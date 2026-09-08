import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Envelope, getChartData } from '../src/app/chart-data.js';
import { addModelInputs } from '../src/app/chart-model-inputs.js';
import { MODEL_INPUT_INFO } from '../src/domain/history-series.js';
import { historyDatasets, leftAxisAvailability, historyStateLabel } from '../chart/history-model.js';

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
