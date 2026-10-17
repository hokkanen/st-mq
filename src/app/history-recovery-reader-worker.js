import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { listRecoveries } from '../recovery/ledger.js';
import { storageStep,admittedReader } from '../storage/worker-admission.js';

const db = admittedReader(storageStep(()=>new DatabaseSync(workerData.path, { readOnly: true })));
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE;');
parentPort.on('message', ({ id, input, options }) => {
  parentPort.postMessage({ id, storageOperationStart: true });
  try { parentPort.postMessage({ id, rows: listRecoveries({ db }, input, options) }); }
  catch { parentPort.postMessage({ id, error: true }); }
});
