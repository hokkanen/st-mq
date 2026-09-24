import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { createAppServer } from '../src/app/server.js';

async function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stmq-export-test-'));
  const store = new Store(join(dir, 'live.sqlite'));
  const server = createAppServer({ store, engine: {}, chartService: { overview() {} }, ...overrides });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, dir, url: `http://127.0.0.1:${server.address().port}/api/database-export` };
}

test('export includes committed WAL state as an independently readable SQLite file', async t => {
  const { store, dir, url } = await fixture(t);
  store.db.exec('PRAGMA wal_autocheckpoint=0');
  store.setState('fixture-export', { latest: 42 });
  store.event('fixture-event', { value: 7 }, 1000);
  assert(readdirSync(dir).includes('live.sqlite-wal'));
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="stmq-.*\.sqlite"$/);
  const isolated = join(dir, 'download.sqlite');
  writeFileSync(isolated, Buffer.from(await response.arrayBuffer()));
  const copy = new DatabaseSync(isolated, { readOnly: true });
  try {
    assert.equal(copy.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(copy.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert(!readdirSync(dir).some(name => /^download.sqlite-(wal|shm)$/.test(name)), 'A read-only export creates no companion files');
    assert.deepEqual(JSON.parse(copy.prepare("SELECT value FROM state WHERE key='fixture-export'").get().value), { latest: 42 });
    assert.equal(copy.prepare('SELECT COUNT(*) n FROM events').get().n, 1);
  } finally { copy.close(); }
  assert.equal(store.getState('fixture-export').latest, 42);
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal', 'Export never changes the live journal mode');
});

test('export enforces authentication and rechecks revocation after a pending backup', async t => {
  let access = { enabled: true, token: 'fixture-export-token', tokenRequired: true };
  const { store, url } = await fixture(t, { getAccess: () => access });
  assert.equal((await fetch(url)).status, 401);
  const original = store.backup.bind(store);
  store.backup = async path => { await original(path); access = { ...access, enabled: false }; };
  const response = await fetch(url, { headers: { Authorization: 'Bearer fixture-export-token' } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('content-disposition'), null);
});

test('an export holds a replica snapshot until streaming finishes', async t => {
  let released = 0, finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const { store, url } = await fixture(t, { role: 'replica', getReadContext: async () => ({ store, engine: {}, release: () => { released++; finish(); } }) });
  store.setState('replica-value', 9);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  await completed;
  assert.equal(released, 1);
});

test('concurrent exports are bounded and a completed download releases the slot', async t => {
  let requests = 0, completed;
  const finished = new Promise(resolve => { completed = resolve; });
  const { store, url } = await fixture(t, { getReadContext: async () => {
    const request = ++requests;
    return { store, engine: {}, release: () => { if (request === 1) completed(); } };
  } });
  let release, begun;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { begun = resolve; });
  const original = store.backup.bind(store);
  store.backup = async path => { begun(); await pending; return original(path); };
  const first = fetch(url);
  try {
    await started;
    const second = await fetch(url);
    assert.equal(second.status, 409);
    assert.match((await second.json()).error, /already in progress/);
  } finally { release(); }
  const response = await first;
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  await finished;
  store.backup = original;
  const again = await fetch(url);
  assert.equal(again.status, 200);
  await again.arrayBuffer();
});
