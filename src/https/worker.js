import { Worker } from 'node:worker_threads';
import { httpsError } from './storage.js';

export function runtimeTask(task, data = {}, { onProgress, signal, timeout = task === 'install' ? 180000 : 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./runtime-worker.js', import.meta.url), { workerData: { task, ...data }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } });
    let settled = false;
    const done = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      // A caller cannot remove/replace staging files until the bounded worker
      // has stopped all network/extraction work and actually exited.
      worker.terminate().catch(() => {}).finally(() => { error ? reject(error) : resolve(result); });
    };
    const timer = setTimeout(() => done(httpsError('helper_worker_timeout')), timeout); timer.unref();
    const aborted = () => done(httpsError('https_manager_closed'));
    if (signal?.aborted) aborted(); else signal?.addEventListener('abort', aborted, { once: true });
    worker.on('message', message => {
      if (message.progress) onProgress?.(message.progress);
      if ('result' in message) done(null, message.result);
      if (message.error) done(httpsError(message.error));
    });
    worker.once('error', () => done(httpsError('helper_worker_failed')));
    worker.once('exit', () => { if (!settled) done(httpsError('helper_worker_failed')); });
  });
}
