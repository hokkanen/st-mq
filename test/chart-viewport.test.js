import { CHART_VIEW_BY_KEY } from '../src/domain/chart-views.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampView, zoomView, panView, viewportTicks, sliceSeries, reduceSeries, createDetailLoader } from '../chart/chart-viewport.js';
import { historyDatasets } from '../chart/history-model.js';

const minute = 60_000;
const bounds = { from: 0, to: 100 * minute };
const finnishTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const finnishDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' });

test('zoom anchors and pan preserve the fixed date window and minimum span', () => {
  assert.deepEqual(zoomView(bounds, bounds, 2, 0), { from: 0, to: 50 * minute });
  assert.deepEqual(zoomView(bounds, bounds, 2, 1), { from: 50 * minute, to: 100 * minute });
  const view = { from: 20 * minute, to: 40 * minute };
  assert.deepEqual(panView(view, bounds, -10), { from: 0, to: 20 * minute });
  assert.deepEqual(panView(view, bounds, 10), { from: 80 * minute, to: 100 * minute });
  assert.deepEqual(zoomView(view, bounds, 0.001), bounds);
  assert.deepEqual(zoomView(view, bounds, 100_000, 0), { from: 20 * minute, to: 21 * minute });
  assert.deepEqual(clampView({ from: -minute, to: 5 * minute }, bounds), { from: 0, to: 6 * minute });
  assert.deepEqual(clampView({ from: 4, to: 5 }, { from: 1, to: 10 }), { from: 1, to: 10 });
  assert.deepEqual(zoomView(view, bounds, NaN), view);
  assert.deepEqual(clampView({ from: NaN, to: 4 }, bounds), bounds);
  assert.throws(() => clampView(view, { from: 10, to: 5 }), RangeError);
});

test('repeated zoom and pan cannot escape a multi-year selection', () => {
  const range = { from: Date.parse('2023-01-01T00:00Z'), to: Date.parse('2026-01-01T00:00Z') };
  let view = range;
  for (let index = 0; index < 200; index++) {
    view = zoomView(view, range, index % 7 ? 1.3 : 0.2, (index % 5) / 4);
    view = panView(view, range, index % 2 ? 0.7 : -2);
    assert(view.from >= range.from && view.to <= range.to);
    assert(view.to - view.from >= minute);
  }
  assert.deepEqual(zoomView(view, range, 1e-10), range);
});

test('minute and hour viewport ticks stay ordered and bounded through Finnish DST', () => {
  for (const view of [
    { from: Date.parse('2026-09-10T08:02:12Z'), to: Date.parse('2026-09-10T08:17:12Z') },
    { from: Date.parse('2026-03-28T22:00Z'), to: Date.parse('2026-03-29T21:00Z') },
    { from: Date.parse('2026-10-24T21:00Z'), to: Date.parse('2026-10-25T22:00Z') },
  ]) {
    const ticks = viewportTicks(view, 9);
    assert.equal(ticks[0].value, view.from); assert.equal(ticks.at(-1).value, view.to);
    assert(ticks.length <= 9);
    assert(ticks.slice(1).every((tick, index) => tick.value > ticks[index].value));
    assert(ticks.slice(1, -1).every(tick => tick.value % minute === 0));
    if (view.to - view.from > 60 * minute) assert(ticks.every(tick => finnishTime.format(tick.value).endsWith(':00')));
  }
});

test('long-view ticks advance by local days, months and years without fixed-duration calendar drift', () => {
  for (const [from, to, count, alignment] of [
    ['2026-03-27T22:00Z', '2026-04-03T21:00Z', 9, 'day'],
    ['2026-01-01T10:00Z', '2027-01-01T10:00Z', 9, 'month'],
    ['2020-01-01T10:00Z', '2030-01-01T10:00Z', 9, 'year'],
  ]) {
    const view = { from: Date.parse(from), to: Date.parse(to) };
    const ticks = viewportTicks(view, count);
    assert(ticks.length >= 3 && ticks.length <= count);
    for (const tick of ticks.slice(1, -1)) {
      assert.equal(finnishTime.format(tick.value), '00:00');
      const date = finnishDay.format(tick.value);
      if (alignment === 'month') assert(date.endsWith('-01'));
      if (alignment === 'year') assert(date.endsWith('-01-01'));
    }
  }
  assert.deepEqual(viewportTicks({ from: 10, to: 9 }), []);
  assert.deepEqual(viewportTicks({ from: 0, to: minute }, 2), [{ value: 0 }, { value: minute }]);
});

test('calendar ticks leave room beside exact endpoints in preview and settled chart widths', () => {
  const view = { from: Date.parse('2026-06-30T21:00Z'), to: Date.parse('2026-09-10T21:00Z') };
  assert.deepEqual(viewportTicks(view, 9).map(tick => finnishDay.format(tick.value)), [
    '2026-07-01', '2026-07-16', '2026-07-30', '2026-08-13', '2026-08-27', '2026-09-11',
  ]);
  // Preview uses 4/8 ticks, settled charts 5/9. Long calendar labels must
  // not acquire an extra nearly coincident label next to either endpoint.
  for (const maxTicks of [4, 5, 8, 9]) {
    for (const range of [view, { from: Date.parse('2023-12-30T22:00Z'), to: Date.parse('2027-01-02T22:00Z') }]) {
      const ticks = viewportTicks(range, maxTicks);
      const wanted = (range.to - range.from) / (maxTicks - 1);
      assert.equal(ticks[0].value, range.from); assert.equal(ticks.at(-1).value, range.to);
      assert(ticks.length <= maxTicks);
      assert(ticks[1].value - range.from >= wanted);
      assert(range.to - ticks.at(-2).value >= wanted);
      assert(ticks.slice(1, -1).every(tick => finnishTime.format(tick.value) === '00:00'));
    }
  }
});

test('series clipping preserves all duplicate boundary edges, neighbors and metadata', () => {
  const points = [0, 1, 1, 2, 2, 3, 3, 4, 4, 5].map((x, index) => ({ x, y: index, source: 'fixture', intervalStart: x }));
  const clipped = sliceSeries(points, { from: 2, to: 3 });
  assert.deepEqual(clipped.map(point => point.x), [1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(clipped[0], points[1]);
  assert.deepEqual(sliceSeries(points, { from: 2.1, to: 2.9 }).map(point => point.x), [2, 2, 3, 3]);
  assert.deepEqual(sliceSeries(points, { from: 20, to: 21 }), [points.at(-1)]);
  assert.deepEqual(sliceSeries(points, { from: -2, to: -1 }), [points[0]]);
  assert.deepEqual(sliceSeries([], bounds), []);
});

test('display reduction keeps peaks, original provenance and every omitted gap disconnected', () => {
  const points = Array.from({ length: 1200 }, (_, x) => ({ x, y: x % 31 === 0 ? null : Math.sin(x / 70), source: 'fixture', observationId: `point-${x}` }));
  points[125].y = 100; points[300].y = -100;
  const before = structuredClone(points);
  const reduced = reduceSeries(points, { from: 0, to: 1199 }, 84);
  assert(reduced.length <= 84);
  assert(reduced.includes(points[125])); assert(reduced.includes(points[300]));
  assert.equal(reduced[0], points[0]); assert.equal(reduced.at(-1), points.at(-1));
  assert(reduced.every(point => points.includes(point)));
  for (let index = 1; index < reduced.length; index++) {
    if (!Number.isFinite(reduced[index - 1].y) || !Number.isFinite(reduced[index].y)) continue;
    const between = points.slice(reduced[index - 1].x + 1, reduced[index].x);
    assert(between.every(point => Number.isFinite(point.y)), 'A display segment cannot cross an omitted outage');
  }
  assert.deepEqual(points, before);
  for (let budget = 0; budget < 20; budget++) assert(reduceSeries(points, { from: 0, to: 1199 }, budget).length <= budget);
});

test('small series keep exact step edges and recording gaps without reduction', () => {
  const points = [{ x: 0, y: -2 }, { x: 10, y: -2 }, { x: 10, y: 4 }, { x: 20, y: 4 }, { x: 20, y: null }];
  assert.deepEqual(reduceSeries(points, { from: 0, to: 20 }), points);
});

test('reducing raw power components before stacking preserves aligned fills, missing baselines and tooltip provenance', () => {
  const keys = ['charger_power', 'charger2_power'];
  const series = Object.fromEntries(keys.map((key, component) => [key, Array.from({ length: 500 }, (_, index) => ({
    x: index * 10 + component,
    y: index >= 130 && index < 150 && component === 0 ? null : component + 1 + (index % 11) / 10,
    source: `fixture-component-${component}`, observedAt: index * 10 + component,
    intervalStart: index * 10 + component, intervalEnd: (index + 1) * 10 + component,
  }))]));
  const before = structuredClone(series);
  const reduced = Object.fromEntries(Object.entries(series).map(([key, points]) => [key, reduceSeries(points, { from: 0, to: 5000 }, 70)]));
  const datasets = historyDatasets(reduced, CHART_VIEW_BY_KEY.power).filter(dataset => keys.includes(dataset.key));
  const ordered = keys.map(key => datasets.find(dataset => dataset.key === key));
  assert(!ordered[0].powerStacked && ordered[1].powerStacked);
  assert.deepEqual(ordered[1].data.map(point => point.x), ordered[0].data.map(point => point.x));
  const firstGap = ordered[0].data.findIndex(point => point.x >= 1300 && point.x < 1500);
  assert(firstGap >= 0);
  assert(ordered.every(dataset => dataset.data.slice(firstGap).filter(point => point.x < 1500).every(point => point.y === null)));
  for (const [component, dataset] of ordered.entries()) {
    for (const point of dataset.data) {
      if (!Number.isFinite(point.y)) continue;
      const recorded = series[dataset.key].find(candidate => candidate.observedAt === point.observedAt);
      assert(recorded, 'Every known stacked component refers to an original recorded point');
      assert.equal(component === 0 ? point.y : point.componentValue, recorded.y);
      assert.equal(point.source, recorded.source);
      assert.equal(point.intervalStart, recorded.intervalStart); assert.equal(point.intervalEnd, recorded.intervalEnd);
      if (component) assert(Number.isFinite(ordered[component - 1].data.find(candidate => candidate.x === point.x)?.y));
    }
  }
  assert.deepEqual(series, before);
});

function detailFixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [], displayed = [], statuses = [];
  const loader = createDetailLoader({
    api: (path, { signal }) => new Promise((resolve, reject) => calls.push({ path, signal, resolve, reject })),
    query: selection => `/api/chart?${new URLSearchParams(selection)}`,
    onData: (data, selection) => displayed.push({ data, selection }),
    onStatus: (status, error) => statuses.push({ status, error }),
    ...options,
  });
  t.after(() => loader.close());
  return { loader, calls, displayed, statuses };
}
const selection = { startDate: '2023-01-01', endDate: '2026-01-01', left: 'power', from: 100, to: 200, points: 400 };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('detail loader debounces gestures and keeps only the latest pending view without aborting active work', async t => {
  const { loader, calls, displayed, statuses } = detailFixture(t);
  loader.request(selection);
  t.mock.timers.tick(100);
  loader.request({ ...selection, from: 110 });
  t.mock.timers.tick(179); assert.equal(calls.length, 0);
  t.mock.timers.tick(1); assert.equal(calls.length, 1);
  loader.request({ ...selection, from: 120 });
  loader.request({ ...selection, from: 130 });
  t.mock.timers.tick(180);
  assert.equal(calls.length, 1); assert.equal(calls[0].signal.aborted, false);
  calls[0].resolve('stale detail'); await flush();
  assert.equal(displayed.length, 0); assert.equal(calls.length, 2);
  assert(calls[1].path.includes('from=130'));
  assert.equal(statuses.at(-1).status, 'loading');
  calls[1].resolve('latest detail'); await flush();
  assert.deepEqual(displayed.map(item => item.data), ['latest detail']);
  assert.equal(statuses.at(-1).status, 'idle');
});

test('detail loader reuses stale-view results when revisited, with date, axis, resolution and TTL separation', async t => {
  let now = 1000;
  const { loader, calls, displayed } = detailFixture(t, { now: () => now, ttl: 1000 });
  loader.request(selection); t.mock.timers.tick(180);
  loader.request({ ...selection, from: 150 }); t.mock.timers.tick(180);
  calls[0].resolve('first'); await flush();
  calls[1].resolve('second'); await flush();
  loader.request({ ...selection });
  assert.equal(calls.length, 2); assert.equal(displayed.at(-1).data, 'first');
  for (const alternate of [{ points: 800 }, { left: 'phases' }, { endDate: '2026-02-01' }]) {
    loader.request({ ...selection, ...alternate }); t.mock.timers.tick(180);
    calls.at(-1).resolve('different'); await flush();
  }
  assert.equal(calls.length, 5);
  now += 1000;
  loader.request(selection); t.mock.timers.tick(180);
  assert.equal(calls.length, 6);
});

test('detail loader does not duplicate identical in-flight requests or apply a stale failure', async t => {
  const { loader, calls, displayed, statuses } = detailFixture(t);
  loader.request(selection); t.mock.timers.tick(180);
  loader.request({ ...selection }); t.mock.timers.tick(180);
  assert.equal(calls.length, 1);
  loader.request({ ...selection, from: 150 }); t.mock.timers.tick(180);
  calls[0].reject(new Error('Earlier request failed')); await flush();
  assert.equal(statuses.at(-1).status, 'loading');
  calls[1].reject(new Error('Current request failed')); await flush();
  assert.equal(statuses.at(-1).status, 'error'); assert.equal(displayed.length, 0);
  loader.request({ ...selection, from: 150 }); t.mock.timers.tick(180);
  calls[2].resolve('retry'); await flush();
  assert.equal(displayed.at(-1).data, 'retry'); assert.equal(statuses.at(-1).status, 'idle');
});

test('detail loader invalidation and close reject late completion, cancel timers and abort requests', async t => {
  const { loader, calls, displayed, statuses } = detailFixture(t);
  loader.request(selection); t.mock.timers.tick(180);
  loader.request({ ...selection, from: 150 });
  loader.invalidate(); assert.equal(calls[0].signal.aborted, true);
  t.mock.timers.tick(180); assert.equal(calls.length, 1);
  loader.request(selection); t.mock.timers.tick(180);
  calls[0].resolve('invalidated'); await flush(); assert.equal(displayed.length, 0);
  calls[1].resolve('fresh'); await flush(); assert.equal(displayed.at(-1).data, 'fresh');
  loader.request({ ...selection, from: 150 }); t.mock.timers.tick(180);
  loader.close(); assert.equal(calls[2].signal.aborted, true);
  const statusCount = statuses.length;
  calls[2].resolve('closed'); loader.request(selection); t.mock.timers.tick(1000); await flush();
  assert.equal(displayed.length, 1); assert.equal(calls.length, 3); assert.equal(statuses.length, statusCount);
});

test('returning to overview cancels pending interest without aborting active work or losing its cache result', async t => {
  const { loader, calls, displayed, statuses } = detailFixture(t);
  loader.request(selection); t.mock.timers.tick(180);
  loader.request({ ...selection, from: 150 });
  loader.request(null);
  assert.equal(statuses.at(-1).status, 'idle'); assert.equal(calls[0].signal.aborted, false);
  t.mock.timers.tick(180); assert.equal(calls.length, 1);
  calls[0].resolve('cached detail'); await flush();
  assert.equal(displayed.length, 0); assert.equal(calls.length, 1); assert.equal(statuses.at(-1).status, 'idle');
  loader.request(selection);
  assert.equal(displayed[0].data, 'cached detail'); assert.equal(calls.length, 1);
  loader.request({ ...selection, from: 150 });
  loader.request(null); t.mock.timers.tick(1000);
  assert.equal(calls.length, 1); assert.equal(statuses.at(-1).status, 'idle');
});

test('detail cache has bounded entries and snapshots mutable selections before request dispatch', async t => {
  const { loader, calls, displayed } = detailFixture(t, { maxEntries: 2 });
  const mutable = { ...selection };
  loader.request(mutable); mutable.points = 9000; t.mock.timers.tick(180);
  calls[0].resolve('first'); await flush(); assert.equal(displayed[0].selection.points, 400);
  for (const from of [110, 120]) {
    loader.request({ ...selection, from }); t.mock.timers.tick(180);
    calls.at(-1).resolve(from); await flush();
  }
  loader.request(selection); t.mock.timers.tick(180); assert.equal(calls.length, 4);
});

test('detail entries expose fresh responses in fetch order, independently of cache access order', async t => {
  let now = 1000;
  const { loader, calls } = detailFixture(t, { now: () => now, ttl: 1000 });
  assert.deepEqual(loader.entries(), []);
  loader.request(selection); t.mock.timers.tick(180);
  calls[0].resolve('older response'); await flush();
  now += 10;
  const next = { ...selection, from: 110 };
  loader.request(next); t.mock.timers.tick(180);
  calls[1].resolve('newer response'); await flush();
  loader.request(selection);
  assert.equal(calls.length, 2);
  assert.deepEqual(loader.entries(), [
    { data: 'older response', selection }, { data: 'newer response', selection: next },
  ], 'Reading an older cached view cannot make it newer than a later fetched response');
  now = 2000;
  assert.deepEqual(loader.entries(), [{ data: 'newer response', selection: next }]);
  now = 2010;
  assert.deepEqual(loader.entries(), [], 'Expired responses cannot compete in resolution selection');
});

test('unwanted successful detail warms entries but errors and invalidated completions cannot restore old data', async t => {
  const { loader, calls, displayed } = detailFixture(t);
  loader.request(selection); t.mock.timers.tick(180);
  loader.request(null);
  calls[0].resolve('cached while zoomed out'); await flush();
  assert.equal(displayed.length, 0);
  assert.deepEqual(loader.entries(), [{ data: 'cached while zoomed out', selection }]);
  const finer = { ...selection, points: 800 };
  loader.request(finer); t.mock.timers.tick(180);
  calls[1].reject(new Error('Refinement unavailable')); await flush();
  assert.deepEqual(loader.entries(), [{ data: 'cached while zoomed out', selection }],
    'A failed refinement leaves the existing loaded resolution available');
  loader.request(finer); t.mock.timers.tick(180);
  loader.invalidate();
  assert.deepEqual(loader.entries(), []);
  loader.request(selection); t.mock.timers.tick(180);
  calls[2].resolve('old source generation'); await flush();
  assert.deepEqual(loader.entries(), []);
  calls[3].resolve('fresh same-window readings'); await flush();
  assert.deepEqual(loader.entries(), [{ data: 'fresh same-window readings', selection }]);
  assert.deepEqual(displayed.map(entry => entry.data), ['fresh same-window readings']);
  loader.close(); assert.deepEqual(loader.entries(), []);
});
