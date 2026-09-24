import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { addFireplace, removeFireplace } from '../src/app/fireplace.js';
import { fireplaceLearningContext, withFireplaceInputs, fireplaceEpisodeAffected } from '../src/app/fireplace-inputs.js';
import { fireplaceIntegral } from '../src/domain/fireplace.js';

const start = Date.UTC(2026, 0, 1), HOUR = 3_600_000;

test('ignition splits preserve electrical energy and source samples while integrating delayed heat', () => {
  const sample = { timestamp: start + HOUR, windowStart: start, durationHours: 1,
    inputSegments: [{ start, end: start + HOUR, durationHours: 1,
      energyKwh: 4, hydronicHeatKwh: 4, compressorKwh: 3, spaceHeatingAuxKwh: 0.5, dhwAuxKwh: 0.5 }] };
  const original = structuredClone(sample);
  const events = [{ id: 1, at: start + HOUR / 4, kg: 8 }, { id: 2, at: start + HOUR / 2, kg: 2 }];
  const projected = withFireplaceInputs(sample, { fireplaceEvents: events, fireplaceStartedAt: start });
  assert.equal(projected.inputSegments.length, 3);
  for (const field of ['energyKwh', 'hydronicHeatKwh', 'compressorKwh', 'spaceHeatingAuxKwh', 'dhwAuxKwh'])
    assert.equal(projected.inputSegments.reduce((sum, row) => sum + row[field], 0), sample.inputSegments[0][field]);
  const released = projected.inputSegments.reduce((sum, row) => sum + row.durationHours * row.fireplaceKgPerHour, 0);
  assert.ok(Math.abs(released - fireplaceIntegral(events, start, start + HOUR)) < 1e-12);
  assert.deepEqual(sample, original);
  assert.equal(projected.fireplaceIgnitions.length, 2);
});

test('correction projection retains its logging epoch, removes heat, and can select the original revision', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const load = addFireplace(store, 'mqtt', { requestId: 'invented-projection-load', kg: 8 }, start);
  const sample = { timestamp: start + HOUR, windowStart: start, durationHours: 1 };
  const before = withFireplaceInputs(sample, fireplaceLearningContext(store, 'mqtt'));
  assert.ok(before.fireplaceKgPerHour > 0);
  removeFireplace(store, 'mqtt', { requestId: 'invented-projection-removal', id: load.id }, start + HOUR);
  const context = fireplaceLearningContext(store, 'mqtt');
  const corrected = withFireplaceInputs(before, context);
  assert.equal(corrected.fireplaceKgPerHour, 0);
  assert.equal(corrected.fireplaceActive, false);
  assert.equal(corrected.fireplaceKnown, true);
  assert.equal(corrected.fireplaceIgnitions, undefined);
  assert.deepEqual(withFireplaceInputs(sample, fireplaceLearningContext(store, 'mqtt', load.revision)), before);
  const older = { timestamp: start - HOUR, durationHours: 1 };
  assert.equal(withFireplaceInputs(older, context).fireplaceKnown, undefined, 'Unlogged historical periods remain unknown');
});

test('a correction invalidates earlier affected episodes without excluding future clean cycles', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const load = addFireplace(store, 'mqtt', { requestId: 'invented-episode-load', kg: 8 }, start);
  removeFireplace(store, 'mqtt', { requestId: 'invented-episode-removal', id: load.id }, start + HOUR);
  const context = fireplaceLearningContext(store, 'mqtt');
  assert.equal(fireplaceEpisodeAffected({ startedAt: start, endedAt: start + 2 * HOUR }, context), true);
  assert.equal(fireplaceEpisodeAffected({ startedAt: start + HOUR, endedAt: start + 3 * HOUR }, context), false);
  const immediate = addFireplace(store, 'mqtt', { requestId: 'invented-instant-load', kg: 8 }, start + 2 * HOUR);
  removeFireplace(store, 'mqtt', { requestId: 'invented-instant-removal', id: immediate.id }, start + 2 * HOUR);
  assert.equal(fireplaceEpisodeAffected({ startedAt: start + 2 * HOUR, endedAt: start + 3 * HOUR },
    fireplaceLearningContext(store, 'mqtt')), false);
});
