import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeElectricityForecast, fetchElectricityForecast, startElectricityForecast, forecastPriceOutlook,
  ELECTRICITY_FORECAST_POLICY, ELECTRICITY_FORECAST_URL } from '../src/acquisition/electricity-forecast.js';
import { createHttp, ProviderError } from '../src/acquisition/http.js';
import { startProviders } from '../src/acquisition/providers.js';

const HOUR = 3_600_000, at = Date.parse('2026-10-08T15:30:00Z');
const iso = value => new Date(value).toISOString();
// Synthetic response with only the provider's inspected public field names.
function body(now = at, values = Array(48).fill(0.1)) {
  const start = Math.ceil(now / HOUR) * HOUR;
  return { api_version: 'v1', generated_at: iso(now), country: 'FI', currency: 'EUR', unit: 'EUR/kWh',
    source: { mode: 'forecast_only', price_mode: 'base', resolution: 'native', firestore: { updated_at: iso(now - HOUR) } },
    request: { country: 'FI', hours: 48, mode: 'forecast_only', price_mode: 'base', resolution: 'native' },
    meta: { allowed_horizon_hours: 48, used_horizon_hours: 48 },
    entries: values.map((value, i) => ({ start: iso(start + i * HOUR), end: iso(start + (i + 1) * HOUR),
      native_start: iso(start + i * HOUR), native_end: iso(start + (i + 1) * HOUR),
      value, unit: 'EUR/kWh', source: 'forecast', slot_minutes: 60, native_resolution_minutes: 60, expansion_method: 'native' })) };
}
const decode = (input = body(), now = at) => decodeElectricityForecast(input, { requestedAt: now, fetchedAt: now });
const contract = { periods: [{ from: 0, marginCtPerKwh: 1, taxCtPerKwh: 2, vatRate: 0.2,
  tariff: 'day-night', transferRates: { vatIncluded: false, dayCtPerKwh: 3, nightCtPerKwh: 1,
    winterDayCtPerKwh: 3, otherCtPerKwh: 1 } }] };

test('native Finnish predictions retain provenance and clip to 48 hours from request, not official horizon', () => {
  const snapshot = decode(body(at, [-0.02, 0, ...Array(46).fill(0.1)]));
  assert.equal(snapshot.intervals.length, 48);
  assert.equal(snapshot.intervals[0].spotCtPerKwh, -2);
  assert.equal(snapshot.intervals[1].spotCtPerKwh, 0);
  assert.equal(snapshot.intervals.at(-1).end, at + 48 * HOUR);
  assert.equal(snapshot.intervals.at(-1).nativeEnd, at + 48.5 * HOUR);
  assert.equal(snapshot.intervals[0].start, at + 0.5 * HOUR, 'Missing current half hour stays missing');
  assert.equal(snapshot.generatedAt, at);
  assert.equal(snapshot.modelUpdatedAt, at - HOUR);
  assert.equal(snapshot.fetchedAt, at);
  assert.equal(snapshot.expiresAt, at + ELECTRICITY_FORECAST_POLICY.cacheTtlMs);
  assert.equal(snapshot.intervals[0].vatIncluded, false);
  const cents = body(at, [-2, 0]);
  cents.unit = 'c/kWh'; cents.entries.forEach(row => { row.unit = 'c/kWh'; });
  assert.equal(decode(cents).intervals[0].spotCtPerKwh, -2);
});

test('invalid values, units, zones, sources, ordering, overlaps and native intervals fail closed', () => {
  const changes = [
    value => { value.country = 'SE'; }, value => { value.currency = 'SEK'; },
    value => { value.timezone = 'Europe/Berlin'; }, value => { value.unit = 'EUR/MWh'; },
    value => { value.api_version = 'v2'; }, value => { value.entries[0].value = '0.1'; },
    value => { value.entries[0].value = NaN; }, value => { value.entries[0].value = Infinity; },
    value => { value.entries[0].source = 'day_ahead'; }, value => { value.entries[0].unit = 'c/kWh'; },
    value => { value.entries[0].start = '2026-10-08T16:00:00'; },
    value => { value.entries[0].native_end = iso(at + 4 * HOUR); },
    value => { value.entries[0].slot_minutes = 15; }, value => { value.entries[0].expansion_method = 'interpolated'; },
    value => { value.entries.reverse(); }, value => { value.entries[1] = { ...value.entries[0] }; },
    value => { value.entries = Array(50).fill(value.entries[0]); },
    value => { value.request.price_mode = 'retail'; }, value => { value.meta.allowed_horizon_hours = 0; },
    value => { value.generated_at = iso(at + 2 * HOUR); },
    value => { value.generated_at = iso(at - 2 * HOUR); },
    value => { value.source.firestore.updated_at = iso(at - 7 * HOUR); },
    value => { value.entries.at(-1).end = iso(at + 50 * HOUR); },
  ];
  for (const change of changes) { const input = body(); change(input); assert.throws(() => decode(input), /invalid-electricity-forecast/); }
});

test('gaps and a shorter entitled horizon survive; absent model time is explicitly unknown', () => {
  const input = body(); input.entries.splice(1, 1); delete input.source.firestore;
  const snapshot = decode(input);
  assert.equal(snapshot.intervals.length, 47);
  assert.equal(snapshot.intervals[1].start - snapshot.intervals[0].end, HOUR);
  assert.equal(snapshot.modelUpdatedAt, null);
  input.meta.allowed_horizon_hours = 24; input.meta.used_horizon_hours = 24;
  input.entries = input.entries.slice(0, 23);
  const shorter = decode(input);
  assert.equal(shorter.horizonEnd, at + 24 * HOUR);
});

test('UTC native hours remain distinct through Finland daylight saving transitions', () => {
  for (const now of [Date.parse('2026-03-28T22:00:00Z'), Date.parse('2026-10-24T21:00:00Z')]) {
    const snapshot = decode(body(now), now);
    assert.equal(snapshot.intervals.length, 48);
    assert.equal(snapshot.intervals.at(-1).end - snapshot.intervals[0].start, 48 * HOUR);
    assert.equal(new Set(snapshot.intervals.map(row => row.start)).size, 48);
  }
});

test('fixed keyless GET uses the documented endpoint and shared HTTP origin restrictions', async () => {
  const calls = [];
  const http = createHttp({ fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json(body()); } });
  const result = await fetchElectricityForecast({ now: at, clock: () => at, http });
  assert.equal(result.country, 'FI'); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ELECTRICITY_FORECAST_URL);
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers, undefined);
  await assert.rejects(http.json(ELECTRICITY_FORECAST_URL, { method: 'POST' }), /device-writes-not-allowed/);
  await assert.rejects(http.json('https://arbitrary.invalid/api/v1/home-assistant/prices'), /provider-origin-not-allowed/);
  http.close();
});

test('read-only reads do not fetch; polling is single-flight and observes 429 cooldown without renewing the cache', async () => {
  let now = at, requests = 0, release;
  const fetcher = async () => { requests++; if (requests === 1) return new Promise(resolve => { release = () => resolve(decode(body(now), now)); });
    throw new ProviderError('provider-http-error', 429, 2 * HOUR); };
  const service = startElectricityForecast({ enabled: true, automatic: false, clock: () => now, fetcher });
  for (let i = 0; i < 100; i++) service.snapshot();
  assert.equal(requests, 0);
  const first = service.runDue(), second = service.runDue();
  assert.equal(first, second); await Promise.resolve(); assert.equal(requests, 1);
  release(); await first;
  assert.equal(service.status().available, true);
  const fetchedAt = service.status().fetchedAt;
  now += 30 * 60_000; await service.runDue();
  assert.equal(service.status().status, 'degraded'); assert.equal(service.status().lastError, 'HTTP-429');
  assert.equal(service.status().nextAttemptAt, now + 2 * HOUR);
  assert.equal(service.status().fetchedAt, fetchedAt);
  now = at + 90 * 60_000;
  assert.equal(service.status().available, false); assert.equal(service.snapshot().intervals.length, 0);
  await service.runDue(); assert.equal(requests, 2);
  await service.close();
});

test('disabled, authority-revoked and closed acquisition dispatch no requests or late results', async () => {
  let requests = 0, allowed = false, now = at, release;
  const disabled = startElectricityForecast({ automatic: false, fetcher: () => { requests++; } });
  await disabled.runDue(); await disabled.close(); assert.equal(requests, 0);
  const service = startElectricityForecast({ enabled: true, automatic: false, clock: () => now, canAcquire: () => allowed,
    fetcher: async () => { requests++; return new Promise(resolve => { release = () => resolve(decode(body(now), now)); }); } });
  await service.runDue(); assert.equal(requests, 0);
  allowed = true; const pending = service.runDue(); await Promise.resolve();
  allowed = false; release(); await pending; assert.equal(service.status().available, false);
  allowed = true; const pendingAgain = service.runDue(); await Promise.resolve();
  const closing = service.close(); release(); await Promise.all([pendingAgain, closing]);
  assert.equal(service.status().available, false); assert.equal(service.status().fetchedAt, null);
});

test('a synchronous provider error can retry, with sanitized diagnostics', async () => {
  let now = at, calls = 0;
  const service = startElectricityForecast({ enabled: true, automatic: false, clock: () => now,
    fetcher() { calls++; throw new Error('private URL secret'); } });
  await service.runDue(); assert.equal(service.status().lastError, 'provider-request-failed');
  now = service.status().nextAttemptAt; await service.runDue(); assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(service.status()), /private URL secret/); await service.close();
});

test('published slots win; forecast quarters retain native evidence and use the actual tariff once', () => {
  const forecast = { ...decode(body(at, [0.1, -0.02, 0])), available: true };
  const start = forecast.intervals[0].start;
  const official = [{ start, end: start + 15 * 60_000, priceCtPerKwh: 99 }];
  const result = forecastPriceOutlook({ official, forecast, contract, now: at });
  assert.equal(result.length, 12); assert.equal(result[0].priceCtPerKwh, 99);
  assert.equal(result[0].predicted, false); assert.equal(result[0].uncertaintyCtPerKwh, 0);
  assert.ok(result.slice(1).every(row => row.predicted && row.uncertaintyCtPerKwh === 2));
  assert.ok(result.slice(1, 4).every(row => row.priceCtPerKwh === 19.2 && row.nativeStart === start && row.nativeEnd === start + HOUR));
  assert.ok(result.slice(4, 8).every(row => Math.abs(row.priceCtPerKwh - 4.8) < 1e-10));
  assert.equal(official[0].predicted, undefined, 'Canonical official input is untouched');
  for (const key of ['allInCentsPerKWh', 'totalCtPerKwh', 'price']) {
    const outlook = forecastPriceOutlook({ official: [{ start, end: start + HOUR, [key]: 0 }], forecast, contract, now: at });
    assert.equal(outlook[0].priceCtPerKwh, 0, `${key} is a supported current price transport`);
    assert.equal(outlook[0].predicted, false);
    assert.equal(outlook.filter(row => row.predicted && row.start < start + HOUR).length, 0);
  }
  const replaced = forecastPriceOutlook({ official: [{ start, end: start + 3 * HOUR, priceCtPerKwh: 7 }], forecast, contract, now: at });
  assert.equal(replaced.length, 1); assert.equal(replaced[0].priceCtPerKwh, 7);
  assert.equal(forecastPriceOutlook({ official, forecast, contract, now: forecast.expiresAt }).length, 0);
});

test('provider lifecycle fetches without connected chargers and never persists forecast snapshots or health', async () => {
  const state = new Map(), snapshots = [], engine = { charging: { setAdapter() {} } };
  const store = { getState: key => state.get(key), setState: (key, value) => state.set(key, structuredClone(value)),
    snapshot: row => snapshots.push(row) };
  const providers = startProviders({ engine, store, config: { connections: {}, electricityForecast: { enabled: true } },
    devices: {}, http: { close() {} }, automatic: false, clock: () => at,
    electricityForecast: async () => decode() });
  await providers.ready; await providers.runDue();
  assert.equal(engine.electricityForecast.status().available, true);
  assert.equal(snapshots.length, 0);
  assert.equal([...state.keys()].some(key => /forecast/i.test(key)), false);
  assert.equal(JSON.stringify([...state.values()]).includes('energypriceforecast'), false);
  await providers.close(); assert.equal(engine.electricityForecast, null);
});
