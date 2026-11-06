import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseCycle, learningReadiness, revalidatePlan } from '../src/control/planner.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { observedState } from '../src/app/cycle-evaluation.js';
import { heatingExplorerFixture } from './helpers/heating-explorer-fixture.js';

const HOUR = 3_600_000;
function input(mode = 'off', floorEnabled = true) {
  const value = heatingExplorerFixture({ hours: 12, outdoorC: 0, price: 2 });
  value.checkpoint.model = initialAdaptiveModel({ heatPumpModelConfirmed: true,
    ...(floorEnabled ? { floorThermalPriors: { capacityKwhPerC: 2, exchangeKwPerC: .5,
      openAllocationFraction: .7, closedAllocationFraction: 0 } } : {}) });
  Object.assign(value.config, { learningTrials: true, maxTrialCostCents: 150,
    trialBudgetCentsPerDay: 300, maxPreheatHours: 0, maxReductionHours: 2,
    minimumHomeBenefitCents: 10_000 });
  value.trialBudgetRemainingCents = 300;
  Object.assign(value.equipment, { compressorOn: 1, dhwRouting: 0,
    floorOverrideMode: mode, floorOverrideAvailable: false,
    heatingDemand: { observedThrough: value.now, coveredHours: 24, duty: .3,
      indoorOutdoorGapC: 21, cycles: 8, runHours: .35, cycleHours: 1.15 } });
  return value;
}

for (const mode of ['unknown', 'partial']) test(`a reduction-only learning trial requires assessable floor evidence: ${mode}`, () => {
  const value = input(), plan = chooseCycle(value).plan;
  assert.equal(plan?.trial, true);
  assert.equal(plan.schedule.preheatEnd, plan.schedule.preheatStart);
  assert.equal(revalidatePlan({ ...value, plan }).valid, true);
  const row = { start: value.now, end: value.now + 60_000, phase: 'reduction', indoorC: 21,
    outdoorC: 0, solarRadiationWm2: 0, thermalCompressorDuty: 0, thermalAuxKw: 0,
    floorOverrideMode: mode, eligible: true };
  const cycle = { plan };
  const poisoned = observedState(cycle, plan.initialState, row, []);
  assert.equal(poisoned, null, 'This evidence cannot support the cycle stored-heat observer');
  assert.equal(observedState(cycle, poisoned, { ...row, start: row.end,
    end: row.end + HOUR, floorOverrideMode: 'off' }, []), null,
  'A later report cannot reconstruct the missing earlier floor state');
  value.equipment.floorOverrideMode = mode;
  assert.notEqual(chooseCycle(value).plan?.trial, true);
  assert.equal(revalidatePlan({ ...value, plan }).valid, false);
});

test('floor evidence requirements preserve unconfigured operation and separate observation from command readiness', () => {
  const ready = value => learningReadiness(value.checkpoint, value.config, value.equipment);
  assert.equal(ready(input('off')).trialReady, true, 'Fresh OFF needs no floor command permission');
  assert.equal(ready(input('on')).trialReady, true, 'An owned observed preheat can progress to release');
  const unconfigured = input('off', false); delete unconfigured.equipment.floorOverrideMode;
  assert.equal(ready(unconfigured).trialReady, true, 'An unconfigured floor adds no equipment requirement');
  for (const mode of ['unknown', 'partial']) {
    for (const enabled of [false, true]) {
      const result = ready(input(mode, enabled));
      assert.equal(result.trialReady, false);
      assert(result.reasons.includes('trials-require-known-floor-output'));
    }
  }
  const missing = input(); delete missing.equipment.floorOverrideMode;
  assert.equal(ready(missing).trialReady, false, 'An explicit physical floor model needs a known mode');
});
