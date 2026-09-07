import { existsSync, mkdirSync, linkSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../storage/store.js';

/** Upgrade the selected database to HA's public add-on folder; retain the old copy. */
export async function prepareStorage(config) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  if (config.dbPath === ':memory:') return null;
  const destination = resolve(config.dbPath);
  mkdirSync(dirname(destination), { recursive: true });
  const previous = join(config.dataDir, basename(destination));
  if (!config.addon || previous === destination || !existsSync(previous) || existsSync(destination)) return null;
  const staging = `${destination}.migration-${randomUUID()}`;
  try {
    // SQLite's backup API includes committed WAL pages; a raw file copy does not.
    await Store.restore(previous, staging);
    const snapshot = new DatabaseSync(staging, { readOnly: true });
    try {
      if (snapshot.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Migrated database failed integrity check');
    } finally { snapshot.close(); }
    // An interruption never leaves a half-written authoritative database. Linking
    // fails if another startup created the destination instead of overwriting it.
    linkSync(staging, destination);
    return { from: previous, to: destination, originalRetained: true };
  } finally { rmSync(staging, { force: true }); }
}
