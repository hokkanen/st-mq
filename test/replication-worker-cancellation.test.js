import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { databaseCheckpoint } from '../src/replication/incremental.js';

test('checkpoint worker cancellation preserves its cause and leaves valid history usable', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-checkpoint-cancel-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'current.sqlite'), store = new Store(path);
  store.setState('synthetic:checkpoint-input', { value: 1 });
  const checkpoint = store.checkpoint(); await store.close();
  for (const code of ['authority_changed', 'stopped']) {
    const controller = new AbortController(), reason = Object.assign(new Error('Synthetic cancellation'), { code });
    const request = databaseCheckpoint({ dbPath: path, signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(request, error => error === reason,
      'Worker exit during termination must not manufacture a verification failure');
    assert.deepEqual(await databaseCheckpoint({ dbPath: path }), checkpoint);
  }
});

test('invalid storage without cancellation still fails checkpoint verification', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-checkpoint-invalid-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'invalid.sqlite'); writeFileSync(path, Buffer.alloc(1024));
  await assert.rejects(databaseCheckpoint({ dbPath: path }), { code: 'database_integrity_failed' });
});
