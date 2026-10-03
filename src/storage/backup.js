import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { backup as sqliteBackup } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

const companions = ['', '-wal', '-shm', '-journal'];
const occupied = async path => {
  for (const suffix of companions) {
    try { await lstat(`${path}${suffix}`); return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return false;
};

function finishSnapshot(path, sourcePath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./backup-worker.js', import.meta.url), { workerData: { path, sourcePath },
      ...(process.execArgv.some(value => value.startsWith('--input-type')) ? { execArgv: [] } : {}) });
    let result;
    worker.on('message', value => { result = value; });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code === 0 && result?.ok) resolve();
      else reject(Object.assign(new Error('Database backup could not be verified.'), { code: result?.code ?? 'backup_failed' }));
    });
  });
}

/** One portable backup format for downloads, CLI backups and reset archives.
 * A caller supplying sourcePath must hold a stable private source for this call.
 * Only the private completed copy is opened writable or changes journal mode. */
export async function createDatabaseBackup({ database, sourcePath, destination }) {
  if (Boolean(database) === Boolean(sourcePath)) throw new TypeError('Specify one database backup source');
  const path = resolve(destination);
  const refuseOccupied = async () => {
    if (sourcePath && path === resolve(sourcePath) || await occupied(path))
      throw new Error('Backup destination must be a new file without SQLite companions');
  };
  await refuseOccupied();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(dirname(path), '.sqlite-backup-'));
  try {
    await chmod(directory, 0o700);
    const staging = join(directory, 'history.sqlite');
    const file = await open(staging, 'wx', 0o600);
    await file.close();
    if (database) await sqliteBackup(database, staging, { rate: 256 });
    await finishSnapshot(staging, sourcePath && resolve(sourcePath));
    const completed = await open(staging, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await completed.sync(); } finally { await completed.close(); }
    await refuseOccupied();
    // A final-name collision never replaces an earlier backup.
    await link(staging, path);
    const parent = await open(dirname(path), constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
  return path;
}
