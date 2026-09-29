import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCharger, CHARGER_DEFINITIONS } from '../src/charging/model.js';
import { chargingSettings } from '../src/charging/settings.js';
import { updateChargingProgress } from '../src/charging/progress.js';
import { planChargers } from '../src/charging/planner.js';
import { updateSessionCost } from '../src/charging/session-cost.js';

const now = Date.parse('2026-09-21T00:00:00Z'), HOUR = 3_600_000;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('both chargers conserve grid energy across battery progress, planning and cost', () => {
  const settings = chargingSettings();
  const prices = [{ start: now, end: now + 2 * HOUR, price: 10 }];
  for (const definition of CHARGER_DEFINITIONS) {
    const charger = buildCharger({ definition: { ...definition, capabilities: { ...definition.capabilities, scheduling: true } },
      settings: { ...settings.chargers[definition.id], enabled: true, capacityKwh: 18.5, manualSoc: 0, minimumSoc: 50 },
      configuration: { efficiency: .8 }, now, deadlineAt: now + 2 * HOUR,
      telemetry: { connected: true, voltageV: 230, currentA: 16, maxCurrentA: 16 } });
    // Adding 9.25 battery kWh requires 10 grid kWh, with 0.75 kWh lost.
    near(charger.requiredGridKwh, 10);
    assert.equal(charger.configuration.efficiency, .925);
    const initial = updateChargingProgress(null, charger, now);
    const half = updateChargingProgress(initial.state, charger, now + HOUR / 2,
      () => ({ gridKwh: 5, coveredMs: HOUR / 2 }));
    near(half.estimatedSoc, 25);
    near(half.remainingGridKwh, 5);
    const result = planChargers({ now, chargers: [charger], prices,
      supply: { availableCurrentA: [25, 25, 25], voltageV: 230 } });
    const plan = result.plans[definition.id];
    assert.equal(plan.feasible, true);
    near(plan.costCents, 100);
    const completed = updateSessionCost(null, { ...charger, progress: { remainingGridKwh: 0, connectionAt: now } },
      now + HOUR, prices, () => ({ gridKwh: 10, intervals: [{ start: now, end: now + HOUR, energyKwh: 10 }] }));
    near(completed.totalCents, 100);
  }
});
