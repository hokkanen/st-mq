import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture, sample, start, W } from './helpers/recovery-fixture.js';
import { replayLearningJournal } from '../src/app/committed-learning.js';
import { enrollJournalPeer, rewindPeer } from '../src/storage/journal-peer.js';
import { verifyDatabase } from '../src/storage/full-verifier.js';
import { validateArchivedLearningCheckpointStorage } from '../src/storage/learning-checkpoint-archive.js';

function retainedBranch(t) {
  const f = fixture(t);
  sample(f.master, start + W);
  const original = replayLearningJournal(f.master, 'mqtt');
  enrollJournalPeer(f.master.db);
  const base = f.master.checkpoint();
  sample(f.master, start + 2 * W, { indoorC: 21.1 });
  const divergent = replayLearningJournal(f.master, 'mqtt', original);
  const branch = rewindPeer(f.master.db, { checkpoint: base });
  assert(branch);
  assert.deepEqual(f.master.getState('adaptive:mqtt'), original);
  return { ...f, branch, divergent };
}

test('full verification resolves compact divergent checkpoints after their bodies leave active tables', async t => {
  const f = retainedBranch(t);
  const row = f.master.db.prepare(`SELECT after_row FROM journal_peer_branch_rows
    WHERE branch_id=? AND table_name='learning_checkpoint_samples' AND before_row IS NULL LIMIT 1`).get(f.branch);
  assert(row, 'the divergent prepared sample is retained as inactive branch evidence');
  const archived = JSON.parse(row.after_row);
  assert.equal(f.master.db.prepare('SELECT 1 FROM learning_checkpoint_samples WHERE digest=?').get(archived.digest), undefined);
  const result = await verifyDatabase({ dbPath: f.master.path });
  assert.equal(result.journal.archivedPeerRows > 0, true);
  assert.equal(f.master.db.prepare('PRAGMA query_only').get().query_only, 0);
  assert.equal(f.master.db.prepare(`SELECT 1 FROM sqlite_temp_schema WHERE name='verification_learning_checkpoint_samples'`).get(), undefined);
});

test('archived checkpoint validation rejects damaged prepared bodies and removes private scratch', t => {
  const f = retainedBranch(t);
  const row = f.master.db.prepare(`SELECT ordinal,after_row FROM journal_peer_branch_rows
    WHERE branch_id=? AND table_name='learning_checkpoint_samples' AND after_row IS NOT NULL LIMIT 1`).get(f.branch);
  const body = JSON.parse(row.after_row);
  body.payload = JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', valid: false });
  f.master.db.prepare('UPDATE journal_peer_branch_rows SET after_row=? WHERE branch_id=? AND ordinal=?')
    .run(JSON.stringify(body), f.branch, row.ordinal);
  assert.throws(() => validateArchivedLearningCheckpointStorage(f.master.db), { code: 'database_integrity_failed' });
  assert.equal(f.master.db.prepare(`SELECT 1 FROM sqlite_temp_schema WHERE name='verification_learning_checkpoint_samples'`).get(), undefined);
});

test('archived manifests cannot silently reference missing bodies at a pinned read-only boundary', t => {
  const f = retainedBranch(t);
  const row = f.master.db.prepare(`SELECT ordinal,after_row FROM journal_peer_branch_rows
    WHERE branch_id=? AND table_name='state' AND after_row IS NOT NULL`).all(f.branch)
    .find(saved => JSON.parse(saved.after_row).key === 'adaptive:mqtt');
  const state = JSON.parse(row.after_row), compact = JSON.parse(state.value);
  compact.sampleRefs[0] = 'f'.repeat(64);
  state.value = JSON.stringify(compact);
  f.master.db.prepare('UPDATE journal_peer_branch_rows SET after_row=? WHERE branch_id=? AND ordinal=?')
    .run(JSON.stringify(state), f.branch, row.ordinal);
  const reader = new DatabaseSync(f.master.path, { readOnly: true });
  reader.exec('PRAGMA query_only=ON; PRAGMA temp_store=FILE; BEGIN');
  try {
    assert.throws(() => validateArchivedLearningCheckpointStorage(reader), { code: 'database_integrity_failed' });
    assert.equal(reader.prepare('PRAGMA query_only').get().query_only, 1);
    assert.equal(reader.isTransaction, true, 'caller owns the pinned read boundary');
  } finally { reader.exec('ROLLBACK'); reader.close(); }
});

test('an archive verification scratch collision preserves caller TEMP data and read settings', t => {
  const f = retainedBranch(t);
  const reader = new DatabaseSync(f.master.path, { readOnly: true });
  reader.exec(`PRAGMA temp_store=FILE;
    CREATE TEMP TABLE verification_learning_checkpoint_samples(marker TEXT);
    INSERT INTO verification_learning_checkpoint_samples VALUES('caller-owned');
    PRAGMA query_only=ON; BEGIN`);
  try {
    assert.throws(() => validateArchivedLearningCheckpointStorage(reader), { code: 'database_integrity_failed' });
    assert.equal(reader.prepare('SELECT marker FROM temp.verification_learning_checkpoint_samples').get().marker, 'caller-owned');
    assert.equal(reader.prepare('PRAGMA query_only').get().query_only, 1);
    assert.equal(reader.isTransaction, true);
  } finally { reader.exec('ROLLBACK'); reader.close(); }
});
