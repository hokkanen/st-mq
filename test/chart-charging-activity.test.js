import test from 'node:test';
import assert from 'node:assert/strict';
import { activityTracks, activityIntervals, activityIntervalLabel } from '../chart/chart-overlays.js';
import { historyTooltipLabel } from '../chart/history-tooltips.js';

const phases = activityTracks.find(track => track.key === 'propertyHighestPhase');
const allowance = activityTracks.find(track => track.key === 'charger2Allowance');

test('highest property phase labels preserve tied phases and reuse opaque phase-chart colours', () => {
  const interval = { start: 1_000, end: 2_000, value: 1, phases: [1, 3] };
  const intervals = [interval];
  assert.equal(activityIntervals(phases, { shading: { propertyHighestPhase: intervals } }), intervals);
  assert.match(activityIntervalLabel(phases, interval), /^L1 \/ L3 tied · L1 shown · /);
  assert.match(activityIntervalLabel(phases, { ...interval, value: 2, phases: [2] }), /^L2 · /);
  assert.deepEqual(phases.colors, { 1: 'phase1', 2: 'phase2', 3: 'phase3' });
  assert.deepEqual(phases.opacities, { 1: 1, 2: 1, 3: 1 });
  assert.match(phases.missingLabel, /Unknown.*evidence is unavailable/);
});

test('allowance activity text separates fallback zero, constrained capacity and unknown basis', () => {
  const interval = { start: 1_000, end: 2_000, value: 5, allowanceA: 0, reason: 'feed-unavailable' };
  assert.match(activityIntervalLabel(allowance, interval), /^Fallback · 0 A allowance · feed unavailable · /);
  for (const [value, text] of [[1, 'Inactive'], [2, 'Full allowance'], [3, 'Priority constrained'], [4, 'Property load constrained']])
    assert(activityIntervalLabel(allowance, { ...interval, value, reason: null, allowanceA: value === 1 ? null : 16 }).startsWith(`${text} · `));
  const ambiguous = activityIntervalLabel(allowance, { ...interval, value: 0, allowanceA: 8, reason: 'native-current-limit' });
  assert.match(ambiguous, /^Unknown · 8 A allowance · native current limit · /);
  assert.doesNotMatch(ambiguous, /Full allowance|Priority constrained|Property load constrained/);
  assert.equal(allowance.patterns[0], 'unknown');
  assert.match(allowance.detail, /Actual draw.*separate/);
});

test('property line tooltip names the highest phase and ties while retaining estimate provenance', () => {
  const point = { x: 1_000, y: 16, maximumPhase: true, equivalentCurrent: true, phases: [2] };
  const item = { dataset: { key: 'property_current_max', label: 'Property highest phase', unit: 'A' }, parsed: point, raw: point };
  assert.match(historyTooltipLabel(item), /highest simultaneous phase.*interval average.*L2/);
  point.phases = [1, 3];
  assert.match(historyTooltipLabel(item), /L1 \/ L3 tied; L1 shown/);
  delete point.phases;
  assert.doesNotMatch(historyTooltipLabel(item), /L[123]|undefined|tied/);
});
