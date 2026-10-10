import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createWriteHealthHistory } from '../src/storage/write-health-history.js';
import { createWriteHealth } from '../src/storage/write-health.js';
import { WriteQueue } from '../src/storage/write-queue.js';
import { Store } from '../src/storage/store.js';

const DAY = 86_400_000, BIN = 300_000, start = Date.parse('2026-10-10T12:00:00Z');
function fixture() {
  let mono = 0, wall = start;
  const history = createWriteHealthHistory({ clock: () => wall, monotonic: () => mono });
  return { history, mono: () => mono, wall: () => wall,
    advance(ms) { mono += ms; wall += ms; }, adjustWall(ms) { wall += ms; } };
}
const timing = (totalMs, committed = true, commitMs = totalMs / 2) =>
  ({ committed, totalMs, beginMs: 0, bodyMs: totalMs - commitMs, commitMs });

test('memory windows retain measured means/maxima and approximate percentiles for committed outcomes', () => {
  const f = fixture();
  for (const duration of [1, 2, 3, 4, 10]) f.history.transaction(timing(duration));
  f.history.transaction(timing(1000, false));
  for (const [priority, delayMs] of [['normal', 8], ['normal', 16], ['control', 100]])
    f.history.queue({ type: 'completed', priority, delayMs });
  const status = f.history.status(), day = status.windows.day;
  assert.equal(day.transactionAttempts, 6); assert.equal(day.committedTransactions, 5);
  assert.deepEqual(day.transactionDuration, { count: 5, meanMs: 4, p95Ms: 10, maxMs: 10 });
  assert.equal(day.commitDuration.meanMs, 2);
  assert.equal(day.queueDelay.count, 3); assert.equal(day.queueDelay.meanMs, 124 / 3);
  assert.equal(day.controlQueueDelay.maxMs, 100); assert.equal(day.normalQueueDelay.meanMs, 12);
  assert.equal(status.percentileMethod, 'histogram-upper-bound');
  assert.equal(day.complete, false); assert.equal(day.coveredMs, 0);
  assert.equal(JSON.stringify(status).includes('histogram"'), false, 'raw histogram implementation stays private');
});

test('failure deduplication and recovery retain recognized failures without errors or private values', () => {
  let now = start, mono = 0;
  const health = createWriteHealth(() => now, null, { monotonic: () => mono });
  const error = Object.assign(new Error('/private/secret-household-value'), { errcode: 13 });
  health.failure(error); health.failure(error);
  health.failure(new Error('unrelated application validation'));
  health.failure({ code: 'STORAGE_QUEUE_FULL' });
  health.queue({ type: 'rejected' }); health.queue({ type: 'cancelled' });
  const failed = health.status();
  assert.equal(failed.failing, true); assert.equal(failed.failures, 2);
  assert.equal(failed.history.windows.day.failedWrites, 1);
  assert.equal(failed.history.windows.day.queueRejected, 1);
  assert.equal(failed.history.windows.day.cancelledJobs, 1);
  mono += 100; now += 100; health.success();
  const recovered = health.status();
  assert.equal(recovered.failing, false);
  assert.equal(recovered.history.windows.day.failedWrites, 1);
  assert.equal(JSON.stringify(recovered).includes('secret-household-value'), false);
});

test('ongoing contention splits into bins and rejoins once with exact duration and peak backlog', () => {
  const f = fixture();
  f.history.queue({ type: 'pending', pending: 3 });
  f.advance(100); f.history.queue({ type: 'waiting' });
  f.advance(2 * BIN + 500);
  let day = f.history.status().windows.day;
  assert.equal(day.contention.episodes, 1); assert.equal(day.contention.totalMs, 2 * BIN + 500);
  assert.equal(day.contention.maxMs, 2 * BIN + 500); assert.equal(day.contention.active, true);
  assert.equal(day.peakPending, 3);
  f.history.queue({ type: 'ready' }); f.history.queue({ type: 'pending', pending: 0 });
  f.advance(100); f.history.queue({ type: 'waiting' });
  f.advance(40); f.history.queue({ type: 'ready' });
  day = f.history.status().windows.day;
  assert.equal(day.contention.episodes, 2); assert.equal(day.contention.totalMs, 2 * BIN + 540);
  assert.equal(day.contention.maxMs, 2 * BIN + 500); assert.equal(day.contention.active, false);
});

test('multiple completed waits in a boundary bin do not merge distinct episodes', () => {
  const f = fixture();
  f.history.queue({ type: 'waiting' }); f.advance(BIN + 20); f.history.queue({ type: 'ready' });
  f.history.queue({ type: 'waiting' }); f.advance(30); f.history.queue({ type: 'ready' });
  f.advance(BIN); f.history.queue({ type: 'waiting' }); f.advance(40); f.history.queue({ type: 'ready' });
  const day = f.history.status().windows.day;
  assert.equal(day.contention.episodes, 3);
  assert.equal(day.contention.totalMs, BIN + 90); assert.equal(day.contention.maxMs, BIN + 20);
});

test('rolling windows clip an existing wait and expire earlier outcomes without invented zero-day coverage', () => {
  const f = fixture();
  f.history.failure('disk-full'); f.history.queue({ type: 'waiting' });
  f.advance(8 * DAY + 123);
  let status = f.history.status();
  assert.equal(status.windows.week.failedWrites, 0);
  assert.equal(status.windows.week.coveredMs, 7 * DAY - BIN + 123);
  assert.equal(status.windows.week.monitoredMs, 7 * DAY);
  assert.equal(status.windows.week.complete, false);
  assert.equal(status.windows.week.contention.episodes, 1);
  assert.equal(status.windows.week.contention.totalMs, status.windows.week.coveredMs);
  assert.equal(status.windows.week.contention.maxMs, status.windows.week.coveredMs);
  assert.equal(status.windows.day.contention.totalMs, status.windows.day.coveredMs);
  f.history.queue({ type: 'ready' }); f.advance(7 * DAY);
  status = f.history.status();
  assert.equal(status.windows.week.contention.totalMs, 0);
  assert.equal(status.windows.week.contention.episodes, 0);
  assert.equal(status.windows.week.contention.active, false);
  assert.equal(fixture().history.status().windows.week.coveredMs, 0, 'a new Store scope has no previous history');
});

test('finished long waits crossing the selected window retain clipped rather than historical full duration', () => {
  const f = fixture(); f.history.queue({ type: 'waiting' });
  f.advance(2 * DAY + 50); f.history.queue({ type: 'ready' });
  const day = f.history.status().windows.day;
  assert.equal(day.contention.episodes, 1);
  assert.equal(day.contention.totalMs, day.coveredMs);
  assert.equal(day.contention.maxMs, day.coveredMs);
  assert.equal(day.contention.active, false);
});

test('wall clock corrections preserve monotonic monitoring coverage, expiry and waiting durations', () => {
  const f = fixture();
  f.history.queue({ type: 'waiting' }); f.advance(100); f.adjustWall(-2 * DAY);
  let status = f.history.status();
  assert.equal(status.clockChanged, true); assert.equal(status.elapsedMs, 100);
  assert.equal(status.current.waitingMs, 100); assert.equal(status.windows.day.coveredMs, 100);
  assert.equal(status.startedAt, start); assert.equal(status.checkedAt, f.wall());
  f.adjustWall(20 * DAY); f.advance(50); f.history.queue({ type: 'ready' });
  status = f.history.status();
  assert.equal(status.elapsedMs, 150); assert.equal(status.windows.day.contention.maxMs, 150);
});

test('queue instrumentation distinguishes successful admissions, intentional cancellations and rejected admission', async () => {
  const f = fixture(); let locked = true;
  const queue = new WriteQueue({ clock: f.wall, monotonic: f.mono, onHealth: event => f.history.queue(event),
    transaction: operation => { if (locked) throw Object.assign(new Error('locked'), { errcode: 5 }); return operation(); } });
  const cancel = new AbortController();
  const first = queue.run(() => 1, { priority: 'control', bytes: 8 * 1024 * 1024 });
  await assert.rejects(queue.run(() => 2, { bytes: 1 }), { code: 'STORAGE_QUEUE_FULL' });
  f.advance(50); locked = false; queue.pump(); assert.equal(await first, 1);
  locked = true;
  const cancelled = queue.run(() => assert.fail('cancelled job ran'), { signal: cancel.signal }).catch(error => error);
  f.advance(20); cancel.abort(); assert.equal((await cancelled).code, 'STORAGE_WRITE_CANCELLED');
  const day = f.history.status(queue.status()).windows.day;
  assert.equal(day.acceptedJobs, 2); assert.equal(day.queueDelay.count, 1);
  assert.equal(day.controlQueueDelay.meanMs, 50); assert.equal(day.normalQueueDelay.count, 0);
  assert.equal(day.queueRejected, 1); assert.equal(day.cancelledJobs, 1); assert.equal(day.failedWrites, 0);
  queue.close();
});

test('pending queue age and health durations are monotonic while diagnostic failure cannot block a save', async () => {
  const f = fixture(); let locked = true;
  const queue = new WriteQueue({ clock: f.wall, monotonic: f.mono,
    onHealth: () => { throw new Error('synthetic diagnostic failure'); },
    transaction: operation => { if (locked) throw Object.assign(new Error('locked'), { errcode: 5 }); return operation(); } });
  const pending = queue.run(() => 'saved');
  f.advance(45); f.adjustWall(-DAY);
  assert.equal(queue.status().oldestPendingMs, 45);
  locked = false; queue.pump(); assert.equal(await pending, 'saved');
  assert.equal(queue.status().oldestPendingMs, null); queue.close();
});

test('running publication work is excluded from backlog peak and committed publication errors count once', async () => {
  const f = fixture();
  const health = createWriteHealth(f.wall, null, { monotonic: f.mono });
  const queue = new WriteQueue({ clock: f.wall, monotonic: f.mono,
    onHealth: event => health.queue(event), onFailure: error => health.failure(error), transaction: fn => fn() });
  let finish;
  const hold = new Promise(resolve => { finish = resolve; });
  const savedError = Object.assign(new Error('private follow-up'), { committed: true, code: 'STORAGE_COMMIT_EFFECT_FAILED' });
  const publication = queue.exclusive(async () => {
    await hold; health.postCommitFailure(savedError); throw savedError;
  }).catch(error => error);
  await Promise.resolve(); f.advance(BIN);
  const pending = queue.run(() => 'queued result');
  const current = health.status();
  assert.equal(queue.status().queued, 1); assert.equal(queue.status().activeJobs, 1);
  assert.equal(current.history.windows.day.peakPending, 1, 'running publication does not become an extra queued operation');
  finish(); assert.equal(await publication, savedError); assert.equal(await pending, 'queued result');
  const day = health.status().history.windows.day;
  assert.equal(day.postCommitFailures, 1); assert.equal(day.failedWrites, 0); assert.equal(day.failedJobs, 0);
  assert.equal(day.queueDelay.count, 2);
  queue.close();
});

test('real writer contention survives recovery as health evidence without recording diagnostic database rows', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-health-history-'));
  const store = new Store(join(directory, 'fixture.sqlite')), writer = new DatabaseSync(store.path);
  t.after(() => { if (writer.isTransaction) writer.exec('ROLLBACK'); writer.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  writer.exec('BEGIN IMMEDIATE');
  const checkpoint = store.checkpoint(), before = store.writeHealth.status().history.windows.day;
  const pending = store.runWrite(() => store.setState('confirmed', true), { priority: 'control' });
  await delay(35);
  const waiting = store.writeHealth.status().history;
  assert.equal(waiting.current.pending, 1); assert(waiting.current.oldestPendingMs >= 25);
  assert(waiting.current.waitingMs >= 25); assert.equal(waiting.windows.day.failedWrites, 0);
  assert.equal(waiting.windows.day.contention.episodes, 1);
  assert.deepEqual(store.checkpoint(), checkpoint);
  writer.exec('ROLLBACK'); await pending;
  const completed = store.writeHealth.status().history.windows.day;
  assert.equal(completed.committedTransactions, before.committedTransactions + 1);
  assert.equal(completed.queueDelay.count, 1); assert(completed.queueDelay.maxMs >= 25);
  assert.equal(completed.contention.episodes, 1); assert(completed.contention.maxMs >= 25);
  assert(completed.transactionAttempts > completed.committedTransactions);
  const after = store.checkpoint();
  for (let i = 0; i < 25; i++) store.writeHealth.status();
  assert.deepEqual(store.checkpoint(), after);
});

test('rolled-back storage writes deduplicate failure counts and postcommit failures retain saved outcomes', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const failure = Object.assign(new Error('private-failure-detail'), { errcode: 10 });
  await assert.rejects(store.runWrite(() => { store.setState('rollback', true); throw failure; }), error => error === failure);
  assert.equal(store.getState('rollback'), null);
  const failed = store.writeHealth.status().history.windows.day;
  assert.equal(failed.failedWrites, 1); assert.equal(failed.failedJobs, 1); assert.equal(failed.queueDelay.count, 0);
  await assert.rejects(store.runWrite(() => {
    store.setState('saved', true); store.afterCommit(() => { throw new Error('consumer error'); });
  }), { code: 'STORAGE_COMMIT_EFFECT_FAILED', committed: true });
  const completed = store.writeHealth.status().history.windows.day;
  assert.equal(completed.failedWrites, 1); assert.equal(completed.failedJobs, 1);
  assert.equal(completed.postCommitFailures, 1); assert.equal(completed.queueDelay.count, 1);
  assert.equal(store.getState('saved'), true);
  assert.equal(store.writeHealth.status().failing, false);
});
