import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceChartSeries, reduceSeries } from '../chart/chart-viewport.js';
import { historyDatasets } from '../chart/history-model.js';
import { intervalPoints } from '../chart/interval-points.js';

const loads = ['auxiliary_power', 'charger_power', 'charger2_power'];
const powerKeys = ['property_power', ...loads];
const finite = Number.isFinite;
const near = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-9, message ?? `${actual} differs from ${expected}`);

function sample(key, x, y) {
  return { x, y, source: `fixture-${key}`, observedAt: x, intervalStart: x, intervalEnd: x + 1, quality: ['fixture-estimate'] };
}

function powerFixture(count = 1000) {
  const result = Object.fromEntries(powerKeys.map(key => [key, []]));
  for (let x = 0; x < count; x++) {
    const at = x % 100;
    const auxiliary_power = at >= 20 && at < 30 ? 4 : 2;
    const charger_power = at >= 40 && at < 60 ? 9 : 0;
    const charger2_power = at >= 80 && at < 90 ? 4 : 0;
    const property_power = 1 + auxiliary_power + charger_power + charger2_power + (at === 70 ? 20 : 0);
    for (const [key, y] of Object.entries({ auxiliary_power, charger_power, charger2_power, property_power })) result[key].push(sample(key, x, y));
  }
  return result;
}

// Match the chart's bounded step segments, including the last side of duplicate
// timestamps. Unknown neighboring endpoints cannot support a connecting line.
function stepAt(points, x) {
  const previous = points.findLast(point => point.x <= x);
  if (previous?.x === x) return previous.y;
  const following = points.find(point => point.x > x);
  return finite(previous?.y) && finite(following?.y) ? previous.y : null;
}

function timesAndMidpoints(groups) {
  const times = [...new Set(groups.flatMap(points => points.map(point => point.x)))].sort((a, b) => a - b);
  return times.flatMap((x, index) => index ? [(times[index - 1] + x) / 2, x] : [x]);
}

function assertAligned(series, keys) {
  const timeline = series[keys[0]].map(point => point.x);
  for (const key of keys.slice(1)) assert.deepEqual(series[key].map(point => point.x), timeline, `${key} retains the shared timeline and duplicate edges`);
}

function assertPowerRelationship(series, preferences = {}) {
  const datasets = historyDatasets(series, 'power', preferences);
  const components = loads.filter(key => preferences[key] !== false);
  const property = datasets.find(dataset => dataset.key === 'property_power');
  const top = datasets.find(dataset => dataset.key === components.at(-1));
  for (const x of timesAndMidpoints(powerKeys.map(key => series[key]))) {
    const total = stepAt(property.data, x);
    const values = components.map(key => stepAt(series[key], x));
    if (!finite(total) || values.some(value => !finite(value))) continue;
    const sum = values.reduce((value, next) => value + next, 0);
    assert(sum <= total + 1e-9, `At ${x}, known component sum ${sum} exceeds displayed property ${total}`);
    near(stepAt(top.data, x), sum, `Stack at ${x} preserves the visible components' own values`);
  }
}

function assertNoBridgedGaps(original, reduced, key) {
  for (let index = 1; index < reduced.length; index++) {
    const previous = reduced[index - 1], next = reduced[index];
    if (!finite(previous.y) || !finite(next.y)) continue;
    const missing = original.find(point => point.x > previous.x && point.x < next.x && !finite(point.y));
    assert(!missing, `${key} bridges an omitted gap at ${missing?.x} between ${previous.x} and ${next.x}`);
  }
}

test('grouped reduction keeps three charging/heating fills below the contemporaneous property curve', () => {
  const source = powerFixture();
  const before = structuredClone(source), view = { from: 0, to: 999 };
  // This is the original regression: unrelated house demand has a later peak
  // than charging. Independent extrema retain incompatible moments in time.
  const independent = Object.fromEntries(Object.entries(source).map(([key, points]) => [key, reduceSeries(points, view, 7)]));
  assert(stepAt(independent.charger_power, 40) + stepAt(independent.auxiliary_power, 40) > stepAt(independent.property_power, 40));
  for (const budget of [7, 35, 140]) {
    const reduced = reduceChartSeries(source, view, budget);
    assertAligned(reduced, powerKeys);
    assert(reduced.property_power.length < source.property_power.length, 'Exercise actual point reduction');
    for (const key of powerKeys) near(Math.max(...reduced[key].map(point => point.y).filter(finite)), Math.max(...source[key].map(point => point.y)));
    assertPowerRelationship(reduced);
    near(stepAt(reduced.property_power, 40), 12);
    near(stepAt(reduced.charger_power, 40), 9);
  }
  assert.deepEqual(source, before, 'Display reduction does not rewrite source values or metadata');
});

test('duplicate interval edges keep both power states and valid sums at edges and midpoints', () => {
  const values = Array.from({ length: 100 }, (_, index) => {
    const auxiliary = index === 1 ? 5 : 2, charger1 = index === 0 ? 3 : 0, charger2 = index === 1 ? 4 : 0;
    return [auxiliary + charger1 + charger2 + 1 + (index === 3 ? 20 : 0), auxiliary, charger1, charger2];
  });
  const source = Object.fromEntries(powerKeys.map((key, component) => [key, intervalPoints(values.map((row, index) => ({
    start: index * 10, end: (index + 1) * 10, value: row[component],
  })), 'value')]));
  const reduced = reduceChartSeries(source, { from: 0, to: 1000 }, 20);
  assertAligned(reduced, powerKeys);
  for (const key of powerKeys) assert.deepEqual(reduced[key].filter(point => point.x === 10).map(point => point.y), source[key].filter(point => point.x === 10).map(point => point.y));
  assertPowerRelationship(reduced);
  const top = historyDatasets(reduced, 'power').find(dataset => dataset.key === 'charger2_power');
  assert.deepEqual(top.data.filter(point => point.x === 10).map(point => point.y), [5, 9]);
  assert(top.data.at(-1).y === null, 'The final interval end cannot become indefinite charging');
});

test('all six phase-current curves retain simultaneous EV/property comparisons after reduction', () => {
  const keys = ['property', 'ev1'].flatMap(prefix => [1, 2, 3].map(phase => `${prefix}_current_l${phase}`));
  const source = Object.fromEntries(keys.map(key => [key, []]));
  for (let x = 0; x < 500; x++) {
    for (const phase of [1, 2, 3]) {
      const charging = x % 100 >= 10 * phase && x % 100 < 10 * phase + 10 ? phase * 5 : 0;
      const property = charging + 2 + (x % 100 === 70 + phase ? 25 : 0);
      for (const [prefix, value] of [['property', property], ['ev1', charging]]) {
        const key = `${prefix}_current_l${phase}`; source[key].push(sample(key, x, value));
      }
    }
  }
  const reduced = reduceChartSeries(source, { from: 0, to: 499 }, 35);
  assertAligned(reduced, keys);
  assert(reduced[keys[0]].length < source[keys[0]].length);
  for (const x of timesAndMidpoints(Object.values(reduced))) {
    for (const phase of [1, 2, 3]) {
      const property = stepAt(reduced[`property_current_l${phase}`], x), charging = stepAt(reduced[`ev1_current_l${phase}`], x);
      if (finite(property) && finite(charging)) assert(charging <= property, `L${phase} charging exceeds its property curve at ${x}`);
    }
  }
  const datasets = historyDatasets(reduced, 'phases');
  assert(keys.every(key => datasets.find(dataset => dataset.key === key).data === reduced[key]));
});

test('paired prices retain contemporaneous values without clipping genuine negative-price relationships', () => {
  const source = { spot_price: [], all_in_price: [] };
  for (let x = 0; x < 100; x++) {
    const spot = x < 20 ? -5 : x >= 40 && x < 60 ? 12 : 0;
    const allIn = x < 20 ? -8 : x >= 40 && x < 60 ? 18 : x === 70 ? 30 : 2;
    source.spot_price.push(sample('spot_price', x, spot)); source.all_in_price.push(sample('all_in_price', x, allIn));
  }
  const reduced = reduceChartSeries(source, { from: 0, to: 99 }, 7);
  assertAligned(reduced, ['spot_price', 'all_in_price']);
  near(stepAt(reduced.spot_price, 40), 12); near(stepAt(reduced.all_in_price, 40), 18);
  near(reduced.spot_price[0].y, -5); near(reduced.all_in_price[0].y, -8);
});

test('interlaced missing runs cannot be reopened when another curve adds shared sample times', () => {
  const source = Object.fromEntries(powerKeys.map((key, component) => [key,
    Array.from({ length: 200 }, (_, x) => sample(key, x, component === 0 ? 20 : component + 1)),
  ]));
  for (const [key, ranges] of Object.entries({
    auxiliary_power: [[20, 30], [80, 90], [150, 160]],
    charger_power: [[50, 60], [120, 130]],
    charger2_power: [[100, 110], [170, 180]],
    property_power: [[140, 145]],
  })) for (const [from, to] of ranges) for (let x = from; x < to; x++) source[key][x].y = null;
  // A zero-duration missing marker at a step boundary must survive expansion
  // of the selected timestamp group too, independently of the longer outages.
  source.charger2_power.splice(10, 0, { ...source.charger2_power[10], y: null });
  const reduced = reduceChartSeries(source, { from: 0, to: 199 }, 7);
  assertAligned(reduced, powerKeys);
  for (const key of powerKeys) assertNoBridgedGaps(source[key], reduced[key], key);
  assert(reduced.charger2_power.some(point => point.x === 10 && point.y === null), 'A missing marker beside a finite reading at the same timestamp survives');
  assert(reduced.charger2_power.some(point => point.x === 10 && finite(point.y)));
  for (const key of powerKeys) {
    const first = reduced[key][0], last = reduced[key].at(-1);
    assert.equal(first.x, 0); assert.equal(last.x, 199);
  }
});

test('alignment preserves recorded provenance and labels held sample times honestly', () => {
  const source = {
    property_power: [sample('property', 0, 20), sample('property', 22, 20), sample('property', 44, 25), sample('property', 66, 25)],
    auxiliary_power: [sample('auxiliary', 0, 2), sample('auxiliary', 20, 2), sample('auxiliary', 40, 3), sample('auxiliary', 60, 3)],
    charger_power: [sample('charger1', 5, 4), sample('charger1', 15, 6), sample('charger1', 30, 6), sample('charger1', 50, 4), sample('charger1', 65, 4)],
    charger2_power: [sample('charger2', 0, 1), sample('charger2', 25, 1), sample('charger2', 55, 2), sample('charger2', 65, 2)],
  };
  const before = structuredClone(source);
  const reduced = reduceChartSeries(source, { from: 0, to: 66 }, 500);
  assertAligned(reduced, powerKeys);
  let held = 0;
  for (const key of powerKeys) for (const point of reduced[key]) {
    if (!finite(point.y)) continue;
    const original = source[key].find(candidate => candidate.observedAt === point.observedAt);
    assert(original, `${key} still refers to a recorded observation`);
    near(point.y, original.y);
    for (const field of ['source', 'observedAt', 'intervalStart', 'intervalEnd', 'quality']) assert.deepEqual(point[field], original[field]);
    if (point.x !== original.x) {
      held++; assert.equal(point.displayBoundary, true); assert.equal(point.interpolated, false);
      assert.notEqual(point.x, point.observedAt, 'An aligned display timestamp is not a new observation timestamp');
    }
  }
  assert(held > 0);
  const datasets = historyDatasets(reduced, 'power');
  for (const key of loads) {
    const dataset = datasets.find(row => row.key === key);
    for (let index = 0; index < dataset.data.length; index++) {
      const point = dataset.data[index];
      if (finite(point.y)) near(point.componentValue ?? point.y, reduced[key][index].y);
    }
  }
  assert.deepEqual(source, before);
});

test('legend changes restack the reduced components while keeping property and individual tooltip values', () => {
  const source = powerFixture(), reduced = reduceChartSeries(source, { from: 0, to: 999 }, 35);
  const before = structuredClone(reduced);
  for (const preferences of [{}, { auxiliary_power: false }, { charger_power: false }, { charger2_power: false },
    { auxiliary_power: false, charger_power: false }, { charger_power: false, charger2_power: false }]) {
    assertPowerRelationship(reduced, preferences);
    const datasets = historyDatasets(reduced, 'power', preferences);
    let previous;
    for (const key of loads) {
      const dataset = datasets.find(row => row.key === key);
      if (preferences[key] === false) { assert.equal(dataset.hidden, true); continue; }
      assert.equal(dataset.fill, previous ? datasets.indexOf(previous) : 'origin');
      previous = dataset;
    }
    assert.equal(datasets.find(dataset => dataset.key === 'property_power').data, reduced.property_power);
  }
  assert.deepEqual(reduced, before);
});

test('each visible load combination retains its cumulative peak even away from individual component peaks', () => {
  const events = new Map([
    [10, [12, 0, 0]], [20, [0, 12, 0]], [30, [0, 0, 12]],
    [40, [10, 10, 10]], [50, [11, 11, 0]], [60, [11, 0, 11]], [70, [0, 11, 11]],
  ]);
  const source = Object.fromEntries(powerKeys.map(key => [key, []]));
  for (let x = 0; x < 100; x++) {
    const values = events.get(x) ?? [0, 0, 0];
    source.property_power.push(sample('property', x, 40));
    loads.forEach((key, component) => source[key].push(sample(key, x, values[component])));
  }
  const reduced = reduceChartSeries(source, { from: 0, to: 99 }, 7);
  assert(reduced.property_power.length < source.property_power.length);
  for (let mask = 1; mask < 8; mask++) {
    const preferences = Object.fromEntries(loads.map((key, bit) => [key, Boolean(mask & (1 << bit))]));
    const topKey = loads.filter(key => preferences[key]).at(-1);
    const fullStack = historyDatasets(source, 'power', preferences).find(dataset => dataset.key === topKey).data;
    const reducedStack = historyDatasets(reduced, 'power', preferences).find(dataset => dataset.key === topKey).data;
    near(Math.max(...reducedStack.map(point => point.y).filter(finite)), Math.max(...fullStack.map(point => point.y).filter(finite)),
      `Visibility combination ${mask} retains its real cumulative peak`);
  }
});

test('genuine recorded power conflicts and missing property readings are not clipped or rewritten', () => {
  const source = powerFixture(100), before = structuredClone(source);
  for (let x = 40; x < 60; x++) source.property_power[x].y = 6;
  const reduced = reduceChartSeries(source, { from: 0, to: 99 }, 7);
  const top = historyDatasets(reduced, 'power').find(dataset => dataset.key === 'charger2_power');
  near(stepAt(reduced.property_power, 40), 6); near(stepAt(top.data, 40), 11);
  near(stepAt(reduced.charger_power, 40), before.charger_power[40].y);
  for (let x = 40; x < 60; x++) source.property_power[x].y = null;
  const withMissing = reduceChartSeries(source, { from: 0, to: 99 }, 500);
  assert.equal(stepAt(withMissing.property_power, 45), null);
  near(stepAt(withMissing.charger_power, 45), 9, 'Missing property data cannot erase an independently recorded charger reading');
});
