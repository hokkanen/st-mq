/** Home Assistant automation for measured BMW CarData charging inputs.
 * Entity identifiers are supplied at deployment; never embed household IDs. */
export function bmwCardataAutomation({ socEntity, targetEntity, capacityEntity,
  topic = 'stmq/garage/charger1/vehicle' }) {
  const entities = [socEntity, targetEntity, capacityEntity];
  if (entities.some(value => typeof value !== 'string' || !/^sensor\.[a-z0-9_]+$/.test(value)))
    throw new Error('Three CarData sensor entity IDs are required');
  if (typeof topic !== 'string' || !topic || /[+#\u0000-\u001f]/.test(topic)) throw new Error('A concrete MQTT topic is required');
  const payload = `{% set soc = states('${socEntity}') %}
{% set target = states('${targetEntity}') %}
{% set capacity = states('${capacityEntity}') %}
{% set soc_time = as_datetime(state_attr('${socEntity}', 'timestamp'), none) %}
{% set target_time = as_datetime(state_attr('${targetEntity}', 'timestamp'), none) %}
{% set capacity_time = as_datetime(state_attr('${capacityEntity}', 'timestamp'), none) %}
{% set soc_at = soc_time.isoformat() if soc_time is not none else none %}
{% set target_at = target_time.isoformat() if target_time is not none else none %}
{% set capacity_at = capacity_time.isoformat() if capacity_time is not none else none %}
{% set ns = namespace(data=dict(soc=soc|float, measuredAt=soc_at,
  readingId='bmw:soc:' ~ soc_at ~ ':' ~ soc), fields=dict()) %}
{% if is_number(target) and 0 <= target|float <= 100 %}
  {% set ns.data = dict(ns.data, chargeLimitSoc=target|float) %}
  {% set ns.fields = dict(ns.fields, chargeLimitSoc=dict(measuredAt=target_at,
    readingId='bmw:target:' ~ target_at ~ ':' ~ target)) %}
{% endif %}
{% if is_number(capacity) and 1 <= capacity|float <= 300 %}
  {% set ns.data = dict(ns.data, usableCapacityKwh=capacity|float) %}
  {% set ns.fields = dict(ns.fields, usableCapacityKwh=dict(measuredAt=capacity_at,
    readingId='bmw:capacity:' ~ capacity_at ~ ':' ~ capacity)) %}
{% endif %}
{{ dict(ns.data, fields=ns.fields)|to_json }}`;
  return {
    alias: 'STMQ BMW CarData to MQTT',
    description: 'Measured battery percentage, vehicle charge target and usable capacity. Source clocks survive retained replay and independent updates.',
    mode: 'restart',
    triggers: [
      { trigger: 'state', entity_id: entities },
      { trigger: 'homeassistant', event: 'start' },
      { trigger: 'mqtt', topic: 'homeassistant/status', payload: 'online' },
      { trigger: 'time_pattern', minutes: '/5' },
    ],
    conditions: [{ condition: 'template', value_template:
      `{{ is_number(states('${socEntity}')) and 0 <= states('${socEntity}')|float <= 100 }}` }],
    actions: [{ action: 'mqtt.publish', data: { topic, qos: 1, retain: true, payload } }],
  };
}
