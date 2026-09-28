// Home Assistant automation generator for the verified electriQ DESD8LW Tuya Local
// entity contract. Entity IDs are supplied privately when installing the bridge.
// Humidity limits alone cannot prove write support: the installed device's Tuya
// target DP was verified as writable, 30–80% in steps of five. Do not reuse this
// model adapter for an unverified humidifier merely because its attributes match.
// deviceIdentity is the digest of the actual Tuya device identity emitted by the
// pinned received-observation adapter. HA entity IDs cannot establish identity.
const sourceTemplate = `
{% set h = states[humidifier_entity] %}
{% set f = states[fan_speed_entity] %}
{% set h_valid = h is not none and h.state in ['off', 'on'] and not h.attributes.get('restored', false) %}
{% set f_valid = f is not none and f.state in ['low', 'medium', 'high'] and not f.attributes.get('restored', false) %}
{% set observations = h.attributes.get('local_observations') if h_valid else none %}
{% set identity_valid = observations is mapping and observations.get('identity') == device_identity %}
${[['power', '1'], ['target', '2'], ['fan', '4'], ['humidity', '6']].map(([field, dp]) => `
{% set ${field}_observation = observations.get('${dp}') if identity_valid else none %}
{% set ${field}_time = ${field}_observation.get('timestamp') if ${field}_observation is mapping else none %}
{% set ${field}_time = ${field}_time if ${field}_time is number and ${field}_time is not boolean and ${field}_time > 0 and ${field}_time % 1 == 0 else none %}
{% set ${field}_value = ${field}_observation.get('value') if ${field}_time is not none else none %}`).join('\n')}
{% set power = 'on' if power_value is sameas true else 'off' if power_value is sameas false else none %}
{% set fan = 'low' if fan_value == 'low' else 'medium' if fan_value == 'mid' else 'high' if fan_value == 'high' else none %}
{% set options = f.attributes.get('options') if f is not none else none %}
{% set appliance_device = device_id(humidifier_entity) %}
{% set same_device = appliance_device is not none and device_id(fan_speed_entity) == appliance_device %}
{% set fan_supported = f_valid and same_device and options is sequence and options is not string and options is not mapping and options | length == 3 and 'low' in options and 'medium' in options and 'high' in options %}
{% set humidity_supported = h is not none and h.attributes.get('min_humidity') == 30 and h.attributes.get('max_humidity') == 80 %}
{% set humidity_options = [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80] if humidity_supported else [] %}
`.trim();

// A new publication is not a new observation. The aggregate clock orders
// snapshots; each field retains its actual local DP receipt time for freshness
// and command confirmation. Native HA states may include pending writes and
// must never supply observed values or clocks. This model exposes no temperature.
export const dehumidifierSnapshotTemplate = `${sourceTemplate}
{% set humidity = humidity_value if humidity_value is number and humidity_value is not boolean and humidity_value >= 0 and humidity_value <= 100 else none %}
{% set times = [power_time, target_time, fan_time, humidity_time] | reject('none') | list %}
{% set capabilities = {'power': ['off', 'on']} if identity_valid else {} %}
{% if identity_valid and fan_supported %}{% set capabilities = dict(capabilities, fanSpeed=['low', 'medium', 'high']) %}{% endif %}
{% if identity_valid and humidity_supported %}{% set capabilities = dict(capabilities, targetHumidity=humidity_options) %}{% endif %}
{{ {'identity': observations.identity if identity_valid else none, 'power': power,
    'fanSpeed': fan, 'targetHumidity': target_value if target_value is number and target_value in humidity_options else none,
    'humidity': humidity, 'temperature': none,
    'timestamp': times | max if times else none,
    'fieldTimestamps': {'power': power_time, 'targetHumidity': target_time, 'fanSpeed': fan_time, 'humidity': humidity_time, 'temperature': none},
    'capabilities': capabilities,
    'available': h_valid and identity_valid and power is not none} }}`;

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
{% set live = h_valid and identity_valid and power is not none and power_time <= current and current - power_time < 180000 %}
{% if valid and live %}
  {% if 'power' in p %}
    {{ p.power in ['off', 'on'] }}
  {% elif 'fanSpeed' in p %}
    {{ f_valid and fan_supported and p.fanSpeed in ['low', 'medium', 'high'] }}
  {% elif 'targetHumidity' in p %}
    {{ humidity_supported and p.targetHumidity is number and p.targetHumidity is not boolean and p.targetHumidity in humidity_options }}
  {% else %}
    {{ false }}
  {% endif %}
{% else %}
  {{ false }}
{% endif %}`;

function validate(options) {
  const { id, label, prefix, humidifierEntity, fanSpeedEntity, deviceIdentity } = options;
  if (Object.keys(options).some(key => !['id', 'label', 'prefix', 'humidifierEntity', 'fanSpeedEntity', 'deviceIdentity'].includes(key)))
    throw new Error('Unsupported dehumidifier bridge option');
  if (!/^[a-z][a-z0-9_]{0,89}$/.test(id) || typeof label !== 'string' || !label.trim() || label.length > 110)
    throw new Error('Invalid dehumidifier automation identity');
  if (!/^stmq\/garage\/[a-z][a-z0-9_]*$/.test(prefix)) throw new Error('Invalid dehumidifier MQTT prefix');
  if (typeof deviceIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(deviceIdentity))
    throw new Error('Dehumidifier identity must be a SHA-256 digest of the private device identity');
  for (const [value, domain] of [[humidifierEntity, 'humidifier'], [fanSpeedEntity, 'select']])
    if (typeof value !== 'string' || !new RegExp(`^${domain}\\.[a-z0-9_]+$`).test(value))
      throw new Error('Invalid dehumidifier source entity');
}

export function dehumidifierAutomations(options) {
  validate(options);
  const { id, label, prefix, humidifierEntity, fanSpeedEntity, deviceIdentity } = options;
  const variables = { humidifier_entity: humidifierEntity, fan_speed_entity: fanSpeedEntity, device_identity: deviceIdentity };
  const publish = (suffix, payload) => ({ action: 'mqtt.publish', data: { topic: `${prefix}/${suffix}`, payload, qos: 1, retain: false } });
  const snapshot = {
    id: `${id}_state`, alias: `${label} status`,
    description: 'Publishes received local device observations and their original per-field clocks. Status requests never operate the appliance.',
    triggers: [
      { trigger: 'state', entity_id: [humidifierEntity, fanSpeedEntity], id: 'source' },
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
        { action: 'select.select_option', target: { entity_id: '{{ fan_speed_entity }}' },
          data: { option: '{{ trigger.payload_json.fanSpeed }}' }, continue_on_error: true },
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
