const finite = Number.isFinite;
const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
const euro = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' });
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' });

export const timingSources = {
  measured: { label: 'Meter-based', short: 'metered', explanation: 'A dedicated power reading for this device was used. This is the closest available basis to measured consumption; energy is still integrated between readings.' },
  observed: { label: 'Operation estimate', short: 'operation estimate', explanation: 'Compressor activity was reported by the heat pump. Electrical power was estimated from that activity and configured component powers; it was not separately metered.' },
  recorded: { label: 'Recorded energy estimate', short: 'recorded energy', explanation: 'Energy was integrated from reported active power or recorded voltage and current readings over each saved interval. Phase allocation and integration between readings remain estimates. Cumulative meter checks do not correct this energy history.' },
  modelled: { label: 'Model-based', short: 'modelled', explanation: 'Compressor activity was not known. The thermal model predicted a running fraction from indoor and outdoor conditions. These periods do not establish that the heat pump actually ran or consumed this energy.' },
  currents: { label: 'Current estimate', short: 'current estimate', explanation: 'Charger power was estimated from phase-current readings at 230 V. This is not a direct measurement of active power or energy.' },
  unknown: { label: 'Basis unrecorded', short: 'basis unrecorded', explanation: 'A historical power value exists, but its measurement or estimation basis was not recorded. It cannot now be classified as metered, observed operation or a model prediction.' },
  simulated: { label: 'Simulated', short: 'simulated', explanation: 'These values come from simulated input. They do not represent measured household consumption or actual savings.' },
};

/** Explanations shared by both devices and shown below their results. */
export const timingExplanations = {
  comparison: [
    'For each included day, the same calculated device energy is priced two ways: at the times assigned to it, and at that whole day’s time-weighted average all-in price. The daily differences are added together.',
    'Positive means cheaper timing; negative means dearer timing. Missing periods are excluded, and the amount is not scaled up to cover them. This comparison does not prove savings caused by the controller.',
  ],
  coverage: [
    'Time included is the share of the selected elapsed time that supports a comparison. Valid zero-consumption values count, as do supported estimates. It does not describe how often the device ran, how much energy was measured, or certainty about energy or savings.',
    'For today, elapsed time runs from Finnish midnight to the calculation time. For other unfinished selections, only the elapsed part is counted. Future hours do not reduce the percentage.',
    'Each included day needs complete historical spot prices and either recorded or assumed contract rates. Assumed rates do not by themselves reduce time coverage. They cannot fill missing spot prices or device energy history.',
    'An unavailable comparison has no supported total; unavailable does not mean zero consumption or zero timing difference. Historical gaps may remain permanently; partial data does not promise that more data will arrive.',
  ],
  evidence: [
    'Energy-basis shares describe included time, weighted by duration. They are not percentages of readings, consumed energy, charging time or accuracy.',
    'Historical values keep their recorded basis; today’s sensors do not reclassify them. Gaps can exist between the contributing dates, and rounded shares may not add to exactly 100%.',
  ],
  rates: [
    'Where dated historical contract rates are missing, the nearest known contract rates are combined with each period’s historical spot price. For dates before the first recorded rates, this uses the earliest known rates, which may be today’s rates.',
    'Contract charges and VAT may have differed at the time. The timing difference depends on these assumptions, including any assumed rates used in the full-day average. The historical spot prices are not replaced by today’s spot price.',
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
  if (ms < 3_600_000) return `${number.format(ms / 60_000)} minutes`;
  return `${number.format(ms / 3_600_000)} hours`;
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
  const name = key === 'heatPump' ? 'Heat pump' : 'Charger';
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
  const ratio = finite(included) && elapsed > 0 ? included / elapsed : result.coverage ?? 0;
  const now = payload.now, range = payload.range ?? {};
  const inProgress = finite(now) && finite(range.to) && now < range.to && (elapsed > 0 || now > range.from);
  const today = inProgress && range.startDate === date.format(now) && range.endDate === range.startDate;
  const basis = sources.length > 1 ? 'Mixed basis' : sources.length ? timingSources[sources[0].key].label : null;
  const tiny = available && result.value !== 0 && Math.abs(result.value) < 0.005;
  const amount = available ? tiny ? `${result.value < 0 ? '−' : '+'}<€0.01` : euro.format(Object.is(result.value, -0) ? 0 : result.value) : null;
  const calculationPeriod = span(coverage.from ?? range.from, coverage.to ?? Math.min(range.to, now), 'Calculation period (Finnish time)');
  const smallDifferenceExplanation = available && Math.abs(result.value) < 0.005
    ? result.value === 0
      ? 'The calculated timing difference is €0.00. This does not prove zero energy use or zero actual savings.'
      : 'The calculated difference is smaller than half a cent; its sign still shows whether the timing was cheaper or dearer. This does not prove zero energy use or zero actual savings.'
    : null;

  const energyExplanation = available
    ? key === 'heatPump' ? reconstructed
      ? 'Heat-pump energy includes space heating and domestic hot water. It is reconstructed from recorded equipment operation using the dated powers described below. It is not household consumption minus charger consumption. Model predictions or a requested operating mode do not fill gaps in consumption evidence.'
      : 'Heat-pump energy first uses dedicated power, otherwise reported compressor activity with configured powers, and otherwise a predicted running fraction from the thermal model. Auxiliary heating is assessed separately. It is not household consumption minus charger consumption. Model predictions can enter this comparison even when actual compressor activity is unknown.'
      : recorded
        ? 'Charger energy uses the original recorded electrical intervals, with older phase-current snapshots where available. These are energy estimates; cumulative meter checks do not correct them.'
        : 'Charger energy uses the recorded basis shown here; current-based estimates are not a dedicated energy measurement.'
    : key === 'heatPump' ? reconstructed
      ? 'Recorded compressor activity, verified auxiliary output and dated nominal power assumptions are needed. Missing or stale equipment data cannot be replaced by a thermal model prediction, a requested operating mode or whole-house consumption minus the charger.'
      : 'A dedicated heat-pump power reading or a stored heat-pump power estimate is needed. Whole-house power is not attributed to the heat pump by subtracting the charger.'
      : recorded
        ? 'Usable recorded charger energy intervals are needed, including valid zero-energy intervals during non-charging periods. Older current snapshots can support their original historical periods.'
        : 'Usable charger power readings or estimates are needed, including zero readings during non-charging periods.';

  const evidenceExplanation = mixedTime
    ? 'Dates span the contributing recorded intervals and older stored power samples.'
    : intervalTime
      ? 'Dates show the original boundaries of contributing recorded intervals.'
      : 'Dates show the first and last contributing stored power samples.';
  const sourceDetails = sources.map(source => ({ ...source, ...timingSources[source.key],
    ...(reconstructed && source.key === 'observed' ? { explanation: 'Recorded compressor activity and verified auxiliary output are converted to electrical energy using the dated nominal compressor, circulation and auxiliary powers. This remains an estimate, not a separate electricity measurement.' } : {}),
    percentage: timingPercent(source.share), dates: span(source.firstAt, source.lastAt, dateBasis) }));
  const auxiliary = result.evidence ?? {};
  const auxiliaryNotes = [];
  if (key === 'heatPump' && auxiliary.auxiliaryAssumedMs > 0) auxiliaryNotes.push(`Auxiliary heater output was also assumed during ${timingPercent(auxiliary.auxiliaryAssumedShare)} of included time. This can overlap the compressor categories above; it is not an extra share to add to them.`);
  if (key === 'heatPump' && auxiliary.auxiliaryUnknownMs > 0) auxiliaryNotes.push(`Whether auxiliary heater output was observed or assumed was not recorded for ${timingPercent(auxiliary.auxiliaryUnknownShare)} of included time.`);

  const coverageExplanation = reconstructed
    ? 'Time is included only when recorded equipment states and dated nominal powers support a heat-pump energy estimate, and all-in prices cover the entire corresponding day. Equipment observations contribute only while their recorded coverage and freshness remain valid. Missing, stale or unverified equipment states, missing power assumptions and days with incomplete prices are excluded.'
    : recorded
      ? `Time is included only when there is usable recorded energy and all-in prices for the entire corresponding day. Recorded energy contributes over its saved interval without extending into gaps.${energyBasis === 'recorded-and-legacy' ? ' Older power snapshots are carried forward for at most 30 minutes.' : ''} Missing or invalid energy intervals and days with incomplete prices are excluded.`
      : 'Time is included only when there is a usable device power value and all-in prices for the entire corresponding day. Estimated and modelled power values count where they form the recorded basis. Power values are carried forward for at most 30 minutes. Missing or invalid power values and days with incomplete prices are excluded.';
  const coverageSummary = elapsed >= 0 && finite(included)
    ? `Included: ${duration(included)} out of ${duration(elapsed)} elapsed. Excluded without usable power: ${duration(coverage.missingPowerMs)}. Excluded with power but incomplete daily prices: ${duration(coverage.incompletePriceMs)}. These groups do not overlap.`
    : null;

  const assumptions = result.priceAssumptions ?? {};
  const assumedRates = available && Boolean(result.assumedPrices || assumptions.durationMs > 0);
  const rateSummary = assumedRates && finite(assumptions.share)
    ? `${timingPercent(assumptions.share)} of included time depends on assumed rates in its own price or its day’s comparison average.`
    : null;
  const rateSpan = assumedRates ? span(assumptions.firstAt, assumptions.lastAt, 'Affected included periods') : null;
  const ratePeriod = rateSpan ? `${rateSpan} Gaps may exist within this span.` : null;

  let unavailableReason = 'Energy and full-day prices needed';
  if (elapsed === 0) unavailableReason = 'No elapsed time in this selection';
  else if (coverage.powerMs === 0) unavailableReason = 'No usable device power history';
  else if (coverage.powerMs > 0 && included === 0) unavailableReason = 'Full-day prices missing';
  const powerSpan = !available ? span(coverage.firstPowerAt, coverage.lastPowerAt, intervalTime ? 'Available energy periods' : 'Available power samples') : null;
  const availablePowerPeriod = powerSpan ? `${powerSpan} Gaps may exist between them.` : null;

  const periodLabel = inProgress ? today ? 'Today so far' : 'Period in progress' : available && result.provisional ? 'Partial data' : null;
  const periodExplanation = periodLabel ? inProgress
    ? 'The selected period has not finished. The comparison stops at the calculation time; later hours may change the total. The amount is not extrapolated to missing hours.'
    : 'Some of the selected elapsed time could not enter the comparison. The displayed total covers only included periods and is not extrapolated to missing hours.'
    : null;
  return { key, name, available, amount, outcome: 'timing difference', basis, sources: sourceDetails,
    coverageLabel: `${timingPercent(ratio)} of time included`, assumedRates,
    periodLabel, unavailableReason, calculationPeriod, energyExplanation, coverageExplanation, coverageSummary,
    periodExplanation, smallDifferenceExplanation, availablePowerPeriod, auxiliaryNotes, evidenceExplanation,
    rateSummary, ratePeriod };
}
