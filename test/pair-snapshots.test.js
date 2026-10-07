import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { createSourceSnapshot } from '../src/replication/transport.js';
import { SnapshotRepository } from '../src/pairing/snapshots.js';

const deferred = () => Promise.withResolvers();

async function fixture(t) {
  const root = await mkdtemp('/tmp/stmq-pair-snapshots-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, 'source.sqlite');
  new Store(dbPath).close();
  let sequence = 0;
  const repository = new SnapshotRepository({ directory: join(root, 'exports'), clock: () => 2000,
    snapshot: async options => ({ ...await createSourceSnapshot(options), sourceStartedAt: 1000, sourceAt: 1000 + ++sequence }) });
  await repository.init();
  const claim = { nodeId: randomUUID(), epoch: randomUUID(), role: 'master', platform: 'ubuntu' };
  return { repository, create: options => repository.create({ dbPath, claim, sequence: sequence + 1, ...options }),
    path: (generation, suffix) => join(repository.directory, `export-${generation}.${suffix}`) };
}

test('export admission is reserved before source validation yields and is released after failure', async t => {
  const f = await fixture(t), entered = deferred(), resume = deferred();
  const first = f.create({ assertSource: async () => { entered.resolve(); await resume.promise; } });
  await entered.promise;
  await assert.rejects(f.create({ force: true }), { code: 'peer_busy' });
  resume.resolve();
  await first;
  await assert.rejects(f.create({ assertSource: () => { throw Error('source lost'); } }), /source lost/);
  assert.ok((await f.create({ force: true })).generation);
});

test('authority lost while retaining an export cannot publish its stale master claim', async t => {
  const f = await fixture(t);
  const prune = f.repository.pruneExports.bind(f.repository);
  let authoritative = true;
  f.repository.pruneExports = async (...args) => { await prune(...args); authoritative = false; };
  await assert.rejects(f.create({ force: true, assertSource: () => {
    if (!authoritative) throw Object.assign(Error('authority changed'), { code: 'authority_changed' });
  } }), { code: 'authority_changed' });
  assert.equal(f.repository.current, undefined);
  assert.equal((await readdir(f.repository.directory)).some(name => name.startsWith('export-')), false);
});

test('an atomically pinned export survives later exports and repository restart until released', async t => {
  const f = await fixture(t), pinned = await f.create({ force: true, pin: true });
  const bytes = await readFile(f.path(pinned.generation, 'sqlite'));
  for (let n = 0; n < 3; n++) await f.create({ force: true });
  const restarted = new SnapshotRepository({ directory: f.repository.directory });
  await restarted.init();
  assert.equal((await restarted.load(pinned.generation)).digest, pinned.digest);
  assert.deepEqual(await readFile(f.path(pinned.generation, 'sqlite')), bytes);
  await restarted.unpin(pinned.generation);
  await restarted.prune(null);
  await assert.rejects(access(f.path(pinned.generation, 'sqlite')), { code: 'ENOENT' });
  await assert.rejects(restarted.load(pinned.generation), { code: 'snapshot_unavailable' });
});

test('missing export metadata never authorizes deleting pinned protected history during restart', async t => {
  const f = await fixture(t), pinned = await f.create({ force: true, pin: true });
  const bytes = await readFile(f.path(pinned.generation, 'sqlite'));
  await rm(f.path(pinned.generation, 'json'));
  const restarted = new SnapshotRepository({ directory: f.repository.directory });
  await restarted.init();
  assert.deepEqual(await readFile(f.path(pinned.generation, 'sqlite')), bytes);
  await access(f.path(pinned.generation, 'pin'));
  await assert.rejects(restarted.load(pinned.generation), { code: 'snapshot_unavailable' });
  await restarted.prune(null);
  assert.deepEqual(await readFile(f.path(pinned.generation, 'sqlite')), bytes);
});

test('requesting a pin on a cached export durably retains that exact generation', async t => {
  const f = await fixture(t), first = await f.create();
  assert.equal((await f.create({ pin: true })).generation, first.generation);
  await access(f.path(first.generation, 'pin'));
  for (let n = 0; n < 3; n++) await f.create({ force: true });
  await access(f.path(first.generation, 'sqlite'));
});

async function oldestExport(f) {
  const oldest = await f.create({ force: true, pin: true });
  await f.create({ force: true });
  await f.create({ force: true });
  await f.repository.unpin(oldest.generation);
  return oldest;
}

function pauseNextLoad(repository) {
  const original = repository.load.bind(repository), entered = deferred(), resume = deferred();
  let first = true;
  repository.load = async (...args) => {
    if (first) { first = false; entered.resolve(); await resume.promise; }
    return original(...args);
  };
  return { entered: entered.promise, resume: () => resume.resolve() };
}

test('a pin that starts before pruning cannot lose its export while awaiting metadata', async t => {
  const f = await fixture(t), oldest = await oldestExport(f), paused = pauseNextLoad(f.repository);
  const pinning = f.repository.pin(oldest.generation);
  await paused.entered;
  const pruning = f.repository.prune(null);
  paused.resume();
  await Promise.all([pinning, pruning]);
  await access(f.path(oldest.generation, 'pin'));
  await access(f.path(oldest.generation, 'sqlite'));
});

test('a pin queued after pruning cannot acknowledge retention of an already removed export', async t => {
  const f = await fixture(t), oldest = await oldestExport(f), paused = pauseNextLoad(f.repository);
  const pruning = f.repository.prune(null);
  await paused.entered;
  const pinning = assert.rejects(f.repository.pin(oldest.generation), { code: 'snapshot_unavailable' });
  paused.resume();
  await Promise.all([pruning, pinning]);
  await assert.rejects(access(f.path(oldest.generation, 'pin')), { code: 'ENOENT' });
  await assert.rejects(access(f.path(oldest.generation, 'sqlite')), { code: 'ENOENT' });
  assert.ok((await f.create({ force: true, pin: true })).generation, 'a rejected pin does not block later exports');
});
