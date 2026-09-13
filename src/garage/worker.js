import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '../storage/store.js';
import { replayGarageJournal } from './learning.js';

const store = new Store(workerData.path, { readOnly: true });
let checkpoint = null;
parentPort.on('message', message => {
  if (message.type !== 'catch-up') return;
  try {
    checkpoint = replayGarageJournal(store, workerData.input, { checkpoint, context: workerData.context });
    parentPort.postMessage({ checkpoint, revision: workerData.context.revision });
  } catch { parentPort.postMessage({ error: 'Garage journal reconstruction failed' }); }
});
