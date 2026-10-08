import { Worker } from 'node:worker_threads';
import { chargingPlannerInput, chargingPlanValidUntil } from './planner-input.js';

const unavailable = () => new Error('Charging planning is temporarily unavailable.');

// One CPU worker, one running request and the newest waiting request per lane.
// Control calculations take priority over optional cost comparisons.
// Computation has no database, device connection or control authority.
export function createChargingPlannerService() {
  let worker, active, queued, preview, sequence = 0, closed = false;
  const cache = new Map();
  const fail = () => {
    const previous = worker; worker = null;
    active?.reject(unavailable()); active = null;
    queued?.reject(unavailable()); queued = null;
    preview?.reject(unavailable()); preview = null;
    void previous?.terminate().catch(() => {});
  };
  const start = request => {
    active = request;
    if (!worker) {
      try { worker = new Worker(new URL('./planner-worker.js', import.meta.url)); }
      catch { fail(); return; }
      const current = worker;
      worker.on('message', message => {
        if (worker !== current || !active || message?.id !== active.id) return;
        const completed = active; active = null;
        if (message.error || !message.result) completed.reject(unavailable());
        else {
          cache.delete(completed.key);
          cache.set(completed.key, { at: completed.options.now,
            until: chargingPlanValidUntil(completed.options, message.result), result: message.result });
          if (cache.size > 4) cache.delete(cache.keys().next().value);
          completed.resolve(structuredClone(message.result));
        }
        if (queued) { const next = queued; queued = null; start(next); }
        else if (preview) { const next = preview; preview = null; start(next); }
        else worker.unref();
      });
      worker.on('error', () => { if (worker === current) fail(); });
      worker.on('exit', () => { if (worker === current) fail(); });
    }
    worker.ref();
    try { worker.postMessage({ id: request.id, options: request.options, comparison: request.comparison }); }
    catch { fail(); }
  };
  const requestPlan = (options, comparison = null) => {
    if (closed) return Promise.resolve(null);
    let key;
    try {
      options = structuredClone(chargingPlannerInput(options));
      key = JSON.stringify({ ...options, now: undefined, ...(comparison ? { comparison } : {}) });
    } catch { return Promise.reject(unavailable()); }
    const saved = cache.get(key);
    if (saved && options.now >= saved.at && options.now < saved.until)
      return Promise.resolve(structuredClone(saved.result));
    return new Promise((resolve, reject) => {
      const request = { id: ++sequence, options, key, resolve, reject, comparison };
      if (active && comparison) { preview?.resolve(null); preview = request; }
      else if (active) { queued?.resolve(null); queued = request; }
      else start(request);
    });
  };
  return {
    request: options => requestPlan(options),
    compare: (options, comparison) => requestPlan(options, comparison),
    close() {
      closed = true;
      cache.clear();
      active?.resolve(null); active = null;
      queued?.resolve(null); queued = null;
      preview?.resolve(null); preview = null;
      const previous = worker; worker = null;
      return previous?.terminate().catch(() => {});
    },
  };
}
