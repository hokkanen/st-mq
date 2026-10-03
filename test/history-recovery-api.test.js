import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { Store } from '../src/storage/store.js';
import { createDatabaseBackup } from '../src/storage/backup.js';
import { createHistoryRecovery } from '../src/app/history-recovery.js';
import { createAppServer } from '../src/app/server.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const request = (action, extra = {}) => ({ action, requestId: randomUUID(), ...extra });
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-history-recovery-api-'));
  const store = new Store(join(root, 'live.sqlite'));
  const engine = { config: { input: 'mqtt' }, closeFireplace: async () => {}, checkpoint: { old: true } };
  let currentEngine = engine, control = true;
  const counts = { missing: 1, conflicts: 0, alreadyPresent: 0, skipped: 0 };
  const calls = [];
  const module = options.real ? await import('../src/recovery/service.js') : {
    listRecoveries: () => [],
    recoveryPreview: async value => { calls.push(['check', value]); return { previewId: 'a'.repeat(64), counts }; },
    recoverHistory: async value => {
      calls.push(['recover', value]);
      value.onPublish({ checkpoint: { recovered: true } });
      return { report: { status: 'complete', counts, imported: 1 } };
    },
    previewRecoveryRevision: async value => ({ previewId: 'b'.repeat(64), recoveryId: value.recoveryId, active: value.active, counts }),
    reviseRecovery: async value => { calls.push(['revise', value]); value.onPublish({ checkpoint: { revised: true } }); return { report: { status: 'complete', counts } }; },
    ...options.module,
  };
  const coordinatorOptions = { store, getEngine: () => currentEngine, canControl: () => control,
    getExportDirectory: () => join(root, 'exports'), recoveryModule: async () => module, ...options.coordinator };
  let coordinator = createHistoryRecovery(coordinatorOptions);
  coordinator.initialize();
  const server = createAppServer({ engine, store, chartService: { overview() {} }, historyRecovery: coordinator,
    controlAuthority: { canControl: () => control, status: () => ({}) }, ...options.server });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await coordinator.close(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(value, extra = {}) {
    return fetch(`${base}/api/history-recovery/action`, { method: 'POST', headers: { 'content-type': 'application/json', ...extra.headers },
      body: JSON.stringify(value), ...extra });
  }
  async function upload(bytes, extra = {}) {
    return fetch(`${base}/api/history-recovery/upload`, { method: 'POST', body: bytes,
      headers: { 'content-type': 'application/vnd.sqlite3', ...extra.headers }, ...extra });
  }
  async function backup() {
    const path = join(root, `${randomUUID()}.sqlite`);
    await createDatabaseBackup({ sourcePath: store.path, destination: path });
    return readFile(path);
  }
  async function restartCoordinator() { await coordinator.close(); coordinator = createHistoryRecovery(coordinatorOptions); coordinator.initialize(); return coordinator; }
  return { root, store, engine, calls, coordinator, backup, base, upload, post, restartCoordinator,
    loseAuthority: () => { control = false; coordinator.cancel(); }, replaceEngine: () => { currentEngine = { ...engine }; } };
}

test('standalone upload, explicit source review, recovery publication and retry receipts share durable coordinator state', async t => {
  const f = await fixture(t);
  const response = await f.upload(await f.backup());
  assert.equal(response.status, 201);
  const source = await response.json();
  assert.equal(source.source.kind, 'upload');
  const files = await readdir(join(f.root, 'history-recovery', 'uploads'));
  assert.equal(files.length, 1);
  assert.equal((await stat(join(f.root, 'history-recovery', 'uploads', files[0]))).mode & 0o777, 0o600);
  const abandoned = join(f.root, 'history-recovery', 'uploads', `${randomUUID()}.partial`);
  await writeFile(abandoned, 'incomplete synthetic upload');
  assert.equal((await f.upload(await f.backup())).status, 201);
  const retainedFiles = await readdir(join(f.root, 'history-recovery', 'uploads'));
  assert.equal(retainedFiles.length, 2);
  assert(retainedFiles.includes(files[0]), 'registered donor remains available after abandoned staging cleanup');
  assert.equal((await f.post(request('check', { sourceId: source.sourceId }))).status, 409);
  const check = request('check', { sourceId: source.sourceId, installationConfirmed: true });
  assert.equal((await f.post(check)).status, 202);
  await f.coordinator.settled();
  const view = await f.coordinator.view();
  assert.equal(view.preview.previewId, 'a'.repeat(64));
  assert.equal(JSON.stringify(view).includes(f.root), false, 'public state contains no private paths');
  const apply = request('recover', { previewId: view.preview.previewId, confirmed: true });
  assert.equal((await f.post(apply)).status, 202);
  await f.coordinator.settled();
  assert.deepEqual(f.engine.checkpoint, { recovered: true });
  assert.equal(f.calls.filter(([kind]) => kind === 'recover').length, 1);
  assert.equal((await f.post(apply)).status, 202);
  assert.equal(f.calls.filter(([kind]) => kind === 'recover').length, 1);
  assert.equal((await f.post({ ...apply, previewId: 'changed' })).status, 409);
  const reopened = await f.restartCoordinator();
  assert.equal((await reopened.view()).job.status, 'complete');
  await reopened.action(apply);
  assert.equal(f.calls.filter(([kind]) => kind === 'recover').length, 1);
});

test('upload rejects arbitrary paths, non-SQLite data, WAL files, size excess and family access', async t => {
  const f = await fixture(t, { coordinator: { maxUploadBytes: 1024 }, server: { token: 'synthetic-admin', familyToken: 'synthetic-family' } });
  const admin = { headers: { authorization: 'Bearer synthetic-admin', 'content-type': 'application/vnd.sqlite3' } };
  assert.equal((await f.upload(Buffer.alloc(200), admin)).status, 400);
  const header = Buffer.alloc(200); header.write('SQLite format 3\0'); header[18] = 2; header[19] = 2;
  assert.equal((await f.upload(header, admin)).status, 400);
  assert.equal((await f.upload(Buffer.alloc(1025), admin)).status, 413);
  assert.equal((await f.upload(header, { headers: { authorization: 'Bearer synthetic-family' } })).status, 403);
  assert.equal((await f.post(request('check', { sourceId: '/invented/private.sqlite', installationConfirmed: true }),
    { headers: { authorization: 'Bearer synthetic-admin', 'content-type': 'application/json' } })).status, 409);
  assert.equal((await f.post(request('check', { path: '/invented/private.sqlite' }),
    { headers: { authorization: 'Bearer synthetic-admin', 'content-type': 'application/json' } })).status, 400);
  assert.deepEqual(await readdir(join(f.root, 'history-recovery', 'uploads')), []);
  assert.equal(f.calls.length, 0);
});

test('running source recovery fences correction/configuration writes and cancellation preserves the old model', async t => {
  const entered = deferred();
  const f = await fixture(t, { module: { recoverHistory: async ({ signal }) => {
    entered.resolve();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('private /secret/path')), { once: true }));
  } } });
  const source = await (await f.upload(await f.backup())).json();
  await f.post(request('check', { sourceId: source.sourceId, installationConfirmed: true })); await f.coordinator.settled();
  await f.post(request('recover', { previewId: (await f.coordinator.view()).preview.previewId, confirmed: true }));
  await entered.promise;
  for (const path of ['/api/fireplace', '/api/sensor-changes/revert', '/api/settings/reload']) {
    const response = await fetch(`${f.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 409, path);
  }
  f.loseAuthority(); await f.coordinator.settled();
  const view = await f.coordinator.view();
  assert.equal(view.available, false); assert.equal(view.job.status, 'interrupted');
  assert.equal(view.job.error.includes('/secret'), false);
  assert.deepEqual(f.engine.checkpoint, { old: true });
});

test('recovery API does not expose private paths or rejected JSON content in unexpected errors', async t => {
  const f = await fixture(t);
  const backup = await f.backup();
  await writeFile(join(f.root, 'history-recovery'), 'synthetic storage obstruction');
  const upload = await f.upload(backup);
  assert.equal(upload.status, 503);
  assert.deepEqual(await upload.json(), { error: 'Recovery storage is unavailable. Retry shortly.' });
  const malformed = await fetch(`${f.base}/api/history-recovery/action`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{"private":"/invented/private-source.sqlite", invalid}' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'The recovery request must contain valid supported input.' });
});

test('reversal requires a matching reviewed action and publishes through the same coordinator', async t => {
  const f = await fixture(t), operationId = randomUUID();
  await f.post(request('review-revert', { operationId })); await f.coordinator.settled();
  const view = await f.coordinator.view();
  assert.equal(view.job.operationId, operationId);
  assert.equal((await f.post(request('restore', { previewId: view.preview.previewId, confirmed: true }))).status, 409);
  assert.equal((await f.post(request('revert', { previewId: view.preview.previewId, confirmed: true }))).status, 202);
  await f.coordinator.settled();
  assert.deepEqual(f.engine.checkpoint, { revised: true });
  assert.equal(f.calls[0][1].active, false);
  assert.equal(f.calls[0][1].recoveryId, operationId);
});

test('another input dependency reports its safe explanation and remains blocked after reopening', async t => {
  const f = await fixture(t, { module: { previewRecoveryRevision: async () => {
    throw Object.assign(new Error('/invented/private-source.sqlite'), { code: 'recovery_other_input' });
  } } });
  await f.post(request('review-revert', { operationId: randomUUID() }));
  await f.coordinator.settled();
  const reopened = await f.restartCoordinator(), view = await reopened.view();
  assert.equal(view.job.status, 'error');
  assert.equal(view.preview, null);
  assert.equal(view.job.error, 'This recovery affects saved learning in another input. Keep it active or use a separate database for that input.');
  assert.deepEqual(f.engine.checkpoint, { old: true });
});

test('a crash receipt is marked interrupted without automatically granting another recovery', async t => {
  const f = await fixture(t);
  const requestId = randomUUID();
  f.store.setState('history-recovery:coordinator', { version: 1, sources: [], receipts: [],
    job: { id: requestId, requestId, kind: 'recover', status: 'running', startedAt: Date.now(), source: null },
    review: { kind: 'recover', preview: { previewId: 'obsolete' } } });
  f.store.setState('recovery:active:mqtt', { status: 'importing' });
  const reopened = await f.restartCoordinator();
  const view = await reopened.view();
  assert.equal(view.job.status, 'interrupted'); assert.equal(view.preview, null);
  assert.equal(f.store.getState('recovery:active:mqtt').status, 'failed');
  assert.equal(f.calls.length, 0);
});

test('saved source listing accepts only application export names and issues opaque source IDs', async t => {
  const f = await fixture(t), { mkdir, symlink } = await import('node:fs/promises');
  const exports = join(f.root, 'exports'); await mkdir(exports);
  const bytes = await f.backup();
  await writeFile(join(exports, 'stmq-2026-10-03T12-00-00-000Z.sqlite'), bytes);
  await writeFile(join(exports, 'unrelated.sqlite'), bytes);
  await symlink(join(exports, 'unrelated.sqlite'), join(exports, 'stmq-2026-10-03T13-00-00-000Z.sqlite'));
  const view = await f.coordinator.view();
  assert.equal(view.sources.length, 1); assert.equal(view.sources[0].kind, 'backup');
  assert.match(view.sources[0].id, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(view).includes(f.root), false);
});

test('unknown saved source and job fields fail closed before private metadata can be exposed', async t => {
  const f = await fixture(t);
  const base = { version: 1, sources: [], receipts: [], job: null, review: null };
  for (const invalid of [
    { ...base, sources: [{ id: randomUUID(), kind: 'upload', label: 'Uploaded database', path: '/invented/private.sqlite' }] },
    { ...base, job: { id: randomUUID(), kind: 'recover', status: 'complete', path: '/invented/private.sqlite' } },
    { ...base, review: { kind: 'recover', preview: { previewId: 'a'.repeat(64), path: '/invented/private.sqlite' } } },
  ]) {
    f.store.setState('history-recovery:coordinator', invalid);
    assert.throws(() => createHistoryRecovery({ store: f.store, getEngine: () => f.engine }), /Saved recovery state is invalid/);
  }
});

test('shutdown cancels an unfinished upload and removes the private partial file before completing', async t => {
  const f = await fixture(t), stream = new PassThrough();
  stream.headers = { 'content-type': 'application/vnd.sqlite3' };
  const header = Buffer.alloc(100); header.write('SQLite format 3\0'); header[18] = 1; header[19] = 1;
  const outcome = f.coordinator.upload(stream).catch(error => error);
  stream.write(header);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.coordinator.busy(), true);
  await f.coordinator.close();
  assert(await outcome instanceof Error);
  assert.deepEqual(await readdir(join(f.root, 'history-recovery', 'uploads')), []);
  assert.equal(f.store.getState('history-recovery:coordinator'), null);
});

test('real backup upload recovers, reverts and restores an old contribution while newer local history survives', async t => {
  const f = await fixture(t, { real: true });
  const donor = new Store(join(f.root, 'donor.sqlite'));
  const observation = (store, at, value) => store.observation({ source: 'synthetic', device: 'invented-house',
    signal: 'indoor_temperature', unit: 'degC', value, sourceTime: at, receivedAt: at });
  const at = Date.parse('2026-01-01T00:00:00Z');
  const permission = { version: 3, features: { home: { enabled: false, identity: 'a'.repeat(64), targetIdentity: null,
    pause: { id: 'synthetic-pause', createdAt: at, expiresAt: null }, revision: 1 } } };
  f.store.setState('automation:mqtt', permission);
  const donorBackup = join(f.root, 'portable.sqlite');
  try {
    observation(donor, at, 21);
    donor.setState('automation:mqtt', { version: 3, features: { home: { ...permission.features.home,
      enabled: true, targetIdentity: 'b'.repeat(64), pause: null } } });
    await createDatabaseBackup({ sourcePath: donor.path, destination: donorBackup });
  } finally { donor.close(); }
  const uploaded = await (await f.upload(await readFile(donorBackup))).json();
  await f.post(request('check', { sourceId: uploaded.sourceId, installationConfirmed: true }));
  await f.coordinator.settled();
  let view = await f.coordinator.view();
  assert.equal(view.job.status, 'complete', JSON.stringify(view.job));
  assert.equal(view.preview.counts.missing, 1);
  await f.post(request('recover', { previewId: view.preview.previewId, confirmed: true }));
  await f.coordinator.settled();
  view = await f.coordinator.view();
  assert.equal(view.job.status, 'complete', JSON.stringify(view.job));
  assert.equal(f.store.observations().length, 1);
  assert.deepEqual(f.store.getState('automation:mqtt'), permission, 'source confirmation grants no automatic control permission');
  const operationId = view.operations[0].id;
  assert.equal(view.operations[0].source.kind, 'upload');
  assert.deepEqual(Object.keys(view.operations[0].source).sort(), ['kind', 'label']);
  observation(f.store, at + 60_000, 22);
  for (const [action, expected] of [['revert', [22]], ['restore', [21, 22]]]) {
    await f.post(request(`review-${action}`, { operationId })); await f.coordinator.settled();
    view = await f.coordinator.view();
    assert.equal(view.job.status, 'complete', JSON.stringify(view.job));
    await f.post(request(action, { previewId: view.preview.previewId, confirmed: true })); await f.coordinator.settled();
    view = await f.coordinator.view();
    assert.equal(view.job.status, 'complete', JSON.stringify(view.job));
    assert.deepEqual(f.store.observations().map(row => row.value), expected);
    assert.deepEqual(f.store.getState('automation:mqtt'), permission);
  }
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 2, 'original rows remain immutable');
  const reopened = await f.restartCoordinator();
  assert.equal((await reopened.view()).job.status, 'complete');
});
