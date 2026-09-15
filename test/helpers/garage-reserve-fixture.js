import { createGarageExposure, reserveProperties } from '../../src/garage/protection.js';

/** Explicit synthetic, already-warm reference objects. This isolates planner
 * and protocol tests from commissioning; it is never installed evidence. */
export function knownGarageReserve(settings, { at, rearC = 7, frontC = 6.7, rearAirC = rearC, frontAirC = frontC } = {}) {
  const exposure = createGarageExposure(settings), capacity = reserveProperties(settings).capacityJPerMK;
  exposure.at = at;
  for (const [location, value, air] of [['rear', rearC, rearAirC], ['front', frontC, frontAirC]])
    Object.assign(exposure.locations[location], { energyJPerM: capacity * value, estimatedC: value,
      stateAt: at, lastAt: at, lastC: air, uncertain: false, unknownMinutes: 0 });
  return exposure;
}
