import { restoreSnapshot } from '../storage/store.js';

const MAX_AGE = 6 * 3_600_000;
const issuedTime = row => row.issuedAt == null && row.issuedAtBasis === 'fetched-snapshot' ? row.fetchedAt : row.issuedAt;

/** Forecast values known at the plotted time, never revised hindsight values.
 * Fetch references share content in SQLite but keep their original provenance. */
export function* historicalSolar(store,range,now) {
  const until=Math.min(range.to,now);
  const query=store.db.prepare(`SELECT v.*,f.fetch_metadata,
    (SELECT MIN(p.fetched_at) FROM provider_snapshot_fetches p WHERE p.content_id=f.content_id
      AND p.source=f.source AND p.kind=f.kind) AS first_fetched_at FROM provider_snapshots v
    JOIN provider_snapshot_fetches f ON f.id=v.id
    WHERE v.kind='weather' AND v.fetched_at>=? AND v.fetched_at<? ORDER BY v.fetched_at,v.id`);
  let previous=null;
  function* emit(snapshot,end) {
    if(!snapshot)return;
    for(const row of snapshot.forecast) {
      const solar=row.solar ?? row, issued=issuedTime(solar);
      const start=Math.max(range.from,snapshot.fetchedAt,row.start);
      const stop=Math.min(until,end,row.end,snapshot.fetchedAt+MAX_AGE,solar.fetchedAt+MAX_AGE,issued+MAX_AGE);
      if(!Number.isFinite(solar.fetchedAt)||!Number.isFinite(issued)||solar.fetchedAt>start||issued>start
        ||!Number.isFinite(row.solarRadiationWm2)||row.solarRadiationWm2<0||!Number.isFinite(start)||!Number.isFinite(stop)||stop<=start)continue;
      yield {...row,start,end:stop};
    }
  }
  for(const row of query.iterate(range.from-MAX_AGE,until)) {
    let payload;
    try{payload=restoreSnapshot(row.payload,row.fetch_metadata);}catch{continue;}
    if(!Array.isArray(payload.forecast))continue;
    yield* emit(previous,row.fetched_at);
    const rows=payload.forecast.map(item=>{
      const value={...item,source:item.source??row.source,fetchedAt:item.fetchedAt??row.fetched_at,issuedAt:item.issuedAt??row.issued_at};
      if(value.issuedAt==null&&Number.isFinite(row.first_fetched_at))value.fetchedAt=Math.min(value.fetchedAt,row.first_fetched_at);
      if(value.solar) {
        value.solar={...value.solar};
        if(value.solar.issuedAt==null&&Number.isFinite(row.first_fetched_at))value.solar.fetchedAt=Math.min(value.solar.fetchedAt??row.fetched_at,row.first_fetched_at);
      }
      return value;
    }).sort((a,b)=>a.start-b.start);
    // Match the acquisition cache: a newly fetched horizon may start after the
    // current hour, whose still-valid value comes from the previous snapshot.
    const first=rows[0]?.start ?? Infinity;
    const earlier=previous?.source===row.source ? previous.forecast.filter(item=>item.end>row.fetched_at&&item.end<=first):[];
    previous={source:row.source,fetchedAt:row.fetched_at,forecast:[...earlier,...rows]};
  }
  yield* emit(previous,until);
}
