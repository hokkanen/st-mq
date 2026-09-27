import test from 'node:test';
import assert from 'node:assert/strict';
import { DailyTimingBenchmark } from '../src/app/daily-timing-benchmark.js';

const HOUR = 3_600_000, MINUTE = 60_000;
const from = Date.parse('2026-09-08T00:00:00+03:00'), to = from + 24 * HOUR;
const devices = ['heatPump', 'charger1', 'charger2'];
function benchmark(prices, start, end, kw, intervalMs) {
  const timing = new DailyTimingBenchmark({ from, to }, to, prices);
  for (const name of devices) for (let at = start; at < end; at += intervalMs) {
    const until = Math.min(end, at + intervalMs);
    timing.addEnergy(name, at, until, kw * (until - at) / HOUR, { key: 'recorded' });
  }
  return timing.result();
}

test('flat tariffs have exactly zero timing difference for split and coalesced energy', () => {
  for (const price of [20, -12, 0, 0.1]) for (const intervalMs of [MINUTE, 15 * MINUTE, 24 * HOUR]) {
    const results = benchmark([{ start: from, end: to, totalCtPerKwh: price }], from, to, 3.08, intervalMs);
    for (const name of [...devices, 'charger']) {
      assert.equal(results[name].value, 0, `${name}: ${price} c/kWh with ${intervalMs / MINUTE}-minute intervals`);
      assert.equal(Object.is(results[name].value, -0), false);
      assert.ok(Math.abs(results[name].actualCostEuro - results[name].uniformCostEuro) < 1e-10);
    }
  }
});

test('uniform energy across varying positive and negative tariffs keeps exact zero direction', () => {
  const prices = [{ start: from, end: from + 12 * HOUR, totalCtPerKwh: -12.3 },
    { start: from + 12 * HOUR, end: to, totalCtPerKwh: 12.3 }];
  for (const intervalMs of [MINUTE, 15 * MINUTE, 24 * HOUR]) {
    const results = benchmark(prices, from, to, 3.08, intervalMs);
    for (const name of [...devices, 'charger']) assert.equal(results[name].value, 0);
  }
});

test('real signed sub-cent timing differences survive numerical-zero handling and interval splitting', () => {
  for (const differenceEuro of [0.004, 1e-9]) {
    const prices = [{ start: from, end: from + 12 * HOUR, totalCtPerKwh: 20 - differenceEuro * 100 },
      { start: from + 12 * HOUR, end: to, totalCtPerKwh: 20 + differenceEuro * 100 }];
    for (const intervalMs of [MINUTE, 15 * MINUTE, HOUR]) for (const sign of [-1, 1]) {
      const start = from + (sign < 0 ? 12 * HOUR : 0);
      const results = benchmark(prices, start, start + HOUR, 1, intervalMs);
      for (const name of [...devices, 'charger']) {
        const expected = sign * differenceEuro * (name === 'charger' ? 2 : 1);
        assert.equal(Math.sign(results[name].value), sign);
        assert.ok(Math.abs(results[name].value - expected) < 1e-12);
      }
    }
  }
});
