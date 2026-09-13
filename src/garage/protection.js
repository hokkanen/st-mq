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
// Exact integral of positive part of a linear temperature segment.
function coldIntegral(a, b, floor, minutes) {
  const x = floor - a, y = floor - b;
  if (x <= 0 && y <= 0) return 0;
  if (x >= 0 && y >= 0) return (x + y) * minutes / 2;
  return Math.max(x, y) ** 2 * minutes / (2 * Math.abs(y - x));
}
/** Update physical exposure at observation/tick time, never reset by a refit, a
 * slider change, a short warm blip, or another location's recovery. */
export function updateGarageExposure(previous, observation, settings = {}) {
  const config = garageSettings(settings), at = observation?.at;
  if (!finite(at)) throw new Error('Garage exposure requires numeric UTC observation time');
  const output = copy(previous ?? createGarageExposure(config));
  if (output.version !== GARAGE_POLICY_VERSION) throw new Error('Unsupported garage exposure version');
  if (finite(output.at) && at <= output.at) return output;
  const policy = output.policy ?? config.protection;
  for (const location of locations) {
    const state = output.locations[location], current = garageSensorStatus(observation, location, at, config);
    if (finite(state.lastAt)) {
      const minutes = (at - state.lastAt) / MINUTE;
      const known = current.usable && finite(state.lastC) && observation?.[`${location}Gap`] !== true
        && at - state.lastAt <= config.maxSensorAgeMs;
      if (known) {
        state.degreeMinutes += coldIntegral(state.lastC, current.value, policy.floorC, minutes);
        if (state.lastC >= policy.recoveryAboveC && current.value >= policy.recoveryAboveC) {
          state.recoveryMinutes += minutes;
          // Dwell is an explicit hysteresis gate, not a refill on every warm report.
          const creditMinutes = Math.max(0, state.recoveryMinutes - policy.recoveryDwellMinutes)
            - Math.max(0, state.recoveryMinutes - minutes - policy.recoveryDwellMinutes);
          state.degreeMinutes = Math.max(0, state.degreeMinutes - creditMinutes * policy.recoveryDegreeMinutesPerMinute);
          if (state.recoveryMinutes >= policy.recoveryDwellMinutes && state.degreeMinutes === 0) {
            state.uncertain = false; state.unknownMinutes = 0;
          }
        } else state.recoveryMinutes = 0;
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
  let projected = copy(exposure ?? createGarageExposure(config));
  if (!finite(projected.at) || projected.at < now) projected = updateGarageExposure(projected, { ...observation, at: now }, config);
  const result = { approved: policy.approved, safeToPause: policy.approved, requiredFresh: true,
    limitingLocation: null, interventionAt: null, locations: {}, reasons: [] };
  for (const location of locations) {
    const sensor = garageSensorStatus(observation, location, now, config), state = projected.locations[location];
    const remaining = Math.max(0, policy.budgetDegreeMinutes - state.degreeMinutes);
    const rate = sensor.usable ? Math.max(0, policy.floorC - sensor.value) : null;
    const interventionAt = rate > 0 ? now + remaining / rate * MINUTE : null;
    const reason = !sensor.usable ? sensor.reason : state.uncertain ? 'exposure-history-uncertain'
      : sensor.value <= policy.hardMinimumC ? 'hard-temperature-limit' : remaining <= 0 ? 'exposure-exhausted' : null;
    result.locations[location] = { ...state, temperatureC: sensor.value, fresh: sensor.usable,
      remainingDegreeMinutes: remaining, interventionAt, reason };
    if (reason) { result.safeToPause = false; result.reasons.push(`${location}:${reason}`); }
    if (!sensor.usable) result.requiredFresh = false;
  }
  const rows = forecast.filter(row => finite(row.at) && row.at > now).sort((a, b) => a.at - b.at);
  for (const row of rows) {
    // Temperature lower bounds include model uncertainty; anticipated EV warmth
    // must be excluded by the caller from protection trajectories.
    const point = { at: row.at,
      rearC: row.rearLowerC ?? row.rearC, frontC: row.frontLowerC ?? row.frontC,
      rearAt: row.at, frontAt: row.at };
    // Predicted intervals are continuous model paths, not stale source reports.
    projected = updateGarageExposure(projected, point, { ...config, maxSensorAgeMs: Math.max(config.maxSensorAgeMs, 4 * 3_600_000) });
    for (const location of locations) {
      const local = projected.locations[location];
      if ((local.degreeMinutes >= policy.budgetDegreeMinutes || local.lastC <= policy.hardMinimumC)
        && (result.locations[location].interventionAt === null || row.at < result.locations[location].interventionAt))
        result.locations[location].interventionAt = row.at;
    }
  }
  for (const location of locations) {
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
