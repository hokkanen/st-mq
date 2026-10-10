import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { publishLearning, publicationKey } from '../src/app/learning-publication.js';
import { replayLearningJournal } from '../src/app/committed-learning.js';
import { addFireplace } from '../src/app/fireplace.js';
import { sample, start, W } from './helpers/recovery-fixture.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-publication-boundary-'));
  const store = new Store(join(directory, 'history.sqlite'));
  const workers = [], pending = [];
  t.after(async () => {
    for (const worker of workers) await worker.terminate();
    await Promise.allSettled(pending);
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  sample(store, start + W);
  const original = replayLearningJournal(store, 'mqtt', null, { rebuild: true });
  sample(store, start + 2 * W, { indoorC: 21.25 });
  const checkpoint = replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false });
  const candidate = { checkpoint, head: checkpoint.journalCursor, revision: checkpoint.fireplaceRevision ?? 0,
    sensorRevision: checkpoint.sensorRevision ?? 0, epoch: store.learningEpoch('mqtt'),
    selection: store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation };
  store.setState('fireplace:rebuild:mqtt', { status: 'ready', requiresRebuild: true,
    revision: candidate.revision, sensorRevision: candidate.sensorRevision, epoch: candidate.epoch });
  store.setState('pending-plan:mqtt', { fixture: 'prior-plan' });
  const launch = (mode, options = {}) => {
    const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    let reached;
    const boundary = new Promise(resolve => { reached = resolve; });
    const workerFactory = settings => {
      const worker = new Worker(new URL('./helpers/learning-publication-worker.js', import.meta.url), {
        ...settings, workerData: { ...settings.workerData, testBoundary: { mode, gate: gate.buffer } },
      });
      workers.push(worker);
      worker.on('message', message => { if (message?.type === 'test-boundary') reached(message.phase); });
      return worker;
    };
    const publication = publishLearning({ store, input: 'mqtt', kind: 'correction', message: candidate,
      workerFactory, ...options });
    pending.push(publication);
    // Failed publication remains observable without an unhandled rejection
    // while the test checks the independently controlled worker boundary.
    void publication.catch(() => {});
    return { publication, boundary, release() { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); } };
  };
  return { store, original, checkpoint, candidate, launch, workers };
}

test('publication keeps queued controller writes behind committed model adoption', { timeout: 20_000 }, async t => {
  const f = fixture(t);
  let adopted = null, ran = false;
  const task = f.launch('after-commit', { onPublish: value => { adopted = value.checkpoint; } });
  assert.equal(await task.boundary, 'after-commit');
  assert.deepEqual(f.store.getState('adaptive:mqtt'), f.checkpoint, 'the worker has committed before its reply');
  assert.equal(adopted, null);
  const next = f.store.runWrite(() => {
    ran = true;
    assert.deepEqual(adopted, f.checkpoint, 'next update sees the adopted model');
    assert.equal(f.store.getState('pending-plan:mqtt'), null);
    f.store.event('synthetic-controller-after-publication', {}, start + 3 * W);
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ran, false, 'writer admission remains reserved while reply is delayed');
  task.release();
  await task.publication; await next;
  assert.equal(ran, true);
});

test('committed receipt recovers a lost worker reply and abnormal exit before releasing updates', { timeout: 20_000 }, async t => {
  const f = fixture(t);
  let adopted;
  const task = f.launch('lost-reply', { onPublish: value => { adopted = value.checkpoint; } });
  const result = await task.publication;
  assert.deepEqual(result.checkpoint, f.checkpoint);
  assert.deepEqual(adopted, f.checkpoint);
  assert.equal(f.store.getState('fireplace:rebuild:mqtt').status, 'current');
  const restarted = new Store(f.store.path, { readOnly: true });
  try {
    assert.deepEqual(replayLearningJournal(restarted, 'mqtt', restarted.getState('adaptive:mqtt'),
      { persistCheckpoint: false }), f.checkpoint);
  } finally { restarted.close(); }
});

test('cancellation before publication commit joins the worker and preserves previous state', { timeout: 20_000 }, async t => {
  const f = fixture(t), cancel = new AbortController();
  let adopted = false;
  const task = f.launch('before-commit', { signal: cancel.signal, onPublish: () => { adopted = true; } });
  assert.equal(await task.boundary, 'before-commit');
  cancel.abort();
  await assert.rejects(task.publication);
  assert.equal(f.workers[0].threadId, -1, 'cancelled writer has exited before publication settles');
  assert.equal(adopted, false);
  assert.deepEqual(f.store.getState('adaptive:mqtt'), f.original);
  assert.equal(f.store.getState(publicationKey('mqtt')), null);
  assert.equal(f.store.getState('fireplace:rebuild:mqtt').status, 'ready');
  await f.store.runWrite(() => f.store.event('synthetic-controller-after-cancellation', {}, start + 3 * W));
});

test('cancellation after commit still adopts the durable result and joins before releasing updates', { timeout: 20_000 }, async t => {
  const f = fixture(t), cancel = new AbortController();
  let adopted;
  const task = f.launch('after-commit', { signal: cancel.signal, onPublish: value => { adopted = value.checkpoint; } });
  assert.equal(await task.boundary, 'after-commit');
  cancel.abort();
  const next = f.store.runWrite(() => {
    assert.equal(f.workers[0].threadId, -1);
    assert.deepEqual(adopted, f.checkpoint);
  });
  await task.publication; await next;
  assert.deepEqual(f.store.getState('adaptive:mqtt'), f.checkpoint);
});

test('failed atomic publication rolls back checkpoint, status, plan and receipt together', { timeout: 20_000 }, async t => {
  const f = fixture(t);
  let adopted = false;
  const task = f.launch('rollback', { onPublish: () => { adopted = true; } });
  await assert.rejects(task.publication);
  assert.equal(adopted, false);
  assert.deepEqual(f.store.getState('adaptive:mqtt'), f.original);
  assert.equal(f.store.getState('fireplace:rebuild:mqtt').status, 'ready');
  assert.deepEqual(f.store.getState('pending-plan:mqtt'), { fixture: 'prior-plan' });
  assert.equal(f.store.getState(publicationKey('mqtt')), null);
  const result = await f.launch('normal').publication;
  assert.deepEqual(result.checkpoint, f.checkpoint, 'the same intact candidate can be explicitly retried');
});

test('outer and nested rollback never start a publication worker', async t => {
  const f = fixture(t);
  let outer, nested;
  await assert.rejects(f.store.runWrite(() => {
    outer = f.launch('normal').publication;
    throw new Error('outer rollback');
  }), /outer rollback/);
  await assert.rejects(outer, { code: 'STORAGE_WRITE_ROLLED_BACK' });
  await f.store.runWrite(() => {
    assert.throws(() => f.store.transaction(() => {
      nested = f.launch('normal').publication;
      throw new Error('savepoint rollback');
    }), /savepoint rollback/);
  });
  await assert.rejects(nested, { code: 'STORAGE_WRITE_ROLLED_BACK' });
  assert.equal(f.workers.length, 0);
  assert.deepEqual(f.store.getState('adaptive:mqtt'), f.original);
});

for (const changed of ['journal head', 'fireplace revision', 'selected history', 'learning epoch'])
test(`publication rejects an obsolete ${changed} without replacing the active model`, { timeout: 20_000 }, async t => {
  const f = fixture(t);
  if (changed === 'journal head') sample(f.store, start + 3 * W);
  else if (changed === 'fireplace revision') addFireplace(f.store, 'mqtt', { requestId: 'synthetic-source-edit', kg: 2 }, start);
  else if (changed === 'selected history') f.store.db.prepare('UPDATE history_selection SET generation=? WHERE id=1').run(randomUUID());
  else f.store.db.prepare('INSERT INTO learning_epochs(input,epoch) VALUES(?,?) ON CONFLICT(input) DO UPDATE SET epoch=excluded.epoch')
    .run('mqtt', randomUUID());
  let adopted = false;
  const task = f.launch('normal', { onPublish: () => { adopted = true; } });
  assert.equal(await task.publication, null);
  assert.equal(adopted, false);
  assert.deepEqual(f.store.getState('adaptive:mqtt'), f.original);
  assert.equal(f.store.getState(publicationKey('mqtt')), null);
});

test('closing write admission cancels and joins an active publication worker', { timeout: 20_000 }, async t => {
  const f = fixture(t);
  let adopted = false;
  const task = f.launch('before-commit', { onPublish: () => { adopted = true; } });
  assert.equal(await task.boundary, 'before-commit');
  const queued = f.store.runWrite(() => assert.fail('closed queue ran pending update'));
  void queued.catch(() => {});
  f.store.writeQueue.close();
  await assert.rejects(queued, { code: 'STORAGE_CLOSED' });
  await assert.rejects(task.publication);
  assert.equal(f.workers[0].threadId, -1);
  assert.equal(adopted, false);
  assert.deepEqual(f.store.getState('adaptive:mqtt'), f.original);
  assert.equal(f.store.getState(publicationKey('mqtt')), null);
});
