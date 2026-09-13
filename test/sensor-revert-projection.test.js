import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { addSensorChange } from '../src/app/sensor-changes.js';
import { withSensorMeasurements } from '../src/app/sensor-samples.js';
import { committedLearningSample, recordLearningContext, appendLearningRecord, applyLearningRecord,
  replayLearningJournal } from '../src/app/committed-learning.js';

const MINUTE = 60_000, start = Date.parse('2026-09-13T12:00:00Z');

test('unaffected temperature projection preserves exact aggregates across finer equipment segments', () => {
  const sample = { sensorInputVersion: 1, windowStart: start, windowEnd: start + 7, indoorC: 21,
    indoorSensors: { indoor_temperature: { value: 21, weight: 1, observedAt: start + 7 } },
    outdoorC: 10.3, quality: [], intervalInputs: { outdoorC: 10.3 },
    inputSegments: [{ start, end: start + 2, outdoorC: 10.3, quality: [] },
      { start: start + 2, end: start + 7, outdoorC: 10.3, quality: [] }] };
  // Resumming 10.3 over lengths 2 and 5 would produce 10.299999999999999.
  // A reset-free sample must keep its committed aggregate without a patch.
  const neutral = withSensorMeasurements(sample);
  assert.equal(neutral.outdoorC, 10.3);
  assert.equal(neutral.intervalInputs.outdoorC, 10.3);
  assert.equal(Object.hasOwn(neutral, 'measurementInputs'), false);
  const excluded = withSensorMeasurements(sample, { measurementEpochAt: start });
  assert.equal(excluded.indoorC, null);
  assert.ok(excluded.measurementInputs);
  const recovered = withSensorMeasurements(JSON.parse(JSON.stringify(excluded)));
  assert.deepEqual(recovered, neutral, 'Removing the reset restores the exact original aggregate');
});

test('disabling periodic reporting inside a post-reset window survives journal serialization without a false coverage gap', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store);
  recordLearningContext(store, 'providers', { phase: 'normal', regime: 'occupied', targetC: 21, roomBoostC: 0 }, start);
  addSensorChange(store, 'providers', { signal: 'indoor_temperature', reason: 'replacement',
    requestId: 'invented-serialization-reset' }, start);
  const report = (minute, periodic = true) => recorder.record({ source: 'mqtt-temperature', device: 'invented-room',
    signal: 'indoor_temperature', value: 21, unit: 'degC', sourceTime: start + minute * MINUTE,
    receivedAt: start + minute * MINUTE, quality: [],
    raw: { reportIntervalMs: periodic ? 15 * MINUTE : 0, reportGraceMs: periodic ? 2 * MINUTE : 0 } });
  for (const minute of [1, 16, 31, 46]) report(minute);
  report(52, false);
  for (const minute of [45, 50, 55, 60]) for (const [signal, value] of [
    ['outdoor_temperature', 10], ['compressor_active', 1], ['dhw_routing', 0],
    ['auxiliary_output', 0], ['alarm_active', 0], ['operating_mode', 1],
  ]) store.observation({ source: signal === 'outdoor_temperature' ? 'fmi' : 'synthetic', device: 'invented-equipment',
    signal, value, unit: signal === 'outdoor_temperature' ? 'degC' : 'state',
    sourceTime: start + minute * MINUTE, receivedAt: start + minute * MINUTE, quality: [] });
  const at = start + 60 * MINUTE;
  const sample = committedLearningSample({ store, input: 'providers', at, measurementEpochAt: start });
  assert.equal(sample.indoorC, 21);
  const indoor = sample.indoorSensors.indoor_temperature;
  assert.equal(indoor.reportCoverageComplete, true);
  assert.ok(indoor.reportIntervals.some(span => span.endpoint));
  assert.ok(indoor.reportIntervals.every(span => Number.isFinite(span.end) && span.end <= at
    && span.start >= sample.windowStart));
  const serialized = JSON.parse(JSON.stringify(sample));
  assert.deepEqual(withSensorMeasurements(serialized, { sensorEpochs: { indoor_temperature: start }, measurementEpochAt: start }), sample);
  const checkpoint = replayLearningJournal(store, 'providers');
  const id = appendLearningRecord(store, 'providers', 'sample', sample);
  const committed = store.learningJournal({ input: 'providers', after: id - 1, limit: 1 })[0];
  const originalEntry = { ...committed, payload: { ...committed.payload, value: sample } };
  const beforeSerialization = applyLearningRecord(checkpoint, originalEntry);
  const afterSerialization = applyLearningRecord(checkpoint, committed);
  assert.deepEqual(afterSerialization, beforeSerialization);
  assert.equal(afterSerialization.samples.at(-1).indoorC, 21);
});
