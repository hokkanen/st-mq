import { Worker } from 'node:worker_threads';

export function startOnlineLearning({ store, input }) {
  const worker = new Worker(new URL('./online-learning-worker.js', import.meta.url));
  let busy = false, closed = false;
  worker.on('message', result => {
    busy = false;
    if (result.error) store.event('learning-error', { message: result.error });
    else store.setState(`learned:${input}`, result.checkpoint);
  });
  worker.on('error', error => { busy = false; closed = true; store.event('learning-error', { message: error.message }); });
  return {
    sample(sample, now) {
      if (busy || closed) return;
      let checkpoint = null;
      try { checkpoint = store.getState(`learned:${input}`); } catch { /* Reconstruct conservatively. */ }
      busy = true;
      worker.postMessage({ checkpoint, sample, now });
    },
    async close() { closed = true; await worker.terminate(); },
  };
}

export function startHistoryLearning({ store }) {
  let worker = null, stopped = false;
  const run = () => {
    if (worker || stopped) return;
    worker = new Worker(new URL('./learning-worker.js', import.meta.url), { workerData: { dbPath: store.path } });
    worker.on('message', result => { if (result.error) store.event('learning-error', { message: result.error }); });
    worker.on('error', error => { store.event('learning-error', { message: error.message }); });
    worker.on('exit', () => { worker = null; });
  };
  run();
  const timer = setInterval(run, 15 * 60_000);
  return { async close() { stopped = true; clearInterval(timer); if (worker) { const current = worker; current.postMessage('stop'); await new Promise(resolve => current.once('exit', resolve)); } } };
}
