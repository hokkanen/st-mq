import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Store } from './storage/store.js';
import { loadConfig, configurationReader, configurationSource } from './app/config.js';
import { Engine } from './app/engine.js';
import { createWebAccess } from './app/web-access.js';
import { startHistoryLearning } from './app/learning.js';
import { createChartService } from './app/chart-service.js';
import { prepareStorage } from './app/storage-paths.js';
import { createHeatingTransport } from './control/mqtt.js';

export async function start({ config = loadConfig(), readConfig = configurationReader(config),
  clock = Date.now, providerOptions = {}, mqttOptions = {} } = {}) {
  const started = performance.now();
  const source = readConfig === configurationReader(config) ? configurationSource(config) : null;
  let startupImport = null;
  if (config.addon && source) {
    startupImport = await source.prepare({ startup: true });
    config = startupImport.config;
    await startupImport.persist();
  }
  if (config.role !== undefined && !['primary', 'replica'].includes(config.role))
    throw new Error('Invalid local instance role');
  // A replica never opens the live Store or constructs a controller. Its role
  // comes from this machine's configuration, never from replicated state.
  if (config.role === 'replica') {
    const { startReplica } = await import('./app/replica.js');
    const app = await startReplica({ config, clock });
    if (startupImport) {
      try { await startupImport.complete(); }
      catch { /* The retained import can be retried on restart. */ }
    }
    return app;
  }
  const migrated = await prepareStorage(config);
  const store = new Store(config.dbPath);
  if (migrated) store.event('database-migrated', migrated, clock());
  let engine, webAccess, learning, chartService, commandTransport, replication, timer, closed = false, reloadPending = null;
  let runtimeUsable = true, starting = true, configurationResult = null;
  const acquisitions = [];
  const signalHandlers = new Map();
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
  async function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    const replicationStopped = replication?.stop();
    await reloadPending?.catch(() => {});
    // Cancel a large copy immediately, but restore equipment before waiting for
    // its worker/process cleanup. Replication must not delay control shutdown.
    await stopRuntime();
    await replicationStopped;
    await chartService?.close();
    await webAccess?.close();
    store.close();
  }
  async function stopRuntime() {
    clearTimeout(timer);
    if (engine) engine.onTemporaryChange = null;
    if (engine?.heatingTestBusy) await commandTransport?.close();
    await engine?.dispatchPending?.catch(() => {});
    await engine?.closeFireplace();
    try { await engine?.executor?.close?.(); }
    catch { store.event('restoration-pending', { reason: 'application-shutdown' }, clock()); }
    await commandTransport?.close();
    await Promise.all(acquisitions.splice(0).map(acquisition => acquisition.close()));
    await learning?.close(); learning = null;
    engine?.recorder.flush(clock());
    commandTransport = null;
  }
  async function createRuntime() {
    if (closed) throw new Error('The application is shutting down.');
    if (['mqtt', 'providers'].includes(config.input) && config.connections.mqtt?.address) {
      commandTransport = createHeatingTransport({ connection: config.connections.mqtt, connect: mqttOptions.connect });
    }
    engine = new Engine({ store, config, clock, commandTransport });
    // Load durable native-setting obligations before the first active dispatch.
    // MQTT connection and device publications remain asynchronous.
    const hasMqttObservations = config.h66?.deviceId || config.deviceId
      || Object.keys(config.connections.mqtt?.temperatureTopics ?? {}).length > 0
      || config.connections.teslamate?.enabled === true;
    if (['mqtt','providers'].includes(config.input) && hasMqttObservations && config.connections.mqtt?.address) {
      const { startMqtt } = await import('./acquisition/mqtt.js');
      if (closed) throw new Error('The application is shutting down.');
      const acquisition = await startMqtt({ ...mqttOptions, engine, store, config });
      acquisitions.push(acquisition);
      if (acquisition.h66) engine.setH66(acquisition);
    }
  }
  function startBackground() {
    if (closed) throw new Error('The application is shutting down.');
    engine.tick();
    // Start UI and conservative control before bounded historical reconstruction.
    learning = config.input !== 'simulated' ? startHistoryLearning({ store, config: engine.control }) : null;
    engine.onTemporaryChange = schedule;
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (closed || reloadPending || !runtimeUsable) return;
    const now = clock();
    const next = Math.min(now + 60_000 - (now % 60_000), engine.nextTemporaryDeadline());
    timer = setTimeout(() => {
      if (closed || reloadPending || !runtimeUsable) return;
      try { engine.tick(); }
      catch (error) { reportControllerError(error); }
      schedule();
    }, Math.max(1, next - now));
  }
  async function startProviderRuntime() {
    if (['providers', 'mqtt'].includes(config.input)) {
      const { startProviders } = await import('./acquisition/providers.js');
      if (closed) throw new Error('The application is shutting down.');
      acquisitions.push(startProviders({ ...providerOptions, engine, store, config, clock }));
    }
  }
  const settingsReloadStatus = () => ({
    available: typeof readConfig === 'function' && runtimeUsable,
    busy: Boolean(reloadPending) || starting,
    unavailable: !runtimeUsable && !reloadPending,
    configuration: config.configuration ?? { environment: config.addon ? 'home-assistant' : 'ubuntu' },
    access: webAccess?.status(),
    result: configurationResult,
    reason: !runtimeUsable && !reloadPending
      ? 'Settings recovery failed. Restart the application after checking configuration.'
      : typeof readConfig === 'function'
        ? 'Applies configuration and reconnects providers. Input, listening addresses, ports and storage changes require restart.'
        : 'This instance has no reloadable configuration source.',
  });
  async function reloadSettings() {
    if (closed) throw new Error('The application is shutting down.');
    if (starting) throw new Error('The application is still starting. Retry shortly.');
    if (!runtimeUsable) throw new Error(settingsReloadStatus().reason);
    if (reloadPending) throw new Error('Settings are already being updated.');
    if (typeof readConfig !== 'function') throw new Error(settingsReloadStatus().reason);
    clearTimeout(timer);
    const requireRunning = () => { if (closed) throw new Error('The application is shutting down.'); };
    const operation = async () => {
      let next, transaction;
      try {
        transaction = source ? await source.prepare() : null;
        next = transaction ? transaction.config : await readConfig();
      }
      catch (error) {
        // Source errors are authored without JSON snippets or provider responses.
        // Injected readers have no such contract, so keep their errors private.
        throw new Error(`Configuration could not be read or validated. ${source ? error.message : 'Check the configuration file.'}`);
      }
      requireRunning();
      const startupKeys = ['role', 'input', 'host', 'port', 'ingressHost', 'ingressPort', 'dataDir', 'databaseDir', 'dbPath', 'legacyDbPath', 'addon'];
      if (startupKeys.some(key => next[key] !== config[key]) || !isDeepStrictEqual(next.replication, config.replication))
        throw new Error('Input, role, replication, network access or storage settings changed. Restart to apply these changes; no settings were updated.');
      const native = engine.h66Status?.();
      if (engine.heatingTestBusy || engine.dispatchPending || engine.executor.pending
        || native?.phase === 'test' || Object.values(native?.controls ?? {}).some(control => control.reason === 'A setting transition is in progress.'))
        throw new Error('Wait for the current heating operation or native setting test to finish before updating settings.');
      clearTimeout(timer);
      engine.onTemporaryChange = null;
      // Restore owned equipment settings through the old connections before any
      // broker or device changes can discard that restoration path.
      try {
        const result = await engine.executor.restore({ now: clock(), reason: 'settings-reload' });
        if (result.restorationPending) throw new Error('pending');
      } catch {
        engine.onTemporaryChange = schedule;
        throw new Error('Heating restoration is still pending. Settings were not updated; retry when the equipment is available.');
      }
      requireRunning();
      const previous = config;
      const savedKeys = [`contract:${config.input}`, 'providers:health', 'provider:market',
        'provider:weather', 'provider:observations', 'electricity:acquisition'];
      const previousState = savedKeys.map(key => [key, store.getState(key)]);
      let stopped = false, accessTransaction;
      // Reserve a newly needed listener before saving anything to Supervisor.
      try {
        accessTransaction = await webAccess.prepare(next);
        await transaction?.persist();
      } catch {
        await accessTransaction?.rollback();
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
          const weatherChanged = changed('geoloc');
          const marketChanged = weatherChanged || changed('entsoe') || changed('elering');
          const electricityChanged = changed('easee');
          const health = store.getState('providers:health') ?? {};
          for (const [name, reset] of [['weather', weatherChanged], ['outdoor', weatherChanged],
            ['market', marketChanged], ['easee', electricityChanged]]) if (reset) delete health[name];
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
        configurationResult = null;
        try { configurationResult = await transaction?.complete() ?? null; }
        catch { configurationResult = { cleanupPending: true }; }
        store.event('settings-reloaded', { input: config.input }, clock());
      } catch {
        await accessTransaction?.rollback();
        runtimeUsable = false;
        requireRunning();
        try { await stopRuntime(); }
        catch { stopped = false; }
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
          if (!closed) await stopRuntime().catch(() => {});
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
  try {
    await createRuntime();
    engine.tick();
    chartService = createChartService({ store });
    webAccess = createWebAccess({ config, getEngine: () => engine, store, chartService,
      replicationStatus: () => replication?.status() ?? null,
      reloadSettings: typeof readConfig === 'function' ? reloadSettings : null, settingsReloadStatus,
      staticDir: resolve(dirname(fileURLToPath(import.meta.url)), '../dist') });
    await webAccess.start();
    await startProviderRuntime();
    // The first tick runs before the listener, as before; background work follows it.
    learning = config.input !== 'simulated' ? startHistoryLearning({ store, config: engine.control }) : null;
    if (config.replication?.enabled) {
      const { ReplicationService } = await import('./replication/service.js');
      replication = new ReplicationService({ dbPath: store.path, config: config.replication });
      replication.start();
    }
    if (startupImport) {
      try { configurationResult = await startupImport.complete(); }
      catch { configurationResult = { cleanupPending: true }; }
    }
    starting = false;
    engine.onTemporaryChange = schedule;
    schedule();
    console.log(JSON.stringify({ event: 'ready', input: config.input, mode: engine.settings.mode, liveWrites: engine.status().liveWrites, manualHeatingTests: engine.heatingTests().available,
      address: webAccess.server.address(), startupMs: Math.round(performance.now() - started) }));
    for (const signal of ['SIGTERM', 'SIGINT']) {
      const handler = () => close().catch(error => { console.error(error.message); process.exitCode = 1; });
      signalHandlers.set(signal, handler); process.once(signal, handler);
    }
    return { store, get engine() { return engine; }, get server() { return webAccess.server; }, webAccess, replication, close, reloadSettings };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  start().catch(error => { console.error(error.message); process.exitCode = 1; });
}
