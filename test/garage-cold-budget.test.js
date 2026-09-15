import test from 'node:test';
import assert from 'node:assert/strict';
import { garageColdBudget } from '../chart/garage-status.js';

const fixture = () => ({
  settings: { protection: { approved: true, marginC: 1 } },
  protection: { approved: true, locations: {
    rear: { remainingKjPerM: 6.3, estimatedC: 5.5, fresh: true, uncertain: false, reason: null },
    front: { remainingKjPerM: 2.1, estimatedC: 2.5, fresh: true, uncertain: false, reason: null },
  } },
});

test('cold allowance shows independent energy reserves and identifies the estimated reference', () => {
  const garage = fixture(), before = structuredClone(garage);
  const rear = garageColdBudget(garage, 'rear'), front = garageColdBudget(garage, 'front');
  assert.equal(rear.label, 'Rear 6.3 kJ/m'); assert.equal(front.label, 'Front 2.1 kJ/m');
  assert.equal(rear.title, 'Rear cold allowance remaining'); assert.equal(front.title, 'Front cold allowance remaining');
  assert.equal(rear.attention, false); assert.equal(front.attention, false);
  assert.equal(rear.summary, 'Reference estimate 5.5 °C');
  assert.match(rear.detail, /6\.3 kJ\/m.*1 °C protection margin.*water-filled copper reference/);
  assert.match(rear.detail, /Heating resumes.*reserve.*restore useful heat/);
  assert.match(rear.detail, /not a measured pipe temperature or a countdown/);
  assert(!rear.detail.includes('%')); assert(!rear.detail.includes('°C·min'));
  assert.deepEqual(garage, before);
});

test('energy display distinguishes tiny reserves from exhaustion without inventing a fixed maximum', () => {
  const garage = fixture();
  for (const [remaining, value] of [[0, '0 kJ/m'], [Number.EPSILON, '<0.01 kJ/m'], [.001, '<0.01 kJ/m'], [8.125, '8.13 kJ/m'], [100, '100 kJ/m']]) {
    garage.protection.locations.rear.remainingKjPerM = remaining;
    const budget = garageColdBudget(garage, 'rear');
    assert.equal(budget.value, value);
    assert.equal(budget.remaining, remaining);
    assert.equal(budget.attention, remaining === 0);
    assert.equal(budget.available, true);
  }
});

test('restoration reserve retains a valid allowance with an attention explanation', () => {
  const garage = fixture();
  garage.protection.limitingLocation = 'front';
  garage.protection.reasons = ['restoration-margin-exhausted'];
  const budget = garageColdBudget(garage, 'front');
  assert.equal(budget.label, 'Front 2.1 kJ/m'); assert.equal(budget.attention, true);
  assert.equal(budget.summary, 'Heating reserve required');
  assert.match(budget.detail, /Current protection limit: restoration margin exhausted/);
  assert.equal(garageColdBudget(garage, 'rear').attention, false);
});

test('missing, invalid, stale, uncertain or unapproved evidence never becomes zero allowance', () => {
  const cases = [
    garage => { delete garage.protection.locations.rear; },
    garage => { delete garage.protection; },
    ...[-1, Infinity, NaN, null, '0'].map(value => garage => { garage.protection.locations.rear.remainingKjPerM = value; }),
    ...[Infinity, NaN, null, '5'].map(value => garage => { garage.protection.locations.rear.estimatedC = value; }),
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
    assert.equal(budget.label, 'Rear —'); assert.equal(budget.remaining, null);
    assert.equal(budget.available, false); assert.equal(budget.attention, false);
    assert(budget.detail.length > 0); assert(!budget.detail.includes('0 kJ/m'));
  }
  const garage = fixture(); garage.protection.locations.rear.uncertain = true;
  assert.equal(garageColdBudget(garage, 'front').label, 'Front 2.1 kJ/m');
});

test('initial reserve establishment is distinguished from missing observations and exhaustion', () => {
  const garage = fixture();
  Object.assign(garage.protection.locations.front, { remainingKjPerM: 0, estimatedC: 0, uncertain: true, reason: 'initializing-reserve' });
  const budget = garageColdBudget(garage, 'front');
  assert.equal(budget.summary, 'Establishing reserve');
  assert.equal(budget.available, false);
  assert.match(budget.detail, /Fresh local temperature reports.*establishing/);
});
