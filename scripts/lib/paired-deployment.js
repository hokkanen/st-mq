import { resolve } from 'node:path';

export class DeploymentSafetyError extends Error {}
const unsafe = message => { throw new DeploymentSafetyError(message); };

export function synchronizationTimeout(value) {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 86400))
    unsafe('sync_timeout_seconds must be an integer from 1 to 86400.');
  return value ?? 900;
}

export function deploymentArguments(args, defaultConnection, { setup = false } = {}) {
  let connection = defaultConnection, stopped = false, apply = false, selected = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--connection' && !selected && args[i + 1] && !args[i + 1].startsWith('--')) {
      connection = resolve(args[++i]); selected = true;
    } else if (args[i] === '--stopped' && !setup && !stopped) stopped = true;
    else if (args[i] === '--apply' && setup && !apply) apply = true;
    else unsafe('Invalid arguments; use --help.');
  }
  return { connection, stopped, apply };
}

export function validateStandby(pair, identity, now = Date.now(), ready = false) {
  if (!pair || pair.role !== 'slave' || pair.canControl !== false || pair.busy !== false || pair.phase != null || pair.error != null
    || pair.vip?.owned !== false || pair.bootstrapPending || pair.recovery?.pendingRelease
    || pair.recovery?.state && !['idle', 'complete'].includes(pair.recovery.state)
    || pair.peer?.reachable !== true || pair.peer.role !== 'master' || !Number.isFinite(pair.peer.lastSeenAt)
    || pair.peer.lastSeenAt > now + 5000 || now - pair.peer.lastSeenAt > 15000
    || typeof pair.nodeId !== 'string' || typeof pair.pairId !== 'string' || typeof pair.peer.nodeId !== 'string') unsafe('A fresh, idle paired slave with a reachable master and no control authority is required.');
  if (identity && ['nodeId', 'pairId'].some(key => pair[key] !== identity[key]) || identity && pair.peer.nodeId !== identity.peer.nodeId) unsafe('Pair identity changed during deployment.');
  if (ready && (pair.sync?.state !== 'ready' || pair.sync.error != null)) unsafe('The slave has not completed synchronization.');
  return pair;
}

// A running slave may be between ordinary periodic checkpoints. Unlike startup,
// this wait never tolerates unavailable status, lost peers or initializing roles.
export async function waitForSynchronizedStandby({ read, verifyRunning, identity,
  timeoutSeconds, clock = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = () => {}, signal }) {
  const deadline = clock() + synchronizationTimeout(timeoutSeconds) * 1000;
  let pinned = identity, nextProgress = clock();
  while (true) {
    if (signal?.aborted) unsafe('Deployment cancelled.');
    await verifyRunning();
    const snapshot = await read();
    if (signal?.aborted) unsafe('Deployment cancelled.');
    if (!snapshot || !Number.isFinite(snapshot.observedAt)) unsafe('Invalid pair status observation.');
    const status = validateStandby(snapshot.pair, pinned, snapshot.observedAt);
    pinned ??= { nodeId: status.nodeId, pairId: status.pairId, peer: { nodeId: status.peer.nodeId } };
    if (status.sync?.error != null || !['ready', 'waiting', 'syncing'].includes(status.sync?.state))
      unsafe('Synchronization reported an error or unknown state; inspect Paired computers.');
    if (status.sync.state === 'ready') return status;
    if (clock() >= deadline) unsafe('Synchronization timed out; inspect Paired computers before continuing deployment.');
    if (clock() >= nextProgress) { log('Waiting for the running slave to finish synchronization…'); nextProgress = clock() + 30000; }
    await sleep(1000, signal);
  }
}

export async function waitForStandby({ read, verifyRunning, verifyReady = async () => {}, identity,
  timeoutSeconds, clock = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = () => {}, signal }) {
  const deadline = clock() + synchronizationTimeout(timeoutSeconds) * 1000;
  let nextProgress = clock() + 30000;
  while (true) {
    if (signal?.aborted) unsafe('Deployment cancelled.');
    await verifyRunning();
    const snapshot = await read();
    if (snapshot) {
      const status = snapshot.pair;
      if (!status || !Number.isFinite(snapshot.observedAt)) unsafe('Invalid pair status observation.');
      if (!['slave', 'protected'].includes(status.role) || status.canControl === true || status.vip?.owned === true || status.error != null
        || status.role === 'protected' && status.phase !== 'initializing'
        || status.nodeId && status.nodeId !== identity.nodeId || status.pairId && status.pairId !== identity.pairId
        || status.peer?.nodeId && status.peer.nodeId !== identity.peer.nodeId) unsafe('Unexpected role, authority, identity or protected recovery after startup.');
      if (status.sync?.state === 'error' || status.sync?.error != null) unsafe('Synchronization reported an error; inspect Paired computers.');
      let ready = false;
      try { validateStandby(status, identity, snapshot.observedAt, true); ready = true; } catch { /* Initial peer acquisition can still be incomplete. */ }
      if (ready) { await verifyReady(); return status; }
    }
    if (clock() >= deadline) unsafe('Synchronization timed out; inspect Paired computers before handover.');
    if (clock() >= nextProgress) { log('Still waiting for slave synchronization…'); nextProgress = clock() + 30000; }
    await sleep(1000, signal);
  }
}
