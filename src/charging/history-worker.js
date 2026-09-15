import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { forecastHousehold } from './history.js';

// The worker owns a read-only connection and a bounded in-memory reference.
// It never writes a model checkpoint, copies the archive or changes source rows.
let db;
try {
  db = new DatabaseSync(workerData.path, { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
  parentPort.on('message', message => {
    if (message?.type !== 'forecast') return;
    try {
      db.exec('BEGIN');
      const rows = forecastHousehold({ db }, message.options);
      db.exec('COMMIT');
      parentPort.postMessage({ type: 'forecast', id: message.id, rows });
    } catch {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the safe original failure. */ }
      // A database/decoder exception may contain private paths or source data.
      parentPort.postMessage({ type: 'error', id: message.id, code: 'history-unavailable' });
    }
  });
} catch {
  parentPort.postMessage({ type: 'error', id: null, code: 'history-unavailable' });
  db?.close();
  parentPort.close();
}
