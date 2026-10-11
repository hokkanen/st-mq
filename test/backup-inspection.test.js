import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { createDatabaseBackup } from '../src/storage/backup.js';
import { createBackupCatalog } from '../src/storage/backup-catalog.js';
import { createBackupInspection } from '../src/app/backup-inspection.js';
import { createAppServer } from '../src/app/server.js';
import { SnapshotRepository } from '../src/pairing/snapshots.js';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-copy-inspection-'));
  const store = new Store(join(directory, 'source.sqlite'));
  store.event('synthetic', { example: 7 }, Date.now());
  const config = { input: 'mqtt', dbPath: store.path, databaseDir: directory,
    recording: { backupDirectory: join(directory, 'backups') } };
  const path = join(config.recording.backupDirectory, 'stmq-2026-10-11T10-00-00-000Z.sqlite');
  await createDatabaseBackup({ sourcePath: store.path, destination: path });
  const catalog = createBackupCatalog({ getConfig: () => config });
  const inspection = createBackupInspection({ catalog, ...options });
  t.after(async () => { await inspection.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const copy = (await catalog.list()).copies[0];
  return { directory, path, store, config, catalog, inspection, copy };
}

test('selected-copy verification independently checks complete contents without changing the copy or granting recovery authority', async t => {
  const f = await fixture(t), before = await readFile(f.path);
  assert.equal(f.inspection.start(f.copy.id).state, 'queued');
  await f.inspection.settled();
  assert.equal(f.inspection.status().state, 'complete');
  const list = await f.inspection.list();
  assert.equal(list.copies[0].recheck.state, 'complete');
  assert.equal(list.copies[0].recheck.scope, 'current-run');
  assert(Number.isSafeInteger(list.copies[0].recheck.checkedAt));
  assert(!JSON.stringify(list).includes(f.path));
  assert(!JSON.stringify(list).includes('fingerprint'));
  assert.deepEqual(await readFile(f.path), before);
  assert.equal(f.store.events().length, 1);
});

test('selected-copy check warnings use current file identity and disappear after application restart', async t => {
  const f = await fixture(t, { verify: async () => { throw Object.assign(Error('private failure'), { code: 'database_integrity_failed' }); } });
  f.inspection.start(f.copy.id); await f.inspection.settled();
  assert.deepEqual(f.inspection.health([f.copy]), { scope: 'current-run', failedChecks: 1, changedChecks: 0 });
  assert.equal((await f.inspection.list()).copies[0].recheck.error, 'database_integrity_failed');
  assert.deepEqual(f.inspection.health([{ ...f.copy, fingerprint: 'replacement' }]),
    { scope: 'current-run', failedChecks: 0, changedChecks: 1 });
  assert.deepEqual(f.inspection.health([]), { scope: 'current-run', failedChecks: 0, changedChecks: 0 });
  const restarted = createBackupInspection({ catalog: f.catalog });
  try {
    assert.equal((await restarted.list()).copies[0].recheck, undefined);
    assert.deepEqual(restarted.health([f.copy]), { scope: 'current-run', failedChecks: 0, changedChecks: 0 });
  } finally { await restarted.close(); }
});

test('a file replaced while verification runs cannot inherit that verification receipt', async t => {
  let begin, release;
  const started = new Promise(resolve => { begin = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { verify: async () => { begin(); await gate; return { verifiedAt: Date.now() }; } });
  f.inspection.start(f.copy.id); await started;
  assert.throws(() => f.inspection.start('b'.repeat(64)), { code: 'backup_verification_busy' });
  const preserved = join(f.directory, 'preserved.sqlite');
  await rename(f.path, preserved); await writeFile(f.path, 'replacement is unavailable'); release();
  await f.inspection.settled();
  assert.equal(f.inspection.status().state, 'changed');
  const view = await f.inspection.list({ force: true });
  assert.equal(view.copies[0].recheck.state, 'changed');
  assert.equal((await readFile(preserved)).subarray(0, 15).toString(), 'SQLite format 3');
});

test('shutdown joins cancelled verification and reports interruption without removing the saved copy', async t => {
  let begin;
  const started = new Promise(resolve => { begin = resolve; });
  const f = await fixture(t, { verify: ({ signal }) => new Promise((resolve, reject) => {
    begin(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  f.inspection.start(f.copy.id); await started; await f.inspection.close();
  assert.equal(f.inspection.status().error, 'backup_verification_interrupted');
  assert.equal((await readFile(f.path)).subarray(0, 15).toString(), 'SQLite format 3');
});

test('a protected copy is verified against its retained checkpoint, not only its internally valid contents', async t => {
  const f = await fixture(t);
  const directory = join(f.config.recording.backupDirectory, 'pair-exports');
  const repository = new SnapshotRepository({ directory });
  await repository.init();
  const snapshot = await repository.create({ dbPath: f.store.path, sequence: 1, force: true, pin: true,
    claim: { nodeId: randomUUID(), epoch: randomUUID(), role: 'protected', platform: 'ubuntu' } });
  // Keep valid generation metadata, but substitute a different valid database
  // of equal size. An integrity check alone would accept this replacement.
  f.store.event('synthetic', { example: 8 }, Date.now());
  const replacement = join(f.directory, 'replacement.sqlite');
  await createDatabaseBackup({ sourcePath: f.store.path, destination: replacement });
  const originalPath = join(directory, `export-${snapshot.generation}.sqlite`);
  const original = await readFile(originalPath), changed = await readFile(replacement);
  assert.equal(changed.length, original.length);
  await writeFile(originalPath, changed);
  const copy = (await f.catalog.list({ force: true })).copies.find(row => row.kind === 'protected');
  assert(copy);
  f.inspection.start(copy.id); await f.inspection.settled();
  assert.equal(f.inspection.status().state, 'error');
  assert.equal(f.inspection.status().error, 'full_verification_checkpoint_mismatch');
  assert.deepEqual(await readFile(originalPath), changed);
  await readFile(join(directory, `export-${snapshot.generation}.pin`));
});

test('download retains its final chunk until identity checks finish, so replacement cannot report a complete transfer', async t => {
  let begin, release;
  const started = new Promise(resolve => { begin = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const events = [];
  const f = await fixture(t, { onDownloadEvent: event => events.push(event) });
  const openCopy = f.catalog.open.bind(f.catalog);
  f.catalog.open = async id => {
    const source = await openCopy(id); let checks = 0;
    return { ...source, async assertCurrent() {
      if (++checks === 2) { begin(); await gate; }
      await source.assertCurrent();
    } };
  };
  const server = createAppServer({ store: f.store, engine: { config: f.config }, chartService: { overview() {} },
    token: 'synthetic-admin', backupCatalog: f.catalog, backupInspection: f.inspection });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const transfer = fetch(`${base}/api/recording-backups/download?sourceId=${f.copy.id}`,
    { headers: { Authorization: 'Bearer synthetic-admin' } }).then(response => response.arrayBuffer());
  // Install the rejection handler before unblocking the intentional failure.
  const failed = assert.rejects(transfer);
  await started;
  const preserved = join(f.directory, 'preserved.sqlite');
  await rename(f.path, preserved); await writeFile(f.path, 'replacement'); release();
  await failed;
  assert(!events.some(event => event.phase === 'complete'));
  assert(events.some(event => event.phase === 'failed'));
  assert.equal((await readFile(preserved)).subarray(0, 15).toString(), 'SQLite format 3');
});

test('admin can list, download and verify an existing copy on a read-only server; family sees only health', async t => {
  const f = await fixture(t), before = await readFile(f.path);
  const engine = { config: f.config, latestStatus: null };
  const server = createAppServer({ store: f.store, engine, role: 'slave', chartService: { overview() {} },
    token: 'synthetic-admin', familyToken: 'synthetic-family', backupCatalog: f.catalog, backupInspection: f.inspection });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = { Authorization: 'Bearer synthetic-admin' }, family = { Authorization: 'Bearer synthetic-family' };
  for (const path of ['/api/recording-backups', `/api/recording-backups/download?sourceId=${f.copy.id}`]) {
    assert.equal((await fetch(`${base}${path}`)).status, 401);
    assert.equal((await fetch(`${base}${path}`, { headers: family })).status, 403);
  }
  const list = await fetch(`${base}/api/recording-backups?refresh=true`, { headers: admin });
  assert.equal(list.status, 200); assert.equal((await list.json()).copies[0].id, f.copy.id);
  const download = await fetch(`${base}/api/recording-backups/download?sourceId=${f.copy.id}`, { headers: admin });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), before);
  assert.match(download.headers.get('content-disposition'), /stmq-2026-10-11T10-00-00-000Z.sqlite/);
  const verify = headers => fetch(`${base}/api/recording-backups/verify`, { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: f.copy.id }) });
  assert.equal((await verify(family)).status, 403);
  assert.equal((await verify(admin)).status, 202);
  await f.inspection.settled(); assert.equal(f.inspection.status().state, 'complete');
  const invalid = await fetch(`${base}/api/recording-backups/download?sourceId=/private/path`, { headers: admin });
  assert.equal(invalid.status, 409); assert(!JSON.stringify(await invalid.json()).includes('/private/path'));
  assert.equal((await fetch(`${base}/api/recording-backups?refresh=invalid`, { headers: admin })).status, 400);
  assert.deepEqual(await readFile(f.path), before);
});

test('configuration/access rotation fences a pending catalog read and a slow verify body before work starts', async t => {
  let enter, release, calls = 0;
  const started = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let access = { enabled: true, token: 'synthetic-token' };
  const inspection = { async list() { enter(); await gate; return { copies: [] }; }, start() { calls++; }, async close() {} };
  const server = createAppServer({ store: {}, engine: { config: {} }, chartService: { overview() {} },
    backupInspection: inspection, getAccess: () => access });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = fetch(`${base}/api/recording-backups`, { headers: { Authorization: 'Bearer synthetic-token' } });
  await started; access = { enabled: true, token: 'new-synthetic-token' }; release();
  assert.equal((await response).status, 401);
  const source = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"sourceId":"'));
    setTimeout(() => { access = { enabled: true, token: 'newer-synthetic-token' };
      controller.enqueue(new TextEncoder().encode(`${'a'.repeat(64)}"}`)); controller.close(); }, 20);
  } });
  const verify = await fetch(`${base}/api/recording-backups/verify`, { method: 'POST', duplex: 'half', body: source,
    headers: { Authorization: 'Bearer new-synthetic-token', 'content-type': 'application/json' } });
  assert.equal(verify.status, 401); assert.equal(calls, 0);
});
