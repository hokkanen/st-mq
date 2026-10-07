import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { snapshotDigest } from '../replication/publication.js';
import { validateCurrentDatabase } from '../storage/store.js';
import { databaseErrorDetails } from '../storage/database-errors.js';

try {
  const db = new DatabaseSync(workerData.path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    validateCurrentDatabase(db);
    const rows = db.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw Object.assign(Error(), { code: 'database_integrity_failed' });
  } finally { db.close(); }
  const actual = await snapshotDigest(workerData.path);
  if (actual.digest !== workerData.metadata.digest || actual.bytes !== workerData.metadata.bytes) throw Error();
  parentPort.postMessage({ ok: true });
} catch (error) { parentPort.postMessage({ ok: false, ...databaseErrorDetails(error) }); }
