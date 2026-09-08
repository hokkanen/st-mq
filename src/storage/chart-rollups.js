import { H66_HISTORY_SIGNALS, PHASE_ENERGY_SIGNALS } from '../domain/history-series.js';

const HOUR = 3_600_000;
export const ENERGY_ROLLUP_MS = 15 * 60_000;
const states = new Set(['compressor_active', 'heating_pump_active', 'dhw_routing', 'operating_mode', 'alarm_active', 'alarm_code', 'auxiliary_output']);
export const ROLLUP_SIGNALS = Object.freeze([...new Set([
  ...H66_HISTORY_SIGNALS.filter(signal => !states.has(signal)), 'garage_temperature', ...PHASE_ENERGY_SIGNALS,
])]);
const eligible = new Set(ROLLUP_SIGNALS);
const energy = new Set(PHASE_ENERGY_SIGNALS);
const BAD = new Set(['missing', 'invalid_numeric', 'invalid_unit', 'invalid_value', 'invalid-value', 'invalid-payload',
  'suspect_zero_indoor', 'implausible_temperature', 'future_source_time', 'future-source-time', 'provider_error', 'unverified-scaling']);

export const rollupSchema = `
CREATE TABLE chart_rollup_meta (id INTEGER PRIMARY KEY CHECK(id=1), legacy_through INTEGER NOT NULL);
INSERT INTO chart_rollup_meta SELECT 1,COALESCE(MAX(id),0) FROM observations;
CREATE TABLE chart_rollups (
 signal TEXT NOT NULL,source TEXT NOT NULL,device TEXT NOT NULL,bucket INTEGER NOT NULL,
 payload TEXT NOT NULL,PRIMARY KEY(signal,source,device,bucket)) WITHOUT ROWID;
CREATE INDEX chart_rollups_time ON chart_rollups(bucket,signal);
`;

const statements = new WeakMap();
function queries(db) {
  let q = statements.get(db);
  if (!q) {
    q = { get: db.prepare('SELECT payload FROM chart_rollups WHERE signal=? AND source=? AND device=? AND bucket=?'),
      put: db.prepare('INSERT INTO chart_rollups(signal,source,device,bucket,payload) VALUES(?,?,?,?,?) ON CONFLICT(signal,source,device,bucket) DO UPDATE SET payload=excluded.payload') };
    statements.set(db, q);
  }
  return q;
}

/** Display summaries only; never used by the recorder, audit or learner.
 * Existing historical rows remain on their original path until explicitly rebuilt. */
export function updateChartRollup(db, observation, id) {
  if (!eligible.has(observation.signal) || !Number.isSafeInteger(observation.sourceTime) || observation.provenance) return;
  if (observation.raw?.recorder?.status && observation.raw.recorder.status!=='fresh') return;
  const { signal, source, device } = observation, q = queries(db);
  const flags = observation.quality ?? [];
  const value = Number.isFinite(observation.value) && !flags.some(flag => BAD.has(flag)) ? observation.value : null;
  const row = { id, source, device, signal, value, unit: observation.unit, source_time: observation.sourceTime,
    received_at: observation.receivedAt, quality: JSON.stringify(flags), raw: observation.raw ? JSON.stringify(observation.raw) : null,
    import_id: null, row_number: null, aggregated: true };
  if (energy.has(signal)) {
    const start = observation.raw?.intervalStart, end = observation.raw?.intervalEnd;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || end-start > 24*HOUR) return;
    for (let at = start; at < end;) {
      const bucket = Math.floor(at/ENERGY_ROLLUP_MS)*ENERGY_ROLLUP_MS, until = Math.min(end,bucket+ENERGY_ROLLUP_MS);
      const previous = q.get.get(signal,source,device,bucket);
      const result = previous ? JSON.parse(previous.payload) : { energy: 0, coveredMs: 0, start: at, end: until, valid: true, count: 0, row };
      result.count++; result.start = Math.min(result.start,at); result.end = Math.max(result.end,until);
      result.valid &&= value !== null;
      if (value !== null) { result.energy += value*(until-at)/(end-start); result.coveredMs += until-at; }
      result.row = row;
      q.put.run(signal,source,device,bucket,JSON.stringify(result));
      at = until;
    }
    return;
  }
  const bucket = Math.floor(observation.sourceTime/HOUR)*HOUR;
  const previous = q.get.get(signal,source,device,bucket);
  const result = previous ? JSON.parse(previous.payload) : { first: row, last: row, min: null, max: null, missing: null, beforeMissing: null, afterMissing: null, count: 0 };
  if (value === null && !result.missing) { result.missing = row; result.beforeMissing = result.last; }
  if (value !== null) {
    if (!result.min || value < result.min.value) result.min = row;
    if (!result.max || value > result.max.value) result.max = row;
    if (result.missing && !result.afterMissing) result.afterMissing = row;
  }
  if (row.source_time < result.first.source_time) result.first = row;
  if (row.source_time >= result.last.source_time) result.last = row;
  result.count++;
  q.put.run(signal,source,device,bucket,JSON.stringify(result));
}

export function rollupWatermark(db) {
  try { return db.prepare('SELECT legacy_through FROM chart_rollup_meta WHERE id=1').get()?.legacy_through ?? null; }
  catch { return null; }
}

export function* energyRollupRows(db,{from,to,input='offline'}) {
  const wanted=[...PHASE_ENERGY_SIGNALS],scope=input==='simulated'?"source='simulation'":"source<>'simulation'";
  for(const row of db.prepare(`SELECT * FROM chart_rollups WHERE signal IN (${wanted.map(()=>'?').join(',')})
    AND bucket>=? AND bucket<? AND ${scope} ORDER BY bucket,device,signal`)
    .iterate(...wanted,Math.floor(from/ENERGY_ROLLUP_MS)*ENERGY_ROLLUP_MS,to)) {
    const r=JSON.parse(row.payload);
    yield {signal:row.signal,source:row.source,device:row.device,bucket:row.bucket,...r,
      valid:r.valid&&r.coveredMs===r.end-r.start&&r.start>=row.bucket&&r.end<=row.bucket+ENERGY_ROLLUP_MS};
  }
}

export function* chartRollupRows(db, { from, to, signals, input = 'offline', energyOnly = false }) {
  const wanted = [...signals].filter(signal => eligible.has(signal) && (!energyOnly || energy.has(signal)));
  if (!wanted.length) return;
  const scope = input === 'simulated' ? "source='simulation'" : "source<>'simulation'";
  const rows = db.prepare(`SELECT signal,payload FROM chart_rollups WHERE bucket>=? AND bucket<?
    AND signal IN (${wanted.map(() => '?').join(',')}) AND ${scope} ORDER BY bucket,signal`).iterate(Math.floor(from/HOUR)*HOUR,to,...wanted);
  // One hour of summaries is the memory bound, independent of selected years.
  let bucket = null, pending = [];
  const flush = function* () { yield* pending.sort((a,b) => a.source_time-b.source_time || a.id-b.id); pending=[]; };
  for (const encoded of rows) {
    const r = JSON.parse(encoded.payload);
    const at = energy.has(encoded.signal) ? r.start : r.first.source_time;
    const nextBucket = Math.floor(at/HOUR)*HOUR;
    if (bucket !== null && bucket !== nextBucket) yield* flush();
    bucket = nextBucket;
    if (energy.has(encoded.signal)) {
      const valid = r.valid && r.coveredMs === r.end-r.start;
      pending.push({ ...r.row, source_time:r.end, value:valid?r.energy:null,
        quality:JSON.stringify(valid?['estimated','hourly_aggregate']:['missing','hourly_aggregate']),
        raw:JSON.stringify({intervalStart:r.start,intervalEnd:r.end,durationMs:r.end-r.start,basis:'estimated',aggregated:true,recordCount:r.count}) });
    } else {
      const seen = new Set();
      for (const point of [r.first,r.min,r.max,r.beforeMissing,r.missing,r.afterMissing,r.last]) {
        if (point && !seen.has(point.id)) { seen.add(point.id); pending.push(point); }
      }
    }
  }
  yield* flush();
}
