import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingPlanInputsUnavailable } from '../src/charging/plan-inputs.js';

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
