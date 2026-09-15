import moment from 'moment-timezone';

/** User preferences, saved in the application's state store rather than config. */
export const DEFAULT_CHARGING_SETTINGS = Object.freeze({
  enabled: false,
  minimumSoc: 80,
  readyBy: '06:00',
  timezone: 'Europe/Helsinki',
  capacity1Kwh: 74,
  capacity2Kwh: 57,
  manualSoc: 40,
  mqttTopic: 'stmq/garage/charger1/vehicle',
  vehicleId: 'charger1-vehicle',
  sourceId: 'vehicle-telemetry',
  efficiency1: 0.9,
  efficiency2: 0.9,
  readinessMarginMinutes: 15,
  installation: Object.freeze({
    mainFuseA: null,
    chargingAllocationA: null,
    circuitA: null,
    charger1MaxA: 16,
    charger2MaxA: 16,
    minChargingA: 6,
    voltageV: 230,
    reserveA: 2,
    otherLoadA: 6,
  }),
});

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}
function range(value, name, min, max, nullable = false) {
  if (nullable && value === null) return;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Charging ${name} must be between ${min} and ${max}${nullable ? ', or unset' : ''}`);
}

export function chargingSettings(input = {}) {
  object(input, 'Charging settings');
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_CHARGING_SETTINGS, key)) throw new Error(`Unknown charging setting: ${key}`);
  if (input.installation !== undefined) object(input.installation, 'Charging installation');
  for (const key of Object.keys(input.installation ?? {})) {
    if (!Object.hasOwn(DEFAULT_CHARGING_SETTINGS.installation, key)) throw new Error(`Unknown charging installation setting: ${key}`);
  }
  const result = { ...DEFAULT_CHARGING_SETTINGS, ...input,
    installation: { ...DEFAULT_CHARGING_SETTINGS.installation, ...input.installation } };
  if (typeof result.enabled !== 'boolean') throw new Error('Charging enabled must be boolean');
  range(result.minimumSoc, 'minimumSoc', 0, 100);
  range(result.manualSoc, 'manualSoc', 0, 100);
  range(result.capacity1Kwh, 'capacity1Kwh', 1, 300);
  range(result.capacity2Kwh, 'capacity2Kwh', 1, 300);
  range(result.efficiency1, 'efficiency1', 0.5, 1);
  range(result.efficiency2, 'efficiency2', 0.5, 1);
  range(result.readinessMarginMinutes, 'readinessMarginMinutes', 0, 180);
  if (typeof result.readyBy !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(result.readyBy)) throw new Error('Charging readyBy must be HH:mm');
  if (typeof result.timezone !== 'string' || !moment.tz.zone(result.timezone)) throw new Error('Charging timezone must be an IANA timezone');
  if (typeof result.mqttTopic !== 'string' || !result.mqttTopic.trim() || result.mqttTopic.length > 512 || /[+#\u0000]/.test(result.mqttTopic)) throw new Error('Charging MQTT topic must be a concrete topic without wildcards');
  for (const key of ['vehicleId', 'sourceId']) {
    if (typeof result[key] !== 'string' || !result[key].trim() || result[key].length > 128 || /[\u0000-\u001f]/.test(result[key])) throw new Error(`Charging ${key} must be a nonempty identity`);
  }
  const electrical = result.installation;
  for (const key of ['mainFuseA', 'chargingAllocationA', 'circuitA']) range(electrical[key], key, 6, 200, true);
  for (const key of ['charger1MaxA', 'charger2MaxA']) range(electrical[key], key, 6, 80);
  if (!Number.isInteger(electrical.charger1MaxA)) throw new Error('Charger 1 maximum current must be a whole number of amperes');
  range(electrical.minChargingA, 'minChargingA', 6, 32);
  if (electrical.minChargingA > electrical.charger1MaxA) throw new Error('Charging minimum current exceeds Charger 1 maximum current');
  range(electrical.voltageV, 'voltageV', 200, 250);
  range(electrical.reserveA, 'reserveA', 0, 50);
  range(electrical.otherLoadA, 'otherLoadA', 0, 100);
  return result;
}

/** Resolve once per new plan/override. DST gaps move forward by the gap;
 * ambiguous autumn times use the first occurrence, consistently with moment. */
export function resolveChargingDeadline(now, readyBy = DEFAULT_CHARGING_SETTINGS.readyBy, timezone = DEFAULT_CHARGING_SETTINGS.timezone) {
  if (!Number.isFinite(now)) throw new Error('Charging deadline requires numeric UTC time');
  if (typeof readyBy !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(readyBy) || !moment.tz.zone(timezone)) throw new Error('Invalid charging deadline time or timezone');
  const day = moment.tz(now, timezone).startOf('day');
  const occurrence = date => moment.tz(`${date.format('YYYY-MM-DD')} ${readyBy}`, 'YYYY-MM-DD HH:mm', true, timezone).valueOf();
  let result = occurrence(day);
  if (result <= now) result = occurrence(day.add(1, 'day'));
  return result;
}
