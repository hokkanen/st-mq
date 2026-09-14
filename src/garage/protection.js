import { garageSettings, GARAGE_POLICY_VERSION } from './settings.js';
const MINUTE = 60_000, finite = Number.isFinite;
const locations = ['rear', 'front'];
const copy = value => structuredClone(value);

export function garageSensorStatus(observation, location, now, settings = {}) {
  const config = garageSettings(settings), value = observation?.[`${location}C`];
  const at = observation?.[`${location}At`] ?? observation?.at;
  const usable = finite(value) && value >= -40 && value <= 65 && finite(at) && at <= now
    && now - at <= config.maxSensorAgeMs && observation?.[`${location}Usable`] !== false
    && observation?.[`${location}Retained`] !== true;
  return { location, value: finite(value) ? value : null, at: finite(at) ? at : null, usable,
    reason: usable ? 'fresh-observation' : !finite(value) ? 'missing-temperature' : 'unqualified-or-stale-temperature' };
}
export function createGarageExposure(settings = {}) {
  const config = garageSettings(settings);
  return { version: GARAGE_POLICY_VERSION, at: null, policy: copy(config.protection),
    locations: Object.fromEntries(locations.map(location => [location, {
      degreeMinutes: 0, lastAt: null, lastC: null, recoveryMinutes: 0, unknownMinutes: 0, uncertain: false,
    }])) };
}
/** A version transition cannot manufacture unused protection allowance. This
 * carries the old debt forward as an uncertain lower bound, not a v1 replay. */
export function upgradeGarageExposure(previous, settings = {}) {
  const config = garageSettings(settings);
  if (!previous) return createGarageExposure(config);
  if (previous.version === GARAGE_POLICY_VERSION) return copy(previous);
  if (previous.version !== 'garage-exposure-v1') throw new Error('Unsupported garage exposure version');
  const output = createGarageExposure(config);
  output.previousVersion = previous.version;
  output.at = finite(previous.at) ? previous.at : null;
  for (const location of locations) {
    const old = previous.locations?.[location], state = output.locations[location];
    state.degreeMinutes = Math.max(config.protection.budgetDegreeMinutes,
      finite(old?.degreeMinutes) ? old.degreeMinutes : 0);
    state.lastAt = finite(old?.lastAt) ? old.lastAt : null;
    state.lastC = finite(old?.lastC) ? old.lastC : null;
    state.unknownMinutes = finite(old?.unknownMinutes) ? Math.max(0, old.unknownMinutes) : 0;
    state.uncertain = true;
  }
  return output;
}
// Exact integral of positive part of a linear temperature segment.
function coldIntegral(a, b, floor, minutes) {
  const x = floor - a, y = floor - b;
  if (x <= 0 && y <= 0) return 0;
  if (x >= 0 && y >= 0) return (x + y) * minutes / 2;
  return Math.max(x, y) ** 2 * minutes / (2 * Math.abs(y - x));
}
// Split at both policy thresholds so recharge occurs in chronological order.
// A warm-then-cold segment must never pay off the cold exposure at its end.
function advanceKnownExposure(state, a, b, minutes, policy, trackLimit = false) {
  const cuts = [0, 1];
  for (const threshold of [policy.floorC, policy.recoveryAboveC]) {
    const fraction = (threshold - a) / (b - a);
    if (fraction > 0 && fraction < 1) cuts.push(fraction);
  }
  cuts.sort((x, y) => x - y);
  let firstLimitMinute = state.degreeMinutes >= policy.budgetDegreeMinutes ? 0 : null;
  if (trackLimit && (a <= policy.hardMinimumC || b <= policy.hardMinimumC)) {
    const hardMinute = a <= policy.hardMinimumC ? 0 : minutes * (a - policy.hardMinimumC) / (a - b);
    firstLimitMinute = firstLimitMinute === null ? hardMinute : Math.min(firstLimitMinute, hardMinute);
  }
  for (let i = 1; i < cuts.length; i++) {
    const from = cuts[i - 1], to = cuts[i], duration = minutes * (to - from);
    const startC = a + (b - a) * from, endC = a + (b - a) * to;
    const cold = coldIntegral(startC, endC, policy.floorC, duration);
    if (trackLimit && state.degreeMinutes < policy.budgetDegreeMinutes && state.degreeMinutes + cold >= policy.budgetDegreeMinutes) {
      let low = 0, high = 1;
      for (let n = 0; n < 40; n++) {
        const fraction = (low + high) / 2;
        if (state.degreeMinutes + coldIntegral(startC, startC + (endC - startC) * fraction,
          policy.floorC, duration * fraction) >= policy.budgetDegreeMinutes) high = fraction;
        else low = fraction;
      }
      const budgetMinute = minutes * from + duration * high;
      firstLimitMinute = firstLimitMinute === null ? budgetMinute : Math.min(firstLimitMinute, budgetMinute);
    }
    state.degreeMinutes += cold;
    if ((startC + endC) / 2 >= policy.recoveryAboveC) {
      const before = state.recoveryMinutes;
      state.recoveryMinutes += duration;
      const creditMinutes = Math.max(0, state.recoveryMinutes - policy.recoveryDwellMinutes)
        - Math.max(0, before - policy.recoveryDwellMinutes);
      state.degreeMinutes = Math.max(0, state.degreeMinutes - creditMinutes * policy.recoveryDegreeMinutesPerMinute);
      if (state.recoveryMinutes >= policy.recoveryDwellMinutes && state.degreeMinutes === 0) {
        state.uncertain = false; state.unknownMinutes = 0;
      }
    } else state.recoveryMinutes = 0;
  }
  return firstLimitMinute;
}
/** Update physical exposure at observation/tick time, never reset by a refit, a
 * slider change, a short warm blip, or another location's recovery. */
export function updateGarageExposure(previous, observation, settings = {}) {
  const config = garageSettings(settings), at = observation?.at;
  if (!finite(at)) throw new Error('Garage exposure requires numeric UTC observation time');
  const output = upgradeGarageExposure(previous, config);
  if (finite(output.at) && at <= output.at) return output;
  const policy = output.policy ?? config.protection;
  for (const location of locations) {
    const state = output.locations[location], current = garageSensorStatus(observation, location, at, config);
    if (finite(state.lastAt)) {
      const minutes = (at - state.lastAt) / MINUTE;
      const known = current.usable && finite(state.lastC) && observation?.[`${location}Gap`] !== true
        && at - state.lastAt <= config.maxSensorAgeMs;
      if (known) {
        advanceKnownExposure(state, state.lastC, current.value, minutes, policy);
      } else {
        state.unknownMinutes += minutes; state.uncertain = true; state.recoveryMinutes = 0;
        // Missing history cannot earn warmth. The index is a conservative bound,
        // not a reconstructed measurement of what happened inside the gap.
        state.degreeMinutes += Math.max(policy.floorC - policy.hardMinimumC,
          finite(state.lastC) ? policy.floorC - state.lastC : 0) * minutes;
      }
    }
    state.degreeMinutes = Math.min(1e9, state.degreeMinutes);
    state.lastAt = at; state.lastC = current.usable ? current.value : null;
  }
  output.at = at; output.policy = copy(config.protection);
  return output;
}

/** Both locations are always required for economic OFF permission. frontRequired
 * additionally makes missing front an explicit fault in monitoring/recovery. */
export function assessGarageProtection(exposure, { now, observation, settings = {}, forecast = [], restorationDelayMs = 0 } = {}) {
  const config = garageSettings(settings), policy = config.protection;
  if (!finite(now) || !finite(restorationDelayMs) || restorationDelayMs < 0) throw new Error('Invalid garage protection timing');
  let projected = upgradeGarageExposure(exposure, config);
  if (!finite(projected.at) || projected.at < now) projected = updateGarageExposure(projected, { ...observation, at: now }, config);
  const result = { approved: policy.approved, safeToPause: policy.approved, requiredFresh: true,
    limitingLocation: null, interventionAt: null, locations: {}, reasons: [] };
  const rows = forecast.filter(row => finite(row.at) && row.at > now).sort((a, b) => a.at - b.at);
  for (const location of locations) {
    const sensor = garageSensorStatus(observation, location, now, config), state = projected.locations[location];
    const validState = state && ['degreeMinutes', 'recoveryMinutes', 'unknownMinutes']
      .every(key => finite(state[key]) && state[key] >= 0) && typeof state.uncertain === 'boolean';
    const remaining = validState ? Math.max(0, policy.budgetDegreeMinutes - state.degreeMinutes) : 0;
    const rate = sensor.usable ? Math.max(0, policy.floorC - sensor.value) : null;
    const interventionAt = remaining <= 0 || (sensor.usable && sensor.value <= policy.hardMinimumC)
      ? now : rows.length === 0 && rate > 0 ? now + remaining / rate * MINUTE : null;
    const reason = !validState ? 'exposure-state-invalid' : !sensor.usable ? sensor.reason : state.uncertain ? 'exposure-history-uncertain'
      : sensor.value <= policy.hardMinimumC ? 'hard-temperature-limit' : remaining <= 0 ? 'exposure-exhausted' : null;
    result.locations[location] = { ...state, temperatureC: sensor.value, fresh: sensor.usable,
      remainingDegreeMinutes: remaining, interventionAt, reason };
    if (reason) { result.safeToPause = false; result.reasons.push(`${location}:${reason}`); }
    if (!sensor.usable) result.requiredFresh = false;
  }
  for (const row of rows) {
    // Temperature lower bounds include model uncertainty; anticipated EV warmth
    // must be excluded by the caller from protection trajectories.
    const point = { at: row.at,
      rearC: row.rearLowerC ?? row.rearC, frontC: row.frontLowerC ?? row.frontC,
      rearAt: row.at, frontAt: row.at };
    for (const location of locations) {
      const state = projected.locations[location], value = point[`${location}C`];
      if (!finite(value) || value < -40 || value > 65 || !finite(state.lastC)) {
        result.safeToPause = false;
        const reason = `${location}:forecast-temperature-unavailable`;
        if (!result.reasons.includes(reason)) result.reasons.push(reason);
        continue;
      }
      const minute = advanceKnownExposure(copy(state), state.lastC, value,
        (row.at - projected.at) / MINUTE, policy, true);
      const interventionAt = minute === null ? null : projected.at + minute * MINUTE;
      if (interventionAt !== null && (result.locations[location].interventionAt === null
        || interventionAt < result.locations[location].interventionAt))
        result.locations[location].interventionAt = interventionAt;
    }
    // Predicted intervals are continuous model paths, not stale source reports.
    projected = updateGarageExposure(projected, point, { ...config, maxSensorAgeMs: Math.max(config.maxSensorAgeMs, 4 * 3_600_000) });
  }
  for (const location of locations) {
    if (rows.length && result.locations[location].interventionAt === null) {
      const state = projected.locations[location];
      const rate = finite(state.lastC) ? Math.max(0, policy.floorC - state.lastC) : 0;
      if (rate > 0) result.locations[location].interventionAt = projected.at
        + Math.max(0, policy.budgetDegreeMinutes - state.degreeMinutes) / rate * MINUTE;
    }
    const at = result.locations[location].interventionAt;
    if (at !== null && (result.interventionAt === null || at < result.interventionAt)) {
      result.interventionAt = at; result.limitingLocation = location;
    }
  }
  if (result.limitingLocation === null) result.limitingLocation = [...locations].sort((a, b) =>
    result.locations[a].remainingDegreeMinutes - result.locations[b].remainingDegreeMinutes)[0];
  if (result.interventionAt !== null && result.interventionAt <= now + restorationDelayMs) {
    result.safeToPause = false; result.reasons.push('restoration-margin-exhausted');
  }
  if (!policy.approved) result.reasons.push('owner-protection-policy-not-approved');
  return result;
}
