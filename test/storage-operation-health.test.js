import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageOperationHealth, STORAGE_OPERATION_KINDS } from '../src/storage/operation-health.js';

function fixture() {
  let now = 1_000_000, tick = 0;
  const health = createStorageOperationHealth({ clock: () => now, monotonic: () => tick });
  return { health, advance(ms) { now += ms; tick += ms; } };
}
const family = (health, kind) => health.status().coverage.find(row => row.kind === kind);
test('queued jobs have exact-once final outcomes and monotonic durations', () => {
  const { health, advance } = fixture();
  const job = health.begin('backup', { queued: true });
  advance(30); assert.equal(family(health, 'backup').queued, 1);
  job.start(); job.start(); advance(70);
  job.finish('failed', { reason: 'cleanup-failed', committed: true }); job.finish('completed');
  const row = family(health, 'backup');
  assert.equal(row.running, 0); assert.equal(row.day.failed, 1); assert.equal(row.day.completed, 0);
  assert.equal(row.day.committed, 1);
  assert.deepEqual([row.lastResult.elapsedMs, row.lastResult.queueMs, row.lastResult.runningMs], [100, 30, 70]);
});
test('observations contain fixed safe categories and do not retain caller data', () => {
  const { health } = fixture();
  health.begin('/private/path', { scope: 'secret' });
  const job = health.begin('verification', { scope: '/private/path', payload: 'password', queued: true });
  job.progress('/private/path'); job.finish('failed', { reason: 'password', payload: 'private', error: Error('secret') });
  const status = health.status(), text = JSON.stringify(status);
  assert.equal(status.coverage.length, STORAGE_OPERATION_KINDS.length);
  assert.equal(text.includes('/private'), false); assert.equal(text.includes('password'), false); assert.equal(text.includes('secret'), false);
  assert.equal(family(health, 'verification').lastResult.reason, null);
});
test('aggregates and latest diagnostic receipts expire after seven elapsed days', () => {
  const { health, advance } = fixture();
  health.begin('history-query').finish('completed');
  advance(86_400_000 + 300_000);
  assert.equal(health.status().day.completed, 0); assert.equal(health.status().week.completed, 1);
  advance(6 * 86_400_000 + 300_000);
  assert.equal(health.status().week.completed, 0);
  assert.equal(family(health, 'history-query').lastResult, null);
});
test('monitoring distinguishes refusals, superseded pending work and cancellation without changing admission', () => {
  const { health } = fixture();
  health.refuse('verification');
  health.begin('history-query', { queued: true }).finish('superseded');
  health.begin('backup').finish('cancelled');
  assert.equal(health.status().day.refused, 1); assert.equal(health.status().day.superseded, 1);
  assert.equal(health.status().day.cancelled, 1); assert.equal(health.status().running, 0);
});

test('a later success preserves the dated problem and a refusal has no execution sample', () => {
  const { health, advance } = fixture();
  health.begin('backup-save').finish('failed', { reason: 'cleanup-failed', committed: true });
  const failed = family(health, 'backup-save').day.lastProblem;
  advance(1000);
  health.begin('backup-save').finish('completed');
  let row = family(health, 'backup-save');
  assert.equal(health.status().version, 2);
  assert.equal(row.lastResult.outcome, 'completed');
  assert.deepEqual(row.day.lastProblem, failed);
  assert.equal(row.day.failed, 1);
  advance(1000); health.refuse('backup-save');
  row = family(health, 'backup-save');
  assert.equal(row.day.lastProblem.outcome, 'refused');
  assert.equal(row.day.lastProblem.finishedAt, failed.finishedAt + 2000);
  assert.equal(row.day.lastProblem.reason, 'capacity');
  assert.equal(row.day.durationSamples, 2);
  assert.equal(row.lastResult.outcome, 'completed');
  advance(86400_000 + 300_000);
  assert.equal(family(health, 'backup-save').day.lastProblem, null);
  assert.equal(family(health, 'backup-save').week.lastProblem.outcome, 'refused');
  advance(6 * 86400_000 + 300_000);
  assert.equal(family(health, 'backup-save').week.lastProblem, null);
});

test('dated problems use the counter bucket boundary despite wall-clock changes', () => {
  let wall = 1_000_000, tick = 1000;
  const health = createStorageOperationHealth({ clock: () => wall, monotonic: () => tick });
  health.begin('backup-download').finish('failed');
  wall += 30 * 86400_000;
  assert.equal(family(health, 'backup-download').day.lastProblem.finishedAt, 1_000_000);
  tick += 86400_000 + 1;
  const row = family(health, 'backup-download');
  assert.equal(row.day.failed, 0);
  assert.equal(row.day.lastProblem, null, 'The partial oldest bucket is omitted for both counts and dates');
  assert.equal(row.week.lastProblem.finishedAt, 1_000_000);
});
test('active observation memory is bounded and no writer identity is adopted on store replacement', () => {
  const { health } = fixture();
  for (let index = 0; index < 200; index++) health.begin('checkpoint-cache', { scope: 'standby', databaseId: 'private-store' });
  const status = health.status();
  assert.equal(status.running, 200); assert.equal(status.observationsDropped, 72);
  assert.equal(JSON.stringify(status).includes('private-store'), false);
  assert.equal(status.period, 'application-run'); assert.equal(status.scope, 'local-node');
});

test('wall clock changes do not discard or prematurely expire observations', () => {
  let wall = 1_000_000, tick = 0;
  const health = createStorageOperationHealth({ clock: () => wall, monotonic: () => tick });
  health.begin('backup').finish('completed');
  wall += 30 * 86400_000;
  assert.equal(health.status().week.completed, 1);
  wall -= 60 * 86400_000;
  assert.equal(health.status().week.completed, 1);
  tick += 7 * 86400_000 + 300_000;
  assert.equal(health.status().week.completed, 0);
});
test('late registration and refusals report actual duration coverage', () => {
  const { health, advance } = fixture(); advance(5000);
  health.register('backup'); advance(1000); health.refuse('backup');
  const row = family(health, 'backup');
  assert.equal(row.day.monitoredMs, 1000); assert.equal(row.day.coveredMs, 1000);
  assert.equal(row.day.durationSamples, 0); assert.equal(row.day.refused, 1);
});

test('dense seven-day observations aggregate both windows exactly without expanding the response', () => {
  const { health, advance } = fixture(), bucketMs = 300_000, bucketCount = 2016;
  const outcomeNames = ['completed', 'failed', 'cancelled', 'superseded', 'unconfirmed'];
  const counters = ['completed', 'failed', 'cancelled', 'superseded', 'unconfirmed', 'refused',
    'committed', 'durationSamples', 'elapsedMs', 'runningMs', 'queueMs', 'maxElapsedMs'];
  const expected = new Map(STORAGE_OPERATION_KINDS.map(kind => [kind, { day: {}, week: {} }]));
  for (const kind of STORAGE_OPERATION_KINDS) health.register(kind);
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    for (const [index, kind] of STORAGE_OPERATION_KINDS.entries()) {
      const queued = index % 2 === 0, outcome = outcomeNames[(bucket + index) % outcomeNames.length];
      const job = health.begin(kind, { queued });
      advance(2); job.start(); advance(3);
      job.finish(outcome, { committed: bucket % 2 === 0 });
      if (bucket % 100 === 0) health.refuse(kind);
      for (const period of bucket >= bucketCount - 288 ? ['day', 'week'] : ['week']) {
        const ledger = expected.get(kind)[period];
        ledger[outcome] = (ledger[outcome] ?? 0) + 1;
        ledger.refused = (ledger.refused ?? 0) + Number(bucket % 100 === 0);
        ledger.committed = (ledger.committed ?? 0) + Number(bucket % 2 === 0);
        ledger.durationSamples = (ledger.durationSamples ?? 0) + 1;
        ledger.elapsedMs = (ledger.elapsedMs ?? 0) + 5;
        ledger.runningMs = (ledger.runningMs ?? 0) + (queued ? 3 : 5);
        ledger.queueMs = (ledger.queueMs ?? 0) + (queued ? 2 : 0);
        ledger.maxElapsedMs = 5;
      }
    }
    advance(bucketMs - STORAGE_OPERATION_KINDS.length * 5);
  }
  const status = health.status();
  assert.equal(status.queued, 0); assert.equal(status.running, 0);
  for (const row of status.coverage) for (const period of ['day', 'week']) {
    assert.equal(row[period].coveredMs, period === 'day' ? 86400_000 : 7 * 86400_000);
    for (const key of counters) assert.equal(row[period][key], expected.get(row.kind)[period][key] ?? 0, `${row.kind}.${period}.${key}`);
  }
  for (const period of ['day', 'week']) for (const key of counters) {
    const values = [...expected.values()].map(value => value[period][key] ?? 0);
    assert.equal(status[period][key], key === 'maxElapsedMs' ? Math.max(...values) : values.reduce((sum, value) => sum + value, 0));
  }
  assert(JSON.stringify(status).length < 100_000, 'only bounded per-family summaries leave the collector');
  advance(7 * 86400_000 + bucketMs);
  const expired = health.status();
  assert.equal(expired.week.durationSamples, 0);
  assert(expired.coverage.every(row => row.lastResult === null && row.week.refused === 0));
});
