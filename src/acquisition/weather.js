import { fetchFmiForecast, fetchFmiObservation, weatherCoordinates, weatherError } from './fmi.js';
import { fetchOpenMeteoForecast, fetchOpenMeteoCurrent } from './openmeteo.js';

export { fetchFmiForecast, fetchFmiObservation } from './fmi.js';
export { decodeOpenMeteo, decodeOpenMeteoCurrent, fetchOpenMeteoForecast, fetchOpenMeteoCurrent } from './openmeteo.js';

function solarStatus(rows) {
  return rows.every(row => Number.isFinite(row.solarRadiationWm2)) ? 'available'
    : rows.some(row => Number.isFinite(row.solarRadiationWm2)) ? 'partial' : 'unavailable';
}

// A missing radiation series must not discard a good FMI temperature forecast.
// Only fill matching intervals, retaining the backup's own provenance and age.
function supplementSolar(primary, backup) {
  const forecast = primary.forecast.map(row => {
    if (Number.isFinite(row.solarRadiationWm2)) return row;
    const replacement = backup.forecast.find(candidate => candidate.start === row.start && candidate.end === row.end
      && Number.isFinite(candidate.solarRadiationWm2));
    return replacement ? { ...row, solarRadiationWm2: replacement.solarRadiationWm2, solar: { ...replacement.solar,
      source: backup.source, issuedAt: replacement.issuedAt, issuedAtBasis: replacement.issuedAtBasis,
      fetchedAt: replacement.fetchedAt } } : row;
  });
  const sources = new Set(forecast.filter(row => Number.isFinite(row.solarRadiationWm2)).map(row => row.solar?.source ?? row.source));
  return { ...primary, forecast, solarStatus: solarStatus(forecast), solarSource: sources.size > 1 ? 'mixed' : [...sources][0] ?? null };
}

async function weatherFallback(options, forecast) {
  weatherCoordinates(options.connections);
  const { signal, skipSources = [] } = options;
  const acquisition = { primary: 'fmi', selected: null, fallbackUsed: false, attempts: [] };
  let lastError, primary;
  for (const [source, fetcher] of [['fmi', forecast ? fetchFmiForecast : fetchFmiObservation],
    ['openmeteo', forecast ? fetchOpenMeteoForecast : fetchOpenMeteoCurrent]]) {
    if (signal?.aborted) throw weatherError(null, 'Weather acquisition cancelled');
    if (skipSources.includes(source)) {
      acquisition.attempts.push({ source, status: 'backoff', error: null }); continue;
    }
    try {
      let result = await fetcher(options);
      if (signal?.aborted) throw weatherError(null, 'Weather acquisition cancelled');
      acquisition.attempts.push({ source, status: 'ok', error: null });
      if (forecast && source === 'fmi' && solarStatus(result.forecast) !== 'available') {
        primary = result; continue;
      }
      if (primary) result = supplementSolar(primary, result);
      acquisition.selected = result.source ?? source;
      if (forecast) acquisition.solarSource = result.solarSource ?? (solarStatus(result.forecast) === 'unavailable' ? null : source);
      acquisition.fallbackUsed = source !== acquisition.primary && (!primary || ['openmeteo', 'mixed'].includes(acquisition.solarSource));
      result.acquisition = acquisition;
      return result;
    } catch (error) {
      if (signal?.aborted) throw weatherError(null, 'Weather acquisition cancelled');
      lastError = error;
      acquisition.attempts.push({ source, status: 'error',
        error: Number.isInteger(error?.status) ? `HTTP-${error.status}` : 'provider-request-failed',
        ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}) });
    }
  }
  if (primary) {
    acquisition.selected = 'fmi';
    acquisition.solarSource = solarStatus(primary.forecast) === 'unavailable' ? null : 'fmi';
    return { ...primary, acquisition };
  }
  const error = weatherError(lastError, forecast ? 'Weather forecast acquisition failed' : 'Outdoor temperature acquisition failed');
  error.acquisition = acquisition;
  throw error;
}

/** Independent chains allow a weather station failure without losing a good forecast. */
export function fetchWeather(options = {}) { return weatherFallback(options, true); }
export function fetchOutdoorTemperature(options = {}) { return weatherFallback(options, false); }
