import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { validLearningCheckpoint } from './committed-learning.js';
import { fireplaceRevision } from './fireplace.js';
import { sensorRevision } from './sensor-inputs.js';
import { recoveryErrorMessage } from '../recovery/errors.js';

const failure = () => new Error('Model publication failed; the previous committed model remains available.');
export const publicationKey = input => `learning:publication:${input}`;

// Used inside the worker's writer transaction (and the isolated memory fixture).
export function publishCorrection(store, input, candidate) {
  const job = store.getState(`fireplace:rebuild:${input}`);
  if (store.learningEpoch(input) !== candidate.epoch
    || store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation !== candidate.selection
    || fireplaceRevision(store, input) !== candidate.revision || sensorRevision(store, input) !== candidate.sensorRevision
    || !['pending', 'running', 'ready'].includes(job?.status)) return null;
  if (store.learningJournalHead(input) !== candidate.head) return null;
  const last = candidate.head ? store.learningJournal({ input, after: candidate.head - 1, limit: 1 })[0] : null;
  if (last ? !validLearningCheckpoint(candidate.checkpoint, last)
    || (candidate.checkpoint.fireplaceRevision ?? 0) !== candidate.revision
    || (candidate.checkpoint.sensorRevision ?? 0) !== candidate.sensorRevision : candidate.checkpoint !== null) throw failure();
  store.setState(`adaptive:${input}`, candidate.checkpoint);
  store.setState(`fireplace:rebuild:${input}`, { ...job, status: 'current', revision: candidate.revision,
    sensorRevision: candidate.sensorRevision, epoch: candidate.epoch, requiresRebuild: false, error: null });
  store.setState(`pending-plan:${input}`, null);
  return { epoch: candidate.epoch, checkpoint: candidate.checkpoint };
}

/** Reserve only the final publication turn. Worker exit is joined before checking
 * the durable receipt, so a lost reply or cancellation after COMMIT cannot leave
 * a new database interpretation paired with the old process model. */
export function publishLearning({ store, input, kind, message, context = {}, signal, isCurrent = () => true,
  onPublish = () => {}, workerFactory = options => new Worker(new URL('./learning-publication-worker.js', import.meta.url), options) }) {
  const databaseId = store.checkpoint().databaseId, token = randomUUID();
  return store.runPublication(async () => {
    const cancelled = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const lifetime = AbortSignal.any([store.writeQueue.shutdown.signal, ...(signal ? [signal] : [])]);
    const abort = () => Atomics.store(cancelled, 0, 1);
    lifetime.addEventListener('abort', abort, { once: true });
    let worker, result, error;
    try {
      if (lifetime.aborted || !isCurrent()) throw failure();
      if (store.path === ':memory:') {
        if (kind !== 'correction') throw failure();
        result = store.transaction(() => publishCorrection(store, input, message));
      } else {
        worker = workerFactory({
          workerData: { dbPath: store.path, input, databaseId, token, kind, message, context, cancellation: cancelled.buffer },
        });
        await new Promise((resolve, reject) => {
          const stop = () => { abort(); void worker.terminate(); };
          lifetime.addEventListener('abort', stop, { once: true });
          // Recheck runtime authority at worker admission, before its transaction.
          worker.on('message', value => {
            if (value?.type === 'ready') {
              if (lifetime.aborted || !isCurrent()) { stop(); return; }
              worker.postMessage({ type: 'publish' });
            } else if (value?.type === 'result') result = value.result;
            else if (value?.type === 'failed') error = recoveryErrorMessage(value.failure?.code)
              ? Object.assign(new Error(value.failure.error), { code: value.failure.code, public: true }) : failure();
          });
          worker.on('error', reject);
          worker.on('exit', code => {
            lifetime.removeEventListener('abort', stop);
            if (code !== 0 || lifetime.aborted || result === undefined) reject(error ?? failure());
            else resolve();
          });
        });
      }
    } catch (caught) { error = caught; }
    finally {
      if (worker) await worker.terminate();
      lifetime.removeEventListener('abort', abort);
    }
    if (store.path !== ':memory:') {
      // Receipt is in the same transaction as the model and all selection state.
      // Even an abort after commit must adopt it before queued updates resume.
      const receipt = store.getState(publicationKey(input));
      if (receipt?.token === token && store.checkpoint().databaseId === databaseId)
        result = { ...receipt.result, checkpoint: message.checkpoint };
      else if (result) throw failure();
    }
    if (result) {
      try { onPublish(result); }
      catch (cause) { throw Object.assign(new Error('The saved model could not finish its follow-up.', { cause }),
        { code: 'STORAGE_COMMIT_EFFECT_FAILED', committed: true }); }
      return result;
    }
    if (error) throw error;
    return null;
  }, { signal, isCurrent });
}
