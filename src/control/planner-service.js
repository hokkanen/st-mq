import { Worker } from 'node:worker_threads';

const unavailable = () => new Error('Home heating planning is temporarily unavailable.');

// Keep learning history, database handles and device objects off the worker
// boundary. The planner receives only its current calculation inputs.
function planningInput(input) {
  const { now, observations, prices, forecast, settings, config, thermalState, equipment, trialBudgetRemainingCents } = input;
  const checkpoint = input.checkpoint ? { model: input.checkpoint.model, baselineC: input.checkpoint.baselineC,
    health: { usableSamples: input.checkpoint.health?.usableSamples } } : null;
  return structuredClone({ now, observations: { indoor: observations?.indoor }, prices, forecast,
    checkpoint, settings, config, thermalState, equipment, trialBudgetRemainingCents });
}

/** One pure calculation worker, one running request and only the newest queued
 * snapshot. Results carry no command authority; callers must revalidate them
 * against current equipment, source evidence, model and control ownership. */
export function createHeatingPlannerService({ WorkerClass = Worker, timeoutMs = 30_000 } = {}) {
  let worker = null, active = null, queued = null, sequence = 0, closed = false, timer = null;
  const clearDeadline = () => { clearTimeout(timer); timer = null; };
  const stop = () => {
    clearDeadline();
    const previous = worker; worker = null;
    return previous?.terminate().catch(() => {});
  };
  const fail = () => {
    active?.reject(unavailable()); active = null;
    queued?.reject(unavailable()); queued = null;
    void stop();
  };
  const start = request => {
    active = request;
    if (!worker) {
      try { worker = new WorkerClass(new URL('./planner-worker.js', import.meta.url)); }
      catch { fail(); return; }
      const current = worker;
      worker.on('message', message => {
        if (worker !== current || !active || message?.id !== active.id) return;
        clearDeadline();
        const completed = active; active = null;
        if (completed.id !== sequence) completed.resolve(null);
        else if (message.error || !message.result) completed.reject(unavailable());
        else completed.resolve(message.result);
        if (queued) { const next = queued; queued = null; start(next); }
        else worker.unref();
      });
      worker.on('error', () => { if (worker === current) fail(); });
      worker.on('exit', () => { if (worker === current) fail(); });
    }
    worker.ref();
    timer = setTimeout(fail, timeoutMs);
    timer.unref();
    try { worker.postMessage({ id: request.id, input: request.input }); }
    catch { fail(); }
  };
  return {
    request(input) {
      if (closed) return Promise.resolve(null);
      try { input = planningInput(input); }
      catch { return Promise.reject(unavailable()); }
      return new Promise((resolve, reject) => {
        const request = { id: ++sequence, input, resolve, reject };
        if (active) { queued?.resolve(null); queued = request; }
        else start(request);
      });
    },
    close() {
      closed = true; sequence++;
      active?.resolve(null); active = null;
      queued?.resolve(null); queued = null;
      return stop();
    },
  };
}
