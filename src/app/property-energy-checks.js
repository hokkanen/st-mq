import { recordedEnergyGroups } from '../storage/energy-history.js';
import { recordedTransport } from '../domain/recording-source.js';

const SIGNAL = 'property_import_energy_counter';
const reading = row => row ? { valueKwh:row.value, sourceTime:row.source_time, receivedAt:row.received_at,
  transport:recordedTransport(row) } : null;

// Valid counter periods advance in source time without overlapping. Share one
// evidence cursor across them so a long run of gaps does not rescan the complete
// energy history for every counter. A recorded interval may span several pairs.
function latestComparison(store,pairs,now) {
  if (!pairs.length) return null;
  const {source,device}=pairs[0].row;
  const groups=recordedEnergyGroups(store,{from:pairs[0].previous.source_time,to:pairs.at(-1).row.source_time,
    now,input:'providers',prefix:'property',source,device});
  let next=groups.next(),comparison=null;
  function* interval(start,end) {
    while(!next.done&&next.value.end<=start)next=groups.next();
    while(!next.done&&next.value.start<end) {
      yield next.value;
      if(next.value.end>=end)return;
      next=groups.next();
    }
  }
  try {
    for(const {row,previous} of pairs) {
      const check=store.checkEnergyAudit(row,previous,now,interval(previous.source_time,row.source_time));
      if(check.comparison)comparison=check.comparison;
    }
    return comparison;
  } finally { groups.return?.(); }
}

/** Keep meter arrival and comparison availability separate. The public result
 * contains only counter values, timestamps and interval evidence; equipment and
 * provider identifiers stay inside the database queries.
 */
export function propertyEnergyCheckSummary(store, { now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || Math.abs(now) > 8640000000000000)
    throw new TypeError('Property checks require a valid receipt cutoff');
  const latest = store.db.prepare(`SELECT * FROM active_energy_audits AS energy_audits WHERE signal=? AND source_time<=? AND received_at<=?
    ORDER BY received_at DESC,id DESC LIMIT 1`).get(SIGNAL,now,now);
  const summary = { status:'no-readings', readingCount:0, latestReading:null, previousReading:null,
    coverage:null, comparison:null, lastSuccessfulComparison:null };
  const result = { kind:'property-meter-summary', signal:SIGNAL, summary };
  if (!latest) return result;

  // Track the highest preceding meter timestamp in receipt order. Delayed
  // readings remain visible but cannot replace that baseline. This single scan
  // also avoids a growing predecessor lookup for each older counter.
  const pairs=[];
  let highest=null,previous=null;
  for(const row of store.db.prepare(`SELECT * FROM active_energy_audits AS energy_audits WHERE source=? AND device=? AND signal=?
    AND source_time<=? AND received_at<=? ORDER BY received_at,id`).iterate(latest.source,latest.device,SIGNAL,now,now)) {
    summary.readingCount++;
    if(row.id===latest.id)previous=highest;
    else if(highest&&row.source_time>highest.source_time&&row.value>=highest.value)pairs.push({row,previous:highest});
    if(!highest||row.source_time>highest.source_time)highest=row;
  }
  summary.latestReading = reading(latest);
  summary.previousReading = reading(previous);
  Object.assign(summary,store.checkEnergyAudit(latest,previous,now));
  summary.lastSuccessfulComparison = summary.comparison;
  if (summary.comparison || !previous) return result;

  // Usually the previous few periods contain a success. If they do not, scan
  // the remaining older evidence once: no page limit can hide a valid result,
  // and no counter-by-counter history rescans are needed.
  summary.lastSuccessfulComparison=latestComparison(store,pairs.slice(-32),now)
    ?? latestComparison(store,pairs.slice(0,-32),now);
  return result;
}
