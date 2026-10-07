import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { restoreAdaptiveCheckpoint } from '../src/control/adaptive-learning.js';
import { addSensorChange, revertSensorChange, sensorChangesView } from '../src/app/sensor-changes.js';
import { sensorBoundaries, sensorLearningContext } from '../src/app/sensor-inputs.js';
import { originalSensorSample } from '../src/app/sensor-samples.js';
import { applyLearningRecord, committedLearningSample, recordLearningContext,
  replayLearningJournal, LEARNING_ALGORITHM} from '../src/app/committed-learning.js';
import { appendLearningRecord, currentComfortReference } from './helpers/home-learning-fixture.js';

const start = Date.parse('2026-09-13T00:00:00Z'), M = 60_000, W = 15 * M;
const config = { indoorSensorWeights: { indoor_temperature: 1, bedroom_temperature: 1 } };
function setup(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const seed = restoreAdaptiveCheckpoint(null, config);
  seed.model.parameters.lossPerHour = 0.026;
  seed.model.parameters.fireplaceCPerKg = 0.32;
  seed.model.energy.recoveryMultiplier = 1.12;
  seed.model.energy.episodes = 9;
  seed.baselineC = 21;
  seed.comfortReference = currentComfortReference(21, start - W);
  seed.state = { indoorC: 21, reserveC: 22, observedAt: new Date(start - W).toISOString() };
  recordLearningContext(store, 'mqtt', { phase: 'normal', regime: 'occupied', roomBoostC: 0, targetC: 21 }, start, { config, seed });
  return store;
}
function observation(store, signal, value, at, extra = {}) {
  store.observation({ source: signal === 'outdoor_temperature' ? 'fmi' : 'mqtt-temperature',
    device: `invented-${signal}`, signal, value, unit: signal.endsWith('temperature') ? 'degC' : 'state',
    sourceTime: at, receivedAt: at, quality: [], ...extra });
}
function window(store, at, { indoor = true, periodic = false } = {}) {
  for (let point = at - W; point <= at; point += 5 * M) {
    if (indoor) for (const [signal, value] of [['indoor_temperature', 22], ['bedroom_temperature', 20]])
      observation(store, signal, value, point, periodic ? { raw: { reportIntervalMs: 15 * M, reportGraceMs: 2 * M } } : {});
    for (const [signal, value] of [['outdoor_temperature', 5], ['compressor_active', 1],
      ['dhw_routing', 0], ['auxiliary_output', 0], ['alarm_active', 0], ['operating_mode', 1]]) observation(store, signal, value, point);
  }
}
function saveSample(store, at, options = {}) {
  const sample = committedLearningSample({ store, input: 'mqtt', at, config, ...options });
  appendLearningRecord(store, 'mqtt', 'sample', sample, { config });
  return sample;
}
const change = (store, at, signal = 'bedroom_temperature', requestId = 'invented-change') =>
  addSensorChange(store, 'mqtt', { signal, reason: 'replacement', requestId }, at, { config });
const revert = (store, id, at = start + 8 * W, requestId = 'invented-revert') =>
  revertSensorChange(store, 'mqtt', { id, requestId }, at, { config });

for (const signal of ['bedroom_temperature', 'outdoor_temperature']) test(`${signal}: reversal recovers settling measurements and retained knowledge from immutable inputs`, t => {
  const store = setup(t);
  window(store, start + W); saveSample(store, start + W);
  const reset = change(store, start + W, signal);
  for (const index of [2, 3, 4, 5]) { window(store, start + index * W); saveSample(store, start + index * W); }
  const resetModel = replayLearningJournal(store, 'mqtt');
  assert.equal(resetModel.baselineC, 21);
  assert.equal(resetModel.model.energy.episodes, 9);
  assert.equal(resetModel.samples.length, 5);
  assert.equal(resetModel.comfortReference.targetC, 21);
  assert.equal(Object.hasOwn(resetModel, 'sensorComfortReferences'), false);
  const before = structuredClone(store.learningJournal({ input: 'mqtt' }));
  const raw = structuredClone(store.observations());
  const excluded = before.filter(row => row.kind === 'sample' && [start + 2 * W, start + 3 * W].includes(row.at));
  assert(excluded.every(row => row.payload.value.indoorC === (signal === 'outdoor_temperature' ? 21 : null)));
  assert(excluded.every(row => row.payload.value.indoorSensors.indoor_temperature.value === 22));
  assert(excluded.every(row => originalSensorSample(row.payload.value).indoorC === 21));
  if (signal === 'outdoor_temperature') assert(excluded.every(row => originalSensorSample(row.payload.value).outdoorC === 5));
  revert(store, reset.id);
  const corrected = replayLearningJournal(store, 'mqtt', null, { rebuild: true });
  // Independently replay the original neutral samples with no reset entry.
  let expected = null;
  for (const entry of before) if (!entry.payload.value.sensorChange)
    expected = applyLearningRecord(expected, { ...entry, payload: { ...entry.payload,
      value: entry.kind === 'sample' ? originalSensorSample(entry.payload.value) : entry.payload.value } });
  for (const key of ['model', 'state', 'samples', 'baselineC', 'comfortReference', 'comfortLearning', 'sinceFit'])
    assert.deepEqual(corrected[key], expected[key], key);
  assert.equal(corrected.samples.length, 5);
  assert.equal(corrected.baselineC, 21);
  assert.equal(corrected.model.energy.episodes, 9);
  assert.equal(corrected.measurementEpochAt, undefined);
  assert.deepEqual(store.learningJournal({ input: 'mqtt' }).slice(0, before.length), before);
  assert.deepEqual(store.observations(), raw);
  // Replay is deliberately independent of source acquisition/coverage queries.
  const onlyJournal = { db: store.db, learningJournal: store.learningJournal.bind(store),
    getState: store.getState.bind(store), setState: store.setState.bind(store) };
  assert.deepEqual(replayLearningJournal(onlyJournal, 'mqtt', null, { rebuild: true }), corrected);
});

test('reverting one change keeps a later real boundary, then reverting it restores held pre-change readings', t => {
  const store = setup(t); window(store, start + W); saveSample(store, start + W);
  const first = change(store, start + W), second = change(store, start + 2 * W, 'indoor_temperature', 'invented-second');
  window(store, start + 5 * W, { indoor: false });
  assert.equal(saveSample(store, start + 5 * W).indoorC, null);
  revert(store, first.id);
  assert.deepEqual(sensorBoundaries(store, 'mqtt', start + 8 * W), { indoor_temperature: second.at });
  let cp = replayLearningJournal(store, 'mqtt', null, { rebuild: true });
  assert.equal(cp.sensorEpochs.indoor_temperature, second.at);
  assert.equal(cp.samples.at(-1).valid, false);
  revert(store, second.id, start + 9 * W, 'invented-revert-second');
  cp = replayLearningJournal(store, 'mqtt', null, { rebuild: true });
  assert.equal(cp.samples.at(-1).indoorC, 21);
  assert.equal(cp.measurementEpochAt, undefined);
  assert.deepEqual(sensorBoundaries(store, 'mqtt', start + 9 * W), {});
});

test('undo restores valid periodic reports but never fills a genuine reporting gap', t => {
  const store = setup(t); window(store, start + W, { periodic: true }); saveSample(store, start + W);
  const reset = change(store, start + W);
  window(store, start + 2 * W, { periodic: true }); saveSample(store, start + 2 * W);
  // No reports for an hour, then recovery at the endpoint: the window remains incomplete.
  window(store, start + 6 * W, { indoor: false });
  for (const [signal, value] of [['indoor_temperature', 22], ['bedroom_temperature', 20]])
    observation(store, signal, value, start + 6 * W, { raw: { reportIntervalMs: 15 * M, reportGraceMs: 2 * M } });
  saveSample(store, start + 6 * W);
  revert(store, reset.id);
  const cp = replayLearningJournal(store, 'mqtt', null, { rebuild: true });
  assert.equal(cp.samples.find(row => Date.parse(row.timestamp) === start + 2 * W).indoorC, 21);
  assert.equal(cp.samples.at(-1).valid, false);
  assert.equal(cp.samples.at(-1).indoorSensors.bedroom_temperature.reportCoverageComplete, false);
});

test('correction retries are idempotent and source-scoped, and unsupported algorithms cannot enter the journal', t => {
  const store = setup(t), reset = change(store, start + W);
  const first = revert(store, reset.id), same = revert(store, reset.id, start + 9 * W);
  const secondRequest = revert(store, reset.id, start + 9 * W, 'invented-another-request');
  assert.equal(same.revision, first.revision); assert.equal(same.revertedAt, first.revertedAt);
  assert.equal(secondRequest.revision, first.revision);
  assert.deepEqual(sensorLearningContext(store, 'mqtt', 0).revertedSensorChanges, []);
  assert.deepEqual(sensorLearningContext(store, 'mqtt').revertedSensorChanges, [reset.id]);
  assert.throws(() => revertSensorChange(store, 'providers', { id: reset.id, requestId: 'invented-wrong-stream' }, start + 9 * W), TypeError);
  const another = change(store, start + 9 * W, 'indoor_temperature', 'invented-third');
  assert.throws(() => revert(store, another.id), error => error.statusCode === 409);
  for (const payload of [{ id: reset.id, requestId: 'invented-private', notes: 'invented-note' }, { id: -1, requestId: 'invented-invalid' }])
    assert.throws(() => revertSensorChange(store, 'mqtt', payload, start + 10 * W), TypeError);
  const before = store.learningJournal({ input: 'mqtt' });
  assert.throws(() => store.appendLearningJournal('mqtt', { kind: 'context', at: start - W, key: 'invented-foreign-change',
    algorithmVersion: 'invented-unsupported-algorithm', payload: { configuration: config,
      value: { sensorChange: { signal: 'bedroom_temperature', reason: 'replacement', requestId: 'invented-old-change' } } } }),
  /Unsupported Home learning journal algorithm/);
  assert.deepEqual(store.learningJournal({ input: 'mqtt' }), before);
  const view = sensorChangesView(store, 'mqtt', { now: start + 10 * W, config });
  assert.equal(view.events.find(row => row.id === reset.id).revertedAt, first.revertedAt);
  assert.equal(LEARNING_ALGORITHM, 'committed-house-v16-observed-input-admission');
});
