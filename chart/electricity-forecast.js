export const PRICE_FORECAST_DASH = Object.freeze([1, 8]);
const PRICE_KEYS = { spot_price: 'spotCtPerKwh', all_in_price: 'totalCtPerKwh' };

/** Append RAM-only predictions to a display copy. Canonical history/cache data
 * stays untouched; the same existing price toggles, scales and dates apply. */
export function withElectricityForecast(series, forecast, range, now) {
  if (!forecast?.available || !(now < forecast.expiresAt) || !Array.isArray(forecast.intervals)) return series;
  let result = series;
  for (const [key, field] of Object.entries(PRICE_KEYS)) {
    if (!Array.isArray(series[key])) continue;
    const original = series[key];
    const cutoff = original.reduce((end, point) => Number.isFinite(point.y)
      ? Math.max(end, point.intervalEnd ?? point.x + 1) : end, Math.max(now, forecast.publishedThrough ?? now));
    const rows = forecast.intervals.filter(row => row.end > Math.max(range.from, cutoff) && row.start < range.to);
    if (!rows.length) continue;
    const points = original.filter(point => point.x < Math.max(rows[0].start, range.from, cutoff));
    const originalCount = points.length;
    let previousEnd = cutoff;
    for (const row of rows) {
      const start = Math.max(row.start, range.from, cutoff), end = Math.min(row.end, range.to);
      if (end <= start || !Number.isFinite(row[field])) continue;
      if (start > previousEnd && points.length) points.push({ x: start - 1, y: null });
      const metadata = { priceForecast: true, source: forecast.source, fetchedAt: forecast.fetchedAt,
        generatedAt: forecast.generatedAt, modelUpdatedAt: forecast.modelUpdatedAt,
        nativeResolutionMinutes: row.nativeResolutionMinutes, intervalStart: row.nativeStart ?? row.start,
        intervalEnd: row.nativeEnd ?? row.end };
      points.push({ ...metadata, x: start, y: row[field] }, { ...metadata, x: end - 1, y: row[field] });
      previousEnd = end;
    }
    if (points.length === originalCount) continue;
    if (result === series) result = { ...series };
    result[key] = points;
  }
  return result;
}

/** The response is a local RAM-cache read, never a provider request. One shared
 * browser request at most; status changes and expiry invalidate the projection. */
export function createElectricityForecastLoader({ api, clock = Date.now }) {
  let cached, key, pending, controller, checkedAt = -Infinity, closed = false;
  return {
    async load(status) {
      const health = status?.providers?.electricityForecast;
      const nextKey = JSON.stringify([health?.enabled, health?.available, health?.fetchedAt, health?.expiresAt,
        status?.contract, status?.providers?.market?.lastSuccessAt, status?.readOnly]);
      if (!health?.enabled || health.available === false) {
        controller?.abort(); controller = null; pending = undefined; cached = undefined; key = nextKey; return null;
      }
      if (pending && nextKey === key) return pending;
      if (key === nextKey && clock() - checkedAt < 60_000 && (!cached || clock() < cached.expiresAt)) return cached;
      controller?.abort(); controller = new AbortController(); key = nextKey;
      const request = controller;
      pending = (async () => {
        const timeout = setTimeout(() => request.abort(), 5_000);
        try {
          const response = await api('/api/electricity-forecast', { signal: request.signal });
          if (!closed && request === controller) { cached = response; checkedAt = clock(); }
          return request === controller ? cached : null;
        } catch {
          if (request === controller) { cached = undefined; checkedAt = clock(); }
          return null;
        } finally { clearTimeout(timeout); if (request === controller) pending = undefined; }
      })();
      return pending;
    },
    close() { closed = true; controller?.abort(); controller = null; pending = undefined; cached = undefined; },
  };
}
