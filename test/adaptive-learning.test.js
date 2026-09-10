import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Store } from '../src/storage/store.js';
import { importCsv } from '../src/storage/history.js';
import { initialAdaptiveModel, predictThermalStep, updateAdaptiveLearning, updateAdaptiveLearningBatch, updateAdaptiveEpisode } from '../src/control/adaptive-learning.js';

const HOUR = 3_600_000, start = Date.parse('2026-01-01T00:00:00Z');
const sample = (i, changes = {}) => ({ timestamp: start + i * HOUR, indoorC: 21, outdoorC: 0,
  solarRadiationWm2: 0, phase: 'normal', roomBoostC: 0, regime: 'occupied', quality: [],
  actualModeKnown: false, powerKw: null, energyBasis: 'unknown', ...changes });

test('normal-only requested-mode history establishes a reference without pretending to identify heat response', () => {
  let cp = null;
  for (let i = 0; i < 144; i++) cp = updateAdaptiveLearning(cp, sample(i), { now: start + i * HOUR });
  assert.equal(cp.model.validation, null);
  assert.equal(cp.health.acceptedFits, 0);
  assert.equal(cp.health.reason, 'insufficient-independent-observed-inputs');
  assert.equal(cp.model.energy.basis, 'estimated');
  assert.equal(cp.model.energy.measuredEpisodes, 0);
  assert.equal(cp.baselineC, 21);
  assert.equal(cp.health.evidence, 'includes-requested-modes');
  const result = predictThermalStep(cp.model, cp.state, { outdoorC: 0, solarRadiationWm2: 0,
    phase: 'reduction', targetC: 21 }, 1);
  assert.equal(result.phaseEvidence, 'prior', 'An observed normal mode does not validate reduction');
});

test('solar, preheat demand and charged thermal memory affect future temperature without an indoor upper clamp', () => {
  const model = initialAdaptiveModel(), state = { indoorC: 21, reserveC: 21 };
  const inputs = { outdoorC: 0, phase: 'normal', roomBoostC: 0, targetC: 21, solarRadiationWm2: 0 };
  const normal = predictThermalStep(model, state, inputs, 1);
  const sunny = predictThermalStep(model, state, { ...inputs, solarRadiationWm2: 800 }, 1);
  const preheat = predictThermalStep(model, state, { ...inputs, phase: 'preheat', roomBoostC: 5 }, 1);
  const reduction = predictThermalStep(model, state, { ...inputs, phase: 'reduction' }, 1);
  const stored = predictThermalStep(model, { ...state, reserveC: 23 }, { ...inputs, phase: 'reduction' }, 1);
  assert.ok(sunny.indoorC > normal.indoorC);
  assert.ok(preheat.indoorC > normal.indoorC);
  assert.ok(preheat.reserveC > normal.reserveC);
  assert.equal(reduction.indoorC, normal.indoorC);
  assert.equal(reduction.compressorDuty, normal.compressorDuty, 'Unobserved tariff response cannot promise less compressor electricity');
  assert.ok(stored.indoorC > reduction.indoorC);
  assert.ok(preheat.compressorDuty >= normal.compressorDuty);
  const warm = predictThermalStep(model, { indoorC: 27, reserveC: 27 },
    { ...inputs, outdoorC: 30, solarRadiationWm2: 1500 }, 1);
  assert.ok(warm.indoorC > 27, 'Prediction must not clamp inconveniently high observations');
});

test('missing radiation increases uncertainty rather than pretending the forecast predicts darkness', () => {
  const model = initialAdaptiveModel(), state = { indoorC: 21, reserveC: 21 };
  const known = predictThermalStep(model, state, { outdoorC: 0, phase: 'normal', solarRadiationWm2: 0 }, 1);
  const missing = predictThermalStep(model, state, { outdoorC: 0, phase: 'normal', solarRadiationWm2: null }, 1);
  assert.equal(known.solarKnown, true); assert.equal(missing.solarKnown, false);
  assert.ok(missing.uncertaintyC > known.uncertaintyC);
});

test('actual compressor duty and auxiliary input affect the same prediction used by the planner', () => {
  const model = initialAdaptiveModel(), state = { indoorC: 20, reserveC: 20 };
  const inputs = { outdoorC: 0, phase: 'normal', targetC: 21, solarRadiationWm2: 0 };
  const stopped = predictThermalStep(model, state, { ...inputs, compressorDuty: 0 }, 1);
  const running = predictThermalStep(model, state, { ...inputs, compressorDuty: 1 }, 1);
  const assisted = predictThermalStep(model, state, { ...inputs, compressorDuty: 1, auxKw: 3 }, 1);
  assert.equal(stopped.compressorDuty, 0); assert.equal(running.compressorDuty, 1);
  assert.ok(running.indoorC > stopped.indoorC); assert.ok(assisted.indoorC > running.indoorC);
});

test('duplicates, future records and bad-quality gaps do not invent continuous training or a reference', () => {
  let cp = null;
  for (let i = 0; i < 30; i++) cp = updateAdaptiveLearning(cp, sample(i, i === 20 ? { quality: ['bad'] } : {}), { now: start + i * HOUR });
  assert.equal(cp.baselineC, null);
  assert.equal(cp.samples[20].valid, false);
  assert.deepEqual(updateAdaptiveLearning(cp, sample(29), { now: start + 29 * HOUR }), cp);
  assert.deepEqual(updateAdaptiveLearning(cp, sample(40), { now: start + 30 * HOUR }), cp);
  assert.equal(updateAdaptiveLearning('{bad', sample(0), { now: start }).model.provenance.status, 'prior-estimates');
  assert.throws(() => predictThermalStep(initialAdaptiveModel(), { indoorC: 21 }, { outdoorC: 0 }, -1));
});

test('coupled preheat and recovery do not redefine the achieved normal-temperature baseline', () => {
  let cp = null;
  for (let i = 0; i < 30; i++) cp = updateAdaptiveLearning(cp, sample(i), { now: start + i * HOUR });
  assert.equal(cp.baselineC, 21);
  for (let i = 30; i < 60; i++) cp = updateAdaptiveLearning(cp, sample(i,
    { phase: 'preheat', indoorC: 23, roomBoostC: 5 }), { now: start + i * HOUR });
  assert.equal(cp.baselineC, 21);
});

test('ordered adaptive batches preserve gradual comfort adaptation and individual room references', () => {
  const samples = Array.from({ length: 174 }, (_, i) => {
    const dayHour = (i - 30) % 24;
    const phase = i < 30 || dayHour >= 6 ? 'normal' : dayHour < 2 ? 'preheat' : dayHour < 4 ? 'reduction' : 'recovery';
    const downstairs = i < 30 ? 22 : 20, bedroom = i < 30 ? 20 : 18;
    return sample(i, { phase, indoorC: (downstairs + bedroom) / 2, measurementEpochAt: start,
      indoorSensors: { downstairs_temperature: { value: downstairs, weight: 0.5 },
        bedroom_temperature: { value: bedroom, weight: 0.5 }, indoor_temperature: { value: 25, weight: 0 } } });
  });
  let single = null;
  for (const current of samples) single = updateAdaptiveLearning(single, current, { now: current.timestamp });
  let batched = updateAdaptiveLearningBatch(null, samples.slice(0, 78), { now: samples.at(-1).timestamp });
  batched = updateAdaptiveLearningBatch(JSON.stringify(batched), samples.slice(78), { now: samples.at(-1).timestamp });
  assert.deepEqual(batched.comfortReference, single.comfortReference);
  assert.deepEqual(batched.sensorComfortReferences, single.sensorComfortReferences);
  assert.ok(single.baselineC < 20.6 && single.baselineC > 20);
  assert.equal(single.sensorComfortReferences.downstairs_temperature.targetC - single.sensorComfortReferences.bedroom_temperature.targetC, 2);
  assert.equal(single.sensorComfortReferences.indoor_temperature, undefined, 'Zero-weight sensors do not define occupied room limits');
  assert.deepEqual(single.samples.at(-1).indoorSensors, samples.at(-1).indoorSensors);
  assert.equal(single.samples.at(-1).measurementEpochAt, start);
  const invalid = updateAdaptiveLearning(single, sample(174, { ...samples.at(-1), timestamp: start + 174 * HOUR, quality: ['missing'] }),
    { now: start + 174 * HOUR });
  assert.equal(invalid.samples.at(-1).valid, false);
  assert.equal(invalid.samples.at(-1).measurementEpochAt, start);
  assert.deepEqual(invalid.samples.at(-1).indoorSensors, samples.at(-1).indoorSensors);
  assert.equal(invalid.sensorComfortReferences.bedroom_temperature.adaptation, null);
  const missingBedroom = updateAdaptiveLearning(single, { ...samples.at(-1), timestamp: start + 174 * HOUR,
    indoorSensors: { ...samples.at(-1).indoorSensors, bedroom_temperature: { value: null, weight: 0.5 } } },
  { now: start + 174 * HOUR });
  assert.equal(missingBedroom.sensorComfortReferences.bedroom_temperature.targetC, single.sensorComfortReferences.bedroom_temperature.targetC);
  assert.equal(missingBedroom.sensorComfortReferences.bedroom_temperature.adaptation, null);
  assert.ok(missingBedroom.sensorComfortReferences.downstairs_temperature.adaptation);
});

test('episode calibration retains attribution and does not turn estimated or incomplete cycles into measured evidence', () => {
  const cp = updateAdaptiveLearning(null, sample(0), { now: start });
  const episode = { id: 'synthetic-cycle', endedAt: start + 10 * HOUR, complete: true, recoveryComplete: true,
    energyBasis: 'estimated', compressorKwh: 7, compressorRunHours: 2, recoveryHours: 4,
    recoveryEnergyKwh: 6, spaceHeatingAuxKwh: 1, dhwAuxKwh: 2,
    predictedEnergyKwh: 8, actualEnergyKwh: 10 };
  assert.deepEqual(updateAdaptiveEpisode(cp, { ...episode, recoveryComplete: false }), cp);
  const next = updateAdaptiveEpisode(cp, episode);
  assert.equal(next.model.energy.episodes, 1);
  assert.equal(next.model.energy.measuredEpisodes, 0);
  assert.equal(next.model.energy.basis, 'estimated');
  assert.equal(next.model.energy.spaceHeatingAuxKwh, 1);
  assert.equal(next.model.energy.dhwAuxKwh, 2);
  assert.equal(next.model.energy.compressorKw, cp.model.energy.compressorKw, 'Estimated compressor power cannot calibrate itself');
  assert.equal(next.model.energy.relativeUncertainty, cp.model.energy.relativeUncertainty);
  assert.deepEqual(updateAdaptiveEpisode(next, episode), next);
});

test('observed recovery components calibrate costs and auxiliary risk without double counting DHW auxiliary energy', () => {
  const cp = updateAdaptiveLearning(null, sample(0), { now: start });
  const episode = { id: 'observed-cycle', endedAt: start + 10 * HOUR, complete: true, recoveryComplete: true,
    energyBasis: 'estimated', compressorActivityObserved: true, auxiliaryObserved: true, auxiliaryRouteKnown: true,
    recoveryHours: 4, recoveryEnergyKwh: 10, recoveryAuxKwh: 2,
    predictedRecoveryEnergyKwh: 6, predictedRecoveryAuxKwh: 2,
    spaceHeatingAuxKwh: 2, dhwAuxKwh: 7, predictedSpaceHeatingAuxKwh: 1,
    frozenRecoveryMultiplier: 1.5, frozenAuxiliaryRiskScale: 1 };
  const result = updateAdaptiveEpisode(cp, episode);
  assert.ok(result.model.energy.recoveryMultiplier > cp.model.energy.recoveryMultiplier);
  assert.ok(result.model.energy.auxiliaryRiskScale > cp.model.energy.auxiliaryRiskScale);
  assert.equal(result.model.energy.measuredEpisodes, 0);
  assert.equal(result.model.energy.basis, 'estimated');
  assert.equal(result.model.energy.relativeUncertainty, cp.model.energy.relativeUncertainty);
  const differentDhw = updateAdaptiveEpisode(cp, { ...episode, dhwAuxKwh: 17 });
  assert.equal(differentDhw.model.energy.auxiliaryRiskScale, result.model.energy.auxiliaryRiskScale);
  const unknown = updateAdaptiveEpisode(cp, { ...episode, auxiliaryObserved: false, compressorActivityObserved: false });
  assert.equal(unknown.model.energy.recoveryMultiplier, cp.model.energy.recoveryMultiplier);
  assert.equal(unknown.model.energy.auxiliaryRiskScale, cp.model.energy.auxiliaryRiskScale);
});

test('adaptive history pages are bounded, chronological, and retain a thermal prior without hindsight solar', () => {
  const cp = updateAdaptiveLearningBatch(null, Array.from({ length: 144 }, (_, i) => sample(i,
    { solarRadiationWm2: null })), { now: start + 144 * HOUR });
  assert.equal(cp.samples.length, 144);
  assert.equal(cp.health.solarSamples, 0);
  assert.equal(cp.model.validation, null);
  assert.throws(() => updateAdaptiveLearningBatch(null, Array(513).fill(sample(0)), { now: start }), RangeError);
  assert.deepEqual(updateAdaptiveLearningBatch(cp, [sample(0)], { now: start + 144 * HOUR }), cp);
});

test('history worker reconstructs adaptive and legacy checkpoints independently and resumes without duplicate fitting', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'stmq-adaptive-history-'));
  const dbPath = join(dir, 'history.sqlite'), file = join(dir, 'synthetic.csv');
  const store = new Store(dbPath);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(file, 'unix_time,price,heat_on,temp_in,temp_ga,temp_out\n'
    + Array.from({ length: 144 }, (_, i) => `${(start + i * HOUR) / 1000},10,15,21,10,0\n`).join(''));
  await importCsv(store, file, { kind: 'stmq' });
  const run = () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../src/app/learning-worker.js', import.meta.url), { workerData: { dbPath } });
    worker.once('error', reject);
    worker.on('message', result => { if (result.error) reject(new Error(result.error)); });
    worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Worker exit ${code}`)));
  });
  await run();
  const adaptive = store.getState('adaptive:history');
  assert.equal(adaptive?.model.validation, null);
  assert.equal(adaptive.samples.length, 573, 'Hourly imports become causal UTC quarter-hour windows');
  assert.ok(adaptive.samples.every(row => row.solarRadiationWm2 === null && row.actualModeKnown === false));
  assert.ok(store.getState('learning:history')?.checkpoint);
  assert.equal(store.getState('learned:mqtt'), null, 'History must not overwrite the active live checkpoint');
  await run();
  assert.equal(store.getState('adaptive:history').health.acceptedFits, adaptive.health.acceptedFits);
  assert.equal(store.getState('learning:health').processed, 0);
});
