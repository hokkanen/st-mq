import { recordedEnergyGroups } from './energy-history.js';

export function previousEnergyAudit(store, row, now = Date.now()) {
  // Receipt order makes a delayed older meter timestamp observable. Use the
  // highest prior meter timestamp so it cannot become a new counter baseline.
  return store.db.prepare(`SELECT * FROM active_energy_audits AS energy_audits WHERE source=? AND device=? AND signal=?
    AND (received_at<? OR received_at=? AND id<?) AND source_time<=? AND received_at<=?
    ORDER BY source_time DESC,received_at,id LIMIT 1`)
    .get(row.source,row.device,row.signal,row.received_at,row.received_at,row.id,now,now) ?? null;
}

export function checkEnergyAudit(store, row, previous, now = Date.now(), groups) {
  if (!Number.isSafeInteger(now) || Math.abs(now) > 8640000000000000)
    throw new TypeError('Property checks require a valid receipt cutoff');
  if (row.signal !== 'property_import_energy_counter') throw new TypeError('Invalid property counter signal');
  if (!previous) return { status:'waiting-for-second-reading', coverage:null, comparison:null };
  if (row.source_time <= previous.source_time) return { status:'out-of-order-counter', coverage:null, comparison:null };
  if (row.value < previous.value) return { status:'counter-reset', coverage:null, comparison:null };
  const start = previous.source_time, end = row.source_time;
  const coverage = { start, end, coveredMs:0, durationMs:end-start, conflictingMs:0 };
  let estimatedKwh = 0, edgeEstimated = false, includesOpenInterval = false;
  for (const group of groups ?? recordedEnergyGroups(store,{from:start,to:end,now,input:'providers',prefix:'property',source:row.source,device:row.device})) {
    if (group.source !== row.source || group.device !== row.device) continue;
    const from = Math.max(group.start,start), until = Math.min(group.end,end);
    if (until <= from) continue;
    // The shared history reader merges overlapping cohorts into unusable
    // conflict spans. Count usable duration across the whole period, including
    // valid intervals after a gap, without filling any of the missing energy.
    if (group.conflict) { coverage.conflictingMs += until-from; continue; }
    if (group.values.length !== 3 || !group.values.every(Number.isFinite)) continue;
    coverage.coveredMs += until-from;
    edgeEstimated ||= from !== group.start || until !== group.end;
    includesOpenInterval ||= group.pending;
    estimatedKwh += group.values.reduce((sum,value)=>sum+value,0)*(until-from)/(group.end-group.start);
  }
  if (coverage.conflictingMs) return { status:'conflicting-coverage', coverage, comparison:null };
  if (coverage.coveredMs !== coverage.durationMs) return { status:'incomplete-coverage', coverage, comparison:null };
  const meteredKwh = row.value-previous.value;
  return { status:'compared', coverage, comparison:{start,end,estimatedKwh,meteredKwh,differenceKwh:estimatedKwh-meteredKwh,
    differencePercent:meteredKwh>0 ? (estimatedKwh-meteredKwh)/meteredKwh*100 : null,
    edgeEstimated,includesOpenInterval,basis:edgeEstimated ? 'diagnostic-only-complete-coverage-with-average-power-at-edges'
      : 'diagnostic-only-matching-complete-intervals'} };
}
