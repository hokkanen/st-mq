import { temperatureReportMaxAge } from '../domain/temperature-reports.js';
import { H66_MAX_AGE_MS } from '../domain/reading-freshness.js';

const EQUIPMENT_SIGNALS = ['compressor_active', 'dhw_routing', 'operating_mode', 'auxiliary_output'];
function sourceReportAge(row,raw) {
  if (['husdata-h66','simulation'].includes(row.source) && EQUIPMENT_SIGNALS.includes(row.signal)
    || row.source==='controller-estimate' && row.signal==='auxiliary_power') return H66_MAX_AGE_MS;
  if (row.source!=='mqtt-equipment' || row.signal!=='dhwr_active') return null;
  return raw.eventOnly===true ? Infinity : Number.isFinite(raw.maxAgeMs)&&raw.maxAgeMs>0 ? raw.maxAgeMs : null;
}

/** Availability has an acquisition clock, distinct from the measurement clock.
 * A failed request must break a line when it failed, not overwrite the last
 * legitimate value at an older source timestamp. Recovery projects the saved
 * value confirmed at that time, never a discarded acquisition value.
 */
function* availabilityRows(store,{from,to,input,signals}) {
  const wanted=[...signals];
  if(!wanted.length) return;
  const scope=input==='simulated' ? "c.source='simulation'" : "c.source<>'simulation'";
  const sql=`WITH gaps AS (
    SELECT c.* FROM active_recorder_coverage c WHERE c.status<>'fresh' AND c.start_at<?
      AND COALESCE((SELECT n.start_at FROM active_recorder_coverage n WHERE n.source=c.source AND n.device=c.device
        AND n.signal=c.signal AND n.id>c.id ORDER BY n.id LIMIT 1),?)>=?
      AND c.signal IN (${wanted.map(()=>'?').join(',')}) AND ${scope}
  ), transitions AS (
    SELECT c.id,c.source,c.device,c.signal,c.status,MAX(c.start_at,?) AS at,c.observation_id FROM gaps c
    UNION ALL
    SELECT f.id,f.source,f.device,f.signal,f.status,f.start_at AS at,f.observation_id
      FROM gaps c JOIN active_recorder_coverage f ON f.id=(SELECT n.id FROM active_recorder_coverage n
        WHERE n.source=c.source AND n.device=c.device AND n.signal=c.signal AND n.id>c.id ORDER BY n.id LIMIT 1)
      WHERE f.status='fresh' AND f.start_at>=? AND f.start_at<?
  ) SELECT t.*,o.unit,o.value,o.quality,o.raw,o.source_time AS original_source_time
    FROM transitions t LEFT JOIN active_observations o ON o.id=t.observation_id ORDER BY t.at,t.id`;
  for(const row of store.db.prepare(sql).iterate(to,to,from,...wanted,from,from,to)) {
    let raw={},quality=[];
    try {raw=row.raw ? JSON.parse(row.raw) : {};} catch { /* Optional metadata. */ }
    if (temperatureReportMaxAge({raw}) !== null || sourceReportAge(row,raw) !== null) continue;
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

/** Each constant-value span is proven by on-time source reports. Its endpoints
 * are drawing boundaries, never new measurements. A later source report cannot
 * repair an earlier expired deadline, and explicit failures truncate at receipt.
 */
function* confirmedReportRows(store,{from,to,input,signals,now=to}) {
  // Explicit sensor deadlines and fixed equipment freshness both prove compact
  // unchanged spans. Drawing endpoints retain the original measurement time.
  const wanted=[...signals];
  if (!wanted.length) return;
  const sql=`SELECT c.*,o.value,o.unit,o.quality,o.raw,o.source_time AS original_source_time,
    (SELECT n.start_at FROM active_recorder_coverage n WHERE n.source=c.source AND n.device=c.device
      AND n.signal=c.signal AND n.id>c.id ORDER BY n.id LIMIT 1) AS next_start
    FROM active_recorder_coverage c JOIN active_observations o ON o.id=c.observation_id
    WHERE c.signal IN (${wanted.map(()=>'?').join(',')}) AND c.start_at<=?
      AND ${input==='simulated' ? "(c.source='simulation' OR c.source='controller-estimate' AND c.device='simulated')"
        : "c.source<>'simulation' AND NOT(c.source='controller-estimate' AND c.device='simulated')"}
      AND o.received_at<=?
      AND (json_extract(o.raw,'$.reportIntervalMs')>0
        OR c.source IN ('husdata-h66','simulation') AND c.signal IN (${EQUIPMENT_SIGNALS.map(signal=>`'${signal}'`).join(',')})
        OR c.source='controller-estimate' AND c.signal='auxiliary_power'
        OR c.source='mqtt-equipment' AND c.signal='dhwr_active')
      AND (c.status<>'fresh' OR c.source_time+COALESCE(json_extract(o.raw,'$.reportIntervalMs'),
        CASE WHEN c.source='mqtt-equipment' THEN json_extract(o.raw,'$.maxAgeMs') ELSE ${H66_MAX_AGE_MS} END)
        +COALESCE(json_extract(o.raw,'$.reportGraceMs'),0)>=? OR json_extract(o.raw,'$.eventOnly')=1)
    ORDER BY c.start_at,c.id`;
  const pending=[];
  const ordered=()=>pending.sort((a,b)=>a.source_time-b.source_time||a.id-b.id);
  for (const row of store.db.prepare(sql).iterate(...wanted,Math.min(to,now),now,from)) {
    ordered();
    while(pending.length&&pending[0].source_time<row.start_at) yield pending.shift();
    const raw=JSON.parse(row.raw),periodicAge=temperatureReportMaxAge({raw}),age=periodicAge??sourceReportAge(row,raw);
    if (age===null) continue;
    const next=row.next_start??Infinity;
    if (next<from) continue;
    const start=Math.max(from,row.start_at),limit=Math.min(to,now),fresh=row.status==='fresh';
    // An extended compact span cannot reveal the intermediate receipt times.
    // For an earlier as-of query only its original observation is usable.
    const confirmedAt=row.end_at<=now ? row.source_time : row.original_source_time;
    const expiry=fresh ? Math.min(confirmedAt+age,next) : next;
    const end=Math.min(expiry,limit);
    if (end<start) continue;
    const point=(at,value,suffix,status=row.status)=>({
      id:Math.floor(Number.MAX_SAFE_INTEGER/2)+row.id*4+suffix,source:row.source,device:row.device,
      signal:row.signal,value,unit:row.unit,source_time:at,received_at:at,
      quality:JSON.stringify(value===null?['missing',status]:JSON.parse(row.quality)),
      raw:JSON.stringify({...raw,coverage:true,recorder:{...raw.recorder,status,
        originalSourceTime:row.original_source_time,temporalBasis:'recorded-availability',coverageId:row.id}}),
      import_id:null,row_number:null,coverage:true,
      ...(periodicAge!==null ? {periodicCoverage:true} : {sourceCoverage:true}),displayBoundary:true,
      observedAt:row.original_source_time,reportExpiresAt:expiry,coverageId:row.id,
    });
    pending.push(point(start,fresh?row.value:null,0));
    if (fresh) {
      // Leave the exact expiry timestamp for the missing marker; fresh recovery
      // owns its own receipt timestamp, even when its numeric value is unchanged.
      const stop=end===expiry ? end-1 : end;
      if (stop>start) pending.push(point(stop,row.value,1));
      if (expiry<=limit && expiry<next) pending.push(point(expiry,null,2,'missing-report'));
    }
  }
  ordered();yield* pending;
}

function* mergeRows(rows,other) {
  const a=rows[Symbol.iterator](),b=other[Symbol.iterator]();
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

export function* chartCoverageRows(store,options) {
  yield* mergeRows(availabilityRows(store,options),confirmedReportRows(store,options));
}

export function* mergeCoverageRows(rows,store,options) {
  yield* mergeRows(rows,chartCoverageRows(store,options));
}
