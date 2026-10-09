import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { currentChargingAllocation } from '../src/charging/planner.js';

const now = Date.parse('2026-10-08T00:00:00Z'), HOUR = 3_600_000;
const reading = value => ({ value, available: true, assumed: false });
function fixture() {
  const views = ['charger1', 'charger2'].map((id, index) => ({ id, association: id, requiredGridKwh: index ? 13 : 15,
    deadlineAt: now + (index ? 3 : 4) * HOUR, settings: { enabled: true }, request: { sessionId: id, revision: 2 },
    capabilities: { scheduling: true, currentControl: Boolean(index), externalLoadBalancing: !index },
    configuration: { maximumCurrentA: 16 }, telemetry: { currentSharingActive: true },
    control: { execution: { planId: id, deadlineAt: now + (index ? 3 : 4) * HOUR, periods: [{ startAt: now, endAt: null }] } },
    values: { connected: reading(true), currentA: reading(16), maximumCurrentA: reading(16), actualCurrentA: reading(0),
      voltageV: reading(230), powerKw: reading(0), minimumSoc: reading(80), vehicleCeilingSoc: reading(80) } }));
  const chargers = Object.fromEntries(views.map(view => [view.id, { plan: { id: view.id, deadlineAt: view.deadlineAt,
    targetAt: now + (view.id === 'charger1' ? 2 : 3) * HOUR, periods: [{ startAt: now, endAt: null }] } }]));
  const runtime = { chargers, views: () => views, clock: () => now, settings: { priority: 'balanced' }, currentAllocationHold: null };
  const allocation = () => ChargingRuntime.prototype.allocationContext.call(runtime).allocateCurrent([16, 16, 16]);
  const expected = target => {
    const result = currentChargingAllocation({ now, chargers: views.map(view => view.id === 'charger1'
      ? { ...view, allocationTargetAt: target } : view), priority: 'balanced', budgetCurrentA: [16, 16, 16] });
    return { allocationA: result.charger2.currentLimitA, reservationA: result.charger1.currentA };
  };
  return { runtime, views, chargers, allocation, expected };
}

test('live allocation retains the earlier selected target only for accepted peer execution', () => {
  const f = fixture(), retained = f.expected(now + 2 * HOUR), ordinary = f.expected(now + 4 * HOUR);
  assert.notDeepEqual(retained, ordinary, 'the fixture makes allocation urgency observable');
  assert.deepEqual(f.allocation(), retained);
  f.chargers.charger1.plan.id = 'unadopted';
  f.chargers.charger1.plan.targetAt = now + HOUR;
  assert.deepEqual(f.allocation(), ordinary, 'an unaccepted C1 candidate does not acquire earlier urgency');
  f.chargers.charger1.plan.priceRevision = { previousPlanId: 'charger1', previousTargetAt: now + 2 * HOUR };
  assert.deepEqual(f.allocation(), retained, 'a pending revision preserves the accepted prior target');
  f.chargers.charger1.newEpisode = true;
  assert.deepEqual(f.allocation(), ordinary, 'a new connection cannot inherit the previous target');
});

test('the first calculation after an explicit grant preserves accepted urgency before its public deadline updates', () => {
  const f = fixture(), earlier = now + 2 * HOUR;
  f.chargers.charger1.plan.deadlineAt = earlier;
  f.views[0].control.execution.deadlineAt = earlier;
  f.views[0].request.flexibility = { activeDefer: { checkpointAt: earlier, deferredReadyByAt: f.views[0].deadlineAt, approvedAt: now } };
  assert.deepEqual(f.allocation(), f.expected(earlier));
  delete f.views[0].request.flexibility;
  assert.deepEqual(f.allocation(), f.expected(f.views[0].deadlineAt), 'an unrelated deadline edit does not retain the old allocation target');
});
