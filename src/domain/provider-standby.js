import { OUTDOOR_MAX_AGE_MS, outdoorTemperatureInRange, recordingSourceUsable } from './reading-freshness.js';

export const STANDBY_CHECK_MS = 60 * 60_000;
export const STANDBY_SOURCES = Object.freeze({ outdoor: 'openmeteo', weather: 'openmeteo', market: 'elering' });
export const standbyCheckOverdue = (check, now) => Number.isFinite(check?.nextAttemptAt)
  && check.nextAttemptAt >= 0 && now - check.nextAttemptAt > 60_000;

/** Assess a decoded response, not mere HTTP reachability. These diagnostics
 * never become observations, forecast snapshots or selected market intervals. */
export function standbyAssessment(name, result, now) {
  const source = STANDBY_SOURCES[name];
  if (name === 'outdoor') {
    const row = result?.find?.(row => row.source === source && row.signal === 'outdoor_temperature');
    if (!row || !outdoorTemperatureInRange(row.value) || row.unit !== 'degC' || !Number.isFinite(row.sourceTime)
      || row.sourceTime > now || now - row.sourceTime > OUTDOOR_MAX_AGE_MS) throw new Error('Invalid standby outdoor reading');
    return { status: 'ok', sourceObservedAt: row.sourceTime, coverage: null, solarStatus: null };
  }
  if (result?.source !== source) throw new Error('Unexpected standby source');
  const rows = (name === 'weather' ? result.forecast : result.intervals)?.filter(row => row.end > now);
  if (!rows?.length) throw new Error('Missing standby coverage');
  let cursor = now, gaps = false;
  for (const row of rows) {
    if (!Number.isFinite(row.start) || !Number.isFinite(row.end) || row.end <= row.start
      || !Number.isFinite(name === 'weather' ? row.outdoorC : row.spotCtPerKwh)) throw new Error('Invalid standby coverage');
    if (row.start > cursor) gaps = true;
    if (!gaps) cursor = Math.max(cursor, row.end);
  }
  if (cursor <= now) throw new Error('Missing current standby coverage');
  const solarStatus = name === 'weather' ? rows.every(row => Number.isFinite(row.solarRadiationWm2)) ? 'available'
    : rows.some(row => Number.isFinite(row.solarRadiationWm2)) ? 'partial' : 'unavailable' : null;
  const coverage = { current: true, gaps, knownUntil: Math.max(...rows.map(row => row.end)) };
  if (name === 'market') coverage.completeToday = result.coverage?.completeToday === true;
  return { status: gaps || name === 'market' && !coverage.completeToday
    || name === 'weather' && solarStatus !== 'available' ? 'partial' : 'ok',
  sourceObservedAt: null, coverage, solarStatus };
}

/** Only the explicitly replaced outdoor provider is standby. Other sources,
 * including individual FMI station streams, retain their existing treatment. */
export function outdoorStandbyStatus(recording, provider, now) {
  const rows = recording.parameters ?? [];
  const primary = provider?.source === 'fmi' && (provider.acquisition?.selected ?? provider.source) === 'fmi'
    ? rows.filter(row => row.source === 'fmi' && row.signal === 'outdoor_temperature'
    && row.observedThisRun === true && row.freshness?.status === 'fresh' && recordingSourceUsable(row, now)) : [];
  return { ...recording, parameters: rows.map(row => row.source === 'openmeteo' && row.signal === 'outdoor_temperature'
    ? { ...row, standby: primary.some(candidate => candidate.unit === row.unit && candidate.policy === row.policy) } : row) };
}
