import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { createWriteScope } from '../src/storage/write-scope.js';

test('cancelling one runtime removes only its queued writes and cannot be reversed by later graceful shutdown', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-write-scope-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  const competitor = new DatabaseSync(store.path);
  const owner = () => createWriteScope({ runWrite: (fn, options) => store.runWrite(fn, options) });
  const first = owner(), second = owner();
  let locked = false;
  t.after(() => {
    first.close(); second.close();
    if (locked) competitor.exec('ROLLBACK');
    competitor.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  competitor.exec('BEGIN IMMEDIATE'); locked = true;
  const obsolete = first.run(() => store.setState('obsolete-runtime', true));
  const rejected = assert.rejects(obsolete, { code: 'STORAGE_WRITE_CANCELLED' });
  const current = second.run(() => store.setState('current-runtime', true));
  assert.equal(store.writeQueueStatus().pending, 2);
  first.beginShutdown({ restore: false });
  first.beginShutdown({ restore: true });
  await rejected;
  await assert.rejects(first.run(() => store.setState('obsolete-runtime', true)), { code: 'STORAGE_WRITE_CANCELLED' });
  assert.equal(store.writeQueueStatus().pending, 1);
  competitor.exec('ROLLBACK'); locked = false;
  await current;
  assert.equal(store.getState('obsolete-runtime'), null);
  assert.equal(store.getState('current-runtime'), true);
});
