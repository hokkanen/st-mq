import { instantMs, normalizePriceIntervals, priceIntervals } from '../domain/prices.js';
import { createHttp, ProviderError, providerFailureCode } from './http.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE, QUARTER = 15 * MINUTE;
export const ELECTRICITY_FORECAST_SOURCE = 'energypriceforecast';
export const ELECTRICITY_FORECAST_URL = 'https://api.energypriceforecast.eu/api/v1/home-assistant/prices?country=fi&hours=48&mode=forecast_only&resolution=native&price_mode=base';
export const ELECTRICITY_FORECAST_POLICY = Object.freeze({ pollMs: 30 * MINUTE, cacheTtlMs: 90 * MINUTE,
  modelMaxAgeMs: 6 * HOUR, horizonMs: 48 * HOUR, uncertaintyCtPerKwh: 2 });
const metadata = Object.freeze({ source: ELECTRICITY_FORECAST_SOURCE, provider: 'Energy Price Forecast EU',
  providerUrl: 'https://energypriceforecast.eu/', country: 'FI', currency: 'EUR', unit: 'c/kWh',
  nativeResolutionMinutes: 60, usage: 'private-noncommercial',
  termsUrl: 'https://energypriceforecast.eu/?country=de&lang=en&tab=legal&legal_section=terms' });
const invalid = () => new ProviderError('invalid-electricity-forecast');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const timestamp = value => {
  if (typeof value !== 'string') throw invalid();
  try { return instantMs(value); } catch { throw invalid(); }
};

/** A provider prediction has no authority to become recorded market history.
 * Keep the provider's complete final hour and its native evidence when expanding
 * the requested horizon into quarter-hour planner slots. */
export function decodeElectricityForecast(body, { requestedAt, fetchedAt = requestedAt } = {}) {
  if (!finite(requestedAt) || !finite(fetchedAt) || fetchedAt < requestedAt || fetchedAt - requestedAt > MINUTE) throw invalid();
  if (!body || body.api_version !== 'v1' || body.country !== 'FI' || body.currency !== 'EUR'
    || !['EUR/kWh', 'c/kWh'].includes(body.unit) || !Array.isArray(body.entries)
    || !body.entries.length || body.entries.length > 49) throw invalid();
  const generatedAt = timestamp(body.generated_at);
  const modelUpdatedAt = body.source?.firestore?.updated_at == null ? null : timestamp(body.source.firestore.updated_at);
  if (generatedAt > fetchedAt + MINUTE || fetchedAt - generatedAt > ELECTRICITY_FORECAST_POLICY.cacheTtlMs
    || modelUpdatedAt !== null && (modelUpdatedAt > fetchedAt + MINUTE
      || fetchedAt - modelUpdatedAt > ELECTRICITY_FORECAST_POLICY.modelMaxAgeMs)) throw invalid();
  const access = body.meta;
  if (!access || !Number.isInteger(access.allowed_horizon_hours) || access.allowed_horizon_hours < 1
    || access.allowed_horizon_hours > 168
    || access.used_horizon_hours != null && (!Number.isInteger(access.used_horizon_hours)
      || access.used_horizon_hours < 1 || access.used_horizon_hours > Math.min(48, access.allowed_horizon_hours))) throw invalid();
  if (body.timezone != null && body.timezone !== 'Europe/Helsinki') throw invalid();
  for (const section of [body.request, body.source, access]) {
    if (section?.mode != null && section.mode !== 'forecast_only'
      || section?.price_mode != null && section.price_mode !== 'base'
      || section?.resolution != null && section.resolution !== 'native') throw invalid();
  }
  if (body.request?.country != null && body.request.country !== 'FI'
    || body.request?.hours != null && body.request.hours !== 48) throw invalid();
  const horizonEnd = Math.ceil(requestedAt / HOUR) * HOUR
    + Math.min(48, access.allowed_horizon_hours, access.used_horizon_hours ?? 48) * HOUR;
  let previousEnd = -Infinity;
  const rows = body.entries.map(row => {
    const start = timestamp(row?.start), end = timestamp(row?.end);
    if (row.source !== 'forecast' || row.unit !== body.unit || !finite(row.value)
      || row.slot_minutes !== 60 || row.native_resolution_minutes !== 60
      || start % HOUR !== 0 || end - start !== HOUR || start < previousEnd
      || start < Math.floor(requestedAt / HOUR) * HOUR || end > horizonEnd
      || row.expansion_method != null && row.expansion_method !== 'native'
      || row.native_start != null && timestamp(row.native_start) !== start
      || row.native_end != null && timestamp(row.native_end) !== end) throw invalid();
    previousEnd = end;
    return { start, end, value: row.value };
  });
  const intervals = normalizePriceIntervals(rows, { unit: body.unit, vatIncluded: false, source: ELECTRICITY_FORECAST_SOURCE })
    .filter(row => row.start < horizonEnd && row.end > fetchedAt)
    .map(row => ({ ...row, nativeStart: row.start, nativeEnd: row.end, nativeResolutionMinutes: 60,
      start: Math.max(row.start, requestedAt), end: Math.min(row.end, horizonEnd), predicted: true }));
  if (!intervals.length) throw invalid();
  const expiresAt = Math.min(fetchedAt + ELECTRICITY_FORECAST_POLICY.cacheTtlMs,
    generatedAt + ELECTRICITY_FORECAST_POLICY.cacheTtlMs,
    modelUpdatedAt === null ? Infinity : modelUpdatedAt + ELECTRICITY_FORECAST_POLICY.modelMaxAgeMs);
  return { ...metadata, requestedAt, fetchedAt, generatedAt, modelUpdatedAt, expiresAt, horizonEnd,
    allowedHorizonHours: Math.min(48, access.allowed_horizon_hours), intervals };
}

export async function fetchElectricityForecast({ now, clock = Date.now, http, signal } = {}) {
  const body = await http.json(ELECTRICITY_FORECAST_URL, { method: 'GET', signal });
  return decodeElectricityForecast(body, { requestedAt: now, fetchedAt: clock() });
}

export function unavailableElectricityForecast({ enabled = false, readOnly = false, reason } = {}) {
  return { ...metadata, enabled, available: false, status: enabled ? readOnly ? 'read-only' : 'waiting' : 'disabled',
    reason: reason ?? (enabled ? readOnly ? 'read-only-instance' : 'awaiting-forecast' : 'not-enabled'),
    readOnly, lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null, lastError: null,
    fetchedAt: null, generatedAt: null, modelUpdatedAt: null, expiresAt: null, horizonEnd: null };
}

/** Independent single-flight polling with one replaceable RAM snapshot. No store,
 * recorder or journal is accepted by this service. Reads never cause requests. */
export function startElectricityForecast({ enabled = false, clock = Date.now, http, automatic = true,
  canAcquire = () => true, fetcher = fetchElectricityForecast } = {}) {
  const ownHttp = !http;
  http ??= createHttp({ maxBytes: 128 * 1024 });
  const abort = new AbortController();
  let closed = false, flight = null, timer = null, cache = null, failures = 0;
  let lastAttemptAt = null, lastSuccessAt = null, nextAttemptAt = enabled ? clock() : null, lastError = null;
  function snapshot({ now = clock() } = {}) {
    const available = !closed && enabled && cache !== null && now >= cache.fetchedAt
      && now < cache.expiresAt && cache.intervals.some(row => row.end > now);
    const result = { ...unavailableElectricityForecast({ enabled }), ...(cache ?? {}), available,
      status: !enabled ? 'disabled' : closed ? 'stopped' : available ? lastError ? 'degraded' : 'ok'
        : cache ? 'stale' : flight ? 'running' : lastError ? 'error' : 'waiting',
      reason: !enabled ? 'not-enabled' : closed ? 'stopped' : available ? null : cache ? 'forecast-stale' : lastError ?? 'awaiting-forecast',
      lastAttemptAt, lastSuccessAt, nextAttemptAt, lastError, error: lastError,
      intervals: available ? cache.intervals.filter(row => row.end > now).map(row => ({ ...row })) : [] };
    return result;
  }
  function status(options) { const { intervals: _intervals, ...result } = snapshot(options); return result; }
  function runDue() {
    if (closed || !enabled || !canAcquire() || nextAttemptAt > clock()) return Promise.resolve();
    if (flight) return flight;
    lastAttemptAt = clock();
    flight = Promise.resolve().then(async () => {
      try {
        const result = await fetcher({ now: lastAttemptAt, clock, http, signal: abort.signal });
        if (closed || !canAcquire()) return;
        cache = result; failures = 0; lastError = null; lastSuccessAt = clock();
        nextAttemptAt = clock() + ELECTRICITY_FORECAST_POLICY.pollMs;
      } catch (error) {
        if (closed || !canAcquire()) return;
        lastError = error?.code === 'invalid-electricity-forecast' ? error.code : providerFailureCode(error);
        failures = Math.min(8, failures + 1);
        const requested = finite(error?.retryAfterMs) ? Math.min(24 * HOUR, Math.max(0, error.retryAfterMs)) : 0;
        nextAttemptAt = clock() + Math.max(requested, Math.min(6 * HOUR, ELECTRICITY_FORECAST_POLICY.pollMs * 2 ** (failures - 1)));
      }
    }).finally(() => { flight = null; });
    return flight;
  }
  if (automatic && enabled) {
    void runDue();
    timer = setInterval(() => { void runDue(); }, MINUTE);
    timer.unref();
  }
  return { snapshot, status, runDue, async close() {
    if (closed) return;
    closed = true; clearInterval(timer); abort.abort(); cache = null;
    if (ownHttp) http.close?.();
    await flight;
  } };
}

/** Charging-only outlook; official rows already include the household tariff.
 * Splitting an hourly forecast never creates additional model observations. */
export function forecastPriceOutlook({ official = [], forecast, contract, now = Date.now() } = {}) {
  const price = row => row.priceCtPerKwh ?? row.allInCentsPerKWh ?? row.totalCtPerKwh ?? row.price;
  const known = official.filter(row => finite(row.start) && finite(row.end) && row.end > row.start
    && finite(price(row)) && row.end > now).map(row => ({ ...row, priceCtPerKwh: price(row), predicted: false, uncertaintyCtPerKwh: 0 }));
  if (forecast?.available !== true || !contract || !Array.isArray(forecast.intervals)
    || forecast.intervals.length > 49 || !(forecast.fetchedAt <= now && now < forecast.expiresAt)) return known;
  let priced;
  try { priced = priceIntervals(forecast.intervals, contract); } catch { return known; }
  const predictions = [];
  for (const row of priced) {
    if (row.end <= now) continue;
    // Price evidence keeps fixed interval bounds while a worker is running.
    // The planner clips delivery at its own `now`; clipping prices on every
    // read would make unchanged current forecasts invalidate every result.
    const boundaries = new Set([row.start, row.end]);
    for (let at = Math.ceil(row.start / QUARTER) * QUARTER; at < row.end; at += QUARTER) boundaries.add(at);
    for (const published of known) for (const at of [published.start, published.end])
      if (at > row.start && at < row.end) boundaries.add(at);
    const sorted = [...boundaries].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const start = sorted[i], end = sorted[i + 1];
      if (end <= start || end <= now || known.some(p => p.start < end && p.end > start)) continue;
      predictions.push({ start, end, priceCtPerKwh: row.totalCtPerKwh, predicted: true,
        uncertaintyCtPerKwh: ELECTRICITY_FORECAST_POLICY.uncertaintyCtPerKwh,
        nativeStart: row.nativeStart, nativeEnd: row.nativeEnd, nativeResolutionMinutes: row.nativeResolutionMinutes,
        source: ELECTRICITY_FORECAST_SOURCE, fetchedAt: forecast.fetchedAt, generatedAt: forecast.generatedAt });
    }
  }
  return [...known, ...predictions].sort((a, b) => a.start - b.start);
}
