import test from 'node:test';
import assert from 'node:assert/strict';
import Chart from 'chart.js/auto';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { getChartData, chartRange } from '../src/app/chart-data.js';
import { historyDatasets } from '../chart/history-model.js';
import { clipChartSeries } from '../chart/chart-resolution.js';
import { temperatureIntervalKnots } from '../chart/temperature-curves.js';
import { LEARNING_ALGORITHM } from '../src/app/committed-learning.js';
import { currentHomeSample } from './helpers/home-learning-fixture.js';
import { appendGarageEntry } from '../src/garage/learning.js';
import { garageSettings } from '../src/garage/settings.js';

const minute = 60_000;
const date = '2026-01-15';
const start = chartRange({ startDate: date, now: Date.UTC(2026, 0, 16) }).from;
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store);
  return { store, put(signal, at, value) {
    recorder.record({ source: /supply|return/.test(signal) ? 'husdata-h66' : 'mqtt-temperature', device: 'synthetic-temperature',
      signal, value, unit: '°C', sourceTime: start + at * minute, receivedAt: start + at * minute, quality: [],
      raw: { verified: true, usableForControl: true, reportIntervalMs: 15 * minute, reportGraceMs: 2 * minute } });
  } };
}
function rendered(t, series, key, range, options) {
  const canvas = { width: 1000, height: 500 };
  const ctx = new Proxy({ canvas, measureText: value => ({ width: String(value).length * 7 }) }, { get: (target, key) => target[key] ?? (() => {}) });
  canvas.getContext = () => ctx;
  const datasets = historyDatasets(clipChartSeries(series, range, options), { leftSignals: [], rightSignals: [key] }, {}, undefined, options);
  // A narrow viewport can contain no original vertices. Keep its surrounding
  // values in scale so Chart.js does not clamp offscreen scalar coordinates.
  const values = datasets[0].data.map(point => point.y).filter(Number.isFinite);
  const chart = new Chart(canvas, { type: 'line', data: { datasets }, options: {
    responsive: false, animation: false, parsing: false, scales: { x: { type: 'linear', min: range.from, max: range.to },
      right: { type: 'linear', position: 'right', min: Math.min(0, ...values), max: Math.max(1, ...values) } },
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
  } });
  t.after(() => chart.destroy());
  const line = chart.getDatasetMeta(0).dataset;
  return { chart, line, data: datasets[0].data, value(at) {
    const x = chart.scales.x.getPixelForValue(start + at * minute);
    if (line.options.stepped) {
      // Chart.js' interpolation helper reverses its drawn step orientation.
      // Inspect the actual canvas path to test the visible held value and gaps.
      let previous, value;
      line.path({ moveTo(px, py) { previous = { x: px, y: py }; }, lineTo(px, py) {
        if (previous && previous.x !== px && x >= Math.min(previous.x, px) && x <= Math.max(previous.x, px)) {
          assert.equal(previous.y, py, 'A stepped line has only horizontal or vertical edges');
          value = chart.scales.right.getValueForPixel(py);
        }
        previous = { x: px, y: py };
      }, closePath() {} });
      return value;
    }
    const point = line.interpolate({ x }, 'x');
    return point && !Array.isArray(point) ? chart.scales.right.getValueForPixel(point.y) : undefined;
  } };
}

test('real periodic bedroom, downstairs and water histories draw cubic slopes instead of hold-edge staircases', t => {
  const { store, put } = fixture(t);
  for (const key of ['bedroom_temperature', 'downstairs_temperature', 'supply_temperature', 'return_temperature']) {
    for (const [at, value] of [[0, 20], [15, 21], [30, 23], [45, 22]]) put(key, at, value);
    const payload = getChartData({ store, input: 'mqtt', now: start + 50 * minute, startDate: date, left: key });
    const before = structuredClone(payload.series[key]);
    assert(payload.series[key].some(point => point.periodicCoverage && point.coverageId !== undefined));
    const plot = rendered(t, payload.series, key, { from: start, to: start + 50 * minute });
    assert.deepEqual(plot.data.map(point => (point.x - start) / minute), [0, 15, 30, 45, 50]);
    for (const at of [16, 20, 22.5, 25, 29]) assert(plot.value(at) > 21 && plot.value(at) < 23, `${key} has a gradual slope throughout the recorded interval`);
    assert(Math.abs(plot.value(22.5) - 22) > .01, `${key} has a real cubic bend, not a linear interpolation flag`);
    for (const at of [46, 48, 50]) assert(Math.abs(plot.value(at) - 22) < 1e-8, 'The terminal supported hold stays flat');
    assert.deepEqual(payload.series[key], before, 'Display interpolation leaves source observations and freshness provenance unchanged');
  }
});

test('narrow detail and cached overview retain the same cubic geometry between genuine observations', t => {
  const { store, put } = fixture(t), key = 'bedroom_temperature';
  for (const [at, value] of [[0, 20], [15, 21], [30, 23], [45, 22], [60, 24]]) put(key, at, value);
  const options = { store, input: 'mqtt', now: start + 65 * minute, startDate: date, left: key };
  const overview = getChartData(options), range = { from: start + 20 * minute, to: start + 25 * minute };
  const detail = getChartData({ ...options, viewFrom: range.from, viewTo: range.to });
  const before = structuredClone([overview.series, detail.series]);
  assert(detail.series[key].some(point => point.displayContext && point.x === start + 30 * minute));
  const fullPlot = rendered(t, overview.series, key, { from: start, to: start + 65 * minute });
  const zoomPlot = rendered(t, overview.series, key, range), detailPlot = rendered(t, detail.series, key, range);
  for (const at of [20, 21, 22.5, 24, 25]) {
    assert(Math.abs(zoomPlot.value(at) - fullPlot.value(at)) < 1e-7, 'Cached zoom preserves original monotone tangents');
    assert(Math.abs(detailPlot.value(at) - fullPlot.value(at)) < 1e-7, 'Detail context preserves original monotone tangents');
  }
  for (const payload of [overview, detail]) {
    const stepped = rendered(t, payload.series, key, range, { interpolation: false });
    for (const at of [20, 21, 22.5, 24, 25])
      assert(Math.abs(stepped.value(at) - 21) < 1e-7, 'Disabled interpolation holds the recorded temperature throughout the interval');
    const restored = rendered(t, payload.series, key, range, { interpolation: true });
    for (const at of [20, 22.5, 25])
      assert(Math.abs(restored.value(at) - fullPlot.value(at)) < 1e-7, 'Re-enabling interpolation restores the original cubic geometry');
  }
  assert.deepEqual([overview.series, detail.series], before, 'Switching display modes leaves cached source points unchanged');
  assert.equal(detail.range.from, range.from); assert.equal(detail.range.to, range.to);
});

test('periodic expiry stays a real gap in full and narrow cubic views', t => {
  const { store, put } = fixture(t), key = 'bedroom_temperature';
  for (const [at, value] of [[0, 20], [15, 21], [60, 23], [75, 22]]) put(key, at, value);
  const options = { store, input: 'mqtt', now: start + 80 * minute, startDate: date, left: key };
  const range = { from: start + 40 * minute, to: start + 45 * minute };
  for (const payload of [getChartData(options), getChartData({ ...options, viewFrom: range.from, viewTo: range.to })]) {
    for (const interpolation of [true, false]) {
      const plot = rendered(t, payload.series, key, range, { interpolation });
      assert.equal(plot.value(42), undefined, 'Neither display mode connects expired coverage');
      assert(plot.data.some(point => point.y === null));
    }
  }
});

test('fetched saved model temperature detail retains the overview cubic and missing intervals', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const [a, b, value] of [[0, 15, 8], [15, 30, 12], [30, 45, 10], [45, 60, 9], [60, 75, null], [75, 90, 11]]) {
    store.appendLearningJournal('mqtt', { kind: 'sample', at: start + b * minute, algorithmVersion: LEARNING_ALGORITHM,
      payload: { value: currentHomeSample({ timestamp: start + b * minute, windowStart: start + a * minute,
        windowEnd: start + b * minute, indoorC: 20, quality: [], inputSegments: [{
          start: start + a * minute, end: start + b * minute, outdoorC: value,
          targetC: value === null ? null : value + 15, roomBoostC: value === null ? null : value / 10,
          solarRadiationWm2: 300, phase: 'normal', thermalCompressorDuty: 0, thermalAuxKw: 0, quality: [],
        }] }) } });
  }
  const view = { from: start + 20 * minute, to: start + 25 * minute };
  for (const key of ['model_outdoor_temperature', 'model_target_temperature', 'model_room_boost']) {
    const options = { store, input: 'mqtt', now: start + 95 * minute, startDate: date, left: key };
    const overview = getChartData(options), detail = getChartData({ ...options, viewFrom: view.from, viewTo: view.to });
    const a = rendered(t, overview.series, key, view), b = rendered(t, detail.series, key, view);
    assert.deepEqual(b.data.map(point => [point.x, point.y]), a.data.map(point => [point.x, point.y]));
    for (const at of [20, 22.5, 25]) assert(Math.abs(a.value(at) - b.value(at)) < 1e-7, `${key} retains actual overview geometry after detail arrives`);
    assert(Math.abs(b.value(20) - b.value(25)) > .01, `${key} cannot revert to the interval's flat value`);
    const expected = { model_outdoor_temperature: 12, model_target_temperature: 27, model_room_boost: 1.2 }[key];
    for (const payload of [overview, detail]) {
      const stepped = rendered(t, payload.series, key, view, { interpolation: false });
      for (const at of [20, 22.5, 25]) assert(Math.abs(stepped.value(at) - expected) < 1e-7,
        `${key} uses its original interval value when interpolation is disabled`);
      assert(stepped.data.some(point => point.x === start + 30 * minute - 1), 'Step mode retains the original interval hold endpoint');
    }
    const gap = { from: start + 65 * minute, to: start + 70 * minute };
    const missing = getChartData({ ...options, viewFrom: gap.from, viewTo: gap.to });
    assert.equal(rendered(t, missing.series, key, gap).value(67), undefined);
    assert.equal(rendered(t, missing.series, key, gap, { interpolation: false }).value(67), undefined);
  }
});

test('disabled interpolation uses original scalar values at detail boundaries and preserves missing readings', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const key = 'heating_integral';
  for (const [at, value] of [[0, -100], [8, -20], [12, null], [16, -40]]) store.observation({
    source: 'synthetic-chart', device: 'synthetic-integral', signal: key, value, unit: '°min',
    sourceTime: start + at * minute, receivedAt: start + at * minute, quality: [],
  });
  const options = { store, input: 'mqtt', now: start + 20 * minute, startDate: date, left: 'integral' };
  const range = { from: start + 2 * minute, to: start + 4 * minute };
  const overview = getChartData(options), detail = getChartData({ ...options, viewFrom: range.from, viewTo: range.to });
  const before = structuredClone([overview.series, detail.series]);
  assert.deepEqual(detail.series[key].map(point => point.y), [-80, -60], 'The API retains the existing linear clip values');
  for (const payload of [overview, detail]) {
    const linear = rendered(t, payload.series, key, range);
    const stepped = rendered(t, payload.series, key, range, { interpolation: false });
    assert(Math.abs(linear.value(3) + 70) < 1e-7, 'The default scalar display still uses linear interpolation');
    for (const at of [2, 3, 4]) assert(Math.abs(stepped.value(at) + 100) < 1e-7,
      'A narrow viewport holds the preceding reading rather than either interpolated boundary value');
    const restored = rendered(t, payload.series, key, range, { interpolation: true });
    assert(Math.abs(restored.value(3) - linear.value(3)) < 1e-7);
    assert(stepped.data.filter(point => point.displayBoundary).every(point => point.interpolated === false));
  }
  assert.deepEqual([overview.series, detail.series], before);
  const gap = { from: start + 10 * minute, to: start + 11 * minute };
  const missing = getChartData({ ...options, viewFrom: gap.from, viewTo: gap.to });
  assert(missing.series[key].every(point => point.y === null && point.heldValue === -20));
  for (const payload of [overview, missing]) {
    const stepped = rendered(t, payload.series, key, gap, { interpolation: false });
    assert.equal(stepped.value(10.5), undefined, 'A finite preceding value cannot fill a missing scalar segment');
  }
});

test('fetched garage temperature detail keeps surrounding saved samples and sampling gaps', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const [at, value] of [[0, 8], [1, 9], [2, 11], [3, 10], [8, 9]]) appendGarageEntry(store, 'providers', 'sample', {
    at: start + at * minute, rearAt: start + at * minute, rearC: value, frontAt: start + at * minute,
    frontC: value + 1, outdoorAt: start + at * minute, outdoorC: value - 10, available: true,
  }, garageSettings(), start + at * minute);
  for (const key of ['garage_model_rear', 'garage_model_front', 'garage_model_outdoor', 'garage_model_difference']) {
    const options = { store, input: 'providers', now: start + 9 * minute, startDate: date, left: key };
    const view = { from: start + 1.2 * minute, to: start + 1.8 * minute };
    const overview = getChartData(options), detail = getChartData({ ...options, viewFrom: view.from, viewTo: view.to });
    const a = rendered(t, overview.series, key, view), b = rendered(t, detail.series, key, view);
    for (const at of [1.2, 1.5, 1.8]) assert(Math.abs(a.value(at) - b.value(at)) < 1e-7, key);
    if (key === 'garage_model_rear') {
      const gap = { from: start + 5 * minute, to: start + 6 * minute };
      const missing = getChartData({ ...options, viewFrom: gap.from, viewTo: gap.to });
      assert.equal(rendered(t, missing.series, key, gap).value(5.5), undefined);
    }
  }
});

test('fetched outdoor forecast detail preserves cubic geometry within forecast intervals', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const key = 'outdoor_forecast', view = { from: start + 20 * minute, to: start + 25 * minute };
  const options = { store, input: 'simulated', now: start, startDate: date, left: 'temperatures', simulated: {
    forecast: [8, 12, 10, 9].map((outdoorC, index) => ({ start: start + index * 15 * minute,
      end: start + (index + 1) * 15 * minute, outdoorC })),
  } };
  const overview = getChartData(options), detail = getChartData({ ...options, viewFrom: view.from, viewTo: view.to });
  const a = rendered(t, overview.series, key, view), b = rendered(t, detail.series, key, view);
  for (const at of [20, 22.5, 25]) assert(Math.abs(a.value(at) - b.value(at)) < 1e-7);
  assert(Math.abs(b.value(20) - b.value(25)) > .1, 'Forecast detail retains its temperature slope');
});

test('periodic display reduction retains real points, provenance changes and all final freshness edges', () => {
  const point = (x, y, coverageId, source = 'room', extra = {}) => ({ x, y, coverageId, source,
    periodicCoverage: true, displayBoundary: true, observedAt: coverageId * 10, reportExpiresAt: coverageId * 10 + 10, ...extra });
  const points = [point(10, 20, 1), point(15, 20.5, 1, 'room', { displayBoundary: false }), point(19, 20.5, 1),
    point(20, 21, 2, 'replacement'), point(29, 21, 2, 'replacement'), { x: 30, y: null }];
  const knots = temperatureIntervalKnots(points);
  assert(knots.includes(points[1]), 'A genuine intermediate observation survives');
  assert(knots.includes(points[2]), 'The old source remains bounded at its final supported edge');
  assert(knots.includes(points[4]), 'The last freshness endpoint survives before a gap');
  assert(knots.includes(points[5]));
  assert(knots.every(point => points.includes(point)));
});
