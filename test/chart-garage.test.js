import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { chartRange, getChartData } from '../src/app/chart-data.js';
import { HISTORY_AXIS_BY_KEY } from '../src/domain/history-series.js';
import { CHART_VIEW_BY_KEY } from '../src/domain/chart-views.js';
const MINUTE = 60_000, range = chartRange({ startDate: '2026-09-08' });

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

test('retired Garage learned series and views are rejected while actual observations remain supported', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const left of ['garage_model_rear', 'garage_coefficient_rear_coolingPerHour', 'garage_outcome_benefit', 'garage_ble_temperature']) {
    assert.equal(HISTORY_AXIS_BY_KEY[left], undefined);
    assert.throws(() => getChartData({ store, input: 'providers', startDate: range.startDate, now: range.to, left }), /supported|Unknown|Invalid/i);
  }
  for (const view of ['garage_temperatures', 'garage_cooling', 'garage_benefit']) assert.equal(CHART_VIEW_BY_KEY[view], undefined);
  for (const signal of ['garage_temperature', 'garage_temperature_2', 'garage_compressor_frequency', 'garage_energy'])
    assert(HISTORY_AXIS_BY_KEY[signal]);
  for (const view of Object.values(CHART_VIEW_BY_KEY))
    assert(![...view.leftSignals, ...view.rightSignals, ...view.tracks, ...Object.keys(view.defaults)].includes('garage_ble_temperature'));
  assert.equal(CHART_VIEW_BY_KEY.garage_control.defaults.garage_temperature, true);
});

test('Garage targets and pipe estimates retain original deadlines and reject unknown numbers', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store), at = range.from + MINUTE;
  const signals = ['garage_room_target', 'garage_effective_target',
    'garage_pipe_rear_temperature', 'garage_pipe_front_temperature', 'garage_native_power',
    'garage_external_enabled', 'garage_frost_active', 'garage_frost_available', 'garage_away_mode'];
  const isTemperature = signal => /(_target|_temperature)$/.test(signal);
  for (const signal of signals) {
    const unit = isTemperature(signal) ? 'degC' : 'state';
    recorder.record({ source: 'garage-adapter', device: 'synthetic-control', signal, value: 0, unit,
      sourceTime: at, receivedAt: at, quality: signal.includes('pipe_') ? ['estimated'] : [],
      raw: { reportIntervalMs: MINUTE, reportGraceMs: 0 } });
    recorder.record({ source: 'garage-adapter', device: 'synthetic-control', signal, value: 1, unit,
      sourceTime: at + 2 * MINUTE, receivedAt: at + 2 * MINUTE, quality: ['unknown'],
      raw: { reportIntervalMs: MINUTE, reportGraceMs: 0 } });
    const chart = getChartData({ store, input: 'providers', startDate: range.startDate,
      now: at + 5 * MINUTE, left: signal });
    const points = chart.series[signal];
    assert(points.some(point => point.y === 0), `${signal}: measured zero or inactive is valid evidence`);
    assert(points.some(point => point.x === at + MINUTE && point.y === null), `${signal}: expired report becomes a gap`);
    assert(!points.some(point => point.y === 1), `${signal}: unknown is never plotted as a numerical observation`);
    assert(points.filter(point => Number.isFinite(point.y)).every(point => point.x < at + MINUTE),
      `${signal}: saved values do not extend beyond their original report deadline`);
  }
});

test('Garage control chart validates state, temperature and target units and bounds', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let at = range.from + MINUTE;
  for (const [signal, value, unit, quality] of [
    ['garage_room_target', 32, 'degC', []], ['garage_effective_target', -1, 'degC', []],
    ['garage_room_target', 10, 'W', []], ['garage_pipe_front_temperature', 100, 'degC', []],
    ['garage_pipe_rear_temperature', 5, 'degC', ['stale']], ['garage_pipe_front_temperature', 5, 'degC', ['retained']],
    ['garage_frost_active', 2, 'state', []], ['garage_frost_available', 1, 'boolean', []],
  ]) {
    at += MINUTE;
    store.observation({ source: 'garage-adapter', device: 'synthetic-invalid-control', signal, value, unit,
      sourceTime: at, receivedAt: at, quality, raw: {} });
    const chart = getChartData({ store, input: 'providers', startDate: range.startDate,
      now: at + MINUTE, left: signal });
    assert(!chart.series[signal].some(point => Number.isFinite(point.y)), `${signal}: unsupported evidence remains unavailable`);
  }
});
