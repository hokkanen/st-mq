import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { fixture, START, MINUTE, HOUR } from './helpers/charging-joint-fixture.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function stage(promise, name) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Fixture stage not reached: ${name}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function acceptedProgram(t, { limiter = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-owned-period-end-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  const f = await fixture(t, { store, budgetA: 25, limiter });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await f.automatic('charger2', true);
  // Each separated cheap half hour is too short for this battery request;
  // actual planning must choose a finite period plus a later final release.
  const prices = [
    // Strictly cheaper first: an equal-price capacity tie would select the
    // slightly longer later block first, leaving a sub-15-minute early run.
    { start: START, end: START + 30 * MINUTE, price: 0 },
    { start: START + 30 * MINUTE, end: START + HOUR, price: 100 },
    { start: START + HOUR, end: START + 90 * MINUTE, price: 1 },
    { start: START + 90 * MINUTE, end: START + 4 * HOUR, price: 100 },
  ];
  // Install prices before the first automatic connection, so takeover does
  // not first adopt an unrelated release program which ordinary replanning
  // correctly retains. The program below still comes from the real planner.
  f.runtime.tick({ prices, force: true }); await f.settle();
  assert.equal(f.cars.charger2.connected, false);
  await f.connect('charger2'); await f.settle();
  let view = f.view('charger2');
  console.error(JSON.stringify({ syntheticSetupOnly: true, now: f.now,
    remainingGridKwh: view.requiredGridKwh, capacityKwh: view.values.capacityKwh.value,
    soc: view.values.soc.value, minimumSoc: view.values.minimumSoc.value,
    configuredMaximumCurrentA: view.configuration.maximumCurrentA,
    reportedMaximumCurrentA: view.values.maximumCurrentA.value,
    assumedVoltageV: view.values.voltageV.value,
    admittedPriceIntervals: (view.plan.intervals ?? []).map(({ start, end, priceCtPerKwh }) => ({ start, end, priceCtPerKwh })),
    planReason: view.plan.reason,
    planPeriods: view.plan.periods, acceptedPeriods: view.control.execution?.periods ?? null,
    scheduleConfirmed: view.control.scheduleConfirmed }));
  assert.equal(view.plan.feasible, true);
  assert.ok(view.plan.periods.length >= 2 && Number.isSafeInteger(view.plan.periods[0].endAt),
    'The real planner must produce a finite accepted first period');
  f.advance(Math.max(0, view.plan.periods[0].startAt - f.now)); await f.settle();
  view = f.view('charger2');
  assert.equal(view.control.scheduleConfirmed, true);
  assert.equal(view.control.execution.planId, view.plan.id);
  assert.deepEqual(view.control.execution.periods, view.plan.periods);
  assert.equal(f.fields.start_charging.value, true);
  assert.ok(view.control.execution.periods[0].endAt > f.now);
  assert.equal(view.control.pending, null);
  assert.equal(view.control.manual, null);
  assert.equal(view.control.identification, null);
  assert.ok(!view.control.currentTest || view.control.currentTest.phase === 'restored');
  await store.runWrite(() => {}); await store.startWriter();
  return Object.assign(f, { store, adapter: f.runtime.chargers.charger2.adapter,
    execution: structuredClone(view.control.execution), initialCurrent: f.fields.current_limit.value });
}

test('an accepted Shelly period stops while background planning awaits vehicle admission', async t => {
  const f = await acceptedProgram(t);
  let pending = true;
  t.mock.method(f.runtime, 'vehicleAdmissionBasis', () => pending ? [['tesla', true, false]] : null);
  const background = f.runtime.updatePlan(f.now, { background: true });
  await f.runtime.planningFlight;
  assert.equal(f.runtime.planningAdmissionDeferred, true);
  f.advance(f.execution.periods[0].endAt - f.now);
  f.runtime.tick({ force: true });
  await stage(f.runtime.reconcile('charger2'), 'native period stop during vehicle admission');
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.runtime.chargers.charger2.controller.status().pending, null);
  pending = false; f.runtime.vehicleInputSettled();
  await background;
});

for (const condition of ['healthy', 'healthy with expired cached permission', 'authority lost', 'newer native Start', 'source unavailable'])
test(`accepted Shelly period end while planning is held: ${condition}`, async t => {
  const f = await acceptedProgram(t), item = f.runtime.chargers.charger2;
  const plannerEntered = deferred(), controllerWaiting = deferred(), releasePlanner = deferred();
  const request = f.runtime.plannerService.request, getPlan = f.runtime.updatePlanForControl;
  let released = false, waitSeen = false, reconcileResult, preStopEvidence;
  let readsBeforeBoundary, boundaryAt, cachedPermissionSourceAt;
  const rpc = f.adapter.rpc, healthy = condition.startsWith('healthy');
  f.adapter.rpc = function (...args) {
    if (condition === 'healthy with expired cached permission' && args[0] === 'Boolean.Set'
      && args[1].role === 'start_charging' && args[1].value === false) {
      const current = f.adapter.snapshot(), permission = current.fields.start_charging;
      preStopEvidence = { controlReady: current.controlReady,
        permissionSourceAt: permission.measuredAt, permissionReceivedAt: permission.receivedAt,
        readbackRequestedAt: permission.readback?.requestedAt ?? null,
        nativeStatusReads: f.reads.charger2, awaitingPlan: Boolean(item.awaitingPlan),
        numericalResultStillHeld: !released };
    }
    return Reflect.apply(rpc, this, args);
  };
  const events = [], started = performance.now();
  const record = name => events.push({ name, elapsedMs: performance.now() - started, now: f.now,
    writerCanDispatch: f.store.canDispatch(), awaitingPlan: Boolean(item.awaitingPlan),
    reconcileFlight: Boolean(item.reconcileFlight), commands: f.commands.length });
  f.runtime.plannerService.request = function (...args) {
    if (released) return Reflect.apply(request, this, args);
    // The production service seals its inputs normally. Only delivery of its
    // actual result is delayed; no substitute program is produced by the test.
    const pending = Reflect.apply(request, this, args);
    record('planner.request.held'); plannerEntered.resolve();
    return pending.then(result => {
      record('planner.result.ready');
      return releasePlanner.promise.then(() => result);
    });
  };
  f.runtime.updatePlanForControl = function (...args) {
    if (item.awaitingPlan) { waitSeen = true; record('controller.getPlan.waiting'); controllerWaiting.resolve(); }
    return Reflect.apply(getPlan, this, args);
  };
  // The actual controller owns this flight, including its native readback and
  // private cancellable readPlan wait. No execution or native reply is injected.
  f.runtime.prices = f.runtime.prices.map(row => ({ ...row, priceCtPerKwh: (row.priceCtPerKwh ?? row.price) + .01 }));
  const reconcile = f.runtime.reconcile('charger2');
  const settled = reconcile.then(() => ({ ok: true }), error => ({ ok: false, error }));
  let assertionError = null, beforeBoundary, afterBoundary;
  try {
    await stage(Promise.all([plannerEntered.promise, controllerWaiting.promise]), 'real controller plan wait');
    await f.store.runWrite(() => {});
    assert.equal(waitSeen, true);
    assert.equal(Boolean(item.reconcileFlight), true);
    assert.equal(f.store.canDispatch(), true, 'No held writer lock supplies the planning failure mechanism');
    beforeBoundary = f.commands.length;
    f.advance(f.execution.periods[0].endAt + 1 - f.now);
    readsBeforeBoundary = f.reads.charger2; boundaryAt = f.now;
    cachedPermissionSourceAt = f.adapter.snapshot().fields.start_charging.measuredAt;
    if (condition === 'newer native Start')
      f.fields.start_charging = { value: true, at: f.now, source: 'rpc' };
    if (condition === 'source unavailable') f.closeAdapter();
    else if (condition === 'healthy with expired cached permission') {
      const cached = f.adapter.snapshot();
      assert.equal(cached.controlReady, false);
      assert.ok(f.now - cached.fields.start_charging.receivedAt > f.adapter.config.maxAgeMs);
    } else await f.adapter.refresh({ force: true });
    if (condition === 'authority lost') t.mock.method(f.runtime, 'canControl', () => false);
    record('boundary.tick'); f.runtime.tick({ force: true });
    // Give asynchronous writer/readback turns a bounded diagnostic window,
    // without completing numerical work or advancing device/source clocks.
    const observedUntil = performance.now() + 5000;
    do {
      await new Promise(resolve => setTimeout(resolve, 10));
      if (healthy && f.view('charger2').control.pauseConfirmed
        && f.fields.current_limit.value === Math.min(f.initialCurrent, f.adapter.config.fallbackCurrentA)
        && f.view('charger2').control.pending === null) break;
    } while (performance.now() < observedUntil);
    afterBoundary = f.commands.slice(beforeBoundary);
    if (healthy) {
      assert.deepEqual(f.view('charger2').control.execution, f.execution,
        'A newer display-only proposal cannot replace the pinned accepted program');
      assert.ok(afterBoundary.some(row => row.method === 'Boolean.Set' && row.role === 'start_charging' && row.value === false),
        'The confirmed finite execution ends before any held plan is released');
      assert.equal(f.fields.start_charging.value, false);
      assert.equal(f.view('charger2').control.pauseConfirmed, true);
      const fallback = Math.min(f.initialCurrent, f.adapter.config.fallbackCurrentA);
      assert.equal(f.fields.current_limit.value, fallback, 'Confirmed idle fallback cannot wait for replacement planning');
      assert.ok(afterBoundary.some(row => row.method === 'Number.Set' && row.value === fallback));
      assert.equal(afterBoundary.some(row => row.method === 'Boolean.Set' && row.value === true), false);
      if (condition === 'healthy with expired cached permission') {
        assert.ok(preStopEvidence, 'The real Stop reached native preflight before numerical delivery');
        assert.equal(preStopEvidence.controlReady, true);
        assert.equal(preStopEvidence.permissionSourceAt, cachedPermissionSourceAt,
          'A fresh query preserves the original native permission source clock');
        assert.ok(preStopEvidence.permissionReceivedAt >= boundaryAt);
        assert.ok(preStopEvidence.readbackRequestedAt >= boundaryAt);
        assert.ok(preStopEvidence.nativeStatusReads > readsBeforeBoundary);
        assert.equal(preStopEvidence.awaitingPlan, false);
        assert.equal(preStopEvidence.numericalResultStillHeld, true);
      }
      const stopIndex = afterBoundary.findIndex(row => row.method === 'Boolean.Set' && row.value === false);
      for (const [index, command] of afterBoundary.entries()) if (command.method === 'Number.Set') {
        assert.ok(index > stopIndex, 'An idle setting follows the confirmed Stop');
        assert.equal(command.value, Math.min(f.initialCurrent, f.adapter.config.fallbackCurrentA),
          'Any ordinary idle setting retains the configured fallback and known tighter current');
        assert.equal(f.view('charger2').control.pending, null, 'The setting needs actual native confirmation');
      }
    } else {
      assert.equal(afterBoundary.length, 0, 'Lost authority, unavailable source or newer native instruction retains its fence');
      assert.equal(f.fields.current_limit.value, f.initialCurrent);
    }
  } catch (error) { assertionError = error; }
  finally {
    released = true; record('planner.released'); releasePlanner.resolve();
    reconcileResult = await settled;
    f.runtime.plannerService.request = request;
    f.runtime.updatePlanForControl = getPlan;
    f.adapter.rpc = rpc;
    console.error(JSON.stringify({ syntheticOnly: true, condition,
      pinnedFirstEndAt: f.execution.periods[0].endAt, waitSeen,
      assertionError: assertionError?.message ?? null,
      originalReconcileError: reconcileResult.ok ? null : reconcileResult.error.message,
      beforeBoundary: beforeBoundary ?? null, preStopEvidence: preStopEvidence ?? null,
      heldBoundaryCommands: (afterBoundary ?? []).map(({ method, role, value, at }) => ({ method, role, value, at })),
      events }));
  }
  if (!reconcileResult.ok) throw reconcileResult.error;
  if (assertionError) throw assertionError;
});

async function until(predicate, name) {
  const end = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() >= end) throw new Error(`Fixture stage not reached: ${name}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
async function joinOutcome(result) { const settled = await result; if (settled.error) throw settled.error; return settled.value; }

function holdFirstPlan(f) {
  // Changed published rates request work; age and unchanged polling do not.
  f.runtime.prices = f.runtime.prices.map(row => ({ ...row, priceCtPerKwh: (row.priceCtPerKwh ?? row.price) + .01 }));
  const original = f.runtime.plannerService.request, entered = deferred(), ready = deferred(), released = deferred();
  let selected = false;
  f.runtime.plannerService.request = function (...args) {
    const pending = Reflect.apply(original, this, args);
    if (selected) return pending;
    selected = true; entered.resolve();
    return pending.then(result => { ready.resolve(); return released.promise.then(() => result); });
  };
  return { entered: entered.promise, ready: ready.promise, release: released.resolve,
    restore() { f.runtime.plannerService.request = original; } };
}
function holdStopBytes(f) {
  const original = f.adapter.rpc, entered = deferred(), released = deferred();
  let selected = false;
  f.adapter.rpc = function (...args) {
    const [method, params] = args;
    if (selected || method !== 'Boolean.Set' || params.role !== 'start_charging' || params.value !== false)
      return Reflect.apply(original, this, args);
    selected = true; entered.resolve();
    // Keep the real RPC's final guards/readback. Delay only entering its
    // external transport boundary, after the controller journaled its intent.
    return released.promise.then(() => Reflect.apply(original, this, args));
  };
  return { entered: entered.promise, release: released.resolve, restore() { f.adapter.rpc = original; } };
}
async function enterGap(f) {
  f.advance(f.execution.periods[0].endAt + 1 - f.now);
  await f.adapter.refresh({ force: true });
}

test('an already-due accepted Stop and confirmed idle fallback do not need a new planner result', async t => {
  const f = await acceptedProgram(t), held = holdFirstPlan(f), before = f.commands.length;
  await enterGap(f);
  const reconcile = outcome(f.runtime.reconcile('charger2'));
  let failure;
  try {
    await stage(reconcile, 'direct owned Stop completion');
    await joinOutcome(reconcile);
    assert.equal(f.view('charger2').control.pauseConfirmed, true);
    assert.equal(f.fields.current_limit.value, f.adapter.config.fallbackCurrentA);
    assert.deepEqual(f.commands.slice(before).map(({ role, value }) => ({ role, value })), [
      { role: 'start_charging', value: false }, { role: 'current_limit', value: f.adapter.config.fallbackCurrentA },
    ]);
  } catch (error) { failure = error; }
  finally {
    held.release(); const result = await reconcile; held.restore();
    failure ??= result.error;
  }
  if (failure) throw failure;
});

for (const change of ['idle returns', 'newer native Start', 'disconnected session', 'tighter native current'])
test(`confirmed owned Stop reaches later idle fallback with planning held: ${change}`, async t => {
  const f = await acceptedProgram(t), item = f.runtime.chargers.charger2, held = holdFirstPlan(f);
  const planning = outcome(f.runtime.updatePlan(f.now));
  let firstReconcile, reconcile, failure;
  try {
    await stage(held.ready, 'replacement numerical result held');
    // The synthetic physical device keeps drawing after confirming false
    // permission. All observations still enter through actual native RPC.
    f.cars.charger2.stopStillDrawing = true;
    await enterGap(f);
    firstReconcile = outcome(f.runtime.reconcile('charger2'));
    await stage(firstReconcile, 'permission Stop before physical idle'); await joinOutcome(firstReconcile);
    assert.equal(f.fields.start_charging.value, false);
    assert.equal(f.view('charger2').control.pending, null);
    assert.equal(f.view('charger2').control.pauseConfirmed, false);
    assert.ok(f.adapter.snapshot().powerKw > 0);
    assert.equal(f.fields.current_limit.value, f.initialCurrent);
    const afterConfirmedStop = f.commands.length;
    assert.equal(f.commands.filter(row => row.role === 'start_charging' && row.value === false).length, 1);
    f.cars.charger2.stopStillDrawing = false;
    f.advance(1000);
    if (change === 'newer native Start') f.fields.start_charging = { value: true, at: f.now, source: 'rpc' };
    if (change === 'disconnected session') f.cars.charger2.connected = false;
    if (change === 'tighter native current') f.fields.current_limit = { value: 6, at: f.now, source: 'rpc' };
    await f.adapter.refresh({ force: true });
    reconcile = outcome(f.runtime.reconcile('charger2'));
    if (change === 'newer native Start' || change === 'tighter native current') {
      await until(() => item.awaitingPlan && (change === 'newer native Start'
        ? f.view('charger2').control.manual?.kind === 'enable' : f.view('charger2').control.manualCurrentA === 6),
      'new instruction or already-complete tighter return reaches ordinary planning');
      assert.equal(item.controller.ownsDueStop(), false);
    } else {
      await stage(reconcile, 'confirmed-idle pass without planner delivery'); await joinOutcome(reconcile);
    }
    const later = f.commands.slice(afterConfirmedStop);
    if (change === 'idle returns') {
      assert.equal(f.view('charger2').control.pauseConfirmed, true);
      assert.equal(f.fields.current_limit.value, f.adapter.config.fallbackCurrentA);
      assert.deepEqual(later.map(({ role, value }) => ({ role, value })), [
        { role: 'current_limit', value: f.adapter.config.fallbackCurrentA },
      ]);
    } else {
      assert.equal(later.length, 0, 'A newer instruction/session or tighter current cannot inherit an old fallback write');
      if (change === 'tighter native current') {
        assert.equal(f.fields.current_limit.value, 6);
        assert.equal(f.view('charger2').control.manualCurrentA, 6);
      } else assert.equal(item.controller.ownsDueStop(), false);
    }
  } catch (error) { failure = error; }
  finally {
    held.release();
    const results = await Promise.all([planning, ...(firstReconcile ? [firstReconcile] : []), ...(reconcile ? [reconcile] : [])]);
    held.restore();
    if (!failure) failure = results.find(result => result.error)?.error;
  }
  if (failure) throw failure;
});

for (const source of ['same cancelled source', 'other coalesced source'])
test(`late proposal publication preserves only the accepted pending Stop: ${source}`, async t => {
  const f = await acceptedProgram(t);
  // Settle the real household-history refresh before this controlled source
  // race. Advancing half an hour after installing the gate would let its
  // separate completion tick supersede the wanted calculation's metadata.
  f.advance(f.execution.periods[0].endAt - 1000 - f.now);
  await f.adapter.refresh({ force: true });
  await stage(f.settle(), 'real pre-boundary calculation');
  await until(() => f.runtime.historyFlights.size === 0, 'current household history returned');
  await stage(f.settle(), 'household-history completion publication');
  assert.equal(f.runtime.historyReady, true);
  assert.ok(f.now - f.runtime.historyAt < MINUTE);
  assert.ok(f.now < f.execution.periods[0].endAt);
  assert.deepEqual(f.view('charger2').control.execution.periods, f.execution.periods);
  assert.equal(f.view('charger2').control.scheduleConfirmed, true);
  assert.equal(f.view('charger2').control.pending, null);
  assert.equal(f.adapter.snapshot().fields.start_charging.value, true);
  console.error(JSON.stringify({ syntheticOnly: true, latePublicationSourceSetup: source,
    now: f.now, historyAt: f.runtime.historyAt, historyFlights: f.runtime.historyFlights.size,
    acceptedFirstEndAt: f.execution.periods[0].endAt }));
  const item = f.runtime.chargers.charger2;
  const held = holdFirstPlan(f), bytes = holdStopBytes(f), committed = deferred();
  const fence = f.runtime.fenceChangedCommands, before = f.commands.length;
  let witness, coalesced, failure;
  f.runtime.fenceChangedCommands = function (now, sourceId, sourceWaiter) {
    const previous = item.commandBasis, owner = item.controller.ownsDueStop(), waiting = item.awaitingPlan;
    const result = Reflect.apply(fence, this, [now, sourceId, sourceWaiter]);
    if (owner && previous !== item.commandBasis) {
      const row = { sourceId, sameWaiter: item.planWait === sourceWaiter,
        waiting: Boolean(waiting), pendingRole: item.controller.status().pending?.role };
      this.store.afterCommit(() => { witness = row; committed.resolve(); });
    }
    return result;
  };
  const first = outcome(f.runtime.reconcile('charger2'));
  try {
    await stage(held.ready, 'first numerical result ready');
    const oldWaiter = item.planWait;
    assert.ok(oldWaiter && item.awaitingPlan);
    await enterGap(f); f.runtime.tick({ force: true });
    await stage(bytes.entered, 'owned Stop native boundary');
    assert.equal(item.awaitingPlan, false, 'Cancelling one controller wait releases only its publication waiter');
    assert.equal(item.controller.ownsDueStop(), true);
    assert.equal(item.controller.interruptOwnedStop(), false, 'A native operation is not a planning wait');
    assert.equal(item.controller.interruptPlanning(), false);
    assert.equal(f.commands.length, before);
    // Controlled coalescing retains a REAL cancelled waiter's identity. It
    // does not fabricate a numerical result or an accepted replacement.
    coalesced = outcome(f.runtime.updatePlan(f.now, source === 'same cancelled source'
      ? { sourceId: 'charger2', sourceWaiter: oldWaiter } : { sourceId: 'charger1' }));
    held.release();
    await stage(committed.promise, 'changed proposal actually committed');
    assert.equal(witness.waiting, false);
    if (source === 'same cancelled source') {
      assert.equal(witness.sourceId, 'charger2'); assert.equal(witness.sameWaiter, false);
    } else assert.equal(witness.sourceId, 'charger1');
    assert.equal(witness.pendingRole, 'start_charging');
    assert.equal(item.controller.ownsDueStop(), true);
    bytes.release();
    await until(() => f.view('charger2').control.pauseConfirmed
      && f.fields.current_limit.value === f.adapter.config.fallbackCurrentA
      && !item.reconcileFlight, 'confirmed Stop and existing fallback after late proposal');
    assert.equal(f.commands.slice(before).some(row => row.role === 'start_charging' && row.value === true), false);
    assert.equal(item.controller.ownsDueStop(), false, 'Proposal exemption ends with this exact native pass');
  } catch (error) { failure = error; }
  finally {
    held.release(); bytes.release();
    const results = await Promise.all([first, ...(coalesced ? [coalesced] : [])]);
    f.runtime.fenceChangedCommands = fence; bytes.restore(); held.restore();
    failure ??= results.find(result => result.error)?.error;
  }
  if (failure) throw failure;
});

test('an unconfirmed older pending Stop is preserved rather than replayed at an accepted gap', async t => {
  const f = await acceptedProgram(t);
  await enterGap(f); f.rejectShellyWrites(true);
  await f.runtime.reconcile('charger2');
  const pending = structuredClone(f.view('charger2').control.pending);
  assert.equal(pending.role, 'start_charging'); assert.equal(pending.value, false);
  assert.equal(pending.stage, 'dispatched'); assert.equal(pending.acceptedAt, undefined);
  const before = f.commands.length;
  f.rejectShellyWrites(false);
  await f.runtime.reconcile('charger2');
  assert.deepEqual(f.view('charger2').control.pending, pending);
  assert.equal(f.commands.length, before, 'An absent ACK supplies no new Stop or fallback-setting authority');
  assert.equal(f.runtime.chargers.charger2.controller.ownsDueStop(), false);
});

test('crossing into the next accepted period before native bytes revokes the old finite-gap Stop', async t => {
  const f = await acceptedProgram(t), bytes = holdStopBytes(f);
  f.advance(f.execution.periods[1].startAt - 1000 - f.now);
  await f.adapter.refresh({ force: true });
  const before = f.commands.length, reconcile = outcome(f.runtime.reconcile('charger2'));
  let failure;
  try {
    await stage(bytes.entered, 'pending Stop before RPC');
    const nativeRevision = f.adapter.snapshot().notificationRevision;
    f.advance(f.execution.periods[1].startAt - f.now);
    assert.ok(f.view('charger2').control.pending.expiresAt > f.now,
      'The original command deadline is still open; only its accepted gap closed');
    assert.equal(f.adapter.snapshot().notificationRevision, nativeRevision);
    bytes.release(); await joinOutcome(reconcile);
    assert.equal(f.commands.length, before);
    assert.equal(f.fields.start_charging.value, true);
    assert.equal(f.fields.current_limit.value, f.initialCurrent);
  } catch (error) { failure = error; }
  finally {
    bytes.release(); const result = await reconcile; bytes.restore();
    failure ??= result.error;
  }
  if (failure) throw failure;
});

test('a newer committed Charge now instruction fences the old Stop before native bytes', async t => {
  const f = await acceptedProgram(t), item = f.runtime.chargers.charger2, bytes = holdStopBytes(f), committed = deferred();
  await enterGap(f);
  const before = f.commands.length, revision = item.request.revision, persist = f.runtime.persist;
  f.runtime.persist = function (...args) {
    const result = Reflect.apply(persist, this, args);
    if (item.request.chargeNow === true && item.request.revision === revision + 1)
      this.store.afterCommit(committed.resolve);
    return result;
  };
  const reconcile = outcome(f.runtime.reconcile('charger2'));
  let action, failure;
  try {
    await stage(bytes.entered, 'old Stop native boundary');
    action = outcome(f.runtime.chargeNow('charger2', f.scope('charger2')));
    await stage(committed.promise, 'new same-session Charge now intent COMMIT');
    assert.equal(item.request.chargeNow, true);
    await until(() => !item.controller.ownsDueStop(), 'committed instruction revokes the old native owner');
    assert.equal(item.controller.ownsDueStop(), false);
    bytes.release(); await joinOutcome(reconcile); await joinOutcome(action);
    assert.equal(f.commands.slice(before).some(row => row.role === 'start_charging' && row.value === false), false);
    assert.equal(item.request.chargeNow, true, 'A late old owner cannot replace the newer committed intent');
  } catch (error) { failure = error; }
  finally {
    bytes.release(); const results = await Promise.all([reconcile, ...(action ? [action] : [])]);
    f.runtime.persist = persist; bytes.restore();
    failure ??= results.find(result => result.error)?.error;
  }
  if (failure) throw failure;
});

test('a completed owned Stop yields to an earlier same-session ready-by program inside the old gap', async t => {
  const f = await acceptedProgram(t);
  await enterGap(f); await f.runtime.reconcile('charger2'); await f.settle();
  const before = f.view('charger2'), oldNextStart = f.execution.periods[1].startAt;
  assert.equal(before.control.pauseConfirmed, true);
  assert.equal(before.control.pending, null);
  assert.equal(f.fields.current_limit.value, f.adapter.config.fallbackCurrentA);
  assert.equal(f.fields.start_charging.value, false);
  assert.ok(f.now < oldNextStart);
  // January Helsinki02:30 is UTC00:30. The actual new03:10 deadline
  // requires an earlier real period than the old UTC01:00 release.
  await stage(f.runtime.setSessionRequest('charger2', { ...f.scope('charger2'),
    changes: { readyBy: '03:10' } }), 'earlier same-session request admitted and planned');
  await f.settle();
  const revised = f.view('charger2');
  assert.equal(revised.plan.feasible, true);
  assert.ok(revised.plan.periods[0].startAt < oldNextStart);
  assert.ok(revised.request.revision > before.request.revision);
  console.error(JSON.stringify({ syntheticOnly: true, completedStopNextRequest: true,
    now: f.now, oldNextStart, newDeadlineAt: revised.request.deadlineAt,
    newFirstStart: revised.plan.periods[0].startAt,
    previousExecutionId: before.control.execution.planId,
    revisedPlanId: revised.plan.id, actualExecutionId: revised.control.execution.planId }));
  assert.equal(revised.control.execution.planId, revised.plan.id,
    'A completed return must stop selecting the old accepted gap before ordinary replanning');
  f.advance(Math.max(0, revised.plan.periods[0].startAt - f.now));
  await f.adapter.refresh({ force: true });
  f.runtime.tick({ force: true }); await f.settle();
  assert.ok(f.now < oldNextStart);
  assert.equal(f.fields.start_charging.value, true,
    'Only the ordinary newly accepted program may release the earlier requested period');
  assert.equal(f.view('charger2').control.scheduleConfirmed, true);
  assert.equal(f.view('charger2').control.pending, null);
});

test('a limiter-disabled confirmed Stop leaves normal planning intact without current-setting authority', async t => {
  const f = await acceptedProgram(t, { limiter: false }), item = f.runtime.chargers.charger2;
  const held = holdFirstPlan(f), planning = outcome(f.runtime.updatePlan(f.now));
  let stopping, waiting, failure;
  try {
    await stage(held.ready, 'real numerical result held');
    f.cars.charger2.stopStillDrawing = true;
    await enterGap(f); stopping = outcome(f.runtime.reconcile('charger2'));
    await stage(stopping, 'permission Stop without limiter'); await joinOutcome(stopping);
    assert.equal(f.fields.start_charging.value, false);
    assert.equal(f.view('charger2').control.pending, null);
    assert.equal(f.view('charger2').control.pauseConfirmed, false,
      'Permission confirmation alone cannot claim the physical pause');
    assert.equal(f.commands.some(row => row.method === 'Number.Set'), false);
    waiting = outcome(f.runtime.reconcile('charger2'));
    await until(() => item.awaitingPlan, 'normal planning after finished permission duty');
    const waiter = item.planWait;
    assert.equal(item.controller.interruptOwnedStop(), false);
    f.cars.charger2.stopStillDrawing = false; f.advance(1000);
    await f.adapter.refresh({ force: true });
    f.runtime.tick({ force: true }); await f.store.runWrite(() => {});
    assert.equal(item.planWait, waiter, 'A completed Stop cannot repeatedly revoke the ordinary waiter');
    assert.equal(item.controller.interruptOwnedStop(), false);
    assert.equal(f.view('charger2').control.pauseConfirmed, true);
    assert.equal(f.commands.some(row => row.method === 'Number.Set'), false);
  } catch (error) { failure = error; }
  finally {
    held.release();
    const results = await Promise.all([planning, ...(stopping ? [stopping] : []), ...(waiting ? [waiting] : [])]);
    held.restore(); failure ??= results.find(result => result.error)?.error;
  }
  if (failure) throw failure;
});
