import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { seedVoltage } from './voltage-fixture.js';
import { Recorder } from '../src/storage/recorder.js';
import { getChartData } from '../src/app/chart-data.js';
import { CHART_VIEWS, CHART_VIEW_BY_KEY } from '../src/domain/chart-views.js';
import { HISTORY_AXIS_BY_KEY } from '../src/domain/history-series.js';

const date = '2026-09-08', start = Date.parse(`${date}T09:00:00+03:00`), MINUTE = 60_000;
const query = (store, options = {}) => getChartData({ store, input: 'offline', now: start + 60 * MINUTE,
  startDate: date, endDate: date, ...options });
const put = (store, signal, value, at = start, extra = {}) => store.observation({ source: 'synthetic-chart',
  device: 'synthetic-house', signal, value, unit: 'degC', sourceTime: at, receivedAt: at, ...extra });

test('every named view resolves only declared subject/context series and prices, with bounded detail', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const view of CHART_VIEWS) {
    const expected = new Set([...view.leftSignals, ...view.rightSignals, 'all_in_price', 'spot_price',
      ...view.tracks.filter(signal => Object.hasOwn(HISTORY_AXIS_BY_KEY, signal))]);
    for (const bounds of [{}, { viewFrom: start, viewTo: start + 30 * MINUTE }]) {
      const result = query(store, { view: view.key, ...bounds });
      assert.equal(result.view, view.key);
      assert.deepEqual(new Set(Object.keys(result.series)), expected, view.key);
      for (const points of Object.values(result.series)) assert(Array.isArray(points));
    }
  }
  assert.throws(() => query(store, { view: 'invented-json-field' }), /Unknown chart view/);
});

test('view combines grouped recorded quantities and interpreted garage temperature without rewriting history', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const [signal, value] of [['garage_temperature', 8], ['garage_temperature_2', 7], ['garage_native_indoor_temperature', 12]]) put(store, signal, value);
  put(store, 'garage_compressor_frequency', 35, start, { unit: 'Hz' });
  put(store, 'indoor_temperature', 21);
  const before = store.observations({ limit: 100 });
  const result = query(store, { view: 'garage' });
  assert.equal(result.series.garage_native_indoor_temperature.find(point => point.x === start).y, 12);
  assert.equal(result.series.garage_temperature_2.find(point => point.x === start).y, 7);
  assert.equal(result.series.garage_compressor_frequency.find(point => point.x === start).y, 35);
  assert(!Object.hasOwn(result.series, 'indoor_temperature'));
  assert.deepEqual(store.observations({ limit: 100 }), before);
});

test('named electrical view and individual power explorer retain coherent phase snapshots', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  seedVoltage(store, start);
  for (const prefix of ['property', 'ev1']) for (let phase = 1; phase <= 3; phase++)
    put(store, `${prefix}_current_l${phase}`, prefix === 'property' ? 10 : 5, start, { unit: 'A' });
  for (const selection of [{ view: 'power' }, { left: 'property_power' }]) {
    const result = query(store, selection);
    assert(Math.abs(result.series.property_power.find(point => point.x === start).y - 6.9) < 1e-10);
  }
  assert(Math.abs(query(store, { left: 'charger_power' }).series.charger_power.find(point => point.x === start).y - 3.45) < 1e-10);
});

test('named electrical comparisons retain common original cohorts through coarse reduction', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  seedVoltage(store, start);
  for (let i = 0; i < 180; i++) for (const prefix of ['property', 'ev1']) for (let phase = 1; phase <= 3; phase++)
    put(store, `${prefix}_current_l${phase}`, i === 90 ? null : (prefix === 'property' ? 12 : 3) + (i % 7 === 0 ? 4 : 0),
      start + i * MINUTE, { unit: 'A' });
  const options = { now: start + 180 * MINUTE, points: 100 };
  for (const selection of ['power', 'phases']) {
    const named = query(store, { ...options, view: selection }), raw = query(store, { ...options, left: selection });
    const keys = selection === 'power' ? ['property_power', 'charger_power', 'charger2_power'] : CHART_VIEW_BY_KEY.phases.leftSignals;
    for (const key of keys) assert.deepEqual(named.series[key], raw.series[key], key);
    assert(named.meta.relatedSampling.groups.some(group => group.includes(selection === 'power' ? 'property_power' : 'property_current_l1')));
  }
});

test('recorded circulation feedback remains distinct from requests and ends at its own deadline', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  put(store, 'dhwr_request', 1, start, { source: 'controller', device: 'offline', unit: 'state', raw: { expiresAt: start + 30 * MINUTE } });
  put(store, 'dhwr_active', 1, start + 5 * MINUTE, { source: 'mqtt-equipment', device: 'synthetic-dhwr', unit: 'state',
    raw: { basis: 'measured-power', verified: true, maxAgeMs: 2 * MINUTE } });
  put(store, 'dhwr_active', 0, start + 15 * MINUTE, { source: 'mqtt-equipment', device: 'synthetic-dhwr', unit: 'state',
    raw: { basis: 'measured-power', verified: true, maxAgeMs: 2 * MINUTE } });
  const result = query(store, { view: 'hot_water' }), points = result.series.dhwr_active;
  assert.deepEqual(result.shading.dhwr, [{ start, end: start + 30 * MINUTE }]);
  assert(points.some(point => point.x === start + 5 * MINUTE && point.y === 1 && point.basis === 'measured-power'));
  assert(points.some(point => point.x === start + 7 * MINUTE && point.y === null));
  assert(points.some(point => point.x === start + 15 * MINUTE && point.y === 0));
  assert(points.some(point => point.x === start + 17 * MINUTE && point.y === null));
  assert(!JSON.stringify(points).includes('synthetic-dhwr'));
  assert.match(result.meta.dhwrBasis, /shown separately/);
});

test('controller request rows retain known intervals, next-request cutoffs and input isolation', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const request = (signal, value, minute, end, extra = {}) => put(store, signal, value, start + minute * MINUTE,
    { source: 'controller', device: 'offline', unit: 'state', raw: { expiresAt: start + end * MINUTE }, ...extra });
  request('controller_phase', 0, 0, 30);
  request('controller_phase', 3, 0, 30, { device: 'providers' });
  request('controller_phase', 1, 5, 10);
  request('controller_phase', 2, 12, 30);
  request('controller_phase', 3, 14, 30, { device: 'providers' });
  request('dhwr_request', 1, 2, 10);
  request('dhwr_request', 0, 3, 3, { device: 'providers' });
  request('dhwr_request', 0, 8, 8);
  const phase = query(store, { view: 'control', now: start + 18 * MINUTE }).series.controller_phase;
  const intervals = [...new Map(phase.filter(point => Number.isFinite(point.y) && Number.isFinite(point.intervalEnd))
    .map(point => [`${point.intervalStart}:${point.intervalEnd}`, [point.intervalStart, point.intervalEnd, point.y]])).values()];
  assert.deepEqual(intervals, [[start, start + 5 * MINUTE, 0],
    [start + 5 * MINUTE, start + 10 * MINUTE, 1], [start + 12 * MINUTE, start + 18 * MINUTE, 2]]);
  assert(phase.some(point => point.x === start + 10 * MINUTE && point.y === null));
  assert(!phase.some(point => point.y === 3));
  const pulse = query(store, { left: 'dhwr_request', now: start + 18 * MINUTE }).series.dhwr_request;
  assert(pulse.filter(point => point.y === 1).every(point => point.requested === true
    && point.intervalStart === start + 2 * MINUTE && point.intervalEnd === start + 8 * MINUTE));
});

test('recorded event contacts seed past days and invalid readback interrupts their exact state', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  put(store, 'dhwr_active', 0, start - 24 * 60 * MINUTE, { unit: 'state', raw: { basis: 'reported-switch', eventOnly: true, verified: true } });
  put(store, 'dhwr_active', null, start, { unit: 'state', quality: ['unavailable'], raw: { verified: false } });
  const result = query(store, { left: 'dhwr_active' });
  assert.equal(result.series.dhwr_active[0].x, result.range.from);
  assert.equal(result.series.dhwr_active[0].y, 0);
  assert.equal(result.series.dhwr_active.find(point => point.x === start).y, null);
  assert(!result.series.dhwr_active.some(point => point.x >= start && point.y !== null));
});

test('floor contacts and garage defrost use recorded periodic coverage and preserve missing states', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store);
  for (const signal of ['floor_living_0_active', 'garage_native_defrost']) recorder.record({
    source: signal.startsWith('floor') ? 'floor-override' : 'garage-adapter', device: 'synthetic-equipment', signal,
    value: 1, unit: 'state', sourceTime: start, receivedAt: start,
    raw: { reportIntervalMs: 90_000, reportGraceMs: 0, diagnosticAvailable: true },
  });
  for (const [view, signal] of [['control', 'floor_living_0_active'], ['garage', 'garage_native_defrost']]) {
    const points = query(store, { view }).series[signal];
    assert(points.some(point => point.x === start && point.y === 1));
    assert(points.some(point => point.x === start + 90_000 && point.y === null));
    assert(!points.some(point => point.x > start + 90_000 && point.y === 1));
  }
  assert(CHART_VIEW_BY_KEY.hot_water.tracks.includes('dhwr_active'));
});

test('garage interval energy exposes original boundaries and provisional basis without treating counters as consumption', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const raw = { intervalStart: start - MINUTE, intervalEnd: start, coveredMs: MINUTE, timingEligible: true,
    meterScope: 'garage-heat-pump-only', energyBasis: 'counter-delta', provisional: true, accuracyVerified: false };
  put(store, 'garage_energy', 0.02, start, { source: 'garage-adapter', unit: 'kWh', raw });
  put(store, 'garage_energy', 0.04, start + MINUTE, { source: 'garage-adapter', unit: 'kWh',
    raw: { ...raw, intervalStart: start, intervalEnd: start + MINUTE, meterScope: 'whole-property' } });
  const points = query(store, { left: 'garage_energy' }).series.garage_energy;
  assert.deepEqual(query(store, { view: 'garage_control' }).series.garage_energy, points,
    'The protection and electricity view preserves the original interval evidence');
  const first = points.find(point => point.x === start);
  assert.equal(first.y, 0.02);
  assert.equal(first.intervalStart, start - MINUTE);
  assert.equal(first.intervalEnd, start);
  assert.equal(first.provisional, true);
  assert.equal(first.accuracyVerified, false);
  assert.equal(points.find(point => point.x === start + MINUTE).y, null);
});
