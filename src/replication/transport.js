import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, isAbsolute, resolve } from 'node:path';
import { rm, readdir } from 'node:fs/promises';
import { ownedDirectory, replicationError } from './publication.js';
import { sshOptions } from './ssh-options.js';

const wrapper = fileURLToPath(new URL('../../scripts/replica-ssh.js', import.meta.url));
const SAFE_PATH = /^[A-Za-z0-9_./-]+$/;
const PUBLIC_ERRORS = new Set(['configuration_invalid', 'tool_unavailable', 'connection_failed', 'transfer_failed',
  'snapshot_failed', 'verification_failed', 'integrity_failed', 'receiver_busy', 'receiver_failed', 'snapshot_busy',
  'directory_not_empty', 'unsafe_directory', 'invalid_publication', 'timed_out', 'stopped', 'protocol_failed']);

export function publicReplicationError(error) {
  return PUBLIC_ERRORS.has(error?.code) ? error.code : 'transfer_failed';
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
      if (message.type === 'error') { rejectAll(replicationError(publicReplicationError(message))); continue; }
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
    worker.once('message', value => finish(value.ok ? null : replicationError('snapshot_failed'), value));
    worker.once('error', () => finish(replicationError('snapshot_failed')));
    worker.once('exit', () => { if (!settled) finish(signal?.aborted ? signal.reason : replicationError('snapshot_failed')); });
  });
}

/** One attempt, including peer preflight, immutable backup, delta transfer and verification. */
export async function synchronizeReplica({ dbPath, config, signal, onPhase = () => {},
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
    await runProcess(config.rsyncPath ?? 'sqlite3_rsync', ['--version'], { ...options, code: 'tool_unavailable' });
    channel = receiverChannel(config, generation, options);
    channel.send({ type: 'prepare', version: 1, generation });
    const ready = await channel.next();
    if (ready.type !== 'ready' || ready.version !== 1) throw replicationError('protocol_failed');
    await ownedDirectory(sourceDirectory, '.st-mq-replication-work');
    // The receiver lock guarantees no other legitimate primary attempt is active.
    for (const name of await readdir(sourceDirectory)) {
      if (/^source-[a-f0-9-]+\.sqlite(?:-wal|-shm|-journal)?$/.test(name)) await rm(join(sourceDirectory, name), { force: true });
    }
    destination = join(sourceDirectory, `source-${generation}.sqlite`);
    onPhase('snapshotting');
    const result = await snapshot({ dbPath, destination, signal: abort.signal });
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
      sourceStartedAt: result.sourceStartedAt, sourceAt: result.sourceAt });
    const published = await channel.next();
    if (published.type !== 'published' || published.generation !== generation || published.digest !== result.digest ||
        published.bytes !== result.bytes || !Number.isSafeInteger(published.verifiedAt)) throw replicationError('verification_failed');
    channel.child.stdin.end();
    await channel.done;
    return { generation, digest: result.digest, bytes: result.bytes, sourceStartedAt: result.sourceStartedAt,
      sourceAt: result.sourceAt, verifiedAt: published.verifiedAt };
  } catch (error) {
    throw replicationError(abort.signal.aborted ? publicReplicationError(abort.signal.reason) : publicReplicationError(error));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
    if (channel) { channel.close(); await channel.done.catch(() => {}); }
    if (destination) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(`${destination}${suffix}`, { force: true }).catch(() => {});
    }
  }
}
