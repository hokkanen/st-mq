import { Worker } from 'node:worker_threads';
import { attachStorageAdmission } from '../storage/worker-admission.js';
import { readEventLog, changedEventLog, advancedEventLog } from './event-log.js';
import { validTime } from './event-log-presentation.js';

const unavailable = () => Object.assign(new Error('The event log could not be refreshed. Previously fetched entries remain available.'), { code: 'event_log_unavailable', statusCode: 503 });
const aborted = () => Object.assign(new Error('Event read cancelled.'), { name: 'AbortError' });
const publicError = code => code === 'event_log_context_changed' ? changedEventLog()
  : code === 'event_log_checkpoint_advanced' ? advancedEventLog()
  : code === 'event_log_aborted' ? aborted()
  : code === 'event_log_query_invalid' ? Object.assign(new TypeError('Choose supported event filters and a valid history page.'), { code, statusCode: 400 }) : unavailable();

/** One bounded read lane per physical history owner. Concurrent matching reads
 * share one in-flight check, including its original check time; no page cache or
 * writable database is introduced. Each snapshot keeps its exact checkpoint. */
export function createEventLogService({ store, idleMs = 60000, requestTimeoutMs = 12000, WorkerClass = Worker } = {}) {
  if (!store?.db || !store.path) throw new TypeError('An event-log history store is required');
  let worker = null, active = null, nextId = 0, closed = false, idleTimer = null, retiring = null, waiterCount = 0;
  const queue = [], flights = new Map();
  const requestSignal = new Int32Array(new SharedArrayBuffer(4));
  function settleWaiter(entry, waiter, error, result) {
    if (!entry.waiters.delete(waiter)) return;
    waiterCount--;
    waiter.signal?.removeEventListener('abort', waiter.cancel);
    const failure = waiter.cancelled ? aborted() : error;
    failure ? waiter.reject(failure) : waiter.resolve(result);
  }
  function forget(entry) {
    clearTimeout(entry.timer);
    if (flights.get(entry.key) === entry) flights.delete(entry.key);
  }
  function finish(entry, error, result) {
    forget(entry);
    if (active === entry) active = null;
    for (const waiter of [...entry.waiters]) settleWaiter(entry, waiter, error, result);
    pump();
  }
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
    const entry = active;
    void retire().then(() => { if (entry) finish(entry, unavailable()); });
  }
  function ensureWorker() {
    if (worker) return worker;
    const storageSignal = new Int32Array(new SharedArrayBuffer(4));
    worker = new WorkerClass(new URL('./event-log-worker.js', import.meta.url), {
      workerData: { dbPath: store.path, storageSignal: storageSignal.buffer, requestSignal: requestSignal.buffer, storageLeaseMs: 10 },
      ...(process.execArgv.some(value => value.startsWith('--input-type')) ? { execArgv: [] } : {}),
    });
    const generation = worker; generation.unref();
    attachStorageAdmission(generation, storageSignal, operation => store.runStorageTask(operation, { kind: 'history' }));
    generation.on('error', () => failed(generation));
    generation.on('exit', () => failed(generation));
    generation.on('message', message => {
      if (worker !== generation || message.id !== active?.id || (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error'))) return;
      const entry = active;
      if (message.retire) {
        void retire().then(() => finish(entry, unavailable())); return;
      }
      // Worker completion follows rollback and release of its final storage
      // turn. Even the last cancelled caller keeps its read lease until here.
      finish(entry, message.error ? publicError(message.error.code) : null, message.result);
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
      Atomics.store(requestSignal, 0, 0);
      generation.postMessage({ id: entry.id, args: entry.args });
    } catch { void retire().then(() => finish(entry, unavailable())); }
  }
  function cancel(entry, waiter) {
    waiter.cancelled = true;
    if (active === entry && entry.waiters.size === 1) {
      // Cooperatively stop SQL/decoding at its next admission boundary. Native
      // cleanup and the request deadline still own the caller's lease lifetime.
      if (flights.get(entry.key) === entry) flights.delete(entry.key);
      Atomics.store(requestSignal, 0, 1);
      return;
    }
    settleWaiter(entry, waiter, aborted());
    if (!entry.waiters.size) {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      forget(entry); pump();
    }
  }
  return {
    query(args, { signal } = {}) {
      if (signal?.aborted) return Promise.reject(aborted());
      if (closed || waiterCount >= 64) return Promise.reject(unavailable());
      if (store.path === ':memory:') {
        const own = !store.db.isTransaction;
        try { if (own) store.db.exec('BEGIN'); return Promise.resolve(readEventLog({ db: store.db, ...args })); }
        catch (error) { return Promise.reject(publicError(error?.code)); }
        finally { if (own && store.db.isTransaction) store.db.exec('ROLLBACK'); }
      }
      // Live callers may join the same pending check. Preserve its original
      // clock rather than pretending each subscriber performed a newer read.
      // Snapshot/history clocks and checkpoint identities are never combined.
      const { checkedAt, now, ...selection } = args;
      if (!validTime(now) || checkedAt !== undefined && !validTime(checkedAt)) return Promise.reject(publicError('event_log_query_invalid'));
      const key = JSON.stringify([selection, selection.scope === 'snapshot' || selection.checkpoint || selection.input === 'offline' ? now : null]);
      let entry = flights.get(key);
      if (!entry && queue.length >= 4) return Promise.reject(unavailable());
      return new Promise((resolve, reject) => {
        if (!entry) {
          entry = { id: ++nextId, key, args: structuredClone(args), waiters: new Set() };
          flights.set(key, entry); queue.push(entry);
          // The deadline includes queueing; an abandoned backlog cannot linger
          // through a fresh full timeout for every request ahead of it.
          entry.timer = setTimeout(() => {
            if (active === entry) failed(worker);
            else { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); finish(entry, unavailable()); }
          }, requestTimeoutMs);
          entry.timer.unref();
        }
        const waiter = { resolve, reject, signal, cancelled: false };
        waiter.cancel = () => cancel(entry, waiter);
        entry.waiters.add(waiter); waiterCount++;
        signal?.addEventListener('abort', waiter.cancel, { once: true });
        pump();
      });
    },
    async close() {
      closed = true;
      const entry = active;
      if (entry) forget(entry);
      for (const queued of queue.splice(0)) finish(queued, unavailable());
      await retire();
      if (entry) finish(entry, unavailable());
    },
  };
}
