import { GARAGE_MODEL_ASSUMPTIONS, garageRecoveryHours } from './model-assumptions.js';
const metric = () => ({ hours: 0, square: 0, signed: 0, maximum: 0 });
function add(metric, residual, hours) {
  metric.hours += hours; metric.square += residual ** 2 * hours; metric.signed += residual * hours;
  metric.maximum = Math.max(metric.maximum, Math.abs(residual));
}
const rmse = metric => metric.hours ? Math.sqrt(metric.square / metric.hours) : null;
const bias = metric => metric.hours ? metric.signed / metric.hours : null;
const secondLargest = values => [...values].sort((a, b) => b - a)[1] ?? 0;
export function createGarageValidation() { return { nextId: 0, active: null, episodes: [], previousAvailable: null }; }
function freezeModel(model) {
  return { algorithm: model.algorithm, rear: { values: [...model.rear.values], active: [...model.rear.active], evidence: [...model.rear.evidence] }, front: { values: [...model.front.values] },
    native: { values: [model.native.active[0] ? model.native.values[0] : .5], samples: model.native.samples, hours: model.native.hours, active: [...model.native.active] },
    evidence: { powerIntervals: model.evidence.powerIntervals, activityIntervals: model.evidence.activityIntervals,
      powerHours: model.evidence.powerHours, activityHours: model.evidence.activityHours },
    nativeActivity: { ...model.nativeActivity }, normalReference: { ...model.normalReference }, heldOut: structuredClone(model.heldOut) };
}
export function interruptGarageValidation(model, reason) {
  if (model.validation.active) {
    model.validation.active.clean = false;
    model.validation.active.reason = reason;
  }
}
/** Each OFF and ensuing recovery belongs entirely to one temporal partition.
 * The held-out state and coefficients are frozen once; subsequent temperatures
 * never correct that forecast. Weather is the preceding observed ambient input,
 * so these validate plant response, not archived weather-forecast accuracy. */
export function advanceGarageValidation(model, { state, prior, current, hours, frontKnown, disturbed, metered, predict }) {
  const validation = model.validation;
  if (!validation.active && prior.available === false && validation.previousAvailable !== false) {
    const id = validation.nextId++;
    // An irrational rotation avoids assigning every fixed-length recurring
    // schedule (for example alternating short/long pauses) to the same side.
    validation.active = { id, role: Math.floor((id + 1) * .38196601125) > Math.floor(id * .38196601125) ? 'validation' : 'training', startedAt: prior.at,
      offEndedAt: null, offHours: 0, recoveryHours: 0, clean: frontKnown, metered: true,
      initialRearC: state.rearC, initialFrontC: state.frontC, initialOutdoorC: prior.outdoorC,
      minimumRearC: state.rearC, minimumFrontC: state.frontC, rearDropC: 0, frontDropC: 0,
      forecast: freezeModel(model), state: { ...state }, observedKwh: 0, predictedKwh: 0, recoveryAllowanceKwh: 0, recoveryAccountedKwh: 0,
      trainingSupportHours: secondLargest(validation.episodes.filter(e => e.role === 'training' && e.complete && e.clean).map(e => e.offHours)),
      rear: metric(), front: metric(), offRear: metric(), offFront: metric() };
  }
  const episode = validation.active;
  validation.previousAvailable = prior.available;
  if (!episode) return { role: null, regime: prior.available === false ? 'off' : 'normal', forecast: null };
  const role = episode.role, regime = prior.available === false ? 'off' : 'recovery';
  if (prior.available !== false && prior.available !== true || !frontKnown || disturbed) episode.clean = false;
  const restart = episode.offEndedAt === null && prior.available === true;
  if (prior.available === false) {
    if (episode.offEndedAt !== null) {
      // A new shutdown before the previous recovery is a single incomplete
      // compound event, never another independent learning opportunity.
      episode.clean = false;
    }
    episode.offHours += hours;
  } else {
    episode.offEndedAt ??= prior.at;
    episode.recoveryHours += hours;
  }
  const forecast = predict(episode.forecast, episode.state,
    { outdoorC: prior.outdoorC, available: prior.available, restart, ev1Kw: 0, ev2Kw: 0 }, hours);
  episode.state = forecast.state;
  episode.predictedKwh += forecast.electricityKwh;
  if (prior.available === false) episode.recoveryAllowanceKwh += episode.forecast.native.values[0] * hours * GARAGE_MODEL_ASSUMPTIONS.recoveryEnergyFactor;
  else {
    const repayment = Math.min(Math.max(0, episode.recoveryAllowanceKwh - episode.recoveryAccountedKwh),
      episode.recoveryAllowanceKwh * hours / garageRecoveryHours(episode.offHours));
    episode.predictedKwh += repayment; episode.recoveryAccountedKwh += repayment;
  }
  if (metered) episode.observedKwh += prior.powerKw * hours;
  else if (prior.available === true) episode.metered = false;
  add(episode.rear, current.rearC - forecast.rearC, hours);
  if (frontKnown) add(episode.front, current.frontC - forecast.frontC, hours);
  if (prior.available === false) {
    add(episode.offRear, current.rearC - forecast.rearC, hours);
    if (frontKnown) add(episode.offFront, current.frontC - forecast.frontC, hours);
  }
  episode.minimumRearC = Math.min(episode.minimumRearC, current.rearC);
  if (frontKnown) episode.minimumFrontC = Math.min(episode.minimumFrontC, current.frontC);
  // Absolute 0.2/0.3C allowances alone call a short pause 'recovered' even
  // before any warmth returns. Require at least 75% of its observed cooling
  // to return, with a 0.05C floor for ordinary sensor resolution.
  // Require the measured pre-pause temperatures. An assumed recovery envelope
  // or changed thermostat setting cannot declare measured recovery complete.
  episode.rearDropC = Math.max(episode.rearDropC, episode.initialRearC - current.rearC);
  if (frontKnown) episode.frontDropC = Math.max(episode.frontDropC, episode.initialFrontC - current.frontC);
  const rearTolerance = Math.min(.2, Math.max(.05, .25 * episode.rearDropC));
  const frontTolerance = Math.min(.3, Math.max(.05, .25 * episode.frontDropC));
  const requiredRecoveryHours = garageRecoveryHours(episode.offHours);
  const recovered = prior.available === true && episode.recoveryHours + 1e-9 >= requiredRecoveryHours
    && current.rearC + 1e-9 >= episode.initialRearC - rearTolerance
      && frontKnown && current.frontC + 1e-9 >= episode.initialFrontC - frontTolerance;
  // A long, continuously observed OFF interval stays one frozen experiment.
  // Only observed normal heating can exhaust the reporting recovery window;
  // no learning timeout imposes a maximum pause or requests restoration.
  const expired = prior.available === true && episode.recoveryHours + 1e-9 >= Math.max(12, requiredRecoveryHours);
  if (recovered || expired) {
    const rearRmse = rmse(episode.rear), frontRmse = rmse(episode.front);
    const offRearRmse = rmse(episode.offRear), offFrontRmse = rmse(episode.offFront);
    const thermalPassed = recovered && episode.clean && offRearRmse <= .6 && offFrontRmse <= .9
      && episode.offRear.maximum <= 1.5 && episode.offFront.maximum <= 2;
    const electricalPassed = thermalPassed && episode.metered && episode.observedKwh > .05
      && Math.abs(episode.predictedKwh - episode.observedKwh) <= Math.max(.12, .35 * episode.observedKwh);
    validation.episodes.push({ id: episode.id, role, startedAt: episode.startedAt, endedAt: current.at,
      offHours: episode.offHours, recoveryHours: episode.recoveryHours, complete: recovered, clean: episode.clean,
      minimumRearC: episode.minimumRearC, minimumFrontC: episode.minimumFrontC,
      metered: episode.metered, thermalPassed, electricalPassed, trainingSupportHours: episode.trainingSupportHours,
      rearRmse, frontRmse, rearBias: bias(episode.rear), frontBias: bias(episode.front), offRearRmse, offFrontRmse,
      rearMaximum: episode.rear.maximum, frontMaximum: episode.front.maximum,
      observedKwh: episode.observedKwh, predictedKwh: episode.predictedKwh });
    validation.episodes = validation.episodes.slice(-24);
    validation.active = null;
  }
  return { role, regime, forecast };
}
export function summarizeGarageValidation(model) {
  const completed = model.validation.episodes.filter(e => e.complete && e.clean);
  const training = completed.filter(e => e.role === 'training');
  const failed = model.validation.episodes.filter(e => e.role === 'validation' && e.clean && !e.thermalPassed).at(-1)?.id ?? -1;
  const validation = completed.filter(e => e.id > failed && e.role === 'validation' && e.thermalPassed && e.trainingSupportHours > 0);
  const holdouts = model.validation.episodes.filter(e => e.role === 'validation' && e.clean);
  const mean = field => holdouts.length ? holdouts.reduce((sum, e) => sum + e[field], 0) / holdouts.length : null;
  const rms = field => holdouts.length ? Math.sqrt(holdouts.reduce((sum, e) => sum + e[field] ** 2, 0) / holdouts.length) : null;
  const trainingDurations = training.map(e => e.offHours), validationDurations = validation.map(e => Math.min(e.offHours, e.trainingSupportHours));
  const supportedOffHours = Math.min(secondLargest(trainingDurations), Math.max(0, ...validationDurations));
  const active = model.validation.active;
  return { completedEpisodes: completed.length, trainingEpisodes: training.length, validationEpisodes: validation.length,
    trainingDurations, validationDurations, completedDurations: completed.map(e => e.offHours), supportedOffHours,
    recoveryEpisodes: validation.filter(e => e.electricalPassed && e.id > (model.validation.episodes.filter(row => row.role === 'validation' && row.clean && row.metered && !row.electricalPassed).at(-1)?.id ?? -1)).length,
    rearRmse: rms('rearRmse'), frontRmse: rms('frontRmse'), rearBias: mean('rearBias'), frontBias: mean('frontBias'),
    offRearRmse: rms('offRearRmse'), offFrontRmse: rms('offFrontRmse'),
    horizonHours: holdouts.length ? Math.max(...holdouts.map(e => e.offHours + e.recoveryHours)) : 0,
    active: active ? { id: active.id, role: active.role, startedAt: active.startedAt,
      phase: active.offEndedAt === null ? 'off' : 'recovery', offHours: active.offHours, recoveryHours: active.recoveryHours } : null,
    basis: 'whole-off-recovery-episodes-frozen-model-observed-ambient-no-future-actual-heating' };
}
