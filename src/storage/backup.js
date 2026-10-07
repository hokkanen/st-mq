import { chmod, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { backup as sqliteBackup } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { assertNewDatabaseDestination, publishDatabaseFile } from './publication.js';

function finishSnapshot(path, sourcePath, { exportedAt, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const worker = new Worker(new URL('./backup-worker.js', import.meta.url), { workerData: { path, sourcePath, exportedAt },
      ...(process.execArgv.some(value => value.startsWith('--input-type')) ? { execArgv: [] } : {}) });
    let result, error;
    const abort = () => { error = signal.reason; void worker.terminate(); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', value => {
      if (error) return;
      if (value.type === 'progress') {
        try { const { type, ...progress } = value; onProgress(progress); }
        catch (failure) { error = failure; void worker.terminate(); }
      } else result = value;
    });
    worker.once('error', failure => { error ??= failure; });
    worker.once('exit', code => {
      signal?.removeEventListener('abort', abort);
      // The source and private staging directory remain owned until the worker
      // has actually exited, including cancellation and progress callback errors.
      if (error) reject(error);
      else if (code === 0 && result?.ok) resolve();
      else reject(Object.assign(new Error('Database backup could not be verified.'),
        { code: result?.code ?? 'backup_failed', ...(result?.details ? { details: result.details } : {}) }));
    });
  });
}

/** One portable backup format for downloads, CLI backups and reset archives.
 * A caller supplying sourcePath must hold that file's lifetime for this call.
 * A worker pins a WAL read snapshot, allowing live recording to continue.
 * Only the private completed copy is opened writable or changes journal mode. */
export async function createDatabaseBackup({ database, sourcePath, destination, exportedAt = Date.now(),
  onProgress = () => {}, signal }) {
  if (Boolean(database) === Boolean(sourcePath)) throw new TypeError('Specify one database backup source');
  signal?.throwIfAborted();
  const path = resolve(destination);
  if (sourcePath && path === resolve(sourcePath))
    throw Object.assign(new Error('Backup destination must be a new file without SQLite companions'),
      { code: 'database_destination_occupied' });
  await assertNewDatabaseDestination(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(dirname(path), '.sqlite-backup-'));
  try {
    await chmod(directory, 0o700);
    const staging = join(directory, 'history.sqlite');
    const file = await open(staging, 'wx', 0o600);
    await file.close();
    if (database) await sqliteBackup(database, staging, { rate: 256,
      progress: ({ remainingPages, totalPages }) => {
        signal?.throwIfAborted();
        onProgress({ phase: 'snapshotting', processed: totalPages - remainingPages, total: totalPages, unit: 'pages' });
      } });
    signal?.throwIfAborted();
    await finishSnapshot(staging, sourcePath && resolve(sourcePath), { exportedAt, onProgress, signal });
    signal?.throwIfAborted();
    await publishDatabaseFile(staging, path);
  } finally { await rm(directory, { recursive: true, force: true }); }
  return path;
}
