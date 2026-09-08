import { auxiliaryPowerFromOutput } from '../domain/telemetry.js';

export const HEAT_PUMP_CONFIG_EVENT = 'heat-pump-power-config';
const AGE = 5 * 60_000, HOUR = 3_600_000;
const SIGNALS = ['compressor_active', 'auxiliary_output'];
const CONFIG_KEYS = ['heatPumpCompressorKw', 'circulationKw', 'auxRatedKw'];
const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

function powerConfiguration(value) {
  if (value?.version !== 1 || CONFIG_KEYS.some(key => !Number.isFinite(value[key]) || value[key] < 0)
    || value.heatPumpCompressorKw <= 0 || value.auxRatedKw <= 0) return null;
  return value;
}

/** Nominal assumptions are historical data, rather than today's settings applied
 * to old readings. One immutable event per change; the small state is only a
 * restart-safe deduplication marker. No model estimate is captured here. */
export function recordHeatPumpConfiguration(store, input, config, at) {
  if (input === 'offline') return;
  const value = { input, version: 1, ...Object.fromEntries(CONFIG_KEYS.map(key => [key, config[key]])) };
  if (!powerConfiguration(value)) throw new TypeError('Invalid historical heat-pump power assumptions');
  const key = `heat-pump-power-config:${input === 'simulated' ? 'simulated' : 'physical'}`;
  if (JSON.stringify(store.getState(key)) === JSON.stringify(value)) return;
  store.transaction(() => {
    store.event(HEAT_PUMP_CONFIG_EVENT, value, at);
    store.setState(key, value);
  });
}

function* configurations(db, from, to, input) {
  const scope = input === 'simulated' ? "json_extract(payload,'$.input')='simulated'"
    : "json_extract(payload,'$.input') IN ('mqtt','providers')";
  const previous = db.prepare(`SELECT id,at,payload FROM events WHERE type=? AND at<=? AND ${scope}
    ORDER BY at DESC,id DESC LIMIT 1`).get(HEAT_PUMP_CONFIG_EVENT, from);
  if (previous) yield { at: from, config: powerConfiguration(parse(previous.payload, null)), configId: previous.id };
  for (const row of db.prepare(`SELECT id,at,payload FROM events WHERE type=? AND at>? AND at<? AND ${scope}
    ORDER BY at,id`).iterate(HEAT_PUMP_CONFIG_EVENT, from, to))
    yield { at: row.at, config: powerConfiguration(parse(row.payload, null)), configId: row.id };
}

function reading(row, at, until, status = 'fresh') {
  const raw = parse(row.raw, {}), flags = parse(row.quality, ['missing']);
  const trusted = row.source === 'simulation' || row.source === 'husdata-h66'
    && raw?.verified && raw?.usableForControl === true && raw?.retained !== true && raw?.cached !== true;
  const valid = trusted && status === 'fresh' && !raw?.acquisitionOnly && !raw?.auditOnly
    && Array.isArray(flags) && flags.every(flag => ['good', 'simulated'].includes(flag))
    && Number.isFinite(row.value) && Number.isFinite(until) && until > at
    && (row.signal === 'compressor_active' ? row.unit === 'state' && row.value >= 0 && row.value <= 1
      && (row.source === 'simulation' || Number.isInteger(row.value)) : row.unit === '%' && row.value >= 0 && row.value <= 100);
  return { at, until, signal: row.signal, device: `${row.source}:${row.device}`,
    value: valid ? row.value : null, observationId: row.observation_id ?? row.id, coverageId: row.coverage_id ?? null };
}

/** Bounded SQL iterators, not a separate query for every reconstructed interval.
 * Coverage carries the saved value while fresh acquisitions confirm it. It never
 * exposes discarded acquisition values or extends an old source clock forever. */
function* observations(db, signal, from, to, input, now) {
  const source = input === 'simulated' ? 'simulation' : 'husdata-h66';
  for (const row of db.prepare(`SELECT id,source,device,signal,value,unit,source_time,received_at,quality,raw
    FROM observations WHERE signal=? AND source=? AND source_time>=? AND source_time<? AND received_at<=?
    AND import_id IS NULL AND COALESCE(json_extract(raw,'$.recorder.status'),'fresh')='fresh'
    ORDER BY source_time,id`).iterate(signal, source, from - AGE, to, now))
    yield reading(row, row.source_time, Math.min(row.source_time, row.received_at) + AGE);
}

function* coverage(db, signal, from, to, input, now) {
  const source = input === 'simulated' ? 'simulation' : 'husdata-h66';
  for (const row of db.prepare(`SELECT c.id AS coverage_id,c.source,c.device,c.signal,c.status,c.start_at,c.end_at,
    c.source_time AS confirmed_at,c.observation_id,o.value,o.unit,o.quality,o.raw
    FROM recorder_coverage c LEFT JOIN observations o ON o.id=c.observation_id
    WHERE c.signal=? AND c.source=? AND c.end_at>=? AND c.start_at<? AND c.end_at<=?
    AND (o.received_at IS NULL OR o.received_at<=?)
    ORDER BY c.start_at,c.id`).iterate(signal, source, from - AGE, to, now, now)) {
    // Do not use a span whose latest confirmation arrived after the query's now;
    // its compact record cannot prove when the intermediate polls happened.
    const until = Number.isFinite(row.confirmed_at) ? Math.min(row.end_at, row.confirmed_at, now) + AGE : row.start_at;
    yield reading(row, row.start_at, until, row.status);
  }
}

function* merge(iterables) {
  const heads = iterables.map(iterable => {
    const iterator = iterable[Symbol.iterator](); return { iterator, next: iterator.next() };
  }).filter(head => !head.next.done);
  while (heads.length) {
    let index = 0;
    for (let i = 1; i < heads.length; i++) if (heads[i].next.value.at < heads[index].next.value.at) index = i;
    const head = heads[index]; yield head.next.value;
    head.next = head.iterator.next(); if (head.next.done) heads.splice(index, 1);
  }
}

/** Total estimated heat-pump electricity, including DHW operation. Compressor
 * activity multiplies the saved nominal compressor + circulation power; H66
 * auxiliary output uses the same documented nominal-stage calculation as the
 * learner. No learned/live fallback, whole-property subtraction, or request-only
 * DHWR energy is used. Missing either equipment input or historical assumptions
 * leaves a gap. Source/device pairs and simulation remain isolated. */
export function* historicalHeatPumpIntervals({ store, range, now, input }) {
  const end = Math.min(range.to, now);
  if (end <= range.from) return;
  const streams = [configurations(store.db, range.from, end, input),
    ...SIGNALS.map(signal => observations(store.db, signal, range.from, end, input, now)),
    ...SIGNALS.map(signal => coverage(store.db, signal, range.from, end, input, now))];
  const devices = new Map();
  let at = range.from, config = null, configId = null, device = null;
  function* advance(until) {
    while (at < until) {
      const current = devices.get(device), compressor = current?.compressor_active, auxiliary = current?.auxiliary_output;
      const expires = [compressor?.until, auxiliary?.until].filter(value => value > at);
      const next = Math.min(until, ...expires);
      const usable = config && Number.isFinite(compressor?.value) && Number.isFinite(auxiliary?.value)
        && compressor.until > at && auxiliary.until > at;
      const kw = usable ? compressor.value * (config.heatPumpCompressorKw + config.circulationKw)
        + auxiliaryPowerFromOutput(auxiliary.value, config.auxRatedKw).kw : null;
      yield { start: at, end: next, kw, configId,
        quality: kw === null ? 'missing' : input === 'simulated' ? 'simulated-estimate' : 'nominal-power-estimate' };
      at = next;
    }
  }
  for (const event of merge(streams)) {
    if (event.at >= end) break;
    yield* advance(Math.max(range.from, event.at));
    if (Object.hasOwn(event, 'config')) { config = event.config; configId = event.configId; }
    else {
      device = event.device;
      if (!devices.has(device)) devices.set(device, {});
      devices.get(device)[event.signal] = event;
    }
  }
  yield* advance(end);
}

export function addHistoricalHeatPump({ store, range, now, input, envelope, timing }) {
  let intervals = 0, coveredMs = 0;
  for (const row of historicalHeatPumpIntervals({ store, range, now, input })) {
    intervals++;
    const metadata = { estimated: true, basis: row.quality, configurationEventId: row.configId };
    envelope?.add(row.start, row.kw, metadata);
    envelope?.add(row.end - 1, row.kw, metadata);
    if (row.kw !== null) {
      coveredMs += row.end - row.start;
      timing.addEnergy('heatPump', row.start, row.end, row.kw * (row.end - row.start) / HOUR);
    }
  }
  return { intervals, coveredMs, basis: 'Recorded compressor activity and auxiliary output with dated nominal power assumptions',
    configuration: HEAT_PUMP_CONFIG_EVENT, maxSourceAgeMs: AGE,
    gaps: 'Missing, stale or unverified equipment data, or missing dated power assumptions; no model fallback' };
}
