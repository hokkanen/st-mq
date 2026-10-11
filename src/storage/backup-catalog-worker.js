import { parentPort, workerData } from 'node:worker_threads';
import { closeSync, constants, lstatSync, openSync, readSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { readBackupMetadata } from './backup-metadata.js';

const fingerprint = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].map(String).join(':');
const result = workerData.map(({ path, fingerprint: expected }) => {
  let database;
  let file;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || fingerprint(before) !== expected) return { changed: true };
    file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const header = Buffer.alloc(100);
    if (readSync(file, header, 0, header.length, 0) !== 100 || header.toString('ascii', 0, 16) !== 'SQLite format 3\0'
      || header[18] !== 1 || header[19] !== 1) return null;
    closeSync(file); file = undefined;
    database = new DatabaseSync(path, { readOnly: true });
    database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=50');
    if (database.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') return null;
    const value = readBackupMetadata(database);
    if (fingerprint(lstatSync(path)) !== expected) return { changed: true };
    return value ? { exportedAt: value.exportedAt } : null;
  } catch { return null; }
  finally { database?.close(); if (file !== undefined) closeSync(file); }
});
parentPort.postMessage(result);
