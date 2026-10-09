import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync, backup } from 'node:sqlite';
import { validateCurrentDatabase, validateWalHeader } from './store.js';
import { readCheckpoint } from './journal.js';
import { databaseErrorDetails } from './database-errors.js';
import { stampBackupMetadata } from './backup-metadata.js';

function validate(db) {
  validateCurrentDatabase(db);
  const rows = db.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok')
    throw Object.assign(new Error('Invalid database'), { code: 'backup_source_invalid' });
}

let phase = 'validate';
let checkpoint = workerData.checkpoint;
let progressAt = 0, progressPhase;
const progress = value => {
  if (value.phase !== progressPhase || Date.now() - progressAt >= 100 || value.processed === value.total) {
    parentPort.postMessage({ type: 'progress', ...value }); progressAt = Date.now(); progressPhase = value.phase;
  }
};
try {
  progress({ phase: 'validating', processed: 0 });
  if (workerData.sourcePath) {
    validateWalHeader(workerData.sourcePath);
    const source = new DatabaseSync(workerData.sourcePath, { readOnly: true });
    try {
      source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN');
      source.prepare('PRAGMA schema_version').get();
      validate(source);
      checkpoint = readCheckpoint(source);
      phase = 'copy';
      progress({ phase: 'snapshotting', processed: 0 });
      const pages = await backup(source, workerData.path, { rate: 256,
        progress: ({ remainingPages, totalPages }) => progress({ phase: 'snapshotting',
          processed: totalPages - remainingPages, total: totalPages, unit: 'pages' }) });
      progress({ phase: 'snapshotting', processed: pages, total: pages, unit: 'pages' });
      source.exec('ROLLBACK');
    } finally { source.close(); }
  }
  phase = 'validate';
  progress({ phase: 'validating', processed: 0 });
  const check = new DatabaseSync(workerData.path, { readOnly: true });
  try { validate(check); checkpoint ??= readCheckpoint(check); } finally { check.close(); }
  phase = 'finalize';
  progress({ phase: 'finalizing', processed: 0 });
  const snapshot = new DatabaseSync(workerData.path);
  try {
    stampBackupMetadata(snapshot, workerData.exportedAt);
    if (snapshot.prepare('PRAGMA journal_mode=DELETE').get().journal_mode !== 'delete')
      throw Object.assign(new Error('Database backup journal could not be finalized'), { code: 'backup_failed' });
  } finally { snapshot.close(); }
  parentPort.postMessage({ ok: true, checkpoint });
} catch (error) {
  // Never expose SQLite errors containing source values or private file paths.
  const sqliteCode = Number(error?.errcode) & 0xff;
  const details = databaseErrorDetails(error);
  const code = details && !['database_integrity_failed', 'database_journal_invalid'].includes(details.code)
    ? 'backup_source_incompatible'
    : phase !== 'validate' || error?.code === 'backup_failed' || [5, 6, 7, 10, 13, 14, 15].includes(sqliteCode)
      ? 'backup_failed' : 'backup_source_invalid';
  parentPort.postMessage({ ok: false, code, ...(details ? { details } : {}) });
}
