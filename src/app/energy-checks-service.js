import { Worker } from 'node:worker_threads';
import { attachStorageAdmission } from '../storage/worker-admission.js';
import { energyCheckSummaries } from './energy-checks.js';
import { storageOperationHealth } from '../storage/operation-health.js';
import { validCheckpoint } from '../storage/journal.js';

const validNow = now => Number.isSafeInteger(now) && Math.abs(now) <= 8640000000000000;
const idleJob = () => ({ id: null, state: 'idle', stage: null, processed: 0,
  startedAt: null, completedAt: null, error: null });
// A verified forward publication of the same physical replica file must not
// cancel a long-running read snapshot. The replica owner closes this service on
// physical replacement or incompatible publication; the worker still verifies
// the exact requested checkpoint when it captures its source snapshot.
const contextKey = checkpoint => checkpoint?.databaseId ?? null;

/** Shared, read-only jobs outlive HTTP requests. Their replaceable evidence and
 * summaries belong to this store instance, never to configuration or history. */
export function createEnergyChecksService({ store, clock = Date.now, refreshMs = 60_000,
  evidenceCacheBytes = 128 * 1024 * 1024, idleMs = 120_000 } = {}) {
  if (!store?.db || !store.path) throw new TypeError('A history store is required');
  if (!Number.isSafeInteger(evidenceCacheBytes) || evidenceCacheBytes < 0
    || !Number.isSafeInteger(idleMs) || idleMs < 1) throw new TypeError('Invalid energy-check cache bounds');
  let closed = false, worker = null, retiring = null, nextId = 0, active = null;
  let idleTimer = null;
  let result = null, latest = null, resultGeneratedAt = null, resultAsOf = null, resultContext = null;
  let job = idleJob(), latestCheckpoint = null;
  const snapshot = () => ({ latest, result, resultGeneratedAt, resultAsOf, job: { ...job } });
  const safeError = error => error?.code === 'ENERGY_CHECKPOINT_CHANGED'
    ? { code: 'history-changed', message: 'The recorded history changed. Refresh the checks to use the current history.' }
    : error?.code === 'ENERGY_STORAGE_BUSY'
      ? { code: 'storage-busy', message: 'Storage is busy. Wait for the current storage operation, then refresh the checks.' }
      : error?.code === 'ENERGY_DATABASE_UNREADABLE'
        ? { code: 'database-unreadable', message: 'The recorded database could not be read. Use Check database to inspect it.' }
        : error?.code === 'ENERGY_WORKER_FAILED'
          ? { code: 'worker-stopped', message: 'The energy-check worker stopped. Refresh the checks to retry.' }
    : { code: 'checks-failed', message: 'The energy checks could not finish. Refresh the checks to retry.' };
  function complete(entry, error, value) {
    if (active !== entry || closed) return;
    active = null;
    job = { ...job, state: error ? 'failed' : 'completed', stage: error ? job.stage : 'complete',
      completedAt: clock(), error: error ? safeError(error) : null };
    if (!error) {
      result = value; latest = value[0] ?? null;
      resultGeneratedAt = clock(); resultAsOf = entry.now; resultContext = entry.context;
    }
    entry.observation?.finish(error ? 'failed' : 'completed', { reason: error ? 'operation-failed' : null });
  }
  function retire() {
    clearTimeout(idleTimer); idleTimer = null;
    const previous = worker; worker = null;
    if (!previous) return retiring ?? Promise.resolve();
    const termination = previous.terminate().catch(() => {});
    retiring = termination.finally(() => { if (retiring === joined) retiring = null; });
    const joined = retiring;
    return joined;
  }
  function retireWhenIdle(generation) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (worker === generation && !active) void retire();
    }, idleMs);
    idleTimer.unref();
  }
  function ensureWorker() {
    if (worker) return worker;
    const storageSignal = new Int32Array(new SharedArrayBuffer(4));
    const requestSignal = new Int32Array(new SharedArrayBuffer(4));
    const generation = new Worker(new URL('./energy-checks-worker.js', import.meta.url), {
      workerData: { dbPath: store.path, storageSignal: storageSignal.buffer,
        requestSignal: requestSignal.buffer, storageLeaseMs: 0, evidenceCacheBytes },
      ...(process.execArgv.some(value => value.startsWith('--input-type')) ? { execArgv: [] } : {}),
    });
    worker = generation;
    generation.unref();
    attachStorageAdmission(generation, storageSignal,
      operation => store.runStorageTask(operation, { kind: 'history' }));
    generation.on('message', message => {
      if (worker !== generation || message.id !== active?.id) return;
      if (message.progress) {
        job = { ...job, state: 'running', ...message.progress };
        active.observation?.progress('reading');
      }
      if (message.latest) latest = message.latest;
      if (message.result) {
        complete(active, null, message.result);
        // Large exact checks may exceed the retained-cache budget while they
        // run. Keep their small complete result and discard only scratch data.
        if (message.evictEvidence) void retire();
        else retireWhenIdle(generation);
      }
      if (message.error) { complete(active, message.error); void retire(); }
    });
    const failed = () => {
      if (worker !== generation) return;
      if (active) complete(active, { code: 'ENERGY_WORKER_FAILED' });
      void retire();
    };
    generation.on('error', failed); generation.on('exit', failed);
    return generation;
  }
  function cancel() {
    if (!active) return;
    active.observation?.finish('cancelled', { reason: 'cancelled' });
    active = null;
    job = { ...job, state: 'cancelled', completedAt: clock(), error: null };
    void retire();
  }
  function start(now, checkpoint, context) {
    if (active) return;
    clearTimeout(idleTimer); idleTimer = null;
    const entry = { id: ++nextId, now, checkpoint, context,
      observation: storageOperationHealth.begin('history-query', { queued: true, scope: 'history' }) };
    active = entry;
    job = { ...idleJob(), id: entry.id, state: 'queued', stage: 'queued', startedAt: clock() };
    void Promise.resolve(retiring).then(() => {
      if (active !== entry || closed) return;
      entry.observation?.start();
      // In-memory stores are confined to disposable fixtures and cannot be
      // reopened by another connection. File-backed installations always use
      // the independently scheduled, bounded worker below.
      if (store.path === ':memory:') {
        job = { ...job, state: 'running', stage: 'comparing-energy' };
        try { complete(entry, null, energyCheckSummaries(store, { now })); }
        catch (error) { complete(entry, error); }
        return;
      }
      try { ensureWorker().postMessage({ id: entry.id, now, checkpoint }); }
      catch (error) { complete(entry, error); void retire(); }
    });
  }
  function prepare({ now = clock(), checkpoint = store.expectedCheckpoint, signal, ...options } = {}) {
    if (closed) throw new Error('Energy checks are closed');
    if (Object.keys(options).length) throw new TypeError('Unsupported energy-check option');
    if (signal?.aborted) throw Object.assign(new Error('Energy-check view aborted'), { name: 'AbortError' });
    if (!validNow(now)) throw new TypeError('Energy checks require a valid receipt cutoff');
    if (checkpoint !== undefined && !validCheckpoint(checkpoint)) throw new TypeError('Invalid energy-check history checkpoint');
    if (checkpoint && latestCheckpoint?.databaseId === checkpoint.databaseId
      && (checkpoint.sequence < latestCheckpoint.sequence
        || checkpoint.sequence === latestCheckpoint.sequence && checkpoint.hash !== latestCheckpoint.hash))
      throw Object.assign(new Error('The replica checkpoint advanced. Reopen the checks to use the current history.'),
        { code: 'ENERGY_CHECKPOINT_CHANGED' });
    if (checkpoint) latestCheckpoint = checkpoint;
    const selection = store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get()?.generation;
    const context = JSON.stringify([contextKey(checkpoint), selection]);
    const obsolete = resultAsOf !== null && now < resultAsOf || resultContext !== context;
    if (obsolete) {
      result = null; latest = null; resultGeneratedAt = null; resultAsOf = null; resultContext = context;
      if (!active) job = idleJob();
    }
    if (active && (now < active.now || active.context !== context)) { cancel(); latest = null; }
    if (obsolete && job.state === 'cancelled') job = idleJob();
    return { now, checkpoint, context };
  }
  return {
    async view(args = {}) {
      const { now, checkpoint, context } = prepare(args);
      // Explicit cancellation/failure remains visible until a user retries;
      // regular polling cannot silently restart a cancelled expensive job.
      if (!active && !['cancelled', 'failed'].includes(job.state)
        && (resultAsOf === null || now - resultAsOf >= refreshMs)) start(now, checkpoint, context);
      return snapshot();
    },
    async action(input, args = {}) {
      if (!input || Object.keys(input).some(key => key !== 'action') || !['refresh', 'cancel'].includes(input.action))
        throw new TypeError('Invalid energy-check action');
      const { now, checkpoint, context } = prepare(args);
      if (input.action === 'cancel') cancel();
      else start(now, checkpoint, context);
      return snapshot();
    },
    async close() {
      if (closed) return;
      cancel(); closed = true;
      await retire();
    },
  };
}
