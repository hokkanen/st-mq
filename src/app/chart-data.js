import moment from 'moment-timezone';
import { validateContract } from '../domain/prices.js';
import { assembleOutlook } from './contract.js';
import { historicalSolar } from './chart-weather.js';
import { createHistoricalPricing } from './chart-prices.js';
import { historicalSpotIntervals } from './historical-spot-prices.js';
import { decodeHistoryRow } from '../storage/history.js';
import { auxiliaryPowerFromOutput } from '../domain/telemetry.js';
import { timingEvidenceSource, timingPowerEvidence } from './timing-evidence.js';
import { HISTORY_AXIS_BY_KEY, ENERGY_SIGNALS, AUDIT_SIGNALS, SESSION_CHECK_INFO, MODEL_INPUT_INFO, MODEL_COEFFICIENT_INFO } from '../domain/history-series.js';
import { addChargingSessionChecks } from './chart-session-checks.js';
import { addModelInputs } from './chart-model-inputs.js';
import { addModelCoefficients } from './chart-model-coefficients.js';
import { addFireplaceInputs, addFirewoodOutcomes, FIREPLACE_INPUT_NAMES, FIREWOOD_OUTCOME_NAMES } from './chart-fireplace.js';
import { getFirewoodBenefit } from './firewood-benefit.js';
import { forecastIntervals } from '../control/planner.js';
import { addRecordedEnergy, recordedEnergyStart } from './chart-energy.js';
import { mergeCoverageRows } from './chart-coverage.js';
import { addHistoricalHeatPump } from './chart-heat-pump.js';
import { getHeatingBenefit } from './chart-heating-benefit.js';
import { RelatedStepSampler, alignRelatedSamples } from './chart-related-series.js';

export const CHART_TIME_ZONE = 'Europe/Helsinki';
const HOUR = 3_600_000, DAY = 24 * HOUR;
const CHARGING_MIN_POWER_KW = 0.1;
const TEMPERATURES = ['indoor_temperature', 'garage_temperature', 'outdoor_temperature'];
const PHASES = ['property', 'ev1'].flatMap(prefix => [1, 2, 3].map(phase => `${prefix}_current_l${phase}`));
const LEARNING = ['learning_profit', 'learning_aux_profit', 'learning_recovery_error', 'learning_indoor_temperature'];
const H66_SIGNALS = ['auxiliary_power', 'charger_power', 'compressor_active', 'dhw_routing', 'operating_mode', 'controller_phase', 'dhwr_request'];
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

/** Calendar selection is immutable while a detail request changes only the
 * queried viewport. Context reads may precede it; returned points remain bounded. */
export function chartRequestRange({ viewFrom, viewTo, ...args } = {}) {
  const selection = chartRange(args), detail = viewFrom !== undefined || viewTo !== undefined;
  if (!detail) return { selection, range: selection, detail: false };
  if (!Number.isSafeInteger(viewFrom) || !Number.isSafeInteger(viewTo))
    throw new TypeError('Both chart viewport bounds must be UTC milliseconds');
  if (viewFrom < selection.from || viewTo > selection.to || viewTo <= viewFrom)
    throw new RangeError('Chart viewport must remain within the selected dates');
  return { selection, range: { ...selection, from: viewFrom, to: viewTo }, detail: true };
}

/** A pixel envelope, not a row limit: every source row contributes. First/last,
 * extrema and both sides of the first missing-data run survive each bucket.
 * Samples occupying separate pixels retain their original timestamps. */
export class Envelope {
  constructor(from, to, points) {
    this.from = from; this.to = to; this.width = (to - from) / points;
    this.buckets = new Map(); this.count = 0;
  }
  add(x, y, metadata) {
    if (!Number.isFinite(x) || x < this.from || x > this.to) return;
    const point = { ...metadata, x, y: Number.isFinite(y) ? y : null };
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
  constructor(envelope, gap, boundedHold = false, clipEdges = false, stepped = false) {
    this.envelope = envelope; this.gap = gap; this.previous = null;
    this.boundedHold = boundedHold; this.clipEdges = clipEdges; this.stepped = stepped;
  }
  add(x, y, metadata) {
    const previous = this.previous;
    if (previous && x - previous.x > this.gap && x > this.envelope.from) {
      if (this.boundedHold) {
        const expires = previous.x + this.gap;
        if (this.clipEdges) {
          const held = { ...previous, displayBoundary: true, observedAt: previous.x, interpolated: false };
          for (const boundary of [this.envelope.from, this.envelope.to])
            if (boundary > previous.x && boundary <= expires) this.envelope.add(boundary, previous.y, held);
          this.envelope.add(expires, previous.y, held);
        } else this.envelope.add(Math.max(this.envelope.from, expires), previous.y, previous);
      }
      this.envelope.add(Math.max(this.envelope.from, previous.x + (this.boundedHold ? this.gap : 0) + 1), null);
      this.envelope.add(x - 1, null);
    }
    if (this.clipEdges && previous && x - previous.x <= this.gap) {
      // A viewport between recorded samples still shows the same connecting
      // segment. These clipped display points never masquerade as observations.
      for (const boundary of [this.envelope.from, this.envelope.to]) {
        if (previous.x >= boundary || x <= boundary) continue;
        const value = Number.isFinite(previous.y) && Number.isFinite(y)
          ? this.stepped ? previous.y : previous.y + (y - previous.y) * (boundary - previous.x) / (x - previous.x) : null;
        this.envelope.add(boundary, value, { ...previous, displayBoundary: true,
          observedAt: previous.x, nextObservedAt: x, interpolated: !this.stepped });
      }
    } else if (!this.clipEdges && x >= this.envelope.from && previous?.x < this.envelope.from && x - previous.x <= this.gap)
      this.envelope.add(this.envelope.from, previous.y, previous);
    this.envelope.add(x, y, metadata); this.previous = { ...metadata, x, y };
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
  if (['auxiliary_power', 'heat_pump_power', 'charger_power'].includes(row.signal) && (row.unit !== 'kW' || row.value < 0)) return null;
  if (row.signal === 'solar_radiation' && (row.unit !== 'W/m²' && row.unit !== 'W/m2' || row.value < 0)) return null;
  if (LEARNING.includes(row.signal) && row.signal !== 'learning_indoor_temperature' && row.unit !== 'EUR/cycle') return null;
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
  // Historical scalar slots fill only gaps in explicit provider intervals.
  // Merge sorted intervals in linear time instead of expanding years of CSV
  // slots into the provider-revision event map above.
  const combined = []; let index = 0;
  for (const slot of historicalSpotIntervals(store, range, now)) {
    while (index < result.length && result[index].end <= slot.start) combined.push(result[index++]);
    let cursor = slot.start;
    while (index < result.length && result[index].start < slot.end) {
      const provider = result[index];
      if (cursor < provider.start) combined.push({ ...slot, start: cursor, end: provider.start });
      cursor = Math.max(cursor, provider.end);
      if (provider.end > slot.end) break;
      combined.push(provider); index++;
    }
    if (cursor < slot.end) combined.push({ ...slot, start: cursor });
  }
  while (index < result.length) combined.push(result[index++]);
  return combined;
}

const WEATHER_SOURCES = new Set(['fmi', 'openmeteo', 'husdata-h66', 'smartthings', 'simulation']);

function weatherPointMetadata(row, solar = false) {
  const detail = solar ? row.solar ?? row : row;
  const source = detail.source ?? row.source;
  const metadata = WEATHER_SOURCES.has(source) ? { source } : {};
  if (solar) {
    for (const key of ['issuedAt', 'fetchedAt']) {
      const value = Object.hasOwn(detail, key) ? detail[key] : row[key];
      if (Number.isSafeInteger(value) && value >= 0 || value === null) metadata[key] = value;
    }
    const issuedAtBasis = detail.issuedAtBasis ?? row.issuedAtBasis;
    if (['fetched-snapshot', 'provider-result-time'].includes(issuedAtBasis)) metadata.issuedAtBasis = issuedAtBasis;
    if (['preceding-hour-mean', 'hourly-point-held-within-published-horizon'].includes(detail.intervalBasis)) metadata.intervalBasis = detail.intervalBasis;
  }
  return metadata;
}

function intervalPoints(intervals, key, envelope) {
  let previous = null;
  for (const interval of intervals) {
    const start = Math.max(envelope.from, interval.start), end = Math.min(envelope.to, interval.end);
    if (end <= start || !Number.isFinite(interval[key])) continue;
    if (previous && start > previous) { envelope.add(previous, null); envelope.add(start - 1, null); }
    const metadata = ['outdoorC', 'solarRadiationWm2'].includes(key) ? weatherPointMetadata(interval, key === 'solarRadiationWm2')
      : key === 'totalCtPerKwh' ? { assumedPrice: interval.assumedPrice === true } : undefined;
    envelope.add(start, interval[key], metadata);
    envelope.add(end - 1, interval[key], metadata);
    previous = end;
  }
}

/** Integrate original power observations, never the chart's extrema envelope.
 * Missing intervals stay missing. Each day's observed energy is compared with
 * that entire Finnish day's duration-weighted marginal price, including DST. */
export class DailyTimingBenchmark {
  constructor(range, now, prices = [], energyBases = {}) {
    this.range = range; this.now = Math.min(now, range.to); this.previous = new Map();
    this.details = Object.fromEntries(['heatPump', 'charger'].map(name => [name, {
      powerMs: 0, chargingMs: 0, idleMs: 0, firstPowerAt: null, lastPowerAt: null, sources: new Map(),
      energyBases: new Set(energyBases[name] ? [energyBases[name]] : []), timeBases: new Set(),
      auxiliaryAssumedMs: 0, auxiliaryUnknownMs: 0,
      priceAssumptions: { durationMs: 0, firstAt: null, lastAt: null, timeBasis: 'included-period' },
    }]));
    this.prices = prices.filter(row => Number.isFinite(row.totalCtPerKwh)).sort((a, b) => a.start - b.start);
    this.days = [];
    let priceIndex = 0;
    for (let day = moment.tz(range.from, CHART_TIME_ZONE).startOf('day'); day.valueOf() < range.to; day.add(1, 'day')) {
      const start = day.valueOf(), end = day.clone().add(1, 'day').valueOf();
      let covered = 0, weighted = 0, assumedPrices = false;
      while (priceIndex < this.prices.length && this.prices[priceIndex].end <= start) priceIndex++;
      for (let index = priceIndex; index < this.prices.length; index++) {
        const price = this.prices[index];
        if (price.start >= end) break;
        const duration = Math.max(0, Math.min(end, price.end) - Math.max(start, price.start));
        covered += duration; weighted += duration * price.totalCtPerKwh;
        if (duration > 0 && price.assumedPrice) assumedPrices = true;
      }
      this.days.push({ start, end, average: covered === end - start ? weighted / covered : null, assumedPrices,
        observedDuration: Math.max(0, Math.min(end, this.now) - Math.max(start, range.from)), heatPump: { energy: 0, cost: 0, covered: 0 }, charger: { energy: 0, cost: 0, covered: 0 } });
    }
  }
  add(name, at, kw, evidence = {}) {
    if (!['heatPump', 'charger'].includes(name) || !Number.isFinite(at)) return;
    const previous = this.previous.get(name);
    if (previous && at >= previous.at && Number.isFinite(previous.kw) && previous.kw >= 0) {
      let start = Math.max(previous.at, this.range.from), end = Math.min(at, previous.at + 30 * 60_000, this.now);
      const details = this.details[name];
      const firstAt = previous.evidence?.intervalStart ?? previous.at;
      const lastAt = previous.evidence?.intervalEnd ?? previous.at;
      // Standby readings establish known history, but only actual charging
      // contributes to charger timing costs and included time.
      // Reconstructing kW from phase energy can round an exact 100 W upward.
      const includedPower = name !== 'charger' || previous.kw > CHARGING_MIN_POWER_KW + Number.EPSILON;
      if (end > start) {
        details.powerMs += end - start;
        if (name === 'charger') details[includedPower ? 'chargingMs' : 'idleMs'] += end - start;
        if (includedPower) {
          details.firstPowerAt = Math.min(details.firstPowerAt ?? firstAt, firstAt);
          details.lastPowerAt = Math.max(details.lastPowerAt ?? lastAt, lastAt);
          details.energyBases.add(previous.evidence?.energyBasis ?? 'power-snapshots');
          details.timeBases.add(previous.evidence?.timeBasis ?? 'power-sample-time');
        }
      }
      // Binary lookup keeps long-range costs proportional to source observations.
      let lo = 0, hi = this.prices.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.prices[mid].end <= start) lo = mid + 1; else hi = mid; }
      for (let i = lo; includedPower && i < this.prices.length && this.prices[i].start < end; i++) {
        const price = this.prices[i];
        let a = Math.max(start, price.start), b = Math.min(end, price.end);
        while (a < b) {
          let low = 0, high = this.days.length;
          while (low < high) { const mid = (low + high) >>> 1; if (this.days[mid].end <= a) low = mid + 1; else high = mid; }
          const day = this.days[low]; if (!day) break;
          const until = Math.min(b, day.end), duration = until - a;
          if (day.average !== null) {
            const energy = previous.kw * duration / HOUR;
            day[name].energy += energy; day[name].cost += energy * price.totalCtPerKwh / 100; day[name].covered += duration;
            const key = timingEvidenceSource(previous.evidence?.key);
            if (!details.sources.has(key)) details.sources.set(key, { key, durationMs: 0, energyKwh: 0,
              firstAt, lastAt });
            const source = details.sources.get(key);
            source.durationMs += duration; source.energyKwh += energy;
            source.firstAt = Math.min(source.firstAt, firstAt); source.lastAt = Math.max(source.lastAt, lastAt);
            if (previous.evidence?.auxiliaryAssumed) details.auxiliaryAssumedMs += duration;
            if (previous.evidence?.auxiliaryUnknown) details.auxiliaryUnknownMs += duration;
            if (day.assumedPrices || price.assumedPrice) {
              details.priceAssumptions.durationMs += duration;
              details.priceAssumptions.firstAt = Math.min(details.priceAssumptions.firstAt ?? a, a);
              details.priceAssumptions.lastAt = Math.max(details.priceAssumptions.lastAt ?? until, until);
            }
          }
          a = until;
        }
      }
    }
    if (!previous || at >= previous.at) this.previous.set(name, { at, kw, evidence });
  }
  addEnergy(name, start, end, kwh, evidence = {}) {
    if (!Number.isFinite(kwh) || kwh < 0 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    // Reuse the exact tariff/day integration, without bridging gaps or applying
    // the legacy snapshot hold cap to a known recorded energy interval.
    const previous = this.previous.get(name), kw = kwh*HOUR/(end-start);
    const intervalEvidence = { ...evidence, intervalStart: start, intervalEnd: end,
      energyBasis: evidence.energyBasis ?? 'recorded-intervals', timeBasis: 'recorded-interval-time' };
    this.previous.delete(name);
    this.add(name,start,kw,intervalEvidence);
    for (let at=start;at<end;) { at=Math.min(end,at+30*60_000); this.add(name,at,at<end?kw:null,intervalEvidence); }
    if (previous) this.previous.set(name,previous); else this.previous.delete(name);
  }
  result() {
    for (const name of ['heatPump', 'charger']) this.add(name, this.now, null);
    return Object.fromEntries(['heatPump', 'charger'].map(name => {
      const duration = this.days.reduce((sum, day) => sum + day.observedDuration, 0);
      const covered = this.days.reduce((sum, day) => sum + day[name].covered, 0);
      const energyKwh = this.days.reduce((sum, day) => sum + day[name].energy, 0);
      const actualCostEuro = this.days.reduce((sum, day) => sum + day[name].cost, 0);
      const uniformCostEuro = this.days.reduce((sum, day) => sum + day[name].energy * (day.average ?? 0) / 100, 0);
      const details = this.details[name], share = ms => covered ? ms / covered : 0;
      const missingPowerMs = Math.max(0, duration - details.powerMs);
      const incompletePriceMs = Math.max(0, (name === 'charger' ? details.chargingMs : details.powerMs) - covered);
      const energyBasis = details.energyBases.size > 1 ? 'recorded-and-legacy'
        : [...details.energyBases][0] ?? 'power-snapshots';
      const timeBasis = details.timeBases.size > 1 ? 'mixed-recorded-time'
        : [...details.timeBases][0] ?? (energyBasis === 'reconstructed-equipment' ? 'recorded-interval-time' : 'power-sample-time');
      return [name, { value: covered ? uniformCostEuro - actualCostEuro : null, energyKwh: covered ? energyKwh : null,
        actualCostEuro: covered ? actualCostEuro : null, uniformCostEuro: covered ? uniformCostEuro : null,
        assumedPrices: this.days.some(day => day[name].covered > 0 && day.assumedPrices),
        coverage: duration ? Math.min(1, covered / duration) : 0,
        provisional: this.now < this.range.to || (name === 'charger'
          ? missingPowerMs > 0 || incompletePriceMs > 0 : covered < duration),
        coverageDetails: { elapsedMs: duration, includedMs: covered, coverageBasis: 'elapsed-time', powerMs: details.powerMs,
          missingPowerMs, incompletePriceMs,
          ...(name === 'charger' ? { chargingMs: details.chargingMs, idleMs: details.idleMs,
            minimumPowerKw: CHARGING_MIN_POWER_KW } : {}),
          from: this.range.from, to: Math.max(this.range.from, this.now),
          firstPowerAt: details.firstPowerAt, lastPowerAt: details.lastPowerAt },
        evidence: { basis: 'included-time', energyBasis, timeBasis,
          sources: [...details.sources.values()].map(source => ({ ...source, share: share(source.durationMs) })),
          auxiliaryAssumedMs: details.auxiliaryAssumedMs, auxiliaryAssumedShare: share(details.auxiliaryAssumedMs),
          auxiliaryUnknownMs: details.auxiliaryUnknownMs, auxiliaryUnknownShare: share(details.auxiliaryUnknownMs) },
        priceAssumptions: { ...details.priceAssumptions, share: share(details.priceAssumptions.durationMs) },
        basis: name === 'charger' ? 'Estimated phase-energy intervals; older history uses phase-current snapshots' : 'Reconstructed compressor and auxiliary electricity using recorded equipment states and dated nominal powers; no whole-property subtraction',
        explanation: 'Recorded energy at its actual times versus the same energy at each whole Finnish day’s average all-in price. Timing comparison, not proven controller savings.' }];
    }));
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
  try {
    let a = imports.next(), b = native.next();
    while (!a.done || !b.done) {
      if (!a.done && (b.done || a.value.source_time <= b.value.source_time)) { yield a.value; a = imports.next(); }
      else { yield b.value; b = native.next(); }
    }
  } finally {
    for (const iterator of [imports, native]) try { iterator.return?.(); } catch { /* Preserve the query error. */ }
  }
}

function addHistoricalChargerTiming(store, timing, range, now, input, cutoff = Infinity) {
  const scope = input === 'simulated' ? "(o.source='simulation' OR o.source='controller-estimate' AND o.device='simulated')"
    : "(o.source<>'simulation' AND NOT(o.source='controller-estimate' AND o.device='simulated'))";
  const firstPower = store.db.prepare(`SELECT min(o.source_time) AS at FROM observations o
    WHERE o.signal='charger_power' AND o.source_time>=? AND o.source_time<=? AND ${scope}`)
    .get(range.from - 30 * 60_000, Math.min(now, range.to)).at;
  const until = Math.min(cutoff, firstPower ?? Math.min(now + 1, range.to));
  if (until <= range.from - 30 * 60_000) return;
  const compact = input !== 'simulated' && range.to - range.from > 7 * DAY;
  const native = store.db.prepare(`SELECT o.* FROM observations o INDEXED BY observations_time
    LEFT JOIN imports i ON i.id=o.import_id WHERE o.source_time>=? AND o.source_time<?
    AND o.signal IN ('ev1_current_l1','ev1_current_l2','ev1_current_l3') AND ${scope}
    ${compact ? 'AND o.import_id IS NULL' : ''} AND (o.import_id IS NULL OR i.status='complete')
    ORDER BY o.source_time,o.id`).iterate(range.from - 30 * 60_000, until);
  const rows = compact ? mergedHistoryRows(store, native, range.from - 30 * 60_000, until, new Set(PHASES)) : native;
  const flagsOf = qualityReader(); let at = null, groups = new Map();
  const flush = () => {
    const candidates = [...groups.values()].sort((a, b) => b.priority - a.priority || b.id - a.id);
    if (candidates.length) {
      const values = candidates[0].values;
      timing.add('charger', at, values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) * 0.23 : null,
        { key: input === 'simulated' ? 'simulated' : 'currents' });
    }
    groups = new Map();
  };
  for (const row of alignEaseePowerSnapshots(rows, store.db, now)) {
    if (at !== null && row.source_time !== at) flush();
    at = row.source_time;
    if (row.imported) {
      if (row.kind !== 'easee') continue;
      const values = decodeHistoryRow(row.kind, row.raw).observations.slice(0, 3).map(observation =>
        observation.quality.includes('ev_exceeds_property_current') ? null : valueOf(observation, observation.quality));
      groups.set(`csv:${row.id}:${row.row_number}`, { values, priority: 0, id: row.id * 1_000_000_000 + row.row_number * 10 });
    } else {
      const key = `${row.source}:${row.device}:${row.import_id ?? ''}:${row.row_number ?? row.received_at}`;
      const flags = flagsOf(row.quality);
      if (!groups.has(key)) groups.set(key, { values: [null, null, null], priority: row.import_id == null ? 1 : 0, id: row.id });
      const group = groups.get(key); group.id = row.id;
      group.values[Number(row.signal.at(-1)) - 1] = flags.includes('ev_exceeds_property_current')
        || !row.alignedPowerSnapshot && flags.includes('asynchronous_snapshot') ? null : valueOf(row, flags);
    }
  }
  if (at !== null) flush();
  // Finish the historical path at the exact handover; a scalar power observation
  // then supersedes it without double counting or dependence on chart decimation.
  timing.add('charger', Math.min(until, now, range.to), null);
}

/** Combined chart query. This deliberately never calls providers, reads options,
 * writes history, or turns phase-current estimates into electricity metering. */
export function getChartData({ store, input = 'offline', contract = null, market = null, weather = null,
  simulated = null, now = Date.now(), startDate, endDate, left = 'power', points = 800, viewFrom, viewTo,
  _relatedTimes, _priceProjection }) {
  const started = performance.now();
  const { range, selection, detail } = chartRequestRange({ startDate, endDate, now, viewFrom, viewTo });
  const projecting = Array.isArray(_relatedTimes), drawingOnly = detail || projecting;
  if (!HISTORY_AXIS_BY_KEY[left]) throw new TypeError('Unknown left axis');
  if (!Number.isInteger(points) || points < 100 || points > 2000) throw new RangeError('Chart points must be 100–2000');
  if (!['simulated', 'providers', 'mqtt', 'offline'].includes(input)) throw new TypeError('Unknown chart input');
  let rates = null;
  if (contract && (!projecting || _priceProjection)) { rates = validateContract(contract); if (rates.mode !== 'billing') throw new TypeError('Historical charts require dated billing rates'); }
  const leftNames = HISTORY_AXIS_BY_KEY[left].signals;
  const names = projecting ? _priceProjection ? ['all_in_price', 'spot_price'] : leftNames
    : [...TEMPERATURES, 'outdoor_forecast', 'all_in_price', 'spot_price', ...leftNames];
  const envelopes = Object.fromEntries(names.map(name => [name, projecting
    ? new RelatedStepSampler(range.from, range.to, _relatedTimes) : new Envelope(range.from, range.to, points)]));
  if (_priceProjection) for (const envelope of Object.values(envelopes)) envelope.mask = _priceProjection.marketIntervals;
  const lines = Object.fromEntries(names.map(name => [name, new HistoryLine(envelopes[name], LEARNING.includes(name) ? Infinity : name === 'auxiliary_power' ? 5 * 60_000 : /power|current|integral|solar/.test(name) ? 30 * 60_000 : 3 * HOUR, ['auxiliary_power', 'solar_radiation'].includes(name), detail,
    name.endsWith('_price') || leftNames.includes(name) && left !== 'integral' && name !== 'model_indoor_temperature' && !ENERGY_SIGNALS.includes(name))]));
  // Following samples close clipped scalar segments, including a viewport
  // narrower than their source cadence. Context never crosses selected dates.
  const queryTo = Math.min(detail ? Math.min(selection.to, range.to + 3 * HOUR) : range.to, now + 1);
  const shading = Object.fromEntries(['heatOff', 'compressorSpace', 'compressorDhw', 'dhwr', 'fireplace'].map(key => [key, new ShadeEnvelope(range, points)])), warnings = [];
  // Daily outcomes retain their selected calendar-day meaning at every zoom.
  // Only their selected series needs this calculation on detail requests.
  const firewoodRange = detail && FIREWOOD_OUTCOME_NAMES.includes(left) ? { ...range,
    from: Math.max(selection.from, moment.tz(range.from, CHART_TIME_ZONE).startOf('day').valueOf()),
    to: Math.min(selection.to, moment.tz(range.to - 1, CHART_TIME_ZONE).startOf('day').add(1, 'day').valueOf()),
  } : range;
  const marketIntervals = projecting || input === 'simulated' ? [] : knownIntervals(market, store, firewoodRange, now);
  const historicalPricing = rates ? createHistoricalPricing(rates) : null;
  const priced = input === 'simulated' ? (simulated?.prices ?? []).map(row => ({ ...row, totalCtPerKwh: row.allInCentsPerKWh }))
    : historicalPricing?.intervals(marketIntervals) ?? [];
  const priceAssumptions = { used: priced.some(price => price.assumedPrice) };
  const timing = drawingOnly ? { add() {}, addEnergy() {} }
    : new DailyTimingBenchmark(range, now, priced, { heatPump: 'reconstructed-equipment' });
  const heatPumpEnergy = !drawingOnly || envelopes.heat_pump_power
    ? addHistoricalHeatPump({ store, range, now, input, envelope: envelopes.heat_pump_power, timing }) : null;
  const energyStarts = Object.fromEntries(['property','ev1'].map(prefix=>[prefix,recordedEnergyStart(store,prefix,input)]));
  if (!drawingOnly) addHistoricalChargerTiming(store, timing, range, now, input, energyStarts.ev1);
  const modeEnvelopes = Object.fromEntries([0, 1, 2, 3, 4].map(mode => [mode, new ShadeEnvelope(range, points)]));
  let telemetry = new Map(), previousTelemetryAt = null;
  const learningMetadata = {};
  const requested = new Set(projecting ? _priceProjection ? ['spot_price']
    : left === 'power' ? [...PHASES, 'auxiliary_output', 'auxiliary_power', 'charger_power'] : PHASES
    : [...TEMPERATURES, 'spot_price', 'requested_heat_mode', 'auxiliary_output', ...H66_SIGNALS,
    ...(left === 'integral' ? [] : PHASES), ...leftNames.filter(name => !Object.hasOwn(MODEL_INPUT_INFO, name) && !Object.hasOwn(MODEL_COEFFICIENT_INFO, name) && !Object.hasOwn(SESSION_CHECK_INFO, name) && !AUDIT_SIGNALS.includes(name) && !FIREWOOD_OUTCOME_NAMES.includes(name) && !['property_power', 'charger2_power', 'heat_pump_power', 'solar_forecast',...ENERGY_SIGNALS].includes(name))]);
  const compactImports = input !== 'simulated' && range.to - range.from > 7 * DAY;
  const columns = `o.id,o.source,o.device,o.signal,o.value,o.unit,o.source_time,o.received_at,
    o.quality,o.import_id,o.row_number,CASE WHEN o.signal IN ('heat_pump_power','charger_power','solar_radiation','auxiliary_output','compressor_active','dhw_routing','operating_mode','controller_phase','dhwr_request',${LEARNING.map(name => `'${name}'`).join(',')}) THEN o.raw END AS raw`;
  const sourceScope = input === 'simulated' ? "(o.source='simulation' OR o.source IN ('controller-learning','controller-estimate','controller') AND o.device='simulated')"
    : "(o.source<>'simulation' AND NOT(o.source IN ('controller-learning','controller-estimate','controller') AND o.device='simulated'))";
  // Read only the selected signals from their index. A chronological full-table
  // scan still touches years of phase energy even when this axis needs only
  // scalar measurements. Recorded energy has its own bounded iterator below.
  // Merge bounded iterators instead of sorting a large intermediate SQL result.
  function* nativeHistoryRows() {
    const heads=[],pending=new Set();
    try {
      for(const signal of requested) {
        const query=store.db.prepare(`SELECT ${columns}
          FROM observations o INDEXED BY observations_signal_time LEFT JOIN imports i ON i.id=o.import_id
          WHERE o.signal=? AND o.source_time>=? AND o.source_time<?
          ${compactImports ? 'AND o.import_id IS NULL' : ''}
          AND ${sourceScope} AND (o.import_id IS NULL OR i.status='complete')
          AND COALESCE(json_extract(o.raw,'$.recorder.status'),'fresh')='fresh'
          ORDER BY o.source_time,o.id`);
        const iterator=query.iterate(signal,range.from-3*HOUR,queryTo);
        pending.add(iterator);
        const item=iterator.next();
        if(item.done)pending.delete(iterator);else heads.push({iterator,value:item.value});
      }
      while(heads.length) {
        let index=0;
        for(let i=1;i<heads.length;i++)if(heads[i].value.source_time<heads[index].value.source_time
          ||heads[i].value.source_time===heads[index].value.source_time&&heads[i].value.id<heads[index].value.id)index=i;
        const head=heads[index];yield head.value;
        const next=head.iterator.next();
        if(next.done){pending.delete(head.iterator);heads.splice(index,1);}else head.value=next.value;
      }
    } finally {
      for(const iterator of pending)try{iterator.return?.();}catch{/* Preserve the query/projection error. */}
    }
  }
  const flagsOf = qualityReader(); let rawRows = 0, invalidRows = 0, latestOutdoor = null;
  let time = null, atRows = new Map(), phases = new Map();
  let previousHeat = null, pendingPulse = null;
  const flushPulse = () => {
    if (!pendingPulse || !envelopes.dhwr_request) return;
    const { start, end } = pendingPulse, until = Math.min(end, now, range.to);
    if (until > Math.max(start, range.from)) {
      envelopes.dhwr_request.add(Math.max(start, range.from), 1);
      envelopes.dhwr_request.add(until - 1, 1);
      envelopes.dhwr_request.add(until, null);
    }
    pendingPulse = null;
  };
  const verified = row => {
    if (input === 'simulated' && row.source === 'simulation') return true;
    try { const raw = JSON.parse(row.raw); return row.source === 'husdata-h66' && Boolean(raw?.verified) && raw?.usableForControl !== false; } catch { return false; }
  };
  const flushTelemetry = until => {
    if (previousTelemetryAt === null || until <= previousTelemetryAt) return;
    const compressor = telemetry.get('compressor_active'), route = telemetry.get('dhw_routing'), mode = telemetry.get('operating_mode');
    if (compressor?.value === 1 && [0, 1].includes(route?.value)) {
      const end = Math.min(until, compressor.at + 5 * 60_000, route.at + 5 * 60_000);
      shading[route.value === 1 ? 'compressorDhw' : 'compressorSpace'].add(previousTelemetryAt, end);
    }
    if (modeEnvelopes[mode?.value]) modeEnvelopes[mode.value].add(previousTelemetryAt, Math.min(until, mode.at + 5 * 60_000));
    const phase = telemetry.get('controller_phase');
    if (phase?.value === 2) shading.heatOff.add(previousTelemetryAt, Math.min(until, phase.until));
  };
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
    const previous = previousHeat;
    const gap = 30 * 60_000;
    if (previous) {
      const until = Math.min(row.source_time, previous.at + gap);
      if (kind === 'heat' && previous.value === 0) shading.heatOff.add(previous.at, until);
      if (kind === 'heat' && previous.value === 60) shading.dhwr.add(previous.at, Math.min(row.source_time, previous.at + 600_000));
    }
    previousHeat = { at: row.source_time, value };
  };
  const flushTime = () => {
    flushTelemetry(time);
    for (const { row, value } of atRows.values()) {
      const signal = row.signal;
      if (signal === 'charger_power' && time >= energyStarts.ev1) continue;
      if (PHASES.includes(signal) && time >= energyStarts[signal.startsWith('ev1')?'ev1':'property']) continue;
      if (signal === 'requested_heat_mode') addState(row, value, 'heat');
      else if (signal === 'dhwr_request' && row.source === 'controller' && row.device === input && value === 1) {
        let end = time + 10 * 60_000;
        try { const raw = JSON.parse(row.raw); if (Number.isFinite(raw?.expiresAt)) end = Math.min(end, raw.expiresAt); } catch { /* Ten-minute legacy pulse default. */ }
        shading.dhwr.add(time, Math.min(end, now));
        if (envelopes.dhwr_request && end > time) {
          if (pendingPulse && time > pendingPulse.end) flushPulse();
          pendingPulse = pendingPulse ? { start: pendingPulse.start, end: Math.max(end, pendingPulse.end) } : { start: time, end };
        }
      }
      else if (signal === 'controller_phase' && row.source === 'controller' && row.device === input) {
        lines[signal]?.add(time, value);
        let until = time + 30 * 60_000;
        try { const raw = JSON.parse(row.raw); if (Number.isFinite(raw?.expiresAt) && raw.expiresAt > time) until = raw.expiresAt; } catch { /* Older requests retain a bounded lifetime. */ }
        telemetry.set(signal, { at: time, value, until });
      }
      else if (['compressor_active', 'dhw_routing', 'operating_mode'].includes(signal)) {
        lines[signal]?.add(time, value);
        telemetry.set(signal, { at: time, value: verified(row) ? value : null });
      } else if (signal === 'auxiliary_output') {
        lines[signal]?.add(time, value);
        if (!atRows.has('auxiliary_power') && lines.auxiliary_power) {
          let kw = null;
          try { const raw = JSON.parse(row.raw), capacity = raw?.ratedPowerKw ?? raw?.ratedKw ?? raw?.maxPowerKw;
            if (verified(row) && Number.isFinite(capacity) && capacity > 0) kw = auxiliaryPowerFromOutput(value, capacity)?.kw ?? null;
          } catch { /* Never assume installed heater capacity. */ }
          lines.auxiliary_power.add(time, kw);
        }
      } else {
        let metadata;
        if (signal === 'outdoor_temperature') metadata = weatherPointMetadata(row);
        if (signal === 'solar_radiation') {
          let raw;
          try { raw = JSON.parse(row.raw); } catch { /* Older archived forecasts may lack metadata. */ }
          metadata = weatherPointMetadata({ source: row.source, solar: raw && typeof raw === 'object' ? raw : {} }, true);
        }
        if (signal !== 'charger_power') lines[signal]?.add(time, value, metadata);
        if (signal === 'charger_power' && !drawingOnly) timing.add('charger', time, row.unit === 'kW' ? value : null, timingPowerEvidence(row));
        if (LEARNING.includes(signal)) {
          try { const raw = JSON.parse(row.raw); learningMetadata[signal] = { at: time, count: raw?.count ?? null, basis: raw?.basis ?? null, modelVersion: raw?.modelVersion ?? null }; } catch { /* Optional metadata. */ }
        }
        if (signal === 'outdoor_temperature' && value !== null) latestOutdoor = time;
        if (signal === 'spot_price' && rates) {
          const total = value === null ? null : historicalPricing.total(time, value);
          lines.all_in_price.add(time, total?.totalCtPerKwh ?? null, total ? { assumedPrice: total.assumedPrice } : undefined);
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
      for (const [prefix, group] of candidates) {
        if (time >= energyStarts[prefix]) continue;
        const power = group.complete ? group.values.reduce((sum, value) => sum + value, 0) * 0.23 : null;
        lines[prefix === 'property' ? 'property_power' : 'charger_power']?.add(time, power);
      }
    }
    previousTelemetryAt = time;
    atRows = new Map(); phases = new Map();
  };
  const nativeRows = nativeHistoryRows();
  const historyRows = compactImports ? mergedHistoryRows(store, nativeRows, range.from - 3 * HOUR, queryTo, requested) : nativeRows;
  function* rowsWithPreviousReadings() {
    const earlier = [];
    // Learned estimates remain in effect until superseded, including past-day
    // views. A seed retains its original timestamp and never backdates learning.
    if (LEARNING.includes(left)) {
      const seed = store.db.prepare(`SELECT ${columns} FROM observations o WHERE o.signal=? AND o.source_time<?
        AND o.source='controller-learning' AND o.device=? ORDER BY o.source_time DESC,o.id DESC LIMIT 1`).get(left, range.from - 3 * HOUR, input);
      if (seed) earlier.push(seed);
    }
    const phaseSeed = store.db.prepare(`SELECT ${columns} FROM observations o WHERE o.signal='controller_phase'
      AND o.source='controller' AND o.device=? AND o.source_time<? ORDER BY o.source_time DESC,o.id DESC LIMIT 1`)
      .get(input, range.from - 3 * HOUR);
    if (phaseSeed) earlier.push(phaseSeed);
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
      for (const at of times) earlier.push(...seeds.iterate(at, ...signals));
    }
    yield* earlier.sort((a, b) => a.source_time - b.source_time || a.id - b.id);
    yield* historyRows;
  }
  const rows = mergeCoverageRows(rowsWithPreviousReadings(),store,{from:range.from-3*HOUR,to:queryTo,input,signals:requested});
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
    if (LEARNING.includes(row.signal) && (row.source !== 'controller-learning' || row.device !== input)) continue;
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
  flushPulse();
  if (Number.isFinite(energyStarts.ev1)) timing.add('charger',energyStarts.ev1,null);
  const recordedEnergy = !drawingOnly || names.some(name => ENERGY_SIGNALS.includes(name) || PHASES.includes(name)
    || ['property_power', 'charger_power', 'charger2_power'].includes(name))
    ? addRecordedEnergy({store,range,now,input,envelopes,timing}) : { rows: 0, intervals: 0 };
  const finishHeldLines = () => {
    for (const name of ['auxiliary_power', 'solar_radiation']) if (lines[name]?.previous) {
      const line = lines[name], previous = line.previous, nowEnd = Math.min(now, range.to), end = Math.min(nowEnd, previous.x + line.gap);
      if (previous.x < range.from && end >= range.from) envelopes[name].add(range.from, previous.y, previous);
      if (previous.x < end) envelopes[name].add(end, previous.y, previous);
      if (end < nowEnd) envelopes[name].add(end + 1, null);
    }
  };
  // The optional second pass shares the exact telemetry/energy projection but
  // skips summaries, weather lookup, model replay and source writes. Price
  // projection reuses the already selected authoritative intervals.
  if (projecting) {
    finishHeldLines();
    if (_priceProjection) {
      for (const envelope of Object.values(envelopes)) envelope.mask = null;
      intervalPoints(_priceProjection.marketIntervals, 'spotCtPerKwh', envelopes.spot_price);
      intervalPoints(_priceProjection.priced, 'totalCtPerKwh', envelopes.all_in_price);
    }
    return { series: Object.fromEntries(names.map(name => [name, envelopes[name].values()])),
      rawRows, energyRows: recordedEnergy.rows };
  }
  const chargingSessions = addChargingSessionChecks({ store, range, now, envelopes });
  const modelInputs = addModelInputs({ store, range, now, input, envelopes });
  const modelCoefficients = addModelCoefficients({ store, range, now, input, envelopes });
  const fireplaceInputs = addFireplaceInputs({ store, range, now, input, envelopes, shading });
  const needsFirewood = !detail || FIREWOOD_OUTCOME_NAMES.includes(left);
  const outlookForFirewood = !needsFirewood ? {} : input === 'simulated' ? simulated ?? {} : assembleOutlook(market, weather, contract, now);
  const firewood = needsFirewood ? getFirewoodBenefit({ store, input, range: firewoodRange, now,
    priceIntervals: priced.map(row => ({ ...row, price: row.totalCtPerKwh })),
    futureIntervals: !detail && range.from <= now && range.to > now
      ? forecastIntervals(outlookForFirewood.prices, outlookForFirewood.forecast, Math.floor(now / 900_000) * 900_000) : [] }) : null;
  const firewoodOutcomes = firewood ? addFirewoodOutcomes({ result: firewood, range: firewoodRange, now, envelopes }) : null;
  if (FIREPLACE_INPUT_NAMES.includes(left) && fireplaceInputs.loggingStartedAt === null)
    warnings.push('No fireplace logging exists for this input source. Earlier unlogged periods are unknown.');
  if (FIREWOOD_OUTCOME_NAMES.includes(left)) {
    warnings.push('Firewood savings are retrospective model estimates of avoided space-heating electricity, with free wood. They are separate from timing-cost comparisons.');
    if (firewood.summary.status === 'unavailable') warnings.push(firewood.summary.reason ?? 'Firewood savings need usable heating observations and prices.');
  }
  if (Object.hasOwn(MODEL_INPUT_INFO, left) && !FIREPLACE_INPUT_NAMES.includes(left) && !modelInputs.records) warnings.push('No saved learning inputs exist for these dates and input source. Recording sensor values alone does not create learning-input history.');
  if (Object.hasOwn(MODEL_COEFFICIENT_INFO, left)) {
    if (!envelopes[left].values().some(point => Number.isFinite(point.y))) warnings.push('No reconstructable model coefficients exist for these dates and input source.');
    if (modelCoefficients.unsupportedRecords || modelCoefficients.invalidRecords) warnings.push('Some coefficient history is unavailable because its learning records are unsupported or incomplete.');
  }
  for(const signal of leftNames.filter(name=>AUDIT_SIGNALS.includes(name))) {
    for(const row of store.db.prepare('SELECT value,source_time,quality FROM energy_audits WHERE signal=? AND source_time>=? AND source_time<=? ORDER BY source_time,id')
      .iterate(signal,range.from,Math.min(range.to,now))) {
      const quality=JSON.parse(row.quality);
      envelopes[signal].add(row.source_time,quality.some(flag=>/reset|not.increasing|invalid/.test(flag))?null:row.value,{auditOnly:true});
    }
  }

  // A last command is only a bounded request; it is not indefinite confirmation.
  if (previousHeat) addState({ source_time: Math.min(now, range.to) }, null, 'heat');
  flushTelemetry(Math.min(now, range.to));
  for (const name of LEARNING) if (lines[name]?.previous) {
    const previous = lines[name].previous, end = Math.min(now, range.to);
    if (previous.x < range.from) envelopes[name].add(range.from, previous.y);
    if (previous.x < end) envelopes[name].add(end, previous.y);
  }
  finishHeldLines();
  if (input !== 'simulated' && envelopes.solar_radiation)
    intervalPoints(historicalSolar(store,range,now),'solarRadiationWm2',envelopes.solar_radiation);

  if (input === 'simulated') {
    intervalPoints(simulated?.prices ?? [], 'allInCentsPerKWh', envelopes.all_in_price);
    intervalPoints((simulated?.forecast ?? []).map(row => ({ ...row, start: Math.max(row.start, now, latestOutdoor ?? now) })), 'outdoorC', envelopes.outdoor_forecast);
    if (envelopes.solar_forecast) intervalPoints((simulated?.forecast ?? []).map(row => ({ ...row, start: Math.max(row.start, now) })), 'solarRadiationWm2', envelopes.solar_forecast);
    warnings.push('Simulation: temperatures and outlook are fictional.');
  } else {
    const intervals = marketIntervals;
    // Provider intervals take precedence over old scalar CSV prices wherever
    // covered, without falsely extending an isolated historical measurement.
    const replaceCovered = name => {
      if (!intervals.length) return;
      const previous = envelopes[name].values();
      envelopes[name] = new Envelope(range.from, range.to, points);
      let index = 0;
      for (const point of previous) {
        while (index < intervals.length && intervals[index].end <= point.x) index++;
        if (!intervals[index] || point.x < intervals[index].start) envelopes[name].add(point.x, point.y, point);
      }
    };
    replaceCovered('spot_price'); replaceCovered('all_in_price');
    intervalPoints(intervals, 'spotCtPerKwh', envelopes.spot_price);
    if (rates) {
      intervalPoints(priced, 'totalCtPerKwh', envelopes.all_in_price);
    } else warnings.push('All-in price needs at least one known set of contract rates; spot remains a separate series.');
    const outlook = assembleOutlook(null, weather, null, now);
    intervalPoints(outlook.forecast.map(row => ({ ...row, start: Math.max(row.start, now, latestOutdoor ?? now) })), 'outdoorC', envelopes.outdoor_forecast);
    if (envelopes.solar_forecast) {
      intervalPoints(outlook.forecast.map(row => ({ ...row, start: Math.max(row.start, now) })), 'solarRadiationWm2', envelopes.solar_forecast);
      warnings.push('Solar radiation uses FMI forecasts with Open-Meteo as backup, including archived historical values; it is not measured at the house.');
    }
    if (rates && !envelopes.all_in_price.values().some(point => point.y !== null))
      warnings.push('No all-in price is available for these dates: spot prices and known contract rates are required.');
  }
  const series = Object.fromEntries(Object.entries(envelopes).map(([name, envelope]) => [name, envelope.values()]));
  let relatedSampling;
  const relatedGroups = [...(['power', 'phases'].includes(left) ? [leftNames] : []), ['all_in_price', 'spot_price']];
  for (const group of relatedGroups) if (group.some(name => envelopes[name].count > series[name].length)) {
    const times = [...new Set(group.flatMap(name => series[name].map(point => point.x)))].sort((a, b) => a - b);
    const priceGroup = group[0] === 'all_in_price';
    const projected = getChartData({ store, input, contract, now, startDate, endDate, left, points, viewFrom, viewTo,
      _relatedTimes: times, ...(priceGroup ? { _priceProjection: { marketIntervals, priced } } : {}) });
    Object.assign(series, alignRelatedSamples(projected.series));
    relatedSampling ??= { basis: 'shared-original-step-times', groups: [], times: 0, sourceRows: 0,
      description: 'Related channels share selected original step times; held display points retain their original source timestamp and interval. Omitted missing runs remain disconnected.' };
    relatedSampling.groups.push(group); relatedSampling.times += times.length;
    relatedSampling.sourceRows += projected.rawRows + projected.energyRows;
  }
  priceAssumptions.used ||= series.all_in_price.some(point => Number.isFinite(point.y) && point.assumedPrice);
  for (const key of Object.keys(shading)) shading[key] = shading[key].values();
  if (Object.values(shading).some(rows => rows.some(row => row.aggregated))) warnings.push('Dense shading shows the occupied fraction of each display interval.');
  // These are original source timestamps, even when outside the visible range.
  // Only the browser draws carry-forward tails; no synthetic readings are stored.
  const lastReadings = Object.fromEntries([...TEMPERATURES,
    ...leftNames]
    .filter(name => lines[name]?.previous).map(name => [name, { ...lines[name].previous }]));
  if (LEARNING.includes(left)) warnings.push('Learning history records estimates when assessed. Gaps mean no recorded estimate; auxiliary recovery metrics exclude cycles whose auxiliary state was unknown.');
  const operatingModes = Object.entries(modeEnvelopes).flatMap(([value, envelope]) => envelope.values().map(row => ({ ...row, value: Number(value) }))).sort((a, b) => a.start - b.start);
  return { range, now, input, left, series, shading, operatingModes,
    ...(detail ? { selection } : { timingBenefit: timing.result(),
      heatingBenefit: getHeatingBenefit({ store, input, range, now }), firewoodBenefit: firewood.summary }),
    meta: { ...(detail ? { detail: true } : {}), ...(relatedSampling ? { relatedSampling } : {}), warnings, priceAssumptions, rawRows, invalidRows, lastReadings, learning: learningMetadata, modelInputs, modelCoefficients, fireplaceInputs, firewoodOutcomes, recordedEnergy, chargingSessions, heatPumpEnergy, historyBasis: 'original-recorded-history',
    returnedPoints: Object.values(series).reduce((sum, rows) => sum + rows.length, 0),
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    powerEstimate: left === 'power' ? 'Recorded phase or total energy divided by its interval duration; older current-only history uses 230 V. Phase allocation and energy integration are estimates.' : null,
    heatOffBasis: 'Historical requested reduction, not compressor activity.',
    auxHeatBasis: 'Estimated kW from H66 auxiliary output and configured capacity; cumulative counters do not identify episodes.',
    dhwrBasis: 'Historical ten-minute pulse requests, not verified pump feedback.',
    fireplaceBasis: 'Corrected manual additions over the model burn timescale; heat release continues afterward.',
    decimation: 'Original recorded history, reduced in memory for display: first, last, minimum, maximum and missing-data breaks per time bucket. Costs use original energy intervals independently of drawing points.' } };
}
