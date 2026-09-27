import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { isRecordedDataset } from '../src/storage/recorded-datasets.js';
import { getChartData } from '../src/app/chart-data.js';

const now = Date.parse('2026-09-14T10:00:00Z');
const retired = ['caravan_power', 'caravan_current', 'caravan_active', 'garage_power', 'garage_external_temperature',
  'garage_relay_active', 'garage_temperature_ha', 'garage_heat_pump_temperature', 'garage_heat_pump_energy'];
const observation = (signal, source = 'shelly-mqtt') => ({ source, device: 'synthetic-device', signal,
  value: 21, unit: 'degC', sourceTime: now, receivedAt: now, quality: [], raw: {} });

test('retired equipment datasets cannot create observations, coverage or recorder parameters', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => now });
  for (const row of [...retired.map(signal => observation(signal)), observation('indoor_temperature', 'husdata-h66')]) {
    assert.equal(isRecordedDataset(row), false);
    assert.equal(recorder.record(row).reason, 'not-in-recorded-dataset');
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM recorder_coverage').get().n, 0);
  assert.equal(recorder.status(now).parameters.length, 0);
  assert.equal(recorder.record(observation('caravan_energy')).saved, true);
  assert.equal(recorder.record(observation('indoor_temperature', 'mqtt-temperature')).saved, true);
});

test('chart API rejects unsupported equipment axes and never uses live caravan watts as recorded power', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const signal of retired) {
    store.observation(observation(signal));
    if (signal === 'caravan_power') {
      assert.deepEqual(getChartData({ store, input: 'mqtt', now, left: signal }).series.caravan_power, [],
        'The supported interval-average projection requires meter energy, not old/live watts observations');
    } else assert.throws(() => getChartData({ store, input: 'mqtt', now, left: signal }), /Unknown left axis/);
  }
});

test('both garage probes stop at their recorded two-minute deadline in chart coverage', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => now });
  for (const [signal, value] of [['garage_temperature', 11], ['garage_temperature_2', 12]]) recorder.record({
    source: 'shelly-mqtt', device: 'garage', signal, value, unit: 'degC', sourceTime: now, receivedAt: now,
    quality: [], raw: { reportIntervalMs: 30_000, reportGraceMs: 90_000, timeBasis: 'mqtt-live-status' },
  });
  const chart = getChartData({ store, input: 'mqtt', now: now + 600_000, startDate: '2026-09-14', endDate: '2026-09-14', left: 'garage_temperature_2' });
  for (const [signal, value] of [['garage_temperature', 11], ['garage_temperature_2', 12]]) {
    const points = chart.series[signal];
    assert(points.some(point => point.y === value), `${signal} remains plottable`);
    assert(points.some(point => point.x === now + 120_000 && point.y === null), `${signal} has an exact expiry gap`);
    assert(!points.some(point => point.x >= now + 120_000 && point.y !== null), `${signal} cannot hold stale values`);
  }
});
