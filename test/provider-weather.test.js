import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeOpenMeteo, decodeOpenMeteoCurrent, fetchWeather, fetchOutdoorTemperature,
  fetchOpenMeteoForecast, fetchOpenMeteoCurrent } from '../src/acquisition/weather.js';
const body = JSON.parse(readFileSync(new URL('./fixtures/weather-openmeteo.json', import.meta.url)));
const fmi = readFileSync(new URL('./fixtures/weather-fmi-forecast.xml', import.meta.url), 'utf8');
const at = Date.parse('2026-09-07T06:20:00Z'), HOUR = 3_600_000;
const connections = { geoloc: { latitude: 60.39, longitude: 25.66 } };
const options = { fetchedAt: at, coordinates: connections.geoloc };
const change = fn => { const data = structuredClone(body); fn(data); return data; };

test('Open-Meteo aligns preceding-hour W/m² with start-time Celsius and never invents publication time', () => {
  const result = decodeOpenMeteo(body, options), start = body.hourly.time[0] * 1000;
  assert.equal(result.source, 'openmeteo'); assert.equal(result.model, 'icon_seamless');
  assert.equal(result.forecast.length, 8);
  assert.deepEqual(result.forecast.slice(0, 3).map(row => [row.start, row.end, row.outdoorC, row.solarRadiationWm2]),
    [[start, start + HOUR, 10.5, 0], [start + HOUR, start + 2 * HOUR, 11, 100], [start + 2 * HOUR, start + 3 * HOUR, 12, 250]]);
  assert.equal(result.forecast.at(-1).end, body.hourly.time.at(-1) * 1000);
  assert.equal(result.solarStatus, 'available'); assert.deepEqual(result.observations, []);
  for (const row of result.forecast) {
    assert.equal(row.issuedAt, null); assert.equal(row.issuedAtBasis, 'fetched-snapshot'); assert.equal(row.fetchedAt, at);
    assert.equal(row.solar.intervalBasis, 'preceding-hour-mean'); assert.equal(row.solar.unit, 'W/m²');
  }
});

test('missing temperatures and radiation stay gaps; missing radiation is never interpreted as night', () => {
  const result = decodeOpenMeteo(change(data => { data.hourly.temperature_2m[1] = null; data.hourly.shortwave_radiation[3] = null; }), options);
  assert.equal(result.forecast.length, 7);
  assert.equal(result.forecast[1].start, body.hourly.time[2] * 1000);
  assert.equal(result.forecast[1].solarRadiationWm2, null);
  assert.deepEqual(result.forecast[1].solar.quality, ['missing-solar-forecast']);
  assert.equal(result.solarStatus, 'partial');
  assert.equal(decodeOpenMeteo(change(data => data.hourly.shortwave_radiation.fill(null)), options).solarStatus, 'unavailable');
  const gap = change(data => { for (const values of Object.values(data.hourly)) values.splice(1, 1); });
  assert.equal(decodeOpenMeteo(gap, options).forecast[0].start, body.hourly.time[2] * 1000, 'Never bridge an absent hour');
});

test('forecast rejects wrong units, timezone, location, malformed arrays and implausible values', () => {
  for (const mutate of [data => data.hourly_units.temperature_2m = 'K', data => data.hourly_units.shortwave_radiation = 'MJ/m²',
    data => data.hourly_units.time = 'iso8601', data => data.utc_offset_seconds = 10800,
    data => data.latitude = 0, data => delete data.longitude, data => data.error = true,
    data => data.hourly.time[1] = data.hourly.time[0], data => data.hourly.time[1]++,
    data => data.hourly.temperature_2m.pop(), data => data.hourly.shortwave_radiation = null,
    data => data.hourly.temperature_2m[0] = '12', data => data.hourly.temperature_2m[0] = 273.15,
    data => data.hourly.shortwave_radiation[1] = -1, data => data.hourly.shortwave_radiation[1] = '100',
    data => data.hourly.shortwave_radiation[1] = 9000,
    data => { for (const values of Object.values(data.hourly)) values.push(...Array(51).fill(values[0])); }])
    assert.throws(() => decodeOpenMeteo(change(mutate), options));
  assert.throws(() => decodeOpenMeteo(body, { ...options, fetchedAt: at + 7 * 24 * HOUR }), /horizon/);
  assert.throws(() => decodeOpenMeteo(change(data => data.hourly.temperature_2m.fill(null)), options), /No usable/);
});

test('keyless forecast/current requests use coordinates, explicit ICON model, units and UTC', async () => {
  for (const [forecast, fetcher] of [[true, fetchOpenMeteoForecast], [false, fetchOpenMeteoCurrent]]) {
    const result = await fetcher({ connections, now: at, http: { json: async (url, opts) => {
      const parsed = new URL(url), params = parsed.searchParams;
      assert.equal(parsed.origin, 'https://api.open-meteo.com'); assert.equal(parsed.pathname, '/v1/forecast');
      assert.equal(params.get('models'), 'icon_seamless'); assert.equal(params.get('latitude'), '60.39');
      assert.equal(params.get('temperature_unit'), 'celsius'); assert.equal(params.get('timeformat'), 'unixtime');
      assert.equal(params.get('timezone'), 'GMT'); assert.equal(params.has('apikey'), false); assert.equal(opts.method, 'GET');
      assert.equal(params.get(forecast ? 'hourly' : 'current'), forecast ? 'temperature_2m,shortwave_radiation' : 'temperature_2m');
      if (forecast) assert.equal(params.get('forecast_hours'), '49');
      return body;
    } } });
    assert.equal(forecast ? result.source : result[0].source, 'openmeteo');
    await assert.rejects(fetcher({ connections, now: at, http: { json: async () => { throw new Error('synthetic-private-response'); } } }),
      error => !error.message.includes('synthetic-private-response') && /acquisition failed/.test(error.message));
  }
});

test('current temperature preserves model valid time, age and estimated provenance', () => {
  const [row] = decodeOpenMeteoCurrent(body, options);
  assert.equal(row.value, 12); assert.equal(row.unit, 'degC'); assert.equal(row.sourceTime, at - 5 * 60_000);
  assert.equal(row.receivedAt, at); assert.deepEqual(row.quality, ['estimated']);
  assert.equal(row.raw.timestampBasis, 'model-valid-time'); assert.equal(row.raw.spatialBasis, 'weather-model-estimate');
  assert.equal(decodeOpenMeteoCurrent(change(data => data.current.temperature_2m = 0), options)[0].value, 0);
});

test('current rejects stale/future/malformed/implausible values and ambiguous units', () => {
  for (const mutate of [data => data.current.time = at / 1000 - 1801, data => data.current.time = at / 1000 + 1,
    data => data.current.time = null, data => data.current.temperature_2m = null, data => data.current.temperature_2m = 273.15,
    data => data.current.temperature_2m = '12', data => data.current.interval = 0, data => data.current.interval = 7200,
    data => data.current_units.temperature_2m = 'K', data => data.current_units.time = 'iso8601', data => data.latitude = 0])
    assert.throws(() => decodeOpenMeteoCurrent(change(mutate), options));
});

test('weather/current chains independently fall back and sanitize provider failure details', async () => {
  let primary = 0, backup = 0;
  const http = { text: async () => { primary++; throw Object.assign(new Error('synthetic-private-response'), { status: 429, retryAfterMs: 120_000 }); },
    json: async () => { backup++; return body; } };
  for (const fetcher of [fetchWeather, fetchOutdoorTemperature]) {
    const result = await fetcher({ connections, now: at, http });
    assert.deepEqual(result.acquisition, { primary: 'fmi', selected: 'openmeteo', fallbackUsed: true,
      attempts: [{ source: 'fmi', status: 'error', error: 'HTTP-429', retryAfterMs: 120_000 }, { source: 'openmeteo', status: 'ok', error: null }],
      ...(fetcher === fetchWeather ? { solarSource: 'openmeteo' } : {}) });
  }
  assert.equal(primary, 2); assert.equal(backup, 2);
});

test('FMI temperature survives missing solar, supplemented only at matching intervals with backup provenance', async () => {
  const result = await fetchWeather({ connections, now: at, http: { text: async () => fmi, json: async () => body } });
  assert.equal(result.source, 'fmi'); assert.equal(result.solarStatus, 'available');
  assert.deepEqual(result.forecast.map(row => [row.outdoorC, row.solarRadiationWm2]), [[10.5, 0], [13, 250], [14, 400]]);
  assert.ok(result.forecast.every(row => row.source === 'fmi' && row.solar.source === 'openmeteo' && row.solar.fetchedAt === at && row.solar.issuedAt === null));
  assert.equal(result.acquisition.selected, 'fmi'); assert.equal(result.acquisition.solarSource, 'openmeteo'); assert.equal(result.acquisition.fallbackUsed, true);
});

test('failed or backed-off solar backup retains good FMI temperatures and missing-solar metadata', async () => {
  for (const skipSources of [[], ['openmeteo']]) {
    let calls = 0;
    const result = await fetchWeather({ connections, now: at, skipSources,
      http: { text: async () => fmi, json: async () => { calls++; throw new Error('synthetic-private-response'); } } });
    assert.equal(result.source, 'fmi'); assert.equal(result.forecast.length, 3); assert.equal(result.solarStatus, 'unavailable');
    assert.equal(result.acquisition.fallbackUsed, false); assert.equal(result.acquisition.solarSource, null);
    assert.equal(calls, skipSources.length ? 0 : 1);
  }
});

test('fallback respects both provider backoffs, keyless operation and cancellation', async () => {
  let primary = 0, backup = 0;
  const http = { text: async () => { primary++; throw new Error('not available'); }, json: async () => { backup++; return body; } };
  const result = await fetchWeather({ connections, now: at, http, skipSources: ['fmi'] });
  assert.equal(primary, 0); assert.equal(backup, 1); assert.equal(result.acquisition.attempts[0].status, 'backoff');
  await assert.rejects(fetchWeather({ connections, now: at, http, skipSources: ['fmi', 'openmeteo'] }), error =>
    error.acquisition.attempts.every(attempt => attempt.status === 'backoff'));
  assert.equal(backup, 1);
  const controller = new AbortController();
  await assert.rejects(fetchWeather({ connections, now: at, signal: controller.signal,
    http: { text: async () => { controller.abort(); throw new Error('cancel'); }, json: http.json } }), /cancelled/);
  assert.equal(backup, 1);
});

test('all weather failures preserve sanitized HTTP status without response content', async () => {
  await assert.rejects(fetchOutdoorTemperature({ connections, now: at,
    http: { text: async () => { throw new Error('synthetic-private-response'); },
      json: async () => { throw Object.assign(new Error('synthetic-private-response'), { status: 401 }); } } }), error => {
    assert.equal(error.status, 401); assert.equal(error.acquisition.selected, null);
    assert.equal(error.acquisition.attempts[1].error, 'HTTP-401');
    assert.equal(JSON.stringify(error).includes('synthetic-private-response'), false); return true;
  });
});
