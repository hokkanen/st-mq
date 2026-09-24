import test from 'node:test';
import assert from 'node:assert/strict';
import Chart from 'chart.js/auto';
import { historyTooltipLabel, historyValueScales } from '../chart/history-chart.js';
import { historyDatasets, leftGroups } from '../chart/history-model.js';
import { historyTooltipTitle, historyTooltipCallbacks, historyLearningLabel, historyTooltipsEnabled, wrapHistoryTooltip } from '../chart/history-tooltips.js';
import { isInterpolatedTemperature } from '../src/domain/chart-temperatures.js';
import { temperatureIntervalKnots } from '../chart/temperature-curves.js';
import { clipChartSeries } from '../chart/chart-resolution.js';
import { HISTORY_AXES, MODEL_INPUT_INFO } from '../src/domain/history-series.js';

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
      raw: { modelInput: true, learningUsable: true, intervalStart: 0, intervalEnd: 1, source: 'fmi', inputSource: 'Imported history' } };
    const text = historyTooltipLabel(item);
    assert(text.startsWith(`${info.label}: `));
    assert(text.endsWith(' · saved learning input · recorded input quality usable; thermal fitting needs observed heat, sunshine and fresh endpoints'));
    assert.equal(text.split(' · ').length, 3, `${key} separates its saved basis and eligibility`);
    assert(!text.includes('Imported history') && !text.includes('GMT') && !text.includes('FMI'));
  }
  assert.equal(historyTooltipLabel({ dataset: { key: 'model_indoor_temperature', label: 'Average indoor', unit: '°C' },
    parsed: { x: 1, y: 23.3 }, raw: { modelInput: true } }), 'Average indoor: 23.3 °C · saved learning input · recorded input quality unavailable');
});

test('tooltips retain truthful source, interval and derived-input distinctions for other series', () => {
  const label = (key, name, unit, raw = {}) => historyTooltipLabel({ dataset: { key, label: name, unit },
    parsed: { x: 1, y: 23.3 }, raw });
  assert.equal(label('indoor_temperature', 'Upstairs', '°C'), 'Upstairs: 23.3 °C');
  assert.equal(label('outdoor_temperature', 'Outdoor', '°C', { source: 'fmi' }), 'Outdoor: 23.3 °C · FMI nearby station');
  assert.equal(label('property_power', 'Property', 'kW', { intervalStart: 0, intervalEnd: 900000 }), 'Property: 23.3 kW · interval average from recorded energy');
  const fireplace = label('model_fireplace_release', 'Fireplace release input', 'kg/h', { modelInput: true });
  assert.match(fireplace, /Calculated delayed release/);
  assert(!fireplace.includes('saved learning input'), 'Calculated manual-event projection is not a saved learning observation');
});

test('Garage coefficient tooltips distinguish fixed priors and time-weighted evidence from interval counts', () => {
  const label = (coefficientStatus, evidenceHours) => historyTooltipLabel({
    dataset: { key: 'garage_coefficient_rear_lossPerHour', label: 'Garage rear · Heat loss', unit: '1/h' },
    parsed: { x: 1, y: .022 }, raw: { modelCoefficient: true, coefficientStatus, evidenceHours },
  });
  assert.match(label('fixed-prior', 0), /Fixed assumption/);
  assert.match(label('fitted', 12.75), /input evidence at that update: 12.75 h/);
  assert.doesNotMatch(label('fitted', 12.75), /intervals|samples/);
  assert.match(label('retained', 3.5), /Retained from an earlier fit/);
});

test('Garage input tooltips distinguish qualified values from independent fitting or episode evidence', () => {
  const point = { modelInput: true, garageModelInput: true, inputQualified: true };
  const item = { dataset: { key: 'garage_model_activity', label: 'Compressor activity input', unit: 'fraction' },
    parsed: { x: 1, y: .4 }, raw: point };
  const text = historyTooltipLabel(item);
  assert.match(text, /0.4 fraction · saved garage input · qualified recorded input; fitting depends on the interval and episode/);
  assert.doesNotMatch(text, /recorded input quality usable; thermal fitting needs observed heat, sunshine and fresh endpoints|kW|40 %/);
  assert.equal(historyLearningLabel('garage_model_activity', { ...point, inputQualified: false }), 'input unavailable or unqualified');
});

test('saved indoor average tooltip identifies held rooms, genuine observation times and excluded learning', () => {
  const observedAt = Date.parse('2026-09-08T08:00:00Z');
  const text = historyTooltipLabel({ dataset: { key: 'model_indoor_temperature', label: 'Average indoor', unit: '°C' },
    parsed: { x: observedAt + 3 * 3_600_000, y: 21 }, raw: { modelInput: true, savedIndoorAverage: true,
      learningUsable: false, held: true, needsAttention: true, attentionSensors: [
        { signal: 'bedroom_temperature', observedAt, reasons: ['old-reading', 'disconnected', 'invented-private-reason'] },
        { signal: 'invented-private-device', observedAt, reasons: [] },
      ] } });
  assert.match(text, /Average indoor: 21 °C · saved indoor average · recorded input quality excluded/);
  assert.match(text, /needs attention · using last known readings: Bedroom observed 8 Sept 2026, 11:00 GMT\+3 \(over 2 hours old, sensor disconnected\)/);
  assert.doesNotMatch(text, /invented-private/);
});

test('every selectable series uses one time context and value format in all four pointer/fullscreen modes', t => {
  const at = Date.parse('2026-09-08T08:00:00Z'), end = at + 15 * 60_000;
  const chart = createChart(t, {}), tested = new Set();
  const cases = [{}, { source: 'fmi' }, { intervalStart: at, intervalEnd: end },
    { modelInput: true, learningUsable: true, intervalStart: at, intervalEnd: end },
    { modelInput: true, learningUsable: false }, { auditOnly: true },
    { carriedForward: true, observedAt: at - 3600000 }, { displayBoundary: true, interpolated: true },
    { equivalentCurrent: true }, { assumedPrice: true },
    { sessionCheck: true, sessionStart: at, sessionEnd: end, comparisonEligible: false }];
  for (const [selection] of Object.entries(leftGroups)) {
    const datasets = historyDatasets({}, selection);
    for (const dataset of datasets) {
      tested.add(dataset.key);
      for (const raw of cases) {
        const item = { chart, dataset, parsed: { x: at, y: 1 }, raw: { x: at, y: 1, ...raw } };
        const label = historyTooltipLabel(item), title = historyTooltipTitle([item]);
        assert(label.startsWith(`${dataset.label}: `), dataset.key);
        assert.doesNotMatch(label, /undefined|NaN|Invalid Date/);
        assert.equal(title.length, 1);
        assert.match(title[0], /2026.*Finland/);
        if (!raw.carriedForward) assert.doesNotMatch(label, /2026|GMT/, 'Point/interval time appears only in title');
        const expected = { title: historyTooltipCallbacks.title([item]), label: historyTooltipCallbacks.label(item) };
        for (const fullscreen of [false, true]) for (const coarsePointer of [false, true]) {
          const enabled = historyTooltipsEnabled({ fullscreen, coarsePointer });
          assert.equal(enabled, fullscreen || !coarsePointer);
          if (enabled) assert.deepEqual({ title: historyTooltipCallbacks.title([item]), label: historyTooltipCallbacks.label(item) }, expected);
        }
      }
    }
  }
  assert(tested.size >= 70, 'The test covers the complete catalogue, not a sample of axes');
  assert.deepEqual(new Set(HISTORY_AXES.flatMap(axis => axis.signals)), tested);
});

test('shared tooltip titles group matching periods and preserve comparisons with different periods', () => {
  const at = Date.parse('2026-09-08T08:00:00Z'), end = at + 900000;
  const item = (key, label, raw) => ({ dataset: { key, label }, parsed: { x: end }, raw });
  const property = item('property_power', 'Property', { intervalStart: at, intervalEnd: end });
  const charger = item('charger_power', 'Charger 1', property.raw);
  assert.equal(historyTooltipTitle([property, charger]).length, 1, 'Matching intervals have one title');
  const average = item('model_indoor_temperature', 'Average indoor', property.raw);
  const title = historyTooltipTitle([property, charger, average]);
  assert.equal(title.length, 2);
  assert.match(title[0], /^Property, Charger 1: .*11:00.*11:15/);
  assert.match(title[1], /^Average indoor: .*11:15/);
  assert.doesNotMatch(title[1], /11:00/, 'The saved indoor average remains an endpoint');
  const held = { ...property, parsed: { x: end + 900000 }, raw: { ...property.raw, carriedForward: true, observedAt: end } };
  assert.match(historyTooltipTitle([held])[0], /11:30/, 'A held extension names its display time; last-recorded time stays separate provenance');
  assert.deepEqual(historyTooltipTitle([]), []);
  const autumn = historyTooltipTitle([item('property_power', 'Property', {
    intervalStart: Date.parse('2026-10-25T00:30:00Z'), intervalEnd: Date.parse('2026-10-25T01:30:00Z'),
  })]);
  assert.match(autumn[0], /03:30 GMT\+3.*03:30 GMT\+2/, 'Repeated local hours retain both offsets');
});

test('only saved input quality claims eligibility and never claims that eligibility proves training', () => {
  for (const key of ['indoor_temperature', 'outdoor_forecast', 'model_coefficient_heat_loss', 'learning_profit'])
    assert.equal(historyLearningLabel(key, { learningUsable: true }), '');
  for (const learningUsable of [true, false, undefined]) {
    const text = historyLearningLabel('model_outdoor_temperature', { modelInput: true, learningUsable });
    assert.equal(text, learningUsable === true ? 'recorded input quality usable; thermal fitting needs observed heat, sunshine and fresh endpoints' : learningUsable === false
      ? 'recorded input quality excluded' : 'recorded input quality unavailable');
    assert.doesNotMatch(text, /included|trained|used/);
  }
  assert.equal(historyLearningLabel('model_fireplace_release', { modelInput: true }), '');
  assert.equal(historyLearningLabel('caravan_energy'), 'not used for learning');
  assert.equal(historyLearningLabel('ev1_session_energy_check', { sessionCheck: true }), 'not used for learning');
});

test('phone tooltip wrapping retains all content within the available canvas width', t => {
  const chart = createChart(t, {}); chart.resize(375, 600);
  const text = 'Average indoor: 21 °C · saved indoor average · recorded input quality excluded · needs attention · using last known readings: Bedroom observed 8 Sept 2026, 11:00 GMT+3 (over 2 hours old, sensor disconnected)';
  const lines = wrapHistoryTooltip(text, chart);
  assert(lines.length > 3);
  assert.equal(lines.join(' '), text);
  assert(lines.every(line => chart.ctx.measureText(line).width <= chart.width - 52));
});

test('Caravan energy popups identify measured interval energy outside heating learning', () => {
  const label = (key, raw) => historyTooltipLabel({ dataset: { key, label: 'Caravan', unit: key === 'caravan_energy' ? 'kWh' : 'A' },
    parsed: { x: 1, y: 1.2 }, raw: { source: 'shelly-mqtt', ...raw } });
  assert.match(label('caravan_energy', {}), /meter energy over the recorded interval · not used for learning/);
});

test('all measured air, liquid and estimated temperatures render bounded cubic curves on either axis', t => {
  const points = [{ x: 0, y: 18 }, { x: 2, y: 19 }, { x: 5, y: 24 }, { x: 6, y: 24 },
    { x: 7, y: null }, { x: 8, y: 20 }, { x: 9, y: 19 }, { x: 12, y: 23 }];
  for (const key of [...new Set(HISTORY_AXES.flatMap(axis => axis.signals))].filter(isInterpolatedTemperature)) {
    const selection = key === 'outdoor_forecast' ? 'power' : key;
    const chart = createChart(t, { [key]: points }, selection);
    const index = chart.data.datasets.findIndex(dataset => dataset.key === key), meta = chart.getDatasetMeta(index);
    assert.equal(meta.dataset.options.stepped, false, key);
    assert.equal(meta.dataset.options.cubicInterpolationMode, 'monotone', key);
    assert.equal(meta.dataset.segments.length, 2, `${key} cannot interpolate across missing observations`);
    let curved = false;
    for (const { start, end } of meta.dataset.segments) for (let i = start; i < end; i++) {
      const a = meta.data[i], b = meta.data[i + 1];
      for (const fraction of [0.2, 0.5, 0.8]) {
        const pixel = meta.dataset.interpolate({ x: a.x + (b.x - a.x) * fraction }, 'x');
        assert(pixel.y >= Math.min(a.y, b.y) - 1e-8 && pixel.y <= Math.max(a.y, b.y) + 1e-8, `${key} must not overshoot its observations`);
        if (Math.abs(pixel.y - (a.y + (b.y - a.y) * fraction)) > 0.01) curved = true;
      }
    }
    assert(curved, `${key} genuinely uses cubic segments instead of linear or stepped drawing`);
  }
  const settings = ['heating_setpoint', 'room_setting', 'dhw_stop_setting', 'model_target_temperature', 'model_room_boost'];
  for (const key of settings) assert.equal(historyDatasets({ [key]: points }, key)[0].stepped, true, `${key} is a command, not a temperature measurement`);
});

test('temperature interval curves remove artificial hold edges while preserving each knot, provenance and gap', t => {
  const points = [0, 10, 20, 40].flatMap((start, index) => [start, start + 9].map(x => ({
    x, y: 10 + index, source: 'fmi', intervalStart: start, intervalEnd: start + 10,
  })));
  points.splice(6, 0, { x: 30, y: null });
  const original = structuredClone(points), knots = temperatureIntervalKnots(points);
  assert.deepEqual(knots.map(point => point.x), [0, 10, 20, 29, 30, 40, 49]);
  assert(knots.every(point => points.includes(point)));
  assert.deepEqual(points, original);
  const chart = createChart(t, { outdoor_forecast: points }, 'power');
  const index = chart.data.datasets.findIndex(dataset => dataset.key === 'outdoor_forecast');
  assert.equal(chart.getDatasetMeta(index).dataset.segments.length, 2);
  assert.deepEqual(chart.data.datasets[index].data, knots);
});
