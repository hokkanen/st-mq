import test from 'node:test';
import assert from 'node:assert/strict';
import { createShellyController } from '../src/charging/shelly-evse.js';
import { fixture, MINUTE } from './helpers/charging-joint-fixture.js';

test('ordinary load adjustment responds before the minute tick without cloud reads or economic replanning', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger1'); await f.connect('charger2'); await f.priority('charger2'); await f.plan();
  f.cars.charger2.demandA = 16;
  const beforeReads = f.reads.charger1;
  const planning = t.mock.method(f.runtime, 'updatePlan');
  f.household.currentA = 17; f.advance(5000);
  await f.runtime.reconcileShellyObservation();
  assert.equal(f.fields.current_limit.value, 8);
  assert.equal(f.view('charger2').limiter.mode, 'limited');
  assert.equal(f.view('charger2').limiter.allowanceA, 8);
  assert.equal(f.reads.charger1, beforeReads);
  assert.equal(planning.mock.callCount(), 0, 'A live current correction reuses the still-valid same-session plan');
  f.household.currentA = 20; f.advance(5000);
  await f.runtime.reconcileShellyObservation();
  assert.equal(f.fields.start_charging.value, false, 'Sub-minimum headroom pauses instead of writing an invalid current');
  assert.equal(f.view('charger2').limiter.mode, 'paused-by-balancing');
  assert.equal(f.view('charger2').limiter.allowanceA, 0);
  f.household.currentA = 0; f.advance(5000);
  await f.runtime.reconcileShellyObservation();
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.fields.start_charging.value, true, 'Recovered headroom resumes only the controller-owned fuse pause');
  assert.equal(f.view('charger2').limiter.mode, 'unrestricted');
  assert.equal(f.view('charger2').limiter.applicationStatus, 'confirmed');
  assert.ok(f.commands.filter(row => row.role === 'current_limit').every(row => row.value >= 6));
  f.advance(5000); f.fields.start_charging = { value: false, at: f.now, source: 'rpc' };
  const count = f.commands.length;
  await f.runtime.reconcileShellyObservation();
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.view('charger2').control.manual.kind, 'stop');
  assert.equal(f.commands.slice(count).some(row => row.role === 'start_charging' && row.value), false);
  assert.ok(planning.mock.callCount() > 0, 'A newer native instruction invalidates the cached plan basis');
});

test('ordinary current adjustment preserves held source age and falls back when the feed loses synchronization', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger2'); await f.priority('charger2'); await f.plan();
  f.household.sourceAt = f.now - MINUTE;
  f.advance(5000); await f.runtime.reconcileShellyObservation();
  assert.equal(f.fields.current_limit.value, 16, 'Old unchanged values remain usable on synchronized matching feeds');
  assert.equal(f.view('charger2').control.limiter.fallback, false);
  assert.equal(f.runtime.allocationContext().property.times[0], f.household.sourceAt);
  f.household.feedsSynchronized = false;
  f.advance(5000); await f.runtime.reconcileShellyObservation();
  assert.equal(f.fields.current_limit.value, 12);
  assert.equal(f.view('charger2').control.limiter.fallback, true);
  assert.equal(f.view('charger2').limiter.mode, 'fallback');
  assert.equal(f.view('charger2').limiter.reason, 'feed-unsynchronized');
  assert.equal(f.runtime.allocationContext().property.times[0], f.household.sourceAt);
});

test('limiter history reads the published snapshot without entering identification, planning or view updates', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger2'); await f.priority('charger2'); await f.plan();
  const expected = f.view('charger2').limiter, item = f.runtime.chargers.charger2;
  const state = () => structuredClone({ identification: item.identification, request: item.request,
    plan: item.plan, revision: f.runtime.revision });
  const before = state(), commands = f.commands.length;
  const observers = ['views', 'telemetry', 'status', 'updatePlan', 'identificationControl'].map(name =>
    t.mock.method(f.runtime, name, () => { throw new Error(`History must not enter ${name}`); }));
  try {
    f.runtime.recordLimiterHistory();
    f.runtime.chargers.charger2.adapter.accept('current_limit', {
      value: f.fields.current_limit.value, last_update_ts: f.fields.current_limit.at / 1000 });
    assert.equal(f.runtime.limiterHistoryError, null);
    assert(observers.every(observer => observer.mock.callCount() === 0));
    assert.deepEqual(state(), before, 'Recording cannot advance a session, identification attempt or plan');
    assert.equal(f.commands.length, commands);
    const row = f.store.db.prepare("SELECT raw FROM observations WHERE signal='charger2_current_allowance' ORDER BY id DESC LIMIT 1").get();
    assert.deepEqual(JSON.parse(row.raw).allowance.limiter, expected, 'The card and recorder share one snapshot projection');
  } finally { for (const observer of observers) observer.mock.restore(); }
});

test('limiter observation rejects another connection, replica authority and replaced callbacks without blocking native reads', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger2'); await f.priority('charger2'); await f.plan();
  const item = f.runtime.chargers.charger2, control = item.controller.status();
  assert.equal(f.runtime.limiterStatus(control, f.now).mode, 'unrestricted');
  for (const snapshot of [
    { ...control.snapshot, generation: control.snapshot.generation + 1 },
    { ...control.snapshot, session: { ...control.snapshot.session, sessionId: 'synthetic-reconnected', connectedAt: f.now + 1 } },
  ]) assert.equal(f.runtime.limiterStatus({ ...control, snapshot }, f.now).mode, 'unknown',
    'A prior decision cannot cross a native generation or physical connection boundary');
  const rows = () => f.store.db.prepare("SELECT id,raw FROM observations WHERE signal='charger2_current_allowance' ORDER BY id").all();
  const initial = rows(), generation = item.adapterGeneration, authority = f.runtime.canControl;
  const accept = value => {
    f.advance(1000); f.fields.current_limit = { value, at: f.now };
    assert.equal(item.adapter.accept('current_limit', { value, last_update_ts: f.now / 1000 }), true);
    assert.equal(item.adapter.snapshot().fields.current_limit.value, value);
  };
  try {
    f.runtime.canControl = () => false; accept(14);
    assert.deepEqual(rows(), initial, 'Read-only replica observations cannot append authoritative limiter history');
    f.runtime.canControl = authority; item.adapterGeneration++;
    accept(13);
    assert.deepEqual(rows(), initial, 'A replaced controller callback cannot publish through its previous generation');
    item.adapterGeneration = generation;
    const failing = t.mock.method(f.runtime, 'recordLimiterHistory', () => { throw new Error('Synthetic history failure'); });
    try { accept(12); assert.equal(failing.mock.callCount(), 1); }
    finally { failing.mock.restore(); }
    assert.deepEqual(rows(), initial, 'Observer failure cannot partially append history or reject the accepted native reading');
    await item.controller.close(); accept(11);
    assert.deepEqual(rows(), initial, 'Closing the controller detaches its adapter publication observer');
    const restarted = createShellyController({ adapter: item.adapter,
      initialState: f.store.getState(f.runtime.ownershipKey('charger2')), clock: () => f.now, canControl: () => true });
    try { assert.equal(f.runtime.limiterStatus(restarted.status(), f.now).mode, 'unknown',
      'Restored diagnostics cannot publish a current decision even when native generation numbers repeat'); }
    finally { await restarted.close(); }
  } finally { f.runtime.canControl = authority; item.adapterGeneration = generation; }
});

test('limiter history records publication before a five-second current-command await without writing from status reads', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger2'); await f.priority('charger2'); await f.plan();
  assert.equal(f.view('charger2').limiter.mode, 'unrestricted');
  const history = () => f.store.db.prepare(`SELECT c.start_at,c.end_at,o.id,o.raw FROM recorder_coverage c
    JOIN observations o ON o.id=c.observation_id WHERE c.signal='charger2_current_allowance' ORDER BY c.id`)
    .all().map(row => ({ ...row, status: JSON.parse(row.raw).allowance.limiter }));
  const held = f.holdNextShellyCurrentWrite();
  f.household.currentA = 17; f.advance(5000);
  const changedAt = f.now, flight = f.runtime.reconcileShellyObservation();
  await held.started;
  try {
    const live = f.view('charger2').limiter, rows = history(), last = rows.at(-1);
    assert.equal(live.mode, 'limited'); assert.equal(live.allowanceA, 8); assert.equal(live.applicationStatus, 'pending');
    assert.deepEqual(last.status, live, 'Published limiter decision must already be recorded while the command is waiting');
    assert.equal(last.start_at, changedAt, 'Use the actual publication clock, not a later poll or a backdated estimate');
    assert(rows.filter(row => row.status.mode === 'unrestricted').every(row => row.end_at <= changedAt));
    for (let i = 0; i < 10; i++) {
      f.advance(500);
      assert.deepEqual(f.runtime.status().chargers.find(charger => charger.id === 'charger2').limiter, live);
      assert.deepEqual(history(), rows, 'Half-second status observers cannot write or renew historical coverage');
    }
  } finally { held.release(); await flight; }
  const final = history().at(-1);
  assert.equal(final.status.mode, 'limited'); assert.equal(final.status.allowanceA, 8);
  assert.equal(final.status.applicationStatus, 'confirmed'); assert.equal(final.status.appliedCurrentA, 8);
  assert.equal(f.runtime.status().limiterHistoryError, null);
});

test('limiter history publishes native readback while another role refresh is still awaiting its reply', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger2'); await f.priority('charger2'); await f.plan();
  const history = () => f.store.db.prepare(`SELECT c.start_at,c.end_at,o.id,o.raw FROM recorder_coverage c
    JOIN observations o ON o.id=c.observation_id WHERE c.signal='charger2_current_allowance' ORDER BY c.id`)
    .all().map(row => ({ ...row, status: JSON.parse(row.raw).allowance.limiter }));
  const held = f.holdShellyReadAfterCurrentWrite();
  f.household.currentA = 17; f.advance(5000);
  const flight = f.runtime.reconcileShellyObservation();
  await held.started;
  try {
    const control = f.runtime.chargers.charger2.controller.status(), live = f.view('charger2').limiter;
    assert.equal(control.pending?.stage, 'accepted');
    assert.equal(control.snapshot.fields.current_limit.value, 8);
    assert.equal(live.allowanceA, 8); assert.equal(live.appliedCurrentA, 8); assert.equal(live.applicationStatus, 'pending');
    const rows = history(), last = rows.at(-1), readbackAt = control.snapshot.fields.current_limit.receivedAt;
    assert.deepEqual(last.status, live, 'Published native setting cannot wait for an unrelated outstanding role reply');
    assert.equal(last.start_at, readbackAt);
    assert(rows.filter(row => row.status.appliedCurrentA === 16).every(row => row.end_at <= readbackAt));
    for (let i = 0; i < 10; i++) {
      f.advance(500);
      assert.deepEqual(f.runtime.status().chargers.find(charger => charger.id === 'charger2').limiter, live);
      assert.deepEqual(history(), rows, 'Status GET cannot renew stale readback coverage or create historical rows');
    }
  } finally { held.release(); await flight; }
  assert.equal(history().at(-1).status.applicationStatus, 'confirmed');
  assert.equal(history().at(-1).status.appliedCurrentA, 8);
});

test('unchanged owned balancing pauses do not produce transient limiter-mode rows on each poll', async t => {
  const f = await fixture(t);
  await f.connect('charger1'); await f.connect('charger2');
  f.cars.charger1.demandA = 16; f.cars.charger2.demandA = 16;
  await f.priority('charger1'); await f.plan();
  assert.equal(f.view('charger2').limiter.mode, 'paused-by-balancing');
  const rows = () => f.store.db.prepare("SELECT id,raw FROM observations WHERE signal='charger2_current_allowance' ORDER BY id").all();
  const initial = rows();
  for (let i = 0; i < 3; i++) {
    f.advance(5000); await f.runtime.reconcileShellyObservation();
    assert.equal(f.view('charger2').limiter.mode, 'paused-by-balancing');
    assert.deepEqual(rows(), initial, 'Publishing an unchanged decision must preserve its complete mode before notifying history');
  }
});

test('the existing Shelly poll drives one serialized local reconciliation and stops after close', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t, { budgetA: 25, notifyRuntime: true });
  await f.connect('charger2'); await f.priority('charger2'); await f.plan();
  const controller = f.runtime.chargers.charger2.controller;
  const originalUpdate = controller.update;
  let release, entered = 0;
  const held = new Promise(resolve => { release = resolve; });
  controller.update = async input => { entered++; await held; return originalUpdate(input); };
  const readsBefore = f.reads.charger1;
  const planning = t.mock.method(f.runtime, 'updatePlan');
  f.household.currentA = 17; f.advance(5000); t.mock.timers.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, 1);
  f.advance(5000); t.mock.timers.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, 1, 'A second poll cannot queue or revoke the in-flight current command');
  release(); await f.runtime.chargers.charger2.reconcileFlight;
  assert.equal(f.fields.current_limit.value, 8);
  assert.equal(f.reads.charger1, readsBefore);
  assert.equal(planning.mock.callCount(), 0);
  await f.runtime.close();
  f.advance(5000); t.mock.timers.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, 1, 'A closed runtime cannot receive more controller updates from the adapter poll');
  f.closeAdapter();
  const finalReads = f.reads.charger2;
  f.advance(5000); t.mock.timers.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.reads.charger2, finalReads, 'Closing the adapter stops its existing poll timer');
});

test('current reconciliation replans at the original cache deadline and discards a disconnected Charge now scope', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger2'); await f.priority('charger2'); await f.runtime.chargeNow('charger2', f.scope('charger2')); await f.plan();
  const originalSession = f.view('charger2').request.sessionId;
  const planning = t.mock.method(f.runtime, 'updatePlan');
  f.advance(31_000); await f.runtime.reconcileShellyObservation();
  assert.ok(planning.mock.callCount() > 0, 'The faster limiter loop does not extend the accepted planning cache');
  f.cars.charger2.connected = false;
  f.advance(5000); await f.runtime.reconcileShellyObservation();
  assert.equal(f.view('charger2').request, null);
  f.advance(5000); f.cars.charger2.connected = true; f.cars.charger2.connectedAt = f.now;
  await f.runtime.reconcileShellyObservation();
  assert.notEqual(f.view('charger2').request.sessionId, originalSession);
  assert.notEqual(f.view('charger2').request.chargeNow, true);
});

test('settled disconnected polling reuses its bounded empty plan without charging or replanning', async t => {
  const f = await fixture(t);
  await f.plan();
  const before = f.commands.length;
  const planning = t.mock.method(f.runtime, 'updatePlan');
  f.advance(5000); await f.runtime.reconcileShellyObservation();
  assert.equal(planning.mock.callCount(), 0);
  assert.equal(f.commands.length, before);
  assert.equal(f.view('charger2').request, null);
});

test('a failed local reconciliation retains its diagnostic without replaying a command', async t => {
  const f = await fixture(t);
  await f.connect('charger2'); await f.plan();
  const controller = f.runtime.chargers.charger2.controller;
  t.mock.method(controller, 'update', async () => { throw new Error('Synthetic state persistence unavailable'); });
  const commands = f.commands.length;
  f.advance(5000);
  await assert.rejects(f.runtime.reconcileShellyObservation(), /Synthetic state persistence unavailable/);
  assert.equal(f.view('charger2').error, 'charging-reconciliation-unavailable');
  assert.equal(f.runtime.chargers.charger2.reconcileFlight, null);
  assert.equal(f.commands.length, commands);
});
