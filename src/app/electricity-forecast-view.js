import { priceIntervals } from '../domain/prices.js';

/** An expiring display projection, never a market snapshot or recorded series. */
export function electricityForecastView({ forecast, official = [], contract, now }) {
  const empty = { ...(forecast ?? { enabled: false, status: 'disabled', available: false }), intervals: [] };
  if (!forecast?.available || !Number.isFinite(forecast.expiresAt) || now >= forecast.expiresAt) return empty;
  const publishedThrough = official.reduce((end, row) => Number.isFinite(row.start) && Number.isFinite(row.end)
    && row.end > row.start && Number.isFinite(row.spotCtPerKwh) && row.unit === 'c/kWh' && row.vatIncluded === false
    ? Math.max(end, row.end) : end, now);
  const intervals = (forecast.intervals ?? []).filter(row => row.end > publishedThrough)
    .map(row => ({ ...row, start: Math.max(row.start, publishedThrough, now) }));
  // Missing contract coverage cannot manufacture an all-in forecast. Raw spot
  // predictions still remain useful and retain their original native intervals.
  const priced = intervals.flatMap(row => {
    try { return priceIntervals([row], contract); }
    catch { return [{ ...row, totalCtPerKwh: null }]; }
  });
  return { ...empty, publishedThrough, intervals: priced };
}
