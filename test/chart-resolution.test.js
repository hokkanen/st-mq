import { CHART_VIEW_BY_KEY } from '../src/domain/chart-views.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chartDetailRequest, clipChartSeries, selectChartResolution } from '../chart/chart-resolution.js';
import { zoomView } from '../chart/chart-viewport.js';
import { historyDatasets } from '../chart/history-model.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const selection = { startDate: '2026-01-01', endDate: '2026-01-03', left: 'power', points: 800 };
const source = (from, to, points = 800, series = {}) => ({ range: { from, to }, points, series });
const width = payload => (payload.range.to - payload.range.from) / (payload.points ?? 800);

test('the first small zoom and every deeper view retain all loaded samples without another response', () => {
  const points = Array.from({ length: 8001 }, (_, index) => Object.freeze({
    x: index * MINUTE, y: index % 113 === 0 ? null : index % 2 ? index % 17 : 20 + index % 31,
    observedAt: index * MINUTE, source: 'synthetic-resolution-fixture', quality: ['estimated'],
  }));
  const overview = source(0, 8000 * MINUTE, 800, { property_power: points });
  let view = overview.range;
  for (const factor of [1.08, 1.08, 1.5, 2, 2, 4, 4]) {
    view = zoomView(view, overview.range, factor);
    const chosen = selectChartResolution(overview, [], view);
    assert.equal(chosen, overview, 'Pending or unavailable refinement keeps the already loaded source');
    const clipped = clipChartSeries(chosen.series, view).property_power;
    const inside = points.filter(point => point.x >= view.from && point.x <= view.to);
    assert.deepEqual(clipped.filter(point => point.x >= view.from && point.x <= view.to), inside);
    assert(inside.every(point => clipped.includes(point)), 'Original points and their metadata survive by identity');
    if (factor === 1.08) assert(clipped.length > 6800, 'A small zoom cannot collapse thousands of samples to a drawing budget');
  }
  assert.equal(points.length, 8001, 'Repeated clipping does not mutate the loaded response');
});

test('clipping preserves duplicate step edges, explicit missing runs and both neighboring groups', () => {
  const points = [
    { x: 0, y: 1 }, { x: 10, y: 1 }, { x: 10, y: 2 },
    { x: 20, y: null, quality: ['missing'] }, { x: 20, y: 3 },
    { x: 30, y: 3 }, { x: 30, y: 4 }, { x: 40, y: null }, { x: 50, y: 5 },
  ];
  const original = structuredClone(points);
  const clipped = clipChartSeries({ property_power: points, charger_power: [], events: [{ x: 20, y: 7, modelInput: true }] }, { from: 11, to: 29 });
  assert.deepEqual(clipped.property_power, points.slice(1, 7));
  assert(clipped.property_power.every((point, index) => point === points[index + 1]));
  assert.deepEqual(clipped.charger_power, []);
  assert.deepEqual(clipped.events, [{ x: 20, y: 7, modelInput: true }]);
  assert.deepEqual(points, original);
});

test('clipping keeps power and phase cohorts intact, including genuine violations and source provenance', () => {
  const power = ['property_power', 'auxiliary_power', 'charger_power', 'charger2_power'];
  const phases = ['property', 'ev1'].flatMap(prefix => [1, 2, 3].map(phase => `${prefix}_current_l${phase}`));
  const times = [0, 10, 10, 20, 20, 30, 40, 50];
  const series = Object.fromEntries([...power, ...phases].map((key, component) => [key, times.map((x, index) => ({
    x, y: index === 3 ? null : key === 'property_power' ? (index === 5 ? 2 : 20)
      : key === 'auxiliary_power' ? 2 : key === 'charger_power' ? 4 : key === 'charger2_power' ? 3
        : key.startsWith('property') ? 15 : 7,
    observedAt: x, intervalStart: x, intervalEnd: x + 10, source: `synthetic-${component}`, quality: ['fixture'],
  }))]));
  const original = structuredClone(series), clipped = clipChartSeries(series, { from: 11, to: 39 });
  for (const key of [...power, ...phases]) {
    assert.deepEqual(clipped[key], series[key].slice(1, 7));
    assert(clipped[key].every((point, index) => point === series[key][index + 1]));
  }
  const datasets = historyDatasets(clipped, CHART_VIEW_BY_KEY.power);
  const top = datasets.find(dataset => dataset.key === 'charger2_power');
  assert.equal(top.data.find(point => point.x === 30).y, 7, 'A true charging sum above the source total remains visible');
  assert.equal(datasets.find(dataset => dataset.key === 'property_power').data.find(point => point.x === 30).y, 2);
  assert(top.data.some(point => point.x === 20 && point.y === null), 'A shared missing edge cannot be bridged');
  assert.deepEqual(series, original);
});

test('source selection uses the finest whole covering response and never downgrades for a deeper view', () => {
  const overview = source(0, 1000 * MINUTE);
  const broad = source(100 * MINUTE, 900 * MINUTE, 800);
  const fine = source(300 * MINUTE, 700 * MINUTE, 1600);
  const laterCoarse = source(250 * MINUTE, 750 * MINUTE, 200);
  const tiny = source(490 * MINUTE, 510 * MINUTE, 8000);
  for (const view of [{ from: 350 * MINUTE, to: 650 * MINUTE }, { from: 450 * MINUTE, to: 550 * MINUTE }]) {
    assert.equal(selectChartResolution(overview, [broad, fine, laterCoarse, tiny], view), fine);
  }
  assert.equal(selectChartResolution(overview, [fine, broad], { from: 200 * MINUTE, to: 800 * MINUTE }), broad);
  assert.equal(selectChartResolution(overview, [fine, broad], { from: 0, to: 1000 * MINUTE }), overview);
  assert.equal(selectChartResolution(overview, [fine, broad], { from: 350 * MINUTE, to: 650 * MINUTE }), fine,
    'Panning away and back recovers the finer cached covering source');
});

test('equal resolutions prefer the freshest candidate and sub-minute samples retain their precision', () => {
  const overview = source(0, 10 * MINUTE);
  delete overview.points;
  const old = source(2 * MINUTE, 8 * MINUTE, 1200);
  const fresh = source(2 * MINUTE, 8 * MINUTE, 1200);
  const coarse = source(2 * MINUTE, 8 * MINUTE, 600);
  const view = { from: 3 * MINUTE, to: 7 * MINUTE };
  assert(width(overview) < MINUTE && width(old) < MINUTE);
  assert.equal(selectChartResolution(overview, [old, fresh, coarse], view), fresh,
    'A one-minute floor would incorrectly let the later coarse response replace finer samples');
  assert.equal(selectChartResolution(overview, [coarse], view), coarse, 'An overview without points uses the default 800');
});

test('detail requests preserve initial resolution and can refine before a twofold zoom', () => {
  const bounds = { from: 0, to: 64 * HOUR }, overview = source(bounds.from, bounds.to);
  assert.equal(chartDetailRequest(selection, bounds, bounds, overview), null);
  const small = zoomView(bounds, bounds, 1.08);
  assert.equal(chartDetailRequest(selection, bounds, small, overview), null,
    'A buffered first zoom with no finer resolution keeps its complete loaded overview');
  const view = { from: 0, to: 34 * HOUR };
  assert((bounds.to - bounds.from) / (view.to - view.from) < 2);
  const request = chartDetailRequest(selection, bounds, view, overview);
  assert(request, 'A request that improves resolution need not wait for a twofold zoom');
  assert.equal(request.points, selection.points);
  assert.equal(request.startDate, selection.startDate); assert.equal(request.endDate, selection.endDate);
  assert.equal(request.left, selection.left);
  assert(request.viewFrom >= bounds.from && request.viewTo <= bounds.to);
  assert(request.viewFrom <= view.from && request.viewTo >= view.to);
  assert((request.viewTo - request.viewFrom) / request.points <= width(overview) * 0.8);
});

test('refinement compares with the finest available source and never requests a coarser replacement', () => {
  const bounds = { from: 0, to: 64 * HOUR }, overview = source(bounds.from, bounds.to);
  const view = { from: 28 * HOUR, to: 36 * HOUR };
  const first = chartDetailRequest(selection, bounds, view, overview);
  assert(first);
  const loaded = source(first.viewFrom, first.viewTo, first.points);
  assert.equal(chartDetailRequest(selection, bounds, view, loaded), null, 'The existing detail does not request itself again');
  const finer = source(first.viewFrom, first.viewTo, first.points * 4);
  assert.equal(chartDetailRequest(selection, bounds, view, finer), null, 'A coarser fixed-size response cannot replace finer cached data');
  const deeper = { from: 31 * HOUR, to: 33 * HOUR };
  const request = chartDetailRequest(selection, bounds, deeper, loaded);
  assert(request);
  assert((request.viewTo - request.viewFrom) / request.points <= width(loaded) * 0.8);
});

test('short-window refinement retains sub-minute density and defaults to the original 800 points', () => {
  const bounds = { from: 0, to: 10 * MINUTE }, view = { from: 3 * MINUTE, to: 4 * MINUTE };
  const { points, ...defaultSelection } = selection;
  const overview = source(bounds.from, bounds.to);
  const request = chartDetailRequest(defaultSelection, bounds, view, overview);
  assert(request); assert.equal(request.points, 800);
  const finer = source(bounds.from, bounds.to, 3200);
  assert.equal(chartDetailRequest(defaultSelection, bounds, view, finer), null);
});
