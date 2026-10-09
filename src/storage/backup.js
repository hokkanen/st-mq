import { chmod, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { backup as sqliteBackup } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { assertNewDatabaseDestination, publishDatabaseFile } from './publication.js';
import { verifyDatabase } from './full-verifier.js';
import { databaseErrorDetails } from './database-errors.js';
import { readCheckpoint } from './journal.js';

function finishSnapshot(path, sourcePath, { exportedAt, onProgress, signal, checkpoint }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const worker = new Worker(new URL('./backup-worker.js', import.meta.url), { workerData: { path, sourcePath, exportedAt, checkpoint },
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
      else if (code === 0 && result?.ok) resolve(result.checkpoint);
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
    // The in-memory source has no independent file-backed reader. Capture its
    // starting checkpoint and reject a copy that advances during native backup;
    // never silently claim a different transaction boundary.
    const initialCheckpoint = database && readCheckpoint(database);
    if (database) await sqliteBackup(database, staging, { rate: 256,
      progress: ({ remainingPages, totalPages }) => {
        signal?.throwIfAborted();
        onProgress({ phase: 'snapshotting', processed: totalPages - remainingPages, total: totalPages, unit: 'pages' });
      } });
    signal?.throwIfAborted();
    const checkpoint = await finishSnapshot(staging, sourcePath && resolve(sourcePath),
      { exportedAt, onProgress, signal, checkpoint: initialCheckpoint || undefined });
    signal?.throwIfAborted();
    // Verify the private, closed artifact through the same bounded admission as
    // manual/recovery checks. Waiting owns no live-source reader or WAL pin.
    // The captured source checkpoint must survive copying and finalization.
    let progressFailure;
    try {
      await verifyDatabase({ dbPath: staging, checkpoint, signal, origin: 'backup', onProgress(value) {
        try { onProgress(value); }
        catch (error) { progressFailure = error; throw error; }
      } });
    } catch (error) {
      if (signal?.aborted || error === progressFailure) throw error;
      const details = databaseErrorDetails(error);
      const code = details && !['database_integrity_failed', 'database_journal_invalid'].includes(details.code)
        ? 'backup_source_incompatible'
        : details || error?.code === 'full_verification_checkpoint_mismatch' ? 'backup_source_invalid' : 'backup_failed';
      throw Object.assign(new Error('Database backup could not be verified.'), { code, ...(details ? { details } : {}) });
    }
    signal?.throwIfAborted();
    await publishDatabaseFile(staging, path);
  } finally { await rm(directory, { recursive: true, force: true }); }
  return path;
}
