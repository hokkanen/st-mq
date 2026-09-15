import { Worker } from 'node:worker_threads';
import { forecastHousehold } from './history.js';

const unavailable = () => Object.assign(new Error('Household history is temporarily unavailable.'), { code: 'history-unavailable' });

/** Keep expensive first-time archive decoding off the control/event loop. One
 * request runs and only the newest subsequent request waits. A superseded or
 * closed request resolves null; callers must also check their input generation
 * before publishing an older in-flight result. Refresh cadence belongs to the
 * runtime, while the worker reuses its source-watermarked reference index. */
export function createHouseholdForecastService({ store } = {}) {
  if (!store?.path || store.path === ':memory:') {
    let closed = false;
    return {
      request(options) { return Promise.resolve().then(() => closed ? null : forecastHousehold(store, options)); },
      close() { closed = true; },
    };
  }
  let worker = null, active = null, queued = null, sequence = 0, closed = false;
  const fail = () => {
    const failed = worker;
    worker = null;
    active?.reject(unavailable()); active = null;
    queued?.reject(unavailable()); queued = null;
    failed?.terminate().catch(() => {});
  };
  const start = request => {
    if (closed) { request.resolve(null); return; }
    active = request;
    if (!worker) {
      try {
        worker = new Worker(new URL('./history-worker.js', import.meta.url), { workerData: { path: store.path } });
      } catch { fail(); return; }
      const current = worker;
      worker.on('message', message => {
        if (worker !== current) return;
        if (message?.type === 'error' && message.id === null) { fail(); return; }
        if (!active || message?.id !== active.id) return;
        const completed = active;
        active = null;
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
      active?.resolve(null); active = null;
      queued?.resolve(null); queued = null;
      const previous = worker; worker = null;
      return previous?.terminate().catch(() => {});
    },
  };
}
