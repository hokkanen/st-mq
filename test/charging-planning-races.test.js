import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { planChargers } from '../src/charging/planner.js';
import { advanceIdentification } from '../src/charging/identification.js';
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

test('a native deadline wakeup progresses while the first economic result is still pending', async t => {
  const f = await fixture(t), controller = f.controllers.charger2;
  let now = AT, returned = false;
  const native = [];
  controller.control.currentTest = { phase: 'active', expiresAt: AT + 2000 };
  controller.update = async () => {
    native.push(now);
    if (now >= controller.control.currentTest.expiresAt) controller.control.currentTest.phase = 'restored';
    return structuredClone(controller.control);
  };
  const first = f.runtime.reconcile('charger2').then(() => { returned = true; });
  await waitForCalls(f.planner, 1);
  for (let i = 0; i < 10; i++) await turn();
  assert.equal(returned, true, 'Completed native work releases the reconciliation queue before economic publication');
  now += 2000; f.setNow(now);
  f.runtime.tick({ force: true });
  for (let i = 0; i < 10 && native.length < 2; i++) await turn();
  assert.deepEqual(native, [AT, AT + 2000]);
  assert.equal(controller.control.currentTest.phase, 'restored');
  assert.equal(f.runtime.coordination, null, 'The worker is still held, so no economic result authorized the native duty');
  assert.equal(f.planner.calls[0].done, false);
  f.planner.complete(0); await first;
});

test('pending economic work does not let a deadline wakeup bypass lost native authority', async t => {
  const f = await fixture(t), controller = f.controllers.charger2;
  let updates = 0;
  controller.control.currentTest = { phase: 'active', expiresAt: AT + 2000 };
  controller.update = async () => { updates++; return structuredClone(controller.control); };
  const first = f.runtime.reconcile('charger2');
  await waitForCalls(f.planner, 1);
  for (let i = 0; i < 10; i++) await turn();
  f.setAuthority(false); f.setNow(AT + 2000);
  f.runtime.tick({ force: true });
  for (let i = 0; i < 10; i++) await turn();
  assert.equal(updates, 1, 'The authority check still precedes every native update');
  assert.equal(controller.control.currentTest.phase, 'active');
  assert.equal(f.runtime.coordination, null);
  f.planner.complete(0); await first;
});

for (const action of ['Charge now', 'Automatic OFF']) test(`${action} completes its native action while global planning and the peer are held`, async t => {
  const f = await fixture(t), item = f.runtime.chargers.charger1;
  const planning = f.runtime.updatePlan();
  await waitForCalls(f.planner, 1);
  let releasePeer, returned = false;
  const peer = new Promise(resolve => { releasePeer = resolve; });
  t.after(releasePeer);
  f.controllers.charger2.update = () => peer;
  const updates = [];
  f.controllers.charger1.update = async input => { updates.push(input); };
  const scope = { association: item.association, sessionId: item.request.sessionId, revision: item.request.revision };
  const work = (action === 'Charge now' ? f.runtime.chargeNow('charger1', scope)
    : f.runtime.setControl('charger1', { association: item.association, revision: item.controls.revision, enabled: false }))
    .then(() => { returned = true; });
  for (let i = 0; i < 20 && !returned; i++) await turn();
  assert.equal(updates.length, 1, 'Independent native action reaches the selected controller before a plan result');
  assert.equal(returned, true, 'The selected action does not wait for a different charger');
  if (action === 'Charge now') assert.equal(updates[0].chargeNow.connectedAt, AT);
  else assert.equal(updates[0].enabled, false);
  assert.equal(f.planner.calls[0].done, false);
  releasePeer(); await f.runtime.close(); await Promise.all([work, planning]);
});

test('returning to Automatic waits for its accepted plan but not the peer native flight', async t => {
  const f = await fixture(t), item = f.runtime.chargers.charger1;
  await f.runtime.write(() => f.runtime.refreshPlanningState(AT));
  item.request.chargeNow = true;
  let releasePeer, returned = false, acceptedPlan;
  const peer = new Promise(resolve => { releasePeer = resolve; });
  t.after(releasePeer);
  f.controllers.charger2.update = () => peer;
  f.controllers.charger1.update = async () => { acceptedPlan = await f.controllers.charger1.getPlan(); };
  const work = f.runtime.resume('charger1', { association: item.association,
    sessionId: item.request.sessionId, revision: item.request.revision }).then(() => { returned = true; });
  await waitForCalls(f.planner, 1);
  assert.equal(returned, false, 'Automatic scheduling still needs the selected current plan');
  assert.equal(acceptedPlan, undefined);
  f.planner.complete(0);
  for (let i = 0; i < 20 && !returned; i++) await turn();
  assert.ok(acceptedPlan?.periods.length);
  assert.equal(returned, true, 'Accepted selected scheduling is not held by the peer');
  releasePeer(); await f.runtime.close(); await work;
});

for (const action of ['Save', 'Use automatic']) test(`${action} can complete after its current publication while a later changed search is held`, async t => {
  const f = await fixture(t), item = f.runtime.chargers.charger1;
  await f.runtime.write(() => f.runtime.refreshPlanningState(AT));
  const calculate = f.runtime.calculatePlan.bind(f.runtime);
  let completed = 0, returned = false, nativeUpdates = 0;
  f.runtime.calculatePlan = async (...args) => {
    await calculate(...args);
    if (++completed === 1) {
      f.controllers.charger2.control.snapshot.limits.chargerA = 12;
      void f.runtime.updatePlan();
    }
  };
  f.controllers.charger1.control.takeover = { available: true, token: 'synthetic-foreground-takeover' };
  f.controllers.charger1.update = async input => {
    nativeUpdates++;
    if (input.takeover) f.controllers.charger1.control.takeover = { available: true,
      token: input.takeover, state: 'confirmed', attemptToken: input.takeover };
  };
  const scope = { association: item.association, sessionId: item.request.sessionId, revision: item.request.revision };
  const work = (action === 'Save'
    ? f.runtime.setSessionRequest('charger1', { scope: 'session', ...scope, changes: { minimumSoc: 85 } })
    : f.runtime.useAutomatic('charger1', { ...scope, controlRevision: item.controls.revision,
      takeoverToken: 'synthetic-foreground-takeover' })).then(() => { returned = true; });
  await waitForCalls(f.planner, 1);
  assert.equal(returned, false);
  f.planner.complete(0); await waitForCalls(f.planner, 2);
  for (let i = 0; i < 20 && !returned; i++) await turn();
  assert.ok(nativeUpdates > 0, 'The selected controller receives its accepted current request');
  assert.equal(returned, true, 'A later numerical search does not hold the completed selected action');
  assert.equal(f.planner.calls[1].done, false);
  assert.equal(f.runtime.coordination.requests.charger1.revision, item.request.revision);
  await f.runtime.close(); await work;
});

for (const boundary of ['close', 'controller', 'adapter generation']) test(`a queued peer failure cannot overwrite diagnostics after ${boundary}`, async t => {
  const f = await fixture(t), item = f.runtime.chargers.charger2;
  let reject, entered = false;
  const pending = new Promise((_resolve, rejectWork) => { reject = rejectWork; });
  f.controllers.charger2.update = async () => { entered = true; await pending; };
  f.runtime.reconcilePeers('charger1');
  for (let i = 0; i < 20 && !entered; i++) await turn();
  assert.equal(entered, true);
  if (boundary === 'close') await f.runtime.close();
  else if (boundary === 'controller') item.controller = { ...item.controller };
  else item.adapterGeneration++;
  item.error = 'current-owner-diagnostic';
  reject(new Error('Older peer work failed'));
  for (let i = 0; i < 10; i++) await turn();
  assert.equal(item.error, 'current-owner-diagnostic');
});

for (const scenario of [
  { name: 'new pause', kind: 'pause', interrupt: true },
  { name: 'original probe deadline', kind: 'probe', interrupt: true },
  { name: 'terminal probe still owing its return', kind: 'return', interrupt: true },
  { name: 'current restoration without a planning request', kind: 'test', noRequest: true, interrupt: true },
  { name: 'newly granted bounded probe', kind: 'start', interrupt: true },
  { name: 'probe not selected to allow charging', kind: 'probe', future: true, interrupt: false },
  { name: 'new probe after a manual instruction', kind: 'start', manual: true, interrupt: false },
  { name: 'new probe after Automatic OFF', kind: 'start', off: true, interrupt: false },
  { name: 'new probe after Charge now', kind: 'start', chargeNow: true, interrupt: false },
  { name: 'new probe after return supersession', kind: 'start', superseded: true, interrupt: false },
  { name: 'new probe from the previous connection', kind: 'start', previous: true, interrupt: false },
  { name: 'expired selected pause', kind: 'pause', expired: true, interrupt: false },
  { name: 'previous identification connection', kind: 'pause', previous: true, interrupt: false },
  { name: 'identification without a current request', kind: 'pause', noRequest: true, interrupt: false },
  { name: 'replaced native current-test session', kind: 'test', previous: true, interrupt: false },
]) test(`deadline wakeup respects the existing duty scope: ${scenario.name}`, async t => {
  const f = await fixture(t), item = f.runtime.chargers.charger2, controller = f.controllers.charger2;
  await f.runtime.write(() => f.runtime.refreshPlanningState(AT));
  // The native owner deliberately reports an in-flight device operation. The
  // runtime can request planning interruption, but cannot cancel that operation.
  let release, entered = false, interruptions = 0;
  const pending = new Promise(resolve => { release = resolve; });
  t.after(release);
  controller.update = async () => { entered = true; await pending; };
  controller.interruptPlanning = () => { interruptions++; return false; };
  controller.supportsIdentification = true;
  f.runtime.updatePlan = async () => {};
  const native = f.runtime.reconcile('charger2');
  for (let i = 0; i < 20 && !entered; i++) await turn();
  assert.equal(entered, true);
  const previous = { request: item.request, identification: item.identification, currentTest: controller.control.currentTest };
  const now = AT + 1000, connectedAt = scenario.previous ? AT - 1000 : AT;
  f.setNow(now);
  if (scenario.kind === 'test') controller.control.currentTest = { phase: 'active', connectedAt,
    sessionId: controller.control.session.sessionId, expiresAt: now };
  else {
    item.identification = advanceIdentification(null, { connectedAt, now: AT, available: true, connected: true });
    if (scenario.kind === 'pause') Object.assign(item.identification, { phase: 'pausing', action: 'pause',
      pauseUntil: scenario.expired ? now - 1 : now + 90_000 });
    else {
      item.identification.probe = { startedAt: AT, deadlineAt: scenario.future || scenario.kind === 'start' ? now + 2000 : now - 500,
        returnStartAt: AT + HOUR, endedAt: scenario.kind === 'return' ? now - 1 : null };
      if (scenario.future) item.identification.action = null;
      if (scenario.kind === 'start') item.identification.action = 'allow';
      if (scenario.superseded) item.identification.probe.returnSupersededAt = now;
      if (scenario.kind === 'return') Object.assign(item.identification, { phase: 'inconclusive', reason: 'pause-timeout',
        action: null, pauseUntil: now - 1 });
    }
  }
  if (scenario.noRequest) item.request = null;
  if (scenario.manual) controller.control.manual = { kind: 'stop' };
  if (scenario.off) item.controls.enabled = false;
  if (scenario.chargeNow) item.request.chargeNow = true;
  await f.runtime.tick({ force: true });
  assert.equal(interruptions, scenario.interrupt ? 1 : 0);
  assert.ok(item.reconcileFlight, 'Native RPC ownership remains until its owner completes it');
  if (scenario.kind === 'probe') assert.equal(f.runtime.boundaryAt, now + 2000,
    'The next bounded wakeup is armed without waiting for numerical publication');
  item.request = previous.request; item.identification = previous.identification;
  controller.control.currentTest = previous.currentTest;
  release(); await native;
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

test('a captured probe return needs no new calculation even after its pause window expired', async t => {
  const f = await fixture(t), item = f.runtime.chargers.charger1, returnStartAt = AT + HOUR;
  f.controllers.charger1.control.execution = null;
  item.request = { scope: `${item.association}:${AT}`, sessionId: `${item.association}:${AT}`, deadlineAt: AT + 2 * HOUR };
  item.identification = { id: 'synthetic-return-after-failed-plan', connectedAt: AT, phase: 'inconclusive', pauseUntil: AT + 70_000,
    probe: { startedAt: AT, deadlineAt: AT + 60_000, returnStartAt, endedAt: AT + 70_000 } };
  f.setNow(AT + 80_000);
  let calculations = 0;
  f.runtime.updatePlan = async () => { calculations++; throw Error('synthetic planning unavailable'); };
  const plan = await f.controllers.charger1.getPlan();
  assert.equal(plan.startAt, returnStartAt);
  assert.deepEqual(plan.periods, [{ startAt: returnStartAt, endAt: null }]);
  assert.equal(calculations, 0, 'The original physical obligation is already selected');
  assert.equal(Boolean(item.awaitingPlan), false);
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
