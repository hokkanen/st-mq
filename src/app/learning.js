import { Worker } from 'node:worker_threads';
import { LEARNING_WINDOW_MS } from './committed-learning.js';

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
      if (sample?.provenance?.basis !== 'committed-history' || sample.timestamp % LEARNING_WINDOW_MS !== 0)
        throw new TypeError('Online learning requires a committed UTC learning window');
      let checkpoint = null;
      try { checkpoint = store.getState(`learned:${input}`); } catch { /* Reconstruct conservatively. */ }
      busy = true;
      worker.postMessage({ checkpoint, sample, now });
    },
    async close() { closed = true; await worker.terminate(); },
  };
}

export function startHistoryLearning({ store, config = {} }) {
  let worker = null, stopped = false;
  const run = () => {
    if (worker || stopped) return;
    // Only model settings cross this boundary; provider credentials are irrelevant.
    const modelConfig = Object.fromEntries(['heatPumpCompressorKw', 'auxRatedKw', 'circulationKw', 'dhwrKw', 'targetC', 'thermalPriors']
      .filter(key => config[key] !== undefined).map(key => [key, config[key]]));
    worker = new Worker(new URL('./learning-worker.js', import.meta.url), { workerData: { dbPath: store.path, config: modelConfig } });
    worker.on('message', result => { if (result.error) store.event('learning-error', { message: result.error }); });
    worker.on('error', error => { store.event('learning-error', { message: error.message }); });
    worker.on('exit', () => { worker = null; });
  };
  run();
  const timer = setInterval(run, 15 * 60_000);
  return { async close() { stopped = true; clearInterval(timer); if (worker) { const current = worker; current.postMessage('stop'); await new Promise(resolve => current.once('exit', resolve)); } } };
}
