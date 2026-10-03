import { Store } from '../../src/storage/store.js';
import { resolve } from 'node:path';
import moment from 'moment-timezone';
import { createChartService } from '../../src/app/chart-service.js';

// Read-only benchmark of an explicitly selected current-schema database;
// never loads options, starts acquisition, or changes the SQLite database.
const dbPath = resolve(process.argv[2] ?? 'var/st-mq.sqlite');
const store = new Store(dbPath, { readOnly: true });
const db = store.db;
const service = createChartService({ store });
const bounds = db.prepare('SELECT MIN(source_time) first,MAX(source_time) last,COUNT(*) count FROM observations').get();
const latest = moment.tz(bounds.last, 'Europe/Helsinki').format('YYYY-MM-DD');
const first = moment.tz(bounds.first, 'Europe/Helsinki').format('YYYY-MM-DD');
const ranges = [
  { name: 'latest-day', startDate: latest, endDate: latest },
  { name: 'winter-day', startDate: '2025-01-15', endDate: '2025-01-15' },
  { name: 'month', startDate: '2025-01-01', endDate: '2025-01-31' },
  { name: 'entire-import', startDate: first, endDate: latest },
];
const rounded = value => Math.round(value * 100) / 100;
let peakRss = process.memoryUsage().rss, delayMs = 0, previous = performance.now();
const monitor = setInterval(() => {
  const at = performance.now(); delayMs = Math.max(delayMs, at - previous - 10); previous = at;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 10);
const report = { databaseObservations: bounds.count, host: `${process.platform}/${process.arch}`, queries: [] };
try {
  for (const range of ranges) {
    const args = { ...range, input: 'offline', now: Date.now(), points: 800, left: 'power' };
    const begin = performance.now();
    const result = await service.query(args);
    const coldMs = performance.now() - begin;
    const warmBegin = performance.now();
    const warm = await service.query(args);
    report.queries.push({ name: range.name, coldServiceMs: rounded(coldMs), warmServiceMs: rounded(performance.now() - warmBegin),
      queryMs: result.meta.elapsedMs, cacheHit: warm.meta.cacheHit === true,
      scannedRows: result.meta.rawRows, returnedPoints: result.meta.returnedPoints,
      responseKiB: rounded(Buffer.byteLength(JSON.stringify(result)) / 1024) });
  }
  report.workerPeakRssMiB = rounded(peakRss / 1048576);
  report.worstMainLoopDelayMs = rounded(delayMs);
  clearInterval(monitor);
  report.note = 'Read-only current chart worker timings. First query includes startup; warm query includes worker transfer. Browser draw and network latency are not measured.';
  console.log(JSON.stringify(report, null, 2));
} finally { clearInterval(monitor); await service.close(); store.close(); }
