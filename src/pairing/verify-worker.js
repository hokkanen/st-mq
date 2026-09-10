import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { snapshotDigest } from '../replication/publication.js';

try {
  const db = new DatabaseSync(workerData.path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const rows = db.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw Error();
  } finally { db.close(); }
  const actual = await snapshotDigest(workerData.path);
  if (actual.digest !== workerData.metadata.digest || actual.bytes !== workerData.metadata.bytes) throw Error();
  parentPort.postMessage({ ok: true });
} catch { parentPort.postMessage({ ok: false }); }
