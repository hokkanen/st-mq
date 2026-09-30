import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Executor } from '../src/app/executor.js';
import { Engine } from '../src/app/engine.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { floorOverrideConfiguration } from '../src/control/floor-override.js';

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

async function mqttFixture(t, { authority = true, enabled = true, savedStore = null, prefix = 'invented-floor', broker = 'mqtt://invented.invalid', username = 'invented-user' } = {}) {
  const client = new EventEmitter(), publications = [], subscriptions = [], store = savedStore ?? memoryStore();
  client.connected = true; client._storeProcessing = false;
  let capture, messageId = 0;
  client.getLastMessageId = () => messageId;
  client.subscribe = (topic, options, done) => { subscriptions.push(topic); done(null, [{ topic, qos: 1 }]); };
  client.publish = (topic, payload, options, done) => {
    const command = JSON.parse(payload); publications.push({ topic, command, options }); messageId++;
    client.emit('packetsend', { cmd: 'publish', topic, payload, messageId });
    done();
    if (topic.endsWith('/stmq/floor/command')) queueMicrotask(() => client.emit('message', topic.replace('/command', '/status'),
      Buffer.from(JSON.stringify({ protocol: 'stmq-floor-v1', requestId: command.requestId, boot: 1,
        sequence: command.sequence ?? 0, owner: command.owner ?? null, expiresAt: command.expiresAt ?? 0,
        at: NOW / 1000, ready: true, clockOk: true,
        channels: [0, 1].map(id => ({ id, output: command.action === 'lease' })) })), {}));
  };
  client.end = (force, options, done) => done();
  const config = { input: 'mqtt', deviceId: null, h66: {},
    floorPreheat: floorOverrideConfiguration({ enabled, commissioned: true,
      storage: { topic_prefix: `${prefix}-storage` }, living: { topic_prefix: `${prefix}-living` } }),
    connections: { mqtt: { address: broker, user: username } } };
  const engine = { clock: () => NOW, ingest() {}, rememberObservation() {} };
  capture = await startMqtt({ engine, store, config, connect: () => client, canControl: () => authority });
  await flush(); t.after(() => capture.close({ restore: false }));
  return { client, capture, engine, config, publications, subscriptions, store };
}

test('MQTT lifecycle wires the dedicated floor topics and suppresses writes without control authority', async t => {
  const f = await mqttFixture(t, { authority: false });
  assert.equal(f.capture.floorOverride, f.engine.floorOverride);
  assert.equal(f.subscriptions.filter(topic => topic.endsWith('/stmq/floor/status')).length, 2);
  assert.equal(f.publications.length, 0, 'Even startup probes are blocked on the replica');
  await assert.rejects(f.capture.floorOverride.lease({ owner: 'forbidden', until: NOW + 60_000 }), { code: 'FLOOR_CANCELLED' });
  assert.equal(f.publications.length, 0);
});

test('MQTT close without restoration preserves durable lease obligations without transmitting OFF', async t => {
  const f = await mqttFixture(t);
  await f.capture.floorOverride.lease({ owner: 'active-owner', until: NOW + 60_000 });
  const before = f.publications.length;
  await f.capture.close({ restore: false });
  assert.equal(f.publications.length, before);
  assert.equal(f.store.getState('floor-override:v1').outstanding.owner, 'active-owner');
});

test('MQTT outgoing-store replay barrier rejects new floor ON publication', async t => {
  const f = await mqttFixture(t);
  f.client._storeProcessing = true;
  await assert.rejects(f.capture.floorOverride.lease({ owner: 'blocked-replay', until: NOW + 60_000 }));
  assert.equal(f.publications.some(row => row.command.action === 'lease'), false);
  assert(f.store.getState('floor-override:v1').outstanding, 'Unable to confirm release: keep its obligation');
  f.client._storeProcessing = false;
});

test('disabled replacement configuration retains old subscriptions and releases the previously owned outputs', async t => {
  const previous = await mqttFixture(t);
  await previous.capture.floorOverride.lease({ owner: 'interrupted', until: NOW + 60_000 });
  await previous.capture.close({ restore: false });
  const successor = await mqttFixture(t, { enabled: false, savedStore: previous.store, prefix: 'invented-replacement' });
  assert(successor.subscriptions.includes('invented-floor-storage/stmq/floor/status'));
  assert(successor.subscriptions.includes('invented-floor-living/stmq/floor/status'));
  const releases = successor.publications.filter(row => row.command.action === 'release');
  assert.equal(releases.length, 2);
  assert(releases.every(row => row.topic.startsWith('invented-floor-')));
  assert.equal(successor.publications.some(row => row.command.action === 'lease'), false);
  assert.equal(successor.store.getState('floor-override:v1').outstanding, null);
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
  assert.notEqual(owners[0], owners[1], 'The previous released owner is fenced by the device script');
  assert.equal(f.executor.status().manualRequested.expiresAt, NOW + 900_000);
});


test('learning context distinguishes inactive, confirmed, partial and missing floor output evidence', () => {
  const channels = outputs => ['storage', 'living'].map((group, index) => ({ group, available: true,
    channels: [0, 1].map(id => ({ id, output: outputs[index * 2 + id] })) }));
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

test('changing broker or account cannot release old floor ownership through a different route', async t => {
  for (const change of [{ broker: 'mqtt://invented-other.invalid' }, { username: 'invented-other-user' }]) {
    const original = await mqttFixture(t);
    await original.capture.floorOverride.lease({ owner: 'broker-scoped-owner', until: NOW + 60_000 });
    const saved = original.store.getState('floor-override:v1');
    assert.match(saved.outstanding.brokerDigest, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(saved).includes('mqtt://invented.invalid'), false);
    assert.equal(JSON.stringify(saved).includes('invented-user'), false);
    await original.capture.close({ restore: false });
    const changed = await mqttFixture(t, { ...change, savedStore: original.store });
    assert.equal(changed.publications.length, 0, 'Do not send even a script probe through the mismatched route');
    assert.equal(changed.capture.floorOverride.status().brokerMismatch, true);
    assert.equal(changed.capture.floorOverride.status().restorationPending, true);
    await assert.rejects(changed.capture.floorOverride.lease({ owner: 'new-owner', until: NOW + 60_000 }), { code: 'FLOOR_PENDING' });
    assert.equal((await changed.capture.floorOverride.release()).released, false);
    assert.equal(changed.publications.length, 0);
    await changed.capture.close({ restore: false });
    const restored = await mqttFixture(t, { savedStore: original.store });
    assert.equal(restored.publications.filter(row => row.command.action === 'release').length, 2);
    assert.equal(restored.store.getState('floor-override:v1').outstanding, null);
    assert.equal(restored.capture.floorOverride.status().brokerMismatch, false);
  }
});

test('a replica cannot discharge matching-broker floor obligations or start a replacement lease', async t => {
  const primary = await mqttFixture(t);
  await primary.capture.floorOverride.lease({ owner: 'primary-owner', until: NOW + 60_000 });
  await primary.capture.close({ restore: false });
  const replica = await mqttFixture(t, { authority: false, savedStore: primary.store });
  assert.equal(replica.publications.length, 0);
  assert.equal(replica.capture.floorOverride.status().restorationPending, true);
  assert.equal(replica.store.getState('floor-override:v1').outstanding.owner, 'primary-owner');
  await assert.rejects(replica.capture.floorOverride.lease({ owner: 'replica-owner', until: NOW + 60_000 }), { code: 'FLOOR_CANCELLED' });
  assert.equal(replica.publications.length, 0);
});
