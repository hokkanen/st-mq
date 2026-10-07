import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishDatabaseFile } from '../src/storage/publication.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-publication-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const staging = join(directory, 'staging.sqlite'), destination = join(directory, 'complete.sqlite');
  writeFileSync(staging, 'complete synthetic snapshot', { mode: 0o600 });
  return { directory, staging, destination };
}

function interceptSync(t, inspect) {
  const original = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const file = await original(...args), sync = file.sync.bind(file);
    t.mock.method(file, 'sync', async () => { await inspect(args[0]); return sync(); });
    return file;
  });
}

test('database publication flushes complete contents before exposing the name and the parent before success', async t => {
  const { directory, staging, destination } = fixture(t), flushed = [];
  interceptSync(t, path => {
    flushed.push(path);
    if (path === staging) assert.equal(existsSync(destination), false);
    if (path === directory) assert.equal(readFileSync(destination, 'utf8'), 'complete synthetic snapshot');
  });
  assert.equal(await publishDatabaseFile(staging, destination), destination);
  assert.deepEqual(flushed, [staging, directory]);
});

test('a failed file flush never exposes an incomplete destination', async t => {
  const { staging, destination } = fixture(t);
  interceptSync(t, path => { if (path === staging) throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' }); });
  await assert.rejects(publishDatabaseFile(staging, destination), { code: 'ENOSPC' });
  assert.equal(existsSync(destination), false);
  assert.equal(readFileSync(staging, 'utf8'), 'complete synthetic snapshot');
});

test('a failed parent flush reports unconfirmed publication and retains the completed copy', async t => {
  const { directory, staging, destination } = fixture(t);
  interceptSync(t, path => { if (path === directory) throw Object.assign(new Error('synthetic I/O failure'), { code: 'EIO' }); });
  await assert.rejects(publishDatabaseFile(staging, destination), { code: 'database_publication_unconfirmed', published: true });
  assert.equal(readFileSync(destination, 'utf8'), 'complete synthetic snapshot');
  await assert.rejects(publishDatabaseFile(staging, destination), { code: 'database_destination_occupied' });
});

test('publication preserves existing and concurrently created filenames and all SQLite companions', async t => {
  const { staging, destination } = fixture(t);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const occupied = `${destination}${suffix}`;
    writeFileSync(occupied, 'existing owner');
    await assert.rejects(publishDatabaseFile(staging, destination), { code: 'database_destination_occupied' });
    assert.equal(readFileSync(occupied, 'utf8'), 'existing owner');
    rmSync(occupied);
    symlinkSync(join(destination, 'missing'), occupied);
    await assert.rejects(publishDatabaseFile(staging, destination), { code: 'database_destination_occupied' });
    rmSync(occupied);
  }
  const original = fs.link;
  t.mock.method(fs, 'link', async (...args) => { writeFileSync(destination, 'concurrent owner'); return original(...args); });
  await assert.rejects(publishDatabaseFile(staging, destination), { code: 'EEXIST' });
  assert.equal(readFileSync(destination, 'utf8'), 'concurrent owner');
});

test('publication refuses a symlink as its completed source', async t => {
  const { staging, destination } = fixture(t), linked = `${staging}.link`;
  symlinkSync(staging, linked);
  await assert.rejects(publishDatabaseFile(linked, destination));
  assert.equal(existsSync(destination), false);
  assert.equal(readFileSync(staging, 'utf8'), 'complete synthetic snapshot');
});
