// Offline current-schema benchmark. Every invocation makes and removes its own
// synthetic database; it never opens installation data, credentials or devices.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Store } from '../../src/storage/store.js';
import { seedChartPerformanceFixture, CHART_PERFORMANCE_NOW, CHART_PERFORMANCE_CONTRACT } from '../lib/chart-performance-fixture.js';

const argv = process.argv.slice(2);
const option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const days = Number(option('--days', 90)), runs = Number(option('--runs', 3));
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('Use --runs 1..10');
const roots = [option('--baseline', null), resolve(option('--source', '.'))].filter(Boolean);
const directory = mkdtempSync(join(tmpdir(), 'stmq-chart-performance-'));
const store = new Store(join(directory, 'synthetic.sqlite'));
const median = values => { const sorted = [...values].sort((a, b) => a - b), m = Math.floor(sorted.length / 2);
  return Math.round((sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2) * 100) / 100; };
// Equality covers every returned field except deliberately non-semantic timing,
// cache and scan diagnostics. Arrays retain their order and complete provenance.
function digest(result) {
  const copy = structuredClone(result);
  for (const key of ['elapsedMs', 'cacheHit', 'contentRevision', 'queryMetrics', 'progress', 'cacheAgeMs', 'queueMs']) delete copy.meta[key];
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}
const selections = [
  ...['power', 'phases', 'garage', 'garage_control'].flatMap(view => [
    { name: `day/${view}`, view, startDate: '2026-10-06', endDate: '2026-10-06' },
    { name: `week/${view}`, view, startDate: '2026-09-30', endDate: '2026-10-06' },
  ]),
  { name: 'month/power', view: 'power', startDate: '2026-09-07', endDate: '2026-10-06' },
  { name: 'today/power', view: 'power', startDate: '2026-10-07', endDate: '2026-10-07' },
  { name: 'tomorrow/power', view: 'power', startDate: '2026-10-08', endDate: '2026-10-08' },
];
const expected = new Map(), report = { runtime: process.version, platform: `${process.platform}/${process.arch}`,
  cpu: cpus()[0]?.model, runs, results: [], note: 'Synthetic Ubuntu service timings, including worker startup for each first request. Warm timings include worker transfer. No Pi, browser or network timing claim.' };
try {
  report.fixture = seedChartPerformanceFixture(store, { days });
  for (const [sourceIndex, root] of roots.entries()) {
    const { createChartService } = await import(pathToFileURL(join(resolve(root), 'src/app/chart-service.js')));
    for (const selection of selections) {
      const first = [], warm = [], loops = [], samples = [];
      let points, bytes, equality = true, peakRss = process.memoryUsage().rss;
      for (let run = 0; run < runs; run++) {
        const service = createChartService({ store });
        const args = { ...selection, input: 'providers', now: CHART_PERFORMANCE_NOW, points: 800, contract: CHART_PERFORMANCE_CONTRACT };
        delete args.name;
        let previous = performance.now(), delay = 0;
        const heartbeat = setInterval(() => { const at = performance.now(); delay = Math.max(delay, at - previous - 10);
          previous = at; peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
        try {
          const started = performance.now(), result = await service.query(args), firstMs = performance.now() - started;
          const repeat = performance.now(), cached = await service.query(args), warmMs = performance.now() - repeat;
          await new Promise(resolve => setTimeout(resolve, 15));
          first.push(firstMs); warm.push(warmMs); loops.push(delay); samples.push({ firstMs, warmMs, mainLoopDelayMs: delay });
          points = result.meta.returnedPoints; bytes = Buffer.byteLength(JSON.stringify(result));
          assert.equal(cached.meta.cacheHit, true, `${selection.name} repeat must hit cache`);
          const hash = digest(result);
          if (sourceIndex === 0 && !expected.has(selection.name)) expected.set(selection.name, hash);
          equality &&= expected.get(selection.name) === hash;
          assert.equal(hash, expected.get(selection.name), `${selection.name} full response changed`);
        } finally { clearInterval(heartbeat); await service.close(); }
      }
      const row = { source: roots.length > 1 ? sourceIndex === 0 ? 'baseline' : 'candidate' : 'current',
        selection: selection.name, firstMedianMs: median(first), warmMedianMs: median(warm),
        worstMainLoopDelayMs: Math.round(Math.max(...loops) * 100) / 100,
        processPeakRssMiB: Math.round(peakRss / 1048576), points, responseKiB: Math.round(bytes / 1024), equality, samples };
      report.results.push(row);
      process.stderr.write(`${row.source} ${row.selection}: ${row.firstMedianMs} ms first, ${row.warmMedianMs} ms cached\n`);
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
