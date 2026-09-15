import { teslamateConfiguration } from '../app/config.js';

// TeslaMate's change-only scalar topics do not contain measurement timestamps.
// Keep each receipt separate; never let a schedule packet refresh battery/current.
// Contract: https://docs.teslamate.org/docs/integrations/mqtt
const NUMERIC = { battery_level: 100, charge_limit_soc: 100, charge_current_request: 100,
  charge_current_request_max: 100, charger_phases: 3, charger_voltage: 500, charger_power: 350 };
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

export function createChargingTeslaCapture({ settings = {}, clock = Date.now }) {
  settings = teslamateConfiguration(settings);
  const root = `teslamate/${settings.namespace ? `${settings.namespace}/` : ''}cars/${settings.carId ?? '1'}/`;
  let connected = false, fields = {}, sequence = 0;
  return {
    topic: `${root}#`,
    setConnected(value) { connected = value; if (!value) fields = {}; },
    receive(topic, payload, packet = {}, now = clock()) {
      if (!connected || !topic.startsWith(root)) return false;
      const field = topic.slice(root.length), value = decodeChargingTeslaField(field, payload);
      if (value === undefined) return false;
      if (packet.dup && fields[field]?.value === value || packet.retain && fields[field]?.retained === false) return true;
      fields[field] = { value, receivedAt: now, measuredAt: null, retained: packet.retain === true,
        timeBasis: 'receipt-only', sequence: ++sequence };
      return true;
    },
    snapshot() {
      const value = field => fields[field]?.value;
      const newest = [fields.state, fields.charging_state].filter(Boolean).sort((a, b) => b.sequence - a.sequence)[0];
      const assignment = settings.chargerAssignment;
      return { connected, atHome: connected && typeof value('geofence') === 'string' ? value('geofence') === (settings.homeGeofence ?? 'Home') : undefined,
        assignment, assignedToCharger1: assignment === 'easee',
        pluggedIn: value('plugged_in'), charging: newest ? ['Charging', 'charging'].includes(newest.value) : undefined,
        batteryLevel: value('battery_level'), chargeLimitSoc: value('charge_limit_soc'),
        requestedCurrentA: value('charge_current_request'), maxCurrentA: value('charge_current_request_max'),
        scheduledStartAt: value('scheduled_charging_start_time'), phases: value('charger_phases'), voltageV: value('charger_voltage'),
        actualPowerKw: value('charger_power'), fields: structuredClone(fields) };
    },
  };
}
