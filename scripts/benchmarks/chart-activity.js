// Same synthetic database, matched sources, no installation configuration or
// devices. Run without other CPU-heavy suites for useful timing comparisons.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { Store } from '../../src/storage/store.js';
import { ChargingAllowanceHistory } from '../../src/charging/allowance-history.js';
import { seedChartActivityFixture, ACTIVITY_FIXTURE_FROM as from, ACTIVITY_FIXTURE_TO as to,
  ACTIVITY_FIXTURE_SIGNALS } from '../lib/chart-activity-fixture.js';

const argv = process.argv.slice(2), option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const roots = [option('--baseline', null), resolve(option('--source', '.'))].filter(Boolean);
const runs = Number(option('--runs', 3));
assert(Number.isInteger(runs) && runs >= 1 && runs <= 10);
const directory = mkdtempSync(join(tmpdir(), 'stmq-activity-performance-'));
const store = new Store(join(directory, 'synthetic.sqlite'));
const median = values => { const sorted = values.toSorted((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const expected = new Map(), report = { runtime: process.version, results: [], note: 'Synthetic local cold/warm worker, wire and main-loop measurements; no live/Pi timing claim.' };
try {
  seedChartActivityFixture(store);
  const history = new ChargingAllowanceHistory({ store, input: 'providers' });
  for (let batch = 0; batch < 60; batch++) store.transaction(() => {
    for (let offset = 0; offset < 100; offset++) {
      const index = batch * 100 + offset, at = from + index * 5000;
      history.observe({ chargerId: 'charger2', association: 'b'.repeat(64), status: { mode: 'limited', allowanceA: 12,
        maximumCurrentA: 16, reportedAllowanceA: null, reason: index % 2 ? 'fuse-limit' : 'priority-allocation',
        source: 'st-mq-load-balancing', measuredAt: at, receivedAt: at, sourceTimes: [], sourceEpoch: null, limiter: null } }, at);
    }
  });
  history.flush();
  for (const [sourceIndex, root] of roots.entries()) {
    const { createChartService } = await import(pathToFileURL(join(resolve(root), 'src/app/chart-service.js')));
    for (const selection of [...ACTIVITY_FIXTURE_SIGNALS.map(left => ({ left })), { view: 'charging_currents' }]) {
      const times = [], warm = [], delays = [];
      let bytes, compressed, bars;
      for (let run = 0; run < runs; run++) {
        const service = createChartService({ store, warmCache: false });
        let previous = performance.now(), delay = 0;
        const heartbeat = setInterval(() => { const at = performance.now(); delay = Math.max(delay, at - previous - 5); previous = at; }, 5);
        try {
          const args = { ...selection, input: 'providers', now: to + 12 * 3600_000, points: 800,
            startDate: '2026-10-05', endDate: '2026-10-06' };
          const begin = performance.now(), wire = await service.queryWire(args); times.push(performance.now() - begin);
          const repeat = performance.now(); await service.queryWire(args); warm.push(performance.now() - repeat);
          const result = JSON.parse(Buffer.from(wire)); bytes = wire.byteLength; compressed = gzipSync(wire).byteLength;
          const key = selection.left ?? selection.view, numeric = JSON.stringify(result.series);
          if (!expected.has(key)) expected.set(key, numeric);
          assert.equal(numeric, expected.get(key), `${key}: numeric values, selected detail and provenance are unchanged`);
          bars = Object.values(result.shading).reduce((sum, rows) => sum + rows.length, result.operatingModes.length);
          await new Promise(resolve => setTimeout(resolve, 10)); delays.push(delay);
        } finally { clearInterval(heartbeat); await service.close(); }
      }
      const row = { source: roots.length === 1 ? 'current' : sourceIndex === 0 ? 'baseline' : 'candidate',
        selection: selection.left ?? selection.view, coldMedianMs: median(times), warmMedianMs: median(warm),
        worstMainLoopDelayMs: Math.max(...delays), bytes, gzipBytes: compressed, intervals: bars };
      report.results.push(row); process.stderr.write(`${row.source} ${row.selection}: ${row.coldMedianMs.toFixed(1)} ms cold, ${row.warmMedianMs.toFixed(1)} ms cached\n`);
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
