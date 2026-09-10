import test from 'node:test';
import assert from 'node:assert/strict';
import Chart from 'chart.js/auto';
import { historyTooltipLabel, historyValueScales } from '../chart/history-chart.js';
import { historyDatasets } from '../chart/history-model.js';
import { clipChartSeries } from '../chart/chart-resolution.js';
import { MODEL_INPUT_INFO } from '../src/domain/history-series.js';

// Use Chart.js itself for layout and pixel positions. Only canvas painting is
// discarded, so these tests exercise the independent-scale bug in the screenshot.
function createChart(t, series, selection = 'temperatures') {
  const canvas = { width: 1100, height: 600 };
  const context = new Proxy({ canvas, measureText: text => ({ width: String(text).length * 7 }) },
    { get: (target, key) => target[key] ?? (() => {}) });
  canvas.getContext = () => context;
  const datasets = historyDatasets(series, selection);
  const chart = new Chart(canvas, { type: 'line', data: { datasets }, options: {
    responsive: false, maintainAspectRatio: false, animation: false, parsing: false,
    scales: { x: { type: 'linear' }, ...historyValueScales(selection, datasets) },
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
  } });
  t.after(() => chart.destroy());
  return chart;
}

function updateChart(chart, series, selection = 'temperatures', preferences = {}, view) {
  chart.data.datasets = historyDatasets(series, selection, preferences);
  chart.options.scales = { x: { type: 'linear', ...(view ? { min: view.from, max: view.to } : {}) },
    ...historyValueScales(selection, chart.data.datasets) };
  chart.update('none');
}

function equalAirAxes(chart) {
  const { left, right } = chart.scales;
  assert.equal(left.min, right.min);
  assert.equal(left.max, right.max);
  assert.deepEqual(left.ticks.map(tick => tick.value), right.ticks.map(tick => tick.value));
  for (const value of [left.min, 0, 18.1, 23.3, right.max]) {
    assert.equal(left.getPixelForValue(value), right.getPixelForValue(value), `${value} must have one height`);
  }
}

const airSeries = () => ({
  indoor_temperature: [0, 1, 2, 3, 4, 5].map(x => ({ x, y: x < 2 ? 23.3 : 24 })),
  bedroom_temperature: [{ x: 0, y: null }],
  model_indoor_temperature: [{ x: 0, y: 23.3 }, { x: 5, y: 24 }],
  outdoor_temperature: [{ x: 0, y: 18.1 }, { x: 5, y: 15 }],
  spot_price: [{ x: 0, y: -40 }, { x: 1, y: 3 }, { x: 2, y: 3 }, { x: 3, y: 3 }, { x: 5, y: 3 }],
});

test('home air axes align equal temperatures, retain visible prices, and stay aligned after resize', t => {
  const chart = createChart(t, airSeries());
  equalAirAxes(chart);
  assert(chart.scales.left.min <= -40, 'Visible negative spot prices remain within the shared scale');
  assert(chart.scales.right.max >= 24);
  assert.equal(chart.scales.left.options.title.text, 'Air temperature · °C');
  assert.equal(chart.scales.right.options.title.text, 'Air temperature · °C / Price · c/kWh');
  const roomIndex = chart.data.datasets.findIndex(row => row.key === 'indoor_temperature');
  const averageIndex = chart.data.datasets.findIndex(row => row.key === 'model_indoor_temperature');
  assert.equal(chart.getDatasetMeta(roomIndex).data[0].y, chart.getDatasetMeta(averageIndex).data[0].y);
  chart.resize(375, 240);
  equalAirAxes(chart);
});

test('shared air scale follows legend changes and clipped zoom data instead of keeping old extrema', t => {
  const series = airSeries(), chart = createChart(t, series);
  updateChart(chart, series, 'temperatures', { spot_price: false });
  equalAirAxes(chart);
  assert(chart.scales.left.min > -40, 'Hidden prices no longer expand either scale');
  updateChart(chart, series);
  assert(chart.scales.left.min <= -40);
  const view = { from: 3, to: 5 };
  updateChart(chart, clipChartSeries(series, view), 'temperatures', {}, view);
  equalAirAxes(chart);
  assert(chart.scales.left.min > -40, 'Zoom recalculates both axes from the plotted data');
});

test('switching from home temperatures restores independent power and temperature axes', t => {
  const chart = createChart(t, airSeries());
  updateChart(chart, { ...airSeries(), property_power: [{ x: 0, y: 100 }, { x: 5, y: 200 }] }, 'power');
  assert(chart.scales.left.max >= 200);
  assert(chart.scales.right.max < 200);
  assert.notEqual(chart.scales.left.getPixelForValue(23.3), chart.scales.right.getPixelForValue(23.3));
  assert.equal(chart.scales.right.options.title.text, 'Air temperature · °C / Price · c/kWh');
  updateChart(chart, airSeries());
  equalAirAxes(chart);
});

test('empty and constant home-temperature histories have matching usable axes', t => {
  const chart = createChart(t, {});
  equalAirAxes(chart);
  updateChart(chart, { indoor_temperature: [{ x: 1, y: 23.3 }] });
  equalAirAxes(chart);
  assert(chart.scales.left.min < 23.3 && chart.scales.left.max > 23.3);
});

test('saved model inputs use the same concise tooltip suffix without interval or import-source clutter', () => {
  for (const [key, info] of Object.entries(MODEL_INPUT_INFO)) {
    if (['firewood_load', 'model_fireplace_release'].includes(key)) continue;
    const item = { dataset: { key, label: info.label, unit: info.unit }, parsed: { x: 1, y: 23.3 },
      raw: { modelInput: true, intervalStart: 0, intervalEnd: 1, source: 'fmi', inputSource: 'Imported history' } };
    const text = historyTooltipLabel(item);
    assert(text.startsWith(`${info.label}: `));
    assert(text.endsWith(' · saved learning input'));
    assert.equal(text.split(' · ').length, 2, `${key} has one consistent short qualifier`);
    assert(!text.includes('Imported history') && !text.includes('GMT') && !text.includes('FMI'));
  }
  assert.equal(historyTooltipLabel({ dataset: { key: 'model_indoor_temperature', label: 'Average indoor', unit: '°C' },
    parsed: { x: 1, y: 23.3 }, raw: { modelInput: true } }), 'Average indoor: 23.3 °C · saved learning input');
});

test('tooltips retain truthful source, interval and derived-input distinctions for other series', () => {
  const label = (key, name, unit, raw = {}) => historyTooltipLabel({ dataset: { key, label: name, unit },
    parsed: { x: 1, y: 23.3 }, raw });
  assert.equal(label('indoor_temperature', 'Upstairs', '°C'), 'Upstairs: 23.3 °C');
  assert.equal(label('outdoor_temperature', 'Outdoor', '°C', { source: 'fmi' }), 'Outdoor: 23.3 °C · FMI nearby station');
  assert.match(label('property_power', 'Property', 'kW', { intervalStart: 0, intervalEnd: 900000 }), /GMT.*–.*GMT/);
  const fireplace = label('model_fireplace_release', 'Fireplace release input', 'kg/h', { modelInput: true });
  assert.match(fireplace, /Calculated delayed release/);
  assert(!fireplace.includes('saved learning input'), 'Calculated manual-event projection is not a saved learning observation');
});
