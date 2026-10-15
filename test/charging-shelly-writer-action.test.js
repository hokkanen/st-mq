import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { readChargingRuntime } from '../src/charging/runtime-storage.js';
import { fixture } from './helpers/charging-joint-fixture.js';

async function readyFixture(t, action) {
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
test(`Shelly ${action} cannot dispatch before its ${failed ? 'failed' : 'held'} intent commit`, async t => {
  const f = await readyFixture(t, action), request = f.store.writer.request.bind(f.store.writer);
  let enter, release, intercepted = false;
  const entered = new Promise(resolve => { enter = resolve; }), resumed = new Promise(resolve => { release = resolve; });
  t.after(release);
  f.store.writer.request = async (command, args) => {
    if (command === 'commit' && !intercepted) {
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
