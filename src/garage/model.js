import { garageSettings } from './settings.js';
const HOUR = 3_600_000, finite = Number.isFinite;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const clone = value => structuredClone(value);
export const GARAGE_ALGORITHM_VERSION = 'committed-garage-v1-coupled';
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
const regression = specs => ({ values: specs.map(x => x[1]), covariance: specs.map((_, i) => specs.map((__, j) => i === j ? .5 : 0)),
  evidence: specs.map(() => 0), samples: 0 });
const errorState = () => ({ n: 0, absolute: 0, square: 0, signed: 0 });
function recordError(metrics, residual) { if (finite(residual)) { metrics.n++; metrics.absolute += Math.abs(residual); metrics.square += residual ** 2; metrics.signed += residual; } }
function errors(metrics) { return { n: metrics.n, mae: metrics.n ? metrics.absolute / metrics.n : null,
  rmse: metrics.n ? Math.sqrt(metrics.square / metrics.n) : null, bias: metrics.n ? metrics.signed / metrics.n : null }; }
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
function fit(reg, specs, features, outcome, weight = 1) {
  // Projected recursive ridge fit. Parameters and covariance remain bounded; no
  // retained telemetry window is needed. Fixed forgetting is part of version 1.
  if (!finite(outcome) || weight <= 0) return;
  const x = features.map(v => v * Math.sqrt(weight)), y = outcome * Math.sqrt(weight), p = reg.covariance;
  const px = p.map(row => dot(row, x)), denominator = .998 + dot(x, px), residual = clamp(y - dot(reg.values, x), -2, 2);
  const gain = px.map(v => v / denominator);
  reg.values = reg.values.map((value, i) => clamp(value + gain[i] * residual, specs[i][2], specs[i][3]));
  reg.covariance = p.map((row, i) => row.map((value, j) => clamp((value - gain[i] * px[j]) / .998, -100, 100)));
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > .005) reg.evidence[i]++;
  reg.samples++;
}
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
    state: { rearC: null, frontC: null, coreC: null, differenceC: null }, previous: null,
    normalReference: { interceptC: baselineC, outdoorSlope: .03, baselineC, samples: 0,
      availableSince: null, lastPauseAt: null, initialized: false, outdoorC: 0 },
    heldOut: Object.fromEntries(['rear', 'front', 'native', 'advanceRear', 'advanceFront', 'offRear', 'offFront'].map(key => [key, errorState()])),
    evidence: { offIntervals: 0, powerIntervals: 0, activityIntervals: 0, rearOnlyIntervals: 0,
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
  return { powerKw, activity: clamp(powerKw / .8, 0, 1),
    basis: model.native.samples >= 24 ? 'learned-native-electrical-response' : 'prior-modeled-electricity',
    uncertaintyKw: Math.max(nativeError ?? .3, model.native.samples >= 24 ? .08 : .25) };
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
    const preferActivity = !actualPower && model.evidence.powerIntervals < 12 && model.evidence.activityIntervals >= 12;
    const off = input.available === false;
    const heatPower = off ? 0 : actualPower ? kw : actualActivity !== null || preferActivity ? 0 : kw;
    const heatActivity = off ? 0 : actualPower ? 0 : actualActivity ?? (preferActivity ? native.activity : 0);
    const x = features(next, input, heatPower, heatActivity);
    const rearRate = dot(model.rear.values, x.rear), differenceRate = dot(model.front.values, x.front);
    // The 18h state is estimated building memory, not pipe temperature or kWh.
    const memoryRate = (next.rearC - next.coreC) / 18;
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
function learnReference(model, current, previous, hours, config) {
  const reference = model.normalReference;
  const disturbance = current.managedPause === true || current.recovering === true || current.available !== true || current.baselineVerified !== true
    || current.doorFront === true || current.doorRear === true || evInputs(current).some(ev => ev.kw > .1 || ev.active > 0);
  if (current.managedPause || current.recovering || current.available === false) reference.lastPauseAt = current.at;
  if (disturbance) { reference.availableSince = null; return; }
  if (reference.availableSince === null) reference.availableSince = current.at;
  const stableHours = (current.at - reference.availableSince) / HOUR;
  const delta = Math.abs(current.rearC - previous.rearC) / Math.max(hours, .02);
  if (stableHours < 8 || delta > .15 || (finite(reference.lastPauseAt) && current.at - reference.lastPauseAt < 48 * HOUR)) return;
  const prediction = normalGarageTemperature(model, current.outdoorC);
  // First baseline can be learned from achieved native warmth. Once established,
  // cold post-control periods never lower it; changed baselines require a new seed.
  if (reference.initialized && current.rearC < prediction - .5) return;
  const weight = reference.initialized ? .003 : 1 / (reference.samples + 1);
  reference.interceptC = clamp(reference.interceptC + weight * (current.rearC - prediction), 3, config.baselineC + 3);
  reference.outdoorC = current.outdoorC; reference.samples++;
  reference.initialized = reference.samples >= 12;
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
    model.previous = null; model.state = { rearC: null, frontC: null, coreC: null, differenceC: null };
    model.normalReference.availableSince = null;
  }
  model.sourceEpoch = current.sourceEpoch ?? model.sourceEpoch;
  const rearAt = current.rearAt ?? current.at, frontAt = current.frontAt ?? current.at;
  const rearFresh = validC(current.rearC) && current.rearUsable !== false && current.rearRetained !== true
    && finite(rearAt) && rearAt <= current.at && current.at - rearAt <= config.maxSensorAgeMs;
  const frontFresh = validC(current.frontC) && current.frontUsable !== false && current.frontRetained !== true
    && finite(frontAt) && frontAt <= current.at && current.at - frontAt <= config.maxSensorAgeMs;
  if (!rearFresh) { model.previous = null; model.lastError = 'rear-input-unavailable'; return model; }
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
    const heldOut = ((prior.at - model.seedAt) / HOUR % 24 + 24) % 24 >= 18;
    const frontKnown = validC(prior.frontC) && frontFresh && frontAt > (prior.frontAt ?? prior.at) && current.frontGap !== true
      && Math.abs(frontAt - rearAt) <= 5 * 60_000 && Math.abs((prior.frontAt ?? prior.at) - (prior.rearAt ?? prior.at)) <= 5 * 60_000;
    if (heldOut) {
      if (inputKnown) recordError(model.heldOut.rear, current.rearC - conditional.rearC);
      recordError(model.heldOut.advanceRear, current.rearC - advance.rearC);
      if (prior.available === false) recordError(model.heldOut.offRear, current.rearC - advance.rearC);
      if (frontKnown) {
        if (inputKnown) recordError(model.heldOut.front, current.frontC - conditional.frontC);
        recordError(model.heldOut.advanceFront, current.frontC - advance.frontC);
        if (prior.available === false) recordError(model.heldOut.offFront, current.frontC - advance.frontC);
      }
      if (qualifiedPower(prior) && prior.available === true)
        recordError(model.heldOut.native, prior.powerKw - predictGarageNative(model, state, prior).powerKw);
    }
    const power = prior.available === false ? 0 : actualPower ? prior.powerKw : 0;
    const active = prior.available === false || actualPower ? 0 : actualActivity ?? 0;
    const x = features(state, source, power, active);
    const frontDisturbance = current.doorFront === true || prior.doorFront === true
      || frontKnown && Math.abs((current.frontC - current.rearC) - state.differenceC) > 1;
    const rearDisturbance = current.doorRear === true || prior.doorRear === true || Math.abs(current.rearC - prior.rearC) > 2;
    if (!heldOut && inputKnown && !rearDisturbance) {
      fit(model.rear, REAR, x.rear.map(v => v * hours), current.rearC - prior.rearC);
      if (frontKnown) fit(model.front, FRONT, x.front.map(v => v * hours),
        (current.frontC - current.rearC) - state.differenceC, frontDisturbance ? .05 : 1);
      model.trainedIntervals++;
      if (prior.available === false) model.evidence.offIntervals++;
      if (actualPower) model.evidence.powerIntervals++; else if (actualActivity !== null) model.evidence.activityIntervals++;
      const vehicles = evInputs(prior);
      vehicles.forEach((ev, i) => {
        if (ev.kind === 'power' && ev.kw > .1) model.evidence.ev[i].powerIntervals++;
        if (ev.kind === 'activity' && ev.active) model.evidence.ev[i].activityIntervals++;
        const other = vehicles[1 - i];
        if ((ev.kw > .1 || ev.active > 0) && other.known && other.kw === 0 && other.active === 0
          && !frontDisturbance && !rearDisturbance) model.evidence.ev[i].independentIntervals++;
      });
      if (!model.evidence.ev.every(ev => ev.independentIntervals >= 24)) {
        for (const index of [4, 6]) {
          const shared = (model.rear.values[index] + model.rear.values[index + 1]) / 2;
          model.rear.values[index] = shared; model.rear.values[index + 1] = shared;
          model.front.values[index] = 0; model.front.values[index + 1] = 0;
        }
      }
      // Electrical demand is separately learned, not made an observed future input.
      if (actualPower && prior.available === true && !frontDisturbance)
        fit(model.native, NATIVE, nativeFeatures(model, state, prior), prior.powerKw);
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
      model.state.coreC = meanRear + (model.state.coreC - meanRear) * Math.exp(-hours / 18);
    }
    if (!heldOut) learnReference(model, current, prior, hours, config);
  }
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
  const points = [];
  for (const step of steps) {
    const start = step.start ?? cursor, end = step.end ?? step.at;
    if (!finite(start) || !finite(end) || start !== cursor || end <= start || end - start > 4 * HOUR) throw new Error('Garage forecast steps must be contiguous bounded UTC intervals');
    const ev = protection ? { ev1Kw: 0, ev2Kw: 0 } : knownGarageEvAt(knownEvPlans, start, now);
    const next = predictGarageStep(model, state, { outdoorC: step.outdoorC, available: step.available !== false,
      restart: step.restart === true, ...ev }, (end - start) / HOUR);
    state = next.state; electricityKwh += next.electricityKwh; uncertaintyKwh += next.uncertaintyKwh;
    if (finite(step.priceCtPerKwh)) costEur += next.electricityKwh * step.priceCtPerKwh / 100;
    const horizonHours = (end - now) / HOUR;
    const rearMargin = next.rearUncertaintyC * Math.sqrt(Math.max(1, horizonHours / ((end - start) / HOUR)));
    const frontMargin = next.frontUncertaintyC * Math.sqrt(Math.max(1, horizonHours / ((end - start) / HOUR)));
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
    basis: reg.evidence[i] >= 24 ? 'fitted-effective-response' : reg.evidence[i] ? 'retained-with-limited-evidence' : 'prior', evidence: reg.evidence[i] }));
  const ready = model.normalReference.initialized && model.rear.samples >= 24 && model.front.samples >= 12 && model.evidence.offIntervals >= 6
    && heldOut.rear.n >= 6 && heldOut.front.n >= 6 && heldOut.offRear.n >= 3 && heldOut.offFront.n >= 3
    && heldOut.offRear.rmse < .8 && heldOut.offFront.rmse < 1.2 && heldOut.advanceRear.rmse < .8 && heldOut.advanceFront.rmse < 1.2;
  return { algorithm: model.algorithm, status: ready ? 'validated-provisional' : 'learning', ready,
    trainedIntervals: model.trainedIntervals, heldOut, coefficients: { rear: coefficients(REAR, model.rear),
      front: coefficients(FRONT, model.front), native: coefficients(NATIVE, model.native) }, state: clone(model.state),
    normalReference: { rearC: normalGarageTemperature(model, model.normalReference.outdoorC), outdoorC: model.normalReference.outdoorC,
      basis: model.normalReference.initialized ? 'continuously-available-achieved-reference' : 'prior-near-pipe-reference', samples: model.normalReference.samples },
    ev: { chargers: model.evidence.ev.map((e, i) => ({ id: i + 1, ...e,
      basis: model.evidence.ev.every(ev => ev.independentIntervals >= 24) ? 'independently-observed-effective-response'
        : e.powerIntervals >= 24 || e.activityIntervals >= 24 ? 'shared-effective-response' : 'shared-prior-limited-evidence' })) },
    limitations: ['Estimated thermal memory is not measured pipe or building-mass temperature.',
      'Validation is temporally held-out one-step prediction, not a pipe-safety guarantee.',
      ...(model.native.samples < 24 ? ['Electricity response remains an explicitly modeled prior.'] : []),
      'Solar is excluded until a versioned held-out improvement is demonstrated.'] };
}
