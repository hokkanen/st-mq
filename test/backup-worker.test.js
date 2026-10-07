import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { fixture, observation, start } from './helpers/recovery-fixture.js';

function fill(store, count) {
  const raw = { synthetic: 'x'.repeat(2048) };
  store.transaction(() => {
    for (let index = 0; index < count; index++) observation(store, start + index * 1000, 20 + index % 2, { raw });
  });
}

test('backup pins one complete WAL snapshot while continuous local recording advances', async t => {
  const f = fixture(t), count = 2048;
  fill(f.master, count);
  f.master.setState('synthetic-backup-boundary', 'before');
  const path = join(f.directory, 'portable.sqlite');
  let writes = 0, pinned = false;
  const progress = [], timer = setInterval(() => {
    f.master.event('synthetic-continued-recording', { sequence: ++writes });
  }, 2);
  try {
    await f.master.backup(path, { signal: t.signal, onProgress(value) {
      progress.push(value);
      if (value.phase === 'snapshotting' && !pinned) {
        pinned = true;
        f.master.transaction(() => {
          observation(f.master, start + count * 1000, 22);
          f.master.setState('synthetic-backup-boundary', 'after');
        });
      }
    } });
  } finally { clearInterval(timer); }
  assert(pinned, 'copy reports when its consistent snapshot has been pinned');
  assert(writes > 1, 'recording continues while the copy is validated and produced');
  assert.equal(f.master.getState('synthetic-backup-boundary'), 'after');
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM observations').get().n, count + 1);
  const copy = new Store(path, { readOnly: true });
  try {
    assert.equal(copy.getState('synthetic-backup-boundary'), 'before');
    assert.equal(copy.db.prepare('SELECT COUNT(*) n FROM observations').get().n, count);
    assert.equal(copy.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(copy.db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  } finally { copy.close(); }
  const pages = progress.filter(value => value.unit === 'pages');
  assert(pages.length > 0, 'the copy reports measured page progress');
  assert(pages.every(value => value.total > 0 && value.processed >= 0 && value.processed <= value.total));
  assert(pages.some(value => value.processed === value.total));
  assert(progress.some(value => value.phase === 'validating'));
  assert(progress.some(value => value.phase === 'finalizing'));
  assert.equal(existsSync(`${path}-wal`), false);
  assert.equal(existsSync(`${path}-shm`), false);
});

test('cancelling a worker backup leaves no published or staging file and preserves the source', async t => {
  const f = fixture(t); fill(f.master, 1024);
  const path = join(f.directory, 'cancelled.sqlite'), controller = new AbortController();
  const reason = new Error('synthetic cancelled backup');
  let copying = false;
  await assert.rejects(f.master.backup(path, { signal: controller.signal, onProgress(value) {
    if (value.phase === 'snapshotting' && !copying) { copying = true; controller.abort(reason); }
  } }), error => error === reason);
  assert(copying);
  assert.equal(existsSync(path), false, 'the incomplete copy has no final filename');
  assert.equal(readdirSync(f.directory).some(name => name.startsWith('.sqlite-backup-')), false,
    'the aborted worker releases its SQLite handles before staging cleanup');
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 1024);
  observation(f.master, start + 2_000_000, 23);
  assert.equal(f.master.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  await f.master.backup(path, { signal: t.signal });
  assert(existsSync(path), 'a later explicit backup succeeds after cancellation');
});

test('pre-cancelled and failed progress callbacks cleanly release backup resources', async t => {
  const f = fixture(t); fill(f.master, 1024);
  const cancelled = new AbortController(), reason = new Error('synthetic cancellation before work');
  cancelled.abort(reason);
  const destination = join(f.directory, 'pre-cancelled.sqlite');
  let progress = 0;
  await assert.rejects(f.master.backup(destination, { signal: cancelled.signal,
    onProgress() { progress++; } }), error => error === reason);
  assert.equal(progress, 0);
  assert.equal(existsSync(destination), false);
  const failed = join(f.directory, 'failed-progress.sqlite'), failure = new Error('synthetic progress failure');
  await assert.rejects(f.master.backup(failed, { onProgress(value) {
    if (value.phase === 'snapshotting') throw failure;
  } }), error => error === failure);
  assert.equal(existsSync(failed), false);
  assert.equal(readdirSync(f.directory).some(name => name.startsWith('.sqlite-backup-')), false);
  await f.master.backup(destination);
  assert(existsSync(destination));
  assert.equal(f.master.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
