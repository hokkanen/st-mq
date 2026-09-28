import { addGarageHistory } from './chart-garage.js';
import { DailyTimingBenchmark } from './daily-timing-benchmark.js';
export { DailyTimingBenchmark } from './daily-timing-benchmark.js';
import { getGarageModelBenefit, getGarageTimingBenefit, buildHeatingSavings } from './garage-reporting.js';
import { isRecordedDataset } from '../storage/recorded-datasets.js';
import { H66_MAX_AGE_MS } from '../domain/reading-freshness.js';
import { isInterpolatedTemperature } from '../domain/chart-temperatures.js';
import moment from 'moment-timezone';
import { validateContract } from '../domain/prices.js';
import { assembleOutlook } from './contract.js';
import { historicalSolar } from './chart-weather.js';
import { createHistoricalPricing } from './chart-prices.js';
import { historicalSpotIntervals } from './historical-spot-prices.js';
import { resolveMarketIntervals } from '../domain/market-authority.js';
import { auxiliaryPowerFromOutput } from '../domain/telemetry.js';
import { HISTORY_AXIS_BY_KEY, CARAVAN_POWER_STATES, GARAGE_INPUT_INFO, GARAGE_COEFFICIENT_INFO, GARAGE_OUTCOME_INFO, ENERGY_SIGNALS, AUDIT_SIGNALS, COUNTER_SIGNALS, SESSION_CHECK_INFO, MODEL_INPUT_INFO, MODEL_COEFFICIENT_INFO, RECORDED_EVIDENCE_SIGNALS } from '../domain/history-series.js';
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
import { alignEaseePowerSnapshots } from './chart-phase-snapshots.js';
import { powerExtremaTimes } from './chart-power-extrema.js';
import { CHART_VIEW_BY_KEY } from '../domain/chart-views.js';
import { RecordedEvidenceLine } from './chart-recorded-evidence.js';

export const CHART_TIME_ZONE = 'Europe/Helsinki';
const HOUR = 3_600_000, DAY = 24 * HOUR;
const TEMPERATURES = ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature', 'garage_temperature', 'garage_temperature_2', 'outdoor_temperature'];
const DOOR_SIGNALS = ['garage_door1_open', 'garage_door2_open'];
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
 * queried viewport. Temperature detail retains explicitly marked neighbouring
 * knots for display tangents; the requested viewport itself remains fixed. */
export function chartRequestRange({ viewFrom, viewTo, ...args } = {}) {
  const selection = chartRange(args), detail = viewFrom !== undefined || viewTo !== undefined;
  if (!detail) return { selection, range: selection, detail: false };
  if (!Number.isSafeInteger(viewFrom) || !Number.isSafeInteger(viewTo))
    throw new TypeError('Both chart viewport bounds must be UTC milliseconds');
  if (viewFrom < selection.from || viewTo > selection.to || viewTo <= viewFrom)
    throw new RangeError('Chart viewport must remain within the selected dates');
  return { selection, range: { ...selection, from: viewFrom, to: viewTo }, detail: true };
}

/** A bounded pixel envelope. If a bucket exceeds eight missing markers, its interior
 * missing span is conservatively unavailable instead of inventing connectivity.
 * First/last and finite extrema outside that span retain their source times. */
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
    if (point.y === null) {
      bucket.gaps ??= new Map();
      if (bucket.gaps.size < 8 || bucket.gaps.has(x)) bucket.gaps.set(x,point);
      else bucket.gapOverflow = true;
      if (!bucket.missing || x < bucket.missing.x) { bucket.missing = point; bucket.beforeMissing = bucket.last; }
      if (!bucket.lastMissing || x >= bucket.lastMissing.x) { bucket.lastMissing = point; bucket.afterMissing = null; }
    }
    if (point.y !== null) {
      if (!bucket.min || point.y < bucket.min.y) bucket.min = point;
      if (!bucket.max || point.y > bucket.max.y) bucket.max = point;
      if (bucket.lastMissing && x > bucket.lastMissing.x
        && (!bucket.afterMissing || x < bucket.afterMissing.x)) bucket.afterMissing = point;
    }
    if (point.x < bucket.first.x) bucket.first = point;
    if (point.x >= bucket.last.x) bucket.last = point;
    this.count++;
  }
  values() {
    const result = [];
    for (const [, bucket] of [...this.buckets].sort((a, b) => a[0] - b[0])) {
      const points = [bucket.first, bucket.min, bucket.max, bucket.beforeMissing, bucket.missing, bucket.lastMissing, bucket.afterMissing, bucket.last,
        ...bucket.gaps?.values() ?? []]
        .filter(Boolean).map(point => bucket.gapOverflow && bucket.missing && bucket.lastMissing && point.x >= bucket.missing.x
          && point.x <= bucket.lastMissing.x && point.y !== null
          ? { ...point, y: null, displayCoverage: 'partial' } : point).sort((a, b) => a.x - b.x);
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

/** Cubic display needs the readings around a zoomed segment, not linear values
 * invented at its cut edges. Reuse the already bounded context query and retain
 * at most eight nearby vertices per side (periodic coverage uses two vertices
 * per span). Gaps and source metadata remain attached to those exact points. */
class TemperatureEnvelope extends Envelope {
  constructor(from, to, points, contextFrom, contextTo) {
    super(from, to, points); this.before = []; this.after = [];
    this.contextFrom = contextFrom; this.contextTo = contextTo;
  }
  add(x, y, metadata) {
    if (x < this.contextFrom || x > this.contextTo) return;
    if (!Number.isFinite(x) || x >= this.from && x <= this.to) return super.add(x, y, metadata);
    const neighbours = x < this.from ? this.before : this.after;
    const point = { ...metadata, x, y: Number.isFinite(y) ? y : null, displayContext: true };
    const index = neighbours.findIndex(row => row.x === x);
    if (index >= 0) {
      if (neighbours[index].y !== null || point.y === null) neighbours[index] = point;
    } else neighbours.push(point);
    neighbours.sort((a, b) => a.x - b.x);
    if (neighbours.length > 8) neighbours.splice(x < this.from ? 0 : 8, neighbours.length - 8);
  }
  values() { return [...this.before, ...super.values(), ...this.after]; }
}

class HistoryLine {
  constructor(envelope, gap, boundedHold = false, clipEdges = false, stepped = false, observationsOnly = false) {
    this.envelope = envelope; this.gap = gap; this.previous = null;
    this.boundedHold = boundedHold; this.clipEdges = clipEdges; this.stepped = stepped; this.observationsOnly = observationsOnly;
  }
  add(x, y, metadata) {
    const previous = this.previous;
    const covered = (metadata?.periodicCoverage || metadata?.sourceCoverage)
      && (previous?.periodicCoverage || previous?.sourceCoverage)
      && metadata.coverageId === previous.coverageId;
    if (previous && !covered && x - previous.x > this.gap && x > this.envelope.from) {
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
    if (!this.observationsOnly && this.clipEdges && previous && (covered || x - previous.x <= this.gap)) {
      // A viewport between recorded samples still shows the same connecting
      // segment. These clipped display points never masquerade as observations.
      for (const boundary of [this.envelope.from, this.envelope.to]) {
        if (previous.x >= boundary || x <= boundary) continue;
        const value = Number.isFinite(previous.y) && Number.isFinite(y)
          ? this.stepped ? previous.y : previous.y + (y - previous.y) * (boundary - previous.x) / (x - previous.x) : null;
        this.envelope.add(boundary, value, { ...previous, displayBoundary: true,
          observedAt: previous.observedAt??previous.x, nextObservedAt: metadata?.observedAt??x, interpolated: !this.stepped });
      }
    } else if (!this.observationsOnly && !this.clipEdges && x >= this.envelope.from && previous?.x < this.envelope.from && (covered || x - previous.x <= this.gap))
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
  if (row.signal === 'caravan_humidity' && (row.unit !== '%' || row.value < 0 || row.value > 100)) return null;
  if (row.signal === 'caravan_dehumidifier_active' && (row.unit !== 'state' || !Object.hasOwn(CARAVAN_POWER_STATES, row.value))) return null;
  if (PHASES.includes(row.signal) && row.unit !== 'A') return null;
  if (row.signal === 'spot_price' && !['c/kWh_ex_vat', 'c/kWh'].includes(row.unit)) return null;
  if (['auxiliary_power', 'heat_pump_power', 'charger_power'].includes(row.signal) && (row.unit !== 'kW' || row.value < 0)) return null;
  if (row.signal === 'solar_radiation' && (row.unit !== 'W/m²' && row.unit !== 'W/m2' || row.value < 0)) return null;
  if (LEARNING.includes(row.signal) && row.signal !== 'learning_indoor_temperature' && row.unit !== 'EUR/cycle') return null;
  return row.value;
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

export function knownIntervals(market, store, range, now) {
  // Stored market snapshots preserve historical intervals after the rolling
  // provider cache has moved on. Receipt eligibility precedes publication authority.
  const rows = [];
  const accept = (snapshot, fetchedAt) => {
    if (!Number.isFinite(fetchedAt) || fetchedAt > now || !Array.isArray(snapshot?.intervals)) return;
    for (const interval of snapshot.intervals) {
      if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end) || interval.end <= interval.start
        || interval.end - interval.start > 25 * HOUR
        || interval.end <= range.from || interval.start >= range.to || !Number.isFinite(interval.spotCtPerKwh)
        || interval.unit !== 'c/kWh' || interval.vatIncluded !== false) continue;
      rows.push({ ...interval, fetchedAt });
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
  const result = resolveMarketIntervals(rows, range);
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
  return combined.filter(row => !row.authorityConflict);
}

const WEATHER_SOURCES = new Set(['fmi', 'openmeteo', 'husdata-h66', 'mqtt-temperature', 'simulation']);

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
  if (!envelope) return;
  let previous = null;
  for (const interval of intervals) {
    const start = Math.max(envelope.contextFrom ?? envelope.from, interval.start),
      end = Math.min(envelope.contextTo ?? envelope.to, interval.end);
    if (end <= start || !Number.isFinite(interval[key])) continue;
    if (previous && start > previous) { envelope.add(previous, null); envelope.add(start - 1, null); }
    const metadata = { intervalStart: interval.start, intervalEnd: interval.end,
      ...(['outdoorC', 'solarRadiationWm2'].includes(key) ? weatherPointMetadata(interval, key === 'solarRadiationWm2')
        : key === 'totalCtPerKwh' ? { assumedPrice: interval.assumedPrice === true } : {}) };
    envelope.add(start, interval[key], metadata);
    envelope.add(end - 1, interval[key], metadata);
    previous = end;
  }
}


function* mergedHistoryRows(store, nativeRows, from, to, requested, now) {
  // Read the canonical import once instead of expanding five/six observations
  // across the JS boundary. The importer owns parsing and quality semantics.
  function* imported() {
    const query = store.db.prepare(`SELECT r.canonical,r.source_time,r.row_number,i.id,i.kind,i.started_at
      FROM import_rows r JOIN imports i ON i.id=r.import_id
      WHERE i.status='complete' AND i.completed_at<=? AND i.kind IN (${requested.has('property_current_l1') ? "'stmq','easee'" : "'stmq'"}) AND r.source_time>=? AND r.source_time<?
      ORDER BY r.source_time,i.id,r.row_number`);
    for (const original of query.iterate(now, from, to)) {
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
  const until = Math.min(cutoff, now + 1, range.to);
  if (until <= range.from - 30 * 60_000) return;
  const compact = input !== 'simulated' && range.to - range.from > 7 * DAY;
  const native = store.db.prepare(`SELECT o.* FROM observations o INDEXED BY observations_time
    LEFT JOIN imports i ON i.id=o.import_id WHERE o.source_time>=? AND o.source_time<?
    AND o.signal IN ('ev1_current_l1','ev1_current_l2','ev1_current_l3')
    AND o.received_at<=? AND (o.import_id IS NULL OR i.status='complete' AND i.completed_at<=?)
    AND ${input === 'simulated' ? "o.source='simulation'" : "o.source<>'simulation'"}
    ${compact ? 'AND o.import_id IS NULL' : ''}
    ORDER BY o.source_time,o.id`).iterate(range.from - 30 * 60_000, until, now, now);
  const rows = compact ? mergedHistoryRows(store, native, range.from - 30 * 60_000, until, new Set(PHASES), now) : native;
  const flagsOf = qualityReader(); let at = null, groups = new Map();
  const flush = () => {
    const candidates = [...groups.values()].sort((a, b) => b.priority - a.priority || b.id - a.id);
    if (candidates.length) {
      const values = candidates[0].values;
      timing.add('charger1', at, values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) * 0.23 : null,
        { key: input === 'simulated' ? 'simulated' : 'currents' });
    }
    groups = new Map();
  };
  for (const row of alignEaseePowerSnapshots(rows, store.db, now)) {
    if (at !== null && row.source_time !== at) flush();
    at = row.source_time;
    if (row.imported) {
      if (row.kind !== 'easee') continue;
      const values = JSON.parse(row.canonical).slice(0, 3).map(observation =>
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
  // Finish snapshots at the exact recorded-energy handover, without double
  // counting or dependence on chart decimation.
  timing.add('charger1', Math.min(until, now, range.to), null);
}

/** Combined chart query. This deliberately never calls providers, reads options,
 * writes history, or turns phase-current estimates into electricity metering. */
export function getChartData({ store, input = 'offline', contract = null, market = null, weather = null,
  simulated = null, now = Date.now(), startDate, endDate, left, view, points = 800, viewFrom, viewTo,
  _relatedTimes, _relatedSignals, _priceProjection }) {
  const started = performance.now();
  const { range, selection, detail } = chartRequestRange({ startDate, endDate, now, viewFrom, viewTo });
  const projecting = Array.isArray(_relatedTimes), drawingOnly = detail || projecting;
  const selectedView = view !== undefined && Object.hasOwn(CHART_VIEW_BY_KEY, view) ? CHART_VIEW_BY_KEY[view] : null;
  if (view !== undefined && left !== undefined) throw new TypeError('Choose either a chart view or a historical series.');
  if (view !== undefined && !selectedView) throw new TypeError('Unknown chart view');
  left ??= 'power';
  if (!selectedView && !Object.hasOwn(HISTORY_AXIS_BY_KEY, left)) throw new TypeError('Unknown left axis');
  if (!Number.isInteger(points) || points < 100 || points > 2000) throw new RangeError('Chart points must be 100–2000');
  if (!['simulated', 'providers', 'mqtt', 'offline'].includes(input)) throw new TypeError('Unknown chart input');
  let rates = null;
  if (contract && (!projecting || _priceProjection)) { rates = validateContract(contract); if (rates.mode !== 'billing') throw new TypeError('Historical charts require dated billing rates'); }
  const leftNames = selectedView ? [...new Set([...selectedView.leftSignals, ...selectedView.rightSignals,
    ...selectedView.tracks.filter(name => Object.hasOwn(HISTORY_AXIS_BY_KEY, name))])]
    : HISTORY_AXIS_BY_KEY[left].signals;
  const names = projecting ? _priceProjection ? ['all_in_price', 'spot_price'] : _relatedSignals ?? leftNames
    : [...new Set([...(selectedView ? [] : [...TEMPERATURES, 'model_indoor_temperature', 'outdoor_forecast']),
      'all_in_price', 'spot_price', ...leftNames])];
  const powerNames = ['property_power', 'auxiliary_power', 'charger_power', 'charger2_power'].filter(name => names.includes(name));
  const phaseNames = ['property', 'ev1', 'ev2'].flatMap(prefix => [1, 2, 3].map(phase => `${prefix}_current_l${phase}`)).filter(name => names.includes(name));
  const aggregatePower = powerNames.some(name => ['property_power', 'charger_power'].includes(name));
  const selectedHas = candidates => leftNames.some(name => candidates.includes(name));
  const envelopes = Object.fromEntries(names.map(name => [name, projecting
    ? new RelatedStepSampler(range.from, range.to, _relatedTimes)
    : detail && isInterpolatedTemperature(name)
      ? new TemperatureEnvelope(range.from, range.to, points, Math.max(selection.from, range.from - 3 * HOUR), Math.min(selection.to, range.to + 3 * HOUR))
      : new Envelope(range.from, range.to, points)]));
  if (_priceProjection) for (const envelope of Object.values(envelopes)) envelope.mask = _priceProjection.marketIntervals;
  const lines = Object.fromEntries(names.map(name => [name, new HistoryLine(envelopes[name], LEARNING.includes(name) || DOOR_SIGNALS.includes(name) ? Infinity : name === 'auxiliary_power' ? H66_MAX_AGE_MS : /power|current|integral|solar/.test(name) ? 30 * 60_000 : 3 * HOUR, ['auxiliary_power', 'solar_radiation', ...DOOR_SIGNALS].includes(name), detail,
    name.endsWith('_price') || leftNames.includes(name) && name !== 'heating_integral' && !isInterpolatedTemperature(name) && !ENERGY_SIGNALS.includes(name), COUNTER_SIGNALS.includes(name))]));
  const evidenceLines = Object.fromEntries(names.filter(name => RECORDED_EVIDENCE_SIGNALS.includes(name))
    .map(name => [name, new RecordedEvidenceLine(envelopes[name], range, now)]));
  // Following samples close clipped scalar segments, including a viewport
  // narrower than their source cadence. Context never crosses selected dates.
  const queryTo = Math.min(detail ? Math.min(selection.to, range.to + 3 * HOUR) : range.to, now + 1);
  const shading = Object.fromEntries(['heatOff', 'compressorGarage', 'dhwr', 'fireplace'].map(key => [key, new ShadeEnvelope(range, points)])), warnings = [];
  // Daily outcomes retain their selected calendar-day meaning at every zoom.
  // Only their selected series needs this calculation on detail requests.
  const firewoodRange = detail && selectedHas(FIREWOOD_OUTCOME_NAMES) ? { ...range,
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
  const energyStarts = Object.fromEntries(['property','ev1'].map(prefix=>[prefix,recordedEnergyStart(store,prefix,input,now)]));
  if (!drawingOnly) addHistoricalChargerTiming(store, timing, range, now, input, energyStarts.ev1);
  const modeEnvelopes = Object.fromEntries([0, 1, 2, 3, 4].map(mode => [mode, new ShadeEnvelope(range, points)]));
  const compressorHomeEnvelopes = Object.fromEntries([0, 1, 2, 3].map(value => [value, new ShadeEnvelope(range, points)]));
  let telemetry = new Map(), previousTelemetryAt = null;
  const learningMetadata = {};
  const requested = new Set(projecting && _priceProjection ? ['spot_price']
    : [...names.filter(name => !Object.hasOwn(GARAGE_INPUT_INFO, name) && !Object.hasOwn(GARAGE_COEFFICIENT_INFO, name) && !Object.hasOwn(GARAGE_OUTCOME_INFO, name) && !Object.hasOwn(MODEL_INPUT_INFO, name) && !Object.hasOwn(MODEL_COEFFICIENT_INFO, name) && !Object.hasOwn(SESSION_CHECK_INFO, name) && !AUDIT_SIGNALS.includes(name) && !FIREWOOD_OUTCOME_NAMES.includes(name) && !['caravan_energy', 'caravan_power', 'property_power', 'charger2_power', 'heat_pump_power', 'outdoor_forecast', 'solar_forecast', 'all_in_price', ...ENERGY_SIGNALS].includes(name)),
      ...(aggregatePower ? PHASES : []),
      ...(!projecting ? ['garage_compressor_active', 'spot_price', 'requested_heat_mode', 'auxiliary_output', ...H66_SIGNALS] : []),
      ...(names.includes('auxiliary_power') ? ['auxiliary_output'] : [])]);
  const compactImports = input !== 'simulated' && range.to - range.from > 7 * DAY;
  const columns = `o.id,o.source,o.device,o.signal,o.value,o.unit,o.source_time,o.received_at,
    json_extract(o.raw,'$.reportIntervalMs') AS report_interval_ms,
    o.quality,o.import_id,o.row_number,CASE WHEN o.signal IN ('heat_pump_power','charger_power','solar_radiation','auxiliary_output','compressor_active','dhw_routing','operating_mode','controller_phase','dhwr_request',${[...LEARNING, ...RECORDED_EVIDENCE_SIGNALS].map(name => `'${name}'`).join(',')}) THEN o.raw END AS raw`;
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
          AND ${sourceScope} AND o.received_at<=? AND (o.import_id IS NULL OR i.status='complete' AND i.completed_at<=?)
          AND COALESCE(json_extract(o.raw,'$.recorder.status'),'fresh')='fresh'
          ORDER BY o.source_time,o.id`);
        const iterator=query.iterate(signal,range.from-3*HOUR,queryTo,now,now);
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
  let previousHeat = null, pendingPulse = null, pendingPhase = null;
  const flushPhase = (until, final = false) => {
    if (!pendingPhase) return;
    const { start, end, value } = pendingPhase;
    const a = Math.max(start, range.from), b = Math.min(end, until, now, range.to);
    if (envelopes.controller_phase && b > a) {
      const metadata = { source: 'controller', requested: true, basis: 'recorded-request',
        observedAt: start, intervalStart: start, intervalEnd: b };
      envelopes.controller_phase.add(a, value, metadata);
      envelopes.controller_phase.add(b - 1, value, metadata);
      if (final || b < until) envelopes.controller_phase.add(b, null);
    }
    pendingPhase = null;
  };
  const flushPulse = () => {
    if (!pendingPulse) return;
    const { start, end } = pendingPulse, until = Math.min(end, now, range.to);
    shading.dhwr.add(start, until);
    if (envelopes.dhwr_request && until > Math.max(start, range.from)) {
      const metadata = { source: 'controller', requested: true, basis: 'recorded-request',
        observedAt: start, intervalStart: start, intervalEnd: until };
      envelopes.dhwr_request.add(Math.max(start, range.from), 1, metadata);
      envelopes.dhwr_request.add(until - 1, 1, metadata);
      envelopes.dhwr_request.add(until, null);
    }
    pendingPulse = null;
  };
  const verified = row => {
    if (input === 'simulated' && row.source === 'simulation') return true;
    try { const raw = JSON.parse(row.raw); return row.source === 'husdata-h66' && Boolean(raw?.verified) && raw?.usableForControl !== false; } catch { return false; }
  };
  const verifiedState = row => {
    if (!verified(row) || row.unit !== 'state'
      || !(row.flags ?? flagsOf(row.quality)).every(flag => ['good', 'simulated'].includes(flag))) return false;
    try {
      const raw = JSON.parse(row.raw);
      return raw?.retained !== true && raw?.cached !== true && !raw?.acquisitionOnly && !raw?.auditOnly;
    } catch { return false; }
  };
  const flushTelemetry = until => {
    if (previousTelemetryAt === null || until <= previousTelemetryAt) return;
    const compressor = telemetry.get('compressor_active'), route = telemetry.get('dhw_routing'), mode = telemetry.get('operating_mode');
    const compressorEnd = Math.min(until, now, compressor?.until ?? compressor?.at + H66_MAX_AGE_MS);
    if (compressor?.value === 0) compressorHomeEnvelopes[0].add(previousTelemetryAt, compressorEnd);
    else if (compressor?.value === 1) {
      // Routing has its own deadline. A fresh running compressor remains known
      // after routing expires, but cannot be assigned to either heating circuit.
      const routeEnd = [0, 1].includes(route?.value)
        ? Math.min(compressorEnd, route.until ?? route.at + H66_MAX_AGE_MS) : previousTelemetryAt;
      if (routeEnd > previousTelemetryAt) compressorHomeEnvelopes[route.value === 1 ? 2 : 1].add(previousTelemetryAt, routeEnd);
      compressorHomeEnvelopes[3].add(Math.max(previousTelemetryAt, routeEnd), compressorEnd);
    }
    if (modeEnvelopes[mode?.value]) modeEnvelopes[mode.value].add(previousTelemetryAt, Math.min(until, mode.until ?? mode.at + H66_MAX_AGE_MS));
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
      const coverageMetadata = row.periodicCoverage || row.sourceCoverage ? { source: row.source,
        ...(row.periodicCoverage ? {periodicCoverage:true} : {sourceCoverage:true}),displayBoundary:true,
        observedAt:row.observedAt,reportExpiresAt:row.reportExpiresAt,coverageId:row.coverageId } : undefined;
      if (evidenceLines[signal]) { evidenceLines[signal].add(row, value); continue; }
      if (signal === 'garage_compressor_active' && value === 1 && row.periodicCoverage && Number.isFinite(row.reportExpiresAt))
        shading.compressorGarage.add(time, Math.min(row.reportExpiresAt, now));
      if (signal === 'charger_power' && time >= energyStarts.ev1) continue;
      if (PHASES.includes(signal) && time >= energyStarts[signal.startsWith('ev1')?'ev1':'property']) continue;
      if (signal === 'requested_heat_mode' && row.import_id != null) addState(row, value, 'heat');
      else if (signal === 'dhwr_request' && row.source === 'controller' && row.device === input && value === 0) {
        if (pendingPulse) { pendingPulse.end = Math.min(pendingPulse.end, time); flushPulse(); }
      }
      else if (signal === 'dhwr_request' && row.source === 'controller' && row.device === input && value === 1) {
        let end = null;
        try { const raw = JSON.parse(row.raw); if (Number.isFinite(raw?.expiresAt)) end = Math.min(time + 60 * 60_000, raw.expiresAt); } catch { /* Unsupported native request. */ }
        if (end > time) {
          if (pendingPulse && time > pendingPulse.end) flushPulse();
          pendingPulse = pendingPulse ? { start: pendingPulse.start, end: Math.max(end, pendingPulse.end) } : { start: time, end };
        }
      }
      else if (signal === 'controller_phase' && row.source === 'controller' && row.device === input) {
        flushPhase(time);
        let until = time;
        try { const raw = JSON.parse(row.raw); if (Number.isFinite(raw?.expiresAt) && raw.expiresAt > time) until = raw.expiresAt; } catch { /* Unsupported native request. */ }
        const current = until > time ? value : null;
        // Request duration comes from its own expiry, not a scalar sample gap.
        envelopes[signal]?.add(time, current);
        if (Number.isFinite(current)) pendingPhase = { start: time, end: until, value: current };
        telemetry.set(signal, { at: time, value: current, until });
      }
      else if (['compressor_active', 'dhw_routing', 'operating_mode'].includes(signal)) {
        lines[signal]?.add(time, value, coverageMetadata);
        telemetry.set(signal, { at: time, value: verifiedState(row) ? value : null,
          ...(row.sourceCoverage ? {until:row.reportExpiresAt} : {}) });
      } else if (signal === 'auxiliary_output') {
        lines[signal]?.add(time, value, coverageMetadata);
        if (!atRows.has('auxiliary_power') && lines.auxiliary_power) {
          let kw = null;
          try { const raw = JSON.parse(row.raw), capacity = raw?.ratedPowerKw;
            if (verified(row) && Number.isFinite(capacity) && capacity > 0) kw = auxiliaryPowerFromOutput(value, capacity)?.kw ?? null;
          } catch { /* Never assume installed heater capacity. */ }
          lines.auxiliary_power.add(time, kw, coverageMetadata);
        }
      } else {
        let metadata;
        if (DOOR_SIGNALS.includes(signal)) {
          let raw; try { raw = JSON.parse(row.raw); } catch { /* Optional telemetry basis. */ }
          metadata = { source: row.source, estimated: raw?.estimated === true, basis: raw?.basis, learningRole: 'history-only' };
          if (DOOR_SIGNALS.includes(signal)) Object.assign(metadata, { basis: 'last-reported-state', lastReported: true,
            observedAt: raw?.recorder?.originalSourceTime ?? row.source_time });
        }
        if (signal === 'outdoor_temperature') metadata = weatherPointMetadata(row);
        if (signal === 'solar_radiation') {
          let raw;
          try { raw = JSON.parse(row.raw); } catch { /* Missing current provenance remains unavailable. */ }
          metadata = weatherPointMetadata({ source: row.source, solar: raw && typeof raw === 'object' ? raw : {} }, true);
        }
        if (coverageMetadata) metadata = { ...metadata, ...coverageMetadata };
        if (signal !== 'charger_power') lines[signal]?.add(time, value, metadata);
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
    if (aggregatePower) {
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
  const historyRows = compactImports ? mergedHistoryRows(store, nativeRows, range.from - 3 * HOUR, queryTo, requested, now) : nativeRows;
  function* rowsWithPreviousReadings() {
    const earlier = [];
    // Door contacts report changes rather than a sampling cadence. An indexed
    // prior state seeds historical days too; explicit outage coverage still
    // interrupts it, and the original report time accompanies the held line.
    for (const signal of leftNames.filter(name => DOOR_SIGNALS.includes(name) || RECORDED_EVIDENCE_SIGNALS.includes(name))) {
      const seed = store.db.prepare(`SELECT ${columns} FROM observations o LEFT JOIN imports i ON i.id=o.import_id
        WHERE o.signal=? AND o.source_time<? AND ${sourceScope}
        AND o.received_at<=? AND (o.import_id IS NULL OR i.status='complete' AND i.completed_at<=?) ORDER BY o.source_time DESC,o.id DESC LIMIT 1`)
        .get(signal, range.from - 3 * HOUR, now, now);
      if (seed) earlier.push(seed);
    }
    // Learned estimates remain in effect until superseded, including past-day
    // views. A seed retains its original timestamp and never backdates learning.
    for (const signal of leftNames.filter(name => LEARNING.includes(name))) {
      const seed = store.db.prepare(`SELECT ${columns} FROM observations o WHERE o.signal=? AND o.source_time<?
        AND o.source='controller-learning' AND o.device=? AND o.received_at<=? ORDER BY o.source_time DESC,o.id DESC LIMIT 1`).get(signal, range.from - 3 * HOUR, input, now);
      if (seed) earlier.push(seed);
    }
    const phaseSeed = store.db.prepare(`SELECT ${columns} FROM observations o WHERE o.signal='controller_phase'
      AND o.source='controller' AND o.device=? AND o.source_time<? AND o.received_at<=? ORDER BY o.source_time DESC,o.id DESC LIMIT 1`)
      .get(input, range.from - 3 * HOUR, now);
    if (phaseSeed) earlier.push(phaseSeed);
    if (range.from <= now && now < range.to) {
      // A sensor can stay unchanged for days. Seed live plots with its latest
      // prior reading, including invalid readings so they cannot revive old data.
      // Indexed lookups avoid expanding the selected history scan indefinitely.
      const signals = [...new Set([...TEMPERATURES.filter(name => names.includes(name)),
        ...(names.includes('heating_integral') ? ['heating_integral'] : []), ...(aggregatePower ? PHASES : phaseNames)])];
      const latest = store.db.prepare(`SELECT o.source_time FROM observations o INDEXED BY observations_signal_time
        LEFT JOIN imports i ON i.id=o.import_id WHERE o.signal=? AND o.source_time<?
        AND ${sourceScope} AND o.received_at<=? AND (o.import_id IS NULL OR i.status='complete' AND i.completed_at<=?)
        ORDER BY o.source_time DESC,o.id DESC LIMIT 1`);
      const times = new Set(signals.map(signal => latest.get(signal, range.from - 3 * HOUR, now, now)?.source_time).filter(Number.isFinite));
      const seeds = store.db.prepare(`SELECT ${columns} FROM observations o INDEXED BY observations_time
        LEFT JOIN imports i ON i.id=o.import_id WHERE o.source_time=?
        AND o.signal IN (${signals.map(() => '?').join(',')}) AND ${sourceScope}
        AND o.received_at<=? AND (o.import_id IS NULL OR i.status='complete' AND i.completed_at<=?) ORDER BY o.id`);
      // Keep complete acquisition cohorts and normal duplicate/source precedence.
      for (const at of times) earlier.push(...seeds.iterate(at, ...signals, now, now));
    }
    yield* earlier.sort((a, b) => a.source_time - b.source_time || a.id - b.id);
    yield* historyRows;
  }
  const rows = mergeCoverageRows(rowsWithPreviousReadings(),store,{from:range.from-3*HOUR,to:queryTo,input,signals:requested,now});
  for (const row of aggregatePower ? alignEaseePowerSnapshots(rows, store.db, now) : rows) {
    if (!isRecordedDataset(row)) continue;
    // Counters are source observations, never held coverage. Native garage
    // counters have a reporting deadline too, but its drawing endpoints are
    // not additional meter readings and cannot replace the original record.
    if (COUNTER_SIGNALS.includes(row.signal) && row.coverage) continue;
    // Periodic reports have their own explicit availability projection, including
    // unchanged spans beginning before the normal three-hour context query.
    if (!row.coverage && row.import_id == null && row.report_interval_ms>0 && !COUNTER_SIGNALS.includes(row.signal)) continue;
    if (row.imported) {
      if (time !== null && time !== row.source_time) flushTime();
      time = row.source_time;
      const decoded = { observations: JSON.parse(row.canonical) };
      if (row.kind === 'easee' && aggregatePower) {
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
    if (['controller_phase', 'dhwr_request'].includes(row.signal) && (row.source !== 'controller' || row.device !== input)) continue;
    const flags = row.flags ?? flagsOf(row.quality), value = valueOf(row, flags);
    if (value === null) invalidRows++;
    if (aggregatePower && PHASES.includes(row.signal)) {
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
  flushPhase(Math.min(now, range.to), true);
  for (const line of Object.values(evidenceLines)) line.flush();
  flushPulse();
  if (Number.isFinite(energyStarts.ev1)) timing.add('charger1',energyStarts.ev1,null);
  const recordedEnergy = !drawingOnly || names.some(name => ENERGY_SIGNALS.includes(name) || PHASES.includes(name)
    || ['property_power', 'charger_power', 'charger2_power', 'caravan_power'].includes(name))
    ? addRecordedEnergy({store,range,now,input,envelopes,timing}) : { rows: 0, intervals: 0 };
  const finishHeldLines = () => {
    for (const name of ['auxiliary_power', 'solar_radiation', ...DOOR_SIGNALS]) if (lines[name]?.previous) {
      const line = lines[name], previous = line.previous, nowEnd = Math.min(now, range.to), end = Math.min(nowEnd, previous.x + line.gap);
      const metadata = DOOR_SIGNALS.includes(name) ? { ...previous, displayBoundary: true,
        observedAt: previous.observedAt ?? previous.x, interpolated: false } : previous;
      if (previous.x < range.from && end >= range.from) envelopes[name].add(range.from, previous.y, metadata);
      if (previous.x < end) envelopes[name].add(end, previous.y, metadata);
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
  const modelInputs = addModelInputs({ store, range, now, input, envelopes,
    indoorLine: detail ? lines.model_indoor_temperature : undefined });
  const garageHistory = addGarageHistory({ store, range, now, input, envelopes, referenceRange: detail ? selection : range });
  const modelCoefficients = addModelCoefficients({ store, range, now, input, envelopes });
  const fireplaceInputs = addFireplaceInputs({ store, range, now, input, envelopes, shading });
  const needsFirewood = !detail || selectedHas(FIREWOOD_OUTCOME_NAMES);
  const outlookForFirewood = !needsFirewood ? {} : input === 'simulated' ? simulated ?? {} : assembleOutlook(market, weather, contract, now);
  const firewood = needsFirewood ? getFirewoodBenefit({ store, input, range: firewoodRange, now,
    priceIntervals: priced.map(row => ({ ...row, price: row.totalCtPerKwh })),
    futureIntervals: !detail && range.from <= now && range.to > now
      ? forecastIntervals(outlookForFirewood.prices, outlookForFirewood.forecast, Math.floor(now / 900_000) * 900_000) : [] }) : null;
  const firewoodOutcomes = firewood ? addFirewoodOutcomes({ result: firewood, range: firewoodRange, now, envelopes }) : null;
  if (selectedHas(FIREPLACE_INPUT_NAMES) && fireplaceInputs.loggingStartedAt === null)
    warnings.push('No fireplace logging exists for this input source. Earlier unlogged periods are unknown.');
  if (selectedHas(FIREWOOD_OUTCOME_NAMES)) {
    warnings.push('Firewood savings are retrospective model estimates of avoided space-heating electricity, with free wood. They are separate from timing-cost comparisons.');
    if (firewood.summary.status === 'unavailable') warnings.push(firewood.summary.reason ?? 'Firewood savings need usable heating observations and prices.');
  }
  if (leftNames.some(name => Object.hasOwn(MODEL_INPUT_INFO, name) && !FIREPLACE_INPUT_NAMES.includes(name)) && !modelInputs.records) warnings.push('No saved learning inputs exist for these dates and input source. Recording sensor values alone does not create learning-input history.');
  if (leftNames.some(name => Object.hasOwn(MODEL_COEFFICIENT_INFO, name))) {
    if (!leftNames.some(name => Object.hasOwn(MODEL_COEFFICIENT_INFO, name) && envelopes[name].values().some(point => Number.isFinite(point.y)))) warnings.push('No reconstructable model coefficients exist for these dates and input source.');
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
  const relatedGroups = [...(powerNames.length > 1 ? [powerNames] : []), ...(phaseNames.length > 1 ? [phaseNames] : []), ['all_in_price', 'spot_price']];
  for (const group of relatedGroups) if (group.some(name => envelopes[name].count > series[name].length)) {
    const compositeTimes = group === powerNames && aggregatePower ? powerExtremaTimes({ store,range,now,input,
      points,readValue:valueOf }) : [];
    const times = [...new Set([...group.flatMap(name => series[name].map(point => point.x)),...compositeTimes])].sort((a, b) => a - b);
    const priceGroup = group[0] === 'all_in_price';
    const projected = getChartData({ store, input, contract, now, startDate, endDate, ...(view === undefined ? { left } : { view }), points, viewFrom, viewTo,
      _relatedTimes: times, _relatedSignals: group, ...(priceGroup ? { _priceProjection: { marketIntervals, priced } } : {}) });
    Object.assign(series, alignRelatedSamples(projected.series));
    relatedSampling ??= { basis: 'shared-original-step-times', groups: [], times: 0, sourceRows: 0,
      description: 'Related channels share selected original step times; held display points retain their original source timestamp and interval. Omitted missing runs remain disconnected.' };
    relatedSampling.groups.push(group); relatedSampling.times += times.length;
    relatedSampling.sourceRows += projected.rawRows + projected.energyRows;
  }
  priceAssumptions.used ||= series.all_in_price.some(point => Number.isFinite(point.y) && point.assumedPrice);
  for (const key of Object.keys(shading)) shading[key] = shading[key].values();
  shading.compressorHome = Object.entries(compressorHomeEnvelopes)
    .flatMap(([value, envelope]) => envelope.values().map(row => ({ ...row, value: Number(value) })))
    .sort((a, b) => a.start - b.start || a.value - b.value);
  if (Object.values(shading).some(rows => rows.some(row => row.aggregated))) warnings.push('Dense shading shows the occupied fraction of each display interval.');
  // These are original source timestamps, even when outside the visible range.
  // Only the browser draws carry-forward tails; no synthetic readings are stored.
  const lastReadings = Object.fromEntries([...TEMPERATURES,
    ...leftNames]
    .filter(name => lines[name]?.previous).map(name => [name, { ...lines[name].previous }]));
  if (selectedHas(LEARNING)) warnings.push('Learning history records estimates when assessed. Gaps mean no recorded estimate; auxiliary recovery metrics exclude cycles whose auxiliary state was unknown.');
  const operatingModes = Object.entries(modeEnvelopes).flatMap(([value, envelope]) => envelope.values().map(row => ({ ...row, value: Number(value) }))).sort((a, b) => a.start - b.start);
  const timingBenefit = detail ? null : timing.result();
  const heatingBenefit = detail ? null : getHeatingBenefit({ store, input, range, now });
  const heatingSavings = detail ? null : buildHeatingSavings({ range, now,
    homeModel: heatingBenefit, homeTiming: timingBenefit.heatPump,
    garageModel: getGarageModelBenefit({ store, input, range, now }),
    garageTiming: getGarageTimingBenefit({ store, input, range, now, prices: priced }) });
  return { range, now, input, ...(view === undefined ? { left } : { view }), series, shading, operatingModes,
    ...(detail ? { selection } : { timingBenefit, heatingBenefit, heatingSavings, firewoodBenefit: firewood.summary }),
    meta: { ...(detail ? { detail: true } : {}), ...(relatedSampling ? { relatedSampling } : {}), warnings, priceAssumptions, rawRows, invalidRows, lastReadings, learning: learningMetadata, modelInputs, modelCoefficients, garageHistory, fireplaceInputs, firewoodOutcomes, recordedEnergy, chargingSessions, heatPumpEnergy, historyBasis: 'original-recorded-history',
    returnedPoints: Object.values(series).reduce((sum, rows) => sum + rows.length, 0),
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    powerEstimate: powerNames.length ? 'Recorded phase or total energy divided by its interval duration; coherent current snapshots, including v0.7.5 CSV imports, use 230 V. Phase allocation and energy integration are estimates.' : null,
    heatOffBasis: 'Historical requested reduction, not compressor activity.',
    auxHeatBasis: 'Estimated kW from H66 auxiliary output and configured capacity; cumulative counters do not identify episodes.',
    dhwrBasis: 'Requested circulation with its recorded duration; v0.7.5 CSV requests last ten minutes. MQTT acknowledgement is not physical pump feedback. Recorded electrical or switch feedback is shown separately and does not prove water flow.',
    fireplaceBasis: 'Corrected manual additions over the model burn timescale; heat release continues afterward.',
    decimation: 'Original recorded history, reduced in memory for display: first, last, minimum, maximum and missing-data breaks per time bucket. Costs use original energy intervals independently of drawing points.' } };
}
