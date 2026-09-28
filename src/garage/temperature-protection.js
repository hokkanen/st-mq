import { garageSettings } from './settings.js';
import { GARAGE_TEMPERATURE_MAX_AGE_MS } from './permission.js';
import { assessGarageProtection, garageSensorStatus, projectGarageExposure, validGarageExposure } from './protection.js';

const locations = ['rear', 'front'], finite = Number.isFinite;
const validAir = value => finite(value) && value >= -40 && value <= 65;
const economicApproval = 'owner-protection-policy-not-approved';

/** Assess bounded temperature permission independently of economic approval.
 * Managed OFF callers must separately require that approval and control authority.
 * A held row is still the original valid measurement: the caller must
 * qualify communication-only loss and supply its last qualified exposure anchor.
 * Projections never mutate that anchor or establish new measured warmth. */
export function assessGarageTemperaturePermission(exposure, {
  now, observation, settings = {}, expiresAt, heatingDelayMs,
} = {}) {
  let protection = null;
  const blocked = (reason, additionalReasons = []) => ({ allowed: false, reason,
    reasons: [...new Set([reason, ...additionalReasons,
      ...(protection?.reasons ?? []).filter(value => value !== economicApproval)])],
    expiresAt: null, protection });
  if (!finite(now) || !finite(expiresAt) || expiresAt <= now) return blocked('external-permission-expired');
  if (!finite(heatingDelayMs) || heatingDelayMs < 0) return blocked('heating-response-bound-unavailable');
  try {
    const config = garageSettings(settings);
    if (!exposure || !validGarageExposure(exposure, now, config)) return blocked('exposure-state-invalid');
    const sensors = Object.fromEntries(locations.map(location =>
      [location, garageSensorStatus(observation, location, now, config)]));
    const failures = [];
    for (const location of locations) {
      const state = exposure.locations[location];
      if (!sensors[location].usable) failures.push(`${location}:${sensors[location].reason}`);
      if (state.uncertain)
        failures.push(`${location}:${state.uncertaintyReason ?? 'exposure-history-uncertain'}`);
      // An uncertain gap in one location must not hide known spent reserve at
      // the other. Callers may only retry uncertainty from a qualified anchor
      // when every reported failure permits that conservative assessment.
      else if (state.estimatedC <= config.protection.marginC)
        failures.push(`${location}:thermal-reserve-exhausted`);
    }
    if (failures.length) return blocked(failures[0], failures.slice(1));
    const evidenceAt = Math.min(...locations.map(location => sensors[location].at));
    const assessmentObservation = { ...observation, at: now };
    const anchor = structuredClone(exposure), heldBounds = {};
    for (const location of locations) {
      if (observation?.[`${location}Held`] !== true) continue;
      const state = anchor.locations[location], sensor = sensors[location];
      if (state.lastAt !== sensor.at || sensor.value > state.lastC || !finite(state.stateAt))
        return blocked(`${location}:held-exposure-anchor-mismatch`);
      const outdoorAt = observation?.outdoorAt;
      const outdoor = validAir(observation?.outdoorC) && finite(outdoorAt) && outdoorAt <= state.stateAt
        && now - outdoorAt <= 30 * 60_000 && observation?.outdoorUsable !== false
        && observation?.outdoorRetained !== true ? observation.outdoorC : -40;
      const bound = Math.min(sensor.value, outdoor, state.estimatedC);
      heldBounds[location] = bound;
      // Set only a projection's air, retaining every original evidence clock.
      // Other locations are projected incidentally and are not copied back.
      const projection = structuredClone(anchor);
      projection.locations[location].projectionC = bound;
      projection.locations[location].projectionAt = state.stateAt;
      const projected = projectGarageExposure(projection, { at: now,
        rearC: location === 'rear' ? bound : sensors.rear.value,
        frontC: location === 'front' ? bound : sensors.front.value }, config);
      anchor.locations[location] = projected.exposure.locations[location];
      anchor.at = now;
      assessmentObservation[`${location}C`] = bound;
      // A communication gap was already conservatively projected above. It is
      // not a new sensor sample or a request to debit the same interval twice.
      assessmentObservation[`${location}Gap`] = false;
    }
    protection = assessGarageProtection(anchor, { now, observation: assessmentObservation,
      settings: config, restorationDelayMs: heatingDelayMs });
    const reason = protection.reasons.find(reason => reason !== economicApproval);
    if (reason || !protection.requiredFresh) return blocked(reason ?? 'fresh-temperature-reserve-required');
    const thermalExpiry = finite(protection.interventionAt)
      ? Math.ceil(protection.interventionAt - heatingDelayMs) - 1 : Infinity;
    const sourceExpiry = evidenceAt + Math.min(config.maxSensorAgeMs, GARAGE_TEMPERATURE_MAX_AGE_MS);
    const boundedExpiry = Math.floor(Math.min(expiresAt, sourceExpiry, thermalExpiry));
    if (boundedExpiry <= now) return blocked('restoration-margin-exhausted');
    protection = assessGarageProtection(anchor, { now, observation: assessmentObservation,
      settings: config, restorationDelayMs: boundedExpiry - now + heatingDelayMs });
    const finalReason = protection.reasons.find(reason => reason !== economicApproval);
    if (finalReason || !protection.requiredFresh) return blocked(finalReason ?? 'fresh-temperature-reserve-required');
    return { allowed: true, reason: null, reasons: [], expiresAt: boundedExpiry, evidenceAt, protection, heldBounds };
  } catch {
    return blocked('external-protection-unavailable');
  }
}
