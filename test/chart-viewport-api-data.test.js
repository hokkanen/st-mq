import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { chartRange, chartRequestRange, getChartData } from '../src/app/chart-data.js';
import { appendLearningRecord } from '../src/app/committed-learning.js';
import { addFireplace } from '../src/app/fireplace.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const day = '2026-09-08', from = Date.parse('2026-09-07T21:00:00Z'), now = from + 24 * HOUR;
const args = { input: 'providers', startDate: day, now };
function observation(store, signal, value, at, extra = {}) {
  store.observation({ source: 'synthetic-chart', device: 'synthetic-room', signal, value,
    unit: 'degC', sourceTime: at, receivedAt: at, quality: [], ...extra });
}

test('viewport requires an exact nonempty subset of the immutable calendar selection, including DST', () => {
  for (const [startDate, hours] of [['2026-03-29', 23], ['2026-10-25', 25]]) {
    const selection = chartRange({ startDate, now });
    const viewFrom = selection.from + HOUR, viewTo = selection.to - HOUR;
    const result = chartRequestRange({ startDate, now, viewFrom, viewTo });
    assert.deepEqual(result.selection, selection);
    assert.equal(result.range.from, viewFrom);
    assert.equal(result.range.to, viewTo);
    assert.equal(result.range.to - result.range.from, (hours - 2) * HOUR);
    assert.equal(result.range.startDate, startDate);
    for (const bounds of [{ viewFrom }, { viewTo }, { viewFrom: null, viewTo },
      { viewFrom: String(viewFrom), viewTo }, { viewFrom: viewFrom + 0.5, viewTo },
      { viewFrom: selection.from - 1, viewTo }, { viewFrom, viewTo: selection.to + 1 },
      { viewFrom, viewTo: viewFrom }, { viewFrom, viewTo: viewFrom - 1 }])
      assert.throws(() => chartRequestRange({ startDate, now, ...bounds }), /viewport/);
  }
});

test('detail inside a three-year selection reveals original samples with bounded scanning and no selection totals', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const selected = { ...args, startDate: '2024-01-01', endDate: '2026-12-31', now: Date.parse('2027-01-01T00:00:00Z'), points: 100 };
  for (const start of [Date.parse('2024-01-01T00:00:00Z'), from])
    for (let minute = 0; minute < 1_000; minute++)
      observation(store, 'indoor_temperature', 20 + minute % 60 / 1000, start + minute * MINUTE);
  store.db.exec('PRAGMA query_only=ON');
  const overview = getChartData({ store, ...selected });
  const viewFrom = from + 6 * HOUR, viewTo = from + 7 * HOUR;
  const detail = getChartData({ store, ...selected, viewFrom, viewTo });
  const originalAt = viewFrom + 10 * MINUTE;
  assert(!overview.series.indoor_temperature.some(point => point.x === originalAt));
  assert(detail.series.indoor_temperature.some(point => point.x === originalAt && point.y === 20.01));
  assert(detail.meta.rawRows < overview.meta.rawRows / 4, 'Only viewport and bounded source context are scanned');
  assert.deepEqual(detail.selection, overview.range);
  assert.equal(detail.range.from, viewFrom); assert.equal(detail.range.to, viewTo);
  assert.equal(detail.meta.detail, true);
  for (const key of ['timingBenefit', 'heatingBenefit', 'firewoodBenefit']) {
    assert(Object.hasOwn(overview, key));
    assert(!Object.hasOwn(detail, key), 'A detail response cannot replace selected-period totals');
  }
  assert.equal(detail.meta.firewoodOutcomes, null);
  assert.equal(detail.meta.heatPumpEnergy, null, 'Detail skips invisible timing reconstruction');
  assert(Object.values(detail.series).flat().every(point => point.x >= viewFrom && point.x <= viewTo));
  const sameDay = getChartData({ store, ...args, points: 100, viewFrom, viewTo });
  assert.deepEqual(detail.series.indoor_temperature, sameDay.series.indoor_temperature,
    'Detail resolution and source interpretation do not depend on original selected span');
});

test('viewport edges retain exact energy intervals, price coverage, request expiry and missing markers', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const start = from + HOUR, viewFrom = start + MINUTE, viewTo = start + 9 * MINUTE;
  for (let phase = 1; phase <= 3; phase++) observation(store, `property_energy_l${phase}`, 0.1,
    start + 10 * MINUTE, { source: 'easee', unit: 'kWh', quality: ['estimated'],
      raw: { intervalStart: start, intervalEnd: start + 10 * MINUTE } });
  observation(store, 'dhwr_request', 1, start, { source: 'controller', device: 'providers', unit: 'state',
    quality: ['requested'], raw: { expiresAt: start + 5 * MINUTE } });
  for (const [minute, value] of [[2, 21], [3, null], [4, 22]])
    observation(store, 'garage_temperature', value, start + minute * MINUTE);
  const market = { fetchedAt: start, intervals: [{ start, end: start + 15 * MINUTE,
    spotCtPerKwh: -5, unit: 'c/kWh', vatIncluded: false, source: 'synthetic-market' }] };
  const result = getChartData({ store, ...args, market, viewFrom, viewTo });
  const power = result.series.property_power.filter(point => point.y !== null);
  assert.equal(power[0].x, viewFrom); assert.equal(power.at(-1).x, viewTo - 1);
  assert(power.every(point => Math.abs(point.y - 1.8) < 1e-12));
  assert(power.every(point => point.intervalStart === start && point.intervalEnd === start + 10 * MINUTE));
  assert(result.series.spot_price.some(point => point.x === viewFrom && point.y === -5));
  assert(result.series.spot_price.some(point => point.x === viewTo - 1 && point.y === -5));
  assert.deepEqual(result.shading.dhwr, [{ start: viewFrom, end: start + 5 * MINUTE }]);
  assert.deepEqual(result.series.garage_temperature.map(point => point.y), [21, null, 22]);
  assert(Object.values(result.series).flat().every(point => point.x >= viewFrom && point.x <= viewTo));
});

test('a viewport within one learning interval keeps its committed boundaries and value', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const start = from + HOUR, end = start + 15 * MINUTE;
  store.appendLearningJournal('providers', { kind: 'sample', at: end, algorithmVersion: 'synthetic-v1',
    payload: { value: { timestamp: end, windowStart: start, windowEnd: end, quality: [],
      inputSegments: [{ start, end, outdoorC: 8, quality: [] }] } } });
  const viewFrom = start + 5 * MINUTE, viewTo = start + 10 * MINUTE;
  const result = getChartData({ store, ...args, left: 'model_outdoor_temperature', viewFrom, viewTo });
  assert.deepEqual(result.series.model_outdoor_temperature.map(point => [point.x, point.y]),
    [[viewFrom, 8], [viewTo - 1, 8], [viewTo, null]]);
  assert(result.series.model_outdoor_temperature.filter(point => point.y !== null)
    .every(point => point.intervalStart === start && point.intervalEnd === end));
});

test('a viewport between scalar readings clips their original line and clearly identifies display points', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const start = from + HOUR, viewFrom = start + 2 * MINUTE, viewTo = start + 4 * MINUTE;
  observation(store, 'indoor_temperature', 20, start);
  observation(store, 'indoor_temperature', 24, start + 8 * MINUTE);
  observation(store, 'heating_integral', -100, start, { unit: '°min' });
  observation(store, 'heating_integral', -20, start + 8 * MINUTE, { unit: '°min' });
  observation(store, 'operating_mode', 1, start, { unit: 'state' });
  observation(store, 'operating_mode', 2, start + 8 * MINUTE, { unit: 'state' });
  const linear = getChartData({ store, ...args, left: 'integral', viewFrom, viewTo });
  assert.deepEqual(linear.series.indoor_temperature.map(point => [point.x, point.y]), [[viewFrom, 21], [viewTo, 22]]);
  assert.deepEqual(linear.series.heating_integral.map(point => point.y), [-80, -60]);
  assert(linear.series.indoor_temperature.every(point => point.displayBoundary && point.interpolated
    && point.observedAt === start && point.nextObservedAt === start + 8 * MINUTE));
  for (const left of ['temperatures', 'indoor_temperature']) {
    const temperatures = getChartData({ store, ...args, left, viewFrom, viewTo });
    assert.deepEqual(temperatures.series.indoor_temperature, linear.series.indoor_temperature,
      'A room temperature must retain the same interpolated display boundaries on either axis');
  }
  const stepped = getChartData({ store, ...args, left: 'operating_mode', viewFrom, viewTo });
  assert.deepEqual(stepped.series.operating_mode.map(point => point.y), [1, 1]);
  assert(stepped.series.operating_mode.every(point => point.displayBoundary && !point.interpolated));
  assert.equal(stepped.meta.lastReadings.indoor_temperature.x, start + 8 * MINUTE,
    'Boundary interpolation never replaces an original observation timestamp');
});

test('clipped scalar context cannot bridge missing readings or extend past selected date bounds', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const start = from + HOUR;
  observation(store, 'indoor_temperature', 20, start);
  observation(store, 'indoor_temperature', null, start + 8 * MINUTE);
  observation(store, 'operating_mode', 1, start, { unit: 'state' });
  observation(store, 'operating_mode', null, start + 8 * MINUTE, { unit: 'state' });
  observation(store, 'garage_temperature', 20, start);
  observation(store, 'garage_temperature', 24, start + 4 * HOUR);
  observation(store, 'outdoor_temperature', 5, from + 24 * HOUR - MINUTE);
  observation(store, 'outdoor_temperature', 6, from + 24 * HOUR + MINUTE);
  const missing = getChartData({ store, ...args, left: 'operating_mode', viewFrom: start + 2 * MINUTE, viewTo: start + 4 * MINUTE });
  assert(missing.series.indoor_temperature.every(point => point.y === null));
  assert(missing.series.operating_mode.every(point => point.y === null));
  const gap = getChartData({ store, ...args, viewFrom: start + 2 * HOUR, viewTo: start + 2 * HOUR + MINUTE });
  assert(gap.series.garage_temperature.every(point => point.y === null), 'A four-hour source gap remains missing');
  const edge = getChartData({ store, ...args, now: now + HOUR, viewFrom: now - 30_000, viewTo: now });
  assert(!edge.series.outdoor_temperature.some(point => Number.isFinite(point.y)),
    'An observation outside the selected dates cannot extend the chart domain');
});

test('following context preserves the valid auxiliary hold and its expiry before a long gap', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const start = from + HOUR;
  const extra = { source: 'husdata-h66', unit: '%',
    raw: { verified: true, usableForControl: true, ratedPowerKw: 9 } };
  observation(store, 'auxiliary_output', 33, start, extra);
  observation(store, 'auxiliary_output', 67, start + 20 * MINUTE, extra);
  const held = getChartData({ store, ...args, viewFrom: start + MINUTE, viewTo: start + 2 * MINUTE });
  assert.deepEqual(held.series.auxiliary_power.map(point => [point.x, point.y]),
    [[start + MINUTE, 3], [start + 2 * MINUTE, 3]]);
  assert(held.series.auxiliary_power.every(point => point.displayBoundary && !point.interpolated
    && point.observedAt === start));
  const expiry = getChartData({ store, ...args, viewFrom: start + 4 * MINUTE, viewTo: start + 6 * MINUTE });
  assert.deepEqual(expiry.series.auxiliary_power.map(point => [point.x, point.y]),
    [[start + 4 * MINUTE, 3], [start + 5 * MINUTE, 3], [start + 5 * MINUTE + 1, null]]);
  const gap = getChartData({ store, ...args, viewFrom: start + 6 * MINUTE, viewTo: start + 7 * MINUTE });
  assert(gap.series.auxiliary_power.every(point => point.y === null));
});

test('future context closes earlier state spans without reviving expired equipment or pulse shading', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const start = from + HOUR;
  for (const [minute, active] of [[0, 1], [20, 0]]) {
    for (const [signal, value] of [['compressor_active', active], ['dhw_routing', 0], ['operating_mode', active]])
      observation(store, signal, value, start + minute * MINUTE, { source: 'husdata-h66', unit: 'state',
        raw: { verified: true, usableForControl: true } });
    observation(store, 'controller_phase', active ? 2 : 0, start + minute * MINUTE,
      { source: 'controller', device: 'providers', unit: 'state', raw: { expiresAt: start + 45 * MINUTE } });
    observation(store, 'dhwr_request', 1, start + minute * MINUTE,
      { source: 'controller', device: 'providers', unit: 'state', raw: { expiresAt: start + (minute + 10) * MINUTE } });
  }
  const early = getChartData({ store, ...args, viewFrom: start + 2 * MINUTE, viewTo: start + 4 * MINUTE });
  const earlySpan = [{ start: early.range.from, end: early.range.to }];
  for (const key of ['compressorSpace', 'heatOff', 'dhwr']) assert.deepEqual(early.shading[key], earlySpan);
  assert.deepEqual(early.operatingModes, [{ ...earlySpan[0], value: 1 }]);
  const later = getChartData({ store, ...args, viewFrom: start + 11 * MINUTE, viewTo: start + 12 * MINUTE });
  assert.deepEqual(later.shading.compressorSpace, []);
  assert.deepEqual(later.shading.dhwr, []);
  assert.deepEqual(later.operatingModes, []);
  assert.deepEqual(later.shading.heatOff, [{ start: later.range.from, end: later.range.to }],
    'The longer dated phase request remains active until the recorded later transition');
});

test('zooming into daily firewood outcomes preserves the selected whole-day total and coverage', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const start = from + 10 * HOUR;
  addFireplace(store, 'providers', { requestId: 'synthetic-viewport-fire', kg: 8 }, start);
  for (let i = 0; i <= 32; i++) {
    const at = start + i * HOUR / 4;
    appendLearningRecord(store, 'providers', 'sample', { timestamp: at, windowStart: at - HOUR / 4,
      windowEnd: at, indoorC: 21, outdoorC: 0, solarRadiationWm2: 0, phase: 'normal', targetC: 21,
      thermalCompressorDuty: 0.5, thermalAuxKw: 0, quality: [] });
  }
  const pricing = { contract: { periods: [{ from, marginCtPerKwh: 0.4,
    taxCtPerKwh: 2.2, vatRate: 0.255, tariff: 'day-night' }] },
    market: { fetchedAt: start, intervals: [{ start, end: start + 8 * HOUR,
      spotCtPerKwh: 10, unit: 'c/kWh', vatIncluded: false, source: 'synthetic-market' }] } };
  const overview = getChartData({ store, ...args, ...pricing, left: 'firewood_savings' });
  const detail = getChartData({ store, ...args, ...pricing, left: 'firewood_savings', viewFrom: from, viewTo: from + HOUR });
  assert(overview.series.firewood_savings[0].y > 0);
  assert.deepEqual(detail.series.firewood_savings, overview.series.firewood_savings,
    'The daily point still includes the later fire even though the viewport shows only the day boundary');
  assert(!Object.hasOwn(detail, 'firewoodBenefit'));
});
