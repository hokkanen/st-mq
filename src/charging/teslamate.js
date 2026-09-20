import { createHash } from 'node:crypto';
import { teslamateConfiguration } from '../app/config.js';

// TeslaMate's change-only scalar topics do not contain measurement timestamps.
// Keep each receipt separate; never let a schedule packet refresh battery/current.
// Contract: https://docs.teslamate.org/docs/integrations/mqtt
const NUMERIC = { battery_level: 100, charge_limit_soc: 100, charge_current_request: 100,
  charge_current_request_max: 100, charger_actual_current: 100, charger_phases: 3, charger_voltage: 500, charger_power: 350 };
const FIELDS = new Set([...Object.keys(NUMERIC), 'scheduled_charging_start_time', 'plugged_in', 'geofence', 'charging_state', 'state']);
export function decodeChargingTeslaField(field, payload) {
  if (!FIELDS.has(field)) return undefined;
  const text = String(payload ?? '').trim();
  if (text.length > 200) return null;
  if (Object.hasOwn(NUMERIC, field)) {
    if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
    const value = Number(text);
    return value <= NUMERIC[field] && (field !== 'charger_phases' || Number.isInteger(value)) ? value : null;
  }
  if (field === 'plugged_in') return text === 'true' ? true : text === 'false' ? false : null;
  if (field === 'scheduled_charging_start_time') {
    const at = /(?:Z|[+-]\d\d:\d\d)$/.test(text) ? Date.parse(text) : NaN;
    return Number.isSafeInteger(at) && at >= 0 ? at : null;
  }
  if (field === 'charging_state') return ['Charging', 'Complete', 'Stopped', 'Disconnected', 'Starting', 'NoPower'].includes(text) ? text : null;
  if (field === 'state') return ['charging', 'online', 'offline', 'asleep', 'suspended', 'driving', 'updating'].includes(text) ? text : null;
  return text;
}

export function createChargingTeslaCapture({ settings = {}, clock = Date.now, initialState, saveState = () => {} } = {}) {
  settings = teslamateConfiguration(settings);
  const root = `teslamate/${settings.namespace ? `${settings.namespace}/` : ''}cars/${settings.carId ?? '1'}/`;
  const signature = createHash('sha256').update(JSON.stringify([root, settings.homeGeofence])).digest('hex');
  const restored = initialState?.signature === signature ? initialState : {};
  let connected = false, brokerConnected = false, subscriptionStatus = 'pending';
  const liveFields = new Set();
  let fields = restored.fields ?? {}, sequence = restored.sequence ?? 0;
  let lastMessageAt = restored.lastMessageAt ?? null, lastLiveAt = null, lastRetainedAt = null;
  const reception = () => ({ brokerConnected, connected, subscribed: connected, subscriptionStatus,
    chargerId: settings.chargerAssignment === 'easee' ? 'charger1' : 'charger2',
    lastMessageAt, lastLiveAt, lastRetainedAt,
    reason: !brokerConnected ? 'mqtt-disconnected' : !connected ? 'awaiting-subscription' : null });
  return {
    topic: `${root}#`,
    setConnected(value, reason) { if (!value) liveFields.clear(); connected = value; brokerConnected = ['subscription-failed', 'awaiting-subscription'].includes(reason) || value;
      subscriptionStatus = value ? 'subscribed' : reason === 'subscription-failed' ? 'failed' : 'pending'; },
    reception,
    receive(topic, payload, packet = {}, now = clock()) {
      if (!connected || !topic.startsWith(root)) return false;
      const field = topic.slice(root.length), value = decodeChargingTeslaField(field, payload);
      if (packet.dup && (value === undefined || fields[field]?.value === value)) return value !== undefined;
      lastMessageAt = now;
      if (packet.retain) lastRetainedAt = now; else lastLiveAt = now;
      if (value === undefined) return false;
      if (packet.retain && liveFields.has(field)) return true;
      if (!packet.retain) liveFields.add(field);
      if (fields[field]?.value === value && (packet.retain || ['battery_level', 'charge_limit_soc'].includes(field))) return true;
      const previousField = fields[field], previousSequence = sequence;
      fields[field] = { value, receivedAt: now, measuredAt: null, retained: packet.retain === true,
        timeBasis: 'receipt-only', sequence: ++sequence };
      try { saveState({ signature, fields: structuredClone(fields), sequence, lastMessageAt }); }
      catch (error) {
        if (previousField) fields[field] = previousField; else delete fields[field];
        sequence = previousSequence; throw error;
      }
      return true;
    },
    snapshot() {
      const value = field => fields[field]?.value;
      const newest = [fields.state, fields.charging_state].filter(Boolean).sort((a, b) => b.sequence - a.sequence)[0];
      const assignment = settings.chargerAssignment;
      return { connected, reception: reception(), atHome: connected && typeof value('geofence') === 'string' ? value('geofence') === (settings.homeGeofence ?? 'Home') : undefined,
        assignment, assignedToCharger1: assignment === 'easee',
        pluggedIn: value('plugged_in'), charging: newest ? ['Charging', 'charging'].includes(newest.value) : undefined,
        batteryLevel: value('battery_level'), chargeLimitSoc: value('charge_limit_soc'),
        requestedCurrentA: value('charge_current_request'), maxCurrentA: value('charge_current_request_max'),
        actualCurrentA: value('charger_actual_current'),
        scheduledStartAt: value('scheduled_charging_start_time'), phases: value('charger_phases'), voltageV: value('charger_voltage'),
        actualPowerKw: value('charger_power'), fields: structuredClone(fields) };
    },
  };
}

/** A confirmed connection probe takes precedence over the default charger. */
export function teslamateChargerAssignment(snapshot = {}, { identified } = {}) {
  return { chargerId: snapshot.assignment === 'easee' || snapshot.assignment === 'auto' && identified === 'easee' ? 'charger1' : 'charger2',
    uncertain: false, reservationChargerId: null };
}

/** TeslaMate is a read-only vehicle source, not a charger command adapter.
 * Scalar MQTT packets have receipt clocks only: keep that limitation visible
 * instead of refreshing every signal whenever an unrelated topic arrives. */
export function teslamateChargerTelemetry(snapshot = {}, { now = Date.now() } = {}) {
  const transportAvailable = snapshot.connected === true;
  const signal = (value, field, extra = {}) => {
    const usable = transportAvailable || ['battery_level', 'charge_limit_soc'].includes(field);
    const metadata = snapshot.fields?.[field] ?? {};
    return { ...metadata, value: usable && value !== undefined ? value : null,
      source: 'teslamate', field: field ?? null,
      available: usable && value !== undefined && value !== null,
      measuredAt: metadata.measuredAt ?? null, receivedAt: metadata.receivedAt ?? null,
      timeBasis: 'receipt-only', ...extra };
  };
  const currentKnown = Number.isFinite(snapshot.requestedCurrentA) && snapshot.requestedCurrentA >= 0;
  const maximumKnown = Number.isFinite(snapshot.maxCurrentA) && snapshot.maxCurrentA >= 0;
  const currentA = currentKnown ? Math.min(snapshot.requestedCurrentA, maximumKnown ? snapshot.maxCurrentA : Infinity) : null;
  const connected = snapshot.pluggedIn === false || snapshot.atHome === false ? false
    : snapshot.pluggedIn === true && snapshot.atHome === true ? true : null;
  const charging = connected === false ? false : connected === true ? snapshot.charging : null;
  const scheduledStartAt = Number.isSafeInteger(snapshot.scheduledStartAt) && snapshot.scheduledStartAt >= now
    ? snapshot.scheduledStartAt : null;
  const chargingField = [snapshot.fields?.state, snapshot.fields?.charging_state].filter(Boolean)
    .sort((a, b) => b.sequence - a.sequence)[0] === snapshot.fields?.state ? 'state' : 'charging_state';
  return { ...snapshot, provider: 'teslamate', providerConnected: transportAvailable,
    capabilities: { scheduling: false, currentControl: false, externalLoadBalancing: false,
      automatic: { capacityKwh: false, soc: true, minimumSoc: true, connected: true, currentA: true, schedule: true } },
    capacityKwh: signal(null), soc: signal(snapshot.batteryLevel, 'battery_level'),
    minimumSoc: signal(snapshot.chargeLimitSoc, 'charge_limit_soc'),
    connected: signal(connected, 'plugged_in', { locationSource: 'teslamate-geofence',
      locationReceivedAt: snapshot.fields?.geofence?.receivedAt ?? null }),
    currentA: signal(currentA, 'charge_current_request', { maximumReceivedAt: snapshot.fields?.charge_current_request_max?.receivedAt ?? null }),
    maxCurrentA: signal(snapshot.maxCurrentA, 'charge_current_request_max'),
    actualCurrentA: signal(connected === true ? snapshot.actualCurrentA : null, 'charger_actual_current'),
    phases: signal(snapshot.phases, 'charger_phases'), voltageV: signal(snapshot.voltageV, 'charger_voltage'),
    powerKw: signal(connected === true ? snapshot.actualPowerKw : null, 'charger_power'), charging: signal(charging, chargingField),
    scheduledStartAt: signal(scheduledStartAt, 'scheduled_charging_start_time'),
    // time_to_full_charge is a duration estimate. It is not a vehicle stop time
    // and must never become an enforced native schedule end.
    scheduledEndAt: signal(null), scheduledEndKind: null };
}
