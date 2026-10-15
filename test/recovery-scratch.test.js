import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { verifyJournal } from '../src/storage/journal.js';
import { ScratchMap } from '../src/recovery/scratch.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-recovery-scratch-'));
  const store = new Store(join(directory, 'source.sqlite'));
  const blocker = new DatabaseSync(store.path);
  t.after(async () => {
    blocker.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  store.setState('durable-synthetic-input', { value: 1 });
  return { store, blocker };
}

test('missing scratch deletion stays read-only while MAIN is locked; present deletion retains writer admission', async t => {
  const { store, blocker } = await fixture(t);
  const scratch = new ScratchMap(store.db), other = new ScratchMap(store.db);
  scratch.set('present', { value: 'retained until deletion' });
  other.set('missing', { value: 'different namespace' });
  const checkpoint = store.checkpoint();

  blocker.exec('BEGIN IMMEDIATE');
  try {
    assert.equal(scratch.delete('missing'), false);
    assert.deepEqual(store.checkpoint(), checkpoint);
    assert.throws(() => scratch.delete('present'), { errcode: 5 });
    assert.deepEqual(scratch.get('present'), { value: 'retained until deletion' });
    assert.deepEqual(other.get('missing'), { value: 'different namespace' });
    assert.equal(scratch.size, 1);
  } finally {
    blocker.exec('ROLLBACK');
  }

  assert.equal(scratch.delete('present'), true);
  assert.equal(scratch.delete('present'), false);
  assert.equal(scratch.size, 0);
  assert.deepEqual(other.get('missing'), { value: 'different namespace' });
  assert.deepEqual(store.checkpoint(), checkpoint);
  assert.deepEqual(verifyJournal(store.db).checkpoint, checkpoint);
  assert.deepEqual(store.getState('durable-synthetic-input'), { value: 1 });
});

test('scratch deletion does not decode payloads and serializes its key once', async t => {
  const { store, blocker } = await fixture(t);
  const scratch = new ScratchMap(store.db);
  scratch.initialize();
  store.db.prepare('INSERT INTO recovery_scratch_map(namespace,key,value) VALUES(?,?,?)')
    .run(scratch.namespace, JSON.stringify('invalid-payload'), 'not JSON');
  const checkpoint = store.checkpoint();
  let serializations = 0;
  const key = { toJSON() { serializations++; return 'invalid-payload'; } };

  blocker.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => scratch.delete(key), { errcode: 5 });
    assert.equal(serializations, 1);
    assert.equal(scratch.size, 1);
  } finally {
    blocker.exec('ROLLBACK');
  }

  serializations = 0;
  assert.equal(scratch.delete(key), true);
  assert.equal(serializations, 1);
  assert.equal(scratch.size, 0);
  assert.deepEqual(store.checkpoint(), checkpoint);
  assert.deepEqual(verifyJournal(store.db).checkpoint, checkpoint);
});
