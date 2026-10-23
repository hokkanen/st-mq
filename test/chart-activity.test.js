import { garageIntent } from './helpers/garage-intent.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { ActivityEnvelope } from '../src/app/chart-activity.js';
import { getChartData } from '../src/app/chart-data.js';
import { LEARNING_ALGORITHM } from '../src/app/committed-learning.js';
import { EXPLORER_SERIES, explorerActivityTrack } from '../chart/series-explorer.js';
import { activityIntervals } from '../chart/chart-overlays.js';
import { currentHomeSample } from './helpers/home-learning-fixture.js';
import { ChargingAllowanceHistory } from '../src/charging/allowance-history.js';

const start = Date.parse('2026-10-05T00:00:00+03:00'), MINUTE = 60_000;
const query = (store, left, extra = {}) => getChartData({ store, input: 'simulated', left,
  startDate: '2026-10-05', endDate: '2026-10-05', now: start + 10 * MINUTE, points: 100, ...extra });
const duration = rows => rows.reduce((sum, row) => sum + (row.end - row.start) * (row.aggregated ? row.fraction : 1), 0);
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test('continuous confirmations coalesce to one full-height interval at every resolution', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (let i = 0; i < 600; i++) {
    const at = start + i * 1000;
    store.observation({ source: 'controller', device: 'simulated', signal: 'controller_phase',
      value: 0, unit: 'state', sourceTime: at, receivedAt: at, quality: ['requested'], raw: { expiresAt: at + 1000 } });
  }
  const before = store.db.prepare('SELECT total_changes() n').get().n;
  for (const points of [100, 800, 2000]) {
    const chart = query(store, 'controller_phase', { points });
    assert.deepEqual(activityIntervals(explorerActivityTrack('controller_phase'), chart),
      [{ start, end: start + 10 * MINUTE, value: 0 }]);
  }
  const zoom = query(store, 'controller_phase', { viewFrom: start + MINUTE, viewTo: start + 2 * MINUTE });
  assert.deepEqual(zoom.shading.controller_phase, [{ start: start + MINUTE, end: start + 2 * MINUTE, value: 0 }]);
  assert.equal(store.db.prepare('SELECT total_changes() n').get().n, before, 'Chart projection performs no writes');
});

for (const [signal, value] of [['garage_native_power', 1], ['caravan_dehumidifier_state', 2],
  ['dhwr_active', 0], ['floor_groundfloor_1_active', 0]]) {
  test(`${signal}: dense brief gaps retain recorded coverage instead of expanding into blank history`, t => {
    const store = new Store(':memory:'); t.after(() => store.close());
    const recorder = new Recorder(store);
    for (let i = 0; i < 600; i++) {
      const at = start + i * 1000;
      for (const [time, reading, quality] of [[at, value, ['simulated']], [at + 999, null, ['missing', 'simulated']]])
        recorder.record({ source: 'simulation', device: 'invented-activity', signal, value: reading,
          unit: 'state', sourceTime: time, receivedAt: time, quality, raw: { reportIntervalMs: 2000 } });
    }
    recorder.flush(start + 600_000, { force: true });
    const chart = query(store, signal), rows = chart.shading[signal];
    assert(rows.some(row => row.aggregated));
    near(duration(rows), 600 * 999);
    assert(rows.every(row => row.value === value), 'Valid zero remains a state, never missing');
    assert(rows.length <= 100, 'Response size is independent of source boundary count');
    const zoom = query(store, signal, { viewFrom: start + 100_000, viewTo: start + 110_000 });
    near(duration(zoom.shading[signal]), 10 * 999);
    assert(zoom.shading[signal].every(row => !row.aggregated));
  });
}

test('every state/code catalogue entry supplies its own authoritative bar intervals', t => {
  const states = EXPLORER_SERIES.filter(row => ['state', 'code'].includes(row.unit));
  assert.equal(states.length, 26, 'Review newly added state writers alongside the catalogue coverage');
  for (const row of states) {
    const store = new Store(':memory:');
    try {
      if (row.signal.startsWith('model_')) {
        store.appendLearningJournal('simulated', { kind: 'sample', at: start + MINUTE, algorithmVersion: LEARNING_ALGORITHM,
          payload: { value: currentHomeSample({ timestamp: start + MINUTE, windowStart: start, indoorC: 21,
            quality: [], phase: 'normal', floorOverrideMode: 'off', outdoorC: 5,
            thermalCompressorDuty: 0, thermalAuxKw: 0 }) } });
      } else if (row.signal==='garage_away_mode') {
        garageIntent(store,start,{input:'simulated',mode:'normal'});
      } else for (const at of [start, start + MINUTE]) {
        store.observation({ source: ['controller_phase', 'dhwr_request'].includes(row.signal) ? 'controller' : 'simulation',
          device: 'simulated', signal: row.signal, unit: row.unit, value: row.signal === 'dhwr_request' ? 1 : 0,
          sourceTime: at, receivedAt: at, quality: ['simulated'], raw: { expiresAt: start + 2 * MINUTE,
            maxAgeMs: 2 * MINUTE, eventOnly: row.signal.includes('door') } });
      }
      const chart = query(store, row.requestKey, { now: start + MINUTE });
      const intervals = activityIntervals(explorerActivityTrack(row.key), chart);
      assert(Object.hasOwn(chart.shading, row.signal), row.key);
      near(duration(intervals), MINUTE);
    } finally { store.close(); }
  }
});

test('dense summaries preserve each category, ties and actual outages without averaging state codes', () => {
  const envelope = new ActivityEnvelope({ from: 0, to: 10_000 }, 100);
  for (let i = 0; i < 1000; i++) {
    if (i >= 400 && i < 500) continue;
    envelope.add(i * 10, (i + 1) * 10, i % 2, i % 2 ? { phases: [1, 2] } : undefined);
  }
  const rows = envelope.values();
  near(duration(rows.filter(row => row.value === 0)), 4500);
  near(duration(rows.filter(row => row.value === 1)), 4500);
  assert(rows.filter(row => row.value === 1).every(row => row.phases.join(',') === '1,2'));
  assert(!rows.some(row => row.start >= 4000 && row.start < 5000));
});

test('point reports and arbitrary alarm codes stay bounded without acquiring known time', () => {
  const points = new ActivityEnvelope({ from: 0, to: 10_000 }, 100);
  for (let i = 0; i < 10_000; i++) points.point(i, i % 2);
  assert(points.values().length <= 100);
  assert(points.values().every(row => row.pointOnly && row.start === row.end));
  const codes = new ActivityEnvelope({ from: 0, to: 10_000 }, 100);
  for (let i = 0; i < 10_000; i++) codes.add(i, i + 1, i);
  near(duration(codes.values()), 10_000);
  assert(codes.values().some(row => row.mixed));
  assert(codes.values().length <= 3300);
});

test('source expiry and invalid final readings retain real missing periods and original request boundaries', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store);
  for (const [offset, value, quality] of [[0, 0, []], [4 * MINUTE, 1, ['unknown']]])
    recorder.record({ source: 'simulation', device: 'invented-expiry', signal: 'garage_native_power', value,
      unit: 'state', sourceTime: start + offset, receivedAt: start + offset, quality, raw: { reportIntervalMs: MINUTE } });
  const chart = query(store, 'garage_native_power');
  assert.deepEqual(chart.shading.garage_native_power, [{ start, end: start + MINUTE, value: 0 }]);
});

test('unqualified reports from different devices do not invent continuity between source identities', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const [offset, device] of [[0, 'invented-first'], [MINUTE, 'invented-replacement']])
    store.observation({ source: 'simulation', device, signal: 'caravan_dehumidifier_state', value: 2, unit: 'state',
      sourceTime: start + offset, receivedAt: start + offset, quality: ['simulated'] });
  const rows = query(store, 'caravan_dehumidifier_state').shading.caravan_dehumidifier_state;
  assert.equal(duration(rows), 0);
  assert(rows.every(row => row.pointOnly));
});

test('allowance bars retain the entire dense period in the same read as bounded numeric detail', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const history = new ChargingAllowanceHistory({ store, input: 'simulated' });
  for (let i = 0; i <= 600; i++) {
    const at = start + i * 1000;
    history.observe({ chargerId: 'charger2', association: 'b'.repeat(64), status: {
      mode: 'limited', allowanceA: 12, maximumCurrentA: 16, reportedAllowanceA: null,
      reason: i % 2 ? 'fuse-limit' : 'priority-allocation', source: 'st-mq-load-balancing',
      measuredAt: at, receivedAt: at, sourceTimes: [], sourceEpoch: null, limiter: null,
    } }, at);
  }
  history.flush();
  let reads = 0;
  const db = new Proxy(store.db, { get(target, key) {
    if (key === 'prepare') return sql => {
      if (sql.includes('FROM recorder_coverage c') && sql.includes('c.source=?')) reads++;
      return target.prepare(sql);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const chart = query({ db }, undefined, { view: 'charging_currents' });
  const rows = chart.shading.charger2Allowance;
  near(duration(rows.filter(row => row.value === 3)), 300_000);
  near(duration(rows.filter(row => row.value === 4)), 300_000);
  assert.equal(reads, 2, 'Each charger history is queried once, with no second bar scan');
  assert.equal(chart.meta.chargingAllowances.charger2.truncated, true, 'The numeric detail budget remains separate');
});
