import { recordedEnergyGroups } from '../storage/energy-history.js';
import { previousEnergyAudit, checkEnergyAudit } from '../storage/energy-audit.js';
import { recordedTransport } from '../domain/recording-source.js';

const SIGNAL = 'property_import_energy_counter';
const reading = row => row ? { valueKwh:row.value, sourceTime:row.source_time, receivedAt:row.received_at,
  transport:recordedTransport(row) } : null;

// Valid counter periods advance in source time without overlapping. Share one
// evidence cursor across them so a long run of gaps does not rescan the complete
// energy history for every counter. A recorded interval may span several pairs.
function latestComparison(store,pairs,now) {
  let groups;
  try {
    let pair=pairs.next();
    if(pair.done)return null;
    const {source,device}=pair.value.row;
    groups=recordedEnergyGroups(store,{from:pair.value.previous.source_time,to:now,
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
    for(;!pair.done;pair=pairs.next()) {
      const {row,previous}=pair.value;
      const check=checkEnergyAudit(store,row,previous,now,interval(previous.source_time,row.source_time));
      if(check.comparison)comparison=check.comparison;
    }
    return comparison;
  } finally { groups?.return?.(); pairs.return?.(); }
}

// Retain just the highest preceding source timestamp and the current pair.
// Delayed readings and changed values at an existing timestamp remain visible,
// but cannot replace the comparison baseline. SQLite owns the ordered cursor;
// the worker uses file-backed temporary storage if ordering needs a sort.
function* comparisonPairs(store,latest,now) {
  let highest=null;
  for(const row of store.db.prepare(`SELECT * FROM active_energy_audits AS energy_audits WHERE source=? AND device=? AND signal=?
    AND source_time<=? AND received_at<=? ORDER BY received_at,id`).iterate(latest.source,latest.device,SIGNAL,now,now)) {
    if(row.id!==latest.id&&highest&&row.source_time>highest.source_time&&row.value>=highest.value)
      yield {row,previous:highest};
    if(!highest||row.source_time>highest.source_time)highest=row;
  }
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

  // A successful latest period needs only an aggregate count and its baseline,
  // never every historical counter materialized as JavaScript objects.
  summary.readingCount=store.db.prepare(`SELECT COUNT(*) AS count FROM active_energy_audits AS energy_audits
    WHERE source=? AND device=? AND signal=? AND source_time<=? AND received_at<=?`)
    .get(latest.source,latest.device,SIGNAL,now,now).count;
  const previous=previousEnergyAudit(store,latest,now);
  summary.latestReading = reading(latest);
  summary.previousReading = reading(previous);
  Object.assign(summary,checkEnergyAudit(store,latest,previous,now));
  summary.lastSuccessfulComparison = summary.comparison;
  if (summary.comparison || !previous) return result;

  // No page limit can hide a valid result. Stream older counters and energy
  // together once, keeping memory bounded even across a long run of gaps.
  summary.lastSuccessfulComparison=latestComparison(store,comparisonPairs(store,latest,now),now);
  return result;
}
