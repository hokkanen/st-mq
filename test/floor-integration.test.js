import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Executor } from '../src/app/executor.js';
import { Engine } from '../src/app/engine.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { floorOverrideConfiguration } from '../src/control/floor-override.js';
import { validateSettings } from '../src/app/config.js';
import { Store } from '../src/storage/store.js';

const NOW = Date.parse('2026-09-20T12:00:00Z');
const flush = () => new Promise(resolve => setImmediate(resolve));
function memoryStore() {
  const memory = new Map();
  return { getState: key => structuredClone(memory.get(key) ?? null),
    setState: (key, value) => memory.set(key, structuredClone(value)), event() {}, observation() {} };
}
function executorFixture(t) {
  const store = memoryStore(), calls = [];
  let releasePending = false, manualPreheat = false;
  const floor = { status: () => ({ enabled: true }),
    lease: async options => { calls.push({ kind: 'lease', ...options }); return { confirmed: true }; },
    release: async options => { calls.push({ kind: 'release', ...options }); return { restorationPending: releasePending, released: !releasePending }; } };
  const h66 = { status: () => ({ controlsReady: true, writesEnabled: true, obligations: {}, manualPreheat }),
    setPhase: async options => { manualPreheat = options.manual === true && options.phase === 'preheat'; calls.push({ kind: 'native', ...options }); return { changed: ['0203'] }; },
    restore: async options => { manualPreheat = false; calls.push({ kind: 'restore-native', ...options }); return { restorationPending: false }; } };
  const commandTransport = { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) }, close: async () => {}, publish: async commands => { calls.push({ kind: 'tariff', commands }); return { sent: true }; },
    publishDhwr: async on => { calls.push({ kind: 'dhwr', on }); return { sent: true }; } };
  const executor = new Executor({ input: 'mqtt', store, commandTransport, h66, floorOverride: floor, clock: () => NOW });
  t.after(() => executor.close({ restore: false }));
  const decision = { phase: 'preheat', commands: ['normal'], floorOverride: true, owner: 'cycle-one', expiresAt: NOW + 3_600_000 };
  return { executor, calls, decision, pending: value => { releasePending = value; } };
}

test('Paused decisions never invoke floor leases or device transports', async t => {
  const f = executorFixture(t);
  {
    const result = await f.executor.execute(f.decision, { automationEnabled: false, now: NOW });
    assert.equal(result.sent, false);
  }
  assert.deepEqual(f.calls, []);
});

test('active pooled preheat leases before ROOM and preserves one owner through changed planning deadlines', async t => {
  const f = executorFixture(t);
  await f.executor.execute(f.decision, { automationEnabled: true, now: NOW });
  assert.equal(f.calls[0].kind, 'lease');
  assert.equal(f.calls.find(row => row.kind === 'native').roomBoostC, 5);
  assert.equal(f.calls.some(row => row.kind === 'dhwr'), false);
  await f.executor.execute({ ...f.decision, expiresAt: NOW + 1_800_000 }, { automationEnabled: true, now: NOW });
  assert.deepEqual(f.calls.filter(row => row.kind === 'lease').map(row => row.owner), ['cycle-one', 'cycle-one']);
});

test('automatic reduction waits for floor release readback before changing heating regime', async t => {
  const f = executorFixture(t); f.pending(true);
  const result = await f.executor.execute({ ...f.decision, phase: 'reduction', commands: ['reduction'] }, { automationEnabled: true, now: NOW });
  assert.equal(result.restorationPending, true);
  assert.deepEqual(f.calls.map(row => row.kind), ['release']);
});

test('manual replacement cannot bypass an unconfirmed floor release', async t => {
  const f = executorFixture(t); f.pending(true);
  const result = await f.executor.execute({ phase: 'reduction', commands: ['reduction'] }, { automationEnabled: true, now: NOW,
    manualTest: true, pause: { id: 'manual-one', expiresAt: NOW + 600_000 } }).catch(error => error);
  assert(result.restorationPending || result.code, 'Pending release must be exposed');
  assert.equal(f.calls.some(row => row.kind === 'tariff' && row.commands.includes('reduction')), false);
});

test('ROOM-only treatment cannot be reported while release of the pooled override is unconfirmed', async t => {
  const f = executorFixture(t); f.pending(true);
  const result = await f.executor.execute({ ...f.decision, floorOverride: false }, { automationEnabled: true, now: NOW }).catch(error => error);
  assert(result.restorationPending || result.code, 'Pending release must be exposed');
  assert.equal(f.calls.some(row => row.kind === 'native' && row.phase === 'preheat'), false);
});

test('a new manual preheat activation gets a fresh owner and maintenance never renews its first lease', async t => {
  const f = executorFixture(t);
  const options = { automationEnabled: true, now: NOW, manualTest: true, pause: { id: 'same-pause', expiresAt: NOW + 600_000 } };
  await f.executor.execute(f.decision, options);
  await f.executor.execute({ phase: 'normal', commands: ['normal'] }, options);
  await f.executor.execute(f.decision, options);
  await f.executor.maintainPause(NOW);
  const owners = f.calls.filter(row => row.kind === 'lease').map(row => row.owner);
  assert.equal(owners.length, 2);
  assert.notEqual(owners[0], owners[1], 'A replacement treatment has its own control identity');
  assert.equal(f.executor.status().manualRequested.expiresAt, NOW + 900_000);
});


test('learning context distinguishes inactive, confirmed, partial and missing floor output evidence', () => {
  const channels = outputs => [{ group: 'groundfloor', available: true,
    channels: [1, 2, 3, 4].map(id => ({ id, output: outputs[id - 1] })) }];
  const mode = status => Engine.prototype.floorOverrideMode.call({ clock: () => NOW, preheatValveStatus: () => status }, NOW);
  assert.equal(mode({ enabled: false, active: false, devices: [] }), 'off');
  const observed = { enabled: true, active: false, available: true, restorationPending: false, devices: channels([false, false, false, false]) };
  assert.equal(mode(observed), 'off');
  assert.equal(mode({ ...observed, active: true, devices: channels([true, true, true, true]) }), 'on');
  assert.equal(mode({ ...observed, devices: channels([false, true, false, false]) }), 'partial');
  assert.equal(mode({ ...observed, enabled: false, devices: channels([true, true, true, true]) }), 'partial');
  assert.equal(mode({ ...observed, restorationPending: true }), 'unknown');
  assert.equal(mode({ ...observed, devices: channels([null, null, null, null]).map(device => ({ ...device, available: false })) }), 'unknown');
});

async function mqttFixture(t, { authority = true, saved = null } = {}) {
  const client = new EventEmitter(), publications = [], subscriptions = [], store = memoryStore();
  if (saved) store.setState('floor-override:v1', saved);
  client.connected = true; client._storeProcessing = false;
  client.getLastMessageId = () => 0;
  client.subscribe = (topic, options, done) => { subscriptions.push(topic); done(null, [{ topic, qos: 1 }]); };
  client.publish = (topic, payload, options, done) => { publications.push({ topic, payload, options }); done(); };
  client.end = (force, options, done) => done();
  const config = { input: 'mqtt', deviceId: null, h66: {}, floorPreheat: floorOverrideConfiguration(),
    connections: { mqtt: { address: 'mqtt://fixture.invalid', user: 'fixture-user' } } };
  const engine = { clock: () => NOW, ingest() {}, rememberObservation() {}, executor: {} };
  const capture = await startMqtt({ engine, store, config, connect: () => client, canControl: () => authority });
  await flush(); t.after(() => capture.close({ restore: false }));
  return { client, capture, engine, config, publications, subscriptions, store };
}

test('MQTT connection cannot subscribe to or activate the unimplemented SONOFF integration', async t => {
  for (const authority of [true, false]) {
    const f = await mqttFixture(t, { authority });
    assert.equal(f.capture.floorOverride, f.engine.floorOverride);
    assert.equal(f.subscriptions.some(topic => topic.includes('/floor/')), false);
    assert.equal(f.capture.floorOverride.status().devices.length, 1);
    assert.equal(f.capture.floorOverride.status().integrationSupported, false);
    await assert.rejects(f.capture.floorOverride.lease({ owner: 'fixture-owner', until: NOW + 60_000 }), { code: 'FLOOR_UNSUPPORTED' });
    assert.equal(f.publications.length, 0);
  }
});

test('MQTT lifecycle preserves outstanding physical obligations while the replacement integration is unavailable', async t => {
  const saved = { version: 1, sequence: 1, outstanding: { owner: 'fixture-previous-owner', devices: [{ topicPrefix: 'fixture-old-device' }] } };
  for (const authority of [true, false]) {
    const f = await mqttFixture(t, { authority, saved });
    assert.equal(f.capture.floorOverride.status().restorationPending, true);
    await assert.rejects(f.capture.floorOverride.lease({ owner: 'fixture-owner' }), { code: 'FLOOR_PENDING' });
    await f.capture.close({ restore: true });
    assert.deepEqual(f.store.getState('floor-override:v1'), saved);
    assert.equal(f.engine.floorOverride.status().restorationPending, true);
    assert.equal(f.engine.executor.floorOverride, f.engine.floorOverride, 'The release guard survives removal of MQTT');
    assert.equal((await f.engine.executor.floorOverride.release()).released, false);
    assert.equal(f.publications.length, 0);
  }
});

test('unconfigured floor hardware does not invent a thermal intervention, while unresolved releases stay unknown', () => {
  const store = memoryStore(), context = { store, config: {}, clock: () => NOW };
  const status = Engine.prototype.preheatValveStatus.call(context);
  const mode = value => Engine.prototype.floorOverrideMode.call({ clock: () => NOW, preheatValveStatus: () => value });
  assert.equal(status.devices.length, 1);
  assert.equal(mode(status), 'off');
  store.setState('floor-override:v1', { version: 1, outstanding: { owner: 'fixture-previous-owner' } });
  const pending = Engine.prototype.preheatValveStatus.call(context);
  assert.equal(pending.restorationPending, true);
  assert.equal(mode(pending), 'unknown');
});

test('Engine guards heating against an unresolved floor release before MQTT acquisition starts', async t => {
  const store = new Store(':memory:'), publications = [];
  store.setState('floor-override:v1', { version: 1, outstanding: { owner: 'fixture-previous-owner' } });
  const engine = new Engine({ store, clock: () => NOW,
    config: { input: 'mqtt', settings: validateSettings() },
    commandTransport: { publish: async commands => publications.push(commands), close: async () => {} } });
  t.after(async () => { await engine.executor.close({ restore: false }); store.close(); });
  assert.equal(engine.executor.floorOverride, engine.floorOverride);
  assert.equal(engine.preheatValveStatus().restorationPending, true);
  const result = await engine.executor.execute({ phase: 'reduction', commands: ['reduction'], expiresAt: NOW + 60_000 },
    { automationEnabled: true, now: NOW });
  assert.equal(result.restorationPending, true);
  assert.deepEqual(publications, []);
});
