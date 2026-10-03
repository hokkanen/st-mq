import { resolve, dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';

// Offline-only benchmark. First import with scripts/history.js; this never opens
// credentials, brokers or providers. It leaves the learned checkpoint in the DB.
const dbPath = resolve(process.argv[2] ?? 'var/st-mq.sqlite');
const configurationDirectory = mkdtempSync(join(tmpdir(), 'stmq-history-benchmark-'));
const config = { ...loadConfig({ XDG_CONFIG_HOME: configurationDirectory, STMQ_INPUT: 'offline', STMQ_PORT: '0', STMQ_DATA_DIR: dirname(dbPath) }), dbPath };
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
  const learned = app.store.getState('adaptive:history');
  console.log(JSON.stringify({ startupMs, elapsedMs: performance.now() - started,
    initialRssMiB: initialRss / 1048576, peakRssMiB: peakRss / 1048576, worstEventLoopDelayMs,
    history, checkpointSamples: learned?.samples.length,
    modelValidation: learned?.model?.validation ?? null,
    note: 'Local x86_64 development host; Pi/ARM performance remains unmeasured. No savings established.' }, null, 2));
} finally { clearInterval(monitor); try { await app?.close(); } finally { rmSync(configurationDirectory, { recursive: true, force: true }); } }
