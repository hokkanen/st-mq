import test from 'node:test';
import assert from 'node:assert/strict';
import { heatingScopeDisplay } from '../chart/heating-scope.js';
import { buildHeatingSavings } from '../src/app/garage-reporting.js';

const HOUR = 3_600_000, from = Date.parse('2026-09-08T00:00:00+03:00');
const range = { from, to: from + 24 * HOUR, startDate: '2026-09-08', endDate: '2026-09-08' };

function timing(scope, { value = 0.004, coverage = 1, elapsed = 24 * HOUR } = {}) {
  return { value, coverage, provisional: scope === 'home', energyKwh: 5,
    actualCostEuro: 2.5, uniformCostEuro: 2.5 + value,
    coverageDetails: { from, to: from + elapsed, elapsedMs: elapsed, includedMs: elapsed * coverage,
      powerMs: elapsed * coverage, missingPowerMs: elapsed * (1 - coverage), incompletePriceMs: 0 },
    evidence: { energyBasis: scope === 'home' ? 'reconstructed-equipment' : 'recorded-intervals',
      timeBasis: 'recorded-interval-time', sources: [{ key: scope === 'home' ? 'observed' : 'measured',
        share: 1, durationMs: elapsed * coverage, firstAt: from, lastAt: from + elapsed * coverage }] },
    ...(scope === 'garage' ? { sourceQuality: 'verified-electrical' } : {}) };
}

function data({ value = 0.004, garageValue = value, coverage = 1, now = range.to + HOUR,
  elapsed = Math.min(24 * HOUR, now - from), homeTiming, garageTiming } = {}) {
  const homeModel = { status: 'estimated', valueEuro: value,
    counts: { assessed: 1, completed: 1 }, referenceCostEuro: 1 + value, actualSpaceHeatingCostEuro: 1 };
  const garageModel = { ...homeModel, valueEuro: garageValue, referenceCostEuro: 1 + garageValue, provisional: true };
  return { range, now, heatingSavings: buildHeatingSavings({ range, now, homeModel, garageModel,
    homeTiming: homeTiming ?? timing('home', { value, coverage, elapsed }),
    garageTiming: garageTiming ?? timing('garage', { value: garageValue, coverage, elapsed }) }) };
}

test('Heating Total and its components preserve coverage edges and signed sub-cent amounts', () => {
  for (const [coverage, expected] of [[0.004, '<1%'], [0.996, '>99%'], [1, '100%']]) {
    const payload = data({ coverage });
    const display = heatingScopeDisplay(payload, 'total', 'timing');
    assert.equal(display.coverageLabel, `${expected} of combined system time included`);
    for (const component of display.breakdown) {
      assert(component.includes(`${expected} of time included`));
      assert(component.includes('+<€0.01'));
    }
    assert.equal(display.amount, '€0.01', 'The unrounded €0.008 total is rounded once');
    assert.equal(display.periodLabel, coverage === 1 ? null : 'Partial data');
  }
  for (const mode of ['model', 'timing']) {
    const cancelled = heatingScopeDisplay(data({ garageValue: -0.004 }), 'total', mode);
    assert.equal(cancelled.amount, '€0.00');
    assert.match(cancelled.breakdown[0], /Home: \+<€0.01/);
    assert.match(cancelled.breakdown[1], /Garage: −<€0.01/);
    const negative = heatingScopeDisplay(data({ value: -0.004 }), 'total', mode);
    assert.equal(negative.amount, '-€0.01');
    assert(negative.breakdown.every(text => text.includes('−<€0.01')));
    assert.match(negative.reconciliationExplanation, /displayed amounts may not add exactly/);
  }
  const zero = heatingScopeDisplay(data({ coverage: 0 }), 'total', 'timing');
  assert.equal(zero.coverageLabel, '0% of combined system time included');
  assert.equal(zero.available, false);
});

test('Home completeness remains independent of its nominal-power estimate after aggregation', () => {
  const complete = heatingScopeDisplay(data(), 'home', 'timing');
  assert.equal(complete.basis, 'Operation estimate');
  assert.equal(complete.coverageLabel, '100% of time included');
  assert.equal(complete.periodLabel, null);
  assert.equal(complete.coverageSummary, null);
  const partial = heatingScopeDisplay(data({ coverage: 0.5 }), 'home', 'timing');
  assert.equal(partial.periodLabel, 'Partial data');
  assert.match(partial.coverageSummary, /device history is missing/);
});

test('Garage and Total retain the current-period label independently of scope', () => {
  for (const scope of ['garage', 'total']) {
    const payload = data({ now: from + 12 * HOUR });
    assert.equal(heatingScopeDisplay(payload, scope, 'timing').periodLabel, 'Today so far');
    const spanning = { ...payload, range: { ...range, from: from - 24 * HOUR, startDate: '2026-09-07' } };
    assert.equal(heatingScopeDisplay(spanning, scope, 'timing').periodLabel, 'Period in progress');
  }
});

test('Garage missing daily prices and future time retain the useful diagnosis', () => {
  for (const [reason, expected] of [
    ['incomplete-daily-prices', 'Full-day prices missing'],
    ['no-elapsed-time', 'No elapsed time in this selection'],
  ]) {
    const payload = data({ garageTiming: { ...timing('garage'), value: null, reason } });
    assert.equal(heatingScopeDisplay(payload, 'garage', 'timing').unavailableReason, expected);
  }
});

test('Heating Total preserves assumed-rate share, affected dates and included system-time denominator', () => {
  const payload = data({ homeTiming: { ...timing('home'), assumedPrices: true,
    priceAssumptions: { durationMs: 24 * HOUR, share: 1, firstAt: from, lastAt: range.to, timeBasis: 'included-time' } } });
  const display = heatingScopeDisplay(payload, 'total', 'timing');
  assert.equal(display.assumedRates, true);
  assert.match(display.rateSummary, /50% of included system-time/);
  assert.match(display.ratePeriod, /8 Sept 2026, 00:00.*9 Sept 2026, 00:00.*Gaps may exist/);
  assert.equal(display.coverageHeading, 'System-time included');
});

test('Total reconciliation sums operands for the same supported contributions as its difference', () => {
  const payload = data({ value: -3.1625, garageValue: 0.1375,
    homeTiming: { ...timing('home'), value: -3.1625, energyKwh: 11, actualCostEuro: 4.4, uniformCostEuro: 1.2375 },
    garageTiming: { ...timing('garage'), value: 0.1375, energyKwh: 11, actualCostEuro: 1.1, uniformCostEuro: 1.2375 } });
  const display = heatingScopeDisplay(payload, 'total', 'timing');
  assert.deepEqual(display.reconciliation.map(row => row.value), ['22 kWh', '€2.475', '€5.50', '-€3.025']);
  const single = data({ garageTiming: { ...timing('garage'), value: null } });
  const partial = heatingScopeDisplay(single, 'total', 'timing');
  assert.match(partial.qualification, /Partial total · Garage unavailable/);
  assert.deepEqual(partial.reconciliation.map(row => row.value), ['5 kWh', '€2.504', '€2.50', '€0.004']);
});
