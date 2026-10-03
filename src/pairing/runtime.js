import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { configurationSource } from '../app/config.js';
import { inheritConfigurationSnapshot } from '../app/configuration-preview.js';
import { startReplica } from '../app/replica.js';
import { createSourceSnapshot } from '../replication/transport.js';
import { durableJson, ownedDirectory, publishSnapshot } from '../replication/publication.js';
import { databaseErrorDetails } from '../storage/database-errors.js';
import { requireLocalBroker } from './config.js';
import { PairManager } from './manager.js';
import { ocppHandoverHooks } from './ocpp.js';
import { archiveRoot, createResetArchive, resumeResetArchive, selectResetDatabase } from './reset-storage.js';
import { resetRestorationStatus } from './reset-safety.js';

const ACTIONS = new Set(['check-recovery', 'recover', 'handover', 'promote', 'rejoin', 'reset']);
const RESET_ERRORS = new Set(['pair_reset_storage_failed', 'pair_reset_unsafe_storage',
  'pair_reset_history_unavailable', 'pair_reset_restoration_required', 'pair_reset_failed']);
const requestError = message => Object.assign(new Error(message), { statusCode: 409, publicMessage: message });

async function prepareAddonVipPolicy(config) {
  if (!config.addon || config.pair.vip.socketPath) return;
  await mkdir('/etc/st-mq-vip', { recursive: true, mode: 0o700 });
  const { interface: networkInterface, address, prefixLength } = config.pair.vip;
  await durableJson('/etc/st-mq-vip/policy.json', { interface: networkInterface, address, prefixLength });
}

/** One machine-local supervisor owns runtime replacement and all command gates. */
export async function startPaired({ config, readConfig, clock = Date.now, providerOptions, mqttOptions,
  startRuntime, installSignalHandlers = true, managerFactory = options => new PairManager(options),
  validateBroker = requireLocalBroker, recoveryModule = () => import('../recovery/service.js'),
  managerOptions = {}, prepareVipPolicy = prepareAddonVipPolicy, snapshotSource = createSourceSnapshot,
  resetStorage = { createResetArchive, resumeResetArchive, selectResetDatabase } } = {}) {
  let runtime = null, manager, closed = false, latestOperation = null;
  let primaryPath = config.dbPath;
  let closing = null;
  let resetPending = null;
  const resetSession = randomUUID();
  const startupAbort = new AbortController();
  let finishStartup;
  const startupSettled = new Promise(resolve => { finishStartup = resolve; });
  const requireOpen = () => { if (closing) throw requestError('The instance is shutting down.'); };
  let runtimeStarting = null, controllerToken = null;
  let replicaAbort = null;
  const operations = new Map(), handlers = new Map();
  const runtimeConfiguration = next => inheritConfigurationSnapshot(next, { ...next, role: 'master', dbPath: primaryPath });
  function resetStatus() {
    const state = manager.state?.value;
    const token = createHash('sha256').update(JSON.stringify([resetSession, state?.nodeId, state?.epoch, state?.role,
      state?.accepted?.generation, state?.transition, state?.recovery?.releaseOperation?.requestId,
      state?.reset, state?.resetReceipt?.requestId])).digest('hex');
    return { token, archiveDirectory: archiveRoot(config), pendingMode: state?.reset?.mode ?? null,
      keepBlockedReason: manager.state?.invalid ? 'invalid_pair_state' : null,
      blockedReason: manager.busy || manager.stopping || runtime?.historyRecovery?.working() || closed || closing || resetPending ? 'busy' : null,
      lastResult: state?.resetReceipt ?? null };
  }
  const context = {
    canControl: () => !closed && Boolean(manager?.canControl()),
    recovering: () => Boolean(runtime?.historyRecovery?.busy()),
    configurationSource: configurationSource(config), runtimeConfiguration,
    status: () => {
      const status = manager.status(), reset = resetStatus();
      const historyBusy = Boolean(runtime?.historyRecovery?.working()), job = runtime?.historyRecovery?.currentJob();
      return { ...status, busy: status.busy || historyBusy,
        actions: { ...Object.fromEntries(Object.entries(status.actions ?? {}).map(([key, allowed]) => [key, allowed && !historyBusy])),
          reset: !reset.blockedReason }, reset,
        ...(latestOperation ? { uiOperation: { ...latestOperation,
          ...(job?.requestId === latestOperation.id && job.progress ? { progress: job.progress } : {}) } } : {}) };
    },
    requestAction(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['action', 'requestId', 'confirmed', 'previewId', 'discardUnrecovered',
          'mode', 'resetToken', 'restorationConfirmed'].includes(key))
        || (input.action !== 'reset' && ['mode', 'resetToken', 'restorationConfirmed'].some(key => key in input))
        || (input.action === 'reset' && (!['keep', 'fresh'].includes(input.mode)
          || typeof input.resetToken !== 'string' || !/^[a-f0-9]{64}$/.test(input.resetToken)
          || ['previewId', 'discardUnrecovered'].some(key => key in input)
          || ('restorationConfirmed' in input && input.restorationConfirmed !== true)))
        || ('discardUnrecovered' in input && (input.action !== 'rejoin' || input.discardUnrecovered !== true))
        || !ACTIONS.has(input.action) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.requestId ?? ''))
        throw requestError('Choose a paired action with a unique request ID.');
      if (input.action !== 'check-recovery' && input.confirmed !== true)
        throw requestError('Confirm this paired action before continuing.');
      if (input.action === 'reset' && input.mode === 'fresh' && input.restorationConfirmed !== true)
        throw requestError('Confirm that temporary equipment changes have been resolved before starting fresh.');
      const previous = operations.get(input.requestId);
      if (previous && !(previous.action === 'rejoin' && input.action === 'rejoin' && previous.state === 'error')) {
        if (previous.action !== input.action || previous.mode !== input.mode) throw requestError('This request ID belongs to another action.');
        latestOperation = previous;
        return context.status();
      }
      const receipt = manager.state?.value?.resetReceipt;
      if (receipt?.requestId === input.requestId) {
        if (input.action !== 'reset' || input.mode !== receipt.mode) throw requestError('This request ID belongs to another action.');
        latestOperation = { id: input.requestId, action: 'reset', mode: receipt.mode, state: 'complete',
          finishedAt: receipt.completedAt, result: receipt };
        return context.status();
      }
      if (closed || closing || context.recovering() || [...operations.values()].some(value => value.state === 'running'))
        throw requestError('A paired operation is already running.');
      if (input.action === 'reset') assertReset(input);
      const operation = { id: input.requestId, action: input.action, ...(input.mode ? { mode: input.mode } : {}), state: 'running', startedAt: clock() };
      operations.set(input.requestId, operation); latestOperation = operation;
      // Let the acceptance response leave the current listener before a handover
      // closes that listener and reopens the read-only view on the same port.
      setImmediate(() => {
        const done = Promise.resolve().then(() => input.action === 'reset' ? resetPairing(input) : manager.action(input.action, input));
        void done.then(result => {
          operation.state = result?.ok === false ? 'error' : 'complete'; operation.finishedAt = clock();
          if (input.action === 'reset') operation.result = result;
          if (result?.ok === false) operation.error = 'This operation did not complete. Review the current state before starting another action.';
        }, error => {
          operation.state = 'error'; operation.finishedAt = clock();
          if (input.action === 'reset') operation.errorCode = RESET_ERRORS.has(error?.code) ? error.code : 'pair_reset_failed';
          operation.error = error?.publicMessage ?? 'The paired operation did not complete. Check its status and retry when ready.';
        }).finally(() => {
          while (operations.size > 64) {
            const oldest = operations.keys().next().value;
            if (operations.get(oldest).state === 'running') break;
            operations.delete(oldest);
          }
        });
      });
      return context.status();
    },
  };
  const hooks = {
    dbPath: () => runtime?.store?.path ?? primaryPath,
    ...ocppHandoverHooks({ configuration: () => context.canControl() && runtime?.engine?.config?.connections
      ? runtime.engine.config : config, store: () => runtime?.store }),
    revokeControl() {
      if (controllerToken) controllerToken.revoked = true;
      runtime?.revokeControl?.();
    },
    async stopControl({ restore = false } = {}) {
      if (!restore) hooks.revokeControl();
      const previous = runtime; runtime = null;
      const token = controllerToken;
      if (token && (!previous || !restore)) token.revoked = true;
      replicaAbort?.abort();
      await previous?.historyRecovery?.close();
      try { await previous?.close({ restore }); }
      finally { if (token) token.revoked = true; }
      await runtimeStarting?.catch(() => {});
    },
    async closeReplica() { const previous = runtime; runtime = null; await previous?.close(); },
    async startPrimary({ dbPath, onWriting } = {}) {
      if (closed || closing) throw requestError('The instance is shutting down.');
      await validateBroker(config.connections.mqtt, { addon: config.addon, vipAddress: config.pair.vip.address });
      if (closed || closing) throw requestError('The instance is shutting down.');
      primaryPath = dbPath ?? primaryPath;
      if (runtime) await hooks.stopControl({ restore: false });
      if (closed || closing) throw requestError('The instance is shutting down.');
      await onWriting?.();
      if (closed || closing) throw requestError('The instance is shutting down.');
      if (!context.canControl()) throw requestError('Controller authority changed before startup.');
      const token = controllerToken = { revoked: false };
      runtimeStarting = startRuntime({ config: runtimeConfiguration(config), readConfig, clock, providerOptions, mqttOptions,
        pairContext: { ...context, canControl: () => !token.revoked && context.canControl() }, installSignalHandlers: false,
        historyRecoveryOptions: { recoveryModule, timeoutMs: config.pair.timeoutMs ?? 3_600_000 },
        shutdownSignal: startupAbort.signal })
        .then(async started => {
          if (closed || closing || token.revoked) { await started.close({ restore: false }); throw requestError('The instance is shutting down.'); }
          runtime = started;
        });
      try { await runtimeStarting; } finally { runtimeStarting = null; }
    },
    async startReplica({ dbPath, role } = {}) {
      if (closed || closing) return;
      if (runtime) await hooks.stopControl({ restore: false });
      if (closed || closing) return;
      replicaAbort = new AbortController();
      const signal = replicaAbort.signal;
      runtimeStarting = (async () => {
        let directory = config.pair.snapshotDirectory;
        if (manager.state?.invalid || manager.state?.value?.reset) {
          // Partial archives are never interpreted as a new database or replica.
          directory = join(config.pair.directory, 'reset-view');
          await ownedDirectory(directory, '.st-mq-reset-view');
        } else if ((role ?? manager.status().role) === 'protected' && dbPath && existsSync(dbPath)) {
          let incoming;
          try {
            directory = join(config.pair.directory, 'protected-view');
            await ownedDirectory(directory, '.st-mq-protected-view');
            const generation = randomUUID(); incoming = join(directory, `incoming-${generation}.sqlite`);
            const snapshot = await snapshotSource({ dbPath, destination: incoming, signal });
            if (closed || closing || signal.aborted) return;
            await publishSnapshot(directory, incoming, { generation, ...snapshot, verifiedAt: clock() });
          } catch (error) {
            if (incoming) for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(`${incoming}${suffix}`, { force: true }).catch(() => {});
            if (closed || closing || signal.aborted) return;
            // Protection and its management UI must survive an unreadable
            // donor. Existing verified history remains available for viewing.
            const database = databaseErrorDetails(error);
            if (database && [null, 'runtime_failed', 'snapshot_failed'].includes(manager.error)) {
              manager.error = database.code;
              manager.reportFailure(error, database.code);
              await manager.state.update({ activationError: database.code });
            } else manager.error ??= 'snapshot_failed';
            directory = config.pair.snapshotDirectory;
          }
        }
        if (closed || closing || signal.aborted) return;
        const started = await startReplica({ config: { ...config, role: 'slave', input: 'offline',
          // The read model needs local equipment mappings and defaults. The
          // viewer never constructs acquisition or control from this config.
          h66: { ...config.h66, enabled: false, writeEnabled: false }, settings: { ...config.settings },
          }, snapshotDirectory: directory, clock, pairContext: context, installSignalHandlers: false });
        if (closed || closing || signal.aborted) await started.close(); else runtime = started;
      })();
      try { await runtimeStarting; } finally { runtimeStarting = null; replicaAbort = null; }
    },
    async recoveryPreview({ donorPath, requestId }) {
      if (!context.canControl() || !runtime?.store) throw requestError('Recovery is available on the active master.');
      return runtime.historyRecovery.checkPath({ donorPath, source: { id: 'peer', kind: 'peer', label: 'Paired computer' },
        requestId });
    },
    async recoveryApply({ donorPath, preview, isCurrent, requestId }) {
      if (!context.canControl() || !runtime?.engine) throw requestError('Recovery is available on the active master.');
      return runtime.historyRecovery.applyPath({ donorPath, preview, isCurrent,
        source: { id: 'peer', kind: 'peer', label: 'Paired computer' }, requestId });
    },
  };
  const makeManager = state => managerFactory({ config: config.pair, hooks, clock, ...managerOptions, ...(state ? { state } : {}) });
  manager = makeManager();

  function assertReset(input) {
    const status = resetStatus();
    if (status.blockedReason || manager.demoting) throw requestError('Wait for the current paired operation to finish before resetting.');
    if (input.resetToken !== status.token) throw requestError('Pairing changed while this confirmation was open. Review the reset again.');
    if (status.pendingMode && input.mode !== status.pendingMode)
      throw requestError('Finish the interrupted reset with its original choice before starting another reset.');
    if (status.keepBlockedReason && input.mode === 'keep')
      throw requestError('The previous pairing state is unreadable. Start fresh archives the configured storage without interpreting that state.');
  }

  async function resetPairing(input) {
    assertReset(input);
    const old = manager;
    old.busy = true;
    old.phase = 'reset';
    resetPending = performReset(old, input);
    try { return await resetPending; }
    finally { resetPending = null; }
  }

  async function performReset(old, input) {
    let original, result, failure;
    try {
      old.prepareShutdown();
      // Retain command authority only for ordinary graceful restoration. It is
      // revoked before archiving, and a completed close alone is not proof that
      // every physical obligation has been resolved.
      await hooks.stopControl({ restore: old.canControl() });
      old.activeAllowed = false;
      await old.vip.release();
      if (old.vip.status().owned !== false) throw requestError('The virtual address could not be released. Pairing was not reset.');
      await old.close({ preserveState: true });
      await old.snapshots.mutations;
      original = structuredClone(old.state.value);
      if (!original.reset && input.mode === 'fresh' && original.everWritten) {
        const source = await resetStorage.selectResetDatabase(config, original).catch(error => {
          if (error.code !== 'pair_reset_history_unavailable') throw error;
          return null; // Unknown history remains opaque; explicit equipment-safe confirmation is required above.
        });
        if (resetRestorationStatus(source) === 'pending')
          throw Object.assign(requestError('Temporary equipment changes still require restoration. Keep local history, or resolve them before starting fresh.'),
            { code: 'pair_reset_restoration_required' });
      }
      requireOpen();
      let journal = original.reset;
      if (!journal) {
        const plan = await resetStorage.createResetArchive({ config, state: original, mode: input.mode,
          requestId: input.requestId, clock });
        journal = { requestId: input.requestId, mode: input.mode, archiveDirectory: plan.archiveDirectory };
        await old.state.beginReset(journal);
      }
      result = await resetStorage.resumeResetArchive(journal.archiveDirectory,
        { config, requestId: journal.requestId, mode: journal.mode });
      const unavailable = (result.recoveryBackups ?? []).filter(item => item.status === 'unavailable');
      const receipt = { ...journal, requestId: input.requestId, completedAt: clock(),
        backupCount: (result.recoveryBackups ?? []).filter(item => item.status === 'complete').length,
        unavailableCount: unavailable.length + (result.recoveryBackupUnavailable ? 1 : 0),
        unavailableReasons: [...new Set([...unavailable.map(item => item.reason), result.recoveryBackupUnavailable].filter(Boolean))] };
      await old.state.resetPairing({ activeDbPath: result.keptDbPath, receipt });
      primaryPath = result.keptDbPath ?? config.dbPath;
      result = receipt;
    } catch (error) {
      failure = error;
      hooks.revokeControl(); old.activeAllowed = false;
      await hooks.stopControl({ restore: false }).catch(() => {});
      await old.vip.release().catch(() => {});
      await old.close({ preserveState: true }).catch(() => {});
      // No failure, including archive I/O or interrupted shutdown, reinstates a
      // former master. The pending journal retains the explicit retry operation.
      await old.state.update({ role: 'protected', reason: old.state.value.reset ? 'pairing_reset_pending' : 'pairing_reset_failed',
        transition: null, activationError: null }).catch(() => {});
    }
    // The same SQLite lock remains held across manager replacement. There is no
    // interval in which another process can adopt these paths during a reset.
    manager = makeManager(old.state);
    if (!closing) {
      try { await manager.init({ stateOpen: true }); await manager.start(); }
      catch (error) { failure ??= error; }
    }
    if (failure) throw failure?.publicMessage ? failure
      : requestError('Pairing reset did not complete. The old files remain preserved. Review the state and retry.');
    return result;
  }

  function close() {
    if (closing) return closing;
    // Manager chooses the appropriate restoring/nonrestoring shutdown while its
    // authority is still available; outer closure follows its gate revocation.
    manager.prepareShutdown?.();
    startupAbort.abort();
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    closing = (async () => {
      await startupSettled;
      if (resetPending) await resetPending.catch(() => {});
      const errors = [];
      try { await hooks.stopControl({ restore: manager.canControl() }); } catch (error) { errors.push(error); }
      try { await manager.close(); } catch (error) { errors.push(error); }
      closed = true;
      if (errors.length) throw new AggregateError(errors, 'Paired cleanup completed with errors.');
    })();
    return closing;
  }
  if (installSignalHandlers) for (const signal of ['SIGTERM', 'SIGINT']) {
    const handler = () => { void close().catch(() => { process.exitCode = 1; }); };
    process.once(signal, handler); handlers.set(signal, handler);
  }
  try {
    await prepareVipPolicy(config);
    requireOpen();
    await manager.init({ allowInvalidState: true });
    requireOpen();
    await manager.start();
    requireOpen();
    finishStartup();
    return { get pair() { return manager; }, get store() { return runtime?.store; }, get engine() { return runtime?.engine; },
      get server() { return runtime?.server; }, get webAccess() { return runtime?.webAccess; }, close,
      status: context.status, requestAction: context.requestAction };
  } catch (error) { finishStartup(); try { await close(); } catch (cleanupError) { error.cleanupError = cleanupError; } throw error; }
}
