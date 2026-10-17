import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '../storage/store.js';
import { admittedReader, storageStep } from '../storage/worker-admission.js';
import { committedLearningSample, replayLearningJournal } from './committed-learning.js';
import { evaluateThermalModel } from '../control/adaptive-learning.js';
import { withFireplaceInputs } from './fireplace-inputs.js';
import { takeImmutableValue } from '../domain/immutable.js';
import { restoreAdaptiveCheckpoint } from '../control/adaptive-learning.js';

let store, checkpoint = null;
try {
  store = storageStep(() => new Store(workerData.dbPath, { readOnly: true }));
  store.db = admittedReader(store.db);
  if (store.checkpoint().databaseId !== workerData.databaseId) throw new Error('Database identity changed');
  parentPort.on('message', message => {
    if (message?.type !== 'calculate') return;
    try {
      let result;
      if (message.operation === 'replay') {
        if (message.checkpoint !== undefined) checkpoint = message.checkpoint;
        if ((checkpoint?.checkpointDigest ?? null) !== message.digest) throw new Error('Checkpoint ownership changed');
        if (!checkpoint) {
          try { checkpoint = store.getState(`adaptive:${workerData.input}`); }
          catch { checkpoint = null; }
        }
        // Freeze one owned graph in this worker. Replay and live learning still
        // use the same ordered update function and journal boundary checks.
        checkpoint = takeImmutableValue(checkpoint);
        const through = store.learningJournalHead(workerData.input);
        const correction = store.getState(`fireplace:rebuild:${workerData.input}`);
        const options = { ...message.options };
        // On restart the parent has not hydrated the saved model yet. Select its
        // held interpretation here, after loading it, just as for a warm Engine.
        // A live replay must never bypass the correction's atomic publication.
        if (checkpoint && ['pending', 'running', 'ready', 'failed'].includes(correction?.status)) {
          options.fireplaceRevision = checkpoint.fireplaceRevision ?? 0;
          options.sensorRevision = checkpoint.sensorRevision ?? 0;
        }
        result = checkpoint = takeImmutableValue(through === 0 ? restoreAdaptiveCheckpoint(null, message.options.config)
          : replayLearningJournal(store, workerData.input, checkpoint,
            { ...options, through, persistCheckpoint: false }));
      } else if (message.operation === 'sample') {
        // Keep SQL on one read snapshot, with admission released between bounded
        // cursor batches. No read snapshot or storage lease spans model fitting.
        store.db.exec('BEGIN');
        try { result = committedLearningSample({ ...message.options, store, input: workerData.input }); }
        finally { store.db.exec('ROLLBACK'); }
      } else if (message.operation === 'reserve') {
        const { checkpoint: value, context } = message.options;
        result = evaluateThermalModel(value.model, value.samples.map(row => withFireplaceInputs(row, context)),
          { rollout: false, observedOnly: false }).state?.reserveC ?? null;
      } else throw new Error('Unknown live learning operation');
      parentPort.postMessage({ type: 'result', id: message.id, ok: true, result });
    } catch {
      parentPort.postMessage({ type: 'result', id: message.id, ok: false });
    }
  });
  parentPort.on('close', () => { try { store.close(); } catch {} });
  parentPort.postMessage({ type: 'ready' });
} catch {
  try { store?.close(); } catch {}
  parentPort.postMessage({ type: 'failed' }); parentPort.close();
}
