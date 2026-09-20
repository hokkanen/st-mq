/** Fixed DHP-H 10 source estimate. Danfoss AN000086466221en-010701,
 * technical data pp. 107–108: B0/W35 9.40 kW, COP 4.24;
 * B0/W45 9.24 kW, COP 3.51. These are test-boundary outputs, not metering. */
export const HEAT_PUMP_PERFORMANCE = Object.freeze({
  version: 'dhp-h10-b0-v1', model: 'Danfoss DHP-H 10', brineReferenceC: 0,
  supplyRangeC: [35, 45], nominalSupplyC: 35, pumpsIncluded: true,
  source: 'https://assets.danfoss.com/documents/latest/29671/AN000086466221en-010701.pdf',
  basis: 'manufacturer-two-point-estimate; not measured heat or electricity',
});

export function estimateHeatPumpPerformance({ supplyC, brineC, modelConfirmed = false } = {}) {
  const supplied = Number.isFinite(supplyC), brineKnown = Number.isFinite(brineC);
  // Only the modest 30–50 C extension is provisionally supported. Preserve the
  // actual point and reject economic use outside it; never evaluate hot W60 as
  // cheap W35. A boundary estimate is still useful for degraded-state display.
  const withinPlanningRange = supplied && supplyC >= 30 && supplyC <= 50;
  const waterC = supplied ? Math.max(30, Math.min(50, supplyC)) : 35;
  const heatKw = 9.40 - 0.016 * (waterC - 35);
  const electricalKw = 9.40 / 4.24 + ((9.24 / 3.51 - 9.40 / 4.24) / 10) * (waterC - 35);
  const extrapolationC = Math.max(0, 35 - waterC, waterC - 45);
  const uncertaintyReasons = [
    ...(!modelConfirmed ? ['installed-model-not-confirmed'] : []),
    ...(!withinPlanningRange ? ['missing-or-out-of-range-water-temperature'] : []),
    ...(extrapolationC > 0 ? ['water-temperature-extrapolation'] : []),
    ...(!brineKnown ? ['missing-brine-temperature'] : Math.abs(brineC) > 0.5 ? ['brine-correction-not-identified'] : []),
  ];
  // An engineering scenario allowance, not a statistical confidence interval.
  // The two B0 points cannot identify a brine slope, so none is invented.
  const relativeUncertainty = Math.min(0.8, 0.10 + (!modelConfirmed ? 0.15 : 0)
    + (!withinPlanningRange ? 0.3 : 0) + extrapolationC * 0.015
    + (!brineKnown ? 0.15 : Math.min(0.3, Math.abs(brineC) * 0.03)));
  return { ...HEAT_PUMP_PERFORMANCE, heatKw, electricalKw, cop: heatKw / electricalKw,
    supplyC: supplied ? supplyC : null, evaluatedSupplyC: waterC, withinPlanningRange,
    brineC: brineKnown ? brineC : null, modelConfirmed: modelConfirmed === true,
    brineCorrectionKnown: brineKnown && Math.abs(brineC) <= 0.5,
    extrapolated: extrapolationC > 0, relativeUncertainty, uncertaintyReasons };
}

/** Callers supply already routed space-heating duty and AUX power. */
export function estimateHydronicHeat(inputs = {}, performance = {}) {
  const source = estimateHeatPumpPerformance({ ...performance, supplyC: inputs.supplyC, brineC: inputs.brineC });
  const duty = Number.isFinite(inputs.compressorDuty) ? Math.max(0, Math.min(1, inputs.compressorDuty)) : null;
  const auxKw = Number.isFinite(inputs.auxKw) ? Math.max(0, Math.min(20, inputs.auxKw)) : null;
  return { ...source, compressorHeatKw: duty === null ? null : duty * source.heatKw,
    hydronicKw: duty === null || auxKw === null ? null : duty * source.heatKw + auxKw };
}

export const hydronicGain = model => Number.isFinite(model?.parameters?.hydronicCPerKwh)
  ? model.parameters.hydronicCPerKwh : 0.75 / 9.4;
export const nominalCompressorHeatKw = (model, inputs = {}) =>
  estimateHeatPumpPerformance({ ...model?.performance, ...inputs }).heatKw;
