import test from 'node:test';
import assert from 'node:assert/strict';
import { continuationInput, deliveredHeatLimit, withoutFurtherPreheat, endTreatmentNow, reviseHeatingCycle } from '../src/control/heating-continuation.js';
import { heatingExplorerFixture } from './helpers/heating-explorer-fixture.js';
import { evaluateCycle } from '../src/control/planner.js';

const HOUR = 3_600_000;
function fixture() {
  const input = heatingExplorerFixture({ hours: 24, outdoorC: 10 });
  Object.assign(input.settings.comfort, { maxRiseC: 1.5, maxDropC: 1.5 });
  Object.assign(input.equipment, { roomSettingC: 20, preheatAvailable: true, supplyC: 35 });
  input.prices.forEach((row, i) => { row.allInCentsPerKWh = i < 8 ? 1 : i < 16 ? 100 : 1; });
  const schedule = { preheatStart: input.now, preheatEnd: input.now + HOUR,
    reductionStart: input.now + 2 * HOUR, reductionEnd: input.now + 4 * HOUR,
    roomSettingC: 21, roomBoostC: 1, treatmentKey: 'room-boost-v1' };
  const args = continuationInput(input, { ...input, schedule, model: input.checkpoint.model,
    targetC: 21, maxDropC: 1.5, maxRiseC: 1.5, initialState: input.thermalState, generatedAt: input.now });
  const plan = { ...args, schedule, generatedAt: input.now };
  return { input, args, plan, schedule };
}

test('missing feeds retain the original forecast clocks and cannot authorize economic cancellation', () => {
  const { input, plan, schedule } = fixture();
  const missing = { ...input, now: input.now + 60_000, prices: [], forecast: [],
    observations: { indoor: { value: null, stale: true } }, thermalState: null };
  const args = continuationInput(missing, plan);
  assert.equal(args.retained, true);
  assert.equal(args.freshComparison, false);
  assert.equal(args.intervals[0].forecastIssuedAt, plan.intervals[0].forecastIssuedAt);
  assert.ok(Number.isFinite(args.initialState.indoorC));
  assert.equal(reviseHeatingCycle({ args, schedule }), null);
});

test('lost solar or native evidence retains known estimates instead of comparing an invented zero', () => {
  const { input, plan } = fixture();
  for (const row of plan.intervals) row.solarRadiationWm2 = 300;
  const missing = structuredClone(input);
  missing.forecast.forEach(row => { row.solarRadiationWm2 = null; });
  const solar = continuationInput(missing, plan);
  assert.equal(solar.intervals[0].solarRadiationWm2, 300);
  assert.equal(solar.freshComparison, false);
  const native = continuationInput({ ...input, equipment: { ...input.equipment, h66Available: false, supplyC: null } },
    { ...plan, equipment: { ...input.equipment, h66Available: true } });
  assert.equal(native.freshComparison, false);
  assert.equal(native.equipment.supplyC, input.equipment.supplyC);
  assert.equal(native.equipment.h66Available, true, 'A retained prediction assumption grants no live native write readiness');
});

test('a fresh indoor endpoint with missing latent state advances the saved delivered-heat estimate', () => {
  const { input, plan, schedule } = fixture();
  const now = input.now + HOUR / 2;
  const args = continuationInput({ ...input, now, thermalState: null,
    observations: { indoor: { value: 21.1, observedAt: now, stale: false } } }, plan);
  const history = plan.intervals.filter(row => row.start < now).map(row => ({ ...row, end: Math.min(row.end, now) }));
  const predicted = evaluateCycle({ ...plan, intervals: history, schedule: null });
  assert.equal(args.initialState.indoorC, 21.1, 'The real endpoint retains its own authority');
  assert.equal(args.initialState.reserveC, predicted.endState.reserveC, 'A pending plan advances Normal rather than inventing missed preheat');
  const active = continuationInput({ ...input, now, thermalState: null,
    observations: { indoor: { value: 21.1, observedAt: now, stale: false } } },
    { ...plan, executionStartedAt: input.now });
  const delivered = evaluateCycle({ ...plan, intervals: history, schedule });
  assert.equal(active.initialState.reserveC, delivered.endState.reserveC,
    'An acknowledged cycle advances heat from its actual start');
  assert.notEqual(delivered.endState.reserveC, predicted.endState.reserveC, 'The fixture distinguishes delivered and hypothetical heat');
});

test('ending preheat preserves the complete reduction and original schedule', () => {
  const { args, schedule } = fixture(), original = structuredClone(schedule);
  const stopped = withoutFurtherPreheat(schedule, args.now + HOUR / 4);
  assert.equal(stopped.preheatEnd, args.now + HOUR / 4);
  assert.equal(stopped.reductionStart, schedule.reductionStart);
  assert.equal(stopped.reductionEnd, schedule.reductionEnd);
  assert.deepEqual(schedule, original);
});

test('ending already completed treatment cannot create a later reduction boundary', () => {
  const { schedule } = fixture();
  assert.deepEqual(endTreatmentNow(schedule, schedule.reductionEnd + HOUR), schedule);
  const cancelled = endTreatmentNow(schedule, schedule.preheatStart - HOUR);
  assert.equal(cancelled.reductionStart, cancelled.reductionEnd);
  assert.deepEqual(endTreatmentNow(cancelled, cancelled.reductionEnd + HOUR), cancelled);
});

test('missing indoor reports retain the runtime estimate of delivered heat without replaying planned actions over it', () => {
  const { input, plan } = fixture();
  const args = continuationInput({ ...input, now: input.now + HOUR / 2,
    observations: { indoor: { value: null, stale: true } },
    thermalState: { indoorC: 22, reserveC: 28, slabC: 25 } }, plan);
  assert.equal(args.initialState.indoorC, 22);
  assert.equal(args.initialState.reserveC, 28);
  assert.equal(args.freshComparison, false);
});

test('delivered-heat test ignores remaining optional preheat and reports the central delayed peak', () => {
  const { args, schedule } = fixture();
  const extended = { ...schedule, preheatEnd: args.now + 2 * HOUR, roomBoostC: 5 };
  const short = deliveredHeatLimit(args, schedule), long = deliveredHeatLimit(args, extended);
  assert.equal(long.peakC, short.peakC, 'Undelivered boost cannot trigger the stop decision');
  const hot = deliveredHeatLimit({ ...args, initialState: { indoorC: 22.4, reserveC: 30 } }, schedule);
  assert.equal(hot.hot, true);
  assert.ok(hot.peakC > 22.5);
});

test('remaining search keeps reduction fixed, respects cumulative preheat and never chooses a dearer exit', () => {
  const { args, schedule } = fixture();
  const result = reviseHeatingCycle({ args, schedule, preheatHours: 1.75 });
  assert.equal(result.schedule.reductionStart, schedule.reductionStart);
  assert.equal(result.schedule.reductionEnd, schedule.reductionEnd);
  assert.ok((result.schedule.preheatEnd - Math.max(args.now, result.schedule.preheatStart)) / HOUR <= .25);
  assert.equal(result.end, result.stoppedCostCents < result.continuedCostCents - 1e-6);
});

test('warmth during reduction does not erase the reduction when its delivered-heat peak is unavoidable', () => {
  const { args, schedule } = fixture();
  const reduction = { ...schedule, preheatStart: args.now - HOUR, preheatEnd: args.now,
    reductionStart: args.now };
  const warm = { ...args, initialState: { indoorC: 22.4, reserveC: 26 } };
  assert.equal(deliveredHeatLimit(warm, reduction).hot, true);
  assert.equal(deliveredHeatLimit(warm, reduction).cold, false);
  const result = reviseHeatingCycle({ args: warm, schedule: reduction });
  assert.equal(result.schedule.reductionEnd, reduction.reductionEnd);
  const stopped = evaluateCycle({ ...warm, schedule: endTreatmentNow(reduction, args.now) });
  assert.ok(!result.end || stopped.costCents < result.continuedCostCents);
});

test('a shorter remaining boost moves to the cheaper late window instead of clipping its early end', () => {
  const { args, schedule } = fixture();
  args.config.maxPreheatHours = .25;
  args.intervals.forEach((row, i) => { row.price = i < 7 ? 20 : i === 7 ? -100 : 100; });
  const result = reviseHeatingCycle({ args, schedule });
  assert.equal(result.end, false);
  assert.equal(result.schedule.preheatStart, args.now + 1.75 * HOUR);
  assert.equal(result.schedule.preheatEnd, schedule.reductionStart);
  assert.equal(result.schedule.reductionEnd, schedule.reductionEnd);
  const early = evaluateCycle({ ...args, schedule: { ...schedule, preheatEnd: args.now + HOUR / 4 } });
  assert.ok(result.continuedCostCents < early.costCents);
});

test('an earlier price advantage can retain early preheat rather than forcing it next to reduction', () => {
  const { args, schedule } = fixture();
  args.config.maxPreheatHours = .25;
  args.intervals.forEach((row, i) => { row.price = i === 0 ? -100 : 100; });
  const result = reviseHeatingCycle({ args, schedule });
  assert.equal(result.schedule.preheatStart, args.now);
  assert.equal(result.schedule.preheatEnd, args.now + HOUR / 4);
  assert.equal(result.schedule.reductionStart, schedule.reductionStart);
});

test('uncertainty padding does not turn a safe central delivered-heat peak into a preheat stop', () => {
  const { args, schedule } = fixture();
  args.model.uncertainty = { points: [{ hours: 48, errorC: 5 }], extrapolationCPerHour: 1 };
  const result = deliveredHeatLimit(args, schedule);
  assert.equal(result.hot, false);
  assert.ok(result.peakC < args.targetC + args.maxRiseC);
});

test('a genuinely cheaper exit is available without a new start penalty or arbitrary margin', () => {
  const { args, schedule } = fixture();
  args.intervals.forEach((row, i) => { row.price = i < 8 ? -100 : 1; });
  const reduction = { ...schedule, preheatStart: args.now, preheatEnd: args.now, reductionStart: args.now,
    roomBoostC: 0 };
  const result = reviseHeatingCycle({ args, schedule: reduction });
  assert.equal(result.end, true);
  assert.ok(result.stoppedCostCents < result.continuedCostCents);
});

test('trial continuation uses its funded allowance rather than the original nominal premium', () => {
  const { input, args, schedule, plan } = fixture();
  const trial = { ...plan, trial: true, trialAllowanceCents: 8,
    prediction: { costCents: 102 }, referencePrediction: { costCents: 100 } };
  assert.equal(continuationInput(input, trial).approvedExtraCostCents, 8);
  assert.equal(continuationInput(input, { ...trial, fundedTrialAllowanceCents: 9 }).approvedExtraCostCents, 9);
  assert.equal(continuationInput(input, { ...trial, fundedTrialAllowanceCents: 0 }).approvedExtraCostCents, 0);
  args.intervals.forEach((row, i) => { row.price = i < 8 ? -100 : 1; });
  const reduction = { ...schedule, preheatStart: args.now, preheatEnd: args.now,
    reductionStart: args.now, roomBoostC: 0 };
  const ordinary = reviseHeatingCycle({ args, schedule: reduction });
  const difference = ordinary.continuedCostCents - ordinary.stoppedCostCents;
  assert.ok(difference > 0);
  assert.equal(reviseHeatingCycle({ args: { ...args, trial: true, approvedExtraCostCents: difference + .1 }, schedule: reduction }).end, false);
  assert.equal(reviseHeatingCycle({ args: { ...args, trial: true, approvedExtraCostCents: difference - .1 }, schedule: reduction }).end, true);
  assert.equal(reviseHeatingCycle({ args: { ...args, trial: true, approvedExtraCostCents: null }, schedule: reduction }).end, false,
    'Unknown funding retains accepted intent instead of inventing a zero allowance');
});

test('a paid preheat trial retains feasible heat exposure while ordinary cost optimization can shorten it', () => {
  const { input, args, plan, schedule } = fixture();
  assert.equal(continuationInput(input, { ...plan, trial: true }).trial, true);
  args.intervals.forEach(row => { row.price = 10; });
  args.approvedExtraCostCents = 100;
  const ordinary = reviseHeatingCycle({ args, schedule });
  assert.ok(ordinary.schedule.preheatEnd < schedule.preheatEnd);
  const trial = reviseHeatingCycle({ args: { ...args, trial: true }, schedule });
  assert.equal(trial.schedule.preheatEnd - Math.max(args.now, trial.schedule.preheatStart),
    schedule.preheatEnd - Math.max(args.now, schedule.preheatStart));
  assert.equal(trial.schedule.reductionStart, schedule.reductionStart);
  assert.equal(trial.schedule.reductionEnd, schedule.reductionEnd);
  assert.equal(trial.end, false, 'the already accepted trial value is retained');
});

test('trial preheat still repairs an infeasible duration and permits a genuinely cheaper full exit', () => {
  const { args, schedule } = fixture();
  args.trial = true;
  args.config.maxPreheatHours = .25;
  const repaired = reviseHeatingCycle({ args, schedule });
  assert.ok(repaired.schedule.preheatEnd - Math.max(args.now, repaired.schedule.preheatStart) <= .25 * HOUR);
  args.config.maxPreheatHours = 2;
  args.intervals.forEach((row, i) => { row.price = i < 4 ? 1000 : 1; });
  const exited = reviseHeatingCycle({ args, schedule });
  assert.equal(exited.end, true);
});

test('a trial can move its full remaining preheat to a cheaper window directly before reduction', () => {
  const { args, schedule } = fixture();
  args.trial = true;
  args.config.maxPreheatHours = 1;
  args.intervals.forEach((row, i) => { row.price = i < 4 ? 20 : i < 8 ? -10 : 100; });
  const result = reviseHeatingCycle({ args, schedule });
  assert.equal(result.schedule.preheatEnd, schedule.reductionStart);
  assert.equal(result.schedule.preheatStart, schedule.reductionStart - HOUR);
  assert.equal(result.schedule.reductionEnd, schedule.reductionEnd);
});
