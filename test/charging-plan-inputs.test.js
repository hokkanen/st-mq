import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingPlanInputsUnavailable, chargingServiceRelease } from '../src/charging/plan-inputs.js';

test('missing charging inputs remain distinct from a modeled shortfall or native restriction', () => {
  for (const reason of ['electrical-telemetry-unavailable', 'equalizer-allowance-unavailable',
    'price-coverage-unavailable', 'household-history-loading', 'household-history-unavailable'])
    assert.equal(chargingPlanInputsUnavailable({ reason, provisional: true }), true, reason);
  for (const reason of ['insufficient-time', 'vehicle-start-after-deadline', 'connection-unavailable',
    'multiple-external-load-balancers', 'cheapest-feasible-start'])
    assert.equal(chargingPlanInputsUnavailable({ reason, provisional: true }), false, reason);
  assert.equal(chargingPlanInputsUnavailable({ reason: 'price-coverage-unavailable', provisional: false }), false);
  assert.equal(chargingPlanInputsUnavailable(null), false);
});

test('service release is limited to an immediately open modeled-shortfall program', () => {
  const now = 1000, plan = { feasible: false, provisional: true, reason: 'insufficient-time',
    periods: [{ startAt: now, endAt: null }] };
  assert.equal(chargingServiceRelease(plan, now), true);
  for (const change of [{ reason: 'price-coverage-unavailable' }, { reason: 'electrical-telemetry-unavailable' },
    { provisional: false }, { feasible: null }, { periods: [{ startAt: now + 1, endAt: null }] },
    { periods: [{ startAt: now, endAt: now + 1 }] },
    { periods: [{ startAt: now, endAt: now + 1 }, { startAt: now + 100, endAt: null }] }])
    assert.equal(chargingServiceRelease({ ...plan, ...change }, now), false);
  assert.equal(chargingServiceRelease(null, now), false);
});
