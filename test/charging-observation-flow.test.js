import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { loadConfig } from '../src/app/config.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { normalizeScheduleState, easeeChargerTelemetry } from '../src/charging/easee.js';

const START = Date.parse('2026-10-09T10:00:00Z');
const settle = async store => { await new Promise(resolve => setImmediate(resolve)); await store.runWrite(() => {}); };

async function fixture(t, { bufferSubscription = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-source-flow-'));
  const store = new Store(join(directory, 'history.sqlite'));
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory }, directory),
    input: 'mqtt', deviceId: null, connections: { mqtt: { address: 'mqtt://synthetic.invalid' },
      easee: { charger_id: 'synthetic-source-flow' }, teslamate: { enabled: true, carId: '1' } } };
  let now = START, fault = null, subscription;
  let buffer = bufferSubscription;
  const nativeCommands = [], errors = [], client = new EventEmitter();
  const engine = new Engine({ store, config, clock: () => now }), runtime = engine.charging;
  // Planning is deliberately absent: only acquisition and native reconciliation
  // can admit state. There is no dashboard, engine tick or forced plan refresh.
  runtime.tick = () => {};
  runtime.updatePlan = async () => {};
  runtime.scheduleWakeup = () => {};
  for (const id of ['charger1', 'charger2']) await runtime.setControl(id, {
    association: runtime.chargers[id].association, revision: runtime.chargers[id].controls.revision, enabled: false });
  let connectedAt = START;
  const physical = { online: true, enabled: true, controlKnown: true, pluggedIn: true, mode: 3,
    powerKw: 7, modeAt: START, powerAt: START, reason: 0, reasonAt: START,
    limits: { chargerA: 16, cableA: 16, circuitA: [16, 16, 16] }, schedule: normalizeScheduleState({ enabled: 'none' }) };
  const adapter = { normalize: easeeChargerTelemetry,
    read: async () => ({ ...structuredClone(physical), readAt: now,
      observations: { 109: { value: physical.mode, at: physical.modeAt }, 120: { value: physical.powerKw, at: physical.powerAt } } }),
    installDelayed: async () => { nativeCommands.push('install'); throw new Error('Unexpected native command'); },
    clear: async () => { nativeCommands.push('clear'); throw new Error('Unexpected native command'); } };
  await runtime.setAdapter('charger1', adapter);
  await runtime.reconcile('charger1', { refreshPlan: false });
  client.subscribe = (topic, _options, done) => {
    if (buffer && topic === 'teslamate/cars/1/#') subscription = () => done(null, [{ topic, qos: 0 }]);
    else done(null, [{ topic, qos: 0 }]);
  };
  client.unsubscribe = (_topic, done) => done?.(); client.end = (_force, _options, done) => done?.();
  const capture = await startMqtt({ engine, store, config, connect: () => client,
    reportStorageFailure: event => errors.push(event) });
  client.emit('connect'); await settle(store);
  const exec = store.db.exec.bind(store.db);
  store.db.exec = sql => {
    if (sql === 'COMMIT' && fault) throw Object.assign(new Error('Synthetic source admission failure'),
      { code: 'ERR_SQLITE_ERROR', errcode: fault === 'FULL' ? 13 : 10 });
    return exec(sql);
  };
  const send = async (field, value, packet = {}) => {
    client.emit('message', `teslamate/cars/1/${field}`, Buffer.from(String(value)), packet);
    await settle(store);
  };
  const connect = async () => {
    for (const [field, value] of Object.entries({ healthy: true, geofence: 'Home', plugged_in: true,
      charging_state: 'Charging', charger_actual_current: 10, battery_level: 35 })) await send(field, value);
  };
  t.after(async () => {
    fault = null; await capture.close({ restore: false }); await runtime.close();
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { runtime, store, send, connect, nativeCommands, errors, client, physical,
    get now() { return now; }, advance: ms => { now += ms; },
    setFault: value => { fault = value; },
    releaseSubscription: async () => { subscription(); await settle(store); },
    reconnectMqtt: async buffered => { buffer = buffered; client.emit('offline'); await settle(store);
      client.emit('connect'); await settle(store); },
    releaseFailedSubscription: async () => { subscription(); await new Promise(resolve => setImmediate(resolve)); },
    reconnect: async () => {
      now += 1000; Object.assign(physical, { pluggedIn: false, mode: 1, powerKw: 0, modeAt: now, powerAt: now });
      await runtime.reconcile('charger1', { refreshPlan: false });
      now += 1000; connectedAt = now; Object.assign(physical, { pluggedIn: true, mode: 3, powerKw: 7, modeAt: now, powerAt: now });
      await runtime.reconcile('charger1', { refreshPlan: false });
      return connectedAt;
    },
  };
}

test('ordinary live Tesla power admits vehicle identity with Automatic off and no dashboard or planner reads', async t => {
  const f = await fixture(t); await f.connect();
  assert.equal(f.runtime.chargers.charger1.vehicleMatch, null);
  await f.send('charger_power', 7);
  const saved = f.store.getState(f.runtime.key);
  assert.equal(saved.chargers.charger1.controls.enabled, false);
  assert.equal(saved.chargers.charger1.vehicleMatch.id, 'tesla');
  assert.equal(saved.consumedTeslaPower.receivedAt, START);
  assert.equal(f.runtime.chargers.charger1.vehicleMatch.id, 'tesla');
  assert.deepEqual(f.nativeCommands, []);
  const revision = saved.revision, request = structuredClone(saved.chargers.charger1.request);
  f.advance(1000); await f.send('charger_power', 7); await f.send('charger_power', 7, { dup: true });
  assert.equal(f.store.getState(f.runtime.key).revision, revision);
  assert.deepEqual(f.store.getState(f.runtime.key).chargers.charger1.request, request);
  assert.equal(f.runtime.teslaCapture.snapshot().fields.charger_power.receivedAt, START);
});

for (const fault of ['IOERR', 'FULL']) test(`failed ${fault} admission rolls Tesla capture and runtime identity back together`, async t => {
  const f = await fixture(t); await f.connect();
  const runtime = f.store.getState(f.runtime.key), source = f.store.getState('charging:teslamate');
  const before = f.runtime.teslaCapture.snapshot();
  f.setFault(fault);
  f.client.emit('message', 'teslamate/cars/1/charger_power', Buffer.from('7'), {});
  await new Promise(resolve => setImmediate(resolve));
  f.setFault(null); await settle(f.store);
  assert.deepEqual(f.store.getState(f.runtime.key), runtime);
  assert.deepEqual(f.store.getState('charging:teslamate'), source);
  assert.deepEqual(f.runtime.teslaCapture.snapshot(), before);
  assert.equal(f.runtime.chargers.charger1.vehicleMatch, null);
  assert.equal(f.runtime.consumedTeslaPower, null);
  assert.deepEqual(f.nativeCommands, []);
  await f.send('charger_power', 7);
  assert.equal(f.store.getState(f.runtime.key).chargers.charger1.vehicleMatch.id, 'tesla');
});

test('buffered Tesla subscription replay admits each original source once without dashboard reads', async t => {
  const f = await fixture(t, { bufferSubscription: true }); await f.connect();
  await f.send('charger_power', 7);
  assert.equal(f.runtime.chargers.charger1.vehicleMatch, null);
  f.advance(2000); await f.releaseSubscription();
  const saved = f.store.getState(f.runtime.key), source = f.runtime.teslaCapture.snapshot();
  assert.equal(saved.chargers.charger1.vehicleMatch.id, 'tesla');
  assert.equal(source.fields.charger_power.receivedAt, START);
  assert.equal(saved.consumedTeslaPower.receivedAt, START);
  const revision = saved.revision;
  await f.send('charger_power', 7); await f.send('healthy', true);
  assert.equal(f.store.getState(f.runtime.key).revision, revision);
  assert.equal(f.runtime.teslaCapture.snapshot().fields.charger_power.receivedAt, START);
  assert.deepEqual(f.nativeCommands, []);
});

test('native disconnect and reconnect admit a new inert request with Automatic off and no dashboard reads', async t => {
  const f = await fixture(t); await f.connect(); await f.send('charger_power', 7);
  const original = f.store.getState(f.runtime.key).chargers.charger1;
  const connectedAt = await f.reconnect();
  const replacement = f.store.getState(f.runtime.key).chargers.charger1;
  assert.notEqual(replacement.request.sessionId, original.request.sessionId);
  assert.equal(replacement.request.scope, `${replacement.association}:${connectedAt}`);
  assert.equal(replacement.vehicleMatch, null); assert.deepEqual(replacement.request.overrides, {});
  assert.equal(replacement.controls.enabled, false); assert.deepEqual(f.nativeCommands, []);
});

test('a caught buffered source failure cannot commit capture bytes without its runtime identity', async t => {
  const f = await fixture(t, { bufferSubscription: true }); await f.connect(); await f.send('charger_power', 7);
  const setState = f.store.setState.bind(f.store);
  f.store.setState = (key, value) => {
    setState(key, value);
    if (key === f.runtime.key && value.chargers.charger1.vehicleMatch?.id === 'tesla')
      throw Object.assign(new Error('Synthetic failure after state statement'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
  };
  await f.releaseSubscription();
  assert.equal(f.runtime.teslaCapture.snapshot().fields.charger_power, undefined);
  assert.equal(f.store.getState('charging:teslamate').fields.charger_power, undefined);
  assert.equal(f.runtime.chargers.charger1.vehicleMatch, null);
  assert.equal(f.store.getState(f.runtime.key).chargers.charger1.vehicleMatch, null);
  assert.equal(f.runtime.consumedTeslaPower, null);
  assert.equal(f.runtime.teslaCapture.snapshot().healthy, false);
  f.store.setState = setState; f.advance(1000); await f.reconnectMqtt(false); await f.send('healthy', true);
  await f.send('charger_power', 7);
  assert.equal(f.store.getState(f.runtime.key).chargers.charger1.vehicleMatch.id, 'tesla');
  assert.equal(f.runtime.teslaCapture.snapshot().fields.charger_power.receivedAt, f.now);
  assert.deepEqual(f.nativeCommands, []);
});

for (const at of ['source statement', 'runtime statement', 'outer commit'])
  test(`failed buffered Tesla departure at ${at} withholds source authority until fresh subscription`, async t => {
    const f = await fixture(t); await f.connect(); await f.send('charger_power', 7);
    const identity = structuredClone(f.runtime.chargers.charger1.vehicleMatch);
    const sourceBefore = f.store.getState('charging:teslamate');
    f.advance(1000); await f.reconnectMqtt(true);
    await f.send('healthy', true); await f.send('plugged_in', false);
    const setState = f.store.setState.bind(f.store);
    if (at === 'outer commit') f.setFault('IOERR');
    else f.store.setState = (key, value) => {
      setState(key, value);
      if (at === 'source statement' && key === 'charging:teslamate' && value.fields.plugged_in?.value === false
        || at === 'runtime statement' && key === f.runtime.key && !value.chargers.charger1.vehicleMatch)
        throw Object.assign(new Error('Synthetic departure admission failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    };
    await f.releaseFailedSubscription(); f.setFault(null); f.store.setState = setState; await settle(f.store);
    const snapshot = f.runtime.teslaCapture.snapshot();
    assert.equal(snapshot.connected, false); assert.equal(snapshot.healthy, false);
    assert.deepEqual(snapshot.fields.plugged_in, sourceBefore.fields.plugged_in);
    assert.deepEqual(f.store.getState('charging:teslamate').fields.plugged_in, sourceBefore.fields.plugged_in);
    assert.deepEqual(f.runtime.chargers.charger1.vehicleMatch, identity, 'The earlier committed assignment is retained as inert context.');
    await f.send('healthy', true); await f.send('plugged_in', false);
    assert.equal(f.runtime.teslaCapture.snapshot().healthy, false, 'An ordinary packet cannot heal failed subscription admission.');
    await f.reconnectMqtt(false); await f.send('healthy', true); await f.send('plugged_in', false);
    assert.equal(f.runtime.teslaCapture.snapshot().healthy, true);
    assert.equal(f.runtime.chargers.charger1.vehicleMatch, null);
    assert.equal(f.store.getState(f.runtime.key).chargers.charger1.vehicleMatch, null);
    assert.deepEqual(f.nativeCommands, []);
  });
