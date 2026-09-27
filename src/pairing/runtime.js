import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { configurationSource } from '../app/config.js';
import { startReplica } from '../app/replica.js';
import { createSourceSnapshot } from '../replication/transport.js';
import { durableJson, ownedDirectory, publishSnapshot } from '../replication/publication.js';
import { requireLocalBroker } from './config.js';
import { PairManager } from './manager.js';
import { ocppHandoverHooks } from './ocpp.js';

const ACTIONS = new Set(['check-recovery', 'recover', 'handover', 'promote', 'rejoin']);
const requestError = message => Object.assign(new Error(message), { statusCode: 409 });

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
  managerOptions = {}, prepareVipPolicy = prepareAddonVipPolicy, snapshotSource = createSourceSnapshot } = {}) {
  let runtime = null, manager, closed = false, recoveryRunning = false, latestOperation = null;
  let primaryPath = config.dbPath;
  let closing = null;
  const startupAbort = new AbortController();
  let finishStartup;
  const startupSettled = new Promise(resolve => { finishStartup = resolve; });
  const requireOpen = () => { if (closing) throw requestError('The instance is shutting down.'); };
  let runtimeStarting = null, controllerToken = null;
  let replicaAbort = null;
  let historyAbort = null, historyPending = null;
  function historyJob(operation) {
    historyAbort = new AbortController();
    const signal = AbortSignal.any([historyAbort.signal, AbortSignal.timeout(config.pair.timeoutMs ?? 3600000)]);
    historyPending = Promise.resolve().then(() => operation(signal)).finally(() => {
      historyPending = null; historyAbort = null;
    });
    return historyPending;
  }
  const operations = new Map(), handlers = new Map();
  const runtimeConfiguration = next => ({ ...next, role: 'master', dbPath: primaryPath });
  const context = {
    canControl: () => !closed && Boolean(manager?.canControl()),
    recovering: () => recoveryRunning,
    configurationSource: configurationSource(config), runtimeConfiguration,
    status: () => ({ ...manager.status(), ...(latestOperation ? { uiOperation: latestOperation } : {}) }),
    requestAction(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['action', 'requestId', 'confirmed', 'previewId', 'discardUnrecovered'].includes(key))
        || ('discardUnrecovered' in input && (input.action !== 'rejoin' || input.discardUnrecovered !== true))
        || !ACTIONS.has(input.action) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.requestId ?? ''))
        throw requestError('Choose a paired action with a unique request ID.');
      if (input.action !== 'check-recovery' && input.confirmed !== true)
        throw requestError('Confirm this paired action before continuing.');
      const previous = operations.get(input.requestId);
      if (previous && !(previous.action === 'rejoin' && input.action === 'rejoin' && previous.state === 'error')) {
        if (previous.action !== input.action) throw requestError('This request ID belongs to another action.');
        latestOperation = previous;
        return context.status();
      }
      if (closed || closing || [...operations.values()].some(value => value.state === 'running'))
        throw requestError('A paired operation is already running.');
      const operation = { id: input.requestId, action: input.action, state: 'running', startedAt: clock() };
      operations.set(input.requestId, operation); latestOperation = operation;
      // Let the acceptance response leave the current listener before a handover
      // closes that listener and reopens the read-only view on the same port.
      setImmediate(() => {
        const done = Promise.resolve().then(() => manager.action(input.action, input));
        void done.then(result => {
          operation.state = result?.ok === false ? 'error' : 'complete'; operation.finishedAt = clock();
          if (result?.ok === false) operation.error = 'This operation did not complete. Review the current state before starting another action.';
        }, error => {
          operation.state = 'error'; operation.finishedAt = clock();
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
    async stopControl({ restore = false, preserveOcpp = false } = {}) {
      if (!restore) hooks.revokeControl();
      const previous = runtime; runtime = null;
      const token = controllerToken;
      if (token && (!previous || !restore)) token.revoked = true;
      replicaAbort?.abort();
      historyAbort?.abort();
      await historyPending?.catch(() => {});
      try { await previous?.close({ restore, preserveOcpp }); }
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
        if ((role ?? manager.status().role) === 'protected' && dbPath && existsSync(dbPath)) {
          let incoming;
          try {
            directory = join(config.pair.directory, 'protected-view');
            await ownedDirectory(directory, '.st-mq-protected-view');
            const generation = randomUUID(); incoming = join(directory, `incoming-${generation}.sqlite`);
            const snapshot = await snapshotSource({ dbPath, destination: incoming, signal });
            if (closed || closing || signal.aborted) return;
            await publishSnapshot(directory, incoming, { generation, ...snapshot, verifiedAt: clock() });
          } catch {
            if (incoming) for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(`${incoming}${suffix}`, { force: true }).catch(() => {});
            if (closed || closing || signal.aborted) return;
            // Protection and its management UI must survive an unreadable
            // donor. Existing verified history remains available for viewing.
            manager.error = 'snapshot_failed';
            directory = config.pair.snapshotDirectory;
          }
        }
        if (closed || closing || signal.aborted) return;
        const started = await startReplica({ config: { ...config, role: 'slave', input: 'offline',
          // The read model needs local equipment mappings and defaults. The
          // viewer never constructs acquisition or control from this config.
          h66: { ...config.h66, enabled: false, writeEnabled: false }, settings: { ...config.settings, mode: 'monitoring' },
          }, snapshotDirectory: directory, clock, pairContext: context, installSignalHandlers: false });
        if (closed || closing || signal.aborted) await started.close(); else runtime = started;
      })();
      try { await runtimeStarting; } finally { runtimeStarting = null; replicaAbort = null; }
    },
    async recoveryPreview({ donorPath }) {
      if (!context.canControl() || !runtime?.store) throw requestError('Recovery is available on the active master.');
      const { recoveryPreview } = await recoveryModule();
      const owner = runtime;
      return historyJob(signal => recoveryPreview({ masterPath: owner.store.path, donorPath, signal,
        input: owner.engine.config.input, workDirectory: join(config.pair.directory, 'recovery-work') }));
    },
    async recoveryApply({ donorPath, preview }) {
      if (!context.canControl() || !runtime?.engine) throw requestError('Recovery is available on the active master.');
      const owner = runtime, engine = owner.engine;
      recoveryRunning = true;
      try {
        await engine.closeFireplace(); engine.fireplaceRebuild = null;
        const { recoverHistory } = await recoveryModule();
        return await historyJob(signal => recoverHistory({ store: owner.store, donorPath, input: engine.config.input, preview, signal,
          workDirectory: join(config.pair.directory, 'recovery-work'),
          isCurrent: () => !closed && context.canControl() && runtime === owner && owner.engine === engine,
          onProgress: progress => { if (latestOperation) latestOperation.progress = progress; },
          onPublish: result => {
            engine.checkpoint = result.checkpoint; engine.pendingPlan = null;
            engine.fireplaceRebuild = null;
            engine.fireplaceReserveOverride = null;
          } }));
      } finally { recoveryRunning = false; }
    },
  };
  manager = managerFactory({ config: config.pair, hooks, clock, ...managerOptions });
  function close() {
    if (closing) return closing;
    // Manager chooses the appropriate restoring/nonrestoring shutdown while its
    // authority is still available; outer closure follows its gate revocation.
    manager.prepareShutdown?.();
    startupAbort.abort();
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    closing = (async () => {
      await startupSettled;
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
    await manager.init();
    requireOpen();
    await manager.start();
    requireOpen();
    finishStartup();
    return { pair: manager, get store() { return runtime?.store; }, get engine() { return runtime?.engine; },
      get server() { return runtime?.server; }, get webAccess() { return runtime?.webAccess; }, close,
      status: context.status, requestAction: context.requestAction };
  } catch (error) { finishStartup(); try { await close(); } catch (cleanupError) { error.cleanupError = cleanupError; } throw error; }
}
