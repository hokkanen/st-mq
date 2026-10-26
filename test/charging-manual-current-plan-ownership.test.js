import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { readChargingRuntime } from '../src/charging/runtime-storage.js';
import { fixture } from './helpers/charging-joint-fixture.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function stage(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Synthetic setup did not reach ${label}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function settleReceivedWork(f) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    // Household completion can start another plan and native reconciliation
    // after a writer barrier. Finish that received work before selecting the
    // displayed takeover token whose publication this fixture holds below.
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

async function ready(t) {
  // The acquisition clock and every native reply in this fixture are already
  // controlled explicitly. Keep the adapter's autonomous five-second poll from
  // injecting unrelated received input between the displayed token and the
  // deliberately held publication. The newer-input case below supplies that
  // competing read explicitly, with its own exact admission boundary.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const directory = mkdtempSync(join(tmpdir(), 'stmq-manual-current-plan-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  const f = await fixture(t, { store, budgetA: 25 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await f.connect('charger2'); await f.plan();
  f.advance(1000);
  // A real native source change in this already established connection, not a
  // setting carried into a new plug or a direct edit of controller RAM.
  f.fields.current_limit = { value: 9, at: f.now, source: 'rpc' };
  await f.settle(); await store.runWrite(() => {}); await store.startWriter();
  await settleReceivedWork(f);
  const before = f.view('charger2'), item = f.runtime.chargers.charger2;
  assert.equal(before.control.manualCurrentA, 9);
  assert.equal(before.control.takeover.available, true);
  assert.equal(item.adapter.snapshot().controlReady, true);
  assert.equal(item.adapter.snapshot().currentControlReady, true);
  assert.equal(store.canDispatch(), true);
  const input = { ...f.scope('charger2'), controlRevision: before.controls.revision,
    takeoverToken: before.control.takeover.token };
  return Object.assign(f, { store, item, before, input });
}

function holdInitialPublication(f) {
  const { runtime, store, item } = f;
  const fence = runtime.fenceChangedCommands;
  const request = store.writer.request;
  const entered = deferred(), resumed = deferred();
  let publication = false, intercepted = false, heldAttempt;
  runtime.fenceChangedCommands = function (...args) {
    const result = Reflect.apply(fence, this, args);
    if (store.writerBodyActive && item.takeoverAttempt?.token === f.input.takeoverToken
      && item.request.revision === f.before.request.revision + 1) publication = true;
    return result;
  };
  store.writer.request = function (command, args) {
    if (command === 'commit' && publication && !intercepted) {
      intercepted = true; heldAttempt = item.takeoverAttempt;
      entered.resolve();
      return resumed.promise.then(() => {
        return Reflect.apply(request, this, [command, args]);
      });
    }
    return Reflect.apply(request, this, [command, args]);
  };
  return { entered: entered.promise,
    get attempt() { return heldAttempt; },
    release() { resumed.resolve(); },
    restore() {
      runtime.fenceChangedCommands = fence;
      store.writer.request = request;
    } };
}

async function atPublication(f, duringHold = () => {}) {
  const gate = holdInitialPublication(f), commands = f.commands.length, receivedReads = [];
  const outcome = f.runtime.useAutomatic('charger2', f.input)
    .then(() => ({ error: null, completionView: structuredClone(f.view('charger2')) }), error => ({ error }));
  const ended = outcome.then(result => {
    throw result.error ?? new Error('Action completed before its selected publication');
  });
  let settlements, setupError, setupFailed = false;
  try {
    await stage(Promise.race([gate.entered, ended]), 'initial accepted-plan COMMIT');
    assert.equal(gate.attempt, f.item.takeoverAttempt);
    assert.equal(gate.attempt.token, f.input.takeoverToken);
    assert.equal(gate.attempt.revision, f.before.request.revision + 1);
    await stage(new Promise(resolve => setImmediate(resolve)), 'normal event-loop turn during held plan COMMIT');
    assert.equal(f.store.canDispatch(), false);
    assert.equal(f.commands.length, commands, 'Uncommitted publication grants no native mutation');
    await duringHold(receivedReads);
  } catch (error) { setupFailed = true; setupError = error; }
  finally {
    gate.release();
    try { settlements = await Promise.allSettled([outcome, ...receivedReads]); }
    finally { gate.restore(); }
  }
  if (setupFailed) throw setupError;
  if (settlements[0].status === 'rejected') throw settlements[0].reason;
  const result = settlements[0].value;
  const nativeReads = settlements.slice(1).map(settled => {
    if (settled.status === 'rejected') throw settled.reason;
    return settled.value;
  });
  await f.settle(); await f.store.whenWritesSettled();
  return { ...result, nativeReads, commands: f.commands.slice(commands) };
}

test('the explicit manual-current takeover owns its initial committed plan', async t => {
  const f = await ready(t);
  t.mock.timers.tick(5000);
  await settleReceivedWork(f);
  const result = await atPublication(f);
  if (result.error) throw result.error;
  const current = f.view('charger2'), saved = readChargingRuntime(f.store, f.runtime.key).chargers.charger2;
  assert.equal(result.completionView.control.takeover.state, 'confirmed');
  assert.equal(result.completionView.control.takeover.attemptToken, f.input.takeoverToken);
  assert.equal(current.control.manualCurrentA, null, 'Use automatic supersedes the displayed adjustable9A choice');
  assert.equal(current.control.scheduleConfirmed, true);
  assert.equal(f.fields.start_charging.value, false, 'The accepted future cheap period remains stopped now');
  assert.ok(result.commands.some(command => command.method === 'Boolean.Set' && command.value === false));
  assert.ok(result.commands.some(command => command.method === 'Number.Set' && command.role === 'current_limit'),
    'The real native setting path follows the confirmed economic wait');
  assert.ok(result.commands.every(command => command.method !== 'Number.Set'
    || command.value >= 6 && command.value <= 16), 'Native/electrical setting limits still apply');
  assert.equal(current.request.revision, f.before.request.revision + 1);
  assert.deepEqual(saved.request, current.request);
  assert.deepEqual(saved.controls, current.controls);
  assert.equal(f.store.getState(f.runtime.ownershipKey('charger2')).manualCurrentA, null);
  assert.equal(f.item.takeoverAttempt, undefined);
});

test('a newer native current instruction wins over an older displayed takeover', async t => {
  const f = await ready(t);
  let changedAt;
  const result = await atPublication(f, async receivedReads => {
    f.advance(1000); changedAt = f.now;
    assert.ok(changedAt > f.before.control.snapshot.fields.current_limit.measuredAt,
      'The newer native setting must have a strictly later source clock');
    f.fields.current_limit = { value: 7, at: changedAt, source: 'rpc' };
    const commands = f.commands.length;
    const read = f.item.adapter.rpc('Number.GetStatus', {
      owner: `service:${f.item.adapter.config.serviceId}`, role: 'current_limit',
    }, { statusReadback: true }).then(value => ({ value }), error => ({ error }));
    receivedReads.push(read);
    await stage(new Promise(resolve => setImmediate(resolve)), 'received native current reply during held plan COMMIT');
    assert.equal(f.item.adapter.snapshot().commandBlockReason, 'evse-input-persistence-pending');
    assert.equal(f.store.canDispatch(), false);
    assert.equal(f.commands.length, commands, 'Received current input cannot grant a mutation before its COMMIT');
  });
  assert.ok(result.error, 'The original displayed token must not acquire a newer native instruction');
  assert.equal(result.nativeReads.length, 1);
  assert.equal(result.nativeReads[0].error, undefined, 'The actual current read must commit before precedence is assessed');
  const rawCurrent = result.nativeReads[0].value;
  assert.equal(rawCurrent.value, 7);
  assert.equal(rawCurrent.last_update_ts, changedAt / 1000);
  assert.equal(rawCurrent.source, 'rpc');
  const current = f.view('charger2');
  assert.notEqual(current.control.takeover.state, 'confirmed');
  const admittedCurrent = current.control.snapshot.fields.current_limit;
  assert.equal(admittedCurrent.value, 7, 'The newer native reading must reach the actual adapter before its precedence is assessed');
  assert.equal(current.control.snapshot.fields.current_limit.measuredAt, changedAt);
  assert.equal(admittedCurrent.commandSource, 'rpc');
  assert.equal(admittedCurrent.retained, false);
  assert.equal(current.control.manualCurrentA, 7);
  assert.equal(f.store.getState(f.runtime.ownershipKey('charger2')).manualCurrentA, 7);
  assert.equal(f.fields.current_limit.value, 7, 'A stale takeover cannot replace the newer setting');
  assert.ok(result.commands.every(command => command.method !== 'Boolean.Set' || command.value !== true));
  assert.ok(result.commands.every(command => command.method !== 'Number.Set' || command.value <= 7));
  assert.equal(current.request.sessionId, f.before.request.sessionId);
  assert.equal(f.item.takeoverAttempt, undefined);
});

test('a known failed intent commit preserves the scoped current choice without a stranded takeover', async t => {
  const f = await ready(t), request = f.store.writer.request;
  const saved = readChargingRuntime(f.store, f.runtime.key).chargers.charger2;
  const commands = f.commands.length, ownershipKey = f.runtime.ownershipKey('charger2');
  const ownership = structuredClone(f.store.getState(ownershipKey));
  let rejectedAttempt;
  f.store.writer.request = function (command, args) {
    if (command === 'commit' && !rejectedAttempt && f.item.takeoverAttempt?.token === f.input.takeoverToken
      && f.item.request.revision === f.before.request.revision + 1) {
      rejectedAttempt = f.item.takeoverAttempt;
      return Promise.reject(Object.assign(new Error('Synthetic manual-current intent rollback'),
        { code: 'ERR_SQLITE_ERROR', errcode: 10 }));
    }
    return Reflect.apply(request, this, [command, args]);
  };
  try {
    await assert.rejects(f.runtime.useAutomatic('charger2', f.input), /Synthetic manual-current intent rollback/);
  } finally { f.store.writer.request = request; }
  assert.ok(rejectedAttempt);
  assert.equal(rejectedAttempt.controller, f.item.controller);
  assert.equal(rejectedAttempt.association, f.before.association);
  assert.equal(rejectedAttempt.sessionId, f.before.request.sessionId);
  assert.deepEqual(readChargingRuntime(f.store, f.runtime.key).chargers.charger2, saved);
  assert.equal(f.item.request.revision, f.before.request.revision);
  assert.deepEqual(f.item.controls, f.before.controls);
  assert.equal(f.view('charger2').control.manualCurrentA, 9);
  assert.deepEqual(f.store.getState(ownershipKey), ownership);
  assert.equal(f.item.takeoverAttempt, undefined);
  assert.equal(f.commands.length, commands, 'No native command is authorized by a rolled-back intent');
  assert.equal(Boolean(f.store.writer.failed), false);
  assert.equal(Boolean(f.store.writerFailed), false);
});
