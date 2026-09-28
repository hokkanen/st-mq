import test from 'node:test';
import assert from 'node:assert/strict';
import { runBootstrapAudit } from '../scripts/garage-planning-simulation.js';

// Untouched priors; the independent plant experiences only the planner's own
// choices. The deliberately exceptional 400/7c tariffs are a stress fixture,
// never a forecast of household tariffs or a reason to manufacture experiments.
test('large target opportunities remain extrapolations without manufacturing native OFF evidence', () => {
  const result = runBootstrapAudit({ days: 42 });
  const first = result.opportunities[0];
  assert.equal(first.completedEpisodes, 0); assert.equal(first.ready, false);
  assert.ok(first.plannedReducedHours > 2); assert.equal(first.forecastExtrapolation, true);
  assert.equal(first.evidence.validatedOffHours, 0); assert.equal(first.evidence.eligible, true);
  assert.ok(result.totalReducedHours > 0);
  assert.equal(result.nativeOffHours, 0);
  assert.ok(result.reducedElectricityKwh >= result.totalReducedHours * result.standbyPowerKw - .00001);
  assert.equal(result.ready, false); assert.equal(result.validatedOffHours, 0);
  assert.equal(result.validation.trainingEpisodes, 0); assert.equal(result.validation.validationEpisodes, 0);
  assert.ok(result.opportunities.every(row => !row.ready && row.forecastExtrapolation));
  assert.ok(result.opportunities.some(row => row.plannedReducedHours > (row.evidence?.validatedOffHours ?? 0)));
  assert.ok(result.opportunities.every(row => !row.plannedReducedHours || row.plannedReducedHours >= 1));
  assert.ok(result.stateBytes < 36_000);
});

test('flat and ordinary prices preserve availability instead of creating learning experiments', () => {
  for (const peakCents of [7, 40]) {
    const result = runBootstrapAudit({ days: 8, peakCents, baseCents: 7 });
    assert.equal(result.totalReducedHours, 0); assert.equal(result.validation.completedEpisodes, 0);
    assert.ok(result.opportunities.every(row => row.timingBenefitEur === 0));
    if (peakCents === 7) assert.ok(result.opportunities.every(row => row.reason === 'flat-prices-preserve-normal-warmth'));
  }
});

test('boolean compressor activity during target control creates neither OFF nor electricity validation', () => {
  const result = runBootstrapAudit({ days: 42, parameters: { activityOnly: true, booleanActivity: true } });
  assert.ok(result.totalReducedHours > 0); assert.equal(result.validation.completedEpisodes, 0);
  assert.equal(result.nativeOffHours, 0);
  assert.ok(result.reducedElectricityKwh > 0);
  assert.equal(result.nativeSamples, 0); assert.equal(result.electricalReady, false);
  assert.equal(result.ready, false);
  assert.ok(result.opportunities.every(row => !row.electricalReady));
  assert.ok(result.opportunities.some(row => !row.ready && row.plannedReducedHours > 2));
});
