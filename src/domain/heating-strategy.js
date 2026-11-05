/** Named retention preferences for Home heating. Monetary policy, temperature,
 * protection and learning gates stay independent of the selected strategy. */
export const DEFAULT_HEATING_STRATEGY = 'savings';
export const HEATING_STRATEGIES = Object.freeze([
  Object.freeze({ id: 'gentle', label: 'Gentle',
    description: 'Prefer a milder cycle retaining at least 60% of the best conservative saving.',
    retainedBenefitFraction: .6 }),
  Object.freeze({ id: 'balanced', label: 'Balanced',
    description: 'Prefer a milder cycle retaining at least 80% of the best conservative saving.',
    retainedBenefitFraction: .8 }),
  Object.freeze({ id: 'savings', label: 'More savings',
    description: 'Retain 100% of the best conservative saving within the configured comfort limits.',
    retainedBenefitFraction: 1 }),
]);

export function heatingStrategy(value = DEFAULT_HEATING_STRATEGY) {
  const strategy = HEATING_STRATEGIES.find(candidate => candidate.id === value);
  if (!strategy) throw new Error('Savings strategy must be gentle, balanced or savings');
  return strategy;
}

/** Explicit installation/one-cycle policy overrides; never fitted coefficients. */
export function heatingEconomics(config = {}) {
  return {
    minimumHomeBenefitCents:config.minimumHomeBenefitCents??0,
    homeDiscomfortCentsPerDegreeSquaredHour:config.homeDiscomfortCentsPerDegreeSquaredHour??0,
    cycleStartCostCents:config.cycleStartCostCents??0,
    cycleHourCostCents:config.cycleHourCostCents??0,
    economicUncertaintyFloorCents:config.economicUncertaintyFloorCents??0,
  };
}
