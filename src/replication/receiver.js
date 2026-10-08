import { createInterface } from 'node:readline';
import { lstat, open, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { acceptPeerPublication, applyPeerPublication, recoverJournalPublication } from './journal-publication.js';
import { CHANGE_CHUNK_BYTES, validPeerTransfer } from './coalesced.js';
import { sameCheckpoint } from './incremental.js';
import { GENERATION_PATTERN, normalizeSnapshot, ownedDirectory, privateFile,
  pruneReplicaSnapshots, publishSnapshot, replicationError, snapshotDigest } from './publication.js';

const MARKER = '.st-mq-replica';
const LOCK = '.receiver-lock.sqlite';

async function assertUnpairedDirectory(directory) {
  // Paired lifecycle owns its recovery gate. A legacy SSH sender must never
  // bypass protection by replacing or pruning its publications independently.
  try {
    await lstat(join(directory, '.st-mq-paired-receiver'));
    throw replicationError('protected_history');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function initializeDirectory(directory) {
  await assertUnpairedDirectory(directory);
  await ownedDirectory(directory, MARKER);
}

export async function acquireReceiverLock(directory) {
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
  if (line.length > 1024 * 1024) throw replicationError('invalid_protocol');
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
  let unlock, incoming, generation, reset = false, publication, staged;
  const send = value => output.write(`${JSON.stringify(value)}\n`);
  try {
    await initializeDirectory(directory);
    for await (const line of messages) {
      const message = parseMessage(line);
      if (!generation) {
        if (message.type !== 'prepare' || message.version !== 2 || !GENERATION_PATTERN.test(message.generation)) {
          throw replicationError('invalid_protocol');
        }
        unlock = await acquireReceiverLock(directory);
        await assertUnpairedDirectory(directory);
        generation = message.generation;
        // Remove leftovers only after ownership is established. Active orphan
        // writers may retain an unlinked inode but cannot publish it.
        for (const name of await readdir(directory)) {
          if (/^incoming-[a-f0-9-]+\.(?:changes|sqlite(?:-wal|-shm|-journal)?)$/.test(name)) await rm(join(directory, name));
        }
        incoming = join(directory, `incoming-${generation}.sqlite`);
        publication = await recoverJournalPublication(directory);
        await pruneReplicaSnapshots(directory, publication);
        await rm(join(directory, 'publication.json.tmp'), { force: true });
        if (!publication || message.repair === true) { const file = await open(incoming, 'wx', 0o600); await file.close(); }
        else incoming = null;
        send({ type: 'ready', version: 2, publication });
        continue;
      }
      if(message.type==='peer-apply-begin') {
        if(!publication||staged||!validPeerTransfer(message.transfer)||!sameCheckpoint(message.transfer.base,publication.checkpoint))
          throw replicationError('invalid_protocol');
        const path=join(directory,`incoming-${randomUUID()}.changes`);
        staged={...message.transfer,mode:'peer',metadata:message.transfer,path,file:await open(path,'wx',0o600),offset:0,hash:createHash('sha256')};
        send({type:'apply-ready'});continue;
      }
      if (message.type === 'apply-chunk') {
        if (!staged || message.offset !== staged.offset || typeof message.data !== 'string'
          || message.data.length > Math.ceil(CHANGE_CHUNK_BYTES / 3) * 4) throw replicationError('invalid_protocol');
        const bytes = Buffer.from(message.data, 'base64');
        if (bytes.length !== Math.min(CHANGE_CHUNK_BYTES, staged.bytes - staged.offset)) throw replicationError('invalid_protocol');
        await staged.file.writeFile(bytes); staged.hash.update(bytes); staged.offset += bytes.length;
        send({ type: 'apply-chunk', offset: staged.offset });
        continue;
      }
      if (message.type === 'apply-commit') {
        if (!staged || staged.offset !== staged.bytes || staged.hash.digest('hex') !== staged.digest)
          throw replicationError('verification_failed');
        await staged.file.sync(); await staged.file.close(); staged.file = null;
        await assertUnpairedDirectory(directory);
        publication=await applyPeerPublication({directory,transfer:{metadata:staged.metadata,path:staged.path},
          metadata:message.metadata,guard:()=>assertUnpairedDirectory(directory)});
        await rm(staged.path); staged = null;
        send({ type: 'applied', checkpoint: publication.checkpoint });
        continue;
      }
      if (message.type === 'complete') {
        if (!publication || staged || !sameCheckpoint(publication.checkpoint, message.checkpoint))
          throw replicationError('verification_failed');
        send({ type: 'published', ...publication });
        return publication;
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
      if (!incoming || message.type !== 'publish' || message.generation !== generation || !/^[a-f0-9]{64}$/.test(message.digest) ||
          !Number.isSafeInteger(message.bytes) || message.bytes < 512 ||
          ![message.sourceStartedAt, message.sourceAt].every(at => Number.isSafeInteger(at) && at > 0) ||
          message.sourceStartedAt > message.sourceAt) throw replicationError('invalid_protocol');
      await privateFile(incoming);
      normalizeSnapshot(incoming);
      const actual = await snapshotDigest(incoming);
      if (actual.digest !== message.digest || actual.bytes !== message.bytes) throw replicationError('verification_failed');
      await assertUnpairedDirectory(directory);
      publication = await publishSnapshot(directory, incoming, { generation, ...actual,
        checkpoint: message.checkpoint, sourceStartedAt: message.sourceStartedAt, sourceAt: message.sourceAt, verifiedAt: Date.now() });
      incoming = null;
      publication=await acceptPeerPublication({directory,guard:()=>assertUnpairedDirectory(directory)});
      send({ type: 'published', ...publication,receivedDigest:actual.digest });
      return publication;
    }
    throw replicationError('transfer_interrupted');
  } finally {
    lines.close();
    if (staged) { await staged.file?.close().catch(() => {}); await rm(staged.path, { force: true }).catch(() => {}); }
    if (incoming) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(`${incoming}${suffix}`, { force: true }).catch(() => {});
    }
    if (unlock) await unlock().catch(() => {});
  }
}
