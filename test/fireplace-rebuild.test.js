import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { addFireplace, removeFireplace, FireplaceRebuildManager } from '../src/app/fireplace.js';
import { fireplaceLearningContext } from '../src/app/fireplace-inputs.js';
import { addSensorChange, revertSensorChange } from '../src/app/sensor-changes.js';
import { sensorLearningContext } from '../src/app/sensor-inputs.js';
import { applyLearningRecord, replayLearningJournal, LEARNING_ALGORITHM, validLearningCheckpoint} from '../src/app/committed-learning.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';

const at = Date.parse('2026-01-01T00:00:00Z');
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function ready(manager) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = manager.takeReady();
    if (result) return result;
    assert.notEqual(manager.status().status, 'failed');
    await pause();
  }
  throw new Error('Synthetic fireplace rebuild timed out');
}
function sample(store, i, input = 'mqtt') {
  const timestamp = at + i * 900_000;
  appendLearningRecord(store, input, 'sample', { timestamp, windowStart: timestamp - 900_000, windowEnd: timestamp,
    indoorC: 21, outdoorC: 0, solarRadiationWm2: 0, quality: [], phase: 'normal', regime: 'occupied',
    targetC: 21, roomBoostC: 0, actualModeKnown: false, powerKw: 3, energyBasis: 'estimated' });
}

test('background replay is deterministic, leaves the old checkpoint active, and catches up journal suffixes', { timeout: 30_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-fireplace-rebuild-'));
  const store = new Store(join(directory, 'invented.sqlite'));
  const manager = new FireplaceRebuildManager({ store, input: 'mqtt' });
  t.after(async () => { await manager.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const load = addFireplace(store, 'mqtt', { requestId: 'invented-load', kg: 4 }, at);
  for (let i = 1; i <= 12; i++) sample(store, i);
  sample(store, 13, 'simulated');
  const old = replayLearningJournal(store, 'mqtt');
  const journal = store.learningJournal({ input: 'mqtt', algorithmVersion: LEARNING_ALGORITHM });
  removeFireplace(store, 'mqtt', { requestId: 'invented-remove', id: load.id }, at + 12 * 900_000 + 1);
  assert.equal(manager.start(), true);
  let candidate = await ready(manager);
  assert.deepEqual(store.getState('adaptive:mqtt'), old);
  assert.deepEqual(store.learningJournal({ input: 'mqtt', algorithmVersion: LEARNING_ALGORITHM }), journal);
  sample(store, 13);
  assert.equal(manager.takeReady(), null, 'New journal entries request an asynchronous suffix replay');
  candidate = await ready(manager);
  const context = fireplaceLearningContext(store, 'mqtt');
  const expected = store.learningJournal({ input: 'mqtt', algorithmVersion: LEARNING_ALGORITHM })
    .reduce((checkpoint, entry) => applyLearningRecord(checkpoint, entry, context), null);
  assert.deepEqual(candidate.checkpoint, expected);
  assert.ok(validLearningCheckpoint(candidate.checkpoint));
  assert.deepEqual(store.getState('adaptive:mqtt'), old, 'Worker and manager never publish a replacement themselves');
  store.transaction(() => {
    store.setState('adaptive:mqtt', candidate.checkpoint);
    assert.equal(manager.complete(candidate.checkpoint), true);
  });
  assert.equal(manager.status().status, 'current');
});

test('restart restores pending work and source changes invalidate completed worker candidates', { timeout: 30_000 }, async t => {
  const store = new Store(':memory:');
  let manager = new FireplaceRebuildManager({ store, input: 'mqtt' });
  t.after(async () => { await manager.close(); store.close(); });
  const load = addFireplace(store, 'mqtt', { requestId: 'invented-load', kg: 4 }, at);
  for (let i = 1; i <= 4; i++) sample(store, i);
  removeFireplace(store, 'mqtt', { requestId: 'invented-remove', id: load.id }, at + 4 * 900_000 + 1);
  manager.start();
  await manager.close();
  assert.equal(store.getState('fireplace:rebuild:mqtt').status, 'pending');
  manager = new FireplaceRebuildManager({ store, input: 'mqtt' });
  manager.start();
  const first = await ready(manager);
  const extra = addFireplace(store, 'mqtt', { requestId: 'invented-second-load', kg: 6 }, at + 4 * 900_000 + 2);
  assert.equal(manager.takeReady(), null);
  const next = await ready(manager);
  assert.notEqual(next.revision, first.revision);
  assert.equal(next.revision, extra.revision);
  assert.equal(manager.complete(first.checkpoint), false);
});

test('failed rebuild state is durable and late messages from replaced workers cannot publish candidates', async t => {
  const store = new Store(':memory:');
  const workers = [];
  const workerFactory = () => {
    const worker = new EventEmitter();
    worker.postMessage = () => {};
    worker.terminate = async () => 0;
    workers.push(worker); return worker;
  };
  const manager = new FireplaceRebuildManager({ store, input: 'mqtt', workerFactory });
  t.after(async () => { await manager.close(); store.close(); });
  const first = addFireplace(store, 'mqtt', { requestId: 'invented-load', kg: 4 }, at);
  manager.start();
  const second = addFireplace(store, 'mqtt', { requestId: 'invented-other', kg: 4 }, at + 1);
  manager.start();
  workers[0].emit('message', { type: 'ready', revision: first.revision, head: 0, checkpoint: { stale: true } });
  assert.equal(manager.takeReady(), null);
  workers[1].emit('error', new Error('Invented worker failure'));
  assert.equal(manager.status().status, 'failed');
  assert.equal(manager.status().revision, second.revision);
  assert.equal(store.getState('adaptive:mqtt'), null);
});

for (const storage of ['memory', 'disk']) test(`joint sensor and fireplace corrections replay deterministically and catch up (${storage})`,
  { timeout: 30_000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'stmq-joint-rebuild-'));
    const store = new Store(storage === 'memory' ? ':memory:' : join(directory, 'invented.sqlite'));
    const manager = new FireplaceRebuildManager({ store, input: 'mqtt' });
    t.after(async () => { await manager.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    const load = addFireplace(store, 'mqtt', { requestId: 'invented-joint-load', kg: 4 }, at);
    sample(store, 1);
    const change = addSensorChange(store, 'mqtt', { requestId: 'invented-sensor-change', signal: 'outdoor_temperature', reason: 'replacement' }, at + 900_001);
    for (let i = 2; i <= 8; i++) sample(store, i);
    const old = replayLearningJournal(store, 'mqtt');
    revertSensorChange(store, 'mqtt', { requestId: 'invented-sensor-revert', id: change.id }, at + 8 * 900_000 + 1);
    const correction = sensorLearningContext(store, 'mqtt');
    const fireplace = removeFireplace(store, 'mqtt', { requestId: 'invented-joint-remove', id: load.id }, at + 8 * 900_000 + 2);
    assert.equal(manager.status().sensorRevision, correction.sensorRevision, 'A fireplace correction retains the requested sensor correction');
    manager.start();
    let candidate = await ready(manager);
    assert.equal(candidate.revision, fireplace.revision);
    assert.equal(candidate.sensorRevision, correction.sensorRevision);
    assert.equal(candidate.epoch, store.learningEpoch('mqtt'));
    assert.deepEqual(store.getState('adaptive:mqtt'), old);
    sample(store, 9);
    assert.equal(manager.takeReady(), null);
    candidate = await ready(manager);
    const context = { ...fireplaceLearningContext(store, 'mqtt'), ...correction };
    const expected = store.learningJournal({ input: 'mqtt', algorithmVersion: LEARNING_ALGORITHM })
      .reduce((checkpoint, entry) => applyLearningRecord(checkpoint, entry, context), null);
    assert.deepEqual(candidate.checkpoint, expected);
    assert.equal(candidate.checkpoint.measurementEpochAt ?? null, null, 'The reverted reset no longer discards earlier learning');
    assert.equal(candidate.checkpoint.sensorRevision, correction.sensorRevision);
    assert.equal(manager.complete(candidate.checkpoint), true);
    assert.equal(manager.status().sensorRevision, correction.sensorRevision);
  });

test('a later sensor correction invalidates a ready worker even when the fireplace revision is unchanged',
  { timeout: 30_000 }, async t => {
    const store = new Store(':memory:');
    const manager = new FireplaceRebuildManager({ store, input: 'mqtt' });
    t.after(async () => { await manager.close(); store.close(); });
    sample(store, 1);
    const change = addSensorChange(store, 'mqtt', { requestId: 'invented-later-change', signal: 'outdoor_temperature', reason: 'calibration' }, at + 900_001);
    sample(store, 2);
    manager.start();
    const old = await ready(manager);
    revertSensorChange(store, 'mqtt', { requestId: 'invented-later-revert', id: change.id }, at + 1_800_001);
    assert.equal(manager.takeReady(), null);
    const next = await ready(manager);
    assert.equal(next.revision, old.revision);
    assert.ok(next.sensorRevision > old.sensorRevision);
    assert.equal(manager.complete(old.checkpoint), false);
    assert.equal(manager.complete(next.checkpoint), true);
  });

test('epoch switches and stale responses replace workers; failed joint jobs can retry after restart', async t => {
  const store = new Store(':memory:');
  const workers = [];
  const workerFactory = () => {
    const worker = new EventEmitter();
    worker.messages = [];
    worker.postMessage = message => worker.messages.push(message);
    worker.terminate = async () => 0;
    workers.push(worker); return worker;
  };
  let manager = new FireplaceRebuildManager({ store, input: 'mqtt', workerFactory });
  t.after(async () => { await manager.close(); store.close(); });
  const respond = (worker, type = 'ready') => {
    const { revision, sensorRevision, epoch } = worker.messages.at(-1);
    worker.emit('message', { type, revision, sensorRevision, epoch, head: 0, checkpoint: null, processed: 0 });
  };
  manager.start();
  respond(workers[0]);
  assert.ok(manager.takeReady());
  store.db.prepare('INSERT INTO learning_epochs(input,epoch) VALUES(?,?)').run('mqtt', 'invented-recovery');
  assert.equal(manager.takeReady(), null);
  assert.equal(workers.length, 2);
  assert.equal(workers[1].messages[0].epoch, 'invented-recovery');
  respond(workers[0]);
  assert.equal(manager.takeReady(), null, 'The previous epoch cannot publish a late result');
  respond(workers[1], 'stale');
  assert.equal(workers.length, 3, 'A worker reporting stale must be replaced even when revisions match');
  workers[2].emit('error', new Error('Invented correction failure'));
  assert.equal(manager.status().status, 'failed');
  const failed = manager.status();
  await manager.close();
  assert.deepEqual(store.getState('fireplace:rebuild:mqtt'), failed, 'Failure intent is durable');
  manager = new FireplaceRebuildManager({ store, input: 'mqtt', workerFactory });
  assert.equal(manager.start(), true);
  respond(workers[3]);
  const candidate = manager.takeReady();
  assert.equal(candidate.epoch, 'invented-recovery');
  assert.equal(candidate.sensorRevision, 0);
  assert.equal(manager.complete(candidate.checkpoint), true);
  assert.equal(manager.status().status, 'current');
});


test('rebuild teardown preserves durable job intent without waiting for a foreign writer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-rebuild-close-'));
  const store = new Store(join(directory, 'history.sqlite')), writer = new DatabaseSync(store.path);
  let terminated = false;
  class WorkerFixture extends EventEmitter {
    postMessage() {}
    async terminate() { terminated = true; }
  }
  const manager = new FireplaceRebuildManager({ store, input: 'mqtt', workerFactory: () => new WorkerFixture() });
  manager.start();
  writer.exec('BEGIN IMMEDIATE');
  let timeout;
  try {
    await Promise.race([manager.close(), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Rebuild label blocked shutdown')), 1000);
    })]);
    assert.equal(writer.isTransaction, true);
    assert.equal(terminated, true);
    assert.equal(manager.status().status, 'running');
    assert.equal(manager.status().requiresRebuild, true);
    assert.equal(store.writeQueueStatus().pending, 0);
  } finally {
    clearTimeout(timeout); writer.exec('ROLLBACK'); writer.close(); await manager.close(); store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const correction of ['fireplace', 'sensor']) test(`late ${correction} corrections reuse sparse prefixes after compaction and worker restart`,
  { timeout: 30_000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'stmq-late-correction-'));
    const store = new Store(join(directory, 'invented.sqlite'));
    let manager = new FireplaceRebuildManager({ store, input: 'mqtt' });
    t.after(async () => { await manager.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    store.transaction(() => {
      for (let i = 1; i <= 128; i++) {
        if (i <= 16) sample(store, i);
        else appendLearningRecord(store, 'mqtt', 'context', { timestamp: at + i * 900_000,
          phase: 'normal', regime: 'occupied', targetC: 21, roomBoostC: 0 });
      }
    });
    replayLearningJournal(store, 'mqtt');
    for (let index = 0; index < 2; index++) {
      const boundary = 129 + index * 10, affectedAt = at + boundary * 900_000;
      const event = correction === 'fireplace'
        ? addFireplace(store, 'mqtt', { requestId: `invented-late-load-${index}`, kg: 4 }, affectedAt)
        : addSensorChange(store, 'mqtt', { requestId: `invented-late-sensor-${index}`, signal: 'outdoor_temperature', reason: 'replacement' }, affectedAt);
      for (const i of [boundary + 1, boundary + 2]) sample(store, i);
      const old = replayLearningJournal(store, 'mqtt', store.getState('adaptive:mqtt'));
      if (correction === 'fireplace') removeFireplace(store, 'mqtt',
        { requestId: `invented-late-removal-${index}`, id: event.id }, at + (boundary + 3) * 900_000 + 1);
      else revertSensorChange(store, 'mqtt',
        { requestId: `invented-late-reversal-${index}`, id: event.id }, at + (boundary + 3) * 900_000 + 1);
      assert.equal(manager.status().affectedAt, affectedAt, 'a completed earlier correction does not widen this new job');
      store.setState('synthetic-current-bookkeeping', { index });
      store.compactJournal({ maxBytes: 1, maxCommits: 1 });
      if (index === 0) {
        manager.start();
        await manager.close();
        manager = new FireplaceRebuildManager({ store, input: 'mqtt' });
      }
      manager.start();
      let candidate = await ready(manager);
      assert.deepEqual(store.getState('adaptive:mqtt'), old, 'the existing model remains selected during reconstruction');
      assert(manager.status().processed <= 4, 'only the correction suffix was replayed after transaction patches expired');
      sample(store, boundary + 4);
      assert.equal(manager.takeReady(), null);
      candidate = await ready(manager);
      assert(manager.status().processed <= 5, 'catch-up adds the newly committed input without restarting replay');
      assert.deepEqual(candidate.checkpoint, replayLearningJournal(store, 'mqtt', null,
        { rebuild: true, persistCheckpoint: false }), 'sparse replay equals independent replay from the retained seed');
      store.transaction(() => {
        store.setState('adaptive:mqtt', candidate.checkpoint);
        assert.equal(manager.complete(candidate.checkpoint), true);
      });
    }
  });

test('queued catch-up cannot replace a correction candidate while prefix lookup yields', { timeout: 30_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-correction-queue-'));
  const store = new Store(join(directory, 'invented.sqlite'));
  const worker = new Worker(new URL('../src/app/fireplace-worker.js', import.meta.url),
    { workerData: { dbPath: store.path, input: 'mqtt' } });
  t.after(async () => { await worker.terminate(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  for (let i = 1; i <= 16; i++) sample(store, i);
  let checkpoint = replayLearningJournal(store, 'mqtt');
  const affectedAt = at + 16.5 * 900_000;
  const load = addFireplace(store, 'mqtt', { requestId: 'invented-queued-load', kg: 4 }, affectedAt);
  // More than sixteen recent unusable states force the asynchronous prefix
  // lookup to yield before it reaches the unaffected committed boundary.
  for (let i = 17; i <= 48; i++) {
    sample(store, i);
    checkpoint = replayLearningJournal(store, 'mqtt', checkpoint);
  }
  const removed = removeFireplace(store, 'mqtt', { requestId: 'invented-queued-removal', id: load.id }, at + 49 * 900_000);
  const entries = store.learningJournal({ input: 'mqtt', limit: 100 }), last = entries.at(-1).id;
  const replies = [];
  const completed = new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', result => {
      if (result.type === 'failed' || result.type === 'stale') reject(new Error(`Unexpected ${result.type} correction reply`));
      if (result.type === 'ready') { replies.push(result); if (replies.length === 2) resolve(); }
    });
  });
  const selection = { revision: removed.revision, sensorRevision: 0, epoch: store.learningEpoch('mqtt') };
  worker.postMessage({ type: 'rebuild', ...selection, affectedAt, head: last - 1 });
  worker.postMessage({ type: 'catchup', ...selection, head: last });
  await completed;
  const source = fireplaceLearningContext(store, 'mqtt');
  for (const [index, head] of [last - 1, last].entries()) {
    assert.equal(replies[index].head, head, 'responses retain request order and their own journal boundary');
    const expected = entries.filter(entry => entry.id <= head)
      .reduce((model, entry) => applyLearningRecord(model, entry, source), null);
    assert.deepEqual(replies[index].checkpoint, expected);
  }
  assert.equal(replies[1].processed, 32, 'the prefix is reused once and only one later input is caught up');
});

test('shutdown immediately fences replay replies before slower runtime cleanup', async t => {
  const store = new Store(':memory:');
  const worker = new EventEmitter();
  worker.postMessage = () => {}; worker.terminate = async () => 0;
  const manager = new FireplaceRebuildManager({ store, input: 'mqtt', workerFactory: () => worker });
  t.after(async () => { await manager.close(); store.close(); });
  manager.start();
  const state = manager.status(), checkpoint = store.checkpoint();
  manager.beginShutdown();
  worker.emit('message', { type: 'progress', revision: state.revision, sensorRevision: state.sensorRevision,
    epoch: state.epoch, processed: 42, journalCursor: 42 });
  worker.emit('error', new Error('Invented late worker failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(store.checkpoint(), checkpoint);
  assert.deepEqual(manager.status(), state);
  assert.equal(store.writeQueueStatus().pending, 0);
});
