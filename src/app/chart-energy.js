import { ENERGY_SIGNALS } from '../domain/history-series.js';

const HOUR = 3_600_000;
const invalid = new Set(['missing','invalid-numeric','invalid-unit','invalid-value','provider-error','provider-unavailable',
  'integration-gap','unknown-phase-share','conflicting-duplicate']);
const scope = input => input === 'simulated' ? "source='simulation'" : "source<>'simulation'";
const prefixOf = signal => signal.startsWith('ev1_') ? 'ev1' : signal==='ev2_energy' ? 'ev2' : signal==='caravan_energy' ? 'caravan' : 'property';
const totalOnly = prefix => ['ev2', 'caravan'].includes(prefix);

export function recordedEnergyStart(store, prefix, input, now) {
  if (!Number.isFinite(now)) throw new TypeError('Energy selection requires an explicit receipt cutoff');
  const row = store.db.prepare(`SELECT MIN(json_extract(raw,'$.intervalStart')) AS at FROM observations
    WHERE signal=? AND ${scope(input)} AND import_id IS NULL AND received_at<=? AND source_time<=?
    AND json_valid(raw) AND json_type(raw,'$.intervalStart')='integer'
    AND json_extract(raw,'$.intervalEnd')=source_time
    AND source_time>json_extract(raw,'$.intervalStart') AND source_time-json_extract(raw,'$.intervalStart')<=?`)
    .get(totalOnly(prefix)?`${prefix}_energy`:`${prefix}_energy_l1`, now, now, 24 * HOUR);
  return Number.isFinite(row?.at) ? row.at : Infinity;
}

/** Stream complete logical energy cohorts across the requested boundaries. */
function* rawRows(store, { from, to, now, input, prefix }) {
  const signals = prefix ? ENERGY_SIGNALS.filter(signal => prefixOf(signal) === prefix) : ENERGY_SIGNALS;
  const geometry = "json_extract(CASE WHEN json_valid(raw) THEN raw ELSE '{}' END,'$.intervalStart')";
  // The geometry index streams complete cohorts in start order. JavaScript
  // retains one cohort and one overlap cluster per logical scope; no full-range
  // sort or source-row array is needed, including multi-year selections.
  const iterator = store.db.prepare(`SELECT id,source,device,signal,value,unit,source_time,received_at,quality,raw
    FROM observations INDEXED BY observations_energy_geometry
    WHERE signal IN (${ENERGY_SIGNALS.map(signal => `'${signal}'`).join(',')}) AND import_id IS NULL
    AND signal IN (${signals.map(() => '?').join(',')}) AND ${geometry}>=? AND ${geometry}<?
    AND source_time>? AND source_time<=? AND ${scope(input)} AND received_at<=? AND import_id IS NULL
    AND json_valid(raw) AND json_extract(raw,'$.intervalStart')<?
    AND json_extract(raw,'$.intervalEnd')=source_time
    AND source_time>json_extract(raw,'$.intervalStart') AND source_time-json_extract(raw,'$.intervalStart')<=?
    ORDER BY ${geometry},source_time,source,device,
      CASE WHEN signal LIKE 'ev1_%' THEN 'ev1' WHEN signal='ev2_energy' THEN 'ev2'
      WHEN signal='caravan_energy' THEN 'caravan' ELSE 'property' END,id`)
    .iterate(...signals, from-24*HOUR, to, from, Math.min(now, to + 24 * HOUR), now, to, 24 * HOUR);
  let finished = false;
  try {
    for (;;) {
      const item = iterator.next();
      if (item.done) { finished = true; return; }
      yield item.value;
    }
  } finally {
    // Iterator delegation alone does not close a cursor whose next() throws.
    if (!finished) try { iterator.return?.(); } catch { /* Preserve the query/projection failure. */ }
  }
}

export function* recordedEnergyGroups(store, options, stats = { rows: 0, conflicts: 0 }) {
  const pending = new Map();
  for (const group of rawGroups(rawRows(store, options),stats)) {
    const previous = pending.get(group.prefix);
    if (previous && group.start < previous.end) {
      if (!previous.conflict) stats.conflicts = (stats.conflicts ?? 0) + 1;
      previous.conflict = true; previous.end = Math.max(previous.end,group.end);
    } else { if (previous) yield previous; pending.set(group.prefix,group); }
  }
  yield* pending.values();
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
      group = { source: row.source, device: row.device, prefix, start: raw?.intervalStart, end: raw?.intervalEnd,
        basis: raw?.basis, values: totalOnly(prefix)?[null]:[null, null, null] };
    }
    group.values[totalOnly(prefix)?0:Number(row.signal.at(-1)) - 1] = row.unit === 'kWh' && Number.isFinite(row.value) && row.value >= 0
      && Array.isArray(flags) && !flags.some(flag => typeof flag !== 'string' || invalid.has(flag.replaceAll('_','-'))) ? row.value : null;
  }
  if (group) yield group;
}

/** Original phase or total-energy intervals supply every history range. Drawing points
 * may be reduced in memory, but never determine energy or tariff comparisons. */
export function addRecordedEnergy({store,range,now,input,envelopes,timing}) {
  const stats = {rows:0,intervals:0};
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
    const {start,end,prefix} = group, values = group.conflict ? group.values.map(() => null) : group.values;
    const duration = end-start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || duration <= 0 || duration > 24*HOUR
      || start >= range.to || end <= range.from) return;
    stats.intervals++;
    const complete = values.length === (totalOnly(prefix)?1:3) && values.every(Number.isFinite);
    const total = complete ? values.reduce((sum,value)=>sum+value,0) : null;
    const metadata = {basis:'estimated',intervalStart:start,intervalEnd:end,source:group.source,fromEnergy:true,
      ...(group.conflict ? { quality: ['conflicting-logical-energy'] } : {})};
    if (prefix==='caravan') {
      // Measured caravan electricity stays an independent history series. It
      // never becomes property demand, charger timing evidence or heating input.
      project('caravan_energy',start,end,total,{...metadata,basis:group.basis??'meter-counter-delta',learningRole:'history-only'});
      return;
    }
    project(prefix === 'ev1' ? 'charger_power' : prefix==='ev2'?'charger2_power':'property_power',start,end,total === null ? null : total*HOUR/duration,metadata);
    if (prefix==='ev2') {
      if (end>=range.from && end<=Math.min(range.to,now)) envelopes.ev2_energy?.add(end,total,metadata);
      if (complete) timing.addEnergy('charger2',start,end,total,
        { key: input === 'simulated' ? 'simulated' : 'recorded', energyBasis: 'recorded-intervals' });
      return;
    }
    for (let phase=0;phase<3;phase++) {
      const value = values[phase] ?? null, power = value === null ? null : value*HOUR/duration;
      project(`${prefix}_current_l${phase+1}`,start,end,power === null ? null : power/0.23,{...metadata,equivalentCurrent:true});
      const energyLine = envelopes[`${prefix}_energy_l${phase+1}`];
      if (energyLine && end >= range.from && end <= Math.min(range.to,now)) energyLine.add(end,value,metadata);
    }
    if (prefix === 'ev1' && complete) timing.addEnergy('charger1',start,end,total,
      { key: input === 'simulated' ? 'simulated' : 'recorded', energyBasis: 'recorded-intervals' });
  };
  for (const group of recordedEnergyGroups(store,{from:range.from,to:range.to,now,input},stats)) accept(group);
  // Finish only after all adjacent intervals are projected, so a shared edge
  // does not acquire a spurious missing marker.
  for (const [name,end] of lastEnd) envelopes[name]?.add(end,null);
  return stats;
}
