import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '../storage/store.js';
import { databaseErrorDetails } from '../storage/database-errors.js';

let store;
try {
  const { operation, dbPath } = workerData;
  store = new Store(dbPath, { readOnly: !['apply', 'rewind'].includes(operation) });
  let value;
  if (operation === 'checkpoint') value = store.checkpoint();
  else if (operation === 'checkpoint-at') value = store.checkpointAt(workerData.sequence);
  else if (operation === 'rewind') value = store.rewindTo(workerData.checkpoint, { preserve: true });
  else if (operation === 'export') value = store.exportChanges({ after: workerData.after,
    through: workerData.through, limit: 128, maxBytes: 512 * 1024 });
  else if (operation === 'apply') value = store.applyChanges(workerData.batch);
  else throw Object.assign(Error(), { code: 'invalid_protocol' });
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  const details = databaseErrorDetails(error);
  const code = details?.code ?? (/^journal_[a-z_]+$/.test(error.code ?? '') || error.code === 'invalid_protocol'
    ? error.code : 'verification_failed');
  parentPort.postMessage({ ok: false, error: { code, ...details } });
} finally { store?.close(); }
