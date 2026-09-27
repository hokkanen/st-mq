import test from 'node:test';
import assert from 'node:assert/strict';
import { CHART_VIEWS, CHART_VIEW_BY_KEY, selectedChartView, chartSelectionKey,
  readChartPreferences, chartViewPreferences, setChartVisibility, chartSubjectAvailability } from '../chart/chart-views.js';
import { HISTORY_AXES, MODEL_COEFFICIENT_INFO, SIGNAL_INFO, MODEL_INPUT_INFO, GARAGE_INPUT_INFO } from '../src/domain/history-series.js';
import { EXPLORER_SERIES_BY_KEY, filterExplorerSeries } from '../chart/series-explorer.js';
import { chartQuery, historyDatasets, createChartLoader } from '../chart/history-model.js';
import { historyValueScales } from '../chart/history-chart.js';

const blank = () => readChartPreferences({ getItem: () => null });

test('view catalogue covers every original signal through a view or searchable explorer without invalid units', () => {
  const supported = new Set(HISTORY_AXES.flatMap(axis => axis.signals));
  const definitions = { ...SIGNAL_INFO, ...MODEL_INPUT_INFO, ...GARAGE_INPUT_INFO };
  assert.equal(new Set(CHART_VIEWS.map(view => view.key)).size, CHART_VIEWS.length);
  for (const view of CHART_VIEWS) {
    assert.equal(new Set([...view.leftSignals, ...view.rightSignals]).size, view.leftSignals.length + view.rightSignals.length, view.key);
    for (const signal of [...view.leftSignals, ...view.rightSignals]) assert(supported.has(signal), `${view.key}: ${signal}`);
    for (const signal of view.rightSignals) assert.equal(definitions[signal]?.unit ?? EXPLORER_SERIES_BY_KEY[signal]?.unit, '°C', `${view.key}: ${signal} on temperature axis`);
    for (const key of Object.keys(view.defaults)) assert([...view.leftSignals, ...view.rightSignals, ...view.tracks].includes(key));
  }
  for (const signal of supported) assert(EXPLORER_SERIES_BY_KEY[signal], signal);
  for (const key of Object.keys(MODEL_COEFFICIENT_INFO)) assert(CHART_VIEW_BY_KEY[key], 'Incompatible coefficients keep separate views');
  const garage = CHART_VIEW_BY_KEY.garage;
  assert(garage.rightSignals.includes('garage_native_indoor_temperature'));
  assert.equal(garage.defaults.garage_native_indoor_temperature, false);
  assert(filterExplorerSeries('interpreted pump').some(row => row.key === 'garage_native_indoor_temperature'));
  assert.deepEqual(CHART_VIEW_BY_KEY.temperatures.rightSignals.filter(key => ['indoor_temperature','bedroom_temperature','downstairs_temperature','garage_temperature','garage_temperature_2'].includes(key)).sort(),
    ['indoor_temperature','bedroom_temperature','downstairs_temperature','garage_temperature','garage_temperature_2'].sort());
});

test('series choices belong to each view and price visibility remains global across switches and resets', () => {
  const preferences = blank(), power = selectedChartView({ view: 'power' }), garage = selectedChartView({ view: 'garage' });
  setChartVisibility(preferences, power, 'outdoor_temperature', false);
  setChartVisibility(preferences, garage, 'outdoor_temperature', true);
  setChartVisibility(preferences, garage, 'garage_native_indoor_temperature', true);
  setChartVisibility(preferences, power, 'spot_price', false);
  assert.equal(chartViewPreferences(power, preferences).outdoor_temperature, false);
  assert.equal(chartViewPreferences(garage, preferences).outdoor_temperature, true);
  assert.equal(chartViewPreferences(garage, preferences).garage_native_indoor_temperature, true);
  assert.equal(chartViewPreferences(garage, preferences).spot_price, false);
  delete preferences.views.garage;
  assert.equal(chartViewPreferences(garage, preferences).garage_native_indoor_temperature, false);
  assert.equal(chartViewPreferences(garage, preferences).spot_price, false);
  const restored = readChartPreferences({ getItem: () => JSON.stringify(preferences) });
  assert.deepEqual(restored, preferences);
  assert.deepEqual(readChartPreferences({ getItem() { throw Error('Storage denied'); } }), blank());
  assert.deepEqual(readChartPreferences({ getItem: () => '{' }), blank());
});

test('view requests and series requests have distinct cache identities and reject mixed selectors', async () => {
  const range = { startDate: '2026-09-07', endDate: '2026-09-07' };
  assert.match(chartQuery({ ...range, view: 'garage' }), /view=garage/);
  assert.doesNotMatch(chartQuery({ ...range, view: 'garage' }), /left=/);
  assert.match(chartQuery({ ...range, left: 'garage_native_indoor_temperature' }), /left=garage_native/);
  assert.throws(() => chartQuery({ ...range, view: 'not-a-view' }));
  assert.throws(() => chartQuery({ ...range, view: 'power', left: 'power' }));
  assert.notEqual(chartSelectionKey({ view: 'power' }), chartSelectionKey({ left: 'property_power', series: 'property_power' }));
  let calls = 0;
  const loader = createChartLoader({ api: async path => ({ path, call: ++calls }) });
  const view = await loader.load({ ...range, view: 'power' });
  const raw = await loader.load({ ...range, left: 'power' });
  assert.notEqual(view.path, raw.path);
  assert.equal((await loader.load({ ...range, view: 'power' })).call, view.call);
  assert.equal(calls, 2); loader.close();
});

test('temperature-led views have one temperature scale and right-side data counts as the subject', () => {
  const view = selectedChartView({ view: 'temperatures' }), preferences = chartViewPreferences(view, blank());
  const datasets = historyDatasets({ bedroom_temperature: [{ x: 0, y: 21 }], spot_price: [{ x: 0, y: -35 }] }, view, preferences);
  assert(datasets.every(dataset => dataset.yAxisID === 'right'));
  const scales = historyValueScales(view, datasets);
  assert.equal(scales.left.display, false);
  assert.equal(scales.right.grid.drawOnChartArea, true);
  assert.equal(chartSubjectAvailability(view, datasets, {}, preferences), '');
  const empty = historyDatasets({ spot_price: [{ x: 0, y: -35 }] }, view, preferences);
  assert.match(chartSubjectAvailability(view, empty, {}, preferences), /No recorded values/);
  const garage = selectedChartView({ view: 'garage' });
  assert.equal(chartSubjectAvailability(garage, [], { series: { garage_door1_open: [{ x: 0, y: 0 }] } }, chartViewPreferences(garage, blank())), '');
});

test('water views use the appropriate temperatures, preserve hidden integral, and never substitute property context', () => {
  const view = selectedChartView({ view: 'heating_water' }), preferences = chartViewPreferences(view, blank());
  preferences.heating_integral = false;
  const datasets = historyDatasets({ supply_temperature: [{ x: 0, y: 32 }] }, view, preferences);
  assert.equal(historyValueScales(view, datasets).left.display, false);
  assert(!datasets.some(dataset => dataset.key === 'garage_temperature'));
  assert.equal(chartSubjectAvailability(view, datasets, {}, preferences), '');
  assert.equal(datasets.find(dataset => dataset.key === 'heating_setpoint').stepped, false);
  assert.deepEqual(datasets.find(dataset => dataset.key === 'supply_temperature').borderDash, [6, 4]);
});

test('stored per-view fields cannot override global price choices', () => {
  const preferences = readChartPreferences({ getItem: () => JSON.stringify({ views: { garage: { spot_price: false, garage_temperature: false } }, prices: { all_in_price: false } }) });
  const visibility = chartViewPreferences(selectedChartView({ view: 'garage' }), preferences);
  assert.equal(visibility.garage_temperature, false);
  assert.equal(visibility.all_in_price, false);
  assert.equal(visibility.spot_price, undefined);
});
