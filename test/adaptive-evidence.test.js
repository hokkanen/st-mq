import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulatedPlant } from '../src/app/simulator.js';
import { inferComfortReference } from '../src/control/learning.js';
import { initialAdaptiveModel, restoreAdaptiveCheckpoint, updateAdaptiveLearning, updateAdaptiveLearningBatch, updateAdaptiveEpisode,
  evaluateThermalModel, fitAdaptiveModel, predictThermalStep, predictEquipmentDuty,
  thermalEvidenceReady, actionEvidenceReady, thermalUncertaintyC, fitEquipmentResponse } from '../src/control/adaptive-learning.js';

const HOUR = 3_600_000, MINUTE = 60_000, start = Date.parse('2026-01-01T00:00:00Z');
const row = (i, changes = {}) => ({ timestamp: start + i * HOUR / 4, indoorC: 21, outdoorC: 21,
  solarRadiationWm2: 0, phase: 'normal', action: 'normal', targetC: 21, roomBoostC: 0,
  regime: 'occupied', quality: [], compressorDuty: 0, auxKw: 0, ...changes });

test('trajectory validation sees a cold excursion even when every day ends at the correct temperature', () => {
  const samples = Array.from({ length: 193 }, (_, i) => row(i, {
    indoorC: 21 - 2.5 * (1 - Math.abs(i / 4 % 24 - 12) / 12) }));
  const result = evaluateThermalModel(initialAdaptiveModel(), samples);
  assert.equal(result.samples, 2);
  assert.ok(result.maxErrorC >= 2.49);
  assert.ok(result.maeC > 1.2);
});

test('a gap scores the preceding twenty-hour fragment instead of erasing its error', () => {
  const samples = Array.from({ length: 193 }, (_, i) => i === 81 ? row(i, { valid: false })
    : row(i, { indoorC: i <= 80 ? 21 - i * 0.025 : 21 }));
  const result = evaluateThermalModel(initialAdaptiveModel(), samples);
  assert.ok(result.horizons.includes(20));
  assert.ok(result.maxErrorC >= 1.99);
  assert.ok(result.maeC > 0.4);
  assert.ok(result.excluded.some(block => block.reason === 'short-fragment'));
});

test('complete short episodes are scored, while phase row counts alone establish no action evidence', () => {
  const samples = Array.from({ length: 9 }, (_, i) => row(i, { phase: i < 4 ? 'reduction' : 'recovery', episodeId: 'short-cycle' }));
  const episode = { id: 'short-cycle', startedAt: start, endedAt: start + 2 * HOUR };
  assert.equal(evaluateThermalModel(initialAdaptiveModel(), samples).samples, 0);
  const result = evaluateThermalModel(initialAdaptiveModel(), samples, { completeEpisodes: [episode] });
  assert.equal(result.samples, 1);
  assert.equal(result.blocks[0].completeEpisode, true);
  assert.equal(result.horizons[0], 2);
  const model = initialAdaptiveModel();
  model.validation = { accepted: true, kind: 'conditional-thermal', samples: 3,
    parameterEvidence: { lossPerHour: { status: 'identified' }, hydronicCPerKwh: { status: 'identified' } },
    phaseSamples: { reduction: 12 }, phaseValidationSamples: { reduction: 4 }, phaseEpisodes: { reduction: 3 } };
  assert.equal(thermalEvidenceReady(model), true);
  assert.equal(actionEvidenceReady(model, 'reduction'), false);
  assert.notEqual(predictThermalStep(model, { indoorC: 21, reserveC: 21 },
    { outdoorC: 0, solarRadiationWm2: 0, phase: 'reduction' }, 1).phaseEvidence, 'checked');
});

test('off-grid archived episodes retain committed boundary windows and invalid barriers after cache eviction', () => {
  const episode = { id: 'off-grid-cycle', startedAt: start + 2 * MINUTE, endedAt: start + 67 * MINUTE,
    phases: ['reduction', 'recovery'], complete: true, recoveryComplete: true, energyBasis: 'estimated', recoveryHours: 0.5 };
  const window = i => {
    if (i === 0) return row(i);
    const from = start + (i - 1) * 15 * MINUTE, to = start + i * 15 * MINUTE;
    const boundaries = [from, episode.startedAt, start + 32 * MINUTE, episode.endedAt, to]
      .filter(at => at >= from && at <= to).sort((a, b) => a - b);
    const inputSegments = [...new Set(boundaries)].slice(1).map((end, j, ends) => {
      const begin = j === 0 ? from : ends[j - 1];
      const active = begin >= episode.startedAt && begin < episode.endedAt;
      return { start: begin, end, outdoorC: 21, solarRadiationWm2: 0, targetC: 21, roomBoostC: 0,
        phase: active ? begin < start + 32 * MINUTE ? 'reduction' : 'recovery' : 'normal',
        regime: 'occupied', episodeId: active ? episode.id : null, thermalCompressorDuty: 0, thermalAuxKw: 0, quality: [] };
    });
    const phases = [...new Set(inputSegments.map(segment => segment.phase))];
    return row(i, { phase: phases.length === 1 ? phases[0] : 'mixed', windowStart: from, inputSegments });
  };
  const evict = (checkpoint, pageSize) => {
    let cp = checkpoint;
    const later = Array.from({ length: 1536 }, (_, i) => row(i + 6, { valid: false }));
    for (let i = 0; i < later.length; i += pageSize)
      cp = updateAdaptiveLearningBatch(cp, later.slice(i, i + pageSize), { now: later.at(-1).timestamp });
    return cp;
  };
  for (const hasInteriorGap of [false, true]) {
    const samples = Array.from({ length: 5 }, (_, i) => hasInteriorGap && i === 2 ? row(i, { valid: false }) : window(i));
    let cp = updateAdaptiveLearningBatch(null, samples, { now: episode.endedAt });
    cp = updateAdaptiveEpisode(cp, episode);
    assert.equal(cp.episodeArchive[0].samples.length, 5, 'The pre-start endpoint is retained');
    assert.equal(evaluateThermalModel(cp.model, cp.episodeArchive[0].samples,
      { completeEpisodes: cp.episodeArchive }).samples, 0, 'The uncommitted tail cannot count as observed');
    const originalRows = structuredClone(cp.episodeArchive[0].samples);
    const restored = restoreAdaptiveCheckpoint(JSON.stringify(cp));
    cp = updateAdaptiveLearning(cp, window(5), { now: start + 75 * MINUTE });
    assert.deepEqual(cp.episodeArchive, updateAdaptiveLearning(restored, window(5),
      { now: start + 75 * MINUTE }).episodeArchive, 'A saved pending archive resumes identically');
    const alreadyCommitted = updateAdaptiveEpisode(updateAdaptiveLearningBatch(null, [...samples, window(5)],
      { now: start + 75 * MINUTE }), episode);
    assert.deepEqual(cp.episodeArchive, alreadyCommitted.episodeArchive,
      'Processing completion after its committed tail retains the same normalized windows');
    assert.deepEqual(cp.episodeArchive[0].samples.slice(0, 5), originalRows);
    assert.deepEqual(cp.episodeArchive[0].samples.at(-1), cp.samples.at(-1), 'Archive uses the exact committed tail window');
    const alternateReplay = evict(cp, 127);
    cp = evict(cp, 512);
    assert.ok(Date.parse(cp.samples[0].timestamp) > episode.endedAt);
    assert.equal(cp.episodeArchive[0].samples.length, 6, 'The archive stops at the first covering endpoint');
    assert.deepEqual(cp.episodeArchive, alternateReplay.episodeArchive, 'Replay paging cannot change archived windows');
    assert.equal(cp.episodeArchive[0].samples.some(sample => sample.valid === false), hasInteriorGap);
    const result = evaluateThermalModel(cp.model, [...cp.episodeArchive[0].samples, cp.samples[0]],
      { completeEpisodes: cp.episodeArchive });
    assert.equal(result.samples, hasInteriorGap ? 0 : 1);
    if (!hasInteriorGap) assert.equal(result.blocks[0].completeEpisode, true,
      'A later gap does not erase a complete continuously observed cycle');
  }
});

test('unknown heat input and collinear steady inputs cannot identify thermal coefficients', () => {
  const samples = Array.from({ length: 961 }, (_, i) => row(i, { outdoorC: 0, compressorDuty: null, auxKw: null }));
  const unavailable = fitAdaptiveModel({ samples, model: initialAdaptiveModel(), baselineC: 21, episodeArchive: [] });
  assert.equal(unavailable.accepted, false);
  assert.equal(unavailable.reason, 'insufficient-independent-observed-inputs');
  const steady = fitAdaptiveModel({ samples: samples.map(sample => ({ ...sample, compressorDuty: 0.5, auxKw: 0 })),
    model: initialAdaptiveModel(), baselineC: 21, episodeArchive: [] });
  assert.equal(steady.accepted, false);
  assert.equal(steady.parameterEvidence.hydronicCPerKwh.reason, 'confounded-with-other-heat-inputs');
  assert.equal(steady.parameterEvidence.memoryExchangePerHour.status, 'fixed');
});

let plantFixture;
function observedPlant() {
  if (plantFixture) return structuredClone(plantFixture);
  const plant = new SimulatedPlant();
  const config = { thermalPriors: { hydronicCPerKwh: 1.3 / 9.4, lossPerHour: 0.02,
    memoryExchangePerHour: 1.6 / 6, reserveTimeHours: 24 / 1.6, solarCPerHourPerKwM2: 0 } };
  const samples = [], episodeArchive = [];
  let duty = 0, auxiliary = 0, outdoor = 0;
  const context = at => {
    const day = Math.floor((at - start) / (24 * HOUR)), hour = ((at - start) / HOUR % 24 + 24) % 24;
    return { phase: hour >= 8 && hour < 16 ? 'reduction' : hour >= 16 && hour < 22 ? 'recovery' : 'normal',
      episodeId: hour >= 8 && hour < 22 ? `invented-plant-cycle-${day}` : null };
  };
  for (let minute = 0; minute <= 14 * 1440; minute++) {
    const now = start + minute * MINUTE, current = context(now);
    plant.state.action = current.phase === 'reduction' ? 'reduction' : 'normal';
    plant.state.phase = current.phase;
    const reading = plant.sample(now);
    duty += reading.actual.compressorDuty; auxiliary += reading.actual.auxKw; outdoor += reading.outdoor.value;
    if (minute % 15 !== 0) continue;
    const from = now - 15 * MINUTE, interval = context(from), count = minute === 0 ? 1 : 15;
    const inputs = { ...interval, outdoorC: outdoor / count, solarRadiationWm2: 0,
      targetC: 21, roomBoostC: 0, compressorDuty: duty / count, auxKw: auxiliary / count };
    samples.push({ ...row(minute / 15), ...inputs, indoorC: reading.indoor.value, windowStart: from, inputSegments: [{ ...inputs, start: from, end: now, thermalCompressorDuty: inputs.compressorDuty, thermalAuxKw: inputs.auxKw, regime: 'occupied', quality: [] }] });
    duty = 0; auxiliary = 0; outdoor = 0;
  }
  for (let day = 0; day < 14; day++) {
    const id = `invented-plant-cycle-${day}`;
    episodeArchive.push({ id, startedAt: start + (day * 24 + 8) * HOUR, endedAt: start + (day * 24 + 22) * HOUR,
      phases: ['reduction', 'recovery'], auxiliaryObserved: false, samples: samples.filter(sample => sample.episodeId === id) });
  }
  plantFixture = { config, samples, episodeArchive };
  return structuredClone(plantFixture);
}

test('an independent slow-heating plant learns from application defaults without hidden state or plant memory priors', () => {
  const { samples, episodeArchive } = observedPlant(), prior = initialAdaptiveModel();
  const result = fitAdaptiveModel({ samples, model: prior, baselineC: 21, episodeArchive });
  assert.equal(result.accepted, true, JSON.stringify(result.validation ?? result.parameterEvidence));
  assert.equal(thermalEvidenceReady(result.model), true);
  assert.deepEqual(result.model.validation.fittedParameters.sort(), ['hydronicCPerKwh', 'lossPerHour']);
  assert.equal(result.model.parameters.memoryExchangePerHour, prior.parameters.memoryExchangePerHour);
  assert.equal(result.model.parameters.reserveTimeHours, prior.parameters.reserveTimeHours);
  assert.equal(Object.keys(result.model.parameters).length, 6);
  assert.ok(result.model.validation.maeC < 0.35);
  assert.ok(result.model.validation.maxErrorC < 0.75);
  assert.ok(result.model.validation.maeC < result.model.validation.previousMaeC);
  assert.ok(result.model.validation.maeC < result.model.validation.persistenceMaeC);
  assert.notEqual(result.model.forecastValidation?.accepted, true, 'Conditional fit is not advance economic evidence');
  const points = result.model.uncertainty.points;
  assert.ok(points.length > 0);
  assert.ok(points.every((point, i) => point.blocks >= 3 && (i === 0 || point.errorC >= points[i - 1].errorC)));
  const last = points.at(-1);
  assert.ok(thermalUncertaintyC(result.model, last.hours + 6, { solarRadiationWm2: 0 }) > last.errorC);
});

test('empirical action response uses distinct complete held-out episodes and expires at an equipment epoch', () => {
  const { config, samples, episodeArchive } = observedPlant();
  const cp = { samples, episodeArchive, model: initialAdaptiveModel(config), baselineC: 21 };
  const result = fitAdaptiveModel(cp, config);
  assert.equal(result.accepted, true, JSON.stringify(result.validation));
  const response = result.model.equipmentResponse;
  assert.ok(response.phases.reduction.trainingEpisodes >= 3);
  assert.ok(response.validation.phases.reduction.episodes >= 3);
  assert.equal(response.validation.kind, 'held-out-conditional-equipment-response');
  assert.ok(response.phases.reduction.ratio < 1);
  assert.equal(actionEvidenceReady(result.model, 'reduction', 24), false);
  const changed = fitAdaptiveModel({ ...cp, equipmentEpochAt: start + 20 * 24 * HOUR }, config);
  assert.equal(changed.accepted, true);
  assert.deepEqual(changed.model.equipmentResponse.phases, {});
});

test('reduction allows sustained compressor operation and unknown tariff response cannot promise savings', () => {
  const model = initialAdaptiveModel(), state = { indoorC: 21, reserveC: 21 };
  const inputs = { outdoorC: -30, targetC: 21, phase: 'reduction', solarRadiationWm2: 0 };
  assert.equal(predictEquipmentDuty(model, state, inputs).compressorDuty, 1);
  assert.equal(predictEquipmentDuty(model, state, { ...inputs, nativeCompressorDemand: true }).compressorDuty, 1);
  assert.equal(predictEquipmentDuty(model, state, { ...inputs, nativeCompressorDemand: false }).compressorDuty, 0);
  const mild = { ...inputs, outdoorC: 10 };
  assert.equal(predictEquipmentDuty(model, state, mild).compressorDuty,
    predictEquipmentDuty(model, state, { ...mild, phase: 'normal' }).compressorDuty);
  assert.equal(predictEquipmentDuty(model, state, mild).uncertaintyDuty, 1);
});

test('one long or high-boost action cannot license durations or boosts without three independent examples', () => {
  const make = (prefix, i, hours, boost) => ({ timestamp: start + i * 24 * HOUR, indoorC: 21, reserveC: 21,
    dt: hours, episodeId: `${prefix}-${i}`, segments: [{ start: start + i * 24 * HOUR,
      end: start + (i * 24 + hours) * HOUR, episodeId: `${prefix}-${i}`, phase: 'preheat',
      outdoorC: 0, targetC: 21, roomBoostC: boost, compressorDuty: boost === 5 ? 1 : 0.8, auxKw: 0 }] });
  const training = [make('train', 0, 0.5, 1), make('train', 1, 0.5, 1), make('train', 2, 4, 5)];
  const holdout = [make('later', 3, 0.5, 1), make('later', 4, 0.5, 1), make('later', 5, 4, 5)];
  const response = fitEquipmentResponse(initialAdaptiveModel(), training, holdout,
    training.map(row => ({ id: row.episodeId })), holdout.map(row => ({ id: row.episodeId })));
  assert.equal(response.validation.phases.preheat.maxDurationHours, 0.5);
  assert.equal(response.validation.phases.preheat.maxRoomBoostC, 1);
  const acknowledged = [0, 1, 2].map(i => make('acknowledged', i, 0.22, 1));
  const acknowledgedLater = [3, 4, 5].map(i => make('acknowledged-later', i, 0.22, 1));
  const short = fitEquipmentResponse(initialAdaptiveModel(), acknowledged, acknowledgedLater,
    acknowledged.map(row => ({ id: row.episodeId })), acknowledgedLater.map(row => ({ id: row.episodeId })));
  assert.equal(short.validation.phases.preheat.episodes, 3);
  assert.equal(short.validation.phases.preheat.maxDurationHours, 0.22, 'Acknowledgement delay cannot round supported duration upward');
});

test('recorded compressor heat charges the slow state before a measured room plateau warms', () => {
  let cp = null;
  for (let i = 0; i <= 4; i++) cp = updateAdaptiveLearning(cp, row(i, { compressorDuty: 1 }), { now: start + i * HOUR / 4 });
  assert.equal(cp.state.indoorC, 21);
  assert.ok(cp.state.reserveC > 21.5);
  const restored = restoreAdaptiveCheckpoint({ ...cp, state: { ...cp.state, reserveC: 500 } });
  assert.equal(restored.state, null);
});

test('known mixed input segments remain useful and are applied in order using attributed space heat', () => {
  const cp = updateAdaptiveLearning(null, row(0), { now: start });
  const segments = [
    { start, end: start + 10 * MINUTE, outdoorC: 21, solarRadiationWm2: 0, phase: 'normal', regime: 'occupied',
      compressorDuty: 1, thermalCompressorDuty: 0, auxKw: 3, thermalAuxKw: 0, targetC: 21 },
    { start: start + 10 * MINUTE, end: start + 15 * MINUTE, outdoorC: 21, solarRadiationWm2: 0,
      phase: 'reduction', regime: 'away', compressorDuty: 1, thermalCompressorDuty: 1, auxKw: 3, thermalAuxKw: 3, targetC: 21 },
  ];
  const mixed = updateAdaptiveLearning(cp, row(1, { phase: 'mixed', regime: 'mixed', windowStart: start, inputSegments: segments }),
    { now: start + 15 * MINUTE });
  assert.equal(mixed.samples.at(-1).inputSegments.length, 2);
  assert.equal(mixed.health.usableSamples, 2);
  const model = initialAdaptiveModel();
  const expected = predictThermalStep(model, { indoorC: 21, reserveC: 21 },
    { ...segments[1], compressorDuty: 1, auxKw: 3 }, 1 / 12);
  assert.ok(Math.abs(mixed.state.reserveC - expected.reserveC) < 1e-9);
});

test('fractional runtime cannot establish a warm-weather baseline by counting whole active windows', () => {
  const samples = Array.from({ length: 97 }, (_, i) => row(i, { windowStart: start + (i - 1) * HOUR / 4,
    indoorC: 21.6, outdoorC: 18, thermalCompressorDuty: 0.02,
    heating: { verified: true, compressorActive: true, compressorDuty: 0.02, route: 'space-heating', quality: [] } }));
  assert.equal(inferComfortReference(null, samples, { now: start + 24 * HOUR }), null);
  const sufficient = samples.map(sample => ({ ...sample, thermalCompressorDuty: 0.2 }));
  const result = inferComfortReference(null, sufficient, { now: start + 24 * HOUR });
  assert.ok(Math.abs(result.heatingEvidence.spaceHeatingHours - 4.8) < 1e-9);
});

test('changed nominal power overrides saved values while unchanged configuration preserves measured calibration', () => {
  const cp = restoreAdaptiveCheckpoint(null, { heatPumpCompressorKw: 3, auxRatedKw: 9 });
  cp.model.energy.compressorKw = 3.5;
  assert.equal(restoreAdaptiveCheckpoint(cp, { heatPumpCompressorKw: 3 }).model.energy.compressorKw, 3.5);
  const changed = restoreAdaptiveCheckpoint(cp, { heatPumpCompressorKw: 4, auxRatedKw: 6 });
  assert.equal(changed.model.energy.compressorKw, 4);
  assert.equal(changed.model.energy.auxiliaryKw, 6);
});

test('advance forecast evidence rejects missing outcomes and needs three comparable-duration cycles', () => {
  let cp = null;
  const episode = (i, reductionHours, extra = {}) => ({ id: `invented-advance-${i}`, startedAt: start + i * 24 * HOUR,
    endedAt: start + (i * 24 + 8) * HOUR, complete: true, recoveryComplete: true, energyBasis: 'estimated',
    recoveryHours: 1, forecastValidation: { eligible: true, adjusted: false, basis: 'frozen-advance-forecast',
      temperatureMaeC: 0.2, minimumTemperatureErrorC: 0.3, energyRelativeError: 0.2,
      costRelativeError: 0.1, reductionHours, ...extra } });
  cp = updateAdaptiveEpisode(cp, episode(0, 0.5, { energyRelativeError: null }));
  assert.equal(cp.model.forecastValidation, undefined);
  for (const [i, duration] of [[1, 4], [2, 0.5], [3, 0.5]]) cp = updateAdaptiveEpisode(cp, episode(i, duration));
  assert.equal(cp.model.forecastValidation.accepted, true);
  assert.equal(cp.model.forecastValidation.episodes, 3);
  assert.equal(cp.model.forecastValidation.maxReductionHours, 0.5);
  cp = updateAdaptiveEpisode(cp, episode(4, 0.5, { minimumTemperatureErrorC: 1.2 }));
  assert.equal(cp.model.forecastValidation.accepted, false);
});

test('a cycle straddling an equipment epoch cannot recalibrate the replacement policy', () => {
  const cp = restoreAdaptiveCheckpoint(null);
  cp.equipmentEpochAt = start + HOUR;
  const before = structuredClone(cp.model.energy);
  const next = updateAdaptiveEpisode(cp, { id: 'invented-old-policy-cycle', startedAt: start,
    endedAt: start + 6 * HOUR, complete: true, recoveryComplete: true, energyBasis: 'measured',
    compressorEnergyMeasured: true, compressorKwh: 12, compressorRunHours: 2,
    auxiliaryObserved: true, auxiliaryRouteKnown: true, spaceHeatingAuxKwh: 3,
    predictedSpaceHeatingAuxKwh: 1, recoveryHours: 4, recoveryEnergyKwh: 9, recoveryAuxKwh: 3,
    predictedRecoveryEnergyKwh: 4, predictedRecoveryAuxKwh: 1 });
  assert.deepEqual(next.model.energy, before);
  assert.equal(next.model.forecastValidation, undefined);
});

test('a failing current holdout revokes readiness while retaining coefficients, then good evidence recovers', () => {
  const { samples, episodeArchive } = observedPlant();
  const first = fitAdaptiveModel({ samples, model: initialAdaptiveModel(), baselineC: 21, episodeArchive });
  assert.equal(first.accepted, true);
  const changed = samples.map((sample, i) => ({ ...sample, indoorC: sample.indoorC
    + (i >= samples.length - 240 ? Math.min(2, (i - (samples.length - 240)) * 0.05) : 0) }));
  let checkpoint = restoreAdaptiveCheckpoint(null);
  Object.assign(checkpoint, { model: first.model, baselineC: 21, samples: changed.slice(0, -1), episodeArchive,
    cursor: changed.at(-2).timestamp, sinceFit: 11 });
  const retained = updateAdaptiveLearning(checkpoint, changed.at(-1), { now: changed.at(-1).timestamp });
  assert.deepEqual(retained.model.parameters, first.model.parameters);
  assert.equal(retained.model.validation.accepted, false);
  assert(retained.model.validation.maxErrorC > 0.75);
  assert.equal(thermalEvidenceReady(retained.model), false);
  assert.equal(actionEvidenceReady(retained.model, 'reduction'), false);
  assert.equal(retained.model.lastAcceptedValidation.accepted, true);
  assert.deepEqual(updateAdaptiveLearning(restoreAdaptiveCheckpoint(JSON.stringify(checkpoint)), changed.at(-1),
    { now: changed.at(-1).timestamp }), retained, 'Current restart reproduces the evidence revocation exactly');
  const recovered = fitAdaptiveModel({ ...retained, samples, episodeArchive });
  assert.equal(recovered.accepted, true);
  assert.equal(thermalEvidenceReady(recovered.model), true);
  const insufficient = fitAdaptiveModel({ ...retained, samples: samples.slice(0, 12), episodeArchive: [] });
  assert.equal(insufficient.incumbent, undefined, 'Insufficient observations do not claim demonstrated failure');
});
