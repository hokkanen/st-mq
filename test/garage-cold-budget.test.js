import test from 'node:test';
import assert from 'node:assert/strict';
import { garageColdBudget } from '../chart/garage-status.js';

const fixture = () => ({
  settings: { protection: { approved: true, budgetDegreeMinutes: 120 } },
  protection: { approved: true, locations: {
    rear: { degreeMinutes: 30, fresh: true, uncertain: false, reason: null },
    front: { degreeMinutes: 12, fresh: true, uncertain: false, reason: null },
  } },
});

test('cold budget shows remaining allowance independently without implying it guarantees safety', () => {
  const garage = fixture(), before = structuredClone(garage);
  const rear = garageColdBudget(garage, 'rear'), front = garageColdBudget(garage, 'front');
  assert.equal(rear.label, 'Rear 75%'); assert.equal(front.label, 'Front 90%');
  assert.equal(rear.title, 'Rear cold budget remaining'); assert.equal(front.title, 'Front cold budget remaining');
  assert.equal(rear.attention, false); assert.equal(front.attention, false);
  assert.match(rear.detail, /90 \/ 120 °C·min remaining/);
  assert.match(front.detail, /108 \/ 120 °C·min remaining/);
  assert.match(rear.detail, /0% means.*exhausted.*Heating may resume earlier.*hard temperature limit.*sensor uncertainty.*restore heating/);
  assert.match(rear.detail, /not a freezing probability or countdown/);
  assert.deepEqual(garage, before);
});

test('remaining percentage reserves zero for exhaustion and 100 for an untouched allowance', () => {
  const garage = fixture();
  for (const [used, percent] of [[0, 100], [Number.EPSILON, 99], [0.001, 99], [119.999, 1], [120 - Number.EPSILON * 120, 1], [120, 0], [147.5, 0]]) {
    garage.protection.locations.rear.degreeMinutes = used;
    const budget = garageColdBudget(garage, 'rear');
    assert.equal(budget.percent, percent);
    assert.equal(budget.attention, used >= 120);
    assert(budget.detail.startsWith(`${Math.max(0, 120 - used)} / 120 °C·min remaining.`));
    if (used > 120) assert(budget.detail.includes(`Accumulated exposure: ${used} °C·min.`));
  }
});

test('a hard temperature limit retains a valid percentage with an attention explanation', () => {
  const garage = fixture();
  garage.protection.locations.front.reason = 'hard-temperature-limit';
  const budget = garageColdBudget(garage, 'front');
  assert.equal(budget.label, 'Front 90%'); assert.equal(budget.attention, true);
  assert.match(budget.detail, /Current protection limit: hard temperature limit/);
});

test('missing, invalid, stale, uncertain or unapproved evidence never becomes a zero percentage', () => {
  const cases = [
    garage => { delete garage.protection.locations.rear; },
    garage => { delete garage.protection; },
    garage => { delete garage.settings.protection.budgetDegreeMinutes; },
    ...[0, -1, Infinity, NaN, '120'].map(value => garage => { garage.settings.protection.budgetDegreeMinutes = value; }),
    ...[-1, Infinity, NaN, null, '0'].map(value => garage => { garage.protection.locations.rear.degreeMinutes = value; }),
    garage => { garage.protection.locations.rear.fresh = false; },
    garage => { delete garage.protection.locations.rear.fresh; },
    garage => { garage.protection.locations.rear.uncertain = true; },
    garage => { garage.settings.protection.approved = false; },
    garage => { garage.protection.approved = false; },
    garage => { delete garage.protection.approved; },
  ];
  for (const change of cases) {
    const garage = fixture(); change(garage);
    const budget = garageColdBudget(garage, 'rear');
    assert.equal(budget.label, 'Rear —'); assert.equal(budget.percent, null);
    assert.equal(budget.available, false); assert.equal(budget.attention, false);
    assert(budget.detail.length > 0); assert(!budget.detail.includes('0%'));
  }
  const garage = fixture(); garage.protection.locations.rear.uncertain = true;
  assert.equal(garageColdBudget(garage, 'front').label, 'Front 90%');
});
