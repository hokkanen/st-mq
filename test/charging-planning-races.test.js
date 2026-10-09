import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { planChargers } from '../src/charging/planner.js';
import { easeeChargerTelemetry, normalizeScheduleState, scheduleFingerprint } from '../src/charging/easee.js';

const AT = Date.parse('2026-10-03T10:00:00Z'), HOUR = 3_600_000;
const turn = () => new Promise(resolve => setImmediate(resolve));
async function waitForCalls(planner, count) {
  for (let turnCount = 0; turnCount < 10 && planner.calls.length < count; turnCount++) await turn();
  assert.equal(planner.calls.length, count);
}

function controlledPlanner() {
  const calls = [];
  return {
    calls,
    request(options) {
      return new Promise(resolve => calls.push({ options: structuredClone(options), resolve, done: false }));
    },
    complete(index) {
      const call = calls[index];
      assert.ok(call && !call.done, `Request ${index} must be pending`);
      call.done = true;
      const result = planChargers(call.options);
      result.solver.testRequest = index;
      call.resolve(result);
    },
    close() { for (const call of calls) if (!call.done) { call.done = true; call.resolve(null); } },
  };
}

async function fixture(t) {
  let now = AT, authority = true;
  const store = new Store(':memory:'), controllers = {};
  const runtime = new ChargingRuntime({ store, engine: {}, clock: () => now, canControl: () => authority,
    config: { input: 'mqtt', connections: { easee: { charger_id: 'synthetic-planning-race' } },
      charging: { defaults: { readyBy: '14:00', capacityKwh: 20, manualSoc: 75, minimumSoc: 80 }, vehicles: { bmw: { mqttTopic: '' } },
        chargers: { charger2: { enabled: true, deviceId: 'synthetic-race-evse', topicPrefix: 'synthetic/races' } } } } });
  await runtime.plannerService.close();
  const tick = runtime.tick;
  runtime.tick = () => {}; // Attach deterministic status providers before starting any planning work.
  t.after(async () => { await runtime.close(); store.close(); });
  for (const id of ['charger1', 'charger2']) {
    const schedule = normalizeScheduleState({ enabled: 'none' });
    const control = { phase: 'waiting', session: { connected: true, connectedAt: AT, observedAt: AT },
      snapshot: { online: true, enabled: true, controlKnown: true, pluggedIn: true, readAt: AT,
        mode: 2, modeAt: AT, reason: 0, reasonAt: AT, schedule, fingerprint: scheduleFingerprint(schedule),
        limits: { circuitA: [16, 16, 16], chargerA: 16, cableA: 32, dynamicChargerA: 16,
          equalizerAvailableA: [16, 16, 16] }, supply: { availableCurrentA: [16, 16, 16],
          propertyCurrentA: [0, 0, 0], chargerCurrentA: [0, 0, 0], voltageV: [230, 230, 230],
          observedAt: AT, observationTimes: { voltage: [AT, AT, AT] } } } };
    runtime.chargers[id].controls.enabled = true; runtime.refreshSettings();
    await runtime.setAdapter(id, {
      normalize: easeeChargerTelemetry,
      capabilities: { externalLoadBalancing: id === 'charger1', currentControl: id === 'charger2' },
      createController(options) {
        const controller = { control, invalidations: 0,
          status: () => structuredClone(control),
          update: async () => structuredClone(control),
          getPlan: () => options.getPlan(structuredClone(control.snapshot)),
          invalidate() { this.invalidations++; }, close: async () => {} };
        controllers[id] = controller;
        return controller;
      },
    });
  }
  runtime.tick = tick;
  runtime.prices = [{ start: AT, end: AT + HOUR, price: 20 },
    { start: AT + HOUR, end: AT + 24 * HOUR, price: 1 }];
  runtime.pricesInitialized = true;
  const planner = controlledPlanner(); runtime.plannerService = planner;
  runtime.coordination = null;
  for (const item of Object.values(runtime.chargers)) { item.plan = null; item.commandBasis = undefined; }
  return { runtime, planner, controllers, store, setNow(value) { now = value; },
    setAuthority(value) { authority = value; } };
}

test('joint planning coalesces an equivalent burst into the running search', async t => {
  const f = await fixture(t), first = f.runtime.updatePlan();
  await waitForCalls(f.planner, 1);
  const rest = Array.from({ length: 8 }, () => f.runtime.updatePlan());
  assert.equal(f.planner.calls.length, 1);
  assert.ok(rest.every(flight => flight === first));
  f.planner.complete(0); await first;
  assert.equal(f.runtime.coordination.solver.testRequest, 0);
  assert.equal(f.planner.calls.length, 1);
  assert.equal(f.runtime.planningRequest, null);
});

test('two controllers awaiting a shared calculation receive it without invalidating each other', async t => {
  const f = await fixture(t);
  for (const item of Object.values(f.runtime.chargers)) item.commandBasis = 'earlier-program';
  const before = Object.fromEntries(Object.entries(f.controllers).map(([id, controller]) => [id, controller.invalidations]));
  const first = f.controllers.charger1.getPlan();
  await waitForCalls(f.planner, 1);
  const second = f.controllers.charger2.getPlan();
  assert.equal(f.runtime.chargers.charger1.awaitingPlan, true);
  assert.equal(f.runtime.chargers.charger2.awaitingPlan, true);
  f.planner.complete(0);
  const plans = await Promise.all([first, second]);
  assert.equal(f.planner.calls.length, 1, 'Both controllers use the same current result');
  for (const [index, id] of ['charger1', 'charger2'].entries()) {
    assert.ok(plans[index]?.periods.length);
    assert.equal(f.controllers[id].invalidations, before[id]);
    assert.equal(f.runtime.chargers[id].awaitingPlan, false);
  }
});

test('a valid native plan returns while newer changed measurements keep background planning busy', async t => {
  const f = await fixture(t), calculate = f.runtime.calculatePlan.bind(f.runtime);
  let completed = 0;
  f.runtime.calculatePlan = async (...args) => {
    await calculate(...args);
    if (++completed === 1) {
      // A real input change after publication deserves another search, but
      // cannot keep the caller of the already committed plan on a global drain.
      f.controllers.charger2.control.snapshot.limits.chargerA = 12;
      void f.runtime.updatePlan();
    }
  };
  let returned = false;
  const native = f.controllers.charger1.getPlan().then(plan => { returned = true; return plan; });
  await waitForCalls(f.planner, 1);
  f.planner.complete(0); await waitForCalls(f.planner, 2);
  await turn();
  assert.equal(returned, true, 'The native caller is released by publication before the next search completes');
  const plan = await native;
  assert.ok(plan.periods.length);
  assert.equal(f.runtime.coordination.solver.testRequest, 0);
  assert.equal(f.planner.calls[1].done, false, 'The newer calculation is still running independently');
  f.planner.complete(1); await f.runtime.planningFlight;
  assert.equal(f.runtime.coordination.solver.testRequest, 1);
});

test('control publication waiters cannot finish with an earlier request revision', async t => {
  const f = await fixture(t);
  let returned = false, latestReturned = false;
  const native = f.controllers.charger1.getPlan().then(plan => { returned = true; return plan; });
  await waitForCalls(f.planner, 1);
  const item = f.runtime.chargers.charger1;
  item.request.revision++; item.request.overrides.minimumSoc = 90;
  const latest = f.runtime.updatePlanForControl().then(() => { latestReturned = true; });
  f.planner.complete(0); await waitForCalls(f.planner, 2);
  assert.equal(returned, false);
  assert.equal(latestReturned, false);
  assert.equal(f.runtime.coordination, null, 'The previous revision has not been published');
  f.planner.complete(1); await Promise.all([native, latest]);
  assert.equal(f.runtime.coordination.requests.charger1.revision, item.request.revision);
  assert.equal(f.runtime.coordination.solver.testRequest, 1);
  assert.equal(f.runtime.planPublicationWaiters.size, 0);
});

test('a control request registered after commit cannot consume the preceding publication', async t => {
  const f = await fixture(t), persist = f.runtime.persist.bind(f.runtime);
  let newer, newerReturned = false, registered = false;
  f.runtime.persist = () => {
    persist();
    if (!registered && f.runtime.coordination?.solver.testRequest === 0) {
      registered = true;
      f.store.afterCommit(() => {
        const request = f.runtime.chargers.charger1.request;
        request.revision++; request.overrides.minimumSoc = 90;
        newer = f.runtime.updatePlanForControl().then(() => { newerReturned = true; });
      });
    }
  };
  const native = f.controllers.charger1.getPlan();
  await waitForCalls(f.planner, 1);
  f.planner.complete(0); await waitForCalls(f.planner, 2);
  assert.ok((await native).periods.length);
  assert.equal(newerReturned, false, 'Only callers covered by the final evidence check receive this publication');
  f.planner.complete(1); await newer;
  assert.equal(f.runtime.coordination.solver.testRequest, 1);
  assert.equal(f.runtime.coordination.requests.charger1.revision, f.runtime.chargers.charger1.request.revision);
  assert.equal(f.runtime.planPublicationWaiters.size, 0);
});

test('an unchanged native read receipt does not discard useful planning work', async t => {
  const f = await fixture(t), work = f.runtime.updatePlan();
  await waitForCalls(f.planner, 1);
  f.controllers.charger1.control.session.observedAt = AT + 1000;
  f.setNow(AT + 1000);
  f.planner.complete(0); await work;
  assert.equal(f.planner.calls.length, 1);
  assert.equal(f.runtime.coordination.solver.testRequest, 0);
});

test('a failed replan still returns a captured probe obligation when no execution snapshot remains', async t => {
  const f = await fixture(t), item = f.runtime.chargers.charger1, returnStartAt = AT + HOUR;
  f.controllers.charger1.control.execution = null;
  item.request = { scope: `${item.association}:${AT}`, sessionId: `${item.association}:${AT}`, deadlineAt: AT + 2 * HOUR };
  item.identification = { id: 'synthetic-return-after-failed-plan', connectedAt: AT, phase: 'inconclusive',
    probe: { startedAt: AT, deadlineAt: AT + 60_000, returnStartAt, endedAt: AT + 70_000 } };
  f.setNow(AT + 80_000);
  f.runtime.updatePlan = async () => { throw Error('synthetic planning unavailable'); };
  const plan = await f.controllers.charger1.getPlan();
  assert.equal(plan.startAt, returnStartAt);
  assert.deepEqual(plan.periods, [{ startAt: returnStartAt, endAt: null }]);
  assert.equal(f.runtime.error, 'charging-planning-unavailable');
  assert.equal(item.awaitingPlan, false);
});

test('a changed joint program still revokes a controller that already reached native preflight', async t => {
  const f = await fixture(t), item = f.runtime.chargers.charger2;
  const before = f.controllers.charger2.invalidations;
  item.commandBasis = 'earlier-native-preflight';
  item.reconcileFlight = new Promise(() => {});
  t.after(() => { item.reconcileFlight = null; item.reconcileAgain = false; });
  const work = f.runtime.updatePlan(AT, { sourceId: 'charger1' });
  await waitForCalls(f.planner, 1);
  f.planner.complete(0); await work;
  assert.equal(f.controllers.charger2.invalidations, before + 1);
  assert.equal(item.reconcileAgain, true);
});

test('close discards a running search and drains its waiting callers without publication', async t => {
  const f = await fixture(t), work = f.runtime.updatePlan();
  await waitForCalls(f.planner, 1);
  assert.equal(f.planner.calls.length, 1);
  await f.runtime.close(); await work;
  assert.equal(f.runtime.coordination, null);
  assert.equal(f.runtime.chargers.charger1.plan, null);
  assert.equal(f.runtime.chargers.charger2.plan, null);
});

test('time spent calculating does not postpone the original charging boundary wakeup', async t => {
  const f = await fixture(t);
  clearInterval(f.runtime.timer);
  clearTimeout(f.runtime.boundaryTimer);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const work = f.runtime.updatePlan();
  await waitForCalls(f.planner, 1);
  f.setNow(AT + 1000); t.mock.timers.tick(1000);
  f.planner.complete(0); await work;
  const boundary = f.runtime.boundaryAt;
  assert.ok(Number.isSafeInteger(boundary) && boundary > AT + 1000);
  let wakeups = 0;
  f.runtime.tick = ({ force }) => { assert.equal(force, true); wakeups++; };
  f.setNow(boundary - 1); t.mock.timers.tick(boundary - AT - 1001);
  assert.equal(wakeups, 0);
  f.setNow(boundary); t.mock.timers.tick(1);
  assert.equal(wakeups, 1, 'The worker duration must not extend a planned wait or charging period');
});

for (const change of ['request', 'session', 'authority', 'native instruction']) {
  test(`changed ${change} during calculation prevents stale joint publication`, async t => {
    const f = await fixture(t), work = f.runtime.updatePlan();
    await waitForCalls(f.planner, 1);
    const item = f.runtime.chargers.charger1, control = f.controllers.charger1.control;
    if (change === 'request') { item.request.revision++; item.request.overrides.minimumSoc = 90; }
    else if (change === 'session') { control.session.connectedAt = AT + 1000; control.snapshot.readAt = AT + 1000; f.setNow(AT + 1000); }
    else if (change === 'authority') f.setAuthority(false);
    else {
      control.manual = { kind: 'stop', detectedAt: AT };
      control.snapshot.enabled = false; control.snapshot.stopped = true;
    }
    f.planner.complete(0); await turn();
    assert.equal(f.runtime.coordination, null, 'The result was computed before the current control evidence');
    await f.runtime.close(); await work;
  });
}

for (const change of ['history selection', 'result age']) {
  test(`changed ${change} rejects the completed search and requests fresh planning`, async t => {
    const f = await fixture(t), work = f.runtime.updatePlan();
    await waitForCalls(f.planner, 1);
    if (change === 'history selection') f.store.db.prepare('UPDATE history_selection SET generation=generation+1 WHERE id=1').run();
    else f.setNow(AT + 31_000);
    f.planner.complete(0); await waitForCalls(f.planner, 2);
    assert.equal(f.runtime.coordination, null);
    f.planner.complete(1); await work;
    assert.equal(f.runtime.coordination.solver.testRequest, 1);
    assert.equal(f.runtime.coordination.at, change === 'result age' ? AT + 31_000 : AT);
  });
}
