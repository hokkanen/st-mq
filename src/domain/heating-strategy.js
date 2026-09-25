/** Named decision policies shared by Home and Garage. These coefficients govern
 * economic selection only; temperature, protection and learning gates stay separate. */
export const DEFAULT_HEATING_STRATEGY = 'balanced';
export const HEATING_STRATEGIES = Object.freeze([
  Object.freeze({ id: 'gentle', label: 'Gentle',
    description: 'Require a larger estimated benefit and favour shorter, milder changes.',
    minimumHomeBenefitCents: 50, homeDiscomfortCentsPerDegreeSquaredHour: 30,
    garageMinimumBenefitMultiplier: 1.5, retainedBenefitFraction: .6 }),
  Object.freeze({ id: 'balanced', label: 'Balanced',
    description: 'Balance worthwhile savings with the duration and effect of heating changes.',
    minimumHomeBenefitCents: 30, homeDiscomfortCentsPerDegreeSquaredHour: 17.5,
    garageMinimumBenefitMultiplier: 1, retainedBenefitFraction: .8 }),
  Object.freeze({ id: 'savings', label: 'More savings',
    description: 'Accept smaller estimated benefits and pursue more of each safe opportunity.',
    minimumHomeBenefitCents: 10, homeDiscomfortCentsPerDegreeSquaredHour: 5,
    garageMinimumBenefitMultiplier: .5, retainedBenefitFraction: 1 }),
]);

export function heatingStrategy(value = DEFAULT_HEATING_STRATEGY) {
  const strategy = HEATING_STRATEGIES.find(candidate => candidate.id === value);
  if (!strategy) throw new Error('Savings strategy must be gentle, balanced or savings');
  return strategy;
}
