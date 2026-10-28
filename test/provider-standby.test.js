import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { startProviders } from '../src/acquisition/providers.js';
import { fetchWeather, fetchOutdoorTemperature } from '../src/acquisition/weather.js';
import { fetchMarket } from '../src/acquisition/market.js';
import { standbyAssessment, outdoorStandbyStatus, STANDBY_CHECK_MS as HOUR } from '../src/domain/provider-standby.js';

const START = Date.parse('2026-10-28T10:00:00Z'), MINUTE = 60_000;
function fixture(t) {
  let now = START, authorized = true;
  const store = new Store(':memory:'), recorder = new Recorder(store, { clock: () => now });
  const calls = [], latest = [];
  const observation = () => [{ source: 'fmi', device: 'synthetic-station', signal: 'outdoor_temperature',
    value: 0, unit: 'degC', sourceTime: now, receivedAt: now, quality: [] }];
  const forecast = source => ({ source, fetchedAt: now, issuedAt: now,
    forecast: [{ source, start: now, end: now + 36 * HOUR, outdoorC: 0, solarRadiationWm2: 0 }] });
  const engine = { recorder, ingest(row) { latest.push(row); recorder.record(row); }, providerObservations: () => latest,
    ingestionCheckpoint: () => null, restoreIngestionCheckpoint() {} };
  const http = { async json(url, options) {
    calls.push({ url: new URL(url), signal: options.signal });
    if (new URL(url).hostname === 'api.open-meteo.com') {
      const start = Math.floor(now / HOUR) * HOUR;
      return { latitude: 60, longitude: 25, utc_offset_seconds: 0,
        current_units: { time: 'unixtime', temperature_2m: '°C', interval: 'seconds' },
        current: { time: now / 1000, temperature_2m: 0, interval: 900 },
        hourly_units: { time: 'unixtime', temperature_2m: '°C', shortwave_radiation: 'W/m²' },
        hourly: { time: Array.from({ length: 49 }, (_, i) => (start + i * HOUR) / 1000),
          temperature_2m: Array(49).fill(0), shortwave_radiation: Array(49).fill(0) } };
    }
    return { success: true, data: { fi: Array.from({ length: 192 }, (_, i) => ({
      timestamp: (Math.floor(now / (15 * MINUTE)) * 15 * MINUTE + i * 15 * MINUTE) / 1000, price: 0 })) } };
  }, close() {} };
  const chain = (name, primary, fetcher) => async args => {
    if (args.skipSources?.includes(primary)) return fetcher(args);
    if (name === 'outdoor') return observation();
    if (name === 'weather') return forecast('fmi');
    return { source: 'entsoe', fetchedAt: now, issuedAt: now,
      intervals: [{ source: 'entsoe', start: now, end: now + 36 * HOUR, spotCtPerKwh: 0 }] };
  };
  const config = { connections: { geoloc: { country_code: 'fi', latitude: 60, longitude: 25 }, entsoe: { token: 'synthetic-token' } },
    acquisition: { outdoorIntervalMs: 24 * HOUR, weatherIntervalMs: 24 * HOUR, marketIntervalMs: 24 * HOUR } };
  const options = { store, engine, config, devices: {}, http, automatic: false, clock: () => now, canControl: () => authorized,
    outdoor: chain('outdoor', 'fmi', fetchOutdoorTemperature), weather: chain('weather', 'fmi', fetchWeather),
    market: chain('market', 'entsoe', fetchMarket) };
  const runtimes = [];
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); store.close(); });
  return { store, engine, recorder, options, calls, forecast, now: () => now, setTime: at => { now = at; },
    authorize: value => { authorized = value; },
    start() { const runtime = startProviders(options); runtimes.push(runtime); return runtime; },
    health: () => store.getState('providers:health') };
}

test('three hourly standby checks validate real decoded responses without changing selected feeds or recording data', async t => {
  const f = fixture(t), runtime = f.start();
  await runtime.runDue();
  const before = { observations: f.store.observations(), weather: f.store.getState('provider:weather'), market: f.store.getState('provider:market') };
  f.setTime(START + HOUR - 1); await runtime.runDue(); assert.equal(f.calls.length, 0);
  f.setTime(START + HOUR); await runtime.runDue();
  assert.equal(f.calls.length, 3);
  for (const name of ['outdoor', 'weather', 'market']) {
    const row = f.health()[name];
    assert.equal(row.standby.status, 'ok'); assert.equal(row.standby.lastCheckedAt, f.now());
    assert.equal(row.standby.nextAttemptAt, START + 2 * HOUR);
    assert.equal(row.source, name === 'market' ? 'entsoe' : 'fmi');
    assert.equal(row.lastSuccessAt, START); assert.equal(row.status, 'ok');
  }
  assert.equal(f.health().weather.standby.solarStatus, 'available', 'valid night-time zero is usable radiation');
  assert.deepEqual(f.store.observations(), before.observations);
  assert.deepEqual(f.store.getState('provider:weather'), before.weather);
  assert.deepEqual(f.store.getState('provider:market'), before.market);
  await runtime.runDue(); assert.equal(f.calls.length, 3, 'repeated scheduler calls do not duplicate checks');
  await runtime.close();
  const restarted = f.start(); await restarted.runDue(); assert.equal(f.calls.length, 3, 'restart preserves real check dates and due times');
  f.setTime(START + 2 * HOUR); await restarted.runDue(); assert.equal(f.calls.length, 6);
});

test('ordinary backup and solar supplementation count as checks of the actual backup result', async t => {
  const f = fixture(t);
  f.options.outdoor = async args => {
    const result = [{ source: 'openmeteo', device: 'synthetic-model', signal: 'outdoor_temperature', value: 0,
      unit: 'degC', sourceTime: f.now(), receivedAt: f.now(), quality: ['estimated'] }];
    args.onSourceResult({ source: 'openmeteo', result, attemptedAt: f.now() }); return result;
  };
  f.options.weather = async args => {
    const backup = f.forecast('openmeteo'); backup.forecast[0].solarRadiationWm2 = null;
    args.onSourceResult({ source: 'openmeteo', result: backup, attemptedAt: f.now() });
    return f.forecast('fmi');
  };
  const runtime = f.start(); await runtime.runDue();
  assert.equal(f.health().outdoor.standby.status, 'ok');
  assert.equal(f.health().weather.standby.status, 'partial');
  assert.equal(f.health().weather.standby.solarStatus, 'unavailable', 'good combined forecasts cannot overstate backup solar readiness');
  f.setTime(START + HOUR - 1); await runtime.runDue(); assert.equal(f.calls.length, 0);
});

test('failed standby checks retain current-feed health, sanitize errors and honor shared Retry-After', async t => {
  const f = fixture(t), runtime = f.start(); await runtime.runDue();
  f.options.http.json = async () => { throw Object.assign(new Error('synthetic-private-response'), { status: 429, retryAfterMs: 3 * HOUR }); };
  f.setTime(START + HOUR); await runtime.runDue();
  for (const name of ['outdoor', 'weather', 'market']) {
    const row = f.health()[name];
    assert.equal(row.status, 'ok'); assert.equal(row.error, null);
    assert.equal(row.standby.status, 'error'); assert.equal(row.standby.error, 'HTTP-429');
    assert.equal(row.standby.lastSuccessAt, null); assert.equal(row.standby.nextAttemptAt, START + 4 * HOUR);
  }
  assert(!JSON.stringify(f.health()).includes('synthetic-private-response'));
  f.setTime(START + 2 * HOUR); await runtime.runDue();
  assert.equal(f.health().outdoor.standby.lastCheckedAt, START + HOUR);
});

test('standby assessment requires current coverage and reports gaps and missing solar independently', () => {
  const weather = { source: 'openmeteo', forecast: [{ start: START, end: START + HOUR, outdoorC: 0, solarRadiationWm2: 0 },
    { start: START + 2 * HOUR, end: START + 3 * HOUR, outdoorC: 0, solarRadiationWm2: null }] };
  assert.equal(standbyAssessment('weather', weather, START).status, 'partial');
  assert.equal(standbyAssessment('weather', weather, START).coverage.gaps, true);
  assert.throws(() => standbyAssessment('weather', weather, START + HOUR));
  assert.throws(() => standbyAssessment('outdoor', [{ source: 'openmeteo', signal: 'outdoor_temperature', value: 0,
    unit: 'degC', sourceTime: START - 31 * MINUTE }], START));
  for (const value of [-60, 50]) assert.equal(standbyAssessment('outdoor', [{ source: 'openmeteo',
    signal: 'outdoor_temperature', value, unit: 'degC', sourceTime: START - 30 * MINUTE }], START).status, 'ok');
  for (const value of [-60.1, 50.1, 55]) assert.throws(() => standbyAssessment('outdoor', [{ source: 'openmeteo',
    signal: 'outdoor_temperature', value, unit: 'degC', sourceTime: START }], START));
});

test('outdoor standby classification requires the selected primary, live evidence, matching units and policy', () => {
  const primary = { source: 'fmi', signal: 'outdoor_temperature', unit: 'degC', policy: 'adaptive-value', observedThisRun: true,
    freshness: { status: 'fresh', sourceObservedAt: START, maxAgeMs: 30 * MINUTE } };
  const backup = { ...primary, source: 'openmeteo', freshness: { status: 'stale' } };
  const classify = (provider, p = primary, b = backup) => outdoorStandbyStatus({ parameters: [p, b] }, provider, START).parameters;
  assert.equal(classify({ source: 'fmi' })[1].standby, true);
  assert.equal(classify({ source: 'openmeteo' })[1].standby, false);
  assert.equal(classify({ source: 'fmi', acquisition: { selected: 'openmeteo' } })[1].standby, false);
  assert.equal(classify({ source: 'fmi' }, { ...primary, observedThisRun: false })[1].standby, false);
  assert.equal(classify({ source: 'fmi' }, primary, { ...backup, unit: 'K' })[1].standby, false);
  assert.equal(classify({ source: 'fmi' }, primary, { ...backup, policy: 'change-only' })[1].standby, false);
  assert.deepEqual(classify({ source: 'fmi' })[0], primary, 'FMI stream classification is unchanged');
});

test('a due foreground poll cancels a slow standby check, while other feeds continue and role loss prevents checks', async t => {
  const f = fixture(t), runtime = f.start(); await runtime.runDue();
  const original = f.options.http.json;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  f.options.http.json = async (url, args) => {
    if (!new URL(url).searchParams.has('current')) return original(url, args);
    started();
    return new Promise((resolve, reject) => args.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  };
  f.setTime(START + HOUR); const checking = runtime.runDue(); await waiting;
  assert.equal(f.health().outdoor.standby.checking, true);
  // Move the existing foreground due time, without touching standby scheduling.
  // Real foreground polls also change this deadline after every normal acquisition.
  f.setTime(START + 24 * HOUR); await runtime.runDue(); await checking;
  assert.equal(f.health().outdoor.lastSuccessAt, START + 24 * HOUR);
  assert.notEqual(f.health().outdoor.standby.status, 'error', 'foreground cancellation is not backup failure');
  f.authorize(false); f.setTime(START + 48 * HOUR); const before = f.health();
  await runtime.runDue(); assert.deepEqual(f.health(), before);
});

test('foreground cancellation before the diagnostic write settles cannot leave a check running or start a request', async t => {
  const f = fixture(t), runtime = f.start(); await runtime.runDue();
  f.setTime(START + HOUR); const checks = runtime.runDue();
  f.setTime(START + 24 * HOUR); const foreground = runtime.runDue();
  await Promise.all([checks, foreground]);
  assert.equal(f.calls.length, 0, 'cancelled diagnostics never reach their provider');
  for (const name of ['outdoor', 'weather', 'market']) {
    assert.equal(f.health()[name].standby.checking, false);
    assert.equal(f.health()[name].standby.status, 'waiting', 'cancellation invents no completed result');
    assert.equal(f.health()[name].standby.lastCheckedAt, null);
  }
});

test('unconfigured feeds make no standby requests and a restored in-progress check retains its completed failure', async t => {
  const f = fixture(t); f.options.config.connections = {};
  const idle = f.start(); f.setTime(START + 4 * HOUR); await idle.runDue();
  assert.equal(f.calls.length, 0); assert(Object.values(f.health()).every(row => !row.standby));
  await idle.close();
  f.options.config.connections = { geoloc: { latitude: 60, longitude: 25, country_code: 'fi' } };
  f.store.setState('providers:health', { market: { status: 'ok', nextAttemptAt: f.now() + HOUR, source: 'entsoe',
    standby: { source: 'elering', status: 'error', checking: true, lastCheckedAt: START,
      lastAttemptAt: f.now(), nextAttemptAt: f.now() + HOUR, error: 'HTTP-503' } } });
  const restored = f.start(); await restored.ready;
  assert.equal(f.health().market.standby.checking, false);
  assert.equal(f.health().market.standby.status, 'error');
  assert.equal(f.health().market.standby.lastCheckedAt, START);
});
