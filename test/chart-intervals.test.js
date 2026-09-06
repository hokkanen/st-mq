import test from 'node:test';
import assert from 'node:assert/strict';
import { intervalPoints } from '../chart/interval-points.js';

test('negative prices retain quarter-hour and hourly durations through the last end', () => {
  const points = intervalPoints([
    { start: 0, end: 900_000, price: -3.5 },
    { start: 900_000, end: 4_500_000, price: 12 },
  ], 'price');
  assert.deepEqual(points, [
    { x: 0, y: -3.5 }, { x: 900_000, y: -3.5 },
    { x: 900_000, y: 12 }, { x: 4_500_000, y: 12 }, { x: 4_500_000, y: null },
  ]);
});

test('missing price intervals create a null break instead of bridging the outage', () => {
  assert.deepEqual(intervalPoints([
    { start: 0, end: 900_000, value: 5 },
    { start: 3_600_000, end: 4_500_000, value: -1 },
  ], 'value'), [
    { x: 0, y: 5 }, { x: 900_000, y: 5 }, { x: 900_000, y: null },
    { x: 3_600_000, y: -1 }, { x: 4_500_000, y: -1 }, { x: 4_500_000, y: null },
  ]);
});

test('forecast null values remain unavailable and bounded output stops at its real end', () => {
  const forecast = [
    { start: 0, end: 10_800_000, outdoorC: -10 },
    { start: 10_800_000, end: 21_600_000, outdoorC: null },
    { start: 21_600_000, end: 32_400_000, outdoorC: -8 },
  ];
  assert.deepEqual(intervalPoints(forecast, 'outdoorC', { limit: 2 }), [
    { x: 0, y: -10 }, { x: 10_800_000, y: -10 },
    { x: 10_800_000, y: null }, { x: 21_600_000, y: null }, { x: 21_600_000, y: null },
  ]);
  assert.deepEqual(intervalPoints([], 'price'), []);
  assert.deepEqual(intervalPoints(forecast, 'outdoorC', { limit: 0 }), []);
});

test('plotting refuses missing durations, guessed numeric values and overlapping intervals', () => {
  assert.throws(() => intervalPoints([{ start: 0, price: 1 }], 'price'), /explicit start and end/);
  assert.throws(() => intervalPoints([{ start: 0, end: 0, price: 1 }], 'price'), /explicit start and end/);
  assert.throws(() => intervalPoints([{ start: 0, end: 1, price: '1' }], 'price'), /finite or null/);
  assert.throws(() => intervalPoints([{ start: 0, end: 1, price: NaN }], 'price'), /finite or null/);
  assert.throws(() => intervalPoints([{ start: 0, end: 2, price: 1 }, { start: 1, end: 3, price: 2 }], 'price'), /non-overlapping/);
  assert.throws(() => intervalPoints([{ start: 2, end: 3, price: 1 }, { start: 0, end: 1, price: 2 }], 'price'), /sorted/);
  assert.throws(() => intervalPoints([], 'price', { limit: 513 }), /limit/);
});
