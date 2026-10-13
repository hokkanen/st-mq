import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { createChargingCalculationWriter } from '../src/charging/calculation-persistence.js';
import { updateSessionCost } from '../src/charging/session-cost.js';
import { readChargingRuntime, writeChargingRuntime } from '../src/charging/runtime-storage.js';
import { fixture as jointFixture } from './helpers/charging-joint-fixture.js';

const at = Date.parse('2026-01-15T00:00:00Z'), key = 'charging:simulated', association = 'a'.repeat(64);
const costKey = `${key}:runtime:charger/charger1/sessionCost`;
const costScope = () => ({ association, request: { scope: `${association}:${at}`, sessionId: `${association}:${at}`,
  revision: 1, deadlineAt: at + 86_400_000, overrides: {} } });
const charger = () => ({ id: 'charger1', settings: { enabled: false }, control: {},
  values: { connected: { value: true } }, progress: { connectionAt: at, remainingGridKwh: 8 } });
const energy = () => ({ gridKwh: 0, intervals: [], incomplete: false });
const cost = () => updateSessionCost(null, charger(), at, [{ start: at, end: at + 86_400_000, price: 10 }], energy);
function saved(value = cost()) {
  return { version: 7, revision: 0, controls: { association: 'b'.repeat(64), priority: 'balanced', revision: 0 },
    chargers: { charger1: { association, controls: { enabled: false, revision: 0 },
      request: costScope().request, sessionCost: value } }, vehicleFeeds: {}, consumedTeslaPower: null, consumedTeslaCurrent: null };
}
const readCost = store => readChargingRuntime(store, key).chargers.charger1.sessionCost;
function storeFixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const setter = store.setState.bind(store), calls = [];
  store.setState = (name, value) => { if (name === costKey) calls.push(structuredClone(value)); return setter(name, value); };
  return { store, calls };
}

test('real cost recomputation keeps its live date without another unchanged durable fragment', t => {
  const { store, calls } = storeFixture(t), original = saved();
  writeChargingRuntime(store, key, original);
  const sequence = store.checkpoint().sequence;
  let live = original.chargers.charger1.sessionCost;
  for (let tick = 1; tick <= 5; tick++) {
    live = updateSessionCost(live, charger(), at + tick * 1000, [], energy);
    const next = { ...original, chargers: { charger1: { ...original.chargers.charger1, sessionCost: live } } };
    writeChargingRuntime(store, key, next);
    assert.equal(live.updatedAt, at + tick * 1000);
    assert.equal(readCost(store).updatedAt, at);
    assert.deepEqual({ ...live, updatedAt: at }, original.chargers.charger1.sessionCost);
  }
  assert.equal(calls.length, 1); assert.equal(store.checkpoint().sequence, sequence);
});

for (const [name, change] of [
  ['amount', next => { next.chargers.charger1.sessionCost.totalCents = 0; }],
  ['energy', next => { next.chargers.charger1.sessionCost.recordedGridKwh = 1; }],
  ['quality', next => { next.chargers.charger1.sessionCost.estimated = !next.chargers.charger1.sessionCost.estimated; }],
  ['prices', next => { next.chargers.charger1.sessionCost.prices[0].priceCtPerKwh++; }],
  ['original provenance', next => { next.chargers.charger1.sessionCost.provenance = { receivedAt: at, source: 'synthetic-observation' }; }],
  ['unknown field', next => { next.chargers.charger1.sessionCost.newEvidence = false; }],
  ['request revision', next => { next.chargers.charger1.request.revision++; }],
  ['physical connection', next => { const scope = `${association}:${at + 1000}`;
    Object.assign(next.chargers.charger1.request, { scope, sessionId: scope }); }],
  ['equipment', next => { const id = 'c'.repeat(64), scope = `${id}:${at}`;
    next.chargers.charger1.association = id; Object.assign(next.chargers.charger1.request, { scope, sessionId: scope }); }],
  ['backward date', next => { next.chargers.charger1.sessionCost.updatedAt = at - 1000; }],
  ['missing date', next => { delete next.chargers.charger1.sessionCost.updatedAt; }],
  ['missing request', next => { next.chargers.charger1.request = null; }],
]) test(`cost ${name} retains the normal complete write`, t => {
  const { store, calls } = storeFixture(t), original = saved(); writeChargingRuntime(store, key, original);
  const next = structuredClone(original); next.chargers.charger1.sessionCost.updatedAt += 1000; change(next);
  writeChargingRuntime(store, key, next);
  assert.equal(calls.length, 2);
  assert.deepEqual(readCost(store), next.chargers.charger1.sessionCost);
});

test('cost A to B to A within one outer transaction commits the last payload, then skips only its later date', t => {
  const { store, calls } = storeFixture(t), a = saved(); writeChargingRuntime(store, key, a);
  const b = structuredClone(a); b.chargers.charger1.sessionCost.totalCents = 17;
  const final = structuredClone(a); final.chargers.charger1.sessionCost.updatedAt += 1000;
  store.transaction(() => { writeChargingRuntime(store, key, b); writeChargingRuntime(store, key, final); });
  assert.equal(calls.length, 3); assert.deepEqual(readCost(store), final.chargers.charger1.sessionCost);
  final.chargers.charger1.sessionCost.updatedAt += 1000; writeChargingRuntime(store, key, final);
  assert.equal(calls.length, 3); assert.equal(readCost(store).updatedAt, at + 1000);
});

test('nested rollback clears its own marker and preserves another pending write until outer commit', t => {
  const { store, calls } = storeFixture(t), a = saved(); writeChargingRuntime(store, key, a);
  const b = structuredClone(a), c = structuredClone(a), final = structuredClone(a);
  b.chargers.charger1.sessionCost.totalCents = 17; c.chargers.charger1.sessionCost.totalCents = 23;
  final.chargers.charger1.sessionCost.updatedAt += 1000;
  store.transaction(() => {
    writeChargingRuntime(store, key, b);
    assert.throws(() => store.transaction(() => { writeChargingRuntime(store, key, c); throw Error('nested-rejection'); }), /nested-rejection/);
    writeChargingRuntime(store, key, final);
  });
  assert.equal(calls.length, 4); assert.deepEqual(readCost(store), final.chargers.charger1.sessionCost);
  assert.throws(() => store.transaction(() => { writeChargingRuntime(store, key, b); throw Error('outer-rejection'); }), /outer-rejection/);
  final.chargers.charger1.sessionCost.updatedAt += 1000; writeChargingRuntime(store, key, final);
  assert.equal(calls.length, 5); assert.equal(readCost(store).updatedAt, at + 1000);
});

test('cost retirement then same-scope return cannot skip a missing row; rolled-back retirement retains the admitted basis', t => {
  const { store, calls } = storeFixture(t), a = saved(); writeChargingRuntime(store, key, a);
  const absent = structuredClone(a); delete absent.chargers.charger1.sessionCost;
  const later = structuredClone(a); later.chargers.charger1.sessionCost.updatedAt += 1000;
  store.transaction(() => { writeChargingRuntime(store, key, absent); writeChargingRuntime(store, key, later); });
  assert.equal(calls.length, 2); assert.deepEqual(readCost(store), later.chargers.charger1.sessionCost);
  assert.throws(() => store.transaction(() => { writeChargingRuntime(store, key, absent); throw Error('retirement-rejected'); }), /retirement-rejected/);
  later.chargers.charger1.sessionCost.updatedAt += 1000; writeChargingRuntime(store, key, later);
  assert.equal(calls.length, 2); assert.equal(readCost(store).updatedAt, at + 1000);
});

test('failed first setter/clone and rollback cannot seed a calculation baseline', t => {
  const { store, calls } = storeFixture(t), writer = createChargingCalculationWriter(store, 'session-cost'), scope = costScope();
  const value = { value: cost() }, set = store.setState;
  store.setState = () => { throw Error('setter-rejected'); };
  assert.throws(() => store.transaction(() => writer.write(costKey, value, scope)), /setter-rejected/);
  store.setState = set;
  assert.throws(() => store.transaction(() => writer.write(costKey, { value: { ...cost(), unsupported: () => {} } }, scope)), /clone|cloned/i);
  assert.throws(() => store.transaction(() => { writer.write(costKey, value, scope); throw Error('save-rejected'); }), /save-rejected/);
  value.value.updatedAt += 1000;
  store.transaction(() => { assert.equal(writer.write(costKey, value, scope), true); });
  assert.equal(calls.length, 2); assert.deepEqual(store.getState(costKey), value);
  store.transaction(() => { assert.equal(writer.write(costKey, value, scope), false); });
});

test('committed cache publication survives a failed follow-up callback without retrying the durable body', t => {
  const { store, calls } = storeFixture(t), writer = createChargingCalculationWriter(store, 'session-cost'), value = { value: cost() };
  assert.throws(() => store.transaction(() => {
    writer.write(costKey, value, costScope()); store.afterCommit(() => { throw Error('consumer-failed'); });
  }), error => error.committed === true);
  value.value.updatedAt += 1000; store.transaction(() => { assert.equal(writer.write(costKey, value, costScope()), false); });
  assert.equal(calls.length, 1); assert.equal(store.getState(costKey).value.updatedAt, at);
});

test('a reentrant afterCommit write or return after retirement remains newer than the outer cache callback', t => {
  const { store } = storeFixture(t), writer = createChargingCalculationWriter(store, 'session-cost'), scope = costScope();
  const a = { value: cost() }, b = structuredClone(a), c = structuredClone(a);
  b.value.totalCents = 17; c.value.totalCents = 23;
  store.transaction(() => writer.write(costKey, a, scope));
  store.transaction(() => {
    store.afterCommit(() => store.transaction(() => writer.write(costKey, c, scope)));
    writer.write(costKey, b, scope);
  });
  assert.deepEqual(store.getState(costKey), c);
  b.value.updatedAt += 1000;
  assert.equal(writer.unchanged(costKey, b, scope), false);
  store.transaction(() => { assert.equal(writer.write(costKey, b, scope), true); });
  assert.deepEqual(store.getState(costKey), b);
  store.transaction(() => {
    store.afterCommit(() => store.transaction(() => writer.write(costKey, c, scope)));
    store.db.prepare('DELETE FROM state WHERE key=?').run(costKey); writer.forget(costKey);
  });
  assert.deepEqual(store.getState(costKey), c);
  c.value.updatedAt += 1000;
  assert.equal(writer.unchanged(costKey, c, scope), true);
  store.transaction(() => {
    store.afterCommit(() => store.transaction(() => {
      store.db.prepare('DELETE FROM state WHERE key=?').run(costKey); writer.forget(costKey);
    }));
    writer.write(costKey, b, scope);
  });
  assert.equal(store.getState(costKey), null);
  assert.equal(writer.unchanged(costKey, b, scope), false, 'an older callback cannot revive a retired baseline');
});

test('same-version disk reopen performs a first write and retains the current cost representation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'charging-calculation-')), path = join(directory, 'recording.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initial = saved(), first = new Store(path); writeChargingRuntime(first, key, initial); first.close();
  const reopened = new Store(path); t.after(() => reopened.close());
  const next = structuredClone(initial); next.chargers.charger1.sessionCost.updatedAt += 1000;
  writeChargingRuntime(reopened, key, next); assert.equal(readCost(reopened).updatedAt, at + 1000);
  assert.equal(readChargingRuntime(reopened, key).version, 7);
});

test('actual Shelly controller keeps fresh RAM/observer clocks while skipping only the identical admitted ownership date', async t => {
  const f = await jointFixture(t); await f.connect('charger2'); f.household.sourceAt = f.now; await f.settle();
  const item = f.runtime.chargers.charger2, adapter = item.adapter, original = adapter.createController;
  const incoming = [], callbacks = []; let notifications = 0, admissions = 0, allControlAdmissions = 0, setterCalls = 0, savingOwnership = false;
  adapter.createController = options => {
    callbacks.push(options.saveState);
    return original({ ...options, saveState: state => {
      incoming.push(structuredClone(state)); savingOwnership = true;
      try { return options.saveState(state); } finally { savingOwnership = false; }
    },
      onStatusChange: () => { notifications++; return options.onStatusChange(); } });
  };
  await f.runtime.setAdapter('charger2', adapter); await f.runtime.reconcile('charger2');
  const ownershipKey = f.runtime.ownershipKey('charger2'), before = f.store.getState(ownershipKey);
  const set = f.store.setState.bind(f.store), run = f.store.runWrite.bind(f.store);
  f.store.setState = (name, value) => { if (name === ownershipKey) setterCalls++; return set(name, value); };
  f.store.runWrite = (action, options) => {
    if (options?.priority === 'control') { allControlAdmissions++; if (savingOwnership) admissions++; }
    return run(action, options);
  };
  incoming.length = 0; const observedBefore = notifications;
  f.advance(1000); await f.runtime.reconcile('charger2');
  assert(incoming.some(state => state.limiter.evaluatedAt === f.now));
  for (const state of incoming) {
    const a = structuredClone(before), b = structuredClone(state); delete a.limiter.evaluatedAt; delete b.limiter.evaluatedAt;
    assert(isDeepStrictEqual(a, b));
  }
  assert.equal(setterCalls, 0); assert.equal(admissions, 0);
  assert.equal(item.controller.status().limiter.evaluatedAt, f.now);
  assert.equal(f.store.getState(ownershipKey).limiter.evaluatedAt, before.limiter.evaluatedAt);
  assert(notifications > observedBefore, 'recording observers still receive the live controller result');
  const saver = callbacks.at(-1), pending = { ...structuredClone(before), limiter: { ...before.limiter, evaluatedAt: f.now } };
  let descendant;
  assert.throws(() => f.store.transaction(() => { descendant = saver(pending); throw Error('parent-rollback'); }), /parent-rollback/);
  await assert.rejects(descendant, error => error.code === 'STORAGE_WRITE_ROLLED_BACK');
  assert.equal(setterCalls, 0);
  f.store.readOnly = true;
  try { await assert.rejects(async () => saver(pending), error => error.errcode === 8); }
  finally { f.store.readOnly = false; }
  assert.equal(setterCalls, 0, 'the clock-only cache cannot acknowledge a read-only save');
  for (const invalid of [null, undefined, { ...pending, version: 999 }])
    assert.throws(() => saver(invalid), /unsupported-shelly-ownership/);
  assert.equal(setterCalls, 0); assert.deepEqual(f.store.getState(ownershipKey), before);
  let entered, release;
  const holding = new Promise(resolve => { entered = resolve; }), released = new Promise(resolve => { release = resolve; });
  const publication = f.store.runPublication(async () => { entered(); await released; });
  await holding;
  const queuedDifferent = structuredClone(pending); queuedDifferent.manualCurrentA = 9;
  const queuedFirst = saver(queuedDifferent); let lastSettled = false;
  const queuedLast = saver(pending).then(() => { lastSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  const settledBeforeAdmission = lastSettled;
  release(); await Promise.all([publication, queuedFirst, queuedLast]);
  assert.equal(settledBeforeAdmission, false, 'a queued earlier save fences the pre-admission shortcut');
  assert.deepEqual(f.store.getState(ownershipKey), pending, 'the final queued callback restores the requested complete state');
  for (const change of [state => { state.lastCurrentInstructionAt++; }, state => { state.permissionEventCursor = (state.permissionEventCursor ?? 0) + 1; },
    state => { state.limiter.sourceEpochs[0] = 'synthetic-new-source'; }, state => { state.newEvidence = { sourceAt: f.now }; },
    state => { state.manualCurrentA = 0; }, state => { state.limiter.currentA = 0; },
    state => { state.limiter.scope.connectedAt += 1000; }, state => { state.limiter.evaluatedAt = before.limiter.evaluatedAt - 1; },
    state => { state.permissionCommand = { value: false, dispatchedAt: f.now - 1000, acceptedAt: f.now, sessionId: state.sessionId }; },
    state => { state.pending = { role: 'start_charging', value: false, stage: 'proposed', association: state.association,
      sessionId: state.sessionId, requestedAt: f.now }; },
    state => { state.currentTest = { id: 'synthetic-restoration', connectedAt: state.limiter.scope.connectedAt,
      sessionId: state.sessionId, phase: 'restoring', startedAt: f.now, expiresAt: f.now + 90_000, confirmedAt: f.now,
      originalCurrentA: 16, appliedCurrentA: 6, permissionAt: f.now, restoreCurrentA: 16, pending: null }; }]) {
    await saver(pending);
    const callsBefore = setterCalls;
    const next = structuredClone(before); next.limiter.evaluatedAt = f.now; change(next);
    await saver(next); assert.deepEqual(f.store.getState(ownershipKey), next);
    assert.equal(setterCalls, callsBefore + 1);
  }
  await saver(pending);
  const priorReplacementCalls = setterCalls;
  const oldSaver = saver;
  await f.runtime.setAdapter('charger2', adapter); await f.runtime.reconcile('charger2');
  assert(setterCalls > priorReplacementCalls, 'a replacement controller performs its first durable admission');
  const admissionsBeforeOld = allControlAdmissions;
  await oldSaver(pending);
  assert.equal(allControlAdmissions, admissionsBeforeOld + 1, 'an old same-adapter callback cannot take the new fast path');
  const currentSaver = callbacks.at(-1), newer = structuredClone(pending);
  newer.manualCurrentA = 9;
  await currentSaver(newer);
  await oldSaver(pending);
  assert.deepEqual(f.store.getState(ownershipKey), pending, 'the admitted old callback compares against the actual last committed state');
  newer.limiter.evaluatedAt += 1000;
  await currentSaver(newer);
  assert.deepEqual(f.store.getState(ownershipKey), newer, 'a newer controller cannot skip against a baseline replaced by another admitted callback');
  await currentSaver(pending);
  await oldSaver(newer);
  pending.limiter.evaluatedAt += 2000;
  await currentSaver(pending);
  assert.deepEqual(f.store.getState(ownershipKey), pending, 'the opposite callback order also uses the actual committed basis');
});
