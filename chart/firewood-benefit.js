import { timingPercent } from './timing-model.js';

const finite = Number.isFinite;
const euro = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const amount = value => value !== 0 && Math.abs(value) < 0.005 ? `${value < 0 ? '−' : '+'}<€0.01` : euro.format(Object.is(value, -0) ? 0 : value);
const number = (value, digits = 1) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: digits }).format(value);
const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', year: 'numeric', month: 'short',
  day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' });
const dateSpan = (from, to, title) => finite(from) && finite(to)
  ? `${title}: ${dateTime.format(from)} – ${dateTime.format(to)}.` : null;
const reasons = {
  'no-firewood-history': 'No firewood has been recorded for this calculation.',
  'no-firewood': 'No logged firewood contributes heat during these dates.',
  'no-journal': 'Recorded learning history is needed to estimate the heating electricity displaced by firewood.',
  'missing-learning-history': 'Recorded learning history is needed to estimate the heating electricity displaced by firewood.',
  'missing-prices': 'Electricity prices are missing for the relevant heating intervals.',
  'missing-model': 'A reconstructible house model is needed before a cost estimate is available.',
  'no-covered-intervals': 'The selected dates do not contain supported heating and price intervals.',
  'no-elapsed-time': 'The selected dates have not elapsed yet.',
  'offline-history': 'Imported history has no corresponding manual firewood records.',
};

export const firewoodExplanations = [
  'Firewood compares estimated heating electricity with and without the logged wood under the same house conditions. This is a retrospective model comparison, not a meter reading or a replay of historical controller choices.',
  'Heating and Charging instead reprice the same electricity against each day’s average price. Their timing differences and the Firewood estimate have different baselines and are not added together.',
  'Wood cost is set to €0. The estimate excludes the cost of buying wood, labour and other fireplace costs. Negative electricity prices can make avoided electricity cost negative.',
];

/** Present only the backend's selected-period estimate. Never infer savings from
 * kilograms, today's coefficient, or the neighbouring timing-comparison cards. */
export function firewoodDisplay(result, payload = {}) {
  result ??= {};
  const status = ['provisional', 'validated'].includes(result.status) ? result.status : 'unavailable';
  const available = status !== 'unavailable' && finite(result.valueEuro);
  const coverage = result.coverage ?? {};
  const coverageKnown = finite(coverage.includedMs) && finite(coverage.elapsedMs) && coverage.elapsedMs >= 0;
  const ratio = coverageKnown && coverage.elapsedMs > 0 ? Math.max(0, Math.min(1, coverage.includedMs / coverage.elapsedMs)) : 0;
  const range = result.range ?? payload.range ?? {};
  const woodCost = finite(result.woodCostEuro) ? result.woodCostEuro : 0;
  const estimateRange = result.estimateRange;
  const loads = result.loads ?? {};
  const remaining = result.remaining;
  const remainingValue = remaining?.status !== 'unavailable' && finite(remaining?.valueEuro) ? remaining.valueEuro : null;
  const remainingEnergy = remaining?.status !== 'unavailable' && finite(remaining?.kwh) ? remaining.kwh : null;
  const statusLabel = status === 'validated' ? 'Validated model estimate' : status === 'provisional' ? 'Provisional model estimate' : 'Estimate unavailable';
  const evidence = result.evidence ?? {};
  const evidenceLines = [];
  if (finite(evidence.trainingBurns) || finite(evidence.validationBurns)) evidenceLines.push(`${evidence.trainingBurns ?? 0} training firing groups; ${evidence.validationBurns ?? 0} later validation groups.`);
  if (typeof evidence.thermalValidated === 'boolean') evidenceLines.push(`House-temperature response: ${evidence.thermalValidated ? 'validated' : 'awaiting validation'}.`);
  if (typeof evidence.fireplaceValidated === 'boolean') evidenceLines.push(`Fireplace response: ${evidence.fireplaceValidated ? 'validated' : 'awaiting validation'}.`);
  if (typeof evidence.electricalValidated === 'boolean') evidenceLines.push(`Heating-electricity response: ${evidence.electricalValidated ? 'validated' : 'awaiting validation'}.`);
  if (finite(evidence.independentBurns)) evidenceLines.push(`${evidence.independentBurns} independent firing groups across ${evidence.independentDays ?? 0} later days${finite(evidence.normalObservedHours) ? `; ${number(evidence.normalObservedHours)} hours of observed normal heating` : ''}.`);
  if (finite(evidence.electricityRelativeError)) evidenceLines.push(`Later heating-electricity prediction error: ${number(evidence.electricityRelativeError * 100)}%.`);
  const through = Math.min(range.to, result.generatedAt ?? payload.now ?? range.to);
  return {
    key: 'firewood', name: 'Firewood', available, status, statusLabel,
    amount: available ? amount(result.valueEuro) : null,
    outcome: available ? result.valueEuro < 0 ? 'estimated electricity cost increase' : 'estimated electricity cost avoided' : null,
    electricity: finite(result.electricityAvoidedKwh) && status !== 'unavailable'
      ? `${number(result.electricityAvoidedKwh)} kWh electricity avoided` : 'Electricity avoided: unavailable',
    uncertainty: available && finite(estimateRange?.lowerEuro) && finite(estimateRange?.upperEuro)
      ? `Estimate range ${euro.format(estimateRange.lowerEuro)}–${euro.format(estimateRange.upperEuro)}; not a statistical confidence interval.` : null,
    unavailableReason: reasons[result.reason] ?? (typeof result.reason === 'string' && result.reason.includes(' ') ? result.reason
      : 'A supported estimate needs recorded firewood, suitable heating history, a reconstructible model and applicable prices.'),
    coverageLabel: coverageKnown ? `${timingPercent(ratio)} of time included` : 'Coverage unavailable',
    coverageExplanation: !coverageKnown ? 'The service has not supplied a supported coverage interval.'
      : 'Only supported elapsed intervals enter this estimate. Missing observations or prices are excluded; the result is not scaled up to fill gaps.',
    coverageSummary: coverageKnown && coverage.elapsedMs > coverage.includedMs ? 'Some elapsed periods are excluded from the estimate.' : null,
    calculationPeriod: finite(through) && finite(range.from) && through <= range.from ? 'The selected dates have not elapsed yet.' : dateSpan(range.from, through, 'Elapsed selection'),
    coveredPeriod: dateSpan(coverage.firstAt, coverage.lastAt, 'Included intervals span'),
    woodCost: `Wood cost: ${euro.format(woodCost)}`,
    loads: finite(loads.kg) && finite(loads.count)
      ? `${number(loads.kg)} kg in ${loads.count} ${loads.count === 1 ? 'addition' : 'additions'} during the selected dates.` : 'Recorded amount for these dates is unavailable.',
    loadExplanation: 'Heat from earlier additions can continue into this selection. Mistaken additions are excluded using their recorded corrections.',
    assumptions: Array.isArray(result.assumptions) ? result.assumptions.filter(value => typeof value === 'string') : [],
    evidence: evidenceLines,
    statusExplanation: status === 'validated'
      ? 'The response has passed the required model checks. This remains an estimate of an unobserved alternative.'
      : 'Initial or incompletely validated response assumptions remain in use. This estimate does not establish metered savings or authorize heating reductions.',
    remaining: remaining ? {
      label: 'Expected remaining contribution',
      energy: remainingEnergy !== null ? `${number(remainingEnergy)} kWh estimated electricity still avoidable` : null,
      amount: remainingValue !== null ? `${amount(remainingValue)} estimated electricity cost still avoidable` : null,
      fuel: finite(remaining.kgEquivalent) ? `${number(remaining.kgEquivalent, 2)} kg of fuel-equivalent release remaining` : null,
      through: finite(remaining.through) ? `Calculated through ${dateTime.format(remaining.through)}.` : null,
      reason: typeof remaining.reason === 'string' ? remaining.reason.trim() || null : null,
      explanation: 'Expected heat release after the selected calculation period is separate from the figures above. It is not yet realised savings.',
      unavailable: remainingValue === null && remainingEnergy === null ? 'Remaining electricity and cost impact are not yet available.' : null,
    } : null,
  };
}
