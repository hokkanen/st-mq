import { CHART_VIEW_BY_KEY } from '../src/domain/chart-views.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LineElement } from 'chart.js';
import { historyDatasets } from '../chart/history-model.js';
import { preparePowerFills, fillSteppedBand, powerFillPlugin } from '../chart/power-fill.js';

function drawing() {
  const paths = [], fills = [], clips = [];
  let path;
  const ctx = {
    beginPath() { path = []; }, moveTo(x, y) { path = [[x, y]]; }, lineTo(x, y) { path.push([x, y]); },
    closePath() { paths.push(path); }, fill(rule) { fills.push(rule); },
    save() {}, restore() {}, rect(...bounds) { clips.push(bounds); }, clip() {},
  };
  return { ctx, paths, fills, clips };
}
const points = rows => rows.map(([x, y]) => ({ x, y, skip: y === null }));

test('stepped fill follows the exact Chart.js forward and reverse edge orientation', () => {
  const upper = points([[0, 5], [10, 3], [10, 2], [20, 4]]);
  const lower = points([[0, 9], [10, 8], [10, 7], [20, 8]]);
  const { ctx, paths, fills } = drawing();
  assert.equal(fillSteppedBand(ctx, upper, lower), 1);
  const expected = [[0, 5], [10, 5], [10, 3], [10, 3], [10, 2], [20, 2], [20, 4],
    [20, 8], [20, 7], [10, 7], [10, 8], [10, 8], [10, 9], [0, 9]];
  assert.deepEqual(paths, [expected]); assert.deepEqual(fills, ['nonzero']);
  const original = drawing();
  const options = { ...LineElement.defaults, stepped: true };
  new LineElement({ points: upper, options }).pathSegment(original.ctx, { start: 0, end: 3 });
  original.ctx.lineTo(lower.at(-1).x, lower.at(-1).y);
  new LineElement({ points: lower, options }).pathSegment(original.ctx, { start: 0, end: 3 }, { reverse: true, move: false });
  original.ctx.closePath();
  const withoutRepeatedVertices = path => path.filter((point, index) => !index
    || point[0] !== path[index - 1][0] || point[1] !== path[index - 1][1]);
  assert.deepEqual(original.paths.map(withoutRepeatedVertices), paths.map(withoutRepeatedVertices));
});

test('missing upper or lower data, duplicate missing edges and stops never acquire a fill bridge', () => {
  const upper = points([[0, 4], [10, 4], [10, null], [10, 3], [20, 3], [30, 2], [40, 2], [50, 1], [60, 1]]);
  const lower = points([[0, 8], [10, 8], [10, 8], [10, 7], [20, 7], [30, null], [40, 6], [50, 6], [60, 6]]);
  upper[7].stop = true;
  const before = structuredClone({ upper, lower }), result = drawing();
  assert.equal(fillSteppedBand(result.ctx, upper, lower), 3);
  assert.deepEqual(result.paths.map(path => [path[0][0], Math.max(...path.map(point => point[0]))]), [[0, 10], [10, 20], [50, 60]]);
  assert.deepEqual({ upper, lower }, before);
});

test('origin bands preserve every disconnected interval and paint once with linear path work', () => {
  const upper = [];
  for (let index = 0; index < 2000; index++) upper.push(...points([[index * 3, 5], [index * 3 + 1, 2], [index * 3 + 2, null]]));
  const result = drawing();
  assert.equal(fillSteppedBand(result.ctx, upper, 10), 2000);
  assert.equal(result.paths.length, 2000); assert.equal(result.fills.length, 1);
  assert(result.paths.reduce((sum, path) => sum + path.length, 0) <= upper.length * 3);
  assert(result.paths.every(path => path.every(([x, y]) => Number.isFinite(x) && y >= 2 && y <= 10)));
});

test('only supported aligned bands bypass generic filling; original data and tooltip metadata remain intact', () => {
  const sample = points([[0, 2], [10, 3]]);
  sample[0].observedAt = 0; sample[0].fromEnergy = true;
  const datasets = [
    { kind: 'fill', stepped: true, fill: 'origin', data: sample },
    { kind: 'fill', stepped: true, fill: 0, data: points([[0, 5], [10, 7]]) },
    { kind: 'fill', stepped: true, fill: 0, data: points([[1, 5], [10, 7]]) },
    { kind: 'line', stepped: true, fill: 'origin', data: sample },
    { kind: 'fill', stepped: 'after', fill: 'origin', data: sample },
  ];
  const before = structuredClone(datasets), result = preparePowerFills(datasets);
  assert.deepEqual(result.slice(0, 2).map(dataset => dataset.fill), [false, false]);
  assert.deepEqual(result.slice(0, 2).map(dataset => dataset.powerFill.target), ['origin', 0]);
  for (let index = 2; index < result.length; index++) assert.equal(result[index], datasets[index]);
  assert.equal(result[0].data, sample); assert.deepEqual(datasets, before);
});

test('only charger bands use their current baseline and clipped Chart pixel coordinates', () => {
  const series = { property_power: points([[0, 9], [10, 9]]), auxiliary_power: points([[0, 2], [10, 3]]),
    charger_power: points([[0, 4], [10, 5]]), charger2_power: points([[0, 1], [10, 1]]) };
  for (const preferences of [{}, { auxiliary_power: false }, { charger_power: false }]) {
    const datasets = preparePowerFills(historyDatasets(series, CHART_VIEW_BY_KEY.power, preferences));
    for (const dataset of datasets.filter(row => row.kind === 'fill' && !row.hidden)) {
      assert.equal(dataset.fill, false);
      const target = dataset.powerFill.target;
      assert.equal(target === 'origin' ? null : datasets[target].key, dataset.powerStackBase);
    }
    const result = drawing();
    const metas = datasets.map(dataset => ({ data: dataset.data.map(point => ({ ...point, y: 100 - point.y })),
      dataset: { options: { backgroundColor: dataset.backgroundColor } }, vScale: { getBasePixel: () => 100 } }));
    const chart = { data: { datasets }, ctx: result.ctx, chartArea: { left: 0, right: 10, top: 0, bottom: 100 },
      getDatasetMeta: index => metas[index], isDatasetVisible: index => !datasets[index].hidden };
    datasets.forEach((dataset, index) => { if (!dataset.hidden) powerFillPlugin.beforeDatasetDraw(chart, { index, meta: metas[index] }); });
    assert.equal(result.paths.length, preferences.charger_power === false ? 1 : 2);
    assert(result.clips.every(bounds => bounds.join(',') === '0,0,10,100'));
    assert.equal(datasets.find(dataset => dataset.key === 'auxiliary_power').powerFill, undefined);
  }
  const phases = preparePowerFills(historyDatasets({ ev1_current_l1: points([[0, 4], [10, 5]]) }, CHART_VIEW_BY_KEY.phases));
  assert.equal(phases.find(dataset => dataset.key === 'ev1_current_l1').powerFill.target, 'origin');
  assert.equal(phases.find(dataset => dataset.key === 'ev1_current_l1').fill, false);
});
