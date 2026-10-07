import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';

/** A database filename and every SQLite companion must be unused. lstat also
 * catches dangling symlinks, which must never be adopted as a new destination. */
export async function assertNewDatabaseDestination(path) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { await fs.lstat(`${path}${suffix}`); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw Object.assign(new Error('Database destination must be a new file without SQLite companions'),
      { code: 'database_destination_occupied' });
  }
}

/** Publish a verified, closed, private standalone database on the same filesystem.
 * Callers own and clean staging. Never replace an existing destination. Flush the
 * completed contents before linking, and its parent before reporting success.
 * If the parent flush fails, the complete destination remains available but its
 * power-loss durability is unconfirmed; callers must not report a successful save. */
export async function publishDatabaseFile(staging, destination) {
  const completed = await fs.open(staging, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await completed.stat()).isFile()) throw new Error('Database publication requires a regular file');
    await completed.sync();
  } finally { await completed.close(); }
  await assertNewDatabaseDestination(destination);
  await fs.link(staging, destination);
  try {
    const parent = await fs.open(dirname(destination), constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (cause) {
    throw Object.assign(new Error('Database copy was published, but its durability could not be confirmed.'),
      { code: 'database_publication_unconfirmed', published: true, cause });
  }
  return destination;
}
