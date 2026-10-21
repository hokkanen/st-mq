import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { readCheckpoint, matchingCheckpoint } from '../storage/journal.js';
import { storageStep, releaseStorageLease, checkStorageRequest, setStorageRequestActive } from '../storage/worker-admission.js';
import { readDatabaseInventory } from './inventory-reader.js';

let db, lastProgress = 0, lastStage;
setStorageRequestActive(true);
try {
  db = storageStep(() => new DatabaseSync(workerData.path, { readOnly: true }));
  storageStep(() => db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE; BEGIN;'));
  const checkpoint = storageStep(() => readCheckpoint(db));
  if (workerData.checkpoint && !matchingCheckpoint(checkpoint, workerData.checkpoint))
    throw Object.assign(new Error('Inventory source changed.'), { code: 'INVENTORY_SOURCE_CHANGED' });
  parentPort.postMessage({ started: true });
  const result = readDatabaseInventory({ store: { db, path: workerData.path }, now: workerData.now,
    step: storageStep, release: releaseStorageLease, checkCancelled: checkStorageRequest,
    onProgress(value) {
      const tick = performance.now();
      if (value.stage !== lastStage || tick - lastProgress >= 100) {
        parentPort.postMessage({ progress: value }); lastProgress = tick; lastStage = value.stage;
      }
    } });
  storageStep(() => db.exec('ROLLBACK;'));
  releaseStorageLease();
  parentPort.postMessage({ result });
} catch (error) {
  // SQLite messages may contain paths or schema identifiers. Only fixed,
  // actionable classifications cross the worker boundary.
  const code = error.name === 'AbortError' ? 'INVENTORY_CANCELLED'
    : ['INVENTORY_SOURCE_CHANGED', 'INVENTORY_TOO_COMPLEX'].includes(error.code) ? error.code
      : error.errcode === 5 || error.errcode === 6 ? 'INVENTORY_STORAGE_BUSY'
        : error.errcode === 11 || error.errcode === 26 ? 'INVENTORY_DATABASE_UNREADABLE' : 'INVENTORY_READ_FAILED';
  parentPort.postMessage({ error: { code } });
} finally {
  setStorageRequestActive(false);
  if (db) { try { storageStep(() => db.close()); } catch { /* Worker exit releases SQLite resources. */ } }
  releaseStorageLease();
  parentPort.close();
}
