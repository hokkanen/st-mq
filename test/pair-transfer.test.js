import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION } from '../src/storage/store.js';
import { randomUUID } from 'node:crypto';
import { createReplicaPublicationGuard, receiveSnapshot, SnapshotRepository, verifySnapshot } from '../src/pairing/snapshots.js';
import { readReplicaPublication, snapshotDigest } from '../src/replication/publication.js';
import { runReceiver } from '../src/replication/receiver.js';
import { Readable, Writable } from 'node:stream';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-pair-transfer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, 'source.sqlite'), db = new Store(dbPath).db;
  const insert = db.prepare("INSERT INTO events(type,payload,at) VALUES('fixture',json_object('value',?),0)");
  for (let n = 0; n < 100; n++) insert.run(String(n).padStart(2,'0').repeat(20000));
  t.after(() => db.close());
  const repository = new SnapshotRepository({ directory: join(root, 'exports') }); await repository.init();
  const claim = { nodeId: randomUUID(), epoch: randomUUID(), role: 'master', platform: 'ubuntu', ancestors: [], sequence: 1 };
  let chunks = 0, failAfter = Infinity;
  const peer = { request: async (operation, body) => {
    if (operation === 'snapshot-hashes') return repository.hashes(body);
    if (++chunks > failAfter) throw Object.assign(Error('unavailable'), { code: 'peer_unavailable' });
    return repository.chunk(body);
  } };
  return { root, db, dbPath, repository, claim, peer, chunks: () => chunks, failAfter: value => { failAfter = value; } };
}

const acceptedSnapshot = metadata => ({ generation: metadata.generation, digest: metadata.digest,
  epoch: metadata.claim.epoch, nodeId: metadata.claim.nodeId, sequence: metadata.sequence });

for (const scenario of [
  { label: 'obsolete schema', version: 7, code: 'database_schema_mismatch' },
  { label: 'invalid current structure', version: SCHEMA_VERSION, code: 'database_schema_invalid' },
]) {
  test(`paired receipt reports ${scenario.label} and preserves the last publication`, async t => {
    const f = await fixture(t), directory = join(f.root, 'slave');
    const current = await f.repository.create({ dbPath: f.dbPath, claim: f.claim, sequence: 1 });
    const publication = await receiveSnapshot({ directory, metadata: current, peer: f.peer });
    const previous = await readFile(publication.dbPath), manifest = await readFile(join(directory, 'publication.json'));
    const path = join(f.root, 'unsupported.sqlite'), db = new DatabaseSync(path);
    db.exec(`CREATE TABLE unsupported(id INTEGER); PRAGMA user_version=${scenario.version}`);
    db.close();
    const original = await readFile(path);
    const expected = { code: scenario.code, actualSchema: scenario.version, requiredSchema: SCHEMA_VERSION };
    await assert.rejects(f.repository.create({ dbPath: path, claim: f.claim, sequence: 2, force: true }), expected);
    assert.deepEqual(await readFile(path), original);
    // Model bytes offered by an incompatible peer without weakening the real
    // export check. Transfer, verification and publication use production code.
    const remote = new SnapshotRepository({ directory: join(f.root, 'unsupported-exports'),
      snapshot: async ({ dbPath, destination }) => {
        await copyFile(dbPath, destination);
        return { ...await snapshotDigest(destination), sourceStartedAt: 1, sourceAt: 1 };
      } });
    await remote.init();
    const incoming = await remote.create({ dbPath: path, claim: f.claim, sequence: 2 });
    const peer = { request: (operation, body) => operation === 'snapshot-hashes' ? remote.hashes(body) : remote.chunk(body) };
    await assert.rejects(receiveSnapshot({ directory, metadata: incoming, peer }), expected);
    assert.deepEqual(await readFile(publication.dbPath), previous);
    assert.deepEqual(await readFile(join(directory, 'publication.json')), manifest);
    await verifySnapshot(publication.dbPath, current);
  });
}

test('publication guard retains the schema diagnosis without changing incompatible local history', async t => {
  const f = await fixture(t), directory = join(f.root, 'slave');
  const metadata = await f.repository.create({ dbPath: f.dbPath, claim: f.claim, sequence: 1 });
  const publication = await receiveSnapshot({ directory, metadata, peer: f.peer });
  const db = new DatabaseSync(publication.dbPath);
  db.exec('PRAGMA user_version=7'); db.close();
  const original = await readFile(publication.dbPath), manifest = await readFile(join(directory, 'publication.json'));
  await assert.rejects(createReplicaPublicationGuard({ directory, accepted: acceptedSnapshot(metadata) }),
    { code: 'database_schema_mismatch', actualSchema: 7, requiredSchema: SCHEMA_VERSION });
  assert.deepEqual(await readFile(publication.dbPath), original);
  assert.deepEqual(await readFile(join(directory, 'publication.json')), manifest);
});

test('paired snapshot replication catches up inserts, changes and deletions exactly with changed chunks', async t => {
  const f = await fixture(t), directory = join(f.root, 'slave');
  const first = await f.repository.create({ dbPath: f.dbPath, claim: f.claim, sequence: 1 });
  const result = await receiveSnapshot({ directory, metadata: first, peer: f.peer });
  assert.equal((await snapshotDigest(result.dbPath)).digest, first.digest);
  const oldReader = new DatabaseSync(result.dbPath, { readOnly: true }); t.after(() => oldReader.close());
  f.db.prepare('DELETE FROM events WHERE id=1').run();
  f.db.prepare("UPDATE events SET payload=json_object('value',?) WHERE id=50").run('changed');
  const second = await f.repository.create({ dbPath: f.dbPath, claim: f.claim, sequence: 2, force: true });
  const next = await receiveSnapshot({ directory, metadata: second, peer: f.peer });
  assert.equal((await snapshotDigest(next.dbPath)).digest, second.digest);
  assert.ok(next.transferredBytes < second.bytes, 'unchanged chunks are reused');
  const nextReader = new DatabaseSync(next.dbPath, { readOnly: true }); t.after(() => nextReader.close());
  assert.equal(nextReader.prepare('SELECT count(*) AS n FROM events').get().n, 99);
  assert.equal(oldReader.prepare('SELECT count(*) AS n FROM events').get().n, 100);
});

test('interrupted initial catchup resumes verified chunks and does not publish partial SQLite', async t => {
  const f = await fixture(t), directory = join(f.root, 'slave');
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
  const f = await fixture(t), directory = join(f.root, 'slave');
  const metadata = await f.repository.create({ dbPath: f.dbPath, claim: f.claim, sequence: 1 });
  await receiveSnapshot({ directory, metadata, peer: f.peer });
  const previous = await readFile(join(directory, 'publication.json'), 'utf8');
  f.db.exec('DELETE FROM events');
  const second = await f.repository.create({ dbPath: f.dbPath, claim: f.claim, sequence: 2, force: true });
  let protectedState = false;
  const peer = { request: async (...args) => { const result = await f.peer.request(...args); protectedState = true; return result; } };
  await assert.rejects(receiveSnapshot({ directory, metadata: second, peer, guard: async () => {
    if (protectedState) throw Object.assign(Error('protected'), { code: 'protected_history' });
  } }), { code: 'protected_history' });
  assert.equal(await readFile(join(directory, 'publication.json'), 'utf8'), previous);
  await assert.rejects(runReceiver({ directory, input: Readable.from([]), output: new Writable({ write(c, e, cb) { cb(); } }) }), { code: 'protected_history' });
});

test('a changed local publication is preserved before another master snapshot can replace it', async t => {
  const f = await fixture(t), directory = join(f.root, 'slave');
  const metadata = await f.repository.create({ dbPath: f.dbPath, claim: f.claim, sequence: 1 });
  const publication = await receiveSnapshot({ directory, metadata, peer: f.peer });
  const changed = new DatabaseSync(publication.dbPath);
  changed.prepare("UPDATE events SET payload=? WHERE id=1").run('{"local":"unrecovered history"}');
  changed.close();
  const preserved = await readFile(publication.dbPath), manifest = await readFile(join(directory, 'publication.json'));
  await assert.rejects(createReplicaPublicationGuard({ directory, accepted: acceptedSnapshot(metadata) }),
    { code: 'verification_failed' });
  assert.deepEqual(await readFile(publication.dbPath), preserved);
  assert.deepEqual(await readFile(join(directory, 'publication.json')), manifest);
});

test('a local change during catchup fences publication and keeps the original database available', async t => {
  const f = await fixture(t), directory = join(f.root, 'slave');
  const metadata = await f.repository.create({ dbPath: f.dbPath, claim: f.claim, sequence: 1 });
  const publication = await receiveSnapshot({ directory, metadata, peer: f.peer });
  const guard = await createReplicaPublicationGuard({ directory, accepted: acceptedSnapshot(metadata) });
  await guard();
  f.db.prepare('DELETE FROM events WHERE id=1').run();
  const next = await f.repository.create({ dbPath: f.dbPath, claim: f.claim, sequence: 2, force: true });
  let changed = false;
  const peer = { request: async (...args) => {
    const response = await f.peer.request(...args);
    if (!changed) {
      changed = true;
      const local = new DatabaseSync(publication.dbPath);
      local.prepare("UPDATE events SET payload=? WHERE id=1").run('{"local":"during transfer"}');
      local.close();
    }
    return response;
  } };
  await assert.rejects(receiveSnapshot({ directory, metadata: next, peer, guard }), { code: 'verification_failed' });
  assert.equal((await readReplicaPublication(directory)).generation, metadata.generation);
  const local = new DatabaseSync(publication.dbPath, { readOnly: true });
  try { assert.equal(local.prepare('SELECT payload FROM events WHERE id=1').get().payload, '{"local":"during transfer"}'); }
  finally { local.close(); }
});

test('published snapshots require their accepted identity and reject additional SQLite journal data', async t => {
  const f = await fixture(t), directory = join(f.root, 'slave');
  const metadata = await f.repository.create({ dbPath: f.dbPath, claim: f.claim, sequence: 1 });
  const publication = await receiveSnapshot({ directory, metadata, peer: f.peer });
  await assert.rejects(createReplicaPublicationGuard({ directory, accepted: { ...acceptedSnapshot(metadata), epoch: randomUUID() } }),
    { code: 'verification_failed' });
  const guard = await createReplicaPublicationGuard({ directory, accepted: acceptedSnapshot(metadata) });
  const original = await readFile(publication.dbPath);
  await writeFile(`${publication.dbPath}-wal`, 'synthetic unclassified journal data', { mode: 0o600 });
  await assert.rejects(guard(), { code: 'verification_failed' });
  await assert.rejects(verifySnapshot(publication.dbPath, metadata), { code: 'verification_failed' });
  assert.deepEqual(await readFile(publication.dbPath), original);
});

test('an empty replica guard rejects an unexpected publication instead of adopting its history', async t => {
  const f = await fixture(t), directory = join(f.root, 'slave');
  const guard = await createReplicaPublicationGuard({ directory, accepted: null });
  await guard();
  const metadata = await f.repository.create({ dbPath: f.dbPath, claim: f.claim, sequence: 1 });
  await receiveSnapshot({ directory, metadata, peer: f.peer });
  await assert.rejects(guard(), { code: 'verification_failed' });
});
