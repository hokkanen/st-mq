/** Immutable recovery rows can retain a longer confirmation of the same
 * original fresh span. Select its most complete source/availability continuation without
 * changing either source row or double-counting their shared prefix. */
export function selectedCoverageSpan(alias, through = null, futureFallback = false) {
  // Keep end bounds from selecting a broad signal/end range instead of the
  // exact stream/start cohort. Unary + retains current numeric/NULL semantics.
  const dominates = `+continuation.end_at>=${alias}.end_at
    AND (continuation.end_at>${alias}.end_at OR continuation.source_time>${alias}.source_time)
    AND continuation.source_time>=${alias}.source_time`;
  // Readers which retain only the original observation from a future compact
  // endpoint must prefer any genuinely known equivalent endpoint. If none is
  // known, their existing original-observation fallback still applies.
  const order = futureFallback ? `(${alias}.end_at>${through} AND +continuation.end_at<=${through}
    OR ((${alias}.end_at<=${through} AND +continuation.end_at<=${through})
      OR (${alias}.end_at>${through} AND +continuation.end_at>${through})) AND ${dominates})`
    : `${dominates} ${through === null ? '' : `AND +continuation.end_at<=${through}`}`;
  return `NOT EXISTS (SELECT 1 FROM active_recorder_coverage continuation
    WHERE ${alias}.status='fresh' AND (${alias}.samples>0 OR ${alias}.evidence IS NOT NULL)
      AND continuation.source=${alias}.source AND continuation.device=${alias}.device
      AND continuation.signal=${alias}.signal AND continuation.status='fresh'
      AND continuation.start_at=${alias}.start_at AND continuation.observation_id=${alias}.observation_id
      AND (continuation.samples>0 OR continuation.evidence IS NOT NULL) AND (${order})
      AND ${alias}.source_time<=${alias}.end_at
      AND continuation.source_time<=continuation.end_at)`;
}

/** Recovery insertion order is not source chronology. Equal-start contrary
 * transitions keep their original ID precedence; equivalent continuations are
 * selected above and do not become artificial stop boundaries. */
function nextCoverage(alias, column, through, futureFallback) {
  return `(SELECT next.${column} FROM active_recorder_coverage next
    WHERE next.source=${alias}.source AND next.device=${alias}.device AND next.signal=${alias}.signal
      AND next.end_at>=${alias}.start_at
      AND (next.start_at,next.id)>(${alias}.start_at,${alias}.id)
      AND ${selectedCoverageSpan('next', through, futureFallback)}
    ORDER BY next.start_at,next.id LIMIT 1)`;
}
export const nextCoverageStart = (alias, through = null, futureFallback = false) => nextCoverage(alias, 'start_at', through, futureFallback);
export const nextCoverageId = (alias, through = null, futureFallback = false) => nextCoverage(alias, 'id', through, futureFallback);

/** Seek one boundary per physical stream, then only the requested transitions.
 * Skip over each complete stream in the index instead of DISTINCT-scanning its
 * retained spans. A compact span may start arbitrarily far before the window;
 * its immediate predecessor is required even when its last report has expired.
 * Raw stream discovery is intentional: selection remains on the actual spans,
 * including proposed recovery views and equivalent continuations.
 */
export function coverageWindow(store, { signals, from, through = null, futureFallback = false }) {
  const wanted = new Set(signals), windows = [], params = [];
  const first = store.db.prepare(`SELECT source,device,signal FROM recorder_coverage
    ORDER BY source,device,signal LIMIT 1`);
  // Strict seeks at each level skip the complete equal prefix. SQLite's tuple
  // comparison can seek to its first equal row and then walk every span in it.
  const nextSignal = store.db.prepare(`SELECT source,device,signal FROM recorder_coverage
    WHERE source=? AND device=? AND signal>? ORDER BY signal LIMIT 1`);
  const nextDevice = store.db.prepare(`SELECT source,device,signal FROM recorder_coverage
    WHERE source=? AND device>? ORDER BY device,signal LIMIT 1`);
  const nextSource = store.db.prepare(`SELECT source,device,signal FROM recorder_coverage
    WHERE source>? ORDER BY source,device,signal LIMIT 1`);
  const next = stream => nextSignal.get(stream.source, stream.device, stream.signal)
    ?? nextDevice.get(stream.source, stream.device) ?? nextSource.get(stream.source);
  const boundary = store.db.prepare(`SELECT c.start_at FROM active_recorder_coverage c
    ${through === null ? '' : 'CROSS JOIN (SELECT ? AS known_at) history_clock'}
    WHERE c.source=? AND c.device=? AND c.signal=? AND c.start_at<?
      AND ${selectedCoverageSpan('c', through === null ? null : 'history_clock.known_at', futureFallback)}
    ORDER BY c.start_at DESC,c.id DESC LIMIT 1`);
  const clock = through === null ? [] : [through];
  for (let stream = first.get(); stream; stream = next(stream)) {
    if (!wanted.has(stream.signal)) continue;
    const prior = boundary.get(...clock, stream.source, stream.device, stream.signal, from);
    windows.push('(?,?,?,?)'); params.push(stream.source, stream.device, stream.signal, prior?.start_at ?? from);
  }
  return { sql: `coverage_window(source,device,signal,from_at) AS (${windows.length
    ? `VALUES ${windows.join(',')}` : 'SELECT NULL,NULL,NULL,NULL WHERE 0'})`, params };
}
