import { Worker } from 'node:worker_threads';
import { replicationError } from './publication.js';
export { matchingCheckpoint as sameCheckpoint, validCheckpoint } from '../storage/journal.js';

export const JOURNAL_DIGEST = 'sha256-transaction-journal-v1';

/** All database work uses the same storage contract in a worker. Batches are
 * bounded independently of retained history; one worker never loads the journal. */
export function journalOperation(operation, { dbPath, signal, ...args }) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? replicationError('stopped'));
  const worker = new Worker(new URL('./incremental-worker.js', import.meta.url), {
    workerData: { operation, dbPath, ...args },
    ...(process.execArgv.some(value => value.startsWith('--input-type')) ? { execArgv: [] } : {}),
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => { void worker.terminate().then(() => finish(signal.reason ?? replicationError('stopped'))); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', message => finish(message.ok ? null :
      Object.assign(replicationError(message.error?.code ?? 'verification_failed'), message.error), message.value));
    worker.once('error', () => finish(replicationError('verification_failed')));
    worker.once('exit', () => { if (!settled) finish(replicationError('verification_failed')); });
  });
}

export const databaseCheckpoint = options => journalOperation('checkpoint', options);
export const exportDatabaseChanges = options => journalOperation('export', options);
export const applyDatabaseChanges = options => journalOperation('apply', options);
