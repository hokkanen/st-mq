import { learningCheckpointSampleReferences, validateLearningCheckpointSample } from './learning-checkpoint-storage.js';
import { journalConnection } from './journal.js';
import { isWriterDatabase } from './writer-database.js';

const invalid = () => Object.assign(new Error('Archived learning checkpoint evidence is incomplete or invalid.'),
  { code: 'database_integrity_failed' });
const SAMPLE_TABLE = 'learning_checkpoint_samples';
const SCRATCH = 'verification_learning_checkpoint_samples';

/** Full verification only. Rewinding a protected peer can move cache bodies out
 * of active tables into retained branch rows. Resolve those immutable hashes
 * through disk-backed scratch, without rebuilding a database or retaining all
 * archived payloads in JavaScript memory. The caller pins one read boundary. */
export function validateArchivedLearningCheckpointStorage(db) {
  if (isWriterDatabase(db)) throw Object.assign(new Error('Full verification requires its dedicated storage worker. Use the database verification service.'),
    { code: 'journal_worker_required' });
  const connection = journalConnection(db);
  if (!connection.prepare(`SELECT 1 FROM journal_peer_branch_rows
    WHERE table_name IN ('learning_checkpoint_samples','learning_checkpoints','state') LIMIT 1`).get()) return;
  const queryOnly = connection.prepare('PRAGMA query_only').get().query_only;
  let created = false;
  try {
    // The MAIN connection remains read-only during full verification. TEMP
    // scratch is private to this connection and cannot change retained evidence.
    connection.exec(`PRAGMA query_only=OFF;
      CREATE TEMP TABLE ${SCRATCH}(digest TEXT PRIMARY KEY) WITHOUT ROWID;`);
    created = true;
    const insert = connection.prepare(`INSERT OR IGNORE INTO temp.${SCRATCH} VALUES(?)`);
    for (const archived of connection.prepare(`SELECT before_row,after_row FROM journal_peer_branch_rows
      WHERE table_name=?`).iterate(SAMPLE_TABLE)) {
      for (const payload of [archived.before_row, archived.after_row]) {
        if (payload === null) continue;
        const row = JSON.parse(payload);
        validateLearningCheckpointSample(row);
        // Closure needs only validated identities. The body remains preserved
        // in the pinned branch evidence; copying it to TEMP adds no verification.
        insert.run(row.digest);
      }
    }
    for (const archived of connection.prepare(`SELECT table_name,before_row,after_row FROM journal_peer_branch_rows
      WHERE table_name IN ('learning_checkpoints','state')`).iterate()) {
      for (const payload of [archived.before_row, archived.after_row]) {
        if (payload === null) continue;
        const row = JSON.parse(payload);
        if (archived.table_name === 'state' && !row.key.startsWith('adaptive:')) continue;
        const compact = JSON.parse(archived.table_name === 'state' ? row.value : row.payload);
        const references = learningCheckpointSampleReferences(compact);
        for (let offset = 0; offset < references.length; offset += 128) {
          const batch = references.slice(offset, offset + 128);
          const placeholders = batch.map(() => '?').join(',');
          const resolved = connection.prepare(`SELECT digest FROM ${SAMPLE_TABLE} WHERE digest IN (${placeholders})
            UNION SELECT digest FROM temp.${SCRATCH} WHERE digest IN (${placeholders})`).all(...batch, ...batch);
          if (resolved.length !== batch.length) throw invalid();
        }
      }
    }
  } catch (error) {
    if (error?.code === 'database_integrity_failed') throw error;
    throw invalid();
  } finally {
    try { if (created) connection.exec(`DROP TABLE temp.${SCRATCH}`); }
    finally { connection.exec(`PRAGMA query_only=${queryOnly}`); }
  }
}
