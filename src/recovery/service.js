import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { learningVersion } from '../app/committed-learning.js';
import { publishLearning } from '../app/learning-publication.js';
import { markRecoveryFailed } from './state.js';
import { RECOVERY_ERROR_CODES, recoveryFailure } from './errors.js';
export { listRecoveries } from './ledger.js';

const running = new WeakSet();
const validInput = input => {
  if (!['mqtt', 'providers', 'simulated', 'history'].includes(input)) throw new TypeError('Choose an existing learning input for recovery');
  return input;
};
const unavailable = message => Object.assign(new Error(message), { statusCode: 409, code: 'recovery_invalid', public: true });

async function finishInterruptedRecovery(store, input, operationToken) {
  // Recording an interrupted job grants no publication or control authority.
  // Try only the immediately available writer turn: shutdown must not wait for
  // this diagnostic, and a queued cleanup must never outlive its operation.
  const cancellation = new AbortController();
  try {
    const saved = store.runWrite(() => markRecoveryFailed(store, input, { operationToken }), { signal: cancellation.signal });
    cancellation.abort();
    await saved;
  } catch { /* Startup reconciles a retained in-progress record if storage could not be admitted. */ }
}

/** Read-only source validation and inventory. No master backup or trial merge
 * is created; recovery makes acceptance decisions against current master data. */
export function recoveryPreview({ masterPath, donorPath, donorJournalPath, input = 'mqtt', onProgress = () => {}, signal }) {
  return workerJob({ mode: 'preview', masterPath, donorPath, donorJournalPath, input: validInput(input) }, { onProgress, signal });
}

/** Accepted source rows commit in bounded worker batches. Until publication,
 * live learning continues appending to its original selected epoch. A crash
 * leaves idempotent source imports and an unpublished projection, never half a
 * checkpoint. onPublish runs synchronously with no intervening control tick. */
export async function recoverHistory({ store, donorPath, donorJournalPath, input = 'mqtt', preview, isCurrent = () => true,
  onPublish = () => {}, onProgress = () => {}, signal, source, operationId }) {
  validInput(input);
  if (store.path === ':memory:' || store.readOnly) throw new TypeError('Recovery requires the writable master database on disk');
  if (running.has(store)) throw unavailable('A recovery is already running');
  const { previewId, ...signed } = preview ?? {};
  if (preview?.status !== 'checked' || preview?.model?.status !== 'not-assessed'
    || preview.counts !== undefined
    || typeof previewId !== 'string' || previewId !== learningVersion(signed)) throw unavailable('Check the other instance before recovering');
  if (!isCurrent()) throw unavailable('Recovery requires the current master');
  const operationToken = randomUUID();
  running.add(store);
  try {
    return await workerJob({ mode: 'recover', masterPath: store.path, donorPath, donorJournalPath, input, preview, source, operationId, operationToken }, {
      signal, onProgress,
      onYield: () => store.runWrite(() => {
        if (!isCurrent()) throw unavailable('Recovery authority changed; the previous model remains selected');
      }, { signal }),
      async onReady(message, worker) {
        if (!isCurrent()) throw unavailable('Master authority changed; recovery remains protected');
        const result = await publishLearning({ store, input, kind: 'recovery', message,
          context: { operationToken, previewId }, signal, isCurrent, onPublish });
        if (!result) { await onProgress({ phase: 'catching-up', processed: 0 }); worker.postMessage({ type: 'catchup', report: message.report }); return null; }
        return result;
      },
    });
  } catch (error) {
    await finishInterruptedRecovery(store, input, operationToken);
    throw error;
  } finally { running.delete(store); }
}

async function workerJob(workerData, { onProgress, onReady, onYield, signal }) {
  if (signal?.aborted) throw unavailable('Recovery was cancelled; the other instance remains protected');
  return await new Promise((resolve, reject) => {
    const worker = new Worker(new URL(workerData.mode.startsWith('revision') ? './revision-worker.js' : './worker.js', import.meta.url), { workerData,
      ...(process.execArgv.some(value => value.startsWith('--input-type')) ? { execArgv: [] } : {}) });
    let settled = false, messages = Promise.resolve(), publication = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort);
      // Termination releases SQLite writer locks and disposes private scan
      // memory even if a peer loses authority during a large recovery.
      worker.postMessage({ type: 'close' });
      // Publication has a separate writer worker and owns the runtime adoption
      // barrier. Revocation must join it too before reporting recovery stopped.
      void Promise.allSettled([worker.terminate(), publication]).then(([, published]) => {
        // Cancellation can arrive after COMMIT but before its worker reply.
        // A joined, verified publication takes precedence over that late abort.
        if (published.status === 'fulfilled' && published.value) resolve(published.value);
        else if (error) reject(error);
        else resolve(result);
      });
    };
    const abort = () => finish(unavailable('Recovery was cancelled; the other instance remains protected'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('error', error => {
      const failure = recoveryFailure(error, 'recovery_worker_failed');
      finish(Object.assign(new Error(failure.error), { code: failure.code }));
    });
    worker.on('exit', () => {
      // The final message may already be received while earlier asynchronous
      // progress persistence is still draining. Judge exit after those messages.
      messages = messages.then(() => {
        if (!settled) {
          const failure = recoveryFailure(null, 'recovery_worker_failed');
          finish(Object.assign(new Error(failure.error), { code: failure.code }));
        }
      });
    });
    worker.on('message', message => {
      messages = messages.then(async () => {
      if (settled) return;
      try {
        if (message.type === 'progress') {
          const { type, ...progress } = message; await onProgress?.(progress);
        }
        else if (message.type === 'yield') {
          // A turn alone can precede WriteQueue's delayed contention retry,
          // letting the worker repeatedly take its next lock first. A no-op
          // admitted behind pending controller writes is a durable ordering
          // barrier; it creates no journal commit of its own.
          await new Promise(resolve => setImmediate(resolve));
          if (settled) return;
          await onYield?.();
          if (!settled) worker.postMessage({ type: 'continue', id: message.id });
        }
        else if (message.type === 'failed') finish(Object.assign(new Error(message.error),
          { code: RECOVERY_ERROR_CODES.includes(message.code) ? message.code : 'recovery_failed' }));
        else if (message.type === 'complete') finish(null, message.report);
        else if (message.type === 'ready') {
          publication = Promise.resolve().then(() => onReady(message, worker));
          let result;
          try { result = await publication; } finally { publication = null; }
          if (result) finish(null, result);
        }
      } catch (error) {
        const failure = recoveryFailure(error);
        finish(Object.assign(new Error(failure.error), { code: failure.code, statusCode: error?.statusCode }));
      }
      });
    });
  });
}

export function previewRecoveryRevision({ store, input = 'mqtt', recoveryId, active, onProgress = () => {}, signal }) {
  validInput(input);
  if (store.readOnly || store.path === ':memory:' || typeof active !== 'boolean' || typeof recoveryId !== 'string')
    throw new TypeError('Choose a recovery in the current writable database');
  return workerJob({ mode: 'revision-preview', masterPath: store.path, input, recoveryId, active }, { onProgress, signal });
}

/** Publish the selected source revision and a complete caught-up model together.
 * Retained evidence is never deleted, and runtime permissions are never copied. */
export async function reviseRecovery({ store, input = 'mqtt', recoveryId, active, preview, isCurrent = () => true,
  onPublish = () => {}, onProgress = () => {}, signal }) {
  validInput(input);
  if (store.readOnly || store.path === ':memory:' || typeof active !== 'boolean' || typeof recoveryId !== 'string')
    throw new TypeError('Choose a recovery in the current writable database');
  if (running.has(store)) throw unavailable('A recovery is already running');
  if (!isCurrent()) throw unavailable('Recovery requires current write authority');
  const { previewId, ...checked } = preview ?? {};
  if (previewId !== learningVersion(checked) || checked.recoveryId !== recoveryId || checked.active !== active)
    throw unavailable('Review this recovery before changing it');
  const operationToken = randomUUID();
  running.add(store);
  try {
    await store.runWrite(() => store.setState(`recovery:active:${input}`, { status: 'rebuilding', recoveryId, revision: true, operationToken, startedAt: Date.now() }), { signal, isCurrent });
    return await workerJob({ mode: 'revision', masterPath: store.path, input, recoveryId, active, preview }, {
      signal, onProgress,
      onYield: () => store.runWrite(() => {
        if (!isCurrent()) throw unavailable('Recovery authority changed; the previous model remains selected');
      }, { signal }),
      async onReady(message, worker) {
        if (!isCurrent()) throw unavailable('Control authority changed; the previous history remains selected');
        const result = await publishLearning({ store, input, kind: 'revision', message,
          context: { operationToken, previewId, recoveryId, active }, signal, isCurrent, onPublish });
        if (!result) { await onProgress({ phase: 'catching-up', processed: 0 }); worker.postMessage({ type: 'catchup' }); return null; }
        return result;
      },
    });
  } catch (error) {
    await finishInterruptedRecovery(store, input, operationToken);
    throw error;
  } finally { running.delete(store); }
}
