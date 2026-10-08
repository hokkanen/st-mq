import { H66_MAX_AGE_MS, OUTDOOR_MAX_AGE_MS } from '../domain/reading-freshness.js';
import { createHash } from 'node:crypto';
import { initialAdaptiveModel, restoreAdaptiveCheckpoint, updateAdaptiveLearning, updateAdaptiveEpisode } from '../control/adaptive-learning.js';
import { auxiliaryPowerFromOutput } from '../domain/telemetry.js';
import { CONTROL_DEFAULTS } from './config.js';
import { fireplaceLearningContext, withFireplaceInputs, fireplaceEpisodeAffected } from './fireplace-inputs.js';
import { indoorWeights, SENSOR_SETTLING_MS } from '../domain/indoor-sensors.js';
import { lastIndoorReading, indoorReportCoverage } from './indoor-readings.js';
import { sensorBoundaries, affectsThermalLearning, sensorLearningContext } from './sensor-inputs.js';
import { withSensorMeasurements } from './sensor-samples.js';
import { estimateHeatPumpPerformance } from '../domain/heat-pump-performance.js';
import { recordedEnergyGroups } from '../storage/energy-history.js';
import { validComfortReference, hasEstimatedIndoor } from '../control/learning.js';

import { LEARNING_ALGORITHM } from '../domain/learning-contract.js';
export { LEARNING_ALGORITHM } from '../domain/learning-contract.js';
export const LEARNING_WINDOW_MS = 15 * 60_000;
const HOUR = 3_600_000;
const PHASES = ['normal', 'preheat', 'reduction', 'recovery'];
const EQUIPMENT_KEYS = ['heatPumpCompressorKw', 'auxRatedKw', 'circulationKw', 'dhwrKw',
  'compressorIntegralA1', 'compressorHysteresisC', 'auxIntegralA2', 'auxHysteresisC', 'a2Basis',
  'recoveryCompressorOnly', 'recoveryHoldMinutes', 'recoveryComfortMarginC',
  'maxReductionHours', 'maxAwayReductionHours', 'maxUnobservedReductionHours', 'maxPreheatHours', 'preheatRoomBoostC',
  'recoveryTimeoutHours', 'dhwrPulseMinutes', 'heatPumpModelConfirmed', 'floorThermalPriors'];
const MODEL_KEYS = [...EQUIPMENT_KEYS, 'targetC', 'thermalPriors', 'indoorSensorWeights'];
const ALLOWED = new Set(['good', 'simulated', 'historical', 'converted_fahrenheit']);
const readingAge = (row, fallback) => row.source === 'husdata-h66' ? H66_MAX_AGE_MS : fallback;

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
function trajectory(store, signal, from, to, input, maxAge, minimumTime = -Infinity) {
  const outdoor = signal === 'outdoor_temperature' && ['mqtt', 'providers'].includes(input);
  const scope = input === 'simulated' ? "source='simulation'" : outdoor
    ? "source IN ('fmi','openmeteo')" : "source<>'simulation'";
  const decode = row => ({ id: row.id, source: row.source, device: row.device, signal: row.signal,
    value: row.value, unit: row.unit, sourceTime: row.source_time, receivedAt: row.received_at,
    quality: JSON.parse(row.quality), raw: row.raw ? JSON.parse(row.raw) : null });
  const rows = store.db.prepare(`SELECT * FROM active_observations AS observations WHERE signal=? AND source_time>=? AND source_time<=?
    AND received_at<=? AND ${scope} ORDER BY source_time,id`).all(signal, Math.max(from - maxAge, minimumTime), to, to).map(decode);
  const coverage = store.db.prepare(`SELECT c.*,c.source_time AS coverage_source_time,o.source,o.device,o.signal,o.value,o.unit,o.source_time,o.received_at,o.quality,o.raw
    FROM active_recorder_coverage c JOIN active_observations o ON o.id=c.observation_id
    WHERE c.signal=? AND c.start_at<=? AND c.end_at>=? AND o.received_at<=?
    AND ${input === 'simulated' ? "o.source='simulation'" : outdoor
      ? "o.source IN ('fmi','openmeteo')" : "o.source<>'simulation'"}
    ORDER BY c.start_at,c.id`).all(signal, to, from - maxAge, to);
  for (const span of coverage) {
    if (span.coverage_source_time < minimumTime) continue;
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

function electricalContext(store, from, to, input) {
  const result = {};
  for (const prefix of ['property','ev1','ev2']) {
    const phases = [0,1,2].map(()=>({kwh:null,coveredMs:0,observations:[],openIntervals:[]}));
    for (const group of recordedEnergyGroups(store,{from,to,now:to,input,prefix})) {
      if (group.conflict || group.values.length !== 3) continue;
      const overlap = Math.min(to,group.end)-Math.max(from,group.start);
      if (overlap <= 0) continue;
      for (let i=0;i<3;i++) {
        if (!Number.isFinite(group.values[i])) continue;
        const phase = phases[i], kwh = group.values[i]*overlap/(group.end-group.start);
        phase.kwh = (phase.kwh ?? 0)+kwh; phase.coveredMs += overlap;
        if (Number.isSafeInteger(group.observationIds?.[i])) phase.observations.push(group.observationIds[i]);
        // Freeze the resolved open-interval context in this journal sample.
        // Later accumulator updates must never reinterpret an earlier sample.
        if (group.pending) phase.openIntervals.push({start:group.start,end:group.end,
          receivedAt:group.receivedAt,kwh,basis:group.basis});
      }
    }
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
    regime: context.regime, episodeId: context.episodeId ?? null,
    floorOverrideMode: ['on', 'off', 'partial', 'unknown'].includes(context.floorOverrideMode) ? context.floorOverrideMode : 'off',
    treatmentKey: typeof context.treatmentKey === 'string' ? context.treatmentKey : 'native',
    dhwrActive: typeof context.dhwrActive === 'boolean' ? context.dhwrActive : null };
  const previous = learningControlContexts(store, input, { latest: true })[0];
  if (previous && at < previous.at) throw new Error('Control context cannot be backdated before an already recorded context');
  if (previous && learningVersion(JSON.parse(previous.payload).value.controlContext) === learningVersion(controlContext)
    && JSON.parse(previous.config_version) === learningVersion(learningConfiguration(config))) return previous.id;
  return appendLearningRecord(store, input, 'context', { timestamp: at, controlContext }, { config, seed });
}

/** Seek time within each retained range instead of sorting the inherited
 * journal. A known newer context also bounds searches in older source epochs. */
function learningControlContexts(store, input, { from = Number.MIN_SAFE_INTEGER, to = Number.MAX_SAFE_INTEGER, latest = false } = {}) {
  const epoch = store.db.prepare('SELECT epoch FROM learning_epochs WHERE input=?').get(input)?.epoch ?? 'original';
  const ranges = [{ source_epoch: epoch, after_id: 0, through_id: Number.MAX_SAFE_INTEGER },
    ...store.db.prepare('SELECT source_epoch,after_id,through_id FROM learning_epoch_segments WHERE epoch=? AND input=? ORDER BY through_id DESC')
      .all(epoch, input)];
  const statement = store.db.prepare(`SELECT e.id,e.at,COALESCE(e.config_version,s.config_version) config_version,
    COALESCE(e.payload,s.payload) payload FROM learning_journal_entries e INDEXED BY learning_entries_time
    LEFT JOIN learning_journal_entries s ON s.id=e.source_entry_id
    WHERE e.epoch=? AND e.input=? AND e.kind='context' AND e.at${latest ? '>=' : '>'}? AND e.at<=?
      AND e.id>? AND e.id<=? AND e.algorithm_version=?
      AND json_type(COALESCE(e.payload,s.payload),'$.value.controlContext')='object'
    ORDER BY e.at${latest ? ' DESC' : ''},e.id${latest ? ' DESC' : ''}${latest ? ' LIMIT 1' : ''}`);
  const rows = []; let best;
  for (const range of ranges) {
    const params = [range.source_epoch, input, best?.at ?? from, to, range.after_id, range.through_id, LEARNING_ALGORITHM];
    if (latest) {
      const row = statement.get(...params);
      if (row && (!best || row.at > best.at || row.at === best.at && row.id > best.id)) best = row;
    } else rows.push(...statement.all(...params));
  }
  return latest ? best ? [best] : [] : rows.sort((a, b) => a.at - b.at || a.id - b.id);
}

function controlContexts(store, input, from, to) {
  const before = learningControlContexts(store, input, { to: from, latest: true })[0];
  const changes = learningControlContexts(store, input, { from, to });
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
export function committedLearningSample({ store, input, at, config = {}, windowMs = LEARNING_WINDOW_MS, measurementEpochAt = null }) {
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(windowMs) || windowMs <= 0 || windowMs > LEARNING_WINDOW_MS)
    throw new TypeError('A bounded completed learning window is required');
  const from = at - windowMs, lineage = {}, streams = {};
  const boundariesBySensor = sensorBoundaries(store, input, at);
  const get = (signal, age = OUTDOOR_MAX_AGE_MS) => {
    const priority = signal === 'outdoor_temperature' && ['mqtt', 'providers'].includes(input)
      ? ['fmi', 'openmeteo'] : null;
    const value = windowValues(trajectory(store, signal, from, at, input, age), from, at, age, priority);
    lineage[signal] = { observations: value.ids, coverage: value.coverageIds };
    streams[signal] = value;
    return value;
  };
  const weights = indoorWeights(config);
  const indoorSensors = Object.fromEntries(Object.entries(weights).map(([signal, weight]) => {
    const reading = lastIndoorReading(store, { signal, at, input });
    const coverage = reading ? indoorReportCoverage(store, { reading, from, at, includeIntervals: true }) : null;
    lineage[signal] = { observations: [...new Set([...(reading ? [reading.id] : []), ...(coverage?.observations ?? [])])],
      coverage: coverage?.coverage ?? [] };
    return [signal, { value: reading && !reading.stale && (coverage === null || coverage.complete) ? reading.value : null, weight,
      observedAt: reading?.sourceTime ?? null, held: reading?.held ?? false,
      needsAttention: reading?.needsAttention ?? false, attentionReasons: reading?.attentionReasons ?? [],
      ...(coverage ? { reportCoverageComplete: coverage.complete,
        reportCoveredThrough: coverage.coveredThrough, reportIntervals: coverage.intervals } : {}) }];
  }));
  const indoor = { value: Object.values(indoorSensors).every(row => Number.isFinite(row.value))
    ? Object.values(indoorSensors).reduce((sum, row) => sum + row.value * row.weight, 0) : null };
  const outdoor = get('outdoor_temperature');
  const sensorEpochAt = Math.max(measurementEpochAt ?? 0, ...Object.entries(boundariesBySensor)
    .filter(([signal]) => affectsThermalLearning(signal, config)).map(([, changedAt]) => changedAt));
  const compressor = get('compressor_active', H66_MAX_AGE_MS), route = get('dhw_routing', H66_MAX_AGE_MS);
  const auxiliary = get('auxiliary_output', H66_MAX_AGE_MS), integral = get('heating_integral', H66_MAX_AGE_MS);
  const supply = get('supply_temperature', H66_MAX_AGE_MS), setpoint = get('heating_setpoint', H66_MAX_AGE_MS);
  const brine = get('brine_in_temperature', H66_MAX_AGE_MS);
  const alarm = get('alarm_active', H66_MAX_AGE_MS), mode = get('operating_mode', H66_MAX_AGE_MS);
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
    const supplyC = valueAt(supply, start), brineC = valueAt(brine, start);
    const performance = estimateHeatPumpPerformance({ supplyC, brineC, modelConfirmed: configuration?.heatPumpModelConfirmed });
    const compressorPowerKw = configuration ? performance.electricalKw : null;
    // This manufacturer boundary already includes circulation pumps. DHWR is a
    // separate service, charged only when its observed/recorded ownership is ON.
    const circulationKw = configuration ? 0 : null;
    const dhwrKw = configuration && context.dhwrActive === true ? configuration.dhwrKw ?? 0.05 : 0;
    const powerKw = Number.isFinite(compressorDuty) && Number.isFinite(auxKw) && configuration
      ? compressorDuty * (compressorPowerKw + circulationKw) + auxKw + dhwrKw : null;
    const outdoorC = valueAt(outdoor, start), supplyTarget = valueAt(setpoint, start);
    const quality = [];
    if (!context) quality.push('unavailable-controller-context');
    if (!Number.isFinite(outdoorC)) quality.push('missing');
    if (valueAt(alarm, start) > 0) quality.push('heat-pump-alarm');
    const segment = { start, end, outdoorC, solarRadiationWm2: valueAt(radiation, start),
      phase: context?.phase ?? null, roomBoostC: context?.roomBoostC ?? null, targetC: context?.targetC ?? null,
      regime: context?.regime ?? null, episodeId: context?.episodeId ?? null,
      supplyC, brineC, compressorHeatKw: performance.heatKw,
      sourceRelativeUncertainty: performance.relativeUncertainty, sourceEstimateBasis: performance.basis,
      sourceUncertaintyReasons: performance.uncertaintyReasons, sourcePumpsIncluded: true,
      floorOverrideMode: context?.floorOverrideMode ?? 'unknown', treatmentKey: context?.treatmentKey ?? 'native',
      compressorDuty, compressorPowerKw, circulationKw, dhwrKw, auxKw, powerKw,
      thermalCompressorDuty: compressorDuty === 0 ? 0 : knownRoute ? observedRoute === 0 ? compressorDuty : 0 : null,
      thermalAuxKw: auxKw === 0 ? 0 : knownRoute && auxKw !== null ? observedRoute === 0 ? auxKw : 0 : null,
      auxRoute: knownRoute ? observedRoute === 0 ? 'space' : 'dhw' : 'unknown',
      dhwCompressorDuty: compressorDuty === 0 ? 0 : knownRoute ? observedRoute === 1 ? compressorDuty : 0 : null,
      dhwAuxKw: auxKw === 0 ? 0 : knownRoute && auxKw !== null ? observedRoute === 1 ? auxKw : 0 : null,
      auxiliaryStage: auxiliaryPower?.stage ?? null, auxiliaryPowerBasis: auxiliaryPower?.basis ?? 'unavailable',
      integral: valueAt(integral, start), supplyShortfallC: Number.isFinite(supplyC) && Number.isFinite(supplyTarget) ? supplyTarget - supplyC : null,
      operatingMode: valueAt(mode, start), quality };
    segment.hydronicHeatKw = Number.isFinite(segment.thermalCompressorDuty) && Number.isFinite(segment.thermalAuxKw)
      ? segment.thermalCompressorDuty * performance.heatKw + segment.thermalAuxKw : null;
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
    segment.hydronicHeatKwh = Number.isFinite(segment.hydronicHeatKw) ? segment.hydronicHeatKw * segment.durationHours : null;
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
  const sample = { sensorInputVersion: 1, timestamp: at, windowStart: from, windowEnd: at, durationHours, inputSegments,
    indoorC: indoor.value, indoorSensors, measurementEpochAt: sensorEpochAt || null,
    outdoorC: outdoor.mean, solarRadiationWm2: radiation.value,
    supplyC: mean('supplyC'), brineC: mean('brineC'), hydronicHeatKw: mean('hydronicHeatKw'),
    hydronicHeatKwh: mean('hydronicHeatKw') === null ? null : mean('hydronicHeatKw') * durationHours,
    floorOverrideMode: oneValue(inputSegments, 'floorOverrideMode', 'unknown'), treatmentKey: oneValue(inputSegments, 'treatmentKey', 'mixed'),
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
    episodeId: oneValue(inputSegments, 'episodeId'), electricalContext: electricalContext(store, from, at, input),
    heating: { verified: Number.isFinite(thermalCompressorDuty), compressorActive: thermalCompressorDuty > 0,
      compressorDuty: thermalCompressorDuty, route: Number.isFinite(thermalCompressorDuty) ? 'space-heating' : 'unknown', quality: [] },
    provenance: { basis: 'committed-history', intervalContract: 1, from, to: at, lineage, forecastVersion: radiation.version,
      electricalUse: 'whole-property and charger energy are context only; never heat-pump metering' } };
  return withSensorMeasurements(sample, { sensorEpochs: boundariesBySensor, measurementEpochAt }, config);
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
      samples.push({ sensorInputVersion: 1, indoorSensors: { indoor_temperature: {
        value: available ? source.indoorC : null, weight: 1, observedAt: source?.at ?? null } },
        timestamp: at, windowStart: at - LEARNING_WINDOW_MS, windowEnd: at,
        indoorC: available ? source.indoorC : null, outdoorC: available ? prior?.outdoorC ?? null : null,
        phase, roomBoostC: 0, solarRadiationWm2: null, regime: source?.regime === 'occupied' ? 'occupied' : 'away',
        quality: available ? source.quality : ['missing'], actualModeKnown: false,
        energyBasis: 'unknown', powerKw: null, compressorDuty: null, heating: null,
        inputSegments: [{ start: at - LEARNING_WINDOW_MS, end: at, durationHours: LEARNING_WINDOW_MS / HOUR,
          outdoorC: available ? prior?.outdoorC ?? null : null, solarRadiationWm2: null,
          phase, regime: source?.regime === 'occupied' ? 'occupied' : 'away', roomBoostC: 0,
          thermalCompressorDuty: null, thermalAuxKw: null, quality: available ? source.quality : ['missing'] }],
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

export function assertCurrentLearningSample(sample) {
  if (!sample || sample.sensorInputVersion !== 1 || !Array.isArray(sample.inputSegments)
    || !sample.indoorSensors || Object.hasOwn(sample, 'intervalInputs') || Object.hasOwn(sample, 'thermal'))
    throw new TypeError('Unsupported Home sample payload; only the current segmented sensor-input contract is supported.');
  if (hasEstimatedIndoor(sample))
    throw new TypeError('Estimated indoor temperatures are control-only and cannot enter the Home learning journal.');
}

function assertCurrentLearningContext(value) {
  const history = value?.historySeed;
  if (history && (history.source?.algorithmVersion !== undefined && history.source.algorithmVersion !== LEARNING_ALGORITHM
    || history.model && history.model.version !== 4
    || history.comfortReference != null && !validComfortReference(history.comfortReference)))
    throw new TypeError('Unsupported Home historical seed; start with fresh current learning state.');
  if (value && Object.hasOwn(value, 'resetBaselineAt'))
    throw new TypeError('Unsupported Home context payload; native ROOM edits reset equipment response, not the comfort reference.');
}

function assertCurrentLearningSeed(seed) {
  if (seed && (seed.model?.version !== 4
    || seed.algorithmVersion !== undefined && seed.algorithmVersion !== LEARNING_ALGORITHM
    || Object.hasOwn(seed, 'sensorComfortReferences')
    || seed.comfortReference != null && !validComfortReference(seed.comfortReference)))
    throw new TypeError('Unsupported Home seed; start with fresh current learning state.');
}

export function appendLearningRecord(store, input, kind, value, { config = {}, seed = null } = {}) {
  if (kind === 'sample') assertCurrentLearningSample(value);
  if (kind === 'context') assertCurrentLearningContext(value);
  assertCurrentLearningSeed(seed);
  // Old CSV temp_in is the historical upstairs sensor, never a fabricated average.
  if (input === 'history') config = { ...config, indoorSensorWeights: { indoor_temperature: 1 } };
  const configuration = learningConfiguration(config);
  const key = `${LEARNING_ALGORITHM}:${kind}:${kind === 'sample' ? value.timestamp : kind === 'context' ? `${value.timestamp}:${learningVersion(value)}` : value.id}`;
  const existing = store.db.prepare('SELECT payload FROM learning_journal WHERE input=? AND key=?').get(input, key);
  const prior = existing ? JSON.parse(existing.payload) : null;
  const first = !store.learningJournal({ input, limit: 1, algorithmVersion: LEARNING_ALGORITHM }).length;
  return store.appendLearningJournal(input, { kind, at: kind === 'episode' ? value.endedAt : value.timestamp,
    key,
    algorithmVersion: LEARNING_ALGORITHM, configVersion: learningVersion(configuration),
    forecastVersion: value.provenance?.forecastVersion ?? null,
    payload: { value, configuration, ...(prior && Object.hasOwn(prior, 'seed') ? { seed: prior.seed,
      ...(prior.epoch ? { epoch: prior.epoch } : {}) }
      : first ? { seed: seed ? structuredClone(seed) : null, epoch: { algorithm: LEARNING_ALGORITHM,
          initialization: 'explicit current v4 seed or fresh passive thermal priors' } } : {}) } });
}

function resetMeasurement(checkpoint, configuration, at) {
  const initial = restoreAdaptiveCheckpoint(checkpoint, configuration), fresh = initialAdaptiveModel(configuration);
  return { ...initial, model: { ...fresh, parameters: { ...initial.model.parameters },
      provenance: { ...fresh.provenance, measurementChangedAt: at, retainedParameters: true } },
    samples: [], episodeArchive: [], comfortLearning: null, state: null,
    baselineC: null, comfortReference: null, sinceFit: 0,
    cursor: new Date(at).toISOString(), windowCursor: Math.floor(at / LEARNING_WINDOW_MS) * LEARNING_WINDOW_MS,
    baselineResetAt: at, measurementEpochAt: at, equipmentEpochAt: at,
    health: { status: 'prior-estimates', reason: 'sensor-measurement-changed', acceptedFits: 0, rejectedFits: 0 } };
}

export function applyLearningRecord(checkpoint, entry, fireplaceContext = {}) {
  if (entry.algorithmVersion !== LEARNING_ALGORITHM) throw new Error('Unsupported learning journal algorithm');
  assertCurrentLearningSeed(entry.payload?.seed);
  if (entry.payload?.epoch && entry.payload.epoch.algorithm !== LEARNING_ALGORITHM)
    throw new TypeError('Unsupported Home learning epoch; start fresh.');
  if (entry.kind === 'sample') assertCurrentLearningSample(entry.payload?.value);
  if (entry.kind === 'context') assertCurrentLearningContext(entry.payload?.value);
  if (entry.configVersion !== learningVersion(entry.payload.configuration)) throw new Error('Learning journal configuration version mismatch');
  if ((checkpoint?.journalCursor ?? 0) >= entry.id) return checkpoint;
  const configuration = entry.payload.configuration;
  let initial = checkpoint ?? entry.payload.seed ?? null;
  if (initial?.learningConfiguration && learningVersion(initial.learningConfiguration) !== entry.configVersion) {
    initial = restoreAdaptiveCheckpoint(initial, configuration);
    const defaults = initialAdaptiveModel(configuration).energy;
    const previous = initial.learningConfiguration;
    if (learningVersion(indoorWeights(previous)) !== learningVersion(indoorWeights(configuration)))
      initial = resetMeasurement(initial, configuration, entry.at);
    const changed = EQUIPMENT_KEYS.some(key => learningVersion(previous[key] ?? null) !== learningVersion(configuration[key] ?? null));
    if (changed) {
      initial.equipmentEpochAt = entry.at;
      initial.model.equipmentResponse = { phases: {}, validation: null };
      initial.model.forecastValidation = null;
      const structuralChanged = ['auxRatedKw', 'heatPumpModelConfirmed', 'floorThermalPriors'].some(key =>
        learningVersion(previous[key] ?? null) !== learningVersion(configuration[key] ?? null));
      if (structuralChanged) {
        initial = resetMeasurement(initial, configuration, entry.at);
        initial.model.performance = initialAdaptiveModel(configuration).performance;
        initial.model.floor = initialAdaptiveModel(configuration).floor;
        initial.model.parameters.hydronicCPerKwh = initialAdaptiveModel(configuration).parameters.hydronicCPerKwh;
      }
      initial.model.energy = { ...initial.model.energy,
        compressorKw: defaults.compressorKw, auxiliaryKw: defaults.auxiliaryKw,
        circulationKw: defaults.circulationKw, dhwrKw: defaults.dhwrKw,
        recoveryMultiplier: defaults.recoveryMultiplier, auxiliaryRiskScale: defaults.auxiliaryRiskScale,
        relativeUncertainty: defaults.relativeUncertainty, basis: 'estimated',
        recoveryCalibrationEpisodes: 0, auxiliaryCalibrationEpisodes: 0,
        configurationChangedAt: entry.at };
    }
  }
  const sensorChange = entry.payload.value.sensorChange;
  if (sensorChange && !fireplaceContext.revertedSensorChanges?.includes(entry.id)) {
    initial = restoreAdaptiveCheckpoint(initial, configuration);
    // Replacement changes measurement continuity, not the building or equipment.
    // Keep fitted parameters, validation, episodes and comfort references; the
    // scoped measurement mask and interval boundary prevent learning the jump.
    if (affectsThermalLearning(sensorChange.signal, configuration)) initial.state = null;
    initial.sensorEpochs = { ...initial.sensorEpochs, [sensorChange.signal]: entry.at };
  }
  const historySeed = entry.payload.value.historySeed;
  if (historySeed) {
    initial = { ...restoreAdaptiveCheckpoint(initial, configuration),
      ...(historySeed.model ? { model: structuredClone(historySeed.model) } : {}),
      ...(Number.isFinite(historySeed.baselineC) ? { baselineC: historySeed.baselineC,
        comfortReference: structuredClone(historySeed.comfortReference), comfortLearning: null } : {}),
      historicalSeed: structuredClone(historySeed.source) };
  }
  if (Number.isFinite(entry.payload.value.resetEquipmentResponseAt)
    && entry.payload.value.resetEquipmentResponseAt > (initial?.equipmentEpochAt ?? -Infinity)) {
    initial = { ...restoreAdaptiveCheckpoint(initial, configuration),
      equipmentEpochAt: entry.payload.value.resetEquipmentResponseAt };
    // A native ROOM edit changes equipment response, not measurement identity
    // or the achieved household temperature. Retain the reference and its
    // chronological learning state while new Normal evidence follows the edit.
    initial.model.equipmentResponse = { phases: {}, validation: null };
    initial.model.forecastValidation = null;
  }
  let value = entry.kind === 'sample' ? withFireplaceInputs(withSensorMeasurements(entry.payload.value, initial, configuration), fireplaceContext) : entry.payload.value;
  const oldMeasurementEpisode = entry.kind === 'episode' && Number.isFinite(initial?.measurementEpochAt)
    && (typeof value.startedAt === 'number' ? value.startedAt : Date.parse(value.startedAt)) < initial.measurementEpochAt;
  const next = entry.kind === 'sample'
    ? updateAdaptiveLearning(initial, value, { now: entry.at, config: configuration })
    : entry.kind === 'episode' && !oldMeasurementEpisode && !fireplaceEpisodeAffected(value, fireplaceContext) ? updateAdaptiveEpisode(initial, value, { config: configuration })
      : restoreAdaptiveCheckpoint(initial, configuration);
  const journalEntryHash = learningVersion(entry);
  const result = { ...next, ...(entry.kind === 'sample' ? { windowCursor: entry.payload.value.windowEnd ?? entry.at } : {}),
    journalCursor: entry.id, algorithmVersion: LEARNING_ALGORITHM,
    journalEntryHash, journalHash: learningVersion({ previous: checkpoint?.journalCursor ? checkpoint.journalHash ?? null : null, entry: journalEntryHash }),
    configVersion: entry.configVersion, learningConfiguration: structuredClone(configuration), forecastVersion: entry.forecastVersion,
    ...(fireplaceContext.fireplaceRevision ? { fireplaceRevision: fireplaceContext.fireplaceRevision } : {}),
    sensorRevision: fireplaceContext.sensorRevision ?? 0 };
  result.checkpointDigest = learningCheckpointDigest(result);
  return result;
}

/** Immutable entries are already committed, so replay needs no writer lock.
 * The checkpoint and its cursor are one atomic state update after computation.
 * A crash before that update replays the same entries from the saved cursor.
 * Rebuild uses precisely this same ordered entry function. A caller composing
 * a catch-up batch may defer checkpoint persistence until its final result. */
export function replayLearningJournal(store, input, checkpoint = null,
  { rebuild = false, fireplaceRevision, sensorRevision, persistCheckpoint = true } = {}) {
  // Source recovery may commit old manual events in bounded batches while the
  // selected journal/model still serves live control. Its completed projection
  // is published atomically; do not accidentally trigger a synchronous rebuild
  // from those partially recovered source revisions on an ordinary control tick.
  const recovery = store.getState?.(`recovery:active:${input}`);
  if (!rebuild && checkpoint && ['importing', 'rebuilding', 'catching-up'].includes(recovery?.status)) {
    fireplaceRevision = checkpoint.fireplaceRevision ?? 0; sensorRevision = checkpoint.sensorRevision ?? 0;
  }
  const fireplaceContext = { ...fireplaceLearningContext(store, input, fireplaceRevision), ...sensorLearningContext(store, input, sensorRevision) };
  if (checkpoint?.algorithmVersion && checkpoint.algorithmVersion !== LEARNING_ALGORITHM)
    throw new Error('Unsupported Home checkpoint algorithm; start fresh.');
  let next = rebuild ? null : checkpoint;
  if (next && ((next.fireplaceRevision ?? 0) !== fireplaceContext.fireplaceRevision
    || (next.sensorRevision ?? 0) !== fireplaceContext.sensorRevision)) next = null;
  if (next?.journalCursor) {
    const last = store.learningJournal({ input, after: next.journalCursor - 1, limit: 1, algorithmVersion: LEARNING_ALGORITHM })[0];
    if (!last || !validLearningCheckpoint(next, last)) next = null;
  }
  for (;;) {
    const entries = store.learningJournal({ input, after: next?.journalCursor ?? 0, limit: 256, algorithmVersion: LEARNING_ALGORITHM });
    if (!entries.length) break;
    for (const entry of entries) next = applyLearningRecord(next, entry, fireplaceContext);
    if (persistCheckpoint) store.setState(`adaptive:${input}`, next);
  }
  return next ?? restoreAdaptiveCheckpoint(null);
}
