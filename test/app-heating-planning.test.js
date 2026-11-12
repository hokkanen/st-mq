import test from 'node:test';
import assert from 'node:assert/strict';
import { HeatingPlanning } from '../src/app/heating-planning.js';
import { chooseCycle } from '../src/control/planner.js';
import { heatingExplorerFixture } from './helpers/heating-explorer-fixture.js';
import { continuationInput } from '../src/control/heating-continuation.js';

function rig(t) {
  const requests = [];
  const engine = { suspended: false, allowed: true,
    automation: { features: { home: { enabled: true, revision: 1 } } },
    automationTarget: () => 'a'.repeat(64), canControl() { return this.allowed; },
    automationEnabled() { return this.automation.features.home.enabled; } };
  const service = { request(input) {
    return new Promise((resolve, reject) => requests.push({ input, resolve, reject }));
  }, async close() { for (const request of requests) request.resolve(null); } };
  const planner = new HeatingPlanning(engine, service);
  t.after(() => planner.close());
  const input = heatingExplorerFixture();
  return { engine, planner, input, requests, async complete(result = chooseCycle(input), index = requests.length - 1) {
    requests[index].resolve(result);
    await planner.pending?.promise;
  } };
}

for (const changedField of ['indoorC', 'reserveC', 'slabC']) test(`continuation completion cannot cancel through missing feeds or changed ${changedField}`, async t => {
  const r = rig(t), plan = chooseCycle(r.input).plan;
  const args = continuationInput(r.input, plan);
  if (changedField === 'slabC') {
    args.model = { ...args.model, floor: { ...args.model.floor, enabled: true } };
    args.initialState.slabC = 21;
  }
  assert.equal(r.planner.continue(args, plan.schedule, 'accepted-owner'), null);
  r.requests[0].resolve({ continuation: { schedule: plan.schedule, end: true,
    continuedCostCents: 10, stoppedCostCents: 5 } });
  await r.planner.continuation.promise;
  assert.equal(r.planner.continue({ ...args, freshComparison: false }, plan.schedule, 'accepted-owner'), null);
  const changed = { ...args, now: args.now + 60_000,
    initialState: { ...args.initialState, [changedField]: args.initialState[changedField] + 1 } };
  assert.equal(r.planner.continue(changed, plan.schedule, 'accepted-owner'), null);
  assert.equal(r.requests.length, 2, 'Changed state requests a fresh comparison instead of applying an old exit');
  assert.deepEqual(plan.schedule, r.requests[0].input.continuation.schedule);
});

for (const delay of [30_000, 120_000])
test(`a delayed preheat stop preserves its executed prefix and original deadline (${delay}ms)`, async t => {
  const r = rig(t), plan = chooseCycle(r.input).plan;
  const start = r.input.now;
  const schedule = { ...plan.schedule, preheatStart: start, preheatEnd: start + 60_000,
    reductionStart: start + 15 * 60_000 };
  const original = structuredClone(schedule);
  const args = continuationInput(r.input, { ...plan, schedule });
  assert.equal(r.planner.continue(args, schedule, 'accepted-owner'), null);
  r.requests[0].resolve({ continuation: { schedule: { ...schedule, preheatEnd: start }, end: false,
    continuedCostCents: 10, stoppedCostCents: 11 } });
  await r.planner.continuation.promise;
  const result = r.planner.continue({ ...args, now: start + delay }, schedule, 'accepted-owner');
  assert.equal(result.schedule.preheatEnd, Math.min(start + delay, original.preheatEnd));
  assert.deepEqual(schedule, original, 'original accepted timing remains intact');
  assert.equal(result.schedule.reductionStart, original.reductionStart);
  assert.equal(result.schedule.reductionEnd, original.reductionEnd);
});

test('background search returns Normal immediately and revalidates its plan with current measurements', async t => {
  const r = rig(t);
  let updates = 0;
  r.engine.requestUpdate = () => { updates++; };
  assert.equal(r.planner.choose(r.input).phase, 'normal');
  assert.equal(r.requests.length, 1);
  const result = chooseCycle(r.input);
  assert.ok(result.plan, 'Synthetic independent price spike admits a reduction');
  await r.complete(result);
  assert.equal(updates, 1, 'A completed search requests guarded adoption without waiting for the minute timer');
  const updated = structuredClone(r.input);
  updated.now += 30_000;
  updated.observations.indoor.value = 21.1;
  updated.observations.indoor.observedAt = updated.now;
  const adopted = r.planner.choose(updated);
  assert.ok(adopted.plan);
  assert.equal(adopted.plan.generatedAt, updated.now);
  assert.equal(adopted.plan.initialState.indoorC, 21.1);
  assert.equal(adopted.phase, 'reduction');
});

for (const change of ['stale indoor', 'missing prices', 'native permission', 'trial budget']) {
  test(`worker result cannot bypass current ${change}`, async t => {
    const r = rig(t);
    r.planner.choose(r.input);
    const result = chooseCycle(r.input);
    if (change === 'trial budget') result.plan.trial = true;
    await r.complete(result);
    const current = structuredClone(r.input);
    if (change === 'stale indoor') current.observations.indoor.stale = true;
    if (change === 'missing prices') current.prices = [];
    if (change === 'native permission') current.equipment.externalChangeRevision = 1;
    if (change === 'trial budget') current.trialBudgetRemainingCents = 0;
    assert.equal(r.planner.choose(current).plan, null);
  });
}

for (const change of ['pause', 'authority', 'configuration', 'model', 'sensor correction', 'fireplace correction', 'expiry']) {
  test(`completed Home search is fenced after ${change}`, async t => {
    const r = rig(t);
    r.planner.choose(r.input);
    await r.complete();
    const current = structuredClone(r.input);
    if (change === 'pause') r.engine.automation.features.home.enabled = false;
    if (change === 'authority') r.engine.allowed = false;
    if (change === 'configuration') current.config.maxReductionHours = 1;
    if (change === 'model') current.checkpoint.model.parameters.lossPerHour *= 2;
    if (change === 'sensor correction') current.checkpoint.sensorRevision = 1;
    if (change === 'fireplace correction') current.checkpoint.fireplaceRevision = 1;
    if (change === 'expiry') current.now += 120_001;
    assert.equal(r.planner.choose(current).plan, null);
  });
}

test('intervening manual control, closure and superseded requests cannot resurrect search results', async t => {
  const r = rig(t);
  r.planner.choose(r.input);
  const original = r.planner.pending.promise;
  r.planner.invalidate();
  r.planner.choose(r.input);
  r.requests[0].resolve(chooseCycle(r.input));
  await original;
  assert.equal(r.planner.completed, null);
  assert.equal(r.requests.length, 2);
  await r.planner.close();
  assert.equal(r.planner.choose(r.input).plan, null);
});

test('worker failure keeps Normal and cannot trigger an immediate retry loop', async t => {
  const r = rig(t);
  r.planner.choose(r.input);
  r.requests[0].reject(new Error('Synthetic worker failure'));
  await r.planner.pending.promise;
  assert.deepEqual(r.planner.choose(r.input).reasons, ['heating-planning-unavailable']);
  assert.equal(r.requests.length, 1);
});

test('pending schedules remain available while periodic fresh searches replace them', async t => {
  const r = rig(t);
  r.input.prices.forEach((row, i) => { row.allInCentsPerKWh = i >= 8 && i < 12 ? 100 : 1; });
  const first = chooseCycle(r.input);
  assert.ok(first.plan.schedule.reductionStart > r.input.now);
  r.planner.choose(r.input);
  await r.complete(first);
  let incumbent = r.planner.choose(r.input).plan;
  for (let minute = 1; minute < 15; minute++) {
    const current = { ...r.input, now: r.input.now + minute * 60_000 };
    assert.equal(r.planner.choose(current, incumbent).plan, incumbent);
  }
  assert.equal(r.requests.length, 1, 'Ordinary controller ticks do not repeat the search');
  const fresh = structuredClone(r.input);
  fresh.now += 15 * 60_000;
  fresh.prices.forEach((row, i) => { if (i >= 16 && i < 20) row.allInCentsPerKWh = 300; });
  assert.equal(r.planner.choose(fresh, incumbent).plan, incumbent);
  assert.equal(r.requests.length, 2);
  assert.equal(r.requests[1].input.incumbentPlan, incumbent);
  const replacement = chooseCycle({ ...fresh, incumbentPlan: incumbent });
  await r.complete(replacement);
  const adopted = r.planner.choose(fresh, incumbent);
  assert.ok(adopted.plan);
  assert.notDeepEqual(adopted.plan.schedule, incumbent.schedule, 'A better new opportunity replaces the waiting schedule');
  assert.equal(adopted.plan.generatedAt, fresh.now);
  assert.equal(r.requests.length, 2);
});

test('numerical source revisions refresh early with a bounded rate; receipt clocks and native chatter do not', async t => {
  const r = rig(t);
  r.planner.choose(r.input);
  await r.complete({ action: 'normal', phase: 'normal', reasons: ['normal-operation-preferred'], plan: null });
  r.planner.choose(r.input);
  const current = structuredClone(r.input);
  current.now += 60_000;
  current.prices.forEach(row => { row.fetchedAt = current.now; row.issuedAt = current.now; });
  current.forecast.forEach(row => { row.fetchedAt = current.now; row.issuedAt = current.now; });
  current.equipment.integral = -50; current.equipment.supplyC = 36;
  current.checkpoint.baselineC += .001;
  r.planner.choose(current);
  assert.equal(r.requests.length, 1);
  current.prices[2].allInCentsPerKWh += 10;
  r.planner.choose(current);
  assert.equal(r.requests.length, 2);
  await r.complete({ action: 'normal', phase: 'normal', reasons: ['normal-operation-preferred'], plan: null });
  r.planner.choose(current);
  current.now += 1000; current.forecast[2].outdoorC -= 1;
  r.planner.choose(current);
  assert.equal(r.requests.length, 2, 'Changed snapshots cannot create a per-tick search loop');
  current.now += 59_000;
  r.planner.choose(current);
  assert.equal(r.requests.length, 3);
});

test('no-plan results use the periodic cadence and failures retry after a minute', async t => {
  const r = rig(t);
  const none = { action: 'normal', phase: 'normal', reasons: ['normal-operation-preferred'], plan: null,
    evaluation: { baselineCostCents: 123, candidates: 20 } };
  r.planner.choose(r.input); await r.complete(none); r.planner.choose(r.input);
  const idle = r.planner.choose({ ...r.input, now: r.input.now + 3 * 60_000 });
  assert.equal(idle.evaluation, undefined, 'The idle cache does not relabel old numerical search results as current');
  assert.equal(r.requests.length, 1, 'An empty result does not run a search every two minutes');
  const later = { ...r.input, now: r.input.now + 15 * 60_000 };
  r.planner.choose(later);
  r.requests[1].reject(new Error('Synthetic worker failure')); await r.planner.pending.promise;
  assert.deepEqual(r.planner.choose(later).reasons, ['heating-planning-unavailable']);
  r.planner.choose({ ...later, now: later.now + 59_999 });
  assert.equal(r.requests.length, 2);
  r.planner.choose({ ...later, now: later.now + 60_000 });
  assert.equal(r.requests.length, 3);
});

test('changed tariff snapshots fence completed results before adoption', async t => {
  const r = rig(t);
  r.planner.choose(r.input); await r.complete();
  const current = structuredClone(r.input);
  current.prices[0].allInCentsPerKWh += 1;
  assert.equal(r.planner.choose(current).plan, null);
});

test('a failed refresh preserves the still-valid pending schedule', async t => {
  const r = rig(t);
  r.input.prices.forEach((row, i) => { row.allInCentsPerKWh = i >= 8 && i < 12 ? 100 : 1; });
  const incumbent = chooseCycle(r.input).plan;
  assert.equal(r.planner.choose(r.input, incumbent).plan, incumbent);
  r.requests[0].reject(new Error('Synthetic refresh failure')); await r.planner.pending.promise;
  assert.equal(r.planner.choose(r.input, incumbent).plan, incumbent);
});

test('a due automatic cycle uses an already completed fresh result, but never waits for search', async t => {
  const r = rig(t);
  r.input.prices.forEach((row, i) => { row.allInCentsPerKWh = i >= 8 && i < 12 ? 100 : 1; });
  const selected = chooseCycle(r.input);
  const old = structuredClone(selected.plan);
  // A synthetic due incumbent isolates the controller's ready-result ordering.
  old.schedule.preheatStart = old.schedule.preheatEnd = old.schedule.reductionStart = r.input.now;
  old.schedule.reductionEnd = r.input.now + 15 * 60_000;
  r.planner.choose(r.input); await r.complete(selected);
  const fresh = r.planner.choose(r.input, old);
  assert.deepEqual(fresh.plan.schedule, selected.plan.schedule);
  assert.equal(fresh.phase, 'normal', 'The completed better future choice is adopted before starting the old cycle');
  r.planner.invalidate();
  const due = r.planner.choose(r.input, old);
  assert.equal(due.plan, old);
  assert.equal(due.phase, 'reduction');
  assert.equal(r.requests.length, 1, 'The due cycle starts without launching or waiting for another search');
});

test('small learned-reference drift in effective settings does not repeatedly search, while explicit edits do', async t => {
  const r = rig(t);
  r.engine.settings = { ...r.input.settings, comfort: { ...r.input.settings.comfort, targetC: null } };
  r.planner.choose(r.input);
  await r.complete({ action:'normal',phase:'normal',reasons:['normal-operation-preferred'],plan:null });
  r.planner.choose(r.input);
  const current = structuredClone(r.input);
  for (let minute=1;minute<15;minute++) {
    current.now = r.input.now+minute*60_000;
    current.checkpoint.baselineC += .001;
    current.settings.comfort.targetC = current.checkpoint.baselineC;
    r.planner.choose(current);
  }
  assert.equal(r.requests.length, 1, 'The runtime copies its slowly learned reference into the effective target');
  r.engine.settings.comfort.targetC = current.settings.comfort.targetC = 21.1;
  r.planner.choose(current);
  assert.equal(r.requests.length, 2, 'An explicit owner target change still refreshes promptly');
});
