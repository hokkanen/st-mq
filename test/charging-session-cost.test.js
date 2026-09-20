import test from 'node:test';
import assert from 'node:assert/strict';
import { updateSessionCost } from '../src/charging/session-cost.js';
import { chargingCost } from '../chart/charging-summary.js';

const HOUR = 3_600_000, now = Date.parse('2026-09-20T20:00:00Z');
const rates = [10, 20, 30].map((price, index) => ({ start: now + index * HOUR, end: now + (index + 1) * HOUR, price }));
const charger = remaining => ({ id: 'charger1', settings: { enabled: true }, control: {},
  values: { connected: { value: true } }, progress: { remainingGridKwh: remaining, connectionAt: now },
  forecast: { startAt: now, finishAt: now + 2 * HOUR,
    accounting: [{ start: now, end: now + HOUR, energyKwh: 10 }, { start: now + HOUR, end: now + 2 * HOUR, energyKwh: 10 }] } });
const recorded = intervals => () => ({ gridKwh: intervals.reduce((sum, row) => sum + row.energyKwh, 0), intervals });

test('session cost keeps delivered cost through new SoC references, reaching target, restart and extra charging', () => {
  const initial = updateSessionCost(null, charger(20), now, rates);
  assert.equal(initial.totalCents, 300);
  const first = { start: now, end: now + HOUR, energyKwh: 10 };
  const halfway = charger(10); halfway.forecast.accounting = [halfway.forecast.accounting[1]];
  halfway.progress.connectionAt = now + HOUR; // A new SoC reference must not reset the connection cost.
  const progress = updateSessionCost(initial, halfway, now + HOUR, rates.slice(1), recorded([first]));
  assert.equal(progress.accruedCents, 100); assert.equal(progress.totalCents, 300);
  const second = { start: now + HOUR, end: now + 2 * HOUR, energyKwh: 10 };
  const complete = updateSessionCost(JSON.parse(JSON.stringify(progress)), charger(0), now + 2 * HOUR,
    rates.slice(2), recorded([first, second]));
  assert.equal(complete.totalCents, 300);
  const extra = { start: now + 2 * HOUR, end: now + 3 * HOUR, energyKwh: 5 };
  const overTarget = updateSessionCost(complete, charger(0), now + 3 * HOUR, [], recorded([first, second, extra]));
  assert.equal(overTarget.totalCents, 450);
  assert.equal(chargingCost({ sessionCost: overTarget }, { showMetrics: true }, {}).value, '€4.50');
  assert.equal(updateSessionCost(overTarget, { ...charger(0), values: { connected: { value: false } } }, now + 4 * HOUR), null);
});

test('manual pauses and temporary forecast loss keep the total estimate, including negative prices', () => {
  const negativeRates = rates.map(row => ({ ...row, price: -10 }));
  const initial = updateSessionCost(null, charger(20), now, negativeRates);
  assert.equal(initial.totalCents, -200);
  const paused = { ...charger(15), control: { manual: { kind: 'stop' } }, forecast: null };
  const state = updateSessionCost(initial, paused, now + HOUR, [],
    recorded([{ start: now, end: now + HOUR, energyKwh: 5 }]));
  assert.equal(state.totalCents, -200); assert.equal(state.estimated, true);
});

test('a delivered interval crossing prices is split by duration without resetting cost at midnight', () => {
  const state = updateSessionCost(null, charger(0), now + 2 * HOUR, rates,
    recorded([{ start: now, end: now + 2 * HOUR, energyKwh: 10 }]));
  assert.equal(state.accruedCents, 150); assert.equal(state.totalCents, 150);
});

test('new SoC during missing energy coverage preserves the session estimate until recorded energy catches up', () => {
  const initial = updateSessionCost(null, charger(20), now, rates);
  const reached = { ...charger(0), forecast: null };
  const unavailable = updateSessionCost(initial, reached, now + 2 * HOUR, [], () => null);
  assert.equal(unavailable.totalCents, 300); assert.equal(unavailable.estimated, true);
  assert.equal(unavailable.recordedGridKwh, 0); assert.equal(unavailable.unrecordedGridKwh, 20);
  const stillMissing = updateSessionCost(unavailable, reached, now + 3 * HOUR, [], () => null);
  assert.equal(stillMissing.totalCents, 300);
  const recovered = updateSessionCost(stillMissing, reached, now + 3 * HOUR, [], recorded([
    { start: now, end: now + HOUR, energyKwh: 10 }, { start: now + HOUR, end: now + 2 * HOUR, energyKwh: 10 },
  ]));
  assert.equal(recovered.totalCents, 300); assert.equal(recovered.unrecordedGridKwh, 0);
});

test('a fresh SoC correction with complete zero-energy coverage cannot invent delivered charging', () => {
  const initial = updateSessionCost(null, charger(20), now, rates);
  const corrected = updateSessionCost(initial, charger(0), now + HOUR, rates,
    () => ({ gridKwh: 0, intervals: [], incomplete: false }));
  assert.equal(corrected.unrecordedGridKwh, 0); assert.equal(corrected.deliveredGridKwh, 0);
  assert.equal(corrected.totalCents, 0);
});
