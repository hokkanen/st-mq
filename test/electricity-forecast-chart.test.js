import test from 'node:test';
import assert from 'node:assert/strict';
import { electricityForecastView } from '../src/app/electricity-forecast-view.js';
import { withElectricityForecast, createElectricityForecastLoader, PRICE_FORECAST_DASH } from '../chart/electricity-forecast.js';
import { prepareChartGeometry, styleChartGeometry } from '../chart/chart-geometry.js';
import { defaultPalette, chartLinePatterns } from '../chart/history-model.js';
import { historyTooltipLabel } from '../chart/history-tooltips.js';
import { dashboardProviders } from '../chart/provider-status.js';
import { familyRouteAllowed } from '../src/app/web-permissions.js';

const HOUR = 3_600_000, now = Date.parse('2026-10-08T12:00:00Z');
const contract = { periods: [{ from: '2026-01-01T00:00:00Z', marginCtPerKwh: 1, taxCtPerKwh: 2, vatRate: .2,
  tariff: 'day-night', transferRates: { vatIncluded: true, dayCtPerKwh: 3, nightCtPerKwh: 1,
    winterDayCtPerKwh: 4, otherCtPerKwh: 2 } }] };
const interval = (start, value) => ({ start, end: start + HOUR, nativeStart: start, nativeEnd: start + HOUR,
  nativeResolutionMinutes: 60, spotCtPerKwh: value, source: 'energypriceforecast', predicted: true, unit: 'c/kWh', vatIncluded: false });
const snapshot = () => ({ enabled: true, available: true, status: 'available', source: 'energypriceforecast',
  fetchedAt: now, generatedAt: now - 1000, modelUpdatedAt: now - HOUR, expiresAt: now + 2 * HOUR,
  intervals: [interval(now, 20), interval(now + HOUR, 0), interval(now + 3 * HOUR, -10)] });
const range = { from: now - HOUR, to: now + 6 * HOUR };

test('price chart forecasts append after official prices and preserve tariff, zero, negative and native-hour evidence', () => {
  const forecast = snapshot(), original = structuredClone(forecast);
  const official = [{ ...interval(now, 10), predicted: false }];
  const view = electricityForecastView({ forecast, official, contract, now });
  assert.equal(view.publishedThrough, now + HOUR);
  assert.deepEqual(view.intervals.map(row => row.spotCtPerKwh), [0, -10]);
  assert.equal(view.intervals[0].totalCtPerKwh, 6.6);
  assert.equal(view.intervals[1].totalCtPerKwh, -5.4);
  assert.deepEqual(forecast, original, 'Acquisition cache is never rewritten by presentation');
  const series = { spot_price: [{ x: now, y: 10, intervalEnd: now + HOUR },
    { x: now + HOUR - 1, y: 10, intervalEnd: now + HOUR }, { x: range.to, y: null }], all_in_price: [] };
  const recorded = structuredClone(series), displayed = withElectricityForecast(series, view, range, now);
  assert.deepEqual(series, recorded);
  assert.equal(displayed.spot_price.filter(point => point.priceForecast).length, 4);
  assert(displayed.spot_price.some(point => point.y === null && point.x === now + 3 * HOUR - 1), 'Unpriced gap stays blank');
  assert(displayed.spot_price.every((point, index, values) => !index || point.x >= values[index - 1].x));
  const first = displayed.spot_price.find(point => point.priceForecast);
  assert.equal(first.intervalEnd - first.intervalStart, HOUR);
  const label = historyTooltipLabel({ dataset: { key: 'spot_price', label: 'Spot price', unit: 'c/kWh' }, raw: first, parsed: first });
  assert.match(label, /Energy Price Forecast EU.*Forecast.*60-minute native prediction.*fetched/);
  assert.equal(withElectricityForecast(series, view, range, view.expiresAt), series, 'Expired cache never appears as history');
});

test('forecast keeps official price color, axis and toggle with distinctly sparser dots', () => {
  const view = electricityForecastView({ forecast: snapshot(), contract, now });
  const series = withElectricityForecast({ spot_price: [], all_in_price: [] }, view, range, now);
  const descriptor = { key: 'prices', leftSignals: [], rightSignals: ['spot_price', 'all_in_price'] };
  const geometry = prepareChartGeometry({ series, descriptor, visibility: {} });
  const datasets = styleChartGeometry(geometry, descriptor, {}, defaultPalette);
  assert.equal(datasets[0].borderColor, defaultPalette.spot);
  assert.equal(datasets[1].borderColor, defaultPalette.price);
  assert(datasets.every(row => row.yAxisID === 'right' && row.stepped === 'before'));
  for (const dataset of datasets) {
    assert.deepEqual(dataset.segment.borderDash({ p0: { raw: {} }, p1: { raw: {} } }), chartLinePatterns.price);
    assert.deepEqual(dataset.segment.borderDash({ p0: { raw: { priceForecast: true } }, p1: { raw: {} } }), PRICE_FORECAST_DASH);
    assert(PRICE_FORECAST_DASH[1] > chartLinePatterns.price[1]);
  }
  styleChartGeometry(geometry, descriptor, { spot_price: false }, defaultPalette);
  assert.equal(geometry[0].hidden, true);
});

test('forecast requires valid freshness and keeps missing all-in coverage unknown', () => {
  const forecast = snapshot();
  for (const unavailable of [{ ...forecast, available: false }, { ...forecast, expiresAt: now }, undefined])
    assert.deepEqual(electricityForecastView({ forecast: unavailable, contract, now }).intervals, []);
  const view = electricityForecastView({ forecast, contract: null, now });
  assert(view.intervals.every(row => row.totalCtPerKwh === null));
  const series = { spot_price: [], all_in_price: [] }, rendered = withElectricityForecast(series, view, range, now);
  assert(rendered.spot_price.length > 0);
  assert.deepEqual(rendered.all_in_price, []);
  assert.equal(withElectricityForecast(series, view, { from: now - 2 * HOUR, to: now }, now), series);
});

test('chart cache reads are single-flight, charger-independent, bounded and expire on status loss', async () => {
  let calls = 0, finish, clock = now;
  const forecast = snapshot();
  const loader = createElectricityForecastLoader({ clock: () => clock, api: async path => {
    assert.equal(path, '/api/electricity-forecast'); calls++;
    if (calls === 1) await new Promise(resolve => { finish = resolve; });
    return forecast;
  } });
  const status = { now, providers: { electricityForecast: forecast }, charging: { chargers: [] } };
  const a = loader.load(status), b = loader.load(status); finish();
  assert.deepEqual(await a, forecast); assert.deepEqual(await b, forecast); assert.equal(calls, 1);
  await loader.load(status); assert.equal(calls, 1);
  clock += 60_000; await loader.load(status); assert.equal(calls, 2);
  assert.equal(await loader.load({ providers: { electricityForecast: { enabled: true, available: false } } }), null);
  loader.close();
  assert.equal(familyRouteAllowed('GET', '/api/electricity-forecast'), true);
  assert.equal(familyRouteAllowed('POST', '/api/electricity-forecast'), false);
});

test('Electricity prices lists the independent feed without confusing official availability or replica evidence', () => {
  const status = { now, providers: { market: { status: 'ok', source: 'entsoe' }, electricityForecast: snapshot() } };
  const options = { now, formatTime: value => new Date(value).toISOString() };
  let group = dashboardProviders(status, options).find(row => row.key === 'market');
  assert.equal(group.display.state, 'Available');
  assert.equal(group.datasets.at(-1).label, '48-hour price forecast');
  assert.equal(group.datasets.at(-1).state, 'Available');
  assert.equal(group.datasets.at(-1).source, 'Energy Price Forecast EU');
  assert.equal(group.datasets.at(-1).sourceUrl, undefined);
  assert.deepEqual(group.sections.map(section => section.title), ['Prices', 'Price forecast']);
  assert.deepEqual(group.sections[0].datasets.map(row => row.signals[0]), ['spot_price', 'all_in_price']);
  assert.deepEqual(group.sections[1].datasets, [group.datasets.at(-1)]);
  assert.match(group.sections[1].description, /Hourly estimates.*charging flexibility.*Recorded costs and heating use published prices/);
  assert.equal(group.datasets.at(-1).description, undefined, 'Description belongs to the section heading');
  assert.equal(group.datasets.at(-1).reported,
    `Fetched ${options.formatTime(now)} (just now) · Model updated ${options.formatTime(now - HOUR)} (1 h ago)`);
  status.providers.electricityForecast.available = false;
  group = dashboardProviders(status, options).find(row => row.key === 'market');
  assert.equal(group.display.state, 'Available');
  assert.equal(group.datasets.at(-1).state, 'Unavailable');
  status.readOnly = true;
  group = dashboardProviders(status, options).find(row => row.key === 'market');
  assert.equal(group.datasets.at(-1).state, 'Unavailable on this replica');
  assert.equal(group.datasets.at(-1).reported, null, 'Transient forecast clocks are not evidence on a replica');
});

test('disabled forecast fences late responses even when transport ignores cancellation', async () => {
  let finish;
  const forecast = snapshot(), status = { providers: { electricityForecast: forecast } };
  const loader = createElectricityForecastLoader({ clock: () => now,
    api: () => new Promise(resolve => { finish = resolve; }) });
  const pending = loader.load(status);
  assert.equal(await loader.load({ providers: { electricityForecast: { enabled: false } } }), null);
  finish(forecast);
  assert.equal(await pending, null);
  loader.close();
});
