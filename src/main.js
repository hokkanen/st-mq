import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Store } from './storage/store.js';
import { loadConfig } from './app/config.js';
import { Engine } from './app/engine.js';
import { createAppServer } from './app/server.js';
import { startHistoryLearning, startOnlineLearning } from './app/learning.js';
import { createChartService } from './app/chart-service.js';
import { prepareStorage } from './app/storage-paths.js';

export async function start({ config = loadConfig(), clock = Date.now, providerOptions = {}, mqttOptions = {} } = {}) {
  const started = performance.now();
  const migrated = await prepareStorage(config);
  const store = new Store(config.dbPath);
  if (migrated) store.event('database-migrated', migrated, clock());
  let engine, server, learning, chartService, timer, closed = false;
  const acquisitions = [];
  const signalHandlers = new Map();
  async function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    if (engine) engine.onTemporaryChange = null;
    await Promise.all(acquisitions.map(acquisition => acquisition.close()));
    await learning?.close();
    await engine?.learner?.close();
    await chartService?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    store.close();
  }
  try {
    engine = new Engine({ store, config, clock });
    engine.learner = startOnlineLearning({ store, input: config.input });
    engine.tick();
    chartService = createChartService({ store });
    server = createAppServer({ engine, store, chartService, token: config.token, staticDir: resolve(dirname(fileURLToPath(import.meta.url)), '../dist') });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolve);
    });
    // Start UI and conservative control before bounded historical reconstruction.
    learning = config.input !== 'simulated' ? startHistoryLearning({ store }) : null;
    if (config.input === 'mqtt') {
      const { startMqtt } = await import('./acquisition/mqtt.js');
      acquisitions.push(await startMqtt({ ...mqttOptions, engine, store, config }));
    }
    if (['providers', 'mqtt'].includes(config.input)) {
      const { startProviders } = await import('./acquisition/providers.js');
      acquisitions.push(startProviders({ ...providerOptions, engine, store, config, clock }));
    }
    const schedule = () => {
      clearTimeout(timer);
      const now = clock();
      const next = Math.min(now + 900_000 - (now % 900_000), engine.nextTemporaryDeadline());
      timer = setTimeout(() => {
        try { engine.tick(); }
        catch (error) { store.event('controller-error', { message: error.message }, clock()); }
        if (!closed) schedule();
      }, Math.max(1, next - now));
    };
    engine.onTemporaryChange = schedule;
    schedule();
    console.log(JSON.stringify({ event: 'ready', input: config.input, mode: engine.settings.mode, liveWrites: false,
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
