import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { listRecoveries } from '../recovery/ledger.js';

const db = new DatabaseSync(workerData.path, { readOnly: true });
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE;');
parentPort.on('message', ({ id, input, options }) => {
  try { parentPort.postMessage({ id, rows: listRecoveries({ db }, input, options) }); }
  catch { parentPort.postMessage({ id, error: true }); }
});
