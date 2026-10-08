import { parentPort, workerData } from 'node:worker_threads';
import { Store } from './store.js';
import { importCsv } from './history.js';

let store;
try {
  store = new Store(workerData.databasePath);
  const result = await importCsv(store, workerData.file, { kind: workerData.kind,
    onProgress: value => parentPort.postMessage({ type: 'progress', value }) });
  store.close(); store = null;
  parentPort.postMessage({ type: 'complete', result });
} catch (error) {
  parentPort.postMessage({ type: 'error', message: error.message, code: error.code });
} finally { store?.close(); }
