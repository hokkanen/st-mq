import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';

const HOUR = 3_600_000, DAY = 24 * HOUR, at = Date.parse('2026-10-13T08:00:00Z');
function fixture(t, path = ':memory:') {
  const store = new Store(path); t.after(() => store.close());
  let now = at;
  const recorder = new Recorder(store, { clock: () => now });
  return { store, recorder, advance: value => { now = value; },
    put(value, time, force = false) {
      now = time;
      return recorder.record({ source: 'synthetic', device: 'fixture', signal: 'supply_temperature',
        value, unit: 'degC', sourceTime: time, receivedAt: time, quality: [] }, { force });
    } };
}
const totals = store => store.db.prepare(`SELECT COALESCE(sum(polls),0) polls, COALESCE(sum(records),0) records,
  COALESCE(sum(bytes),0) bytes, COALESCE(sum(error_time),0) error_time,
  COALESCE(sum(error_squared_time),0) error_squared_time FROM recorder_metrics`).get();
const row = (store, key, time = at) => store.db.prepare('SELECT * FROM recorder_metrics WHERE key=? AND bucket=?')
  .get(key, Math.floor(time / HOUR) * HOUR);
const state = (key = 'fixture-counter', status = 'fresh') => ({ key, status });
const count = (store, recorder, time, options = {}, counter = state()) =>
  store.transaction(() => recorder.count(counter, time, options));

test('unchanged acquisition bursts keep exact live totals without per-poll metric journal changes', t => {
  const { store, recorder, put } = fixture(t);
  put(20, at);
  const boundary = store.checkpoint().sequence;
  for (let i = 1; i <= 200; i++) assert.equal(put(20, at + i * 100).saved, false);
  assert.equal(totals(store).polls, 1);
  assert.equal(store.db.prepare("SELECT count(*) n FROM journal_changes WHERE table_name='recorder_metrics' AND sequence>?")
    .get(boundary).n, 0);
  const before = store.checkpoint(), pending = structuredClone(recorder.pendingMetrics);
  const parameter = recorder.status(at + 20_000).parameters.find(item => item.signal === 'supply_temperature');
  assert.equal(parameter.hour.polls, 201);
  assert.equal(parameter.hour.records, 1);
  assert.deepEqual(store.checkpoint(), before, 'Status reads never flush storage');
  assert.deepEqual(recorder.pendingMetrics, pending);
  recorder.flush(at + 20_000, { force: true });
  assert.equal(totals(store).polls, 201);
  assert.equal(recorder.pendingMetrics.size, 0);
  assert.equal(store.observations().length, 1);
});

test('selected observations commit counters, bytes and timestamp extrema immediately with accumulated diagnostics', t => {
  const { store, recorder, put } = fixture(t);
  put(20, at); put(20, at + 1000); put(20, at + 2000);
  const initial = totals(store);
  assert.equal(put(25, at + 3000, true).saved, true);
  const saved = totals(store), metrics = store.db.prepare('SELECT * FROM recorder_metrics').get();
  assert.equal(saved.polls, 4); assert.equal(saved.records, 2); assert(saved.bytes > initial.bytes);
  assert.equal(metrics.first_saved_at, at); assert.equal(metrics.last_saved_at, at + 3000);
  assert(saved.error_time > 0); assert.equal(recorder.pendingMetrics.size, 0);
  assert.equal(store.observations().length, 2);
});

test('a failed selected observation restores both pending diagnostics and durable adaptive accounting', t => {
  const { store, recorder, put } = fixture(t);
  put(20, at); put(20, at + 1000);
  const before = totals(store), pending = structuredClone(recorder.pendingMetrics);
  const budget = recorder.adaptiveBudgetState();
  assert(budget, 'The observation has durable adaptive accounting');
  assert.throws(() => store.transaction(() => { put(25, at + 2000, true); throw Error('synthetic rollback'); }), /synthetic rollback/);
  assert.deepEqual(totals(store), before); assert.deepEqual(recorder.pendingMetrics, pending);
  assert.deepEqual(recorder.adaptiveBudgetState(), budget); assert.equal(store.observations().length, 1);
  put(25, at + 2000, true);
  assert.equal(totals(store).polls, 3); assert.equal(totals(store).records, 2);
});

test('caught savepoint failures restore only the nested diagnostic delta', t => {
  const { store, recorder } = fixture(t);
  count(store, recorder, at);
  store.transaction(() => {
    recorder.count(state(), at + 1000);
    assert.throws(() => store.transaction(() => {
      recorder.count(state('fixture-counter', 'failed'), at + 2000, { error: 2, elapsed: 1000 });
      recorder.flushMetrics(at + 2000, { force: true }); throw Error('nested rollback');
    }), /nested rollback/);
    recorder.count(state(), at + 3000);
  });
  store.transaction(() => recorder.flushMetrics(at + 3000, { force: true }));
  const saved = row(store, 'fixture-counter');
  assert.equal(saved.polls, 3); assert.equal(saved.failed, 0); assert.equal(saved.error_time, 0);
});

test('COMMIT failure restores buffered metrics and successful retry counts them exactly once', t => {
  const { store, recorder } = fixture(t);
  count(store, recorder, at); count(store, recorder, at + 1000, { error: 2, elapsed: 1000 });
  const pending = structuredClone(recorder.pendingMetrics), exec = store.db.exec.bind(store.db);
  store.db.exec = sql => { if (sql === 'COMMIT') throw Error('synthetic COMMIT failure'); return exec(sql); };
  assert.throws(() => store.transaction(() => recorder.flushMetrics(at + 1000, { force: true })), /synthetic COMMIT failure/);
  store.db.exec = exec;
  assert.deepEqual(recorder.pendingMetrics, pending); assert.equal(totals(store).polls, 1);
  store.transaction(() => recorder.flushMetrics(at + 1000, { force: true }));
  store.transaction(() => recorder.flushMetrics(at + 1000, { force: true }));
  assert.equal(totals(store).polls, 2); assert.equal(totals(store).error_time, 1000);
  assert.equal(totals(store).error_squared_time, 4000);
});

test('post-COMMIT consumer failure does not retry an already persisted diagnostic batch', t => {
  const { store, recorder } = fixture(t);
  count(store, recorder, at); count(store, recorder, at + 1000);
  assert.throws(() => store.transaction(() => {
    recorder.flushMetrics(at + 1000, { force: true });
    store.afterCommit(() => { throw Error('synthetic consumer failure'); });
  }), { code: 'STORAGE_COMMIT_EFFECT_FAILED', committed: true });
  assert.equal(recorder.pendingMetrics.size, 0); assert.equal(totals(store).polls, 2);
  store.transaction(() => recorder.flushMetrics(at + 1000, { force: true }));
  assert.equal(totals(store).polls, 2);
});

test('cadence and routine flush retain original hour buckets including a quiet previous-hour tail', t => {
  const { store, recorder } = fixture(t), end = at + HOUR;
  count(store, recorder, end - 1000); count(store, recorder, end - 500);
  count(store, recorder, end + 100);
  assert.equal(row(store, 'fixture-counter', end).polls, 1);
  assert.equal(row(store, 'fixture-counter', end - 1).polls, 1);
  store.transaction(() => recorder.flushMetrics(end + 100));
  assert.equal(row(store, 'fixture-counter', end - 1).polls, 2);
  count(store, recorder, end + 1000); count(store, recorder, end + 30_999);
  assert.equal(row(store, 'fixture-counter', end).polls, 1);
  count(store, recorder, end + 31_000);
  assert.equal(row(store, 'fixture-counter', end).polls, 4);
});

test('pending diagnostics cannot leak future receipts into an earlier status request', t => {
  const { store, recorder, put } = fixture(t);
  put(20, at); put(20, at + 1000); put(20, at + 2000);
  assert.equal(recorder.status(at + 500).parameters[0].hour.polls, 1);
  assert.equal(recorder.status(at + 2000).parameters[0].hour.polls, 3);
  assert.equal(totals(store).polls, 1);
});

test('bounded pending buckets and long suspension never resurrect expired metrics', t => {
  const { store, recorder } = fixture(t);
  for (let i = 0; i < 258; i++) {
    count(store, recorder, at, {}, state(`fixture-${i}`));
    count(store, recorder, at + 1000, {}, state(`fixture-${i}`));
  }
  assert.equal(recorder.pendingMetrics.size, 256);
  store.transaction(() => {
    store.db.prepare('DELETE FROM recorder_metrics').run();
    // Fill one more bucket after a long suspension: cap eviction must discard
    // its expired oldest delta rather than bringing a pruned SQL row back.
    recorder.count(state('new-fixture'), at + 9 * DAY);
    recorder.count(state('new-fixture'), at + 9 * DAY + 1000);
  });
  assert.equal(store.db.prepare('SELECT count(*) n FROM recorder_metrics WHERE bucket<?').get(at + 2 * DAY).n, 0);
  store.transaction(() => recorder.flushMetrics(at + 9 * DAY + 1000, { force: true }));
  assert.equal(recorder.pendingMetrics.size, 0);
  assert.equal(totals(store).polls, 2);
});

test('restart loses only unsaved optional poll totals while saved records and source continuity remain durable', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-counter-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'history.db'), first = new Store(path);
  const recorder = new Recorder(first, { clock: () => at + 1000 });
  const observation = time => ({ source: 'synthetic', device: 'fixture', signal: 'supply_temperature',
    value: 20, unit: 'degC', sourceTime: time, receivedAt: time, quality: [] });
  recorder.record(observation(at)); recorder.record(observation(at + 1000));
  const latest = recorder.latestCommitted('supply_temperature'), budget = recorder.adaptiveBudgetState();
  first.close();
  const reopened = new Store(path); t.after(() => reopened.close());
  const restarted = new Recorder(reopened, { clock: () => at + 1000 });
  assert.equal(totals(reopened).polls, 1); assert.equal(totals(reopened).records, 1);
  assert.deepEqual(restarted.latestCommitted('supply_temperature'), latest);
  assert.deepEqual(restarted.adaptiveBudgetState(), budget);
  assert.equal(reopened.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
