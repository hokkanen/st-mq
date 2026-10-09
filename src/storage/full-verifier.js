import { Worker } from 'node:worker_threads';

export const FULL_VERIFICATION_ALGORITHM = 'sqlite-canonical-content-v1';

const messages = {
  full_verification_checkpoint_mismatch: 'The databases are at different transaction checkpoints. Catch up to a matching checkpoint before comparing them.',
  full_verification_content_mismatch: 'The databases contain different data at the same transaction checkpoint. Preserve both databases and investigate before replacing either copy.',
  full_verification_transport_mismatch: 'The snapshot bytes do not match the expected transfer. Preserve the files and retry from a verified source.',
  full_verification_failed: 'Full database verification failed. Preserve the database and check its integrity before attempting repair.',
  full_verification_busy: 'Full database verification is busy. Wait for the pending checks to complete before trying again.',
};

// All application callers share this admission queue, including maintenance,
// recovery and pairing. A waiting request owns no SQLite read transaction and
// cannot pin the WAL. Independent application/CLI processes have separate queues.
const pending = [];
const MAX_PENDING = 16;
let active = null, lastRun = null, nextId = 0;
const origins = new Set(['manual', 'scheduled', 'pairing', 'recovery', 'replication', 'backup']);
const jobStatus = job => ({ id: job.id, origin: job.origin, queuedAt: job.queuedAt,
  startedAt: job.startedAt, comparison: Boolean(job.options.rightPath), progress: job.progress });

/** Operational metadata only: database paths and saved row values stay private. */
export function fullVerificationActivity() {
  return structuredClone({ active: active ? jobStatus(active) : null,
    queued: pending.map(jobStatus), lastRun });
}

function progress(job, value) {
  job.progress = value;
  job.options.onProgress?.(value);
}

function drain() {
  if (active || !pending.length) return;
  const job = pending.shift();
  active = job; job.startedAt = Date.now();
  job.options.signal?.removeEventListener('abort', job.abort);
  void (async () => {
    try {
      job.options.signal?.throwIfAborted();
      progress(job, { phase: 'starting', processed: 0 });
      const { origin, ...options } = job.options;
      const result = await run({ ...options, onProgress: value => progress(job, value) });
      lastRun = { ...jobStatus(job), state: 'complete', finishedAt: Date.now(), result };
      job.resolve(result);
    } catch (error) {
      lastRun = { ...jobStatus(job), state: job.options.signal?.aborted ? 'interrupted' : 'error',
        finishedAt: Date.now(), error: Object.hasOwn(messages, error?.code) ? error.code : 'full_verification_failed' };
      job.reject(error);
    } finally {
      active = null;
      drain();
    }
  })();
}

function enqueue(options) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(options.signal.reason); return; }
    if (pending.length >= MAX_PENDING) {
      reject(Object.assign(new Error(messages.full_verification_busy), { code: 'full_verification_busy' })); return;
    }
    const job = { id: ++nextId, options, resolve, reject,
      origin: origins.has(options.origin) ? options.origin : 'operation', queuedAt: Date.now(), startedAt: null };
    job.abort = () => {
      const index = pending.indexOf(job);
      if (index < 0) return;
      pending.splice(index, 1);
      options.signal?.removeEventListener('abort', job.abort);
      reject(options.signal.reason);
    };
    pending.push(job);
    options.signal?.addEventListener('abort', job.abort, { once: true });
    try { progress(job, { phase: 'queued', processed: 0, ahead: pending.length - 1 + Number(Boolean(active)) }); }
    catch (error) {
      const index = pending.indexOf(job);
      if (index >= 0) pending.splice(index, 1);
      options.signal?.removeEventListener('abort', job.abort); reject(error);
    }
    drain();
  });
}

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

export function verifyDatabase({ dbPath, checkpoint, snapshot, signal, onProgress, origin } = {}) {
  return enqueue({ dbPath, checkpoint, snapshot, signal, onProgress, origin });
}

/** Pin both inputs before scanning. Different advancing heads are incomparable,
 * never a content mismatch and never silently compared by wall-clock time. */
export function verifyCheckpointPair({ leftPath, rightPath, checkpoint, signal, onProgress, origin } = {}) {
  return enqueue({ dbPath: leftPath, rightPath, checkpoint, signal, onProgress, origin });
}
