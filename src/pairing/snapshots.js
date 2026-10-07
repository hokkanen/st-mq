import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Worker } from 'node:worker_threads';
import { createSourceSnapshot } from '../replication/transport.js';
import { acquireReceiverLock } from '../replication/receiver.js';
import { copySnapshot, DIGEST_ALGORITHM, durableJson, ownedDirectory, privateFile,
  publishSnapshot, readReplicaPublication, snapshotFileState, syncDirectory } from '../replication/publication.js';
import { NODE_PATTERN, pairError, validClaim } from './state.js';
import { databaseErrorDetails } from '../storage/database-errors.js';

export const CHUNK_BYTES = 1024 * 1024;
const MAX_DATABASE_BYTES = 64 * 1024 ** 3;
const hash = data => createHash('sha256').update(data).digest('hex');

export function validateSnapshot(value) {
  if (!value || !NODE_PATTERN.test(value.generation) || !/^[a-f0-9]{64}$/.test(value.digest) ||
      value.digestAlgorithm !== DIGEST_ALGORITHM || value.chunkBytes !== CHUNK_BYTES ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 512 || value.bytes > MAX_DATABASE_BYTES ||
      !Number.isSafeInteger(value.sourceStartedAt) || !Number.isSafeInteger(value.sourceAt) ||
      value.sourceStartedAt <= 0 || value.sourceAt < value.sourceStartedAt ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !validClaim(value.claim)) throw pairError('peer_protocol_failed');
  return value;
}

async function chunkHashes(path) {
  const result = [];
  for await (const chunk of createReadStream(path, { highWaterMark: CHUNK_BYTES })) result.push(hash(chunk));
  return result;
}

export async function verifySnapshot(path, metadata, signal) {
  if (signal?.aborted) throw pairError('stopped');
  // Default inheritance filters process-only flags; --input-type belongs to an
  // inline launcher and must not be forwarded to this file-based worker.
  const worker = new Worker(new URL('./verify-worker.js', import.meta.url), { workerData: { path, metadata },
    ...(process.execArgv.some(value => value.startsWith('--input-type')) ? { execArgv: [] } : {}) });
  await new Promise((accept, reject) => {
    let done = false;
    const finish = error => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : accept();
    };
    const abort = () => { void worker.terminate().then(() => finish(pairError('stopped'))); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', result => {
      const details = databaseErrorDetails(result);
      finish(result.ok ? null : Object.assign(pairError(details?.code ?? 'verification_failed'), details));
    });
    worker.once('error', () => finish(pairError('verification_failed')));
    worker.once('exit', () => { if (!done) finish(pairError('verification_failed')); });
  });
}

/** Verify once off-thread; cheaply fence local changes throughout a transfer. */
export async function createReplicaPublicationGuard({ directory, accepted, signal }) {
  try {
    const manifestState = async () => {
      let manifest;
      try { manifest = await lstat(join(directory, 'publication.json'), { bigint: true }); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (!manifest.isFile() || manifest.isSymbolicLink()) throw pairError('verification_failed');
      return [manifest.dev, manifest.ino, manifest.size, manifest.mtimeNs, manifest.ctimeNs].map(String);
    };
    const originalManifest = await manifestState();
    const publication = await readReplicaPublication(directory);
    if (!publication) {
      if (accepted || originalManifest) throw pairError('verification_failed');
      return async () => {
        try {
          if (await manifestState()) throw pairError('verification_failed');
        } catch { throw pairError('verification_failed'); }
      };
    }
    validateSnapshot(publication);
    if (!accepted || publication.generation !== accepted.generation || publication.digest !== accepted.digest ||
        publication.claim.epoch !== accepted.epoch || publication.claim.nodeId !== accepted.nodeId ||
        publication.sequence !== accepted.sequence) throw pairError('verification_failed');
    const before = [originalManifest, await snapshotFileState(publication.dbPath)];
    const assertUnchanged = async () => {
      try {
        const current = [await manifestState(), await snapshotFileState(publication.dbPath)];
        if (!isDeepStrictEqual(before, current)) throw pairError('verification_failed');
      } catch { throw pairError('verification_failed'); }
    };
    await verifySnapshot(publication.dbPath, publication, signal);
    await assertUnchanged();
    return assertUnchanged;
  } catch (error) {
    if (signal?.aborted || error?.code === 'stopped') throw pairError('stopped');
    const details = databaseErrorDetails(error);
    throw Object.assign(pairError(details?.code ?? 'verification_failed'), details);
  }
}

/** Immutable export generations are separate from every writable or protected DB. */
export class SnapshotRepository {
  constructor({ directory, clock = Date.now, snapshot = createSourceSnapshot }) {
    this.directory = directory;
    this.clock = clock;
    this.snapshot = snapshot;
    this.active = null;
    this.cache = new Map();
    this.mutations = Promise.resolve();
  }

  async init() {
    await ownedDirectory(this.directory, '.st-mq-pair-exports');
    const names = new Set(await readdir(this.directory));
    for (const name of names) {
      const match = /^export-([a-f0-9-]+)\.sqlite(?:-wal|-shm|-journal)?$/.exec(name);
      // Pins can retain the only copy of protected history after rejoin. Lost
      // metadata makes that copy unavailable, never permission to delete it.
      if (match && NODE_PATTERN.test(match[1]) && !names.has(`export-${match[1]}.json`)
        && !names.has(`export-${match[1]}.pin`)) await rm(join(this.directory, name), { force: true });
      if (/^export-[a-f0-9-]+\.json\.tmp$/.test(name)) await rm(join(this.directory, name), { force: true });
    }
    await this.prune(null);
  }

  serializeMutation(action) {
    const pending = this.mutations.then(action);
    this.mutations = pending.catch(() => {});
    return pending;
  }

  async create({ dbPath, claim, sequence, signal, force = false, pin = false, assertSource = () => {} }) {
    if (this.active) throw pairError('peer_busy');
    // Reserve admission before even source validation can yield. Retention
    // changes share this queue so a successful pin always retains its export.
    this.active = true;
    try { return await this.serializeMutation(async () => {
      await assertSource();
      if (!force && this.current && this.current.claim.epoch === claim.epoch && this.current.claim.role === claim.role &&
          this.clock() - this.current.sourceAt < 30000) {
        if (pin) await this.pinExport(this.current.generation);
        await assertSource();
        return this.current;
      }
      const generation = randomUUID(), path = join(this.directory, `export-${generation}.sqlite`);
      try {
        const result = await this.snapshot({ dbPath, destination: path, signal });
        await assertSource();
        const hashes = await chunkHashes(path);
        await assertSource();
        const metadata = validateSnapshot({ generation, ...result, claim, sequence, chunkBytes: CHUNK_BYTES });
        delete metadata.ok;
        await durableJson(join(this.directory, `export-${generation}.json`), { ...metadata, hashes });
        this.cache.set(generation, { ...metadata, hashes });
        // Rejoin needs this exact generation after a lost acknowledgement or
        // restart. Pin before returning it, with no create-to-pin pruning gap.
        if (pin) await this.pinExport(generation);
        await this.pruneExports(generation);
        await assertSource();
        this.current = metadata;
        return metadata;
      } catch (error) {
        this.cache.delete(generation);
        for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(`${path}${suffix}`, { force: true });
        for (const suffix of ['json', 'pin']) await rm(join(this.directory, `export-${generation}.${suffix}`), { force: true });
        throw error;
      }
    }); } finally { this.active = null; }
  }

  async load(generation) {
    if (!NODE_PATTERN.test(generation ?? '')) throw pairError('snapshot_unavailable');
    if (this.cache.has(generation)) return this.cache.get(generation);
    try {
      const metadata = JSON.parse(await readFile(join(this.directory, `export-${generation}.json`), 'utf8'));
      validateSnapshot(metadata);
      if (!Array.isArray(metadata.hashes) || metadata.hashes.length !== Math.ceil(metadata.bytes / CHUNK_BYTES)) throw Error();
      if (this.cache.size >= 2) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(generation, metadata);
      return metadata;
    } catch { throw pairError('snapshot_unavailable'); }
  }

  async hashes({ generation, offset }) {
    const metadata = await this.load(generation);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= metadata.hashes.length) throw pairError('peer_protocol_failed');
    return { hashes: metadata.hashes.slice(offset, offset + 128) };
  }

  async chunk({ generation, index }) {
    const metadata = await this.load(generation);
    if (!Number.isSafeInteger(index) || index < 0 || index >= metadata.hashes.length) throw pairError('peer_protocol_failed');
    const path = join(this.directory, `export-${generation}.sqlite`);
    await privateFile(path);
    const file = await open(path, 'r');
    try {
      const bytes = Math.min(CHUNK_BYTES, metadata.bytes - index * CHUNK_BYTES);
      const buffer = Buffer.alloc(bytes);
      const result = await file.read(buffer, 0, bytes, index * CHUNK_BYTES);
      if (result.bytesRead !== bytes || hash(buffer) !== metadata.hashes[index]) throw pairError('verification_failed');
      return { data: buffer.toString('base64') };
    } finally { await file.close(); }
  }

  pin(generation) {
    return this.serializeMutation(() => this.pinExport(generation));
  }

  async pinExport(generation) {
    await this.load(generation);
    await privateFile(join(this.directory, `export-${generation}.sqlite`));
    const file = await open(join(this.directory,`export-${generation}.pin`),'a',0o600);
    try { await file.sync(); } finally { await file.close(); }
    await syncDirectory(this.directory);
  }

  unpin(generation) {
    return this.serializeMutation(() => this.unpinExport(generation));
  }

  async unpinExport(generation) {
    if (!NODE_PATTERN.test(generation)) throw pairError('invalid_transition');
    await rm(join(this.directory,`export-${generation}.pin`),{force:true});
    await syncDirectory(this.directory);
  }

  prune(current) {
    return this.serializeMutation(() => this.pruneExports(current));
  }

  async pruneExports(current) {
    const entries = [], names = await readdir(this.directory);
    for (const name of names) {
      const match = /^export-([a-f0-9-]+)\.json$/.exec(name);
      if (!match || !NODE_PATTERN.test(match[1])) continue;
      try { entries.push(await this.load(match[1])); } catch { /* Do not guess at unclassified files. */ }
    }
    entries.sort((a, b) => b.sourceAt - a.sourceAt);
    for (const metadata of entries.slice(2)) {
      if (metadata.generation === current || names.includes(`export-${metadata.generation}.pin`)) continue;
      this.cache.delete(metadata.generation);
      if (this.current?.generation === metadata.generation) this.current = null;
      for (const suffix of ['sqlite', 'json']) await rm(join(this.directory, `export-${metadata.generation}.${suffix}`), { force: true });
    }
  }
}

/** Compare bounded chunks against a previous copy and retain interrupted progress. */
export async function receiveSnapshot({ directory, metadata, peer, signal, guard = async () => {},
  publish = true, onProgress = () => {}, commit = action => action() }) {
  validateSnapshot(metadata);
  await guard();
  await ownedDirectory(directory, publish ? '.st-mq-replica' : '.st-mq-recovery-download');
  const unlock = await acquireReceiverLock(directory);
  try {
  if (publish) {
    const marker = await open(join(directory, '.st-mq-paired-receiver'), 'a', 0o600);
    await marker.close();
    await syncDirectory(directory);
  }
  await guard();
  // Only uncommitted downloads are cleaned here; protected writable DBs never
  // live in this directory. Gate precedes even this bounded cleanup.
  for (const name of await readdir(directory)) {
    const match = /^incoming-([a-f0-9-]+)\.sqlite$/.exec(name);
    if (match && NODE_PATTERN.test(match[1]) && match[1] !== metadata.generation) await rm(join(directory, name));
  }
  const incoming = join(directory, `incoming-${metadata.generation}.sqlite`);
  try { await privateFile(incoming); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const previous = publish ? await readReplicaPublication(directory).catch(() => null) : null;
    if (previous) {
      try { await copySnapshot(previous.dbPath, incoming); }
      catch { await rm(incoming, { force: true }); }
    }
    try { const file = await open(incoming, 'wx', 0o600); await file.close(); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const file = await open(incoming, 'r+');
  let transferredBytes = 0;
  try {
    await file.truncate(metadata.bytes);
    const count = Math.ceil(metadata.bytes / CHUNK_BYTES);
    for (let offset = 0; offset < count; offset += 128) {
      await guard();
      if (signal?.aborted) throw pairError('stopped');
      const { hashes } = await peer.request('snapshot-hashes', { generation: metadata.generation, offset }, { signal });
      if (!Array.isArray(hashes) || hashes.length !== Math.min(128, count - offset) ||
          hashes.some(value => !/^[a-f0-9]{64}$/.test(value))) throw pairError('peer_protocol_failed');
      for (let n = 0; n < hashes.length; n++) {
        await guard();
        if (signal?.aborted) throw pairError('stopped');
        const index = offset + n, bytes = Math.min(CHUNK_BYTES, metadata.bytes - index * CHUNK_BYTES);
        let buffer = Buffer.alloc(bytes);
        await file.read(buffer, 0, bytes, index * CHUNK_BYTES);
        if (hash(buffer) !== hashes[n]) {
          const chunk = await peer.request('snapshot-chunk', { generation: metadata.generation, index }, { signal });
          if (typeof chunk.data !== 'string' || chunk.data.length > Math.ceil(CHUNK_BYTES / 3) * 4) throw pairError('peer_protocol_failed');
          buffer = Buffer.from(chunk.data, 'base64');
          if (buffer.length !== bytes || hash(buffer) !== hashes[n]) throw pairError('verification_failed');
          await guard();
          await file.write(buffer, 0, bytes, index * CHUNK_BYTES);
          transferredBytes += bytes;
        }
        onProgress({ completedBytes: Math.min(metadata.bytes, (index + 1) * CHUNK_BYTES), transferredBytes, bytes: metadata.bytes });
      }
    }
    await file.sync();
  } finally { await file.close(); }
  await verifySnapshot(incoming, metadata, signal);
  await guard();
  if (!publish) return { ...metadata, dbPath: incoming, transferredBytes, verifiedAt: Date.now() };
  const result = await commit(async () => {
    await guard();
    return publishSnapshot(directory, incoming, { ...metadata, verifiedAt: Date.now() });
  });
  return { ...result, transferredBytes };
  } finally { await unlock(); }
}
