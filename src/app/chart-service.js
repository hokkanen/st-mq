import { Worker } from 'node:worker_threads';
import { getChartData, chartRange } from './chart-data.js';
import { getDatabaseOverview } from './database-overview.js';

const aborted = () => Object.assign(new Error('Chart request aborted'), { name: 'AbortError' });

/** Lazy, bounded, cancelable worker queue. In-memory stores use the same pure
 * query directly for small tests; real application files always use a worker. */
export function createChartService({ store, maxQueue = 8 } = {}) {
  if (!store?.db || !store.path) throw new TypeError('A history store is required');
  let worker = null, active = null, nextId = 1, closed = false;
  const queue = [], retiring = new Set();
  const cleanup = entry => entry.signal?.removeEventListener('abort', entry.abort);
  const settle = (entry, error, result) => { cleanup(entry); error ? entry.reject(error) : entry.resolve(result); };
  const reset = () => {
    const previous = worker; worker = null;
    if (previous) {
      previous.removeAllListeners();
      const retirement = previous.terminate().finally(() => { retiring.delete(retirement); pump(); });
      retiring.add(retirement);
    }
  };
  function pump() {
    if (closed || active || retiring.size || !queue.length) return;
    active = queue.shift();
    if (!worker) {
      worker = new Worker(new URL('./chart-worker.js', import.meta.url), { workerData: { dbPath: store.path } });
      const generation = worker;
      worker.on('message', message => {
        if (worker !== generation) return;
        if (message.id !== active?.id) return;
        const entry = active; active = null;
        const error = message.error ? Object.assign(new Error(message.error.message), { name: message.error.name }) : null;
        settle(entry, error, message.result); pump();
      });
      worker.on('error', () => {
        if (worker !== generation) return;
        const entry = active; active = null; reset();
        if (entry) settle(entry, new Error('Chart history worker failed'));
        pump();
      });
      worker.on('exit', code => {
        if (worker === generation && code !== 0) {
          const entry = active; active = null; reset();
          if (entry) settle(entry, new Error('Chart history worker stopped'));
          pump();
        }
      });
    }
    worker.postMessage({ id: active.id, args: active.args, operation: active.operation });
  }
  return {
    overview({ signal } = {}) { return this.query({}, { signal, operation: 'overview' }); },
    query(args, { signal, operation = 'chart' } = {}) {
      if (closed) return Promise.reject(new Error('Chart service is closed'));
      if (signal?.aborted) return Promise.reject(aborted());
      args = { ...args, now: args?.now ?? Date.now() };
      // Validate dates before allocating a worker or queue slot.
      try { if (operation !== 'overview') chartRange(args); } catch (error) { return Promise.reject(error); }
      if (store.path === ':memory:') {
        try { return Promise.resolve(operation === 'overview' ? getDatabaseOverview({ ...args, store }) : getChartData({ ...args, store })); }
        catch (error) { return Promise.reject(error); }
      }
      if (queue.length + Number(Boolean(active)) >= maxQueue) return Promise.reject(new RangeError('Too many pending chart requests'));
      return new Promise((resolve, reject) => {
        const entry = { id: nextId++, args, operation, signal, resolve, reject, abort: null };
        entry.abort = () => {
          if (active === entry) { active = null; reset(); }
          else { const index = queue.indexOf(entry); if (index < 0) return; queue.splice(index, 1); }
          settle(entry, aborted()); pump();
        };
        signal?.addEventListener('abort', entry.abort, { once: true });
        queue.push(entry); pump();
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const entry of queue.splice(0)) settle(entry, new Error('Chart service is closed'));
      if (active) { settle(active, new Error('Chart service is closed')); active = null; }
      const previous = worker; worker = null;
      if (previous) { previous.removeAllListeners(); await previous.terminate(); }
      await Promise.allSettled([...retiring]);
    },
  };
}
