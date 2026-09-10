import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { indoorAverage } from '../src/domain/indoor-sensors.js';
import { addSensorChange } from '../src/app/sensor-changes.js';
import { restoreAdaptiveCheckpoint } from '../src/control/adaptive-learning.js';
import { appendLearningRecord, applyLearningRecord, committedLearningSample, recordLearningContext,
  replayLearningJournal, LEARNING_WINDOW_MS, LEARNING_ALGORITHM } from '../src/app/committed-learning.js';

const start = Date.parse('2026-01-01T00:00:00Z'), W = LEARNING_WINDOW_MS;
const config = { indoorSensorWeights: { indoor_temperature: 1, downstairs_temperature: 1, bedroom_temperature: 1 } };
function record(store, signal, value, at, extra = {}) {
  store.observation({ source: 'mqtt-temperature', device: `invented-${signal}`, signal, value,
    unit: signal.endsWith('temperature') ? 'degC' : 'state', sourceTime: at, receivedAt: at, quality: [], ...extra });
}
function window(store, at, temperatures = [24, 20, 19]) {
  for (const point of [at - W, at]) {
    for (const [i, signal] of ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature'].entries())
      if (temperatures[i] !== undefined) record(store, signal, temperatures[i], point);
    for (const [signal, value] of [['outdoor_temperature', 0], ['compressor_active', 1],
      ['dhw_routing', 0], ['auxiliary_output', 0], ['alarm_active', 0], ['operating_mode', 1]])
      record(store, signal, value, point);
  }
}
function context(store, at = start, configuration = config) {
  recordLearningContext(store, 'providers', { phase: 'normal', regime: 'occupied', roomBoostC: 0, targetC: 21 },
    at, { config: configuration });
}

test('learning keeps three endpoints and their lineage while predicting a fixed configured average', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); context(store); window(store, start + W);
  const sample = committedLearningSample({ store, input: 'providers', at: start + W, config });
  assert.equal(sample.indoorC, 21);
  assert.deepEqual(Object.values(sample.indoorSensors).map(row => row.value), [24, 20, 19]);
  for (const signal of Object.keys(config.indoorSensorWeights)) {
    assert.equal(sample.indoorSensors[signal].weight, 1 / 3);
    assert(sample.provenance.lineage[signal].observations.length > 0);
  }
  appendLearningRecord(store, 'providers', 'sample', sample, { config });
  const cp = replayLearningJournal(store, 'providers');
  assert.deepEqual(cp.samples.at(-1).indoorSensors, sample.indoorSensors);
  assert.deepEqual(replayLearningJournal(store, 'providers', null, { rebuild: true }), cp);
});

test('missing, stale and implausible room readings cannot silently change average membership', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); context(store);
  window(store, start + W, [24, 20, undefined]);
  assert.equal(committedLearningSample({ store, input: 'providers', at: start + W, config }).indoorC, null);
  record(store, 'bedroom_temperature', 19, start + W);
  assert.equal(committedLearningSample({ store, input: 'providers', at: start + W, config }).indoorC, 21);
  window(store, start + 4 * W, [24, 20, undefined]);
  assert.equal(committedLearningSample({ store, input: 'providers', at: start + 4 * W, config }).indoorC, null);
  record(store, 'bedroom_temperature', 45, start + 4 * W);
  assert.equal(committedLearningSample({ store, input: 'providers', at: start + 4 * W, config }).indoorC, null);
  const average = indoorAverage({ indoor_temperature: { value: 24, observedAt: start },
    downstairs_temperature: { value: 20, observedAt: start }, bedroom_temperature: { value: 19, observedAt: start, stale: true } }, config);
  assert.equal(average.value, 21); assert.equal(average.stale, true);
});

test('sensor changes isolate replay, settling and pre-change measurements without rewriting raw observations', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); context(store); window(store, start + W);
  appendLearningRecord(store, 'providers', 'sample', committedLearningSample({ store, input: 'providers', at: start + W, config }), { config });
  const before = replayLearningJournal(store, 'providers');
  const raw = store.db.prepare('SELECT * FROM observations ORDER BY id').all();
  addSensorChange(store, 'providers', { signal: 'bedroom_temperature', reason: 'replacement', requestId: 'invented-change' },
    start + W, { config, seed: before });
  const reset = replayLearningJournal(store, 'providers', before);
  assert.equal(reset.state, null); assert.equal(reset.baselineC, null);
  assert.equal(reset.model.validation, null); assert.deepEqual(reset.samples, []);
  assert.deepEqual(reset.model.parameters, before.model.parameters);
  for (const at of [start + 2 * W, start + 3 * W]) {
    window(store, at, [24, 20, 20]);
    const sample = committedLearningSample({ store, input: 'providers', at, config });
    assert.equal(sample.indoorC, null);
    appendLearningRecord(store, 'providers', 'sample', sample, { config });
  }
  window(store, start + 4 * W, [24, 20, 20]);
  const settled = committedLearningSample({ store, input: 'providers', at: start + 4 * W, config });
  assert(Math.abs(settled.indoorC - 64 / 3) < 1e-9);
  appendLearningRecord(store, 'providers', 'sample', settled, { config });
  const live = replayLearningJournal(store, 'providers', reset);
  assert.deepEqual(replayLearningJournal(store, 'providers', null, { rebuild: true }), live);
  assert.deepEqual(store.db.prepare('SELECT * FROM observations WHERE id<=? ORDER BY id').all(raw.at(-1).id), raw);
  assert(live.samples.filter(row => row.indoorC !== undefined).every(row => Date.parse(row.timestamp) >= start + 4 * W));
});

test('membership changes create a measurement epoch and old CSV samples keep the original single sensor', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); context(store, start, {}); window(store, start + W);
  appendLearningRecord(store, 'providers', 'sample', committedLearningSample({ store, input: 'providers', at: start + W }), {});
  let cp = replayLearningJournal(store, 'providers');
  context(store, start + 2 * W, config);
  cp = replayLearningJournal(store, 'providers', cp);
  assert.equal(cp.measurementEpochAt, start + 2 * W);
  assert.equal(cp.baselineC, null); assert.equal(cp.state, null); assert.deepEqual(cp.samples, []);
  const sample = { timestamp: start + W, indoorC: 24, outdoorC: 0, phase: 'normal', regime: 'occupied', quality: [] };
  appendLearningRecord(store, 'history', 'sample', sample, { config });
  const entry = store.learningJournal({ input: 'history' })[0];
  assert.deepEqual(entry.payload.configuration.indoorSensorWeights, { indoor_temperature: 1 });
  assert.equal(entry.payload.value.indoorC, 24);
  assert.equal(applyLearningRecord(null, entry).samples[0].indoorC, 24);
});

test('changed sensors cannot regain obsolete validation from imported upstairs-only history', async t => {
  const store = new Store(':memory:');
  const engine = new Engine({ store, config: { input: 'providers', control: config }, clock: () => start + W });
  t.after(async () => { await engine.closeFireplace(); store.close(); });
  const seed = engine.readAdaptive(start + W);
  store.setState('adaptive:history', { ...seed, algorithmVersion: LEARNING_ALGORITHM,
    model: { ...seed.model, validation: { accepted: true } }, baselineC: 24 });
  engine.changeSensor({ signal: 'bedroom_temperature', reason: 'moved', requestId: 'invented-move' });
  assert.equal(engine.checkpoint.model.validation, null);
  assert.equal(engine.checkpoint.baselineC, null);
  assert.equal(engine.checkpoint.measurementEpochAt, start + W);
  assert(engine.status().observations.indoor.stale);
});

test('a cold room blocks reductions against its own reference even when the average is comfortable', async t => {
  const store = new Store(':memory:'); let now = start + W;
  const engine = new Engine({ store, config: { input: 'providers', control: config,
    settings: { mode: 'shadow', comfort: { maxDropC: 1 } } }, clock: () => now });
  t.after(async () => { await engine.closeFireplace(); store.close(); });
  const reference = targetC => ({ version: 3, targetC, establishedAt: new Date(start - 86_400_000).toISOString(),
    updatedAt: new Date(start).toISOString(), heatingEvidence: { kind: 'verified-space-heating-activity' } });
  const seed = restoreAdaptiveCheckpoint(null, config);
  seed.baselineC = 21; seed.comfortReference = reference(21);
  seed.sensorComfortReferences = { indoor_temperature: reference(23), downstairs_temperature: reference(21), bedroom_temperature: reference(19) };
  appendLearningRecord(store, 'providers', 'context', { timestamp: start }, { config, seed });
  function readings(downstairs) {
    for (const [signal, value] of [['indoor_temperature', 24], ['downstairs_temperature', downstairs],
      ['bedroom_temperature', 20], ['outdoor_temperature', 0]]) engine.ingest({ signal, value,
      source: signal === 'outdoor_temperature' ? 'fmi' : 'mqtt-temperature', device: `invented-${signal}`,
      sourceTime: now, receivedAt: now, quality: [], unit: 'degC' });
  }
  readings(19);
  const cold = engine.tick();
  assert.equal(cold.observations.indoor.value, 21);
  assert(cold.decision.reasons.includes('room-comfort-limit'));
  now += 60_000; readings(20.5);
  assert(!engine.tick().decision.reasons.includes('room-comfort-limit'));
});
