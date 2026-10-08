import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION } from '../src/storage/store.js';
import { createDatabaseBackup } from '../src/storage/backup.js';
import { verifyDatabase, verifyCheckpointPair } from '../src/storage/full-verifier.js';
import { createDatabaseVerification } from '../src/app/database-verification.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-full-verification-'));
  const store = new Store(join(directory, 'source.sqlite'));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  store.event('fixture', { example: 1 }, 1);
  const copy = join(directory, 'copy.sqlite');
  await createDatabaseBackup({ sourcePath: store.path, destination: copy });
  return { store, copy, directory };
}

test('full verification reports incompatible format before attempting to read the current journal', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-full-verification-format-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'unsupported.sqlite'), raw = new DatabaseSync(dbPath);
  try { raw.exec(`CREATE TABLE unrelated(value TEXT); PRAGMA user_version=${SCHEMA_VERSION - 1}`); }
  finally { raw.close(); }
  const before = await readFile(dbPath);
  await assert.rejects(verifyDatabase({ dbPath }), { code: 'database_schema_mismatch',
    actualSchema: SCHEMA_VERSION - 1, requiredSchema: SCHEMA_VERSION });
  assert.deepEqual(await readFile(dbPath), before);
});

test('full snapshot verification compares canonical content at matching transaction checkpoints', async t => {
  const { store, copy } = await fixture(t);
  const checkpoint = store.checkpoint();
  const result = await verifyCheckpointPair({ leftPath: store.path, rightPath: copy, checkpoint });
  assert.deepEqual(result.checkpoint, checkpoint);
  assert.equal(result.comparison, true);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert(result.rows > 0);
  assert.equal((await verifyDatabase({ dbPath: copy })).digest, result.digest, 'export-only metadata does not change content identity');
});

test('advancing heads refuse full comparison before they can become a false content mismatch', async t => {
  const { store, copy } = await fixture(t);
  const checkpoint = store.checkpoint();
  store.event('fixture', { example: 2 }, 2);
  await assert.rejects(verifyCheckpointPair({ leftPath: store.path, rightPath: copy }), { code: 'full_verification_checkpoint_mismatch' });
  await assert.rejects(verifyDatabase({ dbPath: store.path, checkpoint }), { code: 'full_verification_checkpoint_mismatch' });
  assert.equal(store.events().length, 2);
});

test('same checkpoint with altered content fails independently of the journal hash audit', async t => {
  const { store, copy } = await fixture(t);
  const raw = new DatabaseSync(copy);
  try {
    raw.exec('BEGIN');
    raw.prepare('INSERT INTO events(id,type,payload,at) VALUES(2,?,?,2)').run('fixture', '{"example":900}');
    raw.exec('DELETE FROM journal_pending; COMMIT');
  } finally { raw.close(); }
  await assert.rejects(verifyCheckpointPair({ leftPath: store.path, rightPath: copy }), { code: 'full_verification_content_mismatch' });
  assert.deepEqual(store.events()[0].payload, { example: 1 });
});

test('full verification detects an altered historical commit without exposing source values', async t => {
  const { copy } = await fixture(t);
  const raw = new DatabaseSync(copy);
  try { raw.prepare('UPDATE journal_changes SET after_row=? WHERE sequence=1').run('{"secret":"do not expose"}'); }
  finally { raw.close(); }
  await assert.rejects(verifyDatabase({ dbPath: copy }), error => {
    assert.equal(error.code, 'database_journal_invalid');
    assert.doesNotMatch(error.message, /secret|expose/); return true;
  });
});

test('live full verification pins its checkpoint while later writes continue', async t => {
  const { store } = await fixture(t);
  store.transaction(() => { for (let at = 2; at < 3000; at++) store.event('fixture', { example: at }, at); });
  const checkpoint = store.checkpoint();
  let wrote = false;
  const result = await verifyDatabase({ dbPath: store.path, onProgress: progress => {
    if (!wrote && progress.checkpoint) { wrote = true; store.event('later', { example: 'after snapshot' }, 4000); }
  } });
  assert(wrote); assert.deepEqual(result.checkpoint, checkpoint);
  assert(store.checkpoint().sequence > result.checkpoint.sequence);
});

test('verification cancellation joins its worker and leaves the source available', async t => {
  const { store } = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(verifyDatabase({ dbPath: store.path, signal: controller.signal,
    onProgress() { controller.abort(); } }), { name: 'AbortError' });
  store.event('after-cancel', {}, 3);
  assert.equal(store.events().length, 2);
});

test('scheduled verification defaults off, follows configuration and never overlaps', async () => {
  let now = 0, configured = 0, calls = 0, release, releases = 0;
  const timers = new Map(); let id = 0;
  const service = createDatabaseVerification({ clock: () => now, getIntervalMs: () => configured,
    setTimer: (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id; }, clearTimer: key => timers.delete(key),
    acquire: async () => ({ dbPath: 'fixture', release: () => { releases++; } }),
    verify: async () => { calls++; await new Promise(resolve => { release = resolve; }); return { checkpoint: { sequence: 1 }, verifiedAt: now }; } });
  service.enable(); assert.equal(timers.size, 0); assert.equal(calls, 0);
  configured = 1000; service.configure();
  const [timerId, timer] = [...timers][0]; now = timer.at; timers.delete(timerId); timer.fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(service.status().state, 'running');
  service.start(); assert.equal(calls, 1); assert.equal(timers.size, 0);
  release(); await service.settled(); assert.equal(releases, 1); assert.equal(service.status().nextAt, now + configured);
  configured = 0; service.configure(); assert.equal(timers.size, 0); assert.equal(service.status().nextAt, null);
  await service.close();
});

test('verifier failures and shutdown release the pinned source without affecting application authority', async () => {
  let released = false;
  const service = createDatabaseVerification({ acquire: async () => ({ dbPath: 'fixture', release: () => { released = true; } }),
    verify: async ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  service.start(); await new Promise(resolve => setImmediate(resolve)); await service.close();
  assert(released); assert.equal(service.status().state, 'interrupted');
  assert.equal(service.status().error, 'full_verification_failed');
});
