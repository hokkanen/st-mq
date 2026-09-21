import { ENERGY_SIGNALS } from '../domain/history-series.js';

const HOUR = 3_600_000;
const invalid = new Set(['missing','invalid_numeric','invalid_unit','provider_error','integration_gap','unknown_phase_share']);
const scope = input => input === 'simulated' ? "source='simulation'" : "source<>'simulation'";
const prefixOf = signal => signal.startsWith('ev1_') ? 'ev1' : signal==='ev2_energy' ? 'ev2' : signal==='caravan_energy' ? 'caravan' : 'property';
const totalOnly = prefix => ['ev2', 'caravan'].includes(prefix);

export function recordedEnergyStart(store, prefix, input) {
  const row = store.db.prepare(`SELECT raw,source_time FROM observations WHERE signal=? AND ${scope(input)}
    ORDER BY source_time,id LIMIT 1`).get(totalOnly(prefix)?`${prefix}_energy`:`${prefix}_energy_l1`);
  if (!row) return Infinity;
  try { return JSON.parse(row.raw)?.intervalStart ?? row.source_time; } catch { return row.source_time; }
}

/** Each phase query includes the first following interval. Reading just this
 * boundary instead of an entire extra day keeps sparse/fallback windows bounded. */
function* rawRows(store, { from, to, now, input }) {
  const signals = ENERGY_SIGNALS;
  const columns = 'id,source,device,signal,value,unit,source_time,received_at,quality,raw';
  const condition = `${scope(input)} AND received_at<=?`, until = Math.min(to, now);
  // Individually ordered index scans avoid sorting the whole selected energy
  // history in SQLite. Merge only their current heads; source time and insertion
  // ID preserve the original three-phase acquisition cohort order.
  const heads = [], pending = new Set();
  try {
    for (const signal of signals) {
      const iterator = store.db.prepare(`SELECT ${columns} FROM observations INDEXED BY observations_signal_time
        WHERE signal=? AND source_time>=? AND source_time<=? AND ${condition}
        ORDER BY source_time,id`).iterate(signal, from, until, now);
      pending.add(iterator);
      const next = iterator.next();
      if (next.done) pending.delete(iterator); else heads.push({ iterator, next });
    }
    while (heads.length) {
      let index = 0;
      for (let i = 1; i < heads.length; i++) if (heads[i].next.value.source_time < heads[index].next.value.source_time
        || heads[i].next.value.source_time === heads[index].next.value.source_time && heads[i].next.value.id < heads[index].next.value.id) index = i;
      const head = heads[index]; yield head.next.value;
      head.next = head.iterator.next();
      if (head.next.done) { pending.delete(head.iterator); heads.splice(index, 1); }
    }
  } finally {
    // A failed projection or later cursor initialization must release every
    // already opened statement without replacing the original error.
    for (const iterator of pending) try { iterator.return?.(); } catch { /* Best-effort cleanup. */ }
  }
  if (now <= to) return;
  const next = store.db.prepare(`SELECT ${columns} FROM observations INDEXED BY observations_signal_time
    WHERE signal=? AND source_time>? AND source_time<=? AND ${condition} ORDER BY source_time,id LIMIT 1`);
  yield* signals.map(signal => next.get(signal, to, Math.min(now, to + 24 * HOUR), now)).filter(Boolean)
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
      group = { source: row.source, device: row.device, prefix, start: raw?.intervalStart, end: raw?.intervalEnd,
        basis: raw?.basis, values: totalOnly(prefix)?[null]:[null, null, null] };
    }
    group.values[totalOnly(prefix)?0:Number(row.signal.at(-1)) - 1] = row.unit === 'kWh' && Number.isFinite(row.value) && row.value >= 0
      && Array.isArray(flags) && !flags.some(flag => invalid.has(flag)) ? row.value : null;
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
    const {start,end,prefix,values} = group;
    const duration = end-start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || duration <= 0 || duration > 24*HOUR
      || start >= range.to || end <= range.from) return;
    stats.intervals++;
    const complete = values.length === (totalOnly(prefix)?1:3) && values.every(Number.isFinite);
    const total = complete ? values.reduce((sum,value)=>sum+value,0) : null;
    const metadata = {basis:'estimated',intervalStart:start,intervalEnd:end,source:group.source,fromEnergy:true};
    if (prefix==='caravan') {
      // Measured caravan electricity stays an independent history series. It
      // never becomes property demand, charger timing evidence or heating input.
      project('caravan_energy',start,end,total,{...metadata,basis:group.basis??'meter-counter-delta',learningRole:'history-only'});
      return;
    }
    project(prefix === 'ev1' ? 'charger_power' : prefix==='ev2'?'charger2_power':'property_power',start,end,total === null ? null : total*HOUR/duration,metadata);
    if (prefix==='ev2') {
      if (end>=range.from && end<=Math.min(range.to,now)) envelopes.ev2_energy?.add(end,total,metadata);
      return;
    }
    for (let phase=0;phase<3;phase++) {
      const value = values[phase] ?? null, power = value === null ? null : value*HOUR/duration;
      project(`${prefix}_current_l${phase+1}`,start,end,power === null ? null : power/0.23,{...metadata,equivalentCurrent:true});
      const energyLine = envelopes[`${prefix}_energy_l${phase+1}`];
      if (energyLine && end >= range.from && end <= Math.min(range.to,now)) energyLine.add(end,value,metadata);
    }
    if (prefix === 'ev1' && complete) timing.addEnergy('charger',start,end,total,
      { key: input === 'simulated' ? 'simulated' : 'recorded', energyBasis: 'recorded-intervals' });
  };
  for (const group of rawGroups(rawRows(store,{from:range.from,to:range.to,now,input}),stats)) accept(group);
  // Finish only after all adjacent intervals are projected, so a shared edge
  // does not acquire a spurious missing marker.
  for (const [name,end] of lastEnd) envelopes[name]?.add(end,null);
  return stats;
}
