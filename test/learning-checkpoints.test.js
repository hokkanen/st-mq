import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, sample, start, W } from './helpers/recovery-fixture.js';
import { replayLearningJournal, appendLearningRecord, learningCheckpointDigest } from '../src/app/committed-learning.js';
import { findLearningPrefix } from '../src/recovery/learning-prefix.js';
import { Store } from '../src/storage/store.js';
import { addFireplace } from '../src/app/fireplace.js';
import { addSensorChange, revertSensorChange } from '../src/app/sensor-changes.js';
import { enrollJournalPeer, preparePeerTransfer, peerTransferRows, applyPeerTransfer, rewindPeer, acknowledgePeer } from '../src/storage/journal-peer.js';
import { decodeLearningCheckpoint, learningCheckpointSampleReferences } from '../src/storage/learning-checkpoint-storage.js';
import { saveLearningCheckpoint } from '../src/storage/learning-checkpoints.js';
import { verifyJournal } from '../src/storage/journal.js';
import { verifyDatabase } from '../src/storage/full-verifier.js';
import { encodeChange, changeContentHash } from '../src/storage/journal-codec.js';

const caches = store => store.db.prepare('SELECT * FROM learning_checkpoints ORDER BY journal_cursor').all();
const bodies = store => store.db.prepare('SELECT * FROM learning_checkpoint_samples ORDER BY digest').all();
const compactState = store => JSON.parse(store.db.prepare("SELECT value FROM state WHERE key='adaptive:mqtt'").get().value);
function assertManifest(store, compact, full) {
  assert.equal(compact.checkpointStorageVersion, 1);
  assert.equal(Object.hasOwn(compact, 'samples'), false);
  assert.deepEqual(decodeLearningCheckpoint(store.db, compact), full);
  for (const digest of learningCheckpointSampleReferences(compact))
    assert(store.db.prepare('SELECT 1 FROM learning_checkpoint_samples WHERE digest=?').get(digest));
}

test('learning caches use sparse source-time cadence and remain available after mutation cleanup and restart', async t => {
  const f = fixture(t);
  sample(f.master, start + W);
  let model = replayLearningJournal(f.master, 'mqtt');
  const initial = model;
  for (let index = 2; index <= 24; index++) {
    sample(f.master, start + index * W);
    model = replayLearningJournal(f.master, 'mqtt', model);
  }
  assert.equal(caches(f.master).length, 1, 'ordinary quarter-hour updates do not create model snapshots');
  sample(f.master, start + 25 * W);
  model = replayLearningJournal(f.master, 'mqtt', model);
  assert.equal(caches(f.master).length, 2, 'six hours of source time creates the next reusable boundary');
  assertManifest(f.master, compactState(f.master), model);
  assertManifest(f.master, JSON.parse(caches(f.master)[0].payload), initial);
  assert.equal(caches(f.master)[1].payload,
    f.master.db.prepare("SELECT value FROM state WHERE key='adaptive:mqtt'").get().value,
    'the seal reuses the already encoded active manifest without another body insertion');
  f.master.setState('synthetic-bookkeeping', { value: 1 });
  f.master.compactJournal({ maxBytes: 1, maxCommits: 1 });
  const reader = new Store(f.master.path, { readOnly: true });
  t.after(() => reader.close());
  const prefix = await findLearningPrefix(reader, { input: 'mqtt', epoch: 'original', earliest: start + 2 * W,
    yieldControl: async () => {} });
  assert.equal(prefix.cursor, initial.journalCursor);
  assert.deepEqual(prefix.checkpoint, initial);
  assert.equal(caches(reader).length, 2);
});

test('cache insert and model publication roll back together and replicate as ordinary rows', async t => {
  const f = fixture(t);
  enrollJournalPeer(f.master.db);
  const replica = await f.donor(), base = replica.checkpoint();
  const initialHead = f.master.checkpoint();
  assert.throws(() => f.master.transaction(() => {
    sample(f.master, start + W);
    replayLearningJournal(f.master, 'mqtt');
    throw new Error('synthetic interruption before commit');
  }), /synthetic interruption/);
  assert.deepEqual(f.master.checkpoint(), initialHead);
  assert.equal(caches(f.master).length, 0);
  assert.equal(bodies(f.master).length, 0, 'rollback leaves no orphan prepared bodies');
  assert.equal(f.master.getState('adaptive:mqtt'), null);
  sample(f.master, start + W);
  const model = replayLearningJournal(f.master, 'mqtt');
  const transfer = preparePeerTransfer(f.master.db, { after: base });
  applyPeerTransfer(replica.db, { ...transfer,
    changes: peerTransferRows(f.master.db, { id: transfer.id }).map(row => row.change) });
  assert.deepEqual(caches(replica), caches(f.master));
  assert.deepEqual(bodies(replica), bodies(f.master), 'new manifest dependencies travel in the same incremental commit');
  assert.equal(caches(replica).length, 1);
  assert.deepEqual(replica.getState('adaptive:mqtt'), model);
});

test('a directly saved prefix journals newly prepared interpretations atomically without an active cache', async t => {
  const f = fixture(t);
  sample(f.master, start + W, { quality: ['missing'], indoorSensors: {
    indoor_temperature: { value: null, weight: 1, observedAt: start - W, receivedAt: start + W } } });
  const baseline = replayLearningJournal(f.master, 'mqtt');
  assert.equal(baseline.samples[0].valid, false, 'invalid endpoints remain part of the exact prepared working set');
  enrollJournalPeer(f.master.db);
  const replica = await f.donor(), base = replica.checkpoint();
  const checkpoint = structuredClone(baseline);
  checkpoint.sensorRevision = 1;
  checkpoint.samples[0].measurementEpochAt = start;
  checkpoint.checkpointDigest = learningCheckpointDigest(checkpoint);
  const before = bodies(f.master);
  assert.throws(() => f.master.transaction(() => {
    saveLearningCheckpoint(f.master.db, { input: 'mqtt', epoch: 'original', checkpoint });
    throw Error('synthetic interrupted prefix publication');
  }), /interrupted prefix/);
  assert.deepEqual(bodies(f.master), before);
  f.master.transaction(() => saveLearningCheckpoint(f.master.db, { input: 'mqtt', epoch: 'original', checkpoint }));
  const saved = caches(f.master).find(row => row.sensor_revision === 1);
  assertManifest(f.master, JSON.parse(saved.payload), checkpoint);
  assert.deepEqual(f.master.getState('adaptive:mqtt'), baseline, 'saving a prefix does not replace the active model');
  const transfer = preparePeerTransfer(f.master.db, { after: base });
  const changes = peerTransferRows(f.master.db, { id: transfer.id }).map(row => row.change);
  assert.deepEqual(changes.map(change => change.table).sort(), ['learning_checkpoint_samples', 'learning_checkpoints']);
  const missingBody = changes.filter(change => change.table !== 'learning_checkpoint_samples');
  const oldHead = replica.checkpoint(), oldBodies = bodies(replica), oldCaches = caches(replica);
  const baseContent = replica.db.prepare('SELECT content_hash FROM journal_meta WHERE id=1').get().content_hash;
  assert.throws(() => applyPeerTransfer(replica.db, { ...transfer, changes: missingBody, rows: missingBody.length,
    contentHash: changeContentHash(baseContent, missingBody) }), { code: 'database_integrity_failed' });
  assert.deepEqual(replica.checkpoint(), oldHead);
  assert.deepEqual(bodies(replica), oldBodies);
  assert.deepEqual(caches(replica), oldCaches, 'a fingerprint-consistent sparse-only dangling manifest cannot publish');
  applyPeerTransfer(replica.db, { ...transfer, changes: [...changes].reverse() });
  assertManifest(replica, JSON.parse(caches(replica).find(row => row.sensor_revision === 1).payload), checkpoint);
  verifyJournal(replica.db);
});

test('incoming prepared-body corruption, mutation and deletion retain the checked receiver boundary', async t => {
  const f = fixture(t);
  sample(f.master, start + W);
  const model = replayLearningJournal(f.master, 'mqtt');
  enrollJournalPeer(f.master.db);
  const replica = await f.donor(), base = replica.checkpoint();
  const row = bodies(replica)[0];
  const content = replica.db.prepare('SELECT content_hash FROM journal_meta WHERE id=1').get().content_hash;
  for (const after of [null, { ...row, payload: JSON.stringify({ timestamp: 999, valid: false }) }]) {
    const changes = [encodeChange('learning_checkpoint_samples', [row.digest], row, after)];
    assert.throws(() => applyPeerTransfer(replica.db, { base, target: { ...base, sequence: base.sequence + 1, hash: 'a'.repeat(64) },
      contentHash: changeContentHash(content, changes), changes, rows: 1 }), { code: 'journal_peer_conflict' });
    assert.deepEqual(replica.checkpoint(), base);
    assert.deepEqual(bodies(replica), [row]);
    assert.deepEqual(replica.getState('adaptive:mqtt'), model);
  }
  sample(f.master, start + 2 * W);
  replayLearningJournal(f.master, 'mqtt', model);
  const transfer = preparePeerTransfer(f.master.db, { after: base });
  const changes = peerTransferRows(f.master.db, { id: transfer.id }).map(row => row.change);
  const bodyIndex = changes.findIndex(change => change.table === 'learning_checkpoint_samples');
  assert(bodyIndex >= 0);
  const body = changes[bodyIndex].after;
  changes[bodyIndex] = encodeChange('learning_checkpoint_samples', [body.digest], null,
    { ...body, payload: JSON.stringify({ timestamp: 999, valid: false }) });
  assert.throws(() => applyPeerTransfer(replica.db, { ...transfer, changes,
    contentHash: changeContentHash(content, changes) }), { code: 'database_integrity_failed' });
  assert.deepEqual(replica.checkpoint(), base);
  assert.deepEqual(replica.getState('adaptive:mqtt'), model);
  assert.deepEqual(bodies(replica), [row]);
  verifyJournal(replica.db);
});

test('protected rewind archives new prepared bodies and compact manifests before incremental rejoin and resume', async t => {
  const f = fixture(t);
  sample(f.master, start + W);
  const baseline = replayLearningJournal(f.master, 'mqtt');
  enrollJournalPeer(f.master.db);
  const replica = await f.donor(), base = replica.checkpoint();
  sample(replica, start + 2 * W, { indoorC: 24 });
  const divergent = replayLearningJournal(replica, 'mqtt', baseline);
  const divergentManifest = compactState(replica);
  const baselineRefs = new Set(learningCheckpointSampleReferences(compactState(f.master)));
  const divergentRefs = learningCheckpointSampleReferences(divergentManifest).filter(digest => !baselineRefs.has(digest));
  assert(divergentRefs.length > 0);
  replica.setState('synthetic-branch-bookkeeping', true);
  replica.compactJournal({ maxCommits: 1 });
  const branch = rewindPeer(replica.db, { checkpoint: base });
  assert.deepEqual(replica.getState('adaptive:mqtt'), baseline);
  const archived = replica.db.prepare('SELECT table_name,after_row FROM journal_peer_branch_rows WHERE branch_id=?').all(branch);
  const archivedBodies = archived.filter(row => row.table_name === 'learning_checkpoint_samples').map(row => JSON.parse(row.after_row));
  for (const digest of divergentRefs) {
    assert(archivedBodies.some(row => row.digest === digest), 'rewind preserves bodies removed from the active table');
    assert.equal(replica.db.prepare('SELECT 1 FROM learning_checkpoint_samples WHERE digest=?').get(digest), undefined);
  }
  assert.deepEqual(JSON.parse(archived.find(row => row.table_name === 'state'
    && JSON.parse(row.after_row).key === 'adaptive:mqtt').after_row).value, JSON.stringify(divergentManifest));
  assert.notDeepEqual(divergent, baseline);
  await verifyDatabase({ dbPath: replica.path });
  sample(f.master, start + 2 * W, { indoorC: 20 });
  const current = replayLearningJournal(f.master, 'mqtt', baseline);
  const transfer = preparePeerTransfer(f.master.db, { after: base });
  applyPeerTransfer(replica.db, { ...transfer,
    changes: peerTransferRows(f.master.db, { id: transfer.id }).map(row => row.change) });
  acknowledgePeer(f.master.db, { checkpoint: transfer.target });
  assert.deepEqual(replica.getState('adaptive:mqtt'), current);
  await verifyDatabase({ dbPath: replica.path });
  sample(replica, start + 3 * W);
  const resumed = replayLearningJournal(replica, 'mqtt', current);
  const returning = preparePeerTransfer(replica.db, { after: f.master.checkpoint() });
  applyPeerTransfer(f.master.db, { ...returning,
    changes: peerTransferRows(replica.db, { id: returning.id }).map(row => row.change) });
  assert.deepEqual(f.master.getState('adaptive:mqtt'), resumed);
  verifyJournal(f.master.db);
});

test('entry cadence remains bounded when source timestamps do not advance', t => {
  const f = fixture(t);
  for (let index = 0; index < 513; index++) appendLearningRecord(f.master, 'mqtt', 'context',
    { timestamp: start, phase: 'normal', regime: 'occupied', targetC: 21, roomBoostC: index / 1000 }, { config: {} });
  replayLearningJournal(f.master, 'mqtt');
  const rows = caches(f.master);
  assert.deepEqual(rows.map(row => row.journal_cursor), [256, 512]);
  assert(rows.every(row => row.at === start));
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM learning_journal_entries').get().n, 513);
});

for (const correction of ['fireplace', 'sensor']) test(`a sparse cache cannot hide an earlier ${correction} revision difference`, async t => {
  const f = fixture(t);
  const sensor = correction === 'sensor' ? addSensorChange(f.master, 'mqtt',
    { signal: 'indoor_temperature', reason: 'replacement', requestId: 'synthetic-source-boundary' }, start + W, { config: {} }) : null;
  sample(f.master, start + 2 * W);
  replayLearningJournal(f.master, 'mqtt');
  const revision = correction === 'sensor' ? revertSensorChange(f.master, 'mqtt',
    { id: sensor.id, requestId: 'synthetic-source-reversal' }, start + 3 * W, { config: {} }).revision
    : addFireplace(f.master, 'mqtt', { kg: 2, requestId: 'synthetic-backdated-load' }, start + W).revision;
  f.master.setState('synthetic-bookkeeping', { value: 1 });
  f.master.compactJournal({ maxBytes: 1, maxCommits: 1 });
  const prefix = await findLearningPrefix(f.master, { input: 'mqtt', epoch: 'original', earliest: start + 4 * W,
    fireplaceRevision: correction === 'fireplace' ? revision : 0, sensorRevision: correction === 'sensor' ? revision : 0,
    yieldControl: async () => {} });
  assert.equal(prefix, null, 'the earlier source correction already changes this cache even though the next correction is later');
});

test('equal maximum fireplace revisions do not hide a changed saved history selection', async t => {
  const f = fixture(t);
  const old = addFireplace(f.master, 'mqtt', { kg: 2, requestId: 'synthetic-old-load' }, start + W);
  const latest = addFireplace(f.master, 'mqtt', { kg: 2, requestId: 'synthetic-later-load' }, start + 2 * W);
  sample(f.master, start + 3 * W);
  replayLearningJournal(f.master, 'mqtt');
  // Independently retained cache from the original selection remains available
  // when the current model is absent. Excluding an older load keeps MAX(id).
  f.master.transaction(() => {
    f.master.setState('adaptive:mqtt', null);
    f.master.db.prepare("INSERT INTO recovery_exclusions VALUES('synthetic-selection','fireplace_events',?,'rejected')").run(String(old.id));
    f.master.db.prepare("UPDATE history_selection SET generation='synthetic-selection' WHERE id=1").run();
  });
  f.master.setState('synthetic-bookkeeping', { value: 1 });
  f.master.compactJournal({ maxBytes: 1, maxCommits: 1 });
  const prefix = await findLearningPrefix(f.master, { input: 'mqtt', epoch: 'original', earliest: start + 4 * W,
    fireplaceRevision: latest.revision, yieldControl: async () => {} });
  assert.equal(prefix, null, 'the saved selection changes earlier heat despite equal numeric revisions and journal ranges');
});
