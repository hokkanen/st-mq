const finite = Number.isFinite;
const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
const euro = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' });
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' });

export const timingSources = {
  measured: { label: 'Meter-based', short: 'metered', explanation: 'Uses this device’s dedicated power readings, integrated between samples to estimate energy.' },
  observed: { label: 'Operation estimate', short: 'operation estimate', explanation: 'Uses reported compressor activity and configured component powers. Energy is estimated, not separately metered.' },
  recorded: { label: 'Recorded energy estimate', short: 'recorded energy', explanation: 'Uses reported active power or recorded voltage and current, integrated over each saved interval. Phase allocation and energy remain estimates; cumulative meter checks do not revise this history.' },
  modelled: { label: 'Model-based', short: 'modelled', explanation: 'Uses the thermal model’s predicted running fraction from indoor and outdoor conditions. This does not confirm that the heat pump ran or used this energy.' },
  currents: { label: 'Current estimate', short: 'current estimate', explanation: 'Uses phase-current readings at 230 V to estimate power. This is not a direct active-power or energy measurement.' },
  unknown: { label: 'Basis unrecorded', short: 'basis unrecorded', explanation: 'The stored power value does not say how it was measured or estimated. Its basis cannot be classified now.' },
  simulated: { label: 'Simulated', short: 'simulated', explanation: 'Uses simulated input, not measured household consumption.' },
};

/** Explanations shared by both devices and shown below their results. */
export const timingExplanations = {
  comparison: [
    'Each day’s included energy is priced twice: at the times in its history, and at the full day’s time-weighted average all-in price. The daily differences are added together.',
    'Positive means cheaper timing; negative means dearer timing. Gaps are excluded, and the amount is not scaled up to cover them. This comparison does not prove savings caused by the controller.',
  ],
  coverage: [
    'Heating coverage is the share of elapsed time included, including valid zero-use periods. Charger coverage is the share of detected charging included; idle periods are left out. Even 100% can have gaps in charger data: missing readings are unknown, not idle.',
    'Today runs from Finnish midnight to the calculation time. Future hours do not reduce coverage, but the price average still covers the full day. It needs complete historical spot prices and recorded or assumed contract rates.',
    'Assumed rates do not reduce coverage or fill gaps in energy and spot-price history. Unavailable means there is no supported total, not zero energy use or zero timing difference. Historical gaps may remain.',
  ],
  evidence: [
    'Energy sources here describe how consumption was measured or estimated. Their percentages are shares of included time (charging time for the charger), not shares of energy or measures of accuracy.',
    'Historical values keep their recorded basis; today’s sensors do not reclassify them. Dates span contributing records and can contain gaps. Rounded shares may not add to 100%.',
  ],
  rates: [
    'When dated contract rates are missing, the nearest known contract rates are used with the original historical spot prices. Dates before the first rate record use the earliest known rates, which may be today’s.',
    'Contract charges and VAT may have differed. Assumed rates can affect both the included energy’s price and the full-day average.',
  ],
};

export function timingPercent(share) {
  if (!finite(share) || share <= 0) return '0%';
  if (share < 0.01) return '<1%';
  if (share < 1 && Math.round(share * 100) === 100) return '>99%';
  return `${Math.round(Math.min(1, share) * 100)}%`;
}

function duration(ms) {
  if (!finite(ms) || ms <= 0) return '0 minutes';
  if (ms < 60_000) return 'less than a minute';
  const unit = ms < 3_600_000 ? 'minute' : 'hour';
  const amount = number.format(ms / (unit === 'minute' ? 60_000 : 3_600_000));
  return `${amount} ${unit}${amount === '1' ? '' : 's'}`;
}

function span(from, to, prefix) {
  if (!finite(from) || !finite(to)) return null;
  return `${prefix}: ${dateTime.format(from)}${from === to ? '' : ` – ${dateTime.format(to)}`}.`;
}

function sourcesFor(result) {
  const order = ['measured', 'observed', 'recorded', 'modelled', 'currents', 'unknown', 'simulated'];
  const sources = (result.evidence?.sources ?? []).filter(source => source.durationMs > 0 && source.share > 0)
    .map(source => ({ ...source, key: timingSources[source.key] ? source.key : 'unknown' }))
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  // Old API responses have no per-sample provenance. Never infer it from today's sensors.
  return sources.length ? sources : finite(result.value) ? [{ key: 'unknown', share: 1, durationMs: result.coverageDetails?.includedMs }] : [];
}

/** Copy is driven only by metadata for the selected calculation, never live device state. */
export function timingDisplay(key, result = {}, payload = {}) {
  result ??= {};
  const charger = key === 'charger';
  const name = charger ? 'Charger' : 'Heat pump';
  const includedTimeLabel = charger ? 'included charging time' : 'included time';
  const available = finite(result.value);
  const coverage = result.coverageDetails ?? {};
  const sources = sourcesFor(result);
  const energyBasis = result.evidence?.energyBasis;
  const reconstructed = key === 'heatPump' && energyBasis === 'reconstructed-equipment';
  const recorded = energyBasis === 'recorded-intervals' || energyBasis === 'recorded-and-legacy';
  const mixedTime = result.evidence?.timeBasis === 'mixed-recorded-time';
  const intervalTime = result.evidence?.timeBasis === 'recorded-interval-time' || reconstructed || recorded;
  const dateBasis = mixedTime ? 'Contributing intervals and samples' : intervalTime ? 'Contributing intervals' : 'Contributing samples';
  const included = coverage.includedMs, elapsed = coverage.elapsedMs;
  const denominator = charger ? coverage.chargingMs : elapsed;
  const ratio = finite(included) && denominator > 0 ? included / denominator : result.coverage ?? 0;
  const now = payload.now, range = payload.range ?? {};
  const inProgress = finite(now) && finite(range.to) && now < range.to && (elapsed > 0 || now > range.from);
  const today = inProgress && range.startDate === date.format(now) && range.endDate === range.startDate;
  const basis = sources.length > 1 ? 'Mixed basis' : sources.length ? timingSources[sources[0].key].label : null;
  const tiny = available && result.value !== 0 && Math.abs(result.value) < 0.005;
  const amount = available ? tiny ? `${result.value < 0 ? '−' : '+'}<€0.01` : euro.format(Object.is(result.value, -0) ? 0 : result.value) : null;
  const calculationPeriod = span(coverage.from ?? range.from, coverage.to ?? Math.min(range.to, now), 'Calculation period (Finnish time)');
  const smallDifferenceExplanation = available && Math.abs(result.value) < 0.005
    ? result.value === 0
      ? 'The calculated timing difference is zero; energy use can still be nonzero.'
      : 'The difference is less than half a cent. The sign shows cheaper (+) or dearer (−) timing.'
    : null;

  const energyExplanation = available
    ? key === 'heatPump' ? reconstructed
      ? 'Energy for space heating and domestic hot water is reconstructed from recorded equipment operation and dated nominal powers. Model predictions and requested modes cannot fill missing equipment evidence. Whole-house power is not used.'
      : 'Energy uses dedicated heat-pump power where available, then reported compressor activity with configured powers, then the thermal model’s predicted running fraction. Auxiliary heating is assessed separately; whole-house power is not used.'
      : recorded
        ? `Energy is estimated from the original recorded electrical intervals${energyBasis === 'recorded-and-legacy' ? ' and older phase-current samples' : ''}. Cumulative meter checks do not revise this history.`
        : 'Uses the recorded sources below; estimates are not direct energy measurements.'
    : key === 'heatPump' ? reconstructed
      ? 'Needs recorded compressor activity, verified auxiliary output and dated nominal powers. Model predictions and requested modes cannot fill missing equipment evidence. Whole-house power is not used.'
      : 'Needs dedicated heat-pump power readings or saved heat-pump estimates. Whole-house power is not used.'
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

  const chargingRule = charger ? `Charging means average power above ${number.format((coverage.minimumPowerKw ?? 0.1) * 1000)} W. ` : '';
  const coverageExplanation = reconstructed
    ? 'Includes periods with valid, fresh equipment observations, dated nominal powers and complete daily prices. Missing, stale or unverified equipment states are excluded.'
    : recorded
      ? `${chargingRule}Includes ${charger ? 'detected charging' : 'usable recorded energy'} with complete daily prices. Saved energy intervals are used without extending into gaps.${energyBasis === 'recorded-and-legacy' ? ' Older power samples are held for at most 30 minutes.' : ''}`
      : `${chargingRule}Includes ${charger ? 'detected charging' : 'usable recorded power'} with complete daily prices.${charger ? '' : ' Recorded estimates and modelled values count.'} Power samples are held for at most 30 minutes.`;
  const coverageSummary = finite(included) && (charger ? finite(coverage.chargingMs) : elapsed >= 0)
    ? charger
      ? `Included: ${duration(included)} out of ${duration(coverage.chargingMs)} detected charging. Charging excluded for incomplete daily prices: ${duration(coverage.incompletePriceMs)}. Idle: ${duration(coverage.idleMs)}. Unknown (no usable readings): ${duration(coverage.missingPowerMs)}.`
      : `Included: ${duration(included)} out of ${duration(elapsed)} elapsed. Missing power: ${duration(coverage.missingPowerMs)}. Power available, but full-day prices missing: ${duration(coverage.incompletePriceMs)}. These groups do not overlap.`
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

  const periodLabel = inProgress ? today ? 'Today so far' : 'Period in progress' : available && result.provisional ? 'Partial data' : null;
  const periodExplanation = periodLabel ? inProgress
    ? 'The selection is still in progress. The comparison stops at the calculation time; later hours may change the total.'
    : 'The total covers only included periods. Missing history is not extrapolated.'
    : null;
  return { key, name, available, noChargingDetected, amount, outcome: 'timing difference', basis, sources: sourceDetails,
    coverageLabel: charger && coverage.chargingMs === 0 ? 'No charging time to compare'
      : `${timingPercent(ratio)} of ${charger ? 'detected charging' : 'time'} included`,
    includedTimeLabel, coverageHeading: charger ? 'Charging included' : 'Time included', assumedRates,
    periodLabel, unavailableReason, calculationPeriod, energyExplanation, coverageExplanation, coverageSummary,
    periodExplanation, smallDifferenceExplanation, availablePowerPeriod, auxiliaryNotes, evidenceExplanation,
    rateSummary, ratePeriod };
}
