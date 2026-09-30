import test from 'node:test';
import assert from 'node:assert/strict';
import { createOcppScheduleAdapter, initialOcppControllerState, normalizeOcppComposite, ocppPauseInstruction } from '../src/charging/ocpp.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { chargerDisplay } from '../chart/charging.js';

const START = Date.parse('2026-09-24T09:00:00Z'), MINUTE = 60_000, scope = 'a'.repeat(64);
const plan = (startAt, extra = {}) => ({ id: 'synthetic-plan', startAt, feasible: true, periods: [{ startAt, endAt: null }], ...extra });
function fixture({ initialState = null, identification = null } = {}) {
  let now = START, authority = true, connected = true, confirmed = true, transactionId = 7, connectionId = 'synthetic-socket', physicalPause = true;
  let stored = null, saveError = false, witnessSaveError = false, interceptor = null, manualEvent = null, snapshotChanges = {};
  const profiles = new Map(), calls = [], saves = [];
  const isPausing = () => [...profiles.values()].some(row => row.transactionId === transactionId
    && Date.parse(row.validFrom) <= now && Date.parse(row.validTo) > now);
  const readSnapshot = () => ({ transport: 'ocpp', scope, connectionId, readAt: now, online: connected,
    connectorStatus: isPausing() && physicalPause ? 'SuspendedEVSE' : 'Charging', statusAt: now,
    transactionId, transactionStartedAt: START - MINUTE, transactionConfirmed: confirmed,
    pluggedIn: true, powerKw: isPausing() && physicalPause ? 0 : 7, powerAt: now, manualEvent, ...snapshotChanges });
  const request = async (action, payload, options) => {
    assert.equal(options.guard(), true, 'wire mutation/query requires current authority');
    calls.push({ action, payload: structuredClone(payload) });
    const result = () => {
      assert.equal(options.beforeSend?.() ?? true, true, 'wire send must retain its pre-write status witness');
      if (action === 'SetChargingProfile') { profiles.set(payload.csChargingProfiles.chargingProfileId, structuredClone(payload.csChargingProfiles)); return { status: 'Accepted' }; }
      if (action === 'ClearChargingProfile') return { status: profiles.delete(payload.id) ? 'Accepted' : 'Unknown' };
      const ends = [...profiles.values()].filter(row => row.transactionId === transactionId
        && Date.parse(row.validTo) > now && Date.parse(row.validTo) < now + payload.duration * 1000).map(row => Date.parse(row.validTo));
      return { status: 'Accepted', connectorId: 1, scheduleStart: new Date(now).toISOString(), chargingSchedule: {
        chargingRateUnit: 'A', duration: payload.duration,
        chargingSchedulePeriod: [{ startPeriod: 0, limit: isPausing() ? 0 : 32 }, ...[...new Set(ends)].sort((a, b) => a - b)
          .map(end => ({ startPeriod: (end - now) / 1000, limit: 32 }))] } };
    };
    return interceptor ? interceptor(action, payload, options, result) : result();
  };
  const adapter = createOcppScheduleAdapter({ scope, readSnapshot, request, clock: () => now, canControl: () => authority,
    isCurrent: (value, { unchangedStatus = false } = {}) => connected && value.connectionId === connectionId
      && value.transactionId === transactionId && (!unchangedStatus || value.connectorStatus === readSnapshot().connectorStatus
        && value.statusAt === readSnapshot().statusAt) });
  const controller = adapter.createController({ initialState, clock: () => now, canControl: () => authority,
    getIdentification: snapshot => typeof identification === 'function' ? identification(snapshot) : identification,
    saveState: state => {
      if (saveError || witnessSaveError && state.pending?.instruction.pauseRequestedAt !== undefined) throw Error('synthetic disk error');
      stored = structuredClone(state); saves.push(stored);
    } });
  return { controller, adapter, calls, saves, profiles, get stored() { return stored; }, get now() { return now; },
    advance: ms => { now += ms; }, authority: value => { authority = value; }, connected: value => { connected = value; },
    confirmed: value => { confirmed = value; }, transaction: value => { transactionId = value; },
    physicalPause: value => { physicalPause = value; }, saveError: value => { saveError = value; },
    witnessSaveError: value => { witnessSaveError = value; },
    intercept: value => { interceptor = value; }, manual: value => { manualEvent = value; },
    snapshot: value => { snapshotChanges = value; },
    identify: value => { identification = value; },
    reconnect: () => { connectionId += '-new'; confirmed = false; } };
}
const writes = f => f.calls.filter(row => row.action !== 'GetCompositeSchedule');

test('native pause is a finite transaction-specific zero profile with no positive current command', () => {
  const instruction = ocppPauseInstruction({ profileId: 1, transactionId: 7, now: START, startAt: START + 30 * MINUTE });
  const p = instruction.payload.csChargingProfiles;
  assert.equal(p.chargingProfilePurpose, 'TxProfile'); assert.equal(p.chargingProfileKind, 'Absolute');
  assert.equal(p.transactionId, 7); assert.equal(p.validTo, new Date(START + 30 * MINUTE).toISOString());
  assert.deepEqual(p.chargingSchedule.chargingSchedulePeriod, [{ startPeriod: 0, limit: 0 }]);
  assert.equal(p.chargingSchedule.duration, 1800);
  assert.throws(() => ocppPauseInstruction({ profileId: 1, transactionId: 7, now: START, startAt: START + 49 * 3600_000 }));
});

test('composite parsing requires connector, units, full horizon and ordered bounded periods', () => {
  const response = { status: 'Accepted', connectorId: 1, scheduleStart: new Date(START).toISOString(), chargingSchedule: {
    chargingRateUnit: 'A', duration: 60, chargingSchedulePeriod: [{ startPeriod: 0, limit: 255 }] } };
  assert.equal(normalizeOcppComposite(response, { now: START, duration: 60 }).periods[0].limit, 255);
  for (const changed of [{ ...response, connectorId: 0 }, { ...response, scheduleStart: new Date(START - MINUTE).toISOString() },
    { ...response, chargingSchedule: { ...response.chargingSchedule, chargingRateUnit: 'W' } },
    { ...response, chargingSchedule: { ...response.chargingSchedule, duration: 59 } },
    { ...response, chargingSchedule: { ...response.chargingSchedule, chargingSchedulePeriod: [{ startPeriod: 10, limit: 0 }] } }])
    assert.throws(() => normalizeOcppComposite(changed, { now: START, duration: 60 }), { code: 'composite-unavailable' });
});

test('accepted zero envelope and fresh physical pause are distinct evidence', async () => {
  const f = fixture(); f.physicalPause(false);
  let view = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(view.phase, 'pause-unconfirmed'); assert.equal(view.ownsInstruction, true); assert.equal(view.pauseConfirmed, false);
  assert.equal(f.saves[0].pending, null);
  assert.ok(f.saves.find(value => value.pending?.action === 'install' && value.pending.attempts === 0));
  f.physicalPause(true); f.advance(1000);
  view = await f.controller.update({ enabled: true });
  assert.equal(view.phase, 'paused'); assert.equal(view.pauseConfirmed, true);
  assert.equal(writes(f).length, 1, 'an unchanged pause only rereads the envelope');
  assert.equal(view.snapshot.schedule, undefined); assert.equal(view.snapshot.reason, undefined);
  assert.equal(f.adapter.normalize(view.snapshot).scheduledStartAt.value, START + 30 * MINUTE);
});

test('failed intent persistence never sends a native command', async () => {
  const f = fixture(); f.saveError(true);
  const view = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(view.errorCode, 'storage-failed'); assert.equal(f.calls.length, 0);
});

test('unconfirmed transaction after reconnect cannot install a pause', async () => {
  const f = fixture(); f.confirmed(false);
  const view = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(view.errorCode, 'transaction-unconfirmed'); assert.equal(writes(f).length, 0);
});

function disconnectedState() {
  const state = initialOcppControllerState(scope);
  state.session = { transactionId: 6, connected: null, connectedAt: START - 3 * MINUTE, lastDisconnectedAt: START - MINUTE };
  state.vehicleDisconnect = { source: 'easee-stream', readingId: 'synthetic-disconnect',
    endedConnectedAt: START - 3 * MINUTE, measuredAt: START - 2 * MINUTE,
    receivedAt: START - 2 * MINUTE, awaitingConnection: true };
  state.released = true;
  return state;
}

test('native physical reconnect restores the charger card without granting transaction control', async t => {
  const f = fixture({ initialState: disconnectedState() }), states = new Map();
  f.snapshot({ transactionId: null, transactionStartedAt: null, transactionConfirmed: false, statusAt: START });
  const config = { input: 'providers', connections: { easee: { charger_id: 'synthetic-card-charger' } } };
  const store = { getState: key => structuredClone(states.get(key)), setState: (key, value) => states.set(key, structuredClone(value)) };
  const attach = ({ controller, adapter }, clock) => {
    const runtime = new ChargingRuntime({ engine: {}, config, store, clock });
    const item = runtime.chargers.charger1;
    item.controller = controller; item.adapter = adapter;
    item.vehicleDisconnect ??= structuredClone(disconnectedState().vehicleDisconnect);
    t.after(() => runtime.close());
    return runtime;
  };
  const runtime = attach(f, () => f.now);
  let control = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  let charger = runtime.status().chargers[0];
  assert.equal(charger.values.connected.value, true);
  assert.equal(charger.values.connected.source, 'easee-ocpp');
  assert.equal(charger.values.charging.value, true);
  assert.equal(charger.values.powerKw.value, 7);
  assert.equal(chargerDisplay(charger).showMetrics, true);
  assert.ok(charger.request);
  assert.equal(control.session.connectedAt, START);
  assert.equal(control.session.transactionId, null, 'The disconnected transaction must not enter the new physical session');
  assert.equal(control.vehicleDisconnect.awaitingConnection, true);
  assert.equal(control.released, false);
  assert.equal(charger.identification.available, false);
  assert.equal(f.calls.length, 0, 'Physical charging evidence does not authorize a native profile');
  const request = structuredClone(charger.request);
  runtime.persist();

  const restored = fixture({ initialState: f.stored });
  restored.advance(MINUTE);
  restored.transaction(8);
  restored.snapshot({ transactionId: null, transactionStartedAt: null, transactionConfirmed: false, statusAt: START });
  const restarted = attach(restored, () => restored.now);
  await restored.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  charger = restarted.status().chargers[0];
  assert.deepEqual(charger.request, request, 'Restart and rereading the same status preserve the physical session and deadline');
  assert.equal(charger.values.connected.value, true);
  assert.equal(restored.calls.length, 0);

  restored.advance(MINUTE);
  restored.snapshot({ transactionId: 8, transactionStartedAt: START + 30_000, transactionConfirmed: true, statusAt: START });
  control = await restored.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(control.vehicleDisconnect.awaitingConnection, false);
  assert.equal(control.session.connectedAt, START, 'Transaction confirmation must not start a second physical session');
  assert.deepEqual(restarted.status().chargers[0].request, request);
  assert.equal(writes(restored).filter(call => call.action === 'SetChargingProfile').length, 1);

  restarted.chargers.charger1.vehicleDisconnect = { source: 'easee-stream', readingId: 'synthetic-next-disconnect',
    endedConnectedAt: START, measuredAt: START + MINUTE, receivedAt: START + MINUTE };
  assert.equal(restarted.status().chargers[0].values.connected.value, false,
    'A newer disconnect takes effect even before the controller has reconciled it');
});

test('an old confirmed transaction cannot control a newer physical connection', async () => {
  const initial = disconnectedState(), f = fixture({ initialState: initial });
  f.snapshot({ transactionId: 6, transactionStartedAt: initial.session.connectedAt, transactionConfirmed: true });
  let view = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(view.session.connected, true);
  assert.equal(view.session.connectedAt, START);
  assert.equal(view.session.transactionId, null);
  assert.equal(view.vehicleDisconnect.awaitingConnection, true);
  f.advance(MINUTE);
  view = await f.controller.update({ enabled: true });
  assert.equal(view.session.connectedAt, START);
  assert.equal(view.session.transactionId, null);
  assert.equal(f.calls.length, 0);
});

test('old, unknown and offline OCPP status cannot reopen a disconnected physical session', async () => {
  for (const patch of [
    { statusAt: START - MINUTE - 1 }, { statusAt: START - MINUTE },
    { pluggedIn: null, connectorStatus: 'Unavailable' }, { online: false },
  ]) {
    const f = fixture({ initialState: disconnectedState() });
    f.snapshot({ transactionId: null, transactionStartedAt: null, transactionConfirmed: false, ...patch });
    const view = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
    assert.notEqual(view.session.connected, true);
    assert.equal(view.vehicleDisconnect.awaitingConnection, true);
    assert.equal(f.calls.length, 0);
  }
});

test('lost install acknowledgement retries identical ID and body with a fixed attempt bound', async () => {
  const f = fixture();
  f.intercept((action, payload, options, result) => { const reply = result(); if (action === 'SetChargingProfile') throw Error('lost reply'); return reply; });
  await f.controller.update({ enabled: true, plan: plan(START + 60 * MINUTE) });
  for (let i = 0; i < 4; i++) { f.advance(120_000); await f.controller.update({ enabled: true }); }
  const sets = f.calls.filter(row => row.action === 'SetChargingProfile');
  assert.equal(sets.length, 3); assert.deepEqual(sets[0].payload, sets[2].payload);
  assert.equal(f.controller.status().errorCode, 'retry-limit'); assert.equal(f.stored.pending.attempts, 3);
});

test('accepted install with failed composite readback retries the read without repeating the write', async () => {
  const f = fixture(); let fail = true;
  f.intercept((action, payload, options, result) => { if (action === 'GetCompositeSchedule' && fail) throw Error('lost composite'); return result(); });
  await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(f.stored.pending.accepted, true); fail = false;
  const view = await f.controller.update({ enabled: true });
  assert.equal(view.phase, 'paused'); assert.equal(writes(f).length, 1);
});

test('OFF clears only the exact pending or owned profile and retains foreign restrictions', async () => {
  const f = fixture(); await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  const ownId = f.stored.owned.profileId;
  f.profiles.set(999999999, { transactionId: 7, validFrom: new Date(START).toISOString(), validTo: new Date(START + 60 * MINUTE).toISOString() });
  const view = await f.controller.update({ enabled: false });
  assert.equal(view.phase, 'off'); assert.equal(view.handoverConfirmed, true);
  assert.deepEqual(writes(f).at(-1), { action: 'ClearChargingProfile', payload: { id: ownId } });
  assert.equal(f.profiles.has(999999999), true); assert.equal(f.profiles.has(ownId), false);
});

test('expiry releases the final period and never reinstalls a delay at ready-by', async () => {
  const f = fixture(); await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  f.advance(30 * MINUTE);
  let view = await f.controller.update({ enabled: true });
  assert.equal(view.phase, 'released'); assert.equal(view.released, true);
  f.advance(120 * MINUTE);
  view = await f.controller.update({ enabled: true, plan: plan(f.now + 30 * MINUTE) });
  assert.equal(view.phase, 'released'); assert.equal(f.profiles.size, 0);
  assert.equal(f.calls.filter(row => row.action === 'SetChargingProfile').length, 1);
});

test('sequential planned gaps use expiring profiles while open periods remain unrestricted', async () => {
  const f = fixture(), periods = [{ startAt: START, endAt: START + 20 * MINUTE }, { startAt: START + 50 * MINUTE, endAt: null }];
  let view = await f.controller.update({ enabled: true, plan: plan(START, { periods }) });
  assert.equal(view.phase, 'active'); assert.equal(writes(f).length, 0);
  f.advance(20 * MINUTE); view = await f.controller.update({ enabled: true });
  assert.equal(view.phase, 'paused'); assert.equal(f.stored.owned.startAt, START + 50 * MINUTE);
  f.advance(30 * MINUTE); view = await f.controller.update({ enabled: true });
  assert.equal(view.phase, 'released'); assert.equal(f.profiles.size, 0);
});

test('a vehicle-side suspension retains period timing and needs charger-side gap confirmation', async () => {
  const f = fixture(), periods = [{ startAt: START, endAt: START + 20 * MINUTE }, { startAt: START + 50 * MINUTE, endAt: null }];
  f.snapshot({ connectorStatus: 'SuspendedEV', powerKw: 0 });
  let view = await f.controller.update({ enabled: true, plan: plan(START, { periods }) });
  assert.equal(view.phase, 'active'); assert.equal(writes(f).length, 0);
  assert.equal(f.adapter.normalize(view.snapshot).charging.value, false);

  f.advance(20 * MINUTE); view = await f.controller.update({ enabled: true });
  assert.equal(view.phase, 'pause-unconfirmed'); assert.equal(view.ownsInstruction, true); assert.equal(view.pauseConfirmed, false);
  assert.equal(writes(f).length, 1); assert.equal(writes(f)[0].action, 'SetChargingProfile');
  assert.deepEqual(writes(f)[0].payload.csChargingProfiles.chargingSchedule.chargingSchedulePeriod, [{ startPeriod: 0, limit: 0 }]);
  assert.equal(f.stored.owned.startAt, periods[1].startAt);

  f.advance(MINUTE); f.snapshot({ connectorStatus: 'SuspendedEVSE', powerKw: 0 });
  view = await f.controller.update({ enabled: true });
  assert.equal(view.phase, 'paused'); assert.equal(view.pauseConfirmed, true); assert.equal(writes(f).length, 1);

  const profileId = f.stored.owned.profileId;
  f.advance(29 * MINUTE); f.snapshot({ connectorStatus: 'SuspendedEV', powerKw: 0 });
  view = await f.controller.update({ enabled: true });
  assert.equal(view.phase, 'released'); assert.equal(view.released, true); assert.equal(view.pauseConfirmed, false);
  assert.equal(f.adapter.normalize(view.snapshot).charging.value, false);
  assert.equal(f.profiles.size, 0);
  assert.equal(writes(f).length, 2);
  assert.deepEqual(writes(f).at(-1), { action: 'ClearChargingProfile', payload: { id: profileId } });
});

test('only explicit current-transaction native events establish manual priority', async () => {
  const f = fixture(); await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  f.advance(1000); f.manual({ id: 'native-release', kind: 'release', at: f.now, transactionId: 7 });
  let view = await f.controller.update({ enabled: true });
  assert.equal(view.phase, 'yielded'); assert.equal(f.profiles.size, 0);
  view = await f.controller.update({ enabled: true, resume: true });
  assert.equal(view.manual, null); assert.equal(view.phase, 'paused');
  view = await f.controller.update({ enabled: true });
  assert.equal(view.manual, null, 'repeated source event cannot undo explicit resumption');
});

test('new transaction clears the previous exact profile before creating a separately scoped pause', async () => {
  const f = fixture(); await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  const oldId = f.stored.owned.profileId; f.transaction(8); f.advance(1000);
  await f.controller.update({ enabled: true, plan: plan(START + 40 * MINUTE) });
  assert.equal(f.profiles.has(oldId), false);
  assert.equal(f.stored.owned.transactionId, 8); assert.notEqual(f.stored.owned.profileId, oldId);
});

test('restart retains a pending native intent and rejects foreign, old or malformed ownership', async () => {
  const f = fixture(); f.intercept((action, payload, options, result) => { if (action === 'SetChargingProfile') throw Error('timeout'); return result(); });
  await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  const saved = f.stored, restarted = fixture({ initialState: saved }); restarted.advance(31_000);
  await restarted.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(restarted.stored.owned.profileId, saved.pending.instruction.profileId);
  for (const malformed of [{ ...saved, version: 5 }, { ...saved, scope: 'b'.repeat(64) }, { ...saved, retired: true },
    { ...saved, pending: { ...saved.pending, attempts: 4 } }])
    assert.throws(() => fixture({ initialState: malformed }), /Unsupported native charging ownership/);
});

test('revocation during a queued mutation prevents the wire write and retains intent', async () => {
  const f = fixture();
  f.intercept((action, payload, options, result) => {
    if (action === 'SetChargingProfile') { f.authority(false); assert.equal(options.guard(), false); throw Error('revoked'); }
    return result();
  });
  await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(f.profiles.size, 0); assert.equal(f.stored.pending.action, 'install');
});

test('native ownership namespace never consumes or replaces the cloud ownership key', () => {
  const fake = { key: 'charging:mqtt', charger: () => ({ association: 'same-charger', adapter: { ownershipNamespace: 'ocpp' } }) };
  assert.equal(ChargingRuntime.prototype.ownershipKey.call(fake, 'charger1'), 'charging:mqtt:charger1:same-charger:ownership:ocpp');
  fake.charger = () => ({ association: 'same-charger', adapter: {} });
  assert.equal(ChargingRuntime.prototype.ownershipKey.call(fake, 'charger1'), 'charging:mqtt:charger1:same-charger:ownership');
  assert.equal(initialOcppControllerState(scope).kind, 'ocpp-tx-pause');
});

test('OFF supersedes an in-flight install and releases its exact durable intent', async () => {
  const f = fixture(); let entered, complete;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.intercept(async (action, payload, options, result) => {
    if (action !== 'SetChargingProfile') return result();
    result(); entered(); await new Promise(resolve => { complete = resolve; });
    assert.equal(options.guard(), false); throw Error('acknowledgement lost after OFF');
  });
  const setting = f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  await waiting;
  const off = f.controller.update({ enabled: false }); complete(); await setting;
  const view = await off;
  assert.equal(view.phase, 'off'); assert.equal(view.handoverConfirmed, true); assert.equal(f.profiles.size, 0);
  assert.deepEqual(writes(f).map(row => row.action), ['SetChargingProfile', 'ClearChargingProfile']);
  assert.equal(view.pending, null); assert.equal(view.owned, null);
});

test('an immediate plan clears an uncertain pause without resending obsolete intent', async () => {
  const f = fixture();
  f.intercept((action, payload, options, result) => { const reply = result(); if (action === 'SetChargingProfile') throw Error('lost'); return reply; });
  await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  const view = await f.controller.update({ enabled: true, plan: plan(START) });
  assert.equal(view.phase, 'released'); assert.equal(view.pending, null); assert.equal(f.profiles.size, 0);
  assert.deepEqual(writes(f).map(row => row.action), ['SetChargingProfile', 'ClearChargingProfile']);
});

test('queued command is fenced if the confirmed transaction changes before wire send', async () => {
  const f = fixture();
  f.intercept((action, payload, options, result) => {
    if (action === 'SetChargingProfile') { f.transaction(8); assert.equal(options.guard(), false); throw Error('new transaction'); }
    return result();
  });
  const view = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(view.pending.instruction.transactionId, 7); assert.equal(f.profiles.size, 0);
});

test('identity pause witness is saved from the final Charging read before the native wire write', async () => {
  const f = fixture();
  f.intercept((action, payload, options, result) => {
    if (action === 'SetChargingProfile') {
      assert.equal(f.stored.pending.instruction.pauseRequestedAt, START);
      assert.equal(options.beforeSend(), true);
    }
    return result();
  });
  const control = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(control.owned.requestedAt, START);
  assert.equal(control.owned.pauseRequestedAt, START);
  assert.equal(control.pauseConfirmed, true);
});

test('installing a native pause over an already-stopped transaction grants no identity witness', async () => {
  const f = fixture(); f.snapshot({ connectorStatus: 'SuspendedEVSE', powerKw: 0 });
  const control = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(control.owned.requestedAt, START);
  assert.equal(control.owned.pauseRequestedAt, undefined);
  assert.equal(control.pauseConfirmed, true, 'Ordinary native scheduling retains its existing physical confirmation');
});

test('the fresh native pre-write read, rather than the earlier planning read, decides the identity witness', async () => {
  const f = fixture(), read = f.adapter.read; let reads = 0;
  f.adapter.read = async options => {
    if (++reads === 2) f.snapshot({ connectorStatus: 'SuspendedEVSE', powerKw: 0 });
    return read(options);
  };
  const control = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(control.owned.pauseRequestedAt, undefined);
  assert.equal(control.pauseConfirmed, true);
});

test('a stop while the native request is queued revokes its witness and a stopped retry cannot reuse it', async () => {
  const f = fixture();
  f.intercept((action, payload, options, result) => {
    if (action === 'SetChargingProfile') {
      f.advance(1000); f.snapshot({ connectorStatus: 'SuspendedEVSE', statusAt: START + 1000, powerKw: 0 });
      assert.equal(options.guard(), true, 'Transaction authority remains current');
      assert.equal(options.beforeSend(), false, 'The independent natural stop invalidates causal write evidence');
      throw Error('synthetic queued stop');
    }
    return result();
  });
  let control = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(control.owned, null); assert.equal(f.profiles.size, 0);
  assert.equal(control.pending.instruction.pauseRequestedAt, START);
  f.advance(31_000); f.intercept(null);
  control = await f.controller.update({ enabled: true });
  assert.equal(control.owned.pauseRequestedAt, undefined);
  assert.equal(control.pauseConfirmed, true);
});

test('successful native pause response may follow its physical stop without losing transaction authority', async () => {
  const f = fixture();
  f.intercept((action, payload, options, result) => {
    const response = result();
    if (action === 'SetChargingProfile') {
      assert.equal(options.beforeSend(), false, 'The command has now caused the expected status change');
      assert.equal(options.guard(), true, 'Response delivery must not require the old Charging state');
    }
    return response;
  });
  const control = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(control.pauseConfirmed, true); assert.equal(control.owned.pauseRequestedAt, START);
});

test('identity witness persistence failure prevents the native write', async () => {
  const f = fixture(); f.witnessSaveError(true);
  const control = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(control.errorCode, 'storage-failed'); assert.equal(writes(f).length, 0);
  assert.equal(f.stored.pending.instruction.pauseRequestedAt, undefined);
});

test('accepted native installation preserves its witness through readback recovery without resending', async () => {
  const f = fixture(); let fail = true;
  f.intercept((action, payload, options, result) => {
    if (action === 'GetCompositeSchedule' && fail) throw Error('synthetic lost readback');
    return result();
  });
  let control = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(control.pending.accepted, true); assert.equal(control.pending.instruction.pauseRequestedAt, START);
  fail = false; f.advance(1000);
  control = await f.controller.update({ enabled: true });
  assert.equal(control.owned.pauseRequestedAt, START); assert.equal(writes(f).length, 1);
});

test('restart preserves an accepted native pause witness and does not promote unwitnessed current ownership', async () => {
  const f = fixture();
  f.intercept((action, payload, options, result) => {
    if (action === 'GetCompositeSchedule') throw Error('synthetic lost readback');
    return result();
  });
  await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(f.stored.pending.accepted, true);
  const resumed = fixture({ initialState: f.stored });
  for (const [id, profile] of f.profiles) resumed.profiles.set(id, structuredClone(profile));
  resumed.advance(1000);
  const recovered = await resumed.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(recovered.owned.pauseRequestedAt, START); assert.equal(writes(resumed).length, 0);

  const unwitnessed = structuredClone(resumed.stored); delete unwitnessed.owned.pauseRequestedAt;
  const current = fixture({ initialState: unwitnessed });
  for (const [id, profile] of f.profiles) current.profiles.set(id, structuredClone(profile));
  current.advance(2000);
  const retained = await current.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(retained.ownsInstruction, true); assert.equal(retained.owned.pauseRequestedAt, undefined);
  assert.equal(writes(current).length, 0, 'Current finite cleanup/scheduling duty is restored without inventing a witness');
  for (const pauseRequestedAt of [null, -1, START - 1, recovered.owned.confirmedAt + 1]) {
    const invalid = structuredClone(resumed.stored); invalid.owned.pauseRequestedAt = pauseRequestedAt;
    assert.throws(() => fixture({ initialState: invalid }), /Unsupported native charging ownership/);
  }
});

test('change-reported old status stays valid with fresh connection and fresh zero power', async () => {
  const f = fixture(); f.snapshot({ statusAt: START - 60 * MINUTE });
  const view = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(view.pauseConfirmed, true); assert.equal(view.phase, 'paused');
  f.snapshot({ statusAt: START - 60 * MINUTE, powerAt: START - 2 * MINUTE });
  assert.equal((await f.controller.update({ enabled: true })).pauseConfirmed, false);
  f.snapshot({ statusAt: START + 1000 });
  assert.equal((await f.controller.update({ enabled: true })).errorCode, 'read-failed');
});

test('normalized OCPP status and power preserve their own source and receipt clocks across rereads', async () => {
  const f = fixture();
  f.snapshot({ statusAt: START - 60_000, statusReceivedAt: START - 59_900,
    powerAt: START - 1000, powerReceivedAt: START - 800 });
  const first = f.adapter.normalize(await f.adapter.read());
  assert.equal(first.charging.measuredAt, START - 60_000);
  assert.equal(first.charging.receivedAt, START - 59_900);
  assert.equal(first.connected.receivedAt, START - 59_900);
  assert.equal(first.powerKw.measuredAt, START - 1000);
  assert.equal(first.powerKw.receivedAt, START - 800);
  f.advance(5000);
  const reread = f.adapter.normalize(await f.adapter.read());
  assert.deepEqual(reread.charging, first.charging);
  assert.deepEqual(reread.powerKw, first.powerKw);
  f.snapshot({ statusReceivedAt: null, powerReceivedAt: null });
  const unknown = f.adapter.normalize(await f.adapter.read());
  assert.equal(unknown.charging.receivedAt, null);
  assert.equal(unknown.powerKw.receivedAt, null);
  f.snapshot({ powerReceivedAt: f.now + 1 });
  await assert.rejects(f.adapter.read(), { code: 'read-failed' });
});

test('composite zero is required even after an accepted installation', async () => {
  const f = fixture();
  f.intercept((action, payload, options, result) => {
    const response = result();
    if (action === 'GetCompositeSchedule') response.chargingSchedule.chargingSchedulePeriod = [{ startPeriod: 0, limit: 32 }];
    return response;
  });
  const view = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(view.errorCode, 'readback-mismatch'); assert.equal(view.ownsInstruction, false); assert.equal(view.pauseConfirmed, false);
  assert.equal(view.pending.accepted, true); assert.equal(view.owned, null);
});

function transitionFixture(update) {
  const settings = { enabled: true, readyBy: '07:00' }, item = {
    controller: { update, status: () => ({ phase: 'paused' }) }, adapter: { name: 'cloud' }, lastReconcileAt: START,
  };
  const fake = { closed: false, settings, ticks: [], charger: () => item, savedOwnership: () => null,
    tick: options => fake.ticks.push(options), async setAdapter(id, adapter) { item.adapter = adapter; item.controller = { status: () => ({ phase: 'off' }) }; },
    pauseForBackendChange: id => ChargingRuntime.prototype.pauseForBackendChange.call(fake, id),
    finishBackendChange: (id, adapter) => ChargingRuntime.prototype.finishBackendChange.call(fake, id, adapter) };
  return { fake, item, settings };
}

test('backend preparation drains once, holds reconciles and preserves user preferences', async () => {
  let release, calls = [];
  const { fake, item, settings } = transitionFixture(input => {
    calls.push(input); return new Promise(resolve => { release = () => resolve({ owned: null, pending: null, handoverConfirmed: true }); });
  });
  const first = fake.pauseForBackendChange('charger1'), second = fake.pauseForBackendChange('charger1');
  assert.ok(item.backendTransition); assert.deepEqual(calls, [{ enabled: false }]);
  await ChargingRuntime.prototype.reconcile.call(fake, 'charger1');
  assert.equal(calls.length, 1, 'periodic reconcile cannot race the drain');
  release(); await Promise.all([first, second]);
  assert.equal(item.backendTransition.ready, true); assert.deepEqual(settings, { enabled: true, readyBy: '07:00' });
  const adapter = { name: 'native' }; await fake.finishBackendChange('charger1', adapter);
  assert.equal(item.backendTransition, null); assert.equal(item.adapter, adapter); assert.deepEqual(fake.ticks, [{ force: true }]);
});

test('unconfirmed backend cleanup stays held and a successful retry permits switching', async () => {
  let clean = false;
  const { fake, item } = transitionFixture(async () => ({ owned: clean ? null : { profileId: 1 }, pending: null, handoverConfirmed: clean }));
  await assert.rejects(fake.pauseForBackendChange('charger1'), /blocked until/);
  assert.equal(item.backendTransition.ready, false); assert.equal(item.error, 'charging-backend-transition-blocked');
  await assert.rejects(fake.finishBackendChange('charger1', {}), /not been prepared/);
  clean = true; await fake.pauseForBackendChange('charger1'); assert.equal(item.backendTransition.ready, true);
  fake.setAdapter = async () => { item.error = 'charging-adapter-unavailable'; };
  await assert.rejects(fake.finishBackendChange('charger1', {}), /could not activate/);
  assert.equal(item.backendTransition.ready, true, 'failed activation cannot silently reenable the previous controller');
});

test('a verified price revision retains elapsed history and confirms replacement before committing execution', async () => {
  const f = fixture(), deadlineAt = START + 180 * MINUTE;
  await f.controller.update({ enabled: true, plan: plan(START, { deadlineAt }) });
  f.advance(20 * MINUTE);
  const revised = plan(START + 60 * MINUTE, { id: 'cheaper-price-plan', deadlineAt, requiredGridKwh: 3,
    priceRevision: { previousPlanId: 'synthetic-plan', at: f.now } });
  f.intercept((action, payload, options, result) => { const reply = result(); if (action === 'SetChargingProfile') throw Error('lost reply'); return reply; });
  let view = await f.controller.update({ enabled: true, plan: revised });
  assert.equal(view.execution.planId, 'synthetic-plan'); assert.equal(view.pending.execution.planId, 'cheaper-price-plan');
  f.intercept(null); f.advance(MINUTE); view = await f.controller.update({ enabled: true, plan: revised });
  assert.equal(view.phase, 'paused'); assert.equal(view.execution.planId, 'cheaper-price-plan');
  assert.deepEqual(view.execution.periods, [{ startAt: START, endAt: START + 20 * MINUTE }, { startAt: START + 60 * MINUTE, endAt: null }]);
});

test('withdrawing an unconfirmed price revision releases the uncertain pause and keeps original execution', async () => {
  const f = fixture(), deadlineAt = START + 180 * MINUTE, original = plan(START, { deadlineAt });
  await f.controller.update({ enabled: true, plan: original }); f.advance(20 * MINUTE);
  f.intercept((action, payload, options, result) => { const reply = result(); if (action === 'SetChargingProfile') throw Error('lost reply'); return reply; });
  await f.controller.update({ enabled: true, plan: plan(START + 60 * MINUTE, { id: 'revised', deadlineAt, requiredGridKwh: 3,
    priceRevision: { previousPlanId: 'synthetic-plan', at: f.now } }) });
  const view = await f.controller.update({ enabled: true, plan: original });
  assert.equal(view.phase, 'released'); assert.equal(view.execution.planId, original.id); assert.equal(view.pending, null); assert.equal(f.profiles.size, 0);
});

test('gap replanning changes remaining periods while preserving elapsed execution', async () => {
  const f = fixture();
  await f.controller.update({ enabled: true, plan: plan(START, { periods: [
    { startAt: START, endAt: START + 20 * MINUTE }, { startAt: START + 60 * MINUTE, endAt: null }] }) });
  f.advance(20 * MINUTE); await f.controller.update({ enabled: true });
  const profileId = f.stored.owned.profileId;
  const view = await f.controller.update({ enabled: true, plan: plan(START + 45 * MINUTE, { id: 'gap-replanned' }) });
  assert.equal(view.owned.profileId, profileId); assert.equal(view.owned.startAt, START + 45 * MINUTE);
  assert.deepEqual(view.execution.periods, [{ startAt: START, endAt: START + 20 * MINUTE }, { startAt: START + 45 * MINUTE, endAt: null }]);
});

test('backend preparation permits an empty drained controller despite unrelated readback unavailability', async () => {
  const { fake, item } = transitionFixture(async () => ({ owned: null, pending: null, handoverConfirmed: false }));
  await fake.pauseForBackendChange('charger1'); assert.equal(item.backendTransition.ready, true);
});

test('close drains the current operation while retaining finite ownership for pairing handover', async () => {
  const f = fixture(); await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  const profileId = f.stored.owned.profileId; await f.controller.close();
  assert.equal(f.profiles.has(profileId), true); assert.equal(f.stored.owned.profileId, profileId);
  await f.controller.update({ enabled: false });
  assert.equal(writes(f).length, 1, 'close revokes all new commands rather than clearing a peer transfer obligation');
});

test('exact profile cleanup permits a current connection with unconfirmed transaction, never a missing profile ID', async () => {
  const current = { transport: 'ocpp', scope, connectionId: 'connection', readAt: START, online: true,
    connectorStatus: 'Available', statusAt: START, transactionId: 7, transactionStartedAt: START - MINUTE,
    transactionConfirmed: false, pluggedIn: false, powerKw: 0, powerAt: START };
  const writes = [];
  const adapter = createOcppScheduleAdapter({ scope, clock: () => START, canControl: () => true,
    readSnapshot: () => current,
    isCurrent: (snapshot, { requireTransaction = true } = {}) => snapshot.connectionId === current.connectionId
      && (!requireTransaction || current.transactionConfirmed),
    request: async (action, payload, options) => { assert.equal(options.guard(), true); writes.push({ action, payload }); return { status: 'Accepted' }; } });
  const snapshot = await adapter.read();
  await adapter.clear({ profileId: 419 }, snapshot);
  assert.deepEqual(writes, [{ action: 'ClearChargingProfile', payload: { id: 419 } }]);
  for (const instruction of [{}, { profileId: 0 }, { profileId: -1 }, { profileId: 1.5 }])
    await assert.rejects(adapter.clear(instruction, snapshot), { code: 'invalid-plan' });
  await assert.rejects(adapter.install(ocppPauseInstruction({ profileId: 419, transactionId: 7,
    now: START, startAt: START + 30 * MINUTE }), snapshot), { code: 'control-revoked' });
  current.connectionId = 'replacement';
  await assert.rejects(adapter.clear({ profileId: 419 }, snapshot), { code: 'control-revoked' });
  assert.equal(writes.length, 1);
});

test('Charge Now clears only this session’s owned pause, preserves foreign profiles, and resumes planning explicitly', async () => {
  const f = fixture(), future = plan(START + 30 * MINUTE);
  await f.controller.update({ enabled: true, plan: future });
  const ownId = f.stored.owned.profileId, connectedAt = f.controller.status().session.connectedAt;
  f.profiles.set(999999999, { transactionId: 7, validFrom: new Date(START).toISOString(), validTo: new Date(START + 60 * MINUTE).toISOString() });
  let view = await f.controller.update({ enabled: false, plan: future, chargeNow: { connectedAt } });
  assert.equal(view.phase, 'released'); assert.equal(view.execution, null);
  assert.deepEqual(writes(f).at(-1), { action: 'ClearChargingProfile', payload: { id: ownId } });
  assert(f.profiles.has(999999999), 'Native restrictions remain in the charger');
  assert(!f.profiles.has(ownId));
  const count = writes(f).length;
  await f.controller.update({ enabled: true, plan: future, chargeNow: { connectedAt } });
  assert.equal(writes(f).length, count, 'A price plan cannot replace the active session override');
  view = await f.controller.update({ enabled: true, plan: future, chargeNow: null, resume: true });
  assert.equal(view.phase, 'paused'); assert(f.profiles.has(999999999));
  assert.equal(writes(f).at(-1).action, 'SetChargingProfile');
});

test('Charge Now preserves a confirmed native OCPP stop and never sends a remote start', async () => {
  const f = fixture(); await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  const connectedAt = f.controller.status().session.connectedAt;
  f.advance(1000); f.manual({ id: 'native-stop', kind: 'stop', at: f.now, transactionId: 7 });
  const view = await f.controller.update({ enabled: false, chargeNow: { connectedAt } });
  assert.equal(view.phase, 'yielded'); assert.equal(view.manual.kind, 'stop');
  assert.equal(f.profiles.size, 0, 'Only the controller’s earlier restriction is removed');
  assert(!writes(f).some(row => /RemoteStart|RemoteStop/.test(row.action)));
});

test('an earlier OCPP session’s Charge Now cannot release a new transaction’s planned pause', async () => {
  const f = fixture(); await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  const connectedAt = f.controller.status().session.connectedAt;
  await f.controller.update({ enabled: true, chargeNow: { connectedAt } });
  f.advance(2000); f.transaction(8); f.snapshot({ transactionStartedAt: f.now });
  const view = await f.controller.update({ enabled: true, plan: plan(START + 40 * MINUTE), chargeNow: { connectedAt } });
  assert.equal(view.phase, 'paused'); assert.equal(view.released, false);
  assert.equal(f.stored.owned.transactionId, 8);
});

const activeIdentification = (phase = 'pausing') => ({ id: 'identify-one', connectedAt: START - MINUTE, phase,
  ...(phase === 'pausing' ? { pauseUntil: START + 90_000 } : {}) });

test('native identification pauses briefly with Automatic OFF and Charge Now and releases immediately afterward', async () => {
  const f = fixture({ identification: activeIdentification('waiting') });
  assert.equal(f.controller.supportsIdentification, true);
  let view = await f.controller.update({ enabled: false, chargeNow: { connectedAt: START - MINUTE } });
  assert.equal(view.phase, 'identifying'); assert.equal(writes(f).length, 0);
  f.identify(activeIdentification());
  view = await f.controller.update({ enabled: false });
  assert.equal(view.phase, 'identifying'); assert.equal(view.pauseConfirmed, true);
  assert.equal(view.owned.purpose, 'identification'); assert.equal(view.owned.identificationId, 'identify-one');
  assert.equal(view.owned.startAt, START + 90_000); assert.equal(view.owned.pauseRequestedAt, START);
  assert.equal(writes(f).length, 1);
  f.identify(snapshot => {
    assert.equal(snapshot.connectorStatus, 'SuspendedEVSE');
    assert.equal(f.controller.status().pauseConfirmed, true, 'fresh pause proof is available before lifecycle decision');
    return null;
  });
  view = await f.controller.update({ enabled: false });
  assert.equal(view.phase, 'released'); assert.equal(view.owned, null); assert.equal(writes(f).length, 2);
});

test('native identification releases only controller profiles and reapplies economics after a released session', async () => {
  const f = fixture();
  let view = await f.controller.update({ enabled: true, plan: plan(START) });
  assert.equal(view.released, true);
  const foreign = ocppPauseInstruction({ profileId: 99, transactionId: 7, now: START, startAt: START + 30 * MINUTE });
  f.profiles.set(99, foreign.payload.csChargingProfiles);
  f.identify(activeIdentification('waiting'));
  view = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(view.phase, 'identifying'); assert.equal(view.released, false);
  assert.equal(f.profiles.has(99), true); assert.equal(writes(f).length, 0);
  f.identify(null);
  view = await f.controller.update({ enabled: true });
  assert.equal(view.phase, 'paused'); assert.equal(view.owned.purpose, undefined);
  assert.equal(f.profiles.has(99), true);
});

test('native identification respects manual Stop, current transaction confirmation and stale session requests', async () => {
  for (const blocked of ['stop', 'transaction', 'session']) {
    const f = fixture({ identification: activeIdentification() });
    if (blocked === 'stop') f.manual({ id: 'native-stop', kind: 'stop', at: START, transactionId: 7 });
    if (blocked === 'transaction') { f.confirmed(false); f.identify({ ...activeIdentification(), connectedAt: START }); }
    if (blocked === 'session') f.identify({ ...activeIdentification(), connectedAt: START - 2 * MINUTE });
    const view = await f.controller.update({ enabled: false });
    assert.equal(writes(f).length, 0);
    assert.equal(view.phase, blocked === 'stop' ? 'yielded' : blocked === 'transaction' ? 'unavailable' : 'off');
  }
});

test('native identification restart retains the exact bounded profile and expiry reapplies the plan', async () => {
  const f = fixture({ identification: activeIdentification() });
  await f.controller.update({ enabled: false });
  const resumed = fixture({ initialState: f.stored, identification: activeIdentification() });
  for (const [key, value] of f.profiles) resumed.profiles.set(key, value);
  let view = await resumed.controller.update({ enabled: false });
  assert.equal(view.phase, 'identifying'); assert.equal(writes(resumed).length, 0);
  assert.equal(view.owned.pauseRequestedAt, START);
  resumed.advance(90_000);
  view = await resumed.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(view.phase, 'paused'); assert.equal(view.owned.purpose, undefined);
  assert.equal(writes(resumed)[0].action, 'ClearChargingProfile');
  assert.equal(writes(resumed)[1].action, 'SetChargingProfile');
});

test('native short identification dispatch requires saved witness, live transaction and unexpired bounded intent', async () => {
  for (const failure of ['storage', 'transaction', 'expiry']) {
    const f = fixture({ identification: activeIdentification() });
    if (failure === 'storage') f.witnessSaveError(true);
    else f.intercept((action, payload, options, result) => {
      if (action === 'SetChargingProfile') {
        if (failure === 'transaction') f.transaction(8);
        else f.advance(90_000);
        assert.equal(options.guard(), false);
        throw Object.assign(Error('synthetic changed authority'), { code: 'control-revoked' });
      }
      return result();
    });
    const view = await f.controller.update({ enabled: false });
    assert.equal(f.profiles.size, 0); assert.equal(view.owned, null);
    if (failure === 'storage') assert.equal(writes(f).length, 0);
  }
});

test('native identification rejects unknown ownership markers and retains the economic minimum duration', async () => {
  const f = fixture({ identification: activeIdentification() });
  await f.controller.update({ enabled: false });
  for (const changed of [{ purpose: 'old-test' }, { identificationId: '' },
    { identificationConnectedAt: START + 1 }, { requestedAt: START - 10 * MINUTE }]) {
    const malformed = structuredClone(f.stored); Object.assign(malformed.owned, changed);
    assert.throws(() => fixture({ initialState: malformed }), /Unsupported native charging ownership/);
  }
  const economic = fixture();
  const view = await economic.controller.update({ enabled: true, plan: plan(START + 90_000) });
  assert.equal(view.errorCode, 'invalid-plan'); assert.equal(writes(economic).length, 0);
});

test('a completed native identification pause becomes the economic profile without clearing its restriction', async () => {
  const f = fixture({ identification: activeIdentification() });
  const initial = await f.controller.update({ enabled: true });
  f.identify(null);
  const final = await f.controller.update({ enabled: true, plan: plan(START + 30 * MINUTE) });
  assert.equal(final.phase, 'paused'); assert.equal(final.owned.purpose, undefined);
  assert.equal(final.owned.profileId, initial.owned.profileId);
  assert.equal(writes(f).length, 2); assert.equal(writes(f).every(row => row.action === 'SetChargingProfile'), true);
});
