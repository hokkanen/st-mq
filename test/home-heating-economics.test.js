import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAdaptiveModel, THERMAL_PARAMETER_BOUNDS } from '../src/control/adaptive-learning.js';
import { evaluateCycle, economicAdmission, chooseCycle, trialEnvelope } from '../src/control/planner.js';

const HOUR = 3_600_000, now = Date.parse('2026-01-01T00:00:00Z');
function fixture({ price = 1, hours = 24, indoorC = 21 } = {}) {
  const model = initialAdaptiveModel({ heatPumpModelConfirmed: true });
  model.uncertainty = { points: [{ hours: 24, errorC: 0.1 }], extrapolationCPerHour: 0.05 };
  model.validation = { accepted: true, kind: 'conditional-thermal', samples: 3,
    parameterEvidence: { lossPerHour: { status: 'identified' }, hydronicCPerKwh: { status: 'identified' } } };
  model.equipmentResponse = { phases: { reduction: { ratio: 0, trainingEpisodes: 3, treatmentKey: 'reduction-only-v1' } },
    validation: { phases: { reduction: { accepted: true, episodes: 3, maxDurationHours: 1, treatmentKey: 'reduction-only-v1' } } } };
  model.forecastValidation = { accepted: true, episodes: 3, maxReductionHours: 1 };
  const intervals = Array.from({ length: hours * 4 }, (_, i) => ({ start: now + i * HOUR / 4,
    end: now + (i + 1) * HOUR / 4, outdoorC: 0, solarRadiationWm2: 0, price: i < 4 ? price : 1 }));
  const schedule = { preheatStart: now, preheatEnd: now, reductionStart: now, reductionEnd: now + HOUR,
    roomBoostC: 0, treatmentKey: 'reduction-only-v1' };
  const args = { intervals, model, initialState: { indoorC, reserveC: indoorC + 4.725 }, targetC: 21,
    occupancy: { mode: 'occupied' }, maxDropC: 2, maxRiseC: 2,
    equipment: { supplyC: 35, brineC: 0, nativeAuxAllowed: false }, config: {} };
  return { args, schedule, prediction: evaluateCycle({ ...args, schedule }), referencePrediction: evaluateCycle(args) };
}

test('tiny opportunities fail the monetary hurdle at every aggressiveness setting', () => {
  const input = fixture({ price: 1.1 });
  for (const savingsAggressiveness of [0, 50, 100]) {
    const admission = economicAdmission({ ...input, settings: { savingsAggressiveness } });
    assert.equal(admission.admitted, false);
    assert.ok(admission.minimumCents >= 10);
    assert.ok(admission.lowerBenefitCents <= admission.hurdleCents);
  }
});

test('a large price spike can clear conservative paired costs without negative discomfort credits', () => {
  const input = fixture({ price: 5000 });
  const admission = economicAdmission({ ...input, settings: { savingsAggressiveness: 50 } });
  assert.ok(admission.benefitCents > 100);
  assert.ok(admission.lowerBenefitCents <= admission.benefitCents - 5);
  assert.ok(admission.discomfortCents >= 0);
  assert.ok(admission.burdenCents > 0);
  assert.equal(admission.admitted, true);
});

test('already hot or individually hot occupied rooms reject preheat even at negative prices', () => {
  const { args, schedule } = fixture({ indoorC: 27, price: -5000 });
  const preheat = { ...schedule, preheatEnd: now + HOUR, reductionStart: now + HOUR,
    reductionEnd: now + 2 * HOUR, roomBoostC: 4, roomSettingC: 25 };
  const hot = evaluateCycle({ ...args, schedule: preheat });
  assert.equal(hot.severe, true);
  const mixed = evaluateCycle({ ...args, initialState: { indoorC: 21, reserveC: 21 }, schedule: preheat,
    equipment: { ...args.equipment, rooms: [{ id: 'cool-store', value: 19, targetC: 19, weight: 1 },
      { id: 'bedroom', value: 25, targetC: 21, weight: 1 }] } });
  assert.equal(mixed.severe, true);
});

test('paired scenarios remain valid at legal coefficient bounds', () => {
  for (const [lossPerHour, hydronicCPerKwh] of [[0.001, 0.005], [0.12, 0.6]]) {
    const input = fixture({ price: 100 });
    Object.assign(input.args.model.parameters, { lossPerHour, hydronicCPerKwh });
    input.prediction = evaluateCycle({ ...input.args, schedule: input.schedule });
    input.referencePrediction = evaluateCycle(input.args);
    assert.doesNotThrow(() => economicAdmission({ ...input, settings: { savingsAggressiveness: 50 } }));
  }
  assert.equal(THERMAL_PARAMETER_BOUNDS.hydronicCPerKwh[1], 0.6);
});

test('slider preference never changes candidate physical search or hard comfort limits', () => {
  const { args } = fixture({ price: 1.1, hours: 6 });
  const common = { now, observations: { indoor: { value: 21, observedAt: now } },
    prices: args.intervals.map(row => ({ ...row, allInCentsPerKWh: row.price })),
    forecast: args.intervals.map(row => ({ ...row, issuedAt: now })),
    checkpoint: { model: args.model, baselineC: 21 }, config: { learningTrials: false },
    equipment: { ...args.equipment, h66Available: true }, thermalState: args.initialState };
  const result = value => chooseCycle({ ...common, settings: { savingsAggressiveness: value,
    comfort: { targetC: 21, maxDropC: 2, maxRiseC: 2 }, occupancy: { mode: 'occupied' } } });
  const conservative = result(0), aggressive = result(100);
  assert.equal(conservative.plan, null); assert.equal(aggressive.plan, null);
  assert.deepEqual(conservative.evaluation.search, aggressive.evaluation.search);
});

function preheatStress(extra = {}) {
  const model = initialAdaptiveModel({ heatPumpModelConfirmed: true,
    floorThermalPriors: { capacityKwhPerC: 2, exchangeKwPerC: 0.25, openAllocationFraction: 0.7, closedAllocationFraction: 0 } });
  const intervals = Array.from({ length: 48 * 4 }, (_, i) => ({ start: now + i * HOUR / 4,
    end: now + (i + 1) * HOUR / 4, outdoorC: 21, solarRadiationWm2: 0, price: 5 }));
  return { model, intervals, initialState: { indoorC: 21, reserveC: 21, slabC: 21 }, targetC: 21,
    config: { auxRatedKw: 9 }, occupancy: { mode: 'occupied' }, maxDropC: 1, maxRiseC: 1,
    equipment: { supplyC: 35, brineC: 0, floorOverrideAvailable: true, floorOverrideMode: 'off' },
    schedule: { preheatStart: now, preheatEnd: now + HOUR, reductionStart: now + HOUR,
      reductionEnd: now + 1.5 * HOUR, roomBoostC: 2, floorOverride: true }, ...extra };
}

test('trial hot stress includes permitted AUX and delayed floor release after charging ends', () => {
  const args = preheatStress({ maxRiseC: 0.5 });
  const permitted = trialEnvelope(args), blocked = trialEnvelope({ ...args,
    equipment: { ...args.equipment, nativeAuxAllowed: false } });
  assert.equal(permitted.coldSafe, true);
  assert.ok(permitted.hotPeakC > blocked.hotPeakC, 'Rated AUX contributes only when the native mode permits it');
  assert.ok(permitted.hotPeakAt > args.schedule.preheatEnd, 'The conservative peak includes release after relay OFF');
  assert.ok(permitted.hotStressHours > 2);
  assert.equal(permitted.hotSafe, false);
  assert.equal(permitted.comfortSafe, false);
  assert.equal(permitted.hotStressReason, 'preheat-stress-room-upper-limit');
});

test('a warm bedroom and partial or unknown override feedback cannot be hidden by a cool average', () => {
  const args = preheatStress();
  const hotRoom = trialEnvelope({ ...args, equipment: { ...args.equipment, nativeAuxAllowed: false,
    rooms: [{ id: 'bedroom', value: 22, targetC: 21 }, { id: 'basement', value: 20, targetC: 21 }] } });
  assert.equal(hotRoom.hotSafe, false);
  for (const floorOverrideMode of ['partial', 'unknown']) {
    const invalid = trialEnvelope({ ...args, equipment: { ...args.equipment, floorOverrideMode } });
    assert.equal(invalid.comfortSafe, false);
    assert.equal(invalid.hotStressReason, 'unavailable-or-uncertain-floor-treatment');
  }
  const invalidCapacity = structuredClone(args); invalidCapacity.model.floor.capacityBudgetExceeded = true;
  assert.equal(trialEnvelope(invalidCapacity).hotSafe, false);
  const corruptCapacity = structuredClone(args); corruptCapacity.model.floor.capacityKwhPerC = 0;
  assert.equal(trialEnvelope(corruptCapacity).hotSafe, false);
});

test('short weather coverage cannot certify a slab whose delayed hot peak has not passed', () => {
  const args = preheatStress({ maxRiseC: 4 });
  const covered = trialEnvelope(args);
  assert.equal(covered.hotSafe, true);
  const truncated = trialEnvelope({ ...args, intervals: args.intervals.slice(0, 8) });
  assert.equal(truncated.hotSafe, false);
  assert.equal(truncated.hotStressReason, 'delayed-preheat-peak-not-covered');
  assert.equal(truncated.coldSafe, covered.coldSafe, 'The original no-heat reduction stress remains unchanged');
});

test('continuation still follows an already charged slab after the override has ended', () => {
  const args = preheatStress({ maxRiseC: 0.5, initialState: { indoorC: 21, reserveC: 21, slabC: 35 } });
  args.schedule = { ...args.schedule, preheatStart: now - HOUR, preheatEnd: now,
    reductionStart: now, reductionEnd: now + 0.5 * HOUR };
  const stress = trialEnvelope(args);
  assert.equal(stress.hotSafe, false);
  assert.ok(stress.hotPeakAt > now + 2 * HOUR);
  assert.ok(stress.hotStressHours > 2);
});
