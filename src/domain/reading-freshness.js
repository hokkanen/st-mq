// Source validity and operational attention are different policies. These
// defaults are shared by acquisition, recording, learning and presentation;
// changing learning validity still requires a new algorithm version.
export const H66_MAX_AGE_MS = 5 * 60_000;
export const DEFAULT_SOURCE_MAX_AGE_MS = 5 * 60_000;
export const OUTDOOR_MAX_AGE_MS = 30 * 60_000;
export const PROVIDER_CURRENT_ATTENTION_MS = 30 * 60_000;
export const PROVIDER_TEMPERATURE_ATTENTION_MS = 2 * 60 * 60_000;

export const outdoorMaxAgeMs = source => source === 'husdata-h66' ? H66_MAX_AGE_MS : OUTDOOR_MAX_AGE_MS;
export const outdoorTemperatureInRange = value => Number.isFinite(value) && value >= -60 && value <= 50;

/** Read-only recorder availability, using the recorder's own deadline basis. */
export function recordingSourceUsable(row, now) {
  const freshness = row.freshness;
  if (!freshness) return false;
  if (['last-reported', 'held', 'held-attention'].includes(freshness.status)) return true;
  if (freshness.status === 'recorded-interval') return Number.isFinite(row.lastPollAt)
    && row.lastPollAt <= now && now - row.lastPollAt <= 5 * 60_000;
  if (freshness.status !== 'fresh' || !Number.isFinite(freshness.sourceObservedAt) || freshness.sourceObservedAt > now) return false;
  const age = now - freshness.sourceObservedAt;
  return freshness.maxAgeMs === null || Number.isFinite(freshness.maxAgeMs)
    && (freshness.ageBasis === 'periodic-report' ? age < freshness.maxAgeMs : age <= freshness.maxAgeMs);
}
