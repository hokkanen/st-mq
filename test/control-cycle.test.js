import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { CycleTracker } from '../src/app/cycles.js';
import { initialAdaptiveModel, updateAdaptiveEpisode } from '../src/control/adaptive-learning.js';
import { evaluateCycle, chooseCycle, revalidatePlan } from '../src/control/planner.js';

const HOUR = 3600000, start = Date.parse('2026-01-01T00:00:00Z');
const intervals = (hours = 8, { outdoorC = 0, solarRadiationWm2 = 0, price = i => i < 2 ? 100 : 5 } = {}) =>
  Array.from({ length: hours * 4 }, (_, i) => ({ start: start + i * HOUR / 4,
    end: start + (i + 1) * HOUR / 4, outdoorC, solarRadiationWm2, price: price(i) }));
const schedule = { preheatStart: start, preheatEnd: start, reductionStart: start,
  reductionEnd: start + HOUR / 2, roomBoostC: 0 };
const common = extra => ({ model: initialAdaptiveModel(), initialState: { indoorC: 21, reserveC: 21 },
  targetC: 21, intervals: intervals(), ...extra });
function fixture(t, extra = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const tracker = new CycleTracker({ store, input: 'synthetic', config: { recoveryTimeoutHours: 8 } });
  const args = common(extra);
  const plan = { ...args, schedule: { ...schedule }, reference: null, referenceLabel: 'continuous normal operation',
    occupancy: { mode: 'occupied' }, maxDropC: 1,
    prediction: evaluateCycle({ ...args, schedule }), referencePrediction: evaluateCycle(args) };
  return { store, tracker, plan };
}
const sample = (timestamp, changes = {}) => ({ timestamp, indoorC: 21.5, outdoorC: 0,
  solarRadiationWm2: 0, indoorTrendCPerHour: 0, phase: timestamp < schedule.reductionEnd ? 'reduction' : 'recovery',
  powerKw: 2, compressorDuty: 0.5, compressorPowerKw: 3, compressorActivityObserved: true,
  thermalCompressorDuty:0.5,thermalAuxKw:0,
  auxiliaryObserved: true, auxiliaryRouteKnown: true, auxKw: 0, auxRoute: null, energyBasis: 'estimated',
  ...changes });
function finish(tracker, changes = {}) {
  let result;
  for (let i = 1; i <= 12 && tracker.active(); i++) result = tracker.record(sample(start + i * HOUR / 4, changes),
    start + i * HOUR / 4, { thermalState: { reserveC: 21.5 } }) ?? result;
  return result;
}

test('recovery accounting stops once the room and reserve regain comparable normal operation', () => {
  const short = evaluateCycle(common({ schedule, intervals: intervals(4) }));
  const long = evaluateCycle(common({ schedule, intervals: intervals(48) }));
  assert.ok(short.completeRecoveryPredicted);
  assert.equal(short.recoveredAt, long.recoveredAt);
  assert.equal(short.recoveryCostCents, long.recoveryCostCents);
  assert.equal(short.recoveryEnergyKwh, long.recoveryEnergyKwh);
  assert.ok(long.trajectory.filter(x => x.at > long.recoveredAt).every(x => x.phase === 'normal'));
  const model = initialAdaptiveModel(); model.energy.recoveryMultiplier = 3;
  const expensive = evaluateCycle(common({ schedule, model, intervals: intervals(4) }));
  assert.equal(expensive.recoveryCostCents, short.recoveryCostCents, 'Legacy recovery multiplier cannot override physical source-map electricity');
  assert.equal(expensive.recoveredAt, short.recoveredAt, 'Electrical inefficiency is not extra delivered heat');
});

test('unvalidated bootstrap cannot bypass disabled learning trials even with native controls', () => {
  const choose = (rows, equipment = {}) => chooseCycle({ now: start,
    observations: { indoor: { value: 21, observedAt: start } },
    prices: rows.map(x => ({ ...x, allInCentsPerKWh: x.price })),
    forecast: rows.map(x => ({ ...x, issuedAt: start })),
    checkpoint: { model: initialAdaptiveModel(), baselineC: 21 },
    settings: { comfort: { targetC: 21, maxDropC: 1 }, occupancy: { mode: 'occupied' } },
    config: { learningTrials: false }, equipment });
  for (const equipment of [{},{h66Available:true,preheatAvailable:true}]) {
    const selected = choose(intervals(24),equipment);
    assert.equal(selected.phase,'normal');assert.equal(selected.plan,null);
    assert.deepEqual(selected.reasons,['awaiting-tariff-response-evidence']);
  }
  const warm = choose(intervals(8, { outdoorC: 30, price: i => i < 8 ? -100 : 100 }),
    { h66Available: true, preheatAvailable: true });
  assert.equal(warm.plan, null, 'ROOM boost must not create the demand used to justify DHWR heat credit');
});

test('native integral and supply trends stay bounded to near-term evidence', () => {
  const result = evaluateCycle(common({ initialState: { indoorC: 21, reserveC: 21, integral: -100 },
    equipment: { integralTrendPerHour: -200, supplyShortfallC: 2, supplyShortfallTrendPerHour: 4 },
    config: { compressorIntegralA1: -150, compressorHysteresisC: 5 } }));
  assert.equal(result.trajectory[0].integral, -150);
  assert.equal(result.trajectory[0].supplyShortfallC, 3);
  assert.equal(result.trajectory[0].nativeCompressorDemand, true);
  assert.ok(result.trajectory.filter(x => x.at > start + HOUR).every(x => x.integral === null && x.supplyShortfallC === null));
});

test('missing solar over a 48-hour horizon still permits a bounded startup trial', () => {
  const rows = intervals(48, { solarRadiationWm2: null, price: () => 10 });
  const decision = chooseCycle({ now: start, observations: { indoor: { value: 21, observedAt: start } },
    prices: rows.map(x => ({ ...x, allInCentsPerKWh: x.price })),
    forecast: rows.map(x => ({ ...x, issuedAt: start })),
    checkpoint: { model: initialAdaptiveModel(), baselineC: 21,health:{usableSamples:4} },
    settings: { comfort: { targetC: 21, maxDropC: 1 }, occupancy: { mode: 'occupied' } },
    thermalState: { reserveC: 25.725 }, equipment:{compressorOn:1,dhwRouting:0},trialBudgetRemainingCents: 100 });
  assert.equal(decision.phase, 'reduction');
  assert.equal(decision.plan.trial, true);
  assert.ok(decision.plan.schedule.reductionEnd - decision.plan.schedule.reductionStart <= HOUR / 2);
  assert.ok(decision.plan.trialAllowanceCents <= 50);
  assert.equal(decision.plan.trialSafety.comfortSafe,true);
});

test('cycle selection and revalidation accept old indoor values without renewing their timestamps', () => {
  const rows = intervals(48, { solarRadiationWm2: null, price: () => 10 });
  const args = { now: start, observations: { indoor: { value: 21, observedAt: start - 7 * 24 * HOUR,
    stale: false, needsAttention: true, held: true } },
    prices: rows.map(row => ({ ...row, allInCentsPerKWh: row.price })),
    forecast: rows.map(row => ({ ...row, issuedAt: start })),
    checkpoint: { model: initialAdaptiveModel(), baselineC: 21, health: { usableSamples: 4 } },
    settings: { comfort: { targetC: 21, maxDropC: 1 }, occupancy: { mode: 'occupied' } },
    thermalState: { reserveC: 25.725 }, equipment: { compressorOn: 1, dhwRouting: 0 }, trialBudgetRemainingCents: 100 };
  const decision = chooseCycle(args);
  assert.equal(decision.phase, 'reduction');
  assert.equal(revalidatePlan({ ...args, plan: decision.plan }).valid, true);
  assert.equal(args.observations.indoor.observedAt, start - 7 * 24 * HOUR);
  args.observations.indoor.stale = true;
  assert.equal(chooseCycle(args).phase, 'normal');
  assert.equal(revalidatePlan({ ...args, plan: decision.plan }).reason, 'scheduled-cycle-observations-stale');
});

test('cycle accounting splits published price boundaries without duplicating coverage or stored trajectories', t => {
  const rows = intervals(8, { price: i => i === 0 ? 10 : 30 });
  const { tracker } = fixture(t, { intervals: rows });
  const plan = fixturePlan(rows);
  tracker.start(plan, sample(start + HOUR / 6, { priceCents: 10, priceStart: start, priceEnd: start + HOUR / 4 }), start + HOUR / 6);
  tracker.record(sample(start + HOUR / 3), start + HOUR / 3, { thermalState: { reserveC: 21.5 } });
  const cycle = tracker.active();
  assert.equal(cycle.plan.prediction.trajectory, undefined);
  assert.equal(cycle.plan.referencePrediction.trajectory, undefined);
  assert.equal(cycle.observations.length, 2);
  assert.ok(Math.abs(cycle.actual.coveredHours - 1 / 6) < 1e-10);
  assert.ok(Math.abs(cycle.actual.costCents - (2 * 10 / 12 + 2 * 30 / 12)) < 1e-10);
  assert.equal(cycle.observations[0].priceBasis, 'applicable-observed-quote');
  assert.equal(cycle.observations[1].priceBasis, 'frozen-published-price');
});
function fixturePlan(rows) {
  const args = common({ intervals: rows });
  return { ...args, schedule: { ...schedule }, reference: null, referenceLabel: 'continuous normal operation',
    prediction: evaluateCycle({ ...args, schedule }), referencePrediction: evaluateCycle(args) };
}

test('completed-cycle profit uses the same elapsed period and keeps DHW auxiliary outside the space-auxiliary subgroup', t => {
  const { store, tracker, plan } = fixture(t,{intervals:intervals(8,{outdoorC:21})});
  const changes = { outdoorC:21,auxKw: 1, auxRoute: 'dhw', powerKw: 3,thermalCompressorDuty:0,thermalAuxKw:0 };
  tracker.start(plan, sample(start, changes), start);
  const episode = finish(tracker, changes);
  assert.ok(episode?.complete);
  const cycle = store.cycles({ input: 'synthetic', completedOnly: true })[0];
  const samePeriod = cycle.observations.map(o => ({ ...o }));
  const reference = evaluateCycle({ ...common({ intervals: samePeriod }), includeTail: false });
  assert.ok(Math.abs(cycle.assessment.profitCents - (reference.spaceHeatingCostCents - cycle.actual.spaceHeatingCostCents)) < 1e-8);
  assert.equal(cycle.assessment.wholeCycleProfitCents,null);
  assert.ok(episode.dhwAuxKwh > 0);
  assert.equal(episode.spaceHeatingAuxKwh, 0);
  assert.equal(tracker.metrics(21).auxProfit.count, 0);
  assert.equal(tracker.metrics(21).profit.count, 1);
  assert.equal(tracker.metrics(21).recoveryError.count, 1);
  assert.equal(cycle.assessment.basis, 'estimated-space-heating-execution-and-reference');
  assert.ok(cycle.endedAt < plan.intervals.at(-1).end, 'Assessment must not include unused forecast hours');
});

test('unknown auxiliary evidence cannot establish a recovered reserve or calibrate itself', t => {
  const { tracker, plan } = fixture(t);
  const changes = { auxiliaryObserved: false, auxiliaryRouteKnown: false, compressorActivityObserved: false,
    auxKw: null, auxRoute: null,thermalCompressorDuty:null,thermalAuxKw:null };
  tracker.start(plan, sample(start, changes), start);
  const episode = finish(tracker, changes);
  assert.equal(episode,undefined);
  assert.equal(tracker.active().stableSince,null);
  assert.equal(tracker.metrics(21).auxProfit.count, 0);
  const cp = updateAdaptiveEpisode(null, {complete:false});
  assert.equal(cp.model.energy.recoveryCalibrationEpisodes, 0);
  assert.equal(cp.model.energy.auxiliaryCalibrationEpisodes, 0);
});

test('shortened actions do not count as errors of an unexecuted original forecast', t => {
  const { tracker, plan, store } = fixture(t);
  tracker.start(plan, sample(start), start);
  tracker.shorten(start + HOUR / 4, 'comfort-trend');
  const episode = finish(tracker);
  assert.ok(episode.complete);
  assert.equal(store.cycles({ input: 'synthetic', completedOnly: true })[0].assessment.recoveryErrorCents, null);
  assert.equal(tracker.metrics(21).profit.count, 1);
  assert.equal(tracker.metrics(21).recoveryError.count, 0);
  assert.equal(tracker.metrics(21).recoveryError.value, null);
});

test('a long observation gap closes an incomplete cycle without inventing energy or a heat reserve', t => {
  const { tracker, plan, store } = fixture(t);
  tracker.start(plan, sample(start), start);
  assert.equal(tracker.record(sample(start + HOUR), start + HOUR), null);
  assert.equal(tracker.active(), null);
  const cycle = store.cycles({ input: 'synthetic' })[0];
  assert.equal(cycle.status, 'incomplete');
  assert.equal(cycle.incompleteReason, 'cycle-observation-gap');
  assert.equal(tracker.metrics(21).profit.count, 0);
});

test('a captured compressor-only baseline excludes AUX from the plan and its native alternative', () => {
  const args = common({ schedule, initialState:{ indoorC:20.5,reserveC:20.5,integral:-1200 },
    equipment:{nativeAuxAllowed:false,h66Available:true,supplyShortfallC:35} });
  const controlled=evaluateCycle(args), native=evaluateCycle({...args,schedule:null});
  assert.equal(controlled.auxiliaryKwh,0);assert.equal(native.auxiliaryKwh,0);
  assert.ok(controlled.trajectory.every(step=>step.auxiliaryKw===0));
  assert.ok(evaluateCycle({...args,equipment:{...args.equipment,nativeAuxAllowed:true}}).auxiliaryKwh>0);
});
