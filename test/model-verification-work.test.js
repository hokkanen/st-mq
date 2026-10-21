import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ModelVerificationWork, verificationWorkPath } from '../src/storage/model-verification-work.js';
import { createModelReconstruction } from '../src/app/model-reconstruction.js';
import { Store } from '../src/storage/store.js';

test('temporary verification saves atomically and retains the previous complete checkpoint', t => {
  const directory = mkdtempSync(join(tmpdir(), 'temporary-model-verification-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = verificationWorkPath(directory);
  let work = new ModelVerificationWork({ path });
  work.start({ id: 'synthetic-current-job' });
  work.save({ state: { cursor: 10 }, independentlyComputed: true });
  work.save({ state: { cursor: 20 }, independentlyComputed: true });
  work.save({ state: { cursor: 30 }, independentlyComputed: true });
  assert.equal(work.db.prepare('SELECT COUNT(*) n FROM checkpoints').get().n, 2);
  work.close();
  work = new ModelVerificationWork({ path });
  assert.equal(work.progress().state.cursor, 30);
  work.db.prepare('UPDATE checkpoints SET body=? WHERE cursor=30').run(Buffer.from('interrupted-checkpoint'));
  assert.equal(work.progress().state.cursor, 20);
  work.db.exec('UPDATE checkpoints SET digest=\'damaged\'');
  assert.throws(() => work.progress(), { code: 'model_reconstruction_invalid' });
  work.close();
  assert.match(readFileSync(join(directory, 'README.txt'), 'utf8'), /Stop verification before deleting/);
  assert.match(readFileSync(join(directory, 'README.txt'), 'utf8'), /main database.*unaffected/);
});

test('unsupported verification work is rejected before mutation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'temporary-model-verification-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = verificationWorkPath(directory);
  const work = new ModelVerificationWork({ path });
  work.db.exec('PRAGMA user_version=999'); work.close();
  const original = readFileSync(path);
  assert.throws(() => new ModelVerificationWork({ path }), { code: 'model_reconstruction_invalid' });
  assert.deepEqual(readFileSync(path), original);
});

test('discard refuses to delete a source database even if its configured filename is temporary', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'temporary-model-verification-'));
  const path = verificationWorkPath(directory), store = new Store(path);
  const service = createModelReconstruction({ directory,
    acquire: async () => ({ store, dbPath: path, input: 'simulated' }) });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const before = readFileSync(path), checkpoint = store.checkpoint();
  await assert.rejects(service.action({ action: 'discard', requestId: randomUUID() }), { code: 'model_reconstruction_invalid' });
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(store.checkpoint(), checkpoint);
});

test('discard protects a configured source path when acquisition is unavailable from startup', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'temporary-model-verification-'));
  const path = verificationWorkPath(directory), store = new Store(path); let acquisitions = 0;
  const service = createModelReconstruction({ directory, protectedPaths: [path], acquire: async () => {
    acquisitions++; throw new Error('Invented unavailable read context before first successful acquisition');
  } });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const bytes = () => ['', '-wal'].map(suffix => existsSync(path + suffix) ? readFileSync(path + suffix) : null);
  const checkpoint = store.checkpoint(), before = bytes();
  await assert.rejects(service.action({ action: 'discard', requestId: randomUUID() }), { code: 'model_reconstruction_invalid' });
  assert.equal(acquisitions, 1, 'protection does not depend on an earlier successful source read');
  assert.deepEqual(bytes(), before); assert.deepEqual(store.checkpoint(), checkpoint);
});

test('verify refuses to overwrite a source database through the disposable README filename', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'temporary-model-verification-'));
  const path = join(directory, 'README.txt'), store = new Store(path); let workers = 0;
  const service = createModelReconstruction({ directory,
    acquire: async () => ({ store, dbPath: path, input: 'simulated' }),
    workerFactory: () => { workers++; throw new Error('A colliding source must be rejected before worker creation'); } });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const checkpoint = store.checkpoint(), before = readFileSync(path);
  await assert.rejects(service.action({ action: 'verify', requestId: randomUUID() }), { code: 'model_reconstruction_invalid' });
  assert.equal(workers, 0); assert.deepEqual(readFileSync(path), before); assert.deepEqual(store.checkpoint(), checkpoint);
});
