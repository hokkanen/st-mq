import { validLearningCheckpoint } from '../app/committed-learning.js';
import { LEARNING_ALGORITHM } from '../domain/learning-contract.js';
import { encodeChange } from './journal-codec.js';

// Sparse replay acceleration, independent of the disposable replication suffix.
// These caches retain no new observations and never replace the immutable inputs.
export const LEARNING_CHECKPOINT_INTERVAL = Object.freeze({ entries: 256, milliseconds: 6 * 3_600_000 });

const decode = row => ({ id: row.id, key: row.key, kind: row.kind, at: row.at,
  algorithmVersion: row.algorithm_version, configVersion: row.config_version === null ? null : JSON.parse(row.config_version),
  forecastVersion: row.forecast_version === null ? null : JSON.parse(row.forecast_version), payload: JSON.parse(row.payload) });

/** Cache a validated boundary inside the caller's publication transaction.
 * Recovery also preserves its proven unaffected prefix with the newly selected
 * source revisions, so a later reversal can use it after journal compaction. */
export function saveLearningCheckpoint(db, { input, epoch, checkpoint }) {
  if (!checkpoint) return null;
  const fireplaceRevision = checkpoint.fireplaceRevision ?? 0, sensorRevision = checkpoint.sensorRevision ?? 0;
  const entry = db.prepare('SELECT * FROM learning_journal_all WHERE epoch=? AND input=? AND id=?')
    .get(epoch, input, checkpoint.journalCursor);
  if (!entry || !validLearningCheckpoint(checkpoint, decode(entry))
    || ![fireplaceRevision, sensorRevision].every(value => Number.isSafeInteger(value) && value >= 0))
    throw new Error('The learning checkpoint boundary is invalid');
  const row = { input, epoch, journal_cursor: checkpoint.journalCursor, at: entry.at,
    fireplace_revision: fireplaceRevision, sensor_revision: sensorRevision,
    history_selection: db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation,
    payload: JSON.stringify(checkpoint) };
  const inserted = db.prepare(`INSERT INTO learning_checkpoints
    (input,epoch,journal_cursor,at,fireplace_revision,sensor_revision,history_selection,payload) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(input,epoch,fireplace_revision,sensor_revision,journal_cursor) DO NOTHING`)
    .run(...Object.values(row));
  return inserted.changes ? encodeChange('learning_checkpoints',
    [input, epoch, fireplaceRevision, sensorRevision, checkpoint.journalCursor], null, row) : null;
}

/** Called by the outer transaction seal. Capture only a supported, committed
 * model boundary, atomically with its state and ordinary replicated row changes.
 * The caller includes returned inserts in that same commit and clears capture. */
export function captureLearningCheckpoints(db, changes) {
  const captured = [];
  for (const change of changes) {
    if (change.table !== 'state' || change.after === null || !change.key[0].startsWith('adaptive:')) continue;
    const input = change.key[0].slice('adaptive:'.length);
    const saved = db.prepare('SELECT value FROM state WHERE key=?').get(change.key[0]);
    let checkpoint;
    try { checkpoint = JSON.parse(saved?.value); } catch { continue; }
    if (checkpoint?.algorithmVersion !== LEARNING_ALGORITHM || !Number.isSafeInteger(checkpoint.journalCursor)
      || checkpoint.journalCursor <= 0) continue;
    const epoch = db.prepare('SELECT epoch FROM learning_epochs WHERE input=?').get(input)?.epoch ?? 'original';
    const fireplaceRevision = checkpoint.fireplaceRevision ?? 0, sensorRevision = checkpoint.sensorRevision ?? 0;
    if (![fireplaceRevision, sensorRevision].every(value => Number.isSafeInteger(value) && value >= 0)) continue;
    const latest = db.prepare(`SELECT journal_cursor,at,fireplace_revision,sensor_revision FROM learning_checkpoints
      WHERE input=? AND epoch=? ORDER BY journal_cursor DESC LIMIT 1`).get(input, epoch);
    const entry = db.prepare('SELECT * FROM learning_journal_all WHERE epoch=? AND input=? AND id=?')
      .get(epoch, input, checkpoint.journalCursor);
    if (!entry) continue;
    const sameRevision = latest?.fireplace_revision === fireplaceRevision && latest?.sensor_revision === sensorRevision;
    if (sameRevision && entry.at - latest.at < LEARNING_CHECKPOINT_INTERVAL.milliseconds) {
      if (checkpoint.journalCursor - latest.journal_cursor < LEARNING_CHECKPOINT_INTERVAL.entries) continue;
      const count = db.prepare(`SELECT COUNT(*) n FROM (SELECT id FROM learning_journal_all
        WHERE epoch=? AND input=? AND id>? AND id<=? ORDER BY id LIMIT ?)`)
        .get(epoch, input, latest.journal_cursor, checkpoint.journalCursor, LEARNING_CHECKPOINT_INTERVAL.entries).n;
      if (count < LEARNING_CHECKPOINT_INTERVAL.entries) continue;
    }
    if (!validLearningCheckpoint(checkpoint, decode(entry))) continue;
    const inserted = saveLearningCheckpoint(db, { input, epoch, checkpoint });
    if (inserted) captured.push(inserted);
  }
  return captured;
}
