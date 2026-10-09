import { createHash } from 'node:crypto';
import { teslamateConfiguration } from '../app/config.js';
const NUMERIC = { battery_level: 100, charge_limit_soc: 100, charge_current_request: 100,
  charge_current_request_max: 100, charger_actual_current: 100, charger_phases: 3, charger_voltage: 500,
  charger_power: 350, charge_energy_added: 1000 };
const FIELDS = new Set([...Object.keys(NUMERIC), 'healthy', 'scheduled_charging_start_time', 'plugged_in', 'geofence', 'charging_state', 'state']);
const IDENTITY_FIELDS = new Set(['plugged_in', 'geofence', 'charging_state', 'state', 'charger_power', 'charger_actual_current']);
const CHANGE_ONLY_FIELDS = new Set([...IDENTITY_FIELDS, 'battery_level', 'charge_limit_soc']);
const validTime = value => Number.isSafeInteger(value) && value >= 0;

/** Native negative connection evidence remains distinct from the plug topic. */
export function teslamateDeparture(event) {
  return event?.field === 'plugged_in' && event.value === false
    || event?.field === 'charging_state' && event.value === 'Disconnected'
    || event?.field === 'state' && event.value === 'driving';
}

/** TeslaMate can withhold an unknown plug value while continuing to publish
 * charging state and measured draw. Corroborate that connection explicitly;
 * never overwrite the raw plug field or create a synthetic plug/start edge. */
export function teslamateConnectionContext(snapshot = {}, { now = Date.now() } = {}) {
  if (!validTime(now) || snapshot.connected === false || snapshot.healthy !== true || snapshot.atHome !== true) return null;
  const fields = snapshot.fields ?? {}, plug = fields.plugged_in;
  const states = ['charging_state', 'state'].map(key => ({ field: key, ...fields[key] }));
  const departures = [...states.filter(teslamateDeparture), ...(snapshot.boundaries ?? [])
    .filter(edge => edge.association === snapshot.association && teslamateDeparture(edge))];
  const departedSincePlug = departures.some(edge => {
    const at = edge.at ?? edge.receivedAt;
    return !validTime(at) || at > now || !validTime(plug?.receivedAt) || at >= plug.receivedAt;
  });
  if (snapshot.pluggedIn === true && !departedSincePlug) return { source: 'reported-plug', receivedAt: plug?.receivedAt ?? null,
    retained: plug?.retained ?? null, timeBasis: 'receipt-only' };
  if (snapshot.connected !== true || snapshot.charging !== true) return null;
  const usable = field => validTime(field?.receivedAt) && field.receivedAt <= now
    && field.measuredAt === null && field.timeBasis === 'receipt-only' && typeof field.retained === 'boolean';
  if (plug && !usable(plug)) return null;
  let after = plug?.receivedAt ?? -1;
  for (const edge of snapshot.boundaries ?? []) {
    if (edge.association !== snapshot.association || !(teslamateDeparture(edge)
      || edge.field === 'geofence' && edge.value !== fields.geofence?.value)) continue;
    if (!validTime(edge.at) || edge.at > now) return null;
    after = Math.max(after, edge.at);
  }
  // A later negative state cannot be hidden by a delayed positive publication
  // on the other state topic. A genuine new charging edge must follow it.
  for (const state of states.filter(teslamateDeparture)) {
    if (!usable(state)) return null;
    after = Math.max(after, state.receivedAt);
  }
  const starts = states.filter(state => usable(state) && state.retained === false
    && ['Charging', 'charging'].includes(state.value) && state.receivedAt > after);
  const draw = ['charger_actual_current', 'charger_power'].map(key => fields[key]);
  if (!starts.length || draw.some(field => !usable(field) || field.retained !== false
    || !Number.isFinite(field.value) || field.value <= .5 || field.receivedAt <= after)) return null;
  const startAt = Math.max(...starts.map(field => field.receivedAt));
  return { source: 'live-charging', receivedAt: Math.max(startAt, ...draw.map(field => field.receivedAt)),
    retained: false, timeBasis: 'receipt-only', chargingAt: startAt,
    currentAt: fields.charger_actual_current.receivedAt, powerAt: fields.charger_power.receivedAt,
    reportedPluggedIn: snapshot.pluggedIn ?? null, reportedPlugAt: plug?.receivedAt ?? null };
}
export function decodeChargingTeslaField(field, payload) {
  if (!FIELDS.has(field)) return undefined;
  const text = String(payload ?? '').trim();
  if (text.length > 200) return null;
  if (Object.hasOwn(NUMERIC, field)) {
    if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
    const value = Number(text);
    return value <= NUMERIC[field] && (field !== 'charger_phases' || Number.isInteger(value)) ? value : null;
  }
  if (['plugged_in', 'healthy'].includes(field)) return text === 'true' ? true : text === 'false' ? false : null;
  if (field === 'scheduled_charging_start_time') {
    const at = /(?:Z|[+-]\d\d:\d\d)$/.test(text) ? Date.parse(text) : NaN;
    return Number.isSafeInteger(at) && at >= 0 ? at : null;
  }
  if (field === 'charging_state') return ['Charging', 'Complete', 'Stopped', 'Disconnected', 'Starting', 'NoPower'].includes(text) ? text : null;
  if (field === 'state') return ['charging', 'online', 'offline', 'asleep', 'suspended', 'driving', 'updating'].includes(text) ? text : null;
  return text;
}

/** One durable vehicle projection. Vehicle data never produces EVSE electricity. */
export function createChargingTeslaCapture({ settings = {}, clock = Date.now, initialState, saveState = () => {},
  afterRollback = () => {}, brokerIdentity = null, onObservation = () => {}, admissionStatus = () => null } = {}) {
  settings = teslamateConfiguration(settings);
  const root = `teslamate/${settings.namespace ? `${settings.namespace}/` : ''}cars/${settings.carId}/`;
  const signature = createHash('sha256').update(JSON.stringify([brokerIdentity, root, settings.homeGeofence])).digest('hex');
  if (initialState && initialState.version !== 1) throw new Error('Unsupported Tesla vehicle state; start a fresh development database');
  const restored = initialState?.signature === signature ? initialState : {};
  let connected = false, brokerConnected = false, subscriptionStatus = 'pending';
  const liveFields = new Set();
  let fields = restored.fields ?? {}, sequence = restored.sequence ?? 0, boundaries = restored.boundaries ?? [];
  let lastMessageAt = restored.lastMessageAt ?? null, lastLiveAt = null, lastRetainedAt = null;
  const reception = () => ({ brokerConnected, connected, subscribed: connected, subscriptionStatus,
    vehicleId: 'tesla', lastMessageAt, lastLiveAt, lastRetainedAt,
    admission: admissionStatus(),
    reason: !brokerConnected ? 'mqtt-disconnected' : !connected ? 'awaiting-subscription' : admissionStatus()?.reason ?? null });
  const snapshot = () => {
    const value = field => fields[field]?.value, now = clock();
    const newest = [fields.state, fields.charging_state].filter(Boolean).sort((a, b) => b.sequence - a.sequence)[0];
    const health = fields.healthy;
    const admission = admissionStatus();
    const observationHealthy = connected && liveFields.has('healthy') && health?.value === true && !health.retained
      && now >= health.receivedAt && now - health.receivedAt <= settings.maxAgeMs;
    const healthy = observationHealthy && !admission?.pending && !admission?.failed;
    const result = { connected, healthy, observationHealthy, maxAgeMs: settings.maxAgeMs, association: signature, reception: reception(),
      atHome: connected && typeof value('geofence') === 'string' ? value('geofence') === settings.homeGeofence : undefined,
      pluggedIn: value('plugged_in'), charging: newest ? ['Charging', 'charging'].includes(newest.value) : undefined,
      batteryLevel: value('battery_level'), chargeLimitSoc: value('charge_limit_soc'), requestedCurrentA: value('charge_current_request'),
      maxCurrentA: value('charge_current_request_max'), actualCurrentA: value('charger_actual_current'),
      scheduledStartAt: value('scheduled_charging_start_time'), phases: value('charger_phases'), voltageV: value('charger_voltage'),
      actualPowerKw: value('charger_power'), fields: structuredClone(fields), boundaries: structuredClone(boundaries) };
    result.connectionContext = teslamateConnectionContext(result, { now });
    return result;
  };
  return { topic: `${root}#`, snapshot, reception,
    setConnected(value, reason) { if (!value) liveFields.clear(); connected = value;
      brokerConnected = ['subscription-failed', 'awaiting-subscription'].includes(reason) || value;
      subscriptionStatus = value ? 'subscribed' : reason === 'subscription-failed' ? 'failed' : 'pending'; },
    receive(topic, payload, packet = {}, now = clock(), onAccepted = () => false) {
      if (!connected || !topic.startsWith(root)) return false;
      const field = topic.slice(root.length), value = decodeChargingTeslaField(field, payload);
      if (value === undefined) return false;
      if (packet.dup || packet.retain && liveFields.has(field)) return true;
      if (fields[field]?.receivedAt > now || !Number.isSafeInteger(now) || now < 0) return false;
      const before = { fields: structuredClone(fields), sequence, boundaries: structuredClone(boundaries), lastMessageAt, lastLiveAt, lastRetainedAt, live: new Set(liveFields) };
      const rewind = () => {
        ({ fields, sequence, boundaries, lastMessageAt, lastLiveAt, lastRetainedAt } = before);
        liveFields.clear(); for (const key of before.live) liveFields.add(key);
      };
      afterRollback(rewind);
      let boundary;
      try {
        lastMessageAt = now;
        if (packet.retain) lastRetainedAt = now; else { lastLiveAt = now; liveFields.add(field); }
        const previous = fields[field], identity = IDENTITY_FIELDS.has(field);
        const lastKnown = identity && previous?.value === null ? previous.lastKnown : previous;
        // An unchanged publication is not another plug, charging start or power
        // ramp. Keep its original delivery provenance, including retained data.
        // Only healthy pulses renew health. Unknown gaps also cannot turn the
        // same last-known value into a new edge when the value becomes available.
        if (previous?.value === value && (packet.retain || CHANGE_ONLY_FIELDS.has(field))) {
          if (!packet.retain && value !== null && onAccepted()) onObservation({ field, boundary: null });
          return true;
        }
        if (identity && value !== null && lastKnown?.value === value) {
          fields[field] = structuredClone(lastKnown);
        } else {
          fields[field] = { value, receivedAt: now, measuredAt: null, retained: packet.retain === true,
            timeBasis: 'receipt-only', sequence: ++sequence,
            ...(identity && value === null && lastKnown ? { lastKnown: structuredClone(lastKnown) } : {}) };
        }
        if (!packet.retain && value !== lastKnown?.value && (field === 'plugged_in' && value !== null
          || field === 'geofence' || teslamateDeparture({ field, value }))) {
          boundary = { field, value, at: now, sequence, association: signature };
          boundaries = [...boundaries, boundary].slice(-64);
        }
        saveState({ version: 1, signature, fields: structuredClone(fields), sequence, boundaries, lastMessageAt });
        if (!packet.retain && value !== null) onAccepted();
        onObservation({ field, boundary: boundary ?? null });
      } catch (error) {
        rewind(); throw error;
      }
      return true;
    },
    status() { const s = snapshot(); return { status: !connected ? 'waiting' : s.healthy ? 'ok' : 'degraded',
      reason: !connected ? 'mqtt-disconnected' : s.reception.reason ?? (s.healthy ? 'vehicle-observation' : 'vehicle-logger-unhealthy'),
      connected, healthy: s.healthy, charging: s.charging, home: s.atHome, recording: false }; },
    close() { connected = false; liveFields.clear(); },
  };
}

export function teslamateVehicleTelemetry(snapshot = {}, { now = Date.now(), charging = snapshot.charging } = {}) {
  const available = snapshot.connected === true && snapshot.healthy === true;
  const signal = (value, field) => {
    const metadata = snapshot.fields?.[field] ?? {};
    // TeslaMate publishes these readings/settings only when their value changes.
    // Its live healthy pulse admits the current projection, without changing any
    // field's original receipt clock or promoting retained data to a live edge.
    const fresh = metadata.receivedAt == null || Number.isSafeInteger(metadata.receivedAt) && metadata.receivedAt <= now;
    return { ...metadata, value: available && fresh && value != null ? value : null,
      lastKnownValue: value ?? null, source: 'teslamate', available: available && fresh && value != null,
      reason: !available ? snapshot.reception?.admission?.reason ?? 'vehicle-logger-unhealthy' : !fresh ? 'vehicle-evidence-stale' : null,
      measuredAt: null, receivedAt: metadata.receivedAt ?? null, timeBasis: 'receipt-only' };
  };
  const requested = signal(snapshot.requestedCurrentA, 'charge_current_request');
  const supplied = signal(snapshot.maxCurrentA, 'charge_current_request_max');
  // Tesla's maximum is the currently available supply, including our own
  // temporary pilot reduction or stop. A matching request is not an independent
  // vehicle restriction: feeding it back as an EVSE ceiling can keep a pause
  // stuck at the stopped 5 A report or pin delivery to an identification test.
  // Only a lower request distinguishes vehicle demand from available supply.
  const distinctVehicleLimit = requested.available && supplied.available
    && Number.isFinite(requested.value) && requested.value >= 0
    && Number.isFinite(supplied.value) && requested.value < supplied.value;
  const vehicleCurrentA = { ...requested, value: distinctVehicleLimit ? requested.value : null,
    available: distinctVehicleLimit,
    reason: distinctVehicleLimit ? null : requested.reason ?? supplied.reason ?? 'vehicle-current-limit-unknown' };
  return { soc: signal(snapshot.batteryLevel, 'battery_level'), minimumSoc: signal(snapshot.chargeLimitSoc, 'charge_limit_soc'),
    vehicleCeilingSoc: signal(snapshot.chargeLimitSoc, 'charge_limit_soc'),
    vehicleCurrentA,
    vehicleNotBefore: signal(charging !== true && snapshot.scheduledStartAt > now ? snapshot.scheduledStartAt : null, 'scheduled_charging_start_time') };
}
