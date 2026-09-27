import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { once } from 'node:events';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { createAppServer } from '../src/app/server.js';

const filenamePattern = /^stmq-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?\.sqlite$/;
const saveCopy = (url, options = {}) => fetch(url, {
  method: 'POST', body: '{}', ...options,
  headers: { 'Content-Type': 'application/json', ...options.headers },
});

async function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stmq-export-test-'));
  const exportDirectory = join(dir, 'saved-copies');
  const store = new Store(join(dir, 'live.sqlite'));
  const server = createAppServer({ store, engine: {}, chartService: { overview() {} },
    getDatabaseExportDirectory: () => exportDirectory, ...overrides });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, dir, server, exportDirectory, url: `http://127.0.0.1:${server.address().port}/api/database-export` };
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
  assert.match(response.headers.get('content-disposition')?.match(/^attachment; filename="([^"]+)"$/)?.[1], filenamePattern);
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

test('save local copy publishes a private standalone snapshot with committed WAL data in the configured directory', async t => {
  const { store, dir, exportDirectory, url } = await fixture(t);
  store.db.exec('PRAGMA wal_autocheckpoint=0');
  store.setState('saved-export', { latest: 73 });
  store.event('saved-event', { value: 12 }, 2000);
  assert(readdirSync(dir).includes('live.sqlite-wal'));
  const before = Date.now();
  const response = await saveCopy(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-disposition'), null);
  const saved = await response.json();
  assert.deepEqual(Object.keys(saved).sort(), ['filename', 'path']);
  assert.match(saved.filename, filenamePattern);
  assert.equal(saved.path, join(exportDirectory, saved.filename));
  const timestamp = saved.filename.replace(/^stmq-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.sqlite$/, '$1T$2:$3:$4.$5Z');
  assert(Date.parse(timestamp) >= before && Date.parse(timestamp) <= Date.now());
  assert.equal(statSync(exportDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(saved.path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(exportDirectory), [saved.filename], 'No incomplete files or staging directories remain');
  const copy = new DatabaseSync(saved.path, { readOnly: true });
  try {
    assert.equal(copy.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(copy.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(JSON.parse(copy.prepare("SELECT value FROM state WHERE key='saved-export'").get().value).latest, 73);
    assert.equal(copy.prepare('SELECT COUNT(*) n FROM events').get().n, 1);
  } finally { copy.close(); }
  assert.deepEqual(readdirSync(exportDirectory), [saved.filename], 'A read-only saved copy creates no WAL/SHM companions');
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  store.setState('saved-export', { latest: 74 });
  assert.equal(store.getState('saved-export').latest, 74, 'Recording can continue after saving a copy');
});

test('save requests reject unknown fields, invalid JSON shapes, non-JSON and cross-origin requests before backup', async t => {
  const { store, exportDirectory, url } = await fixture(t);
  let backups = 0;
  store.backup = async () => { backups++; throw new Error('Backup must not start'); };
  for (const payload of [null, [], 4, '', { path: '/invented/destination.sqlite' }, { filename: 'chosen.sqlite' }, { action: 'save' }]) {
    assert.equal((await saveCopy(url, { body: JSON.stringify(payload) })).status, 400);
  }
  assert.equal((await saveCopy(url, { body: '{' })).status, 400);
  assert.equal((await saveCopy(url, { headers: { 'Content-Type': 'text/plain' } })).status, 400);
  assert.equal((await saveCopy(url, { headers: { Origin: 'http://untrusted.invalid' } })).status, 403);
  assert.equal(backups, 0);
  assert.equal(existsSync(exportDirectory), false);
});

for (const action of ['download', 'save']) {
  for (const revoke of ['disable', 'rotate']) {
    test(`${action} rechecks ${revoke} access after backup and removes incomplete files`, async t => {
      let access = { enabled: true, token: 'fixture-export-token', tokenRequired: true };
      let completed;
      const released = new Promise(resolve => { completed = resolve; });
      const { store, exportDirectory, url } = await fixture(t, {
        getAccess: () => access,
        getReadContext: async () => ({ store, engine: {}, release: completed }),
      });
      const send = action === 'download' ? fetch : saveCopy;
      assert.equal((await send(url)).status, 401);
      const original = store.backup.bind(store);
      let staging;
      store.backup = async path => {
        staging = path;
        await original(path);
        access = revoke === 'disable' ? { ...access, enabled: false } : { ...access, token: 'fixture-rotated-token' };
      };
      const response = await send(url, { headers: { Authorization: 'Bearer fixture-export-token' } });
      assert.equal(response.status, revoke === 'disable' ? 503 : 401);
      assert.equal(response.headers.get('content-disposition'), null);
      await released;
      assert.equal(existsSync(staging), false);
      if (action === 'save') assert.deepEqual(readdirSync(exportDirectory), []);
    });
  }
}

test('a slow save request rechecks access after receiving its body before starting a snapshot', async t => {
  let access = { enabled: true, token: 'fixture-export-token', tokenRequired: true };
  const { store, server, exportDirectory, url } = await fixture(t, { getAccess: () => access });
  let backups = 0;
  store.backup = async () => { backups++; };
  const received = once(server, 'request');
  const outgoing = request(url, { method: 'POST', headers: {
    Authorization: 'Bearer fixture-export-token', 'Content-Type': 'application/json', 'Content-Length': '2',
  } });
  const response = new Promise((resolve, reject) => {
    outgoing.on('response', incoming => { incoming.resume(); incoming.on('end', () => resolve(incoming.statusCode)); });
    outgoing.on('error', reject);
  });
  outgoing.write('{');
  await received;
  access = { ...access, token: 'fixture-rotated-token' };
  outgoing.end('}');
  assert.equal(await response, 401);
  assert.equal(backups, 0);
  assert.equal(existsSync(exportDirectory), false);
});

test('revocation during server-side publication removes the unacknowledged saved copy', async t => {
  let access = { enabled: true, token: 'fixture-export-token', tokenRequired: true };
  let completed;
  const released = new Promise(resolve => { completed = resolve; });
  const { store, exportDirectory, url } = await fixture(t, {
    getAccess: () => {
      if (existsSync(exportDirectory) && readdirSync(exportDirectory).some(name => name.endsWith('.sqlite')))
        access = { ...access, enabled: false };
      return access;
    },
    getReadContext: async () => ({ store, engine: {}, release: completed }),
  });
  const response = await saveCopy(url, { headers: { Authorization: 'Bearer fixture-export-token' } });
  assert.equal(response.status, 503);
  await released;
  assert.deepEqual(readdirSync(exportDirectory), []);
});

test('an export holds a replica snapshot until streaming finishes', async t => {
  let released = 0, finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const { store, url } = await fixture(t, { role: 'slave', getReadContext: async () => ({ store, engine: {}, release: () => { released++; finish(); } }) });
  store.setState('replica-value', 9);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  await completed;
  assert.equal(released, 1);
});

test('saving a database file on a replica is rejected before accessing its snapshot', async t => {
  let released = 0;
  const { store, url } = await fixture(t, {
    role: 'slave', controlAuthority: { canControl: () => false },
    pairContext: { canControl: () => false },
    getReadContext: async () => ({ store, engine: {}, release: () => { released++; } }),
  });
  store.setState('replica-export', 11);
  store.backup = async () => { assert.fail('Read-only requests cannot save a database file'); };
  const response = await saveCopy(url);
  assert.equal(response.status, 405);
  assert.match((await response.json()).error, /read-only/);
  assert.equal(released, 0);
});

test('neither export action uses an unverified replica database', async t => {
  let released = 0;
  const { store, url, exportDirectory } = await fixture(t, {
    role: 'slave', getReadContext: async () => ({ store: null, engine: {}, release: () => { released++; } }),
  });
  let backups = 0;
  store.backup = async () => { backups++; };
  const response = await fetch(url);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /verified master snapshot/);
  assert.equal((await saveCopy(url)).status, 405);
  assert.equal(backups, 0);
  assert.equal(released, 1);
  assert.equal(existsSync(exportDirectory), false);
});

test('concurrent downloads and saves share a bounded slot and release it after completion', async t => {
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
    for (const send of [fetch, saveCopy]) {
      const second = await send(url);
      assert.equal(second.status, 409);
      assert.match((await second.json()).error, /already in progress/);
    }
  } finally { release(); }
  const response = await first;
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  await finished;
  store.backup = original;
  const again = await saveCopy(url);
  assert.equal(again.status, 200);
  assert.equal(existsSync((await again.json()).path), true);
});

test('saved copies never overwrite earlier exports even when the timestamp is identical', async t => {
  const { store, url, exportDirectory } = await fixture(t);
  const now = Date.parse('2026-09-25T15:04:32.123Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  store.setState('copy-sequence', 1);
  const first = await saveCopy(url);
  assert.equal(first.status, 200);
  const earlier = await first.json();
  assert.equal(earlier.filename, 'stmq-2026-09-25T15-04-32-123Z.sqlite');
  const earlierBytes = readFileSync(earlier.path);
  store.setState('copy-sequence', 2);
  const second = await saveCopy(url);
  assert.equal(second.status, 200);
  const later = await second.json();
  assert.equal(later.filename, 'stmq-2026-09-25T15-04-32-123Z-2.sqlite');
  assert.deepEqual(readFileSync(earlier.path), earlierBytes);
  assert.deepEqual(readdirSync(exportDirectory).sort(), [earlier.filename, later.filename].sort());
  const download = await fetch(url);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-disposition'), `attachment; filename="${earlier.filename}"`);
  await download.arrayBuffer();
  const copy = new DatabaseSync(later.path, { readOnly: true });
  try { assert.equal(JSON.parse(copy.prepare("SELECT value FROM state WHERE key='copy-sequence'").get().value), 2); }
  finally { copy.close(); }
});

for (const send of [fetch, saveCopy]) {
  test(`${send === fetch ? 'download' : 'save'} backup failure removes partial artifacts and releases the export slot`, async t => {
    const { store, url, exportDirectory } = await fixture(t);
    const original = store.backup.bind(store);
    let staging;
    store.backup = async path => {
      staging = path;
      writeFileSync(path, 'partial fixture snapshot');
      throw new Error('synthetic-private-export-failure');
    };
    const failed = await send(url);
    assert.equal(failed.status, 503);
    assert.doesNotMatch(await failed.text(), /synthetic-private-export-failure/);
    assert.equal(existsSync(staging), false);
    if (send === saveCopy) assert.deepEqual(readdirSync(exportDirectory), []);
    store.backup = original;
    const retried = await send(url);
    assert.equal(retried.status, 200);
    await retried.arrayBuffer();
  });
}

test('an invalid server destination preserves existing files and a changed destination takes effect on the next request', async t => {
  let destination;
  const { dir, url, exportDirectory } = await fixture(t, { getDatabaseExportDirectory: () => destination });
  destination = join(dir, 'existing-file');
  writeFileSync(destination, 'existing fixture content');
  const failed = await saveCopy(url);
  assert.equal(failed.status, 503);
  assert.match((await failed.json()).error, /export folder is writable/);
  assert.equal(readFileSync(destination, 'utf8'), 'existing fixture content');
  destination = exportDirectory;
  const retried = await saveCopy(url);
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).path.startsWith(`${exportDirectory}/`), true);
});
