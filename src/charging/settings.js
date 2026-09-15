import moment from 'moment-timezone';

const chargerDefaults = (capacityKwh, topic, vehicleId) => Object.freeze({
  enabled: false, readyBy: '06:00', capacityKwh, minimumSoc: 80, manualSoc: 40, efficiency: 0.9,
  mqtt: Object.freeze({ topic, vehicleId, sourceId: 'vehicle-telemetry' }),
});

/** First-use preferences live in durable application state, not deployment config. */
export const DEFAULT_CHARGING_SETTINGS = Object.freeze({
  timezone: 'Europe/Helsinki',
  readinessMarginMinutes: 15,
  installation: Object.freeze({ mainFuseA: null, chargingAllocationA: null, voltageV: 230, reserveA: 2, otherLoadA: 6 }),
  chargers: Object.freeze({
    charger1: chargerDefaults(74, 'stmq/garage/charger1/vehicle', 'charger1-vehicle'),
    charger2: chargerDefaults(57, null, 'charger2-vehicle'),
  }),
});

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}
function knownKeys(value, defaults, label) {
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown ${label}: ${key}`);
}
function range(value, name, min, max, nullable = false) {
  if (nullable && value === null) return;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Charging ${name} must be between ${min} and ${max}${nullable ? ', or unset' : ''}`);
}
const validReadyBy = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export function chargingSettings(input = {}) {
  object(input, 'Charging settings');
  knownKeys(input, DEFAULT_CHARGING_SETTINGS, 'charging setting');
  if (input.installation !== undefined) object(input.installation, 'Charging installation');
  if (input.chargers !== undefined) object(input.chargers, 'Charging chargers');
  knownKeys(input.installation ?? {}, DEFAULT_CHARGING_SETTINGS.installation, 'charging installation setting');
  knownKeys(input.chargers ?? {}, DEFAULT_CHARGING_SETTINGS.chargers, 'charger');
  const result = { ...DEFAULT_CHARGING_SETTINGS, ...input,
    installation: { ...DEFAULT_CHARGING_SETTINGS.installation, ...input.installation }, chargers: {} };
  if (typeof result.timezone !== 'string' || !moment.tz.zone(result.timezone)) throw new Error('Charging timezone must be an IANA timezone');
  range(result.readinessMarginMinutes, 'readinessMarginMinutes', 0, 180);
  for (const [id, defaults] of Object.entries(DEFAULT_CHARGING_SETTINGS.chargers)) {
    const supplied = input.chargers?.[id] ?? {};
    object(supplied, `Charging ${id}`);
    knownKeys(supplied, defaults, `charging ${id} setting`);
    if (supplied.mqtt !== undefined) object(supplied.mqtt, `Charging ${id} MQTT`);
    knownKeys(supplied.mqtt ?? {}, defaults.mqtt, `charging ${id} MQTT setting`);
    const value = { ...defaults, ...supplied, mqtt: { ...defaults.mqtt, ...supplied.mqtt } };
    if (typeof value.enabled !== 'boolean') throw new Error(`Charging ${id} enabled must be boolean`);
    if (!validReadyBy(value.readyBy)) throw new Error(`Charging ${id} readyBy must be HH:mm`);
    range(value.minimumSoc, `${id} minimumSoc`, 0, 100);
    range(value.manualSoc, `${id} manualSoc`, 0, 100);
    range(value.capacityKwh, `${id} capacityKwh`, 1, 300);
    range(value.efficiency, `${id} efficiency`, 0.5, 1);
    const { topic } = value.mqtt;
    if (topic !== null && (typeof topic !== 'string' || !topic.trim() || topic.length > 512 || /[+#\u0000]/.test(topic)))
      throw new Error(`Charging ${id} MQTT topic must be a concrete topic without wildcards, or unset`);
    for (const key of ['vehicleId', 'sourceId']) {
      if (typeof value.mqtt[key] !== 'string' || !value.mqtt[key].trim() || value.mqtt[key].length > 128 || /[\u0000-\u001f]/.test(value.mqtt[key]))
        throw new Error(`Charging ${id} MQTT ${key} must be a nonempty identity`);
    }
    result.chargers[id] = value;
  }
  const topics = Object.values(result.chargers).map(item => item.mqtt.topic).filter(Boolean);
  if (new Set(topics).size !== topics.length) throw new Error('Each charger must have a separate vehicle MQTT topic');
  for (const key of ['mainFuseA', 'chargingAllocationA']) range(result.installation[key], key, 6, 200, true);
  range(result.installation.voltageV, 'voltageV', 200, 250);
  range(result.installation.reserveA, 'reserveA', 0, 50);
  range(result.installation.otherLoadA, 'otherLoadA', 0, 100);
  return result;
}

/** Nested PATCH semantics retain the other charger and MQTT identities. */
export function mergeChargingSettings(previous, patch) {
  object(patch, 'Charging settings');
  if (patch.chargers !== undefined) object(patch.chargers, 'Charging chargers');
  if (patch.installation !== undefined) object(patch.installation, 'Charging installation');
  const chargers = { ...previous.chargers };
  for (const [id, item] of Object.entries(patch.chargers ?? {})) {
    object(item, `Charging ${id}`);
    if (item.mqtt !== undefined) object(item.mqtt, `Charging ${id} MQTT`);
    chargers[id] = { ...chargers[id], ...item, mqtt: { ...chargers[id]?.mqtt, ...item.mqtt } };
  }
  return chargingSettings({ ...previous, ...patch, installation: { ...previous.installation, ...patch.installation }, chargers });
}

/** One-way migration of the former asymmetric persisted state. Old electrical
 * guesses are intentionally discarded: charger current now comes from telemetry. */
export function migrateChargingSettings(saved = {}) {
  object(saved, 'Charging settings');
  if (saved.chargers) return chargingSettings(saved);
  const top = {}, installation = {}, chargers = {};
  for (const key of ['timezone', 'readinessMarginMinutes']) if (saved[key] !== undefined) top[key] = saved[key];
  for (const key of Object.keys(DEFAULT_CHARGING_SETTINGS.installation)) if (saved.installation?.[key] !== undefined) installation[key] = saved.installation[key];
  const mappings = {
    charger1: { enabled: 'enabled', readyBy: 'readyBy', capacityKwh: 'capacity1Kwh', minimumSoc: 'minimumSoc', manualSoc: 'manualSoc', efficiency: 'efficiency1' },
    charger2: { capacityKwh: 'capacity2Kwh', efficiency: 'efficiency2' },
  };
  for (const [id, keys] of Object.entries(mappings)) {
    chargers[id] = {};
    for (const [key, legacy] of Object.entries(keys)) if (saved[legacy] !== undefined) chargers[id][key] = saved[legacy];
  }
  const mqtt = {};
  for (const [key, legacy] of Object.entries({ topic: 'mqttTopic', vehicleId: 'vehicleId', sourceId: 'sourceId' })) if (saved[legacy] !== undefined) mqtt[key] = saved[legacy];
  chargers.charger1.mqtt = mqtt;
  return chargingSettings({ ...top, installation, chargers });
}

/** Resolve once per new plan/override. DST gaps move forward by the gap;
 * ambiguous autumn times use the first occurrence, consistently with moment. */
export function resolveChargingDeadline(now, readyBy = '06:00', timezone = DEFAULT_CHARGING_SETTINGS.timezone) {
  if (!Number.isFinite(now)) throw new Error('Charging deadline requires numeric UTC time');
  if (!validReadyBy(readyBy) || !moment.tz.zone(timezone)) throw new Error('Invalid charging deadline time or timezone');
  const day = moment.tz(now, timezone).startOf('day');
  const occurrence = date => moment.tz(`${date.format('YYYY-MM-DD')} ${readyBy}`, 'YYYY-MM-DD HH:mm', true, timezone).valueOf();
  let result = occurrence(day);
  if (result <= now) result = occurrence(day.add(1, 'day'));
  return result;
}
