import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { lstat, open, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acceptsLineage, compareAuthority, NODE_PATTERN, PairState, pairError, validClaim } from './state.js';
import { PairPeer, publicPairError } from './peer.js';
import { createReplicaPublicationGuard, receiveSnapshot, SnapshotRepository, validateSnapshot, verifySnapshot } from './snapshots.js';
import { VirtualIP, VIP_ERRORS } from './vip.js';
import { MQTT_FRONTEND_ERRORS } from './mqtt-frontend.js';
import { createControllerAnnouncements } from './announcements.js';
import { copySnapshot, ownedDirectory, readReplicaPublication, syncDirectory } from '../replication/publication.js';
import { databaseErrorDetails, databaseErrorGuidance } from '../storage/database-errors.js';

const ACTIONS = new Set(['handover', 'promote', 'check-recovery', 'recover', 'rejoin']);
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
// A setup failure before the first write may retry bootstrap. Protection of
// received history must never authorize replacing that history with an empty DB.
const canBootstrap = local => local.bootstrapPending === true && !local.everWritten && !local.accepted
  && (local.role === 'slave' || local.role === 'protected' && ['activation_failed', 'vip_release_failed'].includes(local.reason));
const sameDonor = (left, right) => left && right && left.claim.nodeId === right.claim.nodeId
  && left.claim.epoch === right.claim.epoch && left.claim.role === right.claim.role
  && left.digest === right.digest && left.bytes === right.bytes;
const checkedSource = preview => preview?.status === 'checked' && preview.model?.status === 'not-assessed'
  && typeof preview.previewId === 'string' && /^[a-f0-9]{64}$/.test(preview.previewId)
  && preview.counts === undefined;

// Peer status is observation only. Never copy private diagnostics or use it as
// permission to replace history or acquire equipment control.
const publicSync = sync => ({ state: ['waiting', 'syncing', 'ready', 'error'].includes(sync?.state) ? sync.state : 'waiting',
  sourceAt: Number.isFinite(sync?.sourceAt) && sync.sourceAt > 0 ? sync.sourceAt : null,
  verifiedAt: Number.isFinite(sync?.verifiedAt) && sync.verifiedAt > 0 ? sync.verifiedAt : null,
  bytes: Number.isSafeInteger(sync?.bytes) && sync.bytes >= 0 ? sync.bytes : null });

/** Exceptions may contain credentials or provider payloads. Report only the
 * closed public code, numeric schema details and a repository source location,
 * never raw error text. */
export function startupFailureDiagnostic(error, code) {
  const database = databaseErrorDetails(error);
  if (code === 'runtime_failed' && database) code = database.code;
  const location = typeof error?.stack === 'string' ? error.stack.split('\n').slice(1).flatMap(line => {
    if (!/^\s+at /.test(line)) return [];
    const path = line.match(/(?:\(|\s)(?:file:\/\/)?(\/[^()\n]+\.js:\d+:\d+)\)?$/)?.[1];
    const relative = path?.startsWith(sourceRoot) ? path.slice(sourceRoot.length) : null;
    return relative && /^[a-zA-Z0-9_/-]+\.js:\d+:\d+$/.test(relative) ? [relative] : [];
  })[0] : null;
  return { event: 'paired-startup-failed', reason: publicPairError({ code }),
    ...(database && code === database.code ? {
      ...Object.fromEntries(Object.entries(database).filter(([key]) => key !== 'code')),
      guidance: databaseErrorGuidance(database),
    } : {}),
    ...(location ? { location: `src/${location}` } : {}) };
}

/** Node-local authority is deliberately never part of the mirrored application DB. */
export class PairManager {
  constructor({ config, hooks = {}, clock = Date.now, vip, peer, state, snapshots, announcements,
    reportStartupFailure = diagnostic => console.error(JSON.stringify(diagnostic)) }) {
    this.config = config;
    this.hooks = hooks;
    this.reportStartupFailure = reportStartupFailure;
    this.clock = clock;
    this.state = state ?? new PairState({ ...config, clock });
    this.vip = vip ?? new VirtualIP(config.vip);
    this.peer = peer ?? new PairPeer({ ...config, clock, timeoutMs: Math.min(config.timeoutMs ?? 10000, 10000),
      handler: (operation, body) => this.handlePeer(operation, body) });
    this.snapshots = snapshots ?? new SnapshotRepository({ directory: join(config.directory, 'exports'), clock });
    this.announcementsFactory = announcements ?? createControllerAnnouncements;
    this.activeAllowed = false;
    this.closed = false;
    this.stopping = false;
    this.busy = false;
    this.phase = null;
    this.error = null;
    this.peerState = { reachable: false, lastSeenAt: null };
    this.peerObservation = 0;
    this.sync = { state: 'waiting', sourceAt: null, verifiedAt: null, lastSuccessAt: null, error: null };
    this.lock = Promise.resolve();
    this.abort = new AbortController();
    this.localActions = new Set();
    this.controlReleased = false;
    this.startupChecking = false;
  }

  async init({ stateOpen = false, allowInvalidState = false } = {}) {
    if (!stateOpen) await this.state.open({ allowInvalid: allowInvalidState });
    // An interrupted explicit reset has no usable publication or authority.
    // Only another confirmed reset may resume its archive operation.
    if (this.state.invalid || this.state.value.reset) return this.status();
    await this.snapshots.init();
    await ownedDirectory(this.config.snapshotDirectory, '.st-mq-replica');
    const marker = await open(join(this.config.snapshotDirectory, '.st-mq-paired-receiver'), 'a', 0o600);
    await marker.sync(); await marker.close(); await syncDirectory(this.config.snapshotDirectory);
    // Old standalone publications lack a branch ancestry proof. Existing paired
    // publications must also match the durable accepted record after a restart.
    const publication = await readReplicaPublication(this.config.snapshotDirectory).catch(() => false);
    const pending = this.state.value.pendingSnapshot;
    let publicationVerified = false;
    if (this.state.value.role === 'slave' && publication && pending && publication.generation === pending.generation &&
        publication.digest === pending.digest && acceptsLineage(this.state.value.accepted, pending.claim)) {
      // The immutable publication may have committed immediately before a
      // crash, while the separate node-state acknowledgement had not.
      try {
        await verifySnapshot(publication.dbPath, publication, this.abort.signal);
        publicationVerified = true;
        await this.state.update({ pendingSnapshot: null, accepted: { generation: publication.generation,
          digest: publication.digest, epoch: pending.claim.epoch, sequence: pending.sequence, nodeId: pending.claim.nodeId } });
      } catch (error) {
        if (databaseErrorDetails(error)) this.reportFailure(error, error.code);
        await this.state.update({ role: 'protected', reason: 'snapshot_verification_failed', bootstrapPending: false,
          ...(databaseErrorDetails(error) ? { activationError: error.code } : {}) });
      }
    }
    if (this.state.value.role === 'slave' && (publication === false || publication &&
        (!this.state.value.accepted || publication.generation !== this.state.value.accepted.generation))) {
      await this.state.update({ role: 'protected', reason: 'unclassified_local_history', bootstrapPending: false });
    }
    if (this.state.value.role === 'slave' && publication && this.state.value.accepted) {
      try {
        const accepted = this.state.value.accepted;
        if (publication.digest !== accepted.digest || publication.claim?.epoch !== accepted.epoch
          || publication.claim?.nodeId !== accepted.nodeId || publication.sequence !== accepted.sequence) throw pairError('verification_failed');
        if (!publicationVerified) await verifySnapshot(publication.dbPath, publication, this.abort.signal);
        this.sync = { state: 'ready', sourceAt: publication.sourceAt, verifiedAt: publication.verifiedAt,
          bytes: publication.bytes, lastSuccessAt: null, error: null };
      } catch (error) {
        if (databaseErrorDetails(error)) this.reportFailure(error, error.code);
        await this.state.update({ role: 'protected', reason: 'snapshot_verification_failed', bootstrapPending: false,
          ...(databaseErrorDetails(error) ? { activationError: error.code } : {}) });
      }
    }
    if (['checking', 'recovering'].includes(this.state.value.recovery?.state)) {
      await this.state.update({ recovery: { ...this.state.value.recovery, state: 'error', error: 'recovery_interrupted' } });
    }
    if (this.state.value.actions.some(item => item.state === 'running')) {
      await this.state.update(value => ({ actions: value.actions.map(item => item.state === 'running' ?
        { ...item, state: 'error', error: 'action_interrupted', finishedAt: this.clock() } : item) }));
    }
    return this.status();
  }

  async start() {
    const startingEpoch = this.state.value.epoch;
    const previousError = this.state.value.activationError;
    if (previousError) this.error = publicPairError({ code: previousError });
    this.startupChecking = true;
    await this.peer.start();
    try {
      if (this.state.value.role === 'master' && !this.state.value.transition) await this.checkStartupAuthority();
      this.startupChecking = false;
      if (this.state.value.role === 'master' && !this.state.value.transition) await this.startPrimary();
      else {
        if (this.state.value.role === 'master') await this.state.update({ role: 'protected', reason: 'interrupted_handover' });
        try { await this.releaseTransport(); this.controlReleased = true; }
        catch (error) {
          // A broken address helper must not make protected history and setup
          // diagnostics inaccessible. No controller is started on this path.
          this.error = VIP_ERRORS.has(error?.code) ? error.code : 'vip_failed';
          this.reportFailure(error, this.error);
          if (!this.state.invalid) await this.state.update({ role: 'protected', reason: 'vip_release_failed', activationError: this.error });
        }
        await this.startReplica();
      }
    } catch (error) {
      this.startupChecking = false;
      if (this.state.value.epoch === startingEpoch) {
        this.activeAllowed = false;
        this.error = publicPairError(error);
        await this.releaseTransport().catch(() => {});
        if (!this.activationFallbackReady || this.state.value.role !== 'protected') throw error;
      } else if (!this.canControl() && this.state.value.role !== 'protected') throw error;
    }
    this.announcements = this.announcementsFactory(this.config, {
      claim: () => this.canControl() ? this.state.claim() : { ...this.state.claim(), role: this.state.value.role === 'master' ? 'protected' : this.state.value.role },
      onConflict: claim => this.observeClaim(claim), clock: this.clock,
    });
    this.announcements?.start();
    this.schedule(0);
    return this;
  }

  async checkStartupAuthority() {
    const claim = this.state.claim();
    const timeoutMs = Math.min(this.config.timeoutMs ?? 10000, 10000);
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]);
    let observed = false;
    const current = () => this.state.value.role === 'master' && this.state.value.epoch === claim.epoch;
    try {
      let remote = await this.peer.request('status', {}, { signal, timeoutMs });
      observed = true;
      if (!validClaim(remote.claim)) throw pairError('invalid_claim');
      if (!current()) { await this.demoting; return; }
      const identity = { nodeId: remote.claim.nodeId, epoch: remote.claim.epoch };
      this.recordPeerStatus(remote.claim, remote.sync);
      if (remote.claim.role === 'master' && (remote.claim.nodeId === claim.nodeId || compareAuthority(claim, remote.claim) < 0)) {
        await this.observeClaim(remote.claim, { confirmed: true });
        return;
      }
      // A saved master role does not prove that a reachable peer stopped. The
      // preferred node announces its claim and waits for successful fencing
      // before acquiring the address or opening any equipment connection.
      for (;;) {
        remote = await this.peer.request('status', { claim }, { signal, timeoutMs });
        if (!validClaim(remote.claim) || remote.claim.nodeId !== identity.nodeId || remote.claim.epoch !== identity.epoch)
          throw pairError('authority_changed');
        this.recordPeerStatus(remote.claim, remote.sync);
        if (!current()) { await this.demoting; return; }
        if (remote.claim.role === 'master') throw pairError('authority_changed');
        if (remote.controlReleased === true) return;
        await delay(100, undefined, { signal });
      }
    } catch (error) {
      if (this.stopping || this.closed || this.abort.signal.aborted) throw pairError('stopped');
      // An ordinary saved master remains independent of an offline slave. A
      // peer observed during this startup, even if its later reply is lost,
      // must explicitly confirm release before this node can activate.
      const timeout = signal.aborted && ['AbortError', 'TimeoutError'].includes(error?.name);
      if (!observed && !this.peerState.reachable && (['peer_unavailable', 'timed_out'].includes(error?.code) || timeout)) return;
      const code = publicPairError(timeout ? pairError('timed_out') : error);
      this.error = code;
      this.reportFailure(error, code);
      if (current()) await this.state.update({ role: 'protected', reason: 'startup_authority_unconfirmed', activationError: code });
    }
  }

  canControl() { return !this.closed && this.activeAllowed && this.state.value?.role === 'master'; }

  reportFailure(error, code) {
    try { void Promise.resolve(this.reportStartupFailure(startupFailureDiagnostic(error, code))).catch(() => {}); }
    catch { /* Diagnostic sinks cannot prevent protection or history access. */ }
  }

  serialized(action) {
    const task = this.lock.then(action);
    this.lock = task.catch(() => {});
    return task;
  }

  async releaseTransport() {
    // Removing an address does not close established broker or NAT sessions.
    // Never acknowledge release before all VIP-owned connections have closed.
    await this.hooks.stopTransport?.();
    await this.vip.release();
  }

  async startPrimary() {
    if (this.stopping || this.closed) throw pairError('stopped');
    const activationEpoch = this.state.value.epoch, activationDbPath = this.state.value.activeDbPath;
    const ownsActivation = () => this.state.value.epoch === activationEpoch;
    this.activationFallbackReady = false;
    this.controlReleased = false;
    let code = 'vip_failed';
    try {
      await this.hooks.preparePrimary?.();
      if (this.stopping || this.closed) throw pairError('stopped');
      if (!ownsActivation()) throw pairError('authority_changed');
      await this.vip.acquire();
      if (this.stopping || this.closed) throw pairError('stopped');
      if (!ownsActivation()) throw pairError('authority_changed');
      this.activeAllowed = true;
      code = 'runtime_failed';
      await this.hooks.startPrimary?.({ dbPath: activationDbPath,
        onWriting: async () => {
          if (this.stopping || this.closed || this.state.value.role !== 'master' || !ownsActivation()) throw pairError('stopped');
          await this.state.update(value => {
            if (value.epoch !== activationEpoch || value.role !== 'master') throw pairError('authority_changed');
            return { bootstrapPending: false, everWritten: true };
          });
          if (this.stopping || this.closed || this.state.value.role !== 'master' || !ownsActivation()) throw pairError('stopped');
        } });
      if (!this.canControl() || !ownsActivation()) throw pairError('authority_changed');
      await this.state.update(value => {
        if (value.epoch !== activationEpoch || value.role !== 'master') throw pairError('authority_changed');
        return { bootstrapPending: false, everWritten: true, activationError: null };
      });
      this.error = null;
    } catch (error) {
      if (!ownsActivation()) throw pairError('authority_changed');
      this.activeAllowed = false;
      this.hooks.revokeControl?.();
      if (code === 'runtime_failed' && databaseErrorDetails(error)) code = error.code;
      if (VIP_ERRORS.has(error?.code) || MQTT_FRONTEND_ERRORS.has(error?.code)
        || ['mqtt_local_required', 'mqtt_resolution_failed', 'mqtt_source_context_invalid'].includes(error?.code)) code = error.code;
      let stopped = true;
      try { await this.hooks.stopControl?.({ restore: false }); }
      catch { stopped = false; }
      try { await this.releaseTransport(); }
      catch (releaseError) { code = VIP_ERRORS.has(releaseError?.code) ? releaseError.code : 'vip_release_failed'; }
      if (this.stopping || this.closed) throw pairError('stopped');
      if (!ownsActivation()) throw pairError('authority_changed');
      if (this.demoting) {
        await this.demoting;
        this.activationFallbackReady = true;
        throw pairError(code);
      }
      this.reportFailure(error, code);
      await this.serialized(() => this.state.update(value => {
        if (value.epoch !== activationEpoch) throw pairError('authority_changed');
        return { role: 'protected', reason: 'activation_failed', activationError: code, transition: null, release: null };
      }));
      this.error = code;
      this.controlReleased = stopped && this.vip.status().owned === false && !this.vip.status().error;
      await this.startReplica();
      this.activationFallbackReady = true;
      throw pairError(code);
    }
  }

  async startReplica(publication) {
    if (this.stopping || this.closed) return;
    const local = this.state.value;
    await this.hooks.startReplica?.({ role: local.role, publication,
      dbPath: local.role === 'protected' && local.everWritten ? local.activeDbPath : undefined });
  }

  publicRecovery() {
    const recovery = this.state.value.recovery;
    if (!recovery) return { state: 'idle', preview: null, report: null, error: null };
    return { state: recovery.state, preview: recovery.preview ?? null, report: recovery.report ?? null,
      donorRole: recovery.metadata?.claim?.role ?? null,
      error: recovery.error ?? null,
      pendingRelease: recovery.releaseOperation ? { requestId: recovery.releaseOperation.requestId,
        discardUnrecovered: recovery.releaseOperation.skipRecovery, previewId: recovery.preview?.previewId } : null };
  }

  status() {
    const local = this.state.value;
    if (!local) return { role: 'protected', canControl: false, busy: true, phase: 'initializing', actions: {} };
    const recovery = this.publicRecovery();
    const primary = local.role === 'master' && this.canControl();
    const bootstrapPending = canBootstrap(local);
    const free = !this.busy && !this.closed && !this.stopping && !local.reset && !this.state.invalid;
    const checked = local.recovery?.metadata?.claim;
    const protectedDonor = recovery.donorRole === 'protected' && (!this.peerState.reachable
      || this.peerState.role === 'protected' && this.peerState.nodeId === checked?.nodeId && this.peerState.epoch === checked?.epoch);
    return { ...this.state.claim(), canControl: this.canControl(), busy: this.busy, bootstrapPending,
      phase: this.phase, error: this.error, vip: this.vip.status(), peer: { ...this.peerState }, sync: { ...this.sync },
      recovery, recentActions: local.actions.map(({ requestId, name, state, error, startedAt, finishedAt }) =>
        ({ requestId, name, state, error, startedAt, finishedAt })),
      actions: { handover: free && primary && !recovery.pendingRelease && this.peerState.reachable && this.peerState.role === 'slave',
        promote: free && (['slave', 'protected'].includes(local.role) && (!!local.accepted || bootstrapPending)
          || local.role === 'protected' && local.everWritten && !!local.activeDbPath),
        'check-recovery': free && primary && !recovery.pendingRelease && this.peerState.reachable && this.peerState.role !== 'master',
        recover: free && primary && protectedDonor && this.peerState.reachable
          && recovery.state === 'ready' && checkedSource(recovery.preview),
        rejoin: free && primary && (protectedDonor || Boolean(recovery.pendingRelease))
          && (Boolean(recovery.pendingRelease) || recovery.state === 'complete' || recovery.state === 'ready' && checkedSource(recovery.preview))
          && this.peerState.reachable } };
  }

  schedule(delay) {
    if (this.closed || this.stopping) return;
    this.timer = setTimeout(() => {
      this.polling = this.poll().finally(() => this.schedule(2000));
    }, delay);
    this.timer.unref();
  }

  async poll() {
    const observation = this.observationGeneration();
    const peerObservation = this.peerObservation;
    try {
      const result = await this.peer.request('status', { claim: this.state.claim(), sync: publicSync(this.sync) }, { signal: this.abort.signal });
      if (observation !== this.observationGeneration() || this.closed || this.stopping) return;
      if (!validClaim(result.claim)) throw pairError('invalid_claim');
      if (peerObservation === this.peerObservation) this.recordPeerStatus(result.claim, result.sync);
      if (this.peerState.reachable && validClaim(this.peerState)) await this.observeClaim(this.peerState);
    } catch (error) {
      if (observation !== this.observationGeneration() || peerObservation !== this.peerObservation || this.closed || this.stopping) return;
      this.peerObservation++;
      this.peerState = { ...this.peerState, reachable: false };
      this.sync.error = publicPairError(error);
    } finally {
      // Both computers may poll together. A newer incoming status supersedes
      // the outgoing reply but must still let a slave schedule synchronization.
      if (!this.closed && !this.stopping && !this.busy && !this.syncTask && this.state.value.role === 'slave'
          && this.peerState.reachable && this.peerState.role === 'master'
          && (!this.nextSyncAt || this.nextSyncAt <= this.clock()))
        this.syncTask = this.synchronize(this.peerState).finally(() => { this.syncTask = null; });
    }
  }

  recordPeerStatus(claim, sync) {
    const sameIdentity = this.peerState.nodeId === claim.nodeId && this.peerState.epoch === claim.epoch && this.peerState.role === claim.role;
    this.peerObservation++;
    this.peerState = { reachable: true, lastSeenAt: this.clock(), ...claim,
      sync: sync === undefined && sameIdentity ? this.peerState.sync : publicSync(sync),
      syncReceivedAt: sync === undefined ? sameIdentity ? this.peerState.syncReceivedAt : null : this.clock() };
  }

  observationGeneration() {
    const local = this.state.value;
    return JSON.stringify([local.role,local.epoch,local.transition?.token,local.transition?.phase,this.activeAllowed]);
  }

  async observeClaim(claim, { confirmed = false } = {}) {
    if (!validClaim(claim)) throw pairError('invalid_claim');
    if (this.closed || claim.role !== 'master' || this.state.value.role !== 'master') return;
    const superseded = this.state.value.supersededPeer;
    if (!confirmed && superseded?.nodeId === claim.nodeId && superseded.epoch === claim.epoch) {
      // A valid, delayed announcement may describe the owner that handed over.
      // Challenge it afresh; silence is neither a conflict nor evidence of fencing.
      const observation = this.observationGeneration();
      try {
        const current = await this.peer.request('status', {}, { signal: this.abort.signal });
        if (observation !== this.observationGeneration()) return;
        if (!validClaim(current.claim)) throw pairError('invalid_claim');
        return this.observeClaim(current.claim, { confirmed: true });
      } catch { return; }
    }
    if (claim.nodeId === this.state.value.nodeId) {
      this.activeAllowed = false;
      return this.demote('duplicate_node_identity');
    }
    if (compareAuthority(this.state.claim(), claim) < 0) {
      // Disable publications synchronously, before filesystem or runtime awaits.
      this.activeAllowed = false;
      this.syncAbort?.abort(pairError('authority_changed'));
      return this.demote('competing_master');
    }
  }

  async demote(reason) {
    if (this.demoting) return this.demoting;
    const task = (async () => {
      this.activeAllowed = false;
      this.controlReleased = false;
      this.hooks.revokeControl?.();
      let persistenceError;
      try {
        await this.serialized(async () => {
          if (this.state.value.role !== 'master') return;
          await this.state.update({ role: 'protected', reason, release: null, transition: null });
        });
      } catch (error) { persistenceError = error; }
      const [stopped] = await Promise.allSettled([this.hooks.stopControl?.({ restore: false })]);
      const [released] = await Promise.allSettled([this.releaseTransport()]);
      if (persistenceError) { this.error = 'invalid_pair_state'; throw persistenceError; }
      const failure = released.status === 'rejected' ? pairError(VIP_ERRORS.has(released.reason?.code) ? released.reason.code : 'vip_release_failed')
        : stopped.status === 'rejected' ? pairError('runtime_failed') : null;
      this.controlReleased = !failure;
      if (failure) {
        this.error = failure.code;
        await this.state.update({ activationError: failure.code });
      }
      if (!this.closed && !this.startupChecking) await this.startReplica();
      if (failure) throw failure;
    })();
    this.demoting = task;
    try { await task; } finally { this.demoting = null; }
  }

  async assertReplica(claim, { allowRelease = false } = {}) {
    const local = this.state.value;
    const released = allowRelease && local.role === 'protected' && local.release?.epoch === claim.epoch;
    if (this.closed || local.role !== 'slave' && !released) throw pairError('protected_history');
    if (!released && !acceptsLineage(local.accepted, claim)) {
      await this.state.update({ role: 'protected', reason: 'lineage_mismatch' });
      throw pairError('lineage_mismatch');
    }
  }

  async synchronize(claim) {
    this.syncAbort = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, this.syncAbort.signal, AbortSignal.timeout(this.config.timeoutMs ?? 3600000)]);
    this.sync = { ...this.sync, state: 'syncing', error: null };
    try {
      await this.assertReplica(claim);
      let metadata = this.state.value.pendingSnapshot;
      if (!metadata || metadata.claim?.epoch !== claim.epoch) {
        metadata = validateSnapshot(await this.peer.request('snapshot', {}, { signal, timeoutMs: this.config.timeoutMs }));
        await this.state.update({ pendingSnapshot: metadata });
      } else validateSnapshot(metadata);
      if (metadata.claim.role !== 'master' || metadata.claim.epoch !== claim.epoch) throw pairError('authority_changed');
      const result = await this.installReplica(metadata, { signal });
      this.sync = { state: 'ready', sourceAt: result.sourceAt, verifiedAt: result.verifiedAt, bytes: result.bytes,
        lastSuccessAt: this.clock(), error: null, transferredBytes: result.transferredBytes };
    } catch (error) {
      this.sync = { ...this.sync, state: 'error', error: publicPairError(error) };
      if (['snapshot_unavailable', 'authority_changed'].includes(error?.code)) await this.state.update({ pendingSnapshot: null });
    }
    finally { this.nextSyncAt = this.clock() + (this.config.intervalMs ?? 60000); this.syncAbort = null; }
  }

  async installReplica(metadata, { signal, allowRelease = false } = {}) {
    await this.assertReplica(metadata.claim, { allowRelease });
    const unchanged = allowRelease ? null : await this.replicaPublicationGuard(signal);
    const guard = async () => {
      await this.assertReplica(metadata.claim, { allowRelease });
      if (unchanged) await unchanged();
    };
    return receiveSnapshot({ directory: this.config.snapshotDirectory, metadata, peer: this.peer, signal, guard,
      onProgress: value => { this.sync = { ...this.sync, ...value }; },
      commit: action => this.serialized(async () => {
        await guard();
        // Check the sender is still authoritative just before publication.
        const remote = await this.peer.request('status', { claim: this.state.claim(), sync: publicSync(this.sync) }, { signal });
        if (remote.claim?.role !== 'master' || remote.claim.epoch !== metadata.claim.epoch) throw pairError('authority_changed');
        await guard();
        const result = await action();
        await this.state.update({ pendingSnapshot: null, accepted: { generation: result.generation, digest: result.digest,
          epoch: metadata.claim.epoch, sequence: metadata.sequence, nodeId: metadata.claim.nodeId } });
        return result;
      }) });
  }

  async replicaPublicationGuard(signal = this.abort.signal) {
    const protect = async operation => {
      try { return await operation(); }
      catch (error) {
        if ((error?.code === 'verification_failed' || databaseErrorDetails(error)) && this.state.value.role === 'slave')
          await this.state.update({ role: 'protected', reason: 'snapshot_verification_failed', bootstrapPending: false,
            ...(databaseErrorDetails(error) ? { activationError: error.code } : {}) });
        throw error;
      }
    };
    const unchanged = await protect(() => createReplicaPublicationGuard({ directory: this.config.snapshotDirectory,
      accepted: this.state.value.accepted, signal }));
    return () => protect(unchanged);
  }

  async exportSnapshot({ force = false, pin = false } = {}) {
    let local = this.state.value;
    // A legitimate publication can replace the manifest while a read-only
    // comparison is taking its backup. Serialize with publication so the local
    // mutation guard never mistakes normal mirroring for divergent writes.
    if (local.role === 'slave') return this.serialized(() => this.exportReplicaSnapshot({ force, pin, role: 'slave' }));
    if (local.role === 'protected' && (!local.everWritten || !local.activeDbPath))
      return this.exportReplicaSnapshot({ force, pin, role: 'protected' });
    if (local.role === 'master') {
      await this.prepareExportStamp();
      local = this.state.value;
    }
    const epoch = local.epoch;
    const role = local.role;
    return this.snapshots.create({ dbPath: local.activeDbPath ?? this.hooks.dbPath?.(), claim: this.state.claim(),
      sequence: this.state.value.sequence, signal: this.abort.signal, force, pin,
      assertSource: () => { if (this.closed || this.state.value.epoch !== epoch || this.state.value.role !== role) throw pairError('authority_changed'); } });
  }

  async exportReplicaSnapshot({ force, pin, role }) {
    const local = this.state.value;
    if (local.role !== role) throw pairError('authority_changed');
    const unchanged = role === 'slave' ? await this.replicaPublicationGuard() : null;
    const publication = await readReplicaPublication(this.config.snapshotDirectory);
    if (!publication) throw pairError('snapshot_unavailable');
    return this.snapshots.create({ dbPath: publication.dbPath, claim: this.state.claim(), sequence: local.sequence,
      signal: this.abort.signal, force, pin, assertSource: async () => {
        if (this.closed || this.state.value.epoch !== local.epoch || this.state.value.role !== role) throw pairError('authority_changed');
        if (unchanged) await unchanged();
      } });
  }

  async readLineage(dbPath) {
    if (this.hooks.readLineage) return this.hooks.readLineage({ dbPath });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM state WHERE key='pairing-lineage'").get();
      return row ? JSON.parse(row.value) : null;
    } finally { db.close(); }
  }

  async writeLineage(dbPath, value) {
    if (this.hooks.writeLineage) return this.hooks.writeLineage({ dbPath, value });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout=1000');
      db.prepare("INSERT INTO state(key,value,updated_at) VALUES('pairing-lineage',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
        .run(JSON.stringify(value), this.clock());
    } finally { db.close(); }
  }

  async prepareExportStamp() {
    return this.serialized(async () => {
      let local = this.state.value;
      if (local.role !== 'master') throw pairError('not_master');
      const actual = await this.readLineage(local.activeDbPath);
      const equal = (a, b) => a && b && a.epoch === b.epoch && a.sequence === b.sequence && a.token === b.token;
      if (equal(actual, local.pendingStamp)) {
        await this.state.update({ dbStamp: actual, sequence: actual.sequence, pendingStamp: null });
        local = this.state.value;
      } else if (local.dbStamp && !equal(actual, local.dbStamp)) {
        // A rollback or replacement of only the application database breaks its
        // ancestry even when the machine's authority file survived unchanged.
        await this.state.update({ epoch: randomUUID(), sequence: 0, ancestors: [], dbStamp: null,
          pendingStamp: null, reason: 'database_history_changed' });
        local = this.state.value;
      }
      const stamp = { epoch: local.epoch, sequence: local.sequence + 1, token: randomUUID() };
      await this.state.update({ pendingStamp: stamp });
      await this.writeLineage(local.activeDbPath, stamp);
      await this.state.update({ sequence: stamp.sequence, dbStamp: stamp, pendingStamp: null });
    });
  }

  action(name, body = {}) {
    const task = this.runAction(name, body);
    this.localActions.add(task);
    void task.then(() => this.localActions.delete(task), () => this.localActions.delete(task));
    return task;
  }

  async runAction(name, body = {}) {
    if (this.closed || this.stopping) throw pairError('stopped');
    if (this.state.invalid || this.state.value.reset) throw pairError('protected_history');
    if (!ACTIONS.has(name)) throw pairError('invalid_action');
    if (!NODE_PATTERN.test(body.requestId ?? '')) throw pairError('invalid_request_id');
    const previous = this.state.value.actions.find(item => item.requestId === body.requestId);
    if (previous) {
      if (previous.name !== name) throw pairError('invalid_request_id');
      const retryRelease = name === 'rejoin' && previous.state === 'error'
        && this.state.value.recovery?.releaseOperation?.requestId === body.requestId;
      if (!retryRelease) return { ok: previous.state === 'complete', duplicate: true, status: this.status() };
    }
    if (name !== 'check-recovery' && body.confirmed !== true) throw pairError('confirmation_required');
    if (this.busy || this.demoting) throw pairError('peer_busy');
    this.busy = true;
    this.phase = name;
    this.error = null;
    try {
      await this.state.update(value => ({ actions: [...value.actions.filter(item => item.requestId !== body.requestId).slice(-31),
        { requestId: body.requestId, name, state: 'running', startedAt: this.clock() }] }));
      this.syncAbort?.abort(pairError('authority_changed'));
      await this.syncTask;
      if (name === 'promote') await this.promote();
      else if (name === 'handover') await this.handover();
      else if (name === 'check-recovery') await this.checkRecovery(body);
      else if (name === 'recover') await this.recover(body);
      else await this.rejoin(body);
      await this.finishAction(body.requestId, 'complete');
      return { ok: true, status: this.status() };
    } catch (error) {
      this.error = publicPairError(error);
      await this.finishAction(body.requestId, 'error', this.error);
      throw pairError(this.error);
    } finally { this.busy = false; this.phase = null; }
  }

  finishAction(requestId, state, error) {
    return this.state.update(value => ({ actions: value.actions.map(item => item.requestId === requestId ?
      { ...item, state, error, finishedAt: this.clock() } : item) }));
  }

  async promote({ handover = false } = {}) {
    if (!handover && canBootstrap(this.state.value)) {
      let present;
      try { present = await lstat(this.state.value.activeDbPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!present || present.isFile() && present.size === 0) {
        await this.hooks.closeReplica?.();
        await this.state.update({ role: 'master', epoch: randomUUID(), sequence: 0, ancestors: [],
          reason: null, transition: null, release: null, recovery: null, dbStamp: null, pendingStamp: null });
        await this.startPrimary();
        return;
      }
    }
    if (this.state.value.role === 'protected' && this.state.value.everWritten && this.state.value.activeDbPath && !handover) {
      const source = await this.exportSnapshot({ force: true });
      await verifySnapshot(join(this.snapshots.directory, `export-${source.generation}.sqlite`), source, this.abort.signal);
      await this.hooks.authorizeMqttPromotion?.({ dbPath: join(this.snapshots.directory, `export-${source.generation}.sqlite`) });
      await this.hooks.closeReplica?.();
      const epoch = randomUUID();
      await this.serialized(() => this.state.update({ role: 'master', epoch, sequence: 0,
        ancestors: [...this.state.value.ancestors, { epoch: source.claim.epoch, sequence: source.sequence }],
        reason: null, transition: null, release: null, recovery: null, dbStamp: null, pendingStamp: null }));
      await this.startPrimary();
      return;
    }
    if (!['slave', 'protected'].includes(this.state.value.role) || !this.state.value.accepted) throw pairError('protected_history');
    const publication = await readReplicaPublication(this.config.snapshotDirectory);
    const accepted = this.state.value.accepted;
    if (!publication || publication.generation !== accepted.generation || publication.digest !== accepted.digest
      || publication.claim?.epoch !== accepted.epoch || publication.claim?.nodeId !== accepted.nodeId
      || publication.sequence !== accepted.sequence) throw pairError('verification_failed');
    await verifySnapshot(publication.dbPath, publication, this.abort.signal);
    if (!handover) await this.hooks.authorizeMqttPromotion?.({ dbPath: publication.dbPath });
    await this.hooks.closeReplica?.();
    const epoch = randomUUID(), destination = join(this.config.directory, `master-${epoch}.sqlite`);
    await copySnapshot(publication.dbPath, destination);
    const file = await open(destination, 'r'); await file.sync(); await file.close(); await syncDirectory(this.config.directory);
    const ancestors = [...(publication.claim?.ancestors ?? []),
      { epoch: this.state.value.accepted.epoch, sequence: this.state.value.accepted.sequence }];
    await this.serialized(() => this.state.update({ role: 'master', epoch, sequence: 0,
      ancestors, activeDbPath: destination, everWritten: true, reason: null, transition: null, release: null,
      recovery: null, dbStamp: null, pendingStamp: null,
      supersededPeer: handover ? { nodeId: this.state.value.accepted.nodeId, epoch: this.state.value.accepted.epoch } : null }));
    await this.startPrimary();
    if (!handover) this.nextSyncAt = 0;
  }

  async handover() {
    if (!this.canControl()) throw pairError('not_master');
    if (this.state.value.recovery?.releaseOperation) throw pairError('invalid_transition');
    const claim = this.state.claim(), token = randomUUID();
    const ocpp = await this.hooks.handoverRequirements?.() ?? null;
    const mqtt = await this.hooks.mqttHandoverRequirements?.() ?? null;
    const remote = await this.peer.request('handover-prepare', { claim, token, ocpp, mqtt });
    if (remote.role !== 'slave') throw pairError('invalid_transition');
    if (!Object.hasOwn(remote, 'ocpp') || !isDeepStrictEqual(remote.ocpp, ocpp)) throw pairError('ocpp_handover_not_ready');
    if (!Object.hasOwn(remote, 'mqtt') || !isDeepStrictEqual(remote.mqtt, mqtt)) throw pairError('mqtt_handover_not_ready');
    if (!this.canControl() || this.state.value.epoch !== claim.epoch) throw pairError('authority_changed');
    await this.state.update(value => {
      if (!this.canControl() || value.epoch !== claim.epoch) throw pairError('authority_changed');
      return { transition: { kind: 'handover', phase: 'stopping', token, peerNodeId: remote.nodeId } };
    });
    try {
      // Graceful restoration is allowed until it is flushed. Authority-loss
      // demotion can still synchronously revoke the gate during this await.
      await this.hooks.stopControl?.({ restore: true });
      this.activeAllowed = false;
      await this.releaseTransport();
      this.controlReleased = true;
      if (this.state.value.role !== 'master') throw pairError('authority_changed');
      const metadata = await this.exportSnapshot({ force: true });
      await this.peer.request('handover-stage', { token, metadata }, { timeoutMs: this.config.timeoutMs });
      await this.serialized(() => this.state.update({ role: 'protected', reason: 'handover_released',
        transition: { kind: 'handover', phase: 'released', token, peerNodeId: remote.nodeId, generation: metadata.generation } }));
      const activated = await this.peer.request('handover-activate', { token }, { timeoutMs: this.config.timeoutMs });
      if (activated.role !== 'master' || activated.accepted?.generation !== metadata.generation) throw pairError('invalid_transition');
      // The peer accepted the exact final copy. There is no independent history
      // left to recover; normal lineage gating can now follow its new branch.
      const publication = await receiveSnapshot({ directory: this.config.snapshotDirectory, metadata,
        peer: { request: (operation, body) => operation === 'snapshot-hashes' ? this.snapshots.hashes(body) : this.snapshots.chunk(body) },
        signal: this.abort.signal, guard: async () => {
          if (this.state.value.role !== 'protected' || this.state.value.transition?.token !== token) throw pairError('authority_changed');
        }, commit: action => this.serialized(action) });
      await this.state.update({ role: 'slave', reason: null, transition: null, everWritten: false, activeDbPath: null, accepted: {
        generation: metadata.generation, digest: metadata.digest, epoch: metadata.claim.epoch,
        sequence: metadata.sequence, nodeId: metadata.claim.nodeId } });
      this.sync = { state: 'ready', sourceAt: publication.sourceAt, verifiedAt: publication.verifiedAt,
        bytes: publication.bytes, lastSuccessAt: this.clock(), error: null, transferredBytes: publication.transferredBytes };
      await this.startReplica();
      this.nextSyncAt = 0;
    } catch (error) {
      this.activeAllowed = false;
      this.hooks.revokeControl?.();
      await this.state.update({ role: 'protected', reason: 'interrupted_handover' });
      await this.hooks.stopControl?.({ restore: false }).catch(() => {});
      await this.releaseTransport().catch(() => {});
      await this.startReplica();
      throw error;
    }
  }

  async checkRecovery({ requestId } = {}) {
    if (!this.canControl()) throw pairError('not_master');
    if (!this.hooks.recoveryPreview) throw pairError('recovery_unavailable');
    const previous = this.state.value.recovery;
    if (previous?.releaseOperation) throw pairError('invalid_transition');
    const completedReceipt = previous?.report?.status === 'complete' ? previous : {};
    await this.state.update({ recovery: { ...completedReceipt, state: 'checking' } });
    try {
      const peerObservation = this.peerObservation;
      const metadata = validateSnapshot(await this.peer.request('snapshot', { force: true }, { timeoutMs: this.config.timeoutMs }));
      if (metadata.claim.role === 'master') throw pairError('authority_changed');
      if (peerObservation === this.peerObservation) this.recordPeerStatus(metadata.claim);
      const donor = await receiveSnapshot({ directory: join(this.config.directory, 'recovery'), metadata,
        peer: this.peer, signal: this.abort.signal, publish: false,
        guard: async () => { if (!this.canControl()) throw pairError('not_master'); } });
      const preview = await this.hooks.recoveryPreview({ donorPath: donor.dbPath, requestId });
      if (!checkedSource(preview))
        throw pairError('recovery_unavailable');
      const completed = completedReceipt.report && sameDonor(previous.metadata, metadata);
      await this.state.update({ recovery: { state: completed ? 'complete' : 'ready', metadata, donorPath: donor.dbPath, preview,
        ...(completed ? { report: previous.report } : {}) } });
    } catch (error) {
      await this.state.update({ recovery: { ...completedReceipt, state: 'error', error: publicPairError(error) } });
      throw error;
    }
  }

  async recover(body) {
    if (!this.canControl()) throw pairError('not_master');
    const recovery = this.state.value.recovery;
    if (recovery?.state !== 'ready' || recovery.metadata?.claim?.role !== 'protected'
      || !checkedSource(recovery.preview) || body.previewId !== recovery.preview.previewId) throw pairError('invalid_transition');
    if (!this.hooks.recoveryApply) throw pairError('recovery_unavailable');
    await this.assertRecoveryDonor(recovery);
    await this.state.update({ recovery: { ...recovery, state: 'recovering' } });
    try {
      const report = await this.hooks.recoveryApply({ donorPath: recovery.donorPath, preview: recovery.preview, requestId: body.requestId,
        isCurrent: () => this.canControl() });
      if (!this.canControl()) throw pairError('authority_changed');
      await this.state.update({ recovery: { ...recovery, state: 'complete', report: report.report ?? report } });
    } catch (error) {
      await this.state.update({ recovery: { ...recovery, state: 'error', error: publicPairError(error) } });
      throw error;
    }
  }

  async assertRecoveryDonor(recovery) {
    const peerObservation = this.peerObservation;
    const current = await this.peer.request('status', {}, { signal: this.abort.signal });
    if (!validClaim(current.claim)) throw pairError('invalid_claim');
    if (peerObservation === this.peerObservation) this.recordPeerStatus(current.claim, current.sync);
    const checked = recovery.metadata.claim;
    if (!this.canControl() || !this.peerState.reachable || this.peerState.role !== 'protected'
      || this.peerState.nodeId !== checked.nodeId || this.peerState.epoch !== checked.epoch) throw pairError('invalid_transition');
  }

  async rejoin(body = {}) {
    if (!this.canControl()) throw pairError('not_master');
    const recovery = this.state.value.recovery;
    if (recovery?.metadata?.claim?.role !== 'protected') throw pairError('recovery_required');
    const skipRecovery = body.discardUnrecovered === true;
    let operation = recovery.releaseOperation;
    if (operation) {
      // A saved release is an already authorized replacement with an uncertain
      // result. Verify exactly that request even after the source-check UI
      // contract changes; an old preview alone grants no new permission.
      if (operation.requestId !== body.requestId || operation.skipRecovery !== skipRecovery
        || skipRecovery && body.previewId !== recovery.preview?.previewId) throw pairError('invalid_transition');
    } else if (skipRecovery) {
      if (recovery?.state !== 'ready' || !checkedSource(recovery.preview)) throw pairError('recovery_required');
      if (body.previewId !== recovery.preview.previewId) throw pairError('invalid_transition');
    } else if (recovery?.state !== 'complete') throw pairError('recovery_required');
    if (!operation) {
      await this.assertRecoveryDonor(recovery);
      const metadata = await this.exportSnapshot({ force: true, pin: true });
      operation = { requestId: body.requestId, donor: recovery.metadata, metadata, skipRecovery };
      await this.state.update({ recovery: { ...recovery, releaseOperation: operation } });
    }
    const metadata = operation.metadata;
    let result;
    try { result = await this.peer.request('release', operation, { timeoutMs: this.config.timeoutMs }); }
    catch (error) {
      // This rejection is issued before the peer changes its role or database.
      // It needs a new check, whereas a lost response must retain the same release.
      if (error?.code === 'recovery_required') {
        await this.state.update({ recovery: { ...recovery, releaseOperation: null } });
        await this.snapshots.unpin(metadata.generation).catch(() => {});
      }
      throw error;
    }
    if (result.role !== 'slave' || result.releaseReceipt?.digest !== metadata.digest
      || result.releaseReceipt?.generation !== metadata.generation || result.releaseReceipt?.requestId !== operation.requestId)
      throw pairError('verification_failed');
    const report = skipRecovery ? { ...recovery.preview, status: 'skipped', recoverySkipped: true,
      imported: 0, model: { status: 'unchanged' } } : recovery.report;
    await this.state.update({ recovery: { state: 'resolved', report } });
    await this.snapshots.unpin(metadata.generation).catch(() => {});
    await rm(recovery.donorPath, { force: true }).catch(() => {});
    this.recordPeerStatus(result, result.sync);
  }

  async handlePeer(operation, body) {
    if (this.closed || this.stopping) throw pairError('stopped');
    if ((this.state.invalid || this.state.value.reset) && operation !== 'status') throw pairError('protected_history');
    if (operation === 'status') {
      if (body.claim) {
        await this.observeClaim(body.claim);
        this.recordPeerStatus(body.claim, body.sync);
      }
      return { claim: this.state.claim(), sync: publicSync(this.sync),
        controlReleased: this.controlReleased && !this.canControl() && !this.demoting && this.state.value.role !== 'master' };
    }
    if (operation === 'snapshot') return this.exportSnapshot({ force: body.force === true });
    if (operation === 'snapshot-hashes') return this.snapshots.hashes(body);
    if (operation === 'snapshot-chunk') return this.snapshots.chunk(body);
    if (operation === 'handover-prepare') {
      if (!validClaim(body.claim) || body.claim.role !== 'master' || !NODE_PATTERN.test(body.token ?? '')) throw pairError('invalid_transition');
      if (!Object.hasOwn(body, 'ocpp')) throw pairError('ocpp_handover_not_ready');
      if (!Object.hasOwn(body, 'mqtt') || !this.hooks.prepareMqttHandover
        && !isDeepStrictEqual(body.mqtt, await this.hooks.mqttHandoverRequirements?.() ?? null))
        throw pairError('mqtt_handover_not_ready');
      await this.assertReplica(body.claim);
      if (this.busy) throw pairError('peer_busy');
      this.busy = true;
      try {
        await this.hooks.preparePrimary?.();
        await this.hooks.prepareMqttHandover?.({ requirements: body.mqtt, token: body.token });
        if (body.ocpp !== null && (!this.hooks.prepareHandover || !this.hooks.verifyHandover)) throw pairError('ocpp_handover_not_ready');
        await this.hooks.prepareHandover?.(body.ocpp);
        await this.assertReplica(body.claim);
        await this.state.update({ transition: { kind: 'handover', phase: 'prepared', token: body.token,
          peerNodeId: body.claim.nodeId, epoch: body.claim.epoch, ocpp: body.ocpp, mqtt: body.mqtt } });
        return { ...this.state.claim(), ocpp: body.ocpp, mqtt: body.mqtt };
      } finally { this.busy = false; }
    }
    if (operation === 'handover-stage') {
      if (this.busy || this.state.value.transition?.token !== body.token || this.state.value.role !== 'slave') throw pairError('invalid_transition');
      const metadata = validateSnapshot(body.metadata);
      if (metadata.claim.epoch !== this.state.value.transition.epoch) throw pairError('authority_changed');
      this.busy = true;
      try {
        this.syncAbort?.abort(pairError('authority_changed')); await this.syncTask;
        const publication = await this.installReplica(metadata, { signal: this.abort.signal });
        await this.hooks.verifyHandover?.({ dbPath: publication.dbPath, requirements: this.state.value.transition.ocpp });
        await this.hooks.verifyMqttHandover?.({ dbPath: publication.dbPath, requirements: this.state.value.transition.mqtt,
          token: body.token });
        await this.state.update({ transition: { ...this.state.value.transition, phase: 'staged' } });
        return this.state.claim();
      } finally { this.busy = false; }
    }
    if (operation === 'handover-activate') {
      if (this.state.value.transition?.token !== body.token || this.state.value.transition.phase !== 'staged') throw pairError('invalid_transition');
      if (this.busy) throw pairError('peer_busy');
      const remote = await this.peer.request('status', { claim: this.state.claim(), sync: publicSync(this.sync) });
      if (remote.claim?.role !== 'protected' || remote.claim.transition?.phase !== 'released'
        || remote.controlReleased !== true) throw pairError('invalid_transition');
      this.busy = true;
      try {
        const publication = await readReplicaPublication(this.config.snapshotDirectory);
        if (!publication || publication.generation !== this.state.value.accepted?.generation) throw pairError('verification_failed');
        await this.hooks.verifyHandover?.({ dbPath: publication.dbPath, requirements: this.state.value.transition.ocpp });
        await this.hooks.authorizeMqttHandover?.({ dbPath: publication.dbPath, requirements: this.state.value.transition.mqtt,
          token: body.token });
        await this.promote({ handover: true });
        return { ...this.state.claim(), accepted: this.state.value.accepted };
      }
      finally { this.busy = false; }
    }
    if (operation === 'release') {
      const donor = validateSnapshot(body.donor), metadata = validateSnapshot(body.metadata);
      if (!NODE_PATTERN.test(body.requestId ?? '')) throw pairError('invalid_request_id');
      const identity = { requestId: body.requestId, donorEpoch: donor.claim.epoch, donorDigest: donor.digest,
        donorBytes: donor.bytes, generation: metadata.generation, digest: metadata.digest,
        bytes: metadata.bytes, targetEpoch: metadata.claim.epoch, targetNodeId: metadata.claim.nodeId };
      const receipt = this.state.value.releaseReceipt;
      if (receipt?.requestId === body.requestId) {
        if (JSON.stringify(receipt.identity) !== JSON.stringify(identity) || this.state.value.role !== 'slave'
          || this.state.value.epoch !== donor.claim.epoch || this.state.value.everWritten
          || this.state.value.accepted?.epoch !== metadata.claim.epoch || this.state.value.accepted?.sequence < metadata.sequence)
          throw pairError('invalid_transition');
        const publication = await readReplicaPublication(this.config.snapshotDirectory);
        if (publication?.generation !== this.state.value.accepted?.generation || publication.digest !== this.state.value.accepted?.digest) throw pairError('verification_failed');
        await verifySnapshot(publication.dbPath,publication,this.abort.signal);
        return { ...this.state.claim(), accepted: this.state.value.accepted, releaseReceipt: identity, sync: publicSync(this.sync) };
      }
      if (this.busy || !['protected', 'slave'].includes(this.state.value.role)) throw pairError('protected_history');
      if (donor.claim.epoch !== this.state.value.epoch || donor.claim.nodeId !== this.state.value.nodeId ||
          metadata.claim.role !== 'master') throw pairError('authority_changed');
      // A donor that wrote again after the checked snapshot is never erased by
      // a stale recovery completion. The epoch changes on every promotion.
      this.busy = true;
      try {
        this.syncAbort?.abort(pairError('authority_changed')); await this.syncTask;
        const currentDonor = await this.exportSnapshot({ force: true });
        if (currentDonor.digest !== donor.digest || currentDonor.bytes !== donor.bytes) throw pairError('recovery_required');
        await this.state.update({ role: 'protected', release: { epoch: metadata.claim.epoch, digest: metadata.digest, identity }, reason: 'rejoining' });
        const result = await this.installReplica(metadata, { signal: this.abort.signal, allowRelease: true });
        await this.hooks.closeReplica?.();
        const oldPath = this.state.value.activeDbPath;
        await this.state.update({ role: 'slave', reason: null, release: null, transition: null, everWritten: false,
          activeDbPath: null, recovery: null, activationError: null, releaseReceipt: { requestId: body.requestId, identity } });
        this.sync = { state: 'ready', sourceAt: result.sourceAt, verifiedAt: result.verifiedAt, bytes: result.bytes,
          lastSuccessAt: this.clock(), error: null, transferredBytes: result.transferredBytes };
        this.error = null;
        await this.startReplica(result);
        // Only our dedicated former primary files are owned for deletion. The
        // initially configured path may be user-owned and is never reopened.
        if (oldPath?.startsWith(join(this.config.directory, 'master-'))) await rm(oldPath, { force: true });
        return { ...this.state.claim(), accepted: this.state.value.accepted, releaseReceipt: identity, sync: publicSync(this.sync) };
      } finally { this.busy = false; }
    }
    throw pairError('invalid_action');
  }

  prepareShutdown() {
    this.stopping = true;
    clearTimeout(this.timer);
    this.abort.abort(pairError('stopped'));
    this.syncAbort?.abort(pairError('stopped'));
  }

  async close({ preserveState = false } = {}) {
    this.prepareShutdown();
    this.closed = true;
    this.activeAllowed = false;
    await Promise.allSettled([this.peer.close(), this.announcements?.close(), this.releaseTransport()]);
    await Promise.allSettled([this.polling, this.syncTask, this.demoting, ...this.localActions]);
    await this.lock;
    if (!preserveState) await this.state.close();
  }
}
