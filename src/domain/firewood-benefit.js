import { evaluateCycle } from '../control/planner.js';
import { fireplaceEvidenceReady, THERMAL_PARAMETER_BOUNDS } from '../control/adaptive-learning.js';
const clampParameter = (name, value) => Math.max(THERMAL_PARAMETER_BOUNDS[name][0], Math.min(THERMAL_PARAMETER_BOUNDS[name][1], value));

/** Parameter scenarios, never probability bounds. Each scenario maintains two
 * independent thermal states; observed compressor demand never drives either. */
export function firewoodScenarios(model, initialState) {
  const identified = fireplaceEvidenceReady(model);
  const nominalGain = model.parameters.fireplaceCPerKg ?? 0.15;
  return [
    { name: 'central', gain: 1, loss: 1, heat: 1, power: 1 },
    { name: 'zero-additional-heat', gain: 0, loss: 1, heat: 1, power: 1 },
    { name: 'lower-response', gain: identified ? 0.7 : 0.5, loss: 0.85, heat: 1.15, power: 0.8 },
    { name: 'higher-response', gain: identified ? 1.3 : 2, loss: 1.15, heat: 0.85, power: 1.2 },
  ].map(scenario => ({ name: scenario.name, powerMultiplier: scenario.power, model: {
    ...structuredClone(model), parameters: { ...model.parameters,
      fireplaceCPerKg: clampParameter('fireplaceCPerKg', nominalGain * scenario.gain),
      lossPerHour: clampParameter('lossPerHour', model.parameters.lossPerHour * scenario.loss),
      normalHeatCPerHour: clampParameter('normalHeatCPerHour', model.parameters.normalHeatCPerHour * scenario.heat) },
    energy: { ...model.energy, compressorKw: Math.min(30, model.energy.compressorKw * scenario.power) },
  }, withFire: { ...initialState }, withoutFire: { ...initialState }, cents: 0, kwh: 0 }));
}

/** A normal space-heating policy in both worlds, with the same weather,
 * comfort target and equipment configuration. No terminal heat is monetized. */
export function advanceFirewoodPair(scenario, { start, end, outdoorC, solarRadiationWm2, price = 0,
  targetC, config = {}, fireplaceEvents = [], occupancy = { mode: 'occupied' } }) {
  const changedNominal = Number.isFinite(config.heatPumpCompressorKw)
    && config.heatPumpCompressorKw !== scenario.model.energy.nominalConfiguration?.compressorKw;
  const model = changedNominal ? { ...scenario.model, energy: { ...scenario.model.energy,
    compressorKw: Math.max(0.01, Math.min(30, config.heatPumpCompressorKw * scenario.powerMultiplier)) } } : scenario.model;
  const common = { intervals: [{ start, end, outdoorC, solarRadiationWm2, price }],
    model, targetC, config, occupancy, schedule: null, includeTail: false };
  const withFire = evaluateCycle({ ...common, initialState: scenario.withFire,
    equipment: { fireplaceEvents } });
  const withoutFire = evaluateCycle({ ...common, initialState: scenario.withoutFire,
    equipment: { fireplaceEvents: [] } });
  scenario.withFire = withFire.endState; scenario.withoutFire = withoutFire.endState;
  const hours = (end - start) / 3_600_000;
  return { benefitCents: withoutFire.spaceHeatingCostCents - withFire.spaceHeatingCostCents,
    avoidedKwh: withoutFire.spaceHeatingKwh - withFire.spaceHeatingKwh,
    predictedKwh: withFire.spaceHeatingKwh,
    withoutFirePredictedKwh: withoutFire.spaceHeatingKwh,
    predictedCompressorHours: withFire.trajectory.reduce((sum, row) => sum + row.compressorDuty * row.durationHours, 0),
    predictedAuxKwh: withFire.auxiliaryKwh, hours };
}
