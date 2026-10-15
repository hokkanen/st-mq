import test from 'node:test';
import assert from 'node:assert/strict';
import { createChargingPlannerService } from '../src/charging/planner-service.js';

const now = Date.parse('2026-10-15T19:30:00Z'), QUARTER = 900_000;
const nearCompletion = 1e-7 * (1 + 1e-8);
const reading = value => ({ value, available: value !== null, assumed: false });

function inputFor(amps, requiredGridKwh) {
  return {
    now, priority: 'balanced', household: [],
    supply: { configuredBudgetCurrentA: [amps, amps, amps] },
    prices: Array.from({ length: 4 }, (_, index) => ({
      start: now + index * QUARTER, end: now + (index + 1) * QUARTER, priceCtPerKwh: 10,
    })),
    chargers: [{
      id: 'charger2', label: 'Synthetic EVSE', requiredGridKwh, deadlineAt: now + 4 * QUARTER,
      settings: { enabled: true }, configuration: { maximumCurrentA: amps },
      capabilities: { scheduling: true, currentControl: true, externalLoadBalancing: false },
      values: Object.fromEntries(Object.entries({ connected: true, charging: false, currentA: amps,
        maximumCurrentA: amps, voltageV: 230, powerKw: 0, minimumSoc: 80, vehicleCeilingSoc: 80,
        soc: 20 }).map(([key, value]) => [key, reading(value)])),
      control: {}, telemetry: {},
    }],
  };
}

async function completedPlan(input) {
  // Use the real input transport and numerical worker. A synchronous numerical
  // loop must not hide behind node:test's timer on that same event loop.
  const service = createChargingPlannerService();
  let timer;
  try {
    return await Promise.race([service.request(input), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The pure charging planner did not complete within 3 seconds.')), 3000);
    })]);
  } finally {
    clearTimeout(timer);
    await service.close();
  }
}

function checkDelivery(result, input, amps) {
  assert(result, 'The actual planner must return a result');
  const plan = result.plans.charger2, required = input.chargers[0].requiredGridKwh;
  assert.equal(result.feasible, true);
  assert.equal(plan.feasible, true);
  assert.equal(plan.requiredGridKwh, required, 'A small request cannot be silently discarded');
  assert(plan.deliveredGridKwh > 0);
  assert(Math.abs(plan.deliveredGridKwh - required) < 1e-9, 'Retain the delivered energy through completion');
  assert(plan.shortfallGridKwh < 1e-9);
  assert(Number.isFinite(plan.finishAt) && plan.finishAt >= now && plan.finishAt <= input.chargers[0].deadlineAt);
  assert(plan.periods.length > 0, 'A positive request retains its charging program');
  assert(Math.abs(plan.costCents - required * 10) < 1e-8, 'Charge the declared price for delivered energy');
  assert(plan.accounting.length > 0);
  assert(plan.accounting.every(row => row.energyKwh > 0));
  assert(Math.abs(plan.accounting.reduce((sum, row) => sum + row.energyKwh, 0) - plan.deliveredGridKwh) < 1e-12);
  assert(Math.abs(plan.accounting.reduce((sum, row) => sum + row.energyKwh * row.priceCtPerKwh, 0) - plan.costCents) < 1e-11);
  assert(result.allocations.length > 0);
  for (const row of result.allocations) {
    assert(row.end > row.start && row.end <= input.chargers[0].deadlineAt);
    assert(row.phaseCurrentA.every(current => current >= 0 && current <= amps + 1e-9));
    assert((row.chargers.charger2?.currentA ?? 0) <= amps + 1e-9);
  }
}

for (const amps of [6, 9]) {
  test(`pure charging planner accounts for a near-completion request at ${amps} A`, async () => {
    const input = inputFor(amps, nearCompletion), before = structuredClone(input);
    checkDelivery(await completedPlan(input), input, amps);
    assert.deepEqual(input, before, 'Planning cannot rewrite input, current limits or the request');
  });

  test(`pure charging planner completes an ordinary request with a small interval residual at ${amps} A`, async () => {
    const quarterEnergy = amps * 230 * 3 / 1000 / 4;
    const input = inputFor(amps, quarterEnergy + nearCompletion), before = structuredClone(input);
    checkDelivery(await completedPlan(input), input, amps);
    assert.deepEqual(input, before);
  });
}

test('pure charging planner retains ordinary delivery, cost and phase limits', async () => {
  const input = inputFor(9, 0.1), before = structuredClone(input);
  checkDelivery(await completedPlan(input), input, 9);
  assert.deepEqual(input, before);
});

test('pure charging planner keeps the first minimum completion while accounting a continued native tail', async () => {
  const input = inputFor(9, 0.1);
  input.chargers[0].values.vehicleCeilingSoc = reading(90);
  const before = structuredClone(input), result = await completedPlan(input);
  checkDelivery(result, input, 9);
  const plan = result.plans.charger2;
  // 0.1 kWh at 6.21 kW takes about 58 seconds. A later positive rounding
  // remainder cannot move that minimum completion to a 15-minute boundary.
  assert(plan.finishAt <= now + 100_000);
  assert(result.allocations.some(row => row.start >= plan.finishAt && row.chargers.charger2?.currentA > 0));
  assert.equal(result.forecasts.charger2.known, false);
  assert(result.forecasts.charger2.endAt > plan.finishAt);
  assert(plan.accounting.some(row => row.energyKwh > 0 && row.energyKwh < 1e-7), 'The positive rounding tail remains accounted');
  assert(Math.abs(plan.deliveredGridKwh - 0.1) < 1e-12, 'Count the tail without changing the first completion');
  assert.deepEqual(input, before);
});
