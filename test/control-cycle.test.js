import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { CycleTracker } from '../src/app/cycles.js';
import { initialAdaptiveModel, updateAdaptiveEpisode } from '../src/control/adaptive-learning.js';
import { evaluateCycle, chooseCycle, revalidatePlan } from '../src/control/planner.js';
import { initialHomeState } from '../src/domain/home-model.js';
import { rebuildCycleWorking } from '../src/app/cycle-evaluation.js';

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

test('cycle accounts at every current quote start/end without changing its frozen forecast',t=>{
  for(const [before,after] of [[10,100],[100,10],[-10,-100],[10,-100]]){
    const {tracker,plan}=fixture(t,{intervals:[{start,end:start+HOUR,price:before,outdoorC:0,solarRadiationWm2:0}]});
    tracker.start(plan,sample(start),start);
    const original=structuredClone(tracker.active().plan);
    tracker.record(sample(start+HOUR/4,{priceIntervals:[{start:start+7*60000,end:start+20*60000,price:after}]}),start+HOUR/4);
    const active=tracker.active();
    assert(Math.abs(active.actual.costCents-2*(7*before+8*after)/60)<1e-10);
    assert.equal(active.actual.coveredHours,0.25);assert.equal(active.observationCount,2);
    assert.deepEqual(active.plan,original);
  }
});

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

test('startup economic operation remains available with learning trials disabled', () => {
  const choose = (rows, equipment = {}) => chooseCycle({ now: start,
    observations: { indoor: { value: 21, observedAt: start } },
    prices: rows.map(x => ({ ...x, allInCentsPerKWh: x.price })),
    forecast: rows.map(x => ({ ...x, issuedAt: start })),
    checkpoint: { model: initialAdaptiveModel(), baselineC: 21 },
    settings: { comfort: { targetC: 21, maxDropC: 1 }, occupancy: { mode: 'occupied' } },
    config: { learningTrials: false }, equipment });
  for (const equipment of [{},{h66Available:true,preheatAvailable:true}]) {
    const selected = choose(intervals(24, { price: i => i < 2 ? 500 : 5 }),equipment);
    assert.ok(selected.plan);assert.equal(selected.plan.trial,false);
    assert.ok(selected.plan.estimatedBenefitCents>0);
    assert.equal(selected.plan.readiness.actionValidated,false);
  }
  const warm = choose(intervals(8, { outdoorC: 30, price: i => i < 8 ? -100 : 100 }),
    { h66Available: true, preheatAvailable: true });
  assert.equal(warm.plan, null, 'ROOM boost must not create the demand used to justify DHWR heat credit');
});

test('native integral and supply trends stay bounded to near-term evidence', () => {
  const result = evaluateCycle(common({ initialState: { indoorC: 21, reserveC: 21, integral: -100 },
    equipment: { observedPhase: 'normal', integralTrendPerHour: -200, supplyShortfallC: 2, supplyShortfallTrendPerHour: 4,
      nativeProjection: { integral: { observedAt: start, spanMs: HOUR / 4 }, shortfall: { observedAt: start, spanMs: HOUR / 4 } } },
    config: { compressorIntegralA1: -150, compressorHysteresisC: 5 } }));
  assert.equal(result.trajectory[0].integral, -150);
  assert.equal(result.trajectory[0].supplyShortfallC, 3);
  assert.equal(result.trajectory[0].nativeCompressorDemand, true);
  assert.ok(result.trajectory.filter(x => x.at > start + HOUR / 4).every(x => x.integral === null && x.supplyShortfallC === null));
});

test('missing solar over a 48-hour horizon still permits a bounded startup trial', () => {
  const rows = intervals(48, { solarRadiationWm2: null, price: () => 10 });
  const model=initialAdaptiveModel();
  const decision = chooseCycle({ now: start, observations: { indoor: { value: 21, observedAt: start } },
    prices: rows.map(x => ({ ...x, allInCentsPerKWh: x.price })),
    forecast: rows.map(x => ({ ...x, issuedAt: start })),
    checkpoint: { model, baselineC: 21,health:{usableSamples:4} },
    settings: { comfort: { targetC: 21, maxDropC: 1 }, occupancy: { mode: 'occupied' } },
    thermalState: initialHomeState(model,21,0), config:{maxUnobservedReductionHours:2},
    equipment:{compressorOn:1,dhwRouting:0,h66Available:true},trialBudgetRemainingCents: 300 });
  assert.equal(decision.phase, 'reduction');
  assert.equal(decision.plan.trial, true);
  assert.ok(decision.plan.schedule.reductionEnd - decision.plan.schedule.reductionStart <= 4*HOUR);
  assert.ok(decision.plan.trialAllowanceCents <= 150);
  assert.equal(decision.plan.trialSafety.comfortSafe,true);
});

test('cycle selection and revalidation accept old indoor values without renewing their timestamps', () => {
  const rows = intervals(48, { solarRadiationWm2: null, price: () => 10 });
  const model=initialAdaptiveModel();
  const args = { now: start, observations: { indoor: { value: 21, observedAt: start - 7 * 24 * HOUR,
    stale: false, needsAttention: true, held: true } },
    prices: rows.map(row => ({ ...row, allInCentsPerKWh: row.price })),
    forecast: rows.map(row => ({ ...row, issuedAt: start })),
    checkpoint: { model, baselineC: 21, health: { usableSamples: 4 } },
    settings: { comfort: { targetC: 21, maxDropC: 1 }, occupancy: { mode: 'occupied' } },
    thermalState: initialHomeState(model,21,0), equipment: { compressorOn: 1, dhwRouting: 0, h66Available:true }, trialBudgetRemainingCents: 300 };
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
  const { tracker, store } = fixture(t, { intervals: rows });
  const plan = fixturePlan(rows);
  tracker.start(plan, sample(start + HOUR / 6, { priceCents: 10, priceStart: start, priceEnd: start + HOUR / 4 }), start + HOUR / 6);
  tracker.record(sample(start + HOUR / 3), start + HOUR / 3, { thermalState: { reserveC: 21.5 } });
  const cycle = tracker.active();
  assert.equal(cycle.plan.prediction.trajectory, undefined);
  assert.equal(cycle.plan.referencePrediction.trajectory, undefined);
  assert.equal([...store.cycleEvidence(cycle.id)].length, 2);
  assert.ok(Math.abs(cycle.actual.coveredHours - 1 / 6) < 1e-10);
  assert.ok(Math.abs(cycle.actual.costCents - (2 * 10 / 12 + 2 * 30 / 12)) < 1e-10);
  assert.equal([...store.cycleEvidence(cycle.id)][0].priceBasis, 'applicable-observed-quote');
  assert.equal([...store.cycleEvidence(cycle.id)][1].priceBasis, 'frozen-published-price');
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
  const samePeriod = [...store.cycleEvidence(cycle.id)].map(o => ({ ...o }));
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
  const { tracker, plan, store } = fixture(t);
  const changes = { auxiliaryObserved: false, auxiliaryRouteKnown: false, compressorActivityObserved: false,
    auxKw: null, auxRoute: null,thermalCompressorDuty:null,thermalAuxKw:null };
  const original=tracker.start(plan, sample(start, changes), start);
  const episode = finish(tracker, changes);
  assert.equal(episode,undefined);
  assert.equal(tracker.active(),null);
  const cycle=store.cycleById({id:original.id});
  assert.equal(cycle.status,'incomplete');
  assert.equal(cycle.incompleteReason,'recovery-evidence-unavailable');
  assert.equal(cycle.stableSince,null);
  assert.equal(cycle.observerState,null);
  assert.equal(cycle.assessment,undefined);
  assert.equal(tracker.metrics(21).profit.count, 0);
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

test('a long observation gap preserves intent without inventing energy or a heat reserve', t => {
  const { tracker, plan, store } = fixture(t);
  tracker.start(plan, sample(start), start);
  assert.equal(tracker.record(sample(start + HOUR), start + HOUR), null);
  const cycle = tracker.active();
  assert.equal(cycle.status, 'active');
  assert.equal(cycle.actual.missingHours, 1);
  assert.equal(cycle.actual.electricityKwh, 0);
  assert.equal(cycle.observerState, null);
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

test('an actually completed approved scenario retains consent provenance in the replay journal without changing learning weight', t => {
  const { store, tracker, plan } = fixture(t, { intervals: intervals(8, { outdoorC: 21 }) });
  plan.userTrial = { id: 'synthetic-approved-scenario', approvedAt: start, latestStartAt: start + 300_000,
    expiresAt: start + 8 * HOUR, limits: { maxReductionHours: 8, maxRiseC: 1.75 }, basis: 'admin-approved-one-cycle-scenario' };
  plan.maxRiseC = 1.75;
  const changes = { outdoorC: 21, auxKw: 0, auxRoute: 'space-heating', thermalCompressorDuty: 0, thermalAuxKw: 0 };
  tracker.start(plan, sample(start, changes), start, { executed: true });
  const episode = finish(tracker, changes);
  assert.ok(episode.complete);
  assert.deepEqual(episode.userTrial, plan.userTrial);
  const committed = store.learningJournal({ input: 'synthetic' }).find(entry => entry.kind === 'episode');
  assert.deepEqual(committed.payload.value.userTrial, plan.userTrial);
  const { userTrial, ...ordinaryEvidence } = episode;
  assert.deepEqual(updateAdaptiveEpisode(null, episode), updateAdaptiveEpisode(null, ordinaryEvidence),
    'admin consent labels real exposure; it supplies no extra evidence or fitting weight');
});

const fallbackIndoor = (at, changes = {}) => ({ value: 21.5, estimated: true, stale: false,
  uncertaintyC: 0.1, anchorAt: start, estimatedSensor: 'bedroom_temperature', validUntil: at + HOUR, ...changes });
const neutralSample = (at, changes = {}) => sample(at, { outdoorC: 21,
  thermalCompressorDuty: 0, thermalAuxKw: 0, ...changes });

test('temperature outages retain real energy accounting and conservative fallback can finish control without validation', t => {
  const { tracker, plan, store } = fixture(t, { intervals: intervals(8, { outdoorC: 21 }) });
  tracker.start(plan, neutralSample(start), start);
  let episode;
  for (let quarter = 1; quarter <= 12 && tracker.active(); quarter++) {
    const at = start + quarter * HOUR / 4;
    episode = tracker.record(neutralSample(at, { indoorC: null }), at,
      { controlIndoor: fallbackIndoor(at) }) ?? episode;
    if (quarter === 1) {
      const cycle = tracker.active();
      assert.equal(cycle.actual.electricityKwh, 0.5);
      assert.equal(cycle.actual.coveredHours, 0.25);
      assert.equal(cycle.actual.temperatureMissingHours, 0.25);
      assert.equal(cycle.actual.missingHours, 0);
      assert.equal([...store.cycleEvidence(cycle.id)][0].indoorC, null);
      assert.equal([...store.cycleEvidence(cycle.id)][0].indoorControlEstimate.value, 21.5);
      assert.equal(cycle.observerState.indoorC, 21, 'The model observer does not assimilate an inferred room as a measured endpoint');
    }
  }
  assert.equal(tracker.active(), null, 'Conservative operational recovery does not wait forever for the failed sensor');
  assert.deepEqual({ complete: episode.complete, recoveryComplete: episode.recoveryComplete }, { complete: false, recoveryComplete: false });
  const cycle = store.cycles({ input: 'synthetic', completedOnly: true })[0];
  assert.equal(cycle.completionBasis, 'control-recovery-only');
  assert.equal(cycle.assessment.basis, 'unassessed-indoor-observation-gap');
  assert.equal(cycle.assessment.profitCents, null);
  assert.equal(cycle.assessment.recoveryErrorCents, null);
  assert.equal(cycle.actual.electricityKwh, (cycle.endedAt - start) / HOUR * 2);
  assert.equal(store.learningJournal({ input: 'synthetic' }).some(entry => entry.kind === 'episode'), false);
  assert.equal(updateAdaptiveEpisode(null, episode).model.energy.recoveryCalibrationEpisodes, 0);
  assert.equal(tracker.metrics(21).profit.count, 0);
});

test('a brief returning sensor outage preserves the cycle without fabricating observations', t => {
  const { tracker, plan, store } = fixture(t, { intervals: intervals(8, { outdoorC: 21 }) });
  tracker.start(plan, neutralSample(start), start);
  tracker.record(neutralSample(start + HOUR / 4, { indoorC: null }), start + HOUR / 4,
    { controlIndoor: fallbackIndoor(start + HOUR / 4) });
  let episode;
  for (let quarter = 2; quarter <= 12 && tracker.active(); quarter++) {
    const at = start + quarter * HOUR / 4;
    episode = tracker.record(neutralSample(at), at) ?? episode;
  }
  assert.equal(episode.complete, true);
  assert.equal(episode.recoveryComplete, true);
  const cycle = store.cycles({ input: 'synthetic', completedOnly: true })[0];
  assert.equal(cycle.temperatureCoverage.maximumGapMs, HOUR / 4);
  assert.equal(cycle.actual.temperatureMissingHours, 0.25);
  assert.ok([...store.cycleEvidence(cycle.id)].slice(1).every(row => row.indoorC === 21.5));
  assert.equal([...store.cycleEvidence(cycle.id)][0].indoorC, null);
  assert.equal(store.learningJournal({ input: 'synthetic' }).some(entry => entry.kind === 'episode'), true);
  assert.equal(tracker.metrics(21).recoveryError.count, 1);
});

for (const minutes of [10, 30, 31]) test(`${minutes}-minute temperature-only outage retains its true duration across reconstruction`, t => {
  const { tracker, plan, store } = fixture(t, { intervals: intervals(8, { outdoorC: 21 }) });
  tracker.start(plan, neutralSample(start), start);
  // The completed window contains a real outage followed by a genuine endpoint.
  // Its availability spans prevent rounding the outage to the whole window.
  const returnedAt = start + (minutes + 1) * 60_000;
  const sensors = { room: { weight: 1, value: null, reportCoverageComplete: false,
    reportIntervals: [{ start: returnedAt - 60_000, end: returnedAt, endpoint: true }] } };
  tracker.record(neutralSample(returnedAt, { indoorC: null, indoorEndpointC: 21.5, indoorSensors: sensors,
    inputSegments: [{ ...neutralSample(returnedAt), start, end: returnedAt, phase: 'reduction' }] }), returnedAt);
  const active = tracker.active();
  assert.equal(active.temperatureCoverage.maximumGapMs, minutes * 60_000);
  assert.equal(active.actual.temperatureMissingHours, minutes / 60);
  const replay = rebuildCycleWorking(store, { id: active.id, count: active.observationCount });
  assert.deepEqual(replay.temperatureCoverage, active.temperatureCoverage);
  assert.deepEqual(replay.observer, active.observerState);
  tracker.adoptWorking(replay);
  let episode;
  for (let i = 1; i <= 12 && tracker.active(); i++) {
    const at = returnedAt + i * HOUR / 4;
    episode = tracker.record(neutralSample(at), at) ?? episode;
  }
  const saved = store.cycles({ input: 'synthetic', completedOnly: true })[0];
  assert.equal(saved.temperatureCoverage.maximumGapMs, minutes * 60_000);
  assert.equal(episode.complete, minutes <= 30);
  assert.equal([...store.cycleEvidence(saved.id)][0].indoorC, null,
    'An endpoint cannot fill preceding unobserved segments');
  assert.ok([...store.cycleEvidence(saved.id)].some(row => row.temperatureAvailable === false));
  if (minutes <= 30) {
    assert.ok(store.learningJournal({ input: 'synthetic' }).some(entry => entry.kind === 'episode'));
    assert.equal(saved.assessment.temperatureCoverage.missingMs, minutes * 60_000);
  } else assert.equal(saved.assessment.basis, 'unassessed-indoor-observation-gap');
});

test('a temperature outage during recovery resets the measured confirmation hour', t => {
  const { tracker, plan } = fixture(t, { intervals: intervals(8, { outdoorC: 21 }) });
  tracker.start(plan, neutralSample(start), start);
  for (let minute = 15; minute <= 75; minute += 15) tracker.record(neutralSample(start + minute * 60_000), start + minute * 60_000);
  const missingAt = start + 85 * 60_000;
  tracker.record(neutralSample(missingAt, { indoorC: null }), missingAt, { controlIndoor: fallbackIndoor(missingAt) });
  assert.equal(tracker.active().stableSince, null);
  for (let minute = 95; minute <= 140; minute += 15) tracker.record(neutralSample(start + minute * 60_000), start + minute * 60_000);
  assert.ok(tracker.active(), 'The preceding measured recovery time cannot bridge the outage');
  assert.equal(tracker.record(neutralSample(start + 155 * 60_000), start + 155 * 60_000).complete, true);
});

test('isolated brief outages retain separate durations and do not discard the complete cycle', t => {
  const { tracker, plan, store } = fixture(t, { intervals: intervals(8, { outdoorC: 21 }) });
  tracker.start(plan, neutralSample(start), start);
  for (const minute of [10, 20, 30, 40]) {
    const at = start + minute * 60_000, missing = minute === 10 || minute === 30;
    tracker.record(neutralSample(at, { indoorC: missing ? null : 21.5 }), at,
      missing ? { controlIndoor: fallbackIndoor(at) } : {});
  }
  let episode;
  for (let minute = 55; minute <= 160 && tracker.active(); minute += 15) {
    const at = start + minute * 60_000;
    episode = tracker.record(neutralSample(at), at) ?? episode;
  }
  const saved = store.cycles({ input: 'synthetic', completedOnly: true })[0];
  assert.equal(episode.complete, true);
  assert.equal(saved.temperatureCoverage.missingMs, 20 * 60_000);
  assert.equal(saved.temperatureCoverage.maximumGapMs, 10 * 60_000);
});

test('fallback recovery uses the lower uncertainty bound and resets its hold when support expires', t => {
  const { tracker, plan } = fixture(t, { intervals: intervals(8, { outdoorC: 21 }) });
  tracker.start(plan, neutralSample(start), start);
  for (let quarter = 1; quarter <= 6; quarter++) {
    const at = start + quarter * HOUR / 4;
    const uncertaintyC = quarter <= 3 ? 0.4 : 0.1;
    const controlIndoor = fallbackIndoor(at, { uncertaintyC, ...(quarter === 6 ? { validUntil: at - 1 } : {}) });
    assert.equal(tracker.record(neutralSample(at, { indoorC: null }), at, { controlIndoor }), null);
    const cycle = tracker.active();
    if (quarter <= 3 || quarter === 6) assert.equal(cycle.stableSince, null);
    else assert.equal(cycle.stableSince, start + HOUR);
  }
  let episode;
  for (let quarter = 7; quarter <= 12 && tracker.active(); quarter++) {
    const at = start + quarter * HOUR / 4;
    episode = tracker.record(neutralSample(at, { indoorC: null }), at,
      { controlIndoor: fallbackIndoor(at) }) ?? episode;
  }
  assert.equal(episode.complete, false);
  assert.equal(tracker.active(), null);
});

test('a plan initialized from an estimate cannot validate after all sensors return before its first interval', t => {
  const { tracker, plan, store } = fixture(t, { intervals: intervals(8, { outdoorC: 21 }), equipment: { indoorEstimated: true } });
  tracker.start(plan, neutralSample(start), start);
  let episode;
  for (let quarter = 1; quarter <= 12 && tracker.active(); quarter++) {
    const at = start + quarter * HOUR / 4;
    episode = tracker.record(neutralSample(at), at) ?? episode;
  }
  assert.equal(episode.complete, false);
  const cycle = store.cycles({ input: 'synthetic', completedOnly: true })[0];
  assert.equal(cycle.actual.temperatureMissingHours, 0);
  assert.equal(cycle.completionBasis, 'control-recovery-only');
  assert.equal(store.learningJournal({ input: 'synthetic' }).length, 0);
});


test('native derivative expires at its original observed span including endpoint age', () => {
  const args = common({ initialState: { indoorC: 21, reserveC: 21, integral: -100 },
    equipment: { observedPhase: 'normal', integralTrendPerHour: -120, supplyShortfallC: 0, supplyShortfallTrendPerHour: 60,
      nativeProjection: { integral: { observedAt: start - 30_000, spanMs: 60_000 },
        shortfall: { observedAt: start - 30_000, spanMs: 60_000 } } } });
  const result = evaluateCycle(args);
  assert.equal(result.trajectory[0].at, start + 30_000, 'The forecast splits at the actual evidence expiry');
  assert.equal(result.trajectory[0].integral, -102, 'Projection starts from the native report clock');
  assert.equal(result.trajectory[0].supplyShortfallC, 1);
  assert(result.trajectory.slice(1).every(p => p.integral === null && p.supplyShortfallC === null),
    'Expired native demand becomes unknown, not a held extreme');
  const stale = evaluateCycle({ ...args, equipment: { ...args.equipment, nativeProjection: {
    integral: { observedAt: start - 61_000, spanMs: 60_000 }, shortfall: { observedAt: start - 61_000, spanMs: 60_000 } } } });
  assert(stale.trajectory.every(p => p.integral === null && p.supplyShortfallC === null));
});

test('preheat native demand cannot become AUX evidence for the Normal counterfactual', () => {
  const equipment = { observedPhase: 'preheat', normalSupplyC: 35, supplyC: 35, nativeAuxAllowed: true,
    integralTrendPerHour: -600, supplyShortfallC: 10, supplyShortfallTrendPerHour: 2000,
    nativeProjection: { integral: { observedAt: start, spanMs: 47_000 }, shortfall: { observedAt: start, spanMs: 18_000 } } };
  const args = common({ initialState: { indoorC: 21, reserveC: 21, integral: -1000 }, equipment });
  const result = evaluateCycle(args);
  const unknown = evaluateCycle({ ...args, initialState: { indoorC: 21, reserveC: 21 },
    equipment: { ...equipment, integralTrendPerHour: null, supplyShortfallC: null, supplyShortfallTrendPerHour: null } });
  assert.equal(result.auxiliaryKwh, unknown.auxiliaryKwh, 'A different native phase adds no Normal AUX demand');
  assert.equal(result.electricityKwh, unknown.electricityKwh);
  assert(result.trajectory.every(p => p.integral === null && p.supplyShortfallC === null && p.nativeCompressorDemand === null));
  const active = evaluateCycle({ ...args, schedule: { preheatStart: start, preheatEnd: start + 60_000,
    reductionStart: start + 60_000, reductionEnd: start + HOUR, roomBoostC: 1 } });
  assert(active.trajectory[0].auxiliaryKw > 0, 'Current-phase native AUX risk remains represented');
  assert(active.trajectory.filter(p => p.phase !== 'preheat').every(p => p.integral === null && p.supplyShortfallC === null));
});


test('a brief post-DHW water transient cannot create an hour of AUX demand and a false comfort failure', () => {
  const config = { floorThermalPriors: { capacityKwhPerC: 3.2 } };
  const args = common({ model: initialAdaptiveModel(config), config,
    initialState: { indoorC: 21.2, reserveC: 23.6, slabC: 21.2, integral: -119 },
    targetC: 20.9, maxRiseC: 1.5, maxDropC: 1.5, intervals: intervals(24, { outdoorC: 10, price: () => 10 }),
    equipment: { observedPhase: 'preheat', normalSupplyC: 29, supplyC: 45, maximumSupplyC: 45, brineC: 3,
      integralTrendPerHour: -685, supplyShortfallC: -1, supplyShortfallTrendPerHour: 2000,
      nativeAuxAllowed: true, h66Available: true,
      nativeProjection: { integral: { observedAt: start, spanMs: 47_000 }, shortfall: { observedAt: start, spanMs: 18_000 } } },
    schedule: { preheatStart: start, preheatEnd: start + 2 * 60_000, reductionStart: start + 2 * 60_000,
      reductionEnd: start + 62 * 60_000, roomBoostC: 5, floorOverride: true, treatmentKey: 'room-boost-floor-v1' } });
  const result = evaluateCycle(args);
  assert.equal(result.severe, false, JSON.stringify(result.violations));
  assert.deepEqual(result.violations, []);
  assert(result.auxiliaryKwh < .1, 'The short native transient cannot become sustained auxiliary energy');
  const hot = evaluateCycle({ ...args, initialState: { ...args.initialState, indoorC: 24 } });
  assert.equal(hot.severe, true, 'Real excessive indoor warmth remains unsafe');
  assert(hot.violations.some(v => v.code === 'indoor-rise-limit'));
});
