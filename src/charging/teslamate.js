import { createHash } from 'node:crypto';
import { teslamateConfiguration } from '../app/config.js';
const NUMERIC = { battery_level: 100, charge_limit_soc: 100, charge_current_request: 100,
  charge_current_request_max: 100, charger_actual_current: 100, charger_phases: 3, charger_voltage: 500,
  charger_power: 350, charge_energy_added: 1000 };
const FIELDS = new Set([...Object.keys(NUMERIC), 'healthy', 'scheduled_charging_start_time', 'plugged_in', 'geofence', 'charging_state', 'state']);
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
export function createChargingTeslaCapture({ settings = {}, clock = Date.now, initialState, saveState = () => {}, brokerIdentity = null, onBoundary = () => {} } = {}) {
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
    reason: !brokerConnected ? 'mqtt-disconnected' : !connected ? 'awaiting-subscription' : null });
  const snapshot = () => {
    const value = field => fields[field]?.value, now = clock();
    const newest = [fields.state, fields.charging_state].filter(Boolean).sort((a, b) => b.sequence - a.sequence)[0];
    const health = fields.healthy;
    const healthy = connected && health?.value === true && !health.retained && now >= health.receivedAt && now - health.receivedAt <= settings.maxAgeMs;
    return { connected, healthy, maxAgeMs: settings.maxAgeMs, association: signature, reception: reception(),
      atHome: connected && typeof value('geofence') === 'string' ? value('geofence') === settings.homeGeofence : undefined,
      pluggedIn: value('plugged_in'), charging: newest ? ['Charging', 'charging'].includes(newest.value) : undefined,
      batteryLevel: value('battery_level'), chargeLimitSoc: value('charge_limit_soc'), requestedCurrentA: value('charge_current_request'),
      maxCurrentA: value('charge_current_request_max'), actualCurrentA: value('charger_actual_current'),
      scheduledStartAt: value('scheduled_charging_start_time'), phases: value('charger_phases'), voltageV: value('charger_voltage'),
      actualPowerKw: value('charger_power'), fields: structuredClone(fields), boundaries: structuredClone(boundaries) };
  };
  return { topic: `${root}#`, snapshot, reception,
    setConnected(value, reason) { if (!value) liveFields.clear(); connected = value;
      brokerConnected = ['subscription-failed', 'awaiting-subscription'].includes(reason) || value;
      subscriptionStatus = value ? 'subscribed' : reason === 'subscription-failed' ? 'failed' : 'pending'; },
    receive(topic, payload, packet = {}, now = clock()) {
      if (!connected || !topic.startsWith(root)) return false;
      const field = topic.slice(root.length), value = decodeChargingTeslaField(field, payload);
      if (value === undefined) return false;
      if (packet.dup || packet.retain && liveFields.has(field)) return true;
      if (fields[field]?.receivedAt > now || !Number.isSafeInteger(now) || now < 0) return false;
      const before = { fields: structuredClone(fields), sequence, boundaries: structuredClone(boundaries), lastMessageAt, lastLiveAt, lastRetainedAt, live: new Set(liveFields) };
      let boundary;
      try {
        lastMessageAt = now;
        if (packet.retain) lastRetainedAt = now; else { lastLiveAt = now; liveFields.add(field); }
        const previous = fields[field];
        // Change-only values keep their original clock; a healthy pulse renews health only.
        if (previous?.value === value && (packet.retain || ['battery_level', 'charge_limit_soc'].includes(field))) return true;
        fields[field] = { value, receivedAt: now, measuredAt: null, retained: packet.retain === true,
          timeBasis: 'receipt-only', sequence: ++sequence };
        if (!packet.retain && (field === 'plugged_in' && value !== previous?.value || field === 'geofence' && value !== previous?.value)) {
          boundary = { field, value, at: now, sequence, association: signature };
          boundaries = [...boundaries, boundary].slice(-64);
        }
        saveState({ version: 1, signature, fields: structuredClone(fields), sequence, boundaries, lastMessageAt });
      } catch (error) {
        ({ fields, sequence, boundaries, lastMessageAt, lastLiveAt, lastRetainedAt } = before);
        liveFields.clear(); for (const key of before.live) liveFields.add(key); throw error;
      }
      if (boundary) onBoundary(boundary);
      return true;
    },
    status() { const s = snapshot(); return { status: !connected ? 'waiting' : s.healthy ? 'ok' : 'degraded',
      reason: !connected ? 'mqtt-disconnected' : s.healthy ? 'vehicle-observation' : 'vehicle-logger-unhealthy',
      connected, healthy: s.healthy, charging: s.charging, home: s.atHome, recording: false }; },
    close() { connected = false; liveFields.clear(); },
  };
}

export function teslamateVehicleTelemetry(snapshot = {}, { now = Date.now() } = {}) {
  const available = snapshot.connected === true && snapshot.healthy === true;
  const signal = (value, field) => {
    const metadata = snapshot.fields?.[field] ?? {};
    const operational = !['battery_level', 'charge_limit_soc'].includes(field);
    const fresh = !operational || !metadata.retained && Number.isFinite(metadata.receivedAt) && now >= metadata.receivedAt && now - metadata.receivedAt <= (snapshot.maxAgeMs ?? 180000);
    return { ...metadata, value: available && fresh && value != null ? value : null,
      lastKnownValue: value ?? null, source: 'teslamate', available: available && fresh && value != null,
      reason: !available ? 'vehicle-logger-unhealthy' : !fresh ? 'vehicle-evidence-stale' : null,
      measuredAt: null, receivedAt: metadata.receivedAt ?? null, timeBasis: 'receipt-only' };
  };
  const ceiling = [snapshot.requestedCurrentA, snapshot.maxCurrentA].filter(Number.isFinite);
  return { soc: signal(snapshot.batteryLevel, 'battery_level'), minimumSoc: signal(snapshot.chargeLimitSoc, 'charge_limit_soc'),
    vehicleCeilingSoc: signal(snapshot.chargeLimitSoc, 'charge_limit_soc'),
    vehicleCurrentA: signal(ceiling.length ? Math.min(...ceiling) : null, 'charge_current_request'),
    vehicleNotBefore: signal(snapshot.scheduledStartAt > now ? snapshot.scheduledStartAt : null, 'scheduled_charging_start_time') };
}
