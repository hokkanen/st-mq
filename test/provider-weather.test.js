import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeOpenWeather, decodeOpenWeatherCurrent, fetchWeather, fetchOutdoorTemperature,
  fetchOpenWeatherForecast, fetchOpenWeatherCurrent } from '../src/acquisition/weather.js';
const body = JSON.parse(readFileSync(new URL('./fixtures/weather-openweathermap.json', import.meta.url)));
const at = body.list[0].dt * 1000;
const options = { fetchedAt: at, units: 'metric' };

test('OWM Celsius forecast uses Unix UTC, 3h slots, separate fetch time and no invented issuance', () => {
  const result = decodeOpenWeather(body, options);
  assert.equal(result.forecast[0].start, at);
  assert.equal(result.forecast[0].end, at + 10_800_000);
  assert.equal(result.forecast[0].outdoorC, 12.5);
  assert.equal(result.forecast[0].issuedAt, null);
  assert.equal(result.forecast[0].issuedAtBasis, 'fetched-snapshot');
  assert.equal(result.forecast[0].fetchedAt, at);
  assert.equal(result.forecast[1].end, at + 21_600_000);
  assert.equal(result.forecast[2].start, at + 32_400_000); // missing 6h point stays a gap
});

test('forecast decoding rejects missing/null values, Kelvin ambiguity, old snapshots and excessive data', () => {
  assert.throws(() => decodeOpenWeather(body, { ...options, units: undefined }), /metric/);
  assert.throws(() => decodeOpenWeather({ ...body, cod: 401 }, options));
  assert.throws(() => decodeOpenWeather({ ...body, list: Array(41).fill(body.list[0]) }, options));
  for (const temp of [null, '12', NaN, 273.15]) {
    assert.throws(() => decodeOpenWeather({ ...body, list: [{ ...body.list[0], main: { temp } }] }, options));
  }
  assert.throws(() => decodeOpenWeather(body, { ...options, fetchedAt: at + 7 * 86_400_000 }), /horizon/);
  assert.throws(() => decodeOpenWeather(body, { ...options, coordinates: { latitude: 0, longitude: 0 } }), /location/);
});

test('forecast duplicates merge identical points and reject conflicting observations', () => {
  assert.equal(decodeOpenWeather({ ...body, list: [...body.list, body.list[0]] }, options).forecast.length, 3);
  assert.throws(() => decodeOpenWeather({ ...body, list: [...body.list, { ...body.list[0], main: { temp: 17 } }] }, options), /Conflicting/);
});

test('OWM rejects a response whose only forecast interval has already expired', () => {
  const expired = { ...body, list: [body.list[0]] };
  assert.throws(() => decodeOpenWeather(expired, { ...options, fetchedAt: at + 10_800_000 }), /No usable.*horizon/);
  assert.equal(decodeOpenWeather(expired, { ...options, fetchedAt: at + 10_800_000 - 1 }).forecast.length, 1);
});

test('weather GET uses existing geolocation/token and metric request without exposing failures', async () => {
  const connections = { geoloc: { latitude: 60.39, longitude: 25.66 }, openweathermap: { token: 'synthetic-secret' } };
  const result = await fetchOpenWeatherForecast({ connections, now: at, http: { json: async (url, opts) => {
    assert.equal(new URL(url).searchParams.get('units'), 'metric');
    assert.equal(new URL(url).searchParams.get('lat'), '60.39');
    assert.equal(opts.method, 'GET');
    return body;
  } } });
  assert.equal(result.forecast.length, 3);
  await assert.rejects(fetchOpenWeatherForecast({ connections, now: at, http: { json: async () => { throw new Error('URL synthetic-secret'); } } }), err => err.message === 'OpenWeather forecast acquisition failed');
});

const connections = { geoloc: { latitude: 60.39, longitude: 25.66 }, openweathermap: { token: 'synthetic-secret' } };
const current = { cod: 200, dt: at / 1000, main: { temp: 12 }, coord: { lat: 60.39, lon: 25.66 } };

test('OWM current temperature retains calculation timestamp and spatial estimate provenance', async () => {
  const [row] = decodeOpenWeatherCurrent(current, { ...options, coordinates: connections.geoloc });
  assert.equal(row.value, 12); assert.equal(row.unit, 'degC');
  assert.equal(row.sourceTime, at); assert.equal(row.receivedAt, at);
  assert.equal(row.raw.timestampBasis, 'provider-calculation-time');
  assert.equal(row.raw.spatialBasis, 'provider-current-weather-estimate');
  const rows = await fetchOpenWeatherCurrent({ connections, now: at, http: { json: async (url, opts) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/data/2.5/weather');
    assert.equal(parsed.searchParams.get('units'), 'metric');
    assert.equal(opts.method, 'GET'); return current;
  } } });
  assert.equal(rows[0].source, 'openweathermap');
});

test('OWM current rejects stale, future, impossible and wrong-location readings', () => {
  const decode = data => decodeOpenWeatherCurrent(data, { ...options, coordinates: connections.geoloc });
  for (const change of [{ dt: at / 1000 - 1801 }, { dt: at / 1000 + 1 }, { dt: null }, { cod: 401 },
    { main: { temp: null } }, { main: { temp: 273.15 } }, { coord: { lat: 0, lon: 0 } }, { coord: null }])
    assert.throws(() => decode({ ...current, ...change }));
  assert.throws(() => decodeOpenWeatherCurrent(current, { fetchedAt: at }), /metric/);
});

test('weather and outdoor chains fall back independently once and report sanitized diagnostics', async () => {
  let fmiCalls = 0, owmCalls = 0;
  const http = { text: async () => { fmiCalls++; throw Object.assign(new Error('secret echoed'), { status: 429, retryAfterMs: 120_000 }); },
    json: async url => { owmCalls++; return new URL(url).pathname.endsWith('/forecast') ? body : current; } };
  const forecast = await fetchWeather({ connections, now: at, http });
  const observations = await fetchOutdoorTemperature({ connections, now: at, http });
  for (const result of [forecast, observations]) {
    assert.deepEqual(result.acquisition, { primary: 'fmi', selected: 'openweathermap', fallbackUsed: true,
      attempts: [{ source: 'fmi', status: 'error', error: 'HTTP-429', retryAfterMs: 120_000 },
        { source: 'openweathermap', status: 'ok', error: null }] });
  }
  assert.equal(fmiCalls, 2); assert.equal(owmCalls, 2);
});

test('weather fallback respects primary backoff, missing backup key and cancellation', async () => {
  let primary = 0, backup = 0;
  const http = { text: async () => { primary++; throw new Error('not available'); }, json: async () => { backup++; return body; } };
  const result = await fetchWeather({ connections, now: at, http, skipSources: ['fmi'] });
  assert.equal(primary, 0); assert.equal(backup, 1);
  assert.equal(result.acquisition.attempts[0].status, 'backoff');
  await assert.rejects(fetchWeather({ connections: { geoloc: connections.geoloc }, now: at, http }), error => {
    assert.equal(error.acquisition.attempts[1].status, 'not-configured'); return true;
  });
  const controller = new AbortController();
  await assert.rejects(fetchWeather({ connections, now: at, signal: controller.signal,
    http: { text: async () => { controller.abort(); throw new Error('cancel'); }, json: http.json } }), /cancelled/);
  assert.equal(backup, 1);
});

test('all weather failures preserve HTTP status and diagnostics without response text or secrets', async () => {
  await assert.rejects(fetchOutdoorTemperature({ connections, now: at,
    http: { text: async () => { throw new Error('secret'); },
      json: async () => { throw Object.assign(new Error('secret'), { status: 401 }); } } }), error => {
    assert.equal(error.status, 401); assert.equal(error.acquisition.selected, null);
    assert.equal(error.acquisition.attempts[1].error, 'HTTP-401');
    assert.equal(JSON.stringify(error).includes('secret'), false); return true;
  });
});
