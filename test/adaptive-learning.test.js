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

test('normal-only startup learns usable thermal evidence without action or meter bootstrap deadlock', () => {
  let cp = null;
  for (let i = 0; i < 144; i++) cp = updateAdaptiveLearning(cp, sample(i), { now: start + i * HOUR });
  assert.ok(cp.model.validation?.accepted);
  assert.ok(cp.health.acceptedFits > 0);
  assert.equal(cp.model.validation.phaseSamples.reduction, 0);
  assert.equal(cp.model.energy.basis, 'estimated');
  assert.equal(cp.model.energy.measuredEpisodes, 0);
  assert.equal(cp.baselineC, 21);
  assert.equal(cp.health.evidence, 'includes-requested-modes');
  assert.ok(Date.parse(cp.model.validation.validateFrom) - Date.parse(cp.model.validation.trainThrough) >= 12 * HOUR);
  const result = predictThermalStep(cp.model, cp.state, { outdoorC: 0, solarRadiationWm2: 0,
    phase: 'reduction', targetC: 21 }, 1);
  assert.equal(result.phaseEvidence, 'prior', 'An observed normal mode does not validate reduction');
});

test('solar, coupled preheat and thermal memory affect future temperature without an indoor upper clamp', () => {
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
  assert.ok(reduction.indoorC < normal.indoorC);
  assert.ok(reduction.compressorDuty < normal.compressorDuty, 'Reduced heat must imply less compressor electricity');
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
  assert.ok(cp.model.validation?.accepted);
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
  assert.ok(adaptive?.model.validation?.accepted);
  assert.equal(adaptive.samples.length, 144);
  assert.ok(adaptive.samples.every(row => row.solarRadiationWm2 === null && row.actualModeKnown === false));
  assert.ok(store.getState('learning:history')?.checkpoint);
  assert.equal(store.getState('learned:mqtt'), null, 'History must not overwrite the active live checkpoint');
  await run();
  assert.equal(store.getState('adaptive:history').health.acceptedFits, adaptive.health.acceptedFits);
  assert.equal(store.getState('learning:health').processed, 0);
});
