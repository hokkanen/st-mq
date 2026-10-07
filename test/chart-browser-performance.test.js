import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { chartLoadingLabel, readChartResponse } from '../chart/chart-stream.js';
import { fetchChartResponse } from '../chart/chart-request.js';
import { chartPrefetchSelection, createChartLoader, defaultPalette } from '../chart/history-model.js';
import { selectedChartView } from '../chart/chart-views.js';
import { chartGeometryKey, prepareChartGeometry, styleChartGeometry } from '../chart/chart-geometry.js';
import { createChartGeometryCache } from '../chart/chart-geometry-cache.js';
import { historyRenderFingerprint } from '../chart/history-chart.js';
import { rememberChartResponseSize } from '../chart/chart-response-size.js';

const selection = { startDate: '2026-09-01', endDate: '2026-09-07', view: 'power', points: 800 };
const data = () => ({ series: { property_power: [{ x: 1, y: 3 }, { x: 2, y: null }] } });

test('progress is scoped to measurable source work; stage-only updates do not invent a percentage', () => {
  assert.equal(chartLoadingLabel({ stage: 'reading-history', completed: 1, total: 100 }), 'Loading · Reading history 1%');
  assert.equal(chartLoadingLabel({ stage: 'reading-history', completed: 100, total: 100 }), 'Loading · Reading history 100%');
  assert.equal(chartLoadingLabel({ stage: 'preparing-chart' }), 'Loading · Preparing chart…');
  for (const total of [undefined, 0, -1, Infinity]) assert.doesNotMatch(chartLoadingLabel({ stage: 'reading-history', completed: 1, total }), /%/);
  assert.doesNotMatch(chartLoadingLabel({ completed: 2, total: 1 }), /%/);
});

test('chart stream survives split UTF8 and chunk boundaries and rejects unfinished or failed results', async () => {
  const rows = [{ type: 'progress', stage: 'reading-history', completed: 2, total: 7 },
    { type: 'progress', stage: 'preparing-chart' }, { type: 'result', data: { label: '°C', ...data() } }];
  const encoded = new TextEncoder().encode(rows.map(row => JSON.stringify(row)).join('\n'));
  let at = 0;
  const stream = new ReadableStream({ pull(controller) {
    if (at >= encoded.length) { controller.close(); return; }
    controller.enqueue(encoded.slice(at, at += 7));
  } });
  const progress = [];
  const response = new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
  const received = await readChartResponse(response, entry => progress.push(entry));
  assert.deepEqual(received.result, rows[2].data);
  assert.deepEqual(progress, rows.slice(0, 2));
  for (const [body, message] of [
    [JSON.stringify(rows[0]), /before the result/],
    [JSON.stringify({ type: 'error', message: 'History unavailable' }), /History unavailable/],
    [JSON.stringify({ type: 'unexpected' }), /Invalid chart stream/],
  ]) await assert.rejects(readChartResponse(new Response(body, { headers: { 'content-type': 'application/x-ndjson' } })), message);
  const revoked = await readChartResponse(new Response(JSON.stringify({ type: 'error', status: 401, message: 'Session expired' }),
    { headers: { 'content-type': 'application/x-ndjson' } }));
  assert.deepEqual(revoked, { response: { status: 401, ok: false }, result: { error: 'Session expired' } });
});

test('chart requests keep authentication, timeout and abort ownership on the monitor side', async () => {
  const seen = [], progress = [];
  const result = await fetchChartResponse('http://fixture/api/chart', { headers: { Authorization: 'Bearer synthetic' } }, {
    workerFactory: null, prefetch: true, onProgress: entry => progress.push(entry), fetchImpl: async (_url, options) => {
      seen.push(options);
      return new Response(JSON.stringify({ type: 'progress', stage: 'queued' }) + '\n' + JSON.stringify({ type: 'result', data: data() }),
        { headers: { 'content-type': 'application/x-ndjson' } });
    },
  });
  assert.deepEqual(result.result, data());
  assert.equal(seen[0].headers.Authorization, 'Bearer synthetic');
  assert.equal(seen[0].headers.Accept, 'application/x-ndjson');
  assert.equal(seen[0].headers['X-Chart-Prefetch'], '1');
  assert.equal(progress.length, 1);
  let signal;
  await assert.rejects(fetchChartResponse('http://fixture', {}, { workerFactory: null, timeoutMs: 10,
    fetchImpl: (_url, options) => { signal = options.signal; return new Promise(() => {}); } }), { name: 'TimeoutError' });
  assert.equal(signal.aborted, true);
  const unauthorized = await readChartResponse(new Response('Host session expired', { status: 401 }));
  assert.deepEqual(unauthorized, { response: { status: 401, ok: false }, result: {} });
});

test('fixed companion mapping is bounded to one inclusive week and never extends dates or explorer queries', () => {
  assert.deepEqual(chartPrefetchSelection(selection), { ...selection, view: 'phases' });
  assert.equal(chartPrefetchSelection({ ...selection, endDate: '2026-09-08' }), null);
  assert.equal(chartPrefetchSelection({ ...selection, view: 'integral' }), null);
  assert.equal(chartPrefetchSelection({ ...selection, viewFrom: 1 }), null);
  assert.equal(chartPrefetchSelection({ ...selection, view: undefined, left: 'power' }), null);
  assert.equal(chartPrefetchSelection({ ...selection, view: 'garage' }).view, 'garage_control');
  assert.equal(chartPrefetchSelection({ ...selection, view: 'garage_control' }).view, 'garage');
});

test('selecting an in-flight companion reuses its request and later selections cancel it without publishing stale data', async () => {
  const requests = [];
  const loader = createChartLoader({ api: (path, options) => new Promise(resolve => requests.push({ path, ...options, resolve })), prefetchDelay: 0 });
  const initial = loader.load(selection); await Promise.resolve(); requests[0].resolve(data()); await initial;
  loader.prefetch(selection); await delay(5);
  assert.equal(requests.length, 2); assert.equal(requests[1].prefetch, true);
  const progress = [];
  const companion = loader.load({ ...selection, view: 'phases' }, { onProgress: event => progress.push(event) });
  await Promise.resolve();
  assert.equal(requests.length, 2);
  requests[1].onProgress({ stage: 'reading-energy' }); assert.equal(progress.length, 1);
  const rejected = assert.rejects(companion, { name: 'AbortError' });
  const chosen = loader.load({ ...selection, view: 'garage' }); await Promise.resolve();
  assert.equal(requests[1].signal.aborted, true); assert.equal(requests[2].prefetch, false);
  requests[2].resolve(data()); await chosen;
  requests[1].resolve({ stale: true }); await rejected;
  loader.close();
});

test('unused prefetched charts are not polled again when their cache expires, and hidden pages do no speculation', async () => {
  let time = Date.parse('2026-09-08T12:00:00Z'), hidden = false, calls = 0;
  const loader = createChartLoader({ api: async () => { calls++; return data(); }, now: () => time,
    canPrefetch: () => !hidden, prefetchDelay: 0, pastTtlMs: 10 });
  await loader.load(selection); loader.prefetch(selection); await delay(5); assert.equal(calls, 2);
  time += 20;
  await loader.load(selection); loader.prefetch(selection); await delay(5); assert.equal(calls, 3, 'Only the selected chart refreshes');
  const other = { ...selection, view: 'garage' }; hidden = true;
  await loader.load(other); loader.prefetch(other); await delay(5); assert.equal(calls, 4);
  loader.close();
});

test('response cache bounds retained vertices in addition to entry count and invalidation fences prefetch', async () => {
  let calls = 0;
  const loader = createChartLoader({ api: async () => { calls++; return data(); }, maxEntries: 6, maxRecords: 3, prefetchDelay: 0 });
  await loader.load(selection); await loader.load({ ...selection, view: 'garage' }); await loader.load(selection);
  assert.equal(calls, 3, 'Two two-vertex responses cannot remain in a three-vertex cache');
  loader.prefetch(selection); loader.invalidate(); await delay(5); assert.equal(calls, 3);
  loader.close();
});

test('response cache byte limit also bounds large metadata on charts with few vertices', async () => {
  let calls = 0;
  const loader = createChartLoader({ api: async () => {
    calls++; const response = data(); rememberChartResponseSize(response, 12_000); return response;
  }, maxBytes: 20_000 });
  await loader.load(selection); await loader.load({ ...selection, view: 'garage' }); await loader.load(selection);
  assert.equal(calls, 3, 'Metadata bytes evict an entry even when its point count is small');
  loader.close();
});

test('returning to an unrelated cached chart cancels old speculation, while same-selection polls retain it', async () => {
  const requests = [];
  const loader = createChartLoader({ api: (path, options) => new Promise(resolve => requests.push({ path, ...options, resolve })), prefetchDelay: 0 });
  const garage = { ...selection, view: 'garage' };
  let loaded = loader.load(garage); await Promise.resolve(); requests[0].resolve(data()); await loaded;
  loaded = loader.load(selection); await Promise.resolve(); requests[1].resolve(data()); await loaded;
  loader.prefetch(selection); await delay(5);
  await loader.load(selection); assert.equal(requests[2].signal.aborted, false);
  await loader.load(garage); assert.equal(requests[2].signal.aborted, true);
  requests[2].resolve(data()); await delay(0); loader.close();
});

test('semantic content revisions avoid traversing data and diagnostic-only changes do not redraw charts', () => {
  const overview = { range: { from: 0, to: 2 }, now: 3, meta: { contentRevision: 'semantic-1', elapsedMs: 1 } };
  Object.defineProperty(overview, 'series', { get() { throw new Error('Fingerprint must not traverse datasets'); } });
  assert.equal(historyRenderFingerprint(overview, selection), historyRenderFingerprint({ range: overview.range, now: 4,
    meta: { contentRevision: 'semantic-1', elapsedMs: 200, cacheHit: true } }, selection));
  const original = { range: overview.range, now: 3, series: data().series, meta: { elapsedMs: 1, cacheHit: false }, operatingModes: [] };
  assert.equal(historyRenderFingerprint(original, selection), historyRenderFingerprint({ ...original, meta: { elapsedMs: 200, cacheHit: true } }, selection));
  assert.notEqual(historyRenderFingerprint(original, selection), historyRenderFingerprint({ ...original,
    operatingModes: [{ start: 0, end: 2, value: 1 }] }, selection));
});

test('geometry caching retains source metadata and gaps while theme and non-stack visibility reuse aligned datasets', async () => {
  const descriptor = selectedChartView(selection), visibility = {};
  const series = { property_power: [{ x: 0, y: 3, source: 'synthetic' }, { x: 1, y: 4 }, { x: 2, y: null }, { x: 3, y: 5 }],
    charger_power: [{ x: 0, y: 1 }, { x: 4, y: 1 }], charger2_power: [{ x: 0, y: 2 }, { x: 4, y: 2 }] };
  const input = { series, descriptor, visibility, interpolation: true };
  const cache = createChartGeometryCache({ workerFactory: null });
  const prepared = await cache.prepare(input), property = prepared.find(row => row.key === 'property_power');
  assert.equal(property.data, series.property_power);
  const changed = { ...input, visibility: { property_power: false } };
  const reused = await cache.prepare(changed);
  assert.equal(prepared, reused);
  assert.equal(chartGeometryKey(descriptor, visibility, true), chartGeometryKey(descriptor, changed.visibility, true));
  const points = reused.find(row => row.key === 'charger2_power').data;
  styleChartGeometry(reused, descriptor, changed.visibility, { ...defaultPalette, property: '#123456' });
  assert.equal(property.borderColor, '#123456'); assert.equal(property.hidden, true);
  assert.equal(property.data[0].source, 'synthetic'); assert.equal(property.data[2].y, null);
  assert.equal(reused.find(row => row.key === 'charger2_power').data, points);
  const rebased = await cache.prepare({ ...input, visibility: { charger_power: false } });
  assert.notEqual(rebased, prepared);
  assert.equal(rebased.find(row => row.key === 'charger2_power').powerStacked, false);
  cache.close();
});

test('uniform markers share Chart.js options while isolated real values retain markers and carried edges do not gain them', () => {
  const descriptor = selectedChartView(selection);
  const series = { property_power: [{ x: 0, y: 3 }, { x: 1, y: 4 }, { x: 2, y: 5 }] };
  let property = prepareChartGeometry({ series, descriptor, visibility: {} }).find(row => row.key === 'property_power');
  assert.equal(property.pointRadius, 0); assert.equal(property.pointHoverRadius, 3); assert.equal(property.pointHitRadius, 12);
  property = prepareChartGeometry({ series: { property_power: [{ x: 0, y: null }, { x: 1, y: 4 }, { x: 2, y: null },
    { x: 3, y: 5, carriedForward: true }] }, descriptor, visibility: {} }).find(row => row.key === 'property_power');
  assert.deepEqual(property.pointRadius, [0, 5, 0, 0]);
  assert.equal(property.chartEvidence.carriedForward, true);
});

test('cached price marker colours follow repeated theme changes, retaining hollow evidence markers', () => {
  const descriptor = selectedChartView(selection);
  const datasets = prepareChartGeometry({ series: { all_in_price: [{ x: 0, y: 3 }, { x: 1, y: 4 }],
    spot_price: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }, descriptor, visibility: {} });
  for (const price of ['#ffffff', '#000000', '#ffffff']) {
    styleChartGeometry(datasets, descriptor, {}, { ...defaultPalette, price });
    const actual = datasets.find(row => row.key === 'all_in_price');
    assert.equal(actual.borderColor, price); assert.equal(actual.pointBorderColor, price); assert.equal(actual.pointBackgroundColor, price);
  }
});

test('superseded geometry preparation terminates obsolete work and never publishes its late result', async () => {
  const workers = [];
  const cache = createChartGeometryCache({ workerFactory() {
    const worker = { postMessage(message) { this.sent = message; }, terminate() { this.terminated = true; } };
    workers.push(worker); return worker;
  } });
  const input = { series: data().series, descriptor: selectedChartView(selection), visibility: {}, interpolation: true };
  const first = cache.prepare(input), rejected = assert.rejects(first, { name: 'AbortError' });
  const latest = cache.prepare({ ...input, series: data().series });
  assert.equal(workers[0].terminated, true);
  workers[0].onmessage({ data: { id: 1, datasets: ['obsolete'] } });
  workers[1].onmessage({ data: { id: 2, datasets: [{ data: [{ x: 1, y: 3 }] }] } });
  assert.deepEqual(await latest, [{ data: [{ x: 1, y: 3 }] }]); await rejected;
  cache.close(); assert.equal(workers[1].terminated, true);
});
