import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAdaptiveModel, THERMAL_PARAMETER_BOUNDS } from '../src/control/adaptive-learning.js';
import { initialHomeState } from '../src/domain/home-model.js';
import { heatingExplorerFixture } from './helpers/heating-explorer-fixture.js';
import { evaluateCycle, economicAdmission, chooseCycle, trialEnvelope, recoveryPolicy,
  indoorUncertaintyAt, learningReadiness } from '../src/control/planner.js';

const HOUR = 3_600_000, now = Date.parse('2026-01-01T00:00:00Z');
test('unchanged compressor demand and no observed Normal AUX cannot invent savings at flat prices',()=>{
  for(const nativeAuxAllowed of [true,false,null]){
    const input=heatingExplorerFixture({hours:24,price:5});
    input.prices.forEach(row=>{row.allInCentsPerKWh=5;});
    input.settings.savingsStrategy='savings';input.equipment.nativeAuxAllowed=nativeAuxAllowed;
    input.checkpoint.model.equipmentResponse.phases.reduction.ratio=1;
    assert.equal(chooseCycle(input).plan,null);
    input.equipment.heatingDemand={observedThrough:input.now,normalAuxiliaryKw:0,auxiliaryCoveredHours:24};
    assert.equal(chooseCycle(input).plan,null);
  }
});

test('recorded Normal AUX is not multiplied a second time by learned recovery-risk calibration',()=>{
  for(const scale of [.25,1,4]){
    const {args}=fixture();args.model.energy.auxiliaryRiskScale=scale;
    args.equipment={...args.equipment,nativeAuxAllowed:true,
      heatingDemand:{observedThrough:now,normalAuxiliaryKw:1.5,auxiliaryCoveredHours:24}};
    const normal=evaluateCycle(args);
    assert.equal(normal.trajectory[0].auxiliaryKw,1.5);
  }
});
function fixture({ price = 1, hours = 24, indoorC = 21 } = {}) {
  const model = initialAdaptiveModel({ heatPumpModelConfirmed: true });
  model.uncertainty = { points: [{ hours: 24, errorC: 0.1 }], extrapolationCPerHour: 0.05 };
  model.validation = { accepted: true, kind: 'conditional-thermal', samples: 3,
    parameterEvidence: { lossPerHour: { status: 'identified' }, hydronicCPerKwh: { status: 'identified' } } };
  model.equipmentResponse = { phases: { reduction: { ratio: 0, trainingEpisodes: 3, treatmentKey: 'reduction-only-v1' } },
    validation: { phases: { reduction: { accepted: true, episodes: 3, maxDurationHours: 1, treatmentKey: 'reduction-only-v1' } } } };
  model.forecastValidation = { accepted: true, episodes: 3, maxReductionHours: 1, records: Array.from({length:3},(_,i)=>({id:`synthetic-advance-${i}`, treatmentKey:'reduction-only-v1', roomBoostC:0, preheatHours:0, reductionHours:1, temperatureMaeC:.2, minimumTemperatureErrorC:.3, energyRelativeError:.2, costRelativeError:.1})) };
  const intervals = Array.from({ length: hours * 4 }, (_, i) => ({ start: now + i * HOUR / 4,
    end: now + (i + 1) * HOUR / 4, outdoorC: 0, solarRadiationWm2: 0, price: i < 4 ? price : 1 }));
  const schedule = { preheatStart: now, preheatEnd: now, reductionStart: now, reductionEnd: now + HOUR,
    roomBoostC: 0, treatmentKey: 'reduction-only-v1' };
  const args = { intervals, model, initialState: initialHomeState(model,indoorC,0), targetC: 21,
    occupancy: { mode: 'occupied' }, maxDropC: 2, maxRiseC: 2,
    equipment: { supplyC: 35, brineC: 0, nativeAuxAllowed: false }, config: {} };
  return { args, schedule, prediction: evaluateCycle({ ...args, schedule }), referencePrediction: evaluateCycle(args) };
}

test('small robust benefits are eligible by default and monetary preferences remain configurable', () => {
  const input = fixture({ price: 1.1 });
  for (const savingsStrategy of ['gentle', 'balanced', 'savings']) {
    const admission = economicAdmission({ ...input, settings: { savingsStrategy } });
    assert.equal(admission.admitted, true);
    assert.ok(admission.lowerBenefitCents > 0);
    const configured=economicAdmission({...input,args:{...input.args,config:{minimumHomeBenefitCents:10}},settings:{savingsStrategy}});
    assert.equal(configured.admitted,false);
    assert.equal(configured.minimumCents,10);
  }
});

test('a large price spike can clear conservative paired costs without negative discomfort credits', () => {
  const input = fixture({ price: 5000 });
  const admission = economicAdmission({ ...input, settings: { savingsStrategy: 'balanced' } });
  assert.ok(admission.benefitCents > 100);
  assert.ok(admission.lowerBenefitCents <= admission.benefitCents);
  assert.ok(admission.discomfortCents >= 0);
  assert.equal(admission.burdenCents, 0);
  assert.equal(admission.admitted, true);
});

test('named strategies share physical predictions and default to More savings', () => {
  assert.throws(() => economicAdmission({ ...fixture(), settings: { savingsStrategy: 'unknown' } }), /Savings strategy/);
  for (const [price, expected] of [[1, [false, false, false]], [2, [true, true, true]], [10, [true, true, true]]]) {
    const input = fixture({ price });
    const admissions = ['gentle', 'balanced', 'savings'].map(savingsStrategy =>
      economicAdmission({ ...input, settings: { savingsStrategy } }));
    assert.deepEqual(admissions.map(row => row.admitted), expected);
    assert.deepEqual(admissions.map(row => row.minimumCents), [0, 0, 0]);
    assert.equal(new Set(admissions.map(row => row.lowerBenefitCents)).size, 1, 'Policy cannot change the physical forecast');
    assert.deepEqual(economicAdmission(input), admissions[2]);
  }
});

test('strategy retention selects shorter cycles from the same economically admitted candidates', () => {
  const input = heatingExplorerFixture({ hours: 24, maxReductionHours: 12, validatedHours: 24, price: 10 });
  const results = ['gentle', 'balanced', 'savings'].map(savingsStrategy => chooseCycle({ ...input,
    settings: { ...input.settings, savingsStrategy } }));
  const best = results[2].plan.economics.lowerBenefitCents;
  assert.deepEqual(results.map(row => (row.plan.schedule.reductionEnd - row.plan.schedule.reductionStart) / HOUR), [4, 6, 8]);
  for (const [index, fraction] of [.6, .8, 1].entries()) {
    const result = results[index];
    assert.ok(result.plan.economics.lowerBenefitCents >= best * fraction);
    assert.equal(result.plan.economics.minimumCents, 0);
    assert.equal(result.plan.economics.discomfortCents, 0);
    assert.deepEqual(result.diagnostics, results[2].diagnostics, 'Strategy changes selection, not admission or physical search');
  }
});

test('monetary overrides, retained start penalties and continuation are independent of strategy', () => {
  const input = fixture({ price: 5000 });
  input.args.config = { minimumHomeBenefitCents: 2, homeDiscomfortCentsPerDegreeSquaredHour: 5,
    cycleStartCostCents: 7, cycleHourCostCents: 3 };
  const results = ['gentle', 'balanced', 'savings'].map(savingsStrategy =>
    economicAdmission({ ...input, settings: { savingsStrategy } }));
  assert.deepEqual(results[0], results[1]); assert.deepEqual(results[1], results[2]);
  assert.equal(results[0].minimumCents, 2);
  assert.equal(results[0].burdenCents, 10, 'A new one-hour cycle includes both start and duration penalties');
  const continued = economicAdmission({ ...input, continuing: true });
  assert.equal(continued.minimumCents, 0);
  assert.equal(continued.burdenCents, 3, 'Continuation omits the start penalty but keeps the duration penalty');
  input.args.config.minimumHomeBenefitCents = -2;
  assert.equal(economicAdmission({ ...input, continuing: true }).minimumCents, -2);
});

test('uncertainty floor takes precedence only when greater and remains in continuation', () => {
  const input = fixture({ price: 5000 }), original = economicAdmission(input);
  assert.ok(original.uncertaintyCents > 0);
  input.args.config.economicUncertaintyFloorCents = original.uncertaintyCents / 2;
  assert.deepEqual(economicAdmission(input), original, 'A smaller floor adds no second deduction');
  input.args.config.economicUncertaintyFloorCents = original.uncertaintyCents + 10;
  for (const continuing of [false, true]) {
    const result = economicAdmission({ ...input, continuing });
    assert.equal(result.uncertaintyCents, original.uncertaintyCents + 10);
    assert.equal(result.lowerBenefitCents, original.lowerBenefitCents - 10);
  }
});

test('an already hot occupied indoor average rejects preheat even at negative prices', () => {
  const { args, schedule } = fixture({ indoorC: 27, price: -5000 });
  const preheat = { ...schedule, preheatEnd: now + HOUR, reductionStart: now + HOUR,
    reductionEnd: now + 2 * HOUR, roomBoostC: 4, roomSettingC: 25 };
  const hot = evaluateCycle({ ...args, schedule: preheat });
  assert.equal(hot.severe, true);
  for (const savingsStrategy of ['gentle', 'balanced', 'savings']) {
    const admission = economicAdmission({ args, schedule: preheat, prediction: hot,
      referencePrediction: evaluateCycle(args), settings: { savingsStrategy } });
    assert.equal(admission.unsafe, true);
    assert.equal(admission.admitted, false, `${savingsStrategy} must preserve the indoor upper bound`);
  }
});

test('paired scenarios remain valid at legal coefficient bounds', () => {
  for (const [lossPerHour, hydronicCPerKwh] of [[0.001, 0.005], [0.12, 0.6]]) {
    const input = fixture({ price: 100 });
    Object.assign(input.args.model.parameters, { lossPerHour, hydronicCPerKwh });
    input.prediction = evaluateCycle({ ...input.args, schedule: input.schedule });
    input.referencePrediction = evaluateCycle(input.args);
    assert.doesNotThrow(() => economicAdmission({ ...input, settings: { savingsStrategy: 'balanced' } }));
  }
  assert.equal(THERMAL_PARAMETER_BOUNDS.hydronicCPerKwh[1], 0.6);
});

test('savings strategy never changes candidate physical search or hard comfort limits', () => {
  const { args } = fixture({ price: 1.1, hours: 6 });
  const common = { now, observations: { indoor: { value: 21, observedAt: now } },
    prices: args.intervals.map(row => ({ ...row, allInCentsPerKWh: row.price })),
    forecast: args.intervals.map(row => ({ ...row, issuedAt: now })),
    checkpoint: { model: args.model, baselineC: 21 }, config: { learningTrials: false },
    equipment: { ...args.equipment, h66Available: true }, thermalState: args.initialState };
  const result = value => chooseCycle({ ...common, settings: { savingsStrategy: value,
    comfort: { targetC: 21, maxDropC: 2, maxRiseC: 2 }, occupancy: { mode: 'occupied' } } });
  const conservative = result('gentle'), aggressive = result('savings');
  assert.deepEqual(conservative.plan?.search??conservative.evaluation.search,
    aggressive.plan?.search??aggressive.evaluation.search);
  for(const result of [conservative,aggressive])if(result.plan){
    assert.equal(result.plan.maxDropC,2);assert.equal(result.plan.maxRiseC,2);
    assert.equal(result.plan.prediction.severe,false);
  }
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
  assert.equal(permitted.hotStressReason, 'preheat-stress-indoor-upper-limit');
});

test('partial or unknown override feedback cannot be admitted by a comfortable average', () => {
  const args = preheatStress();
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
  assert.equal(truncated.reason, 'forecast-coverage-lost');
  assert.equal(truncated.available, false);
  assert.equal(truncated.coldSafe, false, 'Missing cycle weather prevents either stress from certifying safety');
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

test('sensor estimate uncertainty widens every forecast comfort bound without changing the central temperature', () => {
  const { args, schedule } = fixture({ hours: 6 });
  const measured = evaluateCycle({ ...args, schedule });
  const estimated = evaluateCycle({ ...args, schedule, equipment: { ...args.equipment,
    indoorEstimated: true, indoorUncertaintyC: 0.2, indoorUncertaintyGrowthCPerHour: 0.02 } });
  assert.equal(estimated.trajectory.length, measured.trajectory.length);
  for (const [index, row] of estimated.trajectory.entries()) {
    const original = measured.trajectory[index];
    assert.equal(row.indoorC, original.indoorC);
    const extra = row.uncertaintyC - original.uncertaintyC;
    assert.ok(extra >= .2);
  }
  assert.ok(estimated.trajectory.at(-1).uncertaintyC - measured.trajectory.at(-1).uncertaintyC
    > estimated.trajectory[0].uncertaintyC - measured.trajectory[0].uncertaintyC);
  const unsupported = evaluateCycle({ ...args, schedule, equipment: { ...args.equipment, indoorEstimated: true } });
  assert.equal(unsupported.severe, true);
  assert.ok(unsupported.violations.some(row => row.code === 'indoor-uncertainty-unavailable'));
  assert.equal(unsupported.trajectory[0].uncertaintyC, null);
});

test('sensor estimate age ends forecast eligibility without serializing infinite uncertainty', () => {
  const { args, schedule } = fixture({ hours: 6 });
  const equipment = { ...args.equipment, indoorEstimated: true, indoorUncertaintyC: .1,
    indoorUncertaintyGrowthCPerHour: .01, indoorEstimateValidUntil: now + HOUR / 2 };
  assert.ok(Math.abs(indoorUncertaintyAt(equipment, .5, now + HOUR / 2) - .105) < 1e-12);
  assert.equal(indoorUncertaintyAt(equipment, 1, now + HOUR), null);
  const result = evaluateCycle({ ...args, schedule, equipment });
  assert.equal(result.severe, true);
  assert.ok(result.violations.some(row => row.code === 'indoor-estimate-expired'));
  assert.ok(result.trajectory.every(row => row.uncertaintyC === null || Number.isFinite(row.uncertaintyC)));
});

test('source uncertainty affects cold margin while provisional reference preserves configured limits', () => {
  const { args, schedule } = fixture({ hours: 6 });
  const ordinary = trialEnvelope({ ...args, schedule });
  assert.equal(ordinary.coldSafe, true);
  const uncertain = trialEnvelope({ ...args, schedule,
    equipment: { ...args.equipment, indoorEstimated: true, indoorUncertaintyC: 1.1 } });
  assert.equal(uncertain.coldSafe, false);
  assert.ok(uncertain.floorC < 20);
  assert.equal(trialEnvelope({ ...args, schedule,
    equipment: { ...args.equipment, comfortReferenceProvisional: true } }).coldSafe, true);
  assert.equal(trialEnvelope({...args,schedule,maxDropC:.25}).coldSafe,false);
});

test('hot stress includes the estimated source margin and rejects an expired estimate', () => {
  const args = preheatStress({ maxRiseC: 4 });
  assert.equal(trialEnvelope(args).hotSafe, true);
  const uncertain = trialEnvelope({ ...args, equipment: { ...args.equipment,
    indoorEstimated: true, indoorUncertaintyC: 4 } });
  assert.equal(uncertain.hotSafe, false);
  assert.equal(uncertain.hotStressReason, 'preheat-stress-indoor-upper-limit');
  const expired = trialEnvelope({ ...args, equipment: { ...args.equipment,
    indoorEstimated: true, indoorUncertaintyC: .1, indoorEstimateValidUntil: now + HOUR } });
  assert.equal(expired.hotSafe, false);
  assert.equal(expired.hotStressReason, 'preheat-stress-indoor-estimate-unavailable');
});

test('aggregate source uncertainty triggers native recovery before the estimated central value is cold', () => {
  const args = { now: now + HOUR / 4, reductionEnd: now, indoorC: 21, targetC: 21,
    equipment: { h66Available: true } };
  assert.equal(recoveryPolicy(args).recoveryCompressorOnly, true);
  const result = recoveryPolicy({ ...args,
    equipment: { ...args.equipment, indoorEstimated: true, indoorUncertaintyC: .6 } });
  assert.equal(result.recoveryCompressorOnly, false);
  assert.equal(result.recoveryFallbackReason, 'recovery-comfort-margin');
  assert.equal(recoveryPolicy({ ...args, equipment: { ...args.equipment, indoorEstimated: true } }).recoveryCompressorOnly, false);
});

test('estimated indoor evidence never admits a new learning trial', () => {
  const { args } = fixture();
  const checkpoint = { model: args.model, health: { usableSamples: 100 } };
  const equipment = { compressorOn: 1, dhwRouting: 0 };
  assert.equal(learningReadiness(checkpoint, { learningTrials: true }, equipment).trialReady, true);
  assert.equal(learningReadiness(checkpoint, { learningTrials: true }, { ...equipment,
    indoorEstimated: true, indoorUncertaintyC: .1 }).trialReady, false);
});

test('matching central temperatures cannot finish forecast recovery while source uncertainty exceeds its margin', () => {
  const { args, schedule } = fixture({ hours: 4 });
  const common = { ...args, initialState: { indoorC: 21, reserveC: 21 },
    intervals: args.intervals.map(row => ({ ...row, outdoorC: 21 })),
    schedule: { ...schedule, reductionEnd: now } };
  const measured = evaluateCycle(common);
  assert.ok(measured.recoveredAt !== null);
  assert.ok(measured.trajectory.some(row => row.phase === 'normal'));
  const uncertain = evaluateCycle({ ...common, equipment: { ...args.equipment,
    indoorEstimated: true, indoorUncertaintyC: .2 } });
  assert.equal(uncertain.recoveredAt, null);
  assert.equal(uncertain.completeRecoveryPredicted, false);
  assert.ok(uncertain.trajectory.every(row => row.phase === 'recovery'));
});
