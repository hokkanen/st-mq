import moment from 'moment-timezone';
import { TIME_ZONE } from '../domain/prices.js';
import { decodeHistoryRow } from '../storage/history.js';
import { HouseholdReference, HOUR, DAY, summarizeHousehold, predictHousehold } from './history-reference.js';
import { pendingEnergyObservations } from '../storage/pending-energy.js';
import { recordedEnergyGroups } from '../storage/energy-history.js';
import { createVoltageReader, VOLTAGE_SIGNALS } from '../storage/voltage.js';

const SIGNALS = ['property_energy_l1', 'property_energy_l2', 'property_energy_l3',
  'ev1_energy_l1', 'ev1_energy_l2', 'ev1_energy_l3', 'ev2_energy', 'ev2_energy_l1', 'ev2_energy_l2', 'ev2_energy_l3'];
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
      if (values.slice(0, 6).every(finite) && values[6] !== null) {
        // A total meter does not reveal which phase carried the load. Native
        // zero proves all phases idle; otherwise use the recorded phase shares
        // only when all three are known, conserving the authoritative total.
        const phaseTotal = values.slice(7).every(finite) ? values.slice(7).reduce((sum, value) => sum + value, 0) : null;
        const knownPeer = values[6] === 0 || finite(values[6]) && phaseTotal > 0;
        const peer = values.slice(7).map(value => values[6] === 0 ? 0 : knownPeer ? values[6] * value / phaseTotal : 0);
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

/** Read original imported CSV once, using the same decoder and precedence as
 * history charts. This does not reconstruct energy counters or rewrite imports:
 * bounded adjacent current snapshots provide an explicitly estimated profile. */
function buildLegacy(store, reference, now, voltageV, { from = 0, to = now, onSpans, input = 'live' } = {}) {
  const query = store.db.prepare(`SELECT r.raw,r.quality,r.source_time,r.row_number,i.id,i.kind
    FROM import_rows r JOIN imports i ON i.id=r.import_id
    WHERE i.status='complete' AND i.kind IN ('easee','stmq') AND r.source_time>=? AND r.source_time<=?
    ORDER BY r.source_time,i.id,r.row_number`);
  let previous = null, pendingTime = null, easee = null, outside = null, day = null, spans = [];
  const temperatures = [];
  const firstPeer = store.db.prepare(`SELECT min(json_extract(raw,'$.intervalStart')) AS at FROM observations
    WHERE signal='ev2_energy' AND import_id IS NULL AND ${nativeScope('live')}`).get().at;
  const peerRows = store.db.prepare(`SELECT id,signal,value,unit,raw,quality FROM observations
    WHERE signal IN ('ev2_energy','ev2_energy_l1','ev2_energy_l2','ev2_energy_l3') AND source_time>? AND source_time<=? AND received_at<=? AND import_id IS NULL
      AND json_valid(raw) AND json_extract(raw,'$.intervalStart')<?
      AND ${nativeScope('live')} ORDER BY source_time,id`);
  const flushDay = () => {
    if (spans.length) {
      let resolved = importedVoltage(spans, store, input, now);
      if (finite(firstPeer) && spans.at(-1).end >= firstPeer) {
        const peers = peerRows.all(spans[0].start, now, now, spans.at(-1).end);
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
function nextSourceAt(store, now, input) {
  return store.db.prepare(`SELECT min(max(source_time,received_at)) AS at FROM observations
    WHERE signal IN (${[...SIGNALS, ...VOLTAGE_SIGNALS, 'outdoor_temperature'].map(() => '?').join(',')})
      AND max(source_time,received_at)>? AND import_id IS NULL AND ${nativeScope(input)}`)
    .get(...SIGNALS, ...VOLTAGE_SIGNALS, 'outdoor_temperature', now).at;
}
function modernRows(store, { from, to, now, input }) {
  const rows = [];
  for (const group of recordedEnergyGroups(store, { from, to, now, input: input === 'simulated' ? input : 'providers' })) {
    if (!['property','ev1','ev2','ev2-phase'].includes(group.prefix)) continue;
    const prefix = group.prefix === 'ev2-phase' ? 'ev2' : group.prefix;
    group.values.forEach((value,index) => rows.push({ id: group.observationIds[index] ?? 0,
      signal: group.prefix === 'ev2' ? 'ev2_energy' : `${prefix}_energy_l${index+1}`,
      value: group.conflict ? null : value, unit: 'kWh', quality: [], source_time: group.end,
      raw: { intervalStart: group.start, intervalEnd: group.end } }));
  }
  return rows;
}
function modernTemperatures(store, { from, to, now, input }) {
  return store.db.prepare(`SELECT id,value,quality,source_time,unit FROM observations
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

function updateModern(store, reference, { from, to, now, input, voltageV }) {
  // Process one week at a time. Neither a years-long history nor expanded
  // imported observations is ever materialized as one JavaScript row array.
  for (let start = from; start < to;) {
    const end = Math.min(to, moment.tz(start, reference.timezone).add(7, 'days').valueOf());
    const rows = modernRows(store, { from: start, to: end, now, input });
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
    const overlappingImport = [...nativeHours].some(key => reference.legacyHours.has(key));
    reference.removeLegacyHours(nativeHours);
    let spans = householdSpans(rows, { voltageV }).map(span => ({ ...span, start: Math.max(span.start, start), end: Math.min(span.end, end) }))
      .filter(span => span.end > span.start);
    spans = temperaturesFor(spans, modernTemperatures(store, { from: start, to: end, now, input }));
    if (overlappingImport && input !== 'simulated') {
      // Where modern and imported history overlap, replace only the genuinely
      // covered interval. A short native fragment must not erase the rest of a
      // useful original night, nor cover an explicit modern recording gap.
      const imported = [];
      buildLegacy(store, reference, now, voltageV, { from: start, to: end, onSpans: values => imported.push(...values) });
      spans.push(...uncoveredSpans(imported, covered).filter(span => {
        const local = moment.tz(span.start, reference.timezone);
        return nativeHours.has(`${local.format('YYYY-MM-DD')}:${local.hour()}`);
      }));
      spans.sort((a, b) => a.start - b.start);
    }
    addEntries(reference, spans, 1, voltageV);
    start = end;
  }
}

/** Cache only compact per-night/hour load distributions. A complete-import
 * signature rebuilds original CSV references; later observations refresh only
 * their affected dates. This separate forecast index never changes thermal
 * learning journals or their versioned replay. */
export function householdReference(store, { now, input = 'live', voltageV, timezone = TIME_ZONE }) {
  if (!store?.db) return new HouseholdReference({ timezone });
  const imports = input === 'simulated' ? '' : JSON.stringify(store.db.prepare("SELECT id,row_count,completed_at FROM imports WHERE status='complete' AND kind IN ('stmq','easee') ORDER BY id").all());
  // Only first-mature fallback publication changes pre-estimate CSV meaning.
  // Ordinary later estimates must not repeatedly reinterpret that archive.
  const csvVoltageKey = input === 'simulated' ? '' : JSON.stringify(createVoltageReader(store, { input, now })(0, { allowFuture: true }));
  const voltageAvailable = voltages(voltageV).every(value => finite(value) && value >= 200 && value <= 250);
  const key = JSON.stringify([input, timezone]);
  const pendingRows = pendingEnergyObservations(store, { now, input: input === 'simulated' ? input : 'providers' })
    .filter(row => SIGNALS.includes(row.signal));
  const pendingKey = JSON.stringify(pendingRows);
  let cache = cacheByDb.get(store.db);
  const watermark = store.db.prepare('SELECT max(id) AS id FROM observations').get().id ?? 0;
  if (!cache || cache.key !== key || cache.imports !== imports || cache.csvVoltageKey !== csvVoltageKey || now < cache.now) {
    const reference = new HouseholdReference({ timezone });
    if (input !== 'simulated') buildLegacy(store, reference, now, voltageV);
    const firstSaved = store.db.prepare(`SELECT min(json_extract(raw,'$.intervalStart')) AS at FROM observations
      WHERE signal IN (${SIGNALS.map(() => '?').join(',')}) AND json_valid(raw) AND import_id IS NULL AND ${nativeScope(input)}`).get(...SIGNALS).at;
    const first = Math.min(firstSaved ?? Infinity, ...pendingRows.map(row => parse(row.raw, {}).intervalStart));
    if (voltageAvailable && finite(first) && first <= now) updateModern(store, reference, { from: moment.tz(first - DAY, timezone).startOf('day').valueOf(), to: now, now, input, voltageV });
    cache = { key, imports, csvVoltageKey, reference, watermark, now, pendingKey, pendingRows, voltageReady: voltageAvailable, nextSourceAt: nextSourceAt(store, now, input) };
    cacheByDb.set(store.db, cache);
    return reference;
  }
  if (!voltageAvailable) return cache.reference;
  if (!cache.voltageReady) {
    // Original ampere snapshots are useful before the first voltage report.
    // When voltage arrives, add energy-derived records to the same index;
    // never decode the entire legacy archive a second time at startup.
    const importedDates = new Set([...cache.reference.legacyHours].map(key => key.slice(0, 10))), peerDates = new Set();
    if (input !== 'simulated' && importedDates.size) for (const row of store.db.prepare(`SELECT source_time,raw FROM observations
      WHERE signal='ev2_energy' AND source_time<=? AND import_id IS NULL AND ${nativeScope(input)}`).iterate(now)) {
      const raw = parse(row.raw, {});
      if (!finite(raw.intervalStart) || !finite(raw.intervalEnd) || raw.intervalEnd <= raw.intervalStart) continue;
      for (let at = moment.tz(raw.intervalStart, timezone).startOf('day'); at.valueOf() < raw.intervalEnd; at.add(1, 'day'))
        if (importedDates.has(at.format('YYYY-MM-DD'))) peerDates.add(at.format('YYYY-MM-DD'));
    }
    for (const date of peerDates) {
      const from = moment.tz(date, timezone).startOf('day'), to = from.clone().add(1, 'day').valueOf();
      cache.reference.removeDates(new Set([date]), 0);
      buildLegacy(store, cache.reference, now, voltageV, { from: from.valueOf(), to });
    }
    const firstSaved = store.db.prepare(`SELECT min(json_extract(raw,'$.intervalStart')) AS at FROM observations
      WHERE signal IN (${SIGNALS.map(() => '?').join(',')}) AND json_valid(raw) AND import_id IS NULL AND ${nativeScope(input)}`).get(...SIGNALS).at;
    const first = Math.min(firstSaved ?? Infinity, ...pendingRows.map(row => parse(row.raw, {}).intervalStart));
    if (finite(first) && first <= now) updateModern(store, cache.reference,
      { from: moment.tz(first - DAY, timezone).startOf('day').valueOf(), to: now, now, input, voltageV });
    cache.voltageReady = true; cache.watermark = watermark; cache.now = now; cache.pendingKey = pendingKey; cache.pendingRows = pendingRows;
    cache.nextSourceAt = nextSourceAt(store, now, input);
    return cache.reference;
  }
  if (watermark > cache.watermark || pendingKey !== cache.pendingKey || finite(cache.nextSourceAt) && cache.nextSourceAt <= now) {
    const changed = store.db.prepare(`SELECT source_time,raw,signal FROM observations WHERE id>? AND id<=?
      AND signal IN (${[...SIGNALS, ...VOLTAGE_SIGNALS, 'outdoor_temperature'].map(() => '?').join(',')})
      AND import_id IS NULL AND ${nativeScope(input)}`).all(cache.watermark, watermark, ...SIGNALS, ...VOLTAGE_SIGNALS, 'outdoor_temperature');
    if (pendingKey !== cache.pendingKey) changed.push(...cache.pendingRows, ...pendingRows);
    if (finite(cache.nextSourceAt) && cache.nextSourceAt <= now) changed.push(...store.db.prepare(`SELECT source_time,raw,signal
      FROM observations WHERE max(source_time,received_at)>? AND max(source_time,received_at)<=?
        AND signal IN (${[...SIGNALS, ...VOLTAGE_SIGNALS, 'outdoor_temperature'].map(() => '?').join(',')})
        AND import_id IS NULL AND ${nativeScope(input)}`).all(cache.now, now, ...SIGNALS, ...VOLTAGE_SIGNALS, 'outdoor_temperature'));
    const dates = new Map(), changedPeerDates = new Set();
    for (const row of changed) {
      if (!finite(row.source_time) || row.source_time > now) continue;
      const raw = parse(row.raw, {}), start = Math.min(row.source_time, raw.intervalStart ?? row.source_time);
      const affectedUntil = Math.min(now, row.source_time + (row.signal === 'outdoor_temperature' ? 9 * HOUR : 0));
      for (let at = moment.tz(start, timezone).startOf('day'); at.valueOf() <= affectedUntil;) {
        const date = at.format('YYYY-MM-DD');
        dates.set(date, [at.valueOf(), at.clone().add(1, 'day').valueOf()]);
        if (row.signal.startsWith('ev2_energy') || VOLTAGE_SIGNALS.includes(row.signal)) changedPeerDates.add(date);
        at.add(1, 'day');
      }
    }
    cache.reference.removeDates(new Set(dates.keys()), 1);
    const importedDates = new Set([...cache.reference.legacyHours].map(key => key.slice(0, 10)));
    for (const date of changedPeerDates) if (importedDates.has(date)) {
      const [from, to] = dates.get(date);
      cache.reference.removeDates(new Set([date]), 0);
      buildLegacy(store, cache.reference, now, voltageV, { from, to });
    }
    for (const [from, to] of dates.values()) updateModern(store, cache.reference, { from, to, now, input, voltageV });
    cache.watermark = watermark;
    cache.pendingKey = pendingKey; cache.pendingRows = pendingRows;
    cache.nextSourceAt = nextSourceAt(store, now, input);
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
