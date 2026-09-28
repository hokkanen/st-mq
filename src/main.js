import { weatherAcquisitionIdentity } from './acquisition/weather-identity.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { Store } from './storage/store.js';
import { loadConfig, configurationReader, configurationSource } from './app/config.js';
import { Engine } from './app/engine.js';
import { createEquipmentTests } from './app/equipment-tests.js';
import { createWebAccess } from './app/web-access.js';
import { startHistoryLearning } from './app/learning.js';
import { createChartService } from './app/chart-service.js';
import { prepareStorage } from './app/storage-paths.js';
import { createHeatingTransport } from './control/mqtt.js';
import { standaloneAuthority, stoppedControllerViewer } from './control/authority.js';
import { createRuntimeTiming } from './app/runtime-timing.js';

export async function start({ config = loadConfig(), readConfig = configurationReader(config),
  clock = Date.now, providerOptions = {}, mqttOptions = {}, pairContext = null, pairOptions = {},
  installSignalHandlers = true, shutdownSignal = null } = {}) {
  const validateTopology = candidate => {
    if (!['standalone', 'mirror', 'pair'].includes(candidate.topology ?? 'standalone')) throw new Error('Invalid local topology');
    if (candidate.role !== undefined && !['master', 'slave'].includes(candidate.role)) throw new Error('Invalid local instance role');
    if ((candidate.topology ?? 'standalone') === 'standalone' && candidate.role === 'slave' && !pairContext)
      throw new Error('Standalone topology requires the master role');
  };
  validateTopology(config);
  const started = performance.now();
  const source = pairContext?.configurationSource ?? (readConfig === configurationReader(config) ? configurationSource(config) : null);
  let startupImport = null;
  if (config.addon && source && !pairContext) {
    startupImport = await source.prepare({ startup: true });
    config = startupImport.config;
    validateTopology(config);
    await startupImport.persist();
  }
  if (config.topology === 'pair' && !pairContext) {
    const { startPaired } = await import('./pairing/runtime.js');
    const app = await startPaired({ config, readConfig, clock, providerOptions, mqttOptions,
      startRuntime: start, installSignalHandlers, ...pairOptions });
    if (startupImport) await startupImport.complete().catch(() => {});
    return app;
  }
  // A slave never opens the live Store or constructs a controller. Mirror roles
  // come from local configuration; pair roles come from the pair supervisor.
  if (config.role === 'slave') {
    const { startReplica } = await import('./app/replica.js');
    const app = await startReplica({ config, clock, pairContext, installSignalHandlers });
    if (startupImport) {
      try { await startupImport.complete(); }
      catch { /* The retained import can be retried on restart. */ }
    }
    return app;
  }
  await prepareStorage(config);
  const store = new Store(config.dbPath);
  const runtimeTiming = createRuntimeTiming();
  let engine, webAccess, learning, chartService, commandTransport, replication, authority, timer, garageSafetyTimer, closed = false, reloadPending = null;
  let runtimeUsable = true, starting = true, configurationResult = null;
  let authorityStopping = null, controlRevoked = false;
  const acquisitions = [];
  const canControl = () => !controlRevoked && (pairContext?.canControl?.() ?? true) && (authority?.canControl() ?? true);
  const requireRunning = () => {
    if (closed) throw new Error('The application is shutting down.');
    if (!canControl()) throw new Error('Controller authority was revoked. This instance is read-only.');
  };
  const signalHandlers = new Map();
  let finishStartup, closePending = null, runtimeStopPending = null;
  const startupSettled = new Promise(resolve => { finishStartup = resolve; });
  const abortStartup = () => { void close().catch(() => { process.exitCode = 1; }); };
  function reportControllerError(error) {
    const databaseBusy = error?.code === 'ERR_SQLITE_ERROR' && [5, 6].includes(error.errcode & 0xff);
    if (!databaseBusy) {
      try { store.event('controller-error', { message: error.message }, clock()); return; }
      catch { /* Reporting must survive an unavailable database too. */ }
    }
    // A failed write cannot reliably report itself with another database write.
    // Keep stderr useful without exposing arbitrary errors or private payloads.
    console.error(JSON.stringify({ event: 'controller-error',
      reason: databaseBusy ? 'database-busy' : 'controller-tick-failed', eventStored: false }));
  }
  function close({ restore = true, preserveOcpp = false } = {}) {
    if (closePending) return closePending;
    closed = true;
    runtimeUsable = false;
    if (engine) engine.suspended = true;
    clearTimeout(timer);
    clearInterval(garageSafetyTimer);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    shutdownSignal?.removeEventListener('abort', abortStartup);
    closePending = (async () => {
      const errors = [];
      const attempt = async fn => { try { return await fn(); } catch (error) { errors.push(error); } };
      // Startup continuations see closed before using any newly acquired resource.
      await startupSettled;
      const replicationStopped = attempt(() => replication?.stop());
      await reloadPending?.catch(() => {});
      await authorityStopping?.catch(() => {});
      await attempt(() => stopRuntime({ restore, preserveOcpp }));
      await attempt(() => authority?.close());
      await replicationStopped;
      await attempt(() => chartService?.close());
      await attempt(() => webAccess?.close());
      await attempt(() => store.close());
      runtimeTiming.close();
      if (errors.length) throw new AggregateError(errors, 'Application cleanup completed with errors; required restoration may remain pending.');
    })();
    return closePending;
  }
  function stopRuntime({ restore = true, preserveOcpp = false } = {}) {
    restore = restore && canControl();
    clearTimeout(timer);
    clearInterval(garageSafetyTimer);
    // Revocation starts before any slow feature cleanup. MQTT queues cannot wait
    // for a charging HTTP response before learning that this controller lost authority.
    const revoked = [];
    if (!restore) {
      const cancel = fn => { try { revoked.push(Promise.resolve(fn()).then(()=>null,error=>error)); } catch(error) { revoked.push(Promise.resolve(error)); } };
      cancel(() => commandTransport?.close());
      for (const acquisition of acquisitions.splice(0)) {
        cancel(() => acquisition.revoke?.());
        cancel(() => acquisition.close({ restore: false }));
      }
    }
    if (runtimeStopPending) {
      if (!revoked.length) return runtimeStopPending;
      const previous = runtimeStopPending;
      runtimeStopPending = (async () => {
        const results = await Promise.allSettled([previous, ...revoked]);
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : result.value instanceof Error ? [result.value] : []);
        if (errors.length) throw new AggregateError(errors, 'Runtime revocation completed with errors.');
      })();
      return runtimeStopPending;
    }
    runtimeStopPending = (async () => {
      const errors = [];
      const attempt = async fn => { try { return await fn(); } catch (error) { errors.push(error); } };
      // Normal exit relinquishes native OCPP while the charger controller,
      // listener, authenticated cloud transport and write authority still exist.
      // Paired handover carries that same native session to the next master.
      if (restore && !preserveOcpp) for (const acquisition of acquisitions)
        await attempt(() => acquisition.restoreOcpp?.());
      await engine?.automationChangePromise?.catch(() => {});
      await attempt(() => engine?.charging?.close());
      await attempt(() => engine?.garage?.close({ restore }));
      if (engine) engine.onTemporaryChange = null;
      await attempt(() => engine?.equipmentTests?.close({ restore }));
      // Always release manager timers even if its physical restoration failed.
      await attempt(() => engine?.equipmentTests?.close({ restore: false }));
      if (engine?.heatingTestBusy) await attempt(() => commandTransport?.close());
      await engine?.dispatchPending?.catch(() => {});
      await attempt(() => engine?.closeFireplace());
      await attempt(() => engine?.executor?.close?.({ restore }));
      await attempt(() => commandTransport?.close());
      for (const acquisition of acquisitions.splice(0)) await attempt(() => acquisition.close({ restore }));
      for (const error of await Promise.all(revoked)) if (error) errors.push(error);
      await attempt(() => learning?.close()); learning = null;
      await attempt(() => engine?.recorder.flush(clock(), { force: true }));
      commandTransport = null;
      if (errors.length) throw new AggregateError(errors, 'Runtime cleanup completed with errors; required restoration may remain pending.');
    })();
    return runtimeStopPending;
  }
  function revokeControl() {
    controlRevoked = true;
    runtimeUsable = false;
    if (engine) engine.suspended = true;
    authorityStopping ??= stopRuntime({ restore: false });
    authorityStopping.catch(() => {});
    return authorityStopping;
  }
  async function createRuntime() {
    requireRunning();
    runtimeStopPending = null;
    await authority?.reconfigure(config.connections.mqtt);
    requireRunning();
    if (['mqtt', 'providers'].includes(config.input) && config.connections.mqtt?.address) {
      commandTransport = createHeatingTransport({ connection: config.connections.mqtt, connect: mqttOptions.connect,
        canControl });
    }
    engine = new Engine({ store, config, clock, commandTransport, canControl });
    engine.runtimeTiming = runtimeTiming.status;
    // Load durable native-setting obligations before the first active dispatch.
    // MQTT connection and device publications remain asynchronous.
    const hasMqttObservations = Boolean(engine.charging?.mqttRoutes().length) || config.h66?.deviceId || config.deviceId
      || config.connections.teslamate?.enabled === true
      || engine.charging?.configuration?.chargers?.charger2?.enabled === true
      || Boolean(config.garage?.adapter?.stateTopic || config.garage?.adapter?.telemetryTopic)
      || config.connections.equipment?.devices?.length > 0;
    if (['mqtt','providers'].includes(config.input) && hasMqttObservations && config.connections.mqtt?.address) {
      const { startMqtt } = await import('./acquisition/mqtt.js');
      requireRunning();
      const acquisition = await startMqtt({ ...mqttOptions, engine, store, config,
        canControl });
      if (closed || !canControl()) {
        await acquisition.close({ restore: false });
        requireRunning();
      }
      acquisitions.push(acquisition);
      engine.equipment = acquisition.equipment ?? null;
      if (acquisition.equipment?.hasHeating) commandTransport.setHeatingRelay(acquisition.equipment.publishHeating, () => {
        const ids = acquisition.equipment.status(clock()).devices.filter(device => device.controls?.tariff).map(device => device.id).sort();
        const identities = ids.map(id => acquisition.equipment.signature(id));
        return ids.length && identities.every(Boolean) ? identities : null;
      });
      if (acquisition.h66) engine.setH66(acquisition);
    }
    engine.equipmentTests = createEquipmentTests({ store, clock, getEquipment: () => engine.equipment,
      canControl: () => canControl() && ['mqtt', 'providers'].includes(config.input) });
    engine.equipmentTests.tick();
  }
  function startGarageSafety() {
    clearInterval(garageSafetyTimer);
    garageSafetyTimer = setInterval(() => {
      if (!closed && runtimeUsable && canControl()) engine.garage.safetyTick();
    }, 5000);
    garageSafetyTimer.unref?.();
  }
  function startBackground() {
    requireRunning();
    engine.tick();
    startGarageSafety();
    // Start UI and conservative control before bounded historical reconstruction.
    learning = config.input !== 'simulated' ? startHistoryLearning({ store, config: engine.control }) : null;
    engine.onTemporaryChange = schedule;
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (closed || reloadPending || !runtimeUsable || !canControl()) return;
    const now = clock();
    const next = Math.min(now + 60_000 - (now % 60_000), engine.nextTemporaryDeadline());
    timer = setTimeout(() => {
      if (closed || reloadPending || !runtimeUsable || !canControl()) return;
      try { engine.tick(); }
      catch (error) { reportControllerError(error); }
      schedule();
    }, Math.max(1, next - now));
  }
  async function startProviderRuntime() {
    if (['providers', 'mqtt'].includes(config.input)) {
      const { startProviders } = await import('./acquisition/providers.js');
      requireRunning();
      acquisitions.push(startProviders({ ...providerOptions, engine, store, config, clock, canControl }));
    }
  }
  const settingsReloadStatus = () => ({
    available: !closed && typeof readConfig === 'function' && runtimeUsable && canControl(),
    stopping: closed,
    busy: Boolean(reloadPending) || starting,
    unavailable: closed || !runtimeUsable && !reloadPending && canControl(),
    configuration: config.configuration ?? { environment: config.addon ? 'home-assistant' : 'ubuntu' },
    access: webAccess?.status(),
    result: configurationResult,
    reason: closed ? 'The application is shutting down.' : !runtimeUsable && !reloadPending
      ? 'Settings recovery failed. Restart the application after checking configuration.'
      : typeof readConfig === 'function'
        ? 'Applies configuration and reconnects providers. Input, listening addresses, ports and storage changes require restart.'
        : 'This instance has no reloadable configuration source.',
  });
  async function reloadSettings() {
    requireRunning();
    if (starting) throw new Error('The application is still starting. Retry shortly.');
    if (!runtimeUsable) throw new Error(settingsReloadStatus().reason);
    if (reloadPending) throw new Error('Settings are already being updated.');
    if (typeof readConfig !== 'function') throw new Error(settingsReloadStatus().reason);
    clearTimeout(timer);
    const operation = async () => {
      let next, transaction;
      try {
        transaction = source ? await source.prepare() : null;
        next = transaction ? transaction.config : await readConfig();
        if (pairContext?.runtimeConfiguration) next = pairContext.runtimeConfiguration(next);
      }
      catch (error) {
        // Source errors are authored without JSON snippets or provider responses.
        // Injected readers have no such contract, so keep their errors private.
        throw new Error(`Configuration could not be read or validated. ${source ? error.message : 'Check the configuration file.'}`);
      }
      requireRunning();
      const startupKeys = ['topology', 'role', 'input', 'host', 'port', 'ingressHost', 'ingressPort', 'dataDir', 'databaseDir', 'dbPath', 'addon'];
      if (startupKeys.some(key => next[key] !== config[key]) || !isDeepStrictEqual(next.mirror, config.mirror)
        || !isDeepStrictEqual(next.pair, config.pair))
        throw new Error('Input, topology, role, mirror, pair, network access or storage settings changed. Restart to apply these changes; no settings were updated.');
      const native = engine.h66Status?.();
      if (engine.heatingTestBusy || engine.dispatchPending || engine.executor.pending || engine.automationChangePending
        || engine.equipmentTests?.status().busy
        || native?.phase === 'test' || Object.values(native?.controls ?? {}).some(control => control.reason === 'A setting transition is in progress.'))
        throw new Error('Wait for the current heating operation or native setting test to finish before updating settings.');
      clearTimeout(timer);
      engine.onTemporaryChange = null;
      // Restore owned equipment settings through the old connections before any
      // broker or device changes can discard that restoration path.
      try {
        await engine.garage.release('settings-reload');
        if (engine.garage.adapter?.status(clock()).restorePending) throw new Error('pending');
        await engine.equipmentTests?.restore();
        const result = await engine.executor.restore({ now: clock(), reason: 'settings-reload' });
        if (result.restorationPending) throw new Error('pending');
      } catch {
        engine.onTemporaryChange = schedule;
        throw new Error('Heating restoration is still pending. Settings were not updated; retry when the equipment is available.');
      }
      requireRunning();
      const previous = config;
      const savedKeys = [`contract:${config.input}`, `automation:${config.input}`, 'providers:health', 'provider:market',
        'provider:weather', 'provider:observations', 'electricity:acquisition'];
      const previousState = savedKeys.map(key => [key, store.getState(key)]);
      let stopped = false, accessTransaction;
      // Reserve a newly needed listener before saving anything to Supervisor.
      try {
        accessTransaction = await webAccess.prepare(next);
        requireRunning();
        await transaction?.persist();
        requireRunning();
      } catch {
        await accessTransaction?.rollback();
        requireRunning();
        engine.onTemporaryChange = schedule;
        throw new Error('Configuration could not be saved or web access prepared. The import file was retained; no runtime settings were updated.');
      }
      runtimeUsable = false;
      try {
        await stopRuntime(); stopped = true;
        requireRunning();
        // A changed provider account/location must not reuse old current caches.
        // Keep unaffected providers' retry state, including shared rate limits.
        store.transaction(() => {
          const changed = key => !isDeepStrictEqual(next.connections?.[key], previous.connections?.[key]);
          const weatherChanged = weatherAcquisitionIdentity(previous.connections) !== weatherAcquisitionIdentity(next.connections);
          const marketChanged = changed('geoloc') || changed('entsoe') || changed('elering');
          const electricityChanged = changed('easee');
          const health = store.getState('providers:health') ?? {};
          for (const [name, reset] of [['weather', weatherChanged], ['outdoor', weatherChanged],
            ['market', marketChanged], ['easee', electricityChanged]]) if (reset) {
            if (['weather', 'outdoor'].includes(name)) health[name] = {
              acquisitionIdentity: weatherAcquisitionIdentity(next.connections),
              sourceBackoff: Object.fromEntries(Object.entries(health[name]?.sourceBackoff ?? {}).filter(([, value]) => value.shared === true)),
            };
            else delete health[name];
          }
          for (const [name, setting] of [['easee', 'easeeIntervalMs'], ['market', 'marketIntervalMs'],
            ['weather', 'weatherIntervalMs'], ['outdoor', 'outdoorIntervalMs']]) {
            const interval = next.acquisition?.[setting], state = health[name];
            if (interval !== previous.acquisition?.[setting] && Number.isFinite(interval)
              && state && !state.error && Number.isFinite(state.nextAttemptAt))
              state.nextAttemptAt = Math.min(state.nextAttemptAt, clock() + interval);
          }
          store.setState('providers:health', health);
          if (marketChanged) store.setState('provider:market', null);
          if (weatherChanged) store.setState('provider:weather', null);
          if (electricityChanged) store.setState('electricity:acquisition', null);
          if (weatherChanged || electricityChanged) {
            const observations = store.getState('provider:observations');
            if (Array.isArray(observations)) store.setState('provider:observations', observations.filter(row =>
              !(weatherChanged && ['fmi', 'openmeteo'].includes(row.source) || electricityChanged && row.source === 'easee')));
          }
        });
        config = next;
        await createRuntime();
        requireRunning();
        await startProviderRuntime();
        requireRunning();
        runtimeUsable = true;
        startBackground();
        await accessTransaction.commit();
        requireRunning();
        configurationResult = null;
        try { configurationResult = await transaction?.complete() ?? null; }
        catch { configurationResult = { cleanupPending: true }; }
        requireRunning();
        store.event('settings-reloaded', { input: config.input }, clock());
      } catch {
        await accessTransaction?.rollback();
        runtimeUsable = false;
        requireRunning();
        try { await stopRuntime(); }
        catch { stopped = false; }
        requireRunning();
        if (!stopped) {
          store.event('settings-reload-failed', { restored: false }, clock());
          throw new Error('Settings teardown failed. Restart the application after checking options/config.');
        }
        store.transaction(() => { for (const [key, value] of previousState) store.setState(key, value); });
        config = previous;
        await webAccess.apply(previous);
        try {
          requireRunning();
          await createRuntime();
          requireRunning();
          await startProviderRuntime();
          requireRunning();
          runtimeUsable = true;
          startBackground();
        } catch {
          runtimeUsable = false;
          requireRunning();
          await stopRuntime().catch(() => {});
          requireRunning();
          store.event('settings-reload-failed', { restored: false }, clock());
          throw new Error('Settings update and runtime recovery failed. Restart the application after checking options/config.');
        }
        store.event('settings-reload-failed', { restored: true }, clock());
        throw new Error('Settings could not be applied. The previous configuration was restored. Any saved Supervisor settings remain saved; retry Apply configuration.');
      }
    };
    reloadPending = operation();
    try { await reloadPending; }
    finally { reloadPending = null; schedule(); }
  }
  if (shutdownSignal?.aborted) abortStartup();
  else shutdownSignal?.addEventListener('abort', abortStartup, { once: true });
  if (installSignalHandlers && !closed) for (const signal of ['SIGTERM', 'SIGINT']) {
    const handler = () => { close().catch(() => { console.error(JSON.stringify({ event: 'shutdown-error', reason: 'cleanup-failed' })); process.exitCode = 1; }); };
    signalHandlers.set(signal,handler); process.once(signal,handler);
  }
  try {
    requireRunning();
    if (!pairContext && ['mqtt', 'providers'].includes(config.input) && config.connections.mqtt?.address) {
      authority = await standaloneAuthority({ config, clock, connect: mqttOptions.connect,
        onLoss: async () => {
          controlRevoked = true;
          if (engine) engine.suspended = true;
          // Invalidate pending reload continuations before cancelling providers.
          // The losing dashboard remains readable; it cannot reopen a runtime.
          authorityStopping = Promise.all([stopRuntime({ restore: false }), reloadPending?.catch(() => {})]);
          await authorityStopping;
        } });
      if (closed) throw new Error('The application is shutting down.');
      if (!authority.canControl()) {
        finishStartup();
        for (const [signal, handler] of signalHandlers) process.removeListener(signal,handler);
        store.close();
        runtimeTiming.close();
        return await stoppedControllerViewer({ config, authority, clock, installSignalHandlers });
      }
    }
    // Reserve HTTP before constructing a controller, connecting MQTT or ticking.
    // A duplicate launch must fail without touching equipment. API requests are
    // held by settingsReloadStatus().busy until startup has completed.
    chartService = createChartService({ store });
    webAccess = createWebAccess({ config, topology: config.topology, role: config.role, getEngine: () => engine, store, chartService,
      getDatabaseExportDirectory: () => config.recording?.exportDirectory ?? homedir(),
      syncStatus: () => replication?.status() ?? null,
      pairContext,
      controlAuthority: authority,
      reloadSettings: typeof readConfig === 'function' ? reloadSettings : null, settingsReloadStatus,
      staticDir: resolve(dirname(fileURLToPath(import.meta.url)), '../dist') });
    await webAccess.start();
    requireRunning();
    await createRuntime();
    requireRunning();
    if (canControl()) { engine.tick(); startGarageSafety(); }
    requireRunning();
    if (canControl()) await startProviderRuntime();
    requireRunning();
    // Background work follows the initial control tick and provider startup.
    learning = canControl() && config.input !== 'simulated' ? startHistoryLearning({ store, config: engine.control }) : null;
    if (config.topology === 'mirror' && config.role === 'master') {
      const { ReplicationService } = await import('./replication/service.js');
      requireRunning();
      replication = new ReplicationService({ dbPath: store.path, config: config.mirror });
      replication.start();
    }
    if (startupImport) {
      try { configurationResult = await startupImport.complete(); }
      catch { configurationResult = { cleanupPending: true }; }
    }
    requireRunning();
    starting = false;
    authority?.start();
    engine.onTemporaryChange = schedule;
    schedule();
    console.log(JSON.stringify({ event: 'ready', input: config.input, environment: engine.environment(), manualHeatingTests: engine.heatingTests().available,
      address: webAccess.server.address(), startupMs: Math.round(performance.now() - started) }));
    finishStartup();
    return { store, get engine() { return engine; }, get server() { return webAccess.server; }, webAccess, mirror: replication, close, reloadSettings, revokeControl };
  } catch (error) {
    finishStartup();
    try { await close(); } catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  start().catch(error => { console.error(error.message); process.exitCode = 1; });
}
