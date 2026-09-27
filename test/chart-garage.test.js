import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../src/storage/recorder.js';
import { Store } from '../src/storage/store.js';
import { chartRange, Envelope, getChartData } from '../src/app/chart-data.js';
import { addGarageHistory } from '../src/app/chart-garage.js';
import { appendGarageEntry, applyGarageEntry, garageCorrectionContext } from '../src/garage/learning.js';
import { createGarageModel, garageModelSummary, GARAGE_ALGORITHM_VERSION } from '../src/garage/model.js';
import { garageSettings } from '../src/garage/settings.js';
import { GARAGE_INPUT_INFO, GARAGE_COEFFICIENT_INFO } from '../src/domain/history-series.js';
import { historyStateLabel } from '../chart/history-model.js';
import { activityIntervals, activityIntervalLabel } from '../chart/chart-overlays.js';

const MINUTE = 60_000, range = chartRange({ startDate: '2026-09-08' }), now = range.to;
const coefficient = 'garage_coefficient_rear_coolingPerHour';
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

test('outdoor input uses the runtime weather deadline while protection inputs retain their shorter deadline', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  sample(store, range.from, { outdoorAt: range.from - 10 * MINUTE, rearAt: range.from - 2 * MINUTE });
  sample(store, range.from + 10 * MINUTE, { outdoorAt: range.from - 10 * MINUTE });
  sample(store, range.from + 20 * MINUTE, { outdoorAt: range.from - 10 * MINUTE });
  const result = chart(store, ['garage_model_outdoor', 'garage_model_rear']);
  assert.deepEqual(result.series.garage_model_outdoor.map(point => [point.x, point.y]), [
    [range.from, -5], [range.from + 10 * MINUTE, -5], [range.from + 20 * MINUTE, null],
  ], 'Weather remains usable until its original reading reaches 30 minutes, without false two-minute gaps');
  assert.equal(result.series.garage_model_outdoor[0].observedAt, range.from - 10 * MINUTE);
  assert.equal(result.series.garage_model_rear[0].y, null);
  assert(result.series.garage_model_rear.some(point => point.x === range.from + 1 && point.y === null));
});

test('normalized unusable or retained protection readings stay unknown in original input charts', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  sample(store, range.from, { rearUsable: false });
  sample(store, range.from + MINUTE, { frontRetained: true });
  const result = chart(store, ['garage_model_rear', 'garage_model_front', 'garage_model_difference']);
  assert.equal(result.series.garage_model_rear[0].y, null);
  assert.equal(result.series.garage_model_rear[0].inputQualified, false);
  assert.equal(result.series.garage_model_front.at(-1).y, null);
  assert(result.series.garage_model_difference.every(point => point.y === null));
});

test('power input requires the learner quality whitelist and preserves qualified zero', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const cases = [
    { powerQuality: null, powerKw: 1, expected: null },
    { powerQuality: 'unknown', powerKw: 1, expected: null },
    { powerQuality: 'verified', powerKw: 0, expected: 0 },
    { powerQuality: 'provisional', powerKw: .4, expected: .4 },
    { powerQuality: 'simulated', powerKw: .7, expected: .7 },
    { powerQuality: 'verified', powerKw: 9, expected: null },
  ];
  cases.forEach(({ expected, ...value }, i) => sample(store, range.from + i * MINUTE, value));
  const points = chart(store, ['garage_model_power']).series.garage_model_power;
  assert.deepEqual(points.map(point => point.y), cases.map(row => row.expected));
  assert.deepEqual(points.map(point => point.inputQualified), cases.map(row => row.expected !== null));
  assert(points.every(point => point.garageModelInput === true && !Object.hasOwn(point, 'learningUsable')));
});

test('input qualification preserves the model temperature and charger-power bounds', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  sample(store, range.from, { rearC: -60, frontC: 65, outdoorC: -60, ev1Kw: 0, ev2Kw: 50 });
  sample(store, range.from + MINUTE, { rearC: -61, frontC: 66, outdoorC: 66, ev1Kw: -1, ev2Kw: 51 });
  const result = chart(store, ['garage_model_rear', 'garage_model_front', 'garage_model_outdoor',
    'garage_model_difference', 'garage_model_ev1', 'garage_model_ev2']);
  for (const points of Object.values(result.series)) {
    assert(Number.isFinite(points[0].y));
    assert.equal(points.at(-1).y, null);
  }
});

test('compressor and separate charger activity charts preserve actual fractions without inventing watts', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  sample(store, range.from, { activity: true, ev1Active: false, ev2Active: true,
    powerKw: null, ev1Kw: null, ev2Kw: null });
  sample(store, range.from + MINUTE, { activity: .4, ev1Active: .25, ev2Active: .75,
    powerKw: null, ev1Kw: null, ev2Kw: null });
  sample(store, range.from + 2 * MINUTE, { activity: 1.1, ev1Active: null, ev2Active: -1 });
  for (const [key, expected] of [
    ['garage_model_activity', [1, .4, null]], ['garage_model_ev1_active', [0, .25, null]],
    ['garage_model_ev2_active', [1, .75, null]],
  ]) {
    const result = getChartData({ store, input: 'providers', startDate: range.startDate, now, left: key });
    assert.deepEqual(result.series[key].map(point => point.y), expected);
    assert.equal(GARAGE_INPUT_INFO[key].unit, 'fraction');
    assert(result.series[key].every(point => point.algorithmVersion === GARAGE_ALGORITHM_VERSION));
  }
  const power = chart(store, ['garage_model_power', 'garage_model_ev1', 'garage_model_ev2']);
  for (const points of Object.values(power.series)) assert(points.slice(0, 2).every(point => point.y === null));
});

test('garage pump readback and managed pause retain only saved boolean states without inference', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const cases = [
    { available: true, managedPause: false, activity: false, powerKw: 0, recovering: true },
    { available: false, managedPause: true, activity: true, powerKw: 1 },
    { available: null, managedPause: null, activity: true, powerKw: 1, recovering: true },
    { available: 1, managedPause: 0, activity: false, powerKw: 0 },
    { available: 'false', managedPause: 'true' },
    { available: false },
  ];
  cases.forEach((value, i) => sample(store, range.from + i * MINUTE, value));
  const before = store.learningJournal({ input: 'garage:providers' });
  for (const [key, expected, labels] of [
    ['garage_model_available', [1, 0, null, null, null, 0], ['Pump off', 'Pump on']],
    ['garage_model_managed_pause', [0, 1, null, null, null, null], ['No managed pause', 'Managed heating pause']],
  ]) {
    const result = getChartData({ store, input: 'providers', startDate: range.startDate, now, left: key });
    assert.deepEqual(result.series[key].map(point => point.y), expected);
    assert.deepEqual(result.series[key].map(point => point.inputQualified), expected.map(value => value !== null));
    assert(result.series[key].every((point, i) => point.observedAt === range.from + i * MINUTE
      && point.garageModelInput === true && point.inputSource === 'Recorded garage inputs'));
    assert.equal(GARAGE_INPUT_INFO[key].unit, 'state');
    assert.deepEqual([0, 1].map(value => historyStateLabel(key, value)), labels);
    assert.equal(historyStateLabel(key, null), 'Unknown');
  }
  assert.deepEqual(store.learningJournal({ input: 'garage:providers' }), before);
});

test('saved garage state samples keep bounded gaps and original timestamps without extending the tail', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const first = range.from + MINUTE, second = first + 5 * MINUTE;
  sample(store, first, { available: false, managedPause: true, at: first - 1000 });
  sample(store, second, { available: true, managedPause: false, at: second - 2000 });
  const keys = ['garage_model_available', 'garage_model_managed_pause'];
  const result = chart(store, keys);
  for (const key of keys) {
    const expected = key === 'garage_model_available' ? [0, 1] : [1, 0];
    assert.deepEqual(result.series[key].map(point => [point.x, point.y]), [
      [first, expected[0]], [first + 1, null], [second, expected[1]],
    ]);
    assert.deepEqual(result.series[key].filter(point => point.y !== null).map(point => point.observedAt),
      [first - 1000, second - 2000]);
    assert.equal(result.series[key][1].displayBoundary, true);
    assert.equal(result.series[key][1].sampleBoundary, true);
    const descriptor = { key, signal: key, values: { 0: 'Off', 1: 'On' } };
    const intervals = activityIntervals(descriptor, { ...result, range, now });
    assert.deepEqual(intervals.map(({ start, end, value, pointOnly }) => ({ start, end, value, pointOnly })), [
      { start: first, end: first, value: expected[0], pointOnly: true },
      { start: second, end: second, value: expected[1], pointOnly: true },
    ], 'Both source readings remain inspectable points around an unknown gap');
    assert.match(activityIntervalLabel(descriptor, intervals[0]), /recorded sample; duration unknown/);
    assert.deepEqual(chart(store, [key], { now: first + MINUTE }).series[key].map(point => [point.x, point.y]),
      [[first, expected[0]]], 'Future saved inputs cannot appear in earlier as-of history');
  }
});

test('coefficient chart uses same ordered learner and seed, then incrementally extends without writes', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let checkpoint = null;
  for (let i = 0; i < 18; i++) {
    const entry = sample(store, range.from + i * MINUTE, { rearC: 8 - i * .01, frontC: 7.5 - i * .02 });
    checkpoint = applyGarageEntry(checkpoint, entry, garageCorrectionContext(store, 'providers'));
  }
  let result = chart(store, [coefficient]);
  const expected = garageModelSummary(checkpoint.model).coefficients.rear.find(row => row.name === 'coolingPerHour');
  assert.equal(result.series[coefficient].at(-1).y, expected.value);
  assert.equal(result.series[coefficient][0].coefficientStatus, 'initial');
  assert.equal(result.stats.replayedRecords, 18);
  const first = structuredClone(result.series[coefficient]);
  const entry = sample(store, range.from + 18 * MINUTE, { rearC: 7.5, frontC: 7 });
  checkpoint = applyGarageEntry(checkpoint, entry, garageCorrectionContext(store, 'providers'));
  result = chart(store, [coefficient]);
  assert.equal(result.stats.replayedRecords, 19);
  assert.equal(result.series[coefficient].at(-1).y,
    garageModelSummary(checkpoint.model).coefficients.rear.find(row => row.name === 'coolingPerHour').value);
  assert.deepEqual(result.series[coefficient].filter(point => point.x < range.from + 17 * MINUTE),
    first.filter(point => point.x < range.from + 17 * MINUTE));
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 0);
});

test('coefficient comparisons replay the garage journal once and share cached history across selections', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (let i = 0; i < 18; i++) sample(store, range.from + i * MINUTE, { rearC: 8 - i * .01, frontC: 7.5 - i * .02 });
  let scanned = 0;
  const facade = { db: { prepare(sql) {
    const statement = store.db.prepare(sql);
    if (!sql.includes('SELECT * FROM learning_journal WHERE input=? AND id>? AND id<=?')) return statement;
    return { *iterate(...args) { for (const row of statement.iterate(...args)) { scanned++; yield row; } } };
  } } };
  const keys = Object.keys(GARAGE_COEFFICIENT_INFO), before = store.learningJournal({ input: 'garage:providers' });
  const rear = chart(facade, [coefficient]);
  assert.equal(scanned, 18);
  const combined = chart(facade, keys);
  assert.equal(scanned, 18, 'Selecting other coefficients reuses the same ordered replay checkpoint');
  assert.equal(combined.stats.replayedRecords, 18, 'Source evidence counts are not multiplied by visible coefficients');
  assert.deepEqual(combined.series[coefficient], rear.series[coefficient]);
  for (const key of keys) assert.deepEqual(combined.series[key], chart(store, [key]).series[key], key);
  assert.deepEqual(store.learningJournal({ input: 'garage:providers' }), before);
  sample(store, range.from + 18 * MINUTE, { rearC: 7.5, frontC: 7 });
  const advanced = chart(facade, keys);
  assert.equal(scanned, 19, 'One newly committed record is applied once for the whole comparison');
  assert.equal(advanced.stats.replayedRecords, 19);
  for (const key of keys) assert.deepEqual(advanced.series[key], chart(store, [key]).series[key], key);
  chart(facade, keys, { now: range.from + 10 * MINUTE });
  assert.equal(scanned, 30, 'Moving the as-of clock backwards replays only the earlier eligible prefix');
});

test('coefficient replay distinguishes learned cooling from observed electricity and the fixed power prior', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const seed = createGarageModel({ seedAt: range.from });
  seed.rear.active[0] = true; seed.rear.fitted[0] = true; seed.rear.evidence[0] = 12.75;
  const power = 'garage_coefficient_native_normalPowerKw';
  appendGarageEntry(store, 'providers', 'context', {}, garageSettings(), range.from, { seed });
  const before = store.learningJournal({ input: 'garage:providers' });
  const result = chart(store, [coefficient, power]);
  for (const [key, status, basis, hours] of [
    [coefficient, 'fitted', 'fitted-effective-response', 12.75],
    [power, 'fixed-prior', 'fixed-prior', 0],
  ]) {
    assert(result.series[key].length > 0, key);
    for (const point of result.series[key]) {
      assert.equal(point.coefficientStatus, status);
      assert.equal(point.coefficientBasis, basis);
      assert.equal(point.evidenceHours, hours);
      assert.equal(point.algorithmVersion, GARAGE_ALGORITHM_VERSION);
      assert.equal(Object.hasOwn(point, 'evidenceIntervals'), false);
    }
  }
  assert.deepEqual(store.learningJournal({ input: 'garage:providers' }), before);
  seed.native.active[0] = true; seed.native.hours = 6; seed.native.values[0] = .42;
  const observedStore = new Store(':memory:'); t.after(() => observedStore.close());
  appendGarageEntry(observedStore, 'providers', 'context', {}, garageSettings(), range.from, { seed });
  const observed = chart(observedStore, [power]).series[power];
  assert(observed.length > 0);
  assert(observed.every(point => point.y === .42 && point.coefficientBasis === 'observed-normal-power'
    && point.coefficientStatus === 'observed' && point.evidenceHours === 6));
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
  for (const left of ['garage_model_front', coefficient, 'garage_coefficient_native_normalPowerKw']) {
    const result = getChartData({ store, input: 'providers', startDate: range.startDate, now, left });
    assert(result.series[left].some(point => Number.isFinite(point.y)), left);
    assert.equal(result.meta.garageHistory.invalidRecords, 0);
    assert.equal(result.meta.garageHistory.basis, 'original-garage-inputs-and-versioned-read-only-replay');
  }
  assert.equal(Object.keys(GARAGE_COEFFICIENT_INFO).length, 3);
  assert.equal(GARAGE_ALGORITHM_VERSION, 'committed-garage-v7-room-reference');
});

test('native garage compressor shading and interpreted temperature respect recorded report deadlines on every axis', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store), at = range.from + MINUTE;
  const report = (signal, value, offset, unit = 'state') => recorder.record({
    source: 'garage-adapter', device: 'synthetic-garage', signal, value, unit,
    sourceTime: at + offset, receivedAt: at + offset, quality: [],
    raw: { reportIntervalMs: 2 * MINUTE, reportGraceMs: 0 },
  });
  report('garage_compressor_active', 1, 0);
  report('garage_compressor_active', 1, MINUTE);
  report('garage_compressor_active', 0, 5 * MINUTE);
  report('garage_native_indoor_temperature', 25, 0, 'degC');
  const before = store.db.prepare('SELECT count(*) n FROM observations').get().n;
  for (const left of ['power', 'temperatures', 'garage_native_indoor_temperature']) {
    const result = getChartData({ store, input: 'providers', startDate: range.startDate, now: at + 10 * MINUTE, left });
    assert.deepEqual(result.shading.compressorGarage, [{ start: at, end: at + 3 * MINUTE }]);
    if (left === 'garage_native_indoor_temperature') {
      assert(result.series[left].some(point => point.y === 25));
      assert(result.series[left].some(point => point.x === at + 2 * MINUTE && point.y === null));
    }
  }
  assert.equal(store.db.prepare('SELECT count(*) n FROM observations').get().n, before, 'Shading and curves are query projections, never additional recordings');
  const clipped = getChartData({ store, input: 'providers', startDate: range.startDate, now: at + 10 * MINUTE,
    left: 'power', viewFrom: at + MINUTE, viewTo: at + 6 * MINUTE });
  assert.deepEqual(clipped.shading.compressorGarage, [{ start: at + MINUTE, end: at + 3 * MINUTE }]);
});
