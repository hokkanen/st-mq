import { fireplaceRate, fireplaceActive, FIREPLACE_HORIZON_MS } from '../domain/fireplace.js';
import { learningPrefixRanges } from '../recovery/learning-prefix.js';

const instant = value => typeof value === 'number' ? value : Date.parse(value);
const HOUR = 3_600_000;

/** A later manual-source revision may only change the unconsumed future. Seek
 * the temporal end of every retained range: the last cursor alone is unsafe
 * when journal entries were committed out of timestamp order. */
export function unchangedFireplacePrefix(store, input, { fromRevision, toRevision, cursor, epoch } = {}) {
  if (![fromRevision,toRevision,cursor].every(Number.isSafeInteger)
    || fromRevision < 0 || toRevision <= fromRevision || cursor <= 0) return false;
  const changed=store.db.prepare(`SELECT MIN(CASE WHEN e.kind='remove' THEN p.at ELSE e.at END) at,
    SUM(CASE WHEN e.kind='remove' AND p.at IS NULL THEN 1 ELSE 0 END) missing
    FROM active_fireplace_events e LEFT JOIN fireplace_events p ON p.id=e.target_id
    WHERE e.input=? AND e.id>? AND e.id<=?`).get(input,fromRevision,toRevision);
  if (!Number.isSafeInteger(changed.at) || changed.missing) return false;
  epoch ??= store.db.prepare('SELECT epoch FROM learning_epochs WHERE input=?').get(input)?.epoch ?? 'original';
  const ranges=learningPrefixRanges(store.db,input,epoch,cursor);
  if (!ranges.length) return false;
  return ranges.every(range=>{
    const latest=store.db.prepare(`SELECT at FROM learning_journal_entries INDEXED BY learning_entries_epoch_time
      WHERE epoch=? AND input=? AND id>? AND id<=? ORDER BY at DESC LIMIT 1`)
      .get(range.sourceEpoch,input,range.after,range.through)?.at;
    return Number.isSafeInteger(latest) && latest < changed.at;
  });
}

/** Source events are retained once. This projection is computed in memory for
 * learning, including corrected retrospective rebuilds; it never edits telemetry. */
export function fireplaceLearningContext(store, input, revision, asOf = Infinity) {
  const rows = store.db.prepare('SELECT id,at,kind,kg,target_id FROM active_fireplace_events AS fireplace_events WHERE input=? AND id<=? AND at<=? ORDER BY id')
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

/** Current control needs only loads whose release or exclusion can intersect
 * its bounded working window. Reconstruction retains the full projection above.
 * Removal ID order and its independent clock are preserved, including rollback. */
export function fireplaceWindowContext(store, input, { from, to, revision = Number.MAX_SAFE_INTEGER,
  asOf = Number.MAX_SAFE_INTEGER } = {}) {
  if (![from,to,revision,asOf].every(Number.isSafeInteger) || from < 0 || to < from)
    throw new TypeError('A bounded fireplace window and current source revision are required.');
  const head = store.db.prepare(`SELECT id FROM active_fireplace_events WHERE input=? AND id<=? AND at<=?
    ORDER BY id DESC LIMIT 1`).get(input, revision, asOf)?.id ?? 0;
  const first = store.db.prepare(`SELECT at FROM active_fireplace_events WHERE input=? AND kind='load'
    AND id<=? AND at<=? ORDER BY at,id LIMIT 1`).get(input, revision, asOf)?.at ?? null;
  const rows = store.db.prepare(`SELECT l.id,l.at,l.kg,
    (SELECT r.at FROM active_fireplace_events r WHERE r.input=l.input AND r.target_id=l.id
      AND r.id<=? AND r.at<=? ORDER BY r.id LIMIT 1) removed_at
    FROM active_fireplace_events l WHERE l.input=? AND l.kind='load' AND l.id<=?
      AND l.at>=? AND l.at<=? ORDER BY l.at,l.id`)
    .all(revision, asOf, input, revision, Math.max(0,from-FIREPLACE_HORIZON_MS), Math.min(to,asOf));
  return { fireplaceRevision: head, fireplaceStartedAt: first,
    fireplaceEvents: rows.filter(row => row.removed_at === null).map(row => ({ id:row.id, at:row.at, litAt:row.at, kg:row.kg })),
    fireplaceExcludedRanges: rows.filter(row => row.removed_at !== null).map(row => ({ start:row.at,
      end:Math.min(row.at+FIREPLACE_HORIZON_MS,row.removed_at) })).filter(range => range.end>range.start) };
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
  if (sample.inputSegments) result.inputSegments = sample.inputSegments.flatMap(segment => {
    const boundaries = [...new Set([segment.start, segment.end, ...ignitions.map(event => instant(event.litAt ?? event.at))])]
      .filter(at => at >= segment.start && at <= segment.end).sort((a, b) => a - b);
    return boundaries.slice(1).map((to, i) => {
      const durationHours = (to - boundaries[i]) / HOUR;
      const split = { ...segment, start: boundaries[i], end: to, durationHours,
        fireplaceKgPerHour: fireplaceRate(fireplaceEvents, boundaries[i], to) };
      for (const key of ['energyKwh', 'compressorKwh', 'spaceHeatingAuxKwh', 'dhwAuxKwh', 'hydronicHeatKwh'])
        if (Number.isFinite(segment[key])) split[key] = segment[key] * (to - boundaries[i]) / (segment.end - segment.start);
      return split;
    });
  });
  return result;
}

export function fireplaceEpisodeAffected(episode, context) {
  return (context.fireplaceExcludedRanges ?? []).some(range => instant(episode.startedAt) < range.end && instant(episode.endedAt) > range.start);
}
