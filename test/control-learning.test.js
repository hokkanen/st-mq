import test from 'node:test';
import assert from 'node:assert/strict';
import { COMFORT_REFERENCE_POLICY, updateComfortLearning } from '../src/control/learning.js';
import { updateAdaptiveLearningBatch, restoreAdaptiveCheckpoint } from '../src/control/adaptive-learning.js';
const HOUR = 3_600_000, start = Date.parse('2026-08-01T00:00:00Z');
const iso = value => new Date(value).toISOString();
const sample = (hour, extra = {}) => ({ timestamp: iso(start + hour * HOUR), indoorC: 21,
  outdoorC: 5, phase: 'normal', regime: 'occupied', ...extra });
const run = (samples, state = null) => samples.reduce((next, row) => updateComfortLearning(next, row), state);
const series = (hours, extra = {}, from = 0) => Array.from({ length: hours + 1 }, (_, i) => sample(from + i, extra));
const verified = { verified: true, compressorActive: true, compressorDuty: 0.05, route: 'space-heating' };

test('one supported hour establishes an approximate reference without a plateau requirement', () => {
  assert.equal(run([sample(0)]).reference, null);
  const state = run([sample(0), sample(0.25, { indoorC: 20.8 }), sample(0.5, { indoorC: 21.2 }),
    sample(0.75, { indoorC: 21.4 }), sample(1, { indoorC: 21 })]);
  assert.equal(state.reference.version, 4);
  assert.equal(state.reference.evidenceHours, 1);
  assert.ok(Math.abs(state.reference.targetC - 21.1) < 1e-9);
  assert.equal(state.reference.provisional, true);
  assert.equal(state.reference.source, 'occupied-normal-temperature-average');
});

test('short missing intervals pause initialization without discarding supported time', () => {
  const state = run([sample(0), sample(0.5), sample(0.75, { quality: ['missing'] }), sample(1.25), sample(1.75)]);
  assert.equal(state.reference.targetC, 21);
  assert.equal(state.evidenceHours, 1);
  assert.equal(state.reference.establishedAt, iso(start + 1.75 * HOUR));
});

test('unchanged genuine reports earn support, cached change-only readings do not', () => {
  const cached = series(30).map(row => ({ ...row, windowStart: Date.parse(row.timestamp) - HOUR,
    indoorSensors: { bedroom_temperature: { value: 21, weight: 1, observedAt: start } } }));
  assert.equal(run(cached).reference, null);
  const reporting = cached.map(row => ({ ...row,
    indoorSensors: { bedroom_temperature: { ...row.indoorSensors.bedroom_temperature, reportCoverageComplete: true } } }));
  assert.equal(run(reporting).reference.targetC, 21);
  const refreshed = cached.map(row => ({ ...row,
    indoorSensors: { bedroom_temperature: { ...row.indoorSensors.bedroom_temperature, observedAt: row.timestamp } } }));
  assert.equal(run(refreshed).reference.targetC, 21);
});

test('long gaps retain learned temperature and progress without granting elapsed evidence', () => {
  const first = run(series(2));
  const recovered = run([sample(100, { indoorC: 19 }), sample(101, { indoorC: 19 })], first);
  assert.equal(recovered.evidenceHours, 3);
  assert.ok(recovered.reference.targetC > 20.97);
  assert.deepEqual(updateComfortLearning(first, sample(2)), first, 'Duplicate input is idempotent');
});

test('low duty heating initializes in mild weather and normal off cycles continue learning', () => {
  const samples = series(30, { outdoorC: 16 }).map((row, i) => ({ ...row,
    heating: { ...verified, compressorActive: i % 5 === 0, compressorDuty: i % 5 === 0 ? 0.01 : 0 } }));
  const state = run(samples);
  assert.equal(state.reference.targetC, 21);
  assert.equal(state.reference.evidenceHours, 30);
  assert.equal(state.reference.provisional, false);
  assert.equal(state.reference.confidence, 'observed-heating-baseline');
});

test('DHW, long verified idle periods, summer and invalid heating telemetry cannot invent demand', () => {
  for (const extra of [{ outdoorC: 18 }, { heating: { ...verified, route: 'dhw' } },
    { heating: { ...verified, compressorActive: false, compressorDuty: 0 } }])
    assert.equal(run(series(30, extra)).reference, null);
  const heated = run(series(2, { heating: verified }));
  const idle = run(series(20, { heating: { ...verified, compressorActive: false, compressorDuty: 0 } }, 3), heated);
  assert.equal(idle.reference.updatedAt, iso(start + 8 * HOUR));
  assert.equal(idle.status, 'heating-demand-unavailable');
});

test('weather inference remains provisional and later verified support refreshes unchanged references', () => {
  let state = run(series(60));
  assert.equal(state.reference.provisional, true);
  const establishedAt = state.reference.establishedAt, adjustedAt = state.reference.adjustedAt;
  state = run(series(25, { heating: verified }, 61), state);
  assert.equal(state.reference.targetC, 21);
  assert.equal(state.reference.provisional, false);
  assert.equal(state.reference.confidence, 'observed-heating-baseline');
  assert.equal(state.reference.establishedAt, establishedAt);
  assert.equal(state.reference.adjustedAt, adjustedAt);
  assert.equal(state.reference.updatedAt, iso(start + 86 * HOUR));
});

test('ordinary variation and quantized temperatures cannot create a plateau boundary rejection', () => {
  for (const offset of [0, 0.2]) {
    const state = run(series(72).map((row, hour) => ({ ...row, indoorC: 21 + offset + 0.5 * Math.sin(hour * Math.PI / 12) })));
    assert.equal(state.evidenceHours, 72);
    assert.ok(Math.abs(state.reference.targetC - 21 - offset) < 0.2);
  }
});

test('persistent household changes adapt gradually in either direction with bounded outlier influence', () => {
  for (const target of [19, 23]) {
    const first = run(series(2));
    const changed = run(series(96, { indoorC: target }, 3), first);
    assert.ok(Math.abs(changed.reference.targetC - target) < 0.6);
    assert.ok(Math.abs(changed.reference.targetC - target) > 0.1);
    const extreme = updateComfortLearning(first, sample(3, { indoorC: target < 21 ? 12 : 28 }));
    assert.ok(Math.abs(extreme.reference.targetC - 21) <= 1 / COMFORT_REFERENCE_POLICY.smoothingHours);
  }
});

test('away, fireplace and intervention temperatures never redefine the reference', () => {
  for (const excluded of [{ regime: 'away' }, { fireplaceActive: true }, { phase: 'reduction' },
    { phase: 'preheat' }, { phase: 'recovery' }, { roomBoostC: 1 },
    { inputSegments: [{ phase: 'reduction', regime: 'occupied', roomBoostC: 0 }] }]) {
    assert.equal(run(series(5, excluded)).reference, null);
    const first = run(series(2));
    const later = run(series(20, { indoorC: 19, ...excluded }, 3), first);
    assert.deepEqual(later.reference, first.reference);
  }
});

test('two hours after the last intervention remain excluded, including incomplete recovery samples', () => {
  const rows = [...series(2), sample(3, { phase: 'reduction', indoorC: 19 }),
    sample(4, { phase: 'recovery', quality: ['missing'] }), sample(5, { indoorC: 19 }),
    sample(6, { indoorC: 19 }), sample(7)];
  const state = run(rows);
  assert.equal(state.reference.targetC, 21);
  assert.equal(state.evidenceHours, 3);
  const checkpoint = updateAdaptiveLearningBatch(null, rows, { now: rows.at(-1).timestamp });
  assert.deepEqual(checkpoint.comfortReference, state.reference);
});

test('incomplete or estimated contributing rooms never update the aggregate reference', () => {
  const first = run(series(2));
  for (const sensor of [{ value: null }, { value: 21, estimated: true }, { value: 21, reportCoverageComplete: false }]) {
    const state = updateComfortLearning(first, sample(3, { indoorSensors: { bedroom_temperature: { weight: 0.5, ...sensor } } }));
    assert.deepEqual(state.reference, first.reference);
    assert.equal(state.status, 'waiting-for-observations');
  }
});

test('initial progress, subsequent learning and exclusions are independent of replay page boundaries', () => {
  const rows = [...Array.from({ length: 4 }, (_, i) => sample(i / 4)), sample(1, { quality: ['missing'] }),
    ...Array.from({ length: 100 }, (_, i) => sample(2 + i, { indoorC: 20 + Math.sin(i / 4) * 0.3,
      phase: i % 24 < 3 ? 'reduction' : 'normal' }))];
  const batch = updateAdaptiveLearningBatch(null, rows, { now: rows.at(-1).timestamp });
  let incremental = null;
  for (const row of rows) incremental = updateAdaptiveLearningBatch(incremental, [row], { now: row.timestamp });
  let paged = updateAdaptiveLearningBatch(null, rows.slice(0, 4), { now: rows[3].timestamp });
  assert.equal(paged.comfortReference, null);
  assert.equal(paged.comfortLearning.evidenceHours, 0.75);
  paged = restoreAdaptiveCheckpoint(JSON.stringify(paged));
  paged = updateAdaptiveLearningBatch(paged, rows.slice(4), { now: rows.at(-1).timestamp });
  assert.deepEqual(batch.comfortLearning, incremental.comfortLearning);
  assert.deepEqual(paged.comfortLearning, incremental.comfortLearning);
  assert.equal(Object.hasOwn(batch, 'sensorComfortReferences'), false);
});

test('obsolete room-reference and comfort formats are rejected without translating checkpoints', () => {
  const checkpoint = restoreAdaptiveCheckpoint(null);
  assert.throws(() => restoreAdaptiveCheckpoint({ ...checkpoint, sensorComfortReferences: {} }), /Unsupported Home checkpoint/);
  assert.throws(() => restoreAdaptiveCheckpoint({ ...checkpoint, comfortReference: { version: 3, targetC: 21 } }), /Unsupported Home checkpoint/);
  assert.throws(() => restoreAdaptiveCheckpoint({ ...checkpoint, comfortLearning: { version: 0 } }), /Unsupported Home checkpoint/);
});
