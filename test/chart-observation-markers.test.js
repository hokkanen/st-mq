import test from 'node:test';
import assert from 'node:assert/strict';
import Chart from 'chart.js/auto';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { getChartData, chartRange } from '../src/app/chart-data.js';
import { COUNTER_SIGNALS } from '../src/domain/history-series.js';
import { historyDatasets } from '../chart/history-model.js';
import { EXPLORER_SERIES } from '../chart/series-explorer.js';

test('runtime and meter counters display only genuine samples as large hollow circles', () => {
  for (const key of COUNTER_SIGNALS) {
    const points = [{ x: 0, y: 100 }, { x: 2, y: 100, displayBoundary: true },
      { x: 8, y: 101 }, { x: 9, y: 101, carriedForward: true }];
    const [dataset] = historyDatasets({ [key]: points }, { leftSignals: [key], rightSignals: [] });
    assert.deepEqual(dataset.data, [points[0], points[2]], key);
    assert.equal(dataset.showLine, false); assert.equal(dataset.pointStyle, 'circle');
    assert.equal(dataset.pointBackgroundColor, 'transparent');
    assert(dataset.pointRadius >= 5 && dataset.pointHoverRadius > dataset.pointRadius && dataset.pointHitRadius >= 12);
    assert.equal(points.length, 4);
  }
});

test('every equivalent isolated reading uses the same hollow circle and usable hit area', () => {
  for (const { key, unit } of EXPLORER_SERIES) {
    if (unit === 'state' || unit === 'code') continue; // States have labelled rows.
    const points = [{ x: 0, y: null }, { x: 1, y: 4 }, { x: 2, y: null }];
    const [dataset] = historyDatasets({ [key]: points }, { leftSignals: [key], rightSignals: [] });
    if (['daily', 'event'].includes(dataset.kind)) continue; // Distinct model outcomes and manual additions.
    const at = value => Array.isArray(value) ? value[1] : value;
    assert.equal(dataset.pointStyle, 'circle', key);
    assert.equal(at(dataset.pointBackgroundColor), 'transparent', key);
    assert.equal(at(dataset.pointRadius), 5, key);
    assert.equal(at(dataset.pointHoverRadius), 7, key);
    assert.equal(at(dataset.pointHitRadius), 12, key);
  }
});

test('counter detail between reports does not manufacture readings at viewport boundaries', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const date = '2026-01-15', start = chartRange({ startDate: date }).from, minute = 60_000;
  for (const [offset, value] of [[0, 100], [8, 101], [16, 102]]) store.observation({ source: 'husdata-h66', device: 'synthetic-counter',
    signal: 'compressor_hours', value, unit: 'h', sourceTime: start + offset * minute, receivedAt: start + offset * minute,
    raw: { verified: true, usableForControl: true } });
  const options = { store, input: 'mqtt', startDate: date, left: 'compressor_hours', now: start + 20 * minute };
  const full = getChartData(options), detail = getChartData({ ...options, viewFrom: start + 2 * minute, viewTo: start + 4 * minute });
  assert.deepEqual(full.series.compressor_hours.filter(point => Number.isFinite(point.y)).map(point => point.y), [100, 101, 102]);
  assert(!detail.series.compressor_hours.some(point => Number.isFinite(point.y)), 'A counter changes only at its recorded samples');
});

test('periodic native meter counters retain original records instead of coverage endpoints', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store), date = '2026-01-15', start = chartRange({ startDate: date }).from, minute = 60_000;
  for (const [offset, value] of [[0, 123], [4, 124]]) recorder.record({
    source: 'garage-adapter', device: 'synthetic-pump', signal: 'garage_native_energy', value, unit: 'kWh',
    sourceTime: start + offset * minute, receivedAt: start + offset * minute + 1000, quality: [],
    raw: { reportIntervalMs: 2 * minute, reportGraceMs: 0, diagnosticAvailable: true, accuracyVerified: true },
  });
  const options = { store, input: 'providers', startDate: date, now: start + 8 * minute, left: 'garage_native_energy' };
  const payload = getChartData(options), [dataset] = historyDatasets(payload.series,
    { leftSignals: ['garage_native_energy'], rightSignals: [] });
  assert.deepEqual(dataset.data.filter(point => point.y !== null).map(point => [point.x, point.y, point.observedAt]),
    [[start, 123, start], [start + 4 * minute, 124, start + 4 * minute]]);
  assert(dataset.data.every(point => !point.displayBoundary && !point.periodicCoverage));
  const detail = getChartData({ ...options, viewFrom: start + minute, viewTo: start + 2 * minute });
  assert(!detail.series.garage_native_energy.some(point => Number.isFinite(point.y)), 'A report deadline cannot create a meter sample inside the detail range');
});

test('Chart.js selects a hollow counter marker within its expanded pointer target', t => {
  const canvas = { width: 800, height: 400 };
  const context = new Proxy({ canvas, measureText: value => ({ width: String(value).length * 7 }) }, { get: (object, key) => object[key] ?? (() => {}) });
  canvas.getContext = () => context;
  const datasets = historyDatasets({ compressor_hours: [{ x: 0, y: 100 }, { x: 10, y: 101 }] }, { leftSignals: ['compressor_hours'], rightSignals: [] });
  const chart = new Chart(canvas, { type: 'line', data: { datasets }, options: { responsive: false, animation: false, parsing: false,
    scales: { x: { type: 'linear', min: -2, max: 12 }, left: { type: 'linear', position: 'left' } }, plugins: { legend: { display: false } } } });
  t.after(() => chart.destroy());
  const point = chart.getDatasetMeta(0).data[0];
  const selected = chart.getElementsAtEventForMode({ native: true, x: point.x + 12, y: point.y }, 'nearest', { intersect: true }, false);
  assert.equal(selected.length, 1); assert.equal(selected[0].index, 0);
  assert.equal(point.options.backgroundColor, 'transparent');
  assert.equal(point.options.radius, 5);
});
