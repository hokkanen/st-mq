import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Store } from '../src/storage/store.js';
import { WriterClient } from '../src/storage/writer-client.js';
import { verifyJournal } from '../src/storage/journal.js';
import { enrollJournalPeer, peerAnchor } from '../src/storage/journal-peer.js';
import { validateArchivedLearningCheckpointStorage } from '../src/storage/learning-checkpoint-archive.js';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-writer-audit-'));
  const store = new Store(join(directory, 'history.sqlite'));
  t.after(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await store.startWriter();
  return store;
}

test('independent audit: idle worker death fences admission while preserving committed reads', async t => {
  const store = await fixture(t);
  await store.runWrite(() => store.setState('durable', true));
  await store.writer.worker.terminate();
  assert.equal(store.canDispatch(), false);
  assert.equal(store.getState('durable'), true);
  let calls = 0;
  await assert.rejects(store.runWrite(() => calls++), { code: 'STORAGE_WRITER_FAILED' });
  assert.equal(calls, 0);
  assert.equal(store.writePending, false);
});

test('independent audit: lost BEGIN reply never invokes callback and joins the dead connection', async t => {
  const store = await fixture(t), request = store.writer.request.bind(store.writer);
  store.writer.request = async (operation, ...args) => {
    const result = await request(operation, ...args);
    if (operation === 'begin') {
      await store.writer.worker.terminate();
      throw store.writer.failed;
    }
    return result;
  };
  let calls = 0;
  await assert.rejects(store.runWrite(() => calls++), { code: 'STORAGE_WRITER_UNAVAILABLE' });
  assert.equal(calls, 0);
  assert.equal(store.writer.terminated, true);
  assert.equal(store.writePending, false);
  assert.equal(store.canDispatch(), false);
});

test('independent audit: lost no-op COMMIT reply cannot authorize effects from an unchanged checkpoint', async t => {
  const store = await fixture(t), request = store.writer.request.bind(store.writer);
  const before = store.checkpoint(), effects = [];
  store.writer.request = async (operation, ...args) => {
    const result = await request(operation, ...args);
    if (operation === 'commit') {
      await store.writer.worker.terminate();
      throw store.writer.failed;
    }
    return result;
  };
  await assert.rejects(store.runWrite(() => {
    store.afterCommit(() => effects.push('commit'));
    store.afterRollback(() => effects.push('rollback'));
  }), { code: 'STORAGE_WRITER_UNAVAILABLE' });
  assert.deepEqual(store.checkpoint(), before);
  assert.deepEqual(effects, ['rollback']);
  assert.equal(store.writerFailed, true);
  assert.equal(store.canDispatch(), false);
});

test('independent audit: synchronous transaction in a committed effect retains subsequent parent effects', async t => {
  const store = await fixture(t), effects = [];
  await store.runWrite(() => {
    store.setState('parent', true);
    store.afterCommit(() => {
      effects.push('parent-first');
      store.transaction(() => {
        store.setState('child', true);
        store.afterCommit(() => effects.push('child'));
      });
    });
    store.afterCommit(() => effects.push('parent-last'));
  });
  assert.deepEqual(effects, ['parent-first', 'child', 'parent-last']);
  assert.equal(store.getState('parent'), true);
  assert.equal(store.getState('child'), true);
  assert.equal(verifyJournal(store.db).commits, 2);
});

test('independent audit: a stale wake cannot complete a synchronous request before its response publishes', async t => {
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { serialize, deserialize } = require('node:v8');
    const signal = new Int32Array(workerData.syncSignal);
    const response = new Uint8Array(workerData.syncResponse);
    let calls = 0;
    workerData.syncPort.on('message', bytes => {
      const { id } = deserialize(bytes);
      calls++;
      // A notification from a previous request can arrive after the next
      // request reset its flag. Notification alone never publishes new data.
      Atomics.notify(signal, 0);
      setTimeout(() => {
        const bytes = serialize({ id, ok: true, result: { state: 'published', calls } });
        response.set(bytes);
        Atomics.store(signal, 1, bytes.byteLength);
        Atomics.store(signal, 0, 1);
        Atomics.notify(signal, 0);
      }, 15);
    });
    parentPort.postMessage(serialize({ type: 'ready', ok: true }));
  `;
  const client = new WriterClient({ path: '/synthetic-only.sqlite',
    workerFactory: options => new Worker(workerSource, { ...options, eval: true }) });
  t.after(() => client.terminate());
  await client.ready;
  assert.deepEqual(client.call('statement', { sql: 'SELECT 1', method: 'get' }), { state: 'published', calls: 1 });
});

test('independent audit: back-to-back shared responses retain independent blob values and correct statement results', async t => {
  const store = await fixture(t);
  await store.runWrite(() => {
    const blob = store.db.prepare("SELECT X'010203' AS payload").get().payload;
    for (let index = 0; index < 128; index++)
      assert.equal(store.db.prepare('SELECT ? AS n').get(index).n, index);
    assert.deepEqual([...blob], [1, 2, 3]);
  });
});

test('independent audit: current journal compaction remains available after writer activation', async t => {
  const store = await fixture(t);
  for (let index = 0; index < 4; index++) await store.runWrite(() => store.setState('compacted', index));
  const head = store.checkpoint();
  store.compactJournal({ maxBytes: 1, maxCommits: 1 });
  assert.deepEqual(store.checkpoint(), head);
  assert.equal(store.getState('compacted'), 3);
  assert.ok(store.journalBase().sequence > 0);
  assert.equal(verifyJournal(store.db).commits, 1);
});

test('independent audit: native-only peer enrollment rejects a runtime facade before changing its checkpoint', async t => {
  const store = await fixture(t);
  await store.runWrite(() => store.setState('peer', true));
  const checkpoint = store.checkpoint();
  assert.throws(() => enrollJournalPeer(store.db), { code: 'journal_worker_required' });
  assert.throws(() => validateArchivedLearningCheckpointStorage(store.db), { code: 'journal_worker_required' });
  assert.equal(peerAnchor(store.db), null);
  assert.deepEqual(store.checkpoint(), checkpoint);
  assert.equal(verifyJournal(store.db).commits, 1);
});

test('independent audit: close joins writer startup cleanup before exposing a completed shutdown', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-writer-start-close-'));
  const store = new Store(join(directory, 'history.sqlite'));
  let startupSettled = false;
  const starting = store.startWriter().finally(() => { startupSettled = true; });
  void starting.catch(() => {});
  t.after(async () => {
    await starting.catch(() => {});
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await store.close();
  assert.equal(startupSettled, true);
  await assert.rejects(starting, { code: 'STORAGE_CLOSED' });
  assert.equal(store.db.isOpen, false);
});
