import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync, backup } from 'node:sqlite';
import { lstat, open, rm } from 'node:fs/promises';
import { normalizeSnapshot, snapshotDigest } from './publication.js';
import { validateCurrentDatabase } from '../storage/store.js';
import { databaseErrorDetails } from '../storage/database-errors.js';

let created = false;
try {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { await lstat(`${workerData.destination}${suffix}`); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('Snapshot destination has existing SQLite companions');
  }
  const file = await open(workerData.destination, 'wx', 0o600);
  created = true;
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
  if (created) for (const suffix of ['', '-wal', '-shm', '-journal'])
    await rm(`${workerData.destination}${suffix}`, { force: true }).catch(() => {});
  parentPort.postMessage({ ok: false, code: 'snapshot_failed', ...databaseErrorDetails(error) });
}
