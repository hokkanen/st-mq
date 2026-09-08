/** Availability has an acquisition clock, distinct from the measurement clock.
 * A failed request must break a line when it failed, not overwrite the last
 * legitimate value at an older source timestamp. Recovery projects the saved
 * value confirmed at that time, never a discarded acquisition value.
 */
export function* chartCoverageRows(store,{from,to,input,signals}) {
  const wanted=[...signals];
  if(!wanted.length) return;
  const scope=input==='simulated' ? "c.source='simulation'" : "c.source<>'simulation'";
  const sql=`WITH gaps AS (
    SELECT c.* FROM recorder_coverage c WHERE c.status<>'fresh' AND c.start_at<?
      AND COALESCE((SELECT n.start_at FROM recorder_coverage n WHERE n.source=c.source AND n.device=c.device
        AND n.signal=c.signal AND n.id>c.id ORDER BY n.id LIMIT 1),?)>=?
      AND c.signal IN (${wanted.map(()=>'?').join(',')}) AND ${scope}
  ), transitions AS (
    SELECT c.id,c.source,c.device,c.signal,c.status,MAX(c.start_at,?) AS at,c.observation_id FROM gaps c
    UNION ALL
    SELECT f.id,f.source,f.device,f.signal,f.status,f.start_at AS at,f.observation_id
      FROM gaps c JOIN recorder_coverage f ON f.id=(SELECT n.id FROM recorder_coverage n
        WHERE n.source=c.source AND n.device=c.device AND n.signal=c.signal AND n.id>c.id ORDER BY n.id LIMIT 1)
      WHERE f.status='fresh' AND f.start_at>=? AND f.start_at<?
  ) SELECT t.*,o.unit,o.value,o.quality,o.raw,o.source_time AS original_source_time
    FROM transitions t LEFT JOIN observations o ON o.id=t.observation_id ORDER BY t.at,t.id`;
  for(const row of store.db.prepare(sql).iterate(to,to,from,...wanted,from,from,to)) {
    let raw={},quality=[];
    try {raw=row.raw ? JSON.parse(row.raw) : {};} catch { /* Optional metadata. */ }
    try {quality=row.quality ? JSON.parse(row.quality) : [];} catch { /* Missing markers remain missing. */ }
    const fresh=row.status==='fresh';
    yield {id:Math.floor(Number.MAX_SAFE_INTEGER/2)+row.id,source:row.source,device:row.device,signal:row.signal,
      value:fresh ? row.value : null,unit:row.unit??'unknown',source_time:row.at,received_at:row.at,
      quality:JSON.stringify(fresh ? quality : ['missing',row.status]),
      raw:JSON.stringify({...raw,coverage:true,recorder:{...raw?.recorder,status:row.status,
        originalSourceTime:row.original_source_time,temporalBasis:'recorded-availability',coverageId:row.id}}),
      import_id:null,row_number:null,coverage:true};
  }
}

export function* mergeCoverageRows(rows,store,options) {
  const a=rows[Symbol.iterator](),b=chartCoverageRows(store,options)[Symbol.iterator]();
  try {
    let x=a.next(),y=b.next();
    while(!x.done||!y.done) {
      if(!x.done&&(y.done||x.value.source_time<=y.value.source_time)) {yield x.value;x=a.next();}
      else {yield y.value;y=b.next();}
    }
  } finally {
    for(const iterator of [a,b])try{iterator.return?.();}catch{/* Preserve the original read/projection failure. */}
  }
}
