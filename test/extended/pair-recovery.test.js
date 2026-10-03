import test from 'node:test';
import assert from 'node:assert/strict';
import { learningCatchup, energyCatchup, fixture, sample, recover, start, W } from '../helpers/recovery-fixture.js';
import { previewRecoveryRevision, reviseRecovery } from '../../src/recovery/service.js';
import { replayLearningJournal, recordLearningContext } from '../../src/app/committed-learning.js';

test('a missing week feeds chronological learning, catches up live records, and retains the original journal',
  t => learningCatchup(t, 7 * 96));

test('a week of phase energy is imported in bounded batches while the master continues recording',
  t => energyCatchup(t, 7 * 24 * 12));

test('a recovered week can be reverted and restored while live learning continues with exact replay', async t => {
  const f = fixture(t), windows = 7 * 96, prefix = 8;
  recordLearningContext(f.master, 'mqtt', { phase: 'normal', regime: 'occupied', targetC: 21, roomBoostC: 0 }, start);
  for (let i = 1; i <= prefix; i++) sample(f.master, start + i * W);
  const donor = await f.donor();
  for (let i = prefix + 1; i <= prefix + windows; i++)
    sample(donor, start + i * W, { indoorC: 21 + Math.sin(i / 30) * 0.1 });
  let beats = 0;
  const timer = setInterval(() => { beats++; }, 5);
  t.after(() => clearInterval(timer));
  const recovered = await recover(f, await f.snapshot(donor));
  assert.equal(recovered.report.model.acceptedSamples, windows);
  assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), recovered.checkpoint);
  let tail = prefix + windows + 1;
  sample(f.master, start + tail * W, { indoorC: 20.75 });
  const originals = f.master.db.prepare(`SELECT * FROM learning_journal_entries
    WHERE source_entry_id IS NULL ORDER BY id`).all();
  const originalHead = originals.at(-1).id;
  const revisions = [];
  for (const active of [false, true]) {
    const args = { store: f.master, input: 'mqtt', recoveryId: recovered.report.recoveryId, active, signal: f.signal };
    const preview = await previewRecoveryRevision(args);
    const previousEpoch = f.master.learningEpoch('mqtt'), previousBeats = beats;
    let liveWritten = false, rebuildMessages = 0;
    const result = await reviseRecovery({ ...args, preview, onProgress(progress) {
      if (progress.phase !== 'rebuilding') return;
      rebuildMessages++;
      if (!liveWritten) {
        liveWritten = true; tail++;
        sample(f.master, start + tail * W, { indoorC: 20.75 });
        assert.equal(f.master.learningEpoch('mqtt'), previousEpoch,
          'the current interpretation remains selected while a replacement is staged');
      }
    } });
    assert(liveWritten, 'live learning can commit during each background revision');
    assert(beats > previousBeats, 'each revision leaves the timer queue responsive');
    assert(rebuildMessages > 1, 'replay reports progress between bounded work batches');
    assert.equal(result.checkpoint.windowCursor, start + tail * W, 'publication catches up the concurrently recorded native tail');
    assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), result.checkpoint,
      'the selected journal exactly reproduces every published model');
    const selected = f.master.learningJournal({ input: 'mqtt', limit: 1000 }).filter(row => row.kind === 'sample');
    assert.equal(selected.length, active ? tail : tail - windows);
    assert(selected.some(row => row.at === start + (prefix + windows + 1) * W),
      'the local sample written after recovery remains selected throughout');
    assert.equal(selected.some(row => row.at === start + (prefix + 1) * W), active);
    assert.deepEqual(f.master.db.prepare(`SELECT * FROM learning_journal_entries
      WHERE source_entry_id IS NULL AND id<=? ORDER BY id`).all(originalHead), originals,
    'revisions retain the exact original input payloads');
    revisions.push({ active, heartbeatTicks: beats - previousBeats, rebuildMessages, selectedSamples: selected.length });
  }
  const storage = f.master.db.prepare(`SELECT COUNT(*) entries,SUM(source_entry_id IS NULL) originalInputs,
    SUM(source_entry_id IS NOT NULL) referencesCount FROM learning_journal_entries`).get();
  assert.equal(storage.originalInputs, originals.length + 2, 'replaying does not duplicate the week of original inputs');
  assert.equal(f.master.db.prepare(`SELECT COUNT(*) n FROM learning_journal_entries a
    JOIN learning_journal_entries b ON a.source_entry_id=b.id WHERE b.source_entry_id IS NOT NULL`).get().n, 0,
  'projection references stay direct rather than growing chains across reversals');
  assert.equal(f.master.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(f.master.db.prepare('PRAGMA foreign_key_check').get(), undefined);
  t.diagnostic(JSON.stringify({ recoveredWindows: windows, revisions, ...storage }));
});
