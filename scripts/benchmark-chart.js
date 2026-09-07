import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Papa from 'papaparse';
import moment from 'moment-timezone';
import { createChartService } from '../src/app/chart-service.js';
import { chartRange } from '../src/app/chart-data.js';

// Read-only benchmark. Uses the supplied CSV files and already imported history;
// never loads options, starts acquisition, or changes the SQLite database.
const dbPath = resolve(process.argv[2] ?? 'var/st-mq.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });
const store = { path: dbPath, db };
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
  // Reproduce 0.7.5's Papa parse, chronological sort, cached binary search and
  // per-series point preparation. Local reads deliberately exclude HTTP costs.
  const parseStart = performance.now();
  const parse = path => {
    const rows = [];
    Papa.parse(readFileSync(path, 'utf8'), { header: true, dynamicTyping: true,
      step: ({ data }) => { if (data.unix_time !== null && !isNaN(data.unix_time)) rows.push(data); } });
    return rows.sort((a, b) => a.unix_time - b.unix_time);
  };
  const easee = parse(resolve('CODEX/easee.csv')), stmq = parse(resolve('CODEX/st-mq-corrected.csv'));
  report.legacyColdParseSortMs = rounded(performance.now() - parseStart);
  const lower = (rows, at) => {
    let low = 0, high = rows.length;
    while (low < high) { const mid = (low + high) >>> 1; if (rows[mid].unix_time < at) low = mid + 1; else high = mid; }
    return low;
  };
  for (let index = 0; index < ranges.length; index++) {
    const range = chartRange(ranges[index]);
    const begin = performance.now();
    const series = Array.from({ length: 13 }, () => []);
    for (const [rows, keys, offset] of [[easee, ['ch_curr1', 'ch_curr2', 'ch_curr3', 'eq_curr1', 'eq_curr2', 'eq_curr3'], 0],
      [stmq, ['price', 'heat_on', 'temp_in', 'temp_ga', 'temp_out'], 8]]) {
      const start = lower(rows, range.from / 1000); let end = start;
      while (end < rows.length && rows[end].unix_time < range.to / 1000) end++;
      for (const row of rows.slice(start, end)) {
        for (let key = 0; key < keys.length; key++) if (!isNaN(row[keys[key]])) series[key + offset].push({ x: row.unix_time, y: row[keys[key]] });
        if (offset === 0) {
          series[6].push({ x: row.unix_time, y: 0.23 * (row.ch_curr1 + row.ch_curr2 + row.ch_curr3) });
          series[7].push({ x: row.unix_time, y: 0.23 * (row.eq_curr1 + row.eq_curr2 + row.eq_curr3) });
        }
      }
    }
    report.queries[index].legacyWarmPrepareMs = rounded(performance.now() - begin);
    report.queries[index].legacyPreparedPoints = series.reduce((sum, rows) => sum + rows.length, 0);
  }
  report.note = 'Local Node preparation timings, not browser draw/network timings. Legacy warm preparation excludes its HEAD requests, parse and browser Chart.js decimation. New first query includes worker startup; warm service includes worker message transfer. Pi/Android unmeasured.';
  console.log(JSON.stringify(report, null, 2));
} finally { clearInterval(monitor); await service.close(); db.close(); }
