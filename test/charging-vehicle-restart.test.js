import { withReportDatabase } from './helpers/report-database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createOcppScheduleAdapter } from '../src/charging/ocpp.js';
import { createChargingController } from '../src/charging/controller.js';
import { normalizeScheduleState, scheduleFingerprint } from '../src/charging/easee.js';

const START = Date.parse('2026-09-24T09:00:00Z'), MINUTE = 60_000;
const view = runtime => runtime.status().chargers.find(item => item.id === 'charger1');
const publish = (runtime, value) => runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, JSON.stringify(value));
const facts = (at, changes = {}) => ({ provider: 'bmw-cardata', soc: 60, usableCapacityKwh: 74, chargeLimitSoc: 85,
  readingId: `battery-${at}`, measuredAt: at, pluggedIn: true, charging: true, atHome: true,
  fields: Object.fromEntries(['pluggedIn', 'charging', 'atHome', 'chargeLimitSoc'].map(key =>
    [key, { readingId: `${key}-${at}`, measuredAt: at }])), ...changes });

function fixture(t) {
  let now = START, readbackAvailable = true;
  const values = new Map(), config = { input: 'mqtt',
    connections: { easee: { charger_id: 'synthetic-charger', equalizer_id: 'synthetic-equalizer' },
      mqtt: { address: 'mqtt://synthetic.invalid', user: 'synthetic' } },
    charging: { vehicles: { bmw: { mqttTopic: 'synthetic/vehicles/bmw' } }, chargers: { charger2: { enabled: false } } } };
  const store = { getState: key => structuredClone(values.get(key)),
    setState: (key, value) => values.set(key, structuredClone(value)) };
  withReportDatabase(store, t);
  const physical = { connectorStatus: 'Charging', statusAt: START, transactionId: 7, transactionStartedAt: START,
    transactionConfirmed: true, pluggedIn: true, powerKw: 7 };
  const create = () => {
    const runtime = new ChargingRuntime({ engine: {}, store, config, clock: () => now });
    t.after(() => runtime.close());
    runtime.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
    return runtime;
  };
  const attach = async runtime => {
    const scope = runtime.chargers.charger1.association;
    const adapter = createOcppScheduleAdapter({ scope, clock: () => now, canControl: () => true,
      readSnapshot: async () => {
        if (!readbackAvailable) throw new Error('Synthetic charger readback unavailable');
        return { transport: 'ocpp', scope, connectionId: 'synthetic-socket', readAt: now, online: true,
          statusAt: now, powerAt: now, ...physical };
      },
      isCurrent: snapshot => snapshot.scope === scope && snapshot.transactionId === physical.transactionId,
      request: async () => assert.fail('These offline identity tests must not send charger commands') });
    await runtime.setAdapter('charger1', adapter);
    await runtime.reconcile();
  };
  return { config, store, create, attach, physical, setNow: value => { now = value; },
    readback: value => { readbackAvailable = value; } };
}

async function savedMatch(t, { sessionOverrides = true } = {}) {
  const f = fixture(t), runtime = f.create();
  await f.attach(runtime);
  publish(runtime, facts(START - MINUTE, { pluggedIn: false, charging: false }));
  publish(runtime, facts(START));
  assert.equal(view(runtime).vehicle.state, 'identifying');
  f.setNow(START + MINUTE);
  Object.assign(f.physical, { connectorStatus: 'SuspendedEV', statusAt: START + MINUTE, powerKw: 0 });
  await runtime.reconcile();
  publish(runtime, { provider: 'bmw-cardata', charging: false,
    fields: { charging: { measuredAt: START + MINUTE, readingId: 'synthetic-charge-stop' } } });
  assert.equal(view(runtime).vehicle.id, 'bmw');
  const current = view(runtime);
  if (sessionOverrides) await runtime.setChargerSettings('charger1', { scope: 'session', association: current.association,
    sessionId: current.request.sessionId, revision: current.request.revision,
    changes: { readyBy: '08:30', capacityKwh: 79, minimumSoc: 100 } });
  runtime.persist();
  const saved = f.store.getState(runtime.key);
  assert.equal(saved.version, 6);
  assert.equal(saved.chargers.charger1.vehicleMatch.id, 'bmw');
  assert.equal(saved.chargers.charger1.request.overrides.minimumSoc, sessionOverrides ? 100 : undefined);
  assert.equal(saved.chargers.charger1.request.revision, sessionOverrides ? 2 : 1);
  assert.ok(saved.vehicleFeeds.bmw.consumedPlugId);
  await runtime.close();
  f.setNow(START + 2 * MINUTE);
  return { ...f, saved };
}

function assertRetained(runtime, saved) {
  const item = runtime.chargers.charger1, expected = saved.chargers.charger1;
  for (const key of ['vehicleMatch', 'request', 'targetState', 'vehicleEvidence'])
    assert.deepEqual(item[key], expected[key], `${key} must survive missing startup evidence`);
  assert.equal(runtime.vehicleFeeds.bmw.consumedPlugId, saved.vehicleFeeds.bmw.consumedPlugId);
}

function assertUnassigned(runtime) {
  const current = view(runtime);
  assert.equal(current.vehicle.id, null);
  assert.equal(current.vehicle.state, 'unidentified');
  assert.equal(current.automaticSoc, null);
  assert.equal(current.targetSelection, null);
  assert.equal(current.request, null, 'Unknown startup connection must not expose saved session edits');
  assert.notEqual(current.values.soc.source, 'bmw-cardata');
  assert.equal(runtime.status().vehicleFeeds.find(item => item.id === 'bmw').usedByChargerId, null);
}

test('current BMW identity and session choices survive startup before the charger adapter exists', async t => {
  const f = await savedMatch(t), restarted = f.create();
  assertUnassigned(restarted);
  assertRetained(restarted, f.saved);
  const request = f.saved.chargers.charger1.request;
  await assert.rejects(restarted.setChargerSettings('charger1', { scope: 'session',
    association: f.saved.chargers.charger1.association, sessionId: request.sessionId,
    revision: request.revision, changes: { minimumSoc: 95 } }), /connection changed/);
  assertRetained(restarted, f.saved);
  restarted.tick();
  restarted.persist();
  assertRetained(restarted, f.saved);
  const persisted = f.store.getState(restarted.key);
  for (const key of ['vehicleMatch', 'request', 'targetState', 'vehicleEvidence'])
    assert.deepEqual(persisted.chargers.charger1[key], f.saved.chargers.charger1[key]);
  assert.equal(persisted.vehicleFeeds.bmw.consumedPlugId, f.saved.vehicleFeeds.bmw.consumedPlugId);

  // Replaying the same live reading supplies heartbeat only, without a fresh plug or stop edge.
  publish(restarted, facts(START));
  assertUnassigned(restarted);
  assertRetained(restarted, f.saved);
  await f.attach(restarted);
  assert.equal(view(restarted).vehicle.id, 'bmw');
  assert.equal(view(restarted).values.soc.source, 'bmw-cardata');
  assert.equal(view(restarted).values.minimumSoc.value, 100);
  assert.equal(view(restarted).values.minimumSoc.source, 'session-request');
  assertRetained(restarted, f.saved);
});

test('a restored OCPP session waits for physical readback without discarding its BMW match', async t => {
  const f = await savedMatch(t), restarted = f.create();
  f.readback(false);
  await f.attach(restarted);
  const control = restarted.chargers.charger1.controller.status();
  assert.equal(control.session.connectedAt, START, 'The real OCPP controller restores its saved session');
  assert.equal(control.snapshot, null);
  assertUnassigned(restarted);
  restarted.tick();
  restarted.persist();
  assertRetained(restarted, f.saved);
  f.readback(true);
  await restarted.reconcile();
  assert.equal(view(restarted).vehicle.id, 'bmw');
  assert.equal(view(restarted).automatic.soc.available, false, 'Battery values still require a live BMW heartbeat');
  assertRetained(restarted, f.saved);
});

test('an offline OCPP readback preserves the saved match without projecting BMW identity', async t => {
  const f = await savedMatch(t), restarted = f.create();
  Object.assign(f.physical, { online: false, pluggedIn: null, transactionConfirmed: false });
  await f.attach(restarted);
  const control = restarted.chargers.charger1.controller.status();
  assert.equal(control.snapshot.online, false);
  assert.equal(control.snapshot.pluggedIn, null);
  assert.equal(control.session.connectedAt, START);
  assertUnassigned(restarted);
  restarted.tick();
  restarted.persist();
  assertRetained(restarted, f.saved);
  Object.assign(f.physical, { online: true, pluggedIn: true, transactionConfirmed: true });
  await restarted.reconcile();
  assert.equal(view(restarted).vehicle.id, 'bmw');
  assertRetained(restarted, f.saved);
});

test('temporary cloud startup cannot apply an old disconnected session to the saved native BMW match', async t => {
  const f = await savedMatch(t), at = START - MINUTE;
  const schedule = normalizeScheduleState({ enabled: 'none' });
  const cloudOwnershipKey = `charging:mqtt:charger1:${f.saved.chargers.charger1.association}:ownership`;
  const cloud = createChargingController({ clock: () => at,
    adapter: { read: async () => ({ schedule, fingerprint: scheduleFingerprint(schedule),
      controlFingerprint: 'synthetic-cloud-control', controlKnown: true, online: true, enabled: true,
      mode: 1, reason: 0, pluggedIn: false, readAt: at, modeAt: at, reasonAt: at }) },
    saveState: state => f.store.setState(cloudOwnershipKey, state) });
  await cloud.update({ enabled: false });
  assert.equal(cloud.status().session.connected, false);
  await cloud.close();

  const restarted = f.create();
  await restarted.setAdapter('charger1', { read: async () => { throw new Error('Synthetic cloud unavailable'); } });
  await restarted.reconcile();
  const control = restarted.chargers.charger1.controller.status();
  assert.equal(control.session.connected, false);
  assert.equal(control.snapshot, null);
  assertUnassigned(restarted);
  restarted.tick();
  restarted.persist();
  assertRetained(restarted, f.saved);
  await f.attach(restarted);
  assert.equal(view(restarted).vehicle.id, 'bmw');
  assertRetained(restarted, f.saved);
});

test('OCPP transaction rollover preserves a saved physical-session identity until an observed unplug', async t => {
  for (const disconnected of [false, true]) await t.test(disconnected ? 'physical disconnect revokes identity' : 'transaction rollover retains identity', async t => {
    const f = await savedMatch(t), restarted = f.create();
    restarted.tick();
    assertRetained(restarted, f.saved);
    Object.assign(f.physical, disconnected
      ? { connectorStatus: 'Available', statusAt: START + 2 * MINUTE, pluggedIn: false,
        transactionConfirmed: false, transactionId: null, transactionStartedAt: null }
      : { transactionId: 8, transactionStartedAt: START + 2 * MINUTE, statusAt: START + 2 * MINUTE });
    await f.attach(restarted);
    const current = view(restarted);
    if (disconnected) {
      assert.equal(current.vehicle.id, null);
      assert.equal(restarted.chargers.charger1.vehicleMatch, null);
      assert.equal(restarted.chargers.charger1.targetState, null);
      assert.equal(restarted.chargers.charger1.request, null);
    } else {
      assert.equal(current.vehicle.id, 'bmw');
      assertRetained(restarted, f.saved);
      const session = restarted.chargers.charger1.controller.status().session;
      assert.equal(session.transactionId, 8);
      assert.equal(session.connectedAt, START, 'A transaction change alone does not establish a physical unplug');
      restarted.persist();
      await restarted.close();
      const again = f.create(); await f.attach(again);
      assert.equal(view(again).vehicle.id, 'bmw');
      assertRetained(again, f.saved);
    }
    assert.equal(restarted.vehicleFeeds.bmw.consumedPlugId, f.saved.vehicleFeeds.bmw.consumedPlugId,
      'Transaction changes and physical disconnects cannot replay the consumed vehicle plug event');
  });
});

test('a replacement charger or BMW feed cannot inherit the stored vehicle association', async t => {
  for (const replacement of ['charger', 'vehicle-feed']) await t.test(replacement, async t => {
    const f = await savedMatch(t);
    if (replacement === 'charger') f.config.connections.easee.charger_id = 'synthetic-replacement-charger';
    else f.config.charging.vehicles.bmw.mqttTopic = 'synthetic/vehicles/replacement';
    const restarted = f.create();
    assertUnassigned(restarted);
    assert.equal(restarted.chargers.charger1.vehicleMatch, null);
    assert.equal(restarted.chargers.charger1.targetState, null);
    await f.attach(restarted);
    assert.equal(view(restarted).vehicle.id, null);
    if (replacement === 'charger') assert.deepEqual(view(restarted).request.overrides, {});
    else assert.equal(restarted.vehicleFeeds.bmw.reading, null);
  });
});

test('a live negative BMW fact revokes the saved identity before charger startup completes', async t => {
  const f = await savedMatch(t), restarted = f.create();
  publish(restarted, { provider: 'bmw-cardata', atHome: false,
    fields: { atHome: { measuredAt: START + 2 * MINUTE, readingId: 'synthetic-left-home' } } });
  assertUnassigned(restarted);
  assert.equal(restarted.chargers.charger1.vehicleMatch, null);
  assert.equal(restarted.chargers.charger1.targetState, null);
  assert.equal(f.store.getState(restarted.key).chargers.charger1.vehicleMatch, null);
  await f.attach(restarted);
  assert.equal(view(restarted).vehicle.id, null);
});

test('startup unplug and replug require a new transaction and charging edges before BMW identification', async t => {
  const f = await savedMatch(t), unplugAt = START + MINUTE + 10_000, replugAt = unplugAt + 20_000;
  f.setNow(unplugAt);
  const restarted = f.create();
  for (const [at, pluggedIn] of [[unplugAt, false], [replugAt, true]]) {
    f.setNow(at);
    publish(restarted, { provider: 'bmw-cardata', pluggedIn,
      fields: { pluggedIn: { measuredAt: at, readingId: `synthetic-startup-plug-${at}` } } });
    assertUnassigned(restarted);
    assert.equal(restarted.chargers.charger1.vehicleMatch, null);
    assert.equal(restarted.chargers.charger1.targetState, null);
    const stored = f.store.getState(restarted.key);
    assert.equal(stored.chargers.charger1.vehicleMatch, null);
    assert.equal(stored.chargers.charger1.targetState, null);
    assert.equal(stored.vehicleFeeds.bmw.consumedPlugId, f.saved.vehicleFeeds.bmw.consumedPlugId);
  }
  assert.equal(restarted.chargers.charger1.vehicleDisconnect?.measuredAt, unplugAt);
  await f.attach(restarted);
  // Complete readback after the newly accepted departure has been persisted.
  await restarted.reconcile();
  assert.ok(restarted.chargers.charger1.controller.status().session.lastDisconnectedAt >= unplugAt);
  assert.equal(view(restarted).vehicle.id, null, 'Old transaction readback cannot revive the departed BMW');
  assert.equal(restarted.chargers.charger1.request, null);
  assert.equal(restarted.chargers.charger1.targetState, null);

  Object.assign(f.physical, { transactionId: 8, transactionStartedAt: replugAt, statusAt: replugAt });
  await restarted.reconcile();
  const current = view(restarted);
  assert.equal(current.vehicle.id, null, 'Nearby charging edges from before unplug cannot identify the new plug');
  assert.notEqual(current.request.scope, f.saved.chargers.charger1.request.scope);
  assert.deepEqual(current.request.overrides, {});
  assert.equal(current.request.revision, 1);
  assert.equal(restarted.chargers.charger1.targetState, null);
  assert.ok(restarted.chargers.charger1.controller.status().session.lastDisconnectedAt >= unplugAt);

  for (const [at, charging] of [[replugAt + 10_000, true], [replugAt + 30_000, false]]) {
    f.setNow(at);
    Object.assign(f.physical, { connectorStatus: charging ? 'Charging' : 'SuspendedEV', statusAt: at,
      powerKw: charging ? 7 : 0 });
    await restarted.reconcile();
    publish(restarted, { provider: 'bmw-cardata', charging,
      fields: { charging: { measuredAt: at, readingId: `synthetic-new-charge-${at}` } } });
  }
  assert.equal(view(restarted).vehicle.id, 'bmw', 'New start and stop evidence identifies the new transaction');
  assert.equal(view(restarted).values.minimumSoc.source, 'bmw-cardata');
  assert.deepEqual(view(restarted).request.overrides, {});
});

test('failed BMW departure persistence restores the matched session and its request choices', async t => {
  const f = await savedMatch(t), restarted = f.create();
  await f.attach(restarted);
  await restarted.reconcile();
  assert.equal(view(restarted).vehicle.id, 'bmw');
  const item = restarted.chargers.charger1;
  const before = structuredClone(Object.fromEntries(['request', 'vehicleMatch', 'targetState', 'vehicleDisconnect', 'vehicleEvidence']
    .map(key => [key, item[key]])));
  const savedBefore = f.store.getState(restarted.key);
  const revision = restarted.revision, setState = f.store.setState;
  const at = START + 3 * MINUTE, unplug = { provider: 'bmw-cardata', pluggedIn: false,
    fields: { pluggedIn: { measuredAt: at, readingId: 'synthetic-persisted-departure' } } };
  f.setNow(at);
  f.store.setState = () => { throw new Error('Synthetic departure persistence failure'); };
  try {
    assert.throws(() => publish(restarted, unplug), /Synthetic departure persistence failure/);
  } finally { f.store.setState = setState; }
  for (const [key, value] of Object.entries(before)) assert.deepEqual(item[key], value, `${key} must roll back with the failed departure`);
  assert.equal(restarted.revision, revision);
  assert.deepEqual(f.store.getState(restarted.key), savedBefore);
  const current = view(restarted);
  assert.equal(current.vehicle.id, 'bmw');
  assert.deepEqual(current.request, before.request);
  assert.equal(current.request.revision, 2);
  assert.deepEqual(current.request.overrides, { readyBy: '08:30', capacityKwh: 79, minimumSoc: 100 });
  assert.equal(current.values.minimumSoc.value, 100);
  assert.equal(current.values.minimumSoc.source, 'session-request');

  publish(restarted, unplug);
  await restarted.reconcile();
  await restarted.reconcile();
  assert.equal(view(restarted).vehicle.state, 'disconnected');
  assert.equal(item.request, null);
  assert.equal(item.vehicleMatch, null);
  assert.equal(item.targetState, null);
  assert.equal(item.vehicleDisconnect.measuredAt, at);
  assert.equal(f.store.getState(restarted.key).chargers.charger1.request, null);
});

test('a confirmed same-session outcome survives adapter startup and unavailable vehicle telemetry after restart', async t => {
  const f = await savedMatch(t, { sessionOverrides: false }), completed = f.create();
  await f.attach(completed);
  const completedAt = START + 3 * MINUTE;
  f.setNow(completedAt);
  Object.assign(f.physical, { connectorStatus: 'SuspendedEV', statusAt: completedAt, powerKw: 0 });
  publish(completed, facts(completedAt, { soc: 100, chargeLimitSoc: 100, charging: false }));
  await completed.reconcile(); completed.persist();
  assert.equal(view(completed).values.minimumSoc.source, 'bmw-cardata');
  const previous = completed.status().diagnostics.chargers.find(row => row.id === 'charger1').current;
  assert.equal(previous.outcome.state, 'target-confirmed');
  assert.equal(previous.outcome.target, 100);
  assert.equal(previous.coverage.completion.state, 'verified');
  const sessionId = view(completed).request.sessionId;
  await completed.close();

  f.setNow(completedAt + 2 * MINUTE);
  const restarted = f.create();
  assertUnassigned(restarted);
  restarted.persist();
  const diagnostics = restarted.status().diagnostics;
  assert.notEqual(diagnostics.available, false, 'The observer remains available before its charger adapters are initialized');
  assert.equal(diagnostics.error, undefined, 'An uninitialized peer limiter cannot prevent the report from observing unknown physical state');
  const unavailable = diagnostics.chargers.find(row => row.id === 'charger1').current;
  assert.equal(unavailable.id, previous.id);
  assert.equal(unavailable.outcome.state, 'target-confirmed', 'Unknown startup defaults do not retract the historical confirmed target');
  assert.equal(unavailable.outcome.target, 100);
  assert.equal(unavailable.coverage.completion.state, 'verified');
  assert.equal(unavailable.current.physicalFresh, false);

  f.readback(false); await f.attach(restarted);
  assert.equal(restarted.status().diagnostics.error, undefined);
  assert.equal(restarted.status().diagnostics.chargers.find(row => row.id === 'charger1').current.current.physicalFresh, false);
  assert.equal(restarted.chargers.charger1.request.sessionId, sessionId);
  assert.equal(restarted.status().diagnostics.chargers.find(row => row.id === 'charger1').current.id, previous.id);
  f.readback(true); await restarted.reconcile();
  assert.equal(view(restarted).request.sessionId, sessionId);
  assert.equal(view(restarted).vehicle.id, 'bmw');
  assert.equal(view(restarted).automatic.soc.available, false, 'A historical receipt does not make the restored BMW feed live');
  assert.equal(restarted.status().diagnostics.chargers.find(row => row.id === 'charger1').current.outcome.state, 'target-confirmed');
});

test('live disconnected status after an outage finalizes the old report without making its old source time new', async t => {
  const f = await savedMatch(t), runtime = f.create();
  await f.attach(runtime); runtime.persist();
  const previous = runtime.status().diagnostics.chargers.find(row => row.id === 'charger1').current;
  const disconnectedAt = START + 4 * MINUTE, recoveredAt = START + 20 * MINUTE;
  f.setNow(recoveredAt);
  Object.assign(f.physical, { connectorStatus: 'Available', statusAt: disconnectedAt, pluggedIn: false,
    transactionConfirmed: false, transactionId: null, transactionStartedAt: null, powerKw: 0 });
  await runtime.reconcile(); runtime.persist();
  const current = view(runtime), reports = runtime.status().diagnostics.chargers.find(row => row.id === 'charger1');
  assert.equal(current.request, null);
  assert.equal(current.values.connected.value, false);
  assert.equal(current.values.connected.measuredAt, disconnectedAt, 'Readback preserves the original source event clock');
  assert.equal(reports.current, null, 'A current disconnected physical state closes the prior report');
  assert.equal(reports.recent[0].id, previous.id);
  assert.equal(reports.recent[0].endReason, 'unplugged');
  assert.equal(reports.recent[0].endedAt, recoveredAt, 'The assessment ends when disconnection is observed, without backdating unseen behavior');
});

test('an empty development database cannot reconstruct overnight identity or completion from an already connected stopped car', async t => {
  const f = fixture(t), observedAt = START + 12 * 60 * MINUTE;
  f.setNow(observedAt);
  Object.assign(f.physical, { connectorStatus: 'SuspendedEV', statusAt: START + 11 * 60 * MINUTE, powerKw: 0 });
  const runtime = f.create();
  await f.attach(runtime); runtime.persist();
  let report = runtime.status().diagnostics.chargers.find(row => row.id === 'charger1').current;
  assert.equal(view(runtime).vehicle.id, null);
  assert.equal(report.vehicleId, null);
  assert.equal(report.firstChargingAt, null);
  assert.equal(report.coverage.identification.state, 'not-exercised');
  assert.equal(report.coverage.completion.state, 'not-exercised');
  const { events, nextBefore } = runtime.sessionDiagnostics.reportEvents({ chargerId: 'charger1', reportId: report.id, limit: 100 });
  assert.equal(nextBefore, null);
  assert.ok(events.every(row => row.at >= observedAt), 'The report records only observations made by this database');
  assert.ok(!events.some(row => row.kind === 'physical' && row.code === 'charging-started'));

  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic,
    JSON.stringify(facts(START + 11 * 60 * MINUTE, { soc: 100, chargeLimitSoc: 100, charging: false })), { retain: true });
  runtime.persist(); report = runtime.status().diagnostics.chargers.find(row => row.id === 'charger1').current;
  assert.equal(view(runtime).vehicle.id, null, 'Retained finished-vehicle data cannot prove its physical assignment');
  assert.equal(report.coverage.completion.state, 'not-exercised');
  assert.notEqual(report.outcome.state, 'target-confirmed');
});
