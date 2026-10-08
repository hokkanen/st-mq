import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { exportDatabaseChanges, sameCheckpoint, validCheckpoint } from './incremental.js';
import { GENERATION_PATTERN, ownedDirectory, replicationError } from './publication.js';
import { acquireReceiverLock } from './receiver.js';

export const CHANGE_CHUNK_BYTES = 256 * 1024;
export const MAX_CHANGE_BYTES = 80 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** A source transaction is never split into separately visible commits. Large
 * transactions use bounded transport frames, staged before atomic application. */
export class ChangeTransfers {
  constructor(directory) { this.directory = directory; this.active = new Set(); }

  async export({ dbPath, after, through, signal }) {
    if (!validCheckpoint(after) || !validCheckpoint(through)) throw replicationError('invalid_protocol');
    const batch = await exportDatabaseChanges({ dbPath, after, through, signal });
    const bytes = Buffer.from(JSON.stringify(batch));
    if (bytes.length > MAX_CHANGE_BYTES) throw replicationError('journal_transaction_too_large');
    await ownedDirectory(this.directory, '.st-mq-journal-transfer');
    const id = randomUUID(), path = join(this.directory, `changes-${id}.json`);
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    this.active.add(id);
    // Transfer data is reproducible from committed journal rows. Losing an old
    // incomplete transfer is a retry, never permission to skip a transaction.
    const retained = new Set([...this.active].slice(-2));
    for (const name of await readdir(this.directory)) {
      const match = /^changes-([a-f0-9-]+)\.json$/.exec(name);
      if (match && GENERATION_PATTERN.test(match[1]) && !retained.has(match[1])) {
        await rm(join(this.directory, name), { force: true }); this.active.delete(match[1]);
      }
    }
    return { version: 1, id, bytes: bytes.length, digest: digest(bytes), from: batch.from, to: batch.to, hasMore: batch.hasMore };
  }

  async chunk({ id, offset }) {
    if (!GENERATION_PATTERN.test(id ?? '') || !Number.isSafeInteger(offset) || offset < 0
      || offset % CHANGE_CHUNK_BYTES) throw replicationError('invalid_protocol');
    const file = await open(join(this.directory, `changes-${id}.json`), 'r').catch(() => { throw replicationError('snapshot_unavailable'); });
    try {
      const info = await file.stat();
      if (offset >= info.size || info.size > MAX_CHANGE_BYTES) throw replicationError('invalid_protocol');
      const buffer = Buffer.alloc(Math.min(CHANGE_CHUNK_BYTES, info.size - offset));
      const result = await file.read(buffer, 0, buffer.length, offset);
      if (result.bytesRead !== buffer.length) throw replicationError('transfer_failed');
      return { data: buffer.toString('base64') };
    } finally { await file.close(); }
  }
}

export async function receiveChanges({ directory, peer, after, through, signal, guard = async () => {} }) {
  await guard();
  const descriptor = await peer.request('changes', { after, through }, { signal });
  if (descriptor?.version !== 1 || !GENERATION_PATTERN.test(descriptor.id ?? '')
    || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 || descriptor.bytes > MAX_CHANGE_BYTES
    || !/^[a-f0-9]{64}$/.test(descriptor.digest ?? '') || !sameCheckpoint(descriptor.from, after)
    || !validCheckpoint(descriptor.to) || descriptor.to.databaseId !== through.databaseId
    || descriptor.to.sequence > through.sequence || descriptor.to.sequence < after.sequence
    || (!sameCheckpoint(after, through) && descriptor.to.sequence === after.sequence)
    || typeof descriptor.hasMore !== 'boolean'
    || descriptor.hasMore === sameCheckpoint(descriptor.to, through)) throw replicationError('invalid_protocol');
  await ownedDirectory(directory, '.st-mq-journal-receive');
  const unlock = await acquireReceiverLock(directory);
  try {
  for (const name of await readdir(directory)) {
    if (/^incoming-changes-[a-f0-9-]{36}\.json$/.test(name)) await rm(join(directory, name), { force: true });
  }
  // A peer transfer identifier never selects a writable local filesystem path.
  const path = join(directory, `incoming-changes-${randomUUID()}.json`);
  const file = await open(path, 'wx', 0o600);
  try {
    const hash = createHash('sha256');
    for (let offset = 0; offset < descriptor.bytes; offset += CHANGE_CHUNK_BYTES) {
      if (signal?.aborted) throw signal.reason;
      await guard();
      const value = await peer.request('changes-chunk', { id: descriptor.id, offset }, { signal });
      if (typeof value?.data !== 'string' || value.data.length > Math.ceil(CHANGE_CHUNK_BYTES / 3) * 4)
        throw replicationError('invalid_protocol');
      const bytes = Buffer.from(value.data, 'base64');
      if (bytes.length !== Math.min(CHANGE_CHUNK_BYTES, descriptor.bytes - offset)) throw replicationError('verification_failed');
      hash.update(bytes); await file.writeFile(bytes);
    }
    if (hash.digest('hex') !== descriptor.digest) throw replicationError('verification_failed');
    await file.sync();
  } catch (error) { await file.close(); await rm(path, { force: true }); throw error; }
  await file.close();
  try {
    const batch = JSON.parse(await readFile(path, 'utf8'));
    if (!sameCheckpoint(batch.from, descriptor.from) || !sameCheckpoint(batch.to, descriptor.to)
      || batch.hasMore !== descriptor.hasMore) throw replicationError('verification_failed');
    return batch;
  } finally { await rm(path, { force: true }); }
  } finally { await unlock(); }
}
