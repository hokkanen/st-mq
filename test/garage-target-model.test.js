import test from 'node:test';
import assert from 'node:assert/strict';
import { createGarageModel } from '../src/garage/model.js';
import { predictGarageTargetStep, garageReducedPowerAllowance } from '../src/garage/target-model.js';

function fixture() {
  const model = createGarageModel({ seedAt: 1800000000000, roomTargetC: 10 });
  model.normalReference.interceptC = 10; model.normalReference.frontC = 9;
  model.rear.values[0] = .1; model.front.values[0] = .12;
  return { model, state: { rearC: 10, frontC: 9, differenceC: -1 },
    input: { outdoorC: -5, targetC: 5, normalTargetC: 10, normalPowerKw: .5 } };
}
test('a reduced room target retains powered consumption while demand is satisfied', () => {
  const { model, state, input } = fixture();
  const result = predictGarageTargetStep(model, state, input, 1);
  assert.equal(result.coolingHours, 1);
  assert.equal(result.maintenanceHours, 0);
  assert.equal(result.electricityKwh, .125);
  assert.ok(result.rearC < 10 && result.rearC > 5);
  assert.equal(state.rearC, 10);
});
test('a lower target can still call for heat and is never priced as a power OFF', () => {
  const { model, input } = fixture();
  const result = predictGarageTargetStep(model, { rearC: 5, frontC: 4 }, input, 1);
  assert.equal(result.coolingHours, 0);
  assert.equal(result.maintenanceHours, 1);
  assert.ok(result.electricityKwh > .125 && result.electricityKwh < .5);
  assert.equal(result.rearC, 5);
  assert.equal(model.normalReference.interceptC, 10);
});
test('crossing the thermostat target includes cooling and later maintenance', () => {
  const { model, input } = fixture();
  const result = predictGarageTargetStep(model, { rearC: 5.2, frontC: 4.2 }, input, 1);
  assert.ok(result.coolingHours > 0 && result.coolingHours < 1);
  assert.equal(result.coolingHours + result.maintenanceHours, 1);
  assert.ok(result.electricityKwh > .125);
});
test('low normal demand never creates negative avoided consumption', () => {
  for (const power of [0, .03, .1, .5]) assert.ok(garageReducedPowerAllowance(power) <= power);
  const { model, state, input } = fixture();
  const result = predictGarageTargetStep(model, state, { ...input, normalPowerKw: .03 }, 1);
  assert.equal(result.electricityKwh, .03);
  assert.throws(() => predictGarageTargetStep(model, state, { ...input, targetC: -1 }, 1), /bounded lower room target/);
});
