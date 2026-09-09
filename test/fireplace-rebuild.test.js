import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { addFireplace, removeFireplace, FireplaceRebuildManager } from '../src/app/fireplace.js';
import { fireplaceLearningContext } from '../src/app/fireplace-inputs.js';
import { appendLearningRecord, applyLearningRecord, replayLearningJournal, LEARNING_ALGORITHM, validLearningCheckpoint } from '../src/app/committed-learning.js';

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
