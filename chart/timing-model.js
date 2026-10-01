const finite = Number.isFinite;
const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
const euro = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const preciseEuro = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 4 });
const energy = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 });
const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' });
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' });

export const timingSources = {
  measured: { label: 'Meter-based', short: 'metered', explanation: 'Uses qualified dedicated electrical intervals with their recorded measurement basis.' },
  observed: { label: 'Operation estimate', short: 'operation estimate', explanation: 'Uses reported compressor activity and configured component powers. Energy is estimated, not separately metered.' },
  recorded: { label: 'Recorded energy estimate', short: 'recorded energy', explanation: 'Uses reported active power or recorded voltage and current, integrated over each saved interval. Phase allocation and energy remain estimates; cumulative meter checks do not revise this history.' },
  currents: { label: 'Current estimate', short: 'current estimate', explanation: 'Uses phase-current readings with the historical per-phase voltage estimates and assumes unity power factor. This is not a direct active-power or energy measurement.' },
  'retrospective-currents': { label: 'Retrospective current estimate', short: 'retrospective estimate', explanation: 'CSV current history before voltage recording uses the first established per-phase voltage estimates retrospectively and assumes unity power factor. The original currents remain unchanged; voltage and energy are not measurements of that earlier period.' },
  unknown: { label: 'Basis unrecorded', short: 'basis unrecorded', explanation: 'The stored power value does not say how it was measured or estimated. Its basis cannot be classified now.' },
  simulated: { label: 'Simulated', short: 'simulated', explanation: 'Uses simulated input, not measured household consumption.' },
};

/** Explanations shared by both devices and shown below their results. */
export const timingExplanations = {
  comparison: [
    'Each day’s included energy is priced twice: at the recorded times, and at the full day’s time-weighted average all-in price. The daily differences are added together.',
    'Positive means cheaper timing; negative means dearer timing. The amount is not scaled up for gaps and does not prove savings caused by the controller.',
  ],
  coverage: [
    '“Time included” uses elapsed time for heating and each charger. Combined charging uses charger-time: an hour on each charger counts twice. Heating Total uses combined system-time: an hour on Home and an hour on Garage also count twice. Heating includes valid zero-use periods; charging excludes idle periods. Missing readings are unknown, not idle.',
    'Today runs from Finnish midnight to the calculation time. Future hours do not reduce the percentage, but the price average still needs the full day’s prices. Unavailable means there is no supported total, not zero energy use.',
  ],
  evidence: [
    'Energy-source and assumed-rate percentages are shares of included time, not energy or accuracy. Source labels keep their recorded basis; today’s sensors do not reclassify them. Date spans can contain gaps. Rounded shares may not add to 100%.',
  ],
  rates: [
    'When dated contract rates are missing, the nearest known contract rates are used with the original historical spot prices. Dates before the first rate record use the earliest known rates.',
    'Historical charges and VAT may have differed. Assumed rates can affect both the included energy’s price and the full-day average, but do not fill gaps in energy or spot-price history.',
  ],
};

export function timingPercent(share) {
  if (!finite(share) || share <= 0) return '0%';
  if (share < 0.01) return '<1%';
  if (share < 1 && Math.round(share * 100) === 100) return '>99%';
  return `${Math.round(Math.min(1, share) * 100)}%`;
}

/** Keep small, nonzero amounts distinct from zero in every comparison scope. */
export function comparisonAmount(value) {
  return value !== 0 && Math.abs(value) < 0.005
    ? `${value < 0 ? '−' : '+'}<€0.01` : euro.format(Object.is(value, -0) ? 0 : value);
}

/** Extra precision makes the subtraction reviewable without rounding its inputs first. */
export function comparisonCost(value) {
  return value !== 0 && Math.abs(value) < 0.00005
    ? `${value < 0 ? '−' : '+'}<€0.0001` : preciseEuro.format(Object.is(value, -0) ? 0 : value);
}

function span(from, to, prefix) {
  if (!finite(from) || !finite(to)) return null;
  return `${prefix}: ${dateTime.format(from)}${from === to ? '' : ` – ${dateTime.format(to)}`}.`;
}

function sourcesFor(result) {
  const order = ['measured', 'observed', 'recorded', 'currents', 'retrospective-currents', 'unknown', 'simulated'];
  return (result.evidence?.sources ?? []).filter(source => source.durationMs > 0 && source.share > 0 && timingSources[source.key])
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

/** Copy is driven only by metadata for the selected calculation, never live device state. */
export function timingDisplay(key, result = {}, payload = {}) {
  result ??= {};
  const charger = ['charger','charger1','charger2'].includes(key);
  const name = key === 'charger1' ? 'Charger 1' : key === 'charger2' ? 'Charger 2' : charger ? 'Charging' : 'Heating';
  const combined = result.coverageDetails?.coverageBasis === 'charger-time';
  const combinedSystems = result.coverageDetails?.coverageBasis === 'combined-system-time';
  const includedTimeLabel = combined ? 'included charger-time' : combinedSystems ? 'included system-time' : 'included time';
  const coverage = result.coverageDetails ?? {};
  const energyBasis = result.evidence?.energyBasis;
  const reconstructed = key === 'heatPump';
  const recorded = energyBasis === 'recorded-intervals' || energyBasis === 'recorded-and-legacy';
  const combinedHeating = key === 'totalHeatPump' && energyBasis === 'separate-system-intervals';
  const currentBasis = reconstructed ? energyBasis === 'reconstructed-equipment' : combinedHeating || recorded || energyBasis === 'power-snapshots';
  const sources = currentBasis ? sourcesFor(result) : [];
  const available = finite(result.value) && currentBasis && coverage.includedMs > 0 && (sources.length > 0 || combinedHeating);
  const mixedTime = result.evidence?.timeBasis === 'mixed-recorded-time';
  const intervalTime = result.evidence?.timeBasis === 'recorded-interval-time' || reconstructed || recorded;
  const dateBasis = mixedTime ? 'Contributing intervals and samples' : intervalTime ? 'Contributing intervals' : 'Contributing samples';
  const included = coverage.includedMs, elapsed = coverage.elapsedMs;
  const ratio = finite(included) && finite(elapsed)
    ? elapsed > 0 ? included / elapsed : 0
    : 0;
  const now = payload.now, range = payload.range ?? {};
  const inProgress = finite(now) && finite(range.to) && now < range.to && (elapsed > 0 || now > range.from);
  const today = inProgress && range.startDate === date.format(now) && range.endDate === range.startDate;
  const basis = sources.length > 1 ? 'Mixed basis' : sources.length ? timingSources[sources[0].key].label : null;
  const amount = available ? comparisonAmount(result.value) : null;
  const calculationPeriod = span(coverage.from ?? range.from, coverage.to ?? Math.min(range.to, now), 'Calculation period (Finnish time)');
  const smallDifferenceExplanation = available && Math.abs(result.value) < 0.005
    ? result.value === 0
      ? 'The calculated timing difference is zero; energy use can still be nonzero.'
      : 'The difference is less than half a cent. The sign shows cheaper (+) or dearer (−) timing.'
    : null;

  const energyExplanation = available
    ? reconstructed
      ? 'Energy for space heating and domestic hot water is reconstructed from recorded equipment operation and dated nominal powers. The Home model comparison instead uses a temperature-dependent electrical estimate for completed space-heating cycles, so its energy and cost need not match this timing view. Model predictions and requested modes cannot fill missing equipment evidence. Whole-house power is not used.'
      : recorded
        ? `Energy is estimated from the original recorded electrical intervals${energyBasis === 'recorded-and-legacy' ? ' and older phase-current samples' : ''}. Cumulative meter checks do not revise this history.`
        : 'Uses the recorded sources below; estimates are not direct energy measurements.'
    : reconstructed
      ? 'Needs recorded compressor activity, verified auxiliary output and dated nominal powers. Model predictions and requested modes cannot fill missing equipment evidence. Whole-house power is not used.'
      : recorded
        ? `Needs recorded electrical intervals${energyBasis === 'recorded-and-legacy' ? ' or older phase-current samples' : ''} showing charging.`
        : 'Needs usable charger power readings or estimates showing charging.';

  const evidenceExplanation = mixedTime
    ? 'Dates cover original intervals and older power samples.'
    : intervalTime
      ? 'Dates show the original interval boundaries.'
      : 'Dates show the first and last contributing power samples.';
  const sourceDetails = sources.map(source => ({ ...source, ...timingSources[source.key],
    ...(reconstructed && source.key === 'observed' ? { explanation: 'Uses recorded compressor activity, verified auxiliary output and dated nominal compressor, circulation and auxiliary powers. Energy is estimated, not separately metered.' } : {}),
    percentage: timingPercent(source.share), dates: span(source.firstAt, source.lastAt, dateBasis) }));
  const auxiliary = result.evidence ?? {};
  const auxiliaryNotes = [];
  if (key === 'heatPump' && auxiliary.auxiliaryAssumedMs > 0) auxiliaryNotes.push(`Auxiliary heater output was assumed during ${timingPercent(auxiliary.auxiliaryAssumedShare)} of included time. This overlaps the sources above; do not add it to their shares.`);
  if (key === 'heatPump' && auxiliary.auxiliaryUnknownMs > 0) auxiliaryNotes.push(`The auxiliary heater’s observed or assumed basis was not recorded for ${timingPercent(auxiliary.auxiliaryUnknownShare)} of included time.`);

  const chargingRule = charger ? `Average power at or below ${number.format((coverage.minimumPowerKw ?? 0.1) * 1000)} W counts as idle and is excluded. ` : '';
  const coverageExplanation = reconstructed
    ? 'Includes periods with valid, fresh equipment observations, dated nominal powers and complete daily prices. Missing, stale or unverified equipment states are excluded.'
    : recorded
      ? `${chargingRule}Includes ${charger ? 'charging periods' : 'usable recorded energy'} with complete daily prices. Saved energy intervals are used without extending into gaps.${energyBasis === 'recorded-and-legacy' ? ' Older power samples are held for at most 30 minutes.' : ''}`
      : `${chargingRule}Includes charging periods with complete daily prices. Coherent current snapshots are held for at most 30 minutes.`;
  const missingHistory = coverage.missingPowerMs > 0;
  const missingPrices = coverage.incompletePriceMs > 0;
  const coverageSummary = missingHistory && missingPrices
    ? 'Some periods are excluded because device history or daily prices are incomplete.'
    : missingHistory
      ? 'Some periods are excluded because device history is missing.'
      : missingPrices
        ? 'Some periods are excluded because daily prices are incomplete.'
        : null;

  const assumptions = result.priceAssumptions ?? {};
  const assumedRates = available && Boolean(result.assumedPrices || assumptions.durationMs > 0);
  const rateSummary = assumedRates && finite(assumptions.share)
    ? `${timingPercent(assumptions.share)} of ${includedTimeLabel} uses assumed rates in its own price or the full-day average.`
    : null;
  const rateSpan = assumedRates ? span(assumptions.firstAt, assumptions.lastAt, 'Affected included periods') : null;
  const ratePeriod = rateSpan ? `${rateSpan} Gaps may exist within this span.` : null;

  const noChargingDetected = charger && !available && coverage.chargingMs === 0
    && coverage.idleMs > 0 && coverage.missingPowerMs === 0;
  let unavailableReason = 'Energy and full-day prices needed';
  if (elapsed === 0) unavailableReason = 'No elapsed time in this selection';
  else if (coverage.powerMs === 0) unavailableReason = 'No usable device power history';
  else if (noChargingDetected) unavailableReason = 'No charging detected';
  else if (charger && coverage.chargingMs === 0) unavailableReason = 'No charging detected in available data';
  else if (coverage.powerMs > 0 && included === 0) unavailableReason = 'Full-day prices missing';
  const powerSpan = !available ? span(coverage.firstPowerAt, coverage.lastPowerAt, intervalTime ? 'Available energy periods' : 'Available power samples') : null;
  const availablePowerPeriod = powerSpan ? `${powerSpan} Gaps may exist between them.` : null;

  const periodLabel = inProgress ? today ? 'Today so far' : 'Period in progress'
    : available && (missingHistory || missingPrices) ? 'Partial data' : null;
  const periodExplanation = periodLabel ? inProgress
    ? 'The selection is still in progress. The comparison stops at the calculation time; later hours may change the total.'
    : 'The total covers only included periods. Missing history is not extrapolated.'
    : null;
  const breakdown = combined ? ['Two physical chargers; one simultaneous hour is two charger-hours. Missing Charger 2 history remains unknown, including v0.7.5 imports.',
    ...['charger1','charger2'].map(id => {
      const display = timingDisplay(id, payload.timingBenefit?.[id], payload);
      return `${display.name}: ${display.amount ?? 'Unavailable'}; ${display.coverageLabel}.`;
    })] : [];
  const reconciliation = available ? [
    finite(result.energyKwh) ? { label: 'Included electricity', value: `${energy.format(result.energyKwh)} kWh` } : null,
    finite(result.uniformCostEuro) ? { label: 'Cost at daily average prices', value: comparisonCost(result.uniformCostEuro) } : null,
    finite(result.actualCostEuro) ? { label: 'Cost at recorded times', value: comparisonCost(result.actualCostEuro) } : null,
    { label: 'Timing difference', value: comparisonCost(result.value) },
  ].filter(Boolean) : [];
  return { key, name, available, noChargingDetected, amount, outcome: 'timing difference', basis, sources: sourceDetails,
    coverageLabel: `${timingPercent(ratio)} of ${combined ? 'charger-time' : combinedSystems ? 'combined system time' : 'time'} included`,
    includedTimeLabel, coverageHeading: combined ? 'Charger-time included' : combinedSystems ? 'System-time included' : 'Time included', assumedRates, breakdown,
    periodLabel, unavailableReason, calculationPeriod, energyExplanation, coverageExplanation, coverageSummary,
    periodExplanation, smallDifferenceExplanation, availablePowerPeriod, auxiliaryNotes, evidenceExplanation,
    rateSummary, ratePeriod, reconciliation,
    reconciliationExplanation: 'Cost at daily average prices minus cost at recorded times gives the timing difference. Calculations use unrounded values; displayed amounts may not add exactly.' };
}

/** Stable card identity; values and coverage always come from the chosen meter scope. */
export function chargingTimingDisplay(payload, scope = 'total') {
  if (!['charger1', 'charger2', 'total'].includes(scope)) throw new RangeError('Choose Charger 1, Charger 2 or Total.');
  const key = scope === 'total' ? 'charger' : scope;
  return { ...timingDisplay(key, payload?.timingBenefit?.[key], payload), key: 'charger', name: 'Charging', scope };
}
