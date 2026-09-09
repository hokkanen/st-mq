import test from 'node:test';
import assert from 'node:assert/strict';
import { FIREPLACE_HORIZON_MS, fireplaceActive, fireplaceIntegral, fireplaceRate, fireplaceBurnGroups } from '../src/domain/fireplace.js';
import { initialAdaptiveModel, predictThermalStep, restoreAdaptiveCheckpoint, evaluateThermalModel,
  fitAdaptiveModel, fireplaceEvidenceReady } from '../src/control/adaptive-learning.js';
import { inferComfortReference } from '../src/control/learning.js';
import { evaluateCycle, chooseCycle } from '../src/control/planner.js';

const HOUR = 3_600_000, start = Date.parse('2026-01-01T00:00:00Z');
const event = (id, hours = 0, kg = 8) => ({ id, litAt: start + hours * HOUR, kg });
const input = { outdoorC: 10, solarRadiationWm2: 0, phase: 'normal', targetC: 21, compressorDuty: 0.4, auxKw: 0 };

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
  assert.equal(warm.reserveC, plain.reserveC, 'Released masonry heat must not be counted as hydronic input');
  assert.equal(warm.usefulHeatCPerHour, plain.usefulHeatCPerHour);
  assert.ok(warm.uncertaintyC > plain.uncertaintyC);
  const older = initialAdaptiveModel(); delete older.parameters.fireplaceCPerKg;
  assert.equal(restoreAdaptiveCheckpoint({ version: 1, samples: [], model: older }).model.parameters.fireplaceCPerKg, 0.15);
});

test('a steady fireplace plateau cannot establish or raise the normal comfort reference', () => {
  const samples = Array.from({ length: 30 }, (_, i) => ({ timestamp: start + i * HOUR,
    indoorC: 21, outdoorC: 5, action: 'normal', regime: 'occupied', quality: [] }));
  const normal = inferComfortReference(null, samples, { now: samples.at(-1).timestamp });
  assert.equal(normal.targetC, 21);
  const heated = samples.map(row => ({ ...row, indoorC: 23, fireplaceActive: true }));
  assert.equal(inferComfortReference(null, heated, { now: heated.at(-1).timestamp }), null);
  assert.deepEqual(inferComfortReference(normal, heated, { now: heated.at(-1).timestamp }), normal);
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

function burnFixture({ confounded = false, repeated = false } = {}) {
  const model = initialAdaptiveModel();
  model.validation = { accepted: true, kind: 'conditional-thermal', samples: 3, fireplaceFreeSamples: 192,
    parameterEvidence: { lossPerHour: { status: 'identified' }, normalHeatCPerHour: { status: 'identified' } } };
  const trueModel = structuredClone(model); trueModel.parameters.fireplaceCPerKg = 0.3;
  const events = repeated ? [event('one', 8 * 24), event('second-same-time', 8 * 24)]
    : Array.from({ length: 11 }, (_, i) => event(`burn-${i}`, (8 + i * 2) * 24));
  let state = { indoorC: 21, reserveC: 21 };
  const samples = [];
  for (let i = 0; i <= 30 * 24; i++) {
    const at = start + i * HOUR, from = at - HOUR;
    const rate = fireplaceRate(events, from, at);
    const inputs = { ...input, outdoorC: 10 + 4 * Math.sin(i / 43), compressorDuty: i % 13 < 5 ? 0.6 : 0.2,
      fireplaceKgPerHour: rate, fireplaceKnown: true,
      solarRadiationWm2: confounded ? rate * 1000 : 0 };
    if (i) state = predictThermalStep(trueModel, state, inputs, 1);
    samples.push({ timestamp: at, indoorC: state.indoorC, ...inputs, phase: 'normal', regime: 'occupied', quality: [],
      windowStart: from, intervalInputs: inputs, fireplaceActive: fireplaceActive(events, at),
      fireplaceIgnitions: events.filter(event => event.litAt >= from && event.litAt < at) });
  }
  return { model, samples, baselineC: 21, episodeArchive: [] };
}

test('fireplace fitting requires separated burns and rejects solar-confounded input', () => {
  for (const options of [{ repeated: true }, { confounded: true }]) {
    const result = fitAdaptiveModel(burnFixture(options));
    const evidence = result.parameterEvidence ?? result.model?.validation?.parameterEvidence;
    assert.notEqual(evidence.fireplaceCPerKg.status, 'identified');
    assert.equal(fireplaceEvidenceReady(result.model), false);
  }
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
