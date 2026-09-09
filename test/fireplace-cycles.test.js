import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { CycleTracker } from '../src/app/cycles.js';
import { addFireplace, removeFireplace } from '../src/app/fireplace.js';
import { fireplaceLearningContext } from '../src/app/fireplace-inputs.js';
import { initialAdaptiveModel, updateAdaptiveEpisode } from '../src/control/adaptive-learning.js';
import { evaluateCycle } from '../src/control/planner.js';

const HOUR = 3_600_000, start = Date.parse('2026-01-01T00:00:00Z');
function fixture(t, { validated = false, reductionHours = 0.5 } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const tracker = new CycleTracker({ store, input: 'mqtt', config: { recoveryTimeoutHours: 8 } });
  const model = initialAdaptiveModel();
  if (validated) model.validation = { accepted: true, kind: 'conditional-thermal', samples: 3,
    parameterEvidence: { lossPerHour: { status: 'identified' }, normalHeatCPerHour: { status: 'identified' },
      fireplaceCPerKg: { status: 'identified' } },
    fireplace: { accepted: true, trainingBurns: 3, validationBurns: 3 } };
  const intervals = Array.from({ length: 32 }, (_, i) => ({ start: start + i * HOUR / 4,
    end: start + (i + 1) * HOUR / 4, outdoorC: 10, solarRadiationWm2: 0, price: i < 2 ? 40 : 5 }));
  const plan = { model, intervals, initialState: { indoorC: 21, reserveC: 21 }, targetC: 21,
    schedule: { preheatStart: start, preheatEnd: start, reductionStart: start,
      reductionEnd: start + reductionHours * HOUR, roomBoostC: 0 },
    reference: null, referenceLabel: 'continuous normal operation', occupancy: { mode: 'occupied' }, maxDropC: 1,
    equipment: { fireplaceEvents: [] } };
  const sample = timestamp => ({ timestamp, indoorC: 22, outdoorC: 10, solarRadiationWm2: 0,
    indoorTrendCPerHour: 0, phase: timestamp <= plan.schedule.reductionEnd ? 'reduction' : 'recovery',
    compressorDuty: 0.5, compressorPowerKw: 3, circulationKw: 0.05, powerKw: 1.525,
    compressorActivityObserved: true, thermalCompressorDuty: 0.5, thermalAuxKw: 0,
    auxiliaryObserved: true, auxiliaryRouteKnown: true, auxKw: 0, auxRoute: 'space', energyBasis: 'measured' });
  const begin = () => tracker.start(plan, sample(start), start);
  const advance = (from = 1, to = 24, step = HOUR / 4) => {
    let episode;
    for (let i = from; i <= to && tracker.active(); i++) episode = tracker.record(sample(start + i * step), start + i * step) ?? episode;
    return episode;
  };
  return { store, tracker, plan, sample, begin, advance };
}
const savedCycle = store => store.cycles({ input: 'mqtt' })[0];
const elapsedIntervals = cycle => cycle.observations.map(({ start, end, outdoorC, solarRadiationWm2, price }) =>
  ({ start, end, outdoorC, solarRadiationWm2, price }));
function reference(cycle, events) {
  return evaluateCycle({ ...cycle.plan, schedule: cycle.plan.reference, intervals: elapsedIntervals(cycle),
    config: cycle.modelConfig, equipment: { ...cycle.plan.equipment, fireplaceEvents: events }, includeTail: false });
}

test('an unvalidated fire preserves actual electricity and the frozen forecast but cannot establish savings or recovery evidence', t => {
  const f = fixture(t), original = f.begin();
  f.advance(1, 1);
  addFireplace(f.store, 'mqtt', { requestId: 'invented-mid-cycle-fire', kg: 8 }, start + HOUR / 4);
  const context = fireplaceLearningContext(f.store, 'mqtt');
  f.tracker.correctFireplace(context, start + HOUR / 4);
  const episode = f.advance(2), cycle = savedCycle(f.store);
  assert.ok(episode && cycle.status === 'completed');
  assert.deepEqual(cycle.plan, original.plan, 'A later fire must not rewrite the original model or forecast inputs');
  assert.deepEqual(cycle.originalPrediction, original.originalPrediction);
  const hours = (cycle.endedAt - cycle.startedAt) / HOUR;
  assert.ok(Math.abs(cycle.actual.electricityKwh - 1.525 * hours) < 1e-10, 'Logged kg cannot enter metered electrical totals');
  assert.equal(cycle.assessment.referenceCostCents, reference(cycle, context.fireplaceEvents).spaceHeatingCostCents);
  assert.notEqual(cycle.assessment.referenceCostCents, reference(cycle, []).spaceHeatingCostCents);
  assert.equal(cycle.assessment.profitCents, null);
  assert.equal(cycle.assessment.recoveryErrorCents, null);
  assert.equal(cycle.assessment.basis, 'unassessed-fireplace-response');
  assert.equal(episode.complete, false);
  assert.equal(episode.forecastValidation.eligible, false);
  const learned = updateAdaptiveEpisode(null, episode);
  assert.equal(learned.model.energy.episodes, 0);
  assert.equal(learned.model.energy.recoveryCalibrationEpisodes, 0);
  assert.equal(learned.model.forecastValidation, undefined);
  assert.equal(f.tracker.metrics(21).profit.count, 0);
});

test('validated fireplace response uses the same current fire in the assessed reference and executed recovery projection', t => {
  const f = fixture(t, { validated: true }), original = f.begin();
  addFireplace(f.store, 'mqtt', { requestId: 'invented-validated-fire', kg: 8 }, start);
  const context = fireplaceLearningContext(f.store, 'mqtt');
  f.tracker.correctFireplace(context, start);
  const episode = f.advance(), cycle = savedCycle(f.store);
  assert.equal(episode.complete, true);
  assert.equal(episode.forecastValidation.eligible, true);
  assert.deepEqual(cycle.plan, original.plan);
  const expectedReference = reference(cycle, context.fireplaceEvents);
  const expectedExecution = evaluateCycle({ ...cycle.plan, intervals: elapsedIntervals(cycle), config: cycle.modelConfig,
    equipment: { ...cycle.plan.equipment, fireplaceEvents: context.fireplaceEvents }, includeTail: false });
  assert.equal(cycle.assessment.referenceCostCents, expectedReference.spaceHeatingCostCents);
  assert.equal(cycle.assessment.profitCents, expectedReference.spaceHeatingCostCents - cycle.actual.spaceHeatingCostCents);
  assert.equal(episode.predictedEnergyKwh, expectedExecution.spaceHeatingKwh);
  assert.equal(cycle.plan.equipment.fireplaceEvents.length, 0, 'Advance prediction retains the genuinely available source version');
});

test('a completed-cycle correction removes economic evidence without rewriting measurements or the immutable episode', t => {
  const f = fixture(t, { validated: true });
  const load = addFireplace(f.store, 'mqtt', { requestId: 'invented-corrected-fire', kg: 8 }, start);
  f.tracker.correctFireplace(fireplaceLearningContext(f.store, 'mqtt'), start);
  f.begin();
  const episode = f.advance(), before = savedCycle(f.store);
  assert.equal(episode.complete, true);
  assert.equal(f.tracker.metrics(21).profit.count, 1);
  const journal = f.store.learningJournal({ input: 'mqtt' });
  removeFireplace(f.store, 'mqtt', { requestId: 'invented-remove-completed', id: load.id }, before.endedAt + 1);
  f.tracker.correctFireplace(fireplaceLearningContext(f.store, 'mqtt'), before.endedAt + 1);
  const corrected = savedCycle(f.store);
  assert.deepEqual(corrected.actual, before.actual);
  assert.deepEqual(corrected.observations, before.observations);
  assert.deepEqual(corrected.plan, before.plan);
  assert.equal(corrected.assessment.profitCents, null);
  assert.equal(corrected.assessment.recoveryErrorCents, null);
  assert.equal(corrected.assessment.basis, 'unassessed-corrected-fireplace-history');
  assert.equal(f.tracker.metrics(21).profit.count, 0);
  assert.equal(f.tracker.metrics(21).recoveryError.count, 0);
  assert.deepEqual(f.store.learningJournal({ input: 'mqtt' }), journal);
});

test('correcting an active observer matches clean reconstruction across sub-sample tariff boundaries', t => {
  const fired = fixture(t, { validated: true, reductionHours: 4 });
  const clean = fixture(t, { validated: true, reductionHours: 4 });
  const load = addFireplace(fired.store, 'mqtt', { requestId: 'invented-observer-fire', kg: 8 }, start);
  fired.tracker.correctFireplace(fireplaceLearningContext(fired.store, 'mqtt'), start);
  const original = fired.begin(); clean.begin();
  fired.advance(1, 3, HOUR / 2); clean.advance(1, 3, HOUR / 2);
  const before = fired.tracker.active(), cleanState = clean.tracker.active().observerState;
  assert.equal(before.observations.length, 6, 'Each 30-minute sample is split into 15-minute tariff intervals');
  assert.notEqual(before.observerState.reserveC, cleanState.reserveC);
  removeFireplace(fired.store, 'mqtt', { requestId: 'invented-remove-observer', id: load.id }, start + 1.5 * HOUR + 1);
  fired.tracker.correctFireplace(fireplaceLearningContext(fired.store, 'mqtt'), start + 1.5 * HOUR + 1);
  const corrected = fired.tracker.active();
  assert.ok(Math.abs(corrected.observerState.reserveC - cleanState.reserveC) < 1e-10,
    `Corrected reserve ${corrected.observerState.reserveC} must match clean reserve ${cleanState.reserveC}`);
  assert.equal(corrected.observerState.indoorC, cleanState.indoorC);
  assert.deepEqual(corrected.actual, before.actual);
  assert.deepEqual(corrected.plan, original.plan);
  assert.equal(corrected.stableSince, null);
  const episode = fired.advance(4, 16, HOUR / 2);
  assert.ok(episode);
  assert.equal(episode.complete, false);
  assert.equal(episode.forecastValidation.eligible, false);
});
