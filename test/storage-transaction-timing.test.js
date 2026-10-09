import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';

const block = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

test('runtime timing separates slow COMMIT and transaction work without recording diagnostics into history', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const execute = store.db.exec.bind(store.db);
  store.db.exec = sql => { if (sql === 'COMMIT') block(25); return execute(sql); };
  store.transaction(() => store.setState('timing-fixture', 1));
  const commit = store.writeHealth.status().transactions;
  assert(commit.commitMs.last >= 20);
  assert(commit.totalMs.last >= commit.commitMs.last);
  store.db.exec = execute;
  store.transaction(() => { block(30); store.setState('timing-fixture', 2); });
  const body = store.writeHealth.status().transactions;
  assert(body.bodyMs.last >= 25);
  assert(body.totalMs.last >= body.bodyMs.last);
  assert.equal(body.committed, commit.committed + 1);
  const checkpoint = store.checkpoint();
  for (let n = 0; n < 100; n++) store.writeHealth.status();
  assert.deepEqual(store.checkpoint(), checkpoint, 'reading runtime timings has no durable side effects');
  assert.equal(store.getState('timing-fixture'), 2);
});

test('failed transactions and failed postcommit observers have distinct truthful timing outcomes', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const before = store.writeHealth.status().transactions;
  assert.throws(() => store.transaction(() => { store.setState('discarded', true); throw new Error('private-fixture-marker'); }));
  const failed = store.writeHealth.status().transactions;
  assert.equal(failed.count, before.count + 1); assert.equal(failed.committed, before.committed);
  assert.equal(store.getState('discarded'), null);
  assert.throws(() => store.transaction(() => {
    store.setState('committed', true); store.afterCommit(() => { throw new Error('private-fixture-marker'); });
  }), { code: 'STORAGE_COMMIT_EFFECT_FAILED', committed: true });
  const committed = store.writeHealth.status().transactions;
  assert.equal(committed.committed, before.committed + 1);
  assert.equal(store.getState('committed'), true);
  assert.equal(JSON.stringify(store.writeHealth.status()).includes('private-fixture-marker'), false);
});

test('timing samples remain bounded and diagnostic failure cannot undo a real commit', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (let n = 0; n < 150; n++) store.transaction(() => store.setState('bounded-timing', n));
  const timing = store.writeHealth.status().transactions;
  assert.equal(timing.sampleCount, 128); assert.equal(timing.sampleLimit, 128);
  assert(timing.count >= 150); assert(timing.committed >= 150);
  assert(timing.totalMs.max >= timing.totalMs.p99);
  store.writeHealth.transaction = () => { throw new Error('synthetic diagnostic failure'); };
  store.transaction(() => store.setState('diagnostic-independent', true));
  assert.equal(store.getState('diagnostic-independent'), true);
});

test('asynchronous writer admission remains distinct from synchronous SQLite timing', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-timing-admission-'));
  const store = new Store(join(directory, 'history.sqlite')), blocker = new DatabaseSync(store.path);
  let locked = false;
  t.after(() => { if (locked) blocker.exec('ROLLBACK'); blocker.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  blocker.exec('BEGIN IMMEDIATE'); locked = true;
  const before = store.writeHealth.status().transactions;
  const pending = store.runWrite(() => store.setState('after-lock', true));
  const waiting = store.writeHealth.status();
  assert.equal(waiting.queue.pending, 1); assert.notEqual(waiting.queue.waitingSince, null);
  assert.equal(waiting.transactions.committed, before.committed);
  assert.equal(waiting.failing, false, 'admission contention is not a failed attempted write');
  blocker.exec('ROLLBACK'); locked = false;
  await pending;
  const after = store.writeHealth.status();
  assert.equal(after.queue.pending, 0); assert.equal(after.queue.waitingSince, null);
  assert.equal(after.transactions.committed, before.committed + 1);
  assert.equal(store.getState('after-lock'), true);
});
