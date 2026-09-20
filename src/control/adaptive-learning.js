/** Small empirical temperature model. Priors permit bounded operation before every
 * actuator is observed; validation never turns assumed electricity into a meter. */
import { HEAT_PUMP_PERFORMANCE, estimateHeatPumpPerformance, estimateHydronicHeat } from '../domain/heat-pump-performance.js';
import { inferComfortReference, goodQuality } from './learning.js';
import { fireplaceBurnGroups, fireplaceAffectsLearning, FIREPLACE_RELEVANCE } from '../domain/fireplace.js';

const HOUR = 3_600_000;
const MAX_SAMPLES = 1536;
const REFIT_RECORDS = 12;
const MIN_PHASE_EPISODES = 3;
const MIN_ACTION_HOURS = 0.2;
const finite = Number.isFinite;
const time = value => typeof value === 'number' ? value : Date.parse(value);
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const PHASES = ['normal', 'preheat', 'reduction', 'recovery'];
const SLOW_HEAT_FRACTION = 1;
export const THERMAL_PARAMETER_BOUNDS = Object.freeze({
  lossPerHour: [0.001, 0.12], hydronicCPerKwh: [0.005, 0.6], solarCPerHourPerKwM2: [0, 2.5],
  memoryExchangePerHour: [0.005, 0.4], reserveTimeHours: [2, 72],
  fireplaceCPerKg: [0, 1],
});
const BOUNDS = THERMAL_PARAMETER_BOUNDS;
const DEFAULTS = Object.freeze({ lossPerHour: 0.018, hydronicCPerKwh: 0.75 / 9.40,
  solarCPerHourPerKwM2: 0.45,
  memoryExchangePerHour: 0.08, reserveTimeHours: 12, fireplaceCPerKg: 0.15 });

function positive(value, fallback, maximum = 30) {
  return finite(value) && value > 0 && value <= maximum ? value : fallback;
}
const optionalPower = (value, fallback) => finite(value) && value >= 0 && value <= 1 ? value : fallback;

function floorPriors(input, parameters) {
  if (!input || !(input.capacityKwhPerC > 0)) return { enabled: false,
    basis: 'no commissioned selected-slab capacity; legacy effective reserve only' };
  const capacityKwhPerC = clamp(input.capacityKwhPerC, 0.1, 100);
  const inheritedCapacity = parameters.memoryExchangePerHour * parameters.reserveTimeHours / parameters.hydronicCPerKwh;
  // Carve selected concrete out of the old effective reserve at the epoch seed.
  // Fixed physical capacities are not enlarged each time the response gain fits.
  const nativeCapacityKwhPerC = positive(input.nativeCapacityKwhPerC,
    Math.max(0.5, inheritedCapacity - capacityKwhPerC), 1000);
  return { enabled: true, capacityKwhPerC, nativeCapacityKwhPerC,
    exchangeKwPerC: positive(input.exchangeKwPerC, capacityKwhPerC / 12, 100),
    groundLossKwPerC: finite(input.groundLossKwPerC) ? clamp(input.groundLossKwPerC, 0, 10) : 0,
    groundC: finite(input.groundC) ? clamp(input.groundC, -5, 25) : 10,
    openAllocationFraction: clamp(finite(input.openAllocationFraction) ? input.openAllocationFraction : 0.4, 0, 1),
    closedAllocationFraction: clamp(finite(input.closedAllocationFraction) ? input.closedAllocationFraction : 0.05, 0, 1),
    groundLossIncludedInEnvelope: input.groundLossIncludedInEnvelope !== false,
    basis: 'fixed uncertain physical priors; selected capacity subtracted from seeded native reserve',
    capacityBudgetExceeded: capacityKwhPerC >= inheritedCapacity && !finite(input.nativeCapacityKwhPerC),
    storageParameterFitted: false };
}

export function initialAdaptiveModel(config = {}) {
  const parameters = { ...DEFAULTS };
  for (const [name, bounds] of Object.entries(BOUNDS)) {
    const candidate = config.thermalPriors?.[name];
    if (finite(candidate)) parameters[name] = clamp(candidate, ...bounds);
  }
  return { version: 3, parameters, performance: { ...HEAT_PUMP_PERFORMANCE, modelConfirmed: config.heatPumpModelConfirmed === true },
    floor: floorPriors(config.floorThermalPriors, parameters), uncertaintyCPerHour: 0.15, trainedAt: null,
    validation: null, uncertainty: null, equipmentResponse: { phases: {}, validation: null }, energy: {
      compressorKw: positive(config.heatPumpCompressorKw, 3),
      auxiliaryKw: positive(config.auxRatedKw, 9),
      circulationKw: optionalPower(config.circulationKw, 0.05),
      dhwrKw: optionalPower(config.dhwrKw, 0.05),
      nominalConfiguration: { compressorKw: positive(config.heatPumpCompressorKw, 3),
        auxiliaryKw: positive(config.auxRatedKw, 9), circulationKw: optionalPower(config.circulationKw, 0.05),
        dhwrKw: optionalPower(config.dhwrKw, 0.05) },
      relativeUncertainty: 0.6, recoveryMultiplier: 1.5, auxiliaryRiskScale: 1, basis: 'estimated', episodes: 0,
      measuredEpisodes: 0, recoveryHours: null, recoveryEnergyKwh: null,
      recoveryCalibrationEpisodes: 0, auxiliaryCalibrationEpisodes: 0,
    }, provenance: { method: 'observed routed hydronic energy with one shared gain and fixed thermal allocation',
      status: 'prior-estimates', reserve: 'effective temperature memory; not measured slab temperature or capacity',
      heating: 'shared C per estimated thermal kWh; compressor uses DHP-H10 B0 map, AUX approximately unity electrical-to-water conversion; neither is metered heat',
      preheat: 'requested boost affects equipment response; no unmeasured additional heat credit',
      heatAllocation: { slowFraction: SLOW_HEAT_FRACTION, basis: 'fixed structural assumption; not identified slab capacity' },
      solar: 'global-radiation forecast response; no radiation observations',
      fireplace: 'pooled logged fuel response; fixed delayed release curve and provisional effective degrees C per kg; not delivered heat or kWh',
      electricity: 'nominal or calibrated estimates unless an episode explicitly carries metered energy' } };
}

function validModel(model) {
  return model?.version === 3 && Object.entries(BOUNDS).every(([key, bounds]) =>
    finite(model.parameters?.[key]) && model.parameters[key] >= bounds[0] && model.parameters[key] <= bounds[1])
    && finite(model.uncertaintyCPerHour) && model.uncertaintyCPerHour >= 0.02 && model.uncertaintyCPerHour <= 1;
}

export function thermalEvidenceReady(model) {
  return model?.validation?.accepted === true && model.validation.kind === 'conditional-thermal'
    && ['lossPerHour', 'hydronicCPerKwh'].every(name => model.validation.parameterEvidence?.[name]?.status === 'identified')
    && model.validation.samples >= 3;
}

export function fireplaceEvidenceReady(model) {
  const evidence = model?.validation?.fireplace;
  return thermalEvidenceReady(model) && evidence?.accepted === true
    && evidence.trainingBurns >= 3 && evidence.validationBurns >= 3
    && model.validation.parameterEvidence?.fireplaceCPerKg?.status === 'identified';
}

/** Structural gain-error allowance; thermal checks are not a probability bound
 * and cannot establish observed electricity displacement. */
export function fireplaceGainUncertainty(model) {
  const gain = model?.parameters?.fireplaceCPerKg ?? DEFAULTS.fireplaceCPerKg;
  return fireplaceEvidenceReady(model) ? Math.max(0.02, gain * 0.5) : Math.max(0.15, gain);
}

export function actionEvidenceReady(model, phase, durationHours = null, treatmentKey = null) {
  if (!thermalEvidenceReady(model)) return false;
  if (phase === 'normal') return true;
  const evidence = model.equipmentResponse?.validation?.phases?.[phase];
  if (treatmentKey && evidence?.treatmentKey !== treatmentKey) return false;
  return model.equipmentResponse?.phases?.[phase]?.trainingEpisodes >= MIN_PHASE_EPISODES
    && evidence?.accepted === true && evidence.episodes >= MIN_PHASE_EPISODES
    && (!finite(durationHours) || durationHours <= evidence.maxDurationHours);
}

/** Expected interval runtime, not a compressor start/stop command. Native demand
 * may only be supplied for the currently observed phase and a short horizon. */
export function predictEquipmentDuty(model, state, inputs = {}, dtHours = 0.25) {
  const p = model?.parameters ?? DEFAULTS;
  const phase = PHASES.includes(inputs.phase) ? inputs.phase : 'normal';
  const boost = phase === 'preheat' ? clamp(finite(inputs.roomBoostC) ? inputs.roomBoostC : 0, 0, 5) : 0;
  const targetC = finite(inputs.targetC) ? inputs.targetC : 21;
  const indoorC = finite(state?.indoorC) ? state.indoorC : targetC;
  const outdoorC = finite(inputs.outdoorC) ? inputs.outdoorC : indoorC;
  const normalDuty = clamp((p.lossPerHour * (indoorC - outdoorC)
    + 0.25 * (targetC + boost - indoorC)) / (p.hydronicCPerKwh * estimateHeatPumpPerformance({ ...model?.performance, ...inputs }).heatKw), 0, 1);
  const available = model?.equipmentResponse?.phases?.[phase];
  const estimate = inputs.treatmentKey && available?.treatmentKey !== inputs.treatmentKey ? null : available;
  const checked = actionEvidenceReady(model, phase, null, inputs.treatmentKey);
  if (typeof inputs.nativeCompressorDemand === 'boolean' && dtHours <= 1) return {
    compressorDuty: Number(inputs.nativeCompressorDemand), basis: 'current-native-demand; interval estimate',
    uncertaintyDuty: 1, actionEvidence: checked ? 'checked' : 'unvalidated' };
  // Reduction changes the native request, not the compressor's physical capacity.
  // Without independent action evidence, retain normal demand and its uncertainty.
  const ratio = finite(estimate?.ratio) ? clamp(estimate.ratio, 0, 2) : 1;
  return { compressorDuty: clamp(normalDuty * ratio, 0, 1),
    basis: estimate ? 'episode-calibrated requested-mode response' : 'normal-demand prior; requested-mode response unknown',
    uncertaintyDuty: checked ? Math.max(0.1, model.equipmentResponse?.validation?.phases?.[phase]?.intervalMaeDuty ?? 0.1) : 1,
    actionEvidence: checked ? 'checked' : estimate ? 'observed-unchecked' : 'prior' };
}

/** Empirical trajectory-error envelope in degrees C. This is not a confidence
 * probability. Beyond checked horizons, uncertainty grows rather than saturates. */
export function thermalUncertaintyC(model, hours, inputs = {}) {
  const duration = Math.max(0, finite(hours) ? hours : 0);
  const points = model?.uncertainty?.points ?? [];
  let base;
  if (points.length) {
    const next = points.find(point => point.hours >= duration);
    const last = points.at(-1);
    base = next ? next.errorC : last.errorC + (duration - last.hours) * Math.max(0.05, model.uncertainty.extrapolationCPerHour);
  } else base = 0.25 + 0.15 * Math.sqrt(duration);
  const phase = inputs.phase ?? 'normal';
  const unknownAction = phase !== 'normal' && !actionEvidenceReady(model, phase, null, inputs.treatmentKey) && !finite(inputs.compressorDuty);
  const missingSolar = !finite(inputs.solarRadiationWm2);
  const fireplace = finite(inputs.fireplaceKgPerHour) ? Math.max(0, inputs.fireplaceKgPerHour) : 0;
  const fireAllowance = fireplace * duration * fireplaceGainUncertainty(model);
  const source = estimateHeatPumpPerformance({ ...model?.performance, ...inputs });
  const sourceAllowance = (model?.parameters?.hydronicCPerKwh ?? DEFAULTS.hydronicCPerKwh)
    * source.heatKw * source.relativeUncertainty * Math.sqrt(duration) * 0.25;
  const floorAllowance = model?.floor?.enabled ? (inputs.floorOverrideMode === 'on' ? 0.15 : 0.08) * Math.sqrt(duration) : 0;
  return base + sourceAllowance + floorAllowance + (unknownAction ? 0.1 * Math.sqrt(duration) : 0)
    + (missingSolar ? 0.08 * Math.sqrt(duration) : 0) + fireAllowance;
}

/** reserveC is an absolute latent building-temperature proxy, initially indoorC.
 * Thermal fitting requires observed inputs; equipment forecasts have separate
 * evidence. No artificial indoor upper temperature cap is applied. */
export function predictThermalStep(model, state, inputs, dtHours) {
  if (!validModel(model) || !finite(state?.indoorC) || !finite(inputs?.outdoorC)
    || !finite(dtHours) || dtHours <= 0 || dtHours > 72) throw new TypeError('Valid thermal model, temperatures and a bounded positive duration required');
  const p = model.parameters, phase = PHASES.includes(inputs.phase) ? inputs.phase : 'normal';
  const solarKnown = finite(inputs.solarRadiationWm2) && inputs.solarRadiationWm2 >= 0 && inputs.solarRadiationWm2 <= 2000;
  const solar = solarKnown ? inputs.solarRadiationWm2 / 1000 * p.solarCPerHourPerKwM2 : 0;
  const observedDuty = finite(inputs.compressorDuty) ? clamp(inputs.compressorDuty, 0, 1) : null;
  const auxiliaryKw = finite(inputs.auxKw) ? clamp(inputs.auxKw, 0, 20) : 0;
  const fireplace = finite(inputs.fireplaceKgPerHour) ? clamp(inputs.fireplaceKgPerHour, 0, 20) * p.fireplaceCPerKg : 0;
  let indoorC = state.indoorC, reserveC = finite(state.reserveC) ? state.reserveC : indoorC;
  const floor = model.floor?.enabled ? model.floor : null;
  let slabC = finite(state.slabC) ? state.slabC : indoorC;
  const initialSlabC = slabC;
  const initialReserveC = reserveC;
  let dutyHours = 0, heatC = 0, hydronicKwh = 0, slabInputKwh = 0, groundLossKwh = 0,
    envelopeLossKwh = 0, otherHeatKwh = 0;
  for (let remaining = dtHours; remaining > 1e-9;) {
    const fastestRate = floor ? Math.max(p.memoryExchangePerHour,
      p.memoryExchangePerHour / (floor.nativeCapacityKwhPerC * p.hydronicCPerKwh),
      (floor.exchangeKwPerC + floor.groundLossKwPerC) / floor.capacityKwhPerC) : 1;
    const dt = Math.min(0.25, floor ? 0.2 / fastestRate : 0.25, remaining);
    let loss = p.lossPerHour * (indoorC - inputs.outdoorC);
    const duty = observedDuty ?? predictEquipmentDuty(model, { indoorC, reserveC }, inputs, dtHours).compressorDuty;
    const source = estimateHeatPumpPerformance({ ...model.performance, ...inputs });
    const heat = p.hydronicCPerKwh * (source.heatKw * duty + auxiliaryKw);
    const exchange = p.memoryExchangePerHour * (reserveC - indoorC);
    const allocation = floor ? (inputs.floorOverrideMode === 'on'
      ? floor.openAllocationFraction : floor.closedAllocationFraction) : 0;
    const slabExchangeKw = floor ? floor.exchangeKwPerC * (slabC - indoorC) : 0;
    const slabGroundKw = floor ? floor.groundLossKwPerC * (slabC - floor.groundC) : 0;
    // The old loss coefficient already represented baseline ground loss. Remove
    // that baseline portion before introducing explicit extra slab-ground loss.
    if (floor?.groundLossIncludedInEnvelope) loss -= p.hydronicCPerKwh
      * floor.groundLossKwPerC * (indoorC - floor.groundC);
    // The capacity ratio a*tau makes exchange conserve the two-node weighted
    // temperature energy. Fixed heat allocation can charge the slow state before
    // the room warms; neither allocation nor memory constants are fitted here.
    const reserveRatio = floor ? floor.nativeCapacityKwhPerC * p.hydronicCPerKwh
      : p.memoryExchangePerHour * p.reserveTimeHours;
    const nextReserve = reserveC + (-exchange + SLOW_HEAT_FRACTION * heat * (1 - allocation)) / reserveRatio * dt;
    if (floor) slabC += (allocation * heat / p.hydronicCPerKwh - slabExchangeKw - slabGroundKw)
      / floor.capacityKwhPerC * dt;
    // The release kernel already represents warming masonry. Released fireplace
    // heat reaches the room directly; it is not routed through hydronic storage.
    indoorC += (-loss + (1 - SLOW_HEAT_FRACTION) * heat * (1 - allocation)
      + solar + fireplace + exchange + slabExchangeKw * p.hydronicCPerKwh) * dt;
    reserveC = nextReserve;
    dutyHours += duty * dt;
    heatC += heat * dt;
    hydronicKwh += heat / p.hydronicCPerKwh * dt;
    slabInputKwh += allocation * heat / p.hydronicCPerKwh * dt;
    groundLossKwh += slabGroundKw * dt;
    envelopeLossKwh += loss / p.hydronicCPerKwh * dt;
    otherHeatKwh += (solar + fireplace) / p.hydronicCPerKwh * dt;
    remaining -= dt;
  }
  const phaseCoverage = model.validation?.phaseSamples?.[phase] ?? 0;
  const checkedPhase = phase === 'normal' ? thermalEvidenceReady(model)
    : (model.validation?.phaseThermalEpisodes?.[phase] ?? 0) >= MIN_PHASE_EPISODES;
  return { indoorC, reserveC, ...(floor ? { slabC, slabChangeC: slabC - initialSlabC } : {}),
    hydronicKwh, slabInputKwh, nativeInputKwh: hydronicKwh - slabInputKwh, groundLossKwh,
    envelopeLossKwh, otherHeatKwh,
    uncertaintyC: thermalUncertaintyC(model, dtHours, inputs),
    compressorDuty: dutyHours / dtHours, usefulHeatCPerHour: heatC / dtHours,
    solarCPerHour: solar, fireplaceCPerHour: fireplace, reserveChangeC: reserveC - initialReserveC,
    solarKnown, phaseEvidence: checkedPhase ? 'checked' : phaseCoverage >= 12 ? 'observed-unchecked' : 'prior',
    actionEvidence: actionEvidenceReady(model, phase, null, inputs.treatmentKey) ? 'checked' : 'unvalidated' };
}

function validSample(sample) {
  return finite(time(sample?.timestamp)) && finite(sample.indoorC) && sample.indoorC > 2 && sample.indoorC < 40
    && finite(sample.outdoorC) && sample.outdoorC >= -60 && sample.outdoorC <= 50
    && (PHASES.includes(sample.phase) || sample.phase === 'mixed' && Array.isArray(sample.inputSegments)
      && sample.inputSegments.length > 0 && sample.inputSegments.every(segment => PHASES.includes(segment.phase)))
    && (['occupied', 'away'].includes(sample.regime) || sample.regime === 'mixed' && Array.isArray(sample.inputSegments)
      && sample.inputSegments.every(segment => ['occupied', 'away'].includes(segment.regime)))
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
    copied.state = null;
    copied.samples = []; copied.episodeArchive = []; copied.episodeIds = []; copied.sinceFit = 0;
    copied.cursor = null;
    copied.health = { status: 'prior-estimates', reason: 'invalid-checkpoint-model', acceptedFits: 0, rejectedFits: 0 };
  }
  const defaults = initialAdaptiveModel(config);
  const savedEnergy = copied.model.energy ?? {};
  copied.model.energy = { ...defaults.energy, ...savedEnergy,
    compressorKw: positive(savedEnergy.compressorKw, defaults.energy.compressorKw),
    auxiliaryKw: positive(savedEnergy.auxiliaryKw, defaults.energy.auxiliaryKw),
    circulationKw: optionalPower(savedEnergy.circulationKw, defaults.energy.circulationKw),
    dhwrKw: optionalPower(savedEnergy.dhwrKw, defaults.energy.dhwrKw),
    relativeUncertainty: finite(savedEnergy.relativeUncertainty) ? clamp(savedEnergy.relativeUncertainty, 0.2, 1.5) : defaults.energy.relativeUncertainty,
    recoveryMultiplier: finite(savedEnergy.recoveryMultiplier) ? clamp(savedEnergy.recoveryMultiplier, 0.75, 4) : defaults.energy.recoveryMultiplier,
    auxiliaryRiskScale: finite(savedEnergy.auxiliaryRiskScale) ? clamp(savedEnergy.auxiliaryRiskScale, 0.2, 4) : 1,
  };
  const nominal = { ...defaults.energy.nominalConfiguration, ...savedEnergy.nominalConfiguration };
  for (const [setting, field, maximum] of [['heatPumpCompressorKw', 'compressorKw', 30], ['auxRatedKw', 'auxiliaryKw', 30],
    ['circulationKw', 'circulationKw', 1], ['dhwrKw', 'dhwrKw', 1]]) {
    const value = config[setting];
    if (finite(value) && value >= (maximum === 1 ? 0 : 0.01) && value <= maximum) {
      if (value !== nominal[field]) copied.model.energy[field] = value;
      nominal[field] = value;
    }
  }
  copied.model.energy.nominalConfiguration = nominal;
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
  const lastSample = copied.samples.at(-1);
  if (copied.state && (!validSample(lastSample) || time(copied.state.observedAt) !== time(lastSample.timestamp)
    || !finite(copied.state.reserveC) || copied.state.reserveC < -20 || copied.state.reserveC > 80)) copied.state = null;
  copied.episodeArchive = Array.isArray(copied.episodeArchive) ? copied.episodeArchive.filter(entry =>
    typeof entry?.id === 'string' && finite(time(entry.startedAt)) && finite(time(entry.endedAt))
    && time(entry.endedAt) > time(entry.startedAt) && Array.isArray(entry.phases) && Array.isArray(entry.samples)) : [];
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
    fireplaceKgPerHour: sample.fireplaceKgPerHour ?? 0, fireplaceActive: sample.fireplaceActive,
    fireplaceKnown: sample.fireplaceKnown,
    supplyC: sample.supplyC ?? null, brineC: sample.brineC ?? null,
    floorOverrideMode: sample.floorOverrideMode ?? 'off', treatmentKey: sample.treatmentKey ?? 'native',
    phase: sample.phase, roomBoostC: sample.roomBoostC, targetC: finite(sample.targetC) ? sample.targetC : targetC,
    compressorDuty: Object.hasOwn(sample, 'thermalCompressorDuty') ? sample.thermalCompressorDuty : sample.compressorDuty,
    auxKw: Object.hasOwn(sample, 'thermalAuxKw') ? sample.thermalAuxKw : sample.auxKw };
}

function intervalInputs(a, b, targetC) {
  return b.intervalInputs && b.windowStart === time(a.timestamp) ? { ...b.intervalInputs,
    fireplaceKnown: b.intervalInputs.fireplaceKnown ?? b.fireplaceKnown,
    fireplaceActive: b.intervalInputs.fireplaceActive ?? b.fireplaceActive,
    targetC: finite(b.intervalInputs.targetC) ? b.intervalInputs.targetC : targetC } : sampleInputs(a, targetC);
}

function intervalSegments(a, b, targetC) {
  const from = time(a.timestamp), to = time(b.timestamp);
  if (Array.isArray(b.inputSegments) && b.windowStart === from) {
    let cursor = from;
    const segments = [];
    for (const segment of b.inputSegments) {
      if (segment.start !== cursor || !(segment.end > segment.start) || segment.end > to) return [];
      segments.push({ ...segment,
        fireplaceKnown: segment.fireplaceKnown ?? b.fireplaceKnown,
        fireplaceActive: segment.fireplaceActive ?? b.fireplaceActive,
        compressorDuty: Object.hasOwn(segment, 'thermalCompressorDuty') ? segment.thermalCompressorDuty : segment.compressorDuty,
        auxKw: Object.hasOwn(segment, 'thermalAuxKw') ? segment.thermalAuxKw : segment.auxKw,
        targetC: finite(segment.targetC) ? segment.targetC : targetC });
      cursor = segment.end;
    }
    return cursor === to ? segments : [];
  }
  const interval = intervalInputs(a, b, targetC);
  return [{ ...interval, start: from, end: to,
    episodeId: b.windowStart === from ? b.episodeId : a.episodeId }];
}

function usableInputs(segment, observedOnly) {
  return PHASES.includes(segment.phase) && finite(segment.outdoorC) && segment.outdoorC >= -60 && segment.outdoorC <= 50
    && goodQuality(segment.quality)
    && (!finite(segment.compressorDuty) || segment.compressorDuty >= 0 && segment.compressorDuty <= 1)
    && (!finite(segment.auxKw) || segment.auxKw >= 0 && segment.auxKw <= 20)
    && (!finite(segment.solarRadiationWm2) || segment.solarRadiationWm2 >= 0 && segment.solarRadiationWm2 <= 2000)
    && (segment.fireplaceKgPerHour === undefined || finite(segment.fireplaceKgPerHour)
      && segment.fireplaceKgPerHour >= 0 && segment.fireplaceKgPerHour <= 20)
    && (!observedOnly || finite(segment.compressorDuty) && finite(segment.auxKw)
      && finite(segment.solarRadiationWm2) && !['partial', 'unknown'].includes(segment.floorOverrideMode));
}

function thermalInterval(model, state, segments) {
  let predicted = state;
  for (const segment of segments)
    predicted = predictThermalStep(model, predicted, segment, (segment.end - segment.start) / HOUR);
  return predicted;
}

function hasFireplace(sample) {
  return fireplaceAffectsLearning(sample);
}

function observedBurns(rows) {
  return fireplaceBurnGroups(rows.filter(row => row.segments.every(segment => segment.fireplaceKnown === true))
    .flatMap(row => row.fireplaceIgnitions ?? []));
}

function genuineEndpoint(previous, next) {
  const members = Object.entries(next?.indoorSensors ?? {}).filter(([, value]) => value.weight > 0);
  if (!members.length || !members.every(([, value]) => finite(time(value.observedAt)))) return true;
  return members.every(([name, value]) => !finite(time(previous?.indoorSensors?.[name]?.observedAt))
    || time(value.observedAt) > time(previous.indoorSensors[name].observedAt));
}

const thermalWarmupHours = model => Math.min(288, Math.max(48, model.parameters.reserveTimeHours * 4,
  model.floor?.enabled ? 4 * model.floor.capacityKwhPerC / (model.floor.exchangeKwPerC + model.floor.groundLossKwPerC) : 0));

/** Integrate the original heat-input windows between genuine new observations.
 * A held room report is control context, not a new independent fitting target. */
export function thermalObservationIntervals(samples, targetC = 21) {
  const result = [];
  let anchor = null, previous = null, pending = [];
  for (const sample of samples) {
    if (!validSample(sample)) { result.push(sample); anchor = null; previous = null; pending = []; continue; }
    if (!anchor) { result.push(sample); anchor = sample; previous = sample; continue; }
    const segments = intervalSegments(previous, sample, targetC);
    if (!segments.length || (time(sample.timestamp) - time(previous.timestamp)) / HOUR > 2) {
      result.push({ timestamp: sample.timestamp, valid: false });
      result.push(sample); anchor = sample; previous = sample; pending = []; continue;
    }
    pending.push(...segments); previous = sample;
    if (!genuineEndpoint(anchor, sample)) continue;
    result.push({ ...sample, windowStart: time(anchor.timestamp), inputSegments: pending,
      observationIntervalHours: (time(sample.timestamp) - time(anchor.timestamp)) / HOUR });
    anchor = sample; pending = [];
  }
  if (pending.length) result.push({ ...previous, windowStart: time(anchor.timestamp), inputSegments: pending,
    temperatureObservationFresh: false });
  return result;
}

/** Score every observed point in chronological rollouts. A gap closes an eligible
 * fragment. Complete short episodes have their own duration; normal blocks need
 * six hours. Neither raw phase rows nor excluded fragments establish evidence. */
export function evaluateThermalModel(model, samples, { targetC = 21, scoreFrom = 0,
  rollout = true, observedOnly = true, completeEpisodes = [], excludeFireplace = false, requireWarmup = false } = {}) {
  const scoreAt = time(samples[scoreFrom]?.timestamp);
  samples = thermalObservationIntervals(samples, targetC);
  scoreFrom = finite(scoreAt) ? samples.findIndex(sample => time(sample.timestamp) >= scoreAt) : 0;
  const completed = new Map(completeEpisodes.map(episode => [episode.id, episode]));
  let state = null, block = null, warmupHours = 0;
  const requiredWarmupHours = requireWarmup ? thermalWarmupHours(model) : 0;
  const squaredRates = [], predictions = [], blocks = [], excluded = [];
  const finish = reason => {
    if (!block) return;
    const episode = completed.get(block.episodeId);
    // A later gap cannot erase an already complete continuous episode. An
    // interior gap splits the block, so neither fragment can cover both edges.
    const wholeEpisode = episode && block.start <= time(episode.startedAt) && block.end >= time(episode.endedAt);
    if (block.initializationSupported && (block.hours >= 6 && !block.episodeId || wholeEpisode && block.hours >= 0.25)) {
      blocks.push({ ...block, completeEpisode: Boolean(wholeEpisode),
        maeC: block.absoluteDegreeHours / block.hours,
        persistenceMaeC: block.persistenceDegreeHours / block.hours });
    } else excluded.push({ id: block.id, hours: block.hours, reason: !block.initializationSupported
      ? 'insufficient-causal-thermal-warmup' : block.episodeId ? 'incomplete-episode' : 'short-fragment' });
    block = null;
  };
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i], dt = (time(b.timestamp) - time(a.timestamp)) / HOUR;
    const segments = validSample(a) && validSample(b) ? intervalSegments(a, b, targetC) : [];
    if (!segments.length || dt < 1 / 12 || dt > 2 || Math.abs((b.indoorC - a.indoorC) / dt) > 2
      || excludeFireplace && (hasFireplace(a) || hasFireplace(b) || segments.some(hasFireplace))
      || !segments.every(segment => usableInputs(segment, observedOnly))) {
      finish('gap'); state = null; warmupHours = 0; continue;
    }
    if (!state) state = { indoorC: a.indoorC, reserveC: a.indoorC };
    const scoring = i - 1 >= scoreFrom;
    const ids = [...new Set(segments.map(segment => segment.episodeId).filter(Boolean))];
    const episodeId = ids.length === 1 ? ids[0] : null;
    const group = episodeId ? `episode:${episodeId}` : `day:${Math.floor(time(a.timestamp) / (24 * HOUR))}`;
    if (rollout && scoring && block && group !== block.id) finish('boundary');
    if (!rollout || !scoring || !block) state.indoorC = a.indoorC;
    if (rollout && scoring && !block) block = { id: group, episodeId, start: time(a.timestamp), end: time(a.timestamp),
      hours: 0, absoluteDegreeHours: 0, persistenceDegreeHours: 0, maxErrorC: 0,
      persistenceStartC: a.indoorC, errors: [], phaseHours: {}, initialState: { ...state },
      initializationSupported: warmupHours >= requiredWarmupHours, warmupHours };
    const before = { ...state };
    state = thermalInterval(model, state, segments);
    warmupHours += dt;
    if (!scoring || b.temperatureObservationFresh === false) continue;
    const errorC = Math.abs(b.indoorC - state.indoorC);
    if (!rollout) {
      if (warmupHours < requiredWarmupHours) continue;
      squaredRates.push((errorC / dt) ** 2);
      predictions.push({ predictedC: state.indoorC, actualC: b.indoorC, dt, segments,
        indoorC: a.indoorC, reserveC: before.reserveC, episodeId, timestamp: b.timestamp,
        initializationSupported: warmupHours >= requiredWarmupHours,
        fireplaceIgnitions: (b.windowStart === time(a.timestamp) ? b : a).fireplaceIgnitions ?? [] });
    } else {
      block.hours += dt; block.end = time(b.timestamp);
      block.absoluteDegreeHours += errorC * dt;
      block.persistenceDegreeHours += Math.abs(b.indoorC - block.persistenceStartC) * dt;
      block.maxErrorC = Math.max(block.maxErrorC, errorC);
      block.errors.push({ hours: block.hours, errorC });
      for (const segment of segments) block.phaseHours[segment.phase] = (block.phaseHours[segment.phase] ?? 0)
        + (segment.end - segment.start) / HOUR;
      if (!episodeId && block.hours >= 24) finish('duration');
    }
  }
  finish('end');
  const hours = blocks.reduce((sum, block) => sum + block.hours, 0);
  return { mse: squaredRates.length ? mean(squaredRates) : Infinity, predictions,
    maeC: hours ? blocks.reduce((sum, block) => sum + block.absoluteDegreeHours, 0) / hours : Infinity,
    maxErrorC: blocks.length ? Math.max(...blocks.map(block => block.maxErrorC)) : Infinity,
    persistenceMaeC: hours ? blocks.reduce((sum, block) => sum + block.persistenceDegreeHours, 0) / hours : Infinity,
    samples: blocks.length, horizons: blocks.map(block => block.hours), blocks, excluded, state,
    lastEndpointFresh: samples.at(-1)?.temperatureObservationFresh !== false };
}

const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
function independentVariation(vector, others) {
  const norm = dot(vector, vector);
  if (norm < 1e-12) return 0;
  const basis = [];
  for (const other of others) {
    let residual = [...other];
    for (const unit of basis) { const projection = dot(residual, unit); residual = residual.map((value, i) => value - projection * unit[i]); }
    const length = Math.sqrt(dot(residual, residual));
    if (length > 1e-8) basis.push(residual.map(value => value / length));
  }
  let residual = [...vector];
  for (const unit of basis) { const projection = dot(residual, unit); residual = residual.map((value, i) => value - projection * unit[i]); }
  return clamp(dot(residual, residual) / norm, 0, 1);
}

function parameterEvidence(model, samples, targetC, episodes, excludeFireplace = false) {
  const baseline = evaluateThermalModel(model, samples, { targetC, rollout: false, excludeFireplace, requireWarmup: true });
  const rows = baseline.predictions;
  const days = new Set(rows.map(row => Math.floor(time(row.timestamp) / (24 * HOUR))));
  const sunlitDays = new Set(rows.filter(row => row.segments.some(segment => segment.solarRadiationWm2 > 50))
    .map(row => Math.floor(time(row.timestamp) / (24 * HOUR))));
  const names = ['lossPerHour', 'hydronicCPerKwh', 'solarCPerHourPerKwM2', 'fireplaceCPerKg'];
  const burns = observedBurns(rows).length;
  const fireFreeSamples = rows.filter(row => row.segments.every(segment => !hasFireplace(segment)
    && segment.fireplaceKnown === true)).length;
  const vectors = {}, inputVectors = {}, evidence = {};
  for (const name of names) {
    const perturbed = structuredClone(model), value = model.parameters[name];
    const changed = clamp(value + Math.max(name === 'fireplaceCPerKg' ? 0.05 : 0.001, value * 0.1), ...BOUNDS[name]);
    perturbed.parameters[name] = changed === value ? value * 0.9 : changed;
    const predictions = evaluateThermalModel(perturbed, samples, { targetC, rollout: false, excludeFireplace, requireWarmup: true }).predictions;
    vectors[name] = predictions.map((row, i) => (row.predictedC - rows[i].predictedC) / row.dt);
    inputVectors[name] = rows.map(row => row.segments.reduce((sum, segment) => {
      const value = name === 'lossPerHour' ? row.indoorC - segment.outdoorC
        : name === 'hydronicCPerKwh' ? estimateHydronicHeat(segment, model.performance).hydronicKw
          : name === 'solarCPerHourPerKwM2' ? segment.solarRadiationWm2 / 1000
            : name === 'fireplaceCPerKg' ? segment.fireplaceKgPerHour ?? 0 : segment.auxKw;
      return sum + value * (segment.end - segment.start) / HOUR;
    }, 0) / row.dt);
    const sensitivity = rows.length ? Math.sqrt(dot(vectors[name], vectors[name]) / rows.length) : 0;
    const reason = rows.length < 96 || days.size < 3 ? 'fewer-than-three-days-of-observed-heat-input'
      : name === 'solarCPerHourPerKwM2' && sunlitDays.size < 3 ? 'fewer-than-three-sunlit-days'
          : name === 'fireplaceCPerKg' && (burns < 3 || !thermalEvidenceReady(model))
            ? 'fireplace-requires-validated-house-response-and-three-separated-burns'
          : sensitivity < 0.002 ? 'insensitive-to-available-inputs' : null;
    evidence[name] = { status: reason ? 'fixed' : 'candidate', reason, sensitivityCPerHour: sensitivity,
      coefficientChange: perturbed.parameters[name] - value, perturbation: 'bounded coefficient perturbation',
      observedIntervals: rows.length, observedDays: days.size,
      ...(name === 'fireplaceCPerKg' ? { burns, fireFreeSamples,
        coreAnchor: thermalEvidenceReady(model) ? 'previously-validated-house-response' : 'unavailable' } : {}) };
  }
  const eligible = names.filter(name => evidence[name].status === 'candidate');
  for (const name of eligible) {
    // A fire cannot acquire evidence merely because a confounding solar or
    // compressor coefficient is fixed rather than currently eligible for fitting.
    const others = names.filter(other => other !== name); // Fixed uncertain peers can still confound identification.
    const variation = Math.min(independentVariation(vectors[name], others.map(other => vectors[other])),
      independentVariation(inputVectors[name], others.map(other => inputVectors[other])));
    evidence[name].independentVariation = variation;
    evidence[name].status = variation >= 0.01 ? 'identified' : 'fixed';
    evidence[name].reason = variation >= 0.01 ? null : 'confounded-with-other-heat-inputs';
  }
  for (const name of ['memoryExchangePerHour', 'reserveTimeHours']) evidence[name] = {
    status: 'fixed', reason: 'unmeasured-slow-state; fixed-structural-prior', observedIntervals: rows.length };
  return { evidence, rows, sunlitDays: sunlitDays.size, fireFreeSamples, burns };
}

function responseTotals(model, rows, episodes) {
  const allowed = new Set(episodes.map(episode => episode.id)), totals = new Map();
  for (const row of rows) for (const segment of row.segments) {
    const id = segment.episodeId ?? row.episodeId;
    if (!allowed.has(id)) continue;
    const treatmentKey = segment.treatmentKey ?? 'native';
    const key = `${id}:${segment.phase}:${treatmentKey}`, hours = (segment.end - segment.start) / HOUR;
    const nominal = predictEquipmentDuty({ ...model, equipmentResponse: null },
      { indoorC: row.indoorC, reserveC: row.reserveC }, segment, hours).compressorDuty;
    const total = totals.get(key) ?? { id, phase: segment.phase, treatmentKey, hours: 0, dutyHours: 0, nominalDutyHours: 0,
      maxRoomBoostC: 0, intervals: [] };
    total.hours += hours; total.dutyHours += segment.compressorDuty * hours; total.nominalDutyHours += nominal * hours;
    total.maxRoomBoostC = Math.max(total.maxRoomBoostC, finite(segment.roomBoostC) ? segment.roomBoostC : 0);
    total.intervals.push({ hours, nominalDuty: nominal, observedDuty: segment.compressorDuty });
    totals.set(key, total);
  }
  return [...totals.values()];
}

export function fitEquipmentResponse(model, trainingRows, holdoutRows, trainingEpisodes, holdoutEpisodes) {
  const training = responseTotals(model, trainingRows, trainingEpisodes);
  const validation = responseTotals(model, holdoutRows, holdoutEpisodes);
  const phases = {}, checked = {};
  for (const phase of PHASES.filter(phase => phase !== 'normal')) {
    const treatmentKey = [...training, ...validation].findLast(row => row.phase === phase)?.treatmentKey;
    const rows = training.filter(row => row.phase === phase && row.treatmentKey === treatmentKey
      && row.nominalDutyHours >= 0.05 && row.hours >= MIN_ACTION_HOURS);
    if (!rows.length) continue;
    const ratios = rows.map(row => clamp(row.dutyHours / row.nominalDutyHours, 0, 2));
    // Three prior-equivalent episodes shrink scarce response toward unchanged
    // native demand. More quarter-hour rows cannot increase this weight.
    const ratio = (3 + ratios.reduce((sum, value) => sum + value, 0)) / (3 + ratios.length);
    const trainingDurations = rows.map(row => row.hours).sort((a, b) => b - a);
    phases[phase] = { ratio, treatmentKey, trainingEpisodes: rows.length, basis: 'episode-weighted ratio to normal-demand prior',
      minDurationHours: Math.min(...rows.map(row => row.hours)), maxDurationHours: trainingDurations[2] ?? 0,
      maxRoomBoostC: rows.map(row => row.maxRoomBoostC).sort((a, b) => b - a)[2] ?? 0 };
    const later = validation.filter(row => row.phase === phase && row.treatmentKey === treatmentKey
      && row.hours >= MIN_ACTION_HOURS && row.nominalDutyHours >= 0.05);
    const errors = later.map(row => (row.intervals.reduce((sum, interval) => sum
      + clamp(interval.nominalDuty * ratio, 0, 1) * interval.hours, 0) - row.dutyHours) / row.hours);
    const intervalErrors = later.map(row => row.intervals.reduce((sum, interval) => sum
      + Math.abs(clamp(interval.nominalDuty * ratio, 0, 1) - interval.observedDuty) * interval.hours, 0) / row.hours);
    const baselineErrors = later.map(row => Math.abs(row.nominalDutyHours - row.dutyHours) / row.hours);
    const maeDuty = errors.length ? mean(errors.map(Math.abs)) : null, biasDuty = errors.length ? mean(errors) : null;
    checked[phase] = { treatmentKey, episodes: later.length, maeDuty, biasDuty,
      metric: 'episode mean duty error; interval error reported separately for timing uncertainty',
      intervalMaeDuty: intervalErrors.length ? mean(intervalErrors) : null,
      accepted: rows.length >= MIN_PHASE_EPISODES && later.length >= MIN_PHASE_EPISODES
        && maeDuty <= 0.2 && Math.abs(biasDuty) <= 0.15 && maeDuty <= mean(baselineErrors) * 0.95 + 0.01,
      minDurationHours: later.length ? Math.min(...later.map(row => row.hours)) : null,
      maxRoomBoostC: later.length >= 3 ? Math.min(phases[phase].maxRoomBoostC,
        later.map(row => row.maxRoomBoostC).sort((a, b) => b - a)[2]) : 0,
      maxDurationHours: later.length >= 3
        ? Math.min(phases[phase].maxDurationHours, later.map(row => row.hours).sort((a, b) => b - a)[2]) : 0 };
  }
  return { phases, validation: { kind: 'held-out-conditional-equipment-response',
    conditionalOn: ['recorded indoor temperature', 'recorded outdoor temperature', 'requested phase and boost'],
    limitation: 'Does not validate full planner trajectories, auxiliary forecasts or economic benefit', phases: checked } };
}

function errorEnvelope(validation) {
  const points = [];
  let previous = 0.15;
  for (const hours of [0.25, 0.5, 1, 2, 4, 8, 12, 24]) {
    const maxima = validation.blocks.filter(block => block.hours >= hours)
      .map(block => Math.max(0, ...block.errors.filter(error => error.hours <= hours).map(error => error.errorC)));
    if (maxima.length < 3) continue;
    // A conservative observed envelope plus a measurement allowance; no claimed
    // probability level from a handful of correlated records.
    previous = Math.max(previous, Math.max(...maxima) + 0.1);
    points.push({ hours, errorC: previous, blocks: maxima.length });
  }
  return points.length ? { kind: 'observed-trajectory-envelope', points,
    extrapolationCPerHour: Math.max(0.05, validation.maxErrorC / Math.max(1, Math.max(...validation.horizons))),
    limitation: 'Empirical observed envelope, not a calibrated confidence probability' } : null;
}

export function fitAdaptiveModel(cp, config = {}) {
  const byTime = new Map([...(cp.episodeArchive ?? []).flatMap(entry => entry.samples), ...cp.samples]
    .map(sample => [time(sample.timestamp), sample]));
  const samples = [...byTime.values()].sort((a, b) => time(a.timestamp) - time(b.timestamp));
  let split = Math.floor(samples.length * 0.7);
  const currentEpisodes = (cp.episodeArchive ?? []).filter(episode => !finite(cp.equipmentEpochAt)
    || time(episode.startedAt) >= cp.equipmentEpochAt).sort((a, b) => time(a.endedAt) - time(b.endedAt));
  // Reserve independent cycles, not merely thirty percent of frequent normal
  // observations. Otherwise a few cycles per week can never supply three held-
  // out examples inside the tail of a sixteen-day sample cache.
  if (currentEpisodes.length >= 6) {
    const heldoutStart = time(currentEpisodes.at(-3).startedAt) - 12 * HOUR;
    const beforeEpisodes = samples.findIndex(sample => time(sample.timestamp) >= heldoutStart);
    if (beforeEpisodes >= 0) split = Math.min(split, beforeEpisodes);
  }
  const splitDay = Math.floor(time(samples[split]?.timestamp) / (24 * HOUR));
  while (split > 0 && (Math.floor(time(samples[split - 1].timestamp) / (24 * HOUR)) === splitDay
    || samples[split]?.episodeId && samples[split - 1].episodeId === samples[split].episodeId)) split--;
  if (split < 32) return { accepted: false, reason: 'collecting-temperature-intervals' };
  const validateAfter = time(samples[split - 1].timestamp) + 12 * HOUR;
  const scoreFrom = samples.findIndex((sample, i) => i >= split && time(sample.timestamp) >= validateAfter);
  if (scoreFrom < 0) return { accepted: false, reason: 'collecting-later-validation' };
  const training = samples.slice(0, split), prior = initialAdaptiveModel(config);
  const trainingEnd = time(training.at(-1).timestamp);
  const actionEpisodes = (cp.episodeArchive ?? []).filter(episode => !finite(cp.equipmentEpochAt)
    || time(episode.startedAt) >= cp.equipmentEpochAt);
  const earlierEpisodes = actionEpisodes.filter(episode => time(episode.endedAt) <= trainingEnd);
  const trainingScored = evaluateThermalModel(cp.model, training, { completeEpisodes: earlierEpisodes, requireWarmup: true });
  const completeTrainingIds = new Set(trainingScored.blocks.filter(block => block.completeEpisode).map(block => block.episodeId));
  const trainingEpisodes = earlierEpisodes.filter(episode => completeTrainingIds.has(episode.id));
  const phaseEpisodes = Object.fromEntries(PHASES.map(phase => [phase,
    trainingEpisodes.filter(episode => episode.phases.includes(phase)).length]));
  const targetC = cp.baselineC ?? (finite(config.targetC) ? config.targetC : 21);
  const diagnostics = parameterEvidence(cp.model, training, targetC, trainingEpisodes);
  const firePresent = samples.some(hasFireplace);
  // Uncertain internal heat must not be absorbed into the house-loss or heat-pump
  // response coefficients. Their objective and evidence use fire-free/negligible
  // intervals. An established anchor can identify wood from varying daily loads
  // without manufacturing a new multi-day no-fire requirement.
  if (firePresent) {
    const clean = parameterEvidence(cp.model, training, targetC, trainingEpisodes, true);
    for (const name of Object.keys(diagnostics.evidence)) if (name !== 'fireplaceCPerKg')
      diagnostics.evidence[name] = clean.evidence[name];
  }
  const tunable = Object.keys(diagnostics.evidence).filter(name => diagnostics.evidence[name].status === 'identified');
  if (!tunable.length) return { accepted: false, reason: 'insufficient-independent-observed-inputs', parameterEvidence: diagnostics.evidence };
  let candidate = structuredClone(cp.model);
  const objective = (model, fireplace = false) => {
    const error = evaluateThermalModel(model, training, { targetC, rollout: false,
      excludeFireplace: firePresent && !fireplace, requireWarmup: true }).mse;
    const penalty = tunable.reduce((sum, key) => sum
      + ((model.parameters[key] - prior.parameters[key]) / Math.max(0.02, prior.parameters[key])) ** 2, 0) * 0.0001;
    return error + penalty;
  };
  let best = objective(candidate, tunable.every(name => name === 'fireplaceCPerKg'));
  if (!finite(best)) return { accepted: false, reason: 'no-usable-temperature-intervals', parameterEvidence: diagnostics.evidence };
  for (const scale of [0.4, 0.2, 0.1, 0.05]) for (let pass = 0; pass < 2; pass++) for (const key of tunable) {
    best = objective(candidate, key === 'fireplaceCPerKg');
    const bounds = BOUNDS[key];
    const current = candidate.parameters[key], step = Math.max(prior.parameters[key], (bounds[1] - bounds[0]) * 0.025) * scale;
    for (const direction of [-1, 1]) {
      const attempt = structuredClone(candidate);
      attempt.parameters[key] = clamp(current + direction * step, ...bounds);
      const score = objective(attempt, key === 'fireplaceCPerKg');
      if (score < best) { best = score; candidate = attempt; }
    }
  }
  const validationOptions = { targetC, scoreFrom, completeEpisodes: cp.episodeArchive, requireWarmup: true,
    excludeFireplace: firePresent && !tunable.includes('fireplaceCPerKg') && !fireplaceEvidenceReady(cp.model) };
  const validation = evaluateThermalModel(candidate, samples, validationOptions);
  if (validation.samples < 3) return { accepted: false, reason: 'collecting-later-validation', parameterEvidence: diagnostics.evidence };
  const previous = evaluateThermalModel(cp.model, samples, validationOptions);
  if (validation.maeC > 0.35 || validation.maxErrorC > 0.75
    || validation.maeC > previous.maeC * 1.05 + 0.02
    || validation.maeC > validation.persistenceMaeC * 0.95 + 0.03)
    return { accepted: false, reason: 'retained-better-predictions', parameterEvidence: diagnostics.evidence,
      validation: { accepted: false, kind: 'conditional-thermal', maeC: validation.maeC,
        maxErrorC: validation.maxErrorC, previousMaeC: previous.maeC, samples: validation.samples } };
  const holdoutRows = evaluateThermalModel(candidate, samples, { targetC, scoreFrom, rollout: false, requireWarmup: true }).predictions;
  const trainingBurns = observedBurns(diagnostics.rows);
  const validationBurns = observedBurns(holdoutRows).filter(burn =>
    !trainingBurns.some(previousBurn => Math.abs(burn.startedAt - previousBurn.startedAt) < 24 * HOUR));
  if (tunable.includes('fireplaceCPerKg') && validationBurns.length < 3)
    return { accepted: false, reason: 'collecting-three-later-fireplace-burns', parameterEvidence: diagnostics.evidence };
  const scoredIds = new Set(validation.blocks.filter(block => block.completeEpisode).map(block => block.episodeId));
  const heldoutEpisodes = actionEpisodes.filter(episode => scoredIds.has(episode.id));
  const fireEpisodeIds = new Set([...diagnostics.rows, ...holdoutRows].filter(row => row.segments.some(hasFireplace))
    .flatMap(row => [row.episodeId, ...row.segments.map(segment => segment.episodeId)]).filter(Boolean));
  const cleanTrainingEpisodes = trainingEpisodes.filter(episode => !fireEpisodeIds.has(episode.id));
  const cleanHeldoutEpisodes = heldoutEpisodes.filter(episode => !fireEpisodeIds.has(episode.id));
  candidate.equipmentResponse = fitEquipmentResponse(candidate, diagnostics.rows, holdoutRows,
    cleanTrainingEpisodes, cleanHeldoutEpisodes);
  candidate.equipmentResponse.validation.equipmentEpochAt = cp.equipmentEpochAt ?? null;
  // A wood-only fit does not change the normal-duty formula. With no fresh clean
  // action episodes, retain checked response from the same equipment epoch.
  if (tunable.length === 1 && tunable[0] === 'fireplaceCPerKg'
    && (cp.model.equipmentResponse?.validation?.equipmentEpochAt ?? null) === (cp.equipmentEpochAt ?? null)) {
    for (const phase of PHASES.filter(phase => phase !== 'normal')) {
      if (!actionEvidenceReady(cp.model, phase)
        || [...cleanTrainingEpisodes, ...cleanHeldoutEpisodes].some(episode => episode.phases.includes(phase))) continue;
      candidate.equipmentResponse.phases[phase] = structuredClone(cp.model.equipmentResponse.phases[phase]);
      candidate.equipmentResponse.validation.phases[phase] = {
        ...structuredClone(cp.model.equipmentResponse.validation.phases[phase]), fitStatus: 'retained-unchanged' };
    }
  }
  const phaseSamples = Object.fromEntries(PHASES.map(phase => [phase,
    diagnostics.rows.filter(row => row.segments.some(segment => segment.phase === phase)).length]));
  // Current-window identification controls what may change. Prior identification
  // of an unchanged coefficient remains valid even when daily fires leave no new
  // clean intervals; retaining it must never make that coefficient tunable here.
  const retainedEvidence = structuredClone(diagnostics.evidence), retainedCoreParameters = [];
  if (thermalEvidenceReady(cp.model)) for (const [name, evidence] of Object.entries(retainedEvidence)) {
    if (name === 'fireplaceCPerKg' || tunable.includes(name)
      || candidate.parameters[name] !== cp.model.parameters[name]
      || cp.model.validation.parameterEvidence?.[name]?.status !== 'identified') continue;
    const previousEvidence = cp.model.validation.parameterEvidence[name];
    retainedEvidence[name] = { ...previousEvidence, fitStatus: 'retained-unchanged',
      retainedFrom: previousEvidence.retainedFrom ?? cp.model.trainedAt,
      currentWindowEvidence: { status: evidence.status, reason: evidence.reason,
        observedIntervals: evidence.observedIntervals, observedDays: evidence.observedDays } };
    retainedCoreParameters.push(name);
  }
  const unchangedAnchor = Object.keys(BOUNDS).every(name => candidate.parameters[name] === cp.model.parameters[name]);
  const retainedFireplace = !tunable.includes('fireplaceCPerKg') && unchangedAnchor && fireplaceEvidenceReady(cp.model);
  if (retainedFireplace) retainedEvidence.fireplaceCPerKg = {
    ...cp.model.validation.parameterEvidence.fireplaceCPerKg, fitStatus: 'retained-unchanged',
    retainedFrom: cp.model.validation.parameterEvidence.fireplaceCPerKg.retainedFrom ?? cp.model.trainedAt,
    currentWindowEvidence: diagnostics.evidence.fireplaceCPerKg };
  candidate.trainedAt = samples.at(-1).timestamp;
  candidate.uncertainty = errorEnvelope(validation);
  candidate.uncertaintyCPerHour = clamp(validation.maxErrorC / Math.max(1, Math.min(...validation.horizons)), 0.04, 0.6);
  candidate.validation = { accepted: true, kind: 'conditional-thermal', chronological: true, samples: validation.samples,
    maeC: validation.maeC, maxErrorC: validation.maxErrorC, persistenceMaeC: validation.persistenceMaeC,
    previousMaeC: previous.maeC, horizonHours: Math.min(...validation.horizons),
    maximumHorizonHours: Math.max(...validation.horizons),
    metric: 'duration-weighted trajectory temperature error in degrees C', embargoHours: 12,
    trainThrough: samples[split - 1].timestamp, validateFrom: samples[scoreFrom].timestamp,
    phaseSamples, phaseEpisodes, fittedParameters: tunable, parameterEvidence: retainedEvidence,
    phaseThermalEpisodes: Object.fromEntries(PHASES.map(phase => [phase,
      validation.blocks.filter(block => block.completeEpisode && block.phaseHours[phase] > 0).length])),
    phaseValidationSamples: Object.fromEntries(PHASES.map(phase => [phase,
      validation.blocks.filter(block => block.phaseHours[phase] > 0).length])),
    excludedValidationBlocks: validation.excluded, solarSamples: diagnostics.rows.length,
    sunlitSamples: diagnostics.rows.filter(row => row.segments.some(segment => segment.solarRadiationWm2 > 50)).length,
    sunlitValidationSamples: holdoutRows.filter(row => row.segments.some(segment => segment.solarRadiationWm2 > 50)).length,
    fireplaceFreeSamples: Math.max(diagnostics.fireFreeSamples, cp.model.validation?.fireplaceFreeSamples ?? 0),
    fireplace: retainedFireplace ? { ...cp.model.validation.fireplace, fitStatus: 'retained-unchanged' }
      : { accepted: tunable.includes('fireplaceCPerKg') && validationBurns.length >= 3,
      trainingBurns: trainingBurns.length, validationBurns: validationBurns.length,
      coreAnchor: { kind: thermalEvidenceReady(cp.model) ? 'previously-validated-house-response' : 'unavailable',
        trainedAt: cp.model.trainedAt, retainedParameters: retainedCoreParameters },
      currentKnownCleanTrainingIntervals: diagnostics.fireFreeSamples,
      cleanRateThresholdKgPerHour: FIREPLACE_RELEVANCE.cleanRateKgPerHour,
      excludedFromHouseFit: firePresent, responseShape: 'fixed-2h-rise-18h-release-120h-horizon',
      basis: 'effective temperature response per logged kg; no delivered-energy claim' },
    limitation: 'Thermal evidence is conditional on observed space-heating inputs; action response and full-cycle economics require separate validation' };
  candidate.provenance.status = thermalEvidenceReady(candidate) ? 'checked-conditional-thermal-estimates' : 'partial-thermal-evidence';
  const reconstruction = evaluateThermalModel(candidate, samples, { targetC, rollout: false, observedOnly: false });
  const reconstructed = reconstruction.state;
  return { accepted: true, model: candidate, state: reconstructed
    ? { indoorC: reconstruction.lastEndpointFresh ? samples.at(-1).indoorC : reconstructed.indoorC,
      reserveC: reconstructed.reserveC, slabC: reconstructed.slabC ?? null, observedAt: samples.at(-1).timestamp } : null };
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
    supplyC: sample.supplyC ?? null, brineC: sample.brineC ?? null,
    floorOverrideMode: sample.floorOverrideMode ?? 'off', treatmentKey: sample.treatmentKey ?? 'native',
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
    ...(sample.fireplaceKgPerHour !== undefined ? { fireplaceKgPerHour: sample.fireplaceKgPerHour } : {}),
    ...(sample.fireplaceActive !== undefined ? { fireplaceActive: sample.fireplaceActive === true } : {}),
    ...(sample.fireplaceKnown !== undefined ? { fireplaceKnown: sample.fireplaceKnown === true } : {}),
    ...(sample.fireplaceEpisodeId ? { fireplaceEpisodeId: sample.fireplaceEpisodeId } : {}),
    ...(sample.fireplaceIgnitions?.length ? { fireplaceIgnitions: structuredClone(sample.fireplaceIgnitions) } : {}),
    episodeId: sample.episodeId ?? null,
    ...(sample.electricalContext ? { electricalContext: structuredClone(sample.electricalContext) } : {}),
    ...(sample.intervalInputs ? { intervalInputs: structuredClone(sample.intervalInputs), windowStart: sample.windowStart } : {}),
    ...(sample.inputSegments ? { inputSegments: structuredClone(sample.inputSegments), windowStart: sample.windowStart } : {}),
  } : { timestamp: new Date(at).toISOString(), valid: false, quality: ['invalid-observation'] };
  if (sample.indoorSensors) normalized.indoorSensors = structuredClone(sample.indoorSensors);
  if (sample.measurementEpochAt !== undefined) normalized.measurementEpochAt = sample.measurementEpochAt;
  const previous = cp.samples.at(-1);
  cp.samples.push(normalized);
  cp.samples = cp.samples.slice(-MAX_SAMPLES);
  cp.cursor = normalized.timestamp;
  for (const episode of cp.episodeArchive) {
    const lastAt = time(episode.samples.at(-1)?.timestamp);
    if ((!finite(lastAt) || lastAt < (episode.observationTailUntil ?? time(episode.endedAt))) && (!finite(lastAt) || at > lastAt)) {
      // Cycle completion can precede the end of its final recording window.
      // Retain that window only when committed, including an invalid endpoint
      // as a barrier. Never reconstruct it from the current controller context.
      episode.samples.push(structuredClone(normalized));
    }
  }
  if (acceptedSample) {
    const dt = previous ? (at - time(previous.timestamp)) / HOUR : Infinity;
    const segments = validSample(previous) && dt >= 1 / 12 && dt <= 2
      ? intervalSegments(previous, normalized, cp.baselineC ?? 21) : [];
    const predicted = segments.length && segments.every(segment => usableInputs(segment, false))
      ? thermalInterval(cp.model, cp.state ?? { indoorC: previous.indoorC, reserveC: previous.indoorC }, segments)
      : { reserveC: sample.indoorC };
    const refreshed = genuineEndpoint(cp.lastObservedEndpoint ?? previous, normalized);
    cp.state = { indoorC: refreshed || !finite(predicted.indoorC) ? sample.indoorC : predicted.indoorC,
      reserveC: predicted.reserveC, slabC: predicted.slabC ?? null, observedAt: normalized.timestamp };
    if (refreshed) cp.lastObservedEndpoint = { indoorSensors: structuredClone(normalized.indoorSensors ?? {}) };
  } else cp.state = null;
  // Reference adaptation consumes each committed sample in the same order in
  // live operation, replay and batched historical processing. A page boundary
  // cannot skip exclusions or earn a larger temperature adjustment.
  const comfortSamples = cp.samples.map(row => ({ ...row,
    action: row.phase === 'normal' ? 'normal' : 'reduction', regime: row.regime === 'occupied' ? 'occupied' : 'absence',
  }));
  cp.comfortReference = inferComfortReference(cp.comfortReference, comfortSamples, { now: at });
  cp.baselineC = cp.comfortReference?.targetC ?? cp.baselineC;
  const participating = Object.entries(normalized.indoorSensors ?? {}).filter(([, sensor]) => sensor.weight > 0).map(([signal]) => signal);
  const sensorSignals = new Set([...Object.keys(cp.sensorComfortReferences ?? {}), ...participating]);
  if (sensorSignals.size) {
    cp.sensorComfortReferences ??= {};
    for (const signal of sensorSignals) cp.sensorComfortReferences[signal] = inferComfortReference(cp.sensorComfortReferences[signal],
      comfortSamples.map(row => ({ ...row, indoorC: row.indoorSensors?.[signal]?.weight > 0 ? row.indoorSensors[signal].value : null })), { now: at });
  }
  cp.sinceFit++;
  return finish ? finishAdaptiveUpdate(cp, { nowAt, config }) : cp;
}

function finishAdaptiveUpdate(cp, { nowAt, config }) {
  const valid = cp.samples.filter(validSample);
  cp.health = { ...cp.health, processedThrough: cp.cursor, usableSamples: valid.length,
    retainedRecords: cp.samples.length, solarSamples: valid.filter(row => finite(row.solarRadiationWm2)).length,
    phaseSamples: Object.fromEntries(PHASES.map(phase => [phase, valid.filter(row => row.phase === phase).length])),
    evidence: valid.some(row => !row.actualModeKnown) ? 'includes-requested-modes' : 'observed-modes',
    electricityBasis: cp.model.energy?.basis ?? 'estimated' };
  if (cp.sinceFit >= REFIT_RECORDS) {
    cp.sinceFit = 0;
    const result = fitAdaptiveModel(cp, config);
    cp.health.lastFitAt = new Date(nowAt).toISOString();
    if (result.accepted) {
      cp.model = result.model;
      cp.state = result.state;
      cp.health = { ...cp.health, status: 'learning', reason: null, acceptedFits: (cp.health.acceptedFits ?? 0) + 1 };
    } else cp.health = { ...cp.health, status: cp.model.validation ? 'retained-previous' : 'prior-estimates',
      reason: result.reason, rejectedFits: (cp.health.rejectedFits ?? 0) + 1,
      rejectedValidation: result.validation ?? null };
    if (result.parameterEvidence) cp.health.parameterEvidence = result.parameterEvidence;
  }
  return cp;
}

/** Optional whole-cycle calibration. An incomplete cycle, missing attribution, or
 * repeated episode cannot strengthen the model. Estimated episodes remain estimates. */
function updateForecastValidation(model, episode) {
  const value = episode.forecastValidation;
  if (value?.eligible !== true || value.adjusted === true || value.basis !== 'frozen-advance-forecast'
    || !['temperatureMaeC', 'minimumTemperatureErrorC', 'energyRelativeError', 'costRelativeError', 'reductionHours']
      .every(key => finite(value[key])) || value.temperatureMaeC < 0 || value.energyRelativeError < 0 || value.costRelativeError < 0
    || value.reductionHours <= 0 || value.reductionHours > 72) return false;
  const records = [...(model.forecastValidation?.records ?? []).filter(record => record.id !== episode.id), {
    id: episode.id, endedAt: episode.endedAt, temperatureMaeC: value.temperatureMaeC,
    minimumTemperatureErrorC: Math.abs(value.minimumTemperatureErrorC), energyRelativeError: value.energyRelativeError,
    costRelativeError: value.costRelativeError,
    costAbsoluteErrorCents: finite(value.costAbsoluteErrorCents) ? value.costAbsoluteErrorCents : null,
    reductionHours: value.reductionHours, recoveryCostErrorCents: finite(value.recoveryCostErrorCents) ? value.recoveryCostErrorCents : null,
  }].slice(-30);
  const temperatureMaeC = mean(records.map(record => record.temperatureMaeC));
  const energyRelativeError = mean(records.map(record => record.energyRelativeError));
  const costRelativeError = mean(records.map(record => record.costRelativeError));
  const minimumTemperatureErrorC = Math.max(...records.map(record => record.minimumTemperatureErrorC));
  const accepted = records.length >= 3 && temperatureMaeC <= 0.5 && energyRelativeError <= 0.5 && costRelativeError <= 0.5
    && minimumTemperatureErrorC <= 0.75;
  const durations = records.map(record => record.reductionHours).sort((a, b) => b - a);
  model.forecastValidation = { kind: 'frozen-advance-forecast', records, episodes: records.length, accepted,
    temperatureMaeC, energyRelativeError, costRelativeError, minimumTemperatureErrorC,
    maxReductionHours: accepted ? durations[2] : 0,
    limitation: 'Recorded component energy may use nominal powers; forecast accuracy is not proof of counterfactual savings' };
  return true;
}

export function updateAdaptiveEpisode(input, episode, { config = {} } = {}) {
  const cp = checkpoint(input, config);
  if (episode?.complete !== true || episode.recoveryComplete !== true || typeof episode.id !== 'string'
    || !episode.id || !finite(time(episode.endedAt)) || !['measured', 'estimated'].includes(episode.energyBasis)) return cp;
  // A cycle that straddles a setting change cannot recalibrate the new equipment
  // policy, even if the old cycle completed successfully. Its journal is retained.
  if (finite(cp.equipmentEpochAt) && (!finite(time(episode.startedAt)) || time(episode.startedAt) < cp.equipmentEpochAt)) return cp;
  cp.episodeIds ??= [];
  if (cp.episodeIds.includes(episode.id) || finite(time(cp.lastEpisodeAt)) && time(episode.endedAt) <= time(cp.lastEpisodeAt)) return cp;
  const energy = { ...cp.model.energy }, priorCount = energy.episodes ?? 0;
  const alpha = 1 / Math.min(20, priorCount + 2);
  const blend = (previous, value) => finite(previous) ? previous + alpha * (value - previous) : value;
  let useful = updateForecastValidation(cp.model, episode);
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
    const warmupHours = thermalWarmupHours(cp.model);
    const warmupFrom = time(episode.startedAt) - warmupHours * HOUR;
    const precedingIndex = cp.samples.findLastIndex(sample => time(sample.timestamp) <= warmupFrom);
    // Periodic rooms may report the first genuine endpoint after recovery has
    // ended. Retain up to two hours of original input windows for that endpoint.
    const hasReportClocks = cp.samples.some(sample => Object.values(sample.indoorSensors ?? {})
      .some(sensor => sensor.weight > 0 && finite(time(sensor.observedAt))));
    const observationTailUntil = time(episode.endedAt) + (hasReportClocks ? 2 * HOUR : 0);
    const coveringIndex = cp.samples.findIndex(sample => time(sample.timestamp) >= observationTailUntil);
    // Preserve the full windows crossing both off-grid cycle boundaries and
    // every invalid endpoint between them. The trailing endpoint may arrive in
    // appendAdaptiveSample after this completion record has been processed.
    const rows = structuredClone(cp.samples.slice(Math.max(0, precedingIndex),
      coveringIndex < 0 ? cp.samples.length : coveringIndex + 1));
    const archive = [...(cp.episodeArchive ?? []), { id: episode.id, startedAt: time(episode.startedAt), endedAt: time(episode.endedAt),
      warmupHours, warmupFrom, observationTailUntil, treatmentKey: episode.treatmentKey ?? 'native',
      phases: [...new Set(episode.phases ?? rows.map(sample => sample.phase))],
      auxiliaryObserved: episode.auxiliaryObserved === true && (episode.spaceHeatingAuxKwh ?? 0) > 0,
      // Keep exact input windows. Point thinning would apply a fifteen-minute
      // duty/configuration to the longer gap and corrupt thermal attribution.
      samples: rows }];
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
