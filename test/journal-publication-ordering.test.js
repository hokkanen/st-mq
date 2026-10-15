import test from 'node:test';
import assert from 'node:assert/strict';
import filesystem, { mkdtemp, open, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { Worker } from 'node:worker_threads';
import { Store } from '../src/storage/store.js';
import { createSourceSnapshot } from '../src/replication/transport.js';
import { ownedDirectory, publishSnapshot, readReplicaPublication } from '../src/replication/publication.js';
import { databaseCheckpoint, sameCheckpoint } from '../src/replication/incremental.js';
import { acceptPeerPublication, applyPeerPublication, publishCheckpointMetadata, recoverJournalPublication } from '../src/replication/journal-publication.js';
import { acquireReceiverLock } from '../src/replication/receiver.js';
import { peerOperation, PeerTransfers, receivePeerTransfer } from '../src/replication/coalesced.js';

async function fixture(t, { accept = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-publication-ordering-'));
  const source = new Store(join(root, 'source.sqlite'));
  let unlock;
  t.after(async () => { await unlock?.(); source.close(); await rm(root, { recursive: true, force: true }); });
  if (accept) source.event('synthetic-baseline', { synthetic: true }, 1);
  await peerOperation('enroll', { dbPath: source.path });
  if (!accept) source.event('synthetic-baseline', { synthetic: true }, 1);
  const directory = join(root, 'replica'); await ownedDirectory(directory, '.st-mq-replica');
  unlock = await acquireReceiverLock(directory);
  const generation = randomUUID(), incoming = join(directory, `incoming-${generation}.sqlite`);
  const seed = await createSourceSnapshot({ dbPath: source.path, destination: incoming });
  let publication = await publishSnapshot(directory, incoming, { ...seed, generation, verifiedAt: Date.now() });
  if (accept) publication = await acceptPeerPublication({ directory });
  const transfers = new PeerTransfers(join(root, 'changes'));
  const peer = { request: (operation, value) => operation === 'peer-transfer'
    ? transfers.export({ dbPath: source.path, ...value }) : transfers.chunk(value) };
  const transfer = async () => {
    source.event('synthetic-update', { synthetic: true }, 2);
    return receivePeerTransfer({ directory: join(root, 'receive'), peer, after: publication.checkpoint });
  };
  const handle = await open(join(root, 'handle-probe'), 'wx', 0o600), prototype = Object.getPrototypeOf(handle);
  await handle.close();
  return { root, source, directory, publication, transfer, prototype,
    pending: join(directory, 'journal-publication.json'), temporary: join(directory, 'publication.json.tmp'),
    manifest: join(directory, 'publication.json') };
}

function replaceFs(t, name, replacement) {
  const original = filesystem[name];
  filesystem[name] = replacement(original); syncBuiltinESMExports();
  const restore = () => { filesystem[name] = original; syncBuiltinESMExports(); };
  t.after(restore); return restore;
}

const pathOf = file => readlink(`/proc/self/fd/${file.fd}`).catch(() => null);
const syntheticFailure = Object.assign(Error('Synthetic owned publication failure'), { code: 'EIO' });
async function pending(f) { return JSON.parse(await readFile(f.pending, 'utf8')); }
async function assertOld(f) {
  assert.ok(sameCheckpoint(await databaseCheckpoint({ dbPath: f.publication.dbPath }), f.publication.checkpoint));
  assert.deepEqual(await readReplicaPublication(f.directory), f.publication);
}
async function assertTarget(f, transfer, next) {
  const actual = await readReplicaPublication(f.directory);
  assert.ok(sameCheckpoint(await databaseCheckpoint({ dbPath: actual.dbPath }), transfer.metadata.target));
  assert.ok(sameCheckpoint(actual.checkpoint, transfer.metadata.target));
  assert.equal(actual.sourceStartedAt, transfer.metadata.sourceStartedAt);
  assert.equal(actual.sourceAt, transfer.metadata.sourceAt);
  if (next) assert.deepEqual(actual, { ...next, dbPath: f.publication.dbPath });
  assert.equal((await readdir(f.directory)).includes('journal-publication.json'), false);
  assert.equal((await readdir(f.directory)).includes('publication.json.tmp'), false);
}

for (const method of ['writeFile', 'sync']) test(`prepared manifest ${method} failure cannot advance SQLite and the next owned preparation replaces it`, async t => {
  const f = await fixture(t), transfer = await f.transfer();
  const original = f.prototype[method]; let failed = false;
  f.prototype[method] = async function (...args) {
    if (!failed && await pathOf(this) === f.temporary) { failed = true; throw syntheticFailure; }
    return original.apply(this, args);
  };
  const restore = () => { f.prototype[method] = original; }; t.after(restore);
  await assert.rejects(applyPeerPublication({ directory: f.directory, transfer, metadata: { ...f.publication, generation: randomUUID() } }), syntheticFailure);
  restore(); assert.equal(failed, true); await assertOld(f);
  assert.ok(sameCheckpoint((await pending(f)).next.checkpoint, transfer.metadata.target));
  const reconciled = await recoverJournalPublication(f.directory);
  assert.deepEqual(reconciled, f.publication);
  const publication = await applyPeerPublication({ directory: f.directory, transfer, metadata: { ...f.publication, generation: randomUUID() } });
  await assertTarget(f, transfer); assert.ok(sameCheckpoint(publication.checkpoint, transfer.metadata.target));
});

for (const boundary of ['guard', 'beforeCommit', 'cancel']) test(`authority ${boundary} after staging prevents apply and keeps the old checkpoint recoverable`, async t => {
  const f = await fixture(t), transfer = await f.transfer(), abort = new AbortController();
  let checks = 0, sawCompleteStage = false;
  const assertStage = async () => {
    const staged = JSON.parse(await readFile(f.temporary, 'utf8'));
    assert.deepEqual(staged, (await pending(f)).next); sawCompleteStage = true;
    await assertOld(f);
  };
  await assert.rejects(applyPeerPublication({ directory: f.directory, transfer, signal: abort.signal,
    metadata: { ...f.publication, generation: randomUUID() },
    guard: async () => {
      if (++checks !== 2 || boundary !== 'guard') return;
      await assertStage(); throw syntheticFailure;
    }, beforeCommit: async () => {
      await assertStage();
      if (boundary === 'beforeCommit') throw syntheticFailure;
      if (boundary === 'cancel') abort.abort(syntheticFailure);
    } }), syntheticFailure);
  assert.equal(sawCompleteStage, true); await assertOld(f);
  assert.deepEqual(await recoverJournalPublication(f.directory), f.publication);
  await assertOld(f);
});

test('actual failed apply rolls back row effects and cannot publish its already prepared manifest', async t => {
  const f = await fixture(t), transfer = await f.transfer();
  const originalBytes = await readFile(transfer.path), lines = originalBytes.toString('utf8').trimEnd().split('\n');
  const header = JSON.parse(lines[0]);
  const wrong = header.contentHash === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
  header.contentHash = wrong; lines[0] = JSON.stringify(header);
  const bytes = Buffer.from(`${lines.join('\n')}\n`);
  await writeFile(transfer.path, bytes);
  const bad = { path: transfer.path, metadata: { ...transfer.metadata, contentHash: wrong,
    bytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') } };
  await assert.rejects(applyPeerPublication({ directory: f.directory, transfer: bad,
    metadata: { ...f.publication, generation: randomUUID() } }), { code: 'journal_peer_conflict' });
  await assertOld(f);
  const read = new Store(f.publication.dbPath, { readOnly: true });
  try { assert.equal(read.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='synthetic-update'").get().n, 0); }
  finally { read.close(); }
  assert.deepEqual(await recoverJournalPublication(f.directory), f.publication);
  await writeFile(transfer.path, originalBytes);
  await applyPeerPublication({ directory: f.directory, transfer, metadata: { ...f.publication, generation: randomUUID() } });
  await assertTarget(f, transfer);
});

for (const boundary of ['rename', 'directory-sync', 'pending-remove']) test(`successful apply with failed ${boundary} retains the exact receipt for reconciliation and idempotent retry`, async t => {
  const f = await fixture(t), transfer = await f.transfer();
  let failed = false, renamed = false, restore = () => {};
  if (boundary === 'rename') restore = replaceFs(t, 'rename', original => async (from, to) => {
    if (!failed && from === f.temporary && to === f.manifest) { failed = true; throw syntheticFailure; }
    return original(from, to);
  });
  if (boundary === 'directory-sync') {
    const restoreRename = replaceFs(t, 'rename', original => async (from, to) => {
      const result = await original(from, to); if (from === f.temporary && to === f.manifest) renamed = true; return result;
    });
    const sync = f.prototype.sync;
    f.prototype.sync = async function (...args) {
      if (!failed && renamed && await pathOf(this) === resolve(f.directory)) { failed = true; throw syntheticFailure; }
      return sync.apply(this, args);
    };
    restore = () => { f.prototype.sync = sync; restoreRename(); }; t.after(restore);
  }
  if (boundary === 'pending-remove') restore = replaceFs(t, 'rm', original => async (path, ...args) => {
    if (!failed && path === f.pending) { failed = true; throw syntheticFailure; }
    return original(path, ...args);
  });
  await assert.rejects(applyPeerPublication({ directory: f.directory, transfer,
    metadata: { ...f.publication, generation: randomUUID() } }), syntheticFailure);
  restore(); assert.equal(failed, true);
  assert.ok(sameCheckpoint(await databaseCheckpoint({ dbPath: f.publication.dbPath }), transfer.metadata.target));
  const saved = await pending(f);
  assert.equal(saved.next.sourceStartedAt, transfer.metadata.sourceStartedAt);
  assert.equal(saved.next.sourceAt, transfer.metadata.sourceAt);
  if (boundary === 'rename') assert.deepEqual(await readReplicaPublication(f.directory), f.publication);
  else assert.equal((await readReplicaPublication(f.directory)).generation, saved.next.generation);
  const recovered = await recoverJournalPublication(f.directory);
  assert.deepEqual(recovered, { ...saved.next, dbPath: f.publication.dbPath });
  await assertTarget(f, transfer, saved.next);
  const retried = await applyPeerPublication({ directory: f.directory, transfer,
    metadata: { ...f.publication, generation: randomUUID() }, beforeCommit: () => { assert.fail('Already accepted target cannot run apply again'); } });
  assert.deepEqual(retried, recovered);
  const read = new Store(f.publication.dbPath, { readOnly: true });
  try { assert.equal(read.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='synthetic-update'").get().n, 1); }
  finally { read.close(); }
});

test('lost apply acknowledgement leaves the committed target recoverable without applying its rows twice', async t => {
  const f = await fixture(t), transfer = await f.transfer();
  const emit = Worker.prototype.emit; let lost = false;
  const mocked = t.mock.method(Worker.prototype, 'emit', function (event, message, ...rest) {
    if (!lost && event === 'message' && message?.ok && sameCheckpoint(message.value, transfer.metadata.target)) {
      lost = true; return false;
    }
    return emit.call(this, event, message, ...rest);
  });
  await assert.rejects(applyPeerPublication({ directory: f.directory, transfer,
    metadata: { ...f.publication, generation: randomUUID() } }), { code: 'verification_failed' });
  mocked.mock.restore(); assert.equal(lost, true);
  assert.ok(sameCheckpoint(await databaseCheckpoint({ dbPath: f.publication.dbPath }), transfer.metadata.target));
  assert.deepEqual(await readReplicaPublication(f.directory), f.publication);
  const saved = await pending(f);
  const result = await recoverJournalPublication(f.directory);
  assert.deepEqual(result, { ...saved.next, dbPath: f.publication.dbPath });
  const retried = await applyPeerPublication({ directory: f.directory, transfer,
    metadata: { ...f.publication, generation: randomUUID() }, beforeCommit: () => assert.fail('A lost reply cannot replay committed rows') });
  assert.deepEqual(retried, result);
  await assertTarget(f, transfer, saved.next);
});

test('metadata-only publication preserves its checked checkpoint and clocks through prepared-file publication', async t => {
  const f = await fixture(t), generation = randomUUID(); let before = false;
  const sourceStartedAt = f.publication.sourceStartedAt, sourceAt = f.publication.sourceAt;
  const result = await publishCheckpointMetadata({ directory: f.directory, checkpoint: f.publication.checkpoint,
    metadata: { ...f.publication, generation, sourceStartedAt, sourceAt }, beforeCommit: async () => {
      assert.equal((await readReplicaPublication(f.directory)).generation, f.publication.generation);
      const stage = JSON.parse(await readFile(f.temporary, 'utf8'));
      assert.equal(stage.generation, generation); assert.equal(stage.sourceAt, sourceAt);
      await assertOld(f); before = true;
    } });
  assert.equal(before, true); assert.equal(result.generation, generation);
  assert.equal(result.sourceStartedAt, sourceStartedAt); assert.equal(result.sourceAt, sourceAt);
  assert.ok(sameCheckpoint(result.checkpoint, f.publication.checkpoint));
  assert.deepEqual(await recoverJournalPublication(f.directory), result);
});

test('seed anchor acceptance still follows preparation and recovers a failed final rename', async t => {
  const f = await fixture(t, { accept: false });
  const anchor = await peerOperation('anchor', { dbPath: f.publication.dbPath });
  assert.ok(anchor.checkpoint.sequence < f.publication.checkpoint.sequence);
  let sawPreparedBeforeAccept = false, failed = false;
  const restore = replaceFs(t, 'rename', original => async (from, to) => {
    if (!failed && from === f.temporary && to === f.manifest) { failed = true; throw syntheticFailure; }
    return original(from, to);
  });
  let guards = 0;
  await assert.rejects(acceptPeerPublication({ directory: f.directory, guard: async () => {
    if (++guards !== 2) return;
    assert.equal((await pending(f)).kind, 'peer-seed');
    assert.ok(sameCheckpoint((await peerOperation('anchor', { dbPath: f.publication.dbPath })).checkpoint, anchor.checkpoint));
    assert.deepEqual(JSON.parse(await readFile(f.temporary, 'utf8')), (await pending(f)).next);
    sawPreparedBeforeAccept = true;
  } }), syntheticFailure);
  restore(); assert.equal(sawPreparedBeforeAccept, true); assert.equal(failed, true);
  const saved = await pending(f);
  assert.ok(sameCheckpoint((await peerOperation('anchor', { dbPath: f.publication.dbPath })).checkpoint, f.publication.checkpoint));
  const recovered = await recoverJournalPublication(f.directory);
  assert.deepEqual(recovered, { ...saved.next, dbPath: f.publication.dbPath });
  const repeated = await acceptPeerPublication({ directory: f.directory });
  const { verifiedAt: repeatedAt, ...repeatedBoundary } = repeated;
  const { verifiedAt: recoveredAt, ...recoveredBoundary } = recovered;
  assert.deepEqual(repeatedBoundary, recoveredBoundary, 'Repeated seed acceptance preserves the exact checkpoint and frozen source clocks');
  assert.ok(repeatedAt >= recoveredAt, 'The existing local verification receipt remains separate from source clocks');
  assert.ok(sameCheckpoint((await peerOperation('anchor', { dbPath: f.publication.dbPath })).checkpoint, recovered.checkpoint));
});
