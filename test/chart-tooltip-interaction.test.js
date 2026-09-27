import test from 'node:test';
import assert from 'node:assert/strict';
import Chart from 'chart.js/auto';
import { historyTooltipInteraction } from '../chart/history-tooltips.js';

function fixture(t, extra = []) {
  const canvas = { width: 1000, height: 500 };
  const ctx = new Proxy({ canvas, measureText: value => ({ width: String(value).length * 7 }) },
    { get: (target, key) => target[key] ?? (() => {}) });
  canvas.getContext = () => ctx;
  const chart = new Chart(canvas, { type: 'line', data: { datasets: [
    { key: 'runtime', showLine: false, pointRadius: 5, pointHitRadius: 12, data: [{ x: 20, y: 80 }] },
    { key: 'price', pointRadius: 1, pointHitRadius: 8, data: [{ x: 20.2, y: 80.2 }, { x: 50, y: 10 }] },
    ...extra,
  ] }, options: { responsive: false, animation: false, parsing: false,
    scales: { x: { type: 'linear', min: 0, max: 100 }, y: { type: 'linear', min: 0, max: 100 } },
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
  } });
  t.after(() => chart.destroy());
  const inspect = (x, y) => historyTooltipInteraction(chart, { native: {}, x, y }, { axis: 'x', intersect: false }, false);
  return { chart, inspect, marker: chart.getDatasetMeta(0).data[0] };
}

test('a sparse circle keeps its hit target when a smaller price point is closer in time and space', t => {
  const { chart, inspect, marker } = fixture(t);
  const price = chart.getDatasetMeta(1).data[0];
  assert(Math.abs(price.x - marker.x) < 5 && Math.abs(price.y - marker.y) < 5);
  assert.deepEqual(inspect(price.x, price.y).map(item => item.datasetIndex), [0],
    'All intersected points are filtered before distance ranking, so the price cannot steal the larger report target');
  assert.deepEqual(inspect(marker.x + 8, marker.y + 2).map(item => item.datasetIndex), [0],
    'The generous marker hit radius works beyond the visible circle');
});

test('overlapping genuine markers choose the nearest XY report and preserve exact ties', t => {
  const { chart, inspect, marker } = fixture(t, [
    { key: 'nearby', showLine: false, pointRadius: 5, pointHitRadius: 12, data: [{ x: 20.5, y: 80 }] },
    { key: 'same', showLine: false, pointRadius: 5, pointHitRadius: 12, data: [{ x: 20, y: 80 }] },
  ]);
  assert.deepEqual(inspect(marker.x, marker.y).map(item => item.datasetIndex), [0, 3]);
  const nearby = chart.getDatasetMeta(2).data[0];
  assert.deepEqual(inspect(nearby.x, nearby.y).map(item => item.datasetIndex), [2]);
});

test('ordinary small points at the same timestamp select the actual vertical target', t => {
  const { chart, inspect } = fixture(t, [
    { key: 'upper', pointRadius: 1, pointHitRadius: 12, data: [{ x: 60, y: 80 }] },
    { key: 'lower', pointRadius: 1, pointHitRadius: 12, data: [{ x: 60, y: 20 }] },
  ]);
  for (const index of [2, 3]) {
    const target = chart.getDatasetMeta(index).data[0];
    assert.deepEqual(inspect(target.x + 2, target.y + 1).map(item => item.datasetIndex), [index],
      'Sharing a timestamp cannot include a different series far above or below the pointer');
  }
});

test('a nearby ordinary line report beats a denser timestamp from a vertically distant series', t => {
  const { chart, inspect } = fixture(t, [
    { key: 'line', pointRadius: 0, pointHitRadius: 12, data: [{ x: 60, y: 70 }, { x: 70, y: 75 }] },
    { key: 'dense', pointRadius: 1, pointHitRadius: 8, data: [{ x: 60.2, y: 15 }] },
  ]);
  const target = chart.getDatasetMeta(2).data[0], dense = chart.getDatasetMeta(3).data[0];
  assert.deepEqual(inspect(dense.x, target.y + 1).map(item => item.datasetIndex), [2],
    'A line sample without a permanently visible dot remains inspectable by its actual hit region');
  assert.deepEqual(inspect(dense.x, dense.y).map(item => item.datasetIndex), [3], 'The small visible dot also keeps its direct target');
});

test('overlapping ordinary point targets rank by XY distance and share only exact ties', t => {
  const { chart, inspect } = fixture(t, [
    { key: 'one', pointRadius: 1, pointHitRadius: 12, data: [{ x: 60, y: 50 }] },
    { key: 'two', pointRadius: 1, pointHitRadius: 12, data: [{ x: 60.3, y: 50.3 }] },
    { key: 'same', pointRadius: 1, pointHitRadius: 12, data: [{ x: 60, y: 50 }] },
  ]);
  const one = chart.getDatasetMeta(2).data[0], two = chart.getDatasetMeta(3).data[0];
  assert.deepEqual(inspect(one.x, one.y).map(item => item.datasetIndex), [2, 4]);
  assert.deepEqual(inspect(two.x, two.y).map(item => item.datasetIndex), [3]);
  assert.deepEqual(inspect(one.x, two.y - 4).map(item => item.datasetIndex), [3],
    'Matching x alone does not beat a closer point in two dimensions');
});

test('hidden and synthetic boundary points cannot claim marker priority; normal nearest-time hover remains', t => {
  const { chart, inspect } = fixture(t, [
    { key: 'edge', pointRadius: 5, pointHitRadius: 12, data: [{ x: 50.1, y: 10, displayBoundary: true }] },
    { key: 'held', pointRadius: 5, pointHitRadius: 12, data: [{ x: 50.2, y: 10, carriedForward: true }] },
    { key: 'hidden', hidden: true, pointRadius: 5, pointHitRadius: 12, data: [{ x: 50, y: 10 }] },
    { key: 'context', pointRadius: 5, pointHitRadius: 12, data: [{ x: 50.1, y: 10, displayContext: true }] },
    { key: 'interpolated', pointRadius: 5, pointHitRadius: 12, data: [{ x: 50.1, y: 10, interpolated: true }] },
  ]);
  const price = chart.getDatasetMeta(1).data[1];
  assert.deepEqual(inspect(price.x, price.y).map(item => item.datasetIndex), [1]);
  const expected = chart.getElementsAtEventForMode({ native: {}, x: price.x, y: price.y + 100 }, 'nearest', { axis: 'x', intersect: false }, false);
  assert.deepEqual(inspect(price.x, price.y + 100).map(item => [item.datasetIndex, item.index]),
    expected.map(item => [item.datasetIndex, item.index]));
  assert.deepEqual(inspect(-10, -10), [], 'No point outside the plot acquires a tooltip');
});

test('small hidden or display-only vertices cannot claim priority over a nearby original sample', t => {
  const { chart, inspect } = fixture(t, [
    { key: 'sample', pointRadius: 0, pointHitRadius: 12, data: [{ x: 60, y: 50, held: true, savedIndoorAverage: true }] },
    ...['displayBoundary', 'carriedForward', 'displayContext', 'interpolated'].map(flag => ({
      key: flag, pointRadius: 1, pointHitRadius: 12, data: [{ x: 60.3, y: 50.3, [flag]: true }],
    })),
    { key: 'hidden', hidden: true, pointRadius: 1, pointHitRadius: 12, data: [{ x: 60.3, y: 50.3 }] },
  ]);
  const displayOnly = chart.getDatasetMeta(3).data[0];
  assert.deepEqual(inspect(displayOnly.x, displayOnly.y).map(item => item.datasetIndex), [2],
    'Saved source-quality flags do not turn a real record into a fabricated display vertex');
});
