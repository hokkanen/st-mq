import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serialize } from 'node:v8';
import { Store } from '../src/storage/store.js';
import { createRecordedChargingEnergyReader } from '../src/charging/energy-reader.js';
import { recordedChargingEnergy } from '../src/charging/energy.js';
import { sourceTimeAdmission } from '../src/domain/time-evidence.js';
import { RECORDING_VERSION } from '../src/storage/recorder.js';

const START = Date.parse('2026-10-01T00:00:00Z');
function interval(store, { source = 'shelly-evse', device = 'synthetic-evse', prefix = 'ev2',
  start, end, receivedAt = end, admittedAt, value = .1 } = {}) {
  return [1, 2, 3].map(phase => store.observation({ source, device, signal: `${prefix}_energy_l${phase}`,
    value, unit: 'kWh', sourceTime: end, receivedAt, quality: [], raw: { intervalStart: start, intervalEnd: end,
      durationMs: end - start, basis: prefix === 'ev2' ? 'native-meter-counter-phase-allocation' : 'integrated-power-phase-allocation',
      recorder: { version: RECORDING_VERSION, policy: 'adaptive-energy', reason: 'power-boundary', group: prefix },
      ...(admittedAt === undefined ? {} : { timeAdmission: sourceTimeAdmission({ sourceTime: end, receivedAt,
        now: admittedAt, deferred: true }) }) } }));
}

test('real writer warm charging reads seek the new ID suffix despite growing same-meter archives', async () => {
  for (const profile of [{ id: 'charger1', source: 'easee', prefix: 'ev1' },
    { id: 'charger2', source: 'shelly-evse', prefix: 'ev2' }]) {
    const selectedSizes = [];
    for (const count of [1000, 10000]) {
      const directory = mkdtempSync(join(tmpdir(), 'st-mq-charging-warm-index-'));
      const store = new Store(join(directory, 'recording.sqlite'));
      try {
        const device = 'synthetic-native-charger';
        for (let from = 0; from < count; from += 64) store.transaction(() => {
          for (let n = from; n < Math.min(count, from + 64); n++) interval(store, { ...profile, device,
            start: START - (count - n + 1) * 1000, end: START - (count - n) * 1000 });
        });
        interval(store, { ...profile, device, start: START, end: START + 20_000 });
        await store.startWriter();
        const read = createRecordedChargingEnergyReader(store);
        const query = { id: profile.id, device, start: START, end: START + 60_000 };
        const call = store.writer.call.bind(store.writer), warm = [], cold = [];
        store.writer.call = (operation, parameters) => {
          const result = call(operation, parameters);
          if (operation === 'statement' && parameters.sql.startsWith('SELECT id,source_time,received_at,raw FROM ')) {
            const details = { sql: parameters.sql, params: parameters.params, rows: result.length,
              bytes: serialize(result).byteLength, plan: call('statement', { ...parameters,
                sql: `EXPLAIN QUERY PLAN ${parameters.sql}`, method: 'all' }).map(row => row.detail) };
            (parameters.sql.includes('ORDER BY id') ? warm : cold).push(details);
          }
          return result;
        };
        await store.runWrite(() => assert.deepEqual(read(query), recordedChargingEnergy(store, query)));
        assert.equal(cold.length, 1);
        assert(cold[0].sql.includes('WHERE signal IN (?,?,?) AND source=?'));
        assert(cold[0].sql.includes('AND device=?'));
        assert(cold[0].plan.some(line => /observations_signal_time .*signal=\? AND source_time>\?/.test(line)), cold[0].plan.join('; '));
        await store.runWrite(() => {
          store.observation({ source: 'fmi', device: 'synthetic-weather', signal: 'outdoor_temperature', value: 5,
            unit: 'degC', sourceTime: START + 30_000, receivedAt: START + 30_000, quality: [] });
          assert.deepEqual(read(query), recordedChargingEnergy(store, query));
        });
        await store.runWrite(() => {
          interval(store, { ...profile, device, start: START + 20_000, end: START + 40_000, value: .2 });
          const result = read(query);
          assert.deepEqual(result, recordedChargingEnergy(store, query));
          assert(Math.abs(result.gridKwh - .9) < 1e-12);
          assert.equal(result.coveredMs, 40_000);
        });
        await store.runWrite(() => {
          // Statistics must not allow a device-prefix skip scan of the archive.
          store.db.exec('ANALYZE observations');
          store.observation({ source: 'fmi', device: 'synthetic-weather', signal: 'outdoor_temperature', value: 6,
            unit: 'degC', sourceTime: START + 50_000, receivedAt: START + 50_000, quality: [] });
          assert.deepEqual(read(query), recordedChargingEnergy(store, query));
        });
        assert.equal(warm.length, 3, 'The primed reader uses its incremental SQL path');
        assert.deepEqual(warm.map(row => row.params.at(-2) - row.params.at(-3)), [1, 3, 1],
          'Only newly appended global IDs form each candidate suffix');
        assert.deepEqual(warm.map(row => row.rows), [0, 3, 0]);
        for (const row of warm) {
          assert(row.bytes < 4096);
          assert(row.plan.some(line => /USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/.test(line)), row.plan.join('; '));
          assert(!row.plan.some(line => /TEMP B-TREE|SCAN (?:r|observations)\b/.test(line)), row.plan.join('; '));
        }
        selectedSizes.push(warm.map(row => row.rows));
      } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
    }
    assert.deepEqual(selectedSizes, [[0, 3, 0], [0, 3, 0]]);
  }
});

test('warm charging delta filters retain native parity for clocks, late history, selection and rollback', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'st-mq-charging-warm-parity-'));
  const store = new Store(join(directory, 'recording.sqlite'));
  t.after(async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); });
  await store.startWriter();
  const read = createRecordedChargingEnergyReader(store), device = '123.0';
  const query = { id: 'charger2', device, start: START, end: START + 60_000 };
  const writerCall = store.writer.call.bind(store.writer), numericCandidates = [];
  store.writer.call = (operation, parameters) => {
    const result = writerCall(operation, parameters);
    if (operation === 'statement' && parameters.sql.startsWith('SELECT id,source_time,received_at,raw FROM active_observations')
      && parameters.params[4] === 123) numericCandidates.push(result.length);
    return result;
  };
  const append = (start, end, options = {}) => interval(store, { device, start: START + start, end: START + end, ...options });
  const check = (end = 60_000, options = {}) => {
    const selected = { ...query, end: START + end, ...options };
    assert.deepEqual(read(selected), recordedChargingEnergy(store, selected));
  };
  await store.runWrite(() => {
    const original = append(0, 20_000); check();
    append(20_000, 40_000, { value: .2 }); check();
    assert(Math.abs(read(query).gridKwh - .9) < 1e-12);
    append(40_000, 50_000, { source: 'simulation', value: 9 }); check();
    append(40_000, 50_000, { device: 'another-device', value: 8 }); check();
    append(10_000, 30_000, { value: .3 }); check();
    append(60_000, 80_000); check(); check(70_000); check(80_000);
    append(80_000, 90_000, { receivedAt: START + 100_000 }); check(90_000); check(100_000);
    append(110_000, 120_000, { receivedAt: START + 119_500, admittedAt: START + 130_000 });
    check(120_000); check(129_999); check(130_000);
    store.transaction(() => {
      store.db.prepare("UPDATE history_selection SET generation='synthetic-energy-selection' WHERE id=1").run();
      for (const id of original) store.db.prepare(`INSERT INTO recovery_exclusions(generation,table_name,record_key)
        VALUES('synthetic-energy-selection','observations',?)`).run(String(id));
    });
    check(130_000);
    let provisional;
    assert.throws(() => store.transaction(() => {
      provisional = append(130_000, 140_000, { value: 4 }); check(150_000);
      throw new Error('Synthetic charging rollback');
    }), /Synthetic charging rollback/);
    const committed = append(130_000, 140_000, { value: .2 });
    assert.deepEqual(committed, provisional, 'The native IDs are reused after rollback');
    check(150_000); check(140_000); check(150_000, { device: 'another-device' });
    check(150_000, { device: undefined }); check(150_000, { device });
    check(150_000, { device: 123 });
    append(140_000, 145_000); check(150_000, { device: 123 });
    assert.deepEqual(numericCandidates, [3], 'Delta SQL retains the original TEXT binding affinity');
  });
});
