import test from 'node:test';
import assert from 'node:assert/strict';
import { planChargers, forecastFixedPlans } from '../src/charging/planner.js';
import { createChargingPlannerService } from '../src/charging/planner-service.js';
import { createEaseeScheduleAdapter, normalizeScheduleState } from '../src/charging/easee.js';
import { createChargingController, validateChargingOwnershipState } from '../src/charging/controller.js';

const NOW = Date.parse('2026-01-01T23:45:00Z'), QUARTER = 15 * 60_000;
const signal = value => ({ value, available: value !== null, assumed: false });
function fixture(prices, { cloud = true } = {}) {
  return { now: NOW, supply: { configuredBudgetCurrentA: [16, 16, 16] },
    prices: prices.map((priceCtPerKwh, index) => ({ start: NOW + index * QUARTER,
      end: NOW + (index + 1) * QUARTER, priceCtPerKwh })),
    chargers: [{ id: 'charger1', label: 'Charger 1', requiredGridKwh: 5.52,
      deadlineAt: NOW + prices.length * QUARTER, settings: { enabled: true },
      capabilities: { scheduling: true, currentControl: false, externalLoadBalancing: true,
        ...(cloud ? { localClockSchedule: true } : {}) },
      configuration: { maximumCurrentA: 16 }, control: {}, telemetry: {},
      values: { connected: signal(true), charging: signal(false), currentA: signal(12),
        maximumCurrentA: signal(16), actualCurrentA: signal(0), voltageV: signal(230), powerKw: signal(0),
        minimumSoc: signal(80), vehicleCeilingSoc: signal(80), soc: signal(20) } }] };
}
const exactGap = [{ startAt: NOW, endAt: NOW + QUARTER }, { startAt: NOW + 2 * QUARTER, endAt: null }];
const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test('a new cloud split cannot promise an exact minimum gap which dispatch cannot preserve', () => {
  const input = fixture([10, 100, 10]), before = structuredClone(input);
  const result = planChargers(input), plan = result.plans.charger1;
  assert.equal(result.feasible, true);
  assert.equal(plan.periods.length, 1);
  // Delivering 5.52 kWh at 11.04 kW needs thirty minutes. In this forty-five
  // minute horizon any strictly longer-than-fifteen-minute gap cannot fit.
  // Every continuous thirty-minute choice buys one expensive quarter hour.
  approx(plan.costCents, 303.6);
  approx(plan.deliveredGridKwh, 5.52);
  assert.ok(plan.finishAt <= input.chargers[0].deadlineAt);
  assert.deepEqual(input, before, 'Original native current and planning inputs stay exact');
});

test('a local OCPP plan retains its representable exact fifteen-minute split', () => {
  const result = planChargers(fixture([10, 100, 10], { cloud: false }));
  assert.equal(result.feasible, true);
  assert.deepEqual(result.plans.charger1.periods, exactGap);
  approx(result.plans.charger1.costCents, 55.2);
});

test('an initial future cloud start remains separate from intermediate pause representation', () => {
  const result = planChargers(fixture([100, 10, 10]));
  assert.equal(result.feasible, true);
  assert.deepEqual(result.plans.charger1.periods, [{ startAt: NOW + QUARTER, endAt: null }]);
  approx(result.plans.charger1.costCents, 55.2);
});

test('cloud planning finds the cheapest valid split instead of forcing a continuous period', () => {
  const input = fixture([5, 100, 6, 6]);
  const witnessPeriods = [{ startAt: NOW, endAt: NOW + QUARTER }, { startAt: NOW + 3 * QUARTER, endAt: null }];
  const witness = forecastFixedPlans({ ...input, periodsByCharger: { charger1: witnessPeriods } });
  assert.equal(witness.feasible, true);
  approx(witness.plans.charger1.costCents, 30.36);
  const result = planChargers(input), plan = result.plans.charger1;
  assert.equal(result.feasible, true);
  assert.ok(plan.periods.length > 1);
  for (let index = 1; index < plan.periods.length; index++)
    assert.ok(plan.periods[index].startAt - plan.periods[index - 1].endAt > QUARTER);
  // The witness buys all 2.76 kWh at five cents, then the remainder at six;
  // this independent price lower bound is achievable within the deadline.
  approx(plan.costCents, 30.36);
  approx(plan.deliveredGridKwh, 5.52);
});

test('forecasting an adopted cloud program preserves its original exact-gap history', () => {
  const input = fixture([10, 100, 10]), frozen = structuredClone(exactGap);
  const result = forecastFixedPlans({ ...input, periodsByCharger: { charger1: exactGap } });
  assert.equal(result.feasible, true);
  assert.deepEqual(result.plans.charger1.periods, frozen);
  assert.deepEqual(exactGap, frozen);
  approx(result.plans.charger1.costCents, 55.2);
});

test('the ordinary planner keeps explicitly admitted execution fixed while pricing its original periods', () => {
  const input = fixture([10, 100, 10]);
  input.chargers[0].control = { phase: 'active', released: true,
    execution: { planId: 'original-adopted-program', periods: structuredClone(exactGap),
      finalStartAt: exactGap[1].startAt, deadlineAt: input.chargers[0].deadlineAt } };
  input.chargers[0].values.charging = signal(true);
  input.chargers[0].values.actualCurrentA = signal(16);
  const original = structuredClone(input);
  // The live runtime supplies confirmed execution as fixedPeriods. The new
  // representation test must not reinterpret that installed program.
  const result = planChargers({ ...input,
    fixedPeriods: { charger1: input.chargers[0].control.execution.periods } });
  assert.equal(result.solver.kind, 'fixed-execution');
  assert.deepEqual(result.plans.charger1.periods, exactGap);
  assert.equal(result.plans.charger1.deadlineAt, original.chargers[0].control.execution.deadlineAt);
  approx(result.plans.charger1.costCents, 55.2);
  assert.deepEqual(input, original, 'Plan ID, original periods, deadline and native readings remain intact');
});

test('a later equal-price edge follows available capacity instead of imposing a thirty-minute gap', () => {
  const input = fixture([5, 100, 6, 6]);
  input.prices.at(-1).end = NOW + 55 * 60_000;
  input.chargers[0].deadlineAt = input.prices.at(-1).end;
  const result = planChargers(input), plan = result.plans.charger1;
  assert.equal(result.feasible, true);
  assert.equal(plan.periods.length, 2);
  assert.equal(plan.periods[1].startAt - plan.periods[0].endAt, 25 * 60_000);
  approx(plan.costCents, 30.36);
  approx(plan.deliveredGridKwh, 5.52);
  assert.ok(plan.finishAt <= input.chargers[0].deadlineAt);
});

test('an equal-price middle block preserves representable gaps at both adjacent periods', () => {
  const input = fixture([5, 100, 6, 6, 100, 5]);
  input.chargers[0].requiredGridKwh = 8.28;
  const witnessPeriods = [{ startAt: NOW, endAt: NOW + QUARTER },
    { startAt: NOW + 37.5 * 60_000, endAt: NOW + 52.5 * 60_000 },
    { startAt: NOW + 5 * QUARTER, endAt: null }];
  const witness = forecastFixedPlans({ ...input, periodsByCharger: { charger1: witnessPeriods } });
  assert.equal(witness.feasible, true);
  approx(witness.plans.charger1.costCents, 44.16);
  const result = planChargers(input), plan = result.plans.charger1;
  assert.equal(result.feasible, true);
  approx(plan.costCents, 44.16, 'Both five-cent quarters and the required six-cent energy remain reachable');
  approx(plan.deliveredGridKwh, 8.28);
  for (let index = 1; index < plan.periods.length; index++)
    assert.ok(plan.periods[index].startAt - plan.periods[index - 1].endAt > QUARTER);
});

test('a centered same-price placement skips a complete unused interval without inventing a run', () => {
  const input = fixture([5, 100, 6, 6, 6, 100, 5]);
  input.chargers[0].requiredGridKwh = 8.28;
  const result = planChargers(input), plan = result.plans.charger1;
  assert.equal(result.feasible, true);
  approx(plan.costCents, 44.16);
  approx(plan.deliveredGridKwh, 8.28);
  assert.equal(plan.periods.length, 3);
  assert.deepEqual(plan.periods[1], { startAt: NOW + 3 * QUARTER, endAt: NOW + 4 * QUARTER });
  assert.ok(plan.periods.every(row => row.startAt % 1000 === 0 && (row.endAt === null || row.endAt % 1000 === 0)));
  assert.ok(plan.finishAt <= input.chargers[0].deadlineAt);
});

test('only the adjacent selected boundary can create an exact cloud gap', () => {
  const input = fixture([5, 100, 100, 5, 5, 6, 6]);
  input.chargers[0].requiredGridKwh = 11.04;
  const result = planChargers(input), plan = result.plans.charger1;
  assert.equal(result.feasible, true);
  // The six-cent run joins the selected five-cent block ending at minute 75.
  // Its older interior row ending at minute 60 is not a pause boundary.
  approx(plan.costCents, 57.96);
  approx(plan.deliveredGridKwh, 11.04);
  assert.deepEqual(plan.periods, [{ startAt: NOW, endAt: NOW + QUARTER },
    { startAt: NOW + 3 * QUARTER, endAt: null }]);
  assert.ok(plan.finishAt <= input.chargers[0].deadlineAt);
});

test('a joined following period keeps its nearest boundary despite a later interior row', () => {
  const input = fixture([6, 6, 5, 5, 100, 100, 5]);
  input.chargers[0].requiredGridKwh = 11.04;
  const result = planChargers(input), plan = result.plans.charger1;
  assert.equal(result.feasible, true);
  // The six-cent run ends at the five-cent block's actual beginning, minute
  // 30. Its interior row beginning at minute 45 is not a pause boundary.
  approx(plan.costCents, 57.96);
  approx(plan.deliveredGridKwh, 11.04);
  assert.deepEqual(plan.periods, [{ startAt: NOW + QUARTER, endAt: NOW + 4 * QUARTER },
    { startAt: NOW + 6 * QUARTER, endAt: null }]);
  assert.ok(plan.finishAt <= input.chargers[0].deadlineAt);
});

test('cloud gap alternatives retain joint phase limits, peer deadlines and complete cash cost', () => {
  const input = fixture([5, 100, 6, 6]);
  input.priority = 'charger1';
  input.supply.configuredBudgetCurrentA = [28, 32, 32];
  const peer = structuredClone(input.chargers[0]);
  Object.assign(peer, { id: 'charger2', label: 'Charger 2', requiredGridKwh: 2.07, deadlineAt: NOW + QUARTER,
    capabilities: { scheduling: true, currentControl: true, externalLoadBalancing: false } });
  input.chargers.push(peer);
  const before = structuredClone(input), result = planChargers(input);
  assert.equal(result.feasible, true);
  for (const charger of input.chargers) {
    const plan = result.plans[charger.id];
    approx(plan.deliveredGridKwh, charger.requiredGridKwh);
    assert.ok(plan.finishAt <= charger.deadlineAt, `${charger.id} retains its service deadline`);
  }
  assert.ok(result.allocations.every(row => row.phaseCurrentA.every((amps, phase) =>
    amps <= input.supply.configuredBudgetCurrentA[phase] + 1e-7)));
  // Both requests can buy their full first quarter at five cents, with C1's
  // remaining quarter at six. The sum is an achievable joint price bound.
  approx(result.plans.charger1.costCents + result.plans.charger2.costCents, 40.71);
  approx(result.solver.cashCostCandidateCents, 40.71);
  assert.deepEqual(input, before, 'No native reading, permission or source input is rewritten');
});

test('unequal cloud and adjustable-peer requests can move together into the cheapest representable windows', () => {
  const input = fixture([5, 100, 6, 6, 100, 5]);
  input.chargers[0].requiredGridKwh = 6;
  const peer = structuredClone(input.chargers[0]);
  Object.assign(peer, { id: 'charger2', label: 'Charger 2', requiredGridKwh: 2.28,
    capabilities: { scheduling: true, currentControl: true, externalLoadBalancing: false } });
  input.chargers.push(peer);
  const witnessPeriods = [{ startAt: NOW, endAt: NOW + QUARTER },
    { startAt: NOW + 37.5 * 60_000, endAt: NOW + 52.5 * 60_000 },
    { startAt: NOW + 5 * QUARTER, endAt: null }];
  const witness = forecastFixedPlans({ ...input,
    periodsByCharger: { charger1: witnessPeriods, charger2: witnessPeriods } });
  assert.equal(witness.feasible, true);
  approx(witness.solver.cashCostCandidateCents, 44.16);
  const original = structuredClone(input), result = planChargers(input);
  assert.equal(result.feasible, true);
  approx(result.solver.cashCostCandidateCents, 44.16);
  for (const charger of input.chargers) {
    approx(result.plans[charger.id].deliveredGridKwh, charger.requiredGridKwh);
    assert.ok(result.plans[charger.id].finishAt <= charger.deadlineAt);
  }
  assert.ok(result.allocations.every(row => row.phaseCurrentA.every(amps => amps <= 16 + 1e-7)));
  const cloudPeriods = result.plans.charger1.periods;
  for (let index = 1; index < cloudPeriods.length; index++)
    assert.ok(cloudPeriods[index].startAt - cloudPeriods[index - 1].endAt > QUARTER);
  assert.deepEqual(input, original);
});

test('the real planner worker transports the existing cloud capability and invalidates its cache on backend change', async t => {
  const service = createChargingPlannerService();
  t.after(() => service.close());
  const input = fixture([10, 100, 10]), original = structuredClone(input);
  const cloud = await service.request(input);
  assert.deepEqual(cloud, planChargers(input));
  assert.equal(cloud.plans.charger1.periods.length, 1);
  delete input.chargers[0].capabilities.localClockSchedule;
  const local = await service.request(input);
  assert.deepEqual(local, planChargers(input));
  assert.deepEqual(local.plans.charger1.periods, exactGap);
  approx(local.plans.charger1.costCents, 55.2);
  assert.deepEqual(original.chargers[0].values, input.chargers[0].values);
});

test('a selected longer cloud gap dispatches through the actual adapter after read and durable-intent delay', async t => {
  const plan = { ...planChargers(fixture([5, 100, 6, 6])).plans.charger1, id: 'representable-cloud-plan' };
  assert.equal(plan.periods[1].startAt - plan.periods[0].endAt, 30 * 60_000);
  let now = NOW, mode = 3, schedule = normalizeScheduleState({ enabled: 'none' });
  let delayRead = false, delayedIntent = false;
  const posts = [], saved = [];
  const observation = (id, value) => ({ id, value, timestamp: new Date(now).toISOString() });
  const adapter = createEaseeScheduleAdapter({ chargerId: 'synthetic-charger', clock: () => now, canControl: () => true,
    waitForReadback: async () => {}, request: async (url, options) => {
      if (options.method === 'GET') {
        if (delayRead) { now += 2500; delayRead = false; }
        if (url.endsWith('/schedules')) return structuredClone(schedule);
        return [observation(250, true), observation(31, true), observation(109, mode),
          observation(96, mode === 2 ? 54 : 77), observation(47, 16), observation(48, 32),
          observation(104, 32), observation(120, mode === 3 ? 8 : 0),
          ...[22, 23, 24].map(id => observation(id, 20)),
          ...[230, 231, 232].map(id => observation(id, 12))];
      }
      if (options.controlGuard && !options.controlGuard()) throw Error('revoked');
      const body = options.body ? JSON.parse(options.body) : null;
      posts.push({ url, body, dispatchedAt: now });
      assert.ok(url.endsWith('/schedules/delayed'), 'Only the supported delayed schedule is dispatched');
      schedule = normalizeScheduleState({ enabled: 'delayed', delayed: body }); mode = 2;
      return '';
    } });
  const controller = createChargingController({ adapter, canControl: () => true, clock: () => now,
    saveState: value => {
      validateChargingOwnershipState(value);
      if (value.pending?.action === 'install' && Number.isFinite(value.pending.installRequestedAt) && !delayedIntent) {
        now += 2000; delayedIntent = true;
      }
      saved.push(structuredClone(value));
    } });
  t.after(() => controller.close());
  const update = () => controller.update({ enabled: true, plan, timezone: 'Europe/Helsinki', maximumAmps: 16 });
  await update();
  assert.equal(controller.status().execution.planId, plan.id);
  now = plan.periods[0].endAt; delayRead = true;
  await update();
  assert.equal(posts.length, 1);
  assert.ok(posts[0].dispatchedAt > plan.periods[0].endAt, 'Actual positive dispatch latency is exercised');
  assert.ok(plan.periods[1].startAt - posts[0].dispatchedAt >= QUARTER);
  assert.equal(controller.status().pending, null);
  assert.equal(controller.status().phase, 'paused');
  assert.equal(controller.status().owned.startAt, plan.periods[1].startAt);
  assert.equal(controller.status().snapshot.powerKw, 0);
  assert.equal(controller.status().snapshot.observations[109].at, now);
  assert.equal(delayedIntent, true, 'The final durable pre-dispatch intent is exercised');
  assert.ok(saved.some(value => value.pending?.action === 'install'), 'Real controller intent precedes the REST write');
});
