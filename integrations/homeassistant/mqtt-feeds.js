// Generates ordinary Home Assistant automation configurations. Supply private
// entity IDs at installation time; generated household configurations stay out
// of the repository. The automation only reads state and publishes MQTT.
export const snapshotTemplate = `
{% set s = states[source_entity] %}
{% set valid = s is not none and s.state not in ['unknown', 'unavailable'] and not s.attributes.get('restored', false) %}
{% if feed_kind == 'temperature' %}
  {% set number = s.state | float(none) if valid else none %}
  {% set unit = s.attributes.get('unit_of_measurement') if s is not none else none %}
  {% set valid = valid and number is not none and unit in ['°C', 'C', '°F', 'F'] %}
  {% set value = ((number - 32) * 5 / 9 if unit in ['°F', 'F'] else number) if valid else none %}
  {% set valid = valid and value >= -60 and value <= 150 %}
{% else %}
  {% set closed = s.attributes.get('is_closed') if s is not none else none %}
  {% if valid and closed is sameas true %}
    {% set value = 'closed' %}
  {% elif valid and closed is sameas false %}
    {% set value = 'open' %}
  {% elif valid and s.state in ['closed', 'off'] %}
    {% set value = 'closed' %}
  {% elif valid and s.state in ['open', 'on', 'opening', 'closing'] %}
    {% set value = 'open' %}
  {% else %}
    {% set value = none %}
  {% endif %}
  {% set valid = value is not none %}
{% endif %}
{{ {'value': value if valid else none,
    'unit': 'C' if feed_kind == 'temperature' else 'state',
    'timestamp': s.last_reported.isoformat() if s is not none else none,
    'published_at': now().isoformat(), 'available': valid,
    'cover_state': s.state if feed_kind == 'contact' and valid and s.state in ['open', 'closed', 'opening', 'closing'] else none} }}
`.trim();

export function garageMqttAutomation({ id, label, sourceEntity, prefix, kind }) {
  if (!/^[a-z][a-z0-9_]{0,99}$/.test(id) || typeof label !== 'string' || !label.trim() || label.length > 120)
    throw new Error('Invalid automation identity');
  if (!['contact', 'temperature'].includes(kind)
    || !/^(cover|binary_sensor|sensor)\.[a-z0-9_]+$/.test(sourceEntity)
    || kind === 'temperature' && !sourceEntity.startsWith('sensor.'))
    throw new Error('Invalid MQTT source entity or kind');
  if (!/^stmq\/garage\/[a-z][a-z0-9_]*$/.test(prefix)) throw new Error('Invalid garage MQTT prefix');
  const publish = (topic, payload, retain = false) => ({ action: 'mqtt.publish', data: { topic, payload, qos: 1, retain } });
  return {
    id, alias: label,
    description: 'Publishes source changes and requested recovery snapshots with the original HA report time. Read-only status queries; no device operation.',
    triggers: [
      { trigger: 'state', entity_id: sourceEntity, id: 'source' },
      { trigger: 'homeassistant', event: 'start', id: 'startup' },
      { trigger: 'homeassistant', event: 'shutdown', id: 'shutdown' },
      { trigger: 'mqtt', topic: 'homeassistant/status', payload: 'online', qos: 1, id: 'reconnect' },
      { trigger: 'mqtt', topic: `${prefix}/command`, payload: 'status_update', qos: 1, id: 'query' },
    ],
    conditions: [],
    variables: { source_entity: sourceEntity, feed_kind: kind },
    actions: [
      { variables: { snapshot: snapshotTemplate,
        stopping: "{{ trigger is defined and trigger.id is defined and trigger.id == 'shutdown' }}" } },
      publish(`${prefix}/availability`, "{{ 'online' if snapshot.available and not stopping else 'offline' }}", true),
      { if: [{ condition: 'template', value_template: '{{ not stopping }}' }], then: [
        publish(`${prefix}/status/${kind}`, '{{ snapshot | to_json }}'),
      ] },
    ],
    mode: 'queued', max: 10,
  };
}

// These are explicit target operations, never toggle pulses. HA's current
// source capabilities decide which actions can run, including optional Stop.
export function garageCoverAutomation({ id, label, sourceEntity, prefix }) {
  garageMqttAutomation({ id, label, sourceEntity, prefix, kind: 'contact' });
  if (!sourceEntity.startsWith('cover.')) throw new Error('Door operation requires an HA cover entity');
  const choices = [
    { payload: 'open', action: 'open_cover', feature: 1 },
    { payload: 'closed', action: 'close_cover', feature: 2 },
    { payload: 'stop', action: 'stop_cover', feature: 8 },
  ];
  return {
    id, alias: label,
    description: 'Accepts explicit MQTT door commands supported by the HA cover. Commands must not be retained. Source state reports remain independent of requests.',
    triggers: [{ trigger: 'mqtt', topic: `${prefix}/command/cover`, qos: 1 }],
    conditions: [{ condition: 'template', value_template: "{{ trigger is defined and trigger.platform == 'mqtt' and trigger.payload in ['open', 'closed', 'stop'] and states(source_entity) not in ['unknown', 'unavailable'] and not state_attr(source_entity, 'restored') }}" }],
    variables: { source_entity: sourceEntity },
    actions: [{ choose: choices.map(({ payload, action, feature }) => ({
      conditions: [{ condition: 'template', value_template: `{{ trigger.payload == '${payload}' and (state_attr(source_entity, 'supported_features') | int(0) | bitwise_and(${feature})) != 0 }}` }],
      sequence: [{ action: `cover.${action}`, target: { entity_id: '{{ source_entity }}' }, continue_on_error: true }],
    })) },
    // Correct an optimistic client display even if an unsupported command was
    // ignored or the cover service failed. This reply is not an operation ACK.
    { action: 'mqtt.publish', data: { topic: `${prefix}/command`, payload: 'status_update', qos: 1, retain: false } }],
    // Do not queue a Stop behind a long-running open/close service call.
    mode: 'parallel', max: 10,
  };
}
