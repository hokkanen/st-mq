import test from 'node:test';
import assert from 'node:assert/strict';
import { historyDatasets } from '../chart/history-model.js';
import { CHART_VIEW_BY_KEY } from '../src/domain/chart-views.js';
import { preparePowerFills } from '../chart/power-fill.js';
import { historyTooltipLabel } from '../chart/history-tooltips.js';

function fixture() {
  const series = {};
  for (const [phase, one, two] of [[1, 2, 3], [2, 5, 7], [3, 11, 13]]) {
    series[`property_current_l${phase}`] = [{ x: 0, y: 30 }, { x: 20, y: 30 }];
    series[`ev1_current_l${phase}`] = [0, 10, 20].map(x => ({ x, y: one, source: 'charger-one', observedAt: x }));
    series[`ev2_current_l${phase}`] = [0, 5, 20].map(x => ({ x, y: two, source: 'charger-two', observedAt: x }));
  }
  return series;
}
test('phase charging fills stack only the two sources on their own conductor with original ampere tooltips', () => {
  const series = fixture(), before = structuredClone(series);
  const datasets = historyDatasets(series, CHART_VIEW_BY_KEY.phases);
  const prepared = preparePowerFills(datasets);
  for (const [phase, expected] of [[1, 5], [2, 12], [3, 24]]) {
    const property = datasets.find(row => row.key === `property_current_l${phase}`);
    const one = datasets.find(row => row.key === `ev1_current_l${phase}`), two = datasets.find(row => row.key === `ev2_current_l${phase}`);
    assert.equal(property.fill, false); assert.equal(property.data, series[property.key]);
    assert.equal(one.fill, 'origin'); assert.equal(two.fill, datasets.indexOf(one));
    assert(one.order > two.order && property.order < two.order);
    assert(two.data.every(point => point.y === expected));
    assert.deepEqual(one.data.map(point => point.x), two.data.map(point => point.x));
    assert.equal(prepared.find(row => row.key === two.key).powerFill.target, datasets.indexOf(one));
    const point = two.data.find(point => point.x === 10);
    assert.equal(point.source, 'charger-two'); assert.equal(point.observedAt, 5);
    const tooltip = historyTooltipLabel({ dataset: two, parsed: { x: point.x, y: point.y }, raw: point });
    assert(tooltip.startsWith(`Charger 2 L${phase}: ${series[two.key][0].y} A`));
  }
  assert.deepEqual(series, before);
});

test('per-phase toggles rebase only the selected phase and independent gaps never erase another conductor', () => {
  const series = fixture();
  series.ev1_current_l1.splice(1, 0, { x: 5, y: null });
  const datasets = historyDatasets(series, CHART_VIEW_BY_KEY.phases);
  const l1 = datasets.find(row => row.key === 'ev2_current_l1');
  assert.equal(l1.data.find(point => point.x === 5).y, null);
  assert.equal(l1.data.find(point => point.x === 5).componentValue, 3);
  for (const phase of [2, 3]) assert(datasets.find(row => row.key === `ev2_current_l${phase}`).data.every(point => Number.isFinite(point.y)));
  const hidden = historyDatasets(series, CHART_VIEW_BY_KEY.phases, { ev1_current_l1: false });
  const independent = hidden.find(row => row.key === 'ev2_current_l1');
  assert.equal(independent.fill, 'origin'); assert.equal(independent.data, series.ev2_current_l1);
  assert.equal(hidden.find(row => row.key === 'ev2_current_l2').powerStackBase, 'ev1_current_l2');
  const raw = historyDatasets(series, { leftSignals: ['ev1_current_l1', 'ev2_current_l1'], rightSignals: [] });
  assert(raw.every(row => row.fill === false), 'The independent series explorer does not silently introduce a stack');
});

test('a phase with no overlapping charger observations displays both independently from zero', () => {
  const series = fixture();
  series.ev2_current_l1 = [{ x: 30, y: 4 }, { x: 40, y: 4 }];
  const datasets = historyDatasets(series, CHART_VIEW_BY_KEY.phases);
  for (const key of ['ev1_current_l1', 'ev2_current_l1']) {
    const row = datasets.find(row => row.key === key);
    assert.equal(row.fill, 'origin'); assert.equal(row.data, series[key]);
    assert.equal(row.powerStacked, false);
  }
});
