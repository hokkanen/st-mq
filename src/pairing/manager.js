import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { lstat, open, rm } from 'node:fs/promises';
import { acceptsLineage, compareAuthority, NODE_PATTERN, PairState, pairError, validClaim } from './state.js';
import { PairPeer, publicPairError } from './peer.js';
import { receiveSnapshot, SnapshotRepository, validateSnapshot, verifySnapshot } from './snapshots.js';
import { VirtualIP } from './vip.js';
import { createControllerAnnouncements } from './announcements.js';
import { copySnapshot, ownedDirectory, readReplicaPublication, syncDirectory } from '../replication/publication.js';

const ACTIONS = new Set(['handover', 'promote', 'check-recovery', 'recover', 'rejoin']);

/** Node-local authority is deliberately never part of the mirrored application DB. */
export class PairManager {
  constructor({ config, hooks = {}, clock = Date.now, vip, peer, state, snapshots, announcements }) {
    this.config = config;
    this.hooks = hooks;
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
    this.sync = { state: 'waiting', sourceAt: null, verifiedAt: null, lastSuccessAt: null, error: null };
    this.lock = Promise.resolve();
    this.abort = new AbortController();
    this.localActions = new Set();
  }

  async init() {
    await this.state.open();
    await this.snapshots.init();
    await ownedDirectory(this.config.replicaDirectory, '.st-mq-replica');
    const marker = await open(join(this.config.replicaDirectory, '.st-mq-paired-receiver'), 'a', 0o600);
    await marker.sync(); await marker.close(); await syncDirectory(this.config.replicaDirectory);
    // Old standalone publications lack a branch ancestry proof. Existing paired
    // publications must also match the durable accepted record after a restart.
    const publication = await readReplicaPublication(this.config.replicaDirectory).catch(() => false);
    const pending = this.state.value.pendingReplica;
    let publicationVerified = false;
    if (this.state.value.role === 'replica' && publication && pending && publication.generation === pending.generation &&
        publication.digest === pending.digest && acceptsLineage(this.state.value.accepted, pending.claim)) {
      // The immutable publication may have committed immediately before a
      // crash, while the separate node-state acknowledgement had not.
      try {
        await verifySnapshot(publication.dbPath, publication, this.abort.signal);
        publicationVerified = true;
        await this.state.update({ pendingReplica: null, accepted: { generation: publication.generation,
          digest: publication.digest, epoch: pending.claim.epoch, sequence: pending.sequence, nodeId: pending.claim.nodeId } });
      } catch { await this.state.update({ role: 'protected', reason: 'replica_verification_failed' }); }
    }
    if (this.state.value.role === 'replica' && (publication === false || publication &&
        (!this.state.value.accepted || publication.generation !== this.state.value.accepted.generation))) {
      await this.state.update({ role: 'protected', reason: 'unclassified_local_history' });
    }
    if (this.state.value.role === 'replica' && publication && this.state.value.accepted) {
      try {
        if (publication.digest !== this.state.value.accepted.digest) throw pairError('verification_failed');
        if (!publicationVerified) await verifySnapshot(publication.dbPath, publication, this.abort.signal);
      } catch {
        await this.state.update({ role: 'protected', reason: 'replica_verification_failed' });
      }
    }
    if (this.state.value.recovery?.state === 'recovering') {
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
    await this.peer.start();
    try {
      if (this.state.value.role === 'primary' && !this.state.value.transition) await this.startPrimary();
      else {
        if (this.state.value.role === 'primary') await this.state.update({ role: 'protected', reason: 'interrupted_handover' });
        await this.vip.release();
        await this.startReplica();
      }
    } catch (error) {
      if (this.state.value.epoch === startingEpoch) {
        this.activeAllowed = false;
        this.error = publicPairError(error);
        await this.vip.release().catch(() => {});
        if (!this.activationFallbackReady || this.state.value.role !== 'protected') throw error;
      } else if (!this.canControl() && this.state.value.role !== 'protected') throw error;
    }
    this.announcements = this.announcementsFactory(this.config, {
      claim: () => this.canControl() ? this.state.claim() : { ...this.state.claim(), role: this.state.value.role === 'primary' ? 'protected' : this.state.value.role },
      onConflict: claim => this.observeClaim(claim), clock: this.clock,
    });
    this.announcements?.start();
    this.schedule(0);
    return this;
  }

  canControl() { return !this.closed && this.activeAllowed && this.state.value?.role === 'primary'; }

  serialized(action) {
    const task = this.lock.then(action);
    this.lock = task.catch(() => {});
    return task;
  }

  async startPrimary() {
    if (this.stopping || this.closed) throw pairError('stopped');
    const activationEpoch = this.state.value.epoch, activationDbPath = this.state.value.activeDbPath;
    const ownsActivation = () => this.state.value.epoch === activationEpoch;
    this.activationFallbackReady = false;
    let code = 'vip_failed';
    try {
      await this.vip.acquire();
      if (this.stopping || this.closed) throw pairError('stopped');
      if (!ownsActivation()) throw pairError('authority_changed');
      this.activeAllowed = true;
      code = 'runtime_failed';
      await this.hooks.startPrimary?.({ dbPath: activationDbPath,
        onWriting: async () => {
          if (this.stopping || this.closed || this.state.value.role !== 'primary' || !ownsActivation()) throw pairError('stopped');
          await this.state.update(value => {
            if (value.epoch !== activationEpoch || value.role !== 'primary') throw pairError('authority_changed');
            return { bootstrapPending: false };
          });
          if (this.stopping || this.closed || this.state.value.role !== 'primary' || !ownsActivation()) throw pairError('stopped');
        } });
      if (!this.canControl() || !ownsActivation()) throw pairError('authority_changed');
      await this.state.update(value => {
        if (value.epoch !== activationEpoch || value.role !== 'primary') throw pairError('authority_changed');
        return { bootstrapPending: false };
      });
    } catch (error) {
      if (!ownsActivation()) throw pairError('authority_changed');
      this.activeAllowed = false;
      await this.vip.release().catch(() => {});
      if (this.stopping || this.closed) throw pairError('stopped');
      if (!ownsActivation()) throw pairError('authority_changed');
      if (this.demoting) {
        await this.demoting;
        this.activationFallbackReady = true;
        throw pairError(code);
      }
      await this.serialized(() => this.state.update(value => {
        if (value.epoch !== activationEpoch) throw pairError('authority_changed');
        return { role: 'protected', reason: 'activation_failed', transition: null, release: null };
      }));
      this.error = code;
      await this.hooks.stopControl?.({ restore: false });
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
      error: recovery.error ?? null };
  }

  status() {
    const local = this.state.value;
    if (!local) return { enabled: true, role: 'protected', canControl: false, busy: true, phase: 'initializing', actions: {} };
    const recovery = this.publicRecovery();
    const primary = local.role === 'primary' && this.canControl();
    const free = !this.busy && !this.closed && !this.stopping;
    return { enabled: true, ...this.state.claim(), canControl: this.canControl(), busy: this.busy,
      phase: this.phase, error: this.error, vip: this.vip.status(), peer: { ...this.peerState }, sync: { ...this.sync },
      recovery, recentActions: local.actions.map(({ requestId, name, state, error, startedAt, finishedAt }) =>
        ({ requestId, name, state, error, startedAt, finishedAt })),
      actions: { handover: free && primary && this.peerState.reachable && this.peerState.role === 'replica',
        promote: free && (local.role === 'replica' && !!local.accepted || local.role === 'protected' && local.everWritten && !!local.activeDbPath),
        'check-recovery': free && primary && this.peerState.reachable && this.peerState.role !== 'primary',
        recover: free && primary && recovery.state === 'ready',
        rejoin: free && primary && recovery.state === 'complete' && this.peerState.reachable } };
  }

  schedule(delay) {
    if (this.closed || this.stopping) return;
    this.timer = setTimeout(() => {
      this.polling = this.poll().finally(() => this.schedule(2000));
    }, delay);
    this.timer.unref();
  }

  async poll() {
    try {
      const result = await this.peer.request('status', { claim: this.state.claim() }, { signal: this.abort.signal });
      if (!validClaim(result.claim)) throw pairError('invalid_claim');
      this.peerState = { reachable: true, lastSeenAt: this.clock(), ...result.claim };
      await this.observeClaim(result.claim);
      if (!this.busy && !this.syncTask && this.state.value.role === 'replica' && result.claim.role === 'primary' &&
          (!this.nextSyncAt || this.nextSyncAt <= this.clock())) {
        this.syncTask = this.synchronize(result.claim).finally(() => { this.syncTask = null; });
      }
    } catch (error) {
      this.peerState = { ...this.peerState, reachable: false };
      this.sync.error = publicPairError(error);
    }
  }

  async observeClaim(claim) {
    if (!validClaim(claim)) throw pairError('invalid_claim');
    if (this.closed || claim.role !== 'primary' || this.state.value.role !== 'primary') return;
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
      let persistenceError;
      try {
        await this.serialized(async () => {
          if (this.state.value.role !== 'primary') return;
          await this.state.update({ role: 'protected', reason, release: null, transition: null });
        });
      } catch (error) { persistenceError = error; }
      await Promise.allSettled([this.vip.release(), this.hooks.stopControl?.({ restore: false })]);
      if (persistenceError) { this.error = 'invalid_pair_state'; throw persistenceError; }
      if (!this.closed) await this.startReplica();
    })();
    this.demoting = task;
    try { await task; } finally { this.demoting = null; }
  }

  async assertReplica(claim, { allowRelease = false } = {}) {
    const local = this.state.value;
    const released = allowRelease && local.role === 'protected' && local.release?.epoch === claim.epoch;
    if (this.closed || local.role !== 'replica' && !released) throw pairError('protected_history');
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
      let metadata = this.state.value.pendingReplica;
      if (!metadata || metadata.claim?.epoch !== claim.epoch) {
        metadata = validateSnapshot(await this.peer.request('snapshot', {}, { signal, timeoutMs: this.config.timeoutMs }));
        await this.state.update({ pendingReplica: metadata });
      } else validateSnapshot(metadata);
      if (metadata.claim.role !== 'primary' || metadata.claim.epoch !== claim.epoch) throw pairError('authority_changed');
      const result = await this.installReplica(metadata, { signal });
      this.sync = { state: 'ready', sourceAt: result.sourceAt, verifiedAt: result.verifiedAt, bytes: result.bytes,
        lastSuccessAt: this.clock(), error: null, transferredBytes: result.transferredBytes };
    } catch (error) {
      this.sync = { ...this.sync, state: 'error', error: publicPairError(error) };
      if (['snapshot_unavailable', 'authority_changed'].includes(error?.code)) await this.state.update({ pendingReplica: null });
    }
    finally { this.nextSyncAt = this.clock() + (this.config.intervalMs ?? 60000); this.syncAbort = null; }
  }

  async installReplica(metadata, { signal, allowRelease = false } = {}) {
    const guard = () => this.assertReplica(metadata.claim, { allowRelease });
    return receiveSnapshot({ directory: this.config.replicaDirectory, metadata, peer: this.peer, signal, guard,
      onProgress: value => { this.sync = { ...this.sync, ...value }; },
      commit: action => this.serialized(async () => {
        await guard();
        // Check the sender is still authoritative just before publication.
        const remote = await this.peer.request('status', { claim: this.state.claim() }, { signal });
        if (remote.claim?.role !== 'primary' || remote.claim.epoch !== metadata.claim.epoch) throw pairError('authority_changed');
        const result = await action();
        await this.state.update({ pendingReplica: null, accepted: { generation: result.generation, digest: result.digest,
          epoch: metadata.claim.epoch, sequence: metadata.sequence, nodeId: metadata.claim.nodeId } });
        return result;
      }) });
  }

  async exportSnapshot({ force = false } = {}) {
    let local = this.state.value;
    if (local.role === 'replica' || local.role === 'protected' && (!local.everWritten || !local.activeDbPath)) {
      const publication = await readReplicaPublication(this.config.replicaDirectory);
      if (!publication) throw pairError('snapshot_unavailable');
      return this.snapshots.create({ dbPath: publication.dbPath, claim: this.state.claim(), sequence: local.sequence,
        signal: this.abort.signal, force });
    }
    if (local.role === 'primary') {
      await this.prepareExportStamp();
      local = this.state.value;
    }
    const epoch = local.epoch;
    return this.snapshots.create({ dbPath: local.activeDbPath ?? this.hooks.dbPath?.(), claim: this.state.claim(),
      sequence: this.state.value.sequence, signal: this.abort.signal, force,
      assertSource: () => { if (this.closed || this.state.value.epoch !== epoch) throw pairError('authority_changed'); } });
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
      if (local.role !== 'primary') throw pairError('not_primary');
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
    if (!ACTIONS.has(name)) throw pairError('invalid_action');
    if (!NODE_PATTERN.test(body.requestId ?? '')) throw pairError('invalid_request_id');
    const previous = this.state.value.actions.find(item => item.requestId === body.requestId);
    if (previous) {
      if (previous.name !== name) throw pairError('invalid_request_id');
      return { ok: previous.state === 'complete', duplicate: true, status: this.status() };
    }
    if (name !== 'check-recovery' && body.confirmed !== true) throw pairError('confirmation_required');
    if (this.busy || this.demoting) throw pairError('peer_busy');
    this.busy = true;
    this.phase = name;
    this.error = null;
    try {
      await this.state.update(value => ({ actions: [...value.actions.slice(-31),
        { requestId: body.requestId, name, state: 'running', startedAt: this.clock() }] }));
      this.syncAbort?.abort(pairError('authority_changed'));
      await this.syncTask;
      if (name === 'promote') await this.promote();
      else if (name === 'handover') await this.handover();
      else if (name === 'check-recovery') await this.checkRecovery();
      else if (name === 'recover') await this.recover(body);
      else await this.rejoin();
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
    if (!handover && this.state.value.role === 'protected' && this.state.value.bootstrapPending && !this.state.value.accepted) {
      let present;
      try { present = await lstat(this.state.value.activeDbPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!present) {
        await this.hooks.closeReplica?.();
        await this.state.update({ role: 'primary', epoch: randomUUID(), sequence: 0, ancestors: [],
          reason: null, transition: null, release: null, recovery: null, dbStamp: null, pendingStamp: null });
        await this.startPrimary();
        return;
      }
    }
    if (this.state.value.role === 'protected' && this.state.value.everWritten && this.state.value.activeDbPath && !handover) {
      const source = await this.exportSnapshot({ force: true });
      await verifySnapshot(join(this.snapshots.directory, `export-${source.generation}.sqlite`), source, this.abort.signal);
      await this.hooks.closeReplica?.();
      const epoch = randomUUID();
      await this.serialized(() => this.state.update({ role: 'primary', epoch, sequence: 0,
        ancestors: [...this.state.value.ancestors, { epoch: source.claim.epoch, sequence: source.sequence }],
        reason: null, transition: null, release: null, recovery: null, dbStamp: null, pendingStamp: null }));
      await this.startPrimary();
      return;
    }
    if (this.state.value.role !== 'replica' || !this.state.value.accepted) throw pairError('protected_history');
    const publication = await readReplicaPublication(this.config.replicaDirectory);
    if (!publication || publication.generation !== this.state.value.accepted.generation) throw pairError('verification_failed');
    await verifySnapshot(publication.dbPath, publication, this.abort.signal);
    await this.hooks.closeReplica?.();
    const epoch = randomUUID(), destination = join(this.config.directory, `primary-${epoch}.sqlite`);
    await copySnapshot(publication.dbPath, destination);
    const file = await open(destination, 'r'); await file.sync(); await file.close(); await syncDirectory(this.config.directory);
    const ancestors = [...(publication.claim?.ancestors ?? []),
      { epoch: this.state.value.accepted.epoch, sequence: this.state.value.accepted.sequence }];
    await this.serialized(() => this.state.update({ role: 'primary', epoch, sequence: 0,
      ancestors, activeDbPath: destination, everWritten: true, reason: null, transition: null, release: null,
      recovery: null, dbStamp: null, pendingStamp: null }));
    await this.startPrimary();
    if (!handover) this.nextSyncAt = 0;
  }

  async handover() {
    if (!this.canControl()) throw pairError('not_primary');
    const claim = this.state.claim(), token = randomUUID();
    const remote = await this.peer.request('handover-prepare', { claim, token });
    if (remote.role !== 'replica') throw pairError('invalid_transition');
    await this.state.update({ transition: { kind: 'handover', phase: 'stopping', token, peerNodeId: remote.nodeId } });
    try {
      // Graceful restoration is allowed until it is flushed. Authority-loss
      // demotion can still synchronously revoke the gate during this await.
      await this.hooks.stopControl?.({ restore: true });
      this.activeAllowed = false;
      await this.vip.release();
      if (this.state.value.role !== 'primary') throw pairError('authority_changed');
      const metadata = await this.exportSnapshot({ force: true });
      await this.peer.request('handover-stage', { token, metadata }, { timeoutMs: this.config.timeoutMs });
      await this.serialized(() => this.state.update({ role: 'protected', reason: 'handover_released',
        transition: { kind: 'handover', phase: 'released', token, peerNodeId: remote.nodeId, generation: metadata.generation } }));
      const activated = await this.peer.request('handover-activate', { token }, { timeoutMs: this.config.timeoutMs });
      if (activated.role !== 'primary' || activated.accepted?.generation !== metadata.generation) throw pairError('invalid_transition');
      // The peer accepted the exact final copy. There is no independent history
      // left to recover; normal lineage gating can now follow its new branch.
      await receiveSnapshot({ directory: this.config.replicaDirectory, metadata,
        peer: { request: (operation, body) => operation === 'snapshot-hashes' ? this.snapshots.hashes(body) : this.snapshots.chunk(body) },
        signal: this.abort.signal, guard: async () => {
          if (this.state.value.role !== 'protected' || this.state.value.transition?.token !== token) throw pairError('authority_changed');
        }, commit: action => this.serialized(action) });
      await this.state.update({ role: 'replica', reason: null, transition: null, everWritten: false, activeDbPath: null, accepted: {
        generation: metadata.generation, digest: metadata.digest, epoch: metadata.claim.epoch,
        sequence: metadata.sequence, nodeId: metadata.claim.nodeId } });
      await this.startReplica();
      this.nextSyncAt = 0;
    } catch (error) {
      this.activeAllowed = false;
      await this.state.update({ role: 'protected', reason: 'interrupted_handover' });
      await this.vip.release().catch(() => {});
      await this.startReplica();
      throw error;
    }
  }

  async checkRecovery() {
    if (!this.canControl()) throw pairError('not_primary');
    if (!this.hooks.recoveryPreview) throw pairError('recovery_unavailable');
    await this.state.update({ recovery: { state: 'checking' } });
    try {
      const metadata = validateSnapshot(await this.peer.request('snapshot', { force: true }, { timeoutMs: this.config.timeoutMs }));
      if (metadata.claim.role === 'primary') throw pairError('authority_changed');
      const donor = await receiveSnapshot({ directory: join(this.config.directory, 'recovery'), metadata,
        peer: this.peer, signal: this.abort.signal, publish: false,
        guard: async () => { if (!this.canControl()) throw pairError('not_primary'); } });
      const preview = await this.hooks.recoveryPreview({ donorPath: donor.dbPath });
      preview.previewId ??= randomUUID();
      await this.state.update({ recovery: { state: 'ready', metadata, donorPath: donor.dbPath, preview } });
    } catch (error) {
      await this.state.update({ recovery: { state: 'error', error: publicPairError(error) } });
      throw error;
    }
  }

  async recover(body) {
    if (!this.canControl()) throw pairError('not_primary');
    const recovery = this.state.value.recovery;
    if (recovery?.state !== 'ready' || body.previewId !== recovery.preview.previewId) throw pairError('invalid_transition');
    if (!this.hooks.recoveryApply) throw pairError('recovery_unavailable');
    await this.state.update({ recovery: { ...recovery, state: 'recovering' } });
    try {
      const report = await this.hooks.recoveryApply({ donorPath: recovery.donorPath, preview: recovery.preview,
        isCurrent: () => this.canControl() });
      if (!this.canControl()) throw pairError('authority_changed');
      await this.state.update({ recovery: { ...recovery, state: 'complete', report: report.report ?? report } });
    } catch (error) {
      await this.state.update({ recovery: { ...recovery, state: 'error', error: publicPairError(error) } });
      throw error;
    }
  }

  async rejoin() {
    if (!this.canControl()) throw pairError('not_primary');
    const recovery = this.state.value.recovery;
    if (recovery?.state !== 'complete') throw pairError('recovery_required');
    const metadata = await this.exportSnapshot({ force: true });
    const result = await this.peer.request('release', { donor: recovery.metadata, metadata }, { timeoutMs: this.config.timeoutMs });
    if (result.role !== 'replica' || result.accepted?.digest !== metadata.digest) throw pairError('verification_failed');
    await this.state.update({ recovery: { state: 'resolved', report: recovery.report } });
    await rm(recovery.donorPath, { force: true });
    this.peerState = { ...this.peerState, ...result, reachable: true, lastSeenAt: this.clock() };
  }

  async handlePeer(operation, body) {
    if (this.closed || this.stopping) throw pairError('stopped');
    if (operation === 'status') {
      if (body.claim) {
        await this.observeClaim(body.claim);
        this.peerState = { reachable: true, lastSeenAt: this.clock(), ...body.claim };
      }
      return { claim: this.state.claim() };
    }
    if (operation === 'snapshot') return this.exportSnapshot(body);
    if (operation === 'snapshot-hashes') return this.snapshots.hashes(body);
    if (operation === 'snapshot-chunk') return this.snapshots.chunk(body);
    if (operation === 'handover-prepare') {
      if (!validClaim(body.claim) || body.claim.role !== 'primary' || !NODE_PATTERN.test(body.token ?? '')) throw pairError('invalid_transition');
      await this.assertReplica(body.claim);
      if (this.busy) throw pairError('peer_busy');
      await this.state.update({ transition: { kind: 'handover', phase: 'prepared', token: body.token,
        peerNodeId: body.claim.nodeId, epoch: body.claim.epoch } });
      return this.state.claim();
    }
    if (operation === 'handover-stage') {
      if (this.busy || this.state.value.transition?.token !== body.token || this.state.value.role !== 'replica') throw pairError('invalid_transition');
      const metadata = validateSnapshot(body.metadata);
      if (metadata.claim.epoch !== this.state.value.transition.epoch) throw pairError('authority_changed');
      this.busy = true;
      try {
        this.syncAbort?.abort(pairError('authority_changed')); await this.syncTask;
        await this.installReplica(metadata, { signal: this.abort.signal });
        await this.state.update({ transition: { ...this.state.value.transition, phase: 'staged' } });
        return this.state.claim();
      } finally { this.busy = false; }
    }
    if (operation === 'handover-activate') {
      if (this.state.value.transition?.token !== body.token || this.state.value.transition.phase !== 'staged') throw pairError('invalid_transition');
      if (this.busy) throw pairError('peer_busy');
      const remote = await this.peer.request('status', { claim: this.state.claim() });
      if (remote.claim?.role !== 'protected' || remote.claim.transition?.phase !== 'released') throw pairError('invalid_transition');
      this.busy = true;
      try { await this.promote({ handover: true }); return { ...this.state.claim(), accepted: this.state.value.accepted }; }
      finally { this.busy = false; }
    }
    if (operation === 'release') {
      if (this.busy || !['protected', 'replica'].includes(this.state.value.role)) throw pairError('protected_history');
      const donor = validateSnapshot(body.donor), metadata = validateSnapshot(body.metadata);
      if (donor.claim.epoch !== this.state.value.epoch || donor.claim.nodeId !== this.state.value.nodeId ||
          metadata.claim.role !== 'primary') throw pairError('authority_changed');
      // A donor that wrote again after the checked snapshot is never erased by
      // a stale recovery completion. The epoch changes on every promotion.
      this.busy = true;
      try {
        this.syncAbort?.abort(pairError('authority_changed')); await this.syncTask;
        const currentDonor = await this.exportSnapshot({ force: true });
        if (currentDonor.digest !== donor.digest || currentDonor.bytes !== donor.bytes) throw pairError('recovery_required');
        await this.state.update({ role: 'protected', release: { epoch: metadata.claim.epoch, digest: metadata.digest }, reason: 'rejoining' });
        const result = await this.installReplica(metadata, { signal: this.abort.signal, allowRelease: true });
        await this.hooks.closeReplica?.();
        const oldPath = this.state.value.activeDbPath;
        await this.state.update({ role: 'replica', reason: null, release: null, transition: null, everWritten: false,
          activeDbPath: null, recovery: null });
        await this.startReplica(result);
        // Only our dedicated former primary files are owned for deletion. The
        // initially configured path may be user-owned and is never reopened.
        if (oldPath?.startsWith(join(this.config.directory, 'primary-'))) await rm(oldPath, { force: true });
        return { ...this.state.claim(), accepted: this.state.value.accepted };
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

  async close() {
    this.prepareShutdown();
    this.closed = true;
    this.activeAllowed = false;
    await Promise.allSettled([this.peer.close(), this.announcements?.close(), this.vip.release()]);
    await Promise.allSettled([this.polling, this.syncTask, this.demoting, ...this.localActions]);
    await this.lock;
    await this.state.close();
  }
}
