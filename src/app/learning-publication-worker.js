import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '../storage/store.js';
import { publicationKey, publishCorrection } from './learning-publication.js';
import { publishRecovery, publishRevision } from '../recovery/publication.js';
import { recoveryFailure } from '../recovery/errors.js';

const cancelled = new Int32Array(workerData.cancellation);
const current = () => Atomics.load(cancelled, 0) === 0;
let store;
try {
  const source = new Store(workerData.dbPath, { readOnly: true });
  try {
    if (!current() || source.checkpoint().databaseId !== workerData.databaseId) throw new Error('stale');
  } finally { source.close(); }
  store = new Store(workerData.dbPath);
  store.db.exec('PRAGMA busy_timeout=0');
  parentPort.once('message', async request => {
    try {
      if (request?.type !== 'publish') throw new Error('invalid publication');
      const result = await store.runWrite(() => {
        if (!current() || store.checkpoint().databaseId !== workerData.databaseId) throw new Error('stale');
        const { input, kind, message, context } = workerData;
        const publish = { correction: publishCorrection, recovery: publishRecovery, revision: publishRevision }[kind];
        if (!publish) throw new Error('invalid publication');
        const published = publish(store, input, message, context);
        if (published) {
          const { checkpoint, ...receipt } = published;
          store.setState(publicationKey(input), { token: workerData.token, result: receipt });
        }
        if (!current()) throw new Error('cancelled');
        return published ? true : null;
      }, { isCurrent: current });
      parentPort.postMessage({ type: 'result', result });
    } catch (error) { parentPort.postMessage({ type: 'failed', failure: recoveryFailure(error) }); }
    finally { store.close(); parentPort.close(); }
  });
  parentPort.postMessage({ type: 'ready' });
} catch {
  try { store?.close(); } catch {}
  parentPort.postMessage({ type: 'failed' }); parentPort.close();
}
