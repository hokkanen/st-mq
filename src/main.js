import { mkdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Store } from './storage/store.js';
import { loadConfig } from './app/config.js';
import { Engine } from './app/engine.js';
import { createAppServer } from './app/server.js';
import { startHistoryLearning, startOnlineLearning } from './app/learning.js';

export async function start({ config = loadConfig(), clock = Date.now } = {}) {
  const started = performance.now();
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(config.dbPath);
  let engine, server, acquisition, learning, timer, closed = false;
  const signalHandlers = new Map();
  async function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    await acquisition?.close();
    await learning?.close();
    await engine?.learner?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    store.close();
  }
  try {
    engine = new Engine({ store, config, clock });
    engine.learner = startOnlineLearning({ store, input: config.input });
    engine.tick();
    server = createAppServer({ engine, store, token: config.token, staticDir: resolve(dirname(fileURLToPath(import.meta.url)), '../dist') });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolve);
    });
    // Start UI and conservative control before bounded historical reconstruction.
    learning = config.input !== 'simulated' ? startHistoryLearning({ store }) : null;
    if (config.input === 'mqtt') {
      const { startMqtt } = await import('./acquisition/mqtt.js');
      acquisition = await startMqtt({ engine, store, config });
    }
    const schedule = () => {
      timer = setTimeout(() => {
        try { engine.tick(); }
        catch (error) { store.event('controller-error', { message: error.message }, clock()); }
        if (!closed) schedule();
      }, 900_000 - (clock() % 900_000));
    };
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
