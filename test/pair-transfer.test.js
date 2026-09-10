import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { receiveSnapshot, SnapshotRepository } from '../src/pairing/snapshots.js';
import { readReplicaPublication, snapshotDigest } from '../src/replication/publication.js';
import { runReceiver } from '../src/replication/receiver.js';
import { Readable, Writable } from 'node:stream';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-pair-transfer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, 'source.sqlite'), db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE rows (id INTEGER PRIMARY KEY,value BLOB);');
  const insert = db.prepare('INSERT INTO rows(value) VALUES(?)');
  for (let n = 0; n < 100; n++) insert.run(Buffer.alloc(40000, n));
  t.after(() => db.close());
  const repository = new SnapshotRepository({ directory: join(root, 'exports') }); await repository.init();
  const claim = { nodeId: randomUUID(), epoch: randomUUID(), role: 'primary', platform: 'ubuntu', ancestors: [], sequence: 1 };
  let chunks = 0, failAfter = Infinity;
  const peer = { request: async (operation, body) => {
    if (operation === 'snapshot-hashes') return repository.hashes(body);
    if (++chunks > failAfter) throw Object.assign(Error('unavailable'), { code: 'peer_unavailable' });
    return repository.chunk(body);
  } };
  return { root, db, dbPath, repository, claim, peer, chunks: () => chunks, failAfter: value => { failAfter = value; } };
}

test('paired snapshot replication catches up inserts, changes and deletions exactly with changed chunks', async t => {
  const f = await fixture(t), directory = join(f.root, 'replica');
  const first = await f.repository.create({ dbPath: f.dbPath, claim: f.claim, sequence: 1 });
  const result = await receiveSnapshot({ directory, metadata: first, peer: f.peer });
  assert.equal((await snapshotDigest(result.dbPath)).digest, first.digest);
  const oldReader = new DatabaseSync(result.dbPath, { readOnly: true }); t.after(() => oldReader.close());
  f.db.prepare('DELETE FROM rows WHERE id=1').run();
  f.db.prepare('UPDATE rows SET value=? WHERE id=50').run(Buffer.from('changed'));
  const second = await f.repository.create({ dbPath: f.dbPath, claim: f.claim, sequence: 2, force: true });
  const next = await receiveSnapshot({ directory, metadata: second, peer: f.peer });
  assert.equal((await snapshotDigest(next.dbPath)).digest, second.digest);
  assert.ok(next.transferredBytes < second.bytes, 'unchanged chunks are reused');
  const nextReader = new DatabaseSync(next.dbPath, { readOnly: true }); t.after(() => nextReader.close());
  assert.equal(nextReader.prepare('SELECT count(*) AS n FROM rows').get().n, 99);
  assert.equal(oldReader.prepare('SELECT count(*) AS n FROM rows').get().n, 100);
});

test('interrupted initial catchup resumes verified chunks and does not publish partial SQLite', async t => {
  const f = await fixture(t), directory = join(f.root, 'replica');
  const metadata = await f.repository.create({ dbPath: f.dbPath, claim: f.claim, sequence: 1 });
  f.failAfter(2);
  await assert.rejects(receiveSnapshot({ directory, metadata, peer: f.peer }), { code: 'peer_unavailable' });
  assert.equal(await readReplicaPublication(directory), null);
  const previousChunks = f.chunks(); f.failAfter(Infinity);
  const result = await receiveSnapshot({ directory, metadata, peer: f.peer });
  assert.equal(result.transferredBytes, metadata.bytes - 2 * 1024 * 1024);
  assert.ok(f.chunks() - previousChunks < Math.ceil(metadata.bytes / (1024 * 1024)));
});

test('universal gate preserves old publication and refuses legacy SSH receiver', async t => {
  const f = await fixture(t), directory = join(f.root, 'replica');
  const metadata = await f.repository.create({ dbPath: f.dbPath, claim: f.claim, sequence: 1 });
  await receiveSnapshot({ directory, metadata, peer: f.peer });
  const previous = await readFile(join(directory, 'publication.json'), 'utf8');
  f.db.exec('DELETE FROM rows');
  const second = await f.repository.create({ dbPath: f.dbPath, claim: f.claim, sequence: 2, force: true });
  let protectedState = false;
  const peer = { request: async (...args) => { const result = await f.peer.request(...args); protectedState = true; return result; } };
  await assert.rejects(receiveSnapshot({ directory, metadata: second, peer, guard: async () => {
    if (protectedState) throw Object.assign(Error('protected'), { code: 'protected_history' });
  } }), { code: 'protected_history' });
  assert.equal(await readFile(join(directory, 'publication.json'), 'utf8'), previous);
  await assert.rejects(runReceiver({ directory, input: Readable.from([]), output: new Writable({ write(c, e, cb) { cb(); } }) }), { code: 'protected_history' });
});
