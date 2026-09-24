import { Worker } from 'node:worker_threads';
import { learningConfiguration } from './committed-learning.js';

export function startHistoryLearning({ store, config = {}, WorkerClass = Worker, stderr = message => process.stderr.write(message) }) {
  let worker = null, stopped = false, fallbackReported = false;
  const reportFailure = () => {
    try { store.event('learning-error', { message: 'Historical learning worker failed; retry will use the committed journal.' }); }
    catch {
      if (fallbackReported) return;
      fallbackReported = true;
      try { stderr('[st-mq] Historical learning failed; diagnostic storage is unavailable.\n'); } catch { /* Diagnostics must never crash control. */ }
    }
  };
  const run = () => {
    if (worker || stopped) return;
    // Only model settings cross this boundary; provider credentials are irrelevant.
    const modelConfig = learningConfiguration(config);
    worker = new WorkerClass(new URL('./learning-worker.js', import.meta.url), { workerData: { dbPath: store.path, config: modelConfig } });
    worker.on('message', result => { if (result?.error) reportFailure(); });
    worker.on('error', reportFailure);
    worker.on('exit', () => { worker = null; });
  };
  run();
  const timer = setInterval(run, 15 * 60_000);
  return { async close() { stopped = true; clearInterval(timer); if (worker) { const current = worker; current.postMessage('stop'); await new Promise(resolve => current.once('exit', resolve)); } } };
}
