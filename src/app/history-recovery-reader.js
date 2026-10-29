import { storageOperationHealth } from '../storage/operation-health.js';
import { Worker } from 'node:worker_threads';
import { attachStorageAdmission, terminateStorageWorker } from '../storage/worker-admission.js';

const unavailable = 'Previous recoveries are unavailable. Refresh to retry.';
function validate(input, options) {
  const cursor = options?.before;
  if (!['mqtt', 'providers', 'simulated', 'history', 'offline'].includes(input)
    || !options || Object.keys(options).some(key => !['before', 'limit'].includes(key))
    || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100
    || cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 180 || !/^\d+:[a-zA-Z0-9-]+$/.test(cursor)
      || !Number.isSafeInteger(Number(cursor.split(':')[0]))))
    throw Object.assign(new Error('Choose a bounded recovery history page.'), { statusCode: 400 });
}

/** Keep large contribution counts off the HTTP/control thread. Duplicate polls
 * share a request; both pending work and the short-lived page cache are bounded. */
export function createRecoveryHistoryReader(store, { WorkerClass = Worker, clock = Date.now } = {}) {
  storageOperationHealth.register('history-query');
  let worker = null, closed = false, sequence = 0, generation = 0;
  const pending = new Map(), cache = new Map(), terminating = new Set();
  const keyOf = (input, options) => JSON.stringify([input, options.before ?? null, options.limit]);
  function remember(entry, value) {
    if (entry.generation !== generation) return;
    cache.delete(entry.key); cache.set(entry.key, { at: clock(), ...value });
    while (cache.size > 8) cache.delete(cache.keys().next().value);
  }
  function terminate(current) {
    const completion = Promise.resolve(terminateStorageWorker(current)).catch(() => {});
    terminating.add(completion);
    void completion.finally(() => terminating.delete(completion));
    return completion;
  }
  const start = () => {
    if (worker) return;
    const storageSignal = new Int32Array(new SharedArrayBuffer(4));
    worker = new WorkerClass(new URL('./history-recovery-reader-worker.js', import.meta.url), { workerData: { path: store.path, storageSignal:storageSignal.buffer },
      ...(process.execArgv.some(value => value.startsWith('--input-type')) ? { execArgv: [] } : {}) });
    attachStorageAdmission(worker,storageSignal,operation=>store.runStorageTask(operation,{kind:'history'}));
    const current = worker;
    worker.on('message', message => {
      if (worker !== current) return;
      if(message.storage)return;
      const entry = pending.get(message.id);
      if (!entry) return;
      if (message.storageOperationStart) { entry.operation?.start(); return; }
      pending.delete(message.id);
      entry.operation?.finish(message.error ? 'failed' : 'completed', { reason: message.error ? 'operation-failed' : null });
      remember(entry, message.error ? { error: unavailable, rows: cache.get(entry.key)?.rows ?? [] } : { rows: message.rows });
    });
    const stop = () => {
      if (worker !== current) return;
      worker = null;
      const entries = [...pending.values()];
      for (const entry of entries) remember(entry, { error: unavailable, rows: cache.get(entry.key)?.rows ?? [] });
      pending.clear();
      void terminate(current).then(() => { for (const entry of entries) entry.operation?.finish('failed', { reason: 'worker-lost' }); });
    };
    worker.on('error', stop);
    worker.on('exit', stop);
  };
  return {
    invalidate() { generation++; cache.clear(); },
    snapshot(input, options, { refresh = true } = {}) {
      validate(input, options);
      if (closed || store.path === ':memory:') return { rows: [], loading: false, error: unavailable };
      const key = keyOf(input, options), hit = cache.get(key);
      const inflight = [...pending.values()].some(entry => entry.key === key && entry.generation === generation);
      if ((!hit || (refresh || hit.error) && clock() - hit.at >= 1000) && !inflight) {
        if (pending.size >= 8) { storageOperationHealth.refuse('history-query'); return { rows: hit?.rows ?? [], loading: false, error: unavailable }; }
        const id = ++sequence, entry = { key, generation, operation: storageOperationHealth.begin('history-query', { queued: true, scope: 'history' }) };
        try { start(); pending.set(id, entry); worker.postMessage({ id, input, options }); }
        catch { entry.operation?.finish('failed', { reason: 'operation-failed' }); pending.delete(id); remember(entry, { error: unavailable, rows: hit?.rows ?? [] }); }
      }
      const result = cache.get(key);
      return { rows: result?.rows ?? [], loading: !result, error: result?.error ?? null };
    },
    async close() {
      closed = true;
      const previous = worker; worker = null;
      const entries = [...pending.values()];
      pending.clear(); cache.clear();
      if (previous) void terminate(previous);
      await Promise.all([...terminating]);
      for (const entry of entries) entry.operation?.finish('cancelled', { reason: 'cancelled' });
    },
  };
}
