import { Worker } from 'node:worker_threads';

export const FULL_VERIFICATION_ALGORITHM = 'sqlite-canonical-content-v1';

const messages = {
  full_verification_checkpoint_mismatch: 'The databases are at different transaction checkpoints. Catch up to a matching checkpoint before comparing them.',
  full_verification_content_mismatch: 'The databases contain different data at the same transaction checkpoint. Preserve both databases and investigate before replacing either copy.',
  full_verification_failed: 'Full database verification failed. Preserve the database and check its integrity before attempting repair.',
};

/** Explicit, independent full verification. Completion always joins the worker,
 * including cancellation, so callers may then safely release their source files. */
function run(options) {
  const { signal, onProgress = () => {}, ...workerData } = options;
  signal?.throwIfAborted();
  const worker = new Worker(new URL('./full-verifier-worker.js', import.meta.url), { workerData,
    ...(process.execArgv.some(value => value.startsWith('--input-type')) ? { execArgv: [] } : {}) });
  return new Promise((resolve, reject) => {
    let result, error;
    const abort = () => { error = signal.reason; void worker.terminate(); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', value => {
      if (error) return;
      if (value.type === 'progress') {
        try { onProgress(value.progress); }
        catch (failure) { error = failure; void worker.terminate(); }
      } else result = value;
    });
    worker.once('error', failure => { error ??= Object.assign(new Error(messages.full_verification_failed), { code: 'full_verification_failed' }); });
    worker.once('exit', code => {
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (code === 0 && result?.ok) resolve(result.result);
      else reject(Object.assign(new Error(messages[result?.code] ?? messages.full_verification_failed),
        { code: result?.code ?? 'full_verification_failed', ...result?.details }));
    });
    if (signal?.aborted) abort();
  });
}

export function verifyDatabase({ dbPath, checkpoint, signal, onProgress } = {}) {
  return run({ dbPath, checkpoint, signal, onProgress });
}

/** Pin both inputs before scanning. Different advancing heads are incomparable,
 * never a content mismatch and never silently compared by wall-clock time. */
export function verifyCheckpointPair({ leftPath, rightPath, checkpoint, signal, onProgress } = {}) {
  return run({ dbPath: leftPath, rightPath, checkpoint, signal, onProgress });
}
