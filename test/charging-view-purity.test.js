import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { readChargingRuntime } from '../src/charging/runtime-storage.js';
import { easeeChargerTelemetry, normalizeScheduleState } from '../src/charging/easee.js';

const START = Date.parse('2026-10-09T08:00:00Z'), MINUTE = 60_000;
const durableFields = ['controls', 'replan', 'request', 'plan', 'progress', 'supplyEstimate', 'sessionCost',
  'vehicleMatch', 'vehicleEvidence', 'vehicleConflict', 'identification', 'targetState', 'vehicleDisconnect',
  'streamEvidence', 'forecast', 'newEpisode', 'wasPluggedIn', 'limiterPlanBasis', 'commandBasis', 'priceRecheckAt'];

// Native observations are synthetic and already authenticated by the fixture.
// The runtime uses real SQLite transactions, admission rollback, source parsing,
// vehicle matching, projection and restart. No network or household data is used.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-projection-'));
  const store = new Store(join(directory, 'history.sqlite'));
  const reader = new DatabaseSync(store.path, { readOnly: true });
  let now = START, fault = null, runtime;
  const commands = [], runtimes = [];
  const config = { input: 'mqtt', connections: { easee: { charger_id: 'synthetic-projection' },
    mqtt: { address: 'mqtt://synthetic.invalid', user: 'synthetic' }, teslamate: { enabled: true } },
    charging: { defaults: { readyBy: '07:00' }, vehicles: { bmw: { mqttTopic: 'synthetic/bmw', defaults: { readyBy: '08:00' } } } } };
  const tesla = { association: 'synthetic-tesla', healthy: false, atHome: false, pluggedIn: false, fields: {} };
  const control = { phase: 'off', enabled: false, session: { connected: false, connectedAt: null, lastDisconnectedAt: START - 1000 },
    owned: null, pending: null, manual: null, snapshot: { online: true, enabled: true, controlKnown: true,
      pluggedIn: false, mode: 1, modeAt: START, powerKw: 0, powerAt: START, readAt: START,
      reason: 0, reasonAt: START, schedule: normalizeScheduleState({ enabled: 'none' }),
      limits: { chargerA: 16, cableA: 16, circuitA: [16, 16, 16] }, observations: {},
      supply: { voltageV: [230, 230, 230], observationTimes: { voltage: [START, START, START] } } } };
  const create = () => {
    runtime = new ChargingRuntime({ store, engine: {}, config, clock: () => now }); runtimes.push(runtime);
    if (!store.getState(runtime.key)) { for (const item of Object.values(runtime.chargers)) item.controls.enabled = false; runtime.refreshSettings(); }
    runtime.tick = () => {};
    runtime.scheduleWakeup = () => {};
    runtime.teslaCapture = { snapshot: () => structuredClone(tesla) };
    runtime.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
    const item = runtime.chargers.charger1;
    item.adapter = { normalize: easeeChargerTelemetry };
    item.controller = { supportsIdentification: true, status: () => structuredClone(control),
      update: async input => { commands.push(structuredClone(input)); }, close: async () => {} };
    runtime.updatePlan = async () => {};
    return runtime;
  };
  const exec = store.db.exec.bind(store.db);
  store.db.exec = sql => {
    if (sql === 'COMMIT' && fault) throw Object.assign(new Error('Synthetic storage failure'), {
      code: 'ERR_SQLITE_ERROR', errcode: fault === 'FULL' ? 13 : 10 });
    return exec(sql);
  };
  create();
  t.after(async () => {
    fault = null;
    for (const item of runtimes) await item.close();
    reader.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const capture = () => structuredClone({ revision: runtime.revision, controls: runtime.controls, settings: runtime.settings,
    coordination: runtime.coordination, allocationScope: runtime.allocationScope,
    consumedTeslaPower: runtime.consumedTeslaPower, consumedTeslaCurrent: runtime.consumedTeslaCurrent,
    chargers: Object.fromEntries(Object.entries(runtime.chargers).map(([id, item]) => [id,
      { ...Object.fromEntries(durableFields.map(key => [key, item[key]])), native: item.controller?.status() }])),
    vehicleFeeds: Object.fromEntries(Object.entries(runtime.vehicleFeeds).map(([id, feed]) => [id,
      { reading: feed.reading, mqtt: feed.mqtt, consumedPlugId: feed.consumedPlugId, consumedChargingId: feed.consumedChargingId }])) });
  const read = () => JSON.stringify(readChargingRuntime({ db: reader, getState: key => {
    const row = reader.prepare('SELECT value FROM state WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  } }, runtime.key));
  const admit = () => runtime.write(() => runtime.persist());
  const publish = (values, { at = now, retained = false } = {}) => runtime.write(() => runtime.receiveSoc('synthetic/bmw',
    JSON.stringify({ provider: 'bmw-cardata', measuredAt: at, readingId: `synthetic-report-${at}`, ...values, fields: Object.fromEntries(Object.entries(values).map(([key, value]) =>
      [key, { measuredAt: at, readingId: `synthetic-${key}-${value}-${at}` }])) }), { retain: retained }, now));
  const native = ({ connected = control.session.connected, charging = connected, connectedAt = control.session.connectedAt } = {}) => {
    control.session = { ...control.session, connected, connectedAt: connected ? connectedAt ?? now : null,
      ...(connected ? {} : { lastDisconnectedAt: now }) };
    Object.assign(control.snapshot, { pluggedIn: connected, mode: connected ? charging ? 3 : 2 : 1,
      modeAt: now, powerKw: charging && connected ? 7 : 0, powerAt: now, readAt: now });
    control.snapshot.observations = { 109: { value: control.snapshot.mode, at: now }, 120: { value: control.snapshot.powerKw, at: now } };
  };
  const poll = (count, at = now) => {
    const before = capture(), bytes = read(), trace = structuredClone(commands);
    for (let index = 0; index < count; index++) { runtime.telemetry(at); runtime.views(at); runtime.status(at); }
    assert.deepEqual(capture(), before, 'Reading every public projection cannot change runtime, feeds, requests or native state.');
    assert.equal(read(), bytes, 'Polling cannot write or replace the independently readable committed state.');
    assert.deepEqual(commands, trace, 'Polling cannot dispatch or reconcile a native command.');
  };
  return { get runtime() { return runtime; }, get now() { return now; }, store, control, tesla, commands, capture, read, admit, publish, native, poll,
    advance: ms => { now += ms; }, setFault: value => { fault = value; },
    restart: async () => { await runtime.close(); create(); } };
}

async function identifyBmw(f) {
  f.native({ connected: true, charging: true });
  await f.admit();
  await f.publish({ atHome: true, pluggedIn: false, charging: false }, { at: f.now - 1000 });
  await f.publish({ pluggedIn: true, charging: true, soc: 35, chargeLimitSoc: 80, usableCapacityKwh: 60 });
  f.advance(MINUTE); f.native({ charging: false }); await f.admit();
  await f.publish({ charging: false });
  assert.equal(f.runtime.telemetry().charger1.vehicle.id, 'bmw');
}

test('public reads cannot create a physical-session request or identification attempt', async t => {
  const f = fixture(t);
  f.native({ connected: true });
  f.poll(20);
  assert.equal(f.runtime.chargers.charger1.request, null);
  assert.equal(f.runtime.chargers.charger1.identification, null);
  await f.admit();
  assert.equal(f.runtime.chargers.charger1.request.scope, `${f.runtime.chargers.charger1.association}:${START}`);
  assert.ok(f.runtime.chargers.charger1.identification.id);
  f.poll(30, START + 30 * MINUTE);
});

test('native reconnection fences old session edits and identity before admission without erasing durable context', async t => {
  const f = fixture(t); await identifyBmw(f);
  await f.runtime.write(() => { f.runtime.chargers.charger1.request.overrides = { capacityKwh: 90, manualSoc: 70 };
    f.runtime.chargers.charger1.request.anchorAt = f.now; f.runtime.persist(); });
  const prior = f.capture();
  f.advance(MINUTE); f.native({ connected: true, connectedAt: f.now });
  f.poll(20);
  const view = f.runtime.views().find(row => row.id === 'charger1');
  assert.equal(view.vehicle.id, null); assert.equal(view.request, null);
  assert.equal(view.identification.id, undefined); assert.equal(view.identification.active, false);
  assert.notEqual(view.settings.capacityKwh, 90); assert.notEqual(view.values.soc.source, 'session-anchor');
  assert.deepEqual(f.runtime.chargers.charger1.request, prior.chargers.charger1.request);
  assert.deepEqual(f.runtime.chargers.charger1.vehicleMatch, prior.chargers.charger1.vehicleMatch);
  await f.admit();
  assert.notEqual(f.runtime.chargers.charger1.request.sessionId, prior.chargers.charger1.request.sessionId);
  assert.deepEqual(f.runtime.chargers.charger1.request.overrides, {});
  assert.equal(f.runtime.chargers.charger1.vehicleMatch, null);
});

for (const fault of ['IOERR', 'FULL']) test(`newer SOC supersession and feed admission roll back on ${fault}`, async t => {
  const f = fixture(t); await identifyBmw(f);
  await f.runtime.write(() => { const request = f.runtime.chargers.charger1.request;
    request.overrides.manualSoc = 55; request.anchorAt = f.now; f.runtime.persist(); });
  const prior = f.capture(), bytes = f.read();
  f.advance(1000); f.setFault(fault);
  await assert.rejects(f.publish({ soc: 45 }), { code: 'ERR_SQLITE_ERROR' });
  assert.deepEqual(f.capture(), prior, 'Failed source admission rolls back all runtime and feed state.');
  assert.equal(f.read(), bytes);
  f.poll(20);
  f.setFault(null); await f.publish({ soc: 45 });
  assert.equal(Object.hasOwn(f.runtime.chargers.charger1.request.overrides, 'manualSoc'), false);
  assert.equal(f.runtime.chargers.charger1.request.revision, prior.chargers.charger1.request.revision + 1);
  const accepted = f.capture(); f.poll(20);
  await f.admit();
  assert.equal(f.runtime.chargers.charger1.request.revision, accepted.chargers.charger1.request.revision,
    'Diagnostics and repeated persistence cannot consume the SOC observation twice.');
});

test('returned projections cannot mutate authoritative nested requests, observations or defaults', async t => {
  const f = fixture(t); await identifyBmw(f);
  const before = f.capture(), bytes = f.read();
  const status = f.runtime.status(), view = status.chargers.find(row => row.id === 'charger1');
  view.request.overrides.readyBy = '23:59'; view.request.revision = 999;
  view.automaticSoc.fields.chargeLimitSoc.readingId = 'changed-by-consumer';
  view.control.session.connectedAt = 0;
  status.settings.chargers.charger1.readyBy = '23:59';
  const telemetry = f.runtime.telemetry();
  if (telemetry.charger1.supply?.estimate) telemetry.charger1.supply.estimate.observedAt = 0;
  assert.deepEqual(f.capture(), before); assert.equal(f.read(), bytes);
});

async function history(f, polls) {
  const outcomes = [];
  for (let episode = 0; episode < 3; episode++) {
    f.native({ connected: true, connectedAt: f.now, charging: true }); f.poll(polls);
    await f.admit(); f.poll(polls);
    await f.publish({ atHome: true, pluggedIn: false, charging: false }, { at: f.now - 500 }); f.poll(polls);
    await f.publish({ pluggedIn: true, charging: true, soc: 30 + episode * 10, chargeLimitSoc: 80, usableCapacityKwh: 60 }); f.poll(polls);
    f.advance(MINUTE + episode * 1000); f.native({ charging: false }); f.poll(polls); await f.admit();
    await f.publish({ charging: false }); f.poll(polls);
    assert.equal(f.runtime.telemetry().charger1.vehicle.id, 'bmw');
    await f.runtime.reconcileCharger('charger1', { refreshPlan: false }); f.poll(polls);
    outcomes.push({ state: f.capture(), persisted: f.read(), commands: structuredClone(f.commands) });
    await f.restart(); f.poll(polls); await f.admit(); f.poll(polls);
    f.advance(MINUTE); f.native({ connected: false, charging: false }); f.poll(polls); await f.admit();
    await f.publish({ pluggedIn: false, charging: false }); f.poll(polls);
    f.advance(2 * MINUTE);
  }
  return outcomes;
}

test('generated admitted connection histories are invariant under zero versus repeated public polling', async t => {
  const unpolled = fixture(t), polled = fixture(t);
  const expected = await history(unpolled, 0), actual = await history(polled, 100);
  assert.deepEqual(actual, expected, 'Same accepted events produce identical state, SQLite values and controller requests regardless of polling.');
});

test('a failed identity admission preserves the earlier default deadline and consumed evidence', async t => {
  const f = fixture(t); f.native({ connected: true }); await f.admit();
  await f.publish({ atHome: true, pluggedIn: false, charging: false }, { at: f.now - 1000 });
  await f.publish({ pluggedIn: true, charging: true, soc: 35 });
  f.advance(MINUTE); f.native({ charging: false }); await f.admit();
  const before = f.capture(), bytes = f.read();
  assert.equal(f.runtime.chargers.charger1.request.readyBy, '07:00');
  f.setFault('IOERR');
  await assert.rejects(f.publish({ charging: false }), { code: 'ERR_SQLITE_ERROR' });
  assert.deepEqual(f.capture(), before); assert.equal(f.read(), bytes); f.poll(20);
  f.setFault(null); await f.publish({ charging: false });
  assert.equal(f.runtime.chargers.charger1.vehicleMatch.id, 'bmw');
  assert.equal(f.runtime.chargers.charger1.request.readyBy, '08:00');
  assert.equal(f.runtime.chargers.charger1.request.deadlineAt, before.chargers.charger1.request.deadlineAt + 60 * MINUTE);
  const accepted = f.capture();
  f.poll(20); await f.admit();
  assert.deepEqual(f.capture(), accepted, 'Replaying unchanged admitted evidence cannot renew identity, deadlines or consumption.');
});

test('authority loss and vehicle source replacement cannot be repaired by polling', async t => {
  const f = fixture(t); await identifyBmw(f);
  f.runtime.canControl = () => false;
  f.poll(20);
  assert.equal(f.runtime.views()[0].identification.available, false);
  const oldMatch = structuredClone(f.runtime.chargers.charger1.vehicleMatch);
  f.runtime.vehicleFeeds.bmw.association = 'synthetic-replaced-bmw-source';
  f.poll(20);
  assert.equal(f.runtime.telemetry().charger1.vehicle.id, null);
  assert.deepEqual(f.runtime.chargers.charger1.vehicleMatch, oldMatch);
  f.native({ connected: false }); f.poll(20);
  assert.equal(f.runtime.telemetry().charger1.vehicle.state, 'disconnected');
  assert.deepEqual(f.runtime.chargers.charger1.vehicleMatch, oldMatch);
});

for (const fault of ['IOERR', 'FULL']) test(`replacement admission cannot lose the original session on ${fault}`, async t => {
  const f = fixture(t); await identifyBmw(f);
  const old = f.capture().chargers.charger1, bytes = f.read();
  f.advance(MINUTE); f.native({ connected: true, connectedAt: f.now });
  const nativeReplaced = f.capture();
  f.setFault(fault); await assert.rejects(f.admit(), { code: 'ERR_SQLITE_ERROR' });
  assert.deepEqual(f.capture(), nativeReplaced); assert.equal(f.read(), bytes); f.poll(20);
  assert.deepEqual(f.runtime.chargers.charger1.request, old.request);
  assert.equal(f.runtime.views()[0].request, null, 'The uncommitted old request remains inert for the replacement connection.');
  f.setFault(null); await f.admit();
  assert.notEqual(f.runtime.chargers.charger1.request.sessionId, old.request.sessionId);
  assert.equal(f.runtime.chargers.charger1.vehicleMatch, null);
  assert.equal(f.runtime.chargers.charger1.request.readyBy, '07:00');
});

for (const malformed of ['request', 'identity revision']) test(`runtime serialization rejects malformed ${malformed} before commit`, async t => {
  const f = fixture(t); await identifyBmw(f);
  const before = f.capture(), bytes = f.read();
  await assert.rejects(f.runtime.write(() => {
    const item = f.runtime.chargers.charger1;
    if (malformed === 'request') item.request.chargeNow = false;
    else item.vehicleMatch.revision = 0;
    f.runtime.persistAcceptedState(f.now);
  }), /Unsupported saved/);
  assert.deepEqual(f.capture(), before); assert.equal(f.read(), bytes);
  f.poll(20);
});

test('a committed runtime transition cannot be rolled back by a failing commit observer', async t => {
  const f = fixture(t); await identifyBmw(f);
  const revision = f.runtime.chargers.charger1.request.revision;
  await assert.rejects(f.runtime.write(() => {
    f.runtime.chargers.charger1.request.overrides.capacityKwh = 90;
    f.runtime.chargers.charger1.request.revision++;
    f.runtime.persist();
    f.store.afterCommit(() => { throw new Error('Synthetic committed observer failure'); });
  }), { code: 'STORAGE_COMMIT_EFFECT_FAILED', committed: true });
  assert.equal(f.runtime.chargers.charger1.request.revision, revision + 1);
  assert.equal(f.runtime.chargers.charger1.request.overrides.capacityKwh, 90);
  assert.deepEqual(JSON.parse(f.read()).chargers.charger1.request, f.runtime.chargers.charger1.request);
  f.poll(20);
});

test('unknown native connection retains labelled request references without granting session edit authority', async t => {
  const f = fixture(t); await identifyBmw(f);
  await f.runtime.write(() => {
    const request = f.runtime.chargers.charger1.request;
    request.overrides = { capacityKwh: 90, minimumSoc: 95, manualSoc: 70 };
    request.anchorAt = f.now; f.runtime.persist();
  });
  const prior = f.capture().chargers.charger1.request;
  f.control.snapshot.online = false; f.poll(20);
  const view = f.runtime.views()[0];
  assert.equal(view.request, null); assert.equal(view.vehicle.id, null);
  assert.equal(view.identification.available, false);
  assert.equal(view.settings.capacityKwh, 90); assert.equal(view.values.capacityKwh.source, 'session-request');
  assert.equal(view.values.minimumSoc.value, 95); assert.equal(view.values.minimumSoc.source, 'session-request');
  assert.equal(view.values.soc.value, 70); assert.equal(view.values.soc.source, 'session-anchor');
  assert.equal(view.deadlineAt, prior.deadlineAt);
  assert.deepEqual(f.runtime.chargers.charger1.request, prior);
});
