import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync, backup } from 'node:sqlite';
import { validateCurrentDatabase } from './store.js';

function validate(db) {
  validateCurrentDatabase(db);
  const rows = db.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok')
    throw Object.assign(new Error('Invalid database'), { code: 'backup_source_invalid' });
}

let phase = 'validate';
try {
  if (workerData.sourcePath) {
    const source = new DatabaseSync(workerData.sourcePath, { readOnly: true });
    try {
      source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN');
      validate(source);
      phase = 'copy';
      await backup(source, workerData.path, { rate: 256 });
      source.exec('ROLLBACK');
    } finally { source.close(); }
  }
  phase = 'validate';
  const check = new DatabaseSync(workerData.path, { readOnly: true });
  try { validate(check); } finally { check.close(); }
  phase = 'finalize';
  const snapshot = new DatabaseSync(workerData.path);
  try {
    if (snapshot.prepare('PRAGMA journal_mode=DELETE').get().journal_mode !== 'delete')
      throw Object.assign(new Error('Database backup journal could not be finalized'), { code: 'backup_failed' });
  } finally { snapshot.close(); }
  parentPort.postMessage({ ok: true });
} catch (error) {
  // Never expose SQLite errors containing source values or private file paths.
  const sqliteCode = Number(error?.errcode) & 0xff;
  const code = ['database_schema_mismatch', 'database_schema_invalid'].includes(error?.code)
    ? 'backup_source_incompatible'
    : phase !== 'validate' || error?.code === 'backup_failed' || [5, 6, 7, 10, 13, 14, 15].includes(sqliteCode)
      ? 'backup_failed' : 'backup_source_invalid';
  parentPort.postMessage({ ok: false, code });
}
