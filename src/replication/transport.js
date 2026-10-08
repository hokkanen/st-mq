import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, isAbsolute, resolve } from 'node:path';
import { rm, readdir, open } from 'node:fs/promises';
import { ownedDirectory, replicationError } from './publication.js';
import { sshOptions } from './ssh-options.js';
import { databaseErrorDetails } from '../storage/database-errors.js';
import { databaseCheckpoint, JOURNAL_DIGEST, sameCheckpoint } from './incremental.js';
import { checkpointMetadata } from './journal-publication.js';
import { CHANGE_CHUNK_BYTES, PeerTransfers, peerOperation } from './coalesced.js';

const wrapper = fileURLToPath(new URL('../../scripts/replica-ssh.js', import.meta.url));
const SAFE_PATH = /^[A-Za-z0-9_./-]+$/;
const PUBLIC_ERRORS = new Set(['configuration_invalid', 'tool_unavailable', 'connection_failed', 'transfer_failed',
  'snapshot_failed', 'verification_failed', 'integrity_failed', 'receiver_busy', 'receiver_failed', 'snapshot_busy',
  'directory_not_empty', 'unsafe_directory', 'invalid_publication', 'timed_out', 'stopped', 'protocol_failed',
  'database_schema_mismatch', 'database_schema_invalid', 'database_algorithm_mismatch',
  'database_state_incompatible', 'database_integrity_failed', 'database_journal_invalid',
  'lineage_mismatch', 'journal_history_expired', 'journal_checkpoint_mismatch', 'journal_hash_mismatch', 'journal_transaction_too_large', 'journal_peer_conflict', 'journal_peer_invalid', 'journal_peer_unregistered', 'journal_peer_pending']);

function publicationResult(publication,transferredBytes) {
  const {generation,digest,digestAlgorithm,checkpoint,bytes,sourceStartedAt,sourceAt,verifiedAt}=publication;
  return {generation,digest,digestAlgorithm,checkpoint,bytes,sourceStartedAt,sourceAt,verifiedAt,transferredBytes};
}

export function publicReplicationError(error) {
  const code = databaseErrorDetails(error)?.code ?? error?.code;
  return PUBLIC_ERRORS.has(code) ? code : 'transfer_failed';
}

export function validateTransportConfig(config) {
  if (!config || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(config.sshHost ?? '') ||
      !isAbsolute(config.remoteDirectory ?? '') || config.remoteDirectory === '/' ||
      !isAbsolute(config.receiverPath ?? '') ||
      ![config.remoteDirectory, config.receiverPath, config.nodePath ?? 'node', config.remoteRsyncPath ?? 'sqlite3_rsync']
        .every(value => SAFE_PATH.test(value) && !value.split('/').includes('..')) ||
      !Number.isSafeInteger(config.timeoutMs ?? 3600000) || (config.timeoutMs ?? 3600000) < 1) {
    throw replicationError('configuration_invalid');
  }
  if (config.sshConfigPath && (typeof config.sshConfigPath !== 'string' || !isAbsolute(config.sshConfigPath) ||
      /[\u0000-\u001f\u007f]/.test(config.sshConfigPath))) throw replicationError('configuration_invalid');
}

function killGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000);
  timer.unref();
}

function startProcess(command, args, { signal, code = 'transfer_failed', spawnProcess = spawn, env = process.env } = {}) {
  if (signal?.aborted) throw signal.reason;
  const child = spawnProcess(command, args, { stdio: ['pipe', 'pipe', 'ignore'], detached: true, env });
  const abort = () => killGroup(child);
  signal?.addEventListener('abort', abort, { once: true });
  const done = new Promise((accept, reject) => {
    child.once('error', () => reject(replicationError(code)));
    child.once('close', status => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(signal.reason);
      else if (status !== 0) reject(replicationError(code));
      else accept();
    });
  });
  // Attach immediately: a failed preflight may exit before its caller awaits it.
  void done.catch(() => {});
  child.stdin.on('error', () => {});
  return { child, done };
}

async function runProcess(command, args, options) {
  const process = startProcess(command, args, options);
  process.child.stdout.resume();
  process.child.stdin.end();
  await process.done;
}

function receiverChannel(config, generation, options) {
  // Remote command strings go through SSH's shell; validation deliberately
  // restricts these configured paths and aliases to non-shell characters.
  const command = `${config.nodePath ?? 'node'} ${config.receiverPath} ${config.remoteDirectory}`;
  const process = startProcess('ssh', [...sshOptions(config.sshConfigPath), config.sshHost, command], { ...options, code: 'connection_failed' });
  let buffer = '', waiting = [], queued = [], failure;
  const rejectAll = error => { failure = error; for (const waiter of waiting.splice(0)) waiter.reject(error); };
  process.child.stdout.setEncoding('utf8');
  process.child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 8192) { rejectAll(replicationError('protocol_failed')); killGroup(process.child); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { rejectAll(replicationError('protocol_failed')); continue; }
      if (message.type === 'error') {
        rejectAll(Object.assign(replicationError(publicReplicationError(message)), databaseErrorDetails(message)));
        continue;
      }
      if (waiting.length) waiting.shift().accept(message);
      else if (queued.length < 4) queued.push(message);
      else rejectAll(replicationError('protocol_failed'));
    }
  });
  process.done.then(() => rejectAll(replicationError('protocol_failed')), rejectAll);
  return {
    child: process.child,
    done: process.done,
    send(message) { process.child.stdin.write(`${JSON.stringify(message)}\n`); },
    next() {
      if (queued.length) return Promise.resolve(queued.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((accept, reject) => waiting.push({ accept, reject }));
    },
    close() { process.child.stdin.end(); killGroup(process.child); },
  };
}

export async function createSourceSnapshot({ dbPath, destination, signal }) {
  if (signal?.aborted) throw signal.reason;
  // Let Node inherit only worker-supported options. Explicitly replaying all
  // process flags also forwards V8/process-only defaults in Node 24 test runs.
  // An inline module launcher needs a clean file-worker argument list instead.
  const worker = new Worker(new URL('./snapshot-worker.js', import.meta.url), { workerData: { dbPath, destination },
    ...(process.execArgv.some(argument => argument.startsWith('--input-type')) ? { execArgv: [] } : {}) });
  return new Promise((accept, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else accept(value);
    };
    const abort = () => { void worker.terminate().then(() => finish(signal.reason)); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', value => {
      const details = databaseErrorDetails(value);
      finish(value.ok ? null : Object.assign(replicationError(details?.code ?? 'snapshot_failed'), details), value);
    });
    worker.once('error', () => finish(replicationError('snapshot_failed')));
    worker.once('exit', () => { if (!settled) finish(signal?.aborted ? signal.reason : replicationError('snapshot_failed')); });
  });
}

/** One attempt: peer preflight, bounded journal catch-up, and durable publication.
 * A receiver without a baseline first needs one complete seed. */
export async function synchronizeReplica({ dbPath, config, signal, onPhase = () => {}, onYield,
  spawnProcess = spawn, snapshot = createSourceSnapshot }) {
  validateTransportConfig(config);
  const sourceDirectory = resolve(config.sourceDirectory ?? join(resolve(dbPath), '..', 'replication'));
  if (sourceDirectory.includes(':')) throw replicationError('configuration_invalid');
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(replicationError('timed_out')), config.timeoutMs ?? 3600000);
  const forwardAbort = () => abort.abort(signal.reason ?? replicationError('stopped'));
  if (signal?.aborted) forwardAbort(); else signal?.addEventListener('abort', forwardAbort, { once: true });
  const env = { ...process.env };
  if (config.sshConfigPath) env.STMQ_MIRROR_SSH_CONFIG = config.sshConfigPath;
  else delete env.STMQ_MIRROR_SSH_CONFIG;
  const options = { signal: abort.signal, spawnProcess, env };
  let generation = randomUUID();
  let channel, destination;
  try {
    onPhase('connecting');
    channel = receiverChannel(config, generation, options);
    channel.send({ type: 'prepare', version: 2, generation });
    const ready = await channel.next();
    if (ready.type !== 'ready' || ready.version !== 2) throw replicationError('protocol_failed');
    await peerOperation('enroll',{dbPath,signal:abort.signal,onYield});
    const peerTransfers=new PeerTransfers(join(sourceDirectory,'peer-exports'));
    if (ready.publication) {
      const checkpoint=await databaseCheckpoint({dbPath,signal:abort.signal});
      if(ready.publication.checkpoint?.databaseId!==checkpoint.databaseId)throw replicationError('lineage_mismatch');
      let after=ready.publication.checkpoint,transferredBytes=0,metadata=await checkpointMetadata({dbPath,checkpoint});
      const currentMetadata=metadata;
      if(sameCheckpoint(after,checkpoint)) {
        await peerOperation('acknowledge',{dbPath,checkpoint:after,signal:abort.signal,onYield});
      } else do {
        onPhase('transferring');
        const transfer=await peerTransfers.export({dbPath,after,signal:abort.signal,onYield});
        metadata={...currentMetadata,...(transfer.target.sequence<checkpoint.sequence?{
          sourceAt:ready.publication.sourceAt,sourceStartedAt:ready.publication.sourceStartedAt}:{}),
          checkpoint:transfer.target,digest:transfer.target.hash};
        channel.send({type:'peer-apply-begin',transfer});
        if((await channel.next()).type!=='apply-ready')throw replicationError('protocol_failed');
        for(let offset=0;offset<transfer.bytes;offset+=CHANGE_CHUNK_BYTES) {
          const value=await peerTransfers.chunk({id:transfer.id,offset});
          channel.send({type:'apply-chunk',offset,data:value.data});
          const acknowledged=await channel.next(),end=Math.min(offset+CHANGE_CHUNK_BYTES,transfer.bytes);
          if(acknowledged.type!=='apply-chunk'||acknowledged.offset!==end)throw replicationError('protocol_failed');
        }
        channel.send({type:'apply-commit',metadata});
        const applied=await channel.next();
        if(applied.type!=='applied'||!sameCheckpoint(applied.checkpoint,transfer.target))throw replicationError('verification_failed');
        await peerOperation('acknowledge',{dbPath,checkpoint:transfer.target,signal:abort.signal,onYield});
        transferredBytes+=transfer.bytes;after=transfer.target;
      }while(after.sequence<checkpoint.sequence);
      channel.send({type:'complete',checkpoint:after});
      const published=await channel.next();
      if(published.type!=='published'||!sameCheckpoint(published.checkpoint,after)
        ||published.digestAlgorithm!==JOURNAL_DIGEST||published.digest!==after.hash)throw replicationError('verification_failed');
      channel.child.stdin.end();await channel.done;
      return publicationResult(published,transferredBytes);
    }
    // A full snapshot is an exceptional initial seed. Subsequent attempts use
    // only committed changes, with no dependence on sqlite3_rsync availability.
    await runProcess(config.rsyncPath ?? 'sqlite3_rsync', ['--version'], { ...options, code: 'tool_unavailable' });
    await ownedDirectory(sourceDirectory, '.st-mq-replication-work');
    // The receiver lock guarantees no other legitimate primary attempt is active.
    for (const name of await readdir(sourceDirectory)) {
      if (/^source-[a-f0-9-]+\.sqlite(?:-wal|-shm|-journal)?$/.test(name)) await rm(join(sourceDirectory, name), { force: true });
    }
    destination = join(sourceDirectory, `source-${generation}.sqlite`);
    onPhase('snapshotting');
    const result = await snapshot({ dbPath, destination, signal: abort.signal });
    const anchor=await peerOperation('anchor',{dbPath,signal:abort.signal});
    await peerTransfers.export({dbPath,after:anchor.checkpoint,sourcePath:destination,refresh:true,signal:abort.signal,onYield});
    onPhase('transferring');
    for (let attempt = 0; attempt < 2; attempt++) {
      const remote = `${config.sshHost}:${config.remoteDirectory}/incoming-${generation}.sqlite`;
      try {
        await runProcess(config.rsyncPath ?? 'sqlite3_rsync', [destination, remote,
          '--ssh', wrapper, '--exe', config.remoteRsyncPath ?? 'sqlite3_rsync'], options);
        break;
      } catch (error) {
        if (attempt || abort.signal.aborted) throw error;
        generation = randomUUID();
        channel.send({ type: 'reset', generation });
        const reset = await channel.next();
        if (reset.type !== 'reset' || reset.generation !== generation) throw replicationError('protocol_failed');
      }
    }
    onPhase('verifying');
    channel.send({ type: 'publish', generation, digest: result.digest, bytes: result.bytes,
      checkpoint: result.checkpoint, sourceStartedAt: result.sourceStartedAt, sourceAt: result.sourceAt });
    const published = await channel.next();
    if (published.type !== 'published' || published.generation !== generation || published.receivedDigest !== result.digest ||
        !sameCheckpoint(published.checkpoint,result.checkpoint) ||
        published.digestAlgorithm !== JOURNAL_DIGEST || published.digest !== result.checkpoint.hash ||
        published.bytes !== result.bytes || !Number.isSafeInteger(published.verifiedAt)) throw replicationError('verification_failed');
    channel.child.stdin.end();
    await channel.done;
    await peerOperation('acknowledge',{dbPath,checkpoint:result.checkpoint,signal:abort.signal,onYield});
    return publicationResult(published,result.bytes);
  } catch (error) {
    const reason = abort.signal.aborted ? abort.signal.reason : error;
    throw Object.assign(replicationError(publicReplicationError(reason)), databaseErrorDetails(reason));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
    if (channel) { channel.close(); await channel.done.catch(() => {}); }
    if (destination) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(`${destination}${suffix}`, { force: true }).catch(() => {});
    }
  }
}
