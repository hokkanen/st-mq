import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCycle } from '../src/control/planner.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';

const start = Date.parse('2026-01-01T00:00:00Z');
const schedule = { preheatStart: start, preheatEnd: start + 900000, reductionStart: start + 900000,
  reductionEnd: start + 1800000, roomBoostC: 5, treatmentKey: 'fixed-room-v1' };
const args = { schedule, intervals: [{ start, end: start + 900000, outdoorC: 0, solarRadiationWm2: 0, price: 20 }],
  model: initialAdaptiveModel({ heatPumpModelConfirmed: true }), initialState: { indoorC: 21, reserveC: 25.7 }, targetC: 21 };

test('remaining preheat forecast does not add ROOM supply uplift twice', () => {
  const continuing = evaluateCycle({ ...args, equipment: { supplyC: 45, observedPhase: 'preheat', observedRoomBoostC: 5, brineC: 0 } });
  const before = evaluateCycle({ ...args, equipment: { supplyC: 30, observedPhase: 'normal', brineC: 0 } });
  assert.equal(continuing.trajectory[0].sourceEstimate.evaluatedSupplyC, 45);
  assert.equal(continuing.trajectory[0].sourceEstimate.withinPlanningRange, true);
  assert.equal(continuing.costCents, before.costCents);
});

test('native reference removes the currently applied ROOM uplift from its source estimate', () => {
  const normal = evaluateCycle({ ...args, schedule: null,
    equipment: { supplyC: 45, normalSupplyC: 30, observedPhase: 'preheat', observedRoomBoostC: 5, brineC: 0 } });
  assert.equal(normal.trajectory[0].sourceEstimate.evaluatedSupplyC, 30);
});
