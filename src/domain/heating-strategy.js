/** Named decision policies for Home heating. These coefficients govern
 * economic selection only; temperature, protection and learning gates stay separate. */
export const DEFAULT_HEATING_STRATEGY = 'savings';
export const HEATING_STRATEGIES = Object.freeze([
  Object.freeze({ id: 'gentle', label: 'Gentle',
    description: 'Require a larger estimated benefit and favour shorter, milder changes.',
    minimumHomeBenefitCents: 2, homeDiscomfortCentsPerDegreeSquaredHour: 5,
    retainedBenefitFraction: .6 }),
  Object.freeze({ id: 'balanced', label: 'Balanced',
    description: 'Balance worthwhile savings with the duration and effect of heating changes.',
    minimumHomeBenefitCents: 0, homeDiscomfortCentsPerDegreeSquaredHour: 0,
    retainedBenefitFraction: .8 }),
  Object.freeze({ id: 'savings', label: 'More savings',
    description: 'Pursue the greatest estimated benefit within the configured comfort limits.',
    minimumHomeBenefitCents: 0, homeDiscomfortCentsPerDegreeSquaredHour: 0,
    retainedBenefitFraction: 1 }),
]);

export function heatingStrategy(value = DEFAULT_HEATING_STRATEGY) {
  const strategy = HEATING_STRATEGIES.find(candidate => candidate.id === value);
  if (!strategy) throw new Error('Savings strategy must be gentle, balanced or savings');
  return strategy;
}

/** Explicit installation/one-cycle policy overrides; never fitted coefficients. */
export function heatingEconomics(config = {}, strategy) {
  const selected=heatingStrategy(strategy);
  return {
    minimumHomeBenefitCents:config.minimumHomeBenefitCents??selected.minimumHomeBenefitCents,
    homeDiscomfortCentsPerDegreeSquaredHour:config.homeDiscomfortCentsPerDegreeSquaredHour??selected.homeDiscomfortCentsPerDegreeSquaredHour,
    cycleStartCostCents:config.cycleStartCostCents??0,
    cycleHourCostCents:config.cycleHourCostCents??0,
    economicUncertaintyFloorCents:config.economicUncertaintyFloorCents??0,
  };
}
