import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Store } from './storage/store.js';
import { loadConfig } from './app/config.js';
import { Engine } from './app/engine.js';
import { createAppServer } from './app/server.js';
import { startHistoryLearning } from './app/learning.js';
import { createChartService } from './app/chart-service.js';
import { prepareStorage } from './app/storage-paths.js';
import { createHeatingTransport } from './control/mqtt.js';

export async function start({ config = loadConfig(), clock = Date.now, providerOptions = {}, mqttOptions = {} } = {}) {
  const started = performance.now();
  const migrated = await prepareStorage(config);
  const store = new Store(config.dbPath);
  if (migrated) store.event('database-migrated', migrated, clock());
  let engine, server, learning, chartService, commandTransport, timer, closed = false;
  const acquisitions = [];
  const signalHandlers = new Map();
  async function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    if (engine) engine.onTemporaryChange = null;
    if (engine?.heatingTestBusy) await commandTransport?.close();
    await engine?.dispatchPending?.catch(() => {});
    try { await engine?.executor?.close?.(); }
    catch { store.event('restoration-pending', { reason: 'application-shutdown' }, clock()); }
    await commandTransport?.close();
    await Promise.all(acquisitions.map(acquisition => acquisition.close()));
    await learning?.close();
    await chartService?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    engine?.recorder.flush(clock());
    store.close();
  }
  try {
    if (['mqtt', 'providers'].includes(config.input) && config.connections.mqtt?.address) {
      commandTransport = createHeatingTransport({ connection: config.connections.mqtt, connect: mqttOptions.connect });
    }
    engine = new Engine({ store, config, clock, commandTransport });
    // Load durable native-setting obligations before the first active dispatch.
    // MQTT connection and device publications remain asynchronous.
    const hasMqttObservations = config.h66?.deviceId || config.deviceId
      || Object.keys(config.connections.mqtt?.temperatureTopics ?? {}).length > 0;
    if (['mqtt','providers'].includes(config.input) && hasMqttObservations && config.connections.mqtt?.address) {
      const { startMqtt } = await import('./acquisition/mqtt.js');
      const acquisition = await startMqtt({ ...mqttOptions, engine, store, config });
      acquisitions.push(acquisition);
      if (acquisition.h66) engine.setH66(acquisition);
    }
    engine.tick();
    chartService = createChartService({ store });
    server = createAppServer({ engine, store, chartService, token: config.token, staticDir: resolve(dirname(fileURLToPath(import.meta.url)), '../dist') });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolve);
    });
    // Start UI and conservative control before bounded historical reconstruction.
    learning = config.input !== 'simulated' ? startHistoryLearning({ store, config: engine.control }) : null;
    if (['providers', 'mqtt'].includes(config.input)) {
      const { startProviders } = await import('./acquisition/providers.js');
      acquisitions.push(startProviders({ ...providerOptions, engine, store, config, clock }));
    }
    const schedule = () => {
      clearTimeout(timer);
      const now = clock();
      const next = Math.min(now + 60_000 - (now % 60_000), engine.nextTemporaryDeadline());
      timer = setTimeout(() => {
        try { engine.tick(); }
        catch (error) { store.event('controller-error', { message: error.message }, clock()); }
        if (!closed) schedule();
      }, Math.max(1, next - now));
    };
    engine.onTemporaryChange = schedule;
    schedule();
    console.log(JSON.stringify({ event: 'ready', input: config.input, mode: engine.settings.mode, liveWrites: engine.status().liveWrites, manualHeatingTests: engine.heatingTests().available,
      address: server.address(), startupMs: Math.round(performance.now() - started) }));
    for (const signal of ['SIGTERM', 'SIGINT']) {
      const handler = () => close().catch(error => { console.error(error.message); process.exitCode = 1; });
      signalHandlers.set(signal, handler); process.once(signal, handler);
    }
    return { store, engine, server, close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  start().catch(error => { console.error(error.message); process.exitCode = 1; });
}
