import { instantMs } from '../domain/prices.js';
import { fetchFmiForecast, fetchFmiObservation, weatherCoordinates, weatherError, distanceKm } from './fmi.js';

export { fetchFmiForecast, fetchFmiObservation } from './fmi.js';

export const WEATHER_SOURCE = 'https://openweathermap.org/forecast5';
const THREE_HOURS = 10_800_000;

/** OWM's JSON forecast has valid times but no documented provider-issued timestamp. */
export function decodeOpenWeather(body, { fetchedAt, units, coordinates } = {}) {
  fetchedAt = instantMs(fetchedAt);
  if (units !== 'metric') throw new Error('OpenWeather forecast requires explicit metric units');
  if (String(body?.cod) !== '200' || !Array.isArray(body.list) || !body.list.length || body.list.length > 40) throw new Error('Invalid OpenWeather forecast response');
  if (coordinates) {
    const reported = weatherCoordinates({ geoloc: { latitude: body.city?.coord?.lat, longitude: body.city?.coord?.lon } });
    if (distanceKm(coordinates, reported) > 50) throw new Error('OpenWeather forecast location mismatch');
  }
  const unique = new Map();
  for (const item of body.list) {
    if (!Number.isSafeInteger(item.dt) || !Number.isFinite(item.main?.temp) || item.main.temp < -90 || item.main.temp > 65) throw new Error('Invalid OpenWeather forecast point');
    const start = instantMs(item.dt * 1000);
    if (start % THREE_HOURS !== 0 || start < fetchedAt - THREE_HOURS || start > fetchedAt + 5 * 86_400_000) throw new Error('OpenWeather forecast timestamp outside expected current horizon');
    if (unique.has(start) && unique.get(start).outdoorC !== item.main.temp) throw new Error('Conflicting OpenWeather forecast duplicate');
    unique.set(start, { start, end: start + THREE_HOURS, outdoorC: item.main.temp,
      source: 'openweathermap', unit: 'degC', issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt,
      quality: ['provider-issuance-unknown'], provenance: WEATHER_SOURCE });
  }
  const forecast = [...unique.values()].sort((a, b) => a.start - b.start);
  if (!forecast.some(row => row.end > fetchedAt)) throw new Error('No usable OpenWeather forecast horizon');
  return { source: 'openweathermap', issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt,
    forecast, observations: [], provenance: WEATHER_SOURCE };
}

function openWeatherUrl(connections, path) {
  const { latitude, longitude } = weatherCoordinates(connections);
  if (typeof connections?.openweathermap?.token !== 'string' || !connections.openweathermap.token.trim()) throw new Error('OpenWeather token is required');
  const url = new URL(`https://api.openweathermap.org/data/2.5/${path}`);
  url.search = new URLSearchParams({ lat: String(latitude), lon: String(longitude), appid: connections.openweathermap.token, units: 'metric' });
  return url.toString();
}

export async function fetchOpenWeatherForecast({ connections, now, http, signal } = {}) {
  const url = openWeatherUrl(connections, 'forecast'), coordinates = weatherCoordinates(connections);
  try { return decodeOpenWeather(await http.json(url, { method: 'GET', signal }), { fetchedAt: now, units: 'metric', coordinates }); }
  catch (error) { throw weatherError(error, 'OpenWeather forecast acquisition failed'); }
}

/** OWM dt is current-data calculation time, not the time of a household thermometer. */
export function decodeOpenWeatherCurrent(body, { fetchedAt, units, coordinates } = {}) {
  fetchedAt = instantMs(fetchedAt);
  if (units !== 'metric') throw new Error('OpenWeather current temperature requires explicit metric units');
  const value = body?.main?.temp;
  if (String(body?.cod) !== '200' || !Number.isSafeInteger(body?.dt) || !Number.isFinite(value) || value < -60 || value > 50)
    throw new Error('Invalid OpenWeather current temperature');
  const sourceTime = instantMs(body.dt * 1000);
  if (sourceTime > fetchedAt || fetchedAt - sourceTime > 30 * 60_000) throw new Error('Stale or future OpenWeather current temperature');
  const reportedCoordinates = weatherCoordinates({ geoloc: { latitude: body?.coord?.lat, longitude: body?.coord?.lon } });
  if (coordinates && distanceKm(coordinates, reportedCoordinates) > 50) throw new Error('OpenWeather current location mismatch');
  return [{ source: 'openweathermap', device: 'current-weather', signal: 'outdoor_temperature', value,
    unit: 'degC', sourceTime, receivedAt: fetchedAt, quality: [],
    raw: { provenance: 'https://openweathermap.org/current', reportedUnit: 'degC',
      spatialBasis: 'provider-current-weather-estimate', timestampBasis: 'provider-calculation-time' } }];
}

export async function fetchOpenWeatherCurrent({ connections, now, http, signal } = {}) {
  const url = openWeatherUrl(connections, 'weather'), coordinates = weatherCoordinates(connections);
  try { return decodeOpenWeatherCurrent(await http.json(url, { method: 'GET', signal }), { fetchedAt: now, units: 'metric', coordinates }); }
  catch (error) { throw weatherError(error, 'OpenWeather current temperature acquisition failed'); }
}

async function weatherFallback(options, forecast) {
  weatherCoordinates(options.connections);
  const { signal, connections, skipSources = [] } = options;
  const acquisition = { primary: 'fmi', selected: null, fallbackUsed: false, attempts: [] };
  let lastError;
  for (const [source, fetcher] of [['fmi', forecast ? fetchFmiForecast : fetchFmiObservation],
    ['openweathermap', forecast ? fetchOpenWeatherForecast : fetchOpenWeatherCurrent]]) {
    if (signal?.aborted) throw weatherError(null, 'Weather acquisition cancelled');
    if (skipSources.includes(source)) {
      acquisition.attempts.push({ source, status: 'backoff', error: null }); continue;
    }
    if (source === 'openweathermap' && (typeof connections?.openweathermap?.token !== 'string' || !connections.openweathermap.token.trim())) {
      acquisition.attempts.push({ source, status: 'not-configured', error: null }); continue;
    }
    try {
      const result = await fetcher(options);
      acquisition.selected = source; acquisition.fallbackUsed = source !== acquisition.primary;
      acquisition.attempts.push({ source, status: 'ok', error: null });
      result.acquisition = acquisition;
      return result;
    } catch (error) {
      lastError = error;
      acquisition.attempts.push({ source, status: 'error',
        error: Number.isInteger(error?.status) ? `HTTP-${error.status}` : 'provider-request-failed',
        ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}) });
    }
  }
  const error = weatherError(lastError, forecast ? 'Weather forecast acquisition failed' : 'Outdoor temperature acquisition failed');
  error.acquisition = acquisition;
  throw error;
}

/** Independent chains allow a weather station failure without losing a good forecast. */
export function fetchWeather(options = {}) {
  return weatherFallback(options, true);
}

export function fetchOutdoorTemperature(options = {}) {
  return weatherFallback(options, false);
}
