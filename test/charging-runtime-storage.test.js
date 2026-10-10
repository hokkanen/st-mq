import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { Store } from '../src/storage/store.js';
import { encodeChange } from '../src/storage/journal-codec.js';
import { readChargingRuntime, writeChargingRuntime } from '../src/charging/runtime-storage.js';

const key = 'charging:simulated', at = 1_800_000_000_000;
const plan = () => ({ id: 'synthetic-accepted-plan', at, deadlineAt: at + 86_400_000,
  targetAt: at + 86_400_000, periods: [{ startAt: at + 3600_000, endAt: at + 7200_000 }],
  allocations: [{ start: at, end: at + 3600_000, targetA: 16 }],
  intervals: Array.from({ length: 60 }, (_, i) => ({ start: at + i * 900_000, end: at + (i + 1) * 900_000,
    priceCtPerKwh: i % 10, powerKw: 11, scenarios: Array.from({ length: 24 }, (_, j) => ({
      source: `synthetic-scenario-${j}`, phaseCurrentA: [j / 3, j / 4, j / 5], weight: 1 / 24,
      reference: 'synthetic bounded planning context',
    })), reference: { method: 'synthetic-reference', oldestAt: at - 86_400_000, newestAt: at } })) });
function fixture() {
  const accepted = plan();
  return { version: 7, revision: 3, controls: { association: 'a'.repeat(64), priority: 'charger1', revision: 2 },
    chargers: { charger1: { association: 'b'.repeat(64), controls: { enabled: false, revision: 1 },
      supplyEstimate: { observedAt: at, voltageV: 230 }, plan: accepted, request: null },
    charger2: { association: 'c'.repeat(64), controls: { enabled: false, revision: 1 }, plan: null } },
    vehicleFeeds: {}, consumedTeslaPower: { association: 'synthetic-vehicle', receivedAt: at }, consumedTeslaCurrent: null,
    view: { settings: { synthetic: true }, reportRetentionDays: 30, chargers: [
      { id: 'charger1', plan: structuredClone(accepted), values: { powerKw: { value: 0, measuredAt: at, receivedAt: at } },
        telemetry: { readAt: at }, control: { phase: 'off' } },
      { id: 'charger2', plan: null, values: {}, telemetry: { readAt: at } },
    ] } };
}
const rows = store => store.db.prepare('SELECT key,value,updated_at FROM state ORDER BY key').all();
const rawReader = db => ({ db, getState: key => { const row = db.prepare('SELECT value FROM state WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; } });
function disk(t) {
  const directory = mkdtempSync(join(tmpdir(), 'charging-runtime-storage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'state.sqlite');
}

test('charging plans and scenario context are single referenced records with lossless current-format restart', t => {
  const path = disk(t), store = new Store(path), saved = fixture();
  writeChargingRuntime(store, key, saved);
  assert.deepEqual(readChargingRuntime(store, key), saved);
  const manifest = store.getState(key);
  assert.equal(manifest.plans.length, 1);
  assert.equal(manifest.contexts.length, 1);
  assert.equal(store.db.prepare("SELECT count(*) n FROM state WHERE key GLOB 'charging:*:runtime:plan/*'").get().n, 1);
  const compact = store.getState(`${key}:runtime:plan/${manifest.plans[0]}`);
  assert.equal(compact.value.intervals[0].scenarios, undefined);
  assert.equal(compact.value.intervals[0].reference, undefined);
  store.close();
  const restarted = new Store(path);
  try { assert.deepEqual(readChargingRuntime(restarted, key), saved); }
  finally { restarted.close(); }
});

test('fresh evidence clocks leave plan/context rows untouched and reduce actual journal payload by at least 95.5 percent', t => {
  const store = new Store(':memory:');
  try {
    let saved = fixture(); writeChargingRuntime(store, key, saved);
    const baselinePlanRows = rows(store).filter(row => /runtime:(?:plan|context)\//.test(row.key));
    const sequence = store.checkpoint().sequence;
    let aggregateBytes = 0;
    for (let tick = 1; tick <= 80; tick++) {
      const next = structuredClone(saved);
      next.chargers.charger1.supplyEstimate.observedAt = at + tick * 1000;
      next.view.chargers[0].values.powerKw.receivedAt = at + tick * 1000;
      next.view.chargers[0].telemetry.readAt = at + tick * 1000;
      next.view.chargers[1].telemetry.readAt = at + tick * 1000;
      aggregateBytes += Buffer.byteLength(JSON.stringify(encodeChange('state', [key],
        { key, value: JSON.stringify(saved), updated_at: at + (tick - 1) * 1000 },
        { key, value: JSON.stringify(next), updated_at: at + tick * 1000 })));
      writeChargingRuntime(store, key, next); saved = next;
    }
    const changes = store.db.prepare('SELECT table_name,record_key,payload FROM journal_changes WHERE sequence>?').all(sequence);
    const actualBytes = changes.reduce((sum, row) => sum + Buffer.byteLength(row.payload), 0);
    t.diagnostic(JSON.stringify({ actualJournalBytes: actualBytes, aggregateJournalBytes: aggregateBytes, reductionPercent: 100 * (1 - actualBytes / aggregateBytes) }));
    assert.ok(actualBytes / aggregateBytes < .045, JSON.stringify({ actualBytes, aggregateBytes }));
    assert.equal(changes.length, 80 * 4, 'Only the four changed evidence fields are journaled');
    assert.ok(changes.every(row => row.table_name === 'state' && !/runtime:(?:plan|context)\//.test(row.record_key)));
    assert.deepEqual(rows(store).filter(row => /runtime:(?:plan|context)\//.test(row.key)), baselinePlanRows);
    assert.deepEqual(readChargingRuntime(store, key), saved);
  } finally { store.close(); }
});

test('runtime fragments, immutable context replacement and garbage collection roll back together', () => {
  const store = new Store(':memory:');
  try {
    const saved = fixture(); writeChargingRuntime(store, key, saved);
    const original = rows(store), checkpoint = store.checkpoint(), next = structuredClone(saved);
    next.chargers.charger1.plan.intervals[0].scenarios[0].weight = .5;
    next.view.chargers[0].plan = structuredClone(next.chargers.charger1.plan);
    next.chargers.charger1.controls.enabled = true;
    const set = store.setState.bind(store);
    store.setState = (rowKey, value) => { if (rowKey === key) throw new Error('synthetic final save failure'); return set(rowKey, value); };
    assert.throws(() => writeChargingRuntime(store, key, next), /synthetic final save failure/);
    assert.deepEqual(rows(store), original);
    assert.deepEqual(store.checkpoint(), checkpoint);
    assert.deepEqual(readChargingRuntime(store, key), saved);
    store.setState = set;
    writeChargingRuntime(store, key, next);
    assert.deepEqual(readChargingRuntime(store, key), next);
    assert.equal(store.db.prepare("SELECT count(*) n FROM state WHERE key GLOB 'charging:*:runtime:plan/*'").get().n, 1);
    assert.equal(store.db.prepare("SELECT count(*) n FROM state WHERE key GLOB 'charging:*:runtime:context/*'").get().n, 1);
  } finally { store.close(); }
});

test('an enclosing failed commit cannot publish new fragments or delete the prior plan', () => {
  const store = new Store(':memory:');
  try {
    const saved = fixture(); writeChargingRuntime(store, key, saved);
    const original = rows(store), next = structuredClone(saved);
    next.chargers.charger1.plan.id = 'replacement';
    next.view.chargers[0].plan = structuredClone(next.chargers.charger1.plan);
    const exec = store.db.exec.bind(store.db);
    store.db.exec = sql => { if (sql === 'COMMIT') throw new Error('synthetic commit failure'); return exec(sql); };
    assert.throws(() => store.transaction(() => writeChargingRuntime(store, key, next)), /synthetic commit failure/);
    store.db.exec = exec;
    assert.deepEqual(rows(store), original);
    assert.deepEqual(readChargingRuntime(store, key), saved);
    writeChargingRuntime(store, key, next);
    assert.deepEqual(readChargingRuntime(store, key), next);
  } finally { store.close(); }
});

test('a pinned reader keeps a complete old plan while current publication replaces and removes its rows', t => {
  const path = disk(t), store = new Store(path), saved = fixture();
  writeChargingRuntime(store, key, saved);
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    reader.exec('BEGIN'); assert.deepEqual(readChargingRuntime(rawReader(reader), key), saved);
    const next = structuredClone(saved);
    next.chargers.charger1.plan.periods[0].startAt += 60_000;
    next.view.chargers[0].plan = structuredClone(next.chargers.charger1.plan);
    next.chargers.charger1.controls.enabled = true;
    writeChargingRuntime(store, key, next);
    assert.deepEqual(readChargingRuntime(rawReader(reader), key), saved);
    reader.exec('COMMIT');
    assert.deepEqual(readChargingRuntime(rawReader(reader), key), next);
  } finally { reader.close(); store.close(); }
});

for (const damage of ['missing-field', 'missing-plan', 'damaged-context', 'orphan', 'missing-root', 'old-aggregate'])
  test(`startup rejects ${damage} on an inactive input without modifying the database`, t => {
    const path = disk(t), store = new Store(path), saved = fixture();
    writeChargingRuntime(store, key, saved);
    const manifest = store.getState(key);
    if (damage === 'missing-field') store.db.prepare('DELETE FROM state WHERE key=?').run(`${key}:runtime:charger/charger1/controls`);
    if (damage === 'missing-plan') store.db.prepare('DELETE FROM state WHERE key=?').run(`${key}:runtime:plan/${manifest.plans[0]}`);
    if (damage === 'damaged-context') store.setState(`${key}:runtime:context/${manifest.contexts[0]}`, []);
    if (damage === 'orphan') store.setState(`${key}:runtime:root/unknown`, { value: true });
    if (damage === 'missing-root') store.db.prepare('DELETE FROM state WHERE key=?').run(key);
    if (damage === 'old-aggregate') store.setState(key, { ...saved, version: 6 });
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
    store.close();
    const before = readFileSync(path);
    assert.throws(() => new Store(path), { code: 'database_state_incompatible' });
    assert.deepEqual(readFileSync(path), before);
    assert.equal(existsSync(`${path}-wal`), false);
  });


test('runtime publication failure restores report observers and allowance coverage before retry', async () => {
  const store = new Store(':memory:');
  const runtime = new ChargingRuntime({ engine: {}, store, config: { input: 'mqtt', connections: { easee: { charger_id: 'synthetic-charger' } } }, clock: () => at });
  try {
    const diagnostics = structuredClone(runtime.sessionDiagnostics.state);
    const assessment = structuredClone(runtime.physicalTests.state);
    const set = store.setState.bind(store);
    store.setState = (rowKey, value) => { if (rowKey === runtime.key) throw new Error('synthetic publication failure'); return set(rowKey, value); };
    assert.throws(() => runtime.persistAcceptedState(at), /synthetic publication failure/);
    assert.deepEqual(runtime.sessionDiagnostics.state, diagnostics);
    assert.deepEqual(runtime.physicalTests.state, assessment);
    assert.equal(runtime.sessionDiagnostics.lastSavedAt, 0);
    assert.equal(runtime.sessionDiagnostics.lastPrunedAt, 0);
    assert.equal(runtime.limiterHistory.previous.size, 0);
    assert.equal(store.db.prepare('SELECT count(*) n FROM observations').get().n, 0);
    assert.equal(store.db.prepare('SELECT count(*) n FROM recorder_coverage').get().n, 0);
    store.setState = set;
    runtime.persistAcceptedState(at);
    assert.equal(runtime.limiterHistory.previous.size, 1);
    for (const previous of runtime.limiterHistory.previous.values()) {
      assert.ok(store.db.prepare('SELECT 1 FROM observations WHERE id=?').get(previous.id));
      assert.ok(store.db.prepare('SELECT 1 FROM recorder_coverage WHERE id=?').get(previous.coverageId));
    }
    assert.equal(readChargingRuntime(store, runtime.key).version, 7);
  } finally { await runtime.close(); store.close(); }
});
