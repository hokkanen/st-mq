import { weatherAcquisitionIdentity } from './weather-identity.js';
import { instantMs } from '../domain/prices.js';
import { weatherCoordinates, weatherError, distanceKm } from './fmi.js';

export const OPEN_METEO_SOURCE = 'https://open-meteo.com/en/docs/dwd-api';
const HOUR = 3_600_000, MINUTE = 60_000;
const MODEL = 'icon_seamless';

function location(body, coordinates) {
  if (!body || body.error || body.utc_offset_seconds !== 0) throw new Error('Invalid Open-Meteo response or timezone');
  const reported = weatherCoordinates({ geoloc: body });
  if (coordinates && distanceKm(coordinates, reported) > 50) throw new Error('Open-Meteo location mismatch');
}
function validValue(value, minimum, maximum) {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

/** Valid times are explicit UTC; the forecast API does not expose model issuance. */
export function decodeOpenMeteo(body, { fetchedAt, coordinates } = {}) {
  fetchedAt = instantMs(fetchedAt);
  location(body, coordinates);
  const units = body.hourly_units, hourly = body.hourly;
  if (units?.time !== 'unixtime' || units?.temperature_2m !== '°C' || units?.shortwave_radiation !== 'W/m²')
    throw new Error('Open-Meteo forecast requires explicit UTC, Celsius and W/m² units');
  const times = hourly?.time, temperatures = hourly?.temperature_2m, radiation = hourly?.shortwave_radiation;
  if (!Array.isArray(times) || times.length < 2 || times.length > 50
    || !Array.isArray(temperatures) || temperatures.length !== times.length
    || !Array.isArray(radiation) || radiation.length !== times.length) throw new Error('Invalid Open-Meteo forecast arrays');
  for (let i = 0; i < times.length; i++) {
    const start = times[i] * 1000;
    if (!Number.isSafeInteger(times[i]) || start % HOUR !== 0 || start < fetchedAt - HOUR
      || start > fetchedAt + 49 * HOUR || (i && times[i] <= times[i - 1])) throw new Error('Invalid Open-Meteo forecast horizon');
    if (temperatures[i] !== null && !validValue(temperatures[i], -90, 65)) throw new Error('Invalid Open-Meteo forecast temperature');
    if (radiation[i] !== null && !validValue(radiation[i], 0, 2000)) throw new Error('Invalid Open-Meteo solar radiation');
  }
  const forecast = [];
  for (let i = 0; i < times.length - 1; i++) {
    const start = times[i] * 1000, end = times[i + 1] * 1000;
    if (end - start !== HOUR || end <= fetchedAt || temperatures[i] === null) continue;
    // Temperature is the point at the start. Radiation at the END describes
    // this preceding hour; using radiation[i] would shift sunlight an hour late.
    const solarRadiationWm2 = radiation[i + 1];
    forecast.push({ start, end, outdoorC: temperatures[i], solarRadiationWm2,
      solar: { source: 'openmeteo', parameter: 'shortwave_radiation', unit: 'W/m²', basis: 'forecast',
        quality: solarRadiationWm2 === null ? ['missing-solar-forecast'] : [],
        intervalBasis: 'preceding-hour-mean', provenance: OPEN_METEO_SOURCE },
      source: 'openmeteo', model: MODEL, unit: 'degC', issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt,
      quality: ['provider-issuance-unknown'], intervalBasis: 'hourly-point-held-within-published-horizon', provenance: OPEN_METEO_SOURCE });
  }
  if (!forecast.length) throw new Error('No usable Open-Meteo forecast horizon');
  return { version: 2, source: 'openmeteo', model: MODEL, issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt,
    solarStatus: forecast.every(row => row.solarRadiationWm2 !== null) ? 'available'
      : forecast.some(row => row.solarRadiationWm2 !== null) ? 'partial' : 'unavailable',
    forecast, observations: [], provenance: OPEN_METEO_SOURCE };
}

/** Current weather is a model estimate, not an observation at a thermometer. */
export function decodeOpenMeteoCurrent(body, { fetchedAt, coordinates } = {}) {
  fetchedAt = instantMs(fetchedAt);
  location(body, coordinates);
  const current = body.current, units = body.current_units;
  if (units?.time !== 'unixtime' || units?.temperature_2m !== '°C' || units?.interval !== 'seconds')
    throw new Error('Open-Meteo current temperature requires explicit UTC and Celsius units');
  if (!Number.isSafeInteger(current?.time) || !validValue(current.temperature_2m, -60, 50)
    || !Number.isSafeInteger(current.interval) || current.interval <= 0 || current.interval > 3600)
    throw new Error('Invalid Open-Meteo current temperature');
  const sourceTime = instantMs(current.time * 1000);
  if (sourceTime > fetchedAt || fetchedAt - sourceTime > 30 * MINUTE) throw new Error('Stale or future Open-Meteo current temperature');
  return [{ source: 'openmeteo', device: MODEL, signal: 'outdoor_temperature', value: current.temperature_2m,
    unit: 'degC', sourceTime, receivedAt: fetchedAt, quality: ['estimated'],
    raw: { provenance: OPEN_METEO_SOURCE, model: MODEL, reportedUnit: 'degC',
      spatialBasis: 'weather-model-estimate', timestampBasis: 'model-valid-time', intervalSeconds: current.interval } }];
}

function requestUrl(connections, forecast) {
  const { latitude, longitude } = weatherCoordinates(connections);
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), models: MODEL,
    temperature_unit: 'celsius', timeformat: 'unixtime', timezone: 'GMT',
    ...(forecast ? { hourly: 'temperature_2m,shortwave_radiation', forecast_hours: '49' } : { current: 'temperature_2m', forecast_days: '1' }) });
  return url.toString();
}

export async function fetchOpenMeteoForecast({ connections, now, http, signal, clock = Date.now } = {}) {
  const url = requestUrl(connections, true), coordinates = weatherCoordinates(connections);
  try {
    const body = await http.json(url, { method: 'GET', signal });
    const result = decodeOpenMeteo(body, { fetchedAt: clock(), coordinates });
    const acquisitionIdentity = weatherAcquisitionIdentity(connections);
    return { ...result, requestStartedAt: now, acquisitionIdentity };
  }
  catch (error) { throw weatherError(error, 'Open-Meteo forecast acquisition failed'); }
}
export async function fetchOpenMeteoCurrent({ connections, now, http, signal, clock = Date.now } = {}) {
  const url = requestUrl(connections, false), coordinates = weatherCoordinates(connections);
  try {
    const body = await http.json(url, { method: 'GET', signal });
    const result = decodeOpenMeteoCurrent(body, { fetchedAt: clock(), coordinates });
    const acquisitionIdentity = weatherAcquisitionIdentity(connections);
    return result.map(row => ({ ...row, raw: { ...row.raw, requestStartedAt: now, acquisitionIdentity } }));
  }
  catch (error) { throw weatherError(error, 'Open-Meteo current temperature acquisition failed'); }
}
