import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { evaluateCycle, evaluateCyclePair, economicAdmission, chooseCycle, revalidatePlan,
  trialCostExposure } from '../src/control/planner.js';
import { reviseHeatingCycle } from '../src/control/heating-continuation.js';
import { exploreHeatingPlan } from '../src/control/heating-explorer.js';
import { Store } from '../src/storage/store.js';
import { CycleTracker } from '../src/app/cycles.js';

const HOUR = 3_600_000, now = Date.parse('2026-02-01T08:03:17Z');
function fixture() {
  const model = initialAdaptiveModel({ heatPumpModelConfirmed: true });
  const intervals = Array.from({ length: 48 }, (_, i) => ({ start: now + i * HOUR / 4,
    end: now + (i + 1) * HOUR / 4, outdoorC: 8, solarRadiationWm2: 20, price: 5 }));
  const schedule = { preheatStart: now, preheatEnd: now, reductionStart: now,
    reductionEnd: now + 17 * 60_000, roomBoostC: 0, treatmentKey: 'reduction-only-v1' };
  const args = { intervals, model, initialState: { indoorC: 21.5, reserveC: 23, slabC: 21.3 },
    targetC: 21, maxDropC: 5, maxRiseC: 5, occupancy: { mode: 'occupied' },
    config: { learningTrials: false, maxReductionHours: 4, maxPreheatHours: 2 },
    equipment: { supplyC: 35, brineC: 0, nativeAuxAllowed: false, h66Available: true,
      preheatAvailable: false, compressorOn: 0, dhwRouting: 0 } };
  const input = { now, observations: { indoor: { value: 21.5, observedAt: now } },
    prices: intervals.map(row => ({ ...row, allInCentsPerKWh: row.price })),
    forecast: intervals.map(row => ({ ...row, issuedAt: now })),
    checkpoint: { model, baselineC: 21 }, thermalState: args.initialState,
    settings: { comfort: { targetC: 21, maxDropC: 5, maxRiseC: 5 },
      occupancy: args.occupancy, savingsStrategy: 'savings' }, config: args.config, equipment: args.equipment };
  return { args, schedule, input };
}

test('an idle reduction has exactly zero benefit on shared integration boundaries', () => {
  for (const price of [5, -5]) {
    const { args, schedule } = fixture();
    args.intervals.forEach(row => { row.price = price; });
    const original = structuredClone({ args, schedule });
    const pair = evaluateCyclePair({ ...args, schedule });
    assert.notEqual(evaluateCycle(args).costCents, pair.prediction.costCents,
      'Separate phase boundaries would invent a cost difference in this fixture');
    assert.notEqual(pair.prediction.costCents, 0, 'The horizon includes later Normal heating');
    assert.equal(pair.prediction.costCents, pair.referencePrediction.costCents);
    assert.deepEqual(pair.prediction.endState, pair.referencePrediction.endState);
    assert.deepEqual(pair.prediction.trajectory.map(row => row.at), pair.referencePrediction.trajectory.map(row => row.at));
    assert(pair.prediction.trajectory.filter(row => row.phase !== 'normal').every(row => row.powerKw === 0));
    const admission = economicAdmission({ ...pair, args, schedule });
    assert.equal(admission.benefitCents, 0);
    assert.equal(admission.admitted, false);
    assert.deepEqual({ args, schedule }, original, 'Comparisons do not rewrite inputs or original forecasts');
  }
});

test('both treatment schedules and an explicit recovery deadline share one time tape', () => {
  const { args, schedule } = fixture();
  const reference = { ...schedule, reductionEnd: now + 19 * 60_000, recoveryHoldUntil: now + 71 * 60_000 };
  schedule.recoveryHoldUntil = now + 68 * 60_000;
  const { prediction, referencePrediction } = evaluateCyclePair({ ...args, schedule }, reference);
  const times = prediction.trajectory.map(row => row.at);
  assert.deepEqual(times, referencePrediction.trajectory.map(row => row.at));
  for (const boundary of [schedule.reductionEnd, schedule.recoveryHoldUntil, reference.reductionEnd, reference.recoveryHoldUntil])
    assert(times.includes(boundary));
  assert.equal(prediction.costCents, referencePrediction.costCents);
});

test('trial exposure retains a different carried reference state on the shared tape', () => {
  const { args, schedule } = fixture();
  const referenceState = { indoorC: 20, reserveC: 20, slabC: 20 };
  const { prediction, referencePrediction } = evaluateCyclePair({ ...args, schedule, referenceInitialState: referenceState }, null,
    { initialState: referenceState });
  assert.notEqual(prediction.costCents, referencePrediction.costCents,
    'A real observed thermal debt cannot disappear when aligning numerical steps');
  assert.deepEqual(prediction.trajectory.map(row => row.at), referencePrediction.trajectory.map(row => row.at));
  assert.equal(trialCostExposure({ ...args, schedule }).costExposureCents, 0);
});

test('pending-plan admission and the explorer reject the same idle economic cycle', () => {
  const { args, schedule, input } = fixture();
  const plan = { ...args, schedule, reference: null, trial: false };
  const checked = revalidatePlan({ ...input, plan });
  assert.equal(checked.valid, false);
  assert.equal(checked.reason, 'scheduled-cycle-no-longer-admissible');
  const explored = exploreHeatingPlan({ ...input, currentPlan: plan }, {}, { includeOpportunities: false });
  assert.equal(explored.current.estimatedBenefitCents, 0);
  assert.equal(explored.current.economics.admitted, false);
  assert.equal(explored.comparison.additionalBenefitCents, 0);
});

test('new cycle definitions freeze the paired forecast without altering older definitions', t => {
  const { args, schedule } = fixture();
  const store = new Store(':memory:'); t.after(() => store.close());
  const tracker = new CycleTracker({ store, input: 'synthetic', config: args.config });
  const cycle = tracker.start({ ...args, schedule, reference: null, trial: false },
    { timestamp: now, phase: 'reduction', indoorC: args.initialState.indoorC }, now);
  assert.equal(cycle.plan.prediction.costCents, cycle.plan.referencePrediction.costCents);
  assert.equal(cycle.originalPrediction.costCents, cycle.plan.prediction.costCents);
  const saved = store.db.prepare('SELECT payload FROM learning_cycle_definitions WHERE id=?').get(cycle.id).payload;
  new CycleTracker({ store, input: 'synthetic', config: args.config }).active();
  assert.equal(store.db.prepare('SELECT payload FROM learning_cycle_definitions WHERE id=?').get(cycle.id).payload, saved);
});

test('unchanged demand cannot start or economically cancel cycles through numerical differences', () => {
  const { args, schedule, input } = fixture();
  args.model.equipmentResponse.phases.reduction = { ratio: 1, trainingEpisodes: 3, treatmentKey: 'reduction-only-v1' };
  assert.equal(chooseCycle(input).plan, null);
  const comparison = reviseHeatingCycle({ args: { ...args, now, freshComparison: true }, schedule });
  assert.equal(comparison.end, false);
  assert.equal(comparison.continuedCostCents, comparison.stoppedCostCents);
  assert.deepEqual(comparison.schedule, schedule);
});
