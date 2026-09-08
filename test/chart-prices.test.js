import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoricalPricing } from '../src/app/chart-prices.js';
import { allInPrice, validateContract } from '../src/domain/prices.js';

const HOUR = 3_600_000;
// Invented values exercise the arithmetic without using household configuration.
const rates = { marginCtPerKwh: 1, taxCtPerKwh: 2, vatRate: 0.2,
  tariff: 'day-night', transferRates: { vatIncluded: false,
    dayCtPerKwh: 3, nightCtPerKwh: 1, winterDayCtPerKwh: 4, otherCtPerKwh: 2 } };
const contract = { periods: [{ ...rates, from: '2026-07-01T00:00:00Z' }] };
const normalized = (start, end, spotCtPerKwh = 10) => ({ start: Date.parse(start), end: Date.parse(end),
  spotCtPerKwh, unit: 'c/kWh', vatIncluded: false, source: 'Synthetic chart fixture', fetchedAt: 123 });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('historical chart prices retain spot and historical tariff hours using the closest known rates', () => {
  const checked = validateContract(contract), original = structuredClone(checked);
  const pricing = createHistoricalPricing(checked);
  const day = pricing.total('2025-01-06T12:00:00+02:00', 10);
  near(day.totalCtPerKwh, 19.2);
  assert.equal(day.assumedPrice, true);
  assert.equal(day.rateFrom, Date.parse(contract.periods[0].from));
  near(pricing.total('2025-01-06T23:00:00+02:00', 10).totalCtPerKwh, 16.8);
  near(pricing.total('2025-01-06T12:05:00+02:00', -10).totalCtPerKwh, -4.8);
  const exact = pricing.total('2026-07-02T12:00:00+03:00', 10);
  assert.equal(exact.assumedPrice, false);
  near(exact.totalCtPerKwh, allInPrice('2026-07-02T12:00:00+03:00', 10, contract).totalCtPerKwh);
  assert.deepEqual(checked, original);
  assert.throws(() => allInPrice('2025-01-06T12:00:00+02:00', 10, contract), /historical/);
});

test('assumed seasonal rates use the historical season and weekday', () => {
  const pricing = createHistoricalPricing(validateContract({ periods: [{ ...contract.periods[0], tariff: 'seasonal' }] }));
  near(pricing.total('2025-01-06T12:00:00+02:00', 10).totalCtPerKwh, 20.4); // Winter Monday
  near(pricing.total('2025-01-05T12:00:00+02:00', 10).totalCtPerKwh, 18); // Winter Sunday
  near(pricing.total('2025-07-07T12:00:00+03:00', 10).totalCtPerKwh, 18); // Summer Monday
});

test('nearest periods are measured from coverage endpoints, prefer exact coverage and resolve ties earlier', () => {
  const periods = [
    { ...rates, from: '2026-01-01T00:00:00Z', to: '2026-01-20T00:00:00Z' },
    { ...rates, from: '2026-01-22T00:00:00Z', to: '2026-01-23T00:00:00Z', marginCtPerKwh: 5 },
  ];
  const pricing = createHistoricalPricing(validateContract({ periods }));
  for (const [at, index, assumedPrice] of [
    ['2025-12-01T00:00:00Z', 0, true], ['2026-01-19T23:59:59Z', 0, false],
    ['2026-01-20T12:00:00Z', 0, true], ['2026-01-21T00:00:00Z', 0, true],
    ['2026-01-21T00:00:00.001Z', 1, true], ['2026-01-22T00:00:00Z', 1, false],
    ['2026-02-01T00:00:00Z', 1, true],
  ]) {
    const price = pricing.total(at, 10);
    assert.equal(price.rateFrom, Date.parse(periods[index].from), at);
    assert.equal(price.assumedPrice, assumedPrice, at);
  }
});

test('intervals split exactly at dated coverage and gap midpoints and preserve source metadata', () => {
  const periods = [
    { ...rates, from: '2026-01-01T00:00:00Z', to: '2026-01-01T02:00:00Z' },
    { ...rates, from: '2026-01-01T04:00:00Z', to: '2026-01-01T06:00:00Z', marginCtPerKwh: 5 },
  ];
  const pricing = createHistoricalPricing(validateContract({ periods }));
  const row = normalized('2026-01-01T01:30:00Z', '2026-01-01T04:30:00Z');
  const original = structuredClone(row), priced = pricing.intervals([row]);
  assert.deepEqual(priced.map(p => p.durationHours), [0.5, 1, 1, 0.5]);
  assert.deepEqual(priced.map(p => p.assumedPrice), [false, true, true, false]);
  assert.deepEqual(priced.map(p => p.rateFrom), [periods[0].from, periods[0].from, periods[1].from, periods[1].from].map(Date.parse));
  assert.deepEqual(priced.map(p => p.start), [row.start, '2026-01-01T02:00:00Z', '2026-01-01T03:00:00Z', '2026-01-01T04:00:00Z']
    .map(value => typeof value === 'number' ? value : Date.parse(value)));
  for (const price of priced) {
    assert.equal(price.source, row.source); assert.equal(price.fetchedAt, row.fetchedAt);
    near(price.totalCtPerKwh, pricing.total(price.start + 1, price.spotCtPerKwh).totalCtPerKwh);
  }
  assert.deepEqual(row, original);
});

test('adjacent periods stay exact, including changes within a tariff hour', () => {
  const periods = [
    { ...rates, from: '2026-01-01T00:00:00Z', to: '2026-01-01T12:15:00Z' },
    { ...rates, from: '2026-01-01T12:15:00Z', marginCtPerKwh: 5 },
  ];
  const pricing = createHistoricalPricing(validateContract({ periods }));
  const priced = pricing.intervals([normalized('2026-01-01T12:00:00Z', '2026-01-01T12:30:00Z')]);
  assert.deepEqual(priced.map(p => p.durationHours), [0.25, 0.25]);
  assert.ok(priced.every(p => p.assumedPrice === false));
  near(pricing.total('2026-01-01T12:00:00Z', 10).totalCtPerKwh, 19.2);
  near(pricing.total('2026-01-01T12:15:00Z', 10).totalCtPerKwh, 24);
});

test('historical DST days retain 23 and 25 hours and the original tariff boundaries', () => {
  const pricing = createHistoricalPricing(validateContract(contract));
  for (const [start, end, hours] of [
    ['2025-03-30T00:00:00+02:00', '2025-03-31T00:00:00+03:00', 23],
    ['2025-10-26T00:00:00+03:00', '2025-10-27T00:00:00+02:00', 25],
  ]) {
    const priced = pricing.intervals([normalized(start, end, 0)]);
    assert.equal(priced.reduce((sum, row) => sum + row.durationHours, 0), hours);
    near(priced.reduce((sum, row) => sum + row.durationHours * row.totalCtPerKwh, 0), 15 * 7.2 + (hours - 15) * 4.8);
    assert.ok(priced.every(row => row.assumedPrice));
  }
});

test('large history is priced in bounded batches without relaxing domain input checks', () => {
  const pricing = createHistoricalPricing(validateContract(contract));
  const start = Date.parse('2025-01-01T00:00:00Z');
  const rows = Array.from({ length: 10001 }, (_, index) => ({ ...normalized('2025-01-01T00:00:00Z', '2025-01-01T00:15:00Z'),
    start: start + index * HOUR / 4, end: start + (index + 1) * HOUR / 4 }));
  const priced = pricing.intervals(rows);
  assert.equal(priced.length, rows.length);
  assert.equal(priced.at(-1).end, rows.at(-1).end);
  assert.ok(priced.every(row => row.assumedPrice && Number.isFinite(row.totalCtPerKwh)));
  assert.throws(() => pricing.intervals([rows[0], rows[0]]), /nonoverlapping/);
  assert.throws(() => pricing.intervals([{ ...rows[0], vatIncluded: true }]), /normalized/);
  assert.throws(() => pricing.total(start, NaN), /finite/);
});
