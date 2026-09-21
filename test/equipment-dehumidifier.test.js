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
    JSON.stringify({ ...state, timestamp: new Date(at).toISOString() }), { retain });
  capture.setConnected(true); capture.confirmSubscriptions(capture.topics);
  return { capture, observations, publications, rawReport,
    report: (state = {}, at = now, retain = false) => rawReport({ ...defaults, ...state }, at, retain),
    online: (value = 'online', retain = false) => capture.receive(device.mqtt.availability_topic, value, { retain }),
    advance: milliseconds => { now += milliseconds; }, authority: value => { authority = value; },
    status: () => capture.status().devices[0],
    command: (setting, value) => capture.setDehumidifier({ deviceId: device.id, setting, value }) };
}

test('dehumidifier configuration requires dedicated MQTT controls and one recorded running state', () => {
  const configured = equipmentConfiguration({ devices: [device] }).devices[0];
  assert.equal(configured.stateSignal, 'caravan_dehumidifier_running_state');
  assert.deepEqual(configured.ownedSignals, ['caravan_dehumidifier_running_state']);
  for (const invalid of [{ ...device, kind: 'switch' }, { ...device, connection: 'shelly:invented/device' },
    { ...device, mqtt: { ...device.mqtt, timestamp_path: null } },
    { ...device, mqtt: { ...device.mqtt, availability_topic: null } },
    { ...device, mqtt: { ...device.mqtt, command_topic: null } },
    { ...device, mqtt: { ...device.mqtt, command_topic: device.mqtt.availability_topic } },
    { ...device, readings: [{ key: 'fanSpeed', unit: 'state' }] }, { ...device, max_age_seconds: 0 }])
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

test('only the off/fan enum is recorded; settings remain live-only and snapshots never merge', t => {
  const f = fixture(t); f.online(); f.report();
  for (const fanSpeed of ['low', 'medium', 'high', 'auto']) {
    f.advance(1000); f.report({ power: 'on', fanSpeed, mode: 'fan_only', targetHumidity: 65, swing: 'oscillate' });
  }
  assert.deepEqual(f.observations.map(row => row.value), [0, 1, 2, 3, 4]);
  assert.deepEqual([...new Set(f.observations.map(row => row.signal))], ['caravan_dehumidifier_running_state']);
  assert.deepEqual(f.observations.at(-1).raw.stateLabels, { 0: 'Off', 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Auto' });
  assert.equal(f.observations.at(-1).raw.reportIntervalMs, 120_000);
  assert.equal(f.observations.at(-1).raw.reportGraceMs, 0);
  f.advance(1000); f.rawReport({ power: 'on' });
  assert.equal(f.observations.at(-1).value, null); assert.equal(f.status().available, false);
  assert.equal(f.status().dehumidifier.state.fanSpeed, null);
  assert.equal(f.status().dehumidifier.runningState, null);
  f.advance(1000); f.rawReport({ power: 'off' });
  assert.equal(f.observations.at(-1).value, 0); assert.equal(f.status().dehumidifier.runningState, 'off');
});

test('expired, invalid, retained and out-of-order source reports never become current control state', t => {
  const f = fixture(t); f.online(); f.report(); f.advance(1000); f.report({ power: 'on', fanSpeed: 'high' });
  const accepted = f.observations.length;
  f.report({ power: 'off' }, INITIAL); f.report({ power: 'off' }, INITIAL + 1000, true);
  assert.equal(f.observations.length, accepted); assert.equal(f.status().dehumidifier.runningState, 'high');
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
    ...[30, 36, 81, '55'].map(value => ({ deviceId: device.id, setting: 'targetHumidity', value })),
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
    assert.deepEqual(f.publications.at(-1), { topic: device.mqtt.command_topic, payload: JSON.stringify({ [setting]: value }),
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
