import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';

const INITIAL = Date.parse('2026-09-21T10:00:00Z');
const device = { id: 'caravan_dehumidifier', area: 'garage', kind: 'dehumidifier',
  connection: 'mqtt:invented/dehumidifier/state', dehumidifier_control: true,
  mqtt: { command_topic: 'invented/dehumidifier/set', timestamp_path: 'timestamp',
    availability_topic: 'invented/dehumidifier/availability' } };
const capabilities = { power: ['off', 'on'], mode: ['auto', 'dehumidify', 'heater', 'fan_only'],
  targetHumidity: Array.from({ length: 11 }, (_, i) => 30 + i * 5), fanSpeed: ['low', 'medium', 'high', 'auto'],
  swing: ['fixed_90', 'fixed_45', 'oscillate'] };
const defaults = { power: 'off', mode: 'auto', targetHumidity: 55, fanSpeed: 'low', swing: 'fixed_90' };
function fixture(t, options = {}) {
  const store = new Store(':memory:'), observations = [], publications = [];
  let now = INITIAL, authority = true;
  const settings = equipmentConfiguration({ devices: [device] });
  const capture = createEquipmentCapture({ engine: { clock: () => now, ingest: row => observations.push(row) },
    store, settings, canControl: () => authority, readbackTimeoutMs: 10_000,
    publish: async (topic, payload, options) => { publications.push({ topic, payload, options }); }, ...options });
  t.after(() => { capture.close(); store.close(); });
  const rawReport = (state, at = now, retain = false) => capture.receive('invented/dehumidifier/state',
    JSON.stringify({ identity: 'a'.repeat(64), capabilities, ...state, timestamp: new Date(at).toISOString() }), { retain });
  capture.setConnected(true); capture.confirmSubscriptions(capture.topics);
  return { capture, observations, publications, rawReport,
    report: (state = {}, at = now, retain = false) => rawReport({ ...defaults, ...state }, at, retain),
    online: (value = 'online', retain = false) => capture.receive(device.mqtt.availability_topic, value, { retain }),
    advance: milliseconds => { now += milliseconds; }, authority: value => { authority = value; },
    status: () => capture.status().devices[0],
    command: (setting, value) => capture.setDehumidifier({ deviceId: device.id, setting, value }) };
}

test('dehumidifier configuration requires dedicated MQTT controls and one current Off/Low/Medium/High state', () => {
  const configured = equipmentConfiguration({ devices: [device] }).devices[0];
  assert.equal(configured.stateSignal, 'caravan_dehumidifier_state');
  assert.deepEqual(configured.ownedSignals, ['caravan_dehumidifier_state']);
  for (const invalid of [{ ...device, kind: 'switch' }, { ...device, connection: 'shelly:invented/device' },
    { ...device, mqtt: { ...device.mqtt, timestamp_path: null } },
    { ...device, mqtt: { ...device.mqtt, availability_topic: null } },
    { ...device, mqtt: { ...device.mqtt, command_topic: null } },
    { ...device, mqtt: { ...device.mqtt, command_topic: device.mqtt.availability_topic } },
    { ...device, readings: [{ key: 'fanSpeed', unit: 'state' }] }, { ...device, max_age_seconds: 0 },
    { ...device, signal: 'caravan_dehumidifier_active' }, { ...device, signal: 'caravan_dehumidifier_running_state' }])
    assert.throws(() => equipmentConfiguration({ devices: [invalid] }));
  assert.throws(() => equipmentConfiguration({ devices: [device,
    { ...device, id: 'other', connection: 'mqtt:invented/other/state' }] }), /dedicated/);
});

test('future equipment and retained reports cannot enable controls or invent history', async t => {
  const f = fixture(t);
  assert.equal(f.status().dehumidifier.available, false);
  assert.deepEqual(f.status().dehumidifier.state, Object.fromEntries(Object.keys(defaults).map(key => [key, null])));
  await assert.rejects(f.command('power', 'on'), /unavailable/);
  f.report({}, INITIAL, true); f.online('online', true);
  assert.equal(f.observations.length, 0); assert.equal(f.status().available, false);
  f.report(); assert.equal(f.status().available, false); assert.equal(f.observations.length, 0);
  f.online(); assert.equal(f.status().available, true); assert.equal(f.status().dehumidifier.available, true);
  assert.deepEqual(f.publications, []);
});

test('one Off/Low/Medium/High series is recorded; unknown speed remains unknown and snapshots never merge', t => {
  const f = fixture(t); f.online(); f.report();
  for (const fanSpeed of ['low', 'medium', 'high', 'auto']) {
    f.advance(1000); f.report({ power: 'on', fanSpeed, mode: 'fan_only', targetHumidity: 65, swing: 'oscillate' });
  }
  assert.deepEqual(f.observations.map(row => row.value), [0, 1, 2, 3, null]);
  assert.deepEqual([...new Set(f.observations.map(row => row.signal))], ['caravan_dehumidifier_state']);
  assert.deepEqual(f.observations.at(-1).raw.stateLabels, { 0: 'Off', 1: 'Low', 2: 'Medium', 3: 'High' });
  assert.equal(f.observations.at(-1).raw.reportIntervalMs, 120_000);
  assert.equal(f.observations.at(-1).raw.reportGraceMs, 0);
  f.advance(1000); f.rawReport({ power: 'on' });
  assert.equal(f.observations.at(-1).value, null); assert.equal(f.status().available, true);
  assert.equal(f.status().dehumidifier.state.fanSpeed, null);
  assert.equal(f.status().dehumidifier.runningState, 'on');
  for (const row of f.observations) {
    for (const field of ['fanSpeed', 'mode', 'targetHumidity', 'swing', 'temperature', 'humidity'])
      assert.equal(Object.hasOwn(row.raw, field), false, `${field} is live-only`);
    if (row.value !== null) assert.deepEqual(Object.keys(row.raw.fieldTimestamps), row.value === 0 ? ['power'] : ['power', 'fanSpeed']);
  }
  f.advance(1000); f.rawReport({ power: 'off' });
  assert.equal(f.observations.at(-1).value, 0); assert.equal(f.status().dehumidifier.runningState, 'off');
});

test('expired, invalid, retained and out-of-order source reports never become current control state', t => {
  const f = fixture(t); f.online(); f.report(); f.advance(1000); f.report({ power: 'on', fanSpeed: 'high' });
  const accepted = f.observations.length;
  f.report({ power: 'off' }, INITIAL); f.report({ power: 'off' }, INITIAL + 1000, true);
  assert.equal(f.observations.length, accepted); assert.equal(f.status().dehumidifier.runningState, 'on');
  f.capture.receive('invented/dehumidifier/state', JSON.stringify({ ...defaults }));
  assert.equal(f.status().available, false);
  f.report({ power: 'off' }, INITIAL);
  assert.equal(f.status().available, false, 'Older snapshots cannot recover a later invalid report');
  f.advance(1000); f.report(); assert.equal(f.status().available, true);
  f.advance(120_000); f.report({}, INITIAL + 2000);
  assert.equal(f.status().available, false); assert.equal(f.observations.at(-1).value, null);
  assert(f.observations.at(-1).quality.includes('stale-report'));
});

test('offline, disconnect and missing reports produce unknown history and require live recovery', t => {
  const f = fixture(t); f.online(); f.report({ power: 'on' }); f.online('offline');
  assert.equal(f.observations.at(-1).value, null); assert.equal(f.status().dehumidifier.runningState, null);
  f.online(); assert.equal(f.status().available, false); f.advance(1000); f.report();
  f.advance(120_000); f.capture.tick();
  assert.equal(f.status().available, false); assert.equal(f.observations.at(-1).value, null);
  f.capture.setConnected(false); f.capture.setConnected(true); f.capture.confirmSubscriptions(f.capture.topics);
  assert.equal(f.status().dehumidifier.available, false); assert.deepEqual(f.publications, []);
});

test('setting requests enforce supported values, authority and explicit field selection', async t => {
  const f = fixture(t); f.online(); f.report();
  for (const input of [null, [], {}, { deviceId: 'unknown', setting: 'power', value: 'on' },
    { deviceId: device.id, setting: '__proto__', value: 'on' },
    { deviceId: device.id, setting: ['power'], value: 'on' },
    { deviceId: device.id, setting: 'power', value: true },
    { deviceId: device.id, setting: 'power', value: 'on', topic: 'invented/arbitrary' },
    ...[25, 36, 81, '55'].map(value => ({ deviceId: device.id, setting: 'targetHumidity', value })),
    { deviceId: device.id, setting: 'mode', value: 'cool' },
    { deviceId: device.id, setting: 'fanSpeed', value: 'off' },
    { deviceId: device.id, setting: 'swing', value: '90' }])
    await assert.rejects(f.capture.setDehumidifier(input));
  f.authority(false); assert.equal(f.status().dehumidifier.available, false);
  await assert.rejects(f.command('power', 'on'), /unavailable/); assert.deepEqual(f.publications, []);
  f.authority(true);
  for (const [setting, value] of [['power', 'on'], ['mode', 'heater'], ['targetHumidity', 80], ['fanSpeed', 'auto'], ['swing', 'fixed_45']]) {
    const previous = f.status().dehumidifier.state;
    await f.command(setting, value);
    assert.deepEqual(f.publications.at(-1), { topic: device.mqtt.command_topic, payload: JSON.stringify({ [setting]: value, identity: 'a'.repeat(64), requestedAt: f.status().dehumidifier.operation.requestedAt,
      expiresAt: f.status().dehumidifier.operation.requestedAt + 10_000 }),
      options: { qos: 1, retain: false, noReplay: true } });
    assert.deepEqual(f.status().dehumidifier.state, previous, 'Broker publications do not change reported settings');
    await assert.rejects(f.command('power', 'off'), /in progress/);
    f.advance(1000); f.report({ [setting]: value });
  }
});

test('only matching fresh telemetry confirms a command and failed delivery remains unconfirmed', async t => {
  const f = fixture(t); f.online(); f.report(); f.advance(1000);
  const result = await f.command('targetHumidity', 70);
  assert.equal(result.confirmed, false); assert.equal(result.acknowledgement, 'mqtt-broker');
  assert.equal(f.status().dehumidifier.operation.status, 'published');
  f.report({ targetHumidity: 70 }, INITIAL);
  assert.equal(f.status().dehumidifier.operation.status, 'published');
  f.report({ targetHumidity: 70 }, INITIAL + 1000, true);
  assert.equal(f.status().dehumidifier.operation.status, 'published');
  f.advance(1000); f.report({ targetHumidity: 70 });
  assert.equal(f.status().dehumidifier.operation.status, 'observed');
  assert.equal(f.status().dehumidifier.state.targetHumidity, 70);
  await f.command('power', 'on'); f.advance(10_000); f.capture.tick();
  assert.equal(f.status().dehumidifier.operation.status, 'unconfirmed');
  f.advance(1000); f.report({ power: 'on' });
  assert.equal(f.status().dehumidifier.operation.status, 'observed', 'Later fresh telemetry may resolve an uncertain command');
  const broken = fixture(t, { publish: async () => { throw new Error('Synthetic broker details'); } });
  broken.online(); broken.report();
  await assert.rejects(broken.command('power', 'on'), /unconfirmed/);
  assert.equal(broken.status().dehumidifier.operation.status, 'unconfirmed');
  assert.equal(JSON.stringify(broken.status()).includes('broker details'), false);
});

test('history waits for confirmed subscriptions and live availability in either arrival order', t => {
  const f = fixture(t); f.capture.setConnected(false); f.capture.setConnected(true);
  const disconnected = f.observations.length;
  f.online(); f.report(); assert.equal(f.observations.length, disconnected);
  f.capture.confirmSubscriptions(f.capture.topics);
  assert.equal(f.observations.at(-1).value, 0); assert.equal(f.status().available, true);
  f.online('offline'); const unavailable = f.observations.length;
  f.advance(1000); f.report({ power: 'on', fanSpeed: 'high' });
  assert.equal(f.observations.length, unavailable, 'Late telemetry cannot record known state while explicitly offline');
  assert.equal(f.status().dehumidifier.available, false);
  f.online(); assert.equal(f.observations.at(-1).value, 3);
});

test('a conflicting snapshot at an unchanged source time cannot mutate state or confirm a command', async t => {
  const f = fixture(t); f.online(); f.report();
  await f.command('power', 'on');
  f.report({ power: 'on' });
  assert.equal(f.status().dehumidifier.state.power, 'off');
  assert.equal(f.status().dehumidifier.operation.status, 'published');
  f.advance(1000); f.report({ power: 'on' });
  assert.equal(f.status().dehumidifier.operation.status, 'observed');
});

test('telemetry arriving during publication confirms only after broker acknowledgement', async t => {
  let acknowledge;
  const f = fixture(t, { publish: () => new Promise(resolve => { acknowledge = resolve; }) });
  f.online(); f.report(); f.advance(1000);
  const pending = f.command('power', 'on');
  f.report({ power: 'on' });
  assert.equal(f.status().dehumidifier.operation.status, 'publishing');
  acknowledge(); const result = await pending;
  assert.equal(result.confirmed, true); assert.equal(f.status().dehumidifier.operation.status, 'observed');
});

test('native capabilities alone authorize settings, including 30% and excluding unsupported modes or Auto fan', async t => {
  const f = fixture(t); f.online();
  const native = { power: ['off', 'on'], targetHumidity: [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80],
    fanSpeed: ['low', 'medium', 'high'] };
  f.report({ capabilities: native });
  assert.deepEqual(f.status().dehumidifier.capabilities, native);
  for (const [setting, value] of [['mode', 'auto'], ['swing', 'fixed_90'], ['fanSpeed', 'auto']])
    await assert.rejects(f.command(setting, value), /advertised/);
  await f.command('targetHumidity', 30);
  assert.equal(JSON.parse(f.publications.at(-1).payload).targetHumidity, 30);
  f.advance(1000); f.report({ targetHumidity: 30, capabilities: native });
  for (const invalid of [undefined, null, [], { power: ['on', 'on'] }, { power: ['on', 'invalid'] },
    { arbitraryService: ['start'] }, { power: ['off', 'on'], fanSpeed: [] }]) {
    f.advance(1000); f.report({ capabilities: invalid });
    assert.deepEqual(f.status().dehumidifier.capabilities, {});
    await assert.rejects(f.command('power', 'on'), /advertised/);
  }
});

test('independent setting clocks govern command confirmation even when another field has a newer report', async t => {
  const f = fixture(t); f.online(); f.report();
  f.advance(1000); await f.command('targetHumidity', 70);
  f.advance(1000); f.report({ targetHumidity: 70,
    fieldTimestamps: { power: INITIAL + 2000, targetHumidity: INITIAL + 500, fanSpeed: INITIAL + 2000 } });
  assert.equal(f.status().dehumidifier.state.targetHumidity, 70);
  assert.equal(f.status().dehumidifier.operation.status, 'published');
  f.advance(1000); f.report({ targetHumidity: 70,
    fieldTimestamps: { power: INITIAL + 3000, targetHumidity: INITIAL + 3000, fanSpeed: INITIAL + 3000 } });
  assert.equal(f.status().dehumidifier.operation.status, 'observed');
  assert.equal(f.status().dehumidifier.operation.observedAt, INITIAL + 3000);
});

test('a later fan or humidity report cannot extend an old power observation deadline', async t => {
  const f = fixture(t); f.online(); f.report({ power: 'on' });
  f.advance(110_000); f.report({ power: 'on', humidity: 50,
    fieldTimestamps: { power: INITIAL, fanSpeed: INITIAL + 110_000, humidity: INITIAL + 110_000 } });
  assert.equal(f.status().available, true);
  assert.equal(f.observations.at(-1).sourceTime, INITIAL + 110_000);
  assert.equal(f.observations.at(-1).raw.reportIntervalMs, 10_000);
  assert.equal(f.observations.at(-1).raw.fieldTimestamps.power, INITIAL);
  assert.equal(f.observations.at(-1).raw.fieldTimestamps.fanSpeed, INITIAL + 110_000);
  f.advance(10_000); f.capture.tick();
  assert.equal(f.status().available, false);
  await assert.rejects(f.command('power', 'off'), /unavailable/);
});


test('native capability readiness can change without refreshing device observation clocks', async t => {
  const f = fixture(t); f.online(); f.report({ capabilities: { power: ['off', 'on'], fanSpeed: ['low', 'medium', 'high'] } });
  f.advance(1000);
  f.report({ capabilities: { power: ['off', 'on'] } }, INITIAL);
  assert.deepEqual(f.status().dehumidifier.capabilities, { power: ['off', 'on'] });
  assert.equal(f.status().readings.caravan_dehumidifier_state.observedAt, INITIAL);
  await assert.rejects(f.command('fanSpeed', 'high'), /advertised/);
  f.report({ capabilities: { power: ['off', 'on'], fanSpeed: ['low', 'medium', 'high'] } }, INITIAL);
  await f.command('fanSpeed', 'high');
  assert.equal(f.status().dehumidifier.operation.status, 'published');
});

test('a fan-only observation records its explicit level using both source clocks and their earliest expiry', t => {
  const f = fixture(t); f.online(); f.report({ power: 'on', fanSpeed: 'low' });
  f.advance(20_000); f.report({ power: 'on', fanSpeed: 'high', humidity: 50,
    fieldTimestamps: { power: INITIAL, fanSpeed: INITIAL + 20_000, humidity: INITIAL + 20_000 } });
  const changed = f.observations.at(-1);
  assert.equal(changed.value, 3); assert.equal(changed.sourceTime, INITIAL + 20_000);
  assert.equal(changed.raw.reportIntervalMs, 100_000);
  assert.deepEqual(changed.raw.fieldTimestamps, { power: INITIAL, fanSpeed: INITIAL + 20_000 });
  f.advance(20_000); f.report({ power: 'on', fanSpeed: 'high', humidity: 51,
    fieldTimestamps: { power: INITIAL, fanSpeed: INITIAL + 20_000, humidity: INITIAL + 40_000 } });
  assert.equal(f.observations.at(-1).sourceTime, changed.sourceTime, 'Humidity cannot refresh the recorded appliance state');
  assert.equal(f.observations.at(-1).raw.reportIntervalMs, changed.raw.reportIntervalMs);
});

test('fan expiry creates unknown history on a timer while fresh power still permits OFF and independent readback', async t => {
  const f = fixture(t); f.online(); f.report({ power: 'on', fanSpeed: 'medium' });
  f.advance(110_000); f.report({ power: 'on', fanSpeed: 'medium',
    fieldTimestamps: { power: INITIAL + 110_000, fanSpeed: INITIAL } });
  assert.equal(f.observations.at(-1).value, 2);
  assert.equal(f.observations.at(-1).sourceTime, INITIAL + 110_000);
  assert.equal(f.observations.at(-1).raw.reportIntervalMs, 10_000);
  f.advance(10_000); f.capture.tick();
  assert.equal(f.observations.at(-1).value, null);
  assert.equal(f.observations.at(-1).sourceTime, null);
  assert.equal(f.status().available, true);
  assert.equal(f.status().dehumidifier.available, true);
  assert.equal(f.status().dehumidifier.powerOffAvailable, true);
  assert.equal(f.status().dehumidifier.runningState, 'on');
  assert.equal(f.status().dehumidifier.state.fanSpeed, null);
  assert.equal(f.status().readings.caravan_dehumidifier_state.stale, true);
  const before = f.observations.length;
  await f.command('power', 'off');
  assert.equal(f.observations.length, before, 'OFF publication is not observation');
  f.advance(1000); f.rawReport({ power: 'off', fieldTimestamps: { power: INITIAL + 121_000 } });
  assert.equal(f.observations.at(-1).value, 0);
  assert.deepEqual(f.observations.at(-1).raw.fieldTimestamps, { power: INITIAL + 121_000 });
  assert.equal(f.status().dehumidifier.operation.status, 'observed');
});

test('unknown and Auto fan never mean LOW or block native settings with fresh power', async t => {
  const f = fixture(t); f.online(); f.rawReport({ power: 'on' });
  assert.equal(f.observations.at(-1).value, null);
  assert.equal(f.status().dehumidifier.runningState, 'on');
  await f.command('fanSpeed', 'medium');
  f.advance(1000); f.report({ power: 'on', fanSpeed: 'medium' });
  assert.equal(f.observations.at(-1).value, 2);
  assert.equal(f.status().dehumidifier.operation.status, 'observed');
  f.advance(1000); f.report({ power: 'on', fanSpeed: 'auto' });
  assert.equal(f.observations.at(-1).value, null);
  assert.equal(f.status().dehumidifier.state.fanSpeed, 'auto');
  await f.command('targetHumidity', 60);
  assert.equal(JSON.parse(f.publications.at(-1).payload).targetHumidity, 60);
});

test('a later OFF power observation older than the latest fan clock updates control feedback without backdating history', async t => {
  const f = fixture(t); f.online(); f.report({ power: 'on', fanSpeed: 'high' });
  f.advance(5000); await f.command('power', 'off');
  f.advance(15_000); f.report({ power: 'on', fanSpeed: 'high',
    fieldTimestamps: { power: INITIAL, fanSpeed: INITIAL + 20_000 } });
  f.advance(1000); f.report({ power: 'off', fanSpeed: 'high',
    fieldTimestamps: { power: INITIAL, fanSpeed: INITIAL + 20_000 } });
  assert.equal(f.status().dehumidifier.runningState, 'on', 'A changed value with an unchanged power clock remains conflicting evidence');
  assert.equal(f.status().dehumidifier.operation.status, 'published');
  f.report({ power: 'off', fanSpeed: 'high',
    fieldTimestamps: { power: INITIAL + 10_000, fanSpeed: INITIAL + 20_000 } });
  assert.equal(f.status().dehumidifier.runningState, 'off');
  assert.equal(f.status().available, true);
  assert.equal(f.status().dehumidifier.operation.status, 'observed');
  assert.equal(f.status().dehumidifier.operation.observedAt, INITIAL + 10_000);
  assert.equal(f.observations.at(-1).value, null);
  assert.equal(f.observations.at(-1).sourceTime, null);
  f.advance(1000); f.report({ power: 'off', fanSpeed: 'high',
    fieldTimestamps: { power: INITIAL + 10_000, fanSpeed: INITIAL + 20_000 } });
  assert.equal(f.observations.at(-1).value, null, 'Repeated OFF evidence cannot erase its history gap');
  f.advance(8000); f.report({ power: 'off', fanSpeed: 'high',
    fieldTimestamps: { power: INITIAL + 10_000, fanSpeed: INITIAL + 30_000 } });
  assert.equal(f.observations.at(-1).value, null, 'A fan update cannot refresh OFF history');
  f.advance(1000); f.report({ power: 'off', fanSpeed: 'high',
    fieldTimestamps: { power: INITIAL + 31_000, fanSpeed: INITIAL + 30_000 } });
  assert.equal(f.observations.at(-1).value, 0);
  assert.equal(f.observations.at(-1).sourceTime, INITIAL + 31_000);
  assert.deepEqual(f.observations.at(-1).raw.fieldTimestamps, { power: INITIAL + 31_000 });
});

test('different combined states at the same clock remain a gap until a strictly newer source observation', t => {
  const f = fixture(t); f.online(); f.report({ power: 'on', fanSpeed: 'high' });
  f.advance(20_000); f.report({ power: 'on', fanSpeed: 'high',
    fieldTimestamps: { power: INITIAL, fanSpeed: INITIAL + 20_000 } });
  f.report({ power: 'off', fanSpeed: 'high',
    fieldTimestamps: { power: INITIAL + 20_000, fanSpeed: INITIAL + 20_000 } });
  assert.equal(f.status().dehumidifier.runningState, 'off');
  assert.equal(f.observations.at(-1).value, null, 'The newly advanced raw power clock is valid but conflicts with the same combined history clock');
  f.advance(1000); f.report({ power: 'off', fanSpeed: 'high',
    fieldTimestamps: { power: INITIAL + 20_000, fanSpeed: INITIAL + 20_000 } });
  assert.equal(f.observations.at(-1).value, null, 'A source clock equal to the gap receipt is still cached evidence');
  f.advance(1000); f.report({ power: 'off', fanSpeed: 'high',
    fieldTimestamps: { power: INITIAL + 22_000, fanSpeed: INITIAL + 20_000 } });
  assert.equal(f.observations.at(-1).value, 0);
  assert.equal(f.observations.at(-1).sourceTime, INITIAL + 22_000);
});

test('physical replacement clears the prior history boundary before its first fresh observation', t => {
  const f = fixture(t); f.online(); f.report({ power: 'on', fanSpeed: 'high' });
  f.advance(1000); f.report({ identity: 'b'.repeat(64), power: 'off' });
  assert.equal(f.observations.at(-2).value, null);
  assert.equal(f.observations.at(-2).receivedAt, INITIAL + 1000);
  assert.equal(f.observations.at(-1).value, 0);
  assert.equal(f.observations.at(-1).sourceTime, INITIAL + 1000,
    'Fresh evidence for the replacement is allowed at the time its separate replacement gap was recorded');
  assert.equal(f.observations.at(-1).raw.identity, 'b'.repeat(64));
  assert.equal(f.status().dehumidifier.runningState, 'off');
});
