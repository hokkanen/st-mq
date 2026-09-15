import { garageSettings, GARAGE_POLICY_VERSION, GARAGE_HEAT_TRANSFER_SAFETY_FACTOR } from './settings.js';
import { GARAGE_TEMPERATURE_MAX_AGE_MS } from './permission.js';
export { GARAGE_HEAT_TRANSFER_SAFETY_FACTOR } from './settings.js';

const MINUTE = 60_000, finite = Number.isFinite, locations = ['rear', 'front'];
const MIN_AIR_C = -40, MAX_AIR_C = 65, EPSILON_J = 1e-7;
const copy = value => structuredClone(value);
const validC = value => finite(value) && value >= MIN_AIR_C && value <= MAX_AIR_C;
const policyKeys = ['marginC', 'pipeOutsideDiameterMm', 'pipeWallMm', 'heatTransferWPerM2K'];
const sensorAge = config => Math.min(config.maxSensorAgeMs, GARAGE_TEMPERATURE_MAX_AGE_MS);

/** Material inventory per metre. The fixed uncertainty factor applies to the
 * selected conductance; it does not describe an intrinsic copper asymmetry. */
export function reserveProperties(settings = {}) {
  const policy = garageSettings(settings).protection;
  const outside = policy.pipeOutsideDiameterMm / 2000, inside = outside - policy.pipeWallMm / 1000;
  const waterKgPerM = Math.PI * inside ** 2 * 1000;
  const copperKgPerM = Math.PI * (outside ** 2 - inside ** 2) * 8960;
  const capacityJPerMK = waterKgPerM * 4180 + copperKgPerM * 385;
  const iceCapacityJPerMK = waterKgPerM * 2090 + copperKgPerM * 385;
  const areaM2PerM = 2 * Math.PI * outside;
  const nominalConductanceWPerMK = areaM2PerM * policy.heatTransferWPerM2K;
  const coolingConductanceWPerMK = nominalConductanceWPerMK * GARAGE_HEAT_TRANSFER_SAFETY_FACTOR;
  const warmingConductanceWPerMK = nominalConductanceWPerMK / GARAGE_HEAT_TRANSFER_SAFETY_FACTOR;
  return { waterKgPerM, copperKgPerM, capacityJPerMK, iceCapacityJPerMK, areaM2PerM,
    latentJPerM: waterKgPerM * 333_550, nominalConductanceWPerMK,
    coolingConductanceWPerMK, warmingConductanceWPerMK,
    coolingTimeConstantMinutes: capacityJPerMK / coolingConductanceWPerMK / 60,
    warmingTimeConstantMinutes: capacityJPerMK / warmingConductanceWPerMK / 60 };
}

// Energy is relative to liquid water at zero. Latent heat is exclusively debt:
// permission expires above zero; possible ice must thaw before reserve returns.
function energyTemperature(energy, properties) {
  if (energy >= 0) return energy / properties.capacityJPerMK;
  if (energy >= -properties.latentJPerM) return 0;
  return (energy + properties.latentJPerM) / properties.iceCapacityJPerMK;
}
const unknownEnergy = p => -p.latentJPerM + MIN_AIR_C * p.iceCapacityJPerMK;
function setEnergy(state, energy, properties) {
  state.energyJPerM = energy; state.estimatedC = energyTemperature(energy, properties);
}
const remainingEnergy = (state, policy, p) => Math.max(0, state.energyJPerM - p.capacityJPerMK * policy.marginC);

export function garageSensorStatus(observation, location, now, settings = {}) {
  const config = garageSettings(settings), value = observation?.[`${location}C`];
  // Explicit null clocks stay missing; only omitted clocks use observation.at.
  const at = observation?.[`${location}At`] === undefined ? observation?.at : observation[`${location}At`];
  const usable = validC(value) && finite(at) && at <= now && now - at < sensorAge(config)
    && observation?.[`${location}Usable`] !== false && observation?.[`${location}Retained`] !== true;
  return { location, value: finite(value) ? value : null, at: finite(at) ? at : null, usable,
    reason: usable ? 'fresh-observation' : !finite(value) ? 'missing-temperature' : 'unqualified-or-stale-temperature' };
}
export function createGarageExposure(settings = {}) {
  const config = garageSettings(settings), properties = reserveProperties(config);
  return { version: GARAGE_POLICY_VERSION, at: null, policy: copy(config.protection),
    locations: Object.fromEntries(locations.map(location => [location, {
      energyJPerM: unknownEnergy(properties), estimatedC: MIN_AIR_C,
      stateAt: null, lastAt: null, lastC: null, uncertain: true, unknownMinutes: 0,
      uncertaintyReason: 'initializing-reserve',
    }])) };
}

/** Shared persistence validation: source clocks and energy must agree. */
export function validGarageExposure(exposure, now = Infinity, settings = {}) {
  if (!exposure || exposure.version !== GARAGE_POLICY_VERSION || !(finite(now) || now === Infinity)
    || !(exposure.at === null || finite(exposure.at) && exposure.at <= now)) return false;
  let properties;
  try {
    garageSettings(settings);
    if (!exposure.policy || exposure.policy.version !== GARAGE_POLICY_VERSION) return false;
    properties = reserveProperties({ protection: exposure.policy });
  } catch { return false; }
  return locations.every(location => {
    const s = exposure.locations?.[location];
    return s && finite(s.energyJPerM) && validC(s.estimatedC)
      && Math.abs(s.estimatedC - energyTemperature(s.energyJPerM, properties)) < 1e-6
      && s.energyJPerM >= unknownEnergy(properties) - EPSILON_J
      && s.energyJPerM <= MAX_AIR_C * properties.capacityJPerMK + EPSILON_J
      && typeof s.uncertain === 'boolean' && finite(s.unknownMinutes) && s.unknownMinutes >= 0
      && (s.stateAt === null || finite(s.stateAt) && finite(exposure.at) && s.stateAt <= exposure.at)
      && (s.lastAt === null || finite(s.lastAt) && finite(s.stateAt) && s.lastAt <= s.stateAt)
      && (s.lastC === null || validC(s.lastC)) && (s.lastAt === null) === (s.lastC === null)
      && (s.lastAt !== null || s.uncertain && s.energyJPerM <= 0);
  });
}

/** Old indices are not temperatures. New-model energy survives policy changes
 * without receiving extra reserve from a larger pipe or a lower margin. */
export function upgradeGarageExposure(previous, settings = {}) {
  const config = garageSettings(settings);
  if (!previous) return createGarageExposure(config);
  if (previous.version !== GARAGE_POLICY_VERSION) {
    if (!['garage-exposure-v1', 'garage-exposure-v2'].includes(previous.version))
      throw new Error('Unsupported garage exposure version');
    const output = createGarageExposure(config);
    output.previousVersion = previous.version;
    output.at = finite(previous.at) ? previous.at : null;
    for (const location of locations) {
      const state = output.locations[location], old = previous.locations?.[location];
      state.stateAt = output.at;
      if (finite(output.at) && finite(old?.lastAt) && old.lastAt <= output.at && validC(old.lastC)) {
        state.lastAt = old.lastAt; state.lastC = old.lastC;
      }
      state.uncertaintyReason = 'protection-policy-transition';
    }
    return output;
  }
  if (!validGarageExposure(previous, Infinity, config)) throw new Error('Invalid garage thermal reserve state');
  const output = copy(previous), oldPolicy = output.policy;
  if (policyKeys.some(key => oldPolicy[key] !== config.protection[key])) {
    const oldP = reserveProperties({ protection: oldPolicy }), p = reserveProperties(config);
    for (const state of Object.values(output.locations)) {
      const mappedEnergy = state.energyJPerM >= 0 ? state.estimatedC * p.capacityJPerMK
        : state.energyJPerM >= -oldP.latentJPerM ? state.energyJPerM / oldP.latentJPerM * p.latentJPerM
          : -p.latentJPerM + state.estimatedC * p.iceCapacityJPerMK;
      let energy = Math.min(state.energyJPerM, mappedEnergy,
        p.capacityJPerMK * config.protection.marginC + remainingEnergy(state, oldPolicy, oldP));
      // Preserve at least the previously assumed frozen fraction as well.
      if (state.energyJPerM < 0) energy = Math.min(energy, state.energyJPerM / oldP.latentJPerM * p.latentJPerM);
      setEnergy(state, Math.max(unknownEnergy(p), energy), p);
      state.uncertain = true; state.uncertaintyReason = 'protection-settings-changed';
    }
  }
  output.policy = copy(config.protection);
  return output;
}

function crossingTime(valueAt, target, high, increasing) {
  let low = 0;
  for (let n = 0; n < 52; n++) {
    const mid = (low + high) / 2;
    if ((valueAt(mid) < target) === increasing) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Exact linear-air integration, split at flow reversals and phase boundaries.
 * A spent margin is recorded even if subsequent warmth restores it before the
 * endpoint. Phase bookkeeping repays possible ice, never extends permission. */
function advanceEnergy(state, a, b, minutes, policy, p) {
  const margin = p.capacityJPerMK * policy.marginC;
  let firstLimitMinute = state.energyJPerM <= margin ? 0 : null;
  if (!(minutes > 0)) return firstLimitMinute;
  const slope = (b - a) / minutes;
  let elapsed = 0, energy = state.energyJPerM;
  for (let transitions = 0; elapsed < minutes - 1e-10; transitions++) {
    if (transitions > 24) throw new Error('Garage thermal reserve segment did not converge');
    const air = a + slope * elapsed, temperature = energyTemperature(energy, p);
    const difference = air - temperature;
    const warming = Math.abs(difference) > 1e-10 ? difference > 0 : slope >= 0;
    const conductance = warming ? p.warmingConductanceWPerMK : p.coolingConductanceWPerMK;
    let capacity = null, offset = 0;
    if (energy > EPSILON_J || Math.abs(energy) <= EPSILON_J && warming) capacity = p.capacityJPerMK;
    else if (energy < -p.latentJPerM - EPSILON_J || Math.abs(energy + p.latentJPerM) <= EPSILON_J && !warming) {
      capacity = p.iceCapacityJPerMK; offset = -p.latentJPerM;
    }
    const tau = capacity === null ? null : capacity / conductance / 60, initial = energy;
    const temperatureAt = tau === null ? () => 0 : t => air + slope * t - slope * tau
      + (temperature - air + slope * tau) * Math.exp(-t / tau);
    const energyAt = tau === null ? t => initial + conductance * 60 * (air * t + slope * t * t / 2)
      : t => offset + capacity * temperatureAt(t);
    let duration = minutes - elapsed;
    const ratio = tau === null ? null : slope * tau / (temperature - air + slope * tau);
    const reversal = tau === null ? -air / slope : ratio > 0 && ratio < 1 ? -tau * Math.log(ratio) : Infinity;
    if (reversal > 1e-10 && reversal < duration) duration = reversal;
    let boundary = capacity === null ? warming ? 0 : -p.latentJPerM
      : offset === 0 && !warming ? 0 : offset !== 0 && warming ? -p.latentJPerM : null;
    const end = energyAt(duration);
    if (boundary !== null && (warming ? end >= boundary : end <= boundary))
      duration = crossingTime(energyAt, boundary, duration, warming);
    else boundary = null;
    const next = boundary === null ? energyAt(duration) : boundary;
    if (firstLimitMinute === null && energy > margin && next <= margin)
      firstLimitMinute = elapsed + crossingTime(energyAt, margin, duration, false);
    energy = next; elapsed += duration;
  }
  setEnergy(state, energy, p);
  return firstLimitMinute;
}

function gapBound(state, current, observation, now) {
  const outdoorAt = observation?.outdoorAt;
  // A fresh endpoint does not describe the missing hours before it. Only a
  // still-qualified outdoor observation spanning the start of this debit can
  // bound the interval; otherwise use the supported cold-air envelope.
  const outdoor = validC(observation?.outdoorC) && finite(outdoorAt) && outdoorAt <= state.stateAt
    && now - outdoorAt <= 30 * MINUTE && observation?.outdoorUsable !== false
    && observation?.outdoorRetained !== true ? observation.outdoorC : MIN_AIR_C;
  return Math.min(outdoor, validC(state.lastC) ? state.lastC : MAX_AIR_C,
    current.usable ? current.value : MAX_AIR_C, state.estimatedC);
}
function advanceGap(state, until, bound, config, properties) {
  if (finite(state.stateAt) && until > state.stateAt) {
    const minutes = (until - state.stateAt) / MINUTE;
    advanceEnergy(state, bound, bound, minutes, config.protection, properties);
    state.unknownMinutes += minutes;
  }
  state.stateAt = until; state.uncertain = true;
  if (state.uncertaintyReason !== 'initializing-reserve') state.uncertaintyReason = 'exposure-history-uncertain';
}

/** Only genuinely newer reports establish warmth. Fresh cached reports leave
 * the measured state at its source clock. Assessment can project cooling only.
 * Invalid/stale intervals debit elapsed energy once and cannot be erased later. */
export function updateGarageExposure(previous, observation, settings = {}) {
  const config = garageSettings(settings), now = observation?.at;
  if (!finite(now)) throw new Error('Garage exposure requires numeric UTC observation time');
  const output = upgradeGarageExposure(previous, config), p = reserveProperties(config);
  if (finite(output.at) && now < output.at) return output;
  for (const location of locations) {
    const state = output.locations[location], current = garageSensorStatus(observation, location, now, config);
    if (state.stateAt === null) {
      state.stateAt = current.usable ? current.at : now;
      if (current.usable) { state.lastAt = current.at; state.lastC = current.value; }
      continue;
    }
    const newer = current.usable && (state.lastAt === null || current.at > state.lastAt) && current.at >= state.stateAt;
    if (newer) {
      const known = finite(state.lastAt) && state.stateAt === state.lastAt
        && current.at - state.lastAt <= sensorAge(config) && observation?.[`${location}Gap`] !== true;
      if (known) {
        advanceEnergy(state, state.lastC, current.value, (current.at - state.stateAt) / MINUTE, config.protection, p);
        state.stateAt = current.at;
        if (state.energyJPerM > p.capacityJPerMK * config.protection.marginC) {
          state.uncertain = false; state.unknownMinutes = 0; state.uncertaintyReason = null;
        }
      } else advanceGap(state, current.at, gapBound(state, current, observation, now), config, p);
      state.lastAt = current.at; state.lastC = current.value;
    }
    if (!current.usable || observation?.[`${location}Gap`] === true)
      advanceGap(state, now, gapBound(state, current, observation, now), config, p);
  }
  output.at = now; output.policy = copy(config.protection);
  return output;
}

/** Independent forecast state and earliest crossing inside one linear step.
 * Predictions never renew genuine source clocks or clear measured uncertainty.
 * Chain this helper for planning; its output is not a new measured observation
 * and must not be passed through updateGarageExposure/assessGarageProtection. */
export function projectGarageExposure(previous, point, settings = {}) {
  const config = garageSettings(settings), exposure = upgradeGarageExposure(previous, config);
  if (!finite(point?.at) || !finite(exposure.at) || point.at < exposure.at)
    throw new Error('Garage reserve projection requires ordered numeric UTC times');
  const p = reserveProperties(config), result = { exposure, interventionAt: null, locations: {} };
  for (const location of locations) {
    const state = exposure.locations[location], lower = point[`${location}LowerC`];
    const value = lower === undefined ? point[`${location}C`] : lower;
    const from = state.projectionAt ?? state.stateAt;
    const air = state.projectionC === undefined ? state.lastC : state.projectionC;
    if (!validC(value) || !validC(air) || !finite(from) || from > point.at) {
      result.locations[location] = { interventionAt: exposure.at, reason: 'forecast-temperature-unavailable' };
      result.interventionAt = result.interventionAt === null ? exposure.at : Math.min(result.interventionAt, exposure.at);
      state.projectionAt = point.at; state.projectionC = null;
      state.uncertain = true; state.uncertaintyReason = 'forecast-temperature-unavailable';
      continue;
    }
    const minute = advanceEnergy(state, air, value, (point.at - from) / MINUTE, config.protection, p);
    const interventionAt = minute === null ? null : from + minute * MINUTE;
    state.stateAt = point.at; state.projectionAt = point.at; state.projectionC = value;
    result.locations[location] = { interventionAt, reason: null };
    if (interventionAt !== null && (result.interventionAt === null || interventionAt < result.interventionAt))
      result.interventionAt = interventionAt;
  }
  exposure.at = point.at;
  return result;
}

/** Anchor a measured state at the decision time before projecting the future.
 * The unobserved prefix may cool but cannot earn cached warmth. Without this
 * boundary a later rising forecast would be interpolated back into the past. */
export function projectCurrentGarageExposure(previous, observation, now, settings = {}) {
  const config = garageSettings(settings), p = reserveProperties(config);
  const output = updateGarageExposure(previous, { ...observation, at: now }, config);
  for (const location of locations) {
    const state = output.locations[location], sensor = garageSensorStatus(observation, location, now, config);
    if (sensor.usable && finite(state.stateAt) && state.stateAt < now) {
      const air = Math.min(sensor.value, state.estimatedC);
      advanceEnergy(state, air, air, (now - state.stateAt) / MINUTE, config.protection, p);
      state.stateAt = now;
    }
    state.projectionAt = now; state.projectionC = sensor.usable ? sensor.value : null;
  }
  output.at = now;
  return output;
}

/** Fresh local observations qualify permission. Forecasts include the caller's
 * uncertainty and exclude hoped-for EV heat. Restore before reserve plus the
 * response margin is spent, with no air cutoff or fixed warming qualification. */
export function assessGarageProtection(exposure, { now, observation, settings = {}, forecast = [], restorationDelayMs = 0 } = {}) {
  const config = garageSettings(settings), policy = config.protection, p = reserveProperties(config);
  if (!finite(now) || !finite(restorationDelayMs) || restorationDelayMs < 0) throw new Error('Invalid garage protection timing');
  const invalid = exposure != null && exposure.version === GARAGE_POLICY_VERSION && !validGarageExposure(exposure, now, config);
  let projected = projectCurrentGarageExposure(invalid ? null : exposure, observation, now, config);
  const result = { approved: policy.approved, safeToPause: policy.approved, requiredFresh: true,
    limitingLocation: null, interventionAt: null, locations: {}, reasons: [] };
  const rows = forecast.filter(row => finite(row.at) && row.at > now).sort((a, b) => a.at - b.at);
  for (const location of locations) {
    const sensor = garageSensorStatus(observation, location, now, config), state = projected.locations[location];
    const remainingKjPerM = remainingEnergy(state, policy, p) / 1000;
    const reason = invalid ? 'exposure-state-invalid' : !sensor.usable ? sensor.reason
      : state.uncertain ? state.uncertaintyReason ?? 'exposure-history-uncertain'
        : remainingKjPerM <= 0 ? 'thermal-reserve-exhausted' : null;
    result.locations[location] = { ...state, temperatureC: sensor.value, fresh: sensor.usable,
      remainingKjPerM, interventionAt: remainingKjPerM <= 0 ? now : null, reason };
    if (reason) { result.safeToPause = false; result.reasons.push(`${location}:${reason}`); }
    if (!sensor.usable) result.requiredFresh = false;
  }
  for (const point of rows) {
    const next = projectGarageExposure(projected, point, config);
    for (const location of locations) {
      const entry = next.locations[location], current = result.locations[location];
      if (entry.reason) {
        result.safeToPause = false;
        const reason = `${location}:${entry.reason}`;
        if (!result.reasons.includes(reason)) result.reasons.push(reason);
      }
      if (entry.interventionAt !== null && (current.interventionAt === null || entry.interventionAt < current.interventionAt))
        current.interventionAt = entry.interventionAt;
    }
    projected = next.exposure;
  }
  // Extend the final supported temperature as a forecast, never as a report.
  for (const location of locations) {
    const state = projected.locations[location], current = result.locations[location], air = state.projectionC;
    if (current.interventionAt === null && validC(air) && air < policy.marginC && state.estimatedC > policy.marginC)
      current.interventionAt = projected.at + p.coolingTimeConstantMinutes
        * Math.log((state.estimatedC - air) / (policy.marginC - air)) * MINUTE;
    const at = current.interventionAt;
    if (at !== null && (result.interventionAt === null || at < result.interventionAt)) {
      result.interventionAt = at; result.limitingLocation = location;
    }
  }
  if (result.limitingLocation === null) result.limitingLocation = [...locations].sort((a, b) =>
    result.locations[a].remainingKjPerM - result.locations[b].remainingKjPerM)[0];
  if (result.interventionAt !== null && result.interventionAt <= now + restorationDelayMs) {
    result.safeToPause = false; result.reasons.push('restoration-margin-exhausted');
  }
  if (!policy.approved) result.reasons.push('owner-protection-policy-not-approved');
  return result;
}
