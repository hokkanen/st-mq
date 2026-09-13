import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { Envelope, getChartData } from '../src/app/chart-data.js';
import { createChartService } from '../src/app/chart-service.js';
import { addModelCoefficients } from '../src/app/chart-model-coefficients.js';
import { addSensorChange, revertSensorChange } from '../src/app/sensor-changes.js';
import { MODEL_COEFFICIENT_INFO } from '../src/domain/history-series.js';
import { appendLearningRecord, applyLearningRecord, learningConfiguration, learningVersion,
  LEARNING_ALGORITHM } from '../src/app/committed-learning.js';
import { initialAdaptiveModel, predictThermalStep, restoreAdaptiveCheckpoint } from '../src/control/adaptive-learning.js';

const MINUTE = 60_000, start = Date.parse('2026-09-08T08:00:00Z');
const coefficientFields = {
  model_coefficient_heat_loss: 'lossPerHour',
  model_coefficient_compressor_response: 'normalHeatCPerHour',
  model_coefficient_solar_response: 'solarCPerHourPerKwM2',
  model_coefficient_auxiliary_response: 'auxiliaryCPerKwh',
  model_coefficient_fireplace_response: 'fireplaceCPerKg',
};

function context(store, at, { input = 'providers', config = {}, seed = null, model = null } = {}) {
  return appendLearningRecord(store, input, 'context', { timestamp: at,
    ...(model ? { historySeed: { model, source: { basis: 'invented-test-model' } } } : {}) }, { config, seed });
}

function model(lossPerHour, extra = {}) {
  return initialAdaptiveModel({ thermalPriors: { lossPerHour, ...extra } });
}

function project(store, { input = 'providers', from = start, to = start + 60 * MINUTE,
  now = to, keys = Object.keys(coefficientFields) } = {}) {
  const range = { from, to };
  const envelopes = Object.fromEntries(keys.map(key => [key, new Envelope(from, to, 2000)]));
  const meta = addModelCoefficients({ store, range, now, input, envelopes });
  return { meta, series: Object.fromEntries(Object.entries(envelopes).map(([key, envelope]) => [key, envelope.values()])) };
}

function databaseSnapshot(store) {
  const tables = store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  return tables.map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]);
}

const values = (result, key = 'model_coefficient_heat_loss') => result.series[key].filter(point => point.y !== null);

test('coefficient projection replays before the range and ignores mutable state and future records without writing', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  context(store, start - 60 * MINUTE, { config: { thermalPriors: { lossPerHour: 0.025 } } });
  context(store, start - 30 * MINUTE, { model: model(0.035) });
  const records = store.learningJournal({ input: 'providers' });
  let checkpoint = null;
  for (const entry of records) checkpoint = applyLearningRecord(checkpoint, entry);
  store.setState('adaptive:providers', { ...checkpoint, model: model(0.11),
    privateFixture: 'invented-checkpoint-marker-not-for-browser' });
  context(store, start + 45 * MINUTE, { model: model(0.09) });
  const before = databaseSnapshot(store);
  store.db.exec('PRAGMA query_only = ON');
  const result = project(store, { now: start + 30 * MINUTE });
  assert.equal(result.meta.basis, 'read-only-learning-replay');
  assert.equal(result.meta.replayedRecords, 2);
  for (const [key, field] of Object.entries(coefficientFields)) {
    const points = values(result, key);
    assert(points.length > 0);
    assert.equal(points[0].x, start, 'The visible range starts with the earlier replayed model');
    assert(points.every(point => point.y === checkpoint.model.parameters[field]));
    assert(points.every(point => point.x <= start + 30 * MINUTE));
    assert(points.every(point => point.modelCoefficient === true && point.algorithmVersion === LEARNING_ALGORITHM));
  }
  assert(!JSON.stringify(result).includes('invented-'));
  assert.deepEqual(databaseSnapshot(store), before);
});

test('independent input journals and imported fallback never share a replay checkpoint', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  context(store, start, { input: 'history', model: model(0.011) });
  context(store, start + 10 * MINUTE, { input: 'providers', config: { thermalPriors: { lossPerHour: 0.03 } } });
  context(store, start + 20 * MINUTE, { input: 'history', model: model(0.09) });
  context(store, start, { input: 'mqtt', model: model(0.05) });
  context(store, start, { input: 'simulated', model: model(0.07) });

  const provider = values(project(store));
  assert(provider.some(point => point.y === 0.011 && point.inputSource === 'Imported history'));
  assert(provider.some(point => point.y === 0.03 && point.inputSource === 'Recorded provider inputs'));
  assert(provider.filter(point => point.x >= start + 10 * MINUTE).every(point => point.y === 0.03));
  assert(!provider.some(point => [0.05, 0.07, 0.09].includes(point.y)));
  const mqtt = values(project(store, { input: 'mqtt' }));
  assert(mqtt.length > 0 && mqtt.every(point => point.y === 0.05 && point.inputSource === 'Recorded MQTT inputs'));
  const simulated = values(project(store, { input: 'simulated' }));
  assert(simulated.length > 0 && simulated.every(point => point.y === 0.07 && point.inputSource === 'Simulation'));
  const history = values(project(store, { input: 'offline' }));
  assert.deepEqual([...new Set(history.map(point => point.y))], [0.011, 0.09]);
  assert(history.every(point => point.inputSource === 'Imported history'));
});

test('the five coefficient selections preserve zero and expose no fixed structural coefficients', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  context(store, start, { model: model(0.025, { solarCPerHourPerKwM2: 0 }) });
  assert.deepEqual(Object.keys(MODEL_COEFFICIENT_INFO).sort(), Object.keys(coefficientFields).sort());
  store.db.exec('PRAGMA query_only = ON');
  for (const key of Object.keys(coefficientFields)) {
    const chart = getChartData({ store, input: 'providers', startDate: '2026-09-08',
      now: start + 60 * MINUTE, left: key });
    assert(chart.series[key].some(point => Number.isFinite(point.y)));
    assert.equal(chart.meta.modelCoefficients.basis, 'read-only-learning-replay');
    assert(!Object.hasOwn(chart.series, 'memoryExchangePerHour'));
    assert(!Object.hasOwn(chart.series, 'reserveTimeHours'));
    if (key === 'model_coefficient_solar_response')
      assert(chart.series[key].filter(point => point.y !== null).every(point => point.y === 0));
  }
});

test('a rejected refit retains learned coefficients while unfitted coefficients remain marked initial', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const seed = restoreAdaptiveCheckpoint(null);
  seed.model.parameters.lossPerHour = 0.03;
  seed.model.trainedAt = new Date(start - 60 * MINUTE).toISOString();
  seed.model.validation = { accepted: true, fittedParameters: ['lossPerHour', 'normalHeatCPerHour'],
    parameterEvidence: { lossPerHour: { status: 'identified' }, normalHeatCPerHour: { status: 'identified' } } };
  seed.health = { status: 'learning', acceptedFits: 1, rejectedFits: 0 };
  seed.sinceFit = 11;
  context(store, start, { seed });
  appendLearningRecord(store, 'providers', 'sample', { timestamp: start + 15 * MINUTE,
    indoorC: 21, outdoorC: 5, phase: 'normal', regime: 'occupied', quality: [],
    compressorDuty: 0.5, auxKw: 0, solarRadiationWm2: 0 });
  let expected = null;
  for (const entry of store.learningJournal({ input: 'providers' })) expected = applyLearningRecord(expected, entry);
  assert.equal(expected.health.status, 'retained-previous');
  const result = project(store);
  const heatLoss = values(result);
  assert(heatLoss.some(point => point.x < start + 15 * MINUTE && point.coefficientStatus === 'fitted'));
  assert(heatLoss.some(point => point.x >= start + 15 * MINUTE && point.coefficientStatus === 'retained'));
  assert(heatLoss.every(point => point.y === expected.model.parameters.lossPerHour));
  assert(values(result, 'model_coefficient_solar_response').every(point => point.coefficientStatus === 'initial'));
  assert(values(result, 'model_coefficient_auxiliary_response').every(point => point.coefficientStatus === 'initial'));
});

test('an auxiliary rating change labels the reset gain initial despite stale model validation', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const seed = restoreAdaptiveCheckpoint(null);
  seed.model.parameters.auxiliaryCPerKwh = 0.33;
  seed.model.trainedAt = new Date(start - 60 * MINUTE).toISOString();
  seed.model.validation = { accepted: true, fittedParameters: ['auxiliaryCPerKwh'],
    parameterEvidence: { auxiliaryCPerKwh: { status: 'identified' } } };
  seed.health = { status: 'learning', acceptedFits: 1, rejectedFits: 0 };
  context(store, start, { seed, config: { auxRatedKw: 9 } });
  context(store, start + 20 * MINUTE, { config: { auxRatedKw: 12 } });
  context(store, start + 40 * MINUTE, { config: { auxRatedKw: 12 } });
  const points = values(project(store), 'model_coefficient_auxiliary_response');
  assert(points.some(point => point.x < start + 20 * MINUTE && point.y === 0.33 && point.coefficientStatus === 'fitted'));
  assert(points.some(point => point.x === start + 20 * MINUTE && point.y === 0.15));
  assert(points.filter(point => point.x >= start + 20 * MINUTE)
    .every(point => point.y === 0.15 && point.coefficientStatus === 'initial'));
});

test('the first recorded seed can reset an older auxiliary rating without retaining fitted status', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const seed = restoreAdaptiveCheckpoint(null);
  seed.learningConfiguration = learningConfiguration({ auxRatedKw: 9 });
  seed.model.parameters.auxiliaryCPerKwh = 0.33;
  seed.model.trainedAt = new Date(start - 60 * MINUTE).toISOString();
  seed.model.validation = { accepted: true, fittedParameters: ['auxiliaryCPerKwh'],
    parameterEvidence: { auxiliaryCPerKwh: { status: 'identified' } } };
  seed.health = { status: 'learning', acceptedFits: 1, rejectedFits: 0 };
  context(store, start, { seed, config: { auxRatedKw: 12 } });
  const points = values(project(store), 'model_coefficient_auxiliary_response');
  assert(points.length > 0);
  assert(points.every(point => point.y === 0.15 && point.coefficientStatus === 'initial'));
});

test('a missing first journal seed leaves a gap and blocks its dependent tail', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const configuration = learningConfiguration({});
  store.appendLearningJournal('providers', { kind: 'context', at: start,
    algorithmVersion: LEARNING_ALGORITHM, configVersion: learningVersion(configuration),
    payload: { value: { timestamp: start }, configuration } });
  const first = project(store);
  assert.equal(first.meta.invalidRecords, 1);
  assert.equal(values(first).length, 0);
  context(store, start + 20 * MINUTE, { model: model(0.06) });
  const continued = project(store);
  assert.equal(continued.meta.invalidRecords, 1);
  assert.equal(continued.meta.replayedRecords, 0);
  assert.equal(values(continued).length, 0);
  assert(continued.series.model_coefficient_heat_loss.some(point => point.y === null));
});

test('unsupported algorithm records break coefficient continuity and produce only generic browser warnings', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  context(store, start, { model: model(0.025) });
  store.appendLearningJournal('providers', { kind: 'context', at: start + 20 * MINUTE,
    algorithmVersion: 'invented-unsupported-implementation',
    payload: { value: { timestamp: start + 20 * MINUTE },
      privateFixture: 'invented-journal-marker-not-for-browser' } });
  // Applying the current implementation after an unknown transition must not fill the gap.
  context(store, start + 30 * MINUTE, { model: model(0.09) });
  const result = project(store);
  assert.equal(result.meta.unsupportedRecords, 1);
  assert(values(result).some(point => point.y === 0.025));
  assert(values(result).every(point => point.x < start + 20 * MINUTE));
  assert(result.series.model_coefficient_heat_loss.some(point => point.y === null && point.x >= start + 20 * MINUTE));
  const chart = getChartData({ store, input: 'providers', startDate: '2026-09-08',
    now: start + 60 * MINUTE, left: 'model_coefficient_heat_loss' });
  assert(chart.meta.warnings.some(warning => /coefficient|replay/i.test(warning)));
  assert(!JSON.stringify(chart).includes('invented-'));
});

test('a mismatched saved configuration leaves a gap without leaking its payload or error details', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  context(store, start, { model: model(0.025) });
  store.appendLearningJournal('providers', { kind: 'context', at: start + 20 * MINUTE,
    algorithmVersion: LEARNING_ALGORITHM, configVersion: 'invented-invalid-configuration-digest',
    payload: { value: { timestamp: start + 20 * MINUTE },
      configuration: { privateFixture: 'invented-invalid-payload-not-for-browser' } } });
  context(store, start + 30 * MINUTE, { model: model(0.09) });
  store.db.exec('PRAGMA query_only = ON');
  const result = project(store);
  assert.equal(result.meta.invalidRecords, 1);
  assert(values(result).some(point => point.y === 0.025));
  assert(values(result).every(point => point.x < start + 20 * MINUTE));
  const chart = getChartData({ store, input: 'providers', startDate: '2026-09-08',
    now: start + 60 * MINUTE, left: 'model_coefficient_heat_loss' });
  assert(chart.meta.warnings.some(warning => /coefficient|replay/i.test(warning)));
  assert(!JSON.stringify(chart).includes('invented-'));
});

test('late journal records take effect in ingestion order without backdating a coefficient change', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  context(store, start, { model: model(0.025) });
  context(store, start + 30 * MINUTE, { model: model(0.04) });
  context(store, start + 10 * MINUTE, { model: model(0.06) });
  const result = project(store);
  const points = values(result);
  assert(points.some(point => point.x >= start + 30 * MINUTE && point.y === 0.06));
  assert(points.filter(point => point.x < start + 30 * MINUTE).every(point => point.y === 0.025));
  assert(points.filter(point => point.x >= start + 30 * MINUTE).every(point => point.y === 0.06));
});

test('a future journal entry stops replay before later ingested entries with older timestamps', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  context(store, start, { model: model(0.025) });
  context(store, start + 90 * MINUTE, { model: model(0.09) });
  context(store, start + 20 * MINUTE, { model: model(0.07) });
  const points = values(project(store));
  assert(points.length > 0 && points.every(point => point.y === 0.025));
});

test('an explicit recorded seed resumes a supported replay after an unsupported segment', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  context(store, start, { model: model(0.025) });
  store.appendLearningJournal('providers', { kind: 'context', at: start + 10 * MINUTE,
    algorithmVersion: 'invented-unsupported-implementation', payload: { value: { timestamp: start + 10 * MINUTE } } });
  const configuration = learningConfiguration({});
  const seed = restoreAdaptiveCheckpoint(null);
  seed.model = model(0.06);
  store.appendLearningJournal('providers', { kind: 'context', at: start + 30 * MINUTE,
    algorithmVersion: LEARNING_ALGORITHM, configVersion: learningVersion(configuration),
    payload: { value: { timestamp: start + 30 * MINUTE }, configuration, seed } });
  const result = project(store), points = values(result);
  assert(points.some(point => point.y === 0.025 && point.x < start + 10 * MINUTE));
  assert(points.some(point => point.y === 0.06 && point.x >= start + 30 * MINUTE));
  assert(points.every(point => point.x < start + 10 * MINUTE || point.x >= start + 30 * MINUTE));
});

test('an unsupported primary journal ends imported fallback at the source boundary', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  context(store, start, { input: 'history', model: model(0.025) });
  context(store, start + 30 * MINUTE, { input: 'history', model: model(0.09) });
  store.appendLearningJournal('providers', { kind: 'context', at: start + 20 * MINUTE,
    algorithmVersion: 'invented-unsupported-implementation', payload: { value: { timestamp: start + 20 * MINUTE } } });
  const result = project(store);
  assert(values(result).length > 0);
  assert(values(result).every(point => point.y === 0.025 && point.x < start + 20 * MINUTE));
  assert(result.series.model_coefficient_heat_loss.some(point => point.x === start + 20 * MINUTE && point.y === null));
  const afterHandover = project(store, { from: start + 20 * MINUTE });
  assert.equal(values(afterHandover).length, 0, 'A view starting at the handover cannot recover imported fallback');
});

test('a view starting at a coefficient change contains only the new model from that boundary', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  context(store, start, { model: model(0.025) });
  context(store, start + 20 * MINUTE, { model: model(0.06) });
  const result = project(store, { from: start + 20 * MINUTE });
  assert.equal(result.series.model_coefficient_heat_loss[0].x, start + 20 * MINUTE);
  assert(values(result).every(point => point.y === 0.06));
});

test('a real sample refit reconstructs the same changed coefficients as the ordered learner', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const hour = 60 * MINUTE, begin = start - 14 * 24 * hour;
  // This synthetic trajectory exercises replay and fitting together. It makes
  // no claim about physical accuracy or calibration of an installed building.
  const generator = initialAdaptiveModel({ thermalPriors: { lossPerHour: 0.03, normalHeatCPerHour: 1.2 } });
  let state = { indoorC: 21, reserveC: 21 };
  const samples = [];
  for (let i = 0; i <= 336; i++) {
    const inputs = { outdoorC: 7 + 5 * Math.sin(i / 24), compressorDuty: 0.4 + 0.2 * Math.sin(i / 5),
      auxKw: 0, solarRadiationWm2: 0, phase: 'normal', targetC: 21, roomBoostC: 0 };
    if (i) state = predictThermalStep(generator, state, inputs, 1);
    samples.push({ timestamp: begin + i * hour, indoorC: state.indoorC, ...inputs,
      regime: 'occupied', quality: [], windowStart: begin + (i - 1) * hour,
      intervalInputs: inputs, actualModeKnown: true });
  }
  const seed = restoreAdaptiveCheckpoint(null);
  seed.samples = samples.slice(0, -1); seed.cursor = samples.at(-2).timestamp;
  seed.sinceFit = 11; seed.baselineC = 21;
  context(store, start - hour, { seed });
  appendLearningRecord(store, 'providers', 'sample', samples.at(-1));
  let expected = null;
  for (const entry of store.learningJournal({ input: 'providers' })) expected = applyLearningRecord(expected, entry);
  assert.equal(expected.health.acceptedFits, 1);
  for (const parameter of ['lossPerHour', 'normalHeatCPerHour'])
    assert.notEqual(expected.model.parameters[parameter], seed.model.parameters[parameter]);
  const before = databaseSnapshot(store);
  store.db.exec('PRAGMA query_only = ON');
  const result = project(store, { from: start - hour });
  for (const [key, parameter] of Object.entries(coefficientFields)) {
    const points = values(result, key);
    assert(points.filter(point => point.x < start).every(point => point.y === seed.model.parameters[parameter]));
    assert(points.some(point => point.x >= start && point.y === expected.model.parameters[parameter]));
    assert(points.filter(point => point.x >= start).every(point => point.y === expected.model.parameters[parameter]));
  }
  assert(values(result).some(point => point.x >= start && point.coefficientStatus === 'fitted'));
  assert.deepEqual(databaseSnapshot(store), before);
});

test('the file-backed chart worker invalidates cached coefficients for new journal entries without database writes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-coefficient-chart-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  const service = createChartService({ store });
  t.after(async () => {
    await service.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  context(store, start, { model: model(0.025) });
  store.setState('adaptive:providers', { model: model(0.11) });
  const args = { input: 'providers', startDate: '2026-09-08', now: start + 60 * MINUTE,
    left: 'model_coefficient_heat_loss' };
  const initialSnapshot = databaseSnapshot(store);
  const initial = await service.query(args);
  assert(values(initial).every(point => point.y === 0.025));
  assert.equal((await service.query(args)).meta.cacheHit, true);
  assert.deepEqual(databaseSnapshot(store), initialSnapshot);
  context(store, start + 20 * MINUTE, { model: model(0.06) });
  const appendedSnapshot = databaseSnapshot(store);
  const changed = await service.query(args);
  assert.notEqual(changed.meta.cacheHit, true);
  assert(values(changed).some(point => point.y === 0.06));
  assert(values(changed).filter(point => point.x >= start + 20 * MINUTE).every(point => point.y === 0.06));
  assert.equal((await service.query(args)).meta.cacheHit, true);
  assert.deepEqual(databaseSnapshot(store), appendedSnapshot);
});

test('cached replay resumes only new effective-prefix rows and matches fresh connections across clock changes', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-coefficient-replay-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let readRows = 0;
  const counted = { db: { prepare(sql) {
    const statement = store.db.prepare(sql);
    if (!/^SELECT \* FROM learning_journal\b/i.test(sql)) return statement;
    return { *iterate(...args) {
      for (const row of statement.iterate(...args)) { readRows++; yield row; }
    } };
  } } };
  const compareFresh = now => {
    const args = { to: start + 120 * MINUTE, now };
    const result = project(counted, args);
    const db = new DatabaseSync(store.path, { readOnly: true });
    try { assert.deepEqual(result, project({ db }, args)); } finally { db.close(); }
    return result;
  };
  const seed = restoreAdaptiveCheckpoint(null);
  seed.model.parameters.lossPerHour = 0.03;
  seed.model.trainedAt = new Date(start - 60 * MINUTE).toISOString();
  seed.model.validation = { accepted: true, fittedParameters: ['lossPerHour'],
    parameterEvidence: { lossPerHour: { status: 'identified' } } };
  seed.health = { status: 'learning', acceptedFits: 1, rejectedFits: 0 };
  seed.sinceFit = 11;
  context(store, start, { seed });
  compareFresh(start + 10 * MINUTE);
  assert.equal(readRows, 1);
  compareFresh(start + 10 * MINUTE + 1);
  assert.equal(readRows, 1, 'Moving the clock does not replay an unchanged prefix');

  appendLearningRecord(store, 'providers', 'sample', { timestamp: start + 15 * MINUTE,
    indoorC: 21, outdoorC: 5, phase: 'normal', regime: 'occupied', quality: [],
    compressorDuty: 0.5, auxKw: 0, solarRadiationWm2: 0 });
  const rejected = compareFresh(start + 20 * MINUTE);
  assert.equal(readRows, 2, 'The new sample resumes the cached checkpoint');
  assert(values(rejected).some(point => point.x >= start + 15 * MINUTE && point.coefficientStatus === 'retained'));
  context(store, start + 25 * MINUTE, { model: model(0.06) });
  const changed = compareFresh(start + 30 * MINUTE);
  assert.equal(readRows, 3);
  assert(values(changed).some(point => point.y === 0.06));

  context(store, start + 90 * MINUTE, { model: model(0.09) });
  context(store, start + 20 * MINUTE, { model: model(0.07) });
  const beforeFuture = compareFresh(start + 30 * MINUTE + 1);
  assert.equal(readRows, 3, 'A future entry blocks the later ingested older timestamp without replaying the prefix');
  assert(!values(beforeFuture).some(point => point.y === 0.07 || point.y === 0.09));
  const afterFuture = compareFresh(start + 100 * MINUTE);
  assert.equal(readRows, 5, 'Both newly available rows are replayed once');
  assert(values(afterFuture).some(point => point.x >= start + 90 * MINUTE && point.y === 0.07));
  compareFresh(start + 40 * MINUTE);
  assert.equal(readRows, 5, 'The earlier cached prefix remains intact after an incremental extension');
});

test('sensor reversal rebuilds a cached earlier coefficient prefix and later records resume the corrected model', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let readRows = 0;
  const counted = { db: { prepare(sql) {
    const statement = store.db.prepare(sql);
    if (!/^SELECT \* FROM learning_journal\b/i.test(sql)) return statement;
    return { *iterate(...args) {
      for (const row of statement.iterate(...args)) { readRows++; yield row; }
    } };
  } } };
  const seed = restoreAdaptiveCheckpoint(null);
  seed.model.parameters.lossPerHour = 0.03;
  seed.model.trainedAt = new Date(start - 60 * MINUTE).toISOString();
  seed.model.validation = { accepted: true, fittedParameters: ['lossPerHour'],
    parameterEvidence: { lossPerHour: { status: 'identified' } } };
  seed.health = { status: 'learning', acceptedFits: 1, rejectedFits: 0 };
  context(store, start, { seed });
  const change = addSensorChange(store, 'providers', { signal: 'indoor_temperature', reason: 'replacement',
    requestId: 'coefficient-reset' }, start + 20 * MINUTE);
  const args = { now: start + 30 * MINUTE };
  const original = project(counted, args);
  assert(values(original).some(point => point.x >= change.at && point.coefficientStatus === 'retained'));
  assert.equal(readRows, 2);
  assert.deepEqual(project(counted, args), original);
  assert.equal(readRows, 2, 'An unchanged journal prefix reuses its cache');

  revertSensorChange(store, 'providers', { id: change.id, requestId: 'coefficient-revert' }, start + 45 * MINUTE);
  const before = databaseSnapshot(store);
  const corrected = project(counted, args);
  assert.equal(readRows, 4, 'A later reversal invalidates the earlier cached prefix even though its last ID did not change');
  assert(values(corrected).every(point => point.y === 0.03 && point.coefficientStatus === 'fitted'));
  assert.deepEqual(project(counted, args), corrected);
  assert.equal(readRows, 4);
  assert.deepEqual(databaseSnapshot(store), before, 'Retrospective chart correction never writes a checkpoint or source record');

  const caughtUp = project(counted);
  assert.equal(readRows, 5, 'The reversal record extends the corrected cached prefix');
  assert(values(caughtUp).every(point => point.coefficientStatus === 'fitted'));
  context(store, start + 50 * MINUTE);
  const extended = project(counted);
  assert.equal(readRows, 6, 'Later records resume the corrected checkpoint');
  assert.deepEqual(extended, project(store), 'Incremental correction replay matches a fresh chart cache');
});

test('sensor-corrected coefficient replay keeps the previous algorithm archived before the explicit current seed', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const configuration = learningConfiguration({});
  store.appendLearningJournal('providers', { kind: 'context', at: start - 15 * MINUTE,
    algorithmVersion: 'committed-house-v8-report-coverage', configVersion: learningVersion(configuration),
    payload: { value: { timestamp: start - 15 * MINUTE }, configuration, seed: restoreAdaptiveCheckpoint(null) } });
  const seed = restoreAdaptiveCheckpoint(null);
  seed.model.parameters.lossPerHour = 0.04;
  seed.model.trainedAt = new Date(start - 5 * MINUTE).toISOString();
  seed.model.validation = { accepted: true, fittedParameters: ['lossPerHour'] };
  seed.health = { status: 'learning', acceptedFits: 1, rejectedFits: 0 };
  context(store, start, { seed });
  const change = addSensorChange(store, 'providers', { signal: 'outdoor_temperature', reason: 'calibration',
    requestId: 'archival-coefficient-reset' }, start + 20 * MINUTE);
  revertSensorChange(store, 'providers', { id: change.id, requestId: 'archival-coefficient-revert' }, start + 30 * MINUTE);
  const result = project(store, { from: start - 15 * MINUTE });
  assert.equal(result.meta.unsupportedRecords, 1);
  assert.equal(result.meta.replayedRecords, 3);
  assert(values(result).every(point => point.x >= start && point.y === 0.04 && point.coefficientStatus === 'fitted'));
  assert(result.series.model_coefficient_heat_loss.some(point => point.x < start && point.y === null));
});
