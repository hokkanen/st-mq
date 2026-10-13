import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { JOURNALED_TABLES } from '../src/storage/schema.js';
import { LEARNING_ALGORITHM } from '../src/domain/learning-contract.js';
import { verifyJournal, journalConnection } from '../src/storage/journal.js';
import { enrollJournalPeer, peerAnchor, preparePeerTransfer, peerTransferRows,
  acknowledgePeer, applyPeerTransfer, rewindPeer, releasePeerSource } from '../src/storage/journal-peer.js';
import { PeerTransfers, peerOperation, receivePeerTransfer } from '../src/replication/coalesced.js';
import { PairManager } from '../src/pairing/manager.js';
import { SnapshotRepository } from '../src/pairing/snapshots.js';

async function fixture(t, populate = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-peer-audit-'));
  const stores = [];
  const open = name => { const store = new Store(join(directory, name)); stores.push(store); return store; };
  t.after(async () => {
    for (const store of stores) { try { store.close(); } catch {} }
    await rm(directory, { recursive: true, force: true });
  });
  const source = open('source.sqlite');
  populate(source);
  enrollJournalPeer(source.db);
  await source.backup(join(directory, 'receiver.sqlite'));
  return { directory, source, receiver: open('receiver.sqlite'), open };
}

function contents(store) {
  return Object.fromEntries(JOURNALED_TABLES.map(table => [table.name,
    store.db.prepare(`SELECT * FROM "${table.name}" ${table.name === 'state' ? "WHERE key<>'backup:metadata'" : ''} ORDER BY ${table.keys.map(key => `"${key}"`).join(',')}`)
      .all().map(row => ({ ...row }))]));
}

function* changes(source, transfer) {
  let afterOrdinal = -1;
  for (;;) {
    const page = peerTransferRows(source.db, { id: transfer.id, afterOrdinal, limit: 7 });
    if (!page.length) return;
    for (const row of page) { afterOrdinal = row.ordinal; yield row.change; }
  }
}

function deliver(source, receiver, transfer) {
  return applyPeerTransfer(receiver.db, { ...transfer, changes: changes(source, transfer) });
}

function random(seed) {
  return limit => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % limit; };
}

for (const seed of [17, 101, 2027]) test(`peer catch-up preserves exact frozen rows through churn and acknowledgement restart (${seed})`, async t => {
  const f = await fixture(t, store => {
    for (let i = 0; i < 12; i++) store.setState(`synthetic:${i}`, { value: i, text: 'unchanged☃'.repeat(50) });
  });
  let source = f.source;
  const rng = random(seed);
  let clock = 0;
  const mutate = count => {
    for (let n = 0; n < count; n++) {
      const key = `synthetic:${rng(24)}`;
      const action = rng(4);
      source.transaction(() => {
        if (action === 0) source.db.prepare('DELETE FROM state WHERE key=?').run(key);
        else {
          const payload = JSON.stringify({ value: rng(100000), text: `${'unchanged☃'.repeat(50)}:${clock}` });
          source.db.prepare('INSERT INTO state VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
            .run(key, payload, ++clock);
          // Exercise a cancelling insert/delete effect inside the same commit.
          source.db.prepare('INSERT INTO state VALUES(?,?,?)').run('synthetic:transient', '{}', clock);
          source.db.prepare('DELETE FROM state WHERE key=?').run('synthetic:transient');
        }
      });
      if (n % 7 === 0) source.compactJournal({ maxCommits: 2 });
    }
  };
  for (let round = 0; round < 5; round++) {
    mutate(45);
    const frozen = contents(source), transfer = preparePeerTransfer(source.db, { after: f.receiver.checkpoint() });
    assert(source.journalBase().sequence > f.receiver.checkpoint().sequence, 'the receiver is older than the transaction window');
    mutate(18);
    assert.deepEqual(preparePeerTransfer(source.db, { after: f.receiver.checkpoint() }).target, transfer.target,
      'retry cannot silently substitute a newer source state');
    deliver(source, f.receiver, transfer);
    assert.deepEqual(contents(f.receiver), frozen, 'the receiver gets the original frozen rows, including deletions');
    assert.deepEqual(deliver(source, f.receiver, transfer), transfer.target, 'lost delivery acknowledgement is idempotent');
    const first = acknowledgePeer(source.db, { checkpoint: transfer.target, limit: 1 });
    assert.equal(first.complete, false);
    source.close(); source = f.open('source.sqlite');
    let count = 0, complete = false;
    while (!complete) {
      mutate(2);
      complete = acknowledgePeer(source.db, { checkpoint: transfer.target, limit: 2 }).complete;
      assert(++count < 30, 'bounded acknowledgement continues making progress after restart');
    }
    verifyJournal(source.db); verifyJournal(f.receiver.db);
  }
  const final = preparePeerTransfer(source.db, { after: f.receiver.checkpoint() });
  deliver(source, f.receiver, final);
  while (!acknowledgePeer(source.db, { checkpoint: final.target, limit: 3 }).complete) {}
  assert.deepEqual(contents(f.receiver), contents(source));
  assert.deepEqual(peerAnchor(source.db).checkpoint, f.receiver.checkpoint());
  assert.equal(source.db.prepare('SELECT COUNT(*) n FROM journal_peer_changes').get().n, 0);
  assert.equal(source.db.prepare('SELECT COUNT(*) n FROM journal_peer_before').get().n, 0);
});

test('peer apply and rewind preserve cascading report and learning dependencies', async t => {
  const f = await fixture(t, store => store.transaction(() => {
    store.db.prepare('INSERT INTO charging_reports VALUES(?,?,?,?,?,?,?,?,?)')
      .run('mqtt', 'synthetic-charger', 'synthetic-report', '{}', 1, null, null, '{}', '{}');
    store.db.prepare('INSERT INTO charging_report_contexts(id,namespace,charger_id,report_id,kind,digest,payload) VALUES(?,?,?,?,?,?,?)')
      .run(1, 'mqtt', 'synthetic-charger', 'synthetic-report', 'prices', 'synthetic-digest', '[]');
    store.db.prepare('INSERT INTO charging_report_events(namespace,charger_id,report_id,at,category,payload,price_context_id) VALUES(?,?,?,?,?,?,?)')
      .run('mqtt', 'synthetic-charger', 'synthetic-report', 2, 'synthetic', '{}', 1);
    store.db.prepare('INSERT INTO learning_journal_entries(id,epoch,input,key,kind,at,algorithm_version,payload) VALUES(?,?,?,?,?,?,?,?)')
      .run(1, 'synthetic-epoch', 'mqtt', 'synthetic-key', 'synthetic', 1, LEARNING_ALGORITHM, '{}');
    store.db.prepare('INSERT INTO learning_checkpoints VALUES(?,?,?,?,?,?,?,?)')
      .run('mqtt', 'synthetic-epoch', 1, 1, 0, 0, 'original', '{"checkpointStorageVersion":1}');
  }));
  const base = f.source.checkpoint(), original = contents(f.source);
  f.source.transaction(() => {
    f.source.db.exec('DELETE FROM charging_reports; DELETE FROM learning_journal_entries');
    f.source.setState('synthetic-new', { value: 1 });
  });
  const transfer = preparePeerTransfer(f.source.db, { after: base });
  deliver(f.source, f.receiver, transfer);
  assert.deepEqual(contents(f.receiver), contents(f.source));
  assert.equal(f.receiver.db.prepare('SELECT COUNT(*) n FROM charging_report_events').get().n, 0);
  assert.equal(f.receiver.db.prepare('SELECT COUNT(*) n FROM charging_report_contexts').get().n, 0);
  const branch = rewindPeer(f.source.db, { checkpoint: base });
  assert(branch);
  assert.deepEqual(contents(f.source), original, 'undo restores parent and cascading child rows together');
  assert.equal(verifyJournal(f.source.db).archivedPeerRows, 6);
  verifyJournal(f.receiver.db);
});

test('stream failure after earlier valid rows rolls back the complete peer application', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 150; i++) f.source.setState(`synthetic:${i}`, i);
  const transfer = preparePeerTransfer(f.source.db, { after: f.receiver.checkpoint() });
  const original = contents(f.receiver), checkpoint = f.receiver.checkpoint(), anchor = peerAnchor(f.receiver.db);
  function* interrupted() {
    let count = 0;
    for (const change of changes(f.source, transfer)) {
      if (++count === 130) throw Object.assign(new Error('synthetic read interruption'), { code: 'synthetic_interrupted' });
      yield change;
    }
  }
  assert.throws(() => applyPeerTransfer(f.receiver.db, { ...transfer, changes: interrupted() }), { code: 'synthetic_interrupted' });
  assert.deepEqual(contents(f.receiver), original);
  assert.deepEqual(f.receiver.checkpoint(), checkpoint);
  assert.deepEqual(peerAnchor(f.receiver.db), anchor);
  deliver(f.source, f.receiver, transfer);
  assert.deepEqual(contents(f.receiver), contents(f.source));
  verifyJournal(f.receiver.db);
});

for (const invalid of ['missing sample', 'damaged sample'])
test(`a correctly fingerprinted peer target with a ${invalid} rolls back without publishing`, async t => {
  const f = await fixture(t);
  const original = contents(f.receiver), checkpoint = f.receiver.checkpoint(), anchor = peerAnchor(f.receiver.db);
  const digest = 'a'.repeat(64);
  f.source.transaction(() => {
    f.source.setState('synthetic:before-invalid-cache', { value: 1 });
    if (invalid === 'damaged sample')
      f.source.db.prepare('INSERT INTO learning_checkpoint_samples(digest,payload) VALUES(?,?)')
        .run(digest, JSON.stringify({ timestamp: 1, phase: 'normal' }));
    f.source.db.prepare('INSERT INTO state VALUES(?,?,?)').run('adaptive:mqtt',
      JSON.stringify({ checkpointStorageVersion: 1, sampleRefs: [digest] }), 1);
  });
  // The source journal fingerprints these exact rows normally. Rejection must
  // therefore come from dependency/body validation, not transport corruption.
  const transfer = preparePeerTransfer(f.source.db, { after: checkpoint });
  assert(transfer.rows > 1, 'the rejected application includes other valid work');
  assert.throws(() => deliver(f.source, f.receiver, transfer), { code: 'database_integrity_failed' });
  assert.deepEqual(contents(f.receiver), original);
  assert.deepEqual(f.receiver.checkpoint(), checkpoint);
  assert.deepEqual(peerAnchor(f.receiver.db), anchor);
  assert.equal(f.receiver.db.prepare("SELECT COUNT(*) n FROM sqlite_temp_master WHERE name='journal_learning_manifest_checks'").get().n, 0);
  verifyJournal(f.receiver.db);
});

for (const operation of ['update', 'delete'])
test(`ordinary peer catch-up refuses to ${operation} an immutable prepared sample`, async t => {
  const payload = JSON.stringify({ timestamp: 1, phase: 'normal', quality: [] });
  const digest = createHash('sha256').update(payload).digest('hex');
  const f = await fixture(t, store => store.transaction(() => {
    store.db.prepare('INSERT INTO learning_checkpoint_samples(digest,payload) VALUES(?,?)').run(digest, payload);
  }));
  const original = contents(f.receiver), checkpoint = f.receiver.checkpoint(), anchor = peerAnchor(f.receiver.db);
  f.source.transaction(() => {
    f.source.setState('synthetic:before-mutated-body', { value: 1 });
    if (operation === 'update')
      f.source.db.prepare('UPDATE learning_checkpoint_samples SET payload=? WHERE digest=?')
        .run(JSON.stringify({ timestamp: 2, phase: 'normal', quality: [] }), digest);
    else f.source.db.prepare('DELETE FROM learning_checkpoint_samples WHERE digest=?').run(digest);
  });
  const transfer = preparePeerTransfer(f.source.db, { after: checkpoint });
  assert.throws(() => deliver(f.source, f.receiver, transfer), { code: 'journal_peer_conflict' });
  assert.deepEqual(contents(f.receiver), original);
  assert.deepEqual(f.receiver.checkpoint(), checkpoint);
  assert.deepEqual(peerAnchor(f.receiver.db), anchor);
  assert.equal(f.receiver.db.prepare("SELECT COUNT(*) n FROM sqlite_temp_master WHERE name='journal_learning_manifest_checks'").get().n, 0);
  verifyJournal(f.receiver.db);
});

test('many arriving cache manifests spill only their identities and validate bodies arriving later', async t => {
  const f = await fixture(t), count = 320;
  const sample = { timestamp: 1, phase: 'normal', quality: [] }, payload = JSON.stringify(sample);
  const digest = createHash('sha256').update(payload).digest('hex');
  f.source.transaction(() => {
    f.source.db.prepare('INSERT INTO learning_checkpoint_samples(digest,payload) VALUES(?,?)').run(digest, payload);
    const insert = f.source.db.prepare('INSERT INTO state VALUES(?,?,?)');
    for (let index = 0; index < count; index++) insert.run(`adaptive:synthetic-${index}`,
      JSON.stringify({ checkpointStorageVersion: 1, sampleRefs: [digest],
        episodeArchive: [{ id: `synthetic-${index}`, sampleRefs: [digest] }] }), 1);
  });
  const transfer = preparePeerTransfer(f.source.db, { after: f.receiver.checkpoint() });
  let observed = 0;
  function* manifestFirst() {
    for (const change of changes(f.source, transfer)) {
      if (change.table === 'learning_checkpoint_samples') continue;
      const state = journalConnection(f.receiver.db);
      assert.equal(state.prepare('PRAGMA temp_store').get().temp_store, 1);
      assert.equal(state.prepare('PRAGMA temp.cache_size').get().cache_size, -8192);
      assert.equal(state.prepare('SELECT COUNT(*) n FROM temp.journal_learning_manifest_checks').get().n, observed);
      if (!observed) assert.deepEqual(state.prepare('PRAGMA temp.table_info(journal_learning_manifest_checks)').all()
        .map(row => row.name), ['table_name', 'record_key'], 'scratch stores identities without retaining full transfer payloads');
      yield change;
      observed++;
    }
    assert.equal(observed, count);
    assert.equal(journalConnection(f.receiver.db).prepare('SELECT COUNT(*) n FROM temp.journal_learning_manifest_checks').get().n, count);
    // Read the transfer again in bounded pages, retaining no body backlog in JS.
    for (const change of changes(f.source, transfer)) if (change.table === 'learning_checkpoint_samples') yield change;
  }
  applyPeerTransfer(f.receiver.db, { ...transfer, changes: manifestFirst() });
  assert.deepEqual(contents(f.receiver), contents(f.source));
  assert.equal(f.receiver.db.prepare("SELECT COUNT(*) n FROM sqlite_temp_master WHERE name='journal_learning_manifest_checks'").get().n, 0);
  assert.deepEqual(f.receiver.getState('adaptive:synthetic-319'), {
    samples: [sample], episodeArchive: [{ id: 'synthetic-319', samples: [sample] }],
  });
  verifyJournal(f.receiver.db);
});

test('peer scratch refuses to erase a caller\'s existing in-memory temporary work', async t => {
  const f = await fixture(t);
  f.source.setState('synthetic:changed', 1);
  const transfer = preparePeerTransfer(f.source.db, { after: f.receiver.checkpoint() });
  const original = contents(f.receiver), checkpoint = f.receiver.checkpoint();
  const state = journalConnection(f.receiver.db);
  state.exec('PRAGMA temp_store=MEMORY; CREATE TEMP TABLE unrelated_work(value INTEGER); INSERT INTO unrelated_work VALUES(7)');
  assert.throws(() => deliver(f.source, f.receiver, transfer), { code: 'journal_peer_temp_storage_required' });
  assert.equal(state.prepare('SELECT value FROM temp.unrelated_work').get().value, 7);
  assert.deepEqual(contents(f.receiver), original);
  assert.deepEqual(f.receiver.checkpoint(), checkpoint);
});

test('worker transfer preserves Unicode split across disk reads and multiple network frames', async t => {
  const f = await fixture(t);
  f.source.setState('synthetic-unicode', { text: 'å☃😀'.repeat(60000) });
  const transfers = new PeerTransfers(join(f.directory, 'outgoing'));
  const peer = { request: (operation, value) => operation === 'peer-transfer'
    ? transfers.export({ dbPath: f.source.path, ...value }) : transfers.chunk(value) };
  const transfer = await receivePeerTransfer({ directory: join(f.directory, 'incoming'), peer, after: f.receiver.checkpoint() });
  const wire = await readFile(transfer.path);
  assert(wire.length > 256 * 1024);
  assert(Array.from({ length: Math.floor(wire.length / (64 * 1024)) }, (_, index) => wire[(index + 1) * 64 * 1024])
    .some(byte => (byte & 0xc0) === 0x80), 'the fixture actually splits a UTF-8 character across disk reads');
  await peerOperation('apply', { dbPath: f.receiver.path, path: transfer.path, metadata: transfer.metadata });
  assert.deepEqual(contents(f.receiver), contents(f.source));
  verifyJournal(f.receiver.db);
});

for (const interrupted of ['lost-ack', 'committed-ack', 'unpinned-ack']) test(`accepted seed becomes reclaimable after ${interrupted} and continued recording`, async t => {
  const f = await fixture(t);
  const claim = { nodeId: randomUUID(), epoch: randomUUID(), role: 'master', platform: 'hassio' };
  const snapshots = new SnapshotRepository({ directory: join(f.directory, 'exports') });
  await snapshots.init();
  const manager = () => new PairManager({
    config: { directory: f.directory, snapshotDirectory: join(f.directory, 'published'), databasePath: f.source.path },
    state: { value: { role: 'master', activeDbPath: f.source.path } }, peer: {}, vip: {}, snapshots,
  });
  f.source.setState('synthetic-seed', 1);
  const seed = await snapshots.create({ dbPath: f.source.path, claim, sequence: 1, force: true, pin: true });
  const sourcePath = join(snapshots.directory, `export-${seed.generation}.sqlite`);
  const delivery = preparePeerTransfer(f.source.db, { after: f.receiver.checkpoint(), sourcePath });
  deliver(f.source, f.receiver, delivery);
  if (interrupted !== 'lost-ack') {
    const result = await peerOperation('acknowledge', { dbPath: f.source.path, checkpoint: delivery.target });
    assert.equal(result.sourcePath, sourcePath);
    assert.equal(peerAnchor(f.source.db).completedSourcePath, sourcePath, 'completed cleanup survives the acknowledgement worker exit');
    if (interrupted === 'unpinned-ack') await snapshots.unpin(seed.generation);
  }
  // No owner finishes cleanup before the simulated manager restart.
  f.source.setState('synthetic-after-seed', 2);
  if (interrupted !== 'unpinned-ack') await access(join(snapshots.directory, `export-${seed.generation}.pin`));
  const restarted = manager();
  restarted.snapshots.create = () => { throw Error('catch-up must not create another full seed'); };
  const next = await restarted.handlePeer('peer-transfer', { after: f.receiver.checkpoint() });
  assert.deepEqual(next.base, delivery.target);
  assert.deepEqual(next.target, f.source.checkpoint());
  assert.equal(next.rows, 1);
  await assert.rejects(access(join(snapshots.directory, `export-${seed.generation}.pin`)), { code: 'ENOENT' });
  assert.equal(peerAnchor(f.source.db).completedSourcePath, undefined);
  const transfer = await receivePeerTransfer({ directory: join(f.directory, 'incoming'), after: f.receiver.checkpoint(),
    peer: { request: (operation, body) => restarted.handlePeer(operation, body) } });
  await peerOperation('apply', { dbPath: f.receiver.path, path: transfer.path, metadata: transfer.metadata });
  await restarted.acknowledgePeerTransfer(next.target);
  assert.deepEqual(contents(f.receiver), contents(f.source));
  verifyJournal(f.source.db); verifyJournal(f.receiver.db);
});

test('receiving reverse-direction changes cannot erase an unfinished owned seed cleanup receipt', async t => {
  const f = await fixture(t);
  f.source.setState('synthetic-original-master', 1);
  const sourcePath = join(f.directory, 'synthetic-seed.sqlite');
  await f.source.backup(sourcePath);
  const seed = preparePeerTransfer(f.source.db, { after: f.receiver.checkpoint(), sourcePath });
  deliver(f.source, f.receiver, seed);
  assert.equal(acknowledgePeer(f.source.db, { checkpoint: seed.target }).sourcePath, sourcePath);
  f.receiver.setState('synthetic-new-master', 2);
  const returning = preparePeerTransfer(f.receiver.db, { after: f.source.checkpoint() });
  const before = contents(f.source), checkpoint = f.source.checkpoint();
  assert.throws(() => deliver(f.receiver, f.source, returning), { code: 'journal_peer_pending' });
  assert.deepEqual(contents(f.source), before);
  assert.deepEqual(f.source.checkpoint(), checkpoint);
  assert.equal(peerAnchor(f.source.db).completedSourcePath, sourcePath);
  await rm(sourcePath);
  releasePeerSource(f.source.db, { sourcePath });
  releasePeerSource(f.source.db, { sourcePath });
  deliver(f.receiver, f.source, returning);
  assert.deepEqual(contents(f.source), contents(f.receiver));
  verifyJournal(f.source.db);
});
