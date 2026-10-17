import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, START, MINUTE, HOUR } from './helpers/charging-joint-fixture.js';

for (const id of ['charger1', 'charger2'])
for (const householdA of [6, 10])
test(`${id} corrects an accepted economic gap when changed capacity threatens ready-by; household ${householdA} A`, async t => {
  const f = await fixture(t);
  const prices = [1, 50, 1].map((price, index) => ({ start: START + index * HOUR,
    end: START + (index + 1) * HOUR, price }));
  f.runtime.tick({ prices }); await f.settle();
  await f.connect(id);
  await f.edit(id, { capacityKwh: 25, readyBy: '05:00' });
  await f.automatic(id, true); await f.settle();
  const prior = structuredClone(f.view(id).control.execution);
  assert.equal(prior.periods.length, 2, 'The initial program must contain an economic gap');
  f.advance(prior.periods[0].startAt - f.now + 5 * MINUTE); await f.settle();
  assert.equal(f.view(id).values.charging.value, true);
  assert.ok(f.now < prior.periods[0].endAt);

  const candidates = [], request = f.runtime.plannerService.request.bind(f.runtime.plannerService);
  t.mock.method(f.runtime.plannerService, 'request', async options => {
    const result = await request(options); candidates.push(result); return result;
  });
  // A known household-load forecast reduces delivery in the accepted windows.
  // The larger load makes even a continuous release insufficient by ready-by.
  f.runtime.household = f.runtime.household.map(row => ({ ...row, phaseCurrentA: [householdA, householdA, householdA],
    ...(row.scenarios ? { scenarios: row.scenarios.map(scenario => ({ ...scenario, phaseCurrentA: [householdA, householdA, householdA] })) } : {}) }));
  f.runtime.historyAt = f.now;
  await f.runtime.updatePlan(f.now); await f.settle();

  const recoverable = householdA === 6;
  assert.ok(candidates.some(result => result.plans[id].feasible === recoverable));
  const next = f.view(id);

  assert.equal(next.forecast.feasible, recoverable, 'Service recovery must keep an honest readiness forecast');
  assert.equal(next.plan.provisional, !recoverable);
  assert.notEqual(next.plan.id, prior.planId);
  if (recoverable) {
    assert.notEqual(next.control.execution.planId, prior.planId);
    assert.ok(next.forecast.finishAt <= next.deadlineAt);
  } else {
    assert.equal(next.plan.periods.length, 1);
    assert.equal(next.plan.periods[0].endAt, null, 'An unrecoverable deadline cannot retain an avoidable economic gap');
    assert.ok(!next.control.execution || next.control.execution.periods.length === 1 && next.control.execution.periods[0].endAt === null);
  }
  assert.ok(next.plan.periods.at(-1).startAt < prior.finalStartAt
    || next.plan.periods[0].endAt === null || next.plan.periods[0].endAt > prior.periods[0].endAt,
  'The correction must add charging opportunity inside the old economic gap');
});

for (const priority of ['balanced', 'charger1', 'charger2'])
test(`both native chargers accept integer schedule boundaries with ${priority} priority`, async t => {
  const f = await fixture(t);
  const prices = [1, 50, 50, 1].map((price, index) => ({ start: START + index * HOUR,
    end: START + (index + 1) * HOUR, price }));
  f.runtime.tick({ prices }); await f.settle();
  for (const id of ['charger1', 'charger2']) {
    await f.connect(id);
    await f.edit(id, { capacityKwh: 18, readyBy: '06:00' });
    await f.automatic(id, true);
  }
  await f.priority(priority); await f.settle();
  const prior = Object.fromEntries(['charger1', 'charger2'].map(id => [id, structuredClone(f.view(id).control.execution)]));
  assert.ok(Object.values(prior).every(Boolean), 'Both native controllers must accept their integer-timestamp program');
  for (const id of ['charger1', 'charger2']) for (const period of f.view(id).plan.periods) {
    assert.ok(Number.isSafeInteger(period.startAt));
    assert.ok(period.endAt === null || Number.isSafeInteger(period.endAt));
  }
  assert.ok(Object.values(prior).some(execution => execution.periods.length === 2));
  for (const id of ['charger1', 'charger2']) {
    const next = f.view(id);
    assert.equal(next.forecast.feasible, true);
    assert.ok(next.forecast.finishAt <= next.deadlineAt);
    assert.equal(next.control.execution.planId, next.plan.id);
  }
});
