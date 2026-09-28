import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dehumidifierAutomations, dehumidifierCommandTemplate, dehumidifierSnapshotTemplate } from '../integrations/homeassistant/dehumidifier.js';

const options = { id: 'example_dehumidifier', label: 'Example dehumidifier', prefix: 'stmq/garage/example_dehumidifier',
  humidifierEntity: 'humidifier.example_appliance', fanSpeedEntity: 'select.example_fan_speed', deviceIdentity: 'a'.repeat(64) };

test('bridge publishes read-only recovery snapshots, source changes and availability without retention', () => {
  const { snapshot, command } = dehumidifierAutomations(options);
  assert.equal(snapshot.id, `${options.id}_state`);
  assert.equal(command.id, `${options.id}_command`);
  assert.deepEqual(snapshot.triggers[0].entity_id, [options.humidifierEntity, options.fanSpeedEntity]);
  assert.deepEqual(snapshot.triggers.find(trigger => trigger.id === 'periodic'), { trigger: 'time_pattern', seconds: '/30', id: 'periodic' });
  assert.deepEqual(snapshot.triggers.find(trigger => trigger.id === 'query'), { trigger: 'mqtt', topic: `${options.prefix}/get`, payload: '{}', qos: 1, id: 'query' });
  assert.equal(snapshot.triggers.find(trigger => trigger.id === 'reconnect').topic, 'homeassistant/status');
  assert.equal(snapshot.triggers.find(trigger => trigger.id === 'startup').event, 'start');
  assert.equal(snapshot.triggers.find(trigger => trigger.id === 'shutdown').event, 'shutdown');
  assert.equal(snapshot.actions[0].variables.snapshot, dehumidifierSnapshotTemplate);
  assert.match(snapshot.actions[0].variables.stopping, /shutdown/);
  const publications = [snapshot.actions[1], snapshot.actions[2].then[0], command.actions[2]];
  for (const { action, data } of publications) {
    assert.equal(action, 'mqtt.publish');
    assert.equal(data.retain, false);
    assert.equal(data.qos, 1);
  }
  assert.equal(snapshot.actions[2].if[0].value_template, '{{ not stopping }}');
  assert.equal(command.actions[2].data.topic, `${options.prefix}/get`);
  assert.equal(command.actions[2].data.payload, '{}');
  assert(!dehumidifierSnapshotTemplate.includes('now()'), 'Queries cannot manufacture observation clocks');
  assert(!dehumidifierSnapshotTemplate.includes('last_reported'), 'HA optimistic changes and partial updates cannot manufacture observations');
  assert(!JSON.stringify(snapshot).includes('update_entity'), 'Status queries cannot trigger a device operation');
});

test('bridge offers only verified DESD8LW settings and maps commands to native explicit actions', () => {
  const { command } = dehumidifierAutomations(options);
  assert.equal(command.mode, 'parallel');
  assert.equal(command.max, 10);
  assert.deepEqual(command.triggers, [{ trigger: 'mqtt', topic: `${options.prefix}/set`, qos: 1 }]);
  assert.equal(command.conditions[0].value_template, dehumidifierCommandTemplate);
  assert.equal(command.actions[0].value_template, dehumidifierCommandTemplate, 'Recheck expiry and evidence at action time');
  const choices = command.actions[1].choose;
  assert.equal(choices.length, 3);
  assert.match(choices[0].sequence[0].action, /humidifier\.turn_on/);
  assert.match(choices[0].sequence[0].action, /humidifier\.turn_off/);
  assert.equal(choices[1].sequence[0].action, 'select.select_option');
  assert.equal(choices[2].sequence[0].action, 'humidifier.set_humidity');
  const serialized = JSON.stringify(command);
  for (const unsupported of ['humidifier.set_mode', 'fan.oscillate', 'fan.turn_on', 'fan.set_percentage', 'switch.turn_off', 'toggle', 'fanSpeed":"auto'])
    assert(!serialized.includes(unsupported));
});

test('bridge rejects unsafe IDs, topics and incompatible entity domains', () => {
  for (const input of [
    { id: '' }, { id: 'a'.repeat(91) }, { label: '' }, { label: ' '.repeat(4) },
    { prefix: 'stmq/garage/+' }, { prefix: 'stmq/garage/example/#' }, { prefix: 'example/outside' },
    { humidifierEntity: 'climate.example' }, { humidifierEntity: "humidifier.example'" },
    { fanSpeedEntity: 'switch.example' }, { fanSpeedEntity: 'select.example\n' }, { fanSpeedEntity: 'select.example/+' },
    { fanEntity: 'fan.example' }, { humidityEntity: 'sensor.example' },
    { deviceIdentity: undefined }, { deviceIdentity: 'private-device-id' }, { deviceIdentity: 'g'.repeat(64) },
    { deviceIdentity: 'a'.repeat(63) }, { deviceIdentity: 'a'.repeat(65) },
  ]) assert.throws(() => dehumidifierAutomations({ ...options, ...input }));
});

// Execute the actual generated templates in HA's Jinja sandbox. Jinja2 is an
// optional test prerequisite, not an application runtime dependency.
const python = process.env.STMQ_JINJA_PYTHON || 'python3';
const hasJinja = spawnSync(python, ['-c', 'import jinja2'], { stdio: 'ignore' }).status === 0;
const jinja = { skip: !hasJinja && 'Optional Home Assistant template execution requires Python Jinja2' };
const renderer = `import ast, json, sys
from datetime import datetime
from types import SimpleNamespace
from jinja2 import StrictUndefined
from jinja2.sandbox import ImmutableSandboxedEnvironment
data = json.load(sys.stdin)
def as_timestamp(value, default=0):
    if value is None: return default
    try:
        if isinstance(value, (int, float)): return value
        if isinstance(value, str): value = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return value.timestamp()
    except (TypeError, ValueError, AttributeError): return default
class States(dict):
    def __getitem__(self, key): return self.get(key)
result = []
for case in data['cases']:
    env = ImmutableSandboxedEnvironment(undefined=StrictUndefined)
    env.filters.update(to_json=json.dumps, bitwise_and=lambda value, mask: int(value) & mask)
    states = States({key: SimpleNamespace(state=source['state'], attributes=source['attributes'], last_reported=source['last_reported']) for key, source in case['states'].items()})
    env.globals.update(states=states, device_id=lambda entity: case['devices'].get(entity), as_timestamp=as_timestamp, now=lambda: datetime.fromisoformat(case['now'].replace('Z', '+00:00')))
    rendered = env.from_string(data['template']).render(**case['variables']).strip()
    try: result.append(ast.literal_eval(rendered))
    except (SyntaxError, ValueError): result.append(rendered)
print(json.dumps(result))
`;

const now = Date.parse('2026-09-28T12:00:00Z');
const stamp = offset => new Date(now + offset).toISOString();
function fixture(change = {}) {
  const base = {
    now: stamp(0),
    devices: { [options.humidifierEntity]: 'synthetic-appliance', [options.fanSpeedEntity]: 'synthetic-appliance' },
    states: {
      [options.humidifierEntity]: { state: 'on', last_reported: stamp(0), attributes: { min_humidity: 30, max_humidity: 80, humidity: 55,
        local_observations: { identity: options.deviceIdentity, '1': { value: true, timestamp: now - 1000 },
          '2': { value: 55, timestamp: now - 4000 }, '4': { value: 'mid', timestamp: now - 2000 }, '6': { value: 53, timestamp: now - 3000 } } } },
      [options.fanSpeedEntity]: { state: 'medium', last_reported: stamp(0), attributes: { options: ['low', 'medium', 'high'] } },
    },
    variables: { humidifier_entity: options.humidifierEntity, fan_speed_entity: options.fanSpeedEntity, device_identity: options.deviceIdentity,
      trigger: { platform: 'mqtt', payload_json: { identity: options.deviceIdentity, power: 'off', requestedAt: now - 100, expiresAt: now + 9900 } },
      this: { attributes: { last_triggered: stamp(-10000) } } },
  };
  if (change.states) for (const [entity, value] of Object.entries(change.states)) {
    if (value === null) delete base.states[entity];
    else base.states[entity] = { ...base.states[entity], ...value, attributes: { ...base.states[entity]?.attributes, ...value.attributes } };
  }
  if (Object.hasOwn(change, 'observations')) {
    const attributes = base.states[options.humidifierEntity].attributes;
    attributes.local_observations = change.observations === null ? null : { ...attributes.local_observations, ...change.observations };
  }
  if (change.variables) Object.assign(base.variables, change.variables);
  if (change.devices) Object.assign(base.devices, change.devices);
  if (change.now) base.now = change.now;
  return base;
}
function render(template, cases) {
  const result = spawnSync(python, ['-c', renderer], { encoding: 'utf8', input: JSON.stringify({ template, cases: cases.map(fixture) }) });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const payload = (value, extra = {}) => ({ variables: { trigger: { platform: 'mqtt', payload_json: { identity: options.deviceIdentity, requestedAt: now - 100, expiresAt: now + 9900, ...value, ...extra } } } });

test('rendered snapshots preserve independent source clocks across queries and other field updates', jinja, () => {
  const [initial, repeated, fanChanged] = render(dehumidifierSnapshotTemplate, [{}, { now: stamp(60000) },
    { observations: { '4': { value: 'high', timestamp: now + 1000 } } }]);
  assert.equal(initial.power, 'on');
  assert.equal(initial.identity, options.deviceIdentity);
  assert.equal(initial.fanSpeed, 'medium');
  assert.equal(initial.targetHumidity, 55);
  assert.equal(initial.humidity, 53);
  assert.equal(initial.temperature, null);
  assert.equal(initial.timestamp, now - 1000);
  assert.deepEqual(initial.fieldTimestamps, { power: now - 1000, targetHumidity: now - 4000,
    fanSpeed: now - 2000, humidity: now - 3000, temperature: null });
  assert.deepEqual(repeated, initial, 'Periodic publication and get requests carry the original observations');
  assert.equal(fanChanged.timestamp, now + 1000);
  assert.equal(fanChanged.fanSpeed, 'high');
  assert.equal(fanChanged.fieldTimestamps.power, initial.fieldTimestamps.power);
  assert.equal(fanChanged.fieldTimestamps.humidity, initial.fieldTimestamps.humidity);
  assert.deepEqual(initial.capabilities, { power: ['off', 'on'], fanSpeed: ['low', 'medium', 'high'],
    targetHumidity: [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80] });
  assert(!Object.hasOwn(initial, 'mode'));
  assert(!Object.hasOwn(initial, 'swing'));
  assert(!JSON.stringify(initial).includes('example_appliance'), 'Private entity IDs stay out of MQTT payloads');
});

test('optimistic HA states and unrelated HA timestamps never confirm requested settings or freshen measurements', jinja, () => {
  const [initial, optimistic] = render(dehumidifierSnapshotTemplate, [{}, {
    now: stamp(60000), states: {
      [options.humidifierEntity]: { state: 'off', last_reported: stamp(60000), attributes: { humidity: 80, current_humidity: 90 } },
      [options.fanSpeedEntity]: { state: 'high', last_reported: stamp(60000) },
    },
  }]);
  assert.deepEqual(optimistic, initial);
  assert.equal(optimistic.power, 'on');
  assert.equal(optimistic.targetHumidity, 55);
  assert.equal(optimistic.fanSpeed, 'medium');
});

test('rendered snapshots leave missing, restored and unsupported evidence unknown', jinja, () => {
  const [missing, restored, invalid, changedContract, validZero] = render(dehumidifierSnapshotTemplate, [
    { states: Object.fromEntries([options.humidifierEntity, options.fanSpeedEntity].map(id => [id, null])) },
    { states: Object.fromEntries([options.humidifierEntity, options.fanSpeedEntity].map(id => [id, { attributes: { restored: true } }])) },
    { states: { [options.humidifierEntity]: { state: 'unavailable' } } },
    { states: { [options.humidifierEntity]: { attributes: { min_humidity: 35 } }, [options.fanSpeedEntity]: { attributes: { options: ['low', 'high'] } } } },
    { observations: { '1': { value: false, timestamp: now }, '2': { value: 30, timestamp: now },
      '4': { value: 'low', timestamp: now }, '6': { value: 0, timestamp: now } } },
  ]);
  for (const value of [missing, restored, invalid]) {
    assert.equal(value.available, false);
    for (const key of ['power', 'fanSpeed', 'targetHumidity', 'humidity', 'temperature']) assert.equal(value[key], null);
  }
  assert.equal(missing.timestamp, null);
  assert.deepEqual(missing.fieldTimestamps, { power: null, targetHumidity: null, fanSpeed: null, humidity: null, temperature: null });
  assert.deepEqual(changedContract.capabilities, { power: ['off', 'on'] });
  assert.equal(changedContract.fanSpeed, 'medium', 'A known raw speed remains a reading even without a native speed control');
  assert.equal(changedContract.targetHumidity, null);
  assert.equal(validZero.humidity, 0);
  assert.equal(validZero.power, 'off');
  assert.equal(validZero.fanSpeed, 'low');
  assert.equal(validZero.targetHumidity, 30);
});

test('missing observation adapter, different actual device identity and malformed evidence never become observations', jinja, () => {
  const snapshots = render(dehumidifierSnapshotTemplate, [{ observations: null },
    { observations: { identity: null } }, { observations: { identity: 'b'.repeat(64) } },
    { observations: { '1': { value: false, timestamp: 'now' }, '2': { value: 55, timestamp: false },
      '4': { value: 'low', timestamp: -1 }, '6': { value: 50, timestamp: now + 0.5 } } },
  ]);
  for (const result of snapshots) {
    assert.equal(result.available, false);
    assert.equal(result.timestamp, null);
    for (const field of ['power', 'targetHumidity', 'fanSpeed', 'humidity', 'temperature']) assert.equal(result[field], null);
  }
});

test('rendered command gate accepts exactly one verified setting within its live deadline', jinja, () => {
  const cases = [['power', 'off'], ['power', 'on'], ['fanSpeed', 'low'], ['fanSpeed', 'medium'], ['fanSpeed', 'high'],
    ...[30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80].map(value => ['targetHumidity', value])];
  assert.deepEqual(render(dehumidifierCommandTemplate, cases.map(([key, value]) => payload({ [key]: value }))), cases.map(() => true));
  const { command } = dehumidifierAutomations(options);
  const fanAction = command.actions[1].choose[1].sequence[0];
  assert.deepEqual(render(fanAction.data.option, ['low', 'medium', 'high'].map(value => payload({ fanSpeed: value }))), ['low', 'medium', 'high']);
});

test('a later OFF can run independently while an earlier service is pending; delayed ON cannot replay', jinja, () => {
  const { command } = dehumidifierAutomations(options);
  assert.equal(command.mode, 'parallel', 'An OFF request cannot be silently discarded by single mode');
  const initialOn = payload({ power: 'on' });
  const laterOff = { ...payload({ power: 'off' }, { requestedAt: now + 1000, expiresAt: now + 11000 }), now: stamp(1001) };
  laterOff.variables.this = { attributes: { last_triggered: stamp(0) } };
  const staleOn = { ...initialOn, now: stamp(1001), variables: { ...initialOn.variables, this: laterOff.variables.this } };
  assert.deepEqual(render(dehumidifierCommandTemplate, [initialOn, laterOff, staleOn]), [true, true, false]);
  assert.deepEqual(render(command.actions[1].choose[0].sequence[0].action, [initialOn, laterOff]), ['humidifier.turn_on', 'humidifier.turn_off']);
  assert.deepEqual(render(command.actions[0].value_template, [{ ...laterOff, now: stamp(11000) }]), [false],
    'A request that expires before its action begins cannot operate the device');
});

test('rendered command gate rejects malformed, obsolete, expired and replayed envelopes', jinja, () => {
  const cases = [
    { variables: { trigger: {} } }, { variables: { trigger: { platform: 'mqtt' } } },
    ...[null, [], {}, 'on', { power: 'on' }].map(p => ({ variables: { trigger: { platform: 'mqtt', payload_json: p } } })),
    payload({ power: 'on', fanSpeed: 'low' }), payload({ power: 'toggle' }), payload({ power: true }),
    payload({ power: 'on' }, { identity: undefined }), payload({ power: 'on' }, { identity: 'b'.repeat(64) }),
    payload({ power: 'on' }, { identity: null }),
    payload({ mode: 'auto' }), payload({ swing: 'oscillate' }), payload({ fanSpeed: 'auto' }), payload({ arbitrary: 'on' }),
    ...[29, 31, 85, '55', true, null].map(value => payload({ targetHumidity: value })),
    payload({ power: 'on' }, { requestedAt: now + 1 }), payload({ power: 'on' }, { expiresAt: now }),
    payload({ power: 'on' }, { expiresAt: now + 10000 }), payload({ power: 'on' }, { requestedAt: now - 20000 }),
    payload({ power: 'on' }, { requestedAt: String(now - 100) }), payload({ power: 'on' }, { expiresAt: true }),
    { ...payload({ power: 'on' }), variables: { ...payload({ power: 'on' }).variables, this: { attributes: { last_triggered: stamp(-100) } } } },
  ];
  assert.deepEqual(render(dehumidifierCommandTemplate, cases), cases.map(() => false));
});

test('rendered commands require current nonrestored source state and the requested native capability', jinja, () => {
  const cases = [
    { states: { [options.humidifierEntity]: null } },
    { states: { [options.humidifierEntity]: { state: 'unknown' } } },
    { states: { [options.humidifierEntity]: { attributes: { restored: true } } } },
    { observations: null }, { observations: { identity: 'b'.repeat(64) } },
    { observations: { '1': { value: true, timestamp: now - 180000 } } },
    { observations: { '1': { value: true, timestamp: now + 1 } } },
    ...[
      { state: 'unavailable' }, { attributes: { restored: true } }, { attributes: { options: ['low', 'high'] } },
      { attributes: { options: ['low', 'medium', 'high', 'auto'] } },
    ].map(value => ({ ...payload({ fanSpeed: 'high' }), states: { [options.fanSpeedEntity]: value } })),
    { ...payload({ targetHumidity: 55 }), states: { [options.humidifierEntity]: { attributes: { max_humidity: 75 } } } },
  ];
  assert.deepEqual(render(dehumidifierCommandTemplate, cases), cases.map(() => false));
  const offWithoutHumidityOrFan = render(dehumidifierCommandTemplate, [{ observations: { '4': null, '6': null },
    states: { [options.fanSpeedEntity]: { state: 'unavailable' } } }]);
  assert.deepEqual(offWithoutHumidityOrFan, [true], 'Missing humidity or fan evidence must not block an explicit native OFF command');
});

test('supported native settings can overwrite old or unknown settings with fresh actual device power feedback', jinja, () => {
  const cases = [
    { ...payload({ fanSpeed: 'high' }), observations: { '4': { value: 'mid', timestamp: now - 180000 } } },
    { ...payload({ targetHumidity: 55 }), observations: { '2': { value: 60, timestamp: now - 180000 } } },
    { ...payload({ fanSpeed: 'high' }), observations: { '4': null } },
    { ...payload({ targetHumidity: 55 }), observations: { '2': null } },
  ];
  assert.deepEqual(render(dehumidifierCommandTemplate, cases), cases.map(() => true));
  const snapshots = render(dehumidifierSnapshotTemplate, cases);
  assert.equal(snapshots[0].fanSpeed, 'medium', 'Permission to write never changes the last observed value');
  assert.equal(snapshots[0].fieldTimestamps.fanSpeed, now - 180000);
  assert.equal(snapshots[1].targetHumidity, 60);
  assert.equal(snapshots[1].fieldTimestamps.targetHumidity, now - 180000);
  assert.equal(snapshots[2].fanSpeed, null);
  assert.equal(snapshots[3].targetHumidity, null);
});

test('a native fan-speed control must belong to the observed physical appliance', jinja, () => {
  const cases = [
    { devices: { [options.fanSpeedEntity]: 'synthetic-other-appliance' } },
    { devices: { [options.fanSpeedEntity]: null } },
    { devices: { [options.humidifierEntity]: null, [options.fanSpeedEntity]: null } },
  ];
  for (const snapshot of render(dehumidifierSnapshotTemplate, cases)) {
    assert.equal(snapshot.available, true, 'A detached speed control does not hide independent power evidence');
    assert.equal(snapshot.fanSpeed, 'medium');
    assert.equal(Object.hasOwn(snapshot.capabilities, 'fanSpeed'), false);
    assert(!JSON.stringify(snapshot).includes('synthetic-appliance'), 'The internal registry ID is not published');
  }
  assert.deepEqual(render(dehumidifierCommandTemplate, cases.map(value => ({ ...payload({ fanSpeed: 'high' }), ...value }))), [false, false, false]);
  assert.deepEqual(render(dehumidifierCommandTemplate, cases), [true, true, true], 'Native OFF remains independent of the optional select association');
});

test('temporary select outages remove only speed control without refreshing observed values or clocks', jinja, () => {
  const cases = [{}, { states: { [options.fanSpeedEntity]: { state: 'unavailable' } } },
    { states: { [options.fanSpeedEntity]: { attributes: { restored: true } } } }, {}];
  const [initial, unavailable, restored, recovered] = render(dehumidifierSnapshotTemplate, cases);
  for (const snapshot of [unavailable, restored]) {
    assert.equal(snapshot.available, true);
    assert.equal(Object.hasOwn(snapshot.capabilities, 'fanSpeed'), false);
    assert.deepEqual(snapshot.capabilities.power, ['off', 'on']);
    assert.deepEqual({ ...snapshot, capabilities: initial.capabilities }, initial,
      'Native readiness changes capabilities without pretending a fresh device observation');
  }
  assert.deepEqual(recovered, initial);
  const malformed = [null, 'low,medium,high', { low: 1, medium: 2, high: 3 },
    ['low', 1, 'high'], ['low', 'low', 'high'], ['low', 'medium', 'high', 'auto']]
    .map(optionsValue => ({ states: { [options.fanSpeedEntity]: { attributes: { options: optionsValue } } } }));
  for (const snapshot of render(dehumidifierSnapshotTemplate, malformed))
    assert.equal(Object.hasOwn(snapshot.capabilities, 'fanSpeed'), false);
  assert.deepEqual(render(dehumidifierCommandTemplate, malformed.map(value => ({ ...payload({ fanSpeed: 'high' }), ...value }))), malformed.map(() => false));
});
