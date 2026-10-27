import test from 'node:test';
import { testCompletionLimit } from '../scripts/lib/offline-test-profile.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { readChargingRuntime } from '../src/charging/runtime-storage.js';
import { fixture } from './helpers/charging-joint-fixture.js';

async function settleReceivedWork(f) {
  const deadline = performance.now() + testCompletionLimit(10_000);
  while (performance.now() < deadline) {
    // Returning household history schedules another planning/reconciliation
    // turn. Join that publication too before capturing a displayed token.
    await f.settle();
    await f.runtime.stateRefreshFlight;
    await f.store.runWrite(() => {});
    await new Promise(resolve => setImmediate(resolve));
    const items = Object.values(f.runtime.chargers);
    if (f.runtime.historyReady && f.runtime.historyFlights.size === 0
      && !f.runtime.planningFlight && !f.runtime.stateRefreshFlight
      && items.every(item => !item.reconcileFlight && !item.reconcileQueued && !item.reconcileAgain)
      && f.store.canDispatch()) {
      assert.equal(await f.runtime.chargers.charger2.adapter.waitForInputAdmission(), true);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('The fixture did not finish its received household history and native-input work');
}

function selectedIntent(f, action) {
  const item = f.runtime.chargers.charger2, attempt = item.takeoverAttempt;
  return attempt?.token === f.input.takeoverToken && attempt.mode === action
    && attempt.controller === item.controller && attempt.association === f.input.association
    && attempt.sessionId === f.input.sessionId && attempt.revision === f.before.request.revision + 1
    && item.request.revision === attempt.revision;
}

async function readyFixture(t, action) {
  // Own the periodic reader while deliberately holding an intent COMMIT.
  // A received poll has its own admission fence, exercised explicitly below.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const directory = mkdtempSync(join(tmpdir(), 'stmq-shelly-writer-action-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  const f = await fixture(t, { store, budgetA: 25 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await f.connect('charger2'); await f.plan();
  f.advance(1000);
  f.fields.start_charging = { value: false, at: f.now, source: 'rpc' };
  await f.settle();
  // Same-session restart retains an expired dispatched Stop without inventing
  // its missing acknowledgement, even when fresh native readback is stopped.
  f.advance(30_000);
  const ownershipKey = f.runtime.ownershipKey('charger2'), ownership = store.getState(ownershipKey);
  const pending = { association: ownership.association, sessionId: ownership.sessionId, revision: 1,
    expiresAt: f.now - 10_000, role: 'start_charging', value: false, reason: 'economic-wait',
    stage: 'dispatched', dispatchedAt: f.now - 20_000 };
  store.setState(ownershipKey, { ...ownership, phase: 'uncertain', pending });
  await f.runtime.setAdapter('charger2', f.runtime.chargers.charger2.adapter);
  await f.settle();
  assert.deepEqual(f.view('charger2').control.pending, pending);
  assert.equal(f.view('charger2').control.manual.kind, 'stop');
  assert.equal(f.view('charger2').control.manualCurrentA, null);
  await store.runWrite(() => {}); await store.startWriter();
  // Initial cache preparation is independent of the explicit action under test.
  // Its completion must not change the selected instruction during that action.
  await settleReceivedWork(f);
  t.mock.timers.tick(5000);
  await settleReceivedWork(f);
  const view = f.view('charger2'), adapter = f.runtime.chargers.charger2.adapter;
  assert.equal(view.control.takeover.available, true);
  assert.equal(adapter.snapshot().controlReady, true);
  assert.equal(adapter.snapshot().currentControlReady, true);
  assert.equal(store.canDispatch(), true);
  const input = { ...f.scope('charger2'), controlRevision: view.controls.revision,
    takeoverToken: view.control.takeover.token };
  const invoke = () => action === 'automatic'
    ? f.runtime.useAutomatic('charger2', input) : f.runtime.chargeNow('charger2', input);
  return { ...f, store, adapter, invoke, before: view, input, originalPending: structuredClone(pending) };
}

for (const action of ['automatic', 'charge-now']) test(`real writer admits Shelly ${action} and confirms its native result`, async t => {
  const f = await readyFixture(t, action), checked = f.runtime.checkedSession.bind(f.runtime), checks = [];
  t.mock.method(f.runtime, 'checkedSession', (...args) => {
    const result = checked(...args);
    checks.push({ pending: f.store.writePending, dispatch: f.store.canDispatch(),
      takeover: result.view.control.takeover.available });
    return result;
  });
  const before = f.commands.length;
  await f.invoke();
  const view = f.view('charger2'), saved = readChargingRuntime(f.store, f.runtime.key).chargers.charger2;
  assert.ok(checks.some(row => row.pending && !row.dispatch && row.takeover),
    'The same admitted action validates inside its real writer turn without gaining dispatch permission');
  assert.equal(view.control.takeover.state, 'confirmed');
  assert.equal(f.originalPending.stage, 'dispatched');
  assert.equal(Object.hasOwn(f.originalPending, 'acceptedAt'), false,
    'A new explicit instruction does not manufacture acknowledgement for the historical Stop');
  assert.equal(view.request.revision, f.before.request.revision + 1);
  assert.equal(saved.request.revision, view.request.revision);
  if (action === 'automatic') {
    assert.equal(view.settings.enabled, true);
    assert.equal(view.control.manualCurrentA, null);
    assert.equal(f.fields.start_charging.value, false, 'Automatic adopts the selected economic wait');
    assert.equal(view.control.scheduleConfirmed, true);
    assert.ok(view.control.execution.periods.length > 0);
    f.advance(view.plan.periods[0].startAt - f.runtime.clock());
    await f.settle();
    assert.ok(f.commands.slice(before).some(row => row.chargerId === 'charger2' && row.method === 'Boolean.Set' && row.value === true),
      'The committed automatic plan reaches the native adapter when its actual synthetic start becomes due');
  } else {
    assert.equal(view.request.chargeNow, true);
    assert.equal(view.settings.enabled, false, 'Charge now preserves the Automatic preference');
    assert.equal(f.fields.start_charging.value, true);
    assert.equal(saved.request.chargeNow, true);
    assert.ok(f.commands.slice(before).some(row => row.chargerId === 'charger2' && row.method === 'Boolean.Set' && row.value === true));
  }
});

for (const action of ['automatic', 'charge-now']) for (const failed of [false, true])
for (const receivedPoll of (failed ? [false, true] : [false]))
test(`Shelly ${action} cannot dispatch before its ${failed ? 'failed' : 'held'} intent commit${receivedPoll ? ' with a received native poll' : ''}`, async t => {
  const f = await readyFixture(t, action), request = f.store.writer.request.bind(f.store.writer);
  let enter, release, intercepted = false;
  const entered = new Promise(resolve => { enter = resolve; }), resumed = new Promise(resolve => { release = resolve; });
  t.after(release);
  f.store.writer.request = async (command, args) => {
    if (command === 'commit' && !intercepted && selectedIntent(f, action)) {
      intercepted = true; enter(); await resumed;
      if (failed) throw Object.assign(new Error('Synthetic intent COMMIT failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    }
    return request(command, args);
  };
  const before = f.commands.length, savedBefore = readChargingRuntime(f.store, f.runtime.key).chargers.charger2;
  const actionPromise = f.invoke();
  const outcome = actionPromise.then(() => null, error => error);
  try {
  await Promise.race([entered, outcome.then(error => {
    throw error ?? new Error('The action completed before its intent COMMIT was held');
  })]);
  assert.equal(f.runtime.chargers.charger2.request.revision, f.before.request.revision + 1,
    'The held COMMIT belongs to this exact action intent, not unrelated background work');
  assert.equal(f.store.canDispatch(), false);
  assert.equal(f.adapter.snapshot().currentControlReady, true,
    'Admitted native capability remains visible during this intent transaction');
  assert.equal(f.adapter.snapshot().commissioning.currentControlReady, true);
  assert.equal(f.commands.length, before, 'No native command can precede the intent COMMIT');
  let current = true;
  const native = f.adapter.rpc('Boolean.Set', { owner: 'service:0', role: 'start_charging', value: true }, {
    mutation: true, guard: () => current,
  }).then(() => null, error => error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.commands.length, before, 'Even a direct native mutation stays behind the unchanged dispatch fence');
  assert.deepEqual(readChargingRuntime(f.store, f.runtime.key).chargers.charger2, savedBefore,
    'The reader retains the committed intent while the writer turn is held');
  if (receivedPoll) {
    t.mock.timers.tick(5000);
    await new Promise(resolve => setImmediate(resolve));
    const snapshot = f.adapter.snapshot();
    assert.equal(snapshot.commandBlockReason, 'evse-input-persistence-pending');
    assert.equal(snapshot.currentControlReady, false, 'Received input keeps its own native admission fence');
    assert.equal(snapshot.commissioning.currentControlReady, false);
    assert.equal(f.commands.length, before);
  }
  // Cancel the independent direct attempt before releasing the writer. It must
  // not supply a second Start after the actual action takes over.
  current = false;
  release();
  assert.ok(await native);
  const result = await outcome;
  if (failed) {
    assert.match(result?.message ?? '', /Synthetic intent COMMIT failure/);
    assert.deepEqual(readChargingRuntime(f.store, f.runtime.key).chargers.charger2, savedBefore);
    assert.equal(f.commands.length, before, 'A failed commit cannot dispatch the provisional action');
  } else {
    if (result) throw result;
    assert.equal(f.view('charger2').control.takeover.state, 'confirmed');
  }
  } finally { release(); await outcome; }
});

for (const action of ['automatic', 'charge-now'])
test(`Shelly ${action} releases its rolled-back takeover and admits a fresh action`, async t => {
  const f = await readyFixture(t, action), item = f.runtime.chargers.charger2;
  const request = f.store.writer.request.bind(f.store.writer);
  const savedBefore = readChargingRuntime(f.store, f.runtime.key).chargers.charger2;
  const before = f.commands.length;
  let failedAttempt;
  f.store.writer.request = async (command, args) => {
    if (command === 'commit' && !failedAttempt && selectedIntent(f, action)) {
      failedAttempt = item.takeoverAttempt;
      assert.equal(failedAttempt.mode, action);
      assert.equal(failedAttempt.controller, item.controller);
      assert.equal(failedAttempt.token, f.input.takeoverToken);
      assert.equal(item.request.revision, f.before.request.revision + 1);
      throw Object.assign(new Error('Synthetic takeover intent COMMIT rollback'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    }
    return request(command, args);
  };
  await assert.rejects(f.invoke(), /Synthetic takeover intent COMMIT rollback/);
  assert.ok(failedAttempt, 'The rejected COMMIT belongs to this exact takeover intent');
  assert.deepEqual(readChargingRuntime(f.store, f.runtime.key).chargers.charger2, savedBefore);
  assert.deepEqual(item.controls, f.before.controls);
  assert.equal(item.request.revision, f.before.request.revision);
  assert.equal(item.takeoverAttempt, undefined, 'A known rollback releases only its provisional RAM reservation');
  assert.equal(f.commands.length, before, 'The rolled-back intent sent no native mutation');
  assert.equal(Boolean(f.store.writer.failed), false);
  assert.equal(Boolean(f.store.writerFailed), false);

  // A fresh displayed scope is still required. This is a new request after a
  // proven rollback, not replay of a possibly dispatched native operation.
  await settleReceivedWork(f);
  const view = f.view('charger2'), input = { ...f.scope('charger2'), controlRevision: view.controls.revision,
    takeoverToken: view.control.takeover.token };
  if (action === 'automatic') await f.runtime.useAutomatic('charger2', input);
  else await f.runtime.chargeNow('charger2', input);
  assert.equal(f.view('charger2').control.takeover.state, 'confirmed');
  assert.equal(item.takeoverAttempt, undefined);
  assert.equal(readChargingRuntime(f.store, f.runtime.key).chargers.charger2.request.revision, f.before.request.revision + 1);
  if (action === 'automatic') assert.equal(f.view('charger2').control.scheduleConfirmed, true);
  else assert.ok(f.commands.slice(before).some(row => row.chargerId === 'charger2'
    && row.method === 'Boolean.Set' && row.value === true));
});

for (const action of ['automatic', 'charge-now'])
test(`Shelly ${action} rollback preserves a replacement takeover reservation`, async t => {
  const f = await readyFixture(t, action), item = f.runtime.chargers.charger2;
  const request = f.store.writer.request.bind(f.store.writer);
  const savedBefore = readChargingRuntime(f.store, f.runtime.key).chargers.charger2;
  const before = f.commands.length;
  let original, replacement;
  f.store.writer.request = async (command, args) => {
    if (command === 'commit' && !original && selectedIntent(f, action)) {
      original = item.takeoverAttempt;
      assert.equal(original.mode, action);
      assert.equal(original.controller, item.controller);
      // Exercise the exact RAM ownership seam while the writer is settling.
      // Cleanup of the failed turn must not delete this different owner.
      replacement = { ...original, revision: original.revision + 1 };
      item.takeoverAttempt = replacement;
      throw Object.assign(new Error('Synthetic superseded takeover COMMIT rollback'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    }
    return request(command, args);
  };
  await assert.rejects(f.invoke(), /Synthetic superseded takeover COMMIT rollback/);
  assert.ok(original);
  assert.notEqual(original, replacement);
  assert.equal(item.takeoverAttempt, replacement);
  assert.deepEqual(readChargingRuntime(f.store, f.runtime.key).chargers.charger2, savedBefore);
  assert.equal(f.commands.length, before);
});
