import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { chartRange, Envelope, getChartData } from '../src/app/chart-data.js';
import { addGarageHistory } from '../src/app/chart-garage.js';
import { appendGarageEntry, applyGarageEntry, garageCorrectionContext } from '../src/garage/learning.js';
import { garageModelSummary, GARAGE_ALGORITHM_VERSION } from '../src/garage/model.js';
import { garageSettings } from '../src/garage/settings.js';
import { GARAGE_INPUT_INFO, GARAGE_COEFFICIENT_INFO } from '../src/domain/history-series.js';

const MINUTE = 60_000, range = chartRange({ startDate: '2026-09-08' }), now = range.to;
const coefficient = 'garage_coefficient_rear_lossPerHour';
function sample(store, at, changes = {}, input = 'providers') {
  const observation = { at, rearAt: at, rearC: 8, frontAt: at, frontC: 7.5, outdoorAt: at, outdoorC: -5,
    available: true, powerKw: 0.4, powerQuality: 'provisional', ev1Kw: 0, ev2Kw: 0, ...changes };
  return appendGarageEntry(store, input, 'sample', observation, garageSettings(), at);
}
function chart(store, selected, changes = {}) {
  const envelopes = Object.fromEntries(selected.map(key => [key, new Envelope(range.from, range.to, 800)]));
  const stats = addGarageHistory({ store, range, now, input: 'providers', envelopes, ...changes });
  return { stats, series: Object.fromEntries(Object.entries(envelopes).map(([key, line]) => [key, line.values()])) };
}

test('original garage inputs keep rear-only prefixes, stale front gaps and outdoor provenance', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  sample(store, range.from, { frontAt: null, frontC: null, outdoorSource: 'fmi' });
  sample(store, range.from + MINUTE, { frontC: 7, rearC: 8, outdoorSource: 'fmi' });
  sample(store, range.from + 4 * MINUTE, { frontAt: range.from, frontC: 7 });
  sample(store, range.from + 5 * MINUTE, { powerKw: 1, powerQuality: 'raw' });
  const keys = Object.keys(GARAGE_INPUT_INFO), before = store.learningJournal({ input: 'garage:providers' });
  const result = chart(store, keys);
  assert.equal(result.series.garage_model_rear[0].y, 8);
  assert.equal(result.series.garage_model_front[0].y, null);
  assert(result.series.garage_model_front.some(point => point.x === range.from + 4 * MINUTE && point.y === null));
  assert.equal(result.series.garage_model_difference.find(point => point.x === range.from + MINUTE).y, -1);
  assert.equal(result.series.garage_model_outdoor[0].outdoorSource, 'fmi');
  assert.equal(result.series.garage_model_power.at(-1).y, null);
  assert.deepEqual(store.learningJournal({ input: 'garage:providers' }), before);
});

test('coefficient chart uses same ordered learner and seed, then incrementally extends without writes', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let checkpoint = null;
  for (let i = 0; i < 18; i++) {
    const entry = sample(store, range.from + i * MINUTE, { rearC: 8 - i * .01, frontC: 7.5 - i * .02 });
    checkpoint = applyGarageEntry(checkpoint, entry, garageCorrectionContext(store, 'providers'));
  }
  let result = chart(store, [coefficient]);
  const expected = garageModelSummary(checkpoint.model).coefficients.rear.find(row => row.name === 'lossPerHour');
  assert.equal(result.series[coefficient].at(-1).y, expected.value);
  assert.equal(result.series[coefficient][0].coefficientStatus, 'initial');
  assert.equal(result.stats.replayedRecords, 18);
  const first = structuredClone(result.series[coefficient]);
  const entry = sample(store, range.from + 18 * MINUTE, { rearC: 7.5, frontC: 7 });
  checkpoint = applyGarageEntry(checkpoint, entry, garageCorrectionContext(store, 'providers'));
  result = chart(store, [coefficient]);
  assert.equal(result.stats.replayedRecords, 19);
  assert.equal(result.series[coefficient].at(-1).y,
    garageModelSummary(checkpoint.model).coefficients.rear.find(row => row.name === 'lossPerHour').value);
  assert.deepEqual(result.series[coefficient].filter(point => point.x < range.from + 17 * MINUTE),
    first.filter(point => point.x < range.from + 17 * MINUTE));
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 0);
});

test('future journal dependencies and unknown algorithm tails cannot fill coefficient history', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  sample(store, range.from);
  sample(store, range.from + 30 * MINUTE, { rearC: 4 });
  sample(store, range.from + 10 * MINUTE, { rearC: 3 });
  let result = chart(store, [coefficient], { now: range.from + 20 * MINUTE });
  assert.equal(result.stats.replayedRecords, 1, 'Stop at first future ID, including late earlier-timestamp tails');
  store.appendLearningJournal('garage:providers', { kind: 'sample', at: range.from + 31 * MINUTE,
    algorithmVersion: 'unsupported-future-garage', payload: { value: {} } });
  sample(store, range.from + 32 * MINUTE);
  result = chart(store, [coefficient]);
  assert.equal(result.series[coefficient].at(-1).y, null);
  assert.equal(result.stats.unsupportedRecords, 1); assert.equal(result.stats.invalidRecords, 1);
});

test('all Garage input and coefficient axes are selectable without adding them to Home learning', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); sample(store, range.from);
  for (const left of ['garage_model_front', coefficient, 'garage_coefficient_native_restartKw']) {
    const result = getChartData({ store, input: 'providers', startDate: range.startDate, now, left });
    assert(result.series[left].some(point => Number.isFinite(point.y)), left);
    assert.equal(result.meta.garageHistory.invalidRecords, 0);
    assert.equal(result.meta.garageHistory.basis, 'original-garage-inputs-and-versioned-read-only-replay');
  }
  assert(Object.keys(GARAGE_COEFFICIENT_INFO).length >= 12);
  assert.equal(GARAGE_ALGORITHM_VERSION, 'committed-garage-v1-coupled');
});
