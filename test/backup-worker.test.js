import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import { Store } from '../src/storage/store.js';
import { registerJournalFunctions } from '../src/storage/journal-codec.js';
import { fullVerificationActivity, verifyDatabase } from '../src/storage/full-verifier.js';
import { fixture, observation, start } from './helpers/recovery-fixture.js';

function fill(store, count) {
  const raw = { synthetic: 'x'.repeat(2048) };
  for (let offset = 0; offset < count; offset += 256) store.transaction(() => {
    for (let index = offset; index < Math.min(count, offset + 256); index++) observation(store, start + index * 1000, 20 + index % 2, { raw });
  });
}

for (const damage of ['magic', 'checksum']) test(`restore refuses a damaged WAL ${damage} instead of silently publishing an earlier commit`, async t => {
  const f = fixture(t), source = f.master.path, destination = join(f.directory, 'rejected.sqlite');
  f.master.event('synthetic-before-crash', {}, 1);
  f.master.close();
  const url = new URL('../src/storage/store.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {Store} from ${JSON.stringify(url)};
    const store=new Store(process.argv[1]); store.event('synthetic-committed-wal',{},2);
    process.kill(process.pid,'SIGKILL');`, source]);
  assert.equal(child.signal, 'SIGKILL');
  const reader = new Store(source, { readOnly: true });
  try { assert.equal(reader.events().length, 2); } finally { reader.close(); }
  const wal = readFileSync(`${source}-wal`);
  assert(wal.length > 32);
  wal[damage === 'magic' ? 0 : 24] ^= 0x01;
  writeFileSync(`${source}-wal`, wal);
  const before = ['', '-wal', '-shm'].map(suffix => [suffix, existsSync(`${source}${suffix}`) ? readFileSync(`${source}${suffix}`) : null]);
  await assert.rejects(Store.restore(source, destination), { code: 'backup_source_invalid' });
  for (const [suffix, bytes] of before) {
    if (bytes === null) assert.equal(existsSync(`${source}${suffix}`), false);
    else assert.deepEqual(readFileSync(`${source}${suffix}`), bytes);
  }
  assert.equal(existsSync(destination), false);
  assert.equal(readdirSync(f.directory).some(name => name.startsWith('.sqlite-backup-')), false);
});

for (const damage of ['materialized-content', 'retained-journal']) {
  test(`backup and restore reject ${damage} damage accepted by SQLite structural integrity`, async t => {
    const f = fixture(t), source = join(f.directory, 'source.sqlite');
    f.master.event('synthetic-private-value', { value: 'do not expose' }, 1);
    await f.master.backup(source);
    const raw = new DatabaseSync(source);
    registerJournalFunctions(raw);
    try {
      if (damage === 'materialized-content') raw.exec("BEGIN; UPDATE events SET at=2; DELETE FROM journal_pending; COMMIT");
      if (damage === 'retained-journal') raw.exec("UPDATE journal_changes SET payload='{}' WHERE sequence=1");
      assert.equal(raw.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { raw.close(); }
    await assert.rejects(verifyDatabase({ dbPath: source }));
    const before = readFileSync(source), reader = new Store(source, { readOnly: true });
    try {
      for (const operation of ['backup', 'restore']) {
        const destination = join(f.directory, `${operation}-rejected.sqlite`);
        await assert.rejects(operation === 'backup' ? reader.backup(destination) : Store.restore(source, destination), error => {
          assert.equal(error.code, 'backup_source_invalid');
          assert.doesNotMatch(error.message, /synthetic-private-value|do not expose/);
          return true;
        });
        assert.equal(existsSync(destination), false);
        assert.deepEqual(readFileSync(source), before);
        assert.equal(readdirSync(f.directory).some(name => name.startsWith('.sqlite-backup-')), false);
      }
    } finally { reader.close(); }
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

for (const phase of ['queued', 'checking-journal']) {
  test(`backup cancellation during full verification ${phase} never publishes or leaves a reader`, async t => {
    const f = fixture(t), path = join(f.directory, 'cancelled-verification.sqlite');
    const controller = new AbortController(), reason = new Error('synthetic verifier cancellation');
    let reached = false;
    await assert.rejects(f.master.backup(path, { signal: controller.signal, onProgress(value) {
      if (value.phase === phase) { reached = true; controller.abort(reason); }
    } }), error => error === reason);
    assert(reached);
    assert.equal(existsSync(path), false);
    assert.equal(readdirSync(f.directory).some(name => name.startsWith('.sqlite-backup-')), false);
    assert.equal(fullVerificationActivity().active, null);
    assert.equal(fullVerificationActivity().queued.length, 0);
    f.master.event('after-cancel', {}, 3);
    await f.master.backup(path);
    assert(existsSync(path));
  });
}

test('full verification callback failures preserve the original error and clean backup staging', async t => {
  const f = fixture(t), path = join(f.directory, 'failed-verification.sqlite');
  const failure = new Error('synthetic verification consumer failure');
  await assert.rejects(f.master.backup(path, { onProgress(value) {
    if (value.phase === 'checking-journal') throw failure;
  } }), error => error === failure);
  assert.equal(existsSync(path), false);
  assert.equal(readdirSync(f.directory).some(name => name.startsWith('.sqlite-backup-')), false);
  assert.equal(fullVerificationActivity().active, null);
});

test('backup binds final verification to its pinned source checkpoint before publication', async t => {
  const f = fixture(t), path = join(f.directory, 'changed-boundary.sqlite');
  f.master.event('source-boundary', {}, 1);
  let changed = false;
  await assert.rejects(f.master.backup(path, { onProgress(value) {
    if (value.phase !== 'queued') return;
    const staging = readdirSync(f.directory).find(name => name.startsWith('.sqlite-backup-'));
    const modified = new Store(join(f.directory, staging, 'history.sqlite'));
    try { modified.event('synthetic-staged-drift', {}, 2); changed = true; }
    finally { modified.close(); }
  } }), { code: 'backup_source_invalid' });
  assert(changed);
  assert.equal(f.master.events().length, 1);
  assert.equal(existsSync(path), false);
  assert.equal(readdirSync(f.directory).some(name => name.startsWith('.sqlite-backup-')), false);
});

test('in-memory backup verifies the captured checkpoint and preserves subsequent source writes', async t => {
  const f = fixture(t), memory = new Store(':memory:'), path = join(f.directory, 'memory.sqlite');
  t.after(() => memory.close());
  memory.event('memory-boundary', {}, 1);
  const checkpoint = memory.checkpoint();
  let wrote = false;
  await memory.backup(path, { onProgress(value) {
    if (value.phase === 'validating' && !wrote) { memory.event('after-copy', {}, 2); wrote = true; }
  } });
  assert(wrote);
  assert.equal(memory.events().length, 2);
  const copy = new Store(path, { readOnly: true });
  try { assert.deepEqual(copy.checkpoint(), checkpoint); assert.equal(copy.events().length, 1); }
  finally { copy.close(); }
});

for (const point of ['file', 'directory']) test(`backup ${point} flush failure preserves source and reports publication honestly`, async t => {
  const f = fixture(t), path = join(f.directory, 'flush-failed.sqlite');
  f.master.event('synthetic-preserved-source', {}, 1);
  const before = readFileSync(f.master.path), wal = readFileSync(`${f.master.path}-wal`);
  const original = fs.open;
  let injected = false;
  t.mock.method(fs, 'open', async (...args) => {
    const file = await original(...args), sync = file.sync.bind(file);
    t.mock.method(file, 'sync', async () => {
      if (point === 'directory' ? args[0] === f.directory : args[0].includes('.sqlite-backup-')) {
        injected = true;
        throw Object.assign(new Error('synthetic flush failure'), { code: point === 'file' ? 'ENOSPC' : 'EIO' });
      }
      return sync();
    });
    return file;
  });
  await assert.rejects(f.master.backup(path), { code: point === 'file' ? 'ENOSPC' : 'database_publication_unconfirmed',
    ...(point === 'directory' ? { published: true } : {}) });
  assert(injected);
  assert.equal(existsSync(path), point === 'directory');
  assert.deepEqual(readFileSync(f.master.path), before);
  assert.deepEqual(readFileSync(`${f.master.path}-wal`), wal);
  assert.equal(readdirSync(f.directory).some(name => name.startsWith('.sqlite-backup-')), false);
  if (point === 'directory') {
    const copy = new Store(path, { readOnly: true });
    try { assert.deepEqual(copy.checkpoint(), f.master.checkpoint()); assert.equal(copy.events().length, 1); }
    finally { copy.close(); }
    await assert.rejects(f.master.backup(path), { code: 'database_destination_occupied' });
  }
});
