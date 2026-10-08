import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, sample, start, W } from './helpers/recovery-fixture.js';
import { replayLearningJournal, appendLearningRecord } from '../src/app/committed-learning.js';
import { findLearningPrefix } from '../src/recovery/learning-prefix.js';
import { Store } from '../src/storage/store.js';
import { addFireplace } from '../src/app/fireplace.js';
import { addSensorChange, revertSensorChange } from '../src/app/sensor-changes.js';
import { enrollJournalPeer, preparePeerTransfer, peerTransferRows, applyPeerTransfer } from '../src/storage/journal-peer.js';

const caches = store => store.db.prepare('SELECT * FROM learning_checkpoints ORDER BY journal_cursor').all();

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
  assert.equal(f.master.getState('adaptive:mqtt'), null);
  sample(f.master, start + W);
  const model = replayLearningJournal(f.master, 'mqtt');
  const transfer = preparePeerTransfer(f.master.db, { after: base });
  applyPeerTransfer(replica.db, { ...transfer,
    changes: peerTransferRows(f.master.db, { id: transfer.id }).map(row => row.change) });
  assert.deepEqual(caches(replica), caches(f.master));
  assert.equal(caches(replica).length, 1);
  assert.deepEqual(replica.getState('adaptive:mqtt'), model);
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
