const priority = source => source === 'entsoe' ? 2 : source === 'elering' ? 1 : 0;
const sameDocument = (a, b) => a.source === b.source && typeof a.documentId === 'string'
  && a.documentId === b.documentId && Number.isSafeInteger(a.revision) && Number.isSafeInteger(b.revision);

function compare(a, b) {
  if (priority(a.source) !== priority(b.source)) return priority(a.source) - priority(b.source);
  const aPublished = Number.isFinite(a.issuedAt) ? a.issuedAt : a.fetchedAt;
  const bPublished = Number.isFinite(b.issuedAt) ? b.issuedAt : b.fetchedAt;
  if (aPublished !== bPublished) return aPublished - bPublished;
  return a.fetchedAt - b.fetchedAt;
}

/** Receipt controls availability; it cannot downgrade a document revision.
 * ENTSO-E is the primary source and Elering fills uncovered periods. Absence in
 * a partial response is not an asserted withdrawal. Conflicting equal document
 * revisions explicitly block their overlap, including scalar-history fallback. */
export function resolveMarketIntervals(candidates, { from = -Infinity, to = Infinity } = {}) {
  const rows = candidates.filter(row => Number.isFinite(row.start) && Number.isFinite(row.end)
    && row.end > row.start && row.end > from && row.start < to
    && (Number.isFinite(row.spotCtPerKwh) || row.authorityConflict === true) && row.unit === 'c/kWh' && row.vatIncluded === false
    && Number.isFinite(row.fetchedAt));
  const boundaries = new Map();
  rows.forEach((row, id) => {
    for (const [at, on] of [[Math.max(from, row.start), true], [Math.min(to, row.end), false]]) {
      if (!boundaries.has(at)) boundaries.set(at, []);
      boundaries.get(at).push({ id, on });
    }
  });
  let previous = null; const active = new Set(), result = [];
  for (const [at, changes] of [...boundaries].sort((a, b) => a[0] - b[0])) {
    if (previous !== null && at > previous && active.size) {
      // Resolve each document before comparing distinct publications. Combining
      // revision order and issue-time order in one pairwise tournament is not
      // transitive when a late revision has an older issue time than another
      // document: input insertion order must never restore a superseded row.
      const revisions = new Map();
      const documentKey = row => typeof row.documentId === 'string' && Number.isSafeInteger(row.revision)
        ? JSON.stringify([row.source,row.documentId]) : null;
      for (const id of active) {
        const row = rows[id], key = documentKey(row);
        if (key !== null) revisions.set(key, Math.max(revisions.get(key) ?? -Infinity,row.revision));
      }
      const eligible = [...active].map(id => rows[id]).filter(row => {
        const key = documentKey(row); return key === null || row.revision === revisions.get(key);
      });
      let winner;
      for (const row of eligible) if (!winner || compare(row, winner) > 0) winner = row;
      const conflict = winner.authorityConflict === true || eligible.some(row => row.spotCtPerKwh !== winner.spotCtPerKwh
        && (sameDocument(row, winner) || compare(row,winner) === 0));
      result.push({ ...winner, start: previous, end: at,
        ...(conflict ? { spotCtPerKwh: null, authorityConflict: true } : {}) });
    }
    for (const { id, on } of changes) on ? active.add(id) : active.delete(id);
    previous = at;
  }
  return result;
}
