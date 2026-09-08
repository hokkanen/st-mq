import { createHash } from 'node:crypto';
import { restoreAdaptiveCheckpoint, updateAdaptiveLearning, updateAdaptiveEpisode } from '../control/adaptive-learning.js';
import { auxiliaryPowerFromOutput } from '../domain/telemetry.js';

export const LEARNING_ALGORITHM = 'committed-house-v2';
export const LEARNING_WINDOW_MS = 15 * 60_000;
const HOUR = 3_600_000;
const PHASES = ['normal', 'preheat', 'reduction', 'recovery'];
const MODEL_KEYS = ['heatPumpCompressorKw', 'auxRatedKw', 'circulationKw', 'dhwrKw', 'targetC', 'thermalPriors'];
const ALLOWED = new Set(['good', 'simulated', 'historical', 'converted_fahrenheit']);
const readingAge = (row, fallback) => row.source === 'husdata-h66' ? 5 * 60_000 : fallback;

export function learningConfiguration(config = {}) {
  return Object.fromEntries(MODEL_KEYS.filter(key => config[key] !== undefined).map(key => [key, structuredClone(config[key])]));
}
export function learningVersion(value) {
  const canonical = input => Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object'
    ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])])) : input;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function usable(row) {
  return row && Number.isFinite(row.value) && !row.raw?.acquisitionOnly && !row.raw?.auditOnly
    && row.source !== 'controller-estimate'
    && (!row.source.startsWith('husdata') || row.raw?.usableForControl === true && row.raw?.retained !== true)
    && (row.quality ?? []).every(flag => ALLOWED.has(flag)
      || flag === 'estimated' && row.source === 'openmeteo' && row.signal === 'outdoor_temperature');
}

/** Only committed observations and committed coverage are read. A coverage span
 * confirms a held recorded value; it never supplies the discarded poll value.
 * Future publications and coverage ends cannot change a causal window. */
function trajectory(store, signal, from, to, input, maxAge) {
  const outdoor = signal === 'outdoor_temperature' && ['mqtt', 'providers'].includes(input);
  const scope = input === 'simulated' ? "source='simulation'" : outdoor
    ? "source IN ('husdata-h66','fmi','openmeteo')" : "source<>'simulation'";
  const decode = row => ({ id: row.id, source: row.source, device: row.device, signal: row.signal,
    value: row.value, unit: row.unit, sourceTime: row.source_time, receivedAt: row.received_at,
    quality: JSON.parse(row.quality), raw: row.raw ? JSON.parse(row.raw) : null });
  const rows = store.db.prepare(`SELECT * FROM observations WHERE signal=? AND source_time>=? AND source_time<=?
    AND received_at<=? AND ${scope} ORDER BY source_time,id`).all(signal, from - maxAge, to, to).map(decode);
  const coverage = store.db.prepare(`SELECT c.*,c.source_time AS coverage_source_time,o.source,o.device,o.signal,o.value,o.unit,o.source_time,o.received_at,o.quality,o.raw
    FROM recorder_coverage c JOIN observations o ON o.id=c.observation_id
    WHERE c.signal=? AND c.start_at<=? AND c.end_at>=? AND c.end_at<=? AND o.received_at<=?
    AND ${input === 'simulated' ? "o.source='simulation'" : outdoor
      ? "o.source IN ('husdata-h66','fmi','openmeteo')" : "o.source<>'simulation'"}
    ORDER BY c.start_at,c.id`).all(signal, to, from, to, to);
  for (const span of coverage) {
    const observation = decode({ ...span, id: span.observation_id });
    rows.push({ ...observation, sourceTime: Math.max(from, span.start_at), coverageId: span.id,
      coverageEnd: Math.min(span.end_at, span.coverage_source_time) + readingAge(observation, maxAge), value: span.status === 'fresh' ? observation.value : null });
  }
  rows.sort((a, b) => a.sourceTime - b.sourceTime || Number(Boolean(a.coverageId)) - Number(Boolean(b.coverageId)) || a.id - b.id);
  return rows;
}

function windowValues(rows, from, to, maxAge, priority = null) {
  if (priority) return prioritizedWindowValues(rows, from, to, maxAge, priority);
  let current = null, cursor = from, weighted = 0, covered = 0;
  const ids = new Set(), coverageIds = new Set();
  const integrate = end => {
    if (!current || !usable(current)) { cursor = end; return; }
    const until = Math.min(end, current.coverageEnd ?? current.sourceTime + readingAge(current, maxAge));
    const duration = Math.max(0, until - cursor);
    if (duration) { covered += duration; weighted += current.value * duration; ids.add(current.id); if (current.coverageId) coverageIds.add(current.coverageId); }
    cursor = end;
  };
  for (const row of rows) {
    if (row.sourceTime > to) break;
    if (row.sourceTime >= from) integrate(row.sourceTime);
    current = row;
  }
  integrate(to);
  const fresh = current && usable(current) && to <= (current.coverageEnd ?? current.sourceTime + readingAge(current, maxAge));
  if (fresh) { ids.add(current.id); if (current.coverageId) coverageIds.add(current.coverageId); }
  return { value: fresh ? current.value : null, mean: covered === to - from && covered > 0 ? weighted / covered : null,
    covered, ids: [...ids], coverageIds: [...coverageIds], row: fresh ? current : null };
}

function prioritizedWindowValues(rows, from, to, maxAge, priority) {
  const expires = row => row.coverageEnd ?? row.sourceTime + readingAge(row, maxAge);
  const boundaries = [...new Set([from, to, ...rows.flatMap(row => [row.sourceTime, expires(row)])])]
    .filter(at => at >= from && at <= to).sort((a, b) => a - b);
  const current = new Map(), ids = new Set(), coverageIds = new Set();
  let index = 0, weighted = 0, covered = 0, selected = null;
  for (let i = 0; i < boundaries.length; i++) {
    const at = boundaries[i];
    while (index < rows.length && rows[index].sourceTime <= at) {
      const row = rows[index++]; current.set(`${row.source}:${row.device}`, row);
    }
    const endpoint = at === to;
    selected = [...current.values()].filter(row => usable(row) && (endpoint ? expires(row) >= at : expires(row) > at))
      .sort((a, b) => priority.indexOf(a.source) - priority.indexOf(b.source) || b.sourceTime - a.sourceTime || b.id - a.id)[0] ?? null;
    if (!selected) continue;
    ids.add(selected.id); if (selected.coverageId) coverageIds.add(selected.coverageId);
    const duration = (boundaries[i + 1] ?? at) - at;
    covered += duration; weighted += selected.value * duration;
  }
  return { value: selected?.value ?? null, mean: covered === to - from && covered > 0 ? weighted / covered : null,
    covered, ids: [...ids], coverageIds: [...coverageIds], row: selected };
}

function weatherAt(store, from, to) {
  const snapshot = store.latestSnapshot('weather', from);
  if (!snapshot || snapshot.fetchedAt > from || from - snapshot.fetchedAt > 6 * HOUR) return { value: null, version: null };
  let duration = 0, weighted = 0;
  const sources = [];
  for (const row of snapshot.payload.forecast ?? []) {
    const solar = row.solar ?? row;
    const issuedAt = Object.hasOwn(solar, 'issuedAt') ? solar.issuedAt : row.issuedAt ?? snapshot.issuedAt;
    const fetchedAt = Object.hasOwn(solar, 'fetchedAt') ? solar.fetchedAt : row.fetchedAt ?? snapshot.fetchedAt;
    // An unknown model issue time ages from the first saved appearance of
    // this content; repeatedly downloading the same forecast cannot renew it.
    const knownAt = issuedAt ?? Math.min(fetchedAt ?? Infinity, snapshot.contentFirstFetchedAt ?? snapshot.fetchedAt);
    const overlap = Math.max(0, Math.min(to, row.end) - Math.max(from, row.start));
    if (!overlap || !Number.isFinite(row.solarRadiationWm2) || !Number.isFinite(knownAt)
      || knownAt > from || from - knownAt > 6 * HOUR
      || Number.isFinite(fetchedAt) && (fetchedAt > from || from - fetchedAt > 6 * HOUR)) continue;
    duration += overlap; weighted += row.solarRadiationWm2 * overlap;
    sources.push({ source: solar.source ?? row.source ?? snapshot.source, issuedAt: issuedAt ?? null,
      fetchedAt: fetchedAt ?? null, issuedAtBasis: solar.issuedAtBasis ?? row.issuedAtBasis ?? null });
  }
  return { value: duration === to - from && duration > 0 ? weighted / duration : null,
    version: { id: snapshot.id, digest: snapshot.digest ?? null, issuedAt: snapshot.issuedAt, fetchedAt: snapshot.fetchedAt,
      contentId: snapshot.contentId ?? null, contentFirstFetchedAt: snapshot.contentFirstFetchedAt ?? snapshot.fetchedAt,
      solar: sources } };
}

function electricalContext(store, from, to) {
  const result = {};
  for (const prefix of ['property', 'ev1']) {
    const phases = [1, 2, 3].map(phase => {
      let kwh = 0, coveredMs = 0;
      const ids = [];
      for (const row of store.db.prepare(`SELECT id,value,unit,raw FROM observations WHERE signal=?
        AND source_time>=? AND source_time<=? AND received_at<=? ORDER BY source_time,id`)
        .iterate(`${prefix}_energy_l${phase}`, from, to, to)) {
        const raw = row.raw ? JSON.parse(row.raw) : null;
        if (row.unit !== 'kWh' || !Number.isFinite(row.value) || raw?.auditOnly || raw?.acquisitionOnly
          || !Number.isFinite(raw?.intervalStart) || raw.intervalEnd > to
          || raw.intervalEnd <= raw.intervalStart) continue;
        const overlap = Math.max(0, raw.intervalEnd - Math.max(from, raw.intervalStart));
        if (!overlap) continue;
        kwh += row.value * overlap / (raw.intervalEnd - raw.intervalStart); coveredMs += overlap; ids.push(row.id);
      }
      return { kwh: coveredMs ? kwh : null, coveredMs, observations: ids };
    });
    result[prefix] = { phases, complete: phases.every(phase => phase.coveredMs === to - from) };
  }
  return result;
}

/** A UTC-aligned, completed window. Temperature endpoints are paired with the
 * same preceding interval's weather and observed heat input, avoiding a one-bin
 * phase lag. Whole-property electricity is retained only as explanatory context. */
export function committedLearningSample({ store, input, at, config = {}, context = {}, windowMs = LEARNING_WINDOW_MS }) {
  const from = at - windowMs, lineage = {};
  const get = (signal, age = 30 * 60_000) => {
    const priority = signal === 'outdoor_temperature' && ['mqtt', 'providers'].includes(input)
      ? ['husdata-h66', 'fmi', 'openmeteo'] : null;
    const value = windowValues(trajectory(store, signal, from, at, input, age), from, at, age, priority);
    lineage[signal] = { observations: value.ids, coverage: value.coverageIds };
    return value;
  };
  const indoor = get('indoor_temperature'), outdoor = get('outdoor_temperature');
  const compressor = get('compressor_active', 5 * 60_000), route = get('dhw_routing', 5 * 60_000);
  const auxiliary = get('auxiliary_output', 5 * 60_000), integral = get('heating_integral', 5 * 60_000);
  const supply = get('supply_temperature', 5 * 60_000), setpoint = get('heating_setpoint', 5 * 60_000);
  const alarm = get('alarm_active', 5 * 60_000), mode = get('operating_mode', 5 * 60_000);
  const controller = get('controller_phase', 30 * 60_000);
  const radiation = weatherAt(store, from, at);
  const aux = auxiliaryPowerFromOutput(auxiliary.mean, config.auxRatedKw ?? 9);
  const knownRoute = route.mean === 0 || route.mean === 1;
  // Joint attribution needs an unchanged destination throughout this window.
  // Mixed routing keeps total nominal electricity but cannot identify space heat.
  const duty = compressor.mean;
  const auxKw = aux?.kw ?? null;
  const powerKw = Number.isFinite(duty) && Number.isFinite(auxKw)
    ? duty * ((config.heatPumpCompressorKw ?? 3) + (config.circulationKw ?? 0.08)) + auxKw : null;
  const phase = PHASES.includes(context.phase) ? context.phase : 'normal';
  const quality = Number.isFinite(indoor.value) && Number.isFinite(outdoor.mean) && !(alarm.mean > 0) ? [] : ['missing'];
  if (controller.ids.length && Number.isFinite(controller.mean) && !Number.isInteger(controller.mean)) quality.push('mixed-control-phase');
  const sample = { timestamp: at, windowStart: from, windowEnd: at, indoorC: indoor.value, outdoorC: outdoor.mean,
    solarRadiationWm2: radiation.value, phase, roomBoostC: context.roomBoostC ?? 0,
    targetC: context.targetC ?? null, regime: context.regime ?? 'occupied', quality,
    powerKw, compressorPowerKw: config.heatPumpCompressorKw ?? 3, compressorDuty: duty, auxKw,
    thermalCompressorDuty: knownRoute && Number.isFinite(duty) ? (route.mean === 0 ? duty : 0) : null,
    thermalAuxKw: knownRoute && Number.isFinite(auxKw) ? (route.mean === 0 ? auxKw : 0) : null,
    auxRoute: knownRoute ? route.mean === 0 ? 'space' : 'dhw' : 'unknown',
    auxiliaryStage: aux?.stage ?? null, auxiliaryPowerBasis: aux?.basis ?? 'unavailable',
    compressorActivityObserved: Number.isFinite(duty), auxiliaryObserved: Number.isFinite(auxKw), auxiliaryRouteKnown: knownRoute,
    actualModeKnown: Number.isFinite(mode.mean), energyBasis: 'estimated',
    integral: integral.value, supplyShortfallC: Number.isFinite(supply.value) && Number.isFinite(setpoint.value) ? setpoint.value - supply.value : null,
    episodeId: context.episodeId ?? null,
    electricalContext: electricalContext(store, from, at),
    heating: { verified: knownRoute && Number.isFinite(duty), compressorActive: duty > 0,
      route: knownRoute ? route.mean === 0 ? 'space-heating' : 'dhw' : 'unknown', quality: [] },
    provenance: { basis: 'committed-history', from, to: at, lineage, forecastVersion: radiation.version,
      electricalUse: 'whole-property and charger energy are context only; never heat-pump metering' } };
  sample.intervalInputs = { outdoorC: sample.outdoorC, solarRadiationWm2: sample.solarRadiationWm2,
    phase, roomBoostC: sample.roomBoostC, targetC: sample.targetC,
    compressorDuty: sample.thermalCompressorDuty, auxKw: sample.thermalAuxKw };
  return sample;
}

/** Streaming legacy imports use the same UTC grid. Only an already encountered
 * source row can fill a boundary; long gaps become explicit barriers instead of
 * being interpolated or expanded into millions of invented measurements. */
export function historicalLearningWindows(rows, inputState = null) {
  const state = structuredClone(inputState ?? { previous: null, nextAt: null }), samples = [];
  for (const row of rows) {
    if (state.previous && row.at <= state.previous.at) continue;
    state.nextAt ??= Math.ceil(row.at / LEARNING_WINDOW_MS) * LEARNING_WINDOW_MS;
    while (state.nextAt <= row.at) {
      const at = state.nextAt, source = row.at === at ? row : state.previous;
      const prior = state.previous ?? source;
      const available = source && at - source.at <= 3 * HOUR;
      const phase = prior?.action === 'reduction' ? 'reduction' : 'normal';
      samples.push({ timestamp: at, windowStart: at - LEARNING_WINDOW_MS, windowEnd: at,
        indoorC: available ? source.indoorC : null, outdoorC: available ? prior?.outdoorC ?? null : null,
        phase, roomBoostC: 0, solarRadiationWm2: null, regime: source?.regime === 'occupied' ? 'occupied' : 'away',
        quality: available ? source.quality : ['missing'], actualModeKnown: false,
        energyBasis: 'unknown', powerKw: null, compressorDuty: null, heating: null,
        intervalInputs: { outdoorC: available ? prior?.outdoorC ?? null : null, solarRadiationWm2: null,
          phase, roomBoostC: 0, compressorDuty: null, auxKw: null },
        provenance: { basis: 'committed-import-history', sourceObservationId: source?.id ?? null,
          sourceTime: source?.at ?? null, forecastVersion: null, modeBasis: 'recorded-request-only' } });
      state.nextAt += LEARNING_WINDOW_MS;
      if (!available && state.nextAt < row.at - LEARNING_WINDOW_MS)
        state.nextAt = Math.floor(row.at / LEARNING_WINDOW_MS) * LEARNING_WINDOW_MS;
    }
    state.previous = row;
  }
  return { state, samples };
}

export function appendLearningRecord(store, input, kind, value, { config = {}, seed = null } = {}) {
  const configuration = learningConfiguration(config);
  const key = `${kind}:${kind === 'sample' ? value.timestamp : kind === 'context' ? `${value.timestamp}:${learningVersion(value)}` : value.id}`;
  const existing = store.db.prepare('SELECT payload FROM learning_journal WHERE input=? AND key=?').get(input, key);
  const prior = existing ? JSON.parse(existing.payload) : null;
  const first = !store.learningJournal({ input, limit: 1 }).length;
  return store.appendLearningJournal(input, { kind, at: kind === 'episode' ? value.endedAt : value.timestamp,
    key,
    algorithmVersion: LEARNING_ALGORITHM, configVersion: learningVersion(configuration),
    forecastVersion: value.provenance?.forecastVersion ?? null,
    payload: { value, configuration, ...(prior && Object.hasOwn(prior, 'seed') ? { seed: prior.seed }
      : first ? { seed: seed ? structuredClone(seed) : null } : {}) } });
}

export function applyLearningRecord(checkpoint, entry) {
  if (entry.algorithmVersion !== LEARNING_ALGORITHM) throw new Error('Unsupported learning journal algorithm');
  if (entry.configVersion !== learningVersion(entry.payload.configuration)) throw new Error('Learning journal configuration version mismatch');
  if ((checkpoint?.journalCursor ?? 0) >= entry.id) return checkpoint;
  const configuration = entry.payload.configuration;
  let initial = checkpoint ?? entry.payload.seed ?? null;
  const historySeed = entry.payload.value.historySeed;
  if (historySeed) {
    initial = { ...restoreAdaptiveCheckpoint(initial, configuration),
      ...(historySeed.model ? { model: structuredClone(historySeed.model) } : {}),
      ...(Number.isFinite(historySeed.baselineC) ? { baselineC: historySeed.baselineC,
        comfortReference: structuredClone(historySeed.comfortReference) } : {}),
      historicalSeed: structuredClone(historySeed.source) };
  }
  if (Number.isFinite(entry.payload.value.resetBaselineAt)
    && entry.payload.value.resetBaselineAt > (initial?.baselineResetAt ?? -Infinity)) {
    initial = { ...restoreAdaptiveCheckpoint(initial, configuration), baselineC: null, comfortReference: null,
      baselineResetAt: entry.payload.value.resetBaselineAt, samples: [], sinceFit: 0 };
  }
  const next = entry.kind === 'sample'
    ? updateAdaptiveLearning(initial, entry.payload.value, { now: entry.at, config: configuration })
    : entry.kind === 'episode' ? updateAdaptiveEpisode(initial, entry.payload.value, { config: configuration })
      : restoreAdaptiveCheckpoint(initial, configuration);
  return { ...next, ...(entry.kind === 'sample' ? { windowCursor: entry.payload.value.windowEnd ?? entry.at } : {}),
    journalCursor: entry.id, algorithmVersion: LEARNING_ALGORITHM,
    configVersion: entry.configVersion, forecastVersion: entry.forecastVersion };
}

/** Applying entries and advancing the cursor share a transaction. If ingestion
 * committed a journal entry immediately before a crash, it is applied once after
 * restart. Rebuild uses precisely this same ordered entry function. */
export function replayLearningJournal(store, input, checkpoint = null, { rebuild = false } = {}) {
  let next = rebuild ? null : checkpoint;
  for (;;) {
    const entries = store.learningJournal({ input, after: next?.journalCursor ?? 0, limit: 256 });
    if (!entries.length) break;
    store.transaction(() => {
      for (const entry of entries) next = applyLearningRecord(next, entry);
      store.setState(`adaptive:${input}`, next);
    });
  }
  return next ?? restoreAdaptiveCheckpoint(null);
}
