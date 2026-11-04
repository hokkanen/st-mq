import test from 'node:test';
import assert from 'node:assert/strict';
import { heatingDemandHistory, trialOpportunity } from '../src/control/heating-trials.js';
import { chooseCycle, revalidatePlan, trialEnvelope, trialCostExposure } from '../src/control/planner.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { controlConfiguration } from '../src/app/config.js';
import { CycleTracker } from '../src/app/cycles.js';
import { Store } from '../src/storage/store.js';
import { learningConfiguration } from '../src/app/committed-learning.js';
import { heatingExplorerFixture } from './helpers/heating-explorer-fixture.js';

const HOUR = 3_600_000, now = Date.parse('2026-01-02T12:00:00Z');
function input(outdoorC = 10) {
  const value = heatingExplorerFixture({ hours: 12, outdoorC, price: 10 });
  value.checkpoint.model = initialAdaptiveModel({ heatPumpModelConfirmed: true });
  Object.assign(value.config, { learningTrials: true, maxTrialCostCents: 150, trialBudgetCentsPerDay: 300 });
  value.trialBudgetRemainingCents = 300;
  value.prices.forEach(row => {row.allInCentsPerKWh=2;});
  Object.assign(value.equipment, { compressorOn: 0, heatingDemand: { observedThrough: value.now,
    coveredHours: 24, duty: .3, indoorOutdoorGapC: 10, cycles: 8, runHours: .35, cycleHours: 1.15 } });
  return value;
}
const duration = plan => (plan.schedule.reductionEnd - plan.schedule.reductionStart) / HOUR;

test('trial windows span useful demand cycles, lengthening in milder weather without bootstrap evidence', () => {
  const cold = chooseCycle(input(0)), mildInput = input(15), mild = chooseCycle(mildInput);
  assert.equal(cold.plan.trial, true);
  assert.equal(mild.plan.trial, true);
  assert.ok(duration(cold.plan) > .5);
  assert.ok(mild.plan.trialOpportunity.minimumHours > cold.plan.trialOpportunity.minimumHours);
  assert.ok(duration(mild.plan) >= mild.plan.trialOpportunity.minimumHours);
  assert.ok(duration(mild.plan) <= mildInput.config.maxReductionHours);
  assert.equal(mild.plan.readiness.actionValidated, false);
  assert.equal(revalidatePlan({ ...mildInput, plan: mild.plan }).valid, true);
  assert.equal(mildInput.checkpoint.model.validation, null, 'Planning creates no learning evidence');
  mildInput.equipment.learningTrialsToday = 2;
  assert.equal(revalidatePlan({ ...mildInput, plan: mild.plan }).valid, true, 'The daily target cannot end useful lifelong exploration');
});

test('no heating opportunity is not a daily experiment, and hard ceilings still win', () => {
  const warm = chooseCycle(input(25));
  assert.equal(warm.plan, null);
  assert.ok(warm.reasons.includes('no-useful-space-heating-window'));
  const capped = input(); capped.config.maxReductionHours = .5;
  const limited=chooseCycle(capped).plan;
  assert.ok(!limited || duration(limited)<=.5);
  assert.notEqual(limited?.trial,true,'A shorter economic action can remain useful without being a qualified experiment');
  const unobserved = input(); unobserved.equipment.h66Available = false;
  const blind=chooseCycle(unobserved).plan;
  assert.ok(!blind||duration(blind)<=.5);
  assert.notEqual(blind?.trial,true,'Experiments require native observations');
  const disabled = input(); disabled.config.learningTrials = false;
  assert.notEqual(chooseCycle(disabled).plan?.trial,true);
});

test('daily trial priority expands checked action coverage instead of depending on episode modulo', () => {
  const value = heatingExplorerFixture({ hours: 12, outdoorC: 10, validatedHours: .5, price: 30 });
  Object.assign(value.config, { learningTrials: true, maxTrialCostCents: 150 });
  value.trialBudgetRemainingCents = 300;
  value.equipment.learningTrialsToday = 0;
  value.prices.forEach(row => {row.allInCentsPerKWh=2;});
  const result = chooseCycle(value);
  assert.equal(result.plan?.trial, true);
  assert.ok(duration(result.plan) > .5);
  value.equipment.learningTrialsToday = 2;
  const ordinary = chooseCycle(value);
  if (ordinary.plan?.trial) assert.ok(ordinary.plan.trialAllowanceCents<=150, 'Continued exploration remains cost bounded');
});

function costArgs({ outdoorC = 10, price = 10 } = {}) {
  const start = now, model = initialAdaptiveModel({ heatPumpModelConfirmed: true });
  return { model, initialState: { indoorC: 21, reserveC: 21 }, targetC: 21,
    intervals: Array.from({ length: 32 }, (_, i) => ({ start: start + i * HOUR / 4,
      end: start + (i + 1) * HOUR / 4, outdoorC, solarRadiationWm2: 0, price })),
    schedule: { preheatStart: start, preheatEnd: start, reductionStart: start, reductionEnd: start + HOUR / 2, roomBoostC: 0 },
    config: controlConfiguration(), equipment: { nativeAuxAllowed: false, supplyC: 35, brineC: 0 } };
}

test('no consumption in any cost scenario has no invented minimum or full-rated recovery charge', () => {
  const args = costArgs({ outdoorC: 25 });
  const exposure = trialCostExposure(args);
  assert.equal(exposure.costExposureCents, 0);
  assert.equal(exposure.foregoneIncomeCents, 0);
  assert.equal(trialEnvelope(args).costExposureCents, 0);
  args.config.auxRatedKw = 20;
  args.config.circulationKw = 1;
  assert.equal(trialCostExposure(args).costExposureCents, 0);
});

test('AUX-disallowed cost screening does not price nameplate AUX or included circulation', () => {
  const args = costArgs({ price: -10 });
  const first = trialCostExposure(args);
  assert.ok(first.foregoneIncomeCents > 0);
  assert.ok(first.costExposureCents >= first.foregoneIncomeCents);
  args.config.auxRatedKw = 20; args.config.circulationKw = 1;
  assert.deepEqual(trialCostExposure(args), first);
});

test('an invalid physical floor model has unknown exposure without entering its thermal integrator', () => {
  const args = costArgs();
  args.model.floor = { enabled: true, capacityKwhPerC: 0, nativeCapacityKwhPerC: 1,
    exchangeKwPerC: .25, groundLossKwPerC: 0 };
  assert.equal(trialCostExposure(args).costExposureCents, null);
});

test('screened loss follows real price differences, recovery and energy rather than duration times rated power', () => {
  const args = costArgs({ price: 1 });
  const flat = trialCostExposure(args);
  for (const row of args.intervals) if (row.start >= args.schedule.reductionEnd) row.price = 100;
  const expensiveRecovery = trialCostExposure(args);
  assert.ok(expensiveRecovery.costExposureCents > flat.costExposureCents);
  const negative = costArgs({ price: -100 });
  assert.ok(trialCostExposure(negative).foregoneIncomeCents > 0);
});

test('demand summary separates DHW, missing coverage, future reports and interventions from Normal cycles', () => {
  const segments = [];
  for (let i = 0; i < 6; i++) {
    const start = now - (6 - i) * HOUR;
    segments.push({ start, end: start + .75 * HOUR, compressorDuty: 0 },
      { start: start + .75 * HOUR, end: start + HOUR, compressorDuty: 1 });
  }
  const samples = segments.map(row => ({ timestamp: row.end, indoorC: 21,
    inputSegments: [{ ...row, phase: 'normal', auxRoute: 'space', outdoorC: 11, quality: [] }] }));
  const history = heatingDemandHistory(samples, now);
  assert.equal(history.duty, .25);
  assert.equal(history.runHours, .25);
  assert.equal(history.cycleHours, 1);
  const dhw = samples.map(sample => ({ ...sample, inputSegments: sample.inputSegments.map(row => ({ ...row, auxRoute: 'dhw' })) }));
  assert.equal(heatingDemandHistory(dhw, now), null);
  const future = samples.map(sample => ({ ...sample, timestamp: now + HOUR }));
  assert.equal(heatingDemandHistory(future, now), null);
  const gap = samples.filter((_, i) => i !== 4);
  assert.ok(heatingDemandHistory(gap, now).cycles < history.cycles);
  const intervention = samples.map(sample => ({ ...sample, inputSegments: sample.inputSegments.map(row => ({ ...row, phase: 'recovery' })) }));
  assert.equal(heatingDemandHistory(intervention, now), null);
});

test('Normal AUX estimates use observed routed energy and keep missing evidence unknown',()=>{
  const segment={phase:'normal',auxRoute:'space',compressorDuty:1,outdoorC:0,quality:[],auxiliaryObserved:true};
  const samples=[{timestamp:now,indoorC:21,inputSegments:[
    {...segment,start:now-2*HOUR,end:now-HOUR,thermalAuxKw:0},
    {...segment,start:now-HOUR,end:now,thermalAuxKw:3}]}];
  const actual=heatingDemandHistory(samples,now);
  assert.equal(actual.normalAuxiliaryKw,1.5);assert.equal(actual.auxiliaryCoveredHours,2);
  const unknown=structuredClone(samples);unknown[0].inputSegments.forEach(row=>{row.auxiliaryObserved=false;});
  assert.equal(heatingDemandHistory(unknown,now).normalAuxiliaryKw,null);
  const diverted=structuredClone(samples);diverted[0].inputSegments[1].auxRoute='dhw';
  assert.equal(heatingDemandHistory(diverted,now).normalAuxiliaryKw,0);
});

test('stale demand history cannot authorize a useful no-demand window', () => {
  const value = input(25), args = costArgs({ outdoorC: 25 });
  args.equipment = { ...value.equipment, heatingDemand: { ...value.equipment.heatingDemand, observedThrough: now - 3 * HOUR } };
  const baseline = { trajectory: args.intervals.map(row => ({ at: row.end, durationHours: .25, compressorDuty: 0 })) };
  assert.equal(trialOpportunity({ ...args, baseline }).useful, false);
});

test('daily progress is rebuilt from recorded dispatched trials with Finnish day boundaries', () => {
  const store = new Store(':memory:');
  try {
    const tracker = new CycleTracker({ store, input: 'providers' });
    const at = Date.parse('2026-01-02T22:01:00Z');
    store.cycle('providers', { id: 'previous-day', startedAt: at - 120_000, endedAt: at - 90_000,
      status: 'completed', plan: { trial: true } });
    store.cycle('providers', { id: 'ordinary', startedAt: at - 30_000, endedAt: at - 20_000,
      status: 'completed', plan: { trial: false } });
    store.cycle('providers', { id: 'today', startedAt: at, endedAt: at + HOUR,
      status: 'completed', plan: { trial: true }, actual: { compressorRunHours: .5 }, assessment: { profitCents: 0 } });
    const progress = new CycleTracker({ store, input: 'providers' }).trialProgress(at + HOUR);
    assert.equal(progress.date, '2026-01-03');
    assert.equal(progress.attempted, 1);
    assert.equal(progress.completed, 1);
    assert.equal(progress.assessed, 1, 'A valid zero assessment remains valid');
    assert.equal(progress.observedCompressorRunHours, .5);
    assert.equal(progress.remainingCents, 300);
    assert.equal(Object.hasOwn(progress,'nextEligibleAt'), false, 'No hidden cooldown follows completed recovery');
    assert.equal(Object.hasOwn(tracker.trialProgress(at + 8 * HOUR),'nextEligibleAt'), false);
    assert.equal(tracker.trialProgress(at + 25 * HOUR).attempted, 0);
  } finally { store.close(); }
});

test('daily target and trial allowances remain configuration owned and bounded', () => {
  assert.equal(controlConfiguration().learningTrialTargetPerDay, 4);
  assert.equal(controlConfiguration({ learning_trial_target_per_day: 4 }).learningTrialTargetPerDay, 4);
  for (const value of [0, 5, 1.5, null, '2'])
    assert.throws(() => controlConfiguration({ learning_trial_target_per_day: value }));
  const config = controlConfiguration({ trial_budget_cents_per_day: 300, max_trial_cost_cents: 150 });
  assert.equal(config.trialBudgetCentsPerDay, 300);
  assert.equal(config.maxTrialCostCents, 150);
  assert.deepEqual(learningConfiguration(config), learningConfiguration(controlConfiguration()),
    'Planning allowances do not change journal interpretation or reset learning');
});
