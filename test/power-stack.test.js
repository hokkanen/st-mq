import test from 'node:test';
import assert from 'node:assert/strict';
import { stackPowerSeries } from '../chart/power-stack.js';

const values = points => points.map(({ x, y }) => [x, y]);
const at = (points, x) => points.find(point => point.x === x);

test('three power bands share exact cumulative boundaries while tooltips retain each load', () => {
  const components = [
    [{ x: 0, y: 2 }, { x: 10, y: 3 }, { x: 30, y: 3 }],
    [{ x: 0, y: 4, source: 'synthetic' }, { x: 5, y: 5, source: 'synthetic' }, { x: 30, y: 5, source: 'synthetic' }],
    [{ x: 0, y: 7, fromEnergy: true, intervalStart: 0, intervalEnd: 15 },
      { x: 15, y: 8, fromEnergy: true, intervalStart: 15, intervalEnd: 30 }, { x: 30, y: 8 }],
  ];
  const original = structuredClone(components);
  const [auxiliary, charger1, charger2] = stackPowerSeries(components);
  assert.deepEqual(values(auxiliary), [[0, 2], [5, 2], [10, 3], [15, 3], [30, 3]]);
  assert.deepEqual(values(charger1), [[0, 6], [5, 7], [10, 8], [15, 8], [30, 8]]);
  assert.deepEqual(values(charger2), [[0, 13], [5, 14], [10, 15], [15, 16], [30, 16]]);
  assert.deepEqual(charger1.map(point => point.componentValue), [4, 5, 5, 5, 5]);
  assert.deepEqual(charger2.map(point => point.componentValue), [7, 7, 7, 8, 8]);
  assert.equal(at(charger1, 10).source, 'synthetic');
  assert.equal(at(charger2, 10).intervalEnd, 15);
  assert.equal(at(charger2, 10).fromEnergy, true);
  assert.deepEqual(components, original, 'Stacking is presentation only');
});

test('duplicate edges retain interval closure, same-time gaps and the following interval', () => {
  const [auxiliary, charger1, charger2] = stackPowerSeries([
    [{ x: 0, y: 2 }, { x: 10, y: 3 }, { x: 20, y: 3 }],
    [{ x: 0, y: 4 }, { x: 10, y: 4 }, { x: 10, y: null }, { x: 10, y: 5 }, { x: 20, y: 5 }],
    [{ x: 0, y: 7, intervalEnd: 10 }, { x: 10, y: 7, intervalEnd: 10 },
      { x: 10, y: 8, intervalEnd: 20 }, { x: 20, y: 8, intervalEnd: 20 }],
  ]);
  assert.deepEqual(auxiliary.filter(point => point.x === 10).map(point => point.y), [2, 2, 3]);
  assert.deepEqual(charger1.filter(point => point.x === 10).map(point => point.y), [6, null, 8]);
  assert.deepEqual(charger2.filter(point => point.x === 10).map(point => point.y), [13, null, 16]);
  assert.deepEqual(charger2.filter(point => point.x === 10).map(point => point.componentValue), [7, 7, 8]);
  assert.deepEqual(charger2.filter(point => point.x === 10).map(point => point.intervalEnd), [10, 10, 20]);
});

test('missing middle readings leave upper gaps without erasing valid lower power', () => {
  const [auxiliary, charger1, charger2] = stackPowerSeries([
    [{ x: 0, y: 2 }, { x: 30, y: 2 }],
    [{ x: 0, y: 4 }, { x: 9, y: 4 }, { x: 10, y: null }, { x: 19, y: null }, { x: 20, y: 5 }, { x: 30, y: 5 }],
    [{ x: 0, y: 7 }, { x: 15, y: 7 }, { x: 30, y: 7 }],
  ]);
  assert(auxiliary.every(point => point.y === 2));
  assert.equal(at(charger1, 15).y, null);
  assert.equal(at(charger2, 15).y, null);
  assert.equal(at(charger2, 15).componentValue, 7);
  assert.equal(at(charger2, 20).y, 14);
});

test('missing lower readings never become zero and known zero is a valid baseline', () => {
  const [auxiliary, charger1, charger2] = stackPowerSeries([
    [{ x: 5, y: 0 }, { x: 10, y: 0 }, { x: 11, y: null }, { x: 20, y: 2 }, { x: 30, y: 2 }],
    [{ x: 0, y: 4 }, { x: 7, y: 4 }, { x: 15, y: 4 }, { x: 25, y: 4 }, { x: 40, y: 4 }],
    [{ x: 0, y: 7 }, { x: 40, y: 7 }],
  ]);
  assert.equal(at(auxiliary, 7).y, 0);
  assert.equal(at(charger1, 7).y, 4);
  assert.equal(at(charger2, 7).y, 11);
  for (const x of [0, 11, 15, 40]) assert.equal(at(charger2, x).y, null);
  assert.equal(at(charger2, 25).y, 13);
  assert.equal(at(charger2, 15).componentValue, 7);
});

test('sparse or wholly absent upper charging does not erase the two lower bands', () => {
  const lower = [[{ x: 0, y: 2 }, { x: 30, y: 2 }], [{ x: 0, y: 4 }, { x: 30, y: 4 }]];
  const sparse = [{ x: 10, y: 7 }, { x: 19, y: 7 }, { x: 20, y: null }];
  const [auxiliary, charger1, charger2] = stackPowerSeries([...lower, sparse]);
  assert(auxiliary.every(point => point.y === 2));
  assert(charger1.every(point => point.y === 6));
  assert.equal(at(charger2, 0).y, null);
  assert.equal(at(charger2, 10).y, 13);
  assert.equal(at(charger2, 20).y, null);
  const withoutUpper = stackPowerSeries([...lower, []]);
  assert.deepEqual(withoutUpper.slice(0, 2), stackPowerSeries(lower));
  assert(withoutUpper[2].every(point => point.y === null));
});

test('callers can remove hidden components so remaining loads stack from zero in order', () => {
  const components = [2, 4, 7].map(y => [{ x: 0, y }, { x: 20, y }]);
  const [auxiliary, charger2] = stackPowerSeries(components.filter((_, index) => index !== 1));
  assert(auxiliary.every(point => point.y === 2));
  assert(charger2.every(point => point.y === 9 && point.componentValue === 7));
  const [charger1, upper] = stackPowerSeries(components.slice(1));
  assert(charger1.every(point => point.y === 4));
  assert(upper.every(point => point.y === 11 && point.componentValue === 7));
  assert.deepEqual(stackPowerSeries([components[2]])[0], components[2]);
  assert.deepEqual(stackPowerSeries(), []);
});

test('held energy tails retain provenance and never extend beyond their terminal timestamp', () => {
  const interval = { x: 0, y: 7, fromEnergy: true, intervalStart: 0, intervalEnd: 10 };
  const components = [
    [{ x: 0, y: 2 }, { x: 15, y: 2 }, { x: 40, y: 2 }],
    [{ x: 0, y: 4 }, { x: 40, y: 4 }],
    [interval, { ...interval, x: 30, carriedForward: true, observedAt: 0 }],
  ];
  const upper = stackPowerSeries(components)[2];
  assert.equal(at(upper, 15).y, 13);
  assert.equal(at(upper, 15).componentValue, 7);
  assert.equal(at(upper, 15).carriedForward, true);
  assert.equal(at(upper, 15).observedAt, 0);
  assert.equal(at(upper, 15).intervalEnd, 10);
  assert.equal(at(upper, 30).y, 13);
  assert.equal(at(upper, 40).y, null);
  components[2].push({ x: 30, y: null });
  assert.equal(stackPowerSeries(components)[2].filter(point => point.x === 30).at(-1).y, null);
});
