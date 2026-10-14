import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createChargingController } from '../src/charging/controller.js';
import { createEaseeScheduleAdapter, normalizeScheduleState } from '../src/charging/easee.js';
import { createOcppScheduleAdapter } from '../src/charging/ocpp.js';
import { updateTargetState } from '../src/charging/target.js';
import { updateChargingProgress } from '../src/charging/progress.js';
import { acceptEaseeTransition } from '../src/charging/stream-evidence.js';

const START = Date.parse('2026-01-15T00:00:00Z'), HOUR = 3600_000, MINUTE = 60_000;
const clone = structuredClone;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function nativeFixture(t, { cloudState = 'absent', restriction = null, references = true } = {}) {
  let now = START + HOUR, permitted = true, connected = true, statusAt = START, online = true;
  let activeProfile = false, loseSetReply = restriction === 'pending', failClear = false;
  let readHook = null;
  const store = new Store(':memory:'), nativeWrites = [];
  const config = { input: 'mqtt', connections: { easee: { charger_id: 'synthetic-cloud-target-charger' } },
    charging: { defaults: { capacityKwh: 20, manualSoc: 20, minimumSoc: 85, readyBy: '08:00' } } };
  const runtime = new ChargingRuntime({ engine: {}, store, config, clock: () => now, canControl: () => permitted });
  runtime.tick = () => {};
  for (const item of Object.values(runtime.chargers)) item.controls.enabled = false;
  runtime.refreshSettings();
  t.after(async () => { await runtime.close(); store.close(); });
  const item = runtime.chargers.charger1, nativeScope = 'b'.repeat(64);
  const plan = { id: 'synthetic-native-adopted-program', startAt: START + 2 * HOUR,
    periods: [{ startAt: START + 2 * HOUR, endAt: START + 3 * HOUR }, { startAt: START + 3 * HOUR + 15 * MINUTE, endAt: null }],
    finalStartAt: START + 3 * HOUR + 15 * MINUTE, deadlineAt: START + 6 * HOUR,
    targetAt: START + 4 * HOUR, feasible: true, provisional: false, state: 'waiting' };
  const snapshot = () => ({ transport: 'ocpp', scope: nativeScope, connectionId: 'synthetic-native-socket',
    readAt: now, online, connectorStatus: connected ? activeProfile ? 'SuspendedEVSE' : 'Preparing' : 'Available',
    statusAt, statusReceivedAt: now, transactionId: connected ? 41 : null,
    transactionStartedAt: connected ? START : null, transactionConfirmedAt: connected ? START : null,
    transactionConfirmed: connected, transactionProvenance: connected ? 'start-transaction' : null,
    pluggedIn: connected, powerKw: 0, powerAt: statusAt, powerReceivedAt: now, appControl: null,
    limits: { chargerA: 16, cableA: 16, circuitA: [16, 16, 16], equalizerAvailableA: [16, 16, 16] },
    supply: { availableCurrentA: [16, 16, 16], propertyCurrentA: [3, 3, 3], chargerCurrentA: [0, 0, 0], voltageV: [230, 230, 230],
      observationTimes: { property: [START, START, START], charger: [START, START, START], voltage: [START, START, START] } } });
  const native = createOcppScheduleAdapter({ scope: nativeScope, clock: () => now, canControl: () => permitted,
    readSnapshot: async () => await readHook?.() ?? snapshot(), isCurrent: () => true,
    request: async (action, body, options) => {
      assert.equal(options.guard?.() ?? true, true);
      if (action === 'GetCompositeSchedule') return { status: 'Accepted', connectorId: 1, scheduleStart: new Date(now).toISOString(),
        chargingSchedule: { duration: body.duration, chargingRateUnit: 'A', chargingSchedulePeriod: activeProfile
          ? [{ startPeriod: 0, limit: 0 }, { startPeriod: Math.max(1, Math.ceil((plan.startAt - now) / 1000)), limit: 16 }]
          : [{ startPeriod: 0, limit: 16 }] } };
      nativeWrites.push({ action, body: clone(body) });
      if (action === 'SetChargingProfile') {
        activeProfile = true; statusAt = now;
        if (loseSetReply) throw Object.assign(Error('synthetic lost Set reply'), { code: 'ocpp-request-timeout' });
        return { status: 'Accepted' };
      }
      assert.equal(action, 'ClearChargingProfile');
      if (failClear) throw Object.assign(Error('synthetic lost Clear reply'), { code: 'ocpp-request-timeout' });
      activeProfile = false; return { status: 'Accepted' };
    } });
  const create = native.createController;
  native.createController = options => create({ ...options, getPlan: () => clone(plan), getIdentification: () => null });
  await runtime.setAdapter('charger1', native);
  await item.controller.update({ enabled: false });
  if (references) runtime.persist();
  assert.equal(item.controller.status().session.connectedAt, START);
  assert.equal(item.ownershipAdmitted, true);
  assert.equal(Boolean(item.request?.scope), references);
  const target = (value, at) => ({ chargeLimitSoc: value, fields: { chargeLimitSoc: { measuredAt: at, receivedAt: at,
    readingId: `synthetic-target-${value}` } } });
  if (references) {
    item.targetState = updateTargetState(null, { connectedAt: START, reading: target(100, now), now });
    now += 1000;
    item.targetState = updateTargetState(item.targetState, { connectedAt: START, reading: target(85, now), now });
    runtime.persist(); item.plan = clone(plan);
    assert.equal(item.targetState.lower.value, 85);
  }
  if (restriction) await item.controller.update({ enabled: true, maximumAmps: 16 });
  if (restriction === 'owned') assert(item.controller.status().owned, item.controller.status().errorCode);
  if (restriction === 'pending') assert(item.controller.status().pending, item.controller.status().errorCode);
  const cloudKey = `${runtime.key}:charger1:${item.association}:ownership`;
  const nativeKey = `${cloudKey}:ocpp`;
  const makeCloudState = async state => {
    let at = state === 'reconnected' ? START - 5 * MINUTE : state === 'same' ? START : START + 10 * MINUTE;
    const isConnected = state !== 'disconnected';
    const adapter = createEaseeScheduleAdapter({ chargerId: 'synthetic-cloud-target-charger', clock: () => at, canControl: () => false,
      readObservations: async () => [[31, true], [250, true], [100, isConnected ? 'B' : 'A'], [109, isConnected ? 2 : 1], [96, 54],
        [120, 0], [48, 32], [47, 16], [104, 32], [22, 16], [23, 16], [24, 16]]
        .map(([id, value]) => ({ id, value, timestamp: new Date(at).toISOString() })),
      request: async (_url, options = {}) => { assert.equal(options.method, 'GET'); return normalizeScheduleState({ enabled: 'none' }); } });
    let saved;
    const controller = createChargingController({ adapter, clock: () => at, canControl: () => true, saveState: value => { saved = clone(value); } });
    await controller.update({ enabled: false });
    if (state === 'reconnected') {
      const disconnectedAt = START - MINUTE, reconnectAt = START - 5000;
      const ended = acceptEaseeTransition(null, { id: 100, value: 'A', previousValue: 'B', previousMeasuredAt: at,
        measuredAt: disconnectedAt, receivedAt: disconnectedAt }, { now: START, connectedAt: at });
      const connected = acceptEaseeTransition(ended.evidence, { id: 100, value: 'B', previousValue: 'A', previousMeasuredAt: disconnectedAt,
        measuredAt: reconnectAt, receivedAt: START }, { now: START, connectedAt: at });
      at = START;
      await controller.update({ enabled: true, plan: null, vehicleDisconnect: connected.boundary });
      assert.equal(saved.session.connectedAt, START);
      assert.equal(saved.vehicleDisconnect.awaitingConnection, false);
      assert.equal(saved.vehicleDisconnect.cleanupPending, false);
    }
    await controller.close(); return saved;
  };
  if (cloudState !== 'absent') store.setState(cloudKey, await makeCloudState(cloudState));
  return { runtime, store, item, native, nativeScope, nativeWrites, cloudKey, nativeKey, plan, snapshot, makeCloudState,
    get now() { return now; }, advance(ms) { now += ms; }, permit(value) { permitted = value; },
    offline() { online = false; }, online() { online = true; }, setReadHook(fn) { readHook = fn; }, loseClear() { failClear = true; },
    disconnect() { connected = false; now += 1000; statusAt = now; },
    async prepare() { return runtime.pauseForBackendChange('charger1', { target: 'cloud' }); } };
}

const preserved = f => ({ request: clone(f.item.request), target: clone(f.item.targetState), progress: clone(f.item.progress),
  cost: clone(f.item.sessionCost), plan: clone(f.item.plan), controls: clone(f.item.controls), native: f.store.getState(f.nativeKey),
  cloud: f.store.getState(f.cloudKey) });
const unchanged = (f, before, writes) => {
  assert.deepEqual(preserved(f), before);
  assert.equal(f.nativeWrites.length, writes, 'guard refuses before a native cleanup write');
  assert.equal(f.item.backendTransition ?? null, null, 'refusal leaves ordinary native reconciliation available');
};

const disconnectEvent = f => ({ id: 100, value: 'A', previousValue: 'B', previousMeasuredAt: START,
  measuredAt: f.now, receivedAt: f.now });

test('a stream disconnect awaiting actual Store admission cannot authorize native backend cleanup', async t => {
  const f = await nativeFixture(t, { cloudState: 'same', restriction: 'owned' });
  const entered = deferred(), release = deferred();
  const held = f.store.runPublication(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const writes = f.nativeWrites.length;
  try {
    f.advance(1000);
    assert.equal(f.runtime.receiveEaseeObservation(disconnectEvent(f)), true);
    assert.equal(f.runtime.streamPersistencePending, true);
    const boundary = clone(f.item.vehicleDisconnect), request = clone(f.item.request);
    await assert.rejects(f.prepare(), /references are unavailable/);
    assert.equal(f.nativeWrites.length, writes);
    assert.equal(f.item.backendTransition ?? null, null);
    assert.deepEqual(f.item.vehicleDisconnect, boundary);
    assert.deepEqual(f.item.request, request);
  } finally {
    release.resolve(); await held;
    await f.runtime.writeStreamEvidence();
  }
  assert.equal(f.runtime.streamPersistencePending, false);
  const admitted = clone(f.item.vehicleDisconnect);
  await assert.rejects(f.prepare(), /references are unavailable/);
  assert.deepEqual(f.item.vehicleDisconnect, admitted, 'successful input admission does not invent native consumption');
  assert.equal(f.nativeWrites.length, writes);
});

test('a new admitted stream boundary during adapter wait cannot become quiet native absence', async t => {
  const f = await nativeFixture(t, { cloudState: 'same' }), wait = deferred();
  f.item.adapterPending = true; f.item.adapterFlight = wait.promise;
  const operation = f.prepare();
  f.advance(1000);
  assert.equal(f.runtime.receiveEaseeObservation(disconnectEvent(f)), true);
  await f.runtime.writeStreamEvidence();
  assert.equal(f.runtime.streamPersistencePending, false);
  const before = preserved(f), boundary = clone(f.item.vehicleDisconnect), writes = f.nativeWrites.length;
  f.item.adapterPending = false; wait.resolve();
  await assert.rejects(operation); unchanged(f, before, writes);
  assert.deepEqual(f.item.vehicleDisconnect, boundary);
});

for (const cloudState of ['absent', 'disconnected', 'different'])
  for (const restriction of [null, 'owned', 'pending'])
    test(`native to cloud refuses ${cloudState} target boundary while preserving ${restriction ?? 'quiet'} native scope`, async t => {
      const f = await nativeFixture(t, { cloudState, restriction }), before = preserved(f), writes = f.nativeWrites.length;
      await assert.rejects(f.prepare(), /Saved cloud and current native session boundaries disagree/);
      unchanged(f, before, writes);
      assert.equal(before.target.lower.value, 85);
    });

test('a separately admitted same-boundary cloud slot permits the ordinary quiet drain', async t => {
  const f = await nativeFixture(t, { cloudState: 'same' }), before = preserved(f);
  await f.prepare();
  assert.equal(f.item.backendTransition.ready, true);
  assert.deepEqual(preserved(f), before);
  assert.equal(f.nativeWrites.length, 0);
});

test('an actual completed earlier stream boundary keeps its original clocks during same-boundary handback', async t => {
  const f = await nativeFixture(t), value = await f.makeCloudState('reconnected');
  f.store.setState(f.cloudKey, value);
  const before = preserved(f);
  await f.prepare();
  assert.equal(f.item.backendTransition.ready, true);
  assert.deepEqual(preserved(f), before);
  assert.equal(f.nativeWrites.length, 0);
  assert.equal(value.vehicleDisconnect.measuredAt, START - MINUTE);
  assert.equal(value.vehicleDisconnect.reconnected.receivedAt, START);
});

for (const [label, change] of [
  ['unknown completed boundary fields', value => { value.vehicleDisconnect.retiredClock = START; }],
  ['unfinished boundary cleanup', value => { value.vehicleDisconnect.cleanupPending = true; }],
  ['unconsumed reconnect', value => { value.vehicleDisconnect.awaitingConnection = true; }],
  ['reconnect source after current target boundary', value => {
    value.vehicleDisconnect.reconnected.measuredAt = START + 1; value.vehicleDisconnect.reconnected.receivedAt = START + 1;
  }],
  ['reconnect receipt after current target boundary', value => { value.vehicleDisconnect.reconnected.receivedAt = START + 1; }],
  ['reconnect admission after current target boundary', value => { value.vehicleDisconnect.reconnected.admittedAt = START + 1; }],
  ['unadmitted source-leading boundary', value => { value.vehicleDisconnect.receivedAt = value.vehicleDisconnect.measuredAt - 1; }],
  ['retained reconnect', value => { value.vehicleDisconnect.reconnected.retained = true; }],
  ['future disconnect source', (value, f) => {
    value.vehicleDisconnect.measuredAt = f.now + 1; value.vehicleDisconnect.receivedAt = f.now + 1;
    delete value.vehicleDisconnect.reconnected;
  }],
]) test(`${label} in an otherwise matching target slot cannot authorize cleanup`, async t => {
  const f = await nativeFixture(t, { restriction: 'owned' }), value = await f.makeCloudState('reconnected');
  change(value, f); f.store.setState(f.cloudKey, value);
  const before = preserved(f), writes = f.nativeWrites.length;
  await assert.rejects(f.prepare()); unchanged(f, before, writes);
});

test('current-format target-cloud rejection preserves the exact malformed slot before native cleanup', async t => {
  const f = await nativeFixture(t, { cloudState: 'same', restriction: 'owned' });
  const invalid = { ...f.store.getState(f.cloudKey), retiredSession: true };
  f.store.setState(f.cloudKey, invalid);
  const before = preserved(f), writes = f.nativeWrites.length;
  await assert.rejects(f.prepare(), /Unsupported charging ownership/);
  unchanged(f, before, writes);
});

test('malformed selected native ownership is rejected before a matching cloud drain', async t => {
  const f = await nativeFixture(t, { cloudState: 'same', restriction: 'owned' });
  const invalid = { ...f.store.getState(f.nativeKey), retiredConnection: true };
  f.store.setState(f.nativeKey, invalid);
  const before = preserved(f), writes = f.nativeWrites.length;
  await assert.rejects(f.prepare(), /Unsupported native charging ownership/);
  unchanged(f, before, writes);
});

for (const [label, change] of [
  ['unadmitted native ownership', f => { f.item.ownershipAdmitted = false; }],
  ['stale native read health', f => { f.advance(2 * MINUTE); }],
  ['unknown native equipment scope', f => { f.native.scope = null; }],
  ['inconsistent current request scope', f => { f.item.request.sessionId = 'synthetic-wrong-session'; }],
  ['future target-cloud observation clock', f => { const value = f.store.getState(f.cloudKey); value.session.observedAt = f.now + 1000; f.store.setState(f.cloudKey, value); }],
  ['target observation before its connection boundary', f => { const value = f.store.getState(f.cloudKey); value.session.observedAt = START - 1; f.store.setState(f.cloudKey, value); }],
  ['unknown nested target disconnect field', f => { const value = f.store.getState(f.cloudKey); value.vehicleDisconnect = { retiredField: true }; f.store.setState(f.cloudKey, value); }],
]) test(`${label} cannot authorize a native to cloud drain`, async t => {
  const f = await nativeFixture(t, { cloudState: 'same' }); change(f);
  const before = preserved(f), writes = f.nativeWrites.length;
  await assert.rejects(f.prepare()); unchanged(f, before, writes);
});

for (const [label, change] of [
  ['target slot disappears', f => f.store.transaction(() => f.store.db.prepare('DELETE FROM state WHERE key=?').run(f.cloudKey))],
  ['source admission becomes unknown', f => { f.item.ownershipAdmitted = false; }],
  ['adapter generation advances', f => { f.item.adapterGeneration++; }],
  ['role loses control', f => { f.permit(false); }],
]) test(`${label} during adapter admission refuses before cleanup`, async t => {
  const f = await nativeFixture(t, { cloudState: 'same' }), wait = deferred();
  f.item.adapterPending = true; f.item.adapterFlight = wait.promise;
  const operation = f.prepare(); change(f);
  const before = preserved(f), writes = f.nativeWrites.length;
  f.item.adapterPending = false; wait.resolve();
  await assert.rejects(operation); unchanged(f, before, writes);
});

test('a positively admitted native disconnect permits exact owned cleanup before cloud handback', async t => {
  const f = await nativeFixture(t, { restriction: 'owned' }), owned = clone(f.item.controller.status().owned);
  f.permit(false); f.disconnect();
  await f.item.controller.update({ enabled: false }); f.runtime.persist();
  assert.equal(f.item.controller.status().session.connected, false);
  assert.deepEqual(f.item.controller.status().owned, owned, 'authority loss did not fabricate cleanup');
  assert.equal(f.item.request, null); assert.equal(f.item.targetState, null);
  const writes = f.nativeWrites.length; f.permit(true);
  await f.prepare();
  assert.equal(f.item.backendTransition.ready, true);
  assert.deepEqual(f.nativeWrites.slice(writes), [{ action: 'ClearChargingProfile', body: { id: owned.profileId } }]);
  assert.equal(f.item.controller.status().owned, null); assert.equal(f.item.controller.status().pending, null);
});

test('a lost native Clear during disconnected handback retains its exact obligation', async t => {
  const f = await nativeFixture(t, { restriction: 'owned' }), owned = clone(f.item.controller.status().owned);
  f.permit(false); f.disconnect(); await f.item.controller.update({ enabled: false }); f.runtime.persist();
  f.permit(true); f.loseClear();
  await assert.rejects(f.prepare(), /blocked until the current restriction is released/);
  assert.equal(f.item.backendTransition.ready, false);
  assert.deepEqual(f.item.controller.status().owned, owned);
  assert.equal(f.item.controller.status().pending.action, 'clear');
  assert.equal(f.item.controller.status().pending.instruction.profileId, owned.profileId);
  assert.equal(f.nativeWrites.filter(row => row.action === 'ClearChargingProfile').length, 1);
});

for (const reason of ['Local', 'Remote', 'DeAuthorized'])
  test(`a current object-shaped ${reason} transaction Stop remains authoritative before cloud handback`, async t => {
    const f = await nativeFixture(t, { cloudState: 'same' });
    const stop = { transactionId: 41, at: f.now, receivedAt: f.now, reason };
    f.setReadHook(() => ({ ...f.snapshot(), nativeStop: stop, transactionId: null, transactionStartedAt: null,
      transactionConfirmedAt: null, transactionConfirmed: false, transactionProvenance: null }));
    await f.item.controller.update({ enabled: false });
    assert.equal(f.item.controller.status().manual.kind, 'stop');
    const before = preserved(f), writes = f.nativeWrites.length;
    await assert.rejects(f.prepare(), /Current native instructions must remain scoped/);
    unchanged(f, before, writes);
    assert.deepEqual(f.item.controller.status().snapshot.nativeStop, stop);
  });

test('a retained Stop from an earlier connection does not block an admitted same-boundary quiet handback', async t => {
  const f = await nativeFixture(t, { cloudState: 'same' });
  const stop = { transactionId: 40, at: START - 1000, receivedAt: START - 1000, reason: 'Remote' };
  f.setReadHook(() => ({ ...f.snapshot(), nativeStop: stop }));
  await f.item.controller.update({ enabled: false });
  assert.equal(f.item.controller.status().manual, null);
  await f.prepare();
  assert.equal(f.item.backendTransition.ready, true);
  assert.deepEqual(f.item.controller.status().snapshot.nativeStop, stop);
  assert.equal(f.nativeWrites.length, 0);
});

test('a rejected future source report withdraws preparation despite a still retained prior snapshot', async t => {
  const f = await nativeFixture(t, { cloudState: 'same' });
  f.setReadHook(() => ({ ...f.snapshot(), statusAt: f.now + 1000 }));
  await f.item.controller.update({ enabled: false });
  assert.equal(f.item.controller.status().errorCode, 'read-failed');
  const before = preserved(f), writes = f.nativeWrites.length;
  await assert.rejects(f.prepare(), /unavailable or inconsistent/); unchanged(f, before, writes);
  f.setReadHook(null); await f.item.controller.update({ enabled: false });
  await f.prepare(); assert.equal(f.item.backendTransition.ready, true, 'read recovery remains reachable after unprepared refusal');
});

test('source loss with an exact pending native instruction never becomes an empty initialization', async t => {
  const f = await nativeFixture(t, { cloudState: 'same', restriction: 'pending' });
  const pending = clone(f.item.controller.status().pending), writes = f.nativeWrites.length;
  f.offline(); await f.item.controller.update({ enabled: false });
  const before = preserved(f);
  await assert.rejects(f.prepare(), /unavailable or inconsistent/); unchanged(f, before, writes);
  assert.deepEqual(f.item.controller.status().pending, pending);
});

for (const restriction of ['owned', 'pending'])
  test(`an unknown socket with no planning references retains its ${restriction} native cleanup duty`, async t => {
    const f = await nativeFixture(t, { restriction });
    f.permit(false); f.disconnect(); await f.item.controller.update({ enabled: false }); f.runtime.persist();
    assert.equal(f.item.request, null); assert.equal(f.item.targetState, null);
    assert.equal(f.item.progress?.reference?.vehicleScope ?? null, null);
    f.offline(); await f.item.controller.update({ enabled: false });
    const before = preserved(f), writes = f.nativeWrites.length; f.permit(true);
    await assert.rejects(f.prepare());
    assert.deepEqual(preserved(f), before);
    assert.equal(f.nativeWrites.length, writes);
    assert.notEqual(f.item.backendTransition?.ready, true);
  });

test('an unknown socket with no planning references cannot retire a produced native manual Stop', async t => {
  const f = await nativeFixture(t, { references: false });
  const stop = { transactionId: 41, at: f.now, receivedAt: f.now, reason: 'Local' };
  f.setReadHook(() => ({ ...f.snapshot(), nativeStop: stop }));
  await f.item.controller.update({ enabled: false });
  assert.equal(f.item.controller.status().manual.kind, 'stop');
  // Unknown physical status is not Available/disconnected. Native ownership
  // can be admitted before the first runtime planning reference exists.
  f.setReadHook(() => ({ ...f.snapshot(), nativeStop: stop, connectorStatus: 'Unavailable', pluggedIn: null }));
  await f.item.controller.update({ enabled: false });
  assert.equal(f.item.controller.status().manual.kind, 'stop');
  assert.equal(f.item.controller.status().session.connected, null);
  assert.equal(f.item.request, null); assert.equal(f.item.targetState, null);
  assert.equal(f.item.progress?.reference?.vehicleScope ?? null, null);
  f.offline(); await f.item.controller.update({ enabled: false });
  assert.equal(f.item.controller.status().errorCode, 'offline');
  const before = preserved(f), writes = f.nativeWrites.length;
  await assert.rejects(f.prepare());
  assert.deepEqual(preserved(f), before);
  assert.equal(f.nativeWrites.length, writes);
  assert.notEqual(f.item.backendTransition?.ready, true);
  assert.deepEqual(f.item.controller.status().snapshot.nativeStop, stop);
});

test('an actual newer Available retires an old produced manual Stop without blocking ordinary deactivation', async t => {
  const f = await nativeFixture(t);
  const stop = { transactionId: 41, at: f.now, receivedAt: f.now, reason: 'Local' };
  f.setReadHook(() => ({ ...f.snapshot(), nativeStop: stop }));
  await f.item.controller.update({ enabled: false });
  assert.equal(f.item.controller.status().manual.kind, 'stop');
  f.disconnect(); await f.item.controller.update({ enabled: false }); f.runtime.persist();
  assert.equal(f.item.controller.status().manual, null);
  assert.equal(f.item.controller.status().session.connected, false);
  assert.equal(f.item.request, null); assert.equal(f.item.targetState, null);
  await f.prepare();
  assert.equal(f.item.backendTransition.ready, true);
  assert.deepEqual(f.item.controller.status().snapshot.nativeStop, stop);
  assert.equal(f.nativeWrites.length, 0);
});

test('historical scoped charge evidence does not override an actual admitted native disconnect', async t => {
  const f = await nativeFixture(t, { restriction: 'owned' }), scope = f.item.request.scope;
  const field = value => ({ value, source: 'bmw-cardata', available: true, measuredAt: f.now, receivedAt: f.now });
  const historical = updateChargingProgress(null, { id: 'charger1', settings: { manualSoc: 20 }, requiredGridKwh: 20,
    telemetry: { providerConnected: true, vehicle: { state: 'identified', id: 'bmw', sessionId: scope } },
    values: { soc: field(50), minimumSoc: field(85), capacityKwh: field(20), connected: { value: true, available: true } } }, f.now).state;
  assert(historical.reference.vehicleScope); assert(historical.batteryInputs.scope);
  f.permit(false); f.disconnect(); await f.item.controller.update({ enabled: false }); f.runtime.persist();
  assert.equal(f.item.request, null); assert.equal(f.item.targetState, null); assert.equal(f.item.vehicleMatch, null);
  // A preserved historical current-format source fragment carries no current
  // connection authority. Keep it exact beside the admitted newer disconnect.
  f.item.progress = clone(historical);
  const owned = clone(f.item.controller.status().owned), writes = f.nativeWrites.length; f.permit(true);
  await f.prepare();
  assert.equal(f.item.backendTransition.ready, true);
  assert.deepEqual(f.item.progress, historical);
  assert.deepEqual(f.nativeWrites.slice(writes), [{ action: 'ClearChargingProfile', body: { id: owned.profileId } }]);
});

test('a quiet admitted Available controller with no current scope permits ordinary cloud preparation', async t => {
  const f = await nativeFixture(t);
  f.disconnect(); await f.item.controller.update({ enabled: false }); f.runtime.persist();
  assert.equal(f.item.request, null); assert.equal(f.item.targetState, null);
  assert.equal(f.item.controller.status().owned, null); assert.equal(f.item.controller.status().pending, null);
  await f.prepare();
  assert.equal(f.item.backendTransition.ready, true);
  assert.equal(f.nativeWrites.length, 0);
  assert.equal(f.store.getState(f.cloudKey), null, 'ordinary preparation does not manufacture cloud session state');
});

test('a native socket change during the drain keeps preparation blocked without copying session references', async t => {
  const f = await nativeFixture(t, { cloudState: 'same' }), before = preserved(f);
  f.setReadHook(() => ({ ...f.snapshot(), connectionId: 'synthetic-new-native-socket' }));
  await assert.rejects(f.prepare(), /blocked until the current restriction is released/);
  assert.equal(f.item.backendTransition.ready, false);
  assert.deepEqual(f.item.request, before.request); assert.deepEqual(f.item.targetState, before.target);
  assert.deepEqual(f.item.progress, before.progress); assert.deepEqual(f.item.sessionCost, before.cost);
  assert.deepEqual(f.store.getState(f.cloudKey), before.cloud);
  assert.equal(f.nativeWrites.length, 0);
});
