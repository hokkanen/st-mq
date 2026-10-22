import moment from 'moment-timezone';
import { TIME_ZONE } from '../domain/prices.js';
import { decodeHistoryRow } from '../storage/history.js';
import { HouseholdReference, HOUR, DAY, MAX_BUCKET_NIGHTS, summarizeHousehold, predictHousehold } from './history-reference.js';
import { pendingEnergyObservations } from '../storage/pending-energy.js';
import { recordedEnergyGroups, validEnergyQuality, isRecordedEnergyGap } from '../storage/energy-history.js';
import { createVoltageReader, VOLTAGE_SIGNALS } from '../storage/voltage.js';
import { observationTimeAdmitted } from '../domain/time-evidence.js';

const SIGNALS = ['property_energy_l1', 'property_energy_l2', 'property_energy_l3',
  'ev1_energy_l1', 'ev1_energy_l2', 'ev1_energy_l3', 'ev2_energy_l1', 'ev2_energy_l2', 'ev2_energy_l3'];
const BAD = new Set(['missing', 'invalid_numeric', 'invalid_unit', 'provider_error', 'integration_gap', 'unknown_phase_share',
  'negative_current', 'implausible_current', 'all_zero_property_current', 'ev_exceeds_property_current',
  'conflicting_duplicate', 'future_source_time', 'implausible_temperature', 'excluded_occupied_training']);
const finite = Number.isFinite;
const valid = row => finite(row.value) && !(row.quality ?? []).some(flag => BAD.has(flag));
const parse = (value, fallback) => { try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; } };
const voltages = voltageV => Array.isArray(voltageV) && voltageV.length === 3 ? voltageV : [voltageV, voltageV, voltageV];
const nativeScope = input => `${input === 'simulated' ? "source='simulation'" : "source<>'simulation' AND NOT(source='controller-estimate' AND device='simulated')"}
  AND COALESCE(json_extract(CASE WHEN json_valid(raw) THEN raw ELSE '{}' END,'$.timeBasis'),'')<>'completed-hour'`;

/** Subtract chargers only where their original energy intervals overlap. An
 * explicit zero is valid idle evidence. Missing Charger 2 records retain an
 * honestly labelled upper estimate (its unknown energy stays in household
 * demand), rather than erasing otherwise useful history. An explicit invalid
 * charger interval is a gap and cannot be replaced with invented zero energy. */
export function householdSpans(rows, { voltageV } = {}) {
  const voltage = voltages(voltageV);
  if (!voltage.every(value => finite(value) && value >= 200 && value <= 250)) return [];
  const events = [];
  let key = 0;
  for (const original of rows) {
    const row = { ...original, raw: parse(original.raw, {}), quality: parse(original.quality, ['missing']) };
    const index = SIGNALS.indexOf(row.signal), start = row.raw?.intervalStart, end = row.raw?.intervalEnd;
    if (index < 0 || row.raw?.timeBasis === 'completed-hour' || !finite(start) || !finite(end) || end <= start) continue;
    const power = row.unit === 'kWh' && valid(row) && row.value >= 0 ? row.value * HOUR / (end - start) : null;
    const item = { index, power, key: key++, start, end, id: row.id ?? 0, priority: row.import_id == null ? 1 : 0 };
    events.push({ at: start, item, begins: true }, { at: end, item, begins: false });
  }
  events.sort((a, b) => a.at - b.at || Number(a.begins) - Number(b.begins));
  const active = SIGNALS.map(() => new Map()), spans = [];
  const selected = group => {
    if (!group.size) return undefined;
    const candidates = [...group.values()].sort((a, b) => b.priority - a.priority || b.id - a.id);
    const chosen = candidates[0];
    // A row ID provides deterministic source precedence. Ambiguous anonymous
    // overlapping test/provider intervals cannot manufacture extra capacity.
    if (candidates.some(item => item !== chosen && item.priority === chosen.priority && item.id === chosen.id
      && (item.start !== chosen.start || item.end !== chosen.end || item.power !== chosen.power))) return null;
    return chosen.power;
  };
  let previous = null;
  for (const event of events) {
    if (previous !== null && event.at > previous) {
      const values = active.map(selected);
      const phases = values.slice(6), knownPeer = phases.every(finite);
      // No peer history retains the labelled upper estimate. A partly recorded
      // or explicitly invalid cohort is a gap, never evidence of zero energy.
      if (values.slice(0, 6).every(finite) && (knownPeer || phases.every(value => value === undefined))) {
        const peer = knownPeer ? phases : [0, 0, 0];
        const residual = values.slice(0, 3).map((power, phase) => power - values[phase + 3] - peer[phase]);
        if (residual.every(value => value >= -0.05)) spans.push({ start: previous, end: event.at,
          phaseCurrentA: residual.map((power, phase) => Math.max(0, power) * 1000 / voltage[phase]),
          phasePowerKw: residual.map(power => Math.max(0, power)),
          unknownCharger2: !knownPeer });
      }
    }
    if (event.begins) active[event.item.index].set(event.item.key, event.item);
    else active[event.item.index].delete(event.item.key);
    previous = event.at;
  }
  return spans;
}

/** Retained public hourly helper. Production prediction preserves the scenario
 * distribution and each night's identity instead of pooling all history. */
export function householdProfile(rows, { timezone = TIME_ZONE, voltageV } = {}) {
  const entries = summarizeHousehold(householdSpans(rows, { voltageV }), { timezone });
  return Array.from({ length: 24 }, (_, hour) => {
    const group = entries.filter(entry => entry.hour === hour), coverageMs = group.reduce((sum, entry) => sum + entry.coverageMs, 0);
    if (coverageMs < 15 * 60_000) return null;
    const scenarios = group.flatMap(entry => entry.patterns.map(pattern => ({ phaseCurrentA: pattern.phaseCurrentA, weight: pattern.durationMs / coverageMs })));
    return { phaseCurrentA: [0, 1, 2].map(phase => scenarios.reduce((sum, item) => sum + item.phaseCurrentA[phase] * item.weight, 0)),
      coverageMs, method: 'duration-weighted-mean', scenarios, unknownCharger2: group.some(entry => entry.unknownCharger2) };
  });
}

function temperatureAt(rows, at, maxAgeMs = 3 * HOUR) {
  let low = 0, high = rows.length;
  while (low < high) { const mid = (low + high) >>> 1; if (rows[mid].at <= at) low = mid + 1; else high = mid; }
  const row = rows[low - 1];
  return row && at - row.at <= maxAgeMs && finite(row.value) ? row.value : null;
}
function trailingTemperature(rows, at) {
  const from = at - 6 * HOUR;
  let total = 0, duration = 0;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (row.at > at) continue;
    const end = Math.min(at, row.at + 3 * HOUR, rows[index + 1]?.at ?? at), start = Math.max(from, row.at);
    if (end > start && finite(row.value)) { total += row.value * (end - start); duration += end - start; }
    if (row.at < from - 3 * HOUR) break;
  }
  return duration >= HOUR ? total / duration : null;
}
function temperaturesFor(spans, temperatures) {
  return spans.map(span => ({ ...span, outdoorC: temperatureAt(temperatures, span.start),
    trailingOutdoorC: trailingTemperature(temperatures, span.start) }));
}

function subtractKnownPeer(spans, peers) {
  const rows = [];
  const known = spans.filter(span => span.referenceVoltageV?.every(value => finite(value) && value >= 200 && value <= 250));
  if (!known.length) return spans;
  for (const span of known) for (let phase = 1; phase <= 3; phase++) {
    const common = { unit: 'kWh', raw: { intervalStart: span.start, intervalEnd: span.end }, quality: [] };
    rows.push({ ...common, signal: `property_energy_l${phase}`, value: span.phaseCurrentA[phase - 1] * span.referenceVoltageV[phase - 1] / 1000 * (span.end - span.start) / HOUR },
      { ...common, signal: `ev1_energy_l${phase}`, value: 0 });
  }
  // The common divisor only transports the power calculation through the
  // interval sweep. Restore each original span's voltage reference below.
  const result = householdSpans([...rows, ...peers], { voltageV: known[0].referenceVoltageV });
  let index = 0;
  return [...spans.filter(span => !known.includes(span)), ...result.map(span => {
    while (index < spans.length - 1 && spans[index].end <= span.start) index++;
    const original = spans[index];
    return { ...original, ...span,
      phaseCurrentA: span.phasePowerKw.map((power, phase) => power * 1000 / original.referenceVoltageV[phase]) };
  })].sort((a, b) => a.start - b.start);
}

function importedVoltage(spans, store, input, now) {
  if (!spans.length) return spans;
  const read = createVoltageReader(store, { input, from: spans[0].start, to: spans.at(-1).end, now });
  return spans.flatMap(span => {
    const boundaries = [...new Set([span.start, ...read.boundaries(span.start, span.end), span.end])].sort((a, b) => a - b);
    return boundaries.slice(0, -1).map((start, index) => {
      const estimate = read(start, { allowFuture: true });
      return { ...span, start, end: boundaries[index + 1],
        ...(estimate.voltageV.every(finite) ? { referenceVoltageV: estimate.voltageV, voltageBasis: estimate.basis } : {}) };
    });
  });
}

function addEntries(reference, spans, priority, voltageV) {
  for (const entry of summarizeHousehold(spans, { timezone: reference.timezone, priority, voltageV: voltages(voltageV) })) reference.add(entry);
}

// Discover the conservative native-peer lower bound only during explicit
// reconstruction. Incremental source/receipt/admission rows can only lower it.
function earliestPeerStart(store, now, input) {
  const firstSavedPeer = store.db.prepare(`SELECT min(json_extract(raw,'$.intervalStart')) AS at FROM active_observations AS observations
    WHERE signal IN ('ev2_energy_l1','ev2_energy_l2','ev2_energy_l3') AND import_id IS NULL
      AND json_valid(raw) AND json_type(raw,'$.intervalStart')='integer'
      AND json_extract(raw,'$.intervalStart')>=-9007199254740991
      AND json_extract(raw,'$.intervalStart')<source_time AND json_extract(raw,'$.intervalEnd')=source_time
      AND source_time<=? AND received_at<=? AND ${nativeScope(input)}`).get(now, now).at;
  const firstPeer = Math.min(firstSavedPeer ?? Infinity,
    ...pendingEnergyObservations(store, { now, input: input === 'simulated' ? input : 'providers', prefix: 'ev2' })
      .map(row => parse(row.raw, {}).intervalStart).filter(Number.isSafeInteger));
  return Number.isSafeInteger(firstPeer) ? firstPeer : null;
}
/** Read original imported CSV using its original decoder and precedence.
 * Bounded adjacent snapshots supply an estimated profile, never native energy. */
function buildLegacy(store, reference, now, voltageV, { from = 0, to = now, onSpans, input = 'live', cohortContext } = {}) {
  const query = store.db.prepare(`SELECT r.raw,r.quality,r.source_time,r.row_number,i.id,i.kind
    FROM active_import_rows r JOIN active_imports i ON i.id=r.import_id
    WHERE i.status='complete' AND i.kind IN ('easee','stmq') AND r.source_time>=? AND r.source_time<=?
    ORDER BY r.source_time,i.id,r.row_number`);
  let previous = null, pendingTime = null, easee = null, outside = null, day = null, spans = [];
  const temperatures = [];
  const firstPeer = cohortContext.peerStart ?? Infinity;
  const flushDay = () => {
    if (spans.length) {
      let resolved = importedVoltage(spans, store, input, now);
      if (finite(firstPeer) && spans.at(-1).end >= firstPeer) {
        const peers = modernRows(store, { from: spans[0].start, to: spans.at(-1).end, now, input: 'live', prefix: 'ev2', cohortContext });
        if (peers.length) resolved = subtractKnownPeer(resolved, peers);
      }
      resolved = resolved.map(span => ({ ...span, start: Math.max(span.start, from), end: Math.min(span.end, to) })).filter(span => span.end > span.start);
      if (onSpans) onSpans(resolved);
      else addEntries(reference, resolved, 0);
    }
    spans = [];
  };
  const flushTime = () => {
    if (pendingTime === null) return;
    if (outside) {
      temperatures.push({ at: pendingTime, value: outside.value });
      while (temperatures.length > 1 && temperatures[1].at < pendingTime - 12 * HOUR) temperatures.shift();
    }
    if (!easee) return;
    const current = { at: pendingTime, values: easee.values };
    if (previous && current.at > previous.at && current.at - previous.at <= 30 * 60_000
      && previous.values && current.values) {
      // Forward hold, bounded by the next genuine report. Keep heating pulses
      // visible rather than smearing a changed endpoint backwards in time.
      for (let at = previous.at; at < current.at;) {
        const local = moment.tz(at, reference.timezone), date = local.format('YYYY-MM-DD');
        const end = Math.min(current.at, local.clone().startOf('day').add(1, 'day').valueOf());
        if (day !== null && day !== date) flushDay();
        day = date;
        spans.push({ start: at, end, phaseCurrentA: previous.values,
          outdoorC: temperatureAt(temperatures, at), trailingOutdoorC: trailingTemperature(temperatures, at),
          legacy: true, unknownCharger2: true });
        at = end;
      }
    }
    previous = current;
  };
  for (const original of query.iterate(Math.max(0, from - 12 * HOUR), Math.min(now, to + 30 * 60_000))) {
    if (pendingTime !== original.source_time) { flushTime(); pendingTime = original.source_time; easee = null; outside = null; }
    const decoded = decodeHistoryRow(original.kind, original.raw);
    const quality = parse(original.quality, ['missing']);
    if (decoded.sourceTime !== original.source_time) continue;
    if (original.kind === 'stmq') {
      const row = decoded.observations.find(item => item.signal === 'outdoor_temperature');
      outside = { value: row && valid({ ...row, quality: [...row.quality, ...quality] }) ? row.value : null };
    } else {
      const values = decoded.observations.map(row => valid({ ...row, quality: [...row.quality, ...quality] }) && row.unit === 'A' && row.value >= 0 && row.value <= 1000 ? row.value : null);
      const residual = values.slice(3).map((value, phase) => value === null || values[phase] === null ? null : value - values[phase]);
      easee = { values: residual.every(value => finite(value) && value >= -0.5) ? residual.map(value => Math.max(0, value)) : null };
    }
  }
  flushTime(); flushDay();
}

const cacheByDb = new WeakMap();
const availabilitySignals = [...SIGNALS, ...VOLTAGE_SIGNALS, 'outdoor_temperature'];
// Keep the two original clocks independent. A scalar max() predicate cannot
// seek either clock and scans all retained inputs to establish an empty future.
// Unary source/signal terms leave receipt time as that branch's index seek.
const changeColumns = 'id,source,device,source_time,received_at,raw,signal,value,unit,quality';
const futureInputs = input => `
  SELECT ${changeColumns} FROM active_observations
    WHERE signal IN (${availabilitySignals.map(() => '?').join(',')}) AND source_time>?
      AND import_id IS NULL AND ${nativeScope(input)}
  UNION ALL
  SELECT ${changeColumns} FROM active_observations
    WHERE +signal IN (${availabilitySignals.map(() => '?').join(',')}) AND received_at>?
      AND import_id IS NULL AND ${nativeScope(input).replace(/\bsource\b/g, '+source')}`;
const futureBindings = after => [...availabilitySignals, after, ...availabilitySignals, after];
function nextSourceAt(store, now, input) {
  return store.db.prepare(`SELECT min(max(source_time,received_at)) AS at FROM (${futureInputs(input)})`)
    .get(...futureBindings(now)).at;
}
function modernRows(store, { from, to, now, input, prefix, cohortContext }) {
  const rows = [];
  for (const group of canonicalEnergyGroups(store, { from, to, now, input, prefix, cohortContext })) {
    if (!['property','ev1','ev2'].includes(group.prefix)) continue;
    if (group.start >= to || group.end <= from) continue;
    group.values.forEach((value,index) => rows.push({ id: group.observationIds[index] ?? 0,
      signal: `${group.prefix}_energy_l${index+1}`,
      value: group.conflict ? null : value, unit: 'kWh', quality: [], source_time: group.end,
      raw: { intervalStart: group.start, intervalEnd: group.end } }));
  }
  return rows;
}

// Mutable numeric prefixes require complete valid zero charger cohorts.
// Immutable-ID geometry and conflict spans separately preserve canonical
// values or unknown results; neither turns missing evidence into idle energy.
const MAX_COHORT_PROOFS = 1000;
const proofIdentity = proof => JSON.stringify([proof.source, proof.device, proof.prefix, proof.start]);
function zeroPendingProofs(rows) {
  const groups = new Map();
  for (const row of rows) {
    const raw = parse(row.raw, {}), quality = parse(row.quality, null), prefix = row.signal.split('_energy_')[0];
    if (!['ev1', 'ev2'].includes(prefix) || row.unit !== 'kWh' || row.value !== 0 || !validEnergyQuality(quality)
      || raw.auditOnly || raw.acquisitionOnly || raw.timeBasis === 'completed-hour') continue;
    const proof = { source: row.source, device: row.device, prefix, start: raw.intervalStart, end: raw.intervalEnd,
      quality: row.quality, basis: raw.basis ?? null, transport: raw.transport ?? null, ids: null };
    const key = proofIdentity(proof), state = groups.get(key) ?? { proof, phases: new Set(), invalid: false };
    if (state.proof.end !== proof.end || state.proof.quality !== proof.quality || state.proof.basis !== proof.basis
      || state.proof.transport !== proof.transport || state.phases.has(row.signal)) state.invalid = true;
    state.phases.add(row.signal); groups.set(key, state);
  }
  return [...groups.values()].filter(state => !state.invalid && state.phases.size === 3).map(state => state.proof);
}
const sameZeroMeaning = (a, b) => proofIdentity(a) === proofIdentity(b) && a.quality === b.quality
  && a.basis === b.basis && a.transport === b.transport;
function pendingGeometries(rows) {
  const groups = new Map();
  for (const row of rows) {
    const raw = parse(row.raw, {}), prefix = row.signal.split('_energy_')[0];
    const geometry = { source: row.source, device: row.device, prefix, start: raw.intervalStart, end: raw.intervalEnd };
    const key = proofIdentity(geometry), saved = groups.get(key) ?? { ...geometry, phases: new Set() };
    saved.phases.add(row.signal); groups.set(key, saved);
  }
  return [...groups.values()].filter(group => group.phases.size === 3);
}
const intersects = (a, b) => a.prefix === b.prefix && a.start < b.end && a.end > b.start;
function conflictProof(context, group) {
  return !group.availabilityGap && context?.conflicts.find(proof => intersects(proof, group));
}
function acceptConflict(context, group) {
  if (!context || !group.conflict || group.end - group.start <= DAY || group.end < context.mutableAfter) return;
  const existing = context.conflicts.find(proof => intersects(proof, group));
  if (existing) { existing.start = Math.min(existing.start, group.start); existing.end = Math.max(existing.end, group.end); }
  else if (context.conflicts.length < MAX_COHORT_PROOFS)
    context.conflicts.push({ prefix: group.prefix, start: group.start, end: group.end, validatedEnd: null });
}
const savedConflicts = context => context.conflicts.map(({ prefix, start, end }) => ({ prefix, start, end }));
function provenCohortGroup(group, proof) {
  if (group.conflict || group.availabilityGap || proofIdentity(group) !== proofIdentity(proof)
    || (group.basis ?? null) !== proof.basis || (group.transport ?? null) !== proof.transport) return false;
  // Finalized rows are immutable: this proves original overlap geometry, not
  // numeric validity. Canonical null/invalid values remain null/invalid.
  if (proof.ids !== null) return !group.pending && group.end === proof.end
    && proof.ids.every((id, i) => group.observationIds[i] === id);
  return group.pending && group.end >= proof.end && group.values.length === 3 && group.values.every(value => value === 0);
}
function acceptCohortGroup(store, context, group) {
  if (!context) return;
  const finalized = context.proofs.find(proof => proof.ids !== null && provenCohortGroup(group, proof));
  if (finalized) finalized.end = group.end;
  else if (!group.pending && !group.conflict && !group.availabilityGap && ['property', 'ev1', 'ev2'].includes(group.prefix)
    && group.observationIds.length === 3
    && group.observationIds.every(id => Number.isSafeInteger(id) && id > 0) && new Set(group.observationIds).size === 3
    && group.end - group.start > DAY && group.end >= context.mutableAfter && context.proofs.length < MAX_COHORT_PROOFS) {
    // Cold recovery has already checked the complete original overlap cluster.
    // Preserve that geometry for a long interval finalized recently too;
    // otherwise every ordinary same-day query would rewind its old prefix.
    const quality = store.db.prepare('SELECT quality FROM active_observations WHERE id=?').get(group.observationIds[0])?.quality;
    if (typeof quality === 'string' && quality.length <= 4096 && Array.isArray(parse(quality, null)))
      context.proofs.push({ source: group.source, device: group.device, prefix: group.prefix, start: group.start,
        end: group.end, quality, basis: group.basis ?? null, transport: group.transport ?? null, ids: [...group.observationIds] });
  }
  const candidate = context.pending.find(proof => provenCohortGroup(group, proof));
  if (candidate && candidate.end - candidate.start > DAY) {
    const previous = context.proofs.findIndex(proof => proofIdentity(proof) === proofIdentity(candidate));
    if (previous >= 0) context.proofs[previous] = { ...candidate };
    else if (context.proofs.length < MAX_COHORT_PROOFS) context.proofs.push({ ...candidate });
  }
}

function* canonicalEnergyGroups(store, { from, now, to = now, input, prefix, cohortContext }) {
  let cursor = from, iterator;
  try {
    for (;;) {
      iterator = recordedEnergyGroups(store, { from: cursor, to: now, now, input: input === 'simulated' ? input : 'providers', prefix });
      let next = iterator.next();
      if (!next.done && next.value.start < cursor && !conflictProof(cohortContext, next.value)
        && !cohortContext?.proofs.some(proof => provenCohortGroup(next.value, proof))) {
        // Include any earlier cohort which conflicted with this original
        // crossing interval, even when that cohort ended before the date.
        cursor = next.value.start;
        iterator.return?.();
        continue;
      }
      while (!next.done && next.value.start < to) {
        if (next.value.end > from) {
          if (conflictProof(cohortContext, next.value)) next.value.conflict = true;
          acceptConflict(cohortContext, next.value);
          acceptCohortGroup(store, cohortContext, next.value); yield next.value;
        }
        next = iterator.next();
      }
      return;
    }
  } finally { try { iterator?.return?.(); } catch { /* Preserve an original reader/projection failure. */ } }
}

function affectedEnergyRanges(store, ranges, { now, input, cohortContext }) {
  for (const [prefix, range] of ranges) {
    // A late overlapping interval may invalidate an older, much longer one.
    // Follow the actual connected cluster backwards; no guessed duration cap
    // may leave a previously optimistic reference in unaffected-looking dates.
    let previousStart;
    do {
      previousStart = range.start;
      for (const group of canonicalEnergyGroups(store, { from: range.start, now, input, prefix, cohortContext })) {
        if (group.start >= range.end) break;
        if (group.conflict && group.end > range.start) {
          const known = conflictProof(cohortContext, group);
          const start = Number.isFinite(known?.validatedEnd) ? Math.max(group.start, known.validatedEnd) : group.start;
          range.start = Math.min(range.start, start);
          range.end = Math.max(range.end, group.end);
        }
      }
    } while (range.start < previousStart);
  }
  return ranges;
}

/** Merge three chronological logical streams once. Requerying each archive
 * week previously walked an ever longer prefix of the interval geometry index.
 * Keep only the current week and intervals genuinely crossing its boundary.
 * Resolve known overlap clusters through now, even for a shorter rebuilt date:
 * an interval's validity must not depend on an arbitrary weekly boundary. */
function* modernWindows(store, { from, to, now, input, timezone, cohortContext }) {
  const streams = [];
  let active = [];
  try {
    for (const prefix of ['property', 'ev1', 'ev2']) {
      const stream = { iterator: null, next: null };
      streams.push(stream);
      stream.iterator = canonicalEnergyGroups(store, { from, to, now, input, prefix, cohortContext });
      stream.next = stream.iterator.next();
    }
    for (let start = from; start < to;) {
      const end = Math.min(to, moment.tz(start, timezone).add(7, 'days').valueOf());
      for (;;) {
        let selected;
        for (const stream of streams) if (!stream.next.done && (!selected || stream.next.value.start < selected.next.value.start)) selected = stream;
        if (!selected || selected.next.value.start >= end) break;
        if (selected.next.value.end > start) active.push(selected.next.value);
        selected.next = selected.iterator.next();
      }
      const rows = active.flatMap(group => group.values.map((value, index) => ({ id: group.observationIds[index] ?? 0,
        signal: `${group.prefix}_energy_l${index + 1}`, value: group.conflict ? null : value, unit: 'kWh', quality: [],
        source_time: group.end, raw: { intervalStart: group.start, intervalEnd: group.end } })));
      yield { start, end, rows };
      active = active.filter(group => group.end > end);
      start = end;
    }
  } finally {
    for (const stream of streams) try { stream.iterator?.return?.(); } catch { /* Preserve the original projection/reader error. */ }
  }
}
function modernTemperatures(store, { from, to, now, input }) {
  return store.db.prepare(`SELECT id,value,quality,source_time,unit FROM active_observations AS observations
    WHERE signal='outdoor_temperature' AND source_time>=? AND source_time<=?
      AND received_at<=?
      AND import_id IS NULL AND ${nativeScope(input)} ORDER BY source_time,id`)
    .all(from - 9 * HOUR, Math.min(now, to), now).map(row => ({ at: row.source_time,
      value: ['degC', '°C'].includes(row.unit) && valid({ ...row, quality: parse(row.quality, ['missing']) }) ? row.value : null }));
}
function uncoveredSpans(spans, covered) {
  covered.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const span of covered) {
    if (merged.length && span.start <= merged.at(-1).end) merged.at(-1).end = Math.max(merged.at(-1).end, span.end);
    else merged.push({ ...span });
  }
  const result = [];
  let index = 0;
  for (const span of spans) {
    let cursor = span.start;
    while (index < merged.length && merged[index].end <= cursor) index++;
    for (let at = index; at < merged.length && merged[at].start < span.end; at++) {
      if (merged[at].start > cursor) result.push({ ...span, start: cursor, end: Math.min(span.end, merged[at].start) });
      cursor = Math.max(cursor, merged[at].end);
      if (cursor >= span.end) break;
    }
    if (cursor < span.end) result.push({ ...span, start: cursor });
  }
  return result;
}

function updateModern(store, reference, { from, to, now, input, voltageV, cohortContext }) {
  // Process one week at a time. Neither a years-long history nor expanded
  // imported observations is ever materialized as one JavaScript row array.
  for (const { start, end, rows } of modernWindows(store, { from, to, now, input, timezone: reference.timezone, cohortContext })) {
    const nativeHours = new Set(), covered = [];
    for (const row of rows) {
      if (!row.signal.startsWith('property_energy_')) continue;
      const raw = parse(row.raw, {}), from = Math.max(start, raw.intervalStart), to = Math.min(end, raw.intervalEnd);
      if (!finite(from) || !finite(to) || to <= from) continue;
      covered.push({ start: from, end: to });
      for (let at = from; at < to;) {
        const local = moment.tz(at, reference.timezone);
        nativeHours.add(`${local.format('YYYY-MM-DD')}:${local.hour()}`);
        at = local.startOf('hour').add(1, 'hour').valueOf();
      }
    }
    const overlappingImport = input !== 'simulated' && nativeHours.size > 0 && (store.db.prepare(`SELECT 1
      FROM active_import_rows r JOIN active_imports i ON i.id=r.import_id
      WHERE i.status='complete' AND i.kind='easee' AND r.source_time>=? AND r.source_time<=? LIMIT 1`)
      .get(Math.max(0, start - 12 * HOUR), Math.min(now, end + 30 * 60_000)) != null);
    reference.removeLegacyHours(nativeHours);
    let spans = householdSpans(rows, { voltageV }).map(span => ({ ...span, start: Math.max(span.start, start), end: Math.min(span.end, end) }))
      .filter(span => span.end > span.start);
    spans = temperaturesFor(spans, modernTemperatures(store, { from: start, to: end, now, input }));
    if (overlappingImport && input !== 'simulated') {
      // Where modern and imported history overlap, replace only the genuinely
      // covered interval. A short native fragment must not erase the rest of a
      // useful original night, nor cover an explicit modern recording gap.
      const imported = [];
      buildLegacy(store, reference, now, voltageV, { from: start, to: end, onSpans: values => imported.push(...values), cohortContext });
      spans.push(...uncoveredSpans(imported, covered).filter(span => {
        const local = moment.tz(span.start, reference.timezone);
        return nativeHours.has(`${local.format('YYYY-MM-DD')}:${local.hour()}`);
      }));
      spans.sort((a, b) => a.start - b.start);
    }
    addEntries(reference, spans, 1, voltageV);
  }
}

/** Cache only compact per-night/hour load distributions. A complete-import
 * signature rebuilds original CSV references; later observations refresh only
 * their affected dates. This separate forecast index never changes thermal
 * learning journals or their versioned replay. */
export function householdReferenceIdentity(store, { now, input = 'live', timezone = TIME_ZONE }) {
  const imports = input === 'simulated' ? '' : JSON.stringify(store.db.prepare("SELECT id,row_count,completed_at FROM active_imports AS imports WHERE status='complete' AND kind IN ('stmq','easee') ORDER BY id").all());
  // Only first-usable fallback publication changes pre-estimate CSV meaning.
  // Ordinary later estimates must not repeatedly reinterpret that archive.
  const csvVoltageKey = input === 'simulated' ? '' : JSON.stringify(createVoltageReader(store, { input, now })(0, { allowFuture: true }));
  const historySelection = store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation;
  const key = JSON.stringify([input, timezone, historySelection]);
  return { key, imports, csvVoltageKey, input, selection: historySelection };
}

export function householdReference(store, { now, input = 'live', voltageV, timezone = TIME_ZONE }) {
  if (!store?.db) return new HouseholdReference({ timezone });
  const { key, imports, csvVoltageKey } = store.householdIdentity ?? householdReferenceIdentity(store, { now, input, timezone });
  const voltageAvailable = voltages(voltageV).every(value => finite(value) && value >= 200 && value <= 250);
  const pendingRows = pendingEnergyObservations(store, { now, input: input === 'simulated' ? input : 'providers' })
    .filter(row => SIGNALS.includes(row.signal));
  const pendingKey = JSON.stringify(pendingRows);
  let cache = cacheByDb.get(store.db);
  const watermark = store.db.prepare('SELECT max(id) AS id FROM active_observations AS observations').get().id ?? 0;
  if (!cache) {
    cache = store.householdCache?.load({ key, imports, csvVoltageKey, now, watermark, timezone }) ?? null;
    if (cache) cacheByDb.set(store.db, cache);
  }
  const rebuild = () => {
    const cohortContext = { proofs: [], conflicts: [], pending: zeroPendingProofs(pendingRows), peerStart: earliestPeerStart(store, now, input) };
    const reference = new HouseholdReference({ timezone });
    reference.advance(now);
    cohortContext.mutableAfter = reference.mutableAfter;
    if (input !== 'simulated') buildLegacy(store, reference, now, voltageV, { cohortContext });
    const firstSaved = store.db.prepare(`SELECT min(json_extract(raw,'$.intervalStart')) AS at FROM active_observations AS observations
      WHERE signal IN (${SIGNALS.map(() => '?').join(',')}) AND json_valid(raw) AND import_id IS NULL AND ${nativeScope(input)}`).get(...SIGNALS).at;
    const first = Math.min(firstSaved ?? Infinity, ...pendingRows.map(row => parse(row.raw, {}).intervalStart));
    if (voltageAvailable && finite(first) && first <= now) updateModern(store, reference, { from: moment.tz(first - DAY, timezone).startOf('day').valueOf(), to: now, now, input, voltageV, cohortContext });
    // Admission is normally no later than live wall time. A historical cutoff
    // or clock rollback can precede an already committed admission, though.
    // Discover its next activation only during this explicit full rebuild;
    // never scan historical JSON clocks on ordinary forecast refreshes.
    const futureAdmission = store.db.prepare(`SELECT min(json_extract(raw,'$.timeAdmission.admittedAt')) AS at,min(id) AS id
      FROM active_observations WHERE signal IN (${SIGNALS.map(() => '?').join(',')}) AND import_id IS NULL
      AND ${nativeScope(input)} AND json_valid(raw) AND json_type(raw,'$.timeAdmission.admittedAt')='integer'
      AND json_extract(raw,'$.timeAdmission.admittedAt')>?`).get(...SIGNALS, now);
    cache = { key, imports, csvVoltageKey, reference, watermark, now, pendingKey, pendingRows, cohortProofs: cohortContext.proofs, conflicts: savedConflicts(cohortContext), peerStart: cohortContext.peerStart, voltageReady: voltageAvailable,
      nextSourceAt: nextSourceAt(store, now, input), nextAdmissionAt: futureAdmission.at,
      admissionAfter: futureAdmission.id === null ? null : futureAdmission.id - 1 };
    cacheByDb.set(store.db, cache);
    store.householdCache?.save(cache, { force: true });
    return reference;
  };
  if (!cache || cache.key !== key || cache.imports !== imports || cache.csvVoltageKey !== csvVoltageKey || now < cache.now) return rebuild();
  cache.reference.advance(now);
  if (!voltageAvailable) return cache.reference;
  if (!cache.voltageReady) {
    // Original ampere snapshots are useful before the first voltage report.
    // When voltage arrives, add energy-derived records to the same index;
    // never decode the entire legacy archive a second time at startup.
    const cohortContext = { proofs: [], conflicts: [], pending: zeroPendingProofs(pendingRows), peerStart: earliestPeerStart(store, now, input), mutableAfter: cache.reference.mutableAfter };
    const importedDates = new Set([...cache.reference.legacyHours].map(key => key.slice(0, 10))), peerDates = new Set();
    if (input !== 'simulated' && importedDates.size) for (const row of store.db.prepare(`SELECT source_time,raw FROM active_observations AS observations
      WHERE signal IN ('ev2_energy_l1','ev2_energy_l2','ev2_energy_l3') AND source_time<=? AND import_id IS NULL AND ${nativeScope(input)}`).iterate(now)) {
      const raw = parse(row.raw, {});
      if (!finite(raw.intervalStart) || !finite(raw.intervalEnd) || raw.intervalEnd <= raw.intervalStart) continue;
      for (let at = moment.tz(raw.intervalStart, timezone).startOf('day'); at.valueOf() < raw.intervalEnd; at.add(1, 'day'))
        if (importedDates.has(at.format('YYYY-MM-DD'))) peerDates.add(at.format('YYYY-MM-DD'));
    }
    for (const date of peerDates) {
      const from = moment.tz(date, timezone).startOf('day'), to = from.clone().add(1, 'day').valueOf();
      cache.reference.removeDates(new Set([date]), 0);
      buildLegacy(store, cache.reference, now, voltageV, { from: from.valueOf(), to, cohortContext });
    }
    const firstSaved = store.db.prepare(`SELECT min(json_extract(raw,'$.intervalStart')) AS at FROM active_observations AS observations
      WHERE signal IN (${SIGNALS.map(() => '?').join(',')}) AND json_valid(raw) AND import_id IS NULL AND ${nativeScope(input)}`).get(...SIGNALS).at;
    const first = Math.min(firstSaved ?? Infinity, ...pendingRows.map(row => parse(row.raw, {}).intervalStart));
    if (finite(first) && first <= now) updateModern(store, cache.reference,
      { from: moment.tz(first - DAY, timezone).startOf('day').valueOf(), to: now, now, input, voltageV, cohortContext });
    cache.cohortProofs = cohortContext.proofs; cache.conflicts = savedConflicts(cohortContext); cache.peerStart = cohortContext.peerStart;
    cache.voltageReady = true; cache.watermark = watermark; cache.now = now; cache.pendingKey = pendingKey; cache.pendingRows = pendingRows;
    cache.nextSourceAt = nextSourceAt(store, now, input);
    store.householdCache?.save(cache);
    return cache.reference;
  }
  if (watermark > cache.watermark || pendingKey !== cache.pendingKey || finite(cache.nextSourceAt) && cache.nextSourceAt <= now
    || finite(cache.nextAdmissionAt) && cache.nextAdmissionAt <= now) {
    const previousNextAdmissionAt = cache.nextAdmissionAt, previousAdmissionAfter = cache.admissionAfter;
    function* sourceChanges() {
      yield* store.db.prepare(`SELECT ${changeColumns} FROM active_observations AS observations WHERE id>? AND id<=?
        AND +signal IN (${[...SIGNALS, ...VOLTAGE_SIGNALS, 'outdoor_temperature'].map(() => '?').join(',')})
        AND import_id IS NULL AND ${nativeScope(input).replace(/\bsource\b/g, '+source')}`)
        .iterate(cache.watermark, watermark, ...SIGNALS, ...VOLTAGE_SIGNALS, 'outdoor_temperature');
      if (finite(cache.nextSourceAt) && cache.nextSourceAt <= now) yield* store.db.prepare(`SELECT ${changeColumns}
        FROM (${futureInputs(input)}) WHERE max(source_time,received_at)>? AND max(source_time,received_at)<=? GROUP BY id`)
        .iterate(...futureBindings(cache.now), cache.now, now);
      if (finite(previousNextAdmissionAt) && previousNextAdmissionAt <= now && Number.isSafeInteger(previousAdmissionAfter)) {
        let nextAdmissionAt = null, admissionAfter = null;
        for (const row of store.db.prepare(`SELECT ${changeColumns} FROM active_observations WHERE id>? AND id<=?
          AND +signal IN (${SIGNALS.map(() => '?').join(',')}) AND import_id IS NULL AND ${nativeScope(input).replace(/\bsource\b/g, '+source')}`)
          .iterate(previousAdmissionAfter, watermark, ...SIGNALS)) {
          const admittedAt = parse(row.raw, {}).timeAdmission?.admittedAt;
          if (!Number.isSafeInteger(admittedAt)) continue;
          if (admittedAt > now) {
            nextAdmissionAt = Math.min(nextAdmissionAt ?? Infinity, admittedAt);
            admissionAfter = Math.min(admissionAfter ?? Infinity, row.id - 1);
          } else if (admittedAt > cache.now) yield row;
        }
        cache.nextAdmissionAt = nextAdmissionAt; cache.admissionAfter = admissionAfter;
      }
    }
    const cohortContext = { proofs: cache.cohortProofs.filter(proof => proof.end - proof.start > DAY && (proof.ids === null || proof.end >= cache.reference.mutableAfter))
      .map(proof => ({ ...proof })), conflicts: cache.conflicts.filter(proof => proof.end >= cache.reference.mutableAfter)
        .map(proof => ({ ...proof, validatedEnd: proof.end })), pending: zeroPendingProofs(pendingRows), peerStart: cache.peerStart, mutableAfter: cache.reference.mutableAfter };
    const cutoffs = new Map(), finalizations = new Map(), invalidProofs = new Set();
    const previousPending = pendingGeometries(cache.pendingRows), currentPending = pendingGeometries(pendingRows);
    const completedGeometry = new Map();
    for (const pending of currentPending) if (pending.prefix === 'ev2')
      cohortContext.peerStart = Math.min(cohortContext.peerStart ?? Infinity, pending.start);
    let leftConflictChange = false;
    // This second bounded-tail pass avoids retaining arbitrary changed rows.
    // New late/conflicting evidence can invalidate an old zero prefix before
    // any shortcut is applied to the mutable recorder tail.
    for (const row of sourceChanges()) {
      const raw = parse(row.raw, {});
      if (row.source_time > now || row.received_at > now || (raw.timeAdmission?.admittedAt ?? 0) > now) continue;
      const prefix = row.signal.split('_energy_')[0];
      if (prefix === 'ev2' && Number.isSafeInteger(raw.intervalStart) && raw.intervalStart < row.source_time
        && raw.intervalEnd === row.source_time)
        cohortContext.peerStart = Math.min(cohortContext.peerStart ?? Infinity, raw.intervalStart);
      const geometry = { source: row.source, device: row.device, prefix, start: raw.intervalStart, end: raw.intervalEnd };
      const measured = SIGNALS.includes(row.signal) && Number.isSafeInteger(raw.intervalStart) && raw.intervalEnd === row.source_time
        && raw.intervalEnd > raw.intervalStart && observationTimeAdmitted({ sourceTime: row.source_time, receivedAt: row.received_at, raw }, now)
        && !isRecordedEnergyGap(row, raw, parse(row.quality, null));
      if (measured) {
        for (const pending of previousPending) if (proofIdentity(pending) === proofIdentity(geometry) && geometry.end >= pending.end) {
          const key = proofIdentity(pending), saved = completedGeometry.get(key) ?? { end: geometry.end, ids: [null, null, null], invalid: false };
          const phase = Number(row.signal.at(-1)) - 1;
          if (saved.end !== geometry.end || saved.ids[phase] !== null && saved.ids[phase] !== row.id) saved.invalid = true;
          saved.ids[phase] = row.id; completedGeometry.set(key, saved);
        }
        for (const proof of cohortContext.conflicts) if (intersects(proof, geometry)) {
          if (geometry.start < proof.start) leftConflictChange = true;
          proof.end = Math.max(proof.end, geometry.end);
        }
      }
      for (const proof of cohortContext.proofs) {
        if (prefix !== proof.prefix || !(raw.intervalStart < proof.end && row.source_time > proof.start)) continue;
        if (proof.ids?.includes(row.id)) continue;
        const candidate = { source: row.source, device: row.device, prefix, start: raw.intervalStart,
          quality: row.quality, basis: raw.basis ?? null, transport: raw.transport ?? null };
        if (proof.ids !== null || !sameZeroMeaning(proof, candidate) || raw.intervalEnd !== row.source_time
          || row.source_time < proof.end || row.value !== 0 || row.unit !== 'kWh' || raw.auditOnly || raw.acquisitionOnly
          || raw.timeBasis === 'completed-hour' || !validEnergyQuality(parse(row.quality, null))
          || !observationTimeAdmitted({ sourceTime: row.source_time, receivedAt: row.received_at, raw }, now)) {
          invalidProofs.add(proof); continue;
        }
        const phase = Number(row.signal.at(-1)) - 1;
        const saved = finalizations.get(proof) ?? { end: row.source_time, ids: [null, null, null] };
        if (saved.end !== row.source_time || saved.ids[phase] !== null && saved.ids[phase] !== row.id) invalidProofs.add(proof);
        saved.ids[phase] = row.id; finalizations.set(proof, saved);
      }
    }
    // Conflict geometry is monotone while every original pending participant
    // still exists (or has finalized as a complete, admitted measured cohort).
    // Numeric/quality changes cannot make an existing overlap valid; removal
    // or shortened/unknown geometry can and requires a fresh assessment.
    if (leftConflictChange) return rebuild();
    for (const proof of cohortContext.conflicts) {
      for (const pending of previousPending) if (intersects(proof, pending)) {
        const current = currentPending.find(group => proofIdentity(group) === proofIdentity(pending) && group.end >= pending.end);
        const completed = completedGeometry.get(proofIdentity(pending));
        if (!current && (!completed || completed.invalid || completed.ids.some(id => !Number.isSafeInteger(id)))) return rebuild();
      }
      for (const current of currentPending) if (intersects(proof, current)) {
        if (current.start < proof.start) return rebuild();
        proof.end = Math.max(proof.end, current.end);
      }
    }
    for (const proof of cohortContext.proofs) {
      if (invalidProofs.has(proof)) continue;
      const next = cohortContext.pending.find(candidate => sameZeroMeaning(proof, candidate) && candidate.end >= proof.end);
      const finalized = finalizations.get(proof);
      if (finalized) {
        if (finalized.ids.some(id => !Number.isSafeInteger(id))) { invalidProofs.add(proof); continue; }
        for (const id of finalized.ids) cutoffs.set(id, proof.end);
        cutoffs.set(proofIdentity(proof), proof.end);
        proof.ids = finalized.ids;
      } else if (proof.ids === null) {
        if (!next) { invalidProofs.add(proof); continue; }
        cutoffs.set(proofIdentity(proof), proof.end);
      }
    }
    cohortContext.proofs = cohortContext.proofs.filter(proof => !invalidProofs.has(proof));
    function* changedRows() {
      yield* sourceChanges();
      if (pendingKey !== cache.pendingKey) { yield* cache.pendingRows; yield* pendingRows; }
    }
    const dates = new Map(), changedPeerDates = new Set(), energyRanges = new Map();
    const maxChangedDates = 32;
    const addDates = (start, end, peer) => {
      for (let at = moment.tz(start, timezone).startOf('day'); at.valueOf() <= Math.min(now, end); at.add(1, 'day')) {
        const date = at.format('YYYY-MM-DD');
        dates.set(date, [at.valueOf(), at.clone().add(1, 'day').valueOf()]);
        if (peer) changedPeerDates.add(date);
        if (dates.size > maxChangedDates) return false;
      }
      return true;
    };
    for (const row of changedRows()) {
      if (!finite(row.source_time) || row.source_time > now || row.received_at > now) continue;
      const raw = parse(row.raw, {});
      let cutoff = row.id === undefined ? cutoffs.get(proofIdentity({ source: row.source, device: row.device,
        prefix: row.signal.split('_energy_')[0], start: raw.intervalStart })) : cutoffs.get(row.id);
      const knownConflict = cohortContext.conflicts.find(proof => proof.prefix === row.signal.split('_energy_')[0]
        && raw.intervalStart >= proof.start && raw.intervalStart < proof.validatedEnd && row.source_time > proof.start);
      if (knownConflict) cutoff = Math.max(cutoff ?? -Infinity, knownConflict.validatedEnd);
      const start = Math.max(Math.min(row.source_time, raw.intervalStart ?? row.source_time), cutoff ?? -Infinity);
      if (Number.isSafeInteger(raw.timeAdmission?.admittedAt) && raw.timeAdmission.admittedAt > now) {
        cache.nextAdmissionAt = Math.min(cache.nextAdmissionAt ?? Infinity, raw.timeAdmission.admittedAt);
        if (Number.isSafeInteger(row.id)) cache.admissionAfter = Math.min(cache.admissionAfter ?? Infinity, row.id - 1);
        continue;
      }
      if (start >= row.source_time && SIGNALS.includes(row.signal)) continue;
      const affectedUntil = Math.min(now, row.source_time + (row.signal === 'outdoor_temperature' ? 9 * HOUR : 0));
      if (!addDates(start, affectedUntil, row.signal.startsWith('ev2_energy'))) return rebuild();
      if (SIGNALS.includes(row.signal) && finite(raw.intervalStart) && finite(raw.intervalEnd) && raw.intervalEnd > raw.intervalStart) {
        const prefix = row.signal.slice(0, row.signal.indexOf('_energy_')), existing = energyRanges.get(prefix);
        energyRanges.set(prefix, { start: Math.min(existing?.start ?? Infinity, start), end: Math.max(existing?.end ?? -Infinity, raw.intervalEnd) });
      }
      if (VOLTAGE_SIGNALS.includes(row.signal)) {
        const availableAt = Math.max(row.source_time, row.received_at ?? row.source_time);
        // Imported amperes adopt voltage at original availability, not at a
        // backdated source clock. Only retained imported reference dates need
        // rebuilding, independently of the archive's elapsed duration.
        for (const key of cache.reference.legacyHours) {
          const date = key.slice(0, 10), from = moment.tz(date, timezone).startOf('day').valueOf();
          if (moment.tz(from, timezone).add(1, 'day').valueOf() > availableAt && !addDates(from, from, true)) return rebuild();
        }
      }
    }
    for (const [prefix, range] of affectedEnergyRanges(store, energyRanges, { now, input, cohortContext }))
      if (!addDates(range.start, range.end, prefix === 'ev2')) return rebuild();
    const fullBuckets = [...cache.reference.evictedBuckets];
    cache.reference.removeDates(new Set(dates.keys()), 1);
    const importedDates = new Set([...cache.reference.legacyHours].map(key => key.slice(0, 10)));
    for (const date of changedPeerDates) if (importedDates.has(date)) {
      const [from, to] = dates.get(date);
      cache.reference.removeDates(new Set([date]), 0);
      buildLegacy(store, cache.reference, now, voltageV, { from, to, cohortContext });
    }
    for (const [from, to] of dates.values()) updateModern(store, cache.reference, { from, to, now, input, voltageV, cohortContext });
    // A destructive correction can uncover an older example already evicted
    // from the bounded 32-night bucket. Recover it from authoritative source in
    // the background worker rather than retaining every historical hourly
    // summary or silently leaving the compact index incomplete.
    if (fullBuckets.some(key => [...(cache.reference.buckets.get(key)?.values() ?? [])]
      .filter(entry => entry.at < cache.reference.mutableAfter).length < MAX_BUCKET_NIGHTS)) return rebuild();
    cache.cohortProofs = cohortContext.proofs; cache.conflicts = savedConflicts(cohortContext); cache.peerStart = cohortContext.peerStart;
    cache.watermark = watermark;
    cache.pendingKey = pendingKey; cache.pendingRows = pendingRows;
    cache.nextSourceAt = nextSourceAt(store, now, input);
    // Publish the cutoff together with its watermark; future receipts that were
    // already assigned IDs must still activate after a process restart.
    cache.now = now;
    store.householdCache?.save(cache);
  }
  cache.now = now;
  return cache.reference;
}

export function forecastHousehold(store, { now, deadlineAt, input, voltageV, timezone = TIME_ZONE, weather = [], outdoorC = null } = {}) {
  const reference = householdReference(store, { now, input, voltageV, timezone });
  const weatherRows = Array.isArray(weather) ? weather : weather?.intervals ?? [];
  const temperatures = weatherRows.filter(row => finite(row.start) && finite(row.outdoorC))
    .map(row => ({ at: row.start, value: row.outdoorC })).sort((a, b) => a.at - b.at);
  const result = [];
  for (let start = now; start < deadlineAt;) {
    const end = Math.min(deadlineAt, moment.tz(start, timezone).startOf('hour').add(1, 'hour').valueOf());
    const predictedC = temperatureAt(temperatures, start);
    result.push({ start, end, ...predictHousehold(reference, { at: start, now,
      outdoorC: finite(predictedC) ? predictedC : outdoorC, trailingOutdoorC: trailingTemperature(temperatures, start), voltageV: voltages(voltageV) }) });
    start = end;
  }
  return result;
}

/** One concise description for the card; interval-specific scenarios stay in
 * the planner. Mixed reference quality is reported honestly across the horizon. */
export function householdReferenceSummary(rows) {
  const references = (rows ?? []).map(row => row.reference).filter(Boolean);
  const useful = references.filter(value => !value.noHistory);
  if (!useful.length) return { method: 'no-history', nights: 0, noHistory: true, limited: true,
    unknownCharger2: false, legacy: false, temperatureRangeC: null, oldestAt: null, newestAt: null };
  const temperatures = useful.flatMap(value => value.temperatureRangeC ?? []);
  const methods = [...new Set(useful.map(value => value.method))];
  return { method: methods.length === 1 ? methods[0] : 'mixed-history',
    nights: Math.max(...useful.map(value => value.nights)), minimumNights: Math.min(...useful.map(value => value.nights)),
    noHistory: false, missingHours: references.length - useful.length,
    limited: references.some(value => value.limited),
    unknownCharger2: useful.some(value => value.unknownCharger2), legacy: useful.some(value => value.legacy),
    retrospectiveVoltage: useful.some(value => value.retrospectiveVoltage),
    temperatureRangeC: temperatures.length ? [Math.min(...temperatures), Math.max(...temperatures)] : null,
    oldestAt: Math.min(...useful.map(value => value.oldestAt)), newestAt: Math.max(...useful.map(value => value.newestAt)) };
}
