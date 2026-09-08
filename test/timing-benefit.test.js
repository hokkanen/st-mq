import test from 'node:test';
import assert from 'node:assert/strict';
import { timingDisplay, timingExplanations, timingPercent } from '../chart/timing-model.js';

const from = Date.parse('2026-09-08T00:00:00+03:00');
const hour = 3_600_000;
const payload = { now: from + 10 * hour, range: { from, to: from + 24 * hour, startDate: '2026-09-08', endDate: '2026-09-08' } };
const result = {
  value: 0, coverage: 0.07, provisional: true,
  coverageDetails: { from, to: payload.now, elapsedMs: 10 * hour, includedMs: 0.7 * hour, powerMs: hour, missingPowerMs: 9 * hour, incompletePriceMs: 0.3 * hour },
  evidence: { sources: [{ key: 'modelled', share: 1, durationMs: 0.7 * hour, firstAt: from + 8 * hour, lastAt: from + 9 * hour }] },
};

test('today model-only zero comparison explicitly separates model basis from elapsed-time coverage', () => {
  const display = timingDisplay('heatPump', result, payload);
  assert.equal(display.amount, '€0.00');
  assert.equal(display.outcome, 'timing difference');
  assert.equal(display.basis, 'Model-based');
  assert.equal(display.sources[0].percentage, '100%');
  assert.equal(display.coverageLabel, '7% of time included');
  assert.equal(display.periodLabel, 'Today so far');
  assert.match(display.smallDifferenceExplanation, /does not prove zero energy use/);
  assert.match(display.energyExplanation, /not household consumption minus charger/);
  assert.match(timingExplanations.coverage.join(' '), /from Finnish midnight to the calculation time/);
  assert.match(display.coverageExplanation, /Estimated and modelled power values/);
  assert.match(display.coverageSummary, /out of 10 hours elapsed/);
  assert.match(display.sources[0].explanation, /do not establish that the heat pump actually ran/);
});

test('included-time evidence shares preserve mixed assumptions and original sample dates', () => {
  const mixed = { ...result, evidence: { sources: ['measured', 'observed', 'modelled', 'unknown'].map((key, index) => ({
    key, share: 0.25, durationMs: 0.175 * hour, firstAt: from - 10 * 60_000 + index * hour, lastAt: from + index * hour,
  })), auxiliaryAssumedMs: hour / 4, auxiliaryAssumedShare: 0.25, auxiliaryUnknownMs: hour / 4, auxiliaryUnknownShare: 0.25 } };
  const display = timingDisplay('heatPump', mixed, payload);
  assert.equal(display.basis, 'Mixed basis');
  assert.deepEqual(display.sources.map(source => source.percentage), Array(4).fill('25%'));
  assert.match(display.sources[0].dates, /7 Sept 2026, 23:50/);
  assert.match(timingExplanations.evidence.join(' '), /not percentages of readings, consumed energy, charging time or accuracy/);
  assert.match(timingExplanations.evidence.join(' '), /Gaps can exist/);
  assert.match(display.auxiliaryNotes.join(' '), /Auxiliary heater output was also assumed during 25%/);
  assert.match(display.auxiliaryNotes.join(' '), /not recorded for 25%/);
});

test('legacy estimates never acquire meter or model provenance from current live state', () => {
  const legacy = { value: 236.98, coverage: 0.29, estimated: true };
  const display = timingDisplay('heatPump', legacy, { ...payload, observations: { heatPumpPowerKw: { source: 'measured' } } });
  assert.equal(display.basis, 'Basis unrecorded');
  assert.equal(display.sources[0].key, 'unknown');
  assert.match(display.sources[0].explanation, /cannot now be classified/);
  assert.equal(display.coverageLabel, '29% of time included');
});

test('unavailable identifies missing power, incomplete prices and future time separately from a zero amount', () => {
  const unavailable = changes => timingDisplay('charger', { ...result, value: null, coverageDetails: { ...result.coverageDetails, includedMs: 0, ...changes } }, payload);
  assert.equal(unavailable({ powerMs: 0 }).unavailableReason, 'No usable device power history');
  assert.equal(unavailable({ powerMs: hour }).unavailableReason, 'Full-day prices missing');
  assert.equal(unavailable({ elapsedMs: 0 }).unavailableReason, 'No elapsed time in this selection');
  assert.equal(unavailable({ powerMs: 0 }).amount, null);
  assert.match(timingExplanations.coverage.join(' '), /unavailable does not mean zero consumption/);
  assert.equal(timingDisplay('charger', null).available, false);
});

test('rates explain historical spot prices and the included-time effect of an assumed daily average', () => {
  const display = timingDisplay('charger', { ...result, value: 236.98, assumedPrices: true,
    evidence: { sources: [{ key: 'currents', durationMs: hour, share: 1 }] },
    priceAssumptions: { durationMs: hour / 2, share: 0.5, firstAt: from, lastAt: from + hour } }, payload);
  assert.equal(display.basis, 'Current estimate');
  assert.equal(display.assumedRates, true);
  assert.match(timingExplanations.rates.join(' '), /nearest known contract rates/);
  assert.match(timingExplanations.rates.join(' '), /historical spot prices are not replaced by today/);
  assert.match(display.rateSummary, /50% of included time.*day’s comparison average/);
  assert.match(display.ratePeriod, /Affected included periods: 8 Sept 2026, 00:00/);
  assert.equal(timingDisplay('charger', { ...result, value: null, assumedPrices: true }, payload).assumedRates, false);
});

test('small included shares remain visible and near-complete coverage does not round to complete', () => {
  assert.equal(timingPercent(0), '0%');
  assert.equal(timingPercent(0.00001), '<1%');
  assert.equal(timingPercent(0.996), '>99%');
  assert.equal(timingPercent(1), '100%');
  const display = timingDisplay('heatPump', { ...result, coverageDetails: { elapsedMs: hour, includedMs: 0.002 * hour } }, payload);
  assert.equal(display.coverageLabel, '<1% of time included');
});

test('sub-cent differences preserve direction and cannot appear as a measured zero saving', () => {
  for (const [value, amount] of [[0.004, '+<€0.01'], [-0.004, '−<€0.01']]) {
    const display = timingDisplay('charger', { value }, payload);
    assert.equal(display.amount, amount);
    assert.match(display.smallDifferenceExplanation, /smaller than half a cent.*sign still shows/);
    assert.doesNotMatch(display.smallDifferenceExplanation, /rounds to €0\.00/);
  }
  assert.equal(timingDisplay('charger', { value: -0 }, payload).amount, '€0.00');
  assert.equal(timingDisplay('charger', { value: -12.34 }, payload).amount, '-€12.34');
  assert.equal(timingDisplay('charger', { value: -12.34 }, payload).smallDifferenceExplanation, null);
});

test('completed history with missing periods says partial data without promising backfill', () => {
  const display = timingDisplay('heatPump', result, { ...payload, now: from + 48 * hour });
  assert.equal(display.periodLabel, 'Partial data');
  assert.match(timingExplanations.coverage.join(' '), /Historical gaps may remain permanently/);
  assert.match(display.periodExplanation, /not extrapolated/);
  assert.match(display.calculationPeriod, /8 Sept 2026, 10:00/);
  assert.equal(timingDisplay('heatPump', { ...result, value: null }, { ...payload, now: from + 48 * hour }).periodLabel, null);
});

test('the evidence ladder keeps its ordering when the earliest contributing source changes', () => {
  const display = timingDisplay('heatPump', { value: 1, evidence: { sources: ['unknown', 'modelled', 'measured', 'observed'].map(key => ({ key, durationMs: hour, share: 0.25 })) } }, payload);
  assert.deepEqual(display.sources.map(source => source.key), ['measured', 'observed', 'modelled', 'unknown']);
});

test('reconstructed heat-pump explanation describes recorded equipment and dated powers without suggesting a model fallback', () => {
  const display = timingDisplay('heatPump', { ...result, evidence: {
    energyBasis: 'reconstructed-equipment', timeBasis: 'recorded-interval-time',
    sources: [{ key: 'observed', durationMs: hour, share: 1, firstAt: from, lastAt: from + hour }],
  } }, payload);
  assert.equal(display.basis, 'Operation estimate');
  assert.match(display.sources[0].explanation, /verified auxiliary output.*dated nominal compressor/);
  assert.match(display.energyExplanation, /space heating and domestic hot water/);
  assert.match(display.sources[0].dates, /Contributing intervals: 8 Sept 2026, 00:00/);
  assert.match(display.evidenceExplanation, /original boundaries of contributing recorded intervals/);
  assert.match(display.energyExplanation, /Model predictions or a requested operating mode do not fill gaps/);
  assert.match(display.coverageExplanation, /recorded coverage and freshness/);
  assert.doesNotMatch(display.coverageExplanation, /30 minutes|estimated and modelled/);
  assert.doesNotMatch(display.energyExplanation, /first uses dedicated power/);
});

test('unavailable reconstructed heat-pump energy still explains the required equipment evidence', () => {
  const display = timingDisplay('heatPump', { value: null,
    coverageDetails: { elapsedMs: hour, includedMs: 0, powerMs: 0 },
    evidence: { energyBasis: 'reconstructed-equipment', sources: [] },
  }, payload);
  assert.equal(display.available, false);
  assert.match(display.energyExplanation, /Recorded compressor activity, verified auxiliary output and dated nominal power assumptions are needed/);
  assert.doesNotMatch(display.energyExplanation, /dedicated heat-pump power reading or a stored/);
});

test('recorded charger intervals retain their estimated energy basis and original interval dates', () => {
  const display = timingDisplay('charger', { ...result, evidence: {
    energyBasis: 'recorded-intervals', timeBasis: 'recorded-interval-time',
    sources: [{ key: 'recorded', durationMs: hour, share: 1, firstAt: from - hour, lastAt: from + hour }],
  } }, payload);
  assert.equal(display.basis, 'Recorded energy estimate');
  assert.equal(display.sources[0].key, 'recorded');
  assert.match(display.sources[0].explanation, /reported active power or recorded voltage and current/);
  assert.match(display.sources[0].explanation, /Cumulative meter checks do not correct/);
  assert.match(display.sources[0].dates, /Contributing intervals: 7 Sept 2026, 23:00/);
  assert.match(display.coverageExplanation, /saved interval without extending into gaps/);
  assert.doesNotMatch(display.coverageExplanation, /30 minutes|modelled power/);
});

test('mixed charger history explains interval energy and the bounded legacy snapshot hold separately', () => {
  const display = timingDisplay('charger', { ...result, evidence: {
    energyBasis: 'recorded-and-legacy', timeBasis: 'mixed-recorded-time',
    sources: ['currents', 'recorded'].map(key => ({ key, durationMs: hour / 2, share: 0.5,
      firstAt: from, lastAt: from + hour })),
  } }, payload);
  assert.equal(display.basis, 'Mixed basis');
  assert.deepEqual(display.sources.map(source => source.key), ['recorded', 'currents']);
  assert.match(display.sources[0].dates, /Contributing intervals and samples/);
  assert.match(display.sources[1].explanation, /phase-current readings at 230 V/);
  assert.match(display.coverageExplanation, /saved interval without extending into gaps.*Older power snapshots are carried forward for at most 30 minutes/);
});

test('simulated reconstructed intervals remain explicitly simulated', () => {
  const display = timingDisplay('heatPump', { ...result, evidence: {
    energyBasis: 'reconstructed-equipment', timeBasis: 'recorded-interval-time',
    sources: [{ key: 'simulated', durationMs: hour, share: 1 }],
  } }, payload);
  assert.equal(display.basis, 'Simulated');
  assert.match(display.sources[0].explanation, /do not represent measured household consumption/);
});

test('shared comparison copy preserves the daily baseline, sign and limits for both devices', () => {
  assert.match(timingExplanations.comparison.join(' '), /same calculated device energy.*whole day’s time-weighted average all-in price/);
  assert.match(timingExplanations.comparison.join(' '), /Positive means cheaper timing; negative means dearer timing/);
  assert.match(timingExplanations.comparison.join(' '), /not scaled up.*does not prove savings caused by the controller/);
  assert.match(timingExplanations.coverage.join(' '), /Valid zero-consumption values count/);
  assert.match(timingExplanations.evidence.join(' '), /today’s sensors do not reclassify/);
});

test('unavailable rate metadata does not suggest a supported device comparison', () => {
  const display = timingDisplay('charger', { value: null, assumedPrices: true,
    coverageDetails: { elapsedMs: hour, includedMs: 0, powerMs: hour, firstPowerAt: from, lastPowerAt: from + hour },
    priceAssumptions: { durationMs: hour, share: 1, firstAt: from, lastAt: from + hour },
  }, payload);
  assert.equal(display.assumedRates, false);
  assert.equal(display.rateSummary, null);
  assert.equal(display.ratePeriod, null);
  assert.match(display.availablePowerPeriod, /Available power samples: 8 Sept 2026, 00:00.*Gaps may exist/);
  assert.equal(display.smallDifferenceExplanation, null);
});
