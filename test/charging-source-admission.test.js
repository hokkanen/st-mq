import { createChargingController } from '../src/charging/controller.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { loadConfig } from '../src/app/config.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { normalizeScheduleState, easeeChargerTelemetry, createEaseeScheduleAdapter } from '../src/charging/easee.js';

const START = Date.parse('2026-10-09T10:00:00Z');
const settle = async store => { await new Promise(resolve => setImmediate(resolve)); await store.runWrite(() => {}); };

async function fixture(t, { bufferSubscription = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-source-flow-'));
  const store = new Store(join(directory, 'history.sqlite'));
  const reader = new DatabaseSync(store.path);
  const saved = key => JSON.parse(reader.prepare('SELECT value FROM state WHERE key=?').get(key).value);
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory }, directory),
    input: 'mqtt', deviceId: null, connections: { mqtt: { address: 'mqtt://synthetic.invalid' },
      easee: { charger_id: 'synthetic-source-flow' }, teslamate: { enabled: true, carId: '1' } } };
  let now = START, fault = null, subscription;
  let buffer = bufferSubscription;
  const nativeCommands = [], errors = [], client = new EventEmitter(); let controllerOptions;
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
  const nativeObservation = (id,value) => ({id,value,timestamp:new Date(now).toISOString()});
  const adapter=createEaseeScheduleAdapter({chargerId:'synthetic-source-flow',clock:()=>now,canControl:()=>true,
    waitForReadback:async()=>{},request:async(url,options)=>{
      if(options.method==='GET'){
        if(url.endsWith('/schedules'))return structuredClone(physical.schedule);
        return [nativeObservation(250,true),nativeObservation(31,true),nativeObservation(109,physical.mode),
          nativeObservation(96,physical.schedule.enabled==='none'?0:54),nativeObservation(47,16),
          nativeObservation(48,32),nativeObservation(104,32),nativeObservation(120,physical.powerKw),
          ...[22,23,24].map(id=>nativeObservation(id,20)),...[230,231,232].map(id=>nativeObservation(id,12))];
      }
      assert.equal(options.controlGuard?.(),true);
      assert.equal(store.db.isTransaction,false);
      assert.ok(store.getState(runtime.ownershipKey('charger1')).pending);
      nativeCommands.push({url,source:runtime.teslaCapture?.snapshot().healthy,
        identity:runtime.telemetry().charger1.vehicle.id,soc:runtime.telemetry().charger1.soc,
        body:options.body?JSON.parse(options.body):null});
      if(url.endsWith('/disable'))physical.schedule.enabled='none';
      else {const {enabled,...delayed}=JSON.parse(options.body);physical.schedule=normalizeScheduleState({enabled:'delayed',delayed});}
      return '';
    }});
  adapter.createController=options=>{controllerOptions=options;return createChargingController(options);};
  await runtime.setAdapter('charger1', adapter);
  await runtime.reconcile('charger1', { refreshPlan: false });
  client.subscribe = (topic, _options, done) => {
    if (buffer === 'bmw' ? topic === runtime.mqttRoutes().find(route => route.id === 'bmw').topic
      : buffer && topic === 'teslamate/cars/1/#') subscription = () => done(null, [{ topic, qos: 0 }]);
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
    fault = null; if (reader.isTransaction) reader.exec('ROLLBACK'); await capture.close({ restore: false }); await runtime.close();
    reader.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { runtime, store, reader, saved, send, connect, nativeCommands, errors, client, physical, adapter, controllerOptions,
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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const rejectReceipt = async (f, topic, value, fault = 'IOERR') => {
  f.setFault(fault);
  f.client.emit('message', topic, Buffer.from(typeof value === 'object' ? JSON.stringify(value) : String(value)), {});
  await new Promise(resolve => setImmediate(resolve));
  f.setFault(null); await settle(f.store);
};
const teslaTopic = field => `teslamate/cars/1/${field}`;
const bmw = (at, patch = {}) => ({ provider: 'bmw-cardata', soc: 60, readingId: `soc-${at}`, measuredAt: at,
  pluggedIn: true, charging: true, atHome: true,
  fields: Object.fromEntries(['pluggedIn', 'charging', 'atHome'].map(field => [field, { readingId: `${field}-${at}`, measuredAt: at }])), ...patch });
const sendBmw = async (f, value, packet = {}) => {
  f.client.emit('message', f.runtime.mqttRoutes().find(route => route.id === 'bmw').topic, Buffer.from(JSON.stringify(value)), packet);
  await settle(f.store);
};

for (const fault of ['IOERR', 'FULL']) for (const [field, rejected] of [['plugged_in', false], ['geofence', 'Away'], ['charge_current_request', 0]])
  test(`ordinary Tesla ${field} ${fault} failure withholds source evidence until relevant live admission`, async t => {
    const f = await fixture(t); await f.connect(); await f.send('charger_power', 7);
    await f.send('charge_current_request_max', 16); await f.send('charge_current_request', 10);
    const identity = structuredClone(f.runtime.chargers.charger1.vehicleMatch);
    const source = f.saved('charging:teslamate'), runtime = f.saved(f.runtime.key);
    f.advance(1000); await rejectReceipt(f, teslaTopic(field), rejected, fault);
    assert.deepEqual(f.saved('charging:teslamate'), source);
    assert.deepEqual(f.saved(f.runtime.key), runtime);
    assert.deepEqual(f.runtime.chargers.charger1.vehicleMatch, identity);
    let snapshot = f.runtime.teslaCapture.snapshot();
    assert.equal(snapshot.connected, true, 'A source admission failure is distinct from MQTT disconnection.');
    assert.equal(snapshot.healthy, false);
    assert.equal(snapshot.reception.reason, 'vehicle-observation-admission-failed');
    assert.deepEqual(snapshot.fields, source.fields, 'Failure never renews original clocks.');
    await f.send('battery_level', 36); await f.send('healthy', true);
    for (const packet of [{ retain: true }, { dup: true }]) await f.send(field, rejected, packet);
    snapshot = f.runtime.teslaCapture.snapshot();
    assert.equal(snapshot.healthy, false, 'Unrelated, retained and duplicate packets cannot heal the failed field.');
    const projected = f.runtime.telemetry().charger1;
    assert.equal(projected.soc.available, false);
    assert.equal(projected.soc.value, null);
    assert.equal(projected.soc.lastKnownValue, 36);
    assert.equal(projected.soc.reason, 'vehicle-observation-admission-failed');
    assert.equal(projected.vehicleCurrentA.available, false);
    assert.deepEqual(f.nativeCommands, []);
    f.advance(1000); await f.send(field, rejected);
    assert.equal(f.runtime.teslaCapture.snapshot().healthy, true);
    assert.equal(f.saved('charging:teslamate').fields[field].value, rejected);
    if (field === 'charge_current_request') assert.equal(f.runtime.telemetry().charger1.vehicleCurrentA.value, 0);
    else assert.equal(f.runtime.chargers.charger1.vehicleMatch, null);
  });

test('pending ordinary Tesla receipt withdraws evidence before the write queue admits it', async t => {
  const f = await fixture(t); await f.connect(); await f.send('charger_power', 7);
  const source = f.saved('charging:teslamate');
  f.reader.exec('BEGIN IMMEDIATE'); f.advance(1000);
  f.client.emit('message', teslaTopic('plugged_in'), Buffer.from('false'), {});
  assert.equal(f.runtime.teslaCapture.snapshot().healthy, false);
  assert.equal(f.runtime.teslaCapture.reception().reason, 'vehicle-observation-storage-pending');
  await delay(30);
  assert.deepEqual(f.saved('charging:teslamate'), source);
  assert.equal(f.runtime.telemetry().charger1.soc.available, false);
  assert.deepEqual(f.nativeCommands, []);
  f.reader.exec('ROLLBACK'); await settle(f.store);
  assert.equal(f.runtime.teslaCapture.snapshot().healthy, true);
  assert.equal(f.runtime.chargers.charger1.vehicleMatch, null);
  assert.equal(f.saved('charging:teslamate').fields.plugged_in.receivedAt, f.now);
});

test('a postcommit observer failure cannot poison successfully admitted Tesla evidence', async t => {
  const f = await fixture(t); await f.connect(); await f.send('charger_power', 7);
  const setState = f.store.setState.bind(f.store); let injected = false;
  f.store.setState = (key, value) => {
    setState(key, value);
    if (!injected && key === 'charging:teslamate' && value.fields.battery_level.value === 36) {
      injected = true; f.store.afterCommit(() => { throw new Error('Synthetic observer failure'); });
    }
  };
  await f.send('battery_level', 36);
  assert.equal(injected, true);
  assert.equal(f.saved('charging:teslamate').fields.battery_level.value, 36);
  assert.equal(f.runtime.teslaCapture.snapshot().healthy, true);
  assert.equal(f.runtime.telemetry().charger1.soc.value, 36);
});

test('a native replacement during failed Tesla admission cannot inherit identity or session references', async t => {
  const f = await fixture(t); await f.connect(); await f.send('charger_power', 7);
  const original = structuredClone(f.runtime.chargers.charger1.request);
  f.advance(1000); await rejectReceipt(f, teslaTopic('plugged_in'), false);
  await f.reconnect();
  const replacement = f.runtime.chargers.charger1;
  assert.notEqual(replacement.request.scope, original.scope);
  assert.equal(replacement.vehicleMatch, null);
  assert.deepEqual(replacement.request.overrides, {});
  await f.send('plugged_in', true);
  assert.equal(f.runtime.teslaCapture.snapshot().healthy, true);
  assert.equal(replacement.vehicleMatch, null, 'Old consumed power cannot identify the replacement connection.');
  assert.equal(f.runtime.telemetry().charger1.vehicle.id, null);
});

test('source failure invalidates cached cloud plans while a rebuilt labelled-reference plan remains usable', async t => {
  const f = await fixture(t); await f.connect(); await f.send('charger_power', 7);
  const item = f.runtime.chargers.charger1;
  await f.runtime.setControl('charger1', { association: item.association, revision: item.controls.revision, enabled: true });
  const plan = { id: 'accepted-before-source-failure', startAt: f.now + 3 * 3600_000 };
  item.plan = plan; item.replan = false; f.runtime.pricesInitialized = true;
  f.runtime.coordination = { at: f.now, allocations: [] };
  item.limiterPlanBasis = f.runtime.currentPlanBasis(item);
  const before = item.limiterPlanBasis;
  f.advance(1000); await rejectReceipt(f, teslaTopic('plugged_in'), false); await f.send('battery_level', 36);
  assert.notEqual(f.runtime.currentPlanBasis(item), before);
  assert.equal(f.runtime.currentPlanReusable(item, { session: item.controller.status().session }), false);
  let replans = 0;
  f.runtime.updatePlan = async () => {
    replans++;
    assert.equal(f.runtime.telemetry().charger1.soc.available, false);
    // An unavailable/failed planner deliberately leaves its previous result.
  };
  await f.runtime.reconcile('charger1', { refreshPlan: false });
  assert.ok(replans > 0);
  assert.deepEqual(f.nativeCommands, [], 'Failure cannot dispatch an old plan under its former source evidence.');
  f.runtime.updatePlan = async () => {
    assert.equal(f.runtime.telemetry().charger1.soc.available, false);
    item.plan = { ...plan, id: 'rebuilt-from-session-reference' };
    item.limiterPlanBasis = f.runtime.currentPlanBasis(item);
  };
  await f.runtime.reconcile('charger1', { refreshPlan: false });
  assert.equal(f.nativeCommands.length, 1, 'Explicitly rebuilt same-session reference planning is not globally disabled.');
  assert.equal(f.nativeCommands[0].source, false);
  assert.equal(f.nativeCommands[0].soc.available, false);
  assert.equal(item.controller.status().owned.planId, 'rebuilt-from-session-reference');
});

for (const fault of ['IOERR', 'FULL']) test(`BMW ${fault} failure is source-local and unrelated partial readings cannot heal it`, async t => {
  const f = await fixture(t); await f.connect(); await f.send('charger_power', 7);
  await sendBmw(f, bmw(f.now, { charging: false }));
  const source = structuredClone(f.runtime.vehicleFeeds.bmw.reading);
  const teslaIdentity = structuredClone(f.runtime.chargers.charger1.vehicleMatch);
  const topic = f.runtime.mqttRoutes().find(route => route.id === 'bmw').topic;
  f.advance(1000);
  const departure = { provider: 'bmw-cardata', pluggedIn: false,
    fields: { pluggedIn: { readingId: 'bmw-departure', measuredAt: f.now } } };
  await rejectReceipt(f, topic, departure, fault);
  assert.deepEqual(f.runtime.vehicleFeeds.bmw.reading, source);
  assert.equal(f.runtime.status().vehicleFeeds.find(feed => feed.id === 'bmw').reception.available, false);
  assert.equal(f.runtime.teslaCapture.snapshot().healthy, true, 'A separate vehicle source retains its own authority.');
  assert.deepEqual(f.runtime.chargers.charger1.vehicleMatch, teslaIdentity);
  await sendBmw(f, { provider: 'bmw-cardata', soc: 61, readingId: 'bmw-new-soc', measuredAt: f.now });
  for (const packet of [{ retain: true }, { dup: true }]) await sendBmw(f, departure, packet);
  assert.equal(f.runtime.status().vehicleFeeds.find(feed => feed.id === 'bmw').reception.available, false);
  f.advance(1000);
  await sendBmw(f, { ...departure, fields: { pluggedIn: { readingId: 'bmw-fresh-departure', measuredAt: f.now } } });
  assert.equal(f.runtime.status().vehicleFeeds.find(feed => feed.id === 'bmw').reception.available, true);
  assert.equal(f.runtime.vehicleFeeds.bmw.reading.pluggedIn, false);
  assert.equal(f.runtime.vehicleFeeds.bmw.reading.measuredAt, source.measuredAt + 1000);
});


for (const outcome of ['failed', 'pending', 'healthy']) test(`a ${outcome} source receipt during native preflight respects the selected command generation`, async t => {
  const f = await fixture(t); await f.connect(); await f.send('charger_power', 7);
  const item = f.runtime.chargers.charger1;
  await f.runtime.setControl('charger1', { association: item.association, revision: item.controls.revision, enabled: true });
  item.plan = { id: 'selected-before-receipt', startAt: f.now + 3 * 3600_000 }; item.replan = false;
  f.runtime.pricesInitialized = true; f.runtime.coordination = { at: f.now, allocations: [] };
  item.limiterPlanBasis = f.runtime.currentPlanBasis(item);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
  const install = f.adapter.installDelayed.bind(f.adapter);
  f.adapter.installDelayed = async args => { entered(); await wait; return install(args); };
  const flight = f.runtime.reconcile('charger1', { refreshPlan: false }); await started;
  assert.equal(f.nativeCommands.length, 0);
  f.advance(1000);
  if (outcome === 'failed') await rejectReceipt(f, teslaTopic('plugged_in'), false);
  else if (outcome === 'pending') {
    f.reader.exec('BEGIN IMMEDIATE');
    f.client.emit('message', teslaTopic('plugged_in'), Buffer.from('false'), {});
    assert.equal(f.runtime.teslaCapture.reception().admission.pending, true);
    // Resolve the database wait after the native preflight is released. The
    // generation must already be cancelled at receipt, before this commit.
    setImmediate(() => f.reader.exec('ROLLBACK'));
  } else await f.send('healthy', true);
  release(); await flight; await settle(f.store);
  assert.equal(f.nativeCommands.length, outcome === 'healthy' ? 1 : 0);
  assert.equal(item.controller.status().owned?.planId ?? null, outcome === 'healthy' ? 'selected-before-receipt' : null);
});

test('ordinary accepted source reports save their battery references without additional energy history reads', async t => {
  const f = await fixture(t); await f.connect(); await f.send('charger_power', 7);
  let energyReads = 0, runtimeSaves = 0;
  const readEnergy = f.runtime.readEnergy, setState = f.store.setState.bind(f.store);
  f.runtime.readEnergy = (...args) => { energyReads++; return readEnergy(...args); };
  f.store.setState = (key, value) => { if (key === f.runtime.key) runtimeSaves++; return setState(key, value); };
  await f.store.runWrite(() => f.runtime.persist());
  const existingPersistenceReads = energyReads; energyReads = 0; runtimeSaves = 0;
  f.advance(1000); await f.send('charge_limit_soc', 100);
  assert.equal(runtimeSaves, 1, 'Source and session references share the existing runtime state save.');
  assert.equal(energyReads, existingPersistenceReads, 'Reference capture adds no history scan beyond existing persistence diagnostics.');
  const accepted = f.saved(f.runtime.key).chargers.charger1.progress;
  assert.equal(accepted.batteryInputs.minimumSoc.value, 100);
  await rejectReceipt(f, teslaTopic('plugged_in'), false);
  const view = f.runtime.views().find(row => row.id === 'charger1');
  assert.equal(view.values.minimumSoc.value, 100);
  assert.equal(view.values.minimumSoc.retainedForSession, true);
  assert.equal(view.values.minimumSoc.receivedAt, f.now);
});

test('an identified BMW retains committed references during failed departure and ends them on fresh admitted departure', async t => {
  const f = await fixture(t);
  await sendBmw(f, bmw(f.now, { chargeLimitSoc: 100, usableCapacityKwh: 72,
    fields: { ...bmw(f.now).fields, chargeLimitSoc: { readingId: 'target100', measuredAt: f.now },
      usableCapacityKwh: { readingId: 'capacity72', measuredAt: f.now } } }));
  f.advance(30_000); Object.assign(f.physical, { mode: 2, powerKw: 0, modeAt: f.now, powerAt: f.now });
  await f.runtime.reconcile('charger1', { refreshPlan: false });
  await sendBmw(f, { provider: 'bmw-cardata', charging: false,
    fields: { charging: { readingId: 'bmw-stopped', measuredAt: f.now } } });
  assert.equal(f.runtime.chargers.charger1.vehicleMatch?.id, 'bmw');
  const before = f.saved(f.runtime.key), source = structuredClone(f.runtime.vehicleFeeds.bmw.reading);
  const topic = f.runtime.mqttRoutes().find(route => route.id === 'bmw').topic;
  f.advance(1000);
  const departure = { provider: 'bmw-cardata', pluggedIn: false,
    fields: { pluggedIn: { readingId: 'identified-departure', measuredAt: f.now } } };
  await rejectReceipt(f, topic, departure);
  assert.deepEqual(f.saved(f.runtime.key), before);
  assert.deepEqual(f.runtime.vehicleFeeds.bmw.reading, source);
  let view = f.runtime.views().find(row => row.id === 'charger1');
  assert.equal(view.vehicle.id, 'bmw'); assert.equal(f.runtime.telemetry().charger1.soc.available, false);
  assert.equal(view.progress.referenceSoc.source, 'bmw-cardata');
  assert.equal(view.values.minimumSoc.value, 100); assert.equal(view.values.capacityKwh.value, 72);
  assert.equal(view.values.minimumSoc.retainedForSession, true);
  await sendBmw(f, departure);
  view = f.runtime.views().find(row => row.id === 'charger1');
  assert.equal(view.vehicle.id, null);
  assert.equal(f.runtime.vehicleFeeds.bmw.reading.pluggedIn, false);
});

const fakeSourceTime = t => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return async ms => {
    elapsed += ms; t.mock.timers.tick(ms);
    for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setImmediate(resolve));
  };
};

test('a deferred BMW receipt retries failed COMMIT with its original clocks and can recover its own field', async t => {
  const elapse = fakeSourceTime(t), f = await fixture(t); await sendBmw(f, bmw(f.now));
  const previous = structuredClone(f.runtime.vehicleFeeds.bmw.reading), receivedAt = f.now, measuredAt = f.now + 400;
  await sendBmw(f, { provider: 'bmw-cardata', pluggedIn: false,
    fields: { pluggedIn: { readingId: 'future-departure', measuredAt } } });
  assert.equal(f.runtime.vehicleFeeds.bmw.sourcePending.size, 1);
  assert.equal(f.runtime.status().vehicleFeeds.find(row => row.id === 'bmw').reception.available, false);
  f.advance(400); f.setFault('IOERR'); await elapse(400);
  assert.equal(f.runtime.vehicleFeeds.bmw.sourcePending.size, 1);
  assert.deepEqual(f.runtime.vehicleFeeds.bmw.reading, previous);
  assert.equal(f.runtime.status().vehicleFeeds.find(row => row.id === 'bmw').reception.admission.failed, true);
  f.setFault(null); await elapse(100); await settle(f.store);
  const feed = f.runtime.vehicleFeeds.bmw, field = feed.reading.fields.pluggedIn;
  assert.equal(feed.sourcePending.size, 0);
  assert.equal(feed.reading.pluggedIn, false); assert.equal(field.readingId, 'future-departure');
  assert.equal(field.measuredAt, measuredAt); assert.equal(field.receivedAt, receivedAt);
  assert.equal(field.admittedAt, measuredAt);
  assert.equal(f.runtime.status().vehicleFeeds.find(row => row.id === 'bmw').reception.available, true);
});

for (const rejection of ['expiry', 'overflow']) test(`BMW source-time ${rejection} cannot silently heal a rejected field`, async t => {
  const elapse = fakeSourceTime(t), f = await fixture(t); await sendBmw(f, bmw(f.now));
  const previous = structuredClone(f.runtime.vehicleFeeds.bmw.reading), measuredAt = f.now + 400;
  for (let index = 0; index < (rejection === 'overflow' ? 129 : 1); index++)
    await sendBmw(f, { provider: 'bmw-cardata', pluggedIn: false,
      fields: { pluggedIn: { readingId: `quarantined-${index}`, measuredAt } } });
  await elapse(5001); await settle(f.store);
  assert.equal(f.runtime.vehicleFeeds.bmw.sourcePending.size, 0);
  assert.deepEqual(f.runtime.vehicleFeeds.bmw.reading, previous);
  assert.equal(f.runtime.status().vehicleFeeds.find(row => row.id === 'bmw').reception.admission.failed, true);
  await sendBmw(f, { provider: 'bmw-cardata', soc: 61, measuredAt: f.now, readingId: 'unrelated-after-expiry' });
  assert.equal(f.runtime.status().vehicleFeeds.find(row => row.id === 'bmw').reception.available, false);
  f.advance(1000); await sendBmw(f, { provider: 'bmw-cardata', pluggedIn: true,
    fields: { pluggedIn: { readingId: 'fresh-after-expiry', measuredAt: f.now } } });
  assert.equal(f.runtime.status().vehicleFeeds.find(row => row.id === 'bmw').reception.available, true);
  assert.equal(f.runtime.vehicleFeeds.bmw.reading.fields.pluggedIn.measuredAt, f.now);
});

for (const fault of ['statement', 'COMMIT']) test(`BMW buffered departure ${fault} failure requires a fresh subscription`, async t => {
  const f = await fixture(t); await sendBmw(f, bmw(f.now));
  const previous = structuredClone(f.runtime.vehicleFeeds.bmw.reading);
  await f.reconnectMqtt('bmw'); f.advance(1000);
  await sendBmw(f, { provider: 'bmw-cardata', pluggedIn: false,
    fields: { pluggedIn: { readingId: 'buffered-departure', measuredAt: f.now } } });
  const setState = f.store.setState.bind(f.store);
  if (fault === 'COMMIT') f.setFault('IOERR');
  else f.store.setState = (key, value) => {
    if (key === f.runtime.key && value.vehicleFeeds.bmw.reading.pluggedIn === false)
      throw Object.assign(new Error('Synthetic buffered BMW failure'), { code: 'SQLITE_FULL' });
    return setState(key, value);
  };
  await f.releaseFailedSubscription();
  f.setFault(null); f.store.setState = setState; await settle(f.store);
  assert.deepEqual(f.runtime.vehicleFeeds.bmw.reading, previous);
  assert.deepEqual(f.saved(f.runtime.key).vehicleFeeds.bmw.reading, previous);
  let reception = f.runtime.status().vehicleFeeds.find(row => row.id === 'bmw').reception;
  assert.equal(reception.available, false); assert.equal(reception.subscribed, false);
  await sendBmw(f, { provider: 'bmw-cardata', soc: 61, measuredAt: f.now, readingId: 'after-rejected-subscription' });
  reception = f.runtime.status().vehicleFeeds.find(row => row.id === 'bmw').reception;
  assert.equal(reception.available, false);
  assert.deepEqual(f.runtime.vehicleFeeds.bmw.reading, previous);
  await f.reconnectMqtt(false); f.advance(1000); await sendBmw(f, bmw(f.now, { pluggedIn: false }));
  assert.equal(f.runtime.status().vehicleFeeds.find(row => row.id === 'bmw').reception.available, true);
  assert.equal(f.runtime.vehicleFeeds.bmw.reading.pluggedIn, false);
});

test('BMW source-time rejection after successful SUBACK keeps its original buffered receipt fence', async t => {
  const elapse = fakeSourceTime(t), f = await fixture(t); await sendBmw(f, bmw(f.now));
  const previous = structuredClone(f.runtime.vehicleFeeds.bmw.reading);
  await f.reconnectMqtt('bmw');
  await sendBmw(f, { provider: 'bmw-cardata', pluggedIn: false,
    fields: { pluggedIn: { readingId: 'buffered-future', measuredAt: f.now + 400 } } });
  await f.releaseSubscription();
  assert.equal(f.runtime.vehicleFeeds.bmw.sourcePending.size, 1);
  await elapse(5001); await settle(f.store);
  assert.equal(f.runtime.vehicleFeeds.bmw.sourcePending.size, 0);
  assert.deepEqual(f.runtime.vehicleFeeds.bmw.reading, previous);
  assert.equal(f.runtime.status().vehicleFeeds.find(row => row.id === 'bmw').reception.admission.failed, true);
  await sendBmw(f, { provider: 'bmw-cardata', soc: 62, readingId: 'unrelated-buffered-expiry', measuredAt: f.now });
  assert.equal(f.runtime.status().vehicleFeeds.find(row => row.id === 'bmw').reception.available, false);
  f.advance(1000); await sendBmw(f, bmw(f.now));
  assert.equal(f.runtime.status().vehicleFeeds.find(row => row.id === 'bmw').reception.available, true);
});

test('BMW subscription overflow cannot discard a departure and publish the remaining packets as healthy', async t => {
  const f = await fixture(t); await sendBmw(f, bmw(f.now));
  const previous = structuredClone(f.runtime.vehicleFeeds.bmw.reading);
  await f.reconnectMqtt('bmw'); f.advance(1000);
  await sendBmw(f, { provider: 'bmw-cardata', pluggedIn: false,
    fields: { pluggedIn: { readingId: 'overflow-departure', measuredAt: f.now } } });
  for (let index = 0; index < 32; index++) {
    f.advance(1); await sendBmw(f, { provider: 'bmw-cardata', soc: 61, measuredAt: f.now, readingId: `overflow-soc-${index}` });
  }
  await f.releaseSubscription();
  const reception = f.runtime.status().vehicleFeeds.find(row => row.id === 'bmw').reception;
  assert.equal(reception.available, false); assert.equal(reception.subscribed, false);
  assert.deepEqual(f.runtime.vehicleFeeds.bmw.reading, previous);
  assert.deepEqual(f.saved(f.runtime.key).vehicleFeeds.bmw.reading, previous);
  await sendBmw(f, { provider: 'bmw-cardata', soc: 62, measuredAt: f.now, readingId: 'after-overflow' });
  assert.equal(f.runtime.status().vehicleFeeds.find(row => row.id === 'bmw').reception.available, false);
  await f.reconnectMqtt(false); f.advance(1000); await sendBmw(f, bmw(f.now, { pluggedIn: false }));
  assert.equal(f.runtime.status().vehicleFeeds.find(row => row.id === 'bmw').reception.available, true);
  assert.equal(f.runtime.vehicleFeeds.bmw.reading.pluggedIn, false);
});
