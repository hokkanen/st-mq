import test from 'node:test';
import assert from 'node:assert/strict';
import { runBootstrapAudit } from '../scripts/garage-planning-simulation.js';

// Untouched priors; the independent plant experiences only the planner's own
// choices. The deliberately exceptional 400/7c tariffs are a stress fixture,
// never a forecast of household tariffs or a reason to manufacture experiments.
test('large worthwhile opportunities collect independent evidence without a learning-duration ceiling', () => {
  const result = runBootstrapAudit({ days: 42 });
  const first = result.opportunities[0];
  assert.equal(first.completedEpisodes, 0); assert.equal(first.ready, false);
  assert.ok(first.plannedOffHours > 2); assert.equal(first.learningTrial, true);
  assert.equal(first.evidence.validatedOffHours, 0); assert.equal(first.evidence.eligible, true);
  assert.ok(result.opportunities.some(row => row.ready && row.plannedOffHours > 2));
  assert.equal(result.ready, true); assert.ok(result.validatedOffHours >= 1);
  assert.ok(result.validation.trainingEpisodes >= 2 && result.validation.validationEpisodes >= 1);
  assert.ok(result.opportunities.some(row => row.plannedOffHours > (row.evidence?.validatedOffHours ?? 0)));
  assert.ok(result.opportunities.every(row => !row.plannedOffHours || row.plannedOffHours >= 1));
  assert.ok(result.stateBytes < 36_000);
});

test('flat and ordinary prices preserve availability instead of creating learning experiments', () => {
  for (const peakCents of [7, 40]) {
    const result = runBootstrapAudit({ days: 8, peakCents, baseCents: 7 });
    assert.equal(result.totalOffHours, 0); assert.equal(result.validation.completedEpisodes, 0);
    assert.ok(result.opportunities.every(row => row.timingBenefitEur === 0));
    if (peakCents === 7) assert.ok(result.opportunities.every(row => row.reason === 'flat-prices-preserve-normal-warmth'));
  }
});

test('boolean compressor activity can qualify temperature evidence without inventing electricity qualification', () => {
  const result = runBootstrapAudit({ days: 42, parameters: { activityOnly: true, booleanActivity: true } });
  assert.ok(result.totalOffHours > 0); assert.ok(result.validation.completedEpisodes >= 3);
  assert.equal(result.nativeSamples, 0); assert.equal(result.electricalReady, false);
  assert.equal(result.ready, true);
  assert.ok(result.opportunities.every(row => !row.electricalReady));
  assert.ok(result.opportunities.some(row => !row.ready && row.plannedOffHours > 2));
});
