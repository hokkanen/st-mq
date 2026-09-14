import test from 'node:test';
import assert from 'node:assert/strict';
import { runBootstrapAudit } from '../scripts/garage-planning-simulation.js';

// These start with untouched priors. The independent plant experiences only the
// planner's own OFF choices; no readiness flags, coefficients or episodes are
// manually assigned. Ordinary 40/7c tariffs recur three times per week.
test('metered garage causally progresses from thirty-minute trials to qualified two-hour planning', () => {
  const result = runBootstrapAudit({ days: 28 });
  const first = result.opportunities[0];
  assert.equal(first.completedEpisodes, 0); assert.equal(first.ready, false);
  assert.equal(first.plannedOffHours, .5); assert.equal(first.learningTrial, true);
  assert.ok(result.opportunities.some(row => row.completedEpisodes >= 2 && row.plannedOffHours > .5));
  assert.equal(result.ready, true); assert.equal(result.electricalReady, true);
  assert.ok(result.maxPauseHours >= 2);
  assert.ok(result.opportunities.some(row => row.electricalReady && row.maxPauseHours >= 2 && row.plannedOffHours >= 2));
  assert.ok(result.opportunities.every(row => row.plannedOffHours <= (row.evidence?.maxPauseHours ?? 0) + 1e-8),
    'Early learning cannot multiply a short supported duration into many chopped pauses');
  assert.ok(result.stateBytes < 36_000);
});

test('flat prices never manufacture an experiment or timing savings', () => {
  const result = runBootstrapAudit({ days: 8, peakCents: 7, baseCents: 7 });
  assert.equal(result.totalOffHours, 0); assert.equal(result.validation.completedEpisodes, 0);
  assert.ok(result.opportunities.every(row => row.reason === 'flat-prices-preserve-normal-warmth' && row.timingBenefitEur === 0));
});

test('boolean compressor activity can collect bounded thermal evidence without inventing electricity qualification', () => {
  const result = runBootstrapAudit({ days: 42, parameters: { activityOnly: true, booleanActivity: true } });
  assert.ok(result.totalOffHours > 0);
  assert.ok(result.validation.completedEpisodes >= 3);
  assert.equal(result.nativeSamples, 0); assert.equal(result.electricalReady, false);
  assert.ok(result.opportunities.every(row => !row.electricalReady));
  assert.ok(result.opportunities.every(row => row.plannedOffHours <= 1));
  assert.ok(result.opportunities.filter(row => row.plannedOffHours > 0).every(row => row.learningTrial));
});
