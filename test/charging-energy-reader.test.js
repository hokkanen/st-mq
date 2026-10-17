import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { recordedChargingEnergy } from '../src/charging/energy.js';
import { createRecordedChargingEnergyReader } from '../src/charging/energy-reader.js';
import { sourceTimeAdmission } from '../src/domain/time-evidence.js';

const START = Date.parse('2026-10-01T00:00:00Z');
function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const read = createRecordedChargingEnergyReader(store);
  const query = (end = START + 60_000, start = START) => ({ id: 'charger2', device: 'synthetic-evse', start, end });
  const interval = (start, end, { value = .1, receivedAt = end, admittedAt, quality = [], device = 'synthetic-evse' } = {}) => {
    for (const phase of [1, 2, 3]) store.observation({ source: 'shelly-evse', device,
      signal: `ev2_energy_l${phase}`, value, unit: 'kWh', sourceTime: end, receivedAt, quality,
      raw: { intervalStart: start, intervalEnd: end,
        ...(admittedAt !== undefined ? { timeAdmission: sourceTimeAdmission({ sourceTime: end, receivedAt, now: admittedAt, deferred: true }) } : {}) },
    });
  };
  const check = q => assert.deepEqual(read(q), recordedChargingEnergy(store, q));
  return { store, read, query, interval, check };
}

test('unchanged charging views reuse selected cohorts while coverage ages honestly', t => {
  const { store, read, query, interval, check } = fixture(t);
  interval(START, START + 30_000);
  const prepare = store.db.prepare.bind(store.db);
  let historyQueries = 0;
  t.mock.method(store.db, 'prepare', sql => {
    if (sql.startsWith('SELECT id,source,device,signal,value,unit,source_time,received_at,quality,raw')) historyQueries++;
    return prepare(sql);
  });
  const initial = read(query());
  for (let n = 0; n < 50; n++) {
    store.setState('synthetic-unrelated-state', { n });
    const current = read(query(START + 60_000 + n * 100));
    assert.equal(current.gridKwh, initial.gridKwh);
    assert.equal(current.coveredMs, initial.coveredMs);
  }
  assert.equal(historyQueries, 1, 'view and unrelated state changes do not rescan the connection history');
  assert.equal(read(query(START + 180_001)).incomplete, true);
  check(query(START + 180_001));
});

test('late and overlapping cohorts rewind the whole affected conflict cluster', t => {
  const { query, interval, check } = fixture(t);
  interval(START, START + 20_000);
  interval(START + 20_000, START + 40_000);
  interval(START + 40_000, START + 60_000);
  check(query());
  interval(START + 10_000, START + 30_000, { value: .2 });
  check(query());
  interval(START + 30_000, START + 50_000, { value: .2 });
  check(query());
  interval(START + 60_000, START + 70_000);
  check(query(START + 75_000));
});

test('future source, receipt and deferred-admission clocks are not cached as current evidence', t => {
  const { query, interval, check } = fixture(t);
  interval(START, START + 20_000);
  interval(START + 20_000, START + 30_000, { receivedAt: START + 40_000 });
  interval(START + 40_000, START + 50_000, { receivedAt: START + 49_500, admittedAt: START + 60_000 });
  for (const at of [25_000, 35_000, 40_000, 50_000, 59_999, 60_000, 70_000]) check(query(START + at));
  check(query(START + 35_000));
  check(query(START + 70_000));
});

test('durable pending energy changes and flushes remain equivalent to the history reader', t => {
  const { store, query, interval, check } = fixture(t);
  interval(START, START + 20_000);
  const key = 'recorder:energy:' + JSON.stringify(['shelly-evse', 'synthetic-evse', 'ev2']);
  const pending = (start, end, energies) => store.setState(key, { pending: { start, end, receivedAt: end, energies, quality: [] } });
  pending(START + 20_000, START + 30_000, [.2, .2, .2]); check(query());
  pending(START + 20_000, START + 40_000, [.3, .3, .3]); check(query());
  interval(START + 20_000, START + 40_000, { value: .3 });
  pending(START + 40_000, START + 50_000, [.1, .1, .1]); check(query());
  store.setState(key, { pending: null }); check(query());
});

test('rollback, reused row IDs, selection changes and a new device cannot reuse provisional energy', t => {
  const { store, read, query, interval, check } = fixture(t);
  interval(START, START + 20_000); check(query());
  assert.throws(() => store.transaction(() => {
    interval(START + 20_000, START + 40_000, { value: 2 });
    assert.ok(read(query()).gridKwh > 1);
    throw Error('Synthetic rollback');
  }), /Synthetic rollback/);
  interval(START + 20_000, START + 40_000, { value: .2 }); check(query());
  store.db.prepare("UPDATE history_selection SET generation=? WHERE id=1").run("synthetic-new-selection");
  check(query());
  check({ ...query(), device: 'another-device' });
  check(query(START + 45_000, START + 10_000));
});

test('mixed late arrivals, gaps, zero energy and changing query cutoffs match a full read', t => {
  const { query, interval, check } = fixture(t);
  let seed = 29;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  let now = START + 100_000;
  for (let n = 0; n < 120; n++) {
    const start = START + random(90) * 1000, end = start + (1 + random(15)) * 1000;
    interval(start, end, { value: random(5) / 20, quality: random(5) === 0 ? ['invalid-value'] : [],
      receivedAt: Math.max(end, START + random(130) * 1000) });
    now += random(5) * 1000;
    check(query(now));
    if (n % 11 === 0) check(query(now - 10_000));
  }
});


test('availability gaps and later measured overlap retain the full-reader meaning', t => {
  const { store, query, interval, check } = fixture(t);
  const gap = (start, end) => {
    for (const phase of [1, 2, 3]) store.observation({ source: 'shelly-evse', device: 'synthetic-evse',
      signal: `ev2_energy_l${phase}`, value: null, unit: 'kWh', sourceTime: end, receivedAt: end,
      quality: ['missing', 'integration-gap'], raw: { intervalStart: start, intervalEnd: end, basis: 'availability-gap' } });
  };
  gap(START, START + 60_000); check(query());
  interval(START + 20_000, START + 30_000); check(query());
  gap(START + 10_000, START + 50_000); check(query());
  interval(START + 40_000, START + 50_000); check(query());
  interval(START + 25_000, START + 45_000); check(query());
});

test('a burst beyond the incremental budget falls back without retaining stale evidence', t => {
  const { query, interval, check } = fixture(t);
  interval(START, START + 100); check(query());
  for (let n = 1; n <= 90; n++) interval(START + n * 100, START + (n + 1) * 100);
  check(query()); check(query());
  interval(START + 9100, START + 9200); check(query());
});

test('worker-backed failed COMMIT and restart cannot publish provisional energy', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-energy-reader-'));
  const path = join(directory, 'fixture.sqlite');
  let store = new Store(path);
  t.after(async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); });
  await store.startWriter();
  const query = { id: 'charger2', device: 'synthetic-evse', start: START, end: START + 60_000 };
  let read = createRecordedChargingEnergyReader(store);
  const append = value => {
    for (const phase of [1, 2, 3]) store.observation({ source: 'shelly-evse', device: query.device,
      signal: `ev2_energy_l${phase}`, value, unit: 'kWh', sourceTime: START + 30_000,
      receivedAt: START + 30_000, quality: [], raw: { intervalStart: START, intervalEnd: START + 30_000 } });
  };
  const request = store.writer.request.bind(store.writer);
  let fail = true;
  t.mock.method(store.writer, 'request', async (command, args) => {
    if (command === 'commit' && fail) { fail = false; throw Error('Synthetic COMMIT rejection'); }
    return request(command, args);
  });
  await assert.rejects(store.runWrite(() => { append(3); assert.ok(read(query).gridKwh > 8); }), /Synthetic COMMIT rejection/);
  assert.deepEqual(read(query), recordedChargingEnergy(store, query));
  assert.equal(read(query).gridKwh, 0);
  await store.runWrite(() => append(.1));
  assert.deepEqual(read(query), recordedChargingEnergy(store, query));
  await store.close();
  store = new Store(path); await store.startWriter();
  read = createRecordedChargingEnergyReader(store);
  assert.deepEqual(read(query), recordedChargingEnergy(store, query));
  assert.ok(Math.abs(read(query).gridKwh - .3) < 1e-12);
});

test('an independently updated read-only view never retains an owned session projection', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-energy-readonly-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  const reader = new Store(store.path, { readOnly: true });
  t.after(async () => { reader.close(); await store.close(); rmSync(directory, { recursive: true, force: true }); });
  const read = createRecordedChargingEnergyReader(reader);
  const query = { id: 'charger2', device: 'synthetic-evse', start: START, end: START + 60_000 };
  assert.equal(read(query).gridKwh, 0);
  for (const phase of [1, 2, 3]) store.observation({ source: 'shelly-evse', device: query.device,
    signal: `ev2_energy_l${phase}`, value: .2, unit: 'kWh', sourceTime: START + 30_000,
    receivedAt: START + 30_000, quality: [], raw: { intervalStart: START, intervalEnd: START + 30_000 } });
  assert.deepEqual(read(query), recordedChargingEnergy(reader, query));
  assert.ok(Math.abs(read(query).gridKwh - .6) < 1e-12);
});
