const defaults = mqttTopic => Object.freeze({ mqttTopic, efficiency: 0.9 });
export const DEFAULT_CHARGING_CONFIGURATION = Object.freeze({ chargers: Object.freeze({
  charger1: defaults('stmq/garage/charger1/vehicle'), charger2: defaults(null),
}) });

/** Machine configuration, kept out of editable dashboard preferences. The
 * dedicated MQTT topic associates a reading with a charger; no extra vehicle
 * or publisher identity needs to be configured by the user. */
export function chargingConfiguration(input = {}) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(input) || Object.keys(input).some(key => key !== 'chargers')
    || input.chargers !== undefined && !object(input.chargers)) throw new Error('Invalid charging configuration');
  const supplied = input.chargers ?? {};
  if (Object.keys(supplied).some(id => !Object.hasOwn(DEFAULT_CHARGING_CONFIGURATION.chargers, id))) throw new Error('Unknown charger configuration');
  const chargers = {};
  for (const [id, defaults] of Object.entries(DEFAULT_CHARGING_CONFIGURATION.chargers)) {
    const value = supplied[id] ?? {};
    if (!object(value) || Object.keys(value).some(key => !['mqttTopic', 'efficiency'].includes(key)))
      throw new Error(`Invalid ${id} configuration`);
    const current = { ...defaults, ...value };
    if (current.mqttTopic !== null && (typeof current.mqttTopic !== 'string' || !current.mqttTopic.trim()
      || current.mqttTopic.length > 512 || /[+#\u0000-\u001f]/.test(current.mqttTopic)))
      throw new Error(`${id} mqttTopic must be a concrete topic or null`);
    if (!Number.isFinite(current.efficiency) || current.efficiency < .5 || current.efficiency > 1)
      throw new Error(`${id} charging efficiency must be between 0.5 and 1`);
    chargers[id] = current;
  }
  const topics = Object.values(chargers).map(value => value.mqttTopic).filter(Boolean);
  if (new Set(topics).size !== topics.length) throw new Error('Each charger must use a different vehicle MQTT topic');
  return { chargers };
}
