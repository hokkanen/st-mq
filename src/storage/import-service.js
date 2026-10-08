import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';

/** The offline CLI uses the existing importer on a storage worker. Its source
 * validation, staging, atomic publication and interruption recovery stay shared.
 * Join the worker before returning on abort or progress-callback failure. */
export function importCsvInWorker({ databasePath, file, kind, onProgress = () => {}, signal }) {
  return new Promise((resolveResult, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const worker = new Worker(new URL('./import-worker.js', import.meta.url), {
      workerData: { databasePath: resolve(databasePath), file: resolve(file), kind },
      ...(process.execArgv.some(value => value.startsWith('--input-type')) ? { execArgv: [] } : {}),
    });
    let result, failure;
    const abort = () => { failure ??= signal.reason; void worker.terminate(); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', message => {
      if (failure) return;
      if (message.type === 'progress') {
        try { onProgress(message.value); }
        catch (error) { failure = error; void worker.terminate(); }
      } else if (message.type === 'error') failure = Object.assign(new Error(message.message),
        message.code ? { code: message.code } : {});
      else if (message.type === 'complete') result = message.result;
    });
    worker.once('error', error => { failure ??= error; });
    worker.once('exit', code => {
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code === 0 && result) resolveResult(result);
      else reject(Object.assign(new Error('CSV import was interrupted; retry from the unchanged source file.'), { code: 'csv_import_interrupted' }));
    });
  });
}
