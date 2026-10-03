import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, link } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateCurrentDatabase } from '../storage/store.js';

export const PUBLICATION_FORMAT = 1;
export const DIGEST_ALGORITHM = 'sha256-sqlite-pages-v1';
export const GENERATION_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MANIFEST = 'publication.json';

export function replicationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** Adopt only an empty directory or one explicitly marked as ours. */
export async function ownedDirectory(directory, marker) {
  if (!isAbsolute(directory) || resolve(directory) === '/') throw replicationError('unsafe_directory');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw replicationError('unsafe_directory');
  const names = await readdir(directory);
  if (!names.includes(marker)) {
    if (names.length) throw replicationError('directory_not_empty');
    const file = await open(join(directory, marker), 'wx', 0o600);
    try { await file.sync(); } finally { await file.close(); }
    await syncDirectory(directory);
  } else {
    const file = await lstat(join(directory, marker));
    if (!file.isFile() || file.isSymbolicLink()) throw replicationError('unsafe_directory');
  }
  await chmod(directory, 0o700);
}

export async function privateFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw replicationError('unsafe_file');
  await chmod(path, 0o600);
}

export async function durableJson(path, value) {
  const temporary = `${path}.tmp`;
  await rm(temporary, { force: true });
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

export async function syncDirectory(directory) {
  const file = await open(directory, 'r');
  try { await file.sync(); } finally { await file.close(); }
}

/** Only accepts our local manifest; never trusts a filename supplied in JSON. */
export async function readReplicaPublication(directory) {
  let raw;
  try { raw = await readFile(join(directory, MANIFEST), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw replicationError('publication_unavailable'); }
  let value;
  try { value = JSON.parse(raw); } catch { throw replicationError('invalid_publication'); }
  if (value.format !== PUBLICATION_FORMAT || value.digestAlgorithm !== DIGEST_ALGORITHM ||
      !GENERATION_PATTERN.test(value.generation) || !/^[a-f0-9]{64}$/.test(value.digest) ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 512 ||
      ![value.sourceStartedAt, value.sourceAt, value.verifiedAt].every(at => Number.isSafeInteger(at) && at > 0) ||
      value.sourceStartedAt > value.sourceAt || (value.previousGeneration != null &&
        (!GENERATION_PATTERN.test(value.previousGeneration) || value.previousGeneration === value.generation))) {
    throw replicationError('invalid_publication');
  }
  return { ...value, dbPath: join(resolve(directory), `snapshot-${value.generation}.sqlite`) };
}

/** Copy a closed, standalone snapshot. Reflinks avoid full disk copies where supported. */
export async function copySnapshot(source, destination) {
  await copyFile(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  await privateFile(destination);
}

/** Published snapshots are standalone files, never writable SQLite/WAL stores. */
export async function snapshotFileState(path) {
  const files = [];
  for (const suffix of ['', '-wal', '-journal']) {
    let info;
    try { info = await lstat(`${path}${suffix}`, { bigint: true }); }
    catch (error) {
      if (suffix && error.code === 'ENOENT') { files.push(null); continue; }
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || (!suffix && info.size < 512n) ||
        (suffix && info.size > 0n)) throw replicationError('invalid_snapshot');
    files.push([info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String));
  }
  return files;
}

/** No callers may keep SQLite connections open while hashing this standalone file. */
export async function snapshotDigest(path) {
  const before = await snapshotFileState(path);
  const hash = createHash('sha256');
  let first = true;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    if (first) {
      first = false;
      if (chunk.length < 100 || chunk.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') {
        throw replicationError('invalid_snapshot');
      }
      // SQLite's change counter, version-valid-for and last-writer version may
      // differ after sqlite3_rsync/backup. All schema, table, index and free-page
      // bytes, and every other header field, remain part of the digest.
      chunk.fill(0, 24, 28);
      chunk.fill(0, 92, 100);
    }
    hash.update(chunk);
  }
  if (!isDeepStrictEqual(before, await snapshotFileState(path))) throw replicationError('verification_failed');
  return { digest: hash.digest('hex'), bytes: Number(before[0][2]), digestAlgorithm: DIGEST_ALGORITHM };
}

/** Close WAL state before publication. This is only for an unpublished snapshot. */
export function normalizeSnapshot(path) {
  const db = new DatabaseSync(path);
  try {
    validateCurrentDatabase(db);
    db.exec('PRAGMA busy_timeout=5000');
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint?.busy) throw replicationError('snapshot_busy');
    if (db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode !== 'delete') throw replicationError('snapshot_busy');
    const result = db.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || result[0].integrity_check !== 'ok') throw replicationError('integrity_failed');
  } finally { db.close(); }
}

/** Verification never changes the immutable generation or its manifest. */
export async function verifyReplicaPublication(directory) {
  const publication = await readReplicaPublication(directory);
  if (!publication) throw replicationError('publication_unavailable');
  const db = new DatabaseSync(publication.dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    validateCurrentDatabase(db);
    const result = db.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || result[0].integrity_check !== 'ok') throw replicationError('integrity_failed');
  } finally { db.close(); }
  const actual = await snapshotDigest(publication.dbPath);
  if (actual.digest !== publication.digest || actual.bytes !== publication.bytes) throw replicationError('verification_failed');
  return publication;
}

/** Caller holds the receiver lock. The manifest names the only retained copies. */
export async function pruneReplicaSnapshots(directory, publication) {
  const retained = new Set([publication?.generation, publication?.previousGeneration]);
  for (const name of await readdir(directory)) {
    const match = /^snapshot-([a-f0-9-]+)\.sqlite$/.exec(name);
    if (match && GENERATION_PATTERN.test(match[1]) && !retained.has(match[1])) await rm(join(directory, name));
  }
}

export async function publishSnapshot(directory, incoming, metadata) {
  const previous = await readReplicaPublication(directory);
  const target = join(directory, `snapshot-${metadata.generation}.sqlite`);
  if (!isAbsolute(directory) || !GENERATION_PATTERN.test(metadata.generation) ||
      incoming !== join(directory, `incoming-${metadata.generation}.sqlite`)) throw replicationError('invalid_publication');
  await privateFile(incoming);
  const candidate = new DatabaseSync(incoming, { readOnly: true });
  try { validateCurrentDatabase(candidate); } finally { candidate.close(); }
  const actual = await snapshotDigest(incoming);
  if (actual.digest !== metadata.digest || actual.bytes !== metadata.bytes) throw replicationError('verification_failed');
  if (previous?.generation === metadata.generation) {
    for (const key of Object.keys(metadata)) {
      if (key !== 'verifiedAt' && !isDeepStrictEqual(previous[key], metadata[key])) throw replicationError('verification_failed');
    }
    const existing = await snapshotDigest(target);
    if (existing.digest !== metadata.digest || existing.bytes !== metadata.bytes) throw replicationError('verification_failed');
    await rm(incoming);
    return previous;
  }
  const file = await open(incoming, 'r');
  try { await file.sync(); } finally { await file.close(); }
  // An immutable generation is never replaced, even after a publication crash.
  try { await link(incoming, target); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await snapshotDigest(target);
    if (existing.digest !== metadata.digest || existing.bytes !== metadata.bytes) throw replicationError('verification_failed');
  }
  await rm(incoming);
  await syncDirectory(directory);
  const publication = { format: PUBLICATION_FORMAT, ...metadata, digestAlgorithm: DIGEST_ALGORITHM,
    previousGeneration: previous?.generation ?? null };
  await durableJson(join(directory, MANIFEST), publication);
  // Linux keeps existing read-only SQLite connections valid after unlink. New
  // readers resolve the manifest again if a generation disappears before open.
  await pruneReplicaSnapshots(directory, publication);
  return { ...publication, dbPath: target };
}
