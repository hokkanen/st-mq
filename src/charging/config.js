import { CHARGING_EFFICIENCY } from '../domain/charging-energy.js';

const defaults = mqttTopic => Object.freeze({ mqttTopic, efficiency: CHARGING_EFFICIENCY });
export const DEFAULT_CHARGING_CONFIGURATION = Object.freeze({ chargers: Object.freeze({
  charger1: defaults(null), charger2: defaults(null),
}), vehicles: Object.freeze({ bmw: Object.freeze({ mqttTopic: 'stmq/vehicles/bmw', label: 'BMW', provider: 'bmw-cardata' }) }) });

/** Vehicle sources are independent of physical charging points. Older explicit
 * charger topics are accepted as configuration aliases, never as identification. */
export function chargingConfiguration(input = {}) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(input) || Object.keys(input).some(key => !['chargers', 'vehicles'].includes(key))
    || input.chargers !== undefined && !object(input.chargers)) throw new Error('Invalid charging configuration');
  const supplied = input.chargers ?? {};
  if (Object.keys(supplied).some(id => !Object.hasOwn(DEFAULT_CHARGING_CONFIGURATION.chargers, id))) throw new Error('Unknown charger configuration');
  const chargers = {};
  for (const [id, defaults] of Object.entries(DEFAULT_CHARGING_CONFIGURATION.chargers)) {
    const value = supplied[id] ?? {};
    if (!object(value) || Object.keys(value).some(key => !['mqttTopic', 'efficiency'].includes(key)))
      throw new Error(`Invalid ${id} configuration`);
    const current = { ...defaults, ...value };
    // Supervisor accepts optional empty strings, but cannot save null values.
    if (current.mqttTopic === '') current.mqttTopic = null;
    if (current.mqttTopic !== null && (typeof current.mqttTopic !== 'string' || !current.mqttTopic.trim()
      || current.mqttTopic.length > 512 || /[+#\u0000-\u001f]/.test(current.mqttTopic)))
      throw new Error(`${id} mqttTopic must be a concrete topic, empty string or null`);
    if (!Number.isFinite(current.efficiency) || current.efficiency < .5 || current.efficiency > 1)
      throw new Error(`${id} charging efficiency must be between 0.5 and 1`);
    // Accept previously saved configuration, but the loss is a fixed assumption
    // shared by both chargers and garage heat, not a per-charger setting.
    current.efficiency = CHARGING_EFFICIENCY;
    chargers[id] = current;
  }
  const topics = Object.values(chargers).map(value => value.mqttTopic).filter(Boolean);
  if (new Set(topics).size !== topics.length) throw new Error('Each charger must use a different vehicle MQTT topic');
  if (input.vehicles !== undefined && (!object(input.vehicles)
    || Object.keys(input.vehicles).some(id => id !== 'bmw'))) throw new Error('Invalid vehicle configuration');
  const bmwInput = input.vehicles?.bmw ?? {};
  if (!object(bmwInput) || Object.keys(bmwInput).some(key => !['mqttTopic', 'label', 'provider'].includes(key)))
    throw new Error('Invalid BMW vehicle configuration');
  const bmw = { ...DEFAULT_CHARGING_CONFIGURATION.vehicles.bmw,
    ...(input.vehicles?.bmw === undefined && supplied.charger1?.mqttTopic !== undefined
      ? { mqttTopic: chargers.charger1.mqttTopic } : {}), ...bmwInput };
  if (bmw.mqttTopic === '') bmw.mqttTopic = null;
  if (bmw.mqttTopic !== null && (typeof bmw.mqttTopic !== 'string' || !bmw.mqttTopic.trim()
    || bmw.mqttTopic.length > 512 || /[+#\u0000-\u001f]/.test(bmw.mqttTopic)))
    throw new Error('BMW mqttTopic must be a concrete topic, empty string or null');
  if (typeof bmw.label !== 'string' || !bmw.label.trim() || bmw.label.length > 80 || /[\u0000-\u001f]/.test(bmw.label)
    || bmw.provider !== 'bmw-cardata') throw new Error('Invalid BMW vehicle configuration');
  if (bmw.mqttTopic && chargers.charger2.mqttTopic === bmw.mqttTopic) throw new Error('Each vehicle must use a different vehicle MQTT topic');
  return { chargers, vehicles: { bmw } };
}
