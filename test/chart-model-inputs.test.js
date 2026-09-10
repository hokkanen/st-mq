import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Envelope, getChartData } from '../src/app/chart-data.js';
import { addModelInputs } from '../src/app/chart-model-inputs.js';
import { MODEL_INPUT_INFO } from '../src/domain/history-series.js';
import { historyDatasets, historySeriesAt, leftAxisAvailability, historyStateLabel } from '../chart/history-model.js';

const MINUTE = 60_000, start = Date.parse('2026-09-08T08:00:00Z');
function put(store, at, value, input = 'providers') {
  store.appendLearningJournal(input, { kind: 'sample', at, algorithmVersion: 'synthetic-v1',
    payload: { value, configuration: { privateFixture: 'invented-configuration-must-stay-private' } } });
}
const segment = (a, b, overrides = {}) => ({ start: start + a * MINUTE, end: start + b * MINUTE,
  outdoorC: 8, solarRadiationWm2: 300, phase: 'normal', roomBoostC: 0, targetC: 21,
  thermalCompressorDuty: 0, thermalAuxKw: 0, quality: [], ...overrides });
const sample = (a, b, segments, overrides = {}) => ({ timestamp: start + b * MINUTE,
  windowStart: start + a * MINUTE, windowEnd: start + b * MINUTE, indoorC: 21.4,
  quality: [], inputSegments: segments, ...overrides });
function project(store, input = 'providers') {
  const range = { from: start, to: start + 30 * MINUTE };
  const envelopes = Object.fromEntries(Object.keys(MODEL_INPUT_INFO).map(key => [key, new Envelope(range.from, range.to, 800)]));
  const meta = addModelInputs({ store, input, range, now: range.to, envelopes });
  return { meta, series: Object.fromEntries(Object.entries(envelopes).map(([key, envelope]) => [key, envelope.values()])) };
}

test('model charts retain committed segment timing, routed heat and original context without exposing journal payloads', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  put(store, start + 15 * MINUTE, sample(0, 15, [segment(0, 5, { compressorDuty: 1, auxKw: 3 }),
    segment(5, 15, { thermalCompressorDuty: 0.5, thermalAuxKw: 1.5, phase: 'reduction', targetC: 20 })]));
  // A conflicting mutable checkpoint and a future journal entry cannot rewrite saved inputs.
  store.setState('adaptive:providers', { baselineC: 29, privateFixture: 'invented-checkpoint-private' });
  put(store, start + 45 * MINUTE, sample(30, 45, [segment(30, 45, { thermalCompressorDuty: 1 })]));
  const result = project(store);
  assert.equal(result.meta.records, 1);
  const duty = result.series.model_compressor_duty;
  assert.deepEqual(duty.map(row => [row.x - start, row.y]), [[0, 0], [5 * MINUTE - 1, 0], [5 * MINUTE, 50], [15 * MINUTE - 1, 50], [15 * MINUTE, null]]);
  assert(result.series.model_auxiliary_power.some(row => row.y === 0), 'DHW electricity is not space-heating input');
  assert(result.series.model_target_temperature.some(row => row.y === 20));
  assert(!result.series.model_target_temperature.some(row => row.y === 29));
  assert.deepEqual(result.series.model_indoor_temperature.map(row => [row.x - start, row.y]), [[15 * MINUTE, 21.4]]);
  assert(result.series.model_controller_phase.some(row => row.y === 2));
  assert(duty.every(row => row.y === null || row.modelInput && row.inputSource === 'Recorded provider inputs'));
  assert(!JSON.stringify(result).includes('invented-'));
});

test('rejected windows, unknown heat input and simulation stay visibly separate', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  put(store, start + 15 * MINUTE, sample(0, 15, [segment(0, 15, { thermalCompressorDuty: null })]));
  put(store, start + 30 * MINUTE, sample(15, 30, [segment(15, 30, { thermalCompressorDuty: 1 })], { quality: ['missing'] }));
  put(store, start + 15 * MINUTE, sample(0, 15, [segment(0, 15, { thermalCompressorDuty: 1 })]), 'simulated');
  const actual = project(store);
  assert(actual.series.model_compressor_duty.every(row => row.y === null));
  assert(actual.series.model_outdoor_temperature.some(row => row.y === 8));
  assert(actual.series.model_outdoor_temperature.filter(row => row.x >= start + 15 * MINUTE).every(row => row.y === null));
  assert.equal(actual.meta.rejectedIntervals, 1);
  assert(project(store, 'simulated').series.model_compressor_duty.some(row => row.y === 100));
});

test('legacy model input history uses saved interval values and source labels without filling missing telemetry', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  put(store, start + 15 * MINUTE, { timestamp: start + 15 * MINUTE, windowStart: start,
    indoorC: 20, quality: [], intervalInputs: { outdoorC: 4, phase: 'reduction', compressorDuty: null, auxKw: null } }, 'history');
  const result = project(store, 'offline');
  assert(result.series.model_outdoor_temperature.some(row => row.y === 4 && row.inputSource === 'Imported history'));
  assert(result.series.model_compressor_duty.every(row => row.y === null));
  const chart = getChartData({ store, input: 'offline', now: start + 30 * MINUTE,
    startDate: '2026-09-08', left: 'model_outdoor_temperature' });
  assert(chart.series.model_outdoor_temperature.some(row => row.y === 4));
  assert.equal(chart.meta.modelInputs.records, 1);
  assert.deepEqual(chart.series.model_indoor_temperature.map(row => [row.y, row.inputSource]), [[20, 'Imported history']]);
  assert.deepEqual(chart.series.downstairs_temperature, []);
  assert.deepEqual(chart.series.bedroom_temperature, []);
});

test('the default Average indoor is the saved model input and missing sensors cannot change average membership', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const [signal, value] of [['indoor_temperature', 23], ['downstairs_temperature', 20],
    ['bedroom_temperature', 19], ['garage_temperature', 12]])
    store.observation({ source: 'mqtt-temperature', device: 'invented-room', signal, value, unit: '°C',
      sourceTime: start, receivedAt: start, quality: ['good'] });
  const args = { store, input: 'mqtt', now: start + 45 * MINUTE, startDate: '2026-09-08' };
  assert.deepEqual(getChartData(args).series.model_indoor_temperature, [], 'Raw rooms do not invent an earlier model average');
  put(store, start + 15 * MINUTE, sample(0, 15, [segment(0, 15)], { indoorC: 20.25 }), 'mqtt');
  put(store, start + 30 * MINUTE, sample(15, 30, [segment(15, 30)], { indoorC: null, quality: ['missing'] }), 'mqtt');
  store.setState('adaptive:mqtt', { indoorC: 29, configuration: { indoorSensorWeights: { indoor_temperature: 1 } } });
  for (const left of ['power', 'phases', 'temperatures', 'indoor_temperature', 'downstairs_temperature', 'bedroom_temperature', 'garage_temperature']) {
    const chart = getChartData({ ...args, left });
    assert.deepEqual(chart.series.model_indoor_temperature.map(row => [row.x, row.y]),
      [[start + 15 * MINUTE, 20.25], [start + 30 * MINUTE, null]]);
    const average = historyDatasets(chart.series, left).find(row => row.key === 'model_indoor_temperature');
    assert.equal(average.label, 'Average indoor');
    assert.equal(average.yAxisID, 'right');
    assert.equal(average.borderColor, '#81ca99');
    assert.deepEqual(historySeriesAt(chart).model_indoor_temperature, chart.series.model_indoor_temperature,
      'The last accepted average does not become a claimed live input during a missing window');
    assert.equal(chart.series.indoor_temperature[0].y, 23);
  }
});

test('a narrow zoom keeps the Average indoor segment between saved endpoints and preserves missing windows', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  put(store, start + 15 * MINUTE, sample(0, 15, [segment(0, 15)], { indoorC: 20 }), 'mqtt');
  put(store, start + 30 * MINUTE, sample(15, 30, [segment(15, 30)], { indoorC: 23 }), 'mqtt');
  put(store, start + 45 * MINUTE, sample(30, 45, [segment(30, 45)], { indoorC: null, quality: ['missing'] }), 'mqtt');
  const args = { store, input: 'mqtt', now: start + 60 * MINUTE, startDate: '2026-09-08' };
  const zoom = getChartData({ ...args, viewFrom: start + 20 * MINUTE, viewTo: start + 25 * MINUTE });
  assert.deepEqual(zoom.series.model_indoor_temperature.map(row => [row.x, row.y]),
    [[start + 20 * MINUTE, 21], [start + 25 * MINUTE, 22]]);
  assert(zoom.series.model_indoor_temperature.every(row => row.displayBoundary && row.interpolated
    && row.observedAt === start + 15 * MINUTE && row.nextObservedAt === start + 30 * MINUTE));
  const missing = getChartData({ ...args, viewFrom: start + 35 * MINUTE, viewTo: start + 40 * MINUTE });
  assert(missing.series.model_indoor_temperature.every(row => row.y === null));
  const future = getChartData({ ...args, now: start + 27 * MINUTE,
    viewFrom: start + 20 * MINUTE, viewTo: start + 25 * MINUTE });
  assert.deepEqual(future.series.model_indoor_temperature, [], 'An endpoint recorded after now cannot supply a display segment');
});

test('DHWR left axis ends each request at its expiry and merges overlapping pulses', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const minute of [0, 5, 60]) store.observation({ source: 'controller', device: 'providers',
    signal: 'dhwr_request', value: 1, unit: 'state', sourceTime: start + minute * MINUTE,
    receivedAt: start + minute * MINUTE, quality: ['requested'], raw: { expiresAt: start + (minute + 10) * MINUTE } });
  const chart = getChartData({ store, input: 'providers', now: start + 90 * MINUTE,
    startDate: '2026-09-08', left: 'dhwr_request', points: 2000 });
  const pulses = chart.series.dhwr_request;
  assert(pulses.some(row => row.x === start + 15 * MINUTE && row.y === null));
  assert(pulses.some(row => row.x === start + 70 * MINUTE && row.y === null));
  assert(!pulses.some(row => row.y === null && row.x < start + 15 * MINUTE));
});

test('right-axis data cannot hide missing or hidden left-axis values and states use meaningful labels', () => {
  const series = { indoor_temperature: [{ x: start, y: 21 }] };
  assert.match(leftAxisAvailability(historyDatasets(series, 'model_compressor_duty')), /No recorded values/);
  series.model_compressor_duty = [{ x: start, y: 0 }];
  assert.equal(leftAxisAvailability(historyDatasets(series, 'model_compressor_duty')), '');
  assert.match(leftAxisAvailability(historyDatasets(series, 'model_compressor_duty', { model_compressor_duty: false })), /hidden in the legend/);
  assert.equal(historyStateLabel('model_controller_phase', 2), 'Tariff reduction');
  assert.equal(historyStateLabel('operating_mode', 2), 'Compressor only');
});
