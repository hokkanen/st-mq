import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';

const at = Date.parse('2026-10-17T00:00:00Z');
const observation = (signal, time, value = 20, extra = {}) => ({ source: 'husdata-h66', device: 'fixture',
  signal, value, unit: 'degC', sourceTime: time, receivedAt: time, quality: [], ...extra });
function fixture(t, path = ':memory:') {
  const store = new Store(path), recorder = new Recorder(store, { clock: () => at });
  t.after(() => store.close());
  return { store, recorder, put: (time, value = 20, signal = 'supply_temperature', extra = {}) =>
    recorder.record(observation(signal, time, value, extra)) };
}
const coverage = store => store.db.prepare('SELECT signal,start_at,end_at,source_time,samples,status FROM recorder_coverage ORDER BY id').all();

test('unchanged streams share a flush and retain exact endpoints and poll totals', t => {
  const { store, recorder, put } = fixture(t);
  for (const signal of ['supply_temperature', 'return_temperature']) put(at, 20, signal);
  const before = store.checkpoint();
  for (let index = 1; index <= 20; index++) for (const signal of ['supply_temperature', 'return_temperature'])
    assert.equal(put(at + index * 100, 20, signal).saved, false);
  assert.deepEqual(store.checkpoint(), before, 'Unchanged receipts create no durable transaction by themselves');
  assert.deepEqual(coverage(store).map(row => row.samples), [1, 1]);
  recorder.flush(at + 31_000);
  assert.equal(store.checkpoint().sequence, before.sequence + 1);
  assert.deepEqual(coverage(store).map(row => [row.end_at, row.source_time, row.samples]),
    [[at + 2000, at + 2000, 21], [at + 2000, at + 2000, 21]], 'Flush time never becomes a source clock');
  assert.equal(store.db.prepare('SELECT sum(polls) n FROM recorder_metrics').get().n, 42);
  assert.equal(store.db.prepare('SELECT count(*) n FROM observations').get().n, 2);
  assert.equal(recorder.pendingSignals.size, 0);
});

for (const transition of ['value', 'unavailable', 'force', 'gap']) test(`${transition} flushes prior unchanged metadata before its boundary`, t => {
  const { store, recorder, put } = fixture(t);
  put(at); put(at + 1000); put(at + 2000);
  if (transition === 'force') recorder.record(observation('supply_temperature', at + 3000), { force: true });
  else if (transition === 'unavailable') put(at + 3000, null, 'supply_temperature', { sourceTime: null, quality: ['missing'] });
  else put(at + (transition === 'gap' ? 600_000 : 3000), transition === 'value' ? 30 : 20);
  const rows = coverage(store);
  assert.equal(rows[0].end_at, at + 2000);
  assert.equal(rows[0].samples, 3);
  assert.equal(rows.length, 2);
  assert.equal(recorder.pendingSignals.size, 0);
  if (transition === 'unavailable') assert.equal(rows[1].status, 'unavailable');
  if (transition === 'gap') assert.equal(rows[1].start_at, at + 600_000);
});

test('a rolled-back receipt cannot change the next metadata endpoint or counter', t => {
  const { store, recorder, put } = fixture(t);
  put(at); put(at + 1000);
  const prior = structuredClone(recorder.pendingSignals), metrics = structuredClone(recorder.pendingMetrics);
  assert.throws(() => store.transaction(() => { put(at + 2000); throw Error('fixture rollback'); }));
  assert.deepEqual(recorder.pendingSignals, prior);
  assert.deepEqual(recorder.pendingMetrics, metrics);
  recorder.flush(at + 3000, { force: true });
  assert.equal(coverage(store)[0].end_at, at + 1000);
  assert.equal(coverage(store)[0].samples, 2);
  assert.equal(store.db.prepare('SELECT sum(polls) n FROM recorder_metrics').get().n, 2);
});

test('one quiet-period timer flushes unchanged endpoints and is cancelled by Store shutdown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new Store(':memory:'); t.after(() => store.close());
  let clock = at;
  const recorder = new Recorder(store, { clock: () => clock });
  recorder.record(observation('supply_temperature', at));
  clock += 1000; recorder.record(observation('supply_temperature', clock));
  assert.equal(coverage(store)[0].samples, 1);
  clock += 30_000; t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(coverage(store)[0].samples, 2);
  clock += 1000; recorder.record(observation('supply_temperature', clock));
  assert.ok(recorder.metadataTimer);
  store.close();
  assert.equal(recorder.metadataTimer, null);
});

test('an earlier flush cutoff cannot publish a later receipt', t => {
  const { store, recorder, put } = fixture(t);
  put(at); put(at + 1000);
  recorder.flush(at + 500, { force: true });
  assert.equal(coverage(store)[0].end_at, at);
  assert.equal(recorder.pendingSignals.size, 1);
  recorder.flush(at + 1000, { force: true });
  assert.equal(coverage(store)[0].end_at, at + 1000);
});

test('failed worker COMMIT preserves pending metadata for one exact retry and restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'recorder-metadata-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'data.sqlite'), { store, recorder, put } = fixture(t, path);
  await store.startWriter();
  await store.runWrite(() => put(at));
  await store.runWrite(() => put(at + 1000));
  const pending = structuredClone(recorder.pendingSignals), before = store.checkpoint();
  const request = store.writer.request;
  store.writer.request = function (op, args) {
    if (op === 'commit') throw Object.assign(Error('fixture failure'), { code: 'STORAGE_TEST_FAILURE' });
    return request.call(this, op, args);
  };
  await assert.rejects(store.runWrite(() => recorder.flush(at + 2000, { force: true })));
  store.writer.request = request;
  assert.deepEqual(store.checkpoint(), before);
  assert.deepEqual(recorder.pendingSignals, pending);
  await store.runWrite(() => recorder.flush(at + 2000, { force: true }));
  assert.equal(coverage(store)[0].samples, 2);
  await store.close();
  const reopened = new Store(path); t.after(() => reopened.close());
  assert.equal(coverage(reopened)[0].end_at, at + 1000);
  assert.equal(reopened.db.prepare('SELECT sum(polls) n FROM recorder_metrics').get().n, 2);
});
