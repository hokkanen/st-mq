import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { Store } from '../../src/storage/store.js';

const store = new Store(workerData.path);
try {
  const value = 's'.repeat(workerData.bytes);
  store.setState('synthetic-large-document', { value });
  const found = store.getState('synthetic-large-document');
  parentPort.postMessage({ ok: found.value === value, bytes: found.value.length,
    digest: createHash('sha256').update(found.value).digest('hex'), checkpoint: store.checkpoint() });
} finally { store.close(); }
