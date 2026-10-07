import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { equipmentConfiguration, equipmentMeterIdentity } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { createEquipmentTests } from '../src/app/equipment-tests.js';
import { createCaravanEnergy } from '../src/acquisition/shelly-energy.js';

const START = Date.parse('2026-01-01T00:00:00Z');
const flush = () => new Promise(resolve => setImmediate(resolve));
const relay = { id: 'relay', kind: 'switch', connection: 'shelly:invented/relay', switch_control: true };
function fixture(t, devices = [relay]) {
  const store = new Store(':memory:'); let now = START;
  const sent = [], engine = { clock: () => now, ingest: row => store.observation(row) };
  const capture = createEquipmentCapture({ store, engine, settings: equipmentConfiguration({ devices }),
    readbackTimeoutMs: 100, publish: async (topic, payload, options) => { sent.push({ topic, payload, options }); } });
  const find = method => sent.findLast(row => row.payload.startsWith('{') && JSON.parse(row.payload).method === method);
  const reply = (publication, result, extra = {}) => {
    const request = JSON.parse(publication.payload);
    capture.receive(`${request.src}/rpc`, JSON.stringify({ id: request.id, src: 'invented-device', dst: request.src, result, ...extra }), {}, now);
  };
  capture.setConnected(true); capture.confirmSubscriptions(capture.topics);
  if (find('Shelly.GetDeviceInfo')) reply(find('Shelly.GetDeviceInfo'), { id: 'invented-device', gen: 2 });
  t.after(() => { capture.close(); store.close(); });
  return { store, engine, capture, sent, find, reply, now: at => { now = at; },
    status: () => capture.status().devices[0], read: value => reply(find('Shelly.GetStatus'), { 'switch:0': { id: 0, output: value } }) };
}

test('A06-001 actual timer rearms after backward clock corrections and restores without a manual tick', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = START, on = false, state;
  const calls = [], signature = 'a'.repeat(64);
  const equipment = { signature: () => signature,
    status: () => ({ devices: [{ id: 'relay', available: true, controls: { switch: true },
      readings: { relay_active: { value: Number(on), unit: 'state', stale: false, observedAt: now } } }] }),
    setSwitch: async (_id, value) => { calls.push(value); on = value; return { confirmed: true }; } };
  const manager = createEquipmentTests({ store: { runWrite: async operation => operation(), getState: () => state, setState: (_key, value) => { state = value; } },
    clock: () => now, getEquipment: () => equipment, canControl: () => true });
  t.after(() => manager.close({ restore: false }));
  await manager.start({ deviceId: 'relay', on: true, durationMinutes: 1 });
  now += 59_000; t.mock.timers.tick(60_000); await flush();
  assert.equal(manager.status().active.status, 'active');
  now += 500; t.mock.timers.tick(1000); await flush();
  assert.deepEqual(calls, [true]);
  now += 500; t.mock.timers.tick(1000); await flush();
  assert.deepEqual(calls, [true, false]); assert.equal(manager.status().active, null);
});

test('A06-002 pre-command polls cannot overwrite command readback or clear restoration', async t => {
  const f = fixture(t); f.read(false); f.now(START + 1);
  const poll = f.capture.recheck({ deviceId: 'relay' }); const old = f.find('Shelly.GetStatus');
  f.now(START + 2);
  const manager = createEquipmentTests({ store: f.store, clock: f.engine.clock, getEquipment: () => f.capture, canControl: () => true });
  t.after(() => manager.close({ restore: false }));
  const start = manager.start({ deviceId: 'relay', on: true, durationMinutes: 1 }); await flush();
  f.now(START + 3); f.reply(f.find('Switch.Set'), { was_on: false });
  f.reply(f.find('Switch.GetStatus'), { id: 0, output: true }); await start;
  f.now(START + 4); f.reply(old, { 'switch:0': { id: 0, output: false } }); await poll;
  assert.equal(f.status().readings.relay_active.value, 1);
  f.now(START + 60_003); const restore = manager.tick(); await flush();
  assert.equal(JSON.parse(f.find('Switch.Set').payload).params.on, false);
  f.reply(f.find('Switch.Set'), { was_on: true }); f.reply(f.find('Switch.GetStatus'), { id: 0, output: false }); await restore;
  assert.equal(manager.status().active, null); assert.equal(manager.status().lastResult.sent, true);
});

test('A06-004 validates complete query/write ownership while allowing shared availability', () => {
  const a = { id: 'a', kind: 'switch', connection: 'mqtt:invented/a', switch_control: true,
    mqtt: { command_topic: 'invented/set', on_payload: 'ON', off_payload: 'OFF', availability_topic: 'invented/online' } };
  const b = { id: 'b', kind: 'temperature', connection: 'mqtt:invented/b',
    mqtt: { request_topic: 'invented/set', request_payload: 'ON' } };
  assert.throws(() => equipmentConfiguration({ devices: [a, b] }), /dedicated/);
  assert.throws(() => equipmentConfiguration({ devices: [a, { ...a, id: 'b', connection: 'mqtt:invented/b' }] }), /dedicated/);
  assert.throws(() => equipmentConfiguration({ devices: [relay, { ...b, mqtt: { request_topic: 'invented/relay/rpc', request_payload: 'write' } }] }), /native equipment prefix/);
  assert.throws(() => equipmentConfiguration({ devices: [{ ...a, mqtt: { ...a.mqtt, heartbeat_topic: 'invented/set', heartbeat_seconds: 30 } }] }), /separate topic/);
  assert.doesNotThrow(() => equipmentConfiguration({ devices: [a, { ...b, mqtt: { availability_topic: 'invented/online' } }] }));
  assert.doesNotThrow(() => equipmentConfiguration({ devices: [a, { ...b, enabled: false }] }));
});

test('A06-005 switch confirmation needs a new main revision and required health, in either arrival order', async t => {
  const device = { id: 'relay', kind: 'switch', connection: 'mqtt:invented/state', switch_control: true,
    mqtt: { command_topic: 'invented/set', on_payload: 'ON', off_payload: 'OFF', timestamp_path: 'timestamp', availability_topic: 'invented/online' },
    readings: [{ key: 'aux', topic: 'invented/aux', path: 'value', unit: 'W' }] };
  const f = fixture(t, [device]);
  const report = (topic, value, timestamp = f.engine.clock()) => f.capture.receive(topic, JSON.stringify({ value, timestamp }));
  report('invented/state', 0); const pending = f.capture.setSwitch('relay', true); let done = false;
  pending.then(() => { done = true; }); await flush();
  report('invented/state', 1); await flush(); assert.equal(done, false, 'equal source-time contradiction rejected');
  report('invented/aux', 4); f.capture.receive('invented/online', 'online'); await flush(); assert.equal(done, false);
  f.now(START + 1); report('invented/state', 1); await pending; assert.equal(done, true);
  const second = f.capture.setSwitch('relay', false); await flush();
  f.capture.receive('invented/online', 'offline'); await assert.rejects(second, /unavailable/);
});

test('A06-005 main before availability waits; cached same-millisecond main plus auxiliary report cannot confirm', async t => {
  const device = { id: 'relay', kind: 'switch', connection: 'mqtt:invented/state', switch_control: true,
    mqtt: { command_topic: 'invented/set', on_payload: 'ON', off_payload: 'OFF', availability_topic: 'invented/online' },
    readings: [{ key: 'aux', topic: 'invented/aux', unit: 'W' }] };
  const f = fixture(t, [device]);
  f.capture.receive('invented/state', 'ON');
  const pending = f.capture.setSwitch('relay', true); let done = false;
  pending.then(() => { done = true; }); await flush();
  f.capture.receive('invented/aux', '4'); f.capture.receive('invented/online', 'online');
  await flush(); assert.equal(done, false);
  f.capture.receive('invented/state', 'ON'); await pending;
  f.capture.setConnected(false); f.capture.setConnected(true);
  const next = f.capture.setSwitch('relay', false); let confirmed = false;
  next.then(() => { confirmed = true; }); await flush();
  f.capture.receive('invented/state', 'OFF'); await flush(); assert.equal(confirmed, false);
  f.capture.receive('invented/online', 'online'); await flush(); assert.equal(confirmed, false, 'subscriptions are also required');
  f.capture.confirmSubscriptions(f.capture.topics); await next;
});

test('A06-006 malformed native origin/component never mutates good state or confirms', async t => {
  for (const extra of [{ src: null }, { src: 'wrong-device' }, { src: 4 }, { src: undefined }]) {
    const f = fixture(t); f.read(false); const command = f.capture.setSwitch('relay', true); f.reply(f.find('Switch.Set'), { was_on: false });
    f.reply(f.find('Switch.GetStatus'), { id: 0, output: true }, extra);
    assert.equal(f.status().readings.relay_active.value, 0); await assert.rejects(command, /timed out/);
  }
  for (const result of [{ id: 1, output: true }, { output: true }, { id: '0', output: true }]) {
    const f = fixture(t); f.read(false); const command = f.capture.setSwitch('relay', true); f.reply(f.find('Switch.Set'), { was_on: false });
    f.reply(f.find('Switch.GetStatus'), result);
    assert.equal(f.status().readings.relay_active.value, 0); await assert.rejects(command, /timed out/);
  }
});

test('A06-008 partial native paths preserve value and original age; explicit null/full omission invalidate', t => {
  const f = fixture(t, [{ ...relay, readings: [
    { key: 'aux', component: 'switch:0', path: 'apower', unit: 'W', required: true },
    { key: 'nested', component: 'switch:0', path: 'aenergy.total', unit: 'Wh' },
  ] }]);
  f.reply(f.find('Shelly.GetStatus'), { 'switch:0': { id: 0, output: false, apower: 100, aenergy: { total: 1000 } } });
  f.now(START + 1000);
  const notify = component => f.capture.receive('invented/relay/events/rpc', JSON.stringify({ src: 'invented-device',
    method: 'NotifyStatus', params: { ts: f.engine.clock() / 1000, 'switch:0': component } }));
  notify({ id: 0, output: true, aenergy: { by_minute: [0] } });
  let rows = f.status().readings;
  assert.equal(rows.relay_aux.value, 100); assert.equal(rows.relay_aux.observedAt, START);
  assert.equal(rows.relay_nested.value, 1000); assert.equal(rows.relay_nested.observedAt, START);
  assert.equal(f.status().available, true);
  notify({ id: 0, apower: null }); assert.equal(f.status().readings.relay_aux.value, null);
  f.now(START + 130_000); f.capture.tick(); assert.equal(f.status().available, false);
});

test('A06-007 current meter lineage rejects cross-device deltas and preserves same-meter restart', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const config = equipmentConfiguration({ devices: [{ id: 'caravan', kind: 'metered_switch', connection: 'shelly:invented/meter' }] }).devices[0];
  const identity = changes => equipmentMeterIdentity({ ...config, ...changes }, { brokerIdentity: 'invented-A', nativeIdentity: 'device-A' });
  const first = createCaravanEnergy({ store, device: identity({}), maxGapMs: 120_000 }); first.receive(100, START);
  const second = createCaravanEnergy({ store, device: identity({}), maxGapMs: 120_000 }); second.receive(100.01, START + 30_000);
  assert.equal(store.observations({ signal: 'caravan_energy' }).filter(row => row.value !== null).length, 1);
  const moved = createCaravanEnergy({ store, device: identity({ switchId: 1 }), maxGapMs: 120_000 }); moved.receive(100.02, START + 60_000);
  assert.equal(store.observations({ signal: 'caravan_energy' }).filter(row => row.value !== null).length, 1);
  assert.ok(Math.abs(moved.status(START + 60_000).dailyKwh - .01) < 1e-8, 'current daily totals preserve valid earlier segments');
  assert.equal(moved.status(START + 60_000).partial, true);
  for (const options of [{ brokerIdentity: 'invented-B', nativeIdentity: 'device-A' }, { brokerIdentity: 'invented-A', nativeIdentity: 'device-B' }])
    assert.notEqual(equipmentMeterIdentity(config, options), identity({}));
  const mapped = { key: 'energy_counter', path: 'meter.total', unit: 'kWh', scale: 1, offset: 0 };
  assert.notEqual(identity({ readings: [mapped] }), identity({ readings: [{ ...mapped, scale: .001 }] }));
  store.setState('shelly:caravan-energy:v2', { version: 2, device: identity({}) });
  assert.throws(() => createCaravanEnergy({ store, device: identity({}), maxGapMs: 120_000 }), /fresh development database/);
});

function failNextCommit(store) {
  const transaction = store.transaction.bind(store); let armed = true;
  store.transaction = action => armed ? transaction(() => { armed = false; action(); throw new Error('synthetic commit failure'); }) : transaction(action);
}

test('generic readback cannot confirm before commit and its timestamped DUP retries the rolled-back state', async t => {
  const f = fixture(t, [{ id: 'relay', kind: 'switch', connection: 'mqtt:invented/state', switch_control: true,
    mqtt: { command_topic: 'invented/set', on_payload: 'ON', off_payload: 'OFF', timestamp_path: 'timestamp' } }]);
  f.capture.receive('invented/state', JSON.stringify({ value: 0, timestamp: START }));
  f.now(START + 1); const pending = f.capture.setSwitch('relay', true); let confirmed = false;
  pending.then(() => { confirmed = true; }); await flush();
  const body = JSON.stringify({ value: 1, timestamp: START + 1 }), packet = { qos: 1, messageId: 31, dup: true };
  failNextCommit(f.store);
  assert.throws(() => f.capture.receive('invented/state', body, packet), /synthetic commit failure/);
  await flush(); assert.equal(confirmed, false);
  assert.equal(f.status().readings.relay_active.value, 0);
  f.capture.receive('invented/state', body, packet); await pending;
  assert.equal(confirmed, true); assert.equal(f.status().readings.relay_active.value, 1);
});

test('native correlated readback and request identity survive a failed commit without acknowledging the command', async t => {
  const f = fixture(t); f.read(false); f.now(START + 1);
  const pending = f.capture.setSwitch('relay', true); let confirmed = false;
  pending.then(() => { confirmed = true; }); await flush();
  f.reply(f.find('Switch.Set'), { was_on: false });
  const request = JSON.parse(f.find('Switch.GetStatus').payload);
  const body = JSON.stringify({ id: request.id, src: 'invented-device', dst: request.src, result: { id: 0, output: true } });
  const packet = { qos: 1, messageId: 32, dup: true };
  failNextCommit(f.store);
  assert.throws(() => f.capture.receive(`${request.src}/rpc`, body, packet), /synthetic commit failure/);
  await flush(); assert.equal(confirmed, false);
  assert.equal(f.status().readings.relay_active.value, 0);
  f.capture.receive(`${request.src}/rpc`, body, packet); await pending;
  assert.equal(confirmed, true); assert.equal(f.status().readings.relay_active.value, 1);
});

test('native meter baseline and daily total rewind with the enclosing failed delivery transaction', t => {
  const f = fixture(t, [{ id: 'caravan', kind: 'metered_switch', connection: 'shelly:invented/caravan' }]);
  const report = (at, total) => JSON.stringify({ method: 'NotifyStatus', src: 'invented-device',
    params: { ts: at / 1000, 'switch:0': { id: 0, output: true, apower: 600, current: 2.6, aenergy: { total } } } });
  f.capture.receive('invented/caravan/events/rpc', report(START, 10000));
  const before = f.status().energy;
  f.now(START + 60_000); const body = report(START + 60_000, 10010), packet = { qos: 1, messageId: 33, dup: true };
  failNextCommit(f.store);
  assert.throws(() => f.capture.receive('invented/caravan/events/rpc', body, packet), /synthetic commit failure/);
  assert.equal(f.status().energy.observedAt, before.observedAt);
  assert.equal(f.status().energy.dailyKwh, 0);
  f.capture.receive('invented/caravan/events/rpc', body, packet);
  assert.equal(f.status().energy.observedAt, START + 60_000);
  assert.ok(Math.abs(f.status().energy.dailyKwh - 0.01) < 1e-9);
});
