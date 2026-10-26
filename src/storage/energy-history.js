import { selectedHistoryPredicate } from './schema.js';
import { ENERGY_SIGNALS } from '../domain/history-series.js';
import { pendingEnergyObservations } from './pending-energy.js';
import { recordedTransport } from '../domain/recording-source.js';
import { observationTimeAdmitted } from '../domain/time-evidence.js';

const invalid = new Set(['missing','invalid-numeric','invalid-unit','invalid-value','provider-error','provider-unavailable',
  'integration-gap','unknown-phase-share','conflicting-duplicate','stale','retained','failed','unavailable',
  'out-of-order','out-of-order-source-time','future-source-time','source-time-unknown','meter-counter-reset',
  'meter-report-gap','invalid-meter-delta','electricity-unavailable','electricity-gap','clock-rollback',
  'source-time-rollback','mqtt-disconnected','device-offline','acquisition-failed']);
const invalidFlag = flag => {
  if (typeof flag !== 'string') return true;
  const normalized = flag.replaceAll('_', '-');
  return invalid.has(normalized) || /failed|disconnected|unavailable|missing|invalid|out-of-order|future-source-time/.test(normalized);
};
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
const decodedRows = new WeakMap();
let previousEncoding, previousDecoded;

function energyRow(row) {
  let value = decodedRows.get(row);
  if (!value) {
    // The phases of one cohort normally carry identical encoded metadata.
    // Retain just the last encoding; row values and identity stay independent.
    if (previousEncoding?.raw === row.raw && previousEncoding.quality === row.quality
      && previousEncoding.transport === row.transport) value = previousDecoded;
    else {
      const raw = JSON.parse(row.raw), flags = JSON.parse(row.quality);
      value = { raw, flags, validQuality: validEnergyQuality(flags),
        transport: recordedTransport({ transport: row.transport, raw, quality: flags }) };
      previousEncoding = { raw: row.raw, quality: row.quality, transport: row.transport };
      previousDecoded = value;
    }
    decodedRows.set(row, value);
  }
  return value;
}

export function recordedEnergyStart(store, prefix, input, now) {
  if (!Number.isFinite(now)) throw new TypeError('Energy selection requires an explicit receipt cutoff');
  const signal = totalOnly(prefix) ? `${prefix}_energy` : `${prefix}_energy_l1`;
  // Seek this signal's earliest geometry, including a long interval whose end
  // is later than shorter intervals. The global geometry index would traverse
  // every other signal's earlier archive before reaching this prefix.
  const geometry = "json_extract(CASE WHEN json_valid(candidate.raw) THEN candidate.raw ELSE '{}' END,'$.intervalStart')";
  const overlay = store.journalSource === true, observed = overlay ? 'candidate' : 'o';
  // Proposed recovery views own actual selection membership. A journal donor's
  // active view instead contains only its changed-key closure; its unhinted raw
  // TEMP overlay and donor selection retain the complete source context.
  const from = overlay ? 'observations candidate' : `observations candidate INDEXED BY observations_energy_start
    CROSS JOIN active_observations o ON o.id=candidate.id`;
  let firstAt = Infinity;
  const candidates = store.db.prepare(`SELECT ${geometry} AS at,${observed}.source_time,${observed}.received_at,${observed}.raw
    FROM ${from}
    WHERE candidate.signal IN ('property_energy_l1','ev1_energy_l1','ev2_energy_l1','caravan_energy') AND candidate.import_id IS NULL
    ${overlay ? `AND ${selectedHistoryPredicate('observations', 'candidate')}` : ''}
    AND candidate.signal=? AND ${scope(input).replaceAll('source', `${observed}.source`)}
    AND ${physicalWriter.replaceAll('raw', `${observed}.raw`)} AND ${observed}.received_at<=? AND ${observed}.source_time<=?
    AND json_valid(${observed}.raw) AND json_type(${observed}.raw,'$.intervalStart')='integer'
    AND json_extract(${observed}.raw,'$.intervalEnd')=${observed}.source_time
    AND ${observed}.source_time>json_extract(${observed}.raw,'$.intervalStart')
    ORDER BY ${geometry}`).iterate(signal, now, now);
  for (const row of candidates) {
    if (observationTimeAdmitted({ sourceTime: row.source_time, receivedAt: row.received_at, raw: JSON.parse(row.raw) }, now)) {
      firstAt = row.at; break;
    }
  }
  return Math.min(firstAt,
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
  // Peer recovery overlays raw observations with a TEMP view. Preserve its
  // complete donor history; the scoped active view contains only changed keys.
  const indexHint = store.journalSource === true ? '' : ` INDEXED BY ${index}`;
  // The geometry index streams complete cohorts in start order. JavaScript
  // retains one cohort, one overlap cluster and one gap per logical scope; no full-range
  // sort or source-row array is needed, including multi-year selections.
  const resident = store.chartSource;
  const cached = resident?.covers(from, now + 1, now, store.chartHead, store.chartRevision);
  const residentRows = () => {
    const rows = [];
    for (const row of resident.iterate({ from, to: now + 1, now, input, signals, scope: 'energy' })) {
      if (row.import_id !== null || row.source_time <= from
        || source !== undefined && row.source !== source || device != null && row.device !== device) continue;
      let raw; try { ({ raw } = energyRow(row)); } catch { continue; }
      if (raw?.timeBasis === 'completed-hour' || !Number.isSafeInteger(raw?.intervalStart)
        || raw.intervalStart >= to || raw.intervalEnd !== row.source_time || row.source_time <= raw.intervalStart) continue;
      rows.push(row);
    }
    const text = (a, b) => a === b ? 0 : Buffer.compare(Buffer.from(a), Buffer.from(b));
    rows.sort((a, b) => energyRow(a).raw.intervalStart - energyRow(b).raw.intervalStart
      || a.source_time - b.source_time || text(a.source, b.source) || text(a.device, b.device)
      || text(prefixOf(a.signal), prefixOf(b.signal)) || a.id - b.id);
    return rows[Symbol.iterator]();
  };
  const iterator = cached ? residentRows() : store.db.prepare(`SELECT id,source,device,signal,value,unit,source_time,received_at,quality,raw
    FROM observations${indexHint}
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
  for (const group of rawGroups(rawRows(store, options),stats,options.now)) {
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

function* rawGroups(rows, stats, now) {
  let key = null, group = null;
  for (const row of rows) {
    stats.rows++;
    let raw, flags, validQuality, transport;
    try { ({ raw, flags, validQuality, transport } = energyRow(row)); } catch { continue; }
    if (!Number.isSafeInteger(raw?.intervalStart) || !Number.isSafeInteger(raw?.intervalEnd)
      || raw.intervalEnd <= raw.intervalStart || raw.intervalEnd !== row.source_time
      || !observationTimeAdmitted({ sourceTime: row.source_time, receivedAt: row.received_at, raw }, now)) continue;
    const prefix = prefixOf(row.signal);
    const availabilityGap = isRecordedEnergyGap(row, raw, flags);
    const nextKey = JSON.stringify([row.source, row.device, prefix, raw?.intervalStart, raw?.intervalEnd, availabilityGap]);
    if (nextKey !== key) {
      if (group) yield group;
      key = nextKey;
      group = { source: row.source, device: row.device, prefix, start: raw?.intervalStart, end: raw?.intervalEnd,
        basis: raw?.basis, receivedAt: row.received_at, pending: raw?.pending === true, transport,
        availabilityGap: true, observationIds: [], values: totalOnly(prefix)?[null]:[null, null, null] };
    }
    group.availabilityGap &&= availabilityGap;
    group.receivedAt = Math.max(group.receivedAt, row.received_at);
    if (group.transport !== transport) group.transport = null;
    const index = totalOnly(prefix)?0:Number(row.signal.at(-1)) - 1;
    if (group.seen?.has(index)) group.conflict = true;
    (group.seen ??= new Set()).add(index);
    if (Number.isSafeInteger(row.id)) group.observationIds[index] = row.id;
    group.values[index] = !raw.auditOnly && !raw.acquisitionOnly && row.unit === 'kWh' && Number.isFinite(row.value) && row.value >= 0
      && validQuality ? row.value : null;
  }
  if (group) yield group;
}
