import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { isRecordedDataset, pruneRetiredDatasets } from '../src/storage/recorded-datasets.js';
import { getChartData } from '../src/app/chart-data.js';

const now = Date.parse('2026-09-14T10:00:00Z');
const retired = ['caravan_power', 'caravan_current', 'caravan_active', 'heat_savings_active',
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

test('cleanup removes obsolete telemetry, coverage and caches while preserving hourly energy and learning history', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const row of [...retired.map(signal => observation(signal)), observation('indoor_temperature', 'husdata-h66')]) {
    const id = store.observation(row), key = JSON.stringify([row.source, row.device, row.signal]);
    store.db.prepare(`INSERT INTO recorder_coverage(source,device,signal,status,start_at,end_at,source_time,observation_id,samples)
      VALUES(?,?,?,'fresh',?,?,?,?,1)`).run(row.source, row.device, row.signal, now, now, now, id);
    store.setState(`recorder:signal:${key}`, { ...row, key });
    store.db.prepare('INSERT INTO recorder_metrics VALUES(?,?,1,1,100,0,0,0,0,0)').run(key, now);
  }
  const orphanKey = JSON.stringify(['shelly-mqtt', 'synthetic-orphan', 'caravan_power']);
  store.setState(`recorder:signal:${orphanKey}`, { ...observation('caravan_power'), key: orphanKey });
  store.setState('shelly:equipment-energy:v1:garage_heat_pump', { previous: null });
  const keepId = store.observation(observation('caravan_energy'));
  const payload = JSON.stringify({ frozen: true, source: 'husdata-h66', signal: 'indoor_temperature' });
  store.appendLearningJournal('mqtt', { key: 'synthetic-journal', kind: 'sample', at: now,
    algorithmVersion: 'synthetic-archive', payload: JSON.parse(payload) });
  const result = pruneRetiredDatasets(store);
  assert.equal(result.observations, retired.length + 1);
  assert.equal(result.coverage, retired.length + 1);
  assert.equal(result.metrics, retired.length + 1);
  assert.deepEqual(store.db.prepare('SELECT id FROM observations').all().map(row => row.id), [keepId]);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM recorder_coverage').get().n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM state WHERE key LIKE 'recorder:signal:%'").get().n, 0);
  assert.equal(store.db.prepare('SELECT payload FROM learning_journal').get().payload, payload);
  assert.equal(store.getState('shelly:equipment-energy:v1:garage_heat_pump'), null);
  assert.deepEqual(pruneRetiredDatasets(store), { observations: 0, coverage: 0, metrics: 0, states: 0 });
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('chart API rejects retired equipment axes instead of returning hidden datasets', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const signal of retired) {
    store.observation(observation(signal));
    assert.throws(() => getChartData({ store, input: 'mqtt', now, left: signal }), /Unknown left axis/);
  }
});

test('cleanup removes orphaned retired metric keys even without any observations or recorder state', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const retiredKey = JSON.stringify(['shelly-mqtt', 'orphaned-device', 'caravan_power']);
  const keepKey = JSON.stringify(['shelly-mqtt', 'orphaned-device', 'caravan_energy']);
  for (const key of [retiredKey, keepKey]) store.db.prepare('INSERT INTO recorder_metrics VALUES(?,?,1,1,100,0,0,0,0,0)').run(key, now);
  const result = pruneRetiredDatasets(store);
  assert.equal(result.metrics, 1);
  assert.deepEqual(store.db.prepare('SELECT key FROM recorder_metrics').all().map(row => row.key), [keepKey]);
});

test('cleanup preserves complete imported observations and raw rows byte-for-byte alongside live retired streams', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const importId = Number(store.db.prepare(`INSERT INTO imports(kind,sha256,path,status,started_at,completed_at,row_count)
    VALUES('synthetic','synthetic-import','/synthetic/archive.csv','complete',?,?,1)`).run(now, now).lastInsertRowid);
  const raw = '{"preserved":"original import bytes"}';
  store.db.prepare('INSERT INTO import_rows VALUES(?,?,?,?,?)').run(importId, 1, now, raw, '[]');
  const row = observation('indoor_temperature', 'husdata-h66');
  const imported = store.observation({ ...row, provenance: { importId, rowNumber: 1 }, raw: { original: true } });
  store.observation(row);
  const before = store.db.prepare('SELECT * FROM observations WHERE id=?').get(imported);
  pruneRetiredDatasets(store);
  assert.deepEqual(store.db.prepare('SELECT * FROM observations WHERE id=?').get(imported), before);
  assert.equal(store.db.prepare('SELECT raw FROM import_rows WHERE import_id=?').get(importId).raw, raw);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 1);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
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
