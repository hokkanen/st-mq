import test from 'node:test';
import assert from 'node:assert/strict';
import { heatingDisplay, heatingExplanations } from '../chart/heating-benefit.js';

const from = Date.parse('2026-09-08T00:00:00+03:00'), HOUR = 3_600_000;
const payload = { now: from + 12 * HOUR, range: { from, to: from + 24 * HOUR } };
const result = { status: 'estimated', valueEuro: 2.5, counts: { assessed: 2, completed: 3, unassessed: 1,
  incomplete: 1, active: 1, startedBeforeSelection: 1 }, firstStartedAt: from - HOUR, lastEndedAt: from + 3 * HOUR,
  estimateRange: { lowerEuro: -1.25, upperEuro: 6.25 } };

test('heating model total clearly attributes full assessed cycles to completion dates and preserves uncertainty', () => {
  const display = heatingDisplay(result, payload);
  assert.equal(display.amount, '€2.50');
  assert.match(display.cycleSummary, /2 assessed cycles completed in the selection out of 3 completed/);
  assert.match(display.periodExplanation, /1 included cycle began before.*included once, on completion/);
  assert.match(display.coveredPeriod, /7 Sept 2026, 23:00.*8 Sept 2026, 03:00/);
  assert.match(display.calculationPeriod, /8 Sept 2026, 00:00.*12:00/);
  assert.match(display.uncertainty, /-€1.25–€6.25.*not a statistical confidence interval/);
  assert.match(display.excludedSummary, /1 completed cycle without.*1 incomplete cycle.*1 cycle still in progress/);
});

test('unsupported model assessments cannot borrow a value from timing, fireplace or rolling learning metrics', () => {
  const other = { ...payload, timingBenefit: { heatPump: { value: 20 } }, firewoodBenefit: { valueEuro: 10 },
    series: { learning_profit: [{ x: from, y: 30 }] } };
  for (const input of [null, { status: 'unavailable', valueEuro: 5 }, { status: 'estimated', valueEuro: null }]) {
    assert.equal(heatingDisplay(input, other).available, false);
    assert.equal(heatingDisplay(input, other).amount, null);
  }
  assert.match(heatingDisplay({ reason: 'no-elapsed-time' }, payload).unavailableReason, /not elapsed/);
  assert.match(heatingDisplay({ reason: 'no-assessed-cycles' }, payload).unavailableReason, /no supported savings assessment/);
});

test('zero, negative and sub-cent heating estimates retain their meaning', () => {
  for (const [valueEuro, amount] of [[0, '€0.00'], [-0, '€0.00'], [-2.5, '-€2.50'], [0.001, '+<€0.01'], [-0.001, '−<€0.01']]) {
    const display = heatingDisplay({ ...result, valueEuro }, payload);
    assert.equal(display.available, true); assert.equal(display.amount, amount);
  }
  assert.equal(heatingDisplay({ ...result, valueEuro: -1 }, payload).outcome, 'estimated extra cost');
  assert.equal(heatingDisplay({ ...result, valueEuro: 0 }, payload).outcome, 'estimated cost difference');
  assert.equal(heatingDisplay({ ...result, estimateRange: null }, payload).uncertainty, null);
});

test('completed-model reconciliation qualifies both costs and preserves selected-cycle scope', () => {
  const display = heatingDisplay({ ...result, referenceCostEuro: 4.7125, actualSpaceHeatingCostEuro: 2.2125 }, payload);
  assert.deepEqual(display.reconciliation, [
    { label: 'Modelled reference cost', value: '€4.7125' },
    { label: 'Assessed heating cost', value: '€2.2125' },
    { label: 'Estimated cost difference', value: '€2.50' },
  ]);
  assert.match(display.reconciliationExplanation, /included completed cycles/);
  assert.match(heatingExplanations.join(' '), /temperature-dependent electrical estimate.*dated nominal equipment powers/);
  assert.match(heatingExplanations.join(' '), /Domestic hot water is excluded.*average euros per assessed cycle/);
  const unsupported = heatingDisplay({ ...result, status: 'unavailable', valueEuro: null,
    referenceCostEuro: 5, actualSpaceHeatingCostEuro: 2.5 }, payload);
  assert.deepEqual(unsupported.reconciliation, []);
});
