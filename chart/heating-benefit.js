import { comparisonAmount, comparisonCost } from './timing-model.js';

const finite = Number.isFinite;
const euro = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', year: 'numeric', month: 'short',
  day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' });
const span = (from, to, title) => finite(from) && finite(to) && to > from
  ? `${title}: ${dateTime.format(from)} – ${dateTime.format(to)}.` : null;
const countLabel = (count, singular, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;

export const heatingExplanations = [
  'The heating model compares each assessed cycle’s estimated space-heating electricity cost with its modelled reference heating policy, including recovery. Home uses a temperature-dependent electrical estimate; its timing view instead uses dated nominal equipment powers and also includes domestic hot water. Domestic hot water is excluded from this model comparison.',
  'Each full cycle is counted on the date it finishes. Cycles can begin before the selected dates; unfinished, unsupported or invalidated assessments contribute no saving. This is a total for included cycles, not for every hour in the selection.',
  'These are saved cycle assessments using the model frozen for that cycle. They differ from the timing comparison, which keeps energy fixed and changes only its price benchmark, and from the retrospective Fireplace estimate. The amounts are not added together. This selected-period total also differs from Learning’s average euros per assessed cycle.',
];

/** Use the selected-cycle total, never the rolling €/cycle learning metric. */
export function heatingDisplay(result, payload = {}) {
  result ??= {};
  const available = result.status === 'estimated' && finite(result.valueEuro);
  const range = result.range ?? payload.range ?? {};
  const through = Math.min(range.to, result.generatedAt ?? payload.now ?? range.to);
  const counts = result.counts ?? {};
  const assessed = counts.assessed ?? 0;
  const bounds = result.estimateRange;
  const excluded = [
    counts.unassessed > 0 ? countLabel(counts.unassessed, 'completed cycle without a supported assessment', 'completed cycles without a supported assessment') : null,
    counts.incomplete > 0 ? countLabel(counts.incomplete, 'incomplete cycle') : null,
    counts.active > 0 ? countLabel(counts.active, 'cycle still in progress', 'cycles still in progress') : null,
  ].filter(Boolean);
  const reasons = {
    'no-elapsed-time': 'The selected dates have not elapsed yet.',
    'no-completed-cycles': 'No completed heating cycles are available for these dates. Choose Timing cost to explore the recorded energy comparison.',
    'no-assessed-cycles': 'Completed cycles have no supported savings assessment for these dates.',
  };
  return {
    key: 'heatPump', name: 'Heating', available,
    amount: available ? comparisonAmount(result.valueEuro) : null,
    outcome: available ? result.valueEuro < 0 ? 'estimated extra cost' : result.valueEuro > 0 ? 'estimated cost avoided' : 'estimated cost difference' : null,
    unavailableReason: reasons[result.reason] ?? 'A model estimate needs supported, completed heating-cycle assessments for the selected dates.',
    cycleSummary: `${countLabel(assessed, 'assessed cycle')} completed in the selection${counts.completed > assessed ? ` out of ${counts.completed} completed` : ''}.`,
    excludedSummary: excluded.length ? `Excluded: ${excluded.join('; ')}.` : null,
    calculationPeriod: through <= range.from ? 'The selected dates have not elapsed yet.' : span(range.from, through, 'Completion dates (Finnish time)'),
    coveredPeriod: span(result.firstStartedAt, result.lastEndedAt, 'Included cycles span'),
    periodExplanation: counts.startedBeforeSelection > 0
      ? `${countLabel(counts.startedBeforeSelection, 'included cycle')} began before the selected dates. Its full cost and recovery are included once, on completion.`
      : 'Full cycle costs are assigned to their completion date without splitting or scaling them to the selected hours.',
    uncertainty: available && finite(bounds?.lowerEuro) && finite(bounds?.upperEuro)
      ? `Estimate range ${euro.format(bounds.lowerEuro)}–${euro.format(bounds.upperEuro)}. This combines saved cycle uncertainty bounds; it is not a statistical confidence interval.` : null,
    reconciliation: available ? [
      finite(result.referenceCostEuro) ? { label: 'Modelled reference cost', value: comparisonCost(result.referenceCostEuro) } : null,
      finite(result.actualSpaceHeatingCostEuro) ? { label: 'Assessed heating cost', value: comparisonCost(result.actualSpaceHeatingCostEuro) } : null,
      { label: 'Estimated cost difference', value: comparisonCost(result.valueEuro) },
    ].filter(Boolean) : [],
    reconciliationExplanation: 'Modelled reference cost minus assessed heating cost gives the estimated cost difference for included completed cycles. Calculations use unrounded values; displayed amounts may not add exactly.',
  };
}
