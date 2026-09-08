/** Small empirical temperature model. Priors permit bounded operation before every
 * actuator is observed; validation never turns assumed electricity into a meter. */
import { inferComfortReference, goodQuality } from './learning.js';

const HOUR = 3_600_000;
const MAX_SAMPLES = 1536;
const REFIT_RECORDS = 12;
const MIN_PHASE_EPISODES = 3;
const finite = Number.isFinite;
const time = value => typeof value === 'number' ? value : Date.parse(value);
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const PHASES = ['normal', 'preheat', 'reduction', 'recovery'];
const BOUNDS = Object.freeze({
  lossPerHour: [0.001, 0.12], normalHeatCPerHour: [0.05, 3], reducedHeatCPerHour: [0, 1.5],
  preheatCPerHourPerDegree: [0, 0.4], solarCPerHourPerKwM2: [0, 2.5],
  memoryExchangePerHour: [0.005, 0.4], reserveTimeHours: [2, 72], auxiliaryCPerKwh: [0.01, 0.6],
});
const DEFAULTS = Object.freeze({ lossPerHour: 0.018, normalHeatCPerHour: 0.75,
  reducedHeatCPerHour: 0.10, preheatCPerHourPerDegree: 0.06, solarCPerHourPerKwM2: 0.45,
  memoryExchangePerHour: 0.08, reserveTimeHours: 12, auxiliaryCPerKwh: 0.15 });

function positive(value, fallback, maximum = 30) {
  return finite(value) && value > 0 && value <= maximum ? value : fallback;
}

export function initialAdaptiveModel(config = {}) {
  const parameters = { ...DEFAULTS };
  for (const [name, bounds] of Object.entries(BOUNDS)) {
    const candidate = config.thermalPriors?.[name];
    if (finite(candidate)) parameters[name] = clamp(candidate, ...bounds);
  }
  parameters.reducedHeatCPerHour = Math.min(parameters.reducedHeatCPerHour, parameters.normalHeatCPerHour);
  return { version: 1, parameters, uncertaintyCPerHour: 0.15, trainedAt: null,
    validation: null, energy: {
      compressorKw: positive(config.heatPumpCompressorKw, 3),
      auxiliaryKw: positive(config.auxRatedKw, 9),
      circulationKw: positive(config.circulationKw, 0.05, 1),
      dhwrKw: positive(config.dhwrKw, 0.05, 1),
      relativeUncertainty: 0.6, recoveryMultiplier: 1.5, auxiliaryRiskScale: 1, basis: 'estimated', episodes: 0,
      measuredEpisodes: 0, recoveryHours: null, recoveryEnergyKwh: null,
      recoveryCalibrationEpisodes: 0, auxiliaryCalibrationEpisodes: 0,
    }, provenance: { method: 'bounded regularized temperature response with a latent heat reserve',
      status: 'prior-estimates', reserve: 'effective temperature memory; not measured slab temperature or capacity',
      heating: 'effective available response; not measured maximum compressor output or COP',
      preheat: 'coupled ROOM and DHWR response; useful heat under continuing heating demand',
      solar: 'global-radiation forecast response; no radiation observations',
      electricity: 'nominal or calibrated estimates unless an episode explicitly carries metered energy' } };
}

function validModel(model) {
  return model?.version === 1 && Object.entries(BOUNDS).every(([key, bounds]) =>
    finite(model.parameters?.[key]) && model.parameters[key] >= bounds[0] && model.parameters[key] <= bounds[1])
    && model.parameters.reducedHeatCPerHour <= model.parameters.normalHeatCPerHour
    && finite(model.uncertaintyCPerHour) && model.uncertaintyCPerHour >= 0.02 && model.uncertaintyCPerHour <= 1;
}

/** reserveC is an absolute latent building-temperature proxy, initially indoorC.
 * The same thermostat response and compressor duty are used by fitting and planning.
 * No artificial indoor upper temperature cap is applied. */
export function predictThermalStep(model, state, inputs, dtHours) {
  if (!validModel(model) || !finite(state?.indoorC) || !finite(inputs?.outdoorC)
    || !finite(dtHours) || dtHours <= 0 || dtHours > 72) throw new TypeError('Valid thermal model, temperatures and a bounded positive duration required');
  const p = model.parameters, phase = PHASES.includes(inputs.phase) ? inputs.phase : 'normal';
  const boost = phase === 'preheat' ? clamp(finite(inputs.roomBoostC) ? inputs.roomBoostC : 0, 0, 5) : 0;
  const target = finite(inputs.targetC) ? inputs.targetC : 21;
  const solarKnown = finite(inputs.solarRadiationWm2) && inputs.solarRadiationWm2 >= 0 && inputs.solarRadiationWm2 <= 2000;
  const solar = solarKnown ? inputs.solarRadiationWm2 / 1000 * p.solarCPerHourPerKwM2 : 0;
  const capacity = phase === 'reduction' ? p.reducedHeatCPerHour : p.normalHeatCPerHour;
  const coupledHeat = phase === 'preheat' ? boost * p.preheatCPerHourPerDegree : 0;
  const observedDuty = finite(inputs.compressorDuty) ? clamp(inputs.compressorDuty, 0, 1) : null;
  const auxiliaryKw = finite(inputs.auxKw) ? clamp(inputs.auxKw, 0, 20) : 0;
  let indoorC = state.indoorC, reserveC = finite(state.reserveC) ? state.reserveC : indoorC;
  const initialReserveC = reserveC;
  let dutyHours = 0, heatC = 0;
  for (let remaining = dtHours; remaining > 1e-9;) {
    const dt = Math.min(0.25, remaining);
    const loss = p.lossPerHour * (indoorC - inputs.outdoorC);
    const demand = Math.max(0, loss + 0.25 * (target + boost - indoorC));
    const available = capacity + coupledHeat;
    const requestFraction = available > 0 ? clamp(demand / available, 0, 1) : 0;
    // A reduced heat allowance means less compressor operation, not a fictitious
    // low-output compressor drawing its full electrical power continuously.
    const duty = observedDuty ?? requestFraction * capacity / p.normalHeatCPerHour;
    // Coupled DHWR heat is useful while heat is demanded. It is included here once;
    // the economic model must still count the circulation and DHW reheating costs.
    const heat = p.normalHeatCPerHour * duty + (demand > 0 ? coupledHeat * requestFraction : 0)
      + auxiliaryKw * p.auxiliaryCPerKwh;
    const exchange = p.memoryExchangePerHour * (reserveC - indoorC);
    const nextReserve = reserveC + (indoorC - reserveC) / p.reserveTimeHours * dt;
    indoorC += (-loss + heat + solar + exchange) * dt;
    reserveC = nextReserve;
    dutyHours += duty * dt;
    heatC += heat * dt;
    remaining -= dt;
  }
  const phaseCoverage = model.validation?.phaseSamples?.[phase] ?? 0;
  const checkedPhase = phaseCoverage >= 12 && (model.validation?.phaseValidationSamples?.[phase] ?? 0) >= 4
    && (phase === 'normal' || (model.validation?.phaseEpisodes?.[phase] ?? 0) >= MIN_PHASE_EPISODES);
  const unobservedAction = phase !== 'normal' && !checkedPhase ? 0.08 : 0;
  const solarChecked = (model.validation?.sunlitSamples ?? 0) >= 12 && (model.validation?.sunlitValidationSamples ?? 0) >= 4;
  const uncertainSolar = solarKnown ? solarChecked ? 0 : inputs.solarRadiationWm2 / 1000 * 0.15 : 0.08;
  return { indoorC, reserveC,
    uncertaintyC: Math.sqrt(dtHours) * (model.uncertaintyCPerHour + uncertainSolar + unobservedAction),
    compressorDuty: dutyHours / dtHours, usefulHeatCPerHour: heatC / dtHours,
    solarCPerHour: solar, reserveChangeC: reserveC - initialReserveC,
    solarKnown, phaseEvidence: checkedPhase ? 'checked' : phaseCoverage >= 12 ? 'observed-unchecked' : 'prior' };
}

function validSample(sample) {
  return finite(time(sample?.timestamp)) && finite(sample.indoorC) && sample.indoorC > 2 && sample.indoorC < 40
    && finite(sample.outdoorC) && sample.outdoorC >= -60 && sample.outdoorC <= 50
    && PHASES.includes(sample.phase) && ['occupied', 'away'].includes(sample.regime)
    && goodQuality(sample.quality) && sample.valid !== false;
}

function checkpoint(input, config) {
  let copied;
  try { copied = typeof input === 'string' ? JSON.parse(input) : structuredClone(input); } catch { copied = null; }
  if (copied?.version !== 1 || !Array.isArray(copied.samples)) copied = {
    version: 1, cursor: null, samples: [], model: initialAdaptiveModel(config), baselineC: null,
    health: { status: 'prior-estimates', acceptedFits: 0, rejectedFits: 0 }, sinceFit: 0,
  };
  if (!validModel(copied.model)) {
    copied.model = initialAdaptiveModel(config);
    copied.health = { status: 'prior-estimates', reason: 'invalid-checkpoint-model', acceptedFits: 0, rejectedFits: 0 };
  }
  const defaults = initialAdaptiveModel(config);
  const savedEnergy = copied.model.energy ?? {};
  copied.model.energy = { ...defaults.energy, ...savedEnergy,
    compressorKw: positive(savedEnergy.compressorKw, defaults.energy.compressorKw),
    auxiliaryKw: positive(savedEnergy.auxiliaryKw, defaults.energy.auxiliaryKw),
    circulationKw: positive(savedEnergy.circulationKw, defaults.energy.circulationKw, 1),
    dhwrKw: positive(savedEnergy.dhwrKw, defaults.energy.dhwrKw, 1),
    relativeUncertainty: finite(savedEnergy.relativeUncertainty) ? clamp(savedEnergy.relativeUncertainty, 0.2, 1.5) : defaults.energy.relativeUncertainty,
    recoveryMultiplier: finite(savedEnergy.recoveryMultiplier) ? clamp(savedEnergy.recoveryMultiplier, 0.75, 4) : defaults.energy.recoveryMultiplier,
    auxiliaryRiskScale: finite(savedEnergy.auxiliaryRiskScale) ? clamp(savedEnergy.auxiliaryRiskScale, 0.2, 4) : 1,
  };
  copied.model.provenance = { ...defaults.provenance, ...copied.model.provenance };
  copied.health ??= { status: 'prior-estimates', acceptedFits: 0, rejectedFits: 0 };
  // Preserve chronological barriers, but do not let corrupt saved records invent a sequence.
  let previous = -Infinity;
  copied.samples = copied.samples.filter(sample => {
    const at = time(sample?.timestamp);
    if (!finite(at) || at <= previous) return false;
    previous = at; return true;
  }).slice(-MAX_SAMPLES);
  if (!finite(time(copied.cursor))) copied.cursor = copied.samples.at(-1)?.timestamp ?? null;
  if (!finite(copied.baselineC) || copied.baselineC < 12 || copied.baselineC > 28) copied.baselineC = null;
  copied.sinceFit = Number.isSafeInteger(copied.sinceFit) && copied.sinceFit >= 0 ? copied.sinceFit : 0;
  return copied;
}

export function restoreAdaptiveCheckpoint(input, config = {}) {
  const cp = checkpoint(input, config);
  cp.health.usableSamples = cp.samples.filter(validSample).length;
  cp.health.retainedRecords = cp.samples.length;
  return cp;
}

function sampleInputs(sample, targetC) {
  return { outdoorC: sample.outdoorC, solarRadiationWm2: sample.solarRadiationWm2,
    phase: sample.phase, roomBoostC: sample.roomBoostC, targetC: finite(sample.targetC) ? sample.targetC : targetC,
    compressorDuty: Object.hasOwn(sample, 'thermalCompressorDuty') ? sample.thermalCompressorDuty : sample.compressorDuty,
    auxKw: Object.hasOwn(sample, 'thermalAuxKw') ? sample.thermalAuxKw : sample.auxKw };
}

function intervalInputs(a, b, targetC) {
  return b.intervalInputs && b.windowStart === time(a.timestamp) ? { ...b.intervalInputs,
    targetC: finite(b.intervalInputs.targetC) ? b.intervalInputs.targetC : targetC } : sampleInputs(a, targetC);
}

/** Validation runs through whole available day/episode blocks (6–24 hours),
 * without resetting indoor temperature after every hour. Missing data breaks a
 * block; a short surviving fragment cannot qualify a model. */
function evaluate(model, samples, { targetC = 21, scoreFrom = 0, rollout = false } = {}) {
  let state = null, rolloutHours = 0, persistenceStart = null, lastIndoor = null, block = null;
  const squaredRates = [], errors = [], persistenceErrors = [];
  const horizons = [];
  const finish = () => {
    if (rolloutHours >= 6 && state && finite(lastIndoor)) {
      errors.push(Math.abs(lastIndoor - state.indoorC) / rolloutHours);
      persistenceErrors.push(Math.abs(lastIndoor - persistenceStart) / rolloutHours);
      horizons.push(rolloutHours);
    }
    rolloutHours = 0; block = null;
  };
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i], dt = (time(b.timestamp) - time(a.timestamp)) / HOUR;
    if (!validSample(a) || !validSample(b) || dt < 1 / 12 || dt > 2
      || Math.abs((b.indoorC - a.indoorC) / dt) > 2) { state = null; rolloutHours = 0; block = null; continue; }
    if (!state) state = { indoorC: a.indoorC, reserveC: a.indoorC };
    const scoring = i - 1 >= scoreFrom;
    const group = a.episodeId ? `episode:${a.episodeId}` : `day:${Math.floor(time(a.timestamp) / (24 * HOUR))}`;
    if (rollout && scoring && block !== null && group !== block) finish();
    if (!rollout || !scoring || rolloutHours === 0) {
      state.indoorC = a.indoorC;
      persistenceStart = a.indoorC;
      if (scoring) block = group;
    }
    state = predictThermalStep(model, state, intervalInputs(a, b, targetC), dt);
    if (!scoring) continue;
    if (!rollout) squaredRates.push(((b.indoorC - state.indoorC) / dt) ** 2);
    else {
      rolloutHours += dt;
      lastIndoor = b.indoorC;
      if (rolloutHours >= 24) finish();
    }
  }
  if (rollout) finish();
  return { mse: squaredRates.length ? mean(squaredRates) : Infinity,
    maeCPerHour: errors.length ? mean(errors) : Infinity,
    persistenceMaeCPerHour: persistenceErrors.length ? mean(persistenceErrors) : Infinity,
    samples: errors.length, horizons, state };
}

function fit(cp, config) {
  // Keep complete older episodes alongside the recent temperature window. The
  // immutable journal remains the full archive; these bounded exemplars prevent
  // a rare phase disappearing merely because normal operation filled the tail.
  const byTime = new Map([...(cp.episodeArchive ?? []).flatMap(entry => entry.samples), ...cp.samples]
    .map(sample => [time(sample.timestamp), sample]));
  const samples = [...byTime.values()].sort((a, b) => time(a.timestamp) - time(b.timestamp));
  let split = Math.floor(samples.length * 0.7);
  const splitDay = Math.floor(time(samples[split]?.timestamp) / (24 * HOUR));
  while (split > 0 && (Math.floor(time(samples[split - 1].timestamp) / (24 * HOUR)) === splitDay
    || samples[split]?.episodeId && samples[split - 1].episodeId === samples[split].episodeId)) split--;
  if (split < 32) return { accepted: false, reason: 'collecting-temperature-intervals' };
  const validateAfter = time(samples[split - 1].timestamp) + 12 * HOUR;
  const scoreFrom = samples.findIndex((sample, i) => i >= split && time(sample.timestamp) >= validateAfter);
  if (scoreFrom < 0) return { accepted: false, reason: 'collecting-later-validation' };
  const training = samples.slice(0, split), prior = initialAdaptiveModel(config);
  const trainingEnd = time(training.at(-1).timestamp);
  const phaseEpisodes = Object.fromEntries(PHASES.map(phase => [phase, (cp.episodeArchive ?? [])
    .filter(episode => episode.endedAt <= trainingEnd && episode.phases.includes(phase)).length]));
  const tunable = new Set(['lossPerHour', 'normalHeatCPerHour', 'solarCPerHourPerKwM2']);
  if (phaseEpisodes.reduction >= MIN_PHASE_EPISODES) tunable.add('reducedHeatCPerHour');
  if (phaseEpisodes.preheat >= MIN_PHASE_EPISODES) tunable.add('preheatCPerHourPerDegree');
  if (phaseEpisodes.recovery >= MIN_PHASE_EPISODES) {
    tunable.add('memoryExchangePerHour'); tunable.add('reserveTimeHours');
  }
  if ((cp.episodeArchive ?? []).filter(episode => episode.endedAt <= trainingEnd && episode.auxiliaryObserved).length >= MIN_PHASE_EPISODES)
    tunable.add('auxiliaryCPerKwh');
  const sunlitDays = new Set(training.filter(sample => sample.solarRadiationWm2 > 50)
    .map(sample => Math.floor(time(sample.timestamp) / (24 * HOUR))));
  if (sunlitDays.size < 3) tunable.delete('solarCPerHourPerKwM2');
  const targetC = cp.baselineC ?? (finite(config.targetC) ? config.targetC : 21);
  let candidate = structuredClone(cp.model);
  const objective = model => {
    const error = evaluate(model, training, { targetC }).mse;
    const penalty = Object.keys(BOUNDS).reduce((sum, key) => sum
      + ((model.parameters[key] - prior.parameters[key]) / Math.max(0.02, prior.parameters[key])) ** 2, 0) * 0.0001;
    return error + penalty;
  };
  let best = objective(candidate);
  if (!finite(best)) return { accepted: false, reason: 'no-usable-temperature-intervals' };
  // A bounded coordinate search avoids an underdetermined inverse capacity fit.
  // Terms lacking evidence stay near explicit priors, including all-normal startup.
  for (const scale of [0.4, 0.2, 0.1]) for (const [key, bounds] of Object.entries(BOUNDS)) {
    if (!tunable.has(key)) continue;
    const current = candidate.parameters[key], step = Math.max(prior.parameters[key], (bounds[1] - bounds[0]) * 0.025) * scale;
    for (const direction of [-1, 1]) {
      const attempt = structuredClone(candidate);
      attempt.parameters[key] = clamp(current + direction * step, ...bounds);
      if (attempt.parameters.reducedHeatCPerHour > attempt.parameters.normalHeatCPerHour) continue;
      const score = objective(attempt);
      if (score < best) { best = score; candidate = attempt; }
    }
  }
  const validation = evaluate(candidate, samples, { targetC, scoreFrom, rollout: true });
  if (validation.samples < 2) return { accepted: false, reason: 'collecting-later-validation' };
  const previous = evaluate(cp.model, samples, { targetC, scoreFrom, rollout: true });
  if (validation.maeCPerHour > 0.35 || validation.maeCPerHour > previous.maeCPerHour * 1.05 + 0.01
    || validation.maeCPerHour > validation.persistenceMaeCPerHour * 1.1 + 0.03)
    return { accepted: false, reason: 'retained-better-predictions', validation: {
      accepted: false, maeCPerHour: validation.maeCPerHour, previousMaeCPerHour: previous.maeCPerHour } };
  const phaseSamples = Object.fromEntries(PHASES.map(phase => [phase, training.filter(sample => validSample(sample) && sample.phase === phase).length]));
  const holdout = samples.slice(scoreFrom);
  candidate.trainedAt = samples.at(-1).timestamp;
  candidate.uncertaintyCPerHour = clamp(validation.maeCPerHour * 2, 0.04, 0.6);
  candidate.validation = { accepted: true, chronological: true, samples: validation.samples,
    maeCPerHour: validation.maeCPerHour, persistenceMaeCPerHour: validation.persistenceMaeCPerHour,
    previousMaeCPerHour: previous.maeCPerHour, horizonHours: Math.min(...validation.horizons),
    maximumHorizonHours: Math.max(...validation.horizons),
    metric: 'hour-normalized temperature error over independent day/episode blocks', embargoHours: 12,
    trainThrough: samples[split - 1].timestamp, validateFrom: samples[scoreFrom].timestamp,
    phaseSamples, phaseEpisodes, fittedParameters: [...tunable],
    phaseValidationSamples: Object.fromEntries(PHASES.map(phase => [phase, holdout.filter(sample => validSample(sample) && sample.phase === phase).length])),
    solarSamples: training.filter(sample => finite(sample.solarRadiationWm2)).length,
    sunlitSamples: training.filter(sample => sample.solarRadiationWm2 > 50).length,
    sunlitValidationSamples: holdout.filter(sample => sample.solarRadiationWm2 > 50).length,
    limitation: 'checks multi-hour thermal blocks; energy and phases without distinct completed episodes remain uncertain' };
  candidate.provenance.status = 'checked-thermal-estimates';
  return { accepted: true, model: candidate, state: validation.state };
}

export function updateAdaptiveLearning(input, sample, { now = Date.now(), config = {} } = {}) {
  const nowAt = time(now);
  if (!finite(nowAt)) throw new TypeError('A valid current time is required');
  return appendAdaptiveSample(checkpoint(input, config), sample, { nowAt, config });
}

/** Historical pages avoid cloning/refitting the same checkpoint for every row. */
export function updateAdaptiveLearningBatch(input, samples, { now = Date.now(), config = {} } = {}) {
  if (!Array.isArray(samples) || samples.length > 512) throw new RangeError('Adaptive history needs a bounded page of at most 512 records');
  const nowAt = time(now);
  if (!finite(nowAt)) throw new TypeError('A valid current time is required');
  const cp = checkpoint(input, config), previousCursor = cp.cursor;
  for (const sample of samples) appendAdaptiveSample(cp, sample, { nowAt, config }, false);
  return cp.cursor === previousCursor ? cp : finishAdaptiveUpdate(cp, { nowAt, config });
}

function appendAdaptiveSample(cp, sample, { nowAt, config }, finish = true) {
  const at = time(sample?.timestamp);
  if (!finite(at) || at > nowAt || cp.cursor !== null && at <= time(cp.cursor)) return cp;
  const acceptedSample = validSample(sample);
  const normalized = acceptedSample ? { timestamp: new Date(at).toISOString(), indoorC: sample.indoorC,
    outdoorC: sample.outdoorC, solarRadiationWm2: finite(sample.solarRadiationWm2)
      && sample.solarRadiationWm2 >= 0 && sample.solarRadiationWm2 <= 2000 ? sample.solarRadiationWm2 : null,
    phase: sample.phase, roomBoostC: clamp(finite(sample.roomBoostC) ? sample.roomBoostC : 0, 0, 5),
    targetC: finite(sample.targetC) ? sample.targetC : null, regime: sample.regime, quality: sample.quality ?? [],
    heating: sample.heating ?? null, compressorDuty: finite(sample.compressorDuty) ? clamp(sample.compressorDuty, 0, 1) : null,
    powerKw: finite(sample.powerKw) && sample.powerKw >= 0 && sample.powerKw <= 30 ? sample.powerKw : null,
    auxKw: finite(sample.auxKw) && sample.auxKw >= 0 && sample.auxKw <= 20 ? sample.auxKw : null,
    thermalCompressorDuty: Object.hasOwn(sample, 'thermalCompressorDuty')
      ? finite(sample.thermalCompressorDuty) ? clamp(sample.thermalCompressorDuty, 0, 1) : null
      : finite(sample.compressorDuty) ? clamp(sample.compressorDuty, 0, 1) : null,
    thermalAuxKw: Object.hasOwn(sample, 'thermalAuxKw')
      ? finite(sample.thermalAuxKw) ? clamp(sample.thermalAuxKw, 0, 20) : null
      : finite(sample.auxKw) ? clamp(sample.auxKw, 0, 20) : null,
    energyBasis: ['measured', 'estimated'].includes(sample.energyBasis) ? sample.energyBasis : 'unknown',
    preheat: sample.phase === 'preheat' || sample.preheat === true,
    recovering: sample.phase === 'recovery' || sample.recovering === true,
    actualModeKnown: sample.actualModeKnown === true,
    episodeId: sample.episodeId ?? null,
    ...(sample.electricalContext ? { electricalContext: structuredClone(sample.electricalContext) } : {}),
    ...(sample.intervalInputs ? { intervalInputs: structuredClone(sample.intervalInputs), windowStart: sample.windowStart } : {}),
  } : { timestamp: new Date(at).toISOString(), valid: false, quality: ['invalid-observation'] };
  const previous = cp.samples.at(-1);
  cp.samples.push(normalized);
  cp.samples = cp.samples.slice(-MAX_SAMPLES);
  cp.cursor = normalized.timestamp;
  if (acceptedSample) {
    const dt = previous ? (at - time(previous.timestamp)) / HOUR : Infinity;
    const predicted = validSample(previous) && dt >= 1 / 12 && dt <= 2
      ? predictThermalStep(cp.model, cp.state ?? { indoorC: previous.indoorC, reserveC: previous.indoorC },
        intervalInputs(previous, normalized, cp.baselineC ?? 21), dt) : { reserveC: sample.indoorC };
    cp.state = { indoorC: sample.indoorC, reserveC: predicted.reserveC, observedAt: normalized.timestamp };
  } else cp.state = null;
  cp.sinceFit++;
  return finish ? finishAdaptiveUpdate(cp, { nowAt, config }) : cp;
}

function finishAdaptiveUpdate(cp, { nowAt, config }) {
  cp.comfortReference = inferComfortReference(cp.comfortReference, cp.samples.map(row => ({ ...row,
    action: row.phase === 'normal' ? 'normal' : 'reduction', regime: row.regime === 'occupied' ? 'occupied' : 'absence',
  })), { now: nowAt });
  cp.baselineC = cp.comfortReference?.targetC ?? cp.baselineC;
  const valid = cp.samples.filter(validSample);
  cp.health = { ...cp.health, processedThrough: cp.cursor, usableSamples: valid.length,
    retainedRecords: cp.samples.length, solarSamples: valid.filter(row => finite(row.solarRadiationWm2)).length,
    phaseSamples: Object.fromEntries(PHASES.map(phase => [phase, valid.filter(row => row.phase === phase).length])),
    evidence: valid.some(row => !row.actualModeKnown) ? 'includes-requested-modes' : 'observed-modes',
    electricityBasis: cp.model.energy?.basis ?? 'estimated' };
  if (cp.sinceFit >= REFIT_RECORDS) {
    cp.sinceFit = 0;
    const result = fit(cp, config);
    cp.health.lastFitAt = new Date(nowAt).toISOString();
    if (result.accepted) {
      cp.model = result.model;
      cp.health = { ...cp.health, status: 'learning', reason: null, acceptedFits: (cp.health.acceptedFits ?? 0) + 1 };
    } else cp.health = { ...cp.health, status: cp.model.validation ? 'retained-previous' : 'prior-estimates',
      reason: result.reason, rejectedFits: (cp.health.rejectedFits ?? 0) + 1,
      rejectedValidation: result.validation ?? null };
  }
  return cp;
}

/** Optional whole-cycle calibration. An incomplete cycle, missing attribution, or
 * repeated episode cannot strengthen the model. Estimated episodes remain estimates. */
export function updateAdaptiveEpisode(input, episode, { config = {} } = {}) {
  const cp = checkpoint(input, config);
  if (episode?.complete !== true || episode.recoveryComplete !== true || typeof episode.id !== 'string'
    || !episode.id || !finite(time(episode.endedAt)) || !['measured', 'estimated'].includes(episode.energyBasis)) return cp;
  cp.episodeIds ??= [];
  if (cp.episodeIds.includes(episode.id) || finite(time(cp.lastEpisodeAt)) && time(episode.endedAt) <= time(cp.lastEpisodeAt)) return cp;
  const energy = { ...cp.model.energy }, priorCount = energy.episodes ?? 0;
  const alpha = 1 / Math.min(20, priorCount + 2);
  const blend = (previous, value) => finite(previous) ? previous + alpha * (value - previous) : value;
  let useful = false;
  if ((episode.compressorEnergyMeasured === true || episode.compressorEnergyBasis === 'measured')
    && finite(episode.compressorKwh) && episode.compressorKwh >= 0 && finite(episode.compressorRunHours)
    && episode.compressorRunHours >= 0.25 && episode.compressorRunHours <= 168) {
    const kw = episode.compressorKwh / episode.compressorRunHours;
    if (kw >= 0.1 && kw <= 15) { energy.compressorKw = blend(energy.compressorKw, kw); useful = true; }
  }
  if (finite(episode.recoveryHours) && episode.recoveryHours >= 0 && episode.recoveryHours <= 168) {
    energy.recoveryHours = blend(energy.recoveryHours, episode.recoveryHours); useful = true;
  }
  if (finite(episode.recoveryEnergyKwh) && episode.recoveryEnergyKwh >= 0 && episode.recoveryEnergyKwh <= 2000) {
    energy.recoveryEnergyKwh = blend(energy.recoveryEnergyKwh, episode.recoveryEnergyKwh); useful = true;
  }
  // Store attribution separately. DHW auxiliary energy still belongs in total
  // episode cost even when its useful incidental heat contributes to room heating.
  for (const key of ['spaceHeatingAuxKwh', 'dhwAuxKwh']) if (finite(episode[key]) && episode[key] >= 0 && episode[key] <= 2000) {
    energy[key] = blend(energy[key], episode[key]); useful = true;
  }
  const measured = episode.energyBasis === 'measured' && finite(episode.actualEnergyKwh) && episode.actualEnergyKwh >= 0;
  // Match recovery components before changing their multipliers. Otherwise extra
  // AUX would be attributed twice: to compressor recovery and to auxiliary risk.
  const recoveryFeedback = episode.auxiliaryObserved === true
    && (measured || episode.compressorActivityObserved === true);
  if (recoveryFeedback && finite(episode.recoveryEnergyKwh) && finite(episode.recoveryAuxKwh)
    && finite(episode.predictedRecoveryEnergyKwh) && finite(episode.predictedRecoveryAuxKwh)) {
    const actual = episode.recoveryEnergyKwh - episode.recoveryAuxKwh;
    const expected = episode.predictedRecoveryEnergyKwh - episode.predictedRecoveryAuxKwh;
    if (actual >= 0 && expected >= 0.25 && episode.recoveryAuxKwh >= 0 && episode.predictedRecoveryAuxKwh >= 0) {
      const frozen = finite(episode.frozenRecoveryMultiplier) ? clamp(episode.frozenRecoveryMultiplier, 0.75, 4) : energy.recoveryMultiplier;
      const correction = clamp(frozen * actual / expected, 0.75, 4);
      const weight = measured ? alpha : Math.min(alpha, 0.2);
      energy.recoveryMultiplier = clamp(energy.recoveryMultiplier + weight * (correction - energy.recoveryMultiplier), 0.75, 4);
      energy.recoveryCalibrationEpisodes = (energy.recoveryCalibrationEpisodes ?? 0) + 1;
      energy.recoveryCalibrationBasis = measured ? 'measured-component-energy' : 'observed-runtime-with-nominal-power';
      useful = true;
    }
  }
  if (episode.auxiliaryObserved === true && episode.auxiliaryRouteKnown === true
    && finite(episode.spaceHeatingAuxKwh) && episode.spaceHeatingAuxKwh >= 0
    && finite(episode.predictedSpaceHeatingAuxKwh) && episode.predictedSpaceHeatingAuxKwh >= 0) {
    const expected = episode.predictedSpaceHeatingAuxKwh;
    if (expected >= 0.05 || episode.spaceHeatingAuxKwh >= 0.05) {
      const frozen = finite(episode.frozenAuxiliaryRiskScale) ? clamp(episode.frozenAuxiliaryRiskScale, 0.2, 4) : energy.auxiliaryRiskScale;
      const correction = clamp(frozen * episode.spaceHeatingAuxKwh / Math.max(0.05, expected), 0.2, 4);
      energy.auxiliaryRiskScale = clamp(blend(energy.auxiliaryRiskScale, correction), 0.2, 4);
      energy.auxiliaryCalibrationEpisodes = (energy.auxiliaryCalibrationEpisodes ?? 0) + 1;
      energy.auxiliaryCalibrationBasis = 'observed-stages-and-routing; nominal-stage-energy';
      if (expected < 0.05 && episode.spaceHeatingAuxKwh >= 0.05)
        energy.relativeUncertainty = Math.max(0.6, energy.relativeUncertainty);
      useful = true;
    }
  }
  if (!useful) return cp;
  if (finite(time(episode.startedAt)) && time(episode.startedAt) < time(episode.endedAt)) {
    const rows = cp.samples.filter(sample => validSample(sample)
      && time(sample.timestamp) >= time(episode.startedAt) && time(sample.timestamp) <= time(episode.endedAt));
    const stride = Math.max(1, Math.ceil(rows.length / 192));
    const retained = rows.filter((sample, index) => index % stride === 0 || index === rows.length - 1);
    const archive = [...(cp.episodeArchive ?? []), { id: episode.id, startedAt: time(episode.startedAt), endedAt: time(episode.endedAt),
      phases: [...new Set(episode.phases ?? rows.map(sample => sample.phase))],
      auxiliaryObserved: episode.auxiliaryObserved === true && (episode.spaceHeatingAuxKwh ?? 0) > 0,
      samples: retained }];
    // Retain early independent examples as well as recent cycles. Historical
    // journal entries are never deleted by this bounded fitting cache.
    const anchors = new Set(PHASES.flatMap(phase => archive.filter(row => row.phases.includes(phase)).slice(0, 3).map(row => row.id)));
    cp.episodeArchive = archive.filter(row => anchors.has(row.id) || archive.indexOf(row) >= archive.length - 12);
  }
  energy.episodes = priorCount + 1;
  energy.measuredEpisodes = (energy.measuredEpisodes ?? 0) + Number(measured);
  energy.basis = energy.measuredEpisodes >= 3 && measured ? 'calibrated-estimate' : 'estimated';
  if (finite(episode.predictedEnergyKwh) && episode.predictedEnergyKwh > 0.1
    && finite(episode.actualEnergyKwh) && episode.actualEnergyKwh >= 0 && episode.energyBasis === 'measured') {
    const relativeError = Math.abs(episode.actualEnergyKwh - episode.predictedEnergyKwh) / episode.predictedEnergyKwh;
    energy.relativeUncertainty = clamp(Math.max(relativeError * 1.5,
      blend(energy.relativeUncertainty, relativeError * 1.5)), energy.measuredEpisodes >= 6 ? 0.2 : 0.4, 1.5);
  }
  cp.model.energy = energy;
  cp.health.electricityBasis = energy.basis;
  cp.episodeIds.push(episode.id);
  cp.episodeIds = cp.episodeIds.slice(-256);
  cp.lastEpisodeAt = episode.endedAt;
  return cp;
}
