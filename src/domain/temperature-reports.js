export const GARAGE_TEMPERATURE_POLL_MS = 30_000;
export const GARAGE_TEMPERATURE_MAX_AGE_MS = 120_000;

export const DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS = 70 * 60_000;
export const DEFAULT_TEMPERATURE_REPORT_GRACE_MS = 5 * 60_000;

// The policy is recorded with the observation so later configuration changes
// cannot reinterpret an older period's report deadline.
export function temperatureReportMaxAge(observation) {
  const interval = observation?.raw?.reportIntervalMs;
  const grace = observation?.raw?.reportGraceMs ?? 0;
  return Number.isSafeInteger(interval) && interval > 0
    && Number.isSafeInteger(grace) && grace >= 0 && Number.isSafeInteger(interval + grace)
    ? interval + grace : null;
}
