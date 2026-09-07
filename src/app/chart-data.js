import moment from 'moment-timezone';
import { allInPrice, priceIntervals, validateContract } from '../domain/prices.js';
import { assembleOutlook } from './contract.js';
import { decodeHistoryRow } from '../storage/history.js';

export const CHART_TIME_ZONE = 'Europe/Helsinki';
const HOUR = 3_600_000, DAY = 24 * HOUR;
const TEMPERATURES = ['indoor_temperature', 'garage_temperature', 'outdoor_temperature'];
const PHASES = ['property', 'ev1'].flatMap(prefix => [1, 2, 3].map(phase => `${prefix}_current_l${phase}`));
const BAD = new Set(['missing', 'invalid_numeric', 'invalid_unit', 'invalid_value', 'invalid-value',
  'invalid-payload', 'suspect_zero_indoor', 'implausible_temperature', 'negative_current',
  'implausible_current', 'all_zero_property_current', 'conflicting_duplicate', 'future_source_time',
  'future-source-time', 'unverified-scaling', 'provider_error', 'unknown_legacy_command']);

export function chartRange({ startDate, endDate, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now)) throw new TypeError('now must be UTC milliseconds');
  const today = moment.tz(now, CHART_TIME_ZONE).format('YYYY-MM-DD');
  startDate ??= today; endDate ??= startDate;
  const parse = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError('Chart dates must be YYYY-MM-DD');
    const date = moment.tz(value, 'YYYY-MM-DD', true, CHART_TIME_ZONE);
    if (!date.isValid()) throw new TypeError('Invalid chart calendar date');
    return date;
  };
  const start = parse(startDate), end = parse(endDate).add(1, 'day');
  if (end <= start) throw new RangeError('End date must be on or after start date');
  if (end.diff(start, 'days') > 3660) throw new RangeError('Select at most ten years at a time');
  return { startDate, endDate, from: start.valueOf(), to: end.valueOf(), timeZone: CHART_TIME_ZONE };
}

/** A pixel envelope, not a row limit: every source row contributes. First/last,
 * extrema and both sides of the first missing-data run survive each bucket.
 * Samples occupying separate pixels retain their original timestamps. */
export class Envelope {
  constructor(from, to, points) {
    this.from = from; this.to = to; this.width = (to - from) / points;
    this.buckets = new Map(); this.count = 0;
  }
  add(x, y) {
    if (!Number.isFinite(x) || x < this.from || x > this.to) return;
    const point = { x, y: Number.isFinite(y) ? y : null };
    const index = Math.min(Math.ceil((this.to - this.from) / this.width) - 1, Math.floor((x - this.from) / this.width));
    let bucket = this.buckets.get(index);
    if (!bucket) { bucket = { first: point, last: point, min: null, max: null, missing: null, beforeMissing: null, afterMissing: null }; this.buckets.set(index, bucket); }
    if (point.y === null && !bucket.missing) { bucket.missing = point; bucket.beforeMissing = bucket.last; }
    if (point.y !== null) {
      if (!bucket.min || point.y < bucket.min.y) bucket.min = point;
      if (!bucket.max || point.y > bucket.max.y) bucket.max = point;
      if (bucket.missing && !bucket.afterMissing) bucket.afterMissing = point;
    }
    if (point.x < bucket.first.x) bucket.first = point;
    if (point.x >= bucket.last.x) bucket.last = point;
    this.count++;
  }
  values() {
    const result = [];
    for (const [, bucket] of [...this.buckets].sort((a, b) => a[0] - b[0])) {
      const points = [bucket.first, bucket.min, bucket.max, bucket.beforeMissing, bucket.missing, bucket.afterMissing, bucket.last]
        .filter(Boolean).sort((a, b) => a.x - b.x);
      for (const point of points) {
        const previous = result.at(-1);
        if (previous?.x === point.x) {
          // A missing marker at a source timestamp must not disappear behind an
          // envelope extremum. Stream callers resolve real duplicate readings.
          if (previous.y !== null || point.y === null) result[result.length - 1] = point;
        } else result.push(point);
      }
    }
    return result;
  }
}

class HistoryLine {
  constructor(envelope, gap) { this.envelope = envelope; this.gap = gap; this.previous = null; }
  add(x, y) {
    const previous = this.previous;
    if (previous && x - previous.x > this.gap && x > this.envelope.from) {
      this.envelope.add(Math.max(this.envelope.from, previous.x + 1), null);
      this.envelope.add(x - 1, null);
    }
    if (x >= this.envelope.from && previous?.x < this.envelope.from && x - previous.x <= this.gap)
      this.envelope.add(this.envelope.from, previous.y);
    this.envelope.add(x, y); this.previous = { x, y };
  }
}

function qualityReader() {
  const cache = new Map();
  return encoded => {
    if (cache.has(encoded)) return cache.get(encoded);
    let flags;
    try { flags = JSON.parse(encoded); } catch { flags = ['missing']; }
    if (!Array.isArray(flags)) flags = ['missing'];
    if (cache.size >= 128) cache.delete(cache.keys().next().value);
    cache.set(encoded, flags); return flags;
  };
}

function valueOf(row, flags) {
  if (!Number.isFinite(row.value) || flags.some(flag => BAD.has(flag))) return null;
  if (row.signal.endsWith('_temperature') && !['degC', '°C'].includes(row.unit)) return null;
  if (PHASES.includes(row.signal) && row.unit !== 'A') return null;
  if (row.signal === 'spot_price' && !['c/kWh_ex_vat', 'c/kWh'].includes(row.unit)) return null;
  return row.value;
}

/** Easee reports the latest state of each phase, with independent event clocks.
 * Combine one device/poll, retaining the newest phase's source time for display.
 * Indexed lookups include unchanged phases outside the selected history window;
 * emitting at the last source row preserves stream order with bounded memory. */
function* alignEaseePowerSnapshots(rows, db, now) {
  const snapshot = db.prepare(`SELECT id,source,device,signal,value,unit,source_time,received_at,quality,import_id,row_number
    FROM observations WHERE source='easee' AND import_id IS NULL AND device=? AND received_at=?
    AND signal IN (?,?,?) ORDER BY id`);
  const cache = new Map();
  for (const row of rows) {
    if (row.source !== 'easee' || row.import_id !== null || !PHASES.includes(row.signal)) {
      yield row; continue;
    }
    const prefix = row.signal.startsWith('property_') ? 'property' : 'ev1';
    const key = JSON.stringify([prefix, row.device, row.received_at]);
    let group = cache.get(key);
    if (!group) {
      const phases = new Map(snapshot.all(row.device, row.received_at,
        ...[1, 2, 3].map(phase => `${prefix}_current_l${phase}`)).map(phase => [phase.signal, phase]));
      const values = [...phases.values()];
      const anchor = values.filter(phase => Number.isFinite(phase.source_time) && phase.source_time <= now)
        .sort((a, b) => b.source_time - a.source_time || b.id - a.id)[0];
      group = { rows: values, anchor };
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      cache.set(key, group);
    }
    if (row.id !== group.anchor?.id) continue;
    for (const phase of group.rows) yield { ...phase, source_time: group.anchor.source_time,
      value: Number.isFinite(phase.source_time) && phase.source_time <= now ? phase.value : null, alignedPowerSnapshot: true };
  }
}

class ShadeEnvelope {
  constructor(range, points) { this.range = range; this.points = points; this.rows = []; this.fractions = null; this.lastEnd = -Infinity; }
  raster(start, end) {
    if (end <= start) return;
    const { range, points } = this, width = (range.to - range.from) / points;
    const first = Math.max(0, Math.floor((start - range.from) / width));
    const last = Math.min(points - 1, Math.floor((end - range.from - 1) / width));
    for (let bucket = first; bucket <= last; bucket++) {
      const from = range.from + bucket * width;
      this.fractions[bucket] += (Math.min(end, from + width) - Math.max(start, from)) / width;
    }
  }
  add(start, end) {
    const { range } = this;
    start = Math.max(range.from, start); end = Math.min(range.to, end);
    if (end <= start) return;
    if (this.fractions) this.raster(Math.max(start, this.lastEnd), end);
    else {
      const previous = this.rows.at(-1);
      if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
      else this.rows.push({ start, end });
      if (this.rows.length > this.points * 4) {
        this.fractions = new Float64Array(this.points);
        for (const row of this.rows) this.raster(row.start, row.end);
        this.rows = [];
      }
    }
    this.lastEnd = Math.max(this.lastEnd, end);
  }
  values() {
    if (!this.fractions) return this.rows;
    const { range, points } = this, width = (range.to - range.from) / points;
    return Array.from(this.fractions, (fraction, index) => ({ start: range.from + index * width,
      end: range.from + (index + 1) * width, fraction: Math.min(1, fraction), aggregated: true })).filter(row => row.fraction > 0);
  }
}

function knownIntervals(market, store, range, now) {
  // Stored market snapshots preserve historical intervals after the rolling
  // provider cache has moved on. Last fetched revision wins for each boundary.
  const rows = new Map();
  const accept = (snapshot, fetchedAt) => {
    if (!Number.isFinite(fetchedAt) || fetchedAt > now || !Array.isArray(snapshot?.intervals)) return;
    for (const interval of snapshot.intervals) {
      if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end) || interval.end <= interval.start
        || interval.end - interval.start > 25 * HOUR
        || interval.end <= range.from || interval.start >= range.to || !Number.isFinite(interval.spotCtPerKwh)
        || interval.unit !== 'c/kWh' || interval.vatIncluded !== false) continue;
      const key = `${interval.start}:${interval.end}`;
      if ((rows.get(key)?.fetchedAt ?? -Infinity) <= fetchedAt) rows.set(key, {
        start: interval.start, end: interval.end, spotCtPerKwh: interval.spotCtPerKwh,
        unit: 'c/kWh', vatIncluded: false, source: interval.source, fetchedAt });
    }
  };
  // Acquisition currently requests 48 hours; seven days also covers the adapter's
  // maximum accepted horizon. Future fetched revisions cannot rewrite this view.
  for (const row of store.db.prepare(`SELECT payload,fetched_at FROM provider_snapshots
    WHERE kind='market' AND fetched_at>=? AND fetched_at<=? ORDER BY fetched_at,id`)
    .iterate(range.from - 7 * DAY, Math.min(now, range.to + 7 * DAY))) {
    try { accept(JSON.parse(row.payload), row.fetched_at); } catch { /* Reject corrupt snapshots independently. */ }
  }
  if (market && now >= market.fetchedAt && now - market.fetchedAt <= 36 * HOUR) accept(market, market.fetchedAt);
  // Resolve differently partitioned revisions (hourly versus quarter-hourly)
  // using boundary segments, avoiding overlapping chart prices.
  const candidates = [...rows.values()].sort((a, b) => a.start - b.start || b.fetchedAt - a.fetchedAt);
  const events = new Map();
  candidates.forEach((row, id) => {
    for (const [at, direction] of [[Math.max(range.from, row.start), 1], [Math.min(range.to, row.end), -1]]) {
      if (!events.has(at)) events.set(at, []);
      events.get(at).push({ id, direction });
    }
  });
  const active = new Set(), result = []; let previous = null;
  for (const [at, changes] of [...events].sort((a, b) => a[0] - b[0])) {
    if (previous !== null && at > previous && active.size) {
      let newest;
      for (const id of active) if (!newest || candidates[id].fetchedAt >= newest.fetchedAt) newest = candidates[id];
      result.push({ ...newest, start: previous, end: at });
    }
    for (const change of changes) change.direction > 0 ? active.add(change.id) : active.delete(change.id);
    previous = at;
  }
  return result;
}

function intervalPoints(intervals, key, envelope) {
  let previous = null;
  for (const interval of intervals) {
    const start = Math.max(envelope.from, interval.start), end = Math.min(envelope.to, interval.end);
    if (end <= start || !Number.isFinite(interval[key])) continue;
    if (previous && start > previous) { envelope.add(previous, null); envelope.add(start - 1, null); }
    envelope.add(start, interval[key]);
    envelope.add(end - 1, interval[key]);
    previous = end;
  }
}

function* mergedHistoryRows(store, nativeRows, from, to, requested) {
  // Imports retain the exact original row. Reading it once is considerably
  // cheaper than materializing five/six expanded SQLite records across the JS
  // boundary. Reuse the importer decoder so missing values and quality agree.
  function* imported() {
    const query = store.db.prepare(`SELECT r.raw,r.source_time,r.row_number,i.id,i.kind,i.started_at
      FROM import_rows r JOIN imports i ON i.id=r.import_id
      WHERE i.status='complete' AND i.kind IN (${requested.has('property_current_l1') ? "'stmq','easee'" : "'stmq'"}) AND r.source_time>=? AND r.source_time<?
      ORDER BY r.source_time,i.id,r.row_number`);
    for (const original of query.iterate(from, to)) {
      yield { ...original, imported: true };
    }
  }
  const imports = imported(), native = nativeRows[Symbol.iterator]();
  let a = imports.next(), b = native.next();
  while (!a.done || !b.done) {
    if (!a.done && (b.done || a.value.source_time <= b.value.source_time)) { yield a.value; a = imports.next(); }
    else { yield b.value; b = native.next(); }
  }
}

/** Combined chart query. This deliberately never calls providers, reads options,
 * writes history, or turns phase-current estimates into electricity metering. */
export function getChartData({ store, input = 'offline', contract = null, market = null, weather = null,
  simulated = null, now = Date.now(), startDate, endDate, left = 'power', points = 800 }) {
  const started = performance.now();
  const range = chartRange({ startDate, endDate, now });
  if (!['power', 'phases', 'integral'].includes(left)) throw new TypeError('Unknown left axis');
  if (!Number.isInteger(points) || points < 100 || points > 2000) throw new RangeError('Chart points must be 100–2000');
  if (!['simulated', 'providers', 'mqtt', 'offline'].includes(input)) throw new TypeError('Unknown chart input');
  let rates = null;
  if (contract) { rates = validateContract(contract); if (rates.mode !== 'billing') throw new TypeError('Historical charts require dated billing rates'); }
  const names = [...TEMPERATURES, 'outdoor_forecast', 'all_in_price', 'spot_price',
    ...(left === 'power' ? ['property_power', 'charger_power'] : left === 'phases' ? PHASES : ['heating_integral'])];
  const envelopes = Object.fromEntries(names.map(name => [name, new Envelope(range.from, range.to, points)]));
  const lines = Object.fromEntries(names.map(name => [name, new HistoryLine(envelopes[name], /power|current|integral/.test(name) ? 30 * 60_000 : 3 * HOUR)]));
  const shading = Object.fromEntries(['heatOff', 'auxHeat', 'dhwr'].map(key => [key, new ShadeEnvelope(range, points)])), warnings = [];
  const requested = new Set([...TEMPERATURES, 'spot_price', 'requested_heat_mode', 'auxiliary_output',
    ...(left === 'integral' ? ['heating_integral'] : PHASES)]);
  const compactImports = input !== 'simulated' && range.to - range.from > 7 * DAY;
  const columns = `o.id,o.source,o.device,o.signal,o.value,o.unit,o.source_time,o.received_at,
    o.quality,o.import_id,o.row_number,CASE WHEN o.signal='auxiliary_output' THEN o.raw END AS raw`;
  const sourceScope = input === 'simulated' ? "o.source='simulation'" : "o.source<>'simulation'";
  const query = store.db.prepare(`SELECT ${columns}
    FROM observations o INDEXED BY observations_time LEFT JOIN imports i ON i.id=o.import_id
    WHERE o.source_time>=? AND o.source_time<? AND o.signal IN (${[...requested].map(() => '?').join(',')})
    AND ${sourceScope}
    ${compactImports ? 'AND o.import_id IS NULL' : ''}
    AND (o.import_id IS NULL OR i.status='complete') ORDER BY o.source_time,o.id`);
  const flagsOf = qualityReader(); let rawRows = 0, invalidRows = 0, latestOutdoor = null;
  const priceBases = new Map();
  const historicalTotal = (at, value) => {
    const period = rates.periods.find(period => period.from <= at && at < period.to);
    if (!period) return null;
    const key = `${Math.floor(at / HOUR)}:${period.from}`;
    let base = priceBases.get(key);
    if (base === undefined) {
      base = allInPrice(at, 0, contract).totalCtPerKwh;
      if (priceBases.size >= 4096) priceBases.delete(priceBases.keys().next().value);
      priceBases.set(key, base);
    }
    return base + value * (1 + period.vatRate);
  };
  let time = null, atRows = new Map(), phases = new Map();
  let previousHeat = null, previousAux = null;
  const rememberScalar = (row, value) => {
    const previous = atRows.get(row.signal)?.row;
    if (previous) {
      const native = row.import_id == null, previousNative = previous.import_id == null;
      // The short query orders expanded observations by insertion ID; the
      // compact query merges original imports before native readings. Resolve
      // precedence explicitly so selecting more days cannot change a value.
      if (previousNative && !native) return;
      if (native === previousNative) {
        if (native && previous.id > row.id) return;
        if (!native && (previous.import_id > row.import_id
          || previous.import_id === row.import_id && previous.row_number > row.row_number)) return;
      }
    }
    atRows.set(row.signal, { row, value });
  };
  const addState = (row, value, kind) => {
    const previous = kind === 'heat' ? previousHeat : previousAux;
    const gap = kind === 'heat' ? 30 * 60_000 : 5 * 60_000;
    if (previous) {
      const until = Math.min(row.source_time, previous.at + gap);
      if (kind === 'heat' && previous.value === 0) shading.heatOff.add(previous.at, until);
      if (kind === 'aux' && previous.value > 0) shading.auxHeat.add(previous.at, until);
      if (kind === 'heat' && previous.value === 60) shading.dhwr.add(previous.at, Math.min(row.source_time, previous.at + 600_000));
    }
    if (kind === 'heat') previousHeat = { at: row.source_time, value };
    else previousAux = { at: row.source_time, value };
  };
  const flushTime = () => {
    for (const { row, value } of atRows.values()) {
      const signal = row.signal;
      if (signal === 'requested_heat_mode') addState(row, value, 'heat');
      else if (signal === 'auxiliary_output') {
        let verified = false;
        try { const raw = JSON.parse(row.raw); verified = Boolean(raw?.verified) && raw?.usableForControl !== false; } catch { /* Unknown installed scaling. */ }
        addState(row, verified && (row.source === 'husdata-h66' || input === 'simulated' && row.source === 'simulation') ? value : null, 'aux');
      } else {
        lines[signal]?.add(time, value);
        if (signal === 'outdoor_temperature' && value !== null) latestOutdoor = time;
        if (signal === 'spot_price' && rates) {
          let total = null;
          if (value !== null) {
            total = historicalTotal(time, value);
          }
          lines.all_in_price.add(time, total);
        }
      }
    }
    if (left === 'power') {
      const candidates = new Map();
      for (const group of phases.values()) {
        const complete = group.values.every(value => Number.isFinite(value));
        const previous = candidates.get(group.prefix);
        // A newer invalid poll must break the line even when an older complete
        // poll has the same last-change timestamp. Native data precedes imports.
        if (!previous || group.priority > previous.priority
          || group.priority === previous.priority && group.id > previous.id)
          candidates.set(group.prefix, { ...group, complete });
      }
      for (const [prefix, group] of candidates) lines[prefix === 'property' ? 'property_power' : 'charger_power']
        .add(time, group.complete ? group.values.reduce((sum, value) => sum + value, 0) * 0.23 : null);
    }
    atRows = new Map(); phases = new Map();
  };
  const nativeRows = query.iterate(range.from - 3 * HOUR, Math.min(range.to, now + 1), ...requested);
  const historyRows = compactImports ? mergedHistoryRows(store, nativeRows, range.from - 3 * HOUR, Math.min(range.to, now + 1), requested) : nativeRows;
  function* rowsWithPreviousReadings() {
    if (range.from <= now && now < range.to) {
      // A sensor can stay unchanged for days. Seed live plots with its latest
      // prior reading, including invalid readings so they cannot revive old data.
      // Indexed lookups avoid expanding the selected history scan indefinitely.
      const signals = [...TEMPERATURES, ...(left === 'integral' ? ['heating_integral'] : PHASES)];
      const latest = store.db.prepare(`SELECT o.source_time FROM observations o INDEXED BY observations_signal_time
        LEFT JOIN imports i ON i.id=o.import_id WHERE o.signal=? AND o.source_time<?
        AND ${sourceScope} AND (o.import_id IS NULL OR i.status='complete')
        ORDER BY o.source_time DESC,o.id DESC LIMIT 1`);
      const times = new Set(signals.map(signal => latest.get(signal, range.from - 3 * HOUR)?.source_time).filter(Number.isFinite));
      const seeds = store.db.prepare(`SELECT ${columns} FROM observations o INDEXED BY observations_time
        LEFT JOIN imports i ON i.id=o.import_id WHERE o.source_time=?
        AND o.signal IN (${signals.map(() => '?').join(',')}) AND ${sourceScope}
        AND (o.import_id IS NULL OR i.status='complete') ORDER BY o.id`);
      // Keep complete acquisition cohorts and normal duplicate/source precedence.
      for (const at of [...times].sort((a, b) => a - b)) yield* seeds.iterate(at, ...signals);
    }
    yield* historyRows;
  }
  const rows = rowsWithPreviousReadings();
  for (const row of left === 'power' ? alignEaseePowerSnapshots(rows, store.db, now) : rows) {
    if (row.imported) {
      if (time !== null && time !== row.source_time) flushTime();
      time = row.source_time;
      const decoded = decodeHistoryRow(row.kind, row.raw);
      if (row.kind === 'easee' && left === 'power') {
        // The original row is already the exact six-phase acquisition cohort.
        // Aggregate it without manufacturing six intermediate SQLite-shaped rows.
        for (const [prefix, offset] of [['ev1', 0], ['property', 3]]) {
          const values = decoded.observations.slice(offset, offset + 3).map(observation => {
            rawRows++;
            const value = valueOf(observation, observation.quality);
            if (value === null) invalidRows++;
            return observation.quality.includes('ev_exceeds_property_current') ? null : value;
          });
          const id = row.id * 1_000_000_000 + row.row_number * 10;
          phases.set(`${prefix}:csv:${row.id}:${row.row_number}`, { prefix, id, values, priority: 0 });
        }
      } else for (const observation of decoded.observations) {
        if (!requested.has(observation.signal)) continue;
        rawRows++;
        const value = valueOf(observation, observation.quality);
        if (value === null) invalidRows++;
        rememberScalar({ ...observation, source_time: time, source: `csv:${row.kind}`,
          import_id: row.id, row_number: row.row_number }, value);
      }
      continue;
    }
    rawRows++;
    if (time !== null && time !== row.source_time) flushTime();
    time = row.source_time;
    const flags = row.flags ?? flagsOf(row.quality), value = valueOf(row, flags);
    if (value === null) invalidRows++;
    if (left === 'power' && PHASES.includes(row.signal)) {
      const prefix = row.signal.startsWith('property') ? 'property' : 'ev1';
      // Same original CSV row, or the last-reported states from one device poll.
      // Easee phases retain independent source timestamps in the phase view.
      const key = `${prefix}:${row.source}:${row.device}:${row.import_id ?? ''}:${row.row_number ?? row.received_at}`;
      let group = phases.get(key);
      if (!group) { group = { prefix, id: row.id, values: [null, null, null], priority: row.import_id === null ? 1 : 0 }; phases.set(key, group); }
      group.values[Number(row.signal.at(-1)) - 1] = !row.alignedPowerSnapshot && flags.includes('asynchronous_snapshot')
        || flags.includes('ev_exceeds_property_current') ? null : value;
      group.id = row.id;
    } else rememberScalar(row, value);
  }
  if (time !== null) flushTime();
  // A last command is only a bounded request; it is not indefinite confirmation.
  if (previousHeat) addState({ source_time: Math.min(now, range.to) }, null, 'heat');
  if (previousAux) addState({ source_time: Math.min(now, range.to) }, null, 'aux');

  if (input === 'simulated') {
    intervalPoints(simulated?.prices ?? [], 'allInCentsPerKWh', envelopes.all_in_price);
    intervalPoints((simulated?.forecast ?? []).map(row => ({ ...row, start: Math.max(row.start, now, latestOutdoor ?? now) })), 'outdoorC', envelopes.outdoor_forecast);
    warnings.push('Simulation: temperatures and outlook are fictional.');
  } else {
    const intervals = knownIntervals(market, store, range, now);
    // Provider intervals take precedence over old scalar CSV prices wherever
    // covered, without falsely extending an isolated historical measurement.
    const replaceCovered = name => {
      if (!intervals.length) return;
      const previous = envelopes[name].values();
      envelopes[name] = new Envelope(range.from, range.to, points);
      let index = 0;
      for (const point of previous) {
        while (index < intervals.length && intervals[index].end <= point.x) index++;
        if (!intervals[index] || point.x < intervals[index].start) envelopes[name].add(point.x, point.y);
      }
    };
    replaceCovered('spot_price'); replaceCovered('all_in_price');
    intervalPoints(intervals, 'spotCtPerKwh', envelopes.spot_price);
    if (rates) {
      const priced = [];
      for (const interval of intervals) for (const period of rates.periods) {
        const start = Math.max(interval.start, period.from), end = Math.min(interval.end, period.to);
        if (end > start) priced.push(...priceIntervals([{ ...interval, start, end }], contract));
      }
      intervalPoints(priced, 'totalCtPerKwh', envelopes.all_in_price);
    } else warnings.push('All-in price needs contract rates covering the selected dates; spot remains a separate series.');
    const outlook = assembleOutlook(null, weather, null, now);
    intervalPoints(outlook.forecast.map(row => ({ ...row, start: Math.max(row.start, now, latestOutdoor ?? now) })), 'outdoorC', envelopes.outdoor_forecast);
    if (rates && !envelopes.all_in_price.values().some(point => point.y !== null))
      warnings.push('No all-in price is available for these dates: market data and dated contract coverage are both required.');
  }
  const series = Object.fromEntries(Object.entries(envelopes).map(([name, envelope]) => [name, envelope.values()]));
  for (const key of Object.keys(shading)) shading[key] = shading[key].values();
  if (Object.values(shading).some(rows => rows.some(row => row.aggregated))) warnings.push('Dense shading shows the occupied fraction of each display interval.');
  // These are original source timestamps, even when outside the visible range.
  // Only the browser draws carry-forward tails; no synthetic readings are stored.
  const lastReadings = Object.fromEntries([...TEMPERATURES,
    ...(left === 'power' ? ['property_power', 'charger_power'] : left === 'phases' ? PHASES : ['heating_integral'])]
    .filter(name => lines[name].previous).map(name => [name, { ...lines[name].previous }]));
  return { range, now, input, left, series, shading, meta: { warnings, rawRows, invalidRows, lastReadings,
    returnedPoints: Object.values(series).reduce((sum, rows) => sum + rows.length, 0),
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    powerEstimate: left === 'power' ? '230 V × sum of three last-reported phase currents from one device acquisition; estimated kW, not metered power or energy.' : null,
    heatOffBasis: 'Historical requested reduction, not compressor activity.',
    auxHeatBasis: 'Verified timestamped auxiliary output only; dated counters cannot identify episodes.',
    dhwrBasis: 'Historical ten-minute pulse requests, not verified pump feedback.',
    decimation: 'Per time bucket: first, last, minimum, maximum and missing-data breaks; all source rows scanned.' } };
}
