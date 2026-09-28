import { predictGarageStep, predictGarageNative, normalGarageTemperature } from './model.js';

export const GARAGE_TARGET_POLICY_VERSION = 'garage-room-target-v1';

// A powered pump still runs electronics and may run its fan. This deliberately
// conservative planning allowance is an assumption, not measured standby power.
export function garageReducedPowerAllowance(normalPowerKw) {
  return Math.min(normalPowerKw, Math.max(.1, normalPowerKw * .25));
}

/** Predict a lower thermostat target without equating native ON with heat input.
 * The learned cooling curve applies until the rear reaches the adjusted normal
 * reference. Thereafter heating may maintain the lower target. Protection uses
 * its separate no-heat trajectory and never credits this predicted heating. */
export function predictGarageTargetStep(model, state, { outdoorC, targetC, normalTargetC, normalPowerKw }, hours) {
  if (![targetC, normalTargetC, normalPowerKw, hours].every(Number.isFinite)
    || targetC < 0 || targetC > normalTargetC || normalPowerKw < 0 || hours <= 0 || hours > 4)
    throw new Error('Garage target prediction requires a bounded lower room target and known power');
  const delta = targetC - normalTargetC;
  const reference = normalGarageTemperature(model) + delta;
  const rate = model.rear.values[0];
  let coolingHours = 0;
  if (state.rearC > reference) {
    coolingHours = reference <= outdoorC || !(rate > 0) ? hours
      : Math.min(hours, Math.max(0, Math.log((state.rearC - outdoorC) / (reference - outdoorC)) / rate));
  }
  let next = state;
  if (coolingHours > 0) next = predictGarageStep(model, state,
    { outdoorC, available: false }, coolingHours).state;
  const maintenanceHours = Math.max(0, hours - coolingHours);
  if (maintenanceHours > 0) {
    const adjusted = { ...model, normalReference: { ...model.normalReference,
      interceptC: reference, frontC: model.normalReference.frontC + delta } };
    next = predictGarageStep(adjusted, next, { outdoorC, available: true }, maintenanceHours).state;
  }
  const idleKw = garageReducedPowerAllowance(normalPowerKw);
  const normalLift = Math.max(0, normalGarageTemperature(model) - outdoorC);
  const reducedLift = Math.max(0, reference - outdoorC);
  const maintenanceKw = normalLift > 0
    ? Math.max(idleKw, normalPowerKw * Math.min(1, reducedLift / normalLift)) : normalPowerKw;
  return { state: next, ...next, targetC, normalTargetC, coolingHours, maintenanceHours,
    electricityKwh: idleKw * coolingHours + maintenanceKw * maintenanceHours,
    uncertaintyKwh: predictGarageNative(model).uncertaintyKw * hours,
    electricityBasis: 'assumed-powered-idle-and-lower-target-maintenance',
    idlePowerAllowanceKw: idleKw, maintenancePowerKw: maintenanceKw };
}
