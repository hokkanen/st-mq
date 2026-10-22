import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { importCsv } from '../src/storage/history.js';
import { createHouseholdHistoryCache } from '../src/charging/history-cache.js';
import { createHouseholdForecastService } from '../src/charging/history-service.js';
import { forecastHousehold, householdReferenceIdentity } from '../src/charging/history.js';
import { seedVoltage } from './voltage-fixture.js';
import { sourceTimeAdmission } from '../src/domain/time-evidence.js';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const now = Date.parse('2026-09-15T01:00:00Z');
const options = { now, deadlineAt: now + HOUR, input: 'live', timezone: 'UTC', voltageV: 230,
  outdoorC: -20 };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'household-reference-cache-')), path = join(dir, 'source.sqlite'), store = new Store(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, path, store, filename: `${path}.household-reference.gz` };
}
function native(store, start, { current = 5, temperature = -20, receivedAt = start + HOUR, duration = HOUR, admittedAt } = {}) {
  store.transaction(() => {
    for (const prefix of ['property', 'ev1', 'ev2']) for (let phase = 1; phase <= 3; phase++)
      store.observation({ source: 'easee', device: `synthetic-${prefix}`, signal: `${prefix}_energy_l${phase}`, unit: 'kWh',
        value: prefix === 'property' ? current * 230 / 1000 * duration / HOUR : 0, sourceTime: start + duration,
        receivedAt, quality: [], raw: { intervalStart: start, intervalEnd: start + duration,
          ...(admittedAt === undefined ? {} : { timeAdmission: sourceTimeAdmission({ sourceTime: start + duration, receivedAt, now: admittedAt, deferred: true }) }) } });
    store.observation({ source: 'mqtt', device: 'synthetic-outdoor', signal: 'outdoor_temperature', value: temperature,
      unit: 'degC', sourceTime: start, receivedAt, quality: [] });
  });
}
function connection(t, path, { cache = true, clock } = {}) {
  const db = new DatabaseSync(path, { readOnly: true });
  t.after(() => db.close());
  const store = { db };
  if (cache) store.householdCache = createHouseholdHistoryCache({ path, db, clock });
  return store;
}
function archived(store) {
  seedVoltage(store, now - 365 * DAY);
  native(store, now - 300 * DAY, { current: 9, temperature: -20 });
  native(store, now - 2 * DAY, { current: 3, temperature: 20 });
}

test('household identity never reads voltage history without a completed Easee CSV', async t => {
  const f = fixture(t);
  const facade = { db: { prepare(sql) {
    assert(!sql.includes('voltage-estimate'), 'Native-only forecasts have no retrospective CSV voltage dependency');
    return f.store.db.prepare(sql);
  } } };
  assert.equal(householdReferenceIdentity(facade, options).csvVoltageKey, '');
  const file = join(f.dir, 'st-mq.csv');
  writeFileSync(file, 'unix_time,price,heat_on,temp_in,temp_ga,temp_out\n1701842400,10,15,21,10,0\n');
  await importCsv(f.store, file, { kind: 'stmq' });
  assert.equal(householdReferenceIdentity(facade, options).csvVoltageKey, '', 'Thermal CSVs alone need no current conversion');
});

test('a sealed one-year source restores the compact projection after a real worker restart', async t => {
  const f = fixture(t); archived(f.store);
  let service = createHouseholdForecastService({ store: f.store });
  try {
    const first = await service.request(options);
    assert.equal(first[0].reference.temperatureRangeC[0], -20, 'Summer never evicts the only winter reference');
    assert.equal(first[0].phaseCurrentA[0], 9);
    const bytes = readFileSync(f.filename), before = statSync(f.filename);
    assert.equal(before.mode & 0o777, 0o600);
    assert(bytes.length < 20_000, 'Only compact hourly distributions are persisted');
    await service.close();
    service = createHouseholdForecastService({ store: f.store });
    assert.deepEqual(await service.request(options), first);
    assert.deepEqual(readFileSync(f.filename), bytes, 'A valid restart reuses the snapshot without rewriting it');
    assert.equal(readdirSync(f.dir).filter(name => name.includes('household-reference')).length, 1);
  } finally { await service.close(); }
});

test('restored watermarks catch backdated rows and future receipt activation without learning early', t => {
  const f = fixture(t); archived(f.store);
  const a = connection(t, f.path);
  const before = forecastHousehold(a, options);
  // The old snapshot predates this append, but the source-time is historical.
  native(f.store, now - DAY, { current: 15, receivedAt: now + HOUR });
  const b = connection(t, f.path);
  const waiting = forecastHousehold(b, options);
  assert.deepEqual(waiting, before, 'An assigned ingestion ID does not make a future receipt available');
  const later = { ...options, now: now + HOUR, deadlineAt: now + 2 * HOUR };
  const actual = forecastHousehold(b, later), full = forecastHousehold(connection(t, f.path, { cache: false }), later);
  assert.deepEqual(actual, full);
  const after = forecastHousehold(b, { ...options, now: now + DAY, deadlineAt: now + DAY + HOUR });
  assert(after[0].phaseCurrentA[0] > before[0].phaseCurrentA[0]);
});

test('corrupt, oversized, expanded and retired algorithm snapshots rebuild safely', t => {
  const f = fixture(t); archived(f.store);
  const baseline = forecastHousehold(connection(t, f.path), options);
  const saved = readFileSync(f.filename);
  const retired = JSON.parse(gunzipSync(saved)); retired.algorithm = 'retired';
  const damaged = JSON.parse(gunzipSync(saved)); damaged.digest = '0'.repeat(64);
  const malformedProof = JSON.parse(gunzipSync(saved)); malformedProof.proof = { unsupported: true };
  for (const bytes of [Buffer.from('broken'), Buffer.alloc(8 * 1024 * 1024 + 1),
    gzipSync(Buffer.alloc(32 * 1024 * 1024 + 1)), gzipSync(JSON.stringify(retired)), gzipSync(JSON.stringify(damaged)), gzipSync(JSON.stringify(malformedProof))]) {
    writeFileSync(f.filename, bytes);
    assert.deepEqual(forecastHousehold(connection(t, f.path), options), baseline);
  }
  writeFileSync(f.filename, saved);
  // This independent DB has the same observation IDs but a different lineage.
  const otherPath = join(f.dir, 'other.sqlite'), other = new Store(otherPath);
  try {
    archived(other); native(other, now - DAY, { current: 15 });
    writeFileSync(`${otherPath}.household-reference.gz`, saved);
    const expected = forecastHousehold(connection(t, otherPath, { cache: false }), options);
    assert.deepEqual(forecastHousehold(connection(t, otherPath), options), expected);
    assert.notDeepEqual(expected, baseline);
  } finally { other.close(); }
});

test('same-lineage divergent and rolled-back databases cannot reuse a newer sidecar', t => {
  const f = fixture(t); archived(f.store);
  f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const otherPath = join(f.dir, 'branch.sqlite'); copyFileSync(f.path, otherPath);
  native(f.store, now - DAY, { current: 15 });
  const original = forecastHousehold(connection(t, f.path), options), saved = readFileSync(f.filename);
  const other = new Store(otherPath);
  try {
    writeFileSync(`${otherPath}.household-reference.gz`, saved);
    const rolledBack = forecastHousehold(connection(t, otherPath), options);
    assert.notDeepEqual(rolledBack, original, 'A snapshot newer than the restored DB is rejected');
    native(other, now - DAY, { current: 30 });
    writeFileSync(`${otherPath}.household-reference.gz`, saved);
    const expected = forecastHousehold(connection(t, otherPath, { cache: false }), options);
    assert.notDeepEqual(expected, original);
    assert.deepEqual(forecastHousehold(connection(t, otherPath), options), expected, 'Identical lineage and ID watermarks do not hide a divergent transaction hash');
  } finally { other.close(); }
});

test('hourly persistence bounds write amplification while restart catches the unsaved tail', t => {
  const f = fixture(t); archived(f.store);
  let clock = 0;
  const a = connection(t, f.path, { clock: () => clock });
  forecastHousehold(a, options);
  const first = readFileSync(f.filename);
  native(f.store, now - DAY, { current: 15 });
  clock = 5 * 60_000;
  const updated = forecastHousehold(a, options);
  assert.deepEqual(readFileSync(f.filename), first, 'Normal five-minute plans do not rewrite the index');
  assert.deepEqual(forecastHousehold(connection(t, f.path), options), updated, 'Restart replays the newer source suffix');
  native(f.store, now - 3 * DAY, { current: 12 });
  clock = HOUR;
  forecastHousehold(a, options);
  assert.notDeepEqual(readFileSync(f.filename), first);
});

test('cold streaming retains complete intervals crossing multiple week boundaries', t => {
  const f = fixture(t); seedVoltage(f.store, now - 40 * DAY);
  native(f.store, now - 30 * DAY, { current: 7, duration: 29 * DAY, receivedAt: now - DAY });
  const result = forecastHousehold(connection(t, f.path), { ...options, outdoorC: null });
  assert(Math.abs(result[0].phaseCurrentA[0] - 7) < 1e-10);
  assert.equal(result[0].reference.nights, 20);
  assert.equal(result[0].reference.unknownCharger2, false);
});

test('a later overlap invalidates an entire long energy cluster across week boundaries', t => {
  const f = fixture(t); seedVoltage(f.store, now - 40 * DAY);
  native(f.store, now - 30 * DAY, { current: 5, duration: 11 * DAY, receivedAt: now - 19 * DAY });
  const a = connection(t, f.path);
  assert.equal(forecastHousehold(a, options)[0].reference.noHistory, false);
  native(f.store, now - 21 * DAY, { current: 6, receivedAt: now - 21 * DAY + HOUR });
  const incremental = forecastHousehold(a, options);
  const cold = forecastHousehold(connection(t, f.path, { cache: false }), options);
  assert.equal(cold[0].reference.noHistory, true, 'Overlapping measured energy cannot supply valid household capacity');
  assert.deepEqual(incremental, cold, 'An old long interval loses its earlier cached dates as well');
});

test('selection changes replace the disposable snapshot immediately within the hourly write lease', t => {
  const f = fixture(t); archived(f.store);
  const a = connection(t, f.path, { clock: () => 0 }); forecastHousehold(a, options);
  const original = readFileSync(f.filename);
  f.store.transaction(() => f.store.db.prepare("UPDATE history_selection SET generation='synthetic-new-selection' WHERE id=1").run());
  forecastHousehold(a, options);
  const replacement = readFileSync(f.filename);
  assert.notDeepEqual(replacement, original);
  assert(JSON.parse(gunzipSync(replacement)).payload.includes('synthetic-new-selection'));
});

test('destructive old edits recover the evicted next eligible night without storing every historical hour', t => {
  const f = fixture(t); seedVoltage(f.store, now - 100 * DAY);
  for (let days = 40; days > 0; days--) native(f.store, now - days * DAY, { current: 3 + days / 10 });
  const a = connection(t, f.path, { clock: () => 0 });
  forecastHousehold(a, options);
  const before = readFileSync(f.filename);
  native(f.store, now - 20 * DAY + HOUR / 2, { current: 6 });
  const incremental = forecastHousehold(a, options);
  assert.deepEqual(incremental, forecastHousehold(connection(t, f.path, { cache: false }), options));
  assert.notDeepEqual(readFileSync(f.filename), before, 'A destructive full reconstruction publishes its complete new bounded cache immediately');
});

test('normal current-hour temperature band changes and reserve expiry never reconstruct the archive', t => {
  const f = fixture(t); seedVoltage(f.store, now - 100 * DAY);
  for (let days = 41; days >= 0; days--) native(f.store, now - days * DAY,
    { current: 5, temperature: -20.1, duration: HOUR / 2, receivedAt: now - days * DAY + HOUR / 2 });
  const a = connection(t, f.path, { clock: () => 0 }), saves = [], originalSave = a.householdCache.save;
  a.householdCache.save = (state, details) => { saves.push(details?.force === true); originalSave(state, details); };
  let current = { ...options, now: now + HOUR / 2, deadlineAt: now + 1.5 * HOUR };
  forecastHousehold(a, current);
  const saved = readFileSync(f.filename);
  assert.deepEqual(saves, [true]);
  native(f.store, now + HOUR / 2, { current: 5, temperature: -19.5, duration: HOUR / 4, receivedAt: now + .75 * HOUR });
  current = { ...options, now: now + .75 * HOUR, deadlineAt: now + 1.75 * HOUR };
  assert.deepEqual(forecastHousehold(a, current), forecastHousehold(connection(t, f.path, { cache: false }), current));
  assert.deepEqual(readFileSync(f.filename), saved, 'A normal band crossing does not force a durable full reconstruction');
  assert.deepEqual(forecastHousehold(connection(t, f.path), current), forecastHousehold(a, current), 'The persisted mutable reserve also works after restart');
  for (let days = 1; days <= 5; days++) {
    native(f.store, now + days * DAY, { current: 5, temperature: days % 2 ? -20.1 : -19.5 });
    current = { ...options, now: now + days * DAY + HOUR, deadlineAt: now + days * DAY + 2 * HOUR };
    assert.deepEqual(forecastHousehold(a, current), forecastHousehold(connection(t, f.path, { cache: false }), current));
  }
  assert(saves.slice(1).every(force => !force), 'Ordinary multi-day advance only trims bounded reserves');
});

test('original imported current/voltage meaning survives worker restart and completed imports invalidate the sidecar', async t => {
  const f = fixture(t); seedVoltage(f.store, now - 365 * DAY);
  async function imported(day, current) {
    const start = now - day * DAY, easee = join(f.dir, `example-${day}-easee.csv`), stmq = join(f.dir, `example-${day}-stmq.csv`);
    let electrical = 'unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3\n';
    let thermal = 'unix_time,price,heat_on,temp_in,temp_ga,temp_out\n';
    for (let at = start; at <= start + HOUR; at += HOUR / 4) {
      electrical += `${at / 1000},0,0,0,${current},${current + 1},${current + 2}\n`;
      thermal += `${at / 1000},8,15,21,12,-20\n`;
    }
    writeFileSync(easee, electrical); writeFileSync(stmq, thermal);
    await importCsv(f.store, easee, { kind: 'easee' }); await importCsv(f.store, stmq, { kind: 'stmq' });
  }
  await imported(300, 10);
  let service = createHouseholdForecastService({ store: f.store });
  try {
    const original = await service.request(options); assert.equal(original[0].reference.nights, 1);
    await service.close(); service = createHouseholdForecastService({ store: f.store });
    assert.deepEqual(await service.request(options), original);
    const changedVoltage = { ...options, voltageV: 240 };
    assert.deepEqual(await service.request(changedVoltage), forecastHousehold(connection(t, f.path, { cache: false }), changedVoltage));
    await imported(299, 6);
    await service.close(); service = createHouseholdForecastService({ store: f.store });
    const actual = await service.request(options);
    assert.equal(actual[0].reference.nights, 2);
    assert.deepEqual(actual, forecastHousehold(connection(t, f.path, { cache: false }), options));
  } finally { await service.close(); }
});

test('deferred admission activates after a historical cutoff, restart and wall-clock rollback', t => {
  const f = fixture(t); seedVoltage(f.store, now - 365 * DAY);
  native(f.store, now - DAY, { admittedAt: now + HOUR });
  const a = connection(t, f.path);
  assert.equal(forecastHousehold(a, options)[0].reference.noHistory, true, 'Source and receipt alone cannot advance admission');
  const later = { ...options, now: now + DAY, deadlineAt: now + DAY + HOUR };
  const after = forecastHousehold(connection(t, f.path), later);
  assert.equal(after[0].reference.noHistory, false, 'The persisted admission boundary wakes the projection');
  const b = connection(t, f.path);
  assert.equal(forecastHousehold(b, later)[0].reference.noHistory, false);
  assert.equal(forecastHousehold(b, options)[0].reference.noHistory, true, 'Clock reversal withdraws not-yet-admitted energy');
  assert.deepEqual(forecastHousehold(b, later), after);
});

test('registered source proof survives journal pruning during a long read snapshot and ordinary restart', async t => {
  const f = fixture(t); archived(f.store);
  const runWrite = f.store.runWrite.bind(f.store);
  let release, observed, held = false;
  const hold = new Promise(resolve => { release = resolve; }), registered = new Promise(resolve => { observed = resolve; });
  f.store.runWrite = (fn, options) => runWrite(fn, options).then(async result => {
    if (!held && result?.token && !result.digest) { held = true; observed(result.source); await hold; }
    return result;
  });
  let service = createHouseholdForecastService({ store: f.store });
  try {
    const running = service.request(options), source = await registered;
    // Keep the worker's exact READ snapshot open while normal commits exhaust
    // the retained transaction proof. The compact registered pin stays durable.
    for (let n = 0; n < 2100; n++) f.store.transaction(() => f.store.setState('synthetic:cache-proof-pruning', { n }));
    assert.equal(f.store.checkpointAt(source.sequence), null);
    release();
    const first = await running, bytes = readFileSync(f.filename);
    assert.equal(first[0].reference.noHistory, false);
    await service.close(); service = createHouseholdForecastService({ store: f.store });
    assert.deepEqual(await service.request(options), first);
    assert.deepEqual(readFileSync(f.filename), bytes, 'A pruned source proof does not turn ordinary restart into a full reconstruction');
  } finally { release(); await service.close(); }
});

test('a proven ninety-day zero tail extends and finalizes without revisiting its archive prefix', t => {
  const f = fixture(t), recorder = new Recorder(f.store), base = now - 90 * DAY;
  seedVoltage(f.store, base - HOUR);
  const sample = (prefix, start, end, powers = [0, 0, 0]) => recorder.recordEnergy({ source: 'easee', device: `zero-${prefix}`,
    prefix, start, end, powers, energies: powers.map(value => value * (end - start) / HOUR), receivedAt: end, quality: [] });
  for (const prefix of ['ev1', 'ev2']) { sample(prefix, base - HOUR, base); sample(prefix, base, now); }
  for (let hour = 1; hour <= 3; hour++) {
    const start = now - hour * HOUR;
    for (let phase = 1; phase <= 3; phase++) f.store.observation({ source: 'easee', device: 'property',
      signal: `property_energy_l${phase}`, unit: 'kWh', value: 1.15, quality: [], sourceTime: start + HOUR,
      receivedAt: start + HOUR, raw: { intervalStart: start, intervalEnd: start + HOUR } });
  }
  const a = connection(t, f.path), saves = [], save = a.householdCache.save;
  a.householdCache.save = (cache, details) => { saves.push(details?.force === true); save(cache, details); };
  const first = forecastHousehold(a, options);
  assert(first.some(row => !row.reference.noHistory));
  const later = { ...options, now: now + HOUR / 4, deadlineAt: now + HOUR };
  for (const prefix of ['ev1', 'ev2']) sample(prefix, now, later.now);
  assert.deepEqual(forecastHousehold(a, later), forecastHousehold(connection(t, f.path, { cache: false }), later));
  assert.deepEqual(saves, [true, false], 'Ordinary zero extension never reconstructs the whole archive');
  const b = connection(t, f.path), restartedSaves = [], restartedSave = b.householdCache.save;
  b.householdCache.save = (cache, details) => { restartedSaves.push(details?.force === true); restartedSave(cache, details); };
  assert.deepEqual(forecastHousehold(b, later), forecastHousehold(a, later));
  assert.deepEqual(restartedSaves, [false], 'A sealed snapshot retains its validated zero prefix across restart');
  recorder.flush(later.now, { force: true });
  for (const prefix of ['ev1', 'ev2']) sample(prefix, later.now, now + HOUR / 2);
  const finalized = { ...later, now: now + HOUR / 2 };
  assert.deepEqual(forecastHousehold(a, finalized), forecastHousehold(connection(t, f.path, { cache: false }), finalized));
  assert.equal(saves.at(-1), false, 'Exact three-phase finalization and a new adjacent pending cohort keep the proven prefix');
  const conflictStart = now - 60 * DAY;
  for (let phase = 1; phase <= 3; phase++) f.store.observation({ source: 'easee', device: 'late-contradiction',
    signal: `ev1_energy_l${phase}`, value: 1, unit: 'kWh', quality: [], sourceTime: conflictStart + HOUR,
    receivedAt: finalized.now, raw: { intervalStart: conflictStart, intervalEnd: conflictStart + HOUR } });
  const corrected = forecastHousehold(a, finalized);
  assert.deepEqual(corrected, forecastHousehold(connection(t, f.path, { cache: false }), finalized));
  assert(corrected.every(row => row.reference.noHistory), 'A later contradiction invalidates the entire connected zero cohort');
  assert.equal(saves.at(-1), true, 'A destructive old conflict explicitly reconstructs the affected reference');
});

test('zero prefix reuse rejects interval rollback, invalid quality and incomplete finalization', t => {
  for (const change of ['rollback', 'quality', 'incomplete', 'admission']) {
    const f = fixture(t), start = now - 90 * DAY, key = `recorder:energy:${JSON.stringify(['easee', 'idle', 'ev1'])}`;
    seedVoltage(f.store, start - HOUR);
    for (let phase = 1; phase <= 3; phase++) f.store.observation({ source: 'easee', device: 'property',
      signal: `property_energy_l${phase}`, unit: 'kWh', value: 1, quality: [], sourceTime: now,
      receivedAt: now, raw: { intervalStart: now - HOUR, intervalEnd: now } });
    const pending = { start, end: now, receivedAt: now, energies: [0, 0, 0], quality: [] };
    f.store.setState(key, { pending });
    const a = connection(t, f.path), saves = [];
    a.householdCache = { load: () => null, save: (_, details) => saves.push(details?.force === true) };
    assert.equal(forecastHousehold(a, options)[0].reference.noHistory, false);
    if (change === 'rollback') f.store.setState(key, { pending: { ...pending, end: now - 2 * HOUR } });
    if (change === 'quality') f.store.setState(key, { pending: { ...pending, quality: ['unknown-phase-share'] } });
    if (['incomplete', 'admission'].includes(change)) {
      f.store.setState(key, { pending: null });
      for (let phase = 1; phase <= (change === 'incomplete' ? 2 : 3); phase++) f.store.observation({ source: 'easee', device: 'idle',
        signal: `ev1_energy_l${phase}`, unit: 'kWh', value: 0, quality: [], sourceTime: now, receivedAt: now,
        raw: { intervalStart: start, intervalEnd: now, basis: 'integrated-power-phase-allocation',
          ...(change === 'admission' ? { timeAdmission: { unsupported: true, admittedAt: now } } : {}) } });
    }
    const result = forecastHousehold(a, options);
    assert.deepEqual(result, forecastHousehold(connection(t, f.path, { cache: false }), options), change);
    assert.equal(result[0].reference.noHistory, true, change);
    assert.deepEqual(saves, [true, true], `${change} cannot reuse a former complete zero prefix`);
  }
});

test('actual fractional positive recorder groups retain cold-equivalent bounded incremental forecasts after ninety days', t => {
  const f = fixture(t), recorder = new Recorder(f.store), step = 6 * HOUR + 60_000, base = now - 360 * step;
  seedVoltage(f.store, base - HOUR);
  const sample = (start, end) => {
    for (const prefix of ['property', 'ev1', 'ev2']) {
      const powers = prefix === 'property' ? [0.137, 1.719, 0.00083] : [0, 0, 0];
      recorder.recordEnergy({ source: 'easee', device: `steady-${prefix}`, prefix, start, end,
        powers, energies: powers.map(value => value * (end - start) / HOUR), receivedAt: end, quality: [] });
    }
  };
  for (let sampleIndex = 0; sampleIndex < 360; sampleIndex++) sample(base + sampleIndex * step, base + (sampleIndex + 1) * step);
  const a = connection(t, f.path), saves = [];
  a.householdCache = { load: () => null, save: (_, details) => saves.push(details?.force === true) };
  forecastHousehold(a, options);
  sample(now, now + step);
  const later = { ...options, now: now + step, deadlineAt: now + step + HOUR };
  assert.deepEqual(forecastHousehold(a, later), forecastHousehold(connection(t, f.path, { cache: false }), later));
  assert.deepEqual(saves, [true, false], 'Daily positive groups and long zero peers keep routine work in recent dates');
});

test('actual invalid zero property and charger acquisitions stay unknown without routine archive reconstruction', t => {
  for (const invalidPrefix of ['property', 'ev1']) {
    const f = fixture(t), recorder = new Recorder(f.store), base = now - 90 * DAY;
    seedVoltage(f.store, base - HOUR);
    const sample = (start, end) => {
      for (const prefix of ['property', 'ev1', 'ev2']) {
        const powers = prefix === 'property' && invalidPrefix !== 'property' ? [1, 1, 1] : [0, 0, 0];
        recorder.recordEnergy({ source: 'easee', device: `invalid-${prefix}`, prefix, start, end,
          powers, energies: powers.map(value => value * (end - start) / HOUR), receivedAt: end,
          quality: prefix === invalidPrefix ? ['missing'] : [] });
      }
    };
    sample(base - HOUR, base);
    for (let day = 0; day < 90; day++) sample(base + day * DAY, base + (day + 1) * DAY);
    const a = connection(t, f.path), saves = [];
    a.householdCache = { load: () => null, save: (_, details) => saves.push(details?.force === true) };
    assert.equal(forecastHousehold(a, options)[0].reference.noHistory, true);
    sample(now, now + HOUR / 4);
    const later = { ...options, now: now + HOUR / 4 };
    const actual = forecastHousehold(a, later);
    assert.deepEqual(actual, forecastHousehold(connection(t, f.path, { cache: false }), later));
    assert.equal(actual[0].reference.noHistory, true, invalidPrefix);
    assert.deepEqual(saves, [true, false], `${invalidPrefix} unknown evidence never rescans the archive on ordinary acquisition`);
  }
});

test('cold recovery proves a recently finalized long zero cohort before ordinary same-day updates', t => {
  const f = fixture(t), recorder = new Recorder(f.store), base = now - 90 * DAY;
  seedVoltage(f.store, base - HOUR);
  const sample = (start, end) => {
    for (const prefix of ['ev1', 'ev2']) recorder.recordEnergy({ source: 'easee', device: `finalized-${prefix}`,
      prefix, start, end, powers: [0, 0, 0], energies: [0, 0, 0], quality: [], receivedAt: end });
  };
  sample(base - HOUR, base); sample(base, now); recorder.flush(now, { force: true });
  sample(now, now + HOUR / 4);
  for (let phase = 1; phase <= 3; phase++) f.store.observation({ source: 'easee', device: 'property',
    signal: `property_energy_l${phase}`, unit: 'kWh', value: 1, quality: [], sourceTime: now, receivedAt: now,
    raw: { intervalStart: now - HOUR, intervalEnd: now } });
  const a = connection(t, f.path, { cache: false }), later = { ...options, now: now + HOUR / 4 };
  assert.equal(forecastHousehold(a, later)[0].reference.noHistory, false);
  let archiveGeometryQueries = 0;
  const prepare = a.db.prepare.bind(a.db);
  a.db.prepare = sql => { if (sql.includes('INDEXED BY observations_energy_geometry')) archiveGeometryQueries++; return prepare(sql); };
  sample(now + HOUR / 4, now + HOUR / 2);
  const next = { ...options, now: now + HOUR / 2 };
  assert.deepEqual(forecastHousehold(a, next), forecastHousehold(connection(t, f.path, { cache: false }), next));
  assert.equal(archiveGeometryQueries, 0, 'A full reconstruction must not leave ordinary updates rewinding the old finalized prefix');
});

test('immutable long positive and invalid cohorts retain cold-equivalent geometry proofs across restart', t => {
  for (const invalid of [false, true]) {
    const f = fixture(t), base = now - 90 * DAY;
    seedVoltage(f.store, base - HOUR);
    const save = (start, end) => f.store.transaction(() => {
      for (const prefix of ['property', 'ev1', 'ev2']) for (let phase = 1; phase <= 3; phase++)
        f.store.observation({ source: 'easee', device: `immutable-${prefix}`, signal: `${prefix}_energy_l${phase}`,
          unit: 'kWh', value: prefix === 'property' ? 1.15 * (end - start) / HOUR : 0,
          quality: invalid && prefix === 'property' ? ['missing'] : [], sourceTime: end, receivedAt: end,
          raw: { intervalStart: start, intervalEnd: end } });
    });
    save(base, now);
    assert.equal(forecastHousehold(connection(t, f.path), options)[0].reference.noHistory, invalid);
    const b = connection(t, f.path); forecastHousehold(b, options);
    let archiveGeometryQueries = 0; const prepare = b.db.prepare.bind(b.db);
    b.db.prepare = sql => { if (sql.includes('INDEXED BY observations_energy_geometry')) archiveGeometryQueries++; return prepare(sql); };
    save(now, now + HOUR / 4);
    const later = { ...options, now: now + HOUR / 4 };
    const actual = forecastHousehold(b, later);
    assert.deepEqual(actual, forecastHousehold(connection(t, f.path, { cache: false }), later));
    assert.equal(actual[0].reference.noHistory, invalid, 'Geometry proof never grants numeric validity');
    assert.equal(archiveGeometryQueries, 0, 'Existing original long spans do not cause repeated backward archive reads');
  }
});

test('proven conflict geometry bounds repeated forward overlaps, pending extensions, finalization and restart', t => {
  const f = fixture(t), recorder = new Recorder(f.store), base = now - 90 * DAY;
  seedVoltage(f.store, base - HOUR);
  const zero = (start, end) => {
    for (const prefix of ['ev1', 'ev2']) recorder.recordEnergy({ source: 'easee', device: `conflicted-${prefix}`,
      prefix, start, end, powers: [0, 0, 0], energies: [0, 0, 0], quality: [], receivedAt: end });
  };
  const saved = (prefix, device, start, end, value) => {
    for (let phase = 1; phase <= 3; phase++) f.store.observation({ source: 'easee', device,
      signal: `${prefix}_energy_l${phase}`, unit: 'kWh', value, quality: [], sourceTime: end, receivedAt: end,
      raw: { intervalStart: start, intervalEnd: end } });
  };
  zero(base - HOUR, base); zero(base, now);
  saved('property', 'property', now - HOUR, now, 1);
  saved('ev1', 'old-conflict', base + DAY, base + DAY + HOUR, 1);
  const a = connection(t, f.path);
  assert.equal(forecastHousehold(a, options)[0].reference.noHistory, true);
  const b = connection(t, f.path), saves = [], save = b.householdCache.save;
  b.householdCache.save = (cache, details) => { saves.push(details?.force === true); save(cache, details); };
  forecastHousehold(b, options);
  let archiveGeometryQueries = 0; const prepare = b.db.prepare.bind(b.db);
  b.db.prepare = sql => { if (sql.includes('INDEXED BY observations_energy_geometry')) archiveGeometryQueries++; return prepare(sql); };
  for (let step = 0; step < 3; step++) {
    const start = now + step * HOUR / 4, end = start + HOUR / 4;
    zero(start, end); saved('ev1', 'staggered-forward-feed', start - 5 * 60_000, end, 0.01);
    const later = { ...options, now: end };
    const actual = forecastHousehold(b, later);
    assert.deepEqual(actual, forecastHousehold(connection(t, f.path, { cache: false }), later));
    assert.equal(actual[0].reference.noHistory, true);
    assert.equal(saves.at(-1), false, 'Forward additions cannot make a proven old conflict valid or require full re-verification');
  }
  recorder.flush(now + 3 * HOUR / 4, { force: true }); zero(now + 3 * HOUR / 4, now + HOUR);
  const later = { ...options, now: now + HOUR, deadlineAt: now + 2 * HOUR };
  assert.deepEqual(forecastHousehold(b, later), forecastHousehold(connection(t, f.path, { cache: false }), later));
  assert.equal(saves.at(-1), false, 'Complete original finalization preserves known unknown geometry');
  assert.equal(archiveGeometryQueries, 0, 'Routine conflict extension and finalization never re-read archive geometry');
});

test('pending geometry removal or rollback invalidates a conflict proof and restores independently valid evidence', t => {
  for (const change of ['remove', 'rollback']) {
    const f = fixture(t), base = now - 90 * DAY;
    seedVoltage(f.store, base - HOUR);
    const key = `recorder:energy:${JSON.stringify(['easee', 'conflicting-tail', 'ev1'])}`;
    const pending = { start: base, end: now, receivedAt: now, energies: [0, 0, 0], quality: [] };
    f.store.setState(key, { pending });
    native(f.store, now - 3 * HOUR);
    const a = connection(t, f.path), saves = [];
    a.householdCache = { load: () => null, save: (_, details) => saves.push(details?.force === true) };
    assert.equal(forecastHousehold(a, options)[0].reference.noHistory, true);
    f.store.setState(key, { pending: change === 'remove' ? null : { ...pending, end: now - 4 * HOUR } });
    const actual = forecastHousehold(a, options);
    assert.deepEqual(actual, forecastHousehold(connection(t, f.path, { cache: false }), options));
    assert.equal(actual[0].reference.noHistory, false, 'A departed conflicting participant cannot keep independently valid evidence unknown');
    assert.deepEqual(saves, [true, true], `${change} explicitly re-assesses the destructive geometry change`);
  }
});

test('a months-long conflict built entirely from short cohorts never re-verifies its prefix on forward append', t => {
  const f = fixture(t), base = now - 90 * DAY;
  seedVoltage(f.store, base - HOUR);
  const save = (prefix, device, start, end, value) => {
    for (let phase = 1; phase <= 3; phase++) f.store.observation({ source: 'easee', device,
      signal: `${prefix}_energy_l${phase}`, unit: 'kWh', value, quality: [], sourceTime: end, receivedAt: end,
      raw: { intervalStart: start, intervalEnd: end } });
  };
  f.store.transaction(() => {
    for (let start = base; start < now; start += 3 * HOUR)
      save('ev1', 'short-overlap-chain', start, Math.min(now, start + 6 * HOUR), 0);
    save('property', 'property', now - HOUR, now, 1);
    save('ev2', 'peer', now - HOUR, now, 0);
  });
  const a = connection(t, f.path), saves = [];
  a.householdCache = { load: () => null, save: (_, details) => saves.push(details?.force === true) };
  assert.equal(forecastHousehold(a, options)[0].reference.noHistory, true);
  let archiveGeometryQueries = 0; const prepare = a.db.prepare.bind(a.db);
  a.db.prepare = sql => { if (sql.includes('INDEXED BY observations_energy_geometry')) archiveGeometryQueries++; return prepare(sql); };
  f.store.transaction(() => save('ev1', 'short-overlap-chain', now - 3 * HOUR, now + 3 * HOUR, 0));
  const later = { ...options, now: now + 3 * HOUR, deadlineAt: now + 4 * HOUR };
  assert.deepEqual(forecastHousehold(a, later), forecastHousehold(connection(t, f.path, { cache: false }), later));
  assert.deepEqual(saves, [true, false]);
  assert.equal(archiveGeometryQueries, 0, 'No individual long cohort is required to preserve a verified conflict prefix');
});

test('same-day supported CSV peer refresh reuses long native-tail proofs and earliest-peer metadata', async t => {
  const f = fixture(t), recorder = new Recorder(f.store), base = now - 90 * DAY;
  seedVoltage(f.store, base - HOUR);
  const zero = (start, end) => recorder.recordEnergy({ source: 'easee', device: 'csv-peer', prefix: 'ev2', start, end,
    powers: [0, 0, 0], energies: [0, 0, 0], quality: [], receivedAt: end });
  zero(base - HOUR, base); zero(base, now);
  const easee = join(f.dir, 'easee.csv'), stmq = join(f.dir, 'st-mq.csv');
  let electrical = 'unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3\n';
  let thermal = 'unix_time,price,heat_on,temp_in,temp_ga,temp_out\n';
  for (let at = now - HOUR; at <= now; at += HOUR / 4) {
    electrical += `${at / 1000},0,0,0,5,5,5\n`; thermal += `${at / 1000},8,15,21,12,-20\n`;
  }
  writeFileSync(easee, electrical); writeFileSync(stmq, thermal);
  await importCsv(f.store, easee, { kind: 'easee' }); await importCsv(f.store, stmq, { kind: 'stmq' });
  f.store.observation({ source: 'easee', device: 'ignored-malformed-peer', signal: 'ev2_energy_l1', unit: 'kWh',
    value: 0, quality: [], sourceTime: now, receivedAt: now, raw: { intervalStart: 'not-a-time', intervalEnd: now } });
  const a = connection(t, f.path);
  assert.equal(forecastHousehold(a, options)[0].reference.noHistory, false);
  let archiveQueries = 0; const prepare = a.db.prepare.bind(a.db);
  a.db.prepare = sql => {
    if (sql.includes('INDEXED BY observations_energy_geometry') || /SELECT min\(json_extract\(raw/.test(sql)) archiveQueries++;
    return prepare(sql);
  };
  zero(now, now + HOUR / 4);
  const later = { ...options, now: now + HOUR / 4 };
  assert.deepEqual(forecastHousehold(a, later), forecastHousehold(connection(t, f.path, { cache: false }), later));
  assert.equal(archiveQueries, 0, 'Routine imported-reference refresh must not bypass the already verified native source prefix');
});

test('an ignored malformed first peer append cannot poison a persisted restart bound', t => {
  const f = fixture(t); seedVoltage(f.store, now - DAY);
  let clock = 0; const a = connection(t, f.path, { clock: () => clock });
  const first = forecastHousehold(a, options);
  f.store.observation({ source: 'easee', device: 'ignored-malformed-first-peer', signal: 'ev2_energy_l1', unit: 'kWh',
    value: 0, quality: [], sourceTime: now + HOUR / 4, receivedAt: now + HOUR / 4,
    raw: { intervalStart: now + DAY, intervalEnd: now + HOUR / 4 } });
  clock += HOUR;
  const later = { ...options, now: now + HOUR / 4 };
  const actual = forecastHousehold(a, later);
  const b = connection(t, f.path, { clock: () => clock }), saves = [], save = b.householdCache.save;
  b.householdCache.save = (cache, details) => { saves.push(details?.force === true); save(cache, details); };
  assert.deepEqual(forecastHousehold(b, later), actual);
  assert.deepEqual(saves, [], 'Malformed ignored source cannot make a valid derived snapshot fail restart validation');
  assert.equal(actual[0].reference.noHistory, first[0].reference.noHistory);
});
