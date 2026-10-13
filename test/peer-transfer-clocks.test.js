import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { PairManager } from '../src/pairing/manager.js';
import { startReplica } from '../src/app/replica.js';
import { chargingSettings } from '../src/charging/settings.js';
import { writeChargingRuntime, readChargingRuntime } from '../src/charging/runtime-storage.js';
import { buildCharger, CHARGER_DEFINITIONS } from '../src/charging/model.js';
import { createSourceSnapshot } from '../src/replication/transport.js';
import { ownedDirectory, publishSnapshot } from '../src/replication/publication.js';
import { acceptPeerPublication, applyPeerPublication, checkpointMetadata, peerPublicationBoundary } from '../src/replication/journal-publication.js';
import { PeerTransfers, peerOperation, receivePeerTransfer } from '../src/replication/coalesced.js';
import { acceptPeerCheckpoint, applyPeerTransfer, peerAnchor, preparePeerTransfer, peerTransferRows } from '../src/storage/journal-peer.js';

function savedCharging(at) {
  const settings = chargingSettings({});
  return { version: 7, chargers: { charger1: { association: 'synthetic-first' }, charger2: { association: 'synthetic-second' } },
    view: { settings, chargers: CHARGER_DEFINITIONS.map(definition => buildCharger({ definition,
      settings: settings.chargers[definition.id], now: at, timezone: 'Europe/Helsinki', configuration: { efficiency: .925 },
      control: { phase: 'off', released: false }, telemetry: {} })),
    controls: { priority: 'balanced', revision: 1 }, coordination: null, error: null } };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-transfer-clock-')), at = Date.now() - 10_000;
  const source = new Store(join(root, 'source.sqlite'));
  t.after(async () => { try { source.close(); } catch {} await rm(root, { recursive: true, force: true }); });
  source.event('decision', { input: 'mqtt' }, at);
  writeChargingRuntime(source, 'charging:mqtt', savedCharging(at), { at });
  await peerOperation('enroll', { dbPath: source.path });
  const directory = join(root, 'replica');
  await ownedDirectory(directory, '.st-mq-replica');
  const generation = randomUUID(), incoming = join(directory, `incoming-${generation}.sqlite`);
  const seed = await createSourceSnapshot({ dbPath: source.path, destination: incoming });
  await publishSnapshot(directory, incoming, { ...seed, generation, sourceStartedAt: at, sourceAt: at, verifiedAt: at });
  const publication = await acceptPeerPublication({ directory });
  const transfers = new PeerTransfers(join(root, 'transfers'));
  const claim = { epoch: randomUUID(), nodeId: randomUUID(), role: 'master' };
  const peer = { request: async (operation, value) => {
    if (operation === 'peer-transfer') return transfers.export({ dbPath: source.path, ...value });
    if (operation === 'peer-transfer-chunk') return transfers.chunk(value);
    if (operation === 'peer-ack') return peerOperation('acknowledge', { dbPath: source.path, checkpoint: value.checkpoint });
    if (operation === 'status') return { claim };
    throw Error(`Unexpected fixture operation ${operation}`);
  } };
  return { root, at, source, directory, publication, transfers, peer, claim };
}
function manager(f) {
  const boundaries = [];
  const state = { value: { role: 'slave', epoch: f.claim.epoch }, claim: () => ({ ...f.claim, role: 'slave' }),
    update: async value => { if (value.pendingSnapshot) boundaries.push(value.pendingSnapshot); Object.assign(state.value, value); } };
  const result = new PairManager({ config: { directory: join(f.root, 'pair'), snapshotDirectory: f.directory,
    databasePath: f.source.path }, state, peer: f.peer, vip: {}, snapshots: {} });
  // Storage/publication regression: authority remains constant throughout.
  result.assertReplica = async () => {};
  return { result, boundaries };
}
async function assertReadableCharging(t, publication) {
  const replica = new Store(publication.dbPath, { readOnly: true });
  try {
    assert.deepEqual(replica.checkpoint(), publication.checkpoint);
    assert(readChargingRuntime(replica, 'charging:mqtt').view.recordedAt <= publication.sourceAt);
  } finally { replica.close(); }
  const app = await startReplica({ config: { topology: 'mirror', role: 'slave', input: 'mqtt', addon: false,
    host: '127.0.0.1', port: 0, token: '', mirror: { directory: join(publication.dbPath, '..') } },
    readPublication: async () => publication, installSignalHandlers: false,
    makeChartService: () => ({ overview: async () => ({}), close: async () => {} }) });
  t.after(() => app.close());
  const status = app.status();
  assert.equal(status.charging.chargers.length, 2);
  assert.equal(status.charging.error, null);
}

test('pair publication dates a later copied checkpoint from its frozen transfer, keeping the charging guard', async t => {
  const f = await fixture(t);
  f.source.event('synthetic-before-query', {}, f.at + 1000);
  const queried = await checkpointMetadata({ dbPath: f.source.path, checkpoint: f.source.checkpoint(),
    claim: f.claim, sequence: 1, clock: () => f.at + 1000 });
  writeChargingRuntime(f.source, 'charging:mqtt', savedCharging(f.at + 2000), { at: f.at + 2000, forceView: true });
  const frozen = preparePeerTransfer(f.source.db, { after: f.publication.checkpoint, clock: () => f.at + 2000 });
  const { result } = manager(f), publication = await result.installCheckpoint(queried);
  assert(publication.checkpoint.sequence > queried.checkpoint.sequence);
  assert.equal(publication.sourceAt, frozen.sourceAt);
  assert.equal(publication.sourceStartedAt, frozen.sourceStartedAt);
  await assertReadableCharging(t, publication);
});

test('pair catch-up retains an older pending delivery clock before installing the latest queried head', async t => {
  const f = await fixture(t);
  writeChargingRuntime(f.source, 'charging:mqtt', savedCharging(f.at + 2000), { at: f.at + 2000, forceView: true });
  const frozen = preparePeerTransfer(f.source.db, { after: f.publication.checkpoint, clock: () => f.at + 2000 });
  writeChargingRuntime(f.source, 'charging:mqtt', savedCharging(f.at + 4000), { at: f.at + 4000, forceView: true });
  const queried = await checkpointMetadata({ dbPath: f.source.path, checkpoint: f.source.checkpoint(),
    claim: f.claim, sequence: 2, clock: () => f.at + 4000 });
  const { result, boundaries } = manager(f), publication = await result.installCheckpoint(queried);
  assert.equal(boundaries.length, 2);
  assert.deepEqual(boundaries[0].checkpoint, frozen.target);
  assert.equal(boundaries[0].sourceAt, frozen.sourceAt);
  assert.equal(boundaries[0].sourceStartedAt, frozen.sourceStartedAt);
  assert.notEqual(boundaries[0].sourceAt, f.publication.sourceAt);
  assert.notEqual(boundaries[0].sourceAt, queried.sourceAt);
  assert.deepEqual(publication.checkpoint, queried.checkpoint);
  await assertReadableCharging(t, publication);
});

test('pending transfer clocks and wire bytes survive source writes, compaction and source reopen', async t => {
  const f = await fixture(t);
  f.source.setState('synthetic-current', 1);
  const frozen = preparePeerTransfer(f.source.db, { after: f.publication.checkpoint, clock: () => f.at + 3000 });
  const first = await f.transfers.export({ dbPath: f.source.path, after: f.publication.checkpoint });
  const wire = await readFile(join(f.transfers.directory, `peer-${first.id}.changes`));
  for (let i = 0; i < 8; i++) f.source.setState('synthetic-current', i + 2);
  f.source.compactJournal({ maxCommits: 1 });
  f.source.close();
  const reopened = new Store(f.source.path);
  try {
    const { status, cursor, ...retained } = preparePeerTransfer(reopened.db, { after: f.publication.checkpoint,
      clock: () => { throw Error('A retry must not acquire a new clock'); } });
    assert.deepEqual(retained, frozen);
    assert.equal(status, 'ready');
    assert.equal(cursor, null);
    const retry = await new PeerTransfers(f.transfers.directory).export({ dbPath: reopened.path, after: f.publication.checkpoint });
    assert.deepEqual(retry, first);
    assert.deepEqual(await readFile(join(f.transfers.directory, `peer-${retry.id}.changes`)), wire);
  } finally { reopened.close(); }
});

test('static source seeds preserve original snapshot clocks and reject a mismatched target without replacing a pending delivery', async t => {
  const f = await fixture(t);
  f.source.setState('synthetic-current', 1);
  const sourcePath = join(f.root, 'static.sqlite');
  const sourceSnapshot = await createSourceSnapshot({ dbPath: f.source.path, destination: sourcePath });
  f.source.setState('synthetic-later', 2);
  const pending = preparePeerTransfer(f.source.db, { after: f.publication.checkpoint });
  await ownedDirectory(f.transfers.directory, '.st-mq-peer-transfers');
  const before = f.source.db.prepare('SELECT * FROM journal_peer').all(), files = await readdir(f.root);
  for (const invalid of [undefined, { ...sourceSnapshot, sourceAt: 0 },
    { ...sourceSnapshot, checkpoint: f.source.checkpoint() }]) {
    assert.throws(() => preparePeerTransfer(f.source.db, { after: f.publication.checkpoint,
      sourcePath, sourceSnapshot: invalid, refresh: true }), { code: 'journal_peer_invalid' });
    assert.deepEqual(f.source.db.prepare('SELECT * FROM journal_peer').all(), before);
    assert.deepEqual(await readdir(f.root), files);
    await readFile(pending.path);
    await assert.rejects(f.transfers.export({ dbPath: f.source.path, after: pending.target,
      sourcePath, sourceSnapshot: invalid, refresh: true }), { code: 'journal_peer_invalid' });
    assert.deepEqual(f.source.db.prepare('SELECT * FROM journal_peer').all(), before,
      'the public export must reject before acknowledging an earlier delivery');
    await readFile(pending.path);
  }
  const frozen = preparePeerTransfer(f.source.db, { after: f.publication.checkpoint, sourcePath, sourceSnapshot, refresh: true,
    clock: () => { throw Error('Reading a static seed must not invent a new source clock'); } });
  assert.deepEqual(frozen.target, sourceSnapshot.checkpoint);
  assert.equal(frozen.sourceStartedAt, sourceSnapshot.sourceStartedAt);
  assert.equal(frozen.sourceAt, sourceSnapshot.sourceAt);
  assert(frozen.target.sequence < f.source.checkpoint().sequence);
});

test('unsupported saved deliveries fail before staging cleanup, seed acceptance or receipt mutation', async t => {
  const f = await fixture(t);
  f.source.setState('synthetic-current', 1);
  const pending = preparePeerTransfer(f.source.db, { after: f.publication.checkpoint });
  const { sourceStartedAt, sourceAt, ...old } = pending;
  const orphan = `${f.source.path}.peer-${randomUUID()}.sqlite.partial`;
  await writeFile(orphan, 'Preserve unsupported delivery staging');
  const spool = await readFile(pending.path);
  for (const unsupported of [false, 0, '', null, [], { ...old, version: 1 }, old, { ...pending, sourceAt: pending.sourceStartedAt - 1 },
    { ...pending, obsoleteAt: pending.sourceAt }]) {
    f.source.db.prepare('UPDATE journal_peer SET pending=?').run(JSON.stringify(unsupported));
    const before = f.source.db.prepare('SELECT * FROM journal_peer').all();
    assert.throws(() => preparePeerTransfer(f.source.db, { after: f.publication.checkpoint, refresh: true }),
      error => error.code === 'journal_peer_format_incompatible' && /matching software/.test(error.message));
    assert.throws(() => acceptPeerCheckpoint(f.source.db), { code: 'journal_peer_format_incompatible' });
    assert.throws(() => applyPeerTransfer(f.source.db, { ...pending, changes: [] }), { code: 'journal_peer_format_incompatible' });
    await assert.rejects(f.transfers.export({ dbPath: f.source.path, after: f.publication.checkpoint }),
      { code: 'journal_peer_format_incompatible' });
    assert.deepEqual(f.source.db.prepare('SELECT * FROM journal_peer').all(), before);
    assert.deepEqual(await readFile(pending.path), spool);
    assert.equal(await readFile(orphan, 'utf8'), 'Preserve unsupported delivery staging');
  }
  f.source.db.prepare('UPDATE journal_peer SET pending=?').run(JSON.stringify({ ...pending, path: join(f.root, 'unowned.sqlite') }));
  const before = f.source.db.prepare('SELECT * FROM journal_peer').all();
  assert.throws(() => preparePeerTransfer(f.source.db, { after: f.publication.checkpoint, refresh: true }),
    { code: 'journal_peer_conflict' });
  assert.deepEqual(f.source.db.prepare('SELECT * FROM journal_peer').all(), before);
  assert.deepEqual(await readFile(pending.path), spool);
  assert.equal(await readFile(orphan, 'utf8'), 'Preserve unsupported delivery staging');
});

test('unsupported delivery descriptors reject before downloading frames or changing replica rows', async t => {
  const f = await fixture(t);
  f.source.setState('synthetic-current', 1);
  const current = await f.transfers.export({ dbPath: f.source.path, after: f.publication.checkpoint });
  const { sourceAt, ...missing } = current;
  for (const descriptor of [{ ...current, version: 1 }, missing, { ...current, sourceAt: current.sourceStartedAt - 1 },
    { ...current, sourceAt: 'now' }, { ...current, obsoleteAt: current.sourceAt }]) {
    let frames = 0;
    const peer = { request: operation => {
      if (operation === 'peer-transfer') return descriptor;
      frames++; throw Error('Unsupported clocks must not request a frame');
    } };
    await assert.rejects(receivePeerTransfer({ directory: join(f.root, 'incoming'), peer, after: f.publication.checkpoint }),
      { code: 'invalid_protocol' });
    assert.equal(frames, 0);
    const replica = new Store(f.publication.dbPath, { readOnly: true });
    try { assert.deepEqual(replica.checkpoint(), f.publication.checkpoint); } finally { replica.close(); }
    assert.throws(() => peerPublicationBoundary(f.publication, descriptor), { code: 'invalid_protocol' });
  }
});

test('a transfer wire header or saved spool with substituted clocks cannot apply or acknowledge', async t => {
  const f = await fixture(t);
  f.source.setState('synthetic-current', 1);
  const transfer = await receivePeerTransfer({ directory: join(f.root, 'incoming'), peer: f.peer, after: f.publication.checkpoint });
  const wire = await readFile(transfer.path, 'utf8'), [first, ...rows] = wire.split('\n');
  const header = { ...JSON.parse(first), sourceAt: transfer.metadata.sourceAt + 1 };
  await writeFile(transfer.path, `${JSON.stringify(header)}\n${rows.join('\n')}`);
  await assert.rejects(peerOperation('apply', { dbPath: f.publication.dbPath, path: transfer.path, metadata: transfer.metadata }),
    { code: 'journal_peer_invalid' });
  const replica = new Store(f.publication.dbPath, { readOnly: true });
  try { assert.deepEqual(replica.checkpoint(), f.publication.checkpoint); } finally { replica.close(); }
  const pending = peerAnchor(f.source.db).pending, spool = new DatabaseSync(pending.path);
  let original;
  try {
    original = JSON.parse(spool.prepare('SELECT value FROM meta').get().value);
  } finally { spool.close(); }
  const { sourceStartedAt, sourceAt, ...untimestamped } = original;
  const orphan = `${f.source.path}.peer-${randomUUID()}.sqlite.partial`;
  await writeFile(orphan, 'Preserve staging when the delivery header is inconsistent');
  for (const damaged of [false, 0, '', null, [], { ...original, sourceAt: original.sourceAt + 1 },
    { ...untimestamped, version: 1 }, untimestamped, { ...original, obsoleteAt: original.sourceAt }]) {
    const writable = new DatabaseSync(pending.path);
    try { writable.prepare('UPDATE meta SET value=?').run(JSON.stringify(damaged)); } finally { writable.close(); }
    assert.throws(() => preparePeerTransfer(f.source.db, { after: pending.base, refresh: true }), { code: 'journal_peer_conflict' });
    await assert.rejects(f.transfers.export({ dbPath: f.source.path, after: pending.target }), { code: 'journal_peer_conflict' });
    assert.equal(await readFile(orphan, 'utf8'), 'Preserve staging when the delivery header is inconsistent');
    assert.throws(() => peerTransferRows(f.source.db, { id: pending.id }), { code: 'journal_peer_conflict' });
    await assert.rejects(peerOperation('acknowledge', { dbPath: f.source.path, checkpoint: pending.target }),
      { code: 'journal_peer_conflict' });
    assert.deepEqual(peerAnchor(f.source.db).checkpoint, f.publication.checkpoint);
  }
});

test('publication applies the delivery clock even when a caller supplies mismatched earlier metadata', async t => {
  const f = await fixture(t);
  f.source.setState('synthetic-current', 1);
  const frozen = preparePeerTransfer(f.source.db, { after: f.publication.checkpoint, clock: () => f.at + 5000 });
  const transfer = await receivePeerTransfer({ directory: join(f.root, 'incoming'), peer: f.peer, after: f.publication.checkpoint });
  const publication = await applyPeerPublication({ directory: f.directory, transfer,
    metadata: { ...f.publication, generation: randomUUID(), sourceStartedAt: 1, sourceAt: 1 } });
  assert.deepEqual(publication.checkpoint, frozen.target);
  assert.equal(publication.sourceStartedAt, frozen.sourceStartedAt);
  assert.equal(publication.sourceAt, frozen.sourceAt);
});
