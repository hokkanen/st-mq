import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { exploreHeatingPlan, validateExplorerOverrides, applyExplorerOverrides } from '../src/control/heating-explorer.js';
import { chooseCycle, evaluateCycle, forecastIntervals, revalidatePlan } from '../src/control/planner.js';
import { heatingExplorerFixture } from './helpers/heating-explorer-fixture.js';

const HOUR = 3_600_000;
const options = { includePlan: true, includeOpportunities: false };

test('normal reference reports its actual temperature separately from the allowed drop',()=>{
  const input=heatingExplorerFixture();input.equipment.comfortReferenceProvisional=true;
  input.settings.comfort.targetC=21.25;input.settings.comfort.maxDropC=1.5;
  let result=exploreHeatingPlan(input,{},options);
  const reference=result.constraints.find(row=>row.key==='normalReference');
  assert.equal(reference.value,21.25);assert.equal(reference.unit,'°C');assert.equal(reference.status,'learning');
  assert.equal(result.constraints.find(row=>row.key==='maxDropC').value,1.5);
  input.settings.comfort.targetC=null;input.checkpoint.baselineC=null;input.observations.indoor.stale=true;
  result=exploreHeatingPlan(input,{},options);
  assert.equal(result.constraints.find(row=>row.key==='normalReference').value,null);
});

test('discarding some alternatives does not label available economics or forecast coverage blocked',()=>{
  const economic=heatingExplorerFixture();economic.config.minimumHomeBenefitCents=5;
  const decision=chooseCycle(economic);
  assert.ok(decision.plan&&decision.diagnostics.economicsRejected>0&&decision.diagnostics.economicsAdmitted>0);
  assert.equal(exploreHeatingPlan(economic,{},options).constraints.find(row=>row.key==='economicAdmission').status,'available');
  const horizon=heatingExplorerFixture();
  horizon.prices.forEach(row=>{row.allInCentsPerKWh=row.start>=horizon.now+9.5*HOUR?500:1;});
  const covered=chooseCycle(horizon);assert.ok(covered.plan&&covered.diagnostics.forecastRejected>0);
  assert.equal(exploreHeatingPlan(horizon,{},options).constraints.find(row=>row.key==='forecastCoverage').status,'available');
});

test('demonstrated ROOM increase belongs to the requested treatment, not another floor treatment',()=>{
  const input=heatingExplorerFixture(),response=input.checkpoint.model.equipmentResponse;
  Object.assign(input.equipment,{preheatAvailable:true,roomSettingC:21});
  const estimate=(key,boost)=>({ratio:1,trainingEpisodes:3,treatmentKey:key,
    validation:{accepted:true,episodes:3,treatmentKey:key,maxRoomBoostC:boost,maxDurationHours:2}});
  const room=estimate('room-boost-v1',1),floor=estimate('room-boost-floor-v1',5);
  response.treatments={preheat:{'room-boost-v1':room,'room-boost-floor-v1':floor}};
  response.phases.preheat=floor;response.validation.phases.preheat=floor.validation;
  const result=exploreHeatingPlan(input,{},options);
  assert.equal(result.constraints.find(row=>row.key==='validatedPreheatBoostC').value,1);
});

test('unchanged scenario uses the ordinary planner and leaves every frozen input unchanged', () => {
  const input = heatingExplorerFixture(), before = structuredClone(input);
  const decision = chooseCycle(input), result = exploreHeatingPlan(input, {}, options);
  assert.ok(decision.plan, 'Synthetic opportunity must exercise a real admitted schedule');
  assert.deepEqual(result.executablePlan, decision.plan);
  assert.deepEqual(result.current.schedule, decision.plan.schedule);
  assert.equal(result.comparison.additionalBenefitCents, 0);
  assert.equal(result.comparison.changed, false);
  assert.deepEqual(input, before);
  assert.equal(result.scenario.outcomes.costIncludesTail, true);
  assert.equal(result.scenario.outcomes.energyIncludesTail, false);
  assert.ok(result.scenario.outcomes.recoveryCostCents >= 0);
  assert.ok(result.scenario.outcomes.terminalCostCents >= 0);
  assert.ok(result.scenario.outcomes.coldestIndoor.at >= input.now);
});

test('retained actual pending plan stays the main reference when fresh optimization differs', () => {
  const input = heatingExplorerFixture(), decision = chooseCycle(input);
  input.currentPlan = { ...decision.plan, schedule: { ...decision.plan.schedule,
    reductionEnd: decision.plan.schedule.reductionStart + .25 * HOUR } };
  input.currentDecision = { action: 'normal', phase: 'normal', reasons: ['previously-selected-opportunity'] };
  const result = exploreHeatingPlan(input, {}, options);
  assert.deepEqual(result.current.schedule, input.currentPlan.schedule);
  assert.deepEqual(result.refreshedCurrent.schedule, decision.plan.schedule);
  assert.equal(result.currentDiffersFromRecalculation, true);
  assert.equal(result.current.origin, 'selected');
  assert.equal(result.comparison.additionalBenefitCents, result.current.outcomes.costCents - result.scenario.outcomes.costCents);
});

test('hypothetical settings map to the same planner without changing evidence or defaults', () => {
  const input = heatingExplorerFixture(), before = structuredClone(input);
  const changes = { maxReductionHours: 8, maxDropC: 1.5, maxRiseC: 1.75, maxPreheatHours: 3,
    preheatRoomBoostC: 2, savingsStrategy: 'savings' };
  const mapped = applyExplorerOverrides(input, changes), result = exploreHeatingPlan(input, changes, options);
  assert.deepEqual(result.executablePlan, chooseCycle(mapped).plan);
  assert.deepEqual(mapped.checkpoint, input.checkpoint);
  assert.deepEqual(mapped.equipment, input.equipment);
  assert.equal(mapped.settings.comfort.maxDropC, 1.5);
  assert.equal(mapped.config.preheatRoomBoostC, 2);
  assert.deepEqual(input, before);
  assert.equal(result.computation.plannerRuns, 2);
});

test('reviewed policy can permit an experiment without positive predicted savings or automatic budget',()=>{
  const input=heatingExplorerFixture({price:2,hours:12});
  input.prices.forEach(row=>{row.allInCentsPerKWh=2;});
  input.checkpoint.model.equipmentResponse.phases.reduction.ratio=1.1;
  assert.equal(chooseCycle(input).plan,null);
  const result=exploreHeatingPlan(input,{minimumHomeBenefitCents:-1000,homeDiscomfortCentsPerDegreeSquaredHour:0,
    cycleStartCostCents:0,cycleHourCostCents:0},{...options});
  assert.ok(result.executablePlan);
  assert.ok(result.executablePlan.economics.lowerBenefitCents<0);
  assert.equal(input.config.minimumHomeBenefitCents,undefined,'Preview never edits defaults');
});

test('an explicit one-cycle learning allowance is separate from an exhausted automatic allowance',()=>{
  const input=heatingExplorerFixture({price:2,hours:12});
  input.prices.forEach(row=>{row.allInCentsPerKWh=2;});
  const proposed=applyExplorerOverrides(input,{learningTrials:true,maxTrialCostCents:151,maxDropC:3,maxRiseC:3,maxUnobservedReductionHours:4});
  assert.equal(proposed.trialBudgetRemainingCents,151);
  assert.equal(proposed.config.learningTrials,true);
  assert.equal(proposed.config.maxUnobservedReductionHours,4);
  assert.equal(input.trialBudgetRemainingCents,0);
  assert.equal(input.config.learningTrials,false);
  assert.ok(exploreHeatingPlan(proposed,{},options).executablePlan);
});

test('unchanged learning fields and permission/priority edits preserve automatic trial restrictions', () => {
  const input = heatingExplorerFixture(), before = structuredClone(input);
  const same = applyExplorerOverrides(input, { learningTrials: false, maxTrialCostCents: 150, learningPriorityPriceCents: 15 });
  assert.equal(same.config.learningTrials, false);
  assert.equal(same.trialBudgetRemainingCents, 0);
  for (const changes of [{ learningTrials: true }, { learningPriorityPriceCents: 20 },
    { learningTrials: true, learningPriorityPriceCents: 20, maxTrialCostCents: 150 }]) {
    const mapped = applyExplorerOverrides(input, changes);
    assert.equal(mapped.trialBudgetRemainingCents, 0);
    assert.equal(mapped.config.maxTrialCostCents, 150);
  }
  const changedBudget = applyExplorerOverrides(input, { maxTrialCostCents: 151 });
  assert.equal(changedBudget.config.learningTrials, false, 'Budget changes do not grant trial permission');
  assert.equal(changedBudget.trialBudgetRemainingCents, 151);
  const zero = applyExplorerOverrides(input, { learningTrials: true, maxTrialCostCents: 0 });
  assert.equal(zero.config.learningTrials, true); assert.equal(zero.trialBudgetRemainingCents, 0);
  assert.deepEqual(input, before);
});

test('learning context reports the captured allowance and never invents a missing original budget', () => {
  const input = heatingExplorerFixture(); input.config.learningTrials = true;
  for (const remaining of [0, 25, null, undefined]) {
    input.trialBudgetRemainingCents = remaining;
    const result = exploreHeatingPlan(input, { maxTrialCostCents: 150, learningTrials: true }, options);
    assert.equal(result.learningContext.remainingAutomaticAllowanceCents, remaining ?? null);
    assert.equal(result.learningContext.perCycleLimitCents, 150);
    assert.equal(result.learningContext.allowanceBasis, 'captured-automatic');
    assert(!result.changedKeys.includes('maxTrialCostCents'));
    if (remaining == null) assert.equal(result.scenario.trial, false);
    if (result.scenario.trial) assert(result.scenario.trialExposureCents <= remaining);
  }
  const explicit = exploreHeatingPlan(input, { maxTrialCostCents: 151 }, options);
  assert.equal(explicit.learningContext.remainingAutomaticAllowanceCents, null);
  assert.equal(explicit.learningContext.allowanceBasis, 'reviewed-one-cycle');
  for (const bad of [0, 1, 'true', 'false', null]) assert.throws(() => validateExplorerOverrides({ learningTrials: bad }), /boolean/);
});

test('initial operation beyond demonstrated duration never manufactures validation', () => {
  const input = heatingExplorerFixture({ validatedHours: 1 });
  const result = exploreHeatingPlan(input, { maxReductionHours: 8 }, options);
  assert.equal(result.evidence.validatedReductionHours, 1);
  assert.ok(result.executablePlan);
  assert.equal(input.checkpoint.model.forecastValidation.maxReductionHours, 1);
  assert.ok(result.illustrative);
  assert.equal(result.illustrative.executable, false);
  assert.equal(result.illustrative.extrapolated, true);
  assert.ok(result.illustrative.reasons.includes('outside-demonstrated-duration'));
  assert.equal((result.illustrative.schedule.reductionEnd - result.illustrative.schedule.reductionStart) / HOUR, 8);
  assert.ok(result.constraints.some(row => row.key === 'validatedReductionHours' && row.status === 'initial'));
});

test('strict scenario input rejects evidence, protection, arbitrary fields and invalid limits', () => {
  for (const input of [null, [], 4, { maxDropC: 35.01 }, { maxRiseC: 0 }, { maxReductionHours: 47 },
    { maxAwayReductionHours: 47 }, { maxPreheatHours: 25 }, { maxDropC: '1.5' }, { maxDropC: NaN },
    { preheatRoomBoostC: 2.5 }, { learningTrials: 'true' }, { trialBudgetRemainingCents: 999 },
    { model: {} }, { thermalValidated: true }, { maxUnobservedReductionHours: 47 },
    { savingsStrategy: 'aggressive' }, JSON.parse('{"__proto__":{}}')])
    assert.throws(() => validateExplorerOverrides(input));
  assert.deepEqual(validateExplorerOverrides({ maxDropC: 0, maxRiseC: .25 }), { maxDropC: 0, maxRiseC: .25 });
});

test('missing or stale observations remain unknown and never produce numerical predictions', () => {
  for (const indoor of [{ value: null, observedAt: null }, { value: 21, observedAt: Date.now(), stale: false },
    { value: 21, observedAt: heatingExplorerFixture().now, stale: true }]) {
    const input = heatingExplorerFixture(); input.observations.indoor = indoor;
    const result = exploreHeatingPlan(input, { maxReductionHours: 8 }, options);
    assert.equal(result.executablePlan, null);
    assert.equal(result.current.outcomes, null);
    assert.equal(result.scenario.outcomes, null);
    assert.equal(result.illustrative, null);
    assert.equal(result.comparison.additionalBenefitCents, null);
    assert.equal(result.indoorInput.available, false);
    assert.equal(result.indoorInput.uncertaintyC, null);
    assert.deepEqual(result.opportunities, []);
  }
});

test('unavailable native telemetry adds its separate ceiling within the ordinary reduction ceiling', () => {
  const input = heatingExplorerFixture({ validatedHours: .5 });
  input.equipment.h66Available = false;
  const result = exploreHeatingPlan(input, { maxReductionHours: 8 });
  if (result.scenario.schedule) assert.ok((result.scenario.schedule.reductionEnd - result.scenario.schedule.reductionStart) / HOUR <= .5);
  assert.ok(result.constraints.some(row => row.key === 'unobservedEquipment' && row.status === 'blocking'));
  assert.deepEqual(result.opportunities, []);
  assert.equal(Object.hasOwn(result, 'executablePlan'), false);
  assert.equal(JSON.stringify(result).includes('equipmentResponse'), false);
});

test('fresh native telemetry does not display an outage ceiling during an owned setting transition', () => {
  const input = heatingExplorerFixture();
  Object.assign(input.equipment, { h66Available: false, reductionTelemetryAvailable: true });
  const result = exploreHeatingPlan(input, {});
  assert.equal(result.constraints.some(row => row.key === 'unobservedEquipment'), false);
});

test('shared evaluator reports the weighted indoor boundary and conservative temperature at rejection', () => {
  const input = heatingExplorerFixture();
  const schedule = { preheatStart: input.now, preheatEnd: input.now, reductionStart: input.now,
    reductionEnd: input.now + HOUR, roomBoostC: 0, treatmentKey: 'reduction-only-v1' };
  const args = { schedule, model: input.checkpoint.model,
    intervals: forecastIntervals(input.prices, input.forecast, input.now), initialState: input.thermalState,
    targetC: 21, maxDropC: .1, maxRiseC: 2, equipment: input.equipment };
  const result = evaluateCycle(args), violation = result.violations.find(row => row.code === 'indoor-drop-limit');
  assert.equal(result.severe, true);
  assert.equal(Object.hasOwn(violation, 'roomId'), false);
  assert.ok(violation.at > input.now);
  assert.ok(violation.value < violation.limit);
  assert.equal(violation.limit, 20.9);
  assert.ok(result.violations.length <= 24);
});

test('forecast coverage prevents an illustrative reduction with unpriced recovery', () => {
  const result = exploreHeatingPlan(heatingExplorerFixture({ hours: 8 }), { maxReductionHours: 8 }, options);
  assert.equal(result.illustrative, null);
});

test('automatic attention requires a tested improvement, never merely a reached ceiling', () => {
  const input = heatingExplorerFixture({ validatedHours: .5, maxReductionHours: .5, maxDropC: 2 });
  const result = exploreHeatingPlan(input);
  assert.ok(result.computation.plannerRuns <= 4);
  for (const opportunity of result.opportunities) {
    assert.ok(opportunity.additionalBenefitCents > 10);
    assert.equal(opportunity.scenario.economics.admitted, true);
  }
  const boundary = result.constraints.find(row => row.key === 'maxReductionHours');
  if (boundary.status === 'blocking') assert.ok(result.opportunities.some(row => row.key === 'maxReductionHours'));
});

test('a useful relaxation explains the duration ceiling against fresh and actual selected plans', () => {
  const input = heatingExplorerFixture(), actual = chooseCycle(input).plan;
  input.currentPlan = { ...actual, schedule: { ...actual.schedule, reductionEnd: actual.schedule.reductionStart + 2 * HOUR } };
  const result = exploreHeatingPlan(input), opportunity = result.opportunities.find(row => row.key === 'maxReductionHours');
  assert.ok(opportunity, 'A validated longer reduction must create the advisory opportunity');
  assert.deepEqual(opportunity.overrides, { maxReductionHours: 8 });
  assert.equal(result.current.schedule.reductionEnd, input.currentPlan.schedule.reductionEnd);
  assert.equal(result.refreshedCurrent.schedule.reductionEnd, actual.schedule.reductionEnd);
  assert.ok(opportunity.scenario.economics.admitted);
  assert.ok(opportunity.additionalBenefitCents > 10);
  assert.equal(opportunity.additionalBenefitCents, result.current.outcomes.costCents - opportunity.scenario.outcomes.costCents);
  assert.equal(result.constraints.find(row => row.key === 'maxReductionHours').status, 'blocking');
  assert.ok(result.computation.plannerRuns <= 4);
});

test('two interacting policy limits produce a combined opportunity only after individual probes fail', () => {
  const input = heatingExplorerFixture({ maxReductionHours: .5, maxDropC: .6 });
  const result = exploreHeatingPlan(input);
  assert.equal(result.computation.plannerRuns, 4);
  assert.equal(result.opportunities.length, 1);
  assert.deepEqual(result.opportunities[0].overrides, { maxReductionHours: 1, maxDropC: 1.1 });
  assert.ok(result.opportunities[0].additionalBenefitCents > 10);
});

test('indoor extrema and deviations use the single weighted average reference', () => {
  const input = heatingExplorerFixture();
  const result = exploreHeatingPlan(input, {}, options);
  assert.equal(result.normal.outcomes.coldestIndoor.label, 'Weighted indoor average');
  assert.equal(result.normal.outcomes.coldestIndoor.referenceC, 21);
  assert.equal(result.normal.outcomes.warmestIndoor.referenceC, 21);
  assert.equal(result.normal.outcomes.maxIndoorDropC, Math.max(0, 21 - result.normal.outcomes.coldestIndoor.valueC));
  assert.equal(result.normal.outcomes.maxIndoorRiseC, Math.max(0, result.normal.outcomes.warmestIndoor.valueC - 21));
});

test('comparison extremes include the captured starting temperature before normal recovery', () => {
  for (const initial of [18, 25]) {
    const input = heatingExplorerFixture();
    input.observations.indoor.value = initial;
    input.thermalState.indoorC = initial;
    const result = exploreHeatingPlan(input, {}, options), normal = result.normal;
    const extreme = initial < 21 ? normal.outcomes.coldestIndoor : normal.outcomes.warmestIndoor;
    assert.equal(extreme.valueC, initial);
    assert.equal(extreme.at, input.now);
    assert.equal(normal.outcomes[initial < 21 ? 'maxIndoorDropC' : 'maxIndoorRiseC'], Math.abs(initial - 21));
    assert.equal(normal.trajectory[0].at, input.now);
    assert.equal(normal.trajectory[0].indoorC, initial);
    assert.equal(normal.evaluationStartAt, input.now);
    assert.equal(normal.evaluationEndAt, input.prices.at(-1).end);
  }
});

test('an earlier missing-temperature gate cannot claim that absent forecast coverage is available', () => {
  const input = heatingExplorerFixture();
  input.observations.indoor.value = null;
  input.prices = [];
  input.forecast = [];
  const result = exploreHeatingPlan(input, {}, options);
  assert.equal(result.constraints.find(row => row.key === 'forecastCoverage').status, 'blocking');
  assert.equal(result.current.outcomes, null);
});

test('retained current economics are recomputed rather than mixing a previous frozen forecast', () => {
  const input = heatingExplorerFixture();
  input.currentPlan = chooseCycle(input).plan;
  input.currentPlan.economics = { ...input.currentPlan.economics, benefitCents: 999999, lowerBenefitCents: 999998 };
  input.currentDecision = { action: 'normal', phase: 'recovery', reasons: ['forced-recovery'] };
  const result = exploreHeatingPlan(input, {}, options);
  assert.equal(result.current.phase, 'recovery');
  assert.equal(result.current.economics.benefitCents, result.current.estimatedBenefitCents);
  assert.notEqual(result.current.lowerBenefitCents, 999998);
});

test('active scenario limits remain visible separately from configured defaults and fresh scenarios', () => {
  const input = heatingExplorerFixture({ maxDropC: 1 });
  input.currentPlan = chooseCycle(applyExplorerOverrides(input, { maxDropC: 2, savingsStrategy: 'savings' })).plan;
  assert.ok(input.currentPlan);
  const result = exploreHeatingPlan(input, {}, options);
  const drop = result.controls.find(row => row.key === 'maxDropC');
  assert.equal(drop.value, 1);
  assert.equal(drop.effectiveValue, 2);
  assert.equal(drop.scenarioValue, 1);
  assert.equal(result.current.limits.savingsStrategy, 'savings');
  assert.equal(result.current.outcomes.comfortSafe, true);
});

test('cancelled scenario recovery uses restored current limits without rewriting the frozen approval', () => {
  const input = heatingExplorerFixture({ maxDropC: 1.5 });
  input.currentPlan = chooseCycle(applyExplorerOverrides(input, { maxDropC: 2,
    maxReductionHours: 8, savingsStrategy: 'savings' })).plan;
  assert.ok(input.currentPlan);
  input.currentPlan.schedule.reductionEnd = input.now;
  input.currentDecision = { phase: 'recovery', action: 'normal', reasons: ['admin-cancelled-scenario'] };
  input.currentSettings = structuredClone(input.settings);
  input.currentConfig = structuredClone(input.config);
  input.observations.indoor.value = 19.4;
  input.thermalState.indoorC = 19.4;
  const frozenPlan = structuredClone(input.currentPlan);
  const result = exploreHeatingPlan(input, {}, options);
  assert.equal(result.current.phase, 'recovery');
  assert.equal(result.current.limits.maxDropC, 1.5);
  assert.equal(result.current.limits.maxReductionHours, 4);
  assert.equal(result.current.limits.savingsStrategy, 'balanced');
  assert.equal(result.controls.find(row => row.key === 'maxDropC').effectiveValue, 1.5);
  assert.deepEqual(input.currentPlan, frozenPlan);
  const expected = evaluateCycle({ schedule: input.currentPlan.schedule,
    intervals: forecastIntervals(input.prices, input.forecast, input.now), model: input.checkpoint.model,
    initialState: input.thermalState, targetC: input.settings.comfort.targetC,
    occupancy: input.settings.occupancy, maxDropC: 1.5, maxRiseC: 2,
    config: input.currentConfig, equipment: input.equipment });
  assert.equal(result.current.outcomes.costCents, expected.costCents);
  assert.equal(result.current.outcomes.comfortSafe, false, 'The restored 1.5 °C boundary must govern the evaluated recovery');
  assert.equal(result.current.outcomes.comfortSafe, !expected.severe);
  assert.deepEqual(result.current.outcomes.violations, expected.violations);
  assert.ok(result.current.outcomes.violations.some(row => row.code === 'indoor-drop-limit' && row.limit === 19.5));
});

test('increasing the preheat ceiling above two hours expands the actual bounded planner search', () => {
  const input = heatingExplorerFixture({ hours: 18 });
  input.prices.forEach((row, index) => { row.allInCentsPerKWh = index >= 16 && index < 40 ? 500 : 1; });
  Object.assign(input.equipment, { preheatAvailable: true, roomSettingC: 20, roomSettingMaximumC: 35 });
  input.config.preheatRoomBoostC = 1;
  input.checkpoint.model.equipmentResponse.phases.preheat = { ratio: 1.2, trainingEpisodes: 3, treatmentKey: 'room-boost-v1' };
  input.checkpoint.model.equipmentResponse.validation.phases.preheat = {
    accepted: true, episodes: 3, maxDurationHours: 6, treatmentKey: 'room-boost-v1' };
  const two = chooseCycle(input), three = chooseCycle(applyExplorerOverrides(input, { maxPreheatHours: 3 }));
  const search = result => result.plan?.search ?? result.evaluation.search;
  assert.ok(search(two).preheatExpansions > 0);
  assert.ok(search(three).evaluatedCandidates > search(two).evaluatedCandidates);
});

test('exploration exposes ROOM-increase evidence separately from permitted duration and native headroom', () => {
  const input = heatingExplorerFixture();
  Object.assign(input.equipment, { preheatAvailable: true, roomSettingC: 20, roomSettingMaximumC: 35 });
  input.checkpoint.model.equipmentResponse.validation.phases.preheat = {
    accepted: true, episodes: 3, maxDurationHours: 6, maxRoomBoostC: 1, treatmentKey: 'room-boost-v1' };
  const boundary = result => result.constraints.find(row => row.key === 'validatedPreheatBoostC');
  const blocked = exploreHeatingPlan(input, { preheatRoomBoostC: 5 }, options);
  assert.equal(boundary(blocked).value, 1);
  assert.equal(boundary(blocked).status, 'initial', 'Initial operation remains available without inventing demonstrated boost support');
  const supported = exploreHeatingPlan(input, { preheatRoomBoostC: 1 }, options);
  assert.equal(boundary(supported).status, 'available');
  input.equipment.roomSettingC = 34;
  const clamped = exploreHeatingPlan(input, { preheatRoomBoostC: 5 }, options);
  assert.equal(boundary(clamped).status, 'available', 'native headroom reduces the actual request to the demonstrated increase');
});

test('explorer worker executes the pure API and reports strict validation errors', async t => {
  const worker = new Worker(new URL('../src/control/heating-explorer-worker.js', import.meta.url));
  t.after(() => worker.terminate());
  const request = message => new Promise((resolve, reject) => {
    worker.once('message', resolve); worker.once('error', reject); worker.postMessage(message);
  });
  const response = await request({ id: 1, input: heatingExplorerFixture(), overrides: {}, options });
  assert.equal(response.id, 1); assert.ok(response.result.scenario);
  const rejected = await request({ id: 2, input: heatingExplorerFixture(), overrides: { learningTrials: 'true' } });
  assert.equal(rejected.id, 2); assert.equal(rejected.error.name, 'TypeError');
});

test('a supported sensor estimate retains bounded economic operation and current uncertainty revalidates the plan', () => {
  const input = heatingExplorerFixture();
  Object.assign(input.equipment, { indoorEstimated: true, indoorUncertaintyC: .1,
    indoorUncertaintyGrowthCPerHour: .005, indoorEstimateValidUntil: input.now + 72 * HOUR });
  const decision = chooseCycle(input);
  assert.ok(decision.plan, 'An incomplete measured average alone must not disable a supported control estimate');
  const result = exploreHeatingPlan(input, {}, options);
  assert.equal(result.indoorInput.estimated, true);
  assert.equal(result.indoorInput.available, true);
  assert.equal(result.indoorInput.valueC, input.observations.indoor.value);
  assert.equal(result.indoorInput.uncertaintyC, .1);
  assert.equal(result.indoorInput.observedAt, input.observations.indoor.observedAt);
  assert.equal(result.indoorInput.estimateValidUntil, input.equipment.indoorEstimateValidUntil);
  assert.equal(result.current.trajectory[0].uncertaintyC, .1);
  assert.equal(revalidatePlan({ ...input, plan: decision.plan }).valid, true);
  const rejected = revalidatePlan({ ...input, plan: decision.plan,
    equipment: { ...input.equipment, indoorUncertaintyC: 3 } });
  assert.equal(rejected.valid, false);
  assert.equal(rejected.reason, 'scheduled-cycle-no-longer-admissible');
  const expired = revalidatePlan({ ...input, plan: decision.plan,
    equipment: { ...input.equipment, indoorEstimateValidUntil: input.now } });
  assert.equal(expired.valid, false);
});

test('provisional reference preserves configured comfort and does not block an approved plan', () => {
  const input = heatingExplorerFixture(), approved = chooseCycle(input).plan;
  input.equipment.comfortReferenceProvisional = true;
  const decision = chooseCycle(input), result = exploreHeatingPlan(input, {}, options);
  assert.equal(decision.comfort.maxDropC, input.settings.comfort.maxDropC);
  if (decision.plan) assert.equal(decision.plan.maxDropC, input.settings.comfort.maxDropC);
  assert.equal(result.constraints.find(row => row.key === 'normalReference').value, input.settings.comfort.targetC);
  assert.equal(revalidatePlan({ ...input, plan: approved }).valid, true);
});
