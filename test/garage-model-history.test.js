import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { garageHistoricalObservations, reconstructGarageHistory } from '../src/garage/history.js';
const HOUR = 3_600_000, start = Date.parse('2026-01-01T00:00:00Z');
const config = { from: start, to: start + 30 * HOUR, asOf: start + 100 * HOUR };
function importId(store, suffix, status = 'complete') {
  return Number(store.db.prepare(`INSERT INTO imports(kind,sha256,path,status,started_at) VALUES ('stmq',?,?,?,?)`)
    .run(`fixture-${suffix}`, `/invented/history-${suffix}.csv`, status, start).lastInsertRowid);
}
function add(store, id, row, signal, value, extra = {}) {
  return store.observation({ source: id === null ? 'synthetic-recorded-source' : 'csv:stmq', device: 'invented-garage',
    signal, value, unit: signal.includes('current') ? 'A' : signal.includes('energy') ? 'kWh' : 'degC',
    sourceTime: start + row * HOUR, receivedAt: start + 90 * HOUR,
    quality: ['historical'], ...(id === null ? {} : { provenance: { importId: id, rowNumber: row + 1 } }), ...extra });
}

test('imported rear/outdoor reconstruction remains separate and cannot invent front, OFF, power or baseline', () => {
  const store = new Store(':memory:');
  try {
    const id = importId(store, 'a');
    for (let i = 0; i < 24; i++) {
      add(store, id, i, 'garage_temperature', 7 - i / 100);
      add(store, id, i, 'outdoor_temperature', 0);
      add(store, id, i, 'requested_heat_mode', 0, { unit: 'legacy_command' });
    }
    const before = store.db.prepare('SELECT COUNT(*) n FROM observations').get().n;
    const result = reconstructGarageHistory(store, config);
    assert.equal(result.samples, 24); assert.equal(result.rearOnly, 24);
    assert.equal(result.model.state.frontC, null);
    assert.equal(Object.hasOwn(result.model.state, 'coreC'), false);
    assert.equal(result.model.state.rearC, 6.77);
    assert.equal(result.model.evidence.offIntervals, 0); assert.equal(result.model.native.samples, 0);
    assert.equal(result.model.normalReference.samples, 0); assert.equal(result.model.rear.samples, 0);
    assert.equal(result.summary.normalReference.roomTargetC, null);
    assert.equal(result.summary.normalReference.rearC, null); assert.equal(result.summary.normalReference.frontC, null);
    assert.equal(result.summary.ready, false); assert.equal(result.summary.heldOut.rear.n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, before);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM learning_journal').get().n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM state').get().n, 0);
    assert.equal(reconstructGarageHistory(store, config).checksum, result.checksum);
  } finally { store.close(); }
});

test('later completed import scalar precedence is deterministic; duplicate times count once and simulations stay separate', () => {
  const store = new Store(':memory:');
  try {
    const first = importId(store, 'first'), second = importId(store, 'second'), incomplete = importId(store, 'incomplete', 'importing');
    add(store, first, 0, 'garage_temperature', 6);
    add(store, second, 0, 'garage_temperature', 7);
    add(store, second, 0, 'garage_temperature', 7);
    add(store, incomplete, 0, 'garage_temperature', 9);
    add(store, null, 0, 'garage_temperature', 12, { source: 'simulation' });
    add(store, null, 1, 'garage_temperature', 20);
    add(store, first, 1, 'outdoor_temperature', -3);
    add(store, second, 2, 'garage_temperature', 6.8);
    const rows = [...garageHistoricalObservations(store, config)];
    assert.equal(rows.length, 2); assert.equal(rows[0].rearC, 7);
    assert.equal(rows[0].outdoorC, null, 'Future outdoor reading cannot fill a past row');
    assert.equal(rows[1].outdoorC, -3);
    assert.equal(rows[0].provenance.rearImportId, second);
  } finally { store.close(); }
});

test('historical EV1 current and EV2 interval activity preserve identity without fabricating watts', () => {
  const store = new Store(':memory:');
  try {
    const id = importId(store, 'ev');
    for (const phase of [1, 2, 3]) add(store, id, 0, `ev1_current_l${phase}`, phase === 1 ? 12 : 0);
    add(store, null, 0, 'ev2_energy', .1, { raw: { intervalStart: start - 5 * 60_000, intervalEnd: start } });
    add(store, id, 0, 'garage_temperature', 7);
    add(store, id, 1, 'garage_temperature', 7);
    const rows = [...garageHistoricalObservations(store, config)];
    assert.equal(rows[0].ev1Active, true); assert.equal(rows[0].ev2Active, true);
    assert.equal(rows[0].ev1Kw, null); assert.equal(rows[0].ev2Kw, null);
    assert.equal(rows[1].ev1Active, null); assert.equal(rows[1].ev2Active, null);
    const importedOnly = [...garageHistoricalObservations(store, { ...config, includeRecordedEvActivity: false })];
    assert.equal(importedOnly[0].ev1Active, true); assert.equal(importedOnly[0].ev2Active, null);
  } finally { store.close(); }
});

test('historical sample cap and as-of boundary are explicit and do not read mutable future receipts', () => {
  const store = new Store(':memory:');
  try {
    const id = importId(store, 'bounded');
    for (let i = 0; i < 5; i++) add(store, id, i, 'garage_temperature', 7);
    const short = reconstructGarageHistory(store, { ...config, maxSamples: 2 });
    assert.equal(short.samples, 2); assert.equal(short.bounded, true);
    assert.equal(reconstructGarageHistory(store, { ...config, asOf: start + HOUR }).samples, 0);
    assert.throws(() => [...garageHistoricalObservations(store, { ...config, maxSamples: Infinity })], /maxSamples/);
    assert.throws(() => reconstructGarageHistory(store, { from: 2, to: 1 }), /UTC range/);
  } finally { store.close(); }
});
