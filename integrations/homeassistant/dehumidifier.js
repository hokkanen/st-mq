// Home Assistant automation generator for the verified electriQ DESD8LW Tuya
// entity contract. Entity IDs are supplied privately when installing the bridge.
// Humidity limits alone cannot prove write support: the installed device's Tuya
// target DP was verified as writable, 30–80% in steps of five. Do not reuse this
// model adapter for an unverified humidifier merely because its attributes match.
// deviceIdentity is a SHA-256 digest supplied from the private HA device registry
// identity, so replacing an appliance cannot inherit its persistent UI choices.
const sourceTemplate = `
{% set h = states[humidifier_entity] %}
{% set f = states[fan_entity] %}
{% set r = states[humidity_entity] %}
{% set h_valid = h is not none and h.state in ['off', 'on'] and not h.attributes.get('restored', false) %}
{% set f_valid = f is not none and f.state in ['off', 'on'] and not f.attributes.get('restored', false) %}
{% set r_valid = r is not none and r.state not in ['unknown', 'unavailable'] and not r.attributes.get('restored', false) %}
{% set h_time = (as_timestamp(h.last_reported) * 1000) | int if h is not none else none %}
{% set f_time = (as_timestamp(f.last_reported) * 1000) | int if f is not none else none %}
{% set r_time = (as_timestamp(r.last_reported) * 1000) | int if r is not none else none %}
{% set fan_supported = f is not none and (f.attributes.get('supported_features', 0) | int(0) | bitwise_and(1)) != 0 and ((f.attributes.get('percentage_step', 0) | float(0)) - 100 / 3) | abs < 0.01 %}
{% set humidity_supported = h is not none and h.attributes.get('min_humidity') == 30 and h.attributes.get('max_humidity') == 80 %}
{% set humidity_options = [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80] if humidity_supported else [] %}
`.trim();

// A new publication is not a new observation. The aggregate clock orders
// snapshots; each field retains the HA source's own report time for freshness
// and command confirmation. This model exposes no appliance temperature.
export const dehumidifierSnapshotTemplate = `${sourceTemplate}
{% set target = h.attributes.get('humidity') if h_valid else none %}
{% set percentage = f.attributes.get('percentage') if f_valid and fan_supported else none %}
{% set fan = 'low' if percentage == 33 else 'medium' if percentage == 66 else 'high' if percentage == 100 else none %}
{% set humidity = r.state | float(none) if r_valid and r.attributes.get('unit_of_measurement') == '%' else none %}
{% set humidity = humidity if humidity is not none and humidity >= 0 and humidity <= 100 else none %}
{% set times = [h_time, f_time, r_time] | reject('none') | list %}
{% set capabilities = {'power': ['off', 'on']} %}
{% if fan_supported %}{% set capabilities = dict(capabilities, fanSpeed=['low', 'medium', 'high']) %}{% endif %}
{% if humidity_supported %}{% set capabilities = dict(capabilities, targetHumidity=humidity_options) %}{% endif %}
{{ {'identity': device_identity, 'power': h.state if h_valid else none,
    'fanSpeed': fan, 'targetHumidity': target if target is number and target in humidity_options else none,
    'humidity': humidity, 'temperature': none,
    'timestamp': times | max if times else none,
    'fieldTimestamps': {'power': h_time, 'targetHumidity': h_time, 'fanSpeed': f_time, 'humidity': r_time, 'temperature': none},
    'capabilities': capabilities,
    'available': h_valid} }}`;

// MQTT automation triggers do not expose the retained flag. The publisher must
// use retain:false; the deadline and previous execution clock also reject old
// retained/replayed commands. No command is queued for reconnection or retry.
export const dehumidifierCommandTemplate = `${sourceTemplate}
{% set p = trigger.payload_json if trigger is defined and trigger.platform is defined and trigger.platform == 'mqtt' and trigger.payload_json is defined else none %}
{% set current = (as_timestamp(now()) * 1000) | int %}
{% set previous = (as_timestamp(this.attributes.get('last_triggered'), 0) * 1000) | int if this is defined else 0 %}
{% set valid = p is mapping and p | length == 4 and 'identity' in p and p.identity == device_identity and 'requestedAt' in p and 'expiresAt' in p %}
{% if valid %}
  {% set requested = p.requestedAt %}
  {% set expires = p.expiresAt %}
  {% set valid = requested is number and requested is not boolean and expires is number and expires is not boolean and requested > previous and requested <= current and expires > current and expires > requested and expires - requested <= 10000 %}
{% endif %}
{% set live = h_valid and h_time is not none and h_time <= current and current - h_time <= 180000 %}
{% if valid and live %}
  {% if 'power' in p %}
    {{ p.power in ['off', 'on'] }}
  {% elif 'fanSpeed' in p %}
    {{ f_valid and fan_supported and f_time <= current and current - f_time <= 180000 and p.fanSpeed in ['low', 'medium', 'high'] }}
  {% elif 'targetHumidity' in p %}
    {{ humidity_supported and p.targetHumidity is number and p.targetHumidity is not boolean and p.targetHumidity in humidity_options }}
  {% else %}
    {{ false }}
  {% endif %}
{% else %}
  {{ false }}
{% endif %}`;

function validate({ id, label, prefix, humidifierEntity, fanEntity, humidityEntity, deviceIdentity }) {
  if (!/^[a-z][a-z0-9_]{0,89}$/.test(id) || typeof label !== 'string' || !label.trim() || label.length > 110)
    throw new Error('Invalid dehumidifier automation identity');
  if (!/^stmq\/garage\/[a-z][a-z0-9_]*$/.test(prefix)) throw new Error('Invalid dehumidifier MQTT prefix');
  if (typeof deviceIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(deviceIdentity))
    throw new Error('Dehumidifier identity must be a SHA-256 digest of the private device identity');
  for (const [value, domain] of [[humidifierEntity, 'humidifier'], [fanEntity, 'fan'], [humidityEntity, 'sensor']])
    if (typeof value !== 'string' || !new RegExp(`^${domain}\\.[a-z0-9_]+$`).test(value))
      throw new Error('Invalid dehumidifier source entity');
}

export function dehumidifierAutomations(options) {
  validate(options);
  const { id, label, prefix, humidifierEntity, fanEntity, humidityEntity, deviceIdentity } = options;
  const variables = { humidifier_entity: humidifierEntity, fan_entity: fanEntity, humidity_entity: humidityEntity, device_identity: deviceIdentity };
  const publish = (suffix, payload) => ({ action: 'mqtt.publish', data: { topic: `${prefix}/${suffix}`, payload, qos: 1, retain: false } });
  const snapshot = {
    id: `${id}_state`, alias: `${label} status`,
    description: 'Publishes source observations and their original HA report times. Status requests never operate the appliance.',
    triggers: [
      { trigger: 'state', entity_id: [humidifierEntity, fanEntity, humidityEntity], id: 'source' },
      { trigger: 'time_pattern', seconds: '/30', id: 'periodic' },
      { trigger: 'homeassistant', event: 'start', id: 'startup' },
      { trigger: 'homeassistant', event: 'shutdown', id: 'shutdown' },
      { trigger: 'mqtt', topic: 'homeassistant/status', payload: 'online', qos: 1, id: 'reconnect' },
      { trigger: 'mqtt', topic: `${prefix}/get`, payload: '{}', qos: 1, id: 'query' },
    ],
    variables, conditions: [],
    actions: [
      { variables: { snapshot: dehumidifierSnapshotTemplate,
        stopping: "{{ trigger is defined and trigger.id is defined and trigger.id == 'shutdown' }}" } },
      publish('availability', "{{ 'online' if snapshot.available and not stopping else 'offline' }}"),
      { if: [{ condition: 'template', value_template: '{{ not stopping }}' }], then: [
        publish('state', '{{ snapshot | to_json }}'),
      ] },
    ],
    mode: 'queued', max: 10,
  };
  const command = {
    id: `${id}_command`, alias: `${label} commands`,
    description: 'Applies one supported setting with a ten-second request deadline and live device evidence. Readback stays independent of requests.',
    triggers: [{ trigger: 'mqtt', topic: `${prefix}/set`, qos: 1 }],
    variables,
    conditions: [{ condition: 'template', value_template: dehumidifierCommandTemplate }],
    actions: [{ condition: 'template', value_template: dehumidifierCommandTemplate }, { choose: [
      { conditions: [{ condition: 'template', value_template: "{{ 'power' in trigger.payload_json }}" }], sequence: [
        { action: "{{ 'humidifier.turn_on' if trigger.payload_json.power == 'on' else 'humidifier.turn_off' }}", target: { entity_id: '{{ humidifier_entity }}' }, continue_on_error: true },
      ] },
      { conditions: [{ condition: 'template', value_template: "{{ 'fanSpeed' in trigger.payload_json }}" }], sequence: [
        { action: 'fan.set_percentage', target: { entity_id: '{{ fan_entity }}' },
          data: { percentage: "{{ {'low': 33, 'medium': 66, 'high': 100}[trigger.payload_json.fanSpeed] }}" }, continue_on_error: true },
      ] },
      { conditions: [{ condition: 'template', value_template: "{{ 'targetHumidity' in trigger.payload_json }}" }], sequence: [
        { action: 'humidifier.set_humidity', target: { entity_id: '{{ humidifier_entity }}' },
          data: { humidity: '{{ trigger.payload_json.targetHumidity }}' }, continue_on_error: true },
      ] },
    ] }, publish('get', '{}')],
    // Native OFF must be able to run while a previous setting awaits its HA
    // service response. The fresh deadline is checked again at action time;
    // neither service failures nor reconnects enqueue a previous request.
    mode: 'parallel', max: 10,
  };
  return { snapshot, command };
}
