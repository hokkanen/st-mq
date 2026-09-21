import { garageSettings } from './settings.js';
import { garagePlanningMargins } from './planning-evidence.js';
import { createGarageRegression, fitGarageRegression } from './model-fit.js';
import { createGarageValidation, advanceGarageValidation, interruptGarageValidation, summarizeGarageValidation } from './model-validation.js';
import { garageDoorIntervalUnknown } from './door-state.js';
const HOUR = 3_600_000, finite = Number.isFinite;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const clone = value => structuredClone(value);
export const GARAGE_ALGORITHM_VERSION = 'committed-garage-v4-simple-off';
export const GARAGE_MODEL_ASSUMPTIONS = Object.freeze({ evHeatFraction: .075, normalPowerKw: .5,
  recoveryTimeHours: 3, recoveryEnergyFactor: 1.25, doorHeat: 'not-credited-reassess-from-sensors' });
const REAR = [['coolingPerHour', .03, .001, .3, '1/h']];
const FRONT = [['coolingPerHour', .04, .001, .4, '1/h']];
const errorState = () => ({ n: 0, hours: 0, absolute: 0, square: 0, signed: 0 });
function recordError(metrics, residual, hours) {
  if (finite(residual)) { metrics.n++; metrics.hours += hours; metrics.absolute += Math.abs(residual) * hours;
    metrics.square += residual ** 2 * hours; metrics.signed += residual * hours; }
}
function errors(metrics) { const weight = metrics.hours || metrics.n;
  return { n: metrics.n, hours: metrics.hours, mae: weight ? metrics.absolute / weight : null,
    rmse: weight ? Math.sqrt(metrics.square / weight) : null, bias: weight ? metrics.signed / weight : null }; }
function validC(value) { return finite(value) && value >= -60 && value <= 65; }
export function qualifiedGaragePower(input) { return finite(input.powerKw) && input.powerKw >= 0 && input.powerKw <= 8
  && ['verified', 'provisional', 'simulated'].includes(input.powerQuality); }
function activity(input) { return typeof input.activity === 'boolean' ? Number(input.activity)
  : finite(input.activity) && input.activity >= 0 && input.activity <= 1 ? input.activity : null; }
function evInputs(input) {
  return [1, 2].map(id => {
    const kw = input[`ev${id}Kw`], active = input[`ev${id}Active`];
    const configured = input.evEvidenceRequired?.[`ev${id}`] ?? (Object.hasOwn(input, `ev${id}Kw`) || Object.hasOwn(input, `ev${id}Active`));
    return finite(kw) && kw >= 0 && kw <= 50 ? { kw, active: kw > .1 || active === true, known: true, kind: 'power' }
      : typeof active === 'boolean' ? { kw: 0, active, known: true, kind: 'activity' }
        : { kw: 0, active: false, known: !configured, kind: 'unknown' };
  });
}
export const garageChargingClean = input => evInputs(input).every(ev => ev.known && !ev.active);
export function garageAssumedEvHeat(input = {}) {
  return [1, 2].map(id => ({ id, heatKw: finite(input[`ev${id}Kw`]) && input[`ev${id}Kw`] >= 0 && input[`ev${id}Kw`] <= 50
    ? input[`ev${id}Kw`] * GARAGE_MODEL_ASSUMPTIONS.evHeatFraction : null, basis: 'fixed-7.5-percent-of-charger-electricity' }));
}
export function createGarageModel({ seedAt = 0, baselineC = 10 } = {}) {
  if (!finite(seedAt) || !finite(baselineC)) throw new Error('Garage seed requires numeric UTC time and baseline');
  return { algorithm: GARAGE_ALGORITHM_VERSION, seedAt, at: null, updates: 0, trainedIntervals: 0,
    rear: createGarageRegression(REAR), front: createGarageRegression(FRONT),
    native: { values: [GARAGE_MODEL_ASSUMPTIONS.normalPowerKw], active: [false], samples: 0, hours: 0 },
    nativeActivity: { mean: null, samples: 0, hours: 0 },
    state: { rearC: null, frontC: null, differenceC: null }, previous: null,
    normalReference: { interceptC: baselineC, frontC: baselineC, outdoorSlope: 0, baselineC, samples: 0,
      availableSince: null, lastPauseAt: null, initialized: false, outdoorC: 0, qualifiedHours: 0, settledC: null },
    validation: createGarageValidation(),
    heldOut: Object.fromEntries(['rear', 'front', 'native', 'advanceRear', 'advanceFront', 'offRear', 'offFront'].map(key => [key, errorState()])),
    evidence: { offIntervals: 0, powerIntervals: 0, activityIntervals: 0, rearOnlyIntervals: 0,
      offHours: 0, powerHours: 0, activityHours: 0,
      ev: [{ powerIntervals: 0, activityIntervals: 0, independentIntervals: 0 }, { powerIntervals: 0, activityIntervals: 0, independentIntervals: 0 }] },
    lastError: null, sourceEpoch: null, intervalDisturbed: false, intervalAvailability: null, intervalTransitions: 0 };
}
export function normalGarageTemperature(model) { return model.normalReference.interceptC; }
export function predictGarageNative(model, state, input = {}) {
  if (input.available === false) return { powerKw: 0, activity: 0, basis: 'explicit-native-off', uncertaintyKw: 0 };
  const measured = model.native.active[0] === true;
  return { powerKw: measured ? model.native.values[0] : GARAGE_MODEL_ASSUMPTIONS.normalPowerKw, activity: model.nativeActivity?.mean ?? null,
    basis: measured ? 'observed-normal-power' : 'fixed-power-assumption',
    uncertaintyKw: Math.max(errors(model.heldOut.native).rmse ?? 0, measured ? .1 : .25) };
}
/** OFF: each sensor approaches outdoor temperature with one measured cooling
 * rate. ON: a declared three-hour approach to observed normal warmth is only an
 * illustrative recovery envelope, never measured pump heat or pipe protection.
 * Charger heat is disclosed but does not create an assumed temperature rise. */
export function predictGarageStep(model, state, input = {}, durationHours, { conditional = false } = {}) {
  if (model?.algorithm !== GARAGE_ALGORITHM_VERSION) throw new Error('Unsupported garage model algorithm');
  if (!finite(durationHours) || durationHours <= 0 || durationHours > 4 || !validC(state?.rearC) || !validC(input.outdoorC))
    throw new Error('Garage prediction requires temperature, outdoor and a bounded interval');
  const off = input.available === false, native = predictGarageNative(model, state, input);
  const next = {};
  for (const location of ['rear', 'front']) {
    const value = state[`${location}C`];
    if (!validC(value)) { next[`${location}C`] = null; continue; }
    const target = off ? input.outdoorC : location === 'rear' ? normalGarageTemperature(model) : model.normalReference.frontC;
    const rate = off ? model[location].values[0] : 1 / GARAGE_MODEL_ASSUMPTIONS.recoveryTimeHours;
    next[`${location}C`] = clamp(target + (value - target) * Math.exp(-rate * durationHours), -60, 65);
  }
  next.differenceC = validC(next.frontC) ? next.frontC - next.rearC : null;
  const metered = conditional && qualifiedGaragePower(input), powerKw = metered ? input.powerKw : native.powerKw;
  return { state: next, ...next, electricityKwh: powerKw * durationHours,
    uncertaintyKwh: metered ? 0 : native.uncertaintyKw * durationHours,
    electricityBasis: metered ? input.powerQuality === 'verified' ? 'qualified-observed-electricity' : 'provisional-observed-electricity' : native.basis,
    assumedEvHeat: garageAssumedEvHeat(input),
    rearUncertaintyC: Math.max(.2, errors(model.heldOut.offRear).rmse ?? .4) * Math.sqrt(durationHours),
    frontUncertaintyC: Math.max(.3, errors(model.heldOut.offFront).rmse ?? .65) * Math.sqrt(durationHours) };
}
function learnReference(model, current, prior, hours, allowFit) {
  const reference = model.normalReference;
  const disturbed = current.inputDisturbed === true || !validC(current.frontC) || !validC(prior.frontC) || model.intervalDisturbed || current.managedPause === true || current.recovering === true || current.available !== true || (current.baselineAccepted !== true && current.baselineVerified !== true)
    || current.doorFront === true || current.doorRear === true || prior.doorFront === true || prior.doorRear === true
    || garageDoorIntervalUnknown(current, prior) || !garageChargingClean(current) || !garageChargingClean(prior);
  if (current.managedPause || current.recovering || current.available === false) reference.lastPauseAt = current.at;
  if (disturbed) { reference.availableSince = null; reference.settledC = current.rearC; return; }
  if (reference.availableSince === null) reference.availableSince = current.at;
  reference.settledC = finite(reference.settledC)
    ? current.rearC + (reference.settledC - current.rearC) * Math.exp(-hours / 2) : current.rearC;
  if (!allowFit || (current.at - reference.availableSince) / HOUR < 8
    || Math.abs(current.rearC - reference.settledC) / 2 > .25) return;
  if (reference.initialized && current.rearC < reference.interceptC - .5) return;
  const weight = reference.initialized ? 1 - Math.exp(-hours / 80) : hours / (reference.qualifiedHours + hours);
  reference.interceptC += weight * (current.rearC - reference.interceptC);
  if (validC(current.frontC)) reference.frontC += weight * (current.frontC - reference.frontC);
  reference.outdoorC = current.outdoorC; reference.samples++; reference.qualifiedHours += hours;
  reference.initialized = reference.qualifiedHours >= 2;
}
/** The same ordered function drives live learning and saved-journal replay. */
export function updateGarageModel(previous, observation, settings = {}) {
  const config = garageSettings(settings);
  const model = clone(previous ?? createGarageModel({ seedAt: observation?.at, baselineC: config.baselineC }));
  if (model.algorithm !== GARAGE_ALGORITHM_VERSION) throw new Error('Unsupported garage model algorithm; preserve archive and start an explicit seed');
  if (!finite(observation?.at)) throw new Error('Garage learning requires numeric UTC time');
  if (finite(model.at) && observation.at <= model.at) return model;
  const current = clone(observation);
  model.at = current.at; model.updates++;
  if (current.sourceEpoch != null && model.sourceEpoch !== null && current.sourceEpoch !== model.sourceEpoch) {
    model.previous = null; model.normalReference.availableSince = null;
    interruptGarageValidation(model, 'source-epoch-boundary');
  }
  model.sourceEpoch = current.sourceEpoch ?? model.sourceEpoch;
  const rearAt = current.rearAt ?? current.at, frontAt = current.frontAt ?? current.at;
  const rearFresh = validC(current.rearC) && current.rearUsable !== false && current.rearRetained !== true
    && finite(rearAt) && rearAt <= current.at && current.at - rearAt <= config.maxSensorAgeMs;
  const frontFresh = validC(current.frontC) && current.frontUsable !== false && current.frontRetained !== true
    && finite(frontAt) && frontAt <= current.at && current.at - frontAt <= config.maxSensorAgeMs;
  if (!rearFresh) { model.previous = null; model.normalReference.availableSince = null; interruptGarageValidation(model, 'rear-input-unavailable'); model.lastError = 'rear-input-unavailable'; return model; }
  if (!frontFresh) current.frontC = null;
  const prior = model.previous, hours = prior ? (rearAt - (prior.rearAt ?? prior.at)) / HOUR : 0;
  if (prior) {
    // A single normal OFF/ON edge between asynchronous temperature reports
    // belongs to the episode. Multiple edges hide a mixed interval even when
    // the final endpoints agree, so neither fitting nor validation may use it.
    const previousAvailability = model.intervalAvailability ?? prior.available;
    if (current.available !== previousAvailability) model.intervalTransitions = (model.intervalTransitions ?? 0) + 1;
    model.intervalAvailability = current.available;
    model.intervalDisturbed ||= model.intervalTransitions > 1 || typeof current.available !== 'boolean';
  }
  if (prior && rearAt <= (prior.rearAt ?? prior.at)) {
    model.intervalDisturbed ||= current.inputDisturbed === true || current.doorFront === true || current.doorRear === true
      || garageDoorIntervalUnknown(current, prior) || !garageChargingClean(current) || current.rearGap === true || current.frontGap === true;
    if (model.intervalDisturbed) { model.normalReference.availableSince = null; interruptGarageValidation(model, 'disturbance-between-temperature-reports'); }
    if (frontFresh) { model.state.frontC = current.frontC; model.state.differenceC = current.frontC - current.rearC; }
    model.lastError = 'no-new-rear-observation'; return model;
  }
  const supported = prior && hours >= 1 / 120 && hours <= 2 && validC(prior.outdoorC) && validC(current.outdoorC)
    && current.rearGap !== true && prior.rearGap !== true;
  if (supported) {
    const state = { rearC: prior.rearC, frontC: prior.frontC, differenceC: validC(prior.frontC) ? prior.frontC - prior.rearC : null };
    const frontKnown = validC(prior.frontC) && frontFresh && frontAt > (prior.frontAt ?? prior.at)
      && current.frontGap !== true && prior.frontGap !== true && Math.abs(frontAt - rearAt) <= 5 * 60_000
      && Math.abs((prior.frontAt ?? prior.at) - (prior.rearAt ?? prior.at)) <= 5 * 60_000;
    const disturbed = current.inputDisturbed === true || model.intervalDisturbed || garageDoorIntervalUnknown(current, prior) || [current, prior].some(row => row.doorFront === true
      || row.doorRear === true || !garageChargingClean(row)) || Math.abs(current.rearC - prior.rearC) > 2;
    const metered = qualifiedGaragePower(prior), active = activity(prior);
    const episode = advanceGarageValidation(model, { state, prior, current, hours, frontKnown, disturbed, metered, predict: predictGarageStep });
    const heldOut = episode.role ? episode.role === 'validation' : ((prior.at - model.seedAt) / HOUR % 24 + 24) % 24 >= 18;
    const off = prior.available === false && current.available === false;
    if (!disturbed && heldOut && off) {
      const forecast = episode.forecast ?? predictGarageStep(model, state, prior, hours);
      for (const key of ['rear', 'advanceRear', 'offRear']) recordError(model.heldOut[key], current.rearC - forecast.rearC, hours);
      if (frontKnown) for (const key of ['front', 'advanceFront', 'offFront']) recordError(model.heldOut[key], current.frontC - forecast.frontC, hours);
    }
    if (!disturbed && !heldOut && off) {
      model.trainedIntervals++; model.evidence.offIntervals++; model.evidence.offHours += hours;
      // Midpoint temperature estimates the integrated temperature difference;
      // duration weighting makes the result independent of sensor poll count.
      const ambient = (prior.outdoorC + current.outdoorC) / 2;
      fitGarageRegression(model.rear, REAR, [ambient - (prior.rearC + current.rearC) / 2], (current.rearC - prior.rearC) / hours, hours);
      if (frontKnown) fitGarageRegression(model.front, FRONT, [ambient - (prior.frontC + current.frontC) / 2], (current.frontC - prior.frontC) / hours, hours);
    }
    if (metered) { model.evidence.powerIntervals++; model.evidence.powerHours += hours; }
    else if (active !== null) { model.evidence.activityIntervals++; model.evidence.activityHours += hours; }
    evInputs(prior).forEach((ev, i) => {
      if (ev.active && ev.kind === 'power') model.evidence.ev[i].powerIntervals++;
      if (ev.active && ev.kind === 'activity') model.evidence.ev[i].activityIntervals++;
    });
    const normal = !disturbed && prior.available === true && current.available === true
      && !prior.managedPause && !prior.recovering && !current.recovering && !model.validation.active
      && model.normalReference.initialized && Math.abs(prior.rearC - normalGarageTemperature(model)) <= .65;
    if (normal && metered && heldOut) recordError(model.heldOut.native, prior.powerKw - model.native.values[0], hours);
    if (normal && !heldOut) {
      if (metered) {
        const weight = model.native.hours < 2 ? hours / (model.native.hours + hours) : 1 - Math.exp(-hours / 48);
        model.native.values[0] += weight * (prior.powerKw - model.native.values[0]);
        model.native.hours += hours; model.native.samples++; model.native.active[0] = model.native.hours >= 2;
      }
      if (active !== null) {
        const duty = model.nativeActivity, weight = duty.hours < 2 ? hours / (duty.hours + hours) : 1 - Math.exp(-hours / 48);
        duty.mean = (duty.mean ?? active) + weight * (active - (duty.mean ?? active)); duty.hours += hours; duty.samples++;
      }
    }
    if (!frontKnown) model.evidence.rearOnlyIntervals++;
    learnReference(model, current, prior, hours, !heldOut);
  } else if (prior) { model.normalReference.availableSince = null; interruptGarageValidation(model, 'gapped-observation'); }
  model.intervalDisturbed = false; model.intervalAvailability = null; model.intervalTransitions = 0;
  model.state = { rearC: current.rearC, frontC: frontFresh ? current.frontC : null,
    differenceC: frontFresh ? current.frontC - current.rearC : null };
  model.previous = { ...current, rearAt, frontAt }; model.lastError = supported ? null : 'initial-or-gapped-observation';
  return model;
}
export function replayGarageModel(seed, entries) {
  if (seed?.algorithm !== GARAGE_ALGORITHM_VERSION) throw new Error('Unsupported garage journal algorithm');
  let model = clone(seed);
  for (const entry of entries) {
    if (entry.algorithm && entry.algorithm !== GARAGE_ALGORITHM_VERSION) throw new Error('Mixed garage journal algorithms');
    model = updateGarageModel(model, entry.observation ?? entry, entry.settings ?? {});
  }
  return model;
}
/** A known plan is still cancellable. It provides heat attribution only. */
export function knownGarageEvAt(plans, at, decisionAt) {
  const result = { ev1Kw: 0, ev2Kw: 0, ev1Active: false, ev2Active: false };
  for (const id of [1, 2]) {
    const eligible = plans.filter(plan => (plan.charger === id || plan.charger === `ev${id}`)
      && finite(plan.knownAt) && plan.knownAt <= decisionAt && finite(plan.start) && finite(plan.end)
      && plan.start <= at && at < plan.end).sort((a, b) => b.knownAt - a.knownAt);
    const plan = eligible[0];
    if (!plan || plan.cancelled === true) continue;
    const confidence = finite(plan.confidence) ? clamp(plan.confidence, 0, 1) : .5;
    if (finite(plan.powerKw) && plan.powerKw >= 0 && plan.powerKw <= 50) result[`ev${id}Kw`] = plan.powerKw * confidence;
    else { delete result[`ev${id}Kw`]; result[`ev${id}Active`] = plan.active === true ? confidence : false; }
  }
  return result;
}
export function forecastGarage(model, { now, initial = model.state, steps = [], settings = {}, knownEvPlans = [], protection = false } = {}) {
  garageSettings(settings);
  if (!finite(now) || steps.length > 600) throw new Error('Garage forecast requires bounded steps and decision time');
  let state = clone(initial), cursor = now, electricityKwh = 0, costEur = 0, uncertaintyKwh = 0;
  const points = [], summary = garageModelSummary(model);
  for (const step of steps) {
    const start = step.start ?? cursor, end = step.end ?? step.at;
    if (!finite(start) || !finite(end) || start !== cursor || end <= start || end - start > 4 * HOUR) throw new Error('Garage forecast steps must be contiguous bounded UTC intervals');
    const ev = protection ? { ev1Kw: 0, ev2Kw: 0 } : knownGarageEvAt(knownEvPlans, start, now);
    const next = predictGarageStep(model, state, { outdoorC: step.outdoorC, available: step.available !== false, ...ev }, (end - start) / HOUR);
    state = next.state; electricityKwh += next.electricityKwh; uncertaintyKwh += next.uncertaintyKwh;
    if (finite(step.priceCtPerKwh)) costEur += next.electricityKwh * step.priceCtPerKwh / 100;
    const margins = garagePlanningMargins(summary, (end - now) / HOUR);
    points.push({ start, end, outdoorC: step.outdoorC, available: step.available !== false, priceCtPerKwh: step.priceCtPerKwh, at: end, ...next,
      rearLowerC: next.rearC - margins.rearC, frontLowerC: next.frontC === null ? null : next.frontC - margins.frontC });
    cursor = end;
  }
  return { points, state, electricityKwh, costEur, uncertaintyKwh,
    basis: 'off-cooling-and-assumed-normal-recovery-no-future-actual-inputs', algorithm: model.algorithm };
}
export function garageModelSummary(model) {
  if (!model || model.algorithm !== GARAGE_ALGORITHM_VERSION) return { algorithm: model?.algorithm ?? GARAGE_ALGORITHM_VERSION, status: 'unavailable' };
  const heldOut = Object.fromEntries(Object.entries(model.heldOut).map(([key, value]) => [key, errors(value)]));
  const coefficients = (specs, reg) => specs.map((spec, i) => ({ name: spec[0], value: reg.values[i], unit: spec[4],
    basis: reg.active[i] ? 'fitted-effective-response' : 'fixed-prior', evidence: reg.evidence[i], evidenceUnit: 'hours' }));
  const validation = summarizeGarageValidation(model);
  const thermalReady = model.normalReference.initialized && model.rear.active[0] && model.front.active[0] && validation.supportedOffHours > 0;
  const electricalReady = model.native.active[0] && model.native.hours >= 6 && heldOut.native.hours >= 2
    && heldOut.native.rmse < .35 && validation.recoveryEpisodes >= 1;
  return { algorithm: model.algorithm, status: thermalReady ? 'validated-provisional' : 'learning', ready: thermalReady,
    thermalReady, electricalReady, nativeActivity: { ...model.nativeActivity, basis: 'observed-dimensionless-activity-no-watts' },
    maxPauseHours: thermalReady ? validation.supportedOffHours : 0, validation, trainedIntervals: model.trainedIntervals, heldOut,
    coefficients: { rear: coefficients(REAR, model.rear), front: coefficients(FRONT, model.front), native: [{ name: 'normalPowerKw', value: predictGarageNative(model).powerKw, unit: 'kW', basis: model.native.active[0] ? 'observed-normal-power' : 'fixed-prior', evidence: model.native.hours }] },
    cooling: Object.fromEntries(['rear', 'front'].map(location => [location,
      { ratePerHour: model[location].values[0], hours: model[location].hours, fitted: model[location].active[0] }])),
    state: clone(model.state), structure: { thermalStates: 2, learnedCoolingCoefficients: 2 }, assumptions: { ...GARAGE_MODEL_ASSUMPTIONS },
    electricity: { normalPowerKw: predictGarageNative(model).powerKw, hours: model.native.hours,
      basis: model.native.active[0] ? 'observed-normal-power' : 'fixed-power-assumption' },
    normalReference: { rearC: normalGarageTemperature(model), frontC: model.normalReference.frontC, outdoorC: model.normalReference.outdoorC,
      initialized: model.normalReference.initialized, outdoorSlope: 0,
      basis: model.normalReference.initialized ? 'continuously-available-achieved-reference' : 'setting-prior-not-measured-temperature',
      samples: model.normalReference.samples, qualifiedHours: model.normalReference.qualifiedHours },
    ev: { heatFraction: GARAGE_MODEL_ASSUMPTIONS.evHeatFraction,
      chargers: model.evidence.ev.map((e, i) => ({ id: i + 1, ...e, basis: 'fixed-7.5-percent-heat-assumption' })) },
    limitations: ['Only clean OFF intervals fit the two cooling coefficients; there is no latent building temperature.',
      'OFF validation freezes its forecast, and completion requires both measured locations to recover with at least three hours of normal heating.',
      'Normal heating and recovery forecasts are fixed envelopes, not measured Mitsubishi heat output.',
      'Charger heat is 7.5% of electricity; it never extends a safe pause.',
      ...(!electricalReady ? ['Euro savings remain provisional because normal and recovery electricity are not fully validated.'] : [])] };
}
