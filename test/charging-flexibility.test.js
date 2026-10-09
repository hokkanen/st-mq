import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingFlexibility, consumeChargingFlexibility, changeChargingFlexibility,
  nextLocalChargingDay, validateChargingFlexibility, admittedChargingDeadlineRevision } from '../src/charging/flexibility.js';
import { compareChargingFlexibility } from '../src/charging/flexibility-comparison.js';
import { planChargers } from '../src/charging/planner.js';
import { createChargingPlannerService } from '../src/charging/planner-service.js';
import { delayedScheduleFor } from '../src/charging/easee.js';

const at = Date.parse, HOUR = 3_600_000;
const request = () => ({ sessionId: 'synthetic-connection', revision: 1, deadlineAt: at('2026-10-09T03:00:00Z') });
const allow = (value, now, actionId = 'approval-1') => changeChargingFlexibility(value, { action: 'allow', actionId }, now);

test('renewable calendar-day permission consumes once at each checkpoint and never silently rolls a missed deadline', () => {
  const value = request(), thursday = at('2026-10-08T14:02:00Z');
  allow(value, thursday);
  assert.equal(value.deadlineAt, at('2026-10-10T03:00:00Z'));
  assert.equal(chargingFlexibility(value, thursday).active, true);
  assert.equal(allow(value, thursday, 'approval-1'), false, 'same authorization is idempotent');
  assert.throws(() => allow(value, thursday, 'approval-stack'), /already allowed/);
  const checkpoint = at('2026-10-09T03:00:00Z'), before = structuredClone(value);
  assert.equal(chargingFlexibility(value, checkpoint).active, false, 'read-only projection removes highlight exactly on time');
  assert.deepEqual(value, before, 'status does not mutate the persisted request');
  assert.equal(consumeChargingFlexibility(value, checkpoint), true);
  assert.equal(consumeChargingFlexibility(value, checkpoint), false);
  assert.equal(value.flexibility.normalReadyByAt, at('2026-10-10T03:00:00Z'));
  assert.equal(value.flexibility.authorizedBaseline, true);
  allow(value, at('2026-10-09T06:00:00Z'), 'approval-2');
  assert.equal(value.deadlineAt, at('2026-10-11T03:00:00Z'));
  assert.equal(chargingFlexibility(value, at('2026-10-10T03:00:00Z')).active, false);
  consumeChargingFlexibility(value, at('2026-10-10T03:00:00Z'));
  assert.equal(consumeChargingFlexibility(value, at('2026-10-12T10:00:00Z')), false);
  assert.equal(value.deadlineAt, at('2026-10-11T03:00:00Z'), 'lateness never forgives another day');
  assert.throws(() => allow(value, at('2026-10-11T03:00:00Z'), 'late-approval'), /passed/);
  validateChargingFlexibility(value);
});

test('downtime consumes only the authorized day and keeps the promoted overdue obligation', () => {
  const original = request(); allow(original, at('2026-10-08T14:00:00Z'));
  const restored = structuredClone(original), monday = at('2026-10-12T12:00:00Z');
  validateChargingFlexibility(restored);
  assert.equal(consumeChargingFlexibility(restored, monday), true);
  assert.equal(restored.deadlineAt, at('2026-10-10T03:00:00Z'));
  assert.equal(restored.flexibility.lastTransition.at, at('2026-10-09T03:00:00Z'));
  const revision = restored.revision;
  assert.equal(consumeChargingFlexibility(restored, monday), false);
  assert.equal(restored.revision, revision);
});

test('cancellation restores only a live baseline; a newly renewed grant retains promoted ownership', () => {
  const value = request(), now = at('2026-10-08T14:00:00Z'); allow(value, now);
  changeChargingFlexibility(value, { action: 'cancel', actionId: 'cancel-1' }, now + 1);
  assert.equal(value.deadlineAt, at('2026-10-09T03:00:00Z'));
  assert.equal(value.flexibility.authorizedBaseline, false);
  assert.equal(changeChargingFlexibility(value, { action: 'cancel', actionId: 'cancel-1' }, now + 2), false);
  allow(value, now + 3, 'approval-2');
  allow(value, at('2026-10-09T06:00:00Z'), 'approval-3');
  assert.equal(value.flexibility.authorizedBaseline, true, 'consumption inside the action is preserved');
  changeChargingFlexibility(value, { action: 'cancel', actionId: 'cancel-2' }, at('2026-10-09T06:00:01Z'));
  assert.equal(value.deadlineAt, at('2026-10-10T03:00:00Z'));
  assert.equal(value.flexibility.authorizedBaseline, true);
  assert.throws(() => changeChargingFlexibility(value, { action: 'cancel', actionId: 'cancel-too-late' },
    at('2026-10-10T06:00:00Z')), /no active/);
});

test('Helsinki calendar days preserve the clock through 23/25-hour days and resolve gaps/ambiguity deterministically', () => {
  assert.equal(nextLocalChargingDay(at('2026-03-28T04:00:00Z')), at('2026-03-29T03:00:00Z'), '06:00 remains 06:00 after spring DST');
  assert.equal(nextLocalChargingDay(at('2026-10-24T03:00:00Z')), at('2026-10-25T04:00:00Z'), '06:00 remains 06:00 after autumn DST');
  assert.equal(nextLocalChargingDay(at('2026-03-28T01:30:00Z')), at('2026-03-29T01:30:00Z'), 'missing 03:30 shifts to 04:30');
  assert.equal(nextLocalChargingDay(at('2026-10-24T00:30:00Z')), at('2026-10-25T00:30:00Z'), 'ambiguous 03:30 chooses its earlier occurrence');
});

test('malformed permissions fail closed rather than inventing or translating authorized days', () => {
  for (const mutate of [v => { v.flexibility.activeDefer.deferredReadyByAt += 24 * HOUR; },
    v => { v.flexibility.unrecognized = true; }, v => { v.deadlineAt++; },
    v => { v.flexibility.activeDefer.checkpointAt++; }, v => { v.flexibility.activeDefer.revision += 100; },
    v => { delete v.flexibility.lastTransition; }, v => { delete v.flexibility.activeDefer; },
    v => { v.flexibility.lastTransition.id = 'different-approval'; }]) {
    const value = request(); allow(value, at('2026-10-08T14:00:00Z')); mutate(value);
    assert.throws(() => validateChargingFlexibility(value), /Unsupported/);
  }
});

test('native deadline revisions require separately supplied matching current session request authority', () => {
  const scope = { actionId: 'approved', revision: 7, connectedAt: 1000, deadlineAt: 5000 };
  const plan = { deadlineAt: 5000, priceRevision: { deadlineRequest: { ...scope } } };
  assert.equal(admittedChargingDeadlineRevision(plan, 3000, scope, 1000), true);
  assert.equal(admittedChargingDeadlineRevision(plan, 3000, null, 1000), false);
  assert.equal(admittedChargingDeadlineRevision(plan, 3000, { ...scope, revision: 8 }, 1000), false);
  assert.equal(admittedChargingDeadlineRevision(plan, 3000, scope, 2000), false);
  assert.equal(admittedChargingDeadlineRevision({ ...plan, deadlineAt: 6000 }, 3000, scope, 1000), false);
  assert.equal(admittedChargingDeadlineRevision({ deadlineAt: 3000 }, 3000, null, 1000), true,
    'ordinary same-deadline price revisions retain their existing contract');
});

const reading = value => ({ value, available: true, assumed: false });
function planning(two = false) {
  const now = at('2026-10-08T00:00:00Z');
  const charger = (id, currentControl) => ({ id, label: id, requiredGridKwh: 5, referenceGridKwh: 6,
    deadlineAt: now + 2 * HOUR, settings: { enabled: true }, sessionCost: { recordedGridKwh: 1 },
    capabilities: { scheduling: true, currentControl, externalLoadBalancing: !currentControl },
    configuration: { maximumCurrentA: 16 }, control: {}, telemetry: {},
    values: { connected: reading(true), charging: reading(false), currentA: reading(16), maximumCurrentA: reading(16),
      actualCurrentA: reading(0), voltageV: reading(230), powerKw: reading(0), minimumSoc: reading(80),
      vehicleCeilingSoc: reading(80), soc: reading(20) } });
  return { now, supply: { configuredBudgetCurrentA: [16, 16, 16], voltageV: [230, 230, 230] },
    prices: Array.from({ length: 4 }, (_, index) => ({ start: now + index * HOUR, end: now + (index + 1) * HOUR,
      priceCtPerKwh: index < 2 ? 20 : 1, ...(index >= 2 ? { predicted: true, uncertaintyCtPerKwh: 2 } : {}) })),
    chargers: [charger('charger1', false), ...(two ? [charger('charger2', true)] : [])] };
}

test('forecast premium is decision-only, applies to predictions only, and needs explicit forecast authority', () => {
  const options = planning(); options.chargers[0].deadlineAt = options.now + 4 * HOUR;
  const ordinary = planChargers(options).plans.charger1;
  assert.ok(ordinary.finishAt <= options.now + 2 * HOUR);
  assert.equal(ordinary.costCents, 100);
  assert.equal(ordinary.uncertaintyPremiumCents, 0);
  options.chargers[0].forecastAllowed = true;
  const flexible = planChargers(options).plans.charger1;
  assert.ok(flexible.startAt >= options.now + 2 * HOUR);
  assert.ok(Math.abs(flexible.costCents - 5) < 1e-6);
  assert.ok(Math.abs(flexible.uncertaintyPremiumCents - 10) < 1e-6);
  assert.ok(Math.abs(flexible.decisionCostCents - 15) < 1e-6);
  assert.ok(flexible.accounting.every(row => row.priceCtPerKwh === 1 && row.predicted));
  const cheaperKnown = structuredClone(options); cheaperKnown.prices.slice(0, 2).forEach(row => { row.priceCtPerKwh = 2; });
  assert.ok(planChargers(cheaperKnown).plans.charger1.finishAt <= options.now + 2 * HOUR,
    'a one-cent speculative saving cannot overcome a two-cent uncertainty premium');
});

test('published prices supersede predictions even when the supplied prediction sorts first', () => {
  const options = planning(); options.chargers[0].forecastAllowed = true;
  options.prices.unshift({ start: options.now, end: options.now + 2 * HOUR, priceCtPerKwh: -50, predicted: true });
  const plan = planChargers(options).plans.charger1;
  assert.equal(plan.costCents, 100); assert.equal(plan.uncertaintyPremiumCents, 0);
});

test('an unapproved peer continues its unknown post-target load through predicted hours', () => {
  const options = planning(true);
  options.chargers[0].forecastAllowed = true; options.chargers[0].deadlineAt = options.now + 4 * HOUR;
  options.chargers[1].values.vehicleCeilingSoc = { value: null, available: false };
  const result = planChargers(options);
  assert.equal(result.plans.charger2.feasible, true);
  assert.ok(result.allocations.filter(row => row.start >= options.now + 2 * HOUR)
    .some(row => row.chargers.charger2?.currentA > 0),
  'a published-price horizon ending is not evidence that a released peer stops drawing');
});

test('cloud local-clock candidates stay representable while OCPP retains the full 48-hour opportunity', () => {
  const options = planning(), now = options.now;
  options.chargers[0].forecastAllowed = true; options.chargers[0].deadlineAt = now + 44 * HOUR;
  options.prices = Array.from({ length: 48 }, (_, index) => ({ start: now + index * HOUR,
    end: now + (index + 1) * HOUR, priceCtPerKwh: index >= 30 && index < 34 ? 1 : 20,
    ...(index >= 24 ? { predicted: true, uncertaintyCtPerKwh: 2 } : {}) }));
  const local = planChargers(options).plans.charger1;
  assert.equal(local.feasible, true); assert.equal(local.startAt, now + 30 * HOUR);
  options.chargers[0].capabilities.localClockSchedule = true;
  const cloud = planChargers(options).plans.charger1;
  assert.equal(cloud.feasible, true); assert.ok(cloud.startAt <= now + 24 * HOUR);
  let pauseAt = now;
  for (const period of cloud.periods) {
    if (period.startAt > pauseAt) assert.doesNotThrow(() => delayedScheduleFor({ startAt: period.startAt,
      timezone: 'Europe/Helsinki', maximumAmps: 16 }, pauseAt));
    pauseAt = period.endAt ?? Infinity;
  }
  assert.ok(cloud.costCents >= local.costCents);
});

test('cloud candidates cannot select either ambiguous Helsinki autumn start hour', () => {
  const options = planning(); options.now = at('2026-10-24T22:00:00Z');
  options.chargers[0].deadlineAt = options.now + 6 * HOUR;
  options.chargers[0].capabilities.localClockSchedule = true;
  options.prices = Array.from({ length: 24 }, (_, index) => ({ start: options.now + index * HOUR / 4,
    end: options.now + (index + 1) * HOUR / 4, priceCtPerKwh: index >= 8 && index < 16 ? 0 : 20 }));
  const result = planChargers(options).plans.charger1;
  assert.equal(result.feasible, true);
  let pauseAt = options.now;
  for (const period of result.periods) {
    if (period.startAt > pauseAt) assert.doesNotThrow(() => delayedScheduleFor({ startAt: period.startAt,
      timezone: 'Europe/Helsinki', maximumAmps: 16 }, pauseAt));
    pauseAt = period.endAt ?? Infinity;
  }
  assert.ok(result.startAt < at('2026-10-25T00:00:00Z') || result.startAt >= at('2026-10-25T02:00:00Z'));
});

test('one snapshot compares equal remaining service for both chargers and exposes household impact separately', () => {
  const options = planning(true), before = structuredClone(options);
  const comparison = compareChargingFlexibility(options, { chargerId: 'charger1',
    normalReadyByAt: options.now + 2 * HOUR, deferredReadyByAt: options.now + 4 * HOUR });
  assert.equal(comparison.available, true); assert.equal(comparison.recommended, true);
  assert.equal(comparison.priceCoverage, 'complete');
  assert.ok(Math.abs(comparison.savingsCents - 95) < 1e-6);
  assert.ok(Math.abs(comparison.householdSavingsCents - 95) < 1e-6);
  assert.ok(Math.abs(comparison.riskAdjustedSavingsCents - 85) < 1e-6);
  assert.equal(comparison.chargers.length, 2);
  assert.ok(Math.abs(comparison.chargers[1].normalCostCents - comparison.chargers[1].deferredCostCents) < 1e-6);
  assert.deepEqual(options, before, 'no delivered energy or session request is reset by a counterfactual');
});

test('refreshing an active allowance preserves the ordinary baseline forecast permission', () => {
  const options = planning();
  const choice = { chargerId: 'charger1', normalReadyByAt: options.now + 3 * HOUR,
    deferredReadyByAt: options.now + 4 * HOUR, normalForecastAllowed: false };
  const original = compareChargingFlexibility(options, choice);
  options.chargers[0].forecastAllowed = true;
  options.chargers[0].deadlineAt = choice.deferredReadyByAt;
  const active = compareChargingFlexibility(options, choice);
  assert.deepEqual(active, original, 'allowing the day does not silently authorize the earlier alternative to use predictions');
  const promoted = compareChargingFlexibility(options, { ...choice, normalForecastAllowed: true });
  assert.ok(promoted.normalCostCents < original.normalCostCents,
    'a previously consumed allowance retains its explicit baseline permission');
});

test('prices ending before ready-by still compare equal service in the cheapest available slots', () => {
  const options = planning(true); options.prices.pop();
  const before = structuredClone(options);
  const comparison = compareChargingFlexibility(options, { chargerId: 'charger1',
    normalReadyByAt: options.now + 2 * HOUR, deferredReadyByAt: options.now + 26 * HOUR });
  assert.equal(comparison.available, true);
  assert.equal(comparison.priceCoverage, 'partial');
  assert.ok(Math.abs(comparison.normalCostCents - 100) < 1e-6);
  assert.ok(Math.abs(comparison.deferredCostCents - 5) < 1e-6);
  assert.ok(Math.abs(comparison.savingsCents - 95) < 1e-6);
  assert.ok(Math.abs(comparison.householdSavingsCents - 95) < 1e-6);
  assert.ok(comparison.deferredPeriods[0].startAt >= options.now + 2 * HOUR);
  assert.ok(comparison.deferredFinishAt <= options.now + 3 * HOUR);
  assert.equal(comparison.chargers.length, 2);
  assert.deepEqual(options, before);
});

test('partial coverage with only the original slots yields a real zero saving', () => {
  const options = planning(); options.prices.splice(2);
  const comparison = compareChargingFlexibility(options, { chargerId: 'charger1',
    normalReadyByAt: options.now + 2 * HOUR, deferredReadyByAt: options.now + 26 * HOUR });
  assert.equal(comparison.available, true);
  assert.equal(comparison.priceCoverage, 'partial');
  assert.equal(comparison.savingsCents, 0);
  assert.ok(Math.abs(comparison.deferredCostCents - 100) < 1e-6);
  assert.equal(comparison.recommended, false);
});

test('an interior price gap never becomes free charging or an implied native pause', () => {
  const options = planning(); options.prices.splice(1, 1);
  const comparison = compareChargingFlexibility(options, { chargerId: 'charger1',
    normalReadyByAt: options.now + 2 * HOUR, deferredReadyByAt: options.now + 4 * HOUR });
  assert.equal(comparison.available, true);
  assert.equal(comparison.priceCoverage, 'partial');
  assert.equal(comparison.savingsCents, 0);
  assert.ok(Math.abs(comparison.deferredCostCents - 100) < 1e-6);
  assert.ok(comparison.deferredFinishAt <= options.now + HOUR);
});

test('missing prices or insufficient priced capacity cannot fabricate a comparison', () => {
  for (const prices of [[], [{ start: 0, end: 1, priceCtPerKwh: 1 }],
    [{ start: planning().now, end: planning().now + 60_000, priceCtPerKwh: 1 }]]) {
    const options = { ...planning(), prices };
    const comparison = compareChargingFlexibility(options, { chargerId: 'charger1',
      normalReadyByAt: options.now + 2 * HOUR, deferredReadyByAt: options.now + 4 * HOUR });
    assert.equal(comparison.available, false); assert.equal(comparison.reason, 'extended-plan-infeasible');
    assert.equal(comparison.savingsCents, null);
    assert.equal(comparison.normalFinishAt, null); assert.equal(comparison.deferredFinishAt, null);
    assert.equal(comparison.normalChargingDurationMs, null); assert.equal(comparison.deferredChargingDurationMs, null);
    assert.equal(comparison.normalPeriods, null); assert.equal(comparison.deferredPeriods, null);
  }
});

test('comparison completion and charging duration describe the selected schedule without counting pauses', () => {
  const options = planning();
  options.chargers[0].requiredGridKwh = 16;
  options.prices.forEach((row, index) => { row.priceCtPerKwh = index === 0 || index === 2 ? 1 : 20; });
  const comparison = compareChargingFlexibility(options, { chargerId: 'charger1',
    normalReadyByAt: options.now + 2 * HOUR, deferredReadyByAt: options.now + 4 * HOUR });
  assert.equal(comparison.available, true);
  // 16 kWh at the fixture's 11.04 kW needs about 86 min 57 s of delivery.
  assert.ok(Math.abs(comparison.normalChargingDurationMs - 5_217_391) < 1);
  assert.ok(Math.abs(comparison.deferredChargingDurationMs - 5_217_391) < 1);
  assert.ok(comparison.normalFinishAt <= options.now + 2 * HOUR);
  assert.ok(comparison.deferredFinishAt > options.now + 2 * HOUR);
  assert.ok(comparison.deferredFinishAt <= options.now + 3 * HOUR);
  assert.ok(comparison.deferredFinishAt - options.now > comparison.deferredChargingDurationMs + HOUR * .9,
    'The later schedule includes a costly gap which is not charging time');
  assert.equal(comparison.normalPeriods[0].startAt, options.now);
  assert.equal(comparison.deferredPeriods[0].startAt, options.now);
  assert.equal(comparison.deferredPeriods[0].endAt, options.now + HOUR);
  assert.equal(comparison.deferredPeriods[1].startAt, options.now + 2 * HOUR);
  assert.equal(comparison.deferredPeriods[1].endAt, null, 'The proposed final permission remains open, distinct from estimated finish');
});

test('comparison runs in the shared bounded worker while command calculations retain queue priority', async t => {
  const service = createChargingPlannerService(); t.after(() => service.close());
  const options = planning(true), comparison = { chargerId: 'charger1', normalReadyByAt: options.now + 2 * HOUR,
    deferredReadyByAt: options.now + 4 * HOUR };
  const order = [];
  const first = service.request(options), replaced = service.compare(options, comparison),
    newest = service.compare(options, comparison).then(result => { order.push('preview'); return result; });
  const command = service.request(options).then(result => { order.push('command'); return result; });
  assert.equal(await replaced, null);
  assert.equal((await first).feasible, true);
  assert.equal((await command).feasible, true);
  assert.deepEqual(await newest, compareChargingFlexibility(options, comparison));
  assert.deepEqual(order, ['command', 'preview']);
});

test('48-hour joint comparison remains off the event loop with realistic two-car energy and 192 price slots', async t => {
  const service = createChargingPlannerService(); t.after(() => service.close());
  const options = planning(true), quarter = HOUR / 4;
  options.chargers[0].requiredGridKwh = 35; options.chargers[0].referenceGridKwh = 40;
  options.chargers[1].requiredGridKwh = 28; options.chargers[1].referenceGridKwh = 30;
  options.chargers.forEach(charger => { charger.deadlineAt = options.now + 20 * HOUR; });
  options.prices = Array.from({ length: 192 }, (_, index) => ({ start: options.now + index * quarter,
    end: options.now + (index + 1) * quarter, priceCtPerKwh: index < 96 ? index % 24 < 8 ? 12 : 25 : index % 24 < 8 ? 2 : 14,
    ...(index >= 96 ? { predicted: true, uncertaintyCtPerKwh: 2 } : {}) }));
  options.household = options.prices.map(row => ({ start: row.start, end: row.end, phaseCurrentA: [3, 4, 2] }));
  let beats = 0, maximumGap = 0, last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); maximumGap = Math.max(maximumGap, now - last); last = now; beats++; }, 5);
  const started = performance.now();
  let result;
  try { result = await service.compare(options, { chargerId: 'charger1', normalReadyByAt: options.now + 20 * HOUR,
    deferredReadyByAt: options.now + 44 * HOUR }); }
  finally { clearInterval(timer); }
  assert.equal(result.available, true); assert.equal(result.chargers.length, 2);
  assert.equal(result.remainingGridKwh, 35); assert.ok(result.householdSavingsCents > 0);
  assert.ok(beats > 0, 'the main event loop continues while both counterfactuals run');
  t.diagnostic(`48 h, 192 intervals, two connected chargers: ${(performance.now() - started).toFixed(1)} ms, ${beats} heartbeats, largest gap ${maximumGap.toFixed(1)} ms`);
});
