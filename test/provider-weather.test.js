import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeOpenWeather, fetchWeather } from '../src/acquisition/weather.js';
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
});

test('forecast duplicates merge identical points and reject conflicting observations', () => {
  assert.equal(decodeOpenWeather({ ...body, list: [...body.list, body.list[0]] }, options).forecast.length, 3);
  assert.throws(() => decodeOpenWeather({ ...body, list: [...body.list, { ...body.list[0], main: { temp: 17 } }] }, options), /Conflicting/);
});

test('weather GET uses existing geolocation/token and metric request without exposing failures', async () => {
  const connections = { geoloc: { latitude: 60.39, longitude: 25.66 }, openweathermap: { token: 'synthetic-secret' } };
  const result = await fetchWeather({ connections, now: at, http: { json: async (url, opts) => {
    assert.equal(new URL(url).searchParams.get('units'), 'metric');
    assert.equal(new URL(url).searchParams.get('lat'), '60.39');
    assert.equal(opts.method, 'GET');
    return body;
  } } });
  assert.equal(result.forecast.length, 3);
  await assert.rejects(fetchWeather({ connections, now: at, http: { json: async () => { throw new Error('URL synthetic-secret'); } } }), err => err.message === 'Weather forecast acquisition failed');
});
