import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, hasLearningSampleAfter } from '../src/storage/store.js';
import { lastIndoorReading, indoorReportCoverage } from '../src/app/indoor-readings.js';
import { Recorder } from '../src/storage/recorder.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';

const start = Date.UTC(2026, 0, 1);

test('learning existence checks retain only the current epoch and its selected immutable prefixes', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const sample = (input, offset) => appendLearningRecord(store, input, 'sample', { timestamp: start + offset, indoorC: 21 });
  sample('providers', 10);
  const prefix = store.learningJournalHead('providers');
  sample('providers', 30); sample('mqtt', 100);
  assert.equal(hasLearningSampleAfter(store.db, 'providers', start + 20), true);
  store.transaction(() => {
    store.db.prepare('INSERT INTO learning_epochs(input,epoch) VALUES(?,?)').run('providers', 'selected-correction');
    store.db.prepare(`INSERT INTO learning_epoch_segments(epoch,input,source_epoch,after_id,through_id)
      VALUES(?,?,'original',0,?)`).run('selected-correction', 'providers', prefix);
  });
  assert.equal(hasLearningSampleAfter(store.db, 'providers', start + 20), false, 'An unselected source suffix cannot require rebuilding');
  assert.equal(hasLearningSampleAfter(store.db, 'providers', start), true, 'The inherited prefix remains visible');
  sample('providers', 20);
  assert.equal(hasLearningSampleAfter(store.db, 'providers', start + 15), true);
  assert.equal(hasLearningSampleAfter(store.db, 'providers', start + 20), false, 'The lower time bound is strict');
  assert.equal(hasLearningSampleAfter(store.db, 'simulated', start), false, 'Another environment supplies no learning evidence');
});

test('an exact report transition retains the preceding boundary provenance', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store), at = start + 60_000;
  for (const [time, value] of [[start, 21], [at, 22]]) recorder.record({ source: 'mqtt-temperature', device: 'room',
    signal: 'indoor_temperature', value, unit: 'degC', sourceTime: time, receivedAt: time, quality: [],
    raw: { reportIntervalMs: 60_000, reportGraceMs: 60_000 } });
  const reading = lastIndoorReading(store, { signal: 'indoor_temperature', at, input: 'providers' });
  const ids = store.db.prepare('SELECT id FROM recorder_coverage ORDER BY id').all().map(row => row.id);
  assert.deepEqual(reading.reportCoverage.coverage, ids);
  const coverage = indoorReportCoverage(store, { reading, from: at, at: at + 30_000, includeIntervals: true });
  assert.deepEqual(coverage.coverage, ids);
  assert.ok(coverage.intervals.some(row => row.start === at && row.end === at && row.observedAt === start));
});

test('latest attention crosses recording policies and units while retained packets cannot clear a failure', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const put = (offset, extra = {}) => store.observation({ source: 'mqtt-temperature', device: 'room',
    signal: 'indoor_temperature', value: 21, unit: 'degC', sourceTime: start + offset, receivedAt: start + offset,
    quality: [], raw: { recorder: { policy: 'first' } }, ...extra });
  put(0);
  put(1, { unit: 'unknown', quality: ['invalid-unit'], raw: { recorder: { policy: 'second' } } });
  put(2, { quality: ['retained'], raw: { retained: true, recorder: { policy: 'second' } } });
  const held = lastIndoorReading(store, { signal: 'indoor_temperature', input: 'providers', at: start + 3 });
  assert.equal(held.sourceTime, start);
  assert.deepEqual(held.attentionReasons, ['invalid-reading']);
  put(4, { raw: { recorder: { policy: 'third' } } });
  const recovered = lastIndoorReading(store, { signal: 'indoor_temperature', input: 'providers', at: start + 4 });
  assert.equal(recovered.sourceTime, start + 4);
  assert.deepEqual(recovered.attentionReasons, []);
});

test('time-window history preserves ingestion order, cursor and active selection for late observations', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const put = (time, signal = 'indoor_temperature') => store.observation({ source: 'synthetic', device: 'room',
    signal, value: 21, unit: 'degC', sourceTime: time, receivedAt: start + 1000, quality: [] });
  const a = put(start + 30), old = put(start - 1), b = put(start + 10), excluded = put(start + 20), c = put(start + 40);
  put(start + 15, 'garage_temperature');
  store.transaction(() => store.db.prepare(`INSERT INTO recovery_exclusions(generation,table_name,record_key)
    VALUES('original','observations',?)`).run(String(excluded)));
  const query = { signal: 'indoor_temperature', from: start, to: start + 40 };
  assert.deepEqual(store.observations(query).map(row => row.id), [a, b]);
  assert.deepEqual(store.observations({ ...query, limit: 1 }).map(row => row.id), [a]);
  assert.deepEqual(store.observations({ ...query, afterId: a, limit: 1 }).map(row => row.id), [b]);
  assert.deepEqual(store.observations({ ...query, afterId: b }).map(row => row.id), []);
  assert.deepEqual(store.observations({ from: start, to: start + 40 }).map(row => row.id), [a, b, c + 1]);
  assert.deepEqual(store.observations({ afterId: a, limit: 1 }).map(row => row.id), [old], 'Unbounded ingestion pages retain their ID seek');
});

test('writer-backed indoor selection pages past invalid readings without transferring the retained history', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-range-reader-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  t.after(async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); });
  const payload = 'x'.repeat(24 * 1024);
  for (let first = 0; first < 480; first += 16) store.transaction(() => {
    for (let n = first; n < first + 16; n++) store.observation({ source: 'mqtt-temperature', device: 'synthetic-room',
      signal: 'indoor_temperature', value: 21 + n / 10_000, unit: 'degC',
      sourceTime: start + n, receivedAt: start + n,
      quality: n < 400 ? [] : ['invalid-value'], raw: { payload } });
  });
  const query = { signal: 'indoor_temperature', at: start + 1000, input: 'providers' };
  const expected = lastIndoorReading(store, query);
  assert.equal(expected.sourceTime, start + 399);
  await store.startWriter();
  const actual = await store.runWrite(() => lastIndoorReading(store, query));
  assert.deepEqual(actual, expected);
  const { needsAttention, attentionReasons, held, ...measurement } = expected;
  assert.deepEqual(await store.runWrite(() => lastIndoorReading(store, { ...query, includeAvailability: false })), measurement);
  assert.equal(await store.runWrite(() => lastIndoorReading(store, { ...query, input: 'simulated' })), null);
});
