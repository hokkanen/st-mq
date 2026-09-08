import { createHash } from 'node:crypto';
import { initialAdaptiveModel, restoreAdaptiveCheckpoint, updateAdaptiveLearning, updateAdaptiveEpisode } from '../control/adaptive-learning.js';
import { auxiliaryPowerFromOutput } from '../domain/telemetry.js';
import { CONTROL_DEFAULTS } from './config.js';

export const LEARNING_ALGORITHM = 'committed-house-v3';
export const LEARNING_WINDOW_MS = 15 * 60_000;
const HOUR = 3_600_000;
const PHASES = ['normal', 'preheat', 'reduction', 'recovery'];
const EQUIPMENT_KEYS = ['heatPumpCompressorKw', 'auxRatedKw', 'circulationKw', 'dhwrKw',
  'compressorIntegralA1', 'compressorHysteresisC', 'auxIntegralA2', 'auxHysteresisC', 'a2Basis',
  'recoveryCompressorOnly', 'recoveryCompressorOnlyHours', 'recoveryComfortMarginC',
  'maxReductionHours', 'maxAwayReductionHours', 'maxUnobservedReductionHours', 'maxPreheatHours', 'maxRoomBoostC',
  'recoveryTimeoutHours', 'dhwrPulseMinutes'];
const MODEL_KEYS = [...EQUIPMENT_KEYS, 'targetC', 'thermalPriors'];
const ALLOWED = new Set(['good', 'simulated', 'historical', 'converted_fahrenheit']);
const readingAge = (row, fallback) => row.source === 'husdata-h66' ? 5 * 60_000 : fallback;

export function learningConfiguration(config = {}) {
  const resolved = { ...CONTROL_DEFAULTS, ...config };
  return Object.fromEntries(MODEL_KEYS.filter(key => resolved[key] !== undefined).map(key => [key, structuredClone(resolved[key])]));
}
export function learningVersion(value) {
  const canonical = input => Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object'
    ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])])) : input;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** Accidental-corruption detection, not authentication. Worker progress fields
 * are outside the model checkpoint; model/state, configuration and the applied
 * journal hash chain are covered. The digest never contains itself. */
export function learningCheckpointDigest(checkpoint) {
  const { checkpointDigest, historyCursor, historyResampling, reconstruction, ...modelCheckpoint } = checkpoint;
  return learningVersion(modelCheckpoint);
}

export function validLearningCheckpoint(checkpoint, lastEntry = null) {
  if (!checkpoint || checkpoint.algorithmVersion !== LEARNING_ALGORITHM
    || !Number.isSafeInteger(checkpoint.journalCursor) || checkpoint.journalCursor <= 0
    || typeof checkpoint.journalHash !== 'string' || checkpoint.checkpointDigest !== learningCheckpointDigest(checkpoint)) return false;
  return lastEntry === null || lastEntry.id === checkpoint.journalCursor
    && lastEntry.algorithmVersion === LEARNING_ALGORITHM && checkpoint.configVersion === lastEntry.configVersion
    && checkpoint.journalEntryHash === learningVersion(lastEntry);
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
    WHERE c.signal=? AND c.start_at<=? AND c.end_at>=? AND o.received_at<=?
    AND ${input === 'simulated' ? "o.source='simulation'" : outdoor
      ? "o.source IN ('husdata-h66','fmi','openmeteo')" : "o.source<>'simulation'"}
    ORDER BY c.start_at,c.id`).all(signal, to, from - maxAge, to);
  for (const span of coverage) {
    const observation = decode({ ...span, id: span.observation_id });
    rows.push({ ...observation, sourceTime: Math.max(from, span.start_at), coverageId: span.id,
      coverageEnd: Math.min(span.end_at, span.coverage_source_time) + readingAge(observation, maxAge), value: span.status === 'fresh' ? observation.value : null });
  }
  rows.sort((a, b) => a.sourceTime - b.sourceTime || Number(Boolean(a.coverageId)) - Number(Boolean(b.coverageId)) || a.id - b.id);
  return rows;
}

function windowValues(rows, from, to, maxAge, priority = null) {
  const expires = row => row.coverageEnd ?? row.sourceTime + readingAge(row, maxAge);
  const boundaries = [...new Set([from, to, ...rows.flatMap(row => [row.sourceTime, expires(row)])])]
    .filter(at => at >= from && at <= to).sort((a, b) => a - b);
  const current = new Map(), ids = new Set(), coverageIds = new Set(), segments = [];
  let index = 0, weighted = 0, covered = 0, selected = null;
  for (let i = 0; i < boundaries.length; i++) {
    const at = boundaries[i];
    while (index < rows.length && rows[index].sourceTime <= at) {
      const row = rows[index++]; current.set(priority ? `${row.source}:${row.device}` : 'latest', row);
    }
    const endpoint = at === to;
    selected = [...current.values()].filter(row => usable(row) && (endpoint ? expires(row) >= at : expires(row) > at))
      .sort((a, b) => (priority ? priority.indexOf(a.source) - priority.indexOf(b.source) : 0)
        || b.sourceTime - a.sourceTime || b.id - a.id)[0] ?? null;
    const duration = (boundaries[i + 1] ?? at) - at;
    if (duration) segments.push({ start: at, end: at + duration, value: selected?.value ?? null });
    if (!selected) continue;
    ids.add(selected.id); if (selected.coverageId) coverageIds.add(selected.coverageId);
    covered += duration; weighted += selected.value * duration;
  }
  return { value: selected?.value ?? null, mean: covered === to - from && covered > 0 ? weighted / covered : null,
    covered, ids: [...ids], coverageIds: [...coverageIds], row: selected, segments };
}

function weatherAt(store, from, to) {
  const snapshot = store.latestSnapshot('weather', from);
  if (!snapshot || snapshot.fetchedAt > from || from - snapshot.fetchedAt > 6 * HOUR) return { value: null, version: null, segments: [] };
  let duration = 0, weighted = 0;
  const sources = [], segments = [];
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
    segments.push({ start: Math.max(from, row.start), end: Math.min(to, row.end), value: row.solarRadiationWm2 });
    sources.push({ source: solar.source ?? row.source ?? snapshot.source, issuedAt: issuedAt ?? null,
      fetchedAt: fetchedAt ?? null, issuedAtBasis: solar.issuedAtBasis ?? row.issuedAtBasis ?? null });
  }
  return { value: duration === to - from && duration > 0 ? weighted / duration : null, segments,
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

/** Persist only a context known at this timestamp. It must never be supplied as
 * today's default for an earlier window. Context and equipment configuration are
 * immutable epochs, distinct from physical compressor/readback observations. */
export function recordLearningContext(store, input, context, at, { config = {}, seed = null } = {}) {
  if (!Number.isSafeInteger(at) || !PHASES.includes(context?.phase)
    || !['occupied', 'away'].includes(context.regime)) throw new TypeError('A dated control phase and occupancy context are required');
  const controlContext = { phase: context.phase,
    roomBoostC: Number.isFinite(context.roomBoostC) ? context.roomBoostC : 0,
    targetC: Number.isFinite(context.targetC) ? context.targetC : null,
    regime: context.regime, episodeId: context.episodeId ?? null };
  const previous = store.db.prepare(`SELECT id,at,config_version,payload FROM learning_journal
    WHERE input=? AND kind='context' AND algorithm_version=?
    AND json_type(payload,'$.value.controlContext')='object' ORDER BY at DESC,id DESC LIMIT 1`).get(input, LEARNING_ALGORITHM);
  if (previous && at < previous.at) throw new Error('Control context cannot be backdated before an already recorded context');
  if (previous && learningVersion(JSON.parse(previous.payload).value.controlContext) === learningVersion(controlContext)
    && JSON.parse(previous.config_version) === learningVersion(learningConfiguration(config))) return previous.id;
  return appendLearningRecord(store, input, 'context', { timestamp: at, controlContext }, { config, seed });
}

function controlContexts(store, input, from, to) {
  const where = "input=? AND kind='context' AND algorithm_version=? AND json_type(payload,'$.value.controlContext')='object'";
  const before = store.db.prepare(`SELECT id,at,payload FROM learning_journal WHERE ${where} AND at<=? ORDER BY at DESC,id DESC LIMIT 1`)
    .get(input, LEARNING_ALGORITHM, from);
  const changes = store.db.prepare(`SELECT id,at,payload FROM learning_journal WHERE ${where} AND at>? AND at<=? ORDER BY at,id`)
    .all(input, LEARNING_ALGORITHM, from, to);
  return [...(before ? [before] : []), ...changes].map(row => {
    const payload = JSON.parse(row.payload);
    return { id: row.id, at: row.at, ...payload.value.controlContext, configuration: payload.configuration };
  });
}

const valueAt = (series, at) => series.segments.find(row => row.start <= at && row.end > at)?.value ?? null;
const meanField = (segments, field, duration) => segments.every(row => Number.isFinite(row[field]))
  ? segments.reduce((sum, row) => sum + row[field] * (row.end - row.start), 0) / duration : null;
const oneValue = (segments, field, fallback = null) => {
  const values = [...new Set(segments.map(row => row[field]))];
  return values.length === 1 ? values[0] : fallback;
};

/** A completed half-open [windowStart, windowEnd) interval. Every input segment
 * refers to its own interval, and energyKwh integrates that same interval. The
 * indoor value is the observation at windowEnd. No current mutable context is
 * allowed to label an earlier interval, including after a restart. */
export function committedLearningSample({ store, input, at, config = {}, windowMs = LEARNING_WINDOW_MS }) {
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(windowMs) || windowMs <= 0 || windowMs > LEARNING_WINDOW_MS)
    throw new TypeError('A bounded completed learning window is required');
  const from = at - windowMs, lineage = {}, streams = {};
  const get = (signal, age = 30 * 60_000) => {
    const priority = signal === 'outdoor_temperature' && ['mqtt', 'providers'].includes(input)
      ? ['husdata-h66', 'fmi', 'openmeteo'] : null;
    const value = windowValues(trajectory(store, signal, from, at, input, age), from, at, age, priority);
    lineage[signal] = { observations: value.ids, coverage: value.coverageIds };
    streams[signal] = value;
    return value;
  };
  const indoor = get('indoor_temperature'), outdoor = get('outdoor_temperature');
  const compressor = get('compressor_active', 5 * 60_000), route = get('dhw_routing', 5 * 60_000);
  const auxiliary = get('auxiliary_output', 5 * 60_000), integral = get('heating_integral', 5 * 60_000);
  const supply = get('supply_temperature', 5 * 60_000), setpoint = get('heating_setpoint', 5 * 60_000);
  const alarm = get('alarm_active', 5 * 60_000), mode = get('operating_mode', 5 * 60_000);
  const radiation = weatherAt(store, from, at), contexts = controlContexts(store, input, from, at);
  const boundaries = [...new Set([from, at, ...Object.values(streams).flatMap(series => series.segments.flatMap(row => [row.start, row.end])),
    ...radiation.segments.flatMap(row => [row.start, row.end]), ...contexts.map(row => row.at)])]
    .filter(time => time >= from && time <= at).sort((a, b) => a - b);
  const inputSegments = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i], end = boundaries[i + 1];
    const context = contexts.findLast(row => row.at <= start);
    const configuration = context?.configuration ?? null;
    const observedCompressor = valueAt(compressor, start), observedRoute = valueAt(route, start);
    const compressorDuty = [0, 1].includes(observedCompressor) ? observedCompressor : null;
    const knownRoute = [0, 1].includes(observedRoute);
    const auxiliaryPower = configuration ? auxiliaryPowerFromOutput(valueAt(auxiliary, start), configuration.auxRatedKw ?? 9) : null;
    const auxKw = auxiliaryPower?.kw ?? null;
    const compressorPowerKw = configuration ? configuration.heatPumpCompressorKw ?? 3 : null;
    const circulationKw = configuration ? configuration.circulationKw ?? 0.08 : null;
    const dhwrKw = configuration && context.phase === 'preheat' ? configuration.dhwrKw ?? 0.05 : 0;
    const powerKw = Number.isFinite(compressorDuty) && Number.isFinite(auxKw) && configuration
      ? compressorDuty * (compressorPowerKw + circulationKw) + auxKw + dhwrKw : null;
    const outdoorC = valueAt(outdoor, start), supplyC = valueAt(supply, start), supplyTarget = valueAt(setpoint, start);
    const quality = [];
    if (!context) quality.push('unavailable-controller-context');
    if (!Number.isFinite(outdoorC)) quality.push('missing');
    if (valueAt(alarm, start) > 0) quality.push('heat-pump-alarm');
    const segment = { start, end, outdoorC, solarRadiationWm2: valueAt(radiation, start),
      phase: context?.phase ?? null, roomBoostC: context?.roomBoostC ?? null, targetC: context?.targetC ?? null,
      regime: context?.regime ?? null, episodeId: context?.episodeId ?? null,
      compressorDuty, compressorPowerKw, circulationKw, dhwrKw, auxKw, powerKw,
      thermalCompressorDuty: compressorDuty === 0 ? 0 : knownRoute ? observedRoute === 0 ? compressorDuty : 0 : null,
      thermalAuxKw: auxKw === 0 ? 0 : knownRoute && auxKw !== null ? observedRoute === 0 ? auxKw : 0 : null,
      auxRoute: knownRoute ? observedRoute === 0 ? 'space' : 'dhw' : 'unknown',
      dhwCompressorDuty: compressorDuty === 0 ? 0 : knownRoute ? observedRoute === 1 ? compressorDuty : 0 : null,
      dhwAuxKw: auxKw === 0 ? 0 : knownRoute && auxKw !== null ? observedRoute === 1 ? auxKw : 0 : null,
      auxiliaryStage: auxiliaryPower?.stage ?? null, auxiliaryPowerBasis: auxiliaryPower?.basis ?? 'unavailable',
      integral: valueAt(integral, start), supplyShortfallC: Number.isFinite(supplyC) && Number.isFinite(supplyTarget) ? supplyTarget - supplyC : null,
      operatingMode: valueAt(mode, start), quality };
    segment.compressorActivityObserved = Number.isFinite(compressorDuty);
    segment.auxiliaryObserved = Number.isFinite(auxKw);
    segment.auxiliaryRouteKnown = knownRoute || auxKw === 0;
    segment.actualModeKnown = Number.isFinite(segment.operatingMode);
    segment.energyBasis = 'estimated';
    segment.configurationVersion = configuration ? learningVersion(configuration) : null;
    const previous = inputSegments.at(-1);
    const comparable = row => { const { start, end, ...values } = row; return JSON.stringify(values); };
    if (previous && comparable(previous) === comparable(segment)) previous.end = end;
    else inputSegments.push(segment);
  }
  for (const segment of inputSegments) {
    segment.durationHours = (segment.end - segment.start) / HOUR;
    segment.energyKwh = Number.isFinite(segment.powerKw) ? segment.powerKw * segment.durationHours : null;
    segment.compressorKwh = Number.isFinite(segment.compressorDuty) && Number.isFinite(segment.compressorPowerKw)
      ? segment.compressorDuty * segment.compressorPowerKw * segment.durationHours : null;
    segment.spaceHeatingAuxKwh = Number.isFinite(segment.thermalAuxKw) ? segment.thermalAuxKw * segment.durationHours : null;
    segment.dhwAuxKwh = Number.isFinite(segment.dhwAuxKw) ? segment.dhwAuxKw * segment.durationHours : null;
  }
  const durationHours = windowMs / HOUR, mean = field => meanField(inputSegments, field, windowMs);
  const powerKw = mean('powerKw'), duty = mean('compressorDuty'), auxKw = mean('auxKw');
  const thermalCompressorDuty = mean('thermalCompressorDuty'), thermalAuxKw = mean('thermalAuxKw');
  const quality = [...new Set(inputSegments.flatMap(row => row.quality))];
  if (!Number.isFinite(indoor.value) && !quality.includes('missing')) quality.push('missing');
  const phase = oneValue(inputSegments, 'phase', 'mixed');
  const routed = inputSegments.every(row => Number.isFinite(row.thermalCompressorDuty) && Number.isFinite(row.thermalAuxKw));
  lineage.control_context = { journal: contexts.filter(row => row.at < at).map(row => row.id) };
  const sample = { timestamp: at, windowStart: from, windowEnd: at, durationHours, inputSegments,
    indoorC: indoor.value, outdoorC: outdoor.mean, solarRadiationWm2: radiation.value,
    phase, roomBoostC: oneValue(inputSegments, 'roomBoostC'), targetC: oneValue(inputSegments, 'targetC'),
    regime: oneValue(inputSegments, 'regime', 'mixed'), quality,
    powerKw, energyKwh: powerKw === null ? null : powerKw * durationHours,
    energyCoveredHours: inputSegments.filter(row => Number.isFinite(row.energyKwh)).reduce((sum, row) => sum + row.durationHours, 0),
    compressorPowerKw: oneValue(inputSegments, 'compressorPowerKw'), compressorDuty: duty, auxKw,
    thermalCompressorDuty, thermalAuxKw, auxRoute: oneValue(inputSegments, 'auxRoute', 'mixed'),
    auxiliaryStage: oneValue(inputSegments, 'auxiliaryStage'), auxiliaryPowerBasis: oneValue(inputSegments, 'auxiliaryPowerBasis', 'mixed'),
    compressorActivityObserved: Number.isFinite(duty), auxiliaryObserved: Number.isFinite(auxKw), auxiliaryRouteKnown: routed,
    actualModeKnown: Number.isFinite(mode.mean), energyBasis: 'estimated',
    integral: integral.value, supplyShortfallC: Number.isFinite(supply.value) && Number.isFinite(setpoint.value) ? setpoint.value - supply.value : null,
    episodeId: oneValue(inputSegments, 'episodeId'), electricalContext: electricalContext(store, from, at),
    heating: { verified: Number.isFinite(thermalCompressorDuty), compressorActive: thermalCompressorDuty > 0,
      compressorDuty: thermalCompressorDuty, route: Number.isFinite(thermalCompressorDuty) ? 'space-heating' : 'unknown', quality: [] },
    provenance: { basis: 'committed-history', intervalContract: 1, from, to: at, lineage, forecastVersion: radiation.version,
      electricalUse: 'whole-property and charger energy are context only; never heat-pump metering' } };
  // Compatibility summary only. Segments are authoritative when phase, target,
  // destination or configuration changes within the completed interval.
  sample.intervalInputs = { outdoorC: sample.outdoorC, solarRadiationWm2: sample.solarRadiationWm2,
    phase, roomBoostC: sample.roomBoostC, targetC: sample.targetC,
    compressorDuty: thermalCompressorDuty, auxKw: thermalAuxKw };
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
  const key = `${LEARNING_ALGORITHM}:${kind}:${kind === 'sample' ? value.timestamp : kind === 'context' ? `${value.timestamp}:${learningVersion(value)}` : value.id}`;
  const existing = store.db.prepare('SELECT payload FROM learning_journal WHERE input=? AND key=?').get(input, key);
  const prior = existing ? JSON.parse(existing.payload) : null;
  const first = !store.learningJournal({ input, limit: 1, algorithmVersion: LEARNING_ALGORITHM }).length;
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
  if (initial?.learningConfiguration && learningVersion(initial.learningConfiguration) !== entry.configVersion) {
    initial = restoreAdaptiveCheckpoint(initial, configuration);
    const defaults = initialAdaptiveModel(configuration).energy;
    const previous = initial.learningConfiguration;
    const changed = EQUIPMENT_KEYS.some(key => previous[key] !== configuration[key]);
    if (changed) {
      initial.equipmentEpochAt = entry.at;
      initial.model.equipmentResponse = { phases: {}, validation: null };
      initial.model.forecastValidation = null;
      if (previous.auxRatedKw !== configuration.auxRatedKw)
        initial.model.parameters.auxiliaryCPerKwh = initialAdaptiveModel(configuration).parameters.auxiliaryCPerKwh;
      initial.model.energy = { ...initial.model.energy,
        compressorKw: defaults.compressorKw, auxiliaryKw: defaults.auxiliaryKw,
        circulationKw: defaults.circulationKw, dhwrKw: defaults.dhwrKw,
        recoveryMultiplier: defaults.recoveryMultiplier, auxiliaryRiskScale: defaults.auxiliaryRiskScale,
        relativeUncertainty: defaults.relativeUncertainty, basis: 'estimated',
        recoveryCalibrationEpisodes: 0, auxiliaryCalibrationEpisodes: 0,
        configurationChangedAt: entry.at };
    }
  }
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
      baselineResetAt: entry.payload.value.resetBaselineAt, equipmentEpochAt: entry.payload.value.resetBaselineAt, samples: [], sinceFit: 0 };
    initial.model.equipmentResponse = { phases: {}, validation: null };
    initial.model.forecastValidation = null;
  }
  const next = entry.kind === 'sample'
    ? updateAdaptiveLearning(initial, entry.payload.value, { now: entry.at, config: configuration })
    : entry.kind === 'episode' ? updateAdaptiveEpisode(initial, entry.payload.value, { config: configuration })
      : restoreAdaptiveCheckpoint(initial, configuration);
  const journalEntryHash = learningVersion(entry);
  const result = { ...next, ...(entry.kind === 'sample' ? { windowCursor: entry.payload.value.windowEnd ?? entry.at } : {}),
    journalCursor: entry.id, algorithmVersion: LEARNING_ALGORITHM,
    journalEntryHash, journalHash: learningVersion({ previous: checkpoint?.journalCursor ? checkpoint.journalHash ?? null : null, entry: journalEntryHash }),
    configVersion: entry.configVersion, learningConfiguration: structuredClone(configuration), forecastVersion: entry.forecastVersion };
  result.checkpointDigest = learningCheckpointDigest(result);
  return result;
}

/** Immutable entries are already committed, so replay needs no writer lock.
 * The checkpoint and its cursor are one atomic state update after computation.
 * A crash before that update replays the same entries from the saved cursor.
 * Rebuild uses precisely this same ordered entry function. */
export function replayLearningJournal(store, input, checkpoint = null, { rebuild = false } = {}) {
  let next = rebuild || checkpoint?.algorithmVersion && checkpoint.algorithmVersion !== LEARNING_ALGORITHM ? null : checkpoint;
  if (next?.journalCursor) {
    const last = store.learningJournal({ input, after: next.journalCursor - 1, limit: 1, algorithmVersion: LEARNING_ALGORITHM })[0];
    if (!last || !validLearningCheckpoint(next, last)) next = null;
  }
  for (;;) {
    const entries = store.learningJournal({ input, after: next?.journalCursor ?? 0, limit: 256, algorithmVersion: LEARNING_ALGORITHM });
    if (!entries.length) break;
    for (const entry of entries) next = applyLearningRecord(next, entry);
    store.setState(`adaptive:${input}`, next);
  }
  return next ?? restoreAdaptiveCheckpoint(null);
}
