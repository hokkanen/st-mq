import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

// Run this same harness against either source tree. All state is synthetic and
// in memory; no provider, adapter, configuration file or installed database is
// opened. --expose-gc makes the explicitly labelled retained-heap samples useful.
const sourceRoot = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)));
const load = path => import(pathToFileURL(resolve(sourceRoot, path)).href);
const [{ Engine }, { Store }, { readChargingRuntime }] = await Promise.all([
  load('src/app/engine.js'), load('src/storage/store.js'), load('src/charging/runtime-storage.js'),
]);
const AT = Date.parse('2026-10-16T12:00:00Z');
const INTERVALS = 48, SCENARIOS = 66;
const round = value => Math.round(value * 1000) / 1000;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const plan = (id, forecast = false) => ({ id: `${forecast ? 'forecast' : 'accepted'}:${id}`,
  at: AT, deadlineAt: AT + 12 * 3_600_000, targetAt: AT + 12 * 3_600_000,
  state: 'waiting', feasible: true, requiredGridKwh: 18, deliveredGridKwh: 18,
  costCents: id === 'charger1' ? 123.4567 : 98.7654,
  periods: [{ startAt: AT + 3_600_000, endAt: AT + 3 * 3_600_000 }],
  allocations: Array.from({ length: INTERVALS }, (_, index) => ({
    start: AT + index * 900_000, end: AT + (index + 1) * 900_000, targetA: 6 + index % 8,
  })),
  intervals: Array.from({ length: INTERVALS }, (_, index) => ({
    start: AT + index * 900_000, end: AT + (index + 1) * 900_000,
    priceCtPerKwh: 4 + index % 12, powerKw: index % 4 ? 11 : 0,
    scenarios: Array.from({ length: SCENARIOS }, (_, scenario) => ({
      source: `synthetic-household-${scenario}`, phaseCurrentA: [scenario / 3, scenario / 4, scenario / 5],
      weight: 1 / SCENARIOS,
    })),
    reference: { method: 'synthetic-history', oldestAt: AT - 7 * 86_400_000, newestAt: AT,
      sampleCount: SCENARIOS, quality: ['synthetic'], window: [0, 900_000] },
  })),
  accounting: Array.from({ length: INTERVALS }, (_, index) => ({
    start: AT + index * 900_000, end: AT + (index + 1) * 900_000,
    priceCtPerKwh: 4 + index % 12, deliveredGridKwh: 18 / INTERVALS,
  })),
  priceSnapshot: 'synthetic-published-prices', decisionPriceSnapshot: 'synthetic-decision-prices',
});

const store = new Store(':memory:');
const engine = new Engine({ store, config: { input: 'simulated', settings: {} }, clock: () => AT });
const runtime = engine.charging;
const measurements = [];
let supplyRevision = 0;
const snapshotHeap = () => { global.gc?.(); return process.memoryUsage().heapUsed; };
function measure(name, operation, { iterations = 48, warmup = 8 } = {}) {
  let result;
  for (let index = 0; index < warmup; index++) result = operation();
  const beforeHeap = snapshotHeap(), cpu = process.cpuUsage(), started = performance.now();
  for (let index = 0; index < iterations; index++) result = operation();
  const wallMs = performance.now() - started, used = process.cpuUsage(cpu);
  const afterLoopHeap = process.memoryUsage().heapUsed;
  const afterGcHeap = snapshotHeap();
  measurements.push({ name, iterations, warmup, wallMs: round(wallMs), wallMsPerOperation: round(wallMs / iterations),
    processCpuMs: round((used.user + used.system) / 1000),
    processCpuMsPerOperation: round((used.user + used.system) / 1000 / iterations),
    heap: { gcAvailable: typeof global.gc === 'function', beforeBytes: beforeHeap,
      afterLoopBytes: afterLoopHeap, afterGcBytes: afterGcHeap,
      retainedDeltaBytes: typeof global.gc === 'function' ? afterGcHeap - beforeHeap : null } });
  return result;
}
const changeSupply = () => {
  for (const item of Object.values(runtime.chargers)) item.supplyEstimate.observedAt = AT + ++supplyRevision;
};
try {
  await store.runWrite(() => engine.tick());
  await runtime.planningFlight;
  for (const [id, item] of Object.entries(runtime.chargers)) {
    assert.equal(item.adapter, undefined, 'No native adapter may be constructed');
    assert.equal(item.controller, undefined, 'No native controller may be constructed');
    item.plan = plan(id);
    item.forecast = plan(id, true);
    item.supplyEstimate = { voltageV: 230, observedAt: AT, basis: 'synthetic' };
  }
  measure('first-publication-with-ownership-and-encoding', () => runtime.persistAcceptedState(AT),
    { iterations: 1, warmup: 0 });
  const expected = runtime.views(AT).map(row => ({ id: row.id, plan: row.plan, forecast: row.forecast }));
  for (const row of expected) {
    assert.equal(row.plan.intervals.length, INTERVALS);
    assert.equal(row.plan.intervals.reduce((sum, interval) => sum + interval.scenarios.length, 0), INTERVALS * SCENARIOS);
    assert.equal(row.plan.costCents, row.id === 'charger1' ? 123.4567 : 98.7654);
  }
  const views = measure('runtime-views', () => runtime.views(AT), { iterations: 96 });
  const status = measure('runtime-status', () => runtime.status(AT), { iterations: 96 });
  assert.deepEqual(views.map(row => ({ id: row.id, plan: row.plan, forecast: row.forecast })), expected);
  assert.deepEqual(status.chargers.map(row => ({ id: row.id, plan: row.plan, forecast: row.forecast })), expected);

  const rollback = Symbol('synthetic-rollback');
  const restoredSupply = Object.fromEntries(Object.entries(runtime.chargers).map(([id, item]) => [id, item.supplyEstimate.observedAt]));
  measure('runtime-rollback-snapshot-and-restore', () => {
    try { store.transaction(() => { runtime.preserveWriteState(); changeSupply(); throw rollback; }); }
    catch (error) { if (error !== rollback) throw error; }
  });
  for (const [id, observedAt] of Object.entries(restoredSupply)) assert.equal(runtime.chargers[id].supplyEstimate.observedAt, observedAt);
  assert.deepEqual(runtime.views(AT).map(row => ({ id: row.id, plan: row.plan, forecast: row.forecast })), expected);

  measure('runtime-persistence-with-small-state-changes', () => {
    changeSupply(); runtime.persistAcceptedState(AT);
  }, { iterations: 32, warmup: 4 });
  const restored = readChargingRuntime(store, runtime.key);
  for (const [id, item] of Object.entries(runtime.chargers)) {
    const { decisionPriceSnapshot, ...durable } = item.plan;
    assert.deepEqual(restored.chargers[id].plan, durable);
    assert.equal(restored.chargers[id].supplyEstimate.observedAt, item.supplyEstimate.observedAt);
  }

  // Include the superseded charging graph present in a real controller tick.
  // Its replacement is read from the actual runtime, rather than a stub.
  engine.latestStatus.charging = runtime.status(AT);
  const engineStatus = measure('engine-status-with-committed-snapshot', () => engine.status(), { iterations: 64 });
  assert.deepEqual(engineStatus.charging.chargers.map(row => ({ id: row.id, plan: row.plan, forecast: row.forecast })), expected);
  const stateRows = store.db.prepare('SELECT key,value FROM state WHERE key GLOB ? ORDER BY key').all(`${runtime.key}*`)
    .map(row => ({ key: row.key, value: JSON.parse(row.value) }));
  console.log(JSON.stringify({ node: process.version, host: `${process.platform}/${process.arch}`, sourceRoot,
    fixture: { chargers: 2, planIntervalsPerCharger: INTERVALS, scenariosPerInterval: SCENARIOS,
      separateForecastPerCharger: true, planAndForecastJsonBytes: Buffer.byteLength(JSON.stringify(expected)),
      storage: 'in-memory SQLite', nativeAdapters: 0, nativeControllers: 0 }, measurements,
    fingerprints: { views: fingerprint(views), runtimeStatus: fingerprint(status), engineCharging: fingerprint(engineStatus.charging),
      persistedRuntime: fingerprint(restored), chargingStateRows: fingerprint(stateRows) },
    persisted: { rowCount: stateRows.length, jsonBytes: stateRows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.value)), 0) },
    notes: ['Wall and CPU cover the named synchronous operation including its normal internal work.',
      'First publication includes initial ownership and encoding; it is measured separately from repeated work.',
      'Heap samples show observed heap occupancy and retained change after explicit GC, never total allocations.',
      'Engine parity fingerprints cover its complete charging projection; unrelated heating learning epochs are independently generated per database.',
      'Synthetic source-tree comparison; no installed Raspberry Pi, storage latency or physical actuation is qualified.'],
  }, null, 2));
} finally {
  engine.beginShutdown({ restore: false });
  await runtime.close(); await engine.garage.close({ restore: false });
  await engine.closeFireplace(); await engine.executor.close({ restore: false }); store.close();
}
