import { createInterface } from 'node:readline';
import { open, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copySnapshot, GENERATION_PATTERN, normalizeSnapshot, ownedDirectory, privateFile,
  pruneReplicaSnapshots, publishSnapshot, readReplicaPublication, replicationError, snapshotDigest } from './publication.js';

const MARKER = '.st-mq-replica';
const LOCK = '.receiver-lock.sqlite';

async function initializeDirectory(directory) {
  await ownedDirectory(directory, MARKER);
}

async function acquireLock(directory) {
  const path = join(directory, LOCK);
  try { const file = await open(path, 'wx', 0o600); await file.close(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await privateFile(path);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS receiver_lock (id INTEGER); BEGIN EXCLUSIVE');
  } catch {
    db.close();
    throw replicationError('receiver_busy');
  }
  // SQLite's OS lock is released even after SIGKILL or a machine crash. No PID
  // lease can expire under a still-active large transfer or require manual repair.
  return async () => { try { db.exec('ROLLBACK'); } finally { db.close(); } };
}

function parseMessage(line) {
  if (line.length > 8192) throw replicationError('invalid_protocol');
  try { return JSON.parse(line); } catch { throw replicationError('invalid_protocol'); }
}

/** Private SSH stdin/stdout protocol; never writes household data to diagnostics. */
export async function runReceiver({ directory, input = process.stdin, output = process.stdout }) {
  process.umask(0o077);
  directory = resolve(directory);
  const lines = createInterface({ input, crlfDelay: Infinity });
  // Attach the iterator before filesystem awaits so an immediate SSH prepare
  // message cannot be lost while the private directory is being initialized.
  const messages = lines[Symbol.asyncIterator]();
  let unlock, incoming, generation, reset = false;
  const send = value => output.write(`${JSON.stringify(value)}\n`);
  try {
    await initializeDirectory(directory);
    for await (const line of messages) {
      const message = parseMessage(line);
      if (!generation) {
        if (message.type !== 'prepare' || message.version !== 1 || !GENERATION_PATTERN.test(message.generation)) {
          throw replicationError('invalid_protocol');
        }
        unlock = await acquireLock(directory);
        generation = message.generation;
        // Remove leftovers only after ownership is established. Active orphan
        // writers may retain an unlinked inode but cannot publish it.
        for (const name of await readdir(directory)) {
          if (/^incoming-[a-f0-9-]+\.sqlite(?:-wal|-shm|-journal)?$/.test(name)) await rm(join(directory, name));
        }
        incoming = join(directory, `incoming-${generation}.sqlite`);
        let previous;
        try { previous = await readReplicaPublication(directory); }
        catch (error) { if (error.code !== 'invalid_publication') throw error; }
        // A crash between snapshot rename and manifest replacement may leave a
        // full orphan copy. Free it BEFORE allocating the next incoming copy so
        // a disk sized for current+previous+incoming can recover automatically.
        await pruneReplicaSnapshots(directory, previous);
        await rm(join(directory, 'publication.json.tmp'), { force: true });
        let useBase = false;
        if (previous) {
          try {
            const digest = await snapshotDigest(previous.dbPath);
            useBase = digest.digest === previous.digest && digest.bytes === previous.bytes;
          } catch { /* A damaged/missing standby copy is rebuilt from the primary. */ }
        }
        if (useBase) await copySnapshot(previous.dbPath, incoming);
        else { const file = await open(incoming, 'wx', 0o600); await file.close(); }
        send({ type: 'ready', version: 1 });
        continue;
      }
      if (message.type === 'reset' && !reset && GENERATION_PATTERN.test(message.generation) && message.generation !== generation) {
        // A page-size change or damaged delta base can make rsync reject its
        // destination. Retry once from empty, using a NEW filename so an old
        // remote rsync process cannot touch the retry or its SQLite sidecars.
        for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(`${incoming}${suffix}`, { force: true });
        generation = message.generation;
        incoming = join(directory, `incoming-${generation}.sqlite`);
        const file = await open(incoming, 'wx', 0o600); await file.close();
        reset = true;
        send({ type: 'reset', generation });
        continue;
      }
      if (message.type !== 'publish' || message.generation !== generation || !/^[a-f0-9]{64}$/.test(message.digest) ||
          !Number.isSafeInteger(message.bytes) || message.bytes < 512 ||
          ![message.sourceStartedAt, message.sourceAt].every(at => Number.isSafeInteger(at) && at > 0) ||
          message.sourceStartedAt > message.sourceAt) throw replicationError('invalid_protocol');
      await privateFile(incoming);
      normalizeSnapshot(incoming);
      const actual = await snapshotDigest(incoming);
      if (actual.digest !== message.digest || actual.bytes !== message.bytes) throw replicationError('verification_failed');
      const publication = await publishSnapshot(directory, incoming, { generation, ...actual,
        sourceStartedAt: message.sourceStartedAt, sourceAt: message.sourceAt, verifiedAt: Date.now() });
      incoming = null;
      send({ type: 'published', generation, digest: publication.digest, bytes: publication.bytes, verifiedAt: publication.verifiedAt });
      return publication;
    }
    throw replicationError('transfer_interrupted');
  } finally {
    lines.close();
    if (incoming) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(`${incoming}${suffix}`, { force: true }).catch(() => {});
    }
    if (unlock) await unlock().catch(() => {});
  }
}
