import { Worker } from 'node:worker_threads';
import { getDatabaseCatalogue, getDatabaseFileMetrics } from './database-overview.js';
import { readDatabaseInventory } from './inventory-reader.js';
import { attachStorageAdmission, terminateStorageWorker } from '../storage/worker-admission.js';
import { storageOperationHealth } from '../storage/operation-health.js';
import { validCheckpoint } from '../storage/journal.js';

const aborted = () => Object.assign(new Error('Inventory request aborted.'), { name: 'AbortError' });
const active = job => ['queued', 'running'].includes(job.state);
const emptyJob = () => ({ id: null, state: 'idle', stage: null, processed: 0, startedAt: null, completedAt: null, error: null });
const messages = {
  INVENTORY_SOURCE_CHANGED: 'The recorded database changed. Measure the inventory again.',
  INVENTORY_STORAGE_BUSY: 'Storage is busy. Wait for the current storage operation, then try again.',
  INVENTORY_DATABASE_UNREADABLE: 'The database could not be read. Use Check database to inspect it.',
  INVENTORY_READ_FAILED: 'The inventory could not be measured. Try again; use Check database if the problem continues.',
  INVENTORY_TOO_COMPLEX: 'The inventory contains too many distinct metadata entries for one measurement. Previously completed results remain available.',
  INVENTORY_WORKER_FAILED: 'The inventory worker stopped. Measure the inventory again.',
};

/** Process-owned results outlive browser requests and chart-worker retirement.
 * One explicit measurement is shared by all viewers; ordinary reads never start
 * historical work. Caches are replaceable and never written into the database. */
export function createInventoryService({ store, clock = Date.now, WorkerClass = Worker } = {}) {
  if (!store?.db || !store.path) throw new TypeError('A history store is required');
  storageOperationHealth.register('storage-inventory');
  const catalogue = getDatabaseCatalogue({ store, now: clock() });
  let result = null, job = emptyJob(), worker = null, requestSignal = null, closed = false, sequence = 0;
  let operation = null, scope, stopping = null, latestCheckpoint = null;
  const scopeKey = checkpoint => JSON.stringify([checkpoint?.databaseId ?? null,
    store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get()?.generation ?? null]);
  function finish(state, error = null) {
    job = { ...job, state, completedAt: clock(), error };
    operation?.finish(state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed',
      { reason: state === 'completed' ? null : state === 'cancelled' ? 'cancelled' : 'operation-failed' });
    operation = null;
  }
  async function stop() {
    if (stopping) return stopping;
    const previous = worker; worker = null;
    if (requestSignal) Atomics.store(requestSignal, 0, 1);
    if (previous) {
      stopping = Promise.resolve(terminateStorageWorker(previous)).catch(() => {}).finally(() => { stopping = null; });
      await stopping;
    }
    if (active(job)) finish('cancelled');
  }
  async function source(checkpoint) {
    if (checkpoint != null && !validCheckpoint(checkpoint)) throw new TypeError('A verified inventory checkpoint is required.');
    if (checkpoint && latestCheckpoint && checkpoint.databaseId === latestCheckpoint.databaseId
      && (checkpoint.sequence < latestCheckpoint.sequence
        || checkpoint.sequence === latestCheckpoint.sequence && checkpoint.hash !== latestCheckpoint.hash))
      throw Object.assign(new Error(messages.INVENTORY_SOURCE_CHANGED), { code: 'INVENTORY_SOURCE_CHANGED' });
    if (checkpoint) latestCheckpoint = checkpoint;
    const key = scopeKey(checkpoint);
    if (scope !== undefined && scope !== key) { await stop(); result = null; job = emptyJob(); }
    scope = key;
  }
  function snapshot() {
    return { catalogue: { ...catalogue, generatedAt: clock(), database: getDatabaseFileMetrics({ store }) }, result, job: { ...job } };
  }
  function start(checkpoint) {
    const id = ++sequence;
    const measurementScope = scope;
    job = { ...emptyJob(), id, state: 'queued', stage: 'queued', startedAt: clock() };
    operation = storageOperationHealth.begin('storage-inventory', { queued: true, scope: 'history' });
    if (store.path === ':memory:') {
      // Synthetic stores cannot be reopened by a worker. The identical paged
      // reader remains available for offline tools and deterministic fixtures.
      queueMicrotask(() => {
        if (closed || job.id !== id || !active(job)) return;
        job.state = 'running'; operation?.start();
        try { result = readDatabaseInventory({ store, now: job.startedAt, onProgress: value => Object.assign(job, value) }); finish('completed'); }
        catch { finish('failed', { code: 'INVENTORY_READ_FAILED', message: messages.INVENTORY_READ_FAILED }); }
      });
      return;
    }
    try {
      const signal = new Int32Array(new SharedArrayBuffer(4));
      requestSignal = new Int32Array(new SharedArrayBuffer(4));
      worker = new WorkerClass(new URL('./inventory-worker.js', import.meta.url), {
        workerData: { path: store.path, now: job.startedAt, checkpoint, storageSignal: signal.buffer,
          requestSignal: requestSignal.buffer, storageLeaseMs: 0 },
        ...(process.execArgv.some(value => value.startsWith('--input-type')) ? { execArgv: [] } : {}),
      });
      const current = worker;
      attachStorageAdmission(current, signal, fn => store.runStorageTask(fn, { kind: 'history' }));
      let response = null;
      current.on('message', message => {
        if (worker !== current || job.id !== id || message.storage) return;
        if (message.started) { job.state = 'running'; operation?.start(); }
        if (message.progress) { job.stage = message.progress.stage; job.processed = message.progress.processed; operation?.progress('reading'); }
        if (message.result || message.error) response = message;
      });
      current.on('error', () => {});
      current.on('exit', () => {
        if (worker !== current || job.id !== id) return;
        worker = null; requestSignal = null;
        let currentScope;
        try { currentScope = scopeKey(checkpoint); }
        catch { finish('failed', { code: 'INVENTORY_READ_FAILED', message: messages.INVENTORY_READ_FAILED }); return; }
        if (scope !== measurementScope || currentScope !== measurementScope) {
          result = null; scope = currentScope;
          finish('failed', { code: 'INVENTORY_SOURCE_CHANGED', message: messages.INVENTORY_SOURCE_CHANGED });
        }
        else if (response?.result) { result = response.result; finish('completed'); }
        else if (response?.error?.code === 'INVENTORY_CANCELLED') finish('cancelled');
        else {
          const code = Object.hasOwn(messages, response?.error?.code) ? response.error.code : 'INVENTORY_WORKER_FAILED';
          finish('failed', { code, message: messages[code] });
        }
      });
    } catch { worker = null; finish('failed', { code: 'INVENTORY_WORKER_FAILED', message: messages.INVENTORY_WORKER_FAILED }); }
  }
  return {
    async view({ checkpoint = store.expectedCheckpoint, signal, ...options } = {}) {
      if (Object.keys(options).length) throw new TypeError('Unsupported inventory option.');
      if (closed) throw new Error('Inventory service is closed.');
      if (signal?.aborted) throw aborted();
      await source(checkpoint);
      if (closed) throw new Error('Inventory service is closed.');
      return snapshot();
    },
    async action(input, { checkpoint = store.expectedCheckpoint, signal, ...options } = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
        || !['measure', 'cancel'].includes(input.action) || Object.keys(options).length) throw new TypeError('Choose measure or cancel for the inventory.');
      if (closed) throw new Error('Inventory service is closed.');
      if (signal?.aborted) throw aborted();
      await source(checkpoint);
      if (closed) throw new Error('Inventory service is closed.');
      if (input.action === 'cancel') await stop();
      else if (!active(job)) {
        if (stopping) await stopping;
        if (closed) throw new Error('Inventory service is closed.');
        start(checkpoint);
      }
      if (closed) throw new Error('Inventory service is closed.');
      return snapshot();
    },
    async close() { if (closed) return; closed = true; await stop(); result = null; },
  };
}
