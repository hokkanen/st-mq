import { storageOperationHealth, observeStorageOperation } from '../storage/operation-health.js';
import { Worker } from 'node:worker_threads';
import { forecastHousehold } from './history.js';
import { createDerivedCacheAnchorOwner, derivedCacheId } from '../storage/derived-cache-anchor.js';

const unavailable = () => Object.assign(new Error('Household history is temporarily unavailable.'), { code: 'history-unavailable' });

/** Keep expensive first-time archive decoding off the control/event loop. One
 * request runs and only the newest subsequent request waits. A superseded or
 * closed request resolves null; callers must also check their input generation
 * before publishing an older in-flight result. Refresh cadence belongs to the
 * runtime, while the worker reuses its source-watermarked reference index. */
export function createHouseholdForecastService({ store, cachePath = store?.path, cacheIdentity = '' } = {}) {
  storageOperationHealth.register('history-query');
  if (!store?.path || store.path === ':memory:') {
    let closed = false;
    return {
      request(options) { return closed ? Promise.resolve(null) : observeStorageOperation('history-query', () => forecastHousehold(store, options)); },
      close() { closed = true; },
    };
  }
  let worker = null, active = null, queued = null, sequence = 0, closed = false;
  const anchorFlights = new Set(), cacheId = derivedCacheId(cachePath, cacheIdentity);
  const fail = () => {
    const failed = worker;
    worker = null;
    const operation = active?.operation;
    active?.reject(unavailable()); active = null;
    queued?.reject(unavailable()); queued = null;
    void Promise.resolve(failed?.terminate()).catch(() => {}).then(() => operation?.finish('failed', { reason: 'worker-lost' }));
  };
  const start = request => {
    if (closed) { request.resolve(null); return; }
    active = request;
    request.operation = storageOperationHealth.begin('history-query');
    if (!worker) {
      try {
        worker = new Worker(new URL('./history-worker.js', import.meta.url), { workerData: { path: store.path, cachePath, cacheId } });
      } catch { fail(); return; }
      const current = worker;
      worker.on('message', message => {
        if (worker !== current) return;
        if (message?.type === 'derived-cache-anchor') {
          const isCurrent = () => !closed && worker === current && active?.id === message.id;
          const owner = createDerivedCacheAnchorOwner({ store, cacheId, purpose: 'household', isCurrent });
          const flight = Promise.resolve().then(() => isCurrent() ? owner(message.request) : null).catch(() => null)
            .then(proof => { if (worker === current) current.postMessage({ type: 'derived-cache-anchor', requestId: message.requestId, proof }); })
            .catch(() => {}).finally(() => anchorFlights.delete(flight));
          anchorFlights.add(flight); return;
        }
        if (message?.type === 'error' && message.id === null) { fail(); return; }
        if (!active || message?.id !== active.id) return;
        const completed = active;
        active = null;
        completed.operation.finish(message.type === 'forecast' && Array.isArray(message.rows) ? 'completed' : 'failed',
          { reason: message.type === 'forecast' && Array.isArray(message.rows) ? null : 'operation-failed' });
        if (message.type === 'forecast' && Array.isArray(message.rows)) completed.resolve(message.rows);
        else completed.reject(unavailable());
        if (queued) { const next = queued; queued = null; start(next); }
        else worker.unref();
      });
      worker.on('error', () => { if (worker === current) fail(); });
      worker.on('exit', () => { if (worker === current) fail(); });
    }
    worker.ref();
    try { worker.postMessage({ type: 'forecast', id: request.id, options: request.options }); }
    catch { fail(); }
  };
  return {
    request(options) {
      if (closed) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const request = { options, resolve, reject, id: ++sequence };
        if (active) { queued?.resolve(null); queued = request; }
        else start(request);
      });
    },
    close() {
      closed = true;
      const operation = active?.operation;
      active?.resolve(null); active = null;
      queued?.resolve(null); queued = null;
      const previous = worker; worker = null;
      return Promise.allSettled([Promise.resolve(previous?.terminate()), ...anchorFlights])
        .then(() => operation?.finish('cancelled', { reason: 'cancelled' }));
    },
  };
}
