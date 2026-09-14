import { garageSettings } from './settings.js';
import { garagePlanningMargins } from './planning-evidence.js';
import { createGarageRegression, fitGarageRegression } from './model-fit.js';
import { createGarageValidation, advanceGarageValidation, interruptGarageValidation, summarizeGarageValidation } from './model-validation.js';
const HOUR = 3_600_000, finite = Number.isFinite;
const MEMORY_TIME_HOURS = 18;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const clone = value => structuredClone(value);
export const GARAGE_ALGORITHM_VERSION = 'committed-garage-v2-sparse';
const REAR = [
  ['lossPerHour', .022, .001, .15, '1/h'], ['memoryExchangePerHour', .11, .01, .6, '1/h'],
  ['powerHeatCPerKwh', .55, .02, 4, '°C/kWh'], ['activityHeatCPerHour', .5, .02, 4, '°C/h'],
  ['ev1CPerKwh', .012, 0, .2, '°C/kWh'], ['ev2CPerKwh', .012, 0, .2, '°C/kWh'],
  ['ev1ActiveCPerHour', .04, 0, .6, '°C/h'], ['ev2ActiveCPerHour', .04, 0, .6, '°C/h'],
];
const FRONT = [
  ['differenceRelaxationPerHour', .55, .08, 2, '1/h'], ['localLossPerHour', .012, 0, .10, '1/h'],
  ['powerDistributionCPerKwh', .07, -.5, .8, '°C/kWh'], ['activityDistributionCPerHour', .06, -.5, .8, '°C/h'],
  ['ev1DifferenceCPerKwh', 0, -.08, .08, '°C/kWh'], ['ev2DifferenceCPerKwh', 0, -.08, .08, '°C/kWh'],
  ['ev1ActiveDifferenceCPerHour', 0, -.2, .2, '°C/h'], ['ev2ActiveDifferenceCPerHour', 0, -.2, .2, '°C/h'],
];
const NATIVE = [ ['idleAndMaintenanceKw', .26, 0, 2, 'kW'], ['coldWeatherKwPerC', .012, 0, .1, 'kW/°C'],
  ['demandKwPerC', .35, .01, 1.5, 'kW/°C'], ['restartKw', .1, 0, 1, 'kW'] ];
const regression = createGarageRegression;
const errorState = () => ({ n: 0, hours: 0, absolute: 0, square: 0, signed: 0 });
function recordError(metrics, residual, hours = 1) {
  if (finite(residual)) { metrics.n++; metrics.hours += hours;
    metrics.absolute += Math.abs(residual) * hours; metrics.square += residual ** 2 * hours; metrics.signed += residual * hours; }
}
function errors(metrics) { const weight = metrics.hours || metrics.n;
  return { n: metrics.n, hours: metrics.hours, mae: weight ? metrics.absolute / weight : null,
    rmse: weight ? Math.sqrt(metrics.square / weight) : null, bias: weight ? metrics.signed / weight : null }; }
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
function validC(value) { return finite(value) && value >= -60 && value <= 65; }
function qualifiedPower(input) { return finite(input.powerKw) && input.powerKw >= 0 && input.powerKw <= 8
  && ['verified', 'provisional', 'simulated'].includes(input.powerQuality); }
function activity(input) { return typeof input.activity === 'boolean' ? Number(input.activity)
  : finite(input.activity) && input.activity >= 0 && input.activity <= 1 ? input.activity : null; }
function evInputs(input) {
  return [1, 2].map(id => {
    const kw = input[`ev${id}Kw`], active = input[`ev${id}Active`];
    return finite(kw) && kw >= 0 && kw <= 50 ? { kw, active: 0, known: true, kind: 'power' }
      : (typeof active === 'boolean' || finite(active) && active >= 0 && active <= 1) ? { kw: 0, active: Number(active), known: true, kind: 'activity' }
        : { kw: 0, active: 0, known: false, kind: 'unknown' };
  });
}
export function createGarageModel({ seedAt = 0, baselineC = 10 } = {}) {
  if (!finite(seedAt) || !finite(baselineC)) throw new Error('Garage seed requires numeric UTC time and baseline');
  return { algorithm: GARAGE_ALGORITHM_VERSION, seedAt, at: null, updates: 0, trainedIntervals: 0,
    rear: regression(REAR), front: regression(FRONT), native: regression(NATIVE),
    nativeActivity: { mean: .5, samples: 0, hours: 0 },
    state: { rearC: null, frontC: null, coreC: null, differenceC: null }, previous: null,
    normalReference: { interceptC: baselineC, outdoorSlope: .03, baselineC, samples: 0,
      availableSince: null, lastPauseAt: null, initialized: false, outdoorC: 0, qualifiedHours: 0, settledC: null },
    validation: createGarageValidation(),
    heldOut: Object.fromEntries(['rear', 'front', 'native', 'advanceRear', 'advanceFront', 'offRear', 'offFront'].map(key => [key, errorState()])),
    evidence: { offIntervals: 0, powerIntervals: 0, activityIntervals: 0, rearOnlyIntervals: 0,
      offHours: 0, powerHours: 0, activityHours: 0,
      ev: [{ powerIntervals: 0, activityIntervals: 0, independentIntervals: 0 }, { powerIntervals: 0, activityIntervals: 0, independentIntervals: 0 }] },
    lastError: null, sourceEpoch: null };
}
export function normalGarageTemperature(model, outdoorC = 0) {
  const reference = model.normalReference;
  return clamp(reference.interceptC + reference.outdoorSlope * (finite(outdoorC) ? outdoorC : 0), 3, reference.baselineC + 3);
}
function nativeFeatures(model, state, input) {
  return [1, Math.max(0, -(input.outdoorC ?? 0)), Math.max(0, normalGarageTemperature(model, input.outdoorC) - state.rearC),
    input.restart === true ? 1 : 0];
}
export function predictGarageNative(model, state, input = {}) {
  if (input.available === false) return { powerKw: 0, activity: 0, basis: 'explicit-native-off', uncertaintyKw: 0 };
  const demand = normalGarageTemperature(model, input.outdoorC) - state.rearC;
  const predicted = dot(model.native.values, nativeFeatures(model, state, input));
  // Availability permits native regulation, including zero output above its
  // effective reference. It never means a forced compressor duty.
  const powerKw = clamp(predicted * clamp((demand + .65) / .65, 0, 1), 0, 3);
  const nativeError = errors(model.heldOut.native).rmse;
  const duty = model.nativeActivity;
  // Activity is dimensionless telemetry. Once observed, predict its own native
  // response rather than deriving it from unmeasured electrical watts.
  const predictedActivity = duty?.hours >= 2
    ? (duty.mean + .015 * Math.max(0, -(input.outdoorC ?? 0)) + .45 * Math.max(0, demand)) * clamp((demand + .65) / .65, 0, 1)
    : powerKw / .8;
  return { powerKw, activity: clamp(predictedActivity, 0, 1),
    basis: model.native.active?.[0] ? 'learned-native-electrical-response' : 'prior-modeled-electricity',
    uncertaintyKw: Math.max(nativeError ?? .3, model.native.active?.[0] ? .08 : .25) };
}
function features(state, input, power, active) {
  const ev = evInputs(input);
  const tail = [power, active, ev[0].kw, ev[1].kw, ev[0].active, ev[1].active];
  return { rear: [input.outdoorC - state.rearC, state.coreC - state.rearC, ...tail],
    front: [-state.differenceC, input.outdoorC - state.rearC, ...tail] };
}
/** One step shared by advance planning and retrospective frozen-model assessment.
 * With conditional:true only input known for this elapsed interval may be used.
 * The default deliberately ignores actual power, fan and defrost fields. */
export function predictGarageStep(model, state, input = {}, durationHours, { conditional = false } = {}) {
  if (model?.algorithm !== GARAGE_ALGORITHM_VERSION) throw new Error('Unsupported garage model algorithm');
  if (!finite(durationHours) || durationHours <= 0 || durationHours > 4 || !validC(state?.rearC) || !validC(input.outdoorC))
    throw new Error('Garage prediction requires temperature, outdoor and a bounded interval');
  const next = { rearC: state.rearC, coreC: validC(state.coreC) ? state.coreC : state.rearC,
    differenceC: finite(state.differenceC) ? state.differenceC : validC(state.frontC) ? state.frontC - state.rearC : -.25 };
  let energyKwh = 0, uncertaintyKwh = 0, basis = 'prior-modeled-electricity';
  const count = Math.ceil(durationHours * 12), dt = durationHours / count;
  for (let i = 0; i < count; i++) {
    const native = predictGarageNative(model, next, input);
    const actualPower = conditional && qualifiedPower(input), actualActivity = conditional ? activity(input) : null;
    const kw = actualPower ? input.powerKw : native.powerKw;
    const preferActivity = !actualPower && (model.rear.active?.[3] === true && model.rear.active?.[2] !== true
      || (model.rear.evidence?.[2] ?? model.evidence.powerHours) < 2 && model.evidence.activityHours >= 2);
    const off = input.available === false;
    const heatPower = off ? 0 : actualPower ? kw : actualActivity !== null || preferActivity ? 0 : kw;
    const heatActivity = off ? 0 : actualPower ? 0 : actualActivity ?? (preferActivity ? native.activity : 0);
    const x = features(next, input, heatPower, heatActivity);
    const rearRate = dot(model.rear.values, x.rear), differenceRate = dot(model.front.values, x.front);
    // The 18h state is estimated building memory, not pipe temperature or kWh.
    const memoryRate = (next.rearC - next.coreC) / MEMORY_TIME_HOURS;
    next.rearC = clamp(next.rearC + rearRate * dt, -60, 65);
    next.coreC = clamp(next.coreC + memoryRate * dt, -60, 65);
    next.differenceC = clamp(next.differenceC + differenceRate * dt, -20, 15);
    energyKwh += (off && !actualPower ? 0 : kw) * dt;
    uncertaintyKwh += actualPower ? 0 : native.uncertaintyKw * dt;
    basis = actualPower ? (input.powerQuality === 'verified' ? 'qualified-observed-electricity' : 'provisional-observed-electricity') : native.basis;
  }
  next.frontC = clamp(next.rearC + next.differenceC, -60, 65);
  const rearError = errors(model.heldOut.advanceRear).rmse, frontError = errors(model.heldOut.advanceFront).rmse;
  return { state: next, rearC: next.rearC, frontC: next.frontC, coreC: next.coreC,
    electricityKwh: energyKwh, uncertaintyKwh, electricityBasis: basis,
    rearUncertaintyC: Math.max(.15, rearError ?? .4) * Math.sqrt(durationHours),
    frontUncertaintyC: Math.max(.25, frontError ?? .65) * Math.sqrt(durationHours) };
}
function learnReference(model, current, previous, hours, config, allowFit) {
  const reference = model.normalReference;
  const disturbance = current.managedPause === true || current.recovering === true || current.available !== true || current.baselineVerified !== true
    || current.doorFront === true || current.doorRear === true || evInputs(current).some(ev => ev.kw > .1 || ev.active > 0);
  if (current.managedPause || current.recovering || current.available === false) reference.lastPauseAt = current.at;
  if (disturbance) { reference.availableSince = null; reference.settledC = current.rearC; return; }
  if (reference.availableSince === null) reference.availableSince = current.at;
  const stableHours = (current.at - reference.availableSince) / HOUR;
  reference.settledC = finite(reference.settledC)
    ? current.rearC + (reference.settledC - current.rearC) * Math.exp(-hours / 2) : current.rearC;
  const trend = Math.abs(current.rearC - reference.settledC) / 2;
  if (!allowFit || stableHours < 8 || trend > .25) return;
  const prediction = normalGarageTemperature(model, current.outdoorC);
  // First baseline can be learned from achieved native warmth. Once established,
  // cold post-control periods never lower it; changed baselines require a new seed.
  if (reference.initialized && current.rearC < prediction - .5) return;
  const weight = reference.initialized ? 1 - Math.exp(-hours / 80) : hours / (reference.qualifiedHours + hours);
  reference.interceptC = clamp(reference.interceptC + weight * (current.rearC - prediction), 3, config.baselineC + 3);
  reference.outdoorC = current.outdoorC; reference.samples++; reference.qualifiedHours += hours;
  reference.initialized = reference.qualifiedHours >= 2;
}

/** Ordered immutable journal update. Duplicate source times are not new training;
 * repeated equal values with newer genuine source times are valid evidence. */
export function updateGarageModel(previous, observation, settings = {}) {
  const config = garageSettings(settings);
  const model = clone(previous ?? createGarageModel({ seedAt: observation?.at, baselineC: config.baselineC }));
  if (model.algorithm !== GARAGE_ALGORITHM_VERSION) throw new Error('Unsupported garage model algorithm; preserve archive and start an explicit seed');
  if (!finite(observation?.at)) throw new Error('Garage learning requires numeric UTC time');
  if (finite(model.at) && observation.at <= model.at) return model;
  const current = clone(observation), last = model.previous;
  model.at = current.at; model.updates++;
  if (current.sourceEpoch != null && model.sourceEpoch !== null && current.sourceEpoch !== model.sourceEpoch) {
    // Adapter boot identity is part of this source epoch. A reboot interrupts
    // interval continuity, not the building's accumulated thermal memory.
    // Explicit sensor corrections reset the model through journal context.
    model.previous = null; model.state = { rearC: null, frontC: null, coreC: model.state.coreC, differenceC: null };
    model.normalReference.availableSince = null;
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
  const prior = model.previous && last;
  const hours = prior ? (rearAt - (prior.rearAt ?? prior.at)) / HOUR : 0;
  const newRear = !prior || rearAt > (prior.rearAt ?? prior.at);
  if (!newRear) {
    if (frontFresh) { model.state.frontC = current.frontC; model.state.differenceC = current.frontC - current.rearC; }
    model.lastError = 'no-new-rear-observation'; return model;
  }
  if (!validC(model.state.coreC)) model.state.coreC = current.rearC;
  const supported = prior && hours >= 1 / 120 && hours <= 2 && validC(prior.outdoorC) && validC(current.outdoorC)
    && current.rearGap !== true && prior.rearGap !== true;
  if (supported) {
    const state = { rearC: prior.rearC, frontC: prior.frontC, coreC: model.state.coreC,
      differenceC: validC(prior.frontC) ? prior.frontC - prior.rearC : model.state.differenceC ?? -.25 };
    const source = { ...prior, outdoorC: (prior.outdoorC + current.outdoorC) / 2 };
    const conditional = predictGarageStep(model, state, source, hours, { conditional: true });
    // Advance prediction uses only the preceding observation and coefficients.
    const advance = predictGarageStep(model, state, prior, hours);
    const actualPower = qualifiedPower(prior), actualActivity = activity(prior);
    const inputKnown = prior.available === false || actualPower || actualActivity !== null;
    const frontKnown = validC(prior.frontC) && frontFresh && frontAt > (prior.frontAt ?? prior.at) && current.frontGap !== true
      && Math.abs(frontAt - rearAt) <= 5 * 60_000 && Math.abs((prior.frontAt ?? prior.at) - (prior.rearAt ?? prior.at)) <= 5 * 60_000;
    const power = prior.available === false ? 0 : actualPower ? prior.powerKw : 0;
    const active = prior.available === false || actualPower ? 0 : actualActivity ?? 0;
    const frontDisturbance = current.doorFront === true || prior.doorFront === true
      || frontKnown && Math.abs((current.frontC - current.rearC) - state.differenceC) > 1;
    const rearDisturbance = current.doorRear === true || prior.doorRear === true || Math.abs(current.rearC - prior.rearC) > 2;
    const vehicles = evInputs(prior), evActive = vehicles.some(ev => ev.kw > .1 || ev.active > 0);
    const episode = advanceGarageValidation(model, { state, prior, current, hours, frontKnown,
      disturbed: frontDisturbance || rearDisturbance || evActive, metered: actualPower, predict: predictGarageStep });
    // A physical episode takes precedence over the ordinary daily partition.
    const heldOut = episode.role ? episode.role === 'validation' : ((prior.at - model.seedAt) / HOUR % 24 + 24) % 24 >= 18;
    if (heldOut) {
      if (inputKnown) recordError(model.heldOut.rear, current.rearC - conditional.rearC, hours);
      recordError(model.heldOut.advanceRear, current.rearC - (episode.forecast ?? advance).rearC, hours);
      if (prior.available === false) recordError(model.heldOut.offRear, current.rearC - (episode.forecast ?? advance).rearC, hours);
      if (frontKnown) {
        if (inputKnown) recordError(model.heldOut.front, current.frontC - conditional.frontC, hours);
        recordError(model.heldOut.advanceFront, current.frontC - (episode.forecast ?? advance).frontC, hours);
        if (prior.available === false) recordError(model.heldOut.offFront, current.frontC - (episode.forecast ?? advance).frontC, hours);
      }
      if (actualPower && prior.available === true)
        recordError(model.heldOut.native, prior.powerKw - predictGarageNative(model, state, prior).powerKw, hours);
    }
    if (!heldOut && inputKnown && !rearDisturbance) {
      model.trainedIntervals++;
      if (prior.available === false) { model.evidence.offIntervals++; model.evidence.offHours += hours; }
      if (actualPower) { model.evidence.powerIntervals++; model.evidence.powerHours += hours; }
      else if (actualActivity !== null) { model.evidence.activityIntervals++; model.evidence.activityHours += hours; }
      vehicles.forEach((ev, i) => {
        if (ev.kind === 'power' && ev.kw > .1) model.evidence.ev[i].powerIntervals++;
        if (ev.kind === 'activity' && ev.active) model.evidence.ev[i].activityIntervals++;
        const other = vehicles[1 - i];
        if ((ev.kw > .1 || ev.active > 0) && other.known && other.kw === 0 && other.active === 0
          && !frontDisturbance) model.evidence.ev[i].independentIntervals++;
      });
      // Average endpoint temperatures approximate interval-integrated features;
      // regression uses rates weighted by elapsed hours, independent of poll count.
      const midpoint = { rearC: (prior.rearC + current.rearC) / 2,
        coreC: (state.coreC + conditional.coreC) / 2,
        differenceC: frontKnown ? (state.differenceC + current.frontC - current.rearC) / 2 : state.differenceC };
      const x = features(midpoint, source, power, active);
      // EV response remains a shared prior; charging intervals cannot silently
      // teach their unknown heat contribution as insulation or pump efficiency.
      if (!evActive) {
        fitGarageRegression(model.rear, REAR, x.rear, (current.rearC - prior.rearC) / hours, hours, episode.regime, 'rear');
        if (frontKnown && !frontDisturbance) fitGarageRegression(model.front, FRONT, x.front,
          ((current.frontC - current.rearC) - state.differenceC) / hours, hours, episode.regime, 'front');
      }
      // Fit the same native thermostat envelope used for forecasting. Baseline
      // and weather learn near normal operation; fixed recovery priors are tested
      // separately by full episode energy, never absorbed into the intercept.
      const demand = normalGarageTemperature(model, prior.outdoorC) - state.rearC;
      const throttle = clamp((demand + .65) / .65, 0, 1);
      if (!actualPower && actualActivity !== null && prior.available === true && model.normalReference.initialized
        && !evActive && !frontDisturbance && episode.regime === 'normal' && Math.abs(demand) <= .65 && throttle >= .2) {
        const duty = model.nativeActivity;
        const adjustedActivity = clamp(actualActivity / throttle - .015 * Math.max(0, -prior.outdoorC) - .45 * Math.max(0, demand), 0, 1);
        const weight = duty.hours < 2 ? hours / (duty.hours + hours) : 1 - Math.exp(-hours / 48);
        duty.mean += weight * (adjustedActivity - duty.mean); duty.hours += hours; duty.samples++;
      }
      if (actualPower && prior.available === true && model.normalReference.initialized && !evActive && !frontDisturbance
        && throttle >= .2 && (episode.regime === 'recovery' || Math.abs(demand) <= .65)) {
        const trainingRecoveries = model.validation.episodes.filter(e => e.role === 'training' && e.complete && e.clean).length;
        fitGarageRegression(model.native, NATIVE, nativeFeatures(model, state, prior).map(v => v * throttle),
          prior.powerKw, hours, episode.regime === 'recovery' ? 'recovery' : 'normal', 'native',
          { allowDemand: trainingRecoveries >= 2 });
      }
    }
    if (!frontKnown) model.evidence.rearOnlyIntervals++;
    if (inputKnown) {
      model.state.coreC = conditional.coreC;
      // Local front plunges never overwrite the slow rear-derived state. Sustained
      // rear cooling gradually corrects memory if the predicted rebound fails.
      const residual = clamp(current.rearC - conditional.rearC, -1, 1);
      model.state.coreC += residual * Math.min(.12, hours / 12);
    } else {
      // Imported rear-only history often has no garage actuator record. Observe
      // memory from the real rear path instead of inventing native heating input.
      const meanRear = (prior.rearC + current.rearC) / 2;
      model.state.coreC = meanRear + (model.state.coreC - meanRear) * Math.exp(-hours / MEMORY_TIME_HOURS);
    }
    learnReference(model, current, prior, hours, config, !heldOut);
  } else if (prior) { model.normalReference.availableSince = null; interruptGarageValidation(model, 'gapped-observation'); }
  model.state.rearC = current.rearC; model.state.frontC = frontFresh ? current.frontC : null;
  model.state.differenceC = frontFresh ? current.frontC - current.rearC : model.state.differenceC;
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
/** Plans are explicitly time-bounded and known at decision time. Unknown or
 * cancelled future charging contributes no warmth; actual future fields ignored. */
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
    const next = predictGarageStep(model, state, { outdoorC: step.outdoorC, available: step.available !== false,
      restart: step.restart === true, ...ev }, (end - start) / HOUR);
    state = next.state; electricityKwh += next.electricityKwh; uncertaintyKwh += next.uncertaintyKwh;
    if (finite(step.priceCtPerKwh)) costEur += next.electricityKwh * step.priceCtPerKwh / 100;
    const horizonHours = (end - now) / HOUR;
    const margins = garagePlanningMargins(summary, horizonHours);
    const rearMargin = margins.rearC, frontMargin = margins.frontC;
    points.push({ start, end, outdoorC: step.outdoorC, available: step.available !== false, priceCtPerKwh: step.priceCtPerKwh, at: end, ...next, rearLowerC: next.rearC - rearMargin, frontLowerC: next.frontC - frontMargin });
    cursor = end;
  }
  return { points, state, electricityKwh, costEur, uncertaintyKwh,
    basis: 'advance-forecast-no-future-actual-inputs', algorithm: model.algorithm };
}
export function garageModelSummary(model) {
  if (!model || model.algorithm !== GARAGE_ALGORITHM_VERSION) return { algorithm: model?.algorithm ?? GARAGE_ALGORITHM_VERSION, status: 'unavailable' };
  const heldOut = Object.fromEntries(Object.entries(model.heldOut).map(([key, value]) => [key, errors(value)]));
  const coefficients = (specs, reg) => specs.map((spec, i) => ({ name: spec[0], value: reg.values[i], unit: spec[4],
    basis: reg.active[i] ? 'fitted-effective-response' : reg.fitted[i] ? 'retained-effective-response' : 'fixed-prior', evidence: reg.evidence[i], evidenceUnit: 'hours' }));
  const validation = summarizeGarageValidation(model);
  const thermalReady = model.normalReference.initialized && model.rear.active[0] && model.front.active[1]
    && validation.supportedOffHours > 0;
  const electricalReady = model.native.active[0] && model.native.hours >= 6 && heldOut.native.hours >= 2
    && heldOut.native.rmse < .35 && validation.recoveryEpisodes >= 1;
  return { algorithm: model.algorithm, status: thermalReady ? 'validated-provisional' : 'learning', ready: thermalReady,
    thermalReady, electricalReady, nativeActivity: { ...model.nativeActivity, basis: model.nativeActivity.hours >= 2 ? 'learned-dimensionless-activity' : 'prior-activity-response' }, maxPauseHours: thermalReady ? validation.supportedOffHours : 0, validation,
    trainedIntervals: model.trainedIntervals, heldOut, coefficients: { rear: coefficients(REAR, model.rear),
      front: coefficients(FRONT, model.front), native: coefficients(NATIVE, model.native) }, state: clone(model.state),
    structure: { memoryTimeHours: MEMORY_TIME_HOURS },
    normalReference: { rearC: normalGarageTemperature(model, model.normalReference.outdoorC), outdoorC: model.normalReference.outdoorC,
      initialized: model.normalReference.initialized, outdoorSlope: model.normalReference.outdoorSlope,
      basis: model.normalReference.initialized ? 'continuously-available-achieved-reference' : 'prior-near-pipe-reference',
      samples: model.normalReference.samples, qualifiedHours: model.normalReference.qualifiedHours },
    ev: { chargers: model.evidence.ev.map((e, i) => ({ id: i + 1, ...e, basis: 'shared-prior-limited-evidence' })) },
    limitations: ['Estimated thermal memory is not measured pipe or building-mass temperature.',
      'Whole-episode validation uses preceding observed ambient weather, with no future actual heating or temperature correction.',
      'Pause duration is limited by distinct completed training and later validation episodes.',
      ...(!electricalReady ? ['Electricity or recovery response remains unqualified for economic dispatch.'] : []),
      'Memory, front distribution, restart and EV effects retain fixed priors; demand response requires independent recovery episodes.'] };
}
