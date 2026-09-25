import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { getChartData, chartRange } from '../src/app/chart-data.js';
import { createCaravanEnergy } from '../src/acquisition/shelly-energy.js';

const HOUR = 3_600_000, date = '2026-09-11';
const start = chartRange({ startDate: date, now: Date.parse('2026-09-11T12:00:00Z') }).from;
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store);
  const put = (value, at) => recorder.record({ source: 'mqtt-equipment', device: 'garage_door1', signal: 'garage_door1_open',
    value, unit: 'state', sourceTime: at, receivedAt: at, quality: [], raw: { eventOnly: true, timeBasis: 'mqtt-live-status' } });
  const query = (extra = {}) => getChartData({ store, input: 'mqtt', startDate: date, endDate: date,
    now: start + 20 * HOUR, left: 'garage_door1_open', ...extra });
  return { store, recorder, put, query };
}

test('a quiet door seeds historical and detail charts with its original report time without inventing an age outage', t => {
  const { put, query, recorder } = fixture(t);
  const reported = start - 48 * HOUR; put(0, reported);
  for (const extra of [{}, { viewFrom: start + 2 * HOUR, viewTo: start + 10 * HOUR }]) {
    const result = query(extra), points = result.series.garage_door1_open;
    assert(points.length >= 2);
    assert(points.every(point => point.y === 0));
    assert(points.every(point => point.observedAt === reported));
    assert.equal(points[0].x, extra.viewFrom ?? start);
    assert.equal(points.at(-1).x, extra.viewTo ?? start + 20 * HOUR);
  }
  const row = recorder.status(start + 20 * HOUR).exactParameters.find(row => row.signal === 'garage_door1_open');
  assert.equal(row.freshness.status, 'last-reported');
  assert.equal(row.freshness.ageBasis, 'event-only');
  assert.equal(row.freshness.maxAgeMs, null);
});

test('door transitions remain discrete and explicit acquisition failures interrupt last-reported history', t => {
  const { put, query, recorder } = fixture(t);
  put(0, start - 24 * HOUR); put(1, start + HOUR); put(0, start + 8 * HOUR);
  recorder.recordFailure({ source: 'mqtt-equipment', device: 'garage_door1', signal: 'garage_door1_open', unit: 'state',
    at: start + 10 * HOUR, quality: ['mqtt-disconnected'] });
  const rows = query().series.garage_door1_open;
  assert(rows.some(point => point.x === start + HOUR && point.y === 1));
  assert(rows.some(point => point.x === start + 8 * HOUR && point.y === 0));
  assert(!rows.some(point => point.x > start + HOUR && point.x < start + 8 * HOUR && point.y === null));
  assert(rows.some(point => point.x === start + 10 * HOUR && point.y === null));
  assert(rows.filter(point => point.x >= start + 10 * HOUR).every(point => point.y === null));
});

test('cached door recovery preserves its source clock and the historical outage', t => {
  const { put, query, recorder } = fixture(t);
  const observedAt = start - 48 * HOUR, failedAt = start + HOUR, recoveredAt = start + 2 * HOUR;
  put(0, observedAt);
  recorder.recordFailure({ source: 'mqtt-equipment', device: 'garage_door1', signal: 'garage_door1_open', unit: 'state',
    at: failedAt, quality: ['bridge-offline'] });
  recorder.record({ source: 'mqtt-equipment', device: 'garage_door1', signal: 'garage_door1_open', value: 0,
    unit: 'state', sourceTime: observedAt, receivedAt: recoveredAt, quality: [],
    raw: { eventOnly: true, availabilityConfirmed: true, confirmedAt: recoveredAt, timeBasis: 'mqtt-live-status' } });
  for (const extra of [{}, { viewFrom: start, viewTo: start + 3 * HOUR },
    { viewFrom: start + 8 * HOUR, viewTo: start + 10 * HOUR }]) {
    const rows = query(extra).series.garage_door1_open;
    assert(rows.filter(point => point.x >= recoveredAt).every(point => point.y === 0 && point.observedAt === observedAt));
    if (!extra.viewFrom || extra.viewFrom < failedAt) {
      assert(rows.some(point => point.x === failedAt && point.y === null));
      assert(!rows.some(point => point.x >= failedAt && point.x < recoveredAt && point.y !== null));
      assert(rows.some(point => point.x === recoveredAt && point.y === 0 && point.observedAt === observedAt));
    }
  }
});

test('Caravan adaptive energy plots native and explicitly mapped MQTT meter intervals with coverage', t => {
  for (const source of ['shelly-mqtt', 'mqtt-equipment']) {
    const store = new Store(':memory:'); t.after(() => store.close());
    const recorder = new Recorder(store);
    const counter = createCaravanEnergy({ store, recorder, device: 'fixture-meter', source, signal: 'caravan_energy',
      recordDevice: 'caravan', stateKey: 'fixture-adaptive', maxGapMs: 120_000 });
    counter.receive(10, start + HOUR - 30_000); counter.receive(10.02, start + HOUR + 30_000);
    for (const view of [{}, { viewFrom: start + HOUR - 10_000, viewTo: start + HOUR + 10_000 }]) {
      const result = getChartData({ store, input: 'mqtt', startDate: date, endDate: date, now: start + 2 * HOUR,
        left: 'caravan_energy', ...view });
      const points = result.series.caravan_energy.filter(point => Number.isFinite(point.y));
      assert.equal(points.length, view.viewTo ? 0 : 1, 'One marker at the actual interval endpoint; a clipped viewport cannot invent another energy point');
      assert(points.every(point => Math.abs(point.y - 0.02) < 1e-9));
      assert(points.every(point => point.intervalStart === start + HOUR - 30_000 && point.intervalEnd === start + HOUR + 30_000));
      assert(points.every(point => point.basis === 'meter-counter-delta' && point.learningRole === 'history-only'));
      assert(!result.series.property_power, 'Caravan demand does not become property power');
    }
  }
});
