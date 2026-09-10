import { fireplaceRate, fireplaceActive, FIREPLACE_HORIZON_MS } from '../domain/fireplace.js';

const instant = value => typeof value === 'number' ? value : Date.parse(value);
const HOUR = 3_600_000;

/** Source events are retained once. This projection is computed in memory for
 * learning, including corrected retrospective rebuilds; it never edits telemetry. */
export function fireplaceLearningContext(store, input, revision, asOf = Infinity) {
  const rows = store.db.prepare('SELECT id,at,kind,kg,target_id FROM fireplace_events WHERE input=? AND id<=? AND at<=? ORDER BY id')
    .all(input, revision ?? Number.MAX_SAFE_INTEGER, Number.isFinite(asOf) ? asOf : Number.MAX_SAFE_INTEGER);
  const removed = new Map();
  for (const row of rows) if (row.kind === 'remove' && !removed.has(row.target_id)) removed.set(row.target_id, row.at);
  const loads = rows.filter(row => row.kind === 'load');
  return { fireplaceRevision: rows.at(-1)?.id ?? 0,
    fireplaceStartedAt: loads.length ? loads.reduce((earliest, row) => Math.min(earliest, row.at), Infinity) : null,
    fireplaceEvents: loads.filter(row => !removed.has(row.id)).map(row => ({ id: row.id, at: row.at, litAt: row.at, kg: row.kg })),
    fireplaceExcludedRanges: loads.filter(row => removed.has(row.id)).map(row => ({ start: row.at,
      end: Math.min(row.at + FIREPLACE_HORIZON_MS, removed.get(row.id)) })).filter(range => range.end > range.start) };
}

export function withFireplaceInputs(sample, { fireplaceEvents = [], fireplaceStartedAt = null } = {}) {
  const end = instant(sample.timestamp);
  const start = sample.windowStart == null ? end - (sample.durationHours ?? 0.25) * HOUR : instant(sample.windowStart);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return sample;
  // Absence of a manual log before logging began is unknown, not proof of no fire.
  const known = Number.isFinite(fireplaceStartedAt) && start >= fireplaceStartedAt;
  const rate = fireplaceRate(fireplaceEvents, start, end);
  const active = fireplaceActive(fireplaceEvents, start) || rate > 0;
  if (!known && !active && !sample.fireplaceActive && !sample.fireplaceKgPerHour) return sample;
  const result = { ...sample, fireplaceKgPerHour: rate, fireplaceActive: active, fireplaceKnown: known };
  const ignitions = fireplaceEvents.filter(event => instant(event.litAt ?? event.at) >= start && instant(event.litAt ?? event.at) < end);
  if (ignitions.length) result.fireplaceIgnitions = ignitions.map(({ id, litAt, at, kg }) => ({ id, litAt: litAt ?? at, kg }));
  else delete result.fireplaceIgnitions;
  if (sample.intervalInputs) result.intervalInputs = { ...sample.intervalInputs, fireplaceKgPerHour: rate };
  if (sample.inputSegments) result.inputSegments = sample.inputSegments.flatMap(segment => {
    const boundaries = [...new Set([segment.start, segment.end, ...ignitions.map(event => instant(event.litAt ?? event.at))])]
      .filter(at => at >= segment.start && at <= segment.end).sort((a, b) => a - b);
    return boundaries.slice(1).map((to, i) => {
      const durationHours = (to - boundaries[i]) / HOUR;
      const split = { ...segment, start: boundaries[i], end: to, durationHours,
        fireplaceKgPerHour: fireplaceRate(fireplaceEvents, boundaries[i], to) };
      for (const key of ['energyKwh', 'compressorKwh', 'spaceHeatingAuxKwh', 'dhwAuxKwh'])
        if (Number.isFinite(segment[key])) split[key] = segment[key] * (to - boundaries[i]) / (segment.end - segment.start);
      return split;
    });
  });
  return result;
}

export function fireplaceEpisodeAffected(episode, context) {
  return (context.fireplaceExcludedRanges ?? []).some(range => instant(episode.startedAt) < range.end && instant(episode.endedAt) > range.start);
}
