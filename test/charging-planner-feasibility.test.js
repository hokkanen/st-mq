import test from 'node:test';
import assert from 'node:assert/strict';
import { planChargers } from '../src/charging/planner.js';
import { createChargingPlannerService } from '../src/charging/planner-service.js';

const HOUR = 3_600_000, MINUTE = 60_000, now = Date.parse('2026-01-15T00:00:00Z');
const reading = value => ({ value, available: value !== null, assumed: false });

function splitFixture({ phase = 0, priority = 'balanced' } = {}) {
  const chargers = ['charger1', 'charger2'].map((id, index) => ({
    id, label: id, requiredGridKwh: index ? 36 : 24, deadlineAt: now + 6 * HOUR,
    settings: { enabled: true },
    capabilities: { scheduling: true, currentControl: false, externalLoadBalancing: index === 0 },
    values: { connected: reading(true), charging: reading(false), currentA: reading(16),
      maximumCurrentA: reading(16), voltageV: reading(230), powerKw: reading(0),
      minimumSoc: reading(80), vehicleCeilingSoc: reading(null), soc: reading(20) },
    control: {}, telemetry: {},
  }));
  return { now, chargers, priority, supply: { configuredBudgetCurrentA: [22, 22, 22] },
    prices: [9, 9, 9, 9, 1, 1].map((priceCtPerKwh, index) => ({
      start: now + index * HOUR, end: now + (index + 1) * HOUR, priceCtPerKwh,
    })),
    household: [1, 4].map(hour => ({ start: now + hour * HOUR, end: now + (hour + 1) * HOUR,
      phaseCurrentA: [0, 1, 2].map(index => index === phase ? 12 : 0) })),
  };
}

function assertPracticalPeriods(plan) {
  assert.equal(plan.periods.at(-1).endAt, null, 'The final period must remain open');
  for (let index = 0; index < plan.periods.length - 1; index++) {
    const period = plan.periods[index], next = plan.periods[index + 1];
    assert.ok(period.endAt - period.startAt >= 15 * MINUTE, 'Intermediate runs last at least 15 minutes');
    assert.ok(next.startAt - period.endAt >= 15 * MINUTE, 'Intermediate pauses last at least 15 minutes');
  }
}

test('fixed 16 A charging uses earlier split opportunities before reporting insufficient time', () => {
  const input = splitFixture();
  // Independent construction: the fixed-current car can use hours 0–1, 2–4,
  // and 5 onward. Its peer receives the externally balanced remainder. Neither
  // vehicle supplies identity, a charge target, or permission to change 16 A.
  const witness = planChargers({ ...input, fixedPeriods: {
    charger1: [{ startAt: now, endAt: null }],
    charger2: [{ startAt: now, endAt: now + HOUR },
      { startAt: now + 2 * HOUR, endAt: now + 4 * HOUR },
      { startAt: now + 5 * HOUR, endAt: null }],
  } });
  assert.equal(witness.feasible, true, 'The model can serve both requests without increasing a native limit');
  const before = structuredClone(input), result = planChargers(input);
  assert.equal(result.feasible, true, 'A future overload must not discard all earlier useful charging windows');
  assert.deepEqual(input, before, 'Searching never changes native limits or request ownership');
  for (const plan of Object.values(result.plans)) {
    assert.equal(plan.feasible, true);
    assert.ok(plan.finishAt <= plan.deadlineAt);
    assertPracticalPeriods(plan);
  }
  assert.ok(result.plans.charger2.periods.length > 1);
  assert.ok(result.plans.charger2.startAt < now + HOUR);
  const replay = planChargers({ ...input,
    fixedPeriods: Object.fromEntries(Object.entries(result.plans).map(([id, plan]) => [id, plan.periods])) });
  assert.equal(replay.feasible, true, 'The published periods must reproduce the claimed service');
  assert.equal(result.currentLimits.length, 0, 'A scheduling-only device receives no current proposal');
  for (const row of result.allocations) {
    const current = row.chargers.charger2?.currentA ?? 0;
    assert.ok(current === 0 || current === 16, 'The fixed pilot remains 16 A');
    assert.ok(row.phaseCurrentA.every((amps, phase) => amps <= row.phaseHeadroomA[phase] + 1e-8));
  }
});

test('split feasibility respects every phase and every selected priority', async t => {
  for (const phase of [0, 1, 2]) for (const priority of ['balanced', 'charger1', 'charger2']) {
    await t.test(`phase ${phase + 1}, ${priority}`, () => {
      const input = splitFixture({ phase, priority }), result = planChargers(input);
      assert.equal(result.feasible, true, 'Priority cannot discard a candidate that serves both requests');
      for (const plan of Object.values(result.plans)) assertPracticalPeriods(plan);
      for (const peak of input.household) assert.ok(result.allocations
        .filter(row => row.start < peak.end && row.end > peak.start)
        .every(row => !(row.chargers.charger2?.currentA > 0)), 'The fixed pilot cannot cross the constrained phase');
    });
  }
});

test('a household scenario peak cannot be replaced with its permissive average', () => {
  const input = splitFixture({ phase: 1 });
  for (const row of input.household) {
    row.phaseCurrentA = [0, 3, 0];
    row.scenarios = [{ weight: 3, phaseCurrentA: [0, 0, 0] }, { weight: 1, phaseCurrentA: [0, 12, 0] }];
  }
  const result = planChargers(input);
  assert.equal(result.feasible, true);
  for (const peak of input.household) assert.ok(result.allocations
    .filter(row => row.start < peak.end && row.end > peak.start)
    .every(row => !(row.chargers.charger2?.currentA > 0)), 'Mean 19 A headroom does not authorize a fixed 16 A pilot through a 10 A scenario');
});

test('feasibility search keeps fixed native periods and schedule-capability limits', async t => {
  await t.test('confirmed fixed permission', () => {
    const input = splitFixture(), fixed = [{ startAt: now + 5 * HOUR, endAt: null }];
    const result = planChargers({ ...input, fixedPeriods: { charger2: fixed } });
    assert.equal(result.feasible, false);
    assert.deepEqual(result.plans.charger2.periods, fixed, 'A candidate cannot move a fixed native instruction');
    assert.ok(result.plans.charger2.deliveredGridKwh <= 11.04 + 1e-8);
  });
  for (const limit of [1, 2]) await t.test(`at most ${limit} periods`, () => {
    const input = splitFixture();
    input.chargers[1].capabilities.maxSchedulePeriods = limit;
    const result = planChargers(input);
    assert.equal(result.feasible, false, 'This request needs all three physically usable windows');
    assert.ok(result.plans.charger2.periods.length <= limit);
    assertPracticalPeriods(result.plans.charger2);
  });
});

test('earlier split opportunities preserve the vehicle start and native current limits', () => {
  const input = splitFixture();
  input.chargers[1].values.vehicleNotBefore = reading(now + 30 * MINUTE);
  const result = planChargers(input);
  assert.equal(result.feasible, true);
  assert.ok(result.plans.charger2.periods.every(period => period.startAt >= now + 30 * MINUTE));
  const limited = splitFixture();
  limited.chargers[1].values.currentA = reading(8);
  const constrained = planChargers(limited);
  assert.equal(constrained.plans.charger2.feasible, false);
  assert.ok(constrained.plans.charger2.deliveredGridKwh <= 8 * .69 * 6 + 1e-8);
  assert.ok(constrained.allocations.every(row => (row.chargers.charger2?.currentA ?? 0) <= 8));
  assert.equal(constrained.currentLimits.length, 0);
});

test('the recovered split schedule remains practical when an extra short window or gap is present', async t => {
  for (const kind of ['short-window', 'short-gap']) await t.test(kind, () => {
    const input = splitFixture();
    if (kind === 'short-window') {
      input.household[0].start = now + 10 * MINUTE;
      input.chargers[1].requiredGridKwh = 30;
    } else input.household[0].end = input.household[0].start + 5 * MINUTE;
    const result = planChargers(input);
    for (const plan of Object.values(result.plans)) assertPracticalPeriods(plan);
    for (const peak of input.household) assert.ok(result.allocations
      .filter(row => row.start < peak.end && row.end > peak.start)
      .every(row => !(row.chargers.charger2?.currentA > 0)), 'Practical consolidation cannot bridge an electrical restriction');
    const replay = planChargers({ ...input,
      fixedPeriods: Object.fromEntries(Object.entries(result.plans).map(([id, plan]) => [id, plan.periods])) });
    assert.equal(replay.feasible, result.feasible, 'Reported feasibility describes the published periods');
  });
});

test('balanced planning preserves an earlier deadline by pausing the later request during a shared shortage', () => {
  const quarter = 15 * MINUTE;
  for (const rawPrices of [[1, 1, 1, 1], [10, 10, -2, 15]]) {
    const input = splitFixture({ priority: 'balanced' });
    input.supply.configuredBudgetCurrentA = [12, 12, 12];
    input.prices = rawPrices.map((priceCtPerKwh, index) => ({
      start: now + index * quarter, end: now + (index + 1) * quarter, priceCtPerKwh,
    }));
    input.household = [12, 6, 12, 6].map((available, index) => ({
      start: now + index * quarter, end: now + (index + 1) * quarter,
      phaseCurrentA: Array(3).fill(12 - available),
    }));
    input.chargers.forEach((charger, index) => {
      charger.requiredGridKwh = [2, 3][index] * 1.035;
      charger.deadlineAt = now + [2, 4][index] * quarter;
      charger.values.currentA = reading(6);
      charger.values.maximumCurrentA = reading(6);
      charger.values.vehicleCeilingSoc = reading(80);
      charger.capabilities.currentControl = index === 1;
    });
    // Independent five-slot witness: C1 needs both early slots, while C2 uses
    // the first, third and fourth. Each slot delivers 6 A * 690 V * .25 h.
    const witness = { charger1: [{ startAt: now, endAt: null }], charger2: [
      { startAt: now, endAt: now + quarter }, { startAt: now + 2 * quarter, endAt: null },
    ] };
    assert.equal(planChargers({ ...input, fixedPeriods: witness }).feasible, true);
    const before = structuredClone(input), result = planChargers(input);
    assert.equal(result.feasible, true, 'Normalized sharing must not hide an available schedule meeting both deadlines');
    assert.deepEqual(input, before);
    const expectedCost = 1.035 * (2 * rawPrices[0] + rawPrices[1] + rawPrices[2] + rawPrices[3]);
    assert.ok(result.solver.cashCostCandidateCents <= expectedCost + 1e-7);
    for (const plan of Object.values(result.plans)) {
      assert.ok(plan.finishAt <= plan.deadlineAt);
      assertPracticalPeriods(plan);
    }
    assert.equal(planChargers({ ...input, fixedPeriods: Object.fromEntries(Object.entries(result.plans)
      .map(([id, plan]) => [id, plan.periods])) }).feasible, true);
    input.chargers[1].capabilities.maxSchedulePeriods = 1;
    assert.equal(planChargers(input).feasible, false, 'The earlier deadline cannot invent a second native period');
  }
});

test('the real worker finds a full-day fixed-current split plan while the main thread remains responsive', async t => {
  const service = createChargingPlannerService();
  t.after(() => service.close());
  const input = splitFixture({ phase: 2 });
  for (const charger of input.chargers) {
    charger.requiredGridKwh *= 4;
    charger.deadlineAt = now + 24 * HOUR;
  }
  input.prices = Array.from({ length: 96 }, (_, index) => ({
    start: now + index * 15 * MINUTE, end: now + (index + 1) * 15 * MINUTE,
    priceCtPerKwh: index >= 64 ? 1 : 9,
  }));
  input.household = input.prices.map((row, index) => {
    const peak = index >= 16 && index < 32 || index >= 64 && index < 80;
    return { start: row.start, end: row.end, phaseCurrentA: [0, 0, peak ? 11 : 0],
      scenarios: Array.from({ length: 6 }, (_, scenario) => ({ weight: scenario + 1,
        phaseCurrentA: [0, 0, peak ? 12 - scenario / 4 : 0] })) };
  });
  const before = structuredClone(input), started = performance.now();
  let beats = 0;
  const heartbeat = setInterval(() => { beats++; }, 5);
  t.after(() => clearInterval(heartbeat));
  const result = await service.request(input);
  clearInterval(heartbeat);
  assert.equal(result.feasible, true);
  assert.ok(beats > 0, 'The additional feasibility candidate stays inside the planner worker');
  assert.deepEqual(input, before);
  for (const plan of Object.values(result.plans)) assertPracticalPeriods(plan);
  assert.equal(result.solver.globalOptimalityProven, false);
  assert.equal(result.solver.candidateLimitPerJob, 48);
  assert.equal(result.currentLimits.length, 0);
  t.diagnostic(`96 intervals and six scenarios: ${(performance.now() - started).toFixed(1)} ms, ${beats} main-thread heartbeats`);
});
