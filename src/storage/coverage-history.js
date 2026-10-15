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
    WHERE ${alias}.status='fresh' AND ${alias}.samples>0
      AND continuation.source=${alias}.source AND continuation.device=${alias}.device
      AND continuation.signal=${alias}.signal AND continuation.status='fresh'
      AND continuation.start_at=${alias}.start_at AND continuation.observation_id=${alias}.observation_id
      AND continuation.samples>0 AND (${order})
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
