import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { CycleTracker } from '../src/app/cycles.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { evaluateCycle } from '../src/control/planner.js';

const hour = 3_600_000, now = Date.parse('2026-11-05T12:00:00Z');
function fixture(t, { exposure = .248, reserved = exposure, cap = 150, daily = 300,
  previous = 0, reviewed = false, startedAt = now, deferStart = false } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const config = { maxTrialCostCents: cap, trialBudgetCentsPerDay: daily };
  const tracker = new CycleTracker({ store, input: 'synthetic', config });
  const intervals = Array.from({ length: 32 }, (_, i) => ({ start: startedAt + i * hour / 4,
    end: startedAt + (i + 1) * hour / 4, outdoorC: 10, solarRadiationWm2: 0, price: 5 }));
  const schedule = { preheatStart: startedAt, preheatEnd: startedAt, reductionStart: startedAt,
    reductionEnd: startedAt + 2 * hour, roomBoostC: 0 };
  const args = { model: initialAdaptiveModel(), initialState: { indoorC: 21, reserveC: 21 },
    targetC: 21, intervals, config };
  const plan = { ...args, schedule, reference: null, trial: true, trialAllowanceCents: reserved,
    trialSafety: { costExposureCents: exposure }, prediction: evaluateCycle({ ...args, schedule }),
    referencePrediction: evaluateCycle(args), occupancy: { mode: 'occupied' } };
  if (reviewed) plan.userTrial = { limits: { maxTrialCostCents: cap } };
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(startedAt);
  store.setState('trials:synthetic', { date, reservedCents: previous });
  const begin = () => tracker.start(plan, { timestamp: startedAt, indoorC: 21, phase: 'reduction' }, startedAt);
  if (!deferStart) begin();
  return { store, tracker, plan, date, begin, ledger: () => store.getState('trials:synthetic') };
}

test('small forecast changes grow a reservation inside the authorized cap without rewriting the original plan', t => {
  const r = fixture(t), original = structuredClone(r.tracker.active().plan);
  assert.equal(r.tracker.reserveTrialExposure(.249), true);
  assert.equal(r.tracker.reserveTrialExposure(.249), true);
  assert.equal(r.ledger().reservedCents, .249);
  assert.equal(r.tracker.active().trialBudget.reservedCents, .249);
  assert.deepEqual(r.tracker.active().plan, original);
  const restored = new CycleTracker({ store: r.store, input: 'synthetic', config: r.tracker.config });
  assert.equal(restored.reserveTrialExposure(.250), true);
  assert.equal(r.ledger().reservedCents, .250);
  assert.equal(r.tracker.active().adjustments, undefined, 'Budget updates are not schedule changes');
});

test('falling estimates do not refund exposure that may already be incurred or permit reuse of the same cap', t => {
  const r = fixture(t, { exposure: 10, cap: 12 });
  assert.equal(r.tracker.reserveTrialExposure(5), true);
  assert.equal(r.ledger().reservedCents, 10);
  assert.equal(r.tracker.reserveTrialExposure(7), true);
  assert.equal(r.ledger().reservedCents, 12);
  assert.equal(r.tracker.reserveTrialExposure(7.001), false);
  assert.equal(r.ledger().reservedCents, 12);
  assert.equal(r.tracker.active().trialBudget.lastExposureCents, 7);
});

test('continuation includes previous daily reservations and rejects only the unaffordable increase', t => {
  const r = fixture(t, { exposure: 1, reserved: 2, cap: 150, daily: 150, previous: 147 });
  assert.equal(r.tracker.reserveTrialExposure(2), true);
  assert.equal(r.ledger().reservedCents, 150);
  assert.equal(r.tracker.active().trialBudget.reservedCents, 3);
  assert.equal(r.tracker.reserveTrialExposure(2.01), false);
  assert.equal(r.ledger().reservedCents, 150);
});

test('explicit reviewed budgets stay separate from the automatic daily ledger', t => {
  const r = fixture(t, { reviewed: true, cap: 400, daily: 0 });
  assert.equal(r.tracker.reserveTrialExposure(399), true);
  assert.equal(r.ledger().reservedCents, 0);
  assert.equal(r.tracker.reserveTrialExposure(401), false);
  assert.equal(r.ledger().reservedCents, 0);
});

test('one-cycle approval without an edited budget still uses automatic allowance', t => {
  const r = fixture(t, { exposure: 1, cap: 10, daily: 10, previous: 8, deferStart: true });
  r.plan.userTrial = { limits: { maxDropC: 2 } }; r.begin();
  assert.equal(r.tracker.reserveTrialExposure(2), true);
  assert.equal(r.ledger().reservedCents, 10);
  assert.equal(r.tracker.reserveTrialExposure(2.1), false);
});

test('zero remains a valid allowance and unknown exposure never becomes free learning', t => {
  const r = fixture(t, { exposure: 0, cap: 0, daily: 0 });
  assert.equal(r.tracker.reserveTrialExposure(0), true);
  for (const value of [.001, null, undefined, NaN, Infinity, -1, '0'])
    assert.equal(r.tracker.reserveTrialExposure(value), false);
  assert.equal(r.ledger().reservedCents, 0);
});

test('a midnight-spanning cycle retains its original Finnish funding day', t => {
  const startedAt = Date.parse('2026-11-05T21:59:00Z'), nextDay = startedAt + 2 * 60_000;
  const r = fixture(t, { exposure: 1, startedAt });
  assert.equal(r.tracker.reserveTrialExposure(2), true);
  assert.equal(r.ledger().date, r.date);
  assert.equal(r.ledger().reservedCents, 2);
  assert.equal(r.tracker.budget(nextDay), 0, 'An active cycle still blocks another experiment');
  const cycle = r.tracker.active(); cycle.status = 'incomplete'; cycle.endedAt = nextDay; r.tracker.save(cycle);
  assert.equal(r.tracker.budget(nextDay), 300);
  assert.equal(r.tracker.budget(startedAt), 298);
});

test('ledger and active-cycle reservation roll back together after a failed save', t => {
  const r = fixture(t), cycle = structuredClone(r.tracker.active()), ledger = r.ledger();
  const save = r.store.cycle;
  r.store.cycle = () => { throw new Error('Synthetic cycle save failure'); };
  try { assert.throws(() => r.tracker.reserveTrialExposure(1), /Synthetic/); }
  finally { r.store.cycle = save; }
  assert.deepEqual(r.tracker.active(), cycle);
  assert.deepEqual(r.ledger(), ledger);
});

test('a failed initial cycle save cannot consume daily allowance or publish a started event', t => {
  const r = fixture(t, { deferStart: true, previous: 20 }), ledger = r.ledger();
  const save = r.store.cycle;
  r.store.cycle = () => { throw new Error('Synthetic initial cycle save failure'); };
  try { assert.throws(() => r.begin(), /Synthetic/); }
  finally { r.store.cycle = save; }
  assert.equal(r.tracker.active(), null);
  assert.deepEqual(r.ledger(), ledger);
  assert.equal(r.store.events().some(event => event.type === 'cycle-started'), false);
});

test('missing or damaged reservation state does not silently grant more allowance', t => {
  const r = fixture(t);
  r.store.setState('trials:synthetic', { date: r.date, reservedCents: null });
  assert.equal(r.tracker.reserveTrialExposure(.249), false);
  const cycle = r.tracker.active(); cycle.status = 'incomplete'; cycle.endedAt = now + hour; r.tracker.save(cycle);
  assert.equal(r.tracker.budget(now + hour), null);
});
