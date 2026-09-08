import { PHASE_ENERGY_SIGNALS } from '../domain/history-series.js';
import { ENERGY_ROLLUP_MS, energyRollupRows, rollupWatermark } from '../storage/chart-rollups.js';

const HOUR = 3_600_000;
const invalid = new Set(['missing','invalid_numeric','invalid_unit','provider_error','integration_gap','unknown_phase_share']);
const scope = input => input === 'simulated' ? "source='simulation'" : "source<>'simulation'";
const prefixOf = signal => signal.startsWith('ev1_') ? 'ev1' : 'property';

export function recordedEnergyStart(store, prefix, input) {
  const row = store.db.prepare(`SELECT raw,source_time FROM observations WHERE signal=? AND ${scope(input)}
    ORDER BY source_time,id LIMIT 1`).get(`${prefix}_energy_l1`);
  if (!row) return Infinity;
  try { return JSON.parse(row.raw)?.intervalStart ?? row.source_time; } catch { return row.source_time; }
}

/** Each phase query includes the first following interval. Reading just this
 * boundary instead of an entire extra day keeps sparse/fallback windows bounded. */
function* rawRows(store, { from, to, now, input, prefix, source, device, beforeId, afterId }) {
  const signals = prefix ? [1, 2, 3].map(phase => `${prefix}_energy_l${phase}`) : PHASE_ENERGY_SIGNALS;
  const clauses = [scope(input), 'received_at<=?'], values = [now];
  if (source !== undefined) { clauses.push('source=?'); values.push(source); }
  if (device !== undefined) { clauses.push('device=?'); values.push(device); }
  if (beforeId !== undefined) { clauses.push('id<=?'); values.push(beforeId); }
  if (afterId !== undefined) { clauses.push('id>?'); values.push(afterId); }
  const columns = 'id,source,device,signal,value,unit,source_time,received_at,quality,raw';
  const condition = clauses.join(' AND '), until = Math.min(to, now);
  yield* store.db.prepare(`SELECT ${columns} FROM observations
    WHERE signal IN (${signals.map(() => '?').join(',')}) AND source_time>=? AND source_time<=? AND ${condition}
    ORDER BY source_time,id`).iterate(...signals, from, until, ...values);
  if (now <= to) return;
  const next = store.db.prepare(`SELECT ${columns} FROM observations
    WHERE signal=? AND source_time>? AND source_time<=? AND ${condition} ORDER BY source_time,id LIMIT 1`);
  yield* signals.map(signal => next.get(signal, to, Math.min(now, to + 24 * HOUR), ...values)).filter(Boolean)
    .sort((a, b) => a.source_time - b.source_time || a.id - b.id);
}

function* rawGroups(rows, stats) {
  let key = null, group = null;
  for (const row of rows) {
    stats.rows++;
    let raw, flags;
    try { raw = JSON.parse(row.raw); flags = JSON.parse(row.quality); } catch { continue; }
    const prefix = prefixOf(row.signal);
    const nextKey = JSON.stringify([row.source, row.device, prefix, raw?.intervalStart, raw?.intervalEnd]);
    if (nextKey !== key) {
      if (group) yield group;
      key = nextKey;
      group = { source: row.source, device: row.device, prefix, start: raw?.intervalStart, end: raw?.intervalEnd, values: [null, null, null] };
    }
    group.values[Number(row.signal.at(-1)) - 1] = row.unit === 'kWh' && Number.isFinite(row.value) && row.value >= 0
      && Array.isArray(flags) && !flags.some(flag => invalid.has(flag)) ? row.value : null;
  }
  if (group) yield group;
}

function* rollupGroups(rows, stats) {
  let key = null, group = null;
  for (const row of rows) {
    stats.rollupRows++;
    const prefix = prefixOf(row.signal), next = JSON.stringify([row.bucket, row.source, row.device, prefix]);
    if (next !== key) {
      if (group) yield group;
      key = next;
      group = { prefix, source: row.source, device: row.device, bucket: row.bucket,
        start: row.bucket, end: row.bucket + ENERGY_ROLLUP_MS, phases: [null, null, null] };
    }
    group.phases[Number(row.signal.at(-1)) - 1] = row;
  }
  if (group) yield group;
}

/** Complete 15-minute energy sums give equivalent cost for quarter-aligned
 * prices. Incomplete buckets, selection edges and finer tariff changes retain
 * raw intervals. Decimated drawing points never determine energy or cost. */
export function addRecordedEnergy({store,range,now,input,envelopes,timing}) {
  const stats = {rows:0,intervals:0,rollupRows:0,aggregated:false,aggregationMinutes:null,rawFallbackBuckets:0};
  const lastEnd = new Map();
  const project = (name,start,end,value,metadata) => {
    const line = envelopes[name]; if (!line) return;
    const a = Math.max(start,range.from), b = Math.min(end,range.to,now);
    if (b <= a) return;
    if (lastEnd.has(name) && a > lastEnd.get(name)) { line.add(lastEnd.get(name),null); line.add(a-1,null); }
    line.add(a,value,metadata); line.add(b-1,value,metadata);
    lastEnd.set(name,Math.max(lastEnd.get(name) ?? -Infinity,b));
  };
  const accept = group => {
    const {start,end,prefix,values} = group;
    const duration = end-start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || duration <= 0 || duration > 24*HOUR
      || start >= range.to || end <= range.from) return;
    stats.intervals++;
    const complete = values.length === 3 && values.every(Number.isFinite);
    const total = complete ? values.reduce((sum,value)=>sum+value,0) : null;
    const metadata = {basis:'estimated',intervalStart:start,intervalEnd:end,source:group.source,fromEnergy:true,
      ...(group.aggregated ? {aggregated:true,aggregationMinutes:15,basis:'estimated-quarter-hour-average'} : {})};
    project(prefix === 'ev1' ? 'charger_power' : 'property_power',start,end,total === null ? null : total*HOUR/duration,metadata);
    for (let phase=0;phase<3;phase++) {
      const value = values[phase] ?? null, power = value === null ? null : value*HOUR/duration;
      project(`${prefix}_current_l${phase+1}`,start,end,power === null ? null : power/0.23,{...metadata,equivalentCurrent:true});
      const energyLine = envelopes[`${prefix}_energy_l${phase+1}`];
      if (energyLine && end >= range.from && end <= Math.min(range.to,now)) energyLine.add(end,value,metadata);
    }
    if (prefix === 'ev1' && complete) timing.addEnergy('charger',start,end,total);
  };
  const watermark = range.to-range.from > 7*24*HOUR ? rollupWatermark(store.db) : null;
  const options = {from:range.from,to:range.to,now,input};
  if (watermark === null) {
    for (const group of rawGroups(rawRows(store,options),stats)) accept(group);
  } else {
    if (watermark>0) for (const group of rawGroups(rawRows(store,{...options,beforeId:watermark}),stats)) accept(group);
    const preciseBuckets = new Set();
    for (const price of timing.prices ?? []) for (const boundary of [price.start,price.end]) {
      if (Number.isFinite(boundary) && boundary%ENERGY_ROLLUP_MS!==0)
        preciseBuckets.add(Math.floor(boundary/ENERGY_ROLLUP_MS)*ENERGY_ROLLUP_MS);
    }
    for (const group of rollupGroups(energyRollupRows(store.db,{from:range.from,to:Math.min(range.to,now),input}),stats)) {
      const complete = group.start>=range.from && group.end<=Math.min(range.to,now)
        && !preciseBuckets.has(group.bucket) && group.phases.every(phase=>phase && phase.valid
          && phase.row?.unit==='kWh' && phase.coveredMs===ENERGY_ROLLUP_MS
          && phase.start===group.start && phase.end===group.end && phase.row.received_at<=now);
      if (complete) {
        stats.aggregated=true;stats.aggregationMinutes=15;
        accept({...group,values:group.phases.map(phase=>phase.energy),aggregated:true});
      } else {
        stats.rawFallbackBuckets++;
        const from=Math.max(group.start,range.from),to=Math.min(group.end,range.to,now);
        const candidates=rawGroups(rawRows(store,{...options,from,to,source:group.source,device:group.device,
          prefix:group.prefix,afterId:watermark}),stats);
        for(const original of candidates) {
          const start=Math.max(from,original.start),end=Math.min(to,original.end),duration=original.end-original.start;
          if(end<=start || duration<=0 || duration>24*HOUR) continue;
          accept({...original,start,end,values:original.values.map(value=>value===null?null:value*(end-start)/duration)});
        }
      }
    }
  }
  // Finish only after all adjacent intervals are projected, so a shared edge
  // does not acquire a spurious missing marker.
  for (const [name,end] of lastEnd) envelopes[name]?.add(end,null);
  return stats;
}
