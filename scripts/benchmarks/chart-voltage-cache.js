// Synthetic only: never opens installation databases, credentials or devices.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../../src/storage/store.js';
import { seedVoltageFixture } from '../lib/chart-fixture.js';
import { seedChartPerformanceFixture, CHART_PERFORMANCE_NOW as now,
  CHART_PERFORMANCE_CONTRACT as contract } from '../lib/chart-performance-fixture.js';

const argv = process.argv.slice(2);
const option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const days = Number(option('--days', 35)), runs = Number(option('--runs', 3));
assert(Number.isInteger(runs) && runs >= 1 && runs <= 10, 'Use --runs 1..10');
const roots = [option('--baseline', null), resolve(option('--source', '.'))].filter(Boolean);
const directory = mkdtempSync(join(tmpdir(), 'stmq-voltage-performance-'));
const store = new Store(join(directory, 'synthetic.sqlite'));
const digest = result => createHash('sha256').update(JSON.stringify({ series: result.series, shading: result.shading })).digest('hex');
const expected = new Map(), report = { runtime: process.version, results: [],
  note: 'Synthetic Ubuntu worker timings. No household, network, phone or Pi latency claim.' };
const selections = [
  { name: 'day/power', view: 'power', startDate: '2026-10-06' },
  { name: 'week/phases', view: 'phases', startDate: '2026-09-30' },
  { name: '22-days/power', view: 'power', startDate: '2026-09-15' },
];
try {
  report.fixture = seedChartPerformanceFixture(store, { days });
  for (const [sourceIndex, root] of roots.entries()) {
    const { createChartService } = await import(pathToFileURL(join(resolve(root), 'src/app/chart-service.js')));
    for (const selection of selections) {
      const service = createChartService({ store, warmCache: false, clock: () => now });
      try {
        const { name, ...view } = selection;
        const args = { ...view, endDate: '2026-10-06', input: 'providers', now, contract, points: 800 };
        let start = performance.now();
        const first = await service.query(args), coldMs = performance.now() - start, hash = digest(first);
        if (!expected.has(name)) expected.set(name, hash);
        assert.equal(hash, expected.get(name), 'The candidate preserves original evidence and geometry');
        assert.equal((await service.query(args)).meta.cacheHit, true);
        const samples = [];
        for (let run = 0; run < runs; run++) {
          seedVoltageFixture(store, { at: now - 1000 + sourceIndex * 100 + run,
            input: 'providers', voltageV: [236 + run, 238, 240] });
          start = performance.now();
          const after = await service.query(args), ms = performance.now() - start;
          assert.equal(digest(after), hash, 'A later voltage publication cannot change this closed drawing');
          if (sourceIndex === roots.length - 1) assert.equal(after.meta.cacheHit, true, 'Unrelated voltage must retain the candidate response');
          samples.push({ ms: Math.round(ms * 100) / 100, cacheHit: after.meta.cacheHit === true });
        }
        const row = { source: roots.length > 1 ? sourceIndex === 0 ? 'baseline' : 'candidate' : 'current',
          selection: name, coldMs: Math.round(coldMs * 100) / 100, samples, exactEquality: true };
        report.results.push(row); process.stderr.write(JSON.stringify(row) + '\n');
      } finally { await service.close(); }
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
