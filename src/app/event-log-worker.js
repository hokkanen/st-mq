import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { readEventLog } from './event-log.js';
import { admittedReader, storageStep, releaseStorageLease, setStorageRequestActive } from '../storage/worker-admission.js';

const db = admittedReader(storageStep(() => new DatabaseSync(workerData.dbPath, { readOnly: true })), { batchRows: 64 });
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=500; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE;');
parentPort.on('message', ({ id, args }) => {
  if (!Number.isSafeInteger(id)) return;
  setStorageRequestActive(true);
  let response;
  try {
    db.exec('BEGIN');
    const result = readEventLog({ db, ...args });
    response = { id, result };
  } catch (error) {
    const code = ['event_log_context_changed', 'event_log_query_invalid', 'event_log_checkpoint_advanced'].includes(error?.code) ? error.code : 'event_log_unavailable';
    response = { id, error: { code } };
  } finally {
    setStorageRequestActive(false);
    if (db.isTransaction) try { db.exec('ROLLBACK'); } catch {
      response = { id, error: { code: 'event_log_unavailable' }, retire: true };
    }
    releaseStorageLease();
  }
  // The owner can release its replica Store lease only after this connection's
  // read transaction has ended. FIFO delivery releases storage admission first.
  parentPort.postMessage(response);
});
