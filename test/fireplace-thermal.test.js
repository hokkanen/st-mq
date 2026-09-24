import test from 'node:test';
import assert from 'node:assert/strict';
import { FIREPLACE_HORIZON_MS, FIREPLACE_RESPONSE, fireplaceActive, fireplaceIntegral, fireplaceRate, fireplaceBurnGroups,
  fireplaceInfluence, fireplaceAffectsLearning } from '../src/domain/fireplace.js';
import { initialAdaptiveModel, predictThermalStep, restoreAdaptiveCheckpoint, evaluateThermalModel,
  fitAdaptiveModel, fireplaceEvidenceReady, thermalEvidenceReady, fireplaceGainUncertainty, actionEvidenceReady } from '../src/control/adaptive-learning.js';
import { inferComfortReference } from '../src/control/learning.js';
import { evaluateCycle, chooseCycle, learningReadiness, revalidatePlan } from '../src/control/planner.js';

const HOUR = 3_600_000, start = Date.parse('2026-01-01T00:00:00Z');
const event = (id, hours = 0, kg = 8) => ({ id, litAt: start + hours * HOUR, kg });
const input = { outdoorC: 10, solarRadiationWm2: 0, phase: 'normal', targetC: 21, compressorDuty: 0.4, auxKw: 0 };

test('shared response constants preserve version 1 numerical release exactly', () => {
  assert.equal(FIREPLACE_RESPONSE.version, 1);
  // Golden integrals from the original fixed 2 h / 18 h response, including the
  // normalized tail boundary. Presentation must not change journal replay.
  for (const [from, to, expected] of [[0, 0.25, 0.0066423618453288775],
    [1.1, 1.7, 0.12821253399534283], [4, 5, 0.3366822183837146],
    [18, 24, 0.939768941344937], [48, 49, 0.033842756557000975],
    [119.75, 120, 0.00016041874785788224]])
    assert.equal(fireplaceIntegral([event('reference')], start + from * HOUR, start + to * HOUR), expected);
});

test('pooled fireplace release rises gradually, adds simultaneous loads and retains a normalized five-day tail', () => {
  const first = event('first'), second = event('second'), reload = event('reload', 3, 2);
  assert.equal(fireplaceRate([first], start - HOUR, start), 0);
  assert.ok(fireplaceRate([first], start + 4 * HOUR, start + 5 * HOUR)
    > fireplaceRate([first], start, start + HOUR));
  assert.equal(fireplaceIntegral([first], start, start + FIREPLACE_HORIZON_MS), 8);
  assert.equal(fireplaceIntegral([first], start + FIREPLACE_HORIZON_MS, start + 200 * HOUR), 0);
  assert.equal(fireplaceRate([first, second], start, start + HOUR), 2 * fireplaceRate([first], start, start + HOUR));
  assert.ok(fireplaceRate([first, reload], start + 4 * HOUR, start + 5 * HOUR)
    > fireplaceRate([first], start + 4 * HOUR, start + 5 * HOUR));
  assert.equal(fireplaceActive([first], start + 49 * HOUR), true);
  assert.ok(fireplaceIntegral([first], start + 48 * HOUR, start + FIREPLACE_HORIZON_MS) > 0);
  assert.equal(fireplaceBurnGroups([first, second, reload, event('tomorrow', 24)]).length, 2);
});

test('fireplace warms the room independently of hydronic heat and zero fire preserves temperature predictions', () => {
  const model = initialAdaptiveModel(), state = { indoorC: 21, reserveC: 21 };
  const plain = predictThermalStep(model, state, input, 0.25);
  assert.deepEqual(predictThermalStep(model, state, { ...input, fireplaceKgPerHour: 0 }, 0.25), plain);
  const warm = predictThermalStep(model, state, { ...input, fireplaceKgPerHour: 1 }, 0.25);
  assert.ok(warm.indoorC > plain.indoorC);
  assert.equal(warm.hydronicKwh, plain.hydronicKwh, 'Released masonry heat must not be counted as hydronic input');
  assert.ok(warm.reserveC >= plain.reserveC, 'Room warming can exchange energy with the reserve within the second solver stage');
  assert.equal(warm.usefulHeatCPerHour, plain.usefulHeatCPerHour);
  assert.ok(warm.uncertaintyC > plain.uncertaintyC);
  const older = initialAdaptiveModel(); delete older.parameters.fireplaceCPerKg;
  assert.equal(restoreAdaptiveCheckpoint({ version: 1, samples: [], model: older }).model.parameters.fireplaceCPerKg, 0.15);
});

test('relevance aggregates small tails without shortening their response or erasing zero-gain uncertainty', () => {
  const at = start + 60 * HOUR, first = event('first'), second = event('second');
  const single = fireplaceInfluence([first], at), pooled = fireplaceInfluence([first, second], at);
  assert.equal(fireplaceActive([first], at), true);
  assert.ok(single.remainingKgEquivalent > 0);
  assert.equal(single.relevant, false);
  assert.equal(pooled.relevant, true, 'Two individually negligible residuals must be assessed together');
  assert.equal(pooled.remainingKgEquivalent, 2 * single.remainingKgEquivalent);
  assert.equal(fireplaceAffectsLearning({ fireplaceActive: true, fireplaceKgPerHour: single.rateKgPerHour }), false);
  assert.equal(fireplaceAffectsLearning({ fireplaceKgPerHour: pooled.rateKgPerHour }), true);
  const zeroGain = initialAdaptiveModel(); zeroGain.parameters.fireplaceCPerKg = 0;
  assert.equal(fireplaceGainUncertainty(zeroGain), 0.15);
  assert.equal(fireplaceInfluence([first], start, { gainCPerKg: 0,
    gainUncertaintyCPerKg: fireplaceGainUncertainty(zeroGain) }).relevant, true);
});

test('a steady fireplace plateau cannot establish or raise the normal comfort reference', () => {
  const samples = Array.from({ length: 30 }, (_, i) => ({ timestamp: start + i * HOUR,
    indoorC: 21, outdoorC: 5, action: 'normal', regime: 'occupied', quality: [] }));
  const normal = inferComfortReference(null, samples, { now: samples.at(-1).timestamp });
  assert.equal(normal.targetC, 21);
  const heated = samples.map(row => ({ ...row, indoorC: 23, fireplaceActive: true }));
  assert.equal(inferComfortReference(null, heated, { now: heated.at(-1).timestamp }), null);
  assert.deepEqual(inferComfortReference(normal, heated, { now: heated.at(-1).timestamp }), normal);
  const negligible = samples.map(row => ({ ...row, fireplaceActive: true, fireplaceKgPerHour: 0.005 }));
  assert.equal(inferComfortReference(null, negligible, { now: negligible.at(-1).timestamp }).targetC, 21);
  assert.equal(inferComfortReference(null, negligible.map(row => ({ ...row,
    inputSegments: [{ fireplaceKgPerHour: 0.04 }] })), { now: negligible.at(-1).timestamp }), null);
});

test('planner includes the same fireplace release in both paths and unvalidated fires cannot authorize trials', () => {
  const model = initialAdaptiveModel(), intervals = Array.from({ length: 24 }, (_, i) => ({
    start: start + i * HOUR, end: start + (i + 1) * HOUR, outdoorC: 10, solarRadiationWm2: 0, price: 10 }));
  const args = { intervals, model, initialState: { indoorC: 21, reserveC: 21 }, targetC: 21 };
  const plain = evaluateCycle(args);
  const heated = evaluateCycle({ ...args, equipment: { fireplaceEvents: [event('first')] } });
  assert.ok(heated.endState.indoorC > plain.endState.indoorC);
  assert.deepEqual(heated.endState, heated.nativeEndState);
  const choice = chooseCycle({ now: start, observations: { indoor: { value: 21, observedAt: start } },
    checkpoint: { model, baselineC: 21, health: { usableSamples: 100 } }, prices: [], forecast: [],
    settings: { comfort: { targetC: 21, maxDropC: 1 }, occupancy: { mode: 'occupied' } },
    config: { learningTrials: true }, trialBudgetRemainingCents: 100,
    equipment: { fireplaceEvents: [event('first')], compressorOn: 1, dhwRouting: 0 } });
  assert.equal(choice.phase, 'normal');
  assert.equal(choice.reasons[0], 'awaiting-fireplace-response-evidence');
});

test('negligible residuals stop blocking planner readiness and revalidation while aggregate uncertainty still blocks', () => {
  const now = start + 60 * HOUR, model = initialAdaptiveModel();
  const args = { now, observations: { indoor: { value: 21, observedAt: now } },
    checkpoint: { model, baselineC: 21, health: { usableSamples: 100 } }, prices: [], forecast: [],
    settings: { comfort: { targetC: 21, maxDropC: 1 }, occupancy: { mode: 'occupied' } },
    config: { learningTrials: true }, trialBudgetRemainingCents: 100,
    equipment: { fireplaceEvents: [event('first')], fireplaceActive: true, compressorOn: 1, dhwRouting: 0 } };
  assert.equal(chooseCycle(args).reasons[0], 'missing-or-incomplete-price-weather-horizon');
  assert.equal(chooseCycle({ ...args, equipment: { ...args.equipment,
    fireplaceEvents: [event('first'), event('second')] } }).reasons[0], 'awaiting-fireplace-response-evidence');
  assert.equal(learningReadiness(args.checkpoint, args.config,
    { ...args.equipment, fireplaceRelevant: false }).trialReady, true);
  const plan = { schedule: { preheatStart: now, preheatEnd: now, reductionStart: now,
    reductionEnd: now + HOUR, roomBoostC: 0 } };
  assert.notEqual(revalidatePlan({ ...args, plan }).reason, 'awaiting-fireplace-response-evidence');
  assert.equal(revalidatePlan({ ...args, plan, equipment: { ...args.equipment,
    fireplaceEvents: [event('first'), event('second')] } }).reason, 'awaiting-fireplace-response-evidence');
});

function burnFixture({ confounded = false, repeated = false, daily = false, unknown = false, noFire = false } = {}) {
  const model = initialAdaptiveModel();
  model.validation = { accepted: true, kind: 'conditional-thermal', samples: 3, fireplaceFreeSamples: 192,
    parameterEvidence: { lossPerHour: { status: 'identified' }, hydronicCPerKwh: { status: 'identified' } } };
  if (daily) delete model.validation.fireplaceFreeSamples;
  const trueModel = structuredClone(model); trueModel.parameters.fireplaceCPerKg = 0.3;
  const events = noFire ? [] : daily ? Array.from({ length: 16 }, (_, i) => event(`daily-${i}`, i * 24, [2, 8, 4, 10][i % 4]))
    : repeated ? [event('one', 8 * 24), event('second-same-time', 8 * 24)]
    : Array.from({ length: 11 }, (_, i) => event(`burn-${i}`, (8 + i * 2) * 24));
  let state = { indoorC: 21, reserveC: 21 };
  const samples = [];
  for (let i = 0; i <= (daily ? 16 : 30) * 24; i++) {
    const at = start + i * HOUR, from = at - HOUR;
    const rate = fireplaceRate(events, from, at);
    const inputs = { ...input, outdoorC: 10 + 4 * Math.sin(i / 43), compressorDuty: i % 13 < 5 ? 0.6 : 0.2,
      fireplaceKgPerHour: rate, fireplaceKnown: !unknown,
      solarRadiationWm2: confounded ? rate * 1000 : 0 };
    if (i) state = predictThermalStep(trueModel, state, inputs, 1);
    samples.push({ timestamp: at, indoorC: state.indoorC, ...inputs, phase: 'normal', regime: 'occupied', quality: [],
      windowStart: from, inputSegments: [{ ...inputs, start: from, end: at, thermalCompressorDuty: inputs.compressorDuty, thermalAuxKw: inputs.auxKw, regime: 'occupied', quality: [] }], fireplaceActive: fireplaceActive(events, at),
      fireplaceIgnitions: events.filter(event => event.litAt >= from && event.litAt < at) });
  }
  return { model, samples, baselineC: 21, episodeArchive: [] };
}

test('fireplace fitting requires separated burns and rejects solar-confounded input', () => {
  for (const options of [{ repeated: true }, { confounded: true }, { daily: true, confounded: true },
    { daily: true, unknown: true }]) {
    const result = fitAdaptiveModel(burnFixture(options));
    const evidence = result.parameterEvidence ?? result.model?.validation?.parameterEvidence;
    assert.notEqual(evidence.fireplaceCPerKg.status, 'identified');
    assert.equal(fireplaceEvidenceReady(result.model), false);
  }
});

test('daily fireplace heat cannot establish the house anchor from unvalidated priors', () => {
  const cp = burnFixture({ daily: true }); cp.model.validation = null;
  const result = fitAdaptiveModel(cp);
  assert.equal(result.accepted, false);
  assert.notEqual(result.parameterEvidence.fireplaceCPerKg.status, 'identified');
  assert.notEqual(result.parameterEvidence.lossPerHour.status, 'identified');
  assert.notEqual(result.parameterEvidence.hydronicCPerKwh.status, 'identified');
});

test('varying daily fires calibrate from an established house anchor without new clean days or refitting house coefficients', () => {
  const cp = burnFixture({ daily: true }), result = fitAdaptiveModel(cp);
  assert.equal(result.accepted, true, JSON.stringify({ reason: result.reason, evidence: result.parameterEvidence,
    validation: result.validation }));
  assert.deepEqual(result.model.validation.fittedParameters, ['fireplaceCPerKg']);
  assert.equal(thermalEvidenceReady(result.model), true);
  assert.equal(fireplaceEvidenceReady(result.model), true);
  for (const name of ['lossPerHour', 'hydronicCPerKwh']) {
    assert.equal(result.model.parameters[name], cp.model.parameters[name]);
    assert.equal(result.model.validation.parameterEvidence[name].status, 'identified');
    assert.equal(result.model.validation.parameterEvidence[name].fitStatus, 'retained-unchanged');
  }
  const evidence = result.model.validation.fireplace;
  assert.equal(evidence.coreAnchor.kind, 'previously-validated-house-response');
  assert.ok(evidence.currentKnownCleanTrainingIntervals < 96);
  assert.ok(evidence.trainingBurns >= 3 && evidence.validationBurns >= 3);
  assert.ok(result.model.parameters.fireplaceCPerKg > cp.model.parameters.fireplaceCPerKg);
});

test('wood-only calibration retains checked action evidence only within the same equipment epoch', () => {
  const cp = burnFixture({ daily: true });
  cp.model.equipmentResponse = { phases: { reduction: { ratio: 0.5, trainingEpisodes: 3 } },
    validation: { phases: { reduction: { accepted: true, episodes: 3, maxDurationHours: 2 } } } };
  assert.equal(actionEvidenceReady(cp.model, 'reduction'), true);
  const updated = fitAdaptiveModel(cp);
  assert.equal(updated.accepted, true);
  assert.equal(actionEvidenceReady(updated.model, 'reduction'), true);
  assert.equal(updated.model.equipmentResponse.validation.phases.reduction.fitStatus, 'retained-unchanged');
  const changedEquipment = fitAdaptiveModel({ ...cp, equipmentEpochAt: start + HOUR });
  assert.equal(changedEquipment.accepted, true);
  assert.equal(actionEvidenceReady(changedEquipment.model, 'reduction'), false);
});

test('a later clean fit retains fireplace evidence when every anchored coefficient stays unchanged', () => {
  const learned = fitAdaptiveModel(burnFixture({ daily: true }));
  assert.equal(fireplaceEvidenceReady(learned.model), true);
  const clean = burnFixture({ noFire: true }); clean.model = learned.model;
  const later = fitAdaptiveModel(clean);
  assert.equal(later.accepted, true);
  assert.deepEqual(later.model.parameters, learned.model.parameters);
  assert.equal(fireplaceEvidenceReady(later.model), true);
  assert.equal(later.model.validation.fireplace.fitStatus, 'retained-unchanged');
  assert.equal(later.model.validation.parameterEvidence.fireplaceCPerKg.currentWindowEvidence.burns, 0);
});

test('separated training and later burns identify one effective fireplace gain while retaining house coefficients', () => {
  const cp = burnFixture(), result = fitAdaptiveModel(cp);
  assert.equal(result.accepted, true, JSON.stringify({ reason: result.reason, validation: result.validation }));
  assert.equal(fireplaceEvidenceReady(result.model), true);
  assert.ok(result.model.parameters.fireplaceCPerKg > cp.model.parameters.fireplaceCPerKg);
  assert.ok(Math.abs(result.model.parameters.lossPerHour - cp.model.parameters.lossPerHour) < 0.001);
  assert.ok(result.model.validation.fireplace.trainingBurns >= 3);
  assert.ok(result.model.validation.fireplace.validationBurns >= 3);
  assert.ok(evaluateThermalModel(result.model, cp.samples).maeC < evaluateThermalModel(cp.model, cp.samples).maeC);
});
