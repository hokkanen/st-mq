import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { getChartData, chartRange } from './chart-data.js';
import { getDatabaseOverview, OVERVIEW_REFRESH_MS } from './database-overview.js';

// The chart worker owns a separate read-only SQLite connection. A large history
// view cannot block control decisions or the application's HTTP event loop.
const db = new DatabaseSync(workerData.dbPath, { readOnly: true });
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE;');
const store = { db, path: workerData.dbPath };
const cache = new Map(); let cacheBytes = 0, version = null;
let overview = null;
parentPort.on('message', ({ id, args, operation }) => {
  try {
    if (operation === 'overview') {
      const at = Date.now();
      const hit = overview && at - overview.generatedAt >= 0 && at - overview.generatedAt < OVERVIEW_REFRESH_MS;
      if (!hit) {
        // Consistent read snapshot across aggregate queries. WAL permits the
        // controller's writer to continue while the worker builds the overview.
        db.exec('BEGIN');
        try { overview = getDatabaseOverview({ store, now: at }); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      parentPort.postMessage({ id, result: { ...overview,
        cache: { hit: Boolean(hit), ageMs: at - overview.generatedAt, maxAgeMs: OVERVIEW_REFRESH_MS } } });
      return;
    }
    // Acquisition checkpoints and rolling recorder metrics update frequently.
    // They do not invalidate a completed historical plot. New observations,
    // availability spans, forecast fetches and completed imports do.
    const currentVersion = JSON.stringify(db.prepare(`SELECT
      (SELECT MAX(id) FROM observations) observations,
      (SELECT MAX(id) FROM provider_snapshot_fetches) snapshots,
      (SELECT MAX(id) FROM recorder_coverage) coverage,
      (SELECT MAX(id) FROM learning_journal) learningJournal,
      (SELECT MAX(id) FROM fireplace_events) fireplaceRevision,
      (SELECT group_concat(CASE WHEN json_valid(value) THEN json_extract(value,'$.checkpointDigest') ELSE 'invalid' END) FROM state WHERE key IN ('adaptive:mqtt','adaptive:providers','adaptive:simulated')) adaptiveModels,
      (SELECT group_concat(value) FROM state WHERE key IN ('fireplace:rebuild:mqtt','fireplace:rebuild:providers','fireplace:rebuild:simulated')) fireplaceRebuilds,
      (SELECT MAX(id) FROM events WHERE type='heat-pump-power-config') heatPowerConfig,
      (SELECT COUNT(*) FROM imports WHERE status='complete') imports`).get());
    if (currentVersion !== version) { cache.clear(); cacheBytes = 0; version = currentVersion; }
    // Historical views survive second-by-second clock movement. Current/future
    // views renew within fifteen seconds, preserving acquisition timestamps.
    const bucket = chartRange(args).to <= args.now ? 0 : Math.floor(args.now / 15_000);
    const key = JSON.stringify({ ...args, now: bucket });
    let entry = cache.get(key), result;
    if (entry) {
      cache.delete(key); cache.set(key, entry);
      result = { ...entry.result, now: args.now, meta: { ...entry.result.meta, cacheHit: true } };
    } else {
      // Replay and source handovers must see one committed journal prefix.
      db.exec('BEGIN');
      try { result = getChartData({ ...args, store }); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      const bytes = Buffer.byteLength(JSON.stringify(result));
      while (cache.size && (cache.size >= 16 || cacheBytes + bytes > 32 * 1024 * 1024)) {
        const first = cache.keys().next().value; cacheBytes -= cache.get(first).bytes; cache.delete(first);
      }
      if (bytes <= 32 * 1024 * 1024) { entry = { result, bytes }; cache.set(key, entry); cacheBytes += bytes; }
    }
    parentPort.postMessage({ id, result });
  } catch (error) { parentPort.postMessage({ id, error: { name: error.name, message: error.message } }); }
});
