import { resolve, dirname } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';

// Offline-only benchmark. First import with scripts/history.js; this never opens
// credentials, brokers or providers. It leaves the learned checkpoint in the DB.
const dbPath = resolve(process.argv[2] ?? 'var/st-mq.sqlite');
const config = { ...loadConfig({ STMQ_INPUT: 'offline', STMQ_PORT: '0', STMQ_DATA_DIR: dirname(dbPath) }), dbPath };
const initialRss = process.memoryUsage().rss;
let peakRss = initialRss, worstEventLoopDelayMs = 0, previousTick = performance.now();
const monitor = setInterval(() => {
  const now = performance.now();
  worstEventLoopDelayMs = Math.max(worstEventLoopDelayMs, now - previousTick - 20);
  previousTick = now;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 20);
let app;
try {
  const started = performance.now();
  app = await start({ config });
  const startupMs = performance.now() - started;
  const initialHealth = app.store.getState('learning:health');
  while (performance.now() - started < 60_000) {
    const health = app.store.getState('learning:health');
    if (health?.status === 'history-current' && (!initialHealth || health.updatedAt !== initialHealth.updatedAt)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const history = app.store.getState('learning:health');
  if (history?.status !== 'history-current') throw new Error('Historical learning did not finish within 60 seconds');
  const learned = app.store.getState('learning:history');
  console.log(JSON.stringify({ startupMs, elapsedMs: performance.now() - started,
    initialRssMiB: initialRss / 1048576, peakRssMiB: peakRss / 1048576, worstEventLoopDelayMs,
    history, checkpointSamples: learned?.checkpoint.samples.length,
    modelValidation: learned?.checkpoint.model?.validation ?? null,
    note: 'Local x86_64 development host; Pi/ARM performance remains unmeasured. No savings established.' }, null, 2));
} finally { clearInterval(monitor); await app?.close(); }
