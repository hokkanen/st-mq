import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { createWriteHealthHistory } from '../src/storage/write-health-history.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-scheduling-health-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return store;
}

test('configuration comes from the owning connection and health reads never issue SQL', async t => {
  const store = await fixture(t);
  assert.equal(store.storageStatus().configuration.execution, 'direct');
  assert.deepEqual(store.storageStatus().configuration.checkpoint, { mode: 'automatic', autoCheckpointFrames: 1000 });
  await store.startWriter(); clearInterval(store.walMaintenance.timer);
  const config = store.storageStatus().configuration;
  assert.equal(config.execution, 'worker'); assert.equal(config.synchronous, 'full');
  assert.equal(config.journalMode, 'wal'); assert.equal(config.checkpoint.autoCheckpointFrames, 0);
  const [major, minor] = store.db.prepare('SELECT sqlite_version() AS version').get().version.split('.').map(Number);
  if (major > 3 || major === 3 && minor >= 51) {
    assert.equal(config.checkpoint.mode, 'queued-passive');
    assert.equal(config.checkpoint.triggerFrames, 50); assert.equal(config.checkpoint.maxDirtyMs, 5000);
    assert.equal(config.checkpoint.fallbackPollMs, null);
  } else {
    assert.equal(config.checkpoint.mode, 'periodic-passive');
    assert.equal(config.checkpoint.triggerFrames, null); assert.equal(config.checkpoint.maxDirtyMs, null);
    assert.equal(config.checkpoint.fallbackPollMs, 1000);
  }
  const checkpoint = store.checkpoint(), db = store.db;
  store.db = new Proxy({}, { get() { throw Error('Health must not read SQLite'); } });
  try { for (let i = 0; i < 20; i++) { store.storageStatus(); store.writeHealth.status(); } }
  finally { store.db = db; }
  assert.deepEqual(store.checkpoint(), checkpoint);
});

test('a background turn reports its owner and pending lanes without becoming a save', async t => {
  const store = await fixture(t); await store.startWriter(); store.walMaintenance.close();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const background = store.runStorageTask(async () => { entered(); await new Promise(resolve => { release = resolve; }); }, { kind: 'history' });
  await started;
  const control = store.runWrite(() => store.setState('control', true), { priority: 'control' });
  const ordinary = store.runWrite(() => store.setState('ordinary', true));
  const pendingBackground = store.runStorageTask(() => {}, { kind: 'mirror' });
  try {
    const status = store.storageStatus();
    assert.equal(status.queue.active.kind, 'history'); assert.equal(status.queue.active.priority, 'background');
    assert.equal(status.queue.lanes.control.queued, 1); assert.equal(status.queue.lanes.normal.queued, 1);
    assert.equal(status.queue.lanes.background.queued, 1); assert.equal(status.queue.lanes.background.running, 1);
    assert.equal(store.writePending, false, 'A background reservation is not a pending durable save');
  } finally { release(); await Promise.all([background, control, ordinary, pendingBackground]); }
  const before = store.writeHealth.status().history.windows.day;
  await assert.rejects(store.runStorageTask(() => { throw Object.assign(Error('synthetic'), { errcode: 10 }); }), /synthetic/);
  const after = store.writeHealth.status().history.windows.day;
  assert.equal(after.backgroundFailedJobs, before.backgroundFailedJobs + 1);
  assert.equal(after.failedJobs, before.failedJobs); assert.equal(after.failedWrites, before.failedWrites);
  assert.equal(after.backgroundRunDuration.count, before.backgroundRunDuration.count + 1);
});

test('checkpoint calls and status polls have separate timing evidence and retain original observation clocks', async t => {
  const store = await fixture(t); await store.startWriter(); clearInterval(store.walMaintenance.timer);
  const maintenance = store.walMaintenance, request = store.writer.request.bind(store.writer);
  let result = { ran: true, busy: 0, log: 157, checkpointed: 150, elapsedMs: 23 };
  store.writer.request = (op, ...args) => op === 'checkpoint' ? Promise.resolve(result) : request(op, ...args);
  const before = store.writeHealth.status().history.windows.day;
  maintenance.poll(); await maintenance.pending;
  const measured = maintenance.status();
  assert.equal(measured.frames.remainingFrames, 7); assert.equal(measured.lastRun.elapsedMs, 23);
  result = { ran: false, elapsedMs: 0 }; maintenance.poll(); await maintenance.pending;
  assert.deepEqual(maintenance.status().frames, measured.frames, 'A throttled request does not renew frame evidence');
  assert.deepEqual(maintenance.status().lastRun, measured.lastRun);
  const after = store.writeHealth.status().history.windows.day;
  assert.equal(after.checkpointDuration.count, before.checkpointDuration.count + 1);
  assert.equal(after.checkpointDuration.meanMs, 23);
  assert.equal(after.committedTransactions, before.committedTransactions);
  store.writer.request = (op, ...args) => op === 'checkpoint' ? Promise.reject(Error('synthetic')) : request(op, ...args);
  maintenance.poll(); await maintenance.pending;
  assert.equal(maintenance.status().state, 'failed');
  assert.equal(store.writeHealth.status().history.windows.day.checkpointFailures, 1);
  assert.equal(store.writeHealth.status().history.windows.day.failedWrites, before.failedWrites);
  store.writer.request = (op, ...args) => op === 'checkpoint' ? Promise.resolve({ ran: false, elapsedMs: 0 }) : request(op, ...args);
  maintenance.poll(); await maintenance.pending;
  assert.equal(maintenance.status().state, 'failed', 'A throttled poll cannot clear an unresolved checkpoint failure');
  store.writer.request = (op, ...args) => op === 'checkpoint'
    ? Promise.resolve({ ran: true, busy: 0, log: 157, checkpointed: 157, elapsedMs: 12 }) : request(op, ...args);
  maintenance.poll(); await maintenance.pending;
  assert.equal(maintenance.status().state, 'idle');
  assert.equal(store.writeHealth.status().history.windows.day.checkpointFailures, 1, 'Recovery retains dated failure history');
});

test('building, commit and checkpoint history remain distinct; background refusals are not save refusals', () => {
  let elapsed = 0;
  const health = createWriteHealthHistory({ clock: () => 1000 + elapsed, monotonic: () => elapsed });
  health.transaction({ committed: true, beginMs: 2, bodyMs: 90, commitMs: 7, totalMs: 100,
    journalSealMs: 3, nativeCommitMs: 2 });
  health.queue({ type: 'completed', priority: 'background', delayMs: 30 });
  health.queue({ type: 'rejected', priority: 'background' });
  health.queue({ type: 'cancelled', priority: 'background' });
  health.checkpoint({ ran: false, elapsedMs: 0 });
  health.checkpoint({ ran: true, elapsedMs: 450 });
  elapsed = 20;
  const day = health.status().windows.day;
  assert.equal(day.bodyDuration.meanMs, 90); assert.equal(day.beginDuration.meanMs, 2);
  assert.equal(day.commitDuration.meanMs, 7); assert.equal(day.transactionDuration.meanMs, 100);
  assert.equal(day.checkpointDuration.meanMs, 450); assert.equal(day.checkpointDuration.count, 1);
  assert.equal(day.backgroundQueueDelay.meanMs, 30); assert.equal(day.queueDelay.count, 0);
  assert.equal(day.backgroundQueueRejected, 1); assert.equal(day.queueRejected, 0);
  assert.equal(day.backgroundCancelledJobs, 1); assert.equal(day.cancelledJobs, 0);
});
