import { Worker } from 'node:worker_threads';
import { attachStorageAdmission } from '../storage/worker-admission.js';
import { readEventLog, changedEventLog, advancedEventLog } from './event-log.js';

const unavailable = () => Object.assign(new Error('The event log could not be refreshed. Previously fetched entries remain available.'), { code: 'event_log_unavailable', statusCode: 503 });
const publicError = code => code === 'event_log_context_changed' ? changedEventLog()
  : code === 'event_log_checkpoint_advanced' ? advancedEventLog()
  : code === 'event_log_query_invalid' ? Object.assign(new TypeError('Choose supported event filters and a valid history page.'), { code, statusCode: 400 }) : unavailable();

/** One bounded read lane per displayed store. Source records remain owned by
 * their existing writers; this worker has no writable database or disk cache. */
export function createEventLogService({ store, idleMs = 60000, requestTimeoutMs = 12000, WorkerClass = Worker } = {}) {
  if (!store?.db || !store.path) throw new TypeError('An event-log history store is required');
  let worker = null, active = null, nextId = 0, closed = false, idleTimer = null, retiring = null;
  const queue = [];
  const settle = (entry, error, result) => { clearTimeout(entry.timer); error ? entry.reject(error) : entry.resolve(result); };
  function retire() {
    clearTimeout(idleTimer); idleTimer = null;
    const previous = worker; worker = null;
    if (!previous) return retiring ?? Promise.resolve();
    const joined = previous.terminate().catch(() => {}).finally(() => {
      if (retiring === joined) { retiring = null; pump(); }
    });
    retiring = joined; return joined;
  }
  function failed(generation) {
    if (worker !== generation) return;
    const entry = active; active = null;
    void retire().then(() => { if (entry) settle(entry, unavailable()); pump(); });
  }
  function ensureWorker() {
    if (worker) return worker;
    const storageSignal = new Int32Array(new SharedArrayBuffer(4));
    worker = new WorkerClass(new URL('./event-log-worker.js', import.meta.url), {
      workerData: { dbPath: store.path, storageSignal: storageSignal.buffer, storageLeaseMs: 10 },
      ...(process.execArgv.some(value => value.startsWith('--input-type')) ? { execArgv: [] } : {}),
    });
    const generation = worker; generation.unref();
    attachStorageAdmission(generation, storageSignal, operation => store.runStorageTask(operation, { kind: 'history' }));
    generation.on('error', () => failed(generation));
    generation.on('exit', () => failed(generation));
    generation.on('message', message => {
      if (worker !== generation || message.id !== active?.id || (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error'))) return;
      const entry = active; active = null;
      if (message.retire) {
        void retire().then(() => { settle(entry, unavailable()); pump(); }); return;
      }
      settle(entry, message.error ? publicError(message.error.code) : null, message.result);
      pump();
    });
    return generation;
  }
  function pump() {
    if (closed || active || retiring) return;
    clearTimeout(idleTimer); idleTimer = null;
    if (!queue.length) {
      idleTimer = setTimeout(() => { if (!active) void retire(); }, idleMs); idleTimer.unref(); return;
    }
    active = queue.shift(); const entry = active;
    try {
      const generation = ensureWorker();
      entry.timer = setTimeout(() => failed(generation), requestTimeoutMs); entry.timer.unref();
      generation.postMessage({ id: entry.id, args: entry.args });
    } catch { const failedEntry = active; active = null; void retire().then(() => { if (failedEntry) settle(failedEntry, unavailable()); pump(); }); }
  }
  return {
    query(args) {
      if (closed || queue.length >= 4) return Promise.reject(unavailable());
      if (store.path === ':memory:') {
        const own = !store.db.isTransaction;
        try { if (own) store.db.exec('BEGIN'); return Promise.resolve(readEventLog({ db: store.db, ...args })); }
        catch (error) { return Promise.reject(publicError(error?.code)); }
        finally { if (own && store.db.isTransaction) store.db.exec('ROLLBACK'); }
      }
      return new Promise((resolve, reject) => { queue.push({ id: ++nextId, args, resolve, reject }); pump(); });
    },
    async close() {
      closed = true;
      const entry = active; active = null;
      for (const entry of queue.splice(0)) settle(entry, unavailable());
      await retire();
      if (entry) settle(entry, unavailable());
    },
  };
}
