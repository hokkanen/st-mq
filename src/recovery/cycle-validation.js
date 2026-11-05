/** Validate source structure in bounded, metadata-only pages. Callers own the
 * pinned snapshot and any exemption for an admitted, unfinished recovery job.
 * Yield after each page in workers; synchronous verification may report it. */
export function* verifyCycleEvidencePages(db, { id, startedAt, observationCount, lastSampleAt,
  selected = false, allowPrefix = false }) {
  const invalid = () => { throw Object.assign(new Error('Cycle source evidence failed verification. Preserve the database and retry from an intact source.'),
    { code: 'database_integrity_failed' }); };
  if(typeof id !== 'string' || !Number.isSafeInteger(startedAt) || !Number.isSafeInteger(observationCount) || observationCount<0) invalid();
  const observations = `${selected?'active_':''}learning_cycle_observations`, samples = `${selected?'active_':''}learning_cycle_samples`;
  const page=db.prepare(`SELECT o.ordinal,o.start_at,o.end_at,o.sample_id,s.sample_at FROM ${observations} o
    LEFT JOIN ${samples} s ON s.id=o.sample_id AND s.cycle_id=o.cycle_id
    WHERE o.cycle_id=? AND o.ordinal>=? ORDER BY o.ordinal LIMIT 128`);
  let ordinal=0,end=startedAt,sample=null,sampleAt=null,groups=0;
  for(;;) {
    const batch=page.all(id,ordinal);
    if(!batch.length) break;
    for(const row of batch) {
      if(!Number.isSafeInteger(row.ordinal) || !Number.isSafeInteger(row.start_at) || !Number.isSafeInteger(row.end_at)
        || row.ordinal!==ordinal || row.start_at!==end || row.end_at<=row.start_at
        || !Number.isSafeInteger(row.sample_at) || row.end_at>row.sample_at) invalid();
      if(row.sample_id!==sample) {
        if(sample!==null && end!==sampleAt) invalid();
        if(sampleAt!==null && row.sample_at<=sampleAt) invalid();
        sample=row.sample_id;sampleAt=row.sample_at;groups++;
      }
      ordinal++;end=row.end_at;
      if(ordinal>observationCount) invalid();
    }
    yield ordinal;
  }
  const bounds=db.prepare(`SELECT COUNT(*) n,MIN(sample_at) first,MAX(sample_at) last FROM ${samples} WHERE cycle_id=?`).get(id);
  const expectedGroups=bounds.n;
  if(expectedGroups && (!Number.isSafeInteger(bounds.first) || !Number.isSafeInteger(bounds.last)
    || bounds.first<=startedAt || !Number.isSafeInteger(lastSampleAt) || bounds.last>lastSampleAt)) invalid();
  if(allowPrefix && ordinal<observationCount) {
    if(!Number.isSafeInteger(lastSampleAt) || end>lastSampleAt || sampleAt!==null && sampleAt>lastSampleAt || groups>expectedGroups) invalid();
    return;
  }
  if(ordinal!==observationCount || groups!==expectedGroups || sample!==null && (end!==sampleAt || end!==lastSampleAt)) invalid();
}
