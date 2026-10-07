import { selectedHistoryPredicate } from './schema.js';
import { ENERGY_SIGNALS } from '../domain/history-series.js';
import { pendingEnergyObservations } from './pending-energy.js';
import { recordedTransport } from '../domain/recording-source.js';

const invalid = new Set(['missing','invalid-numeric','invalid-unit','invalid-value','provider-error','provider-unavailable',
  'integration-gap','unknown-phase-share','conflicting-duplicate','stale','retained','failed','unavailable',
  'out-of-order','out-of-order-source-time','future-source-time','source-time-unknown','meter-counter-reset',
  'meter-report-gap','invalid-meter-delta','electricity-unavailable','electricity-gap','clock-rollback',
  'source-time-rollback','mqtt-disconnected','device-offline','acquisition-failed']);
const invalidFlag = flag => typeof flag !== 'string' || invalid.has(flag.replaceAll('_','-'))
  || /failed|disconnected|unavailable|missing|invalid|out-of-order|future-source-time/.test(flag.replaceAll('_','-'));
export const validEnergyQuality = quality => Array.isArray(quality) && !quality.some(invalidFlag);
const invalidGapFlags = new Set(['retained', 'invalid-numeric', 'invalid-unit', 'invalid-value', 'future-source-time',
  'out-of-order-source-time', 'source-time-unknown']);
// Only an explicit recorder outage is absence of energy evidence. Invalid or
// retained numeric observations and incomplete measured cohorts remain subject
// to the ordinary overlap checks; they cannot be relabelled as harmless gaps.
export const isRecordedEnergyGap = (row, raw, quality) => row.value === null && row.unit === 'kWh'
  && raw?.basis === 'availability-gap' && !raw.auditOnly && !raw.acquisitionOnly
  && raw.timeBasis !== 'completed-hour'
  && Array.isArray(quality) && quality.includes('missing') && quality.every(flag => typeof flag === 'string'
    && !invalidGapFlags.has(flag.replaceAll('_', '-')));
const scope = input => input === 'simulated' ? "source='simulation'" : "source<>'simulation'";
// Configurable equipment IDs can coincide with a physical energy signal. Their
// direct hourly writer is a different dataset, not charger/property evidence.
const physicalWriter = "COALESCE(json_extract(CASE WHEN json_valid(raw) THEN raw ELSE '{}' END,'$.timeBasis'),'')<>'completed-hour'";
const prefixOf = signal => signal.startsWith('ev1_') ? 'ev1'
  : signal.startsWith('ev2_energy_l') ? 'ev2' : signal==='caravan_energy' ? 'caravan' : 'property';
const totalOnly = prefix => prefix === 'caravan';

export function recordedEnergyStart(store, prefix, input, now) {
  if (!Number.isFinite(now)) throw new TypeError('Energy selection requires an explicit receipt cutoff');
  const signal = totalOnly(prefix) ? `${prefix}_energy` : `${prefix}_energy_l1`;
  // The earliest start is already ordered by the geometry index. MIN() on the
  // signal index used to parse every retained interval on each chart pass. A
  // cheap existence check prevents scanning all other devices for an absent
  // prefix (the selected-history predicate remains on the actual lookup).
  const present = store.db.prepare(`SELECT 1 FROM observations INDEXED BY observations_signal_time
    WHERE signal=? AND import_id IS NULL AND ${scope(input)} AND received_at<=? AND source_time<=? LIMIT 1`)
    .get(signal, now, now);
  const geometry = "json_extract(CASE WHEN json_valid(raw) THEN raw ELSE '{}' END,'$.intervalStart')";
  const row = present && store.db.prepare(`SELECT ${geometry} AS at FROM observations INDEXED BY observations_energy_geometry
    WHERE signal IN (${ENERGY_SIGNALS.map(name => `'${name}'`).join(',')}) AND import_id IS NULL
    AND ${selectedHistoryPredicate('observations', 'observations')}
    AND signal=? AND ${scope(input)} AND ${physicalWriter} AND received_at<=? AND source_time<=?
    AND json_valid(raw) AND json_type(raw,'$.intervalStart')='integer'
    AND json_extract(raw,'$.intervalEnd')=source_time
    AND source_time>json_extract(raw,'$.intervalStart') AND source_time<=received_at
    ORDER BY ${geometry} LIMIT 1`).get(signal, now, now);
  return Math.min(Number.isFinite(row?.at) ? row.at : Infinity,
    ...pendingEnergyObservations(store, { now, input: input ?? 'providers', prefix }).map(row => JSON.parse(row.raw).intervalStart));
}

/** Stream complete logical energy cohorts across the requested boundaries. */
function* rawRows(store, { from, to, now, input, prefix, source, device }) {
  const signals = prefix ? ENERGY_SIGNALS.filter(signal => prefixOf(signal) === prefix) : ENERGY_SIGNALS;
  const geometry = "json_extract(CASE WHEN json_valid(raw) THEN raw ELSE '{}' END,'$.intervalStart')";
  // Recent views should seek directly to recent interval ends instead of
  // traversing every earlier interval start in the installation. This retains
  // arbitrarily long intervals crossing the left boundary; no assumed maximum
  // duration or guessed lookback is introduced. Older/long selections use the
  // geometry index to stream without a potentially large temporary sort.
  const day = 86_400_000;
  const recent = now - from <= 31 * day;
  const index = recent ? 'observations_signal_time' : 'observations_energy_geometry';
  // The geometry index streams complete cohorts in start order. JavaScript
  // retains one cohort, one overlap cluster and one gap per logical scope; no full-range
  // sort or source-row array is needed, including multi-year selections.
  const iterator = store.db.prepare(`SELECT id,source,device,signal,value,unit,source_time,received_at,quality,raw
    FROM observations INDEXED BY ${index}
    WHERE signal IN (${ENERGY_SIGNALS.map(signal => `'${signal}'`).join(',')}) AND import_id IS NULL
    AND ${selectedHistoryPredicate('observations', 'observations')}
    AND signal IN (${signals.map(() => '?').join(',')}) AND ${geometry}<?
    AND source_time>? AND source_time<=? AND ${scope(input)} AND ${physicalWriter} AND received_at<=? AND import_id IS NULL
    ${source !== undefined ? 'AND source=?' : ''} ${device != null ? 'AND device=?' : ''}
    AND json_valid(raw) AND json_extract(raw,'$.intervalStart')<?
    AND json_extract(raw,'$.intervalEnd')=source_time
    AND source_time>json_extract(raw,'$.intervalStart')
    ORDER BY ${geometry},source_time,source,device,
      CASE WHEN signal LIKE 'ev1_%' THEN 'ev1'
      WHEN signal LIKE 'ev2_energy_l%' THEN 'ev2' WHEN signal='caravan_energy' THEN 'caravan' ELSE 'property' END,id`)
    .iterate(...signals, to, from, now, now, ...(source !== undefined ? [source] : []), ...(device != null ? [device] : []), to);
  const tail = pendingEnergyObservations(store, { now, input: input ?? 'providers', prefix, source, device })
    .filter(row => row.source_time > from && JSON.parse(row.raw).intervalStart < to);
  const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const compare = (a, b) => JSON.parse(a.raw).intervalStart - JSON.parse(b.raw).intervalStart
    || a.source_time - b.source_time || lexical(a.source,b.source) || lexical(a.device,b.device)
    || lexical(prefixOf(a.signal),prefixOf(b.signal)) || (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER);
  tail.sort(compare);
  let tailIndex = 0;
  let finished = false;
  try {
    for (;;) {
      const item = iterator.next();
      if (item.done) { finished = true; yield* tail.slice(tailIndex); return; }
      while (tailIndex < tail.length && compare(tail[tailIndex], item.value) < 0) yield tail[tailIndex++];
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
    const state = pending.get(group.prefix) ?? { energy: null, gap: null };
    pending.set(group.prefix, state);
    if (state.energy && state.energy.end <= group.start) {
      yield state.energy; state.energy = null;
    }
    // Once a start boundary has passed, no later cohort can cover that earlier
    // gap. Emit only the uncovered part, without prorating any measured energy.
    if (state.gap && state.gap.start < group.start) {
      const end = Math.min(state.gap.end, group.start);
      yield { ...state.gap, end };
      state.gap = end < state.gap.end ? { ...state.gap, start: end } : null;
    }
    if (group.availabilityGap) {
      const start = Math.max(group.start, options.from, state.energy?.end ?? -Infinity);
      const end = Math.min(group.end, options.to);
      if (start >= end) continue;
      const gap = { ...group, start, end, conflict: false };
      if (!state.gap) state.gap = gap;
      else {
        // This is a resolved absence span, not a new source observation. Raw
        // source records and their complete bounds remain unchanged in SQLite.
        state.gap.end = Math.max(state.gap.end, gap.end);
        state.gap.receivedAt = Math.max(state.gap.receivedAt, gap.receivedAt);
        if (state.gap.source !== gap.source) state.gap.source = null;
        if (state.gap.device !== gap.device) state.gap.device = null;
        if (state.gap.transport !== gap.transport) state.gap.transport = null;
        state.gap.observationIds = [];
      }
      continue;
    }
    const previous = state.energy;
    if (previous) {
      if (!previous.conflict) stats.conflicts = (stats.conflicts ?? 0) + 1;
      previous.conflict = true; previous.end = Math.max(previous.end,group.end);
    } else state.energy = group;
    if (state.gap) state.gap = state.gap.end > state.energy.end
      ? { ...state.gap, start: Math.max(state.gap.start, state.energy.end) } : null;
  }
  for (const state of pending.values()) {
    if (state.energy) yield state.energy;
    if (state.gap) yield state.gap;
  }
}

function* rawGroups(rows, stats) {
  let key = null, group = null;
  for (const row of rows) {
    stats.rows++;
    let raw, flags;
    try { raw = JSON.parse(row.raw); flags = JSON.parse(row.quality); } catch { continue; }
    if (!Number.isSafeInteger(raw?.intervalStart) || !Number.isSafeInteger(raw?.intervalEnd)
      || raw.intervalEnd <= raw.intervalStart || raw.intervalEnd !== row.source_time
      || !Number.isSafeInteger(row.received_at) || row.source_time > row.received_at) continue;
    const prefix = prefixOf(row.signal);
    const availabilityGap = isRecordedEnergyGap(row, raw, flags);
    const nextKey = JSON.stringify([row.source, row.device, prefix, raw?.intervalStart, raw?.intervalEnd, availabilityGap]);
    if (nextKey !== key) {
      if (group) yield group;
      key = nextKey;
      group = { source: row.source, device: row.device, prefix, start: raw?.intervalStart, end: raw?.intervalEnd,
        basis: raw?.basis, receivedAt: row.received_at, pending: raw?.pending === true, transport: recordedTransport(row),
        availabilityGap: true, observationIds: [], values: totalOnly(prefix)?[null]:[null, null, null] };
    }
    group.availabilityGap &&= availabilityGap;
    group.receivedAt = Math.max(group.receivedAt, row.received_at);
    if (group.transport !== recordedTransport(row)) group.transport = null;
    const index = totalOnly(prefix)?0:Number(row.signal.at(-1)) - 1;
    if (group.seen?.has(index)) group.conflict = true;
    (group.seen ??= new Set()).add(index);
    if (Number.isSafeInteger(row.id)) group.observationIds[index] = row.id;
    group.values[index] = !raw.auditOnly && !raw.acquisitionOnly && row.unit === 'kWh' && Number.isFinite(row.value) && row.value >= 0
      && validEnergyQuality(flags) ? row.value : null;
  }
  if (group) yield group;
}
