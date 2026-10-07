/** Evidence-time learning of the achieved occupied Normal temperature. */
import { fireplaceAffectsLearning } from '../domain/fireplace.js';

const HOUR = 3_600_000;
const finite = Number.isFinite;
const instant = value => typeof value === 'number' ? value : Date.parse(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
export const COMFORT_REFERENCE_POLICY = Object.freeze({
  initializationHours: 1, provisionalHours: 24, smoothingHours: 48,
  innovationLimitC: 1, settlingHours: 2, heatingMemoryHours: 6, maximumObservationGapHours: 2,
  proxyMaximumOutdoorC: 12, proxyMinimumGapC: 8,
});

export function goodQuality(quality) {
  const flags = Array.isArray(quality) ? quality : quality ? [quality] : [];
  return flags.every(flag => ['good', 'simulated', 'historical', 'corrected_price', 'converted_fahrenheit', 'requested_not_observed'].includes(flag));
}

/** Control estimates retain separate provenance even when another caller has
 * not copied the quality flag. They can never become observed learning input. */
export function hasEstimatedIndoor(sample) {
  return sample?.estimated === true || sample?.indoorEstimated === true
    || Object.values(sample?.indoorSensors ?? {}).some(sensor => sensor.weight > 0 && sensor.estimated === true);
}

export function validComfortReference(reference) {
  return reference?.version === 4 && finite(reference.targetC) && reference.targetC >= 12 && reference.targetC <= 28
    && reference.source === 'occupied-normal-temperature-average'
    && !['adaptation', 'windowStart', 'windowEnd', 'samples'].some(key => Object.hasOwn(reference, key))
    && ['observed-heating-baseline', 'provisional-heating-demand-baseline'].includes(reference.confidence)
    && ['sustained-cool-weather-proxy', 'verified-space-heating-activity'].includes(reference.heatingEvidence?.kind)
    && finite(reference.evidenceHours) && reference.evidenceHours + 1e-9 >= COMFORT_REFERENCE_POLICY.initializationHours
    && finite(reference.verifiedEvidenceHours) && reference.verifiedEvidenceHours >= 0
    && reference.verifiedEvidenceHours <= reference.evidenceHours
    && reference.provisional === (reference.verifiedEvidenceHours < COMFORT_REFERENCE_POLICY.provisionalHours)
    && finite(instant(reference.establishedAt)) && finite(instant(reference.updatedAt))
    && finite(instant(reference.adjustedAt)) && instant(reference.adjustedAt) <= instant(reference.updatedAt)
    && instant(reference.establishedAt) <= instant(reference.updatedAt);
}

export function validComfortLearning(state) {
  return state?.version === 1 && (state.reference === null || validComfortReference(state.reference))
    && (state.cursor === null || finite(instant(state.cursor)))
    && finite(state.evidenceHours) && state.evidenceHours >= 0
    && finite(state.verifiedEvidenceHours) && state.verifiedEvidenceHours >= 0
    && state.verifiedEvidenceHours <= state.evidenceHours
    && (state.bootstrapC === null || finite(state.bootstrapC) && state.bootstrapC >= 12 && state.bootstrapC <= 28)
    && (state.lastSpaceHeatingAt === null || finite(state.lastSpaceHeatingAt))
    && (state.settlingUntil === null || finite(state.settlingUntil))
    && (state.lastSample === null || finite(instant(state.lastSample?.timestamp))
      && finite(state.lastSample?.indoorC) && instant(state.lastSample.timestamp) <= instant(state.cursor))
    && ['waiting-for-observations', 'excluded-operation', 'settling-after-intervention', 'heating-demand-unavailable', 'learning'].includes(state.status)
    && (state.reference === null || state.reference.evidenceHours === state.evidenceHours
      && state.reference.verifiedEvidenceHours === state.verifiedEvidenceHours);
}

function validObservation(sample) {
  const sensors = Object.values(sample?.indoorSensors ?? {}).filter(sensor => sensor.weight > 0);
  return finite(instant(sample?.timestamp)) && finite(sample.indoorC) && sample.indoorC >= 12 && sample.indoorC <= 28
    && finite(sample.outdoorC) && sample.outdoorC >= -60 && sample.outdoorC <= 50
    && sample.valid !== false && !hasEstimatedIndoor(sample) && goodQuality(sample.quality)
    && sensors.every(sensor => finite(sensor.value) && sensor.estimated !== true && sensor.reportCoverageComplete !== false);
}

function normalOperation(sample) {
  return sample.phase === 'normal' && sample.regime === 'occupied'
    && sample.preheat !== true && sample.recovering !== true && !(sample.roomBoostC > 0)
    && !fireplaceAffectsLearning(sample)
    && (!sample.inputSegments || sample.inputSegments.every(segment => segment.phase === 'normal'
      && segment.regime === 'occupied' && !(segment.roomBoostC > 0)));
}

function ownIntervention(sample) {
  return ['preheat', 'reduction', 'recovery'].includes(sample.phase)
    || sample.preheat === true || sample.recovering === true || sample.roomBoostC > 0
    || sample.inputSegments?.some(segment => ['preheat', 'reduction', 'recovery'].includes(segment.phase) || segment.roomBoostC > 0);
}

/** Full report coverage confirms an unchanged value. Without that contract,
 * every contributing thermometer must have supplied a new actual observation.
 * Reading an old application value again never earns another learning interval. */
function supportedHours(previous, sample) {
  const end = instant(sample.timestamp), previousAt = instant(previous?.timestamp);
  const completedStart = instant(sample.windowStart);
  const start = finite(completedStart) ? Math.max(completedStart, finite(previousAt) ? previousAt : completedStart) : previousAt;
  if (!finite(start) || end <= start || end - start > COMFORT_REFERENCE_POLICY.maximumObservationGapHours * HOUR) return 0;
  const members = Object.entries(sample.indoorSensors ?? {}).filter(([, sensor]) => sensor.weight > 0);
  if (!previous && !members.length) return 0;
  if (!members.every(([signal, sensor]) => sensor.reportCoverageComplete === true
    || finite(instant(sensor.observedAt)) && finite(instant(previous?.indoorSensors?.[signal]?.observedAt))
      && instant(sensor.observedAt) > instant(previous.indoorSensors[signal].observedAt)
      && instant(sensor.observedAt) >= start && instant(sensor.observedAt) <= end)) return 0;
  return (end - start) / HOUR;
}

function heatingEvidence(state, sample, at) {
  const heating = sample.heating;
  const verified = heating?.verified === true && typeof heating.compressorActive === 'boolean'
    && ['space-heating', 'dhw', 'idle'].includes(heating.route) && goodQuality(heating.quality);
  const duty = sample.thermalCompressorDuty ?? heating?.compressorDuty ?? sample.compressorDuty;
  const active = verified && heating.route === 'space-heating'
    && (finite(duty) ? duty > 0 : !sample.inputSegments && heating.compressorActive)
    || finite(sample.thermalAuxKw) && sample.thermalAuxKw > 0;
  if (active) state.lastSpaceHeatingAt = at;
  if (state.lastSpaceHeatingAt !== null && at - state.lastSpaceHeatingAt <= COMFORT_REFERENCE_POLICY.heatingMemoryHours * HOUR)
    return { kind: 'verified-space-heating-activity', lastSpaceHeatingAt: new Date(state.lastSpaceHeatingAt).toISOString(),
      compressorDuty: finite(duty) ? duty : null, outdoorC: sample.outdoorC, indoorOutdoorGapC: sample.indoorC - sample.outdoorC };
  if (!verified && sample.outdoorC <= COMFORT_REFERENCE_POLICY.proxyMaximumOutdoorC
    && sample.indoorC - sample.outdoorC >= COMFORT_REFERENCE_POLICY.proxyMinimumGapC)
    return { kind: 'sustained-cool-weather-proxy', outdoorC: sample.outdoorC,
      indoorOutdoorGapC: sample.indoorC - sample.outdoorC };
  return null;
}

/** One ordered update, shared by live learning and replay. Gaps/exclusions pause
 * earned evidence; only newly supported Normal intervals move the reference.
 * The caller stores the pending state even before initialization. */
export function updateComfortLearning(previous, sample, { reference = null } = {}) {
  if (reference && !validComfortReference(reference)) throw new TypeError('Unsupported comfort reference; start fresh.');
  if (previous && !validComfortLearning(previous)) throw new TypeError('Unsupported comfort learning state; start fresh.');
  const state = previous ? structuredClone(previous) : { version: 1, reference: structuredClone(reference), cursor: reference?.updatedAt ?? null,
    evidenceHours: reference?.evidenceHours ?? 0, verifiedEvidenceHours: reference?.verifiedEvidenceHours ?? 0, bootstrapC: reference?.targetC ?? null, lastSample: null, lastSpaceHeatingAt: null, settlingUntil: null,
    status: 'waiting-for-observations', reason: 'No supported indoor observation interval yet.' };
  const at = instant(sample?.timestamp);
  if (!finite(at) || state.cursor !== null && at <= instant(state.cursor)) return state;
  state.cursor = new Date(at).toISOString();
  const preceding = state.lastSample;
  state.lastSample = null;
  if (ownIntervention(sample)) state.settlingUntil = at + COMFORT_REFERENCE_POLICY.settlingHours * HOUR;
  if (!validObservation(sample)) {
    state.status = 'waiting-for-observations'; state.reason = 'Learning paused: a contributing observation or its coverage is unavailable.';
    return state;
  }
  if (!normalOperation(sample)) {
    state.status = 'excluded-operation'; state.reason = 'Learning requires occupied Normal operation without fireplace influence.';
    return state;
  }
  state.lastSample = { timestamp: sample.timestamp, indoorC: sample.indoorC,
    indoorSensors: structuredClone(sample.indoorSensors ?? {}) };
  const evidence = heatingEvidence(state, sample, at);
  // End-of-window context cannot turn the interval before it into settled Normal.
  const intervalStart = finite(instant(sample.windowStart)) ? instant(sample.windowStart) : instant(preceding?.timestamp);
  if (state.settlingUntil !== null && (!finite(intervalStart) || intervalStart < state.settlingUntil)) {
    state.status = 'settling-after-intervention'; state.reason = 'Learning pauses for two hours of Normal after a heating intervention.';
    return state;
  }
  if (!evidence) {
    state.status = 'heating-demand-unavailable'; state.reason = 'No recent verified space heating or cool-weather heating demand.';
    return state;
  }
  const hours = supportedHours(preceding, sample);
  if (!(hours > 0)) {
    state.status = 'waiting-for-observations'; state.reason = 'Waiting for a new observation or genuine unchanged-report coverage.';
    return state;
  }
  state.status = 'learning'; state.reason = null;
  const beforeHours = state.evidenceHours;
  state.evidenceHours += hours;
  if (evidence.kind === 'verified-space-heating-activity') state.verifiedEvidenceHours += hours;
  if (!state.reference) {
    // Bounded influence prevents one unusual startup interval dominating the seed.
    const candidate = state.bootstrapC === null ? sample.indoorC
      : state.bootstrapC + clamp(sample.indoorC - state.bootstrapC, -1, 1);
    state.bootstrapC = ((state.bootstrapC ?? 0) * beforeHours + candidate * hours) / state.evidenceHours;
    if (state.evidenceHours + 1e-9 < COMFORT_REFERENCE_POLICY.initializationHours) return state;
  }
  const previousTarget = state.reference?.targetC;
  const targetC = finite(previousTarget) ? previousTarget
    + clamp(sample.indoorC - previousTarget, -COMFORT_REFERENCE_POLICY.innovationLimitC, COMFORT_REFERENCE_POLICY.innovationLimitC)
      * -Math.expm1(-hours / COMFORT_REFERENCE_POLICY.smoothingHours) : state.bootstrapC;
  const timestamp = new Date(at).toISOString();
  state.reference = { version: 4, targetC, establishedAt: state.reference?.establishedAt ?? timestamp,
    updatedAt: timestamp, adjustedAt: targetC === previousTarget ? state.reference.adjustedAt : timestamp,
    source: 'occupied-normal-temperature-average', evidenceHours: state.evidenceHours,
    verifiedEvidenceHours: state.verifiedEvidenceHours,
    provisional: state.verifiedEvidenceHours < COMFORT_REFERENCE_POLICY.provisionalHours,
    confidence: evidence.kind === 'verified-space-heating-activity' ? 'observed-heating-baseline' : 'provisional-heating-demand-baseline',
    heatingEvidence: evidence,
    semantics: 'achieved weighted indoor temperature during occupied Normal; not thermostat intent or continuous compressor runtime' };
  return state;
}
