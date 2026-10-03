import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync, backup } from 'node:sqlite';
import { open, rm } from 'node:fs/promises';
import { normalizeSnapshot, snapshotDigest } from './publication.js';
import { validateCurrentDatabase } from '../storage/store.js';
import { databaseErrorDetails } from '../storage/database-errors.js';

try {
  const file = await open(workerData.destination, 'wx', 0o600);
  await file.close();
  const db = new DatabaseSync(workerData.dbPath, { readOnly: true });
  let sourceStartedAt, sourceAt;
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN');
    // Pin a read snapshot before starting the incremental backup. A busy live
    // writer cannot keep restarting the backup, and remains free to append WAL.
    sourceStartedAt = Date.now();
    db.prepare('PRAGMA schema_version').get();
    validateCurrentDatabase(db);
    sourceAt = Date.now();
    await backup(db, workerData.destination, { rate: 256 });
    db.exec('ROLLBACK');
  } finally { db.close(); }
  normalizeSnapshot(workerData.destination);
  const digest = await snapshotDigest(workerData.destination);
  parentPort.postMessage({ ok: true, ...digest, sourceStartedAt, sourceAt });
} catch (error) {
  await rm(workerData.destination, { force: true }).catch(() => {});
  parentPort.postMessage({ ok: false, code: 'snapshot_failed', ...databaseErrorDetails(error) });
}
