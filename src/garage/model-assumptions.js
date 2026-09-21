import { CHARGING_LOSS_FRACTION } from '../domain/charging-energy.js';

export const GARAGE_MODEL_ASSUMPTIONS = Object.freeze({ evHeatFraction: CHARGING_LOSS_FRACTION, normalPowerKw: .5,
  recoveryTimeHours: 3, recoveryEnergyFactor: 1.25, doorHeat: 'not-credited-reassess-from-sensors' });

/** Price extra recovery over enough time that its assumed average input never
 * exceeds the normal-power estimate. This is an electricity allowance, not a
 * prediction of delivered heat or a permission to remain OFF. */
export function garageRecoveryHours(offHours = 0) {
  if (!Number.isFinite(offHours) || offHours < 0) throw new TypeError('Garage recovery requires nonnegative OFF hours');
  return Math.max(GARAGE_MODEL_ASSUMPTIONS.recoveryTimeHours,
    GARAGE_MODEL_ASSUMPTIONS.recoveryEnergyFactor * offHours);
}
