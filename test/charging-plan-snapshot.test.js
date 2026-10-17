import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingPlanSnapshot, chargingPlanView } from '../src/charging/plan-snapshot.js';
import { immutableValue } from '../src/domain/immutable.js';
import { Store } from '../src/storage/store.js';

const at = Date.parse('2026-10-17T00:00:00Z');
const plan = () => ({ state: 'planned', deadlineAt: at + 3600_000, costCents: 31, requiredGridKwh: 4,
  periods: [{ startAt: at, endAt: at + 900_000 }], allocations: [{ start: at, end: at + 900_000, powerKw: 4 }],
  intervals: Array.from({ length: 60 }, (_, index) => ({ start: at + index * 900_000, end: at + (index + 1) * 900_000,
    priceCtPerKwh: 10, phaseHeadroomA: [16, 16, 16], basis: 'duration-weighted-history',
    reference: { method: 'comparable-nights', nights: 20, oldestAt: at - 30 * 86400_000, newestAt: at },
    scenarios: Array.from({ length: 24 }, (_, j) => ({ phaseHeadroomA: [10 + j / 10, 12, 14], weight: 1 / 24 })) })) });

test('durable charging snapshots preserve executable and accounting evidence without mutable search vectors', () => {
  const live = plan(), original = structuredClone(live), snapshot = chargingPlanSnapshot(live);
  assert.deepEqual(live, original);
  for (const key of ['state', 'deadlineAt', 'costCents', 'requiredGridKwh', 'periods', 'allocations'])
    assert.deepEqual(snapshot[key], original[key]);
  assert.deepEqual(snapshot.intervals.map(({ scenarios, ...row }) => row),
    original.intervals.map(({ scenarios, ...row }) => row));
  assert.ok(snapshot.intervals.every(row => !Object.hasOwn(row, 'scenarios')));
  assert.deepEqual(snapshot.intervals[0].reference, original.intervals[0].reference);
  const owned = immutableValue(live);
  assert.equal(chargingPlanSnapshot(owned), chargingPlanSnapshot(owned));
  assert.ok(Object.isFrozen(chargingPlanSnapshot(owned).intervals[0]));
});

test('changing candidate scenario weights alone creates no new durable schedule or journal entry', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const original = plan(); store.setState('synthetic-plan', chargingPlanSnapshot(original));
  const before = store.checkpoint();
  const next = structuredClone(original);
  for (const interval of next.intervals) for (const [index, scenario] of interval.scenarios.entries())
    scenario.weight = (index + 1) / 300;
  store.setState('synthetic-plan', chargingPlanSnapshot(next));
  assert.deepEqual(store.checkpoint(), before);
  next.periods[0].endAt += 60_000;
  store.setState('synthetic-plan', chargingPlanSnapshot(next));
  assert.equal(store.checkpoint().sequence, before.sequence + 1, 'An adopted schedule change remains durable');
});

test('unpublished price caches remain transient while published interval prices survive', () => {
  const live = plan(); live.decisionPriceSnapshot = [{ predicted: true }];
  live.intervals[1].predicted = true;
  const snapshot = chargingPlanSnapshot(live);
  assert.equal(snapshot.decisionPriceSnapshot, undefined);
  assert.equal(snapshot.intervals.length, 59);
  assert.equal(snapshot.intervals[0].priceCtPerKwh, 10);
  const view = chargingPlanView(immutableValue(live));
  assert.equal(view.intervals.length, 60, 'Live presentation preserves forecast price intervals');
  assert.equal(view.intervals[1].predicted, true);
  assert.equal(view.intervals[1].scenarios, undefined);
  assert.deepEqual(view.periods, live.periods);
});
