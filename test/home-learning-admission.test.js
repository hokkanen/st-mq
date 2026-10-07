import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAdaptiveModel, updateAdaptiveLearningBatch, evaluateThermalModel } from '../src/control/adaptive-learning.js';
import { updateComfortLearning } from '../src/control/learning.js';
import { appendLearningRecord, replayLearningJournal } from '../src/app/committed-learning.js';
import { Store } from '../src/storage/store.js';

const HOUR = 3_600_000, start = Date.parse('2026-10-07T00:00:00Z');
function sample(hour, extra = {}) {
  const at = start + hour * HOUR;
  return { sensorInputVersion: 1, timestamp: at, windowStart: at - HOUR, windowEnd: at,
    indoorC: 21, outdoorC: 5, phase: 'normal', regime: 'occupied', quality: [],
    thermalCompressorDuty: 0.5, thermalAuxKw: 0, solarRadiationWm2: 0,
    indoorSensors: { indoor_temperature: { value: 21, weight: 1, observedAt: at, reportCoverageComplete: true } },
    inputSegments: [{ start: at - HOUR, end: at, outdoorC: 5, phase: 'normal', regime: 'occupied',
      thermalCompressorDuty: 0.5, thermalAuxKw: 0, solarRadiationWm2: 0, quality: [] }], ...extra };
}
const estimates = [
  row => ({ ...row, estimated: true }),
  row => ({ ...row, indoorEstimated: true }),
  row => ({ ...row, indoorSensors: { indoor_temperature: { ...row.indoorSensors.indoor_temperature, estimated: true } } }),
];

test('control estimates cannot initialize comfort, train thermal response or become an observed checkpoint state', () => {
  for (const estimate of estimates) {
    const rows = Array.from({ length: 30 }, (_, hour) => estimate(sample(hour)));
    const checkpoint = updateAdaptiveLearningBatch(null, rows, { now: rows.at(-1).timestamp });
    assert.equal(checkpoint.comfortReference, null);
    assert.equal(checkpoint.comfortLearning.evidenceHours, 0);
    assert.equal(checkpoint.health.usableSamples, 0);
    assert.equal(checkpoint.state, null);
    assert.equal(checkpoint.model.validation, null);
    assert.ok(checkpoint.samples.every(row => row.valid === false));
    const assessment = evaluateThermalModel(initialAdaptiveModel(), rows, { rollout: false });
    assert.equal(assessment.predictions.length, 0);
    assert.equal(assessment.state, null);
    const comfort = rows.reduce((state, row) => updateComfortLearning(state, row), null);
    assert.equal(comfort.reference, null);
  }
});

test('estimated indoor provenance rejects before learning-journal mutation', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const estimate of estimates)
    assert.throws(() => appendLearningRecord(store, 'mqtt', 'sample', estimate(sample(1))), /control-only/);
  assert.equal(store.learningJournal({ input: 'mqtt' }).length, 0);
});

test('an uncovered contributing report is an ordered barrier even if its endpoint value is present', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const rows = [sample(0), sample(1), sample(2, { indoorC: 25,
    indoorSensors: { indoor_temperature: { value: 25, weight: 1, observedAt: start + 2 * HOUR, reportCoverageComplete: false } } }),
  sample(3), sample(4)];
  let live = null;
  for (const row of rows) {
    appendLearningRecord(store, 'mqtt', 'sample', row);
    live = replayLearningJournal(store, 'mqtt', live);
    if (row.timestamp === start + 2 * HOUR) {
      assert.equal(live.state, null);
      assert.equal(live.samples.at(-1).valid, false);
      assert.equal(live.comfortReference.targetC, 21);
    }
  }
  assert.equal(live.health.usableSamples, 4);
  assert.equal(live.comfortReference.targetC, 21);
  assert.deepEqual(replayLearningJournal(store, 'mqtt', null, { rebuild: true }), live);
  const assessment = evaluateThermalModel(initialAdaptiveModel(), rows, { rollout: false });
  assert.deepEqual(assessment.predictions.map(row => row.timestamp), [start + HOUR, start + 4 * HOUR]);
});

test('estimates on excluded zero-weight rooms do not veto the configured observed target', () => {
  const rows = [sample(0), sample(1)].map(row => ({ ...row, indoorSensors: { ...row.indoorSensors,
    bedroom_temperature: { weight: 0, value: 24, estimated: true, reportCoverageComplete: false } } }));
  const checkpoint = updateAdaptiveLearningBatch(null, rows, { now: rows.at(-1).timestamp });
  assert.equal(checkpoint.comfortReference.targetC, 21);
  assert.equal(checkpoint.health.usableSamples, 2);
});
