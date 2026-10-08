import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Store } from '../src/storage/store.js';
import { createSourceSnapshot } from '../src/replication/transport.js';
import { durableJson, ownedDirectory, publishSnapshot, readReplicaPublication } from '../src/replication/publication.js';
import { databaseCheckpoint, JOURNAL_DIGEST } from '../src/replication/incremental.js';
import { acceptPeerPublication, applyPeerPublication, recoverJournalPublication } from '../src/replication/journal-publication.js';
import { CHANGE_CHUNK_BYTES, PeerTransfers, peerOperation, receivePeerTransfer } from '../src/replication/coalesced.js';

async function fixture(t, historyMiB = 1) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-journal-transfer-'));
  const source = new Store(join(root, 'source.sqlite'));
  t.after(async () => { source.close(); await rm(root, { recursive: true, force: true }); });
  const payload = { synthetic: 'x'.repeat(32768) };
  for (let i = 0; i < historyMiB; i++) source.transaction(() => {
    for (let row = 0; row < 32; row++) source.event('synthetic-history', payload, 1);
  });
  const directory = join(root, 'replica');
  await ownedDirectory(directory, '.st-mq-replica');
  await peerOperation('enroll',{dbPath:source.path});
  const generation = randomUUID(), incoming = join(directory, `incoming-${generation}.sqlite`);
  const metadata = await createSourceSnapshot({ dbPath: source.path, destination: incoming });
  await publishSnapshot(directory, incoming, { ...metadata, generation, verifiedAt: Date.now() });
  const publication=await acceptPeerPublication({directory});
  const transfers = new PeerTransfers(join(root, 'changes'));
  const peer = { request: (operation, value) => operation === 'peer-transfer'
    ? transfers.export({ dbPath: source.path, ...value }) : transfers.chunk(value) };
  return { root, source, directory, publication, peer };
}

test('incremental transfer cost and replica inode stay fixed as retained history grows', async t => {
  const sizes = [];
  for (const size of [1, 32]) {
    const f = await fixture(t, size), before = await stat(f.publication.dbPath);
    f.source.event('synthetic-new', { value: 17 }, 2);
    const target = f.source.checkpoint();
    const transfer = await receivePeerTransfer({ directory: join(f.root, 'receive'), peer: f.peer,
      after: f.publication.checkpoint });
    sizes.push(transfer.metadata.bytes);
    assert.equal(transfer.metadata.rows, 1);
    const publication = await applyPeerPublication({ directory: f.directory, transfer,
      metadata: { ...f.publication, generation: randomUUID(), sourceStartedAt: Date.now(), sourceAt: Date.now() } });
    assert.equal((await stat(publication.dbPath)).ino, before.ino, 'normal replication updates the existing file');
    assert.deepEqual(await databaseCheckpoint({ dbPath: publication.dbPath }), target);
    assert.equal(publication.digestAlgorithm, JOURNAL_DIGEST);
    const replica = new Store(publication.dbPath, { readOnly: true });
    try { assert.equal(replica.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='synthetic-new'").get().n, 1); }
    finally { replica.close(); }
  }
  assert(Math.abs(sizes[0] - sizes[1]) < 64, `delta sizes ${sizes} must depend on changed rows only`);
});

test('a partial multi-frame transfer changes neither replica rows nor its checkpoint', async t => {
  const f = await fixture(t), before = f.publication.checkpoint;
  f.source.event('synthetic-large-transaction', { value: 'y'.repeat(1024 * 1024) }, 2);
  let frames = 0;
  const disconnected = { request: (operation, value) => {
    if (operation === 'peer-transfer-chunk' && ++frames === 2) throw Object.assign(Error(), { code: 'peer_unavailable' });
    return f.peer.request(operation, value);
  } };
  await assert.rejects(receivePeerTransfer({ directory: join(f.root, 'receive'), peer: disconnected,
    after: before }), { code: 'peer_unavailable' });
  assert.deepEqual(await databaseCheckpoint({ dbPath: f.publication.dbPath }), before);
  const transfer = await receivePeerTransfer({ directory: join(f.root, 'receive'), peer: f.peer,
    after: before });
  await applyPeerPublication({ directory: f.directory, transfer,
    metadata: { ...f.publication, generation: randomUUID() } });
  assert.deepEqual(await databaseCheckpoint({ dbPath: f.publication.dbPath }), f.source.checkpoint());
});

test('receive staging owns its filenames and removes abandoned partial transfers', async t => {
  const f = await fixture(t), after = f.publication.checkpoint;
  f.source.event('synthetic-staging', { value: 9 }, 2);
  const through = f.source.checkpoint(), descriptor = await f.peer.request('peer-transfer', { after });
  const directory = join(f.root, 'receive');
  await ownedDirectory(directory, '.st-mq-peer-receive');
  const victim = join(f.root, 'unrelated.txt');
  await writeFile(victim, 'keep these bytes');
  await symlink(victim, join(directory, `peer-${descriptor.id}.changes`));
  await writeFile(join(directory, `incoming-peer-${randomUUID()}.changes`), 'abandoned partial transfer');
  const peer = { request: (operation, value) => operation === 'peer-transfer' ? descriptor : f.peer.request(operation, value) };
  const transfer = await receivePeerTransfer({ directory, peer, after });
  assert.deepEqual(transfer.metadata.target, through);
  assert.equal(await readFile(victim, 'utf8'), 'keep these bytes');
  assert.equal((await readdir(directory)).filter(name => name.startsWith('incoming-peer-')).length,1);
});

test('an unsupported raw-transaction descriptor is rejected before downloading frames', async t => {
  const f = await fixture(t), after = f.publication.checkpoint;
  f.source.event('synthetic-progress', { value: 9 }, 2);
  let frames = 0;
  const peer = { request: operation => {
    if (operation !== 'peer-transfer') { frames++; throw Error('unexpected frame'); }
    return { version: 1, id: randomUUID(), bytes: 1, digest: '0'.repeat(64), from: after, to: after, hasMore: true };
  } };
  await assert.rejects(receivePeerTransfer({ directory: join(f.root, 'receive'), peer, after }), { code: 'invalid_protocol' });
  assert.equal(frames, 0);
});

test('receiver process death mid-transfer leaves a reusable checkpoint and cleans partial staging', async t => {
  const f = await fixture(t), before = f.publication.checkpoint;
  f.source.event('synthetic-killed-transfer', { value: 'z'.repeat(1024 * 1024) }, 2);
  const transfer=await receivePeerTransfer({directory:join(f.root,'receive'),peer:f.peer,after:before});
  const bytes=await readFile(transfer.path);
  function receiver() {
    const child = spawn(process.execPath, [resolve('scripts/replica-receiver.js'), f.directory],
      { stdio: ['pipe', 'pipe', 'ignore'] });
    const closed = once(child, 'close');
    child.stdin.on('error', () => {});
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    return { child, closed, send: async message => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      const next = await lines.next();
      assert.equal(next.done, false, 'receiver returns a protocol acknowledgement');
      return JSON.parse(next.value);
    } };
  }
  const interrupted = receiver();
  assert.equal((await interrupted.send({ type: 'prepare', version: 2, generation: randomUUID() })).type, 'ready');
  const begin = { type: 'peer-apply-begin',transfer:transfer.metadata };
  assert.equal((await interrupted.send(begin)).type, 'apply-ready');
  await interrupted.send({ type: 'apply-chunk', offset: 0, data: bytes.subarray(0, CHANGE_CHUNK_BYTES).toString('base64') });
  interrupted.child.kill('SIGKILL'); await interrupted.closed;
  assert.deepEqual(await databaseCheckpoint({ dbPath: f.publication.dbPath }), before);
  const resumed = receiver();
  assert.equal((await resumed.send({ type: 'prepare', version: 2, generation: randomUUID() })).type, 'ready');
  assert.equal((await resumed.send(begin)).type, 'apply-ready');
  for (let offset = 0; offset < bytes.length; offset += CHANGE_CHUNK_BYTES) {
    const frame = bytes.subarray(offset, offset + CHANGE_CHUNK_BYTES);
    assert.equal((await resumed.send({ type: 'apply-chunk', offset, data: frame.toString('base64') })).offset,
      offset + frame.length);
  }
  const metadata = { ...f.publication, generation: randomUUID(), checkpoint: transfer.metadata.target,
    digest: transfer.metadata.target.hash, digestAlgorithm: JOURNAL_DIGEST };
  assert.equal((await resumed.send({ type: 'apply-commit', metadata })).type, 'applied');
  assert.equal((await resumed.send({ type: 'complete', checkpoint: transfer.metadata.target })).type, 'published');
  resumed.child.stdin.end(); await resumed.closed;
  assert.deepEqual(await databaseCheckpoint({ dbPath: f.publication.dbPath }), transfer.metadata.target);
  assert.equal((await readdir(f.directory)).some(name => name.endsWith('.changes')), false);
});

for (const committed of [false, true]) test(`publication restart selects the ${committed ? 'new' : 'old'} checkpoint after a crash`, async t => {
  const f = await fixture(t);
  f.source.event('synthetic-crash', { value: 21 }, 2);
  const transfer=await receivePeerTransfer({directory:join(f.root,'receive'),peer:f.peer,after:f.publication.checkpoint});
  const { dbPath, ...previous } = f.publication;
  const next = { ...previous, generation: randomUUID(), checkpoint: transfer.metadata.target,
    digest: transfer.metadata.target.hash, digestAlgorithm: JOURNAL_DIGEST };
  await durableJson(join(f.directory, 'journal-publication.json'), { version: 1, from: transfer.metadata.base, next });
  if (committed) await peerOperation('apply',{dbPath,path:transfer.path,metadata:transfer.metadata});
  const restored = await recoverJournalPublication(f.directory);
  assert.deepEqual(restored.checkpoint, committed ? transfer.metadata.target : transfer.metadata.base);
  assert.deepEqual((await readReplicaPublication(f.directory)).checkpoint, restored.checkpoint);
  assert.equal((await readdir(f.directory)).includes('journal-publication.json'), false);
});

for(const accepted of [false,true]) test(`seed publication recovers a crash ${accepted?'after':'before'} accepting its peer anchor`,async t=>{
  const f=await fixture(t);
  f.source.event('seed-boundary',{value:31},2);
  const generation=randomUUID(),incoming=join(f.directory,`incoming-${generation}.sqlite`);
  const metadata=await createSourceSnapshot({dbPath:f.source.path,destination:incoming});
  const publication=await publishSnapshot(f.directory,incoming,{...metadata,generation,verifiedAt:Date.now()});
  const {dbPath,...previous}=publication;
  const anchor=await peerOperation('anchor',{dbPath});
  assert(anchor.checkpoint.sequence<publication.checkpoint.sequence,'copied source anchor precedes the selected seed');
  const next={...previous,digestAlgorithm:JOURNAL_DIGEST,digest:publication.checkpoint.hash};
  await durableJson(join(f.directory,'journal-publication.json'),{version:1,kind:'peer-seed',from:publication.checkpoint,next});
  if(accepted)await peerOperation('accept',{dbPath,checkpoint:publication.checkpoint});
  const restored=await recoverJournalPublication(f.directory);
  assert.equal(restored.digestAlgorithm,JOURNAL_DIGEST);
  assert.deepEqual((await peerOperation('anchor',{dbPath})).checkpoint,restored.checkpoint);
  assert.deepEqual(await databaseCheckpoint({dbPath}),metadata.checkpoint);
  assert.equal((await readdir(f.directory)).includes('journal-publication.json'),false);
});
