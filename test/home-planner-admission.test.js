import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseCycle, revalidatePlan, trialEnvelope } from '../src/control/planner.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { heatingExplorerFixture } from './helpers/heating-explorer-fixture.js';

function preheatFixture() {
  const input = heatingExplorerFixture({ hours: 12, maxReductionHours: 2 });
  input.config.preheatRoomBoostC = 1;
  input.prices.forEach((price, i) => { price.allInCentsPerKWh = i < 4 ? -5000 : i < 12 ? 5000 : 1; });
  Object.assign(input.equipment, { preheatAvailable: true, roomSettingC: 20, roomSettingMaximumC: 35, supplyC: 30 });
  const response = input.checkpoint.model.equipmentResponse;
  response.phases.reduction.treatmentKey = 'room-boost-v1';
  response.validation.phases.reduction.treatmentKey = 'room-boost-v1';
  response.phases.preheat = { ratio: 1.2, trainingEpisodes: 3, treatmentKey: 'room-boost-v1' };
  response.validation.phases.preheat = {
    accepted: true, episodes: 3, maxDurationHours: 2, maxRoomBoostC: 1, treatmentKey: 'room-boost-v1' };
  return input;
}

test('economic preheat never extrapolates held-out ROOM-boost authority', () => {
  const input = preheatFixture();
  const supported = chooseCycle(input);
  assert.equal(supported.plan?.trial, false);
  assert.equal(supported.plan.schedule.roomBoostC, 1);
  input.config.preheatRoomBoostC = 5;
  const unsupported = chooseCycle(input);
  assert.equal(unsupported.plan, null, 'Large negative prices cannot turn +1 evidence into +5 authorization');
  input.checkpoint.model.equipmentResponse.validation.phases.preheat.maxRoomBoostC = 5;
  assert.equal(chooseCycle(input).plan?.schedule.roomBoostC, 5, 'Matching independent boost evidence permits consideration');
});

test('dispatch revalidates the supported ROOM boost and the current preheat-duration ceiling', () => {
  const input = preheatFixture(), plan = chooseCycle(input).plan;
  assert.equal(revalidatePlan({ ...input, plan }).valid, true);
  const beyondDuration = revalidatePlan({ ...input, plan, config: { ...input.config, maxPreheatHours: .5 } });
  assert.equal(beyondDuration.valid, false);
  assert.equal(beyondDuration.reason, 'scheduled-cycle-outside-current-limits');
  input.checkpoint.model.equipmentResponse.validation.phases.preheat.maxRoomBoostC = .5;
  const beyondBoost = revalidatePlan({ ...input, plan });
  assert.equal(beyondBoost.valid, false);
  assert.equal(beyondBoost.reason, 'scheduled-preheat-evidence-unavailable');
});

function trialFixture({ indoorC = 21, price = 10, hours = 8 } = {}) {
  const input = heatingExplorerFixture({ hours, maxDropC: 1 });
  input.config.learningTrials = true;
  input.checkpoint.model = initialAdaptiveModel();
  input.observations.indoor.value = indoorC;
  input.thermalState.reserveC = indoorC + 4.725;
  input.trialBudgetRemainingCents = 100;
  input.prices.forEach(row => { row.allInCentsPerKWh = price; });
  const schedule = { preheatStart: input.now, preheatEnd: input.now, reductionStart: input.now,
    reductionEnd: input.now + 1_800_000, roomBoostC: 0 };
  const args = { schedule, model: input.checkpoint.model, initialState: { indoorC, reserveC: input.thermalState.reserveC },
    targetC: 21, maxDropC: 1, config: input.config, equipment: input.equipment,
    intervals: input.forecast.map((row, i) => ({ ...row, price: input.prices[i].allInCentsPerKWh })) };
  return { input, args };
}

test('negative all-in prices count foregone income in the bounded trial allowance', () => {
  const { input, args } = trialFixture({ price: -1000 });
  const envelope = trialEnvelope(args);
  assert.ok(envelope.foregoneIncomeCents > input.trialBudgetRemainingCents);
  assert.ok(envelope.costExposureCents >= envelope.foregoneIncomeCents);
  assert.equal(chooseCycle(input).plan, null, 'An unknown reduction response cannot promise zero lost negative-price income');
});

test('Away trials defer their temperature floor to native protection and restore occupied comfort for return', () => {
  const { args } = trialFixture({ indoorC: 15.5 });
  assert.equal(trialEnvelope({ ...args, occupancy: { mode: 'away' } }).coldSafe, true);
  assert.equal(trialEnvelope({ ...args, occupancy: { mode: 'occupied' } }).coldSafe, false);
  for (const offset of [0, 900_000, 3_600_000]) {
    assert.equal(trialEnvelope({ ...args, occupancy: { mode: 'away', returnAt: args.schedule.reductionStart + offset } }).coldSafe,
      false, 'A return before or during the recovery window restores occupied comfort');
  }
});

test('returning during preheat recovery restores the occupied upper comfort limit', () => {
  const { args } = trialFixture({ indoorC: 25, hours: 24 });
  args.initialState.reserveC = 25;
  args.schedule = { ...args.schedule, preheatEnd: args.schedule.reductionStart + 900_000,
    reductionStart: args.schedule.reductionStart + 900_000, roomBoostC: 1 };
  args.intervals.forEach(interval => { interval.outdoorC = 21; });
  const away = trialEnvelope({ ...args, occupancy: { mode: 'away' } });
  assert.equal(away.hotSafe, true);
  const returning = trialEnvelope({ ...args, occupancy: { mode: 'away', returnAt: args.schedule.reductionEnd + 900_000 } });
  assert.equal(returning.hotSafe, false);
  assert.equal(returning.hotStressReason, 'preheat-stress-indoor-upper-limit');
});
