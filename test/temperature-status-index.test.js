import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { indoorStatusMetadata, recordedOutdoorObservation, recordedTemperatureAttempt } from '../src/app/temperature-status.js';
import { Recorder } from '../src/storage/recorder.js';
import { RECOVERABLE_TABLES, recoveryRecordKey } from '../src/storage/schema.js';
import { enrollJournalPeer } from '../src/storage/journal-peer.js';
import { openJournalSource } from '../src/recovery/incremental-source.js';
import { PeerTransfers } from '../src/replication/coalesced.js';
import { fixture } from './helpers/recovery-fixture.js';

const T = Date.UTC(2026, 8, 1), MINUTE = 60_000, HOUR = 60 * MINUTE;
const proposed = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const signals = ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature',
  'garage_temperature', 'garage_temperature_2', 'outdoor_temperature'];
const report = (at, extra = {}) => ({ source: 'mqtt-temperature', device: 'invented-room', signal: 'indoor_temperature',
  value: 21, unit: 'degC', sourceTime: at, receivedAt: at, quality: [], raw: {}, ...extra });
const weather = (at, extra = {}) => report(at, { source: 'fmi', device: 'invented-station', signal: 'outdoor_temperature', value: 10, ...extra });
function reading(store, id) {
  const row = store.db.prepare('SELECT * FROM observations WHERE id=?').get(id);
  return { id: row.id, source: row.source, device: row.device, signal: row.signal, value: row.value, unit: row.unit,
    sourceTime: row.source_time, receivedAt: row.received_at, raw: JSON.parse(row.raw), quality: JSON.parse(row.quality) };
}
function planned(store) {
  const plans = [];
  return { plans, store: { journalSource: store.journalSource, db: { prepare(sql) {
    const statement = store.db.prepare(sql);
    const run = method => (...args) => {
      const result = statement[method](...args);
      if (sql.includes('INDEXED BY observations_temperature_')) plans.push({ sql,
        details: store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(row => row.detail),
        rows: method === 'all' ? result.length : result ? 1 : 0 });
      return result;
    };
    return { get: run('get'), all: run('all') };
  } } } };
}
function assertPlans(plans) {
  assert(plans.length > 0);
  for (const { details } of plans) {
    assert(details.some(detail => /SEARCH candidate USING (?:COVERING )?INDEX observations_temperature_/.test(detail)), details.join('\n'));
    assert(details.some(detail => /SEARCH r USING INTEGER PRIMARY KEY/.test(detail)), 'Actual selected membership uses a point lookup');
    assert(!details.some(detail => /SCAN (?:candidate|r)\b|TEMP B-TREE/.test(detail)), details.join('\n'));
  }
}

test('temperature receipt queries seek fixed ranges and exact streams as old unrelated history grows', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.observation(weather(T));
  const held = reading(store, store.observation(report(T)));
  const attempt = store.observation(report(T + 1, { value: null, unit: 'invalid', quality: ['invalid_unit'] }));
  const insert = store.db.prepare(`INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality,raw)
    VALUES(?,?,?,10,'degC',?,?,'[]','{}')`);
  let previous = 0;
  for (const count of [1000, 30000]) {
    for (let start = previous; start < count; start += 64) store.transaction(() => {
      for (let n = start; n < Math.min(count, start + 64); n++) {
        const at = T - (n + 1) * HOUR;
        for (const source of ['fmi', 'openmeteo']) insert.run(source, 'invented-station', 'outdoor_temperature', at, at);
        insert.run('mqtt-temperature', 'invented-room', 'indoor_temperature', at, at);
        // Same source and signal with another device must not fill the metadata stream.
        insert.run('mqtt-temperature', 'invented-other-room', 'indoor_temperature', T, T + 2);
      }
    });
    previous = count;
    const traced = planned(store), began = performance.now(), now = T + MINUTE;
    const outdoor = recordedOutdoorObservation(traced.store, now, { input: 'providers' });
    assert.equal(outdoor.value, 10); assert.equal(outdoor.stale, false);
    assert.equal(recordedOutdoorObservation(traced.store, now, { input: 'offline' }).value, 10);
    assert.equal(recordedOutdoorObservation(traced.store, now, { input: 'simulated' }).value, null);
    const metadata = indoorStatusMetadata(held, now, { store: traced.store, stale: true });
    assert.equal(metadata.lastAttemptAt, T + 1); assert(metadata.lastAttemptReasons.includes('unsupported-unit'));
    assert.equal(recordedTemperatureAttempt(traced.store, 'indoor_temperature', T + 1, 'providers').id, attempt);
    assert.equal(recordedTemperatureAttempt(traced.store, 'bedroom_temperature', now, 'providers'), null);
    assert.equal(recordedTemperatureAttempt(traced.store, 'indoor_temperature', now, 'simulated'), null);
    assert.equal(recordedOutdoorObservation(traced.store, T - (count + 1) * HOUR, { input: 'providers' }).value, null);
    assert.equal(recordedTemperatureAttempt(traced.store, 'indoor_temperature', T - (count + 1) * HOUR, 'providers'), null);
    assertPlans(traced.plans);
    assert(traced.plans.every(plan => plan.rows <= 1), 'Fixed windows return at most one recent/predecessor/attempt row per query');
    t.diagnostic(JSON.stringify({ olderRowsPerStream: count, plans: traced.plans.length, elapsedMs: performance.now() - began }));
  }
});

for (const signal of signals) test(`${signal} attempts retain receipt and ID ordering, source scope and incomplete-import exclusions`, t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const base = store.observation(report(T, { signal }));
  const latest = store.observation(report(T + MINUTE, { signal, sourceTime: T + 10 * MINUTE,
    value: null, unit: 'invalid', quality: ['invalid_unit'], raw: { timeBasis: 'availability-transition' } }));
  const retained = store.observation(report(T + MINUTE, { signal, quality: ['retained'], raw: { retained: true } }));
  const simulated = store.observation(report(T + MINUTE + 1, { signal, source: 'simulation' }));
  store.observation(report(T + 2 * MINUTE, { signal }));
  assert.equal(recordedTemperatureAttempt(store, signal, T, 'providers').id, base);
  assert.equal(recordedTemperatureAttempt(store, signal, T + MINUTE, 'providers').id, retained,
    'A retained or failed attempt is still diagnostic evidence, and equal receipts use the greatest ID');
  assert.equal(recordedTemperatureAttempt(store, signal, T + MINUTE + 1, 'simulated').id, simulated);
  store.transaction(() => store.db.prepare('INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES(?,?,?)')
    .run('original', 'observations', String(retained)));
  const result = recordedTemperatureAttempt(store, signal, T + MINUTE, 'providers');
  assert.equal(result.id, latest); assert.equal(result.sourceTime, T + 10 * MINUTE, 'Attempt selection preserves an unadmitted source clock');
  const importId = store.db.prepare("INSERT INTO imports(kind,path,sha256,status,started_at) VALUES('stmq','invented','invented','importing',?)").run(T).lastInsertRowid;
  store.observation(report(T + MINUTE + 1, { signal, provenance: { importId: Number(importId), rowNumber: 1 } }));
  assert.equal(recordedTemperatureAttempt(store, signal, T + MINUTE + 1, 'providers').id, latest);
  store.transaction(() => store.db.prepare("UPDATE imports SET status='complete' WHERE id=?").run(importId));
  assert.notEqual(recordedTemperatureAttempt(store, signal, T + MINUTE + 1, 'providers').id, latest);
});

test('outdoor receipt seeks preserve delayed reports, outages, retained packets and original admission clocks', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.observation(weather(T));
  store.observation(weather(T + MINUTE, { sourceTime: T - 2 * MINUTE, value: 8 }));
  store.observation(weather(T + 2 * MINUTE, { sourceTime: T + 20 * MINUTE, value: 9, quality: ['future_source_time'] }));
  store.observation(weather(T + 3 * MINUTE, { value: 11, quality: ['retained'], raw: { retained: true } }));
  assert.equal(recordedOutdoorObservation(store, T + 3 * MINUTE, { input: 'providers' }).value, 10);
  store.observation(weather(T + 4 * MINUTE, { sourceTime: null, value: null, quality: ['mqtt-disconnected'],
    raw: { timeBasis: 'availability-transition' } }));
  store.observation(weather(T + 5 * MINUTE, { sourceTime: T + 3 * MINUTE, value: 11 }));
  const unavailable = recordedOutdoorObservation(store, T + 5 * MINUTE, { input: 'providers' });
  assert.equal(unavailable.value, null); assert(unavailable.availabilityReasons.includes('disconnected'));
  store.observation(weather(T + 6 * MINUTE, { value: 12 }));
  store.observation(weather(T + 6 * MINUTE, { value: 13 }));
  store.observation(weather(T + 6 * MINUTE + 1, { sourceTime: T + 6 * MINUTE + 501, value: 14,
    raw: { timeAdmission: { sourceTime: T + 6 * MINUTE + 501, receivedAt: T + 6 * MINUTE + 1, admittedAt: T + 10 * MINUTE } } }));
  assert.equal(recordedOutdoorObservation(store, T + 8 * MINUTE, { input: 'providers' }).value, 13);
  assert.equal(recordedOutdoorObservation(store, T + 10 * MINUTE, { input: 'providers' }).value, 14);
  assert.equal(recordedOutdoorObservation(store, T + 10 * MINUTE, { knownAt: T + 5 * MINUTE, input: 'providers' }).value, null);
});

test('metadata preserves exact stream, retained rejection, policy changes and as-of coverage uncertainty', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store), periodic = { reportIntervalMs: 15 * MINUTE, reportGraceMs: 2 * MINUTE };
  for (const at of [T, T + 15 * MINUTE, T + 30 * MINUTE]) recorder.record(report(at, { raw: periodic }));
  const held = reading(store, store.db.prepare("SELECT id FROM observations WHERE signal='indoor_temperature' ORDER BY id LIMIT 1").get().id);
  const inside = indoorStatusMetadata(held, T + 20 * MINUTE, { store, knownAt: T + 20 * MINUTE });
  assert.equal(inside.lastReportAt, null); assert.equal(inside.reportExpiresAt, T + 20 * MINUTE);
  store.observation(report(T + 31 * MINUTE, { value: null, quality: ['report-policy-changed'],
    raw: { timeBasis: 'availability-transition', ...periodic } }));
  store.observation(report(T + 32 * MINUTE, { value: 22, quality: ['retained'], raw: { retained: true } }));
  store.observation(report(T + 33 * MINUTE, { source: 'another-source', value: 22 }));
  store.observation(report(T + 34 * MINUTE, { device: 'another-device', value: 22 }));
  const metadata = indoorStatusMetadata(held, T + 35 * MINUTE, { store, stale: true });
  assert.deepEqual(metadata.availabilityReasons, ['report-policy-changed']);
  assert.equal(metadata.lastAttemptAt, T + 31 * MINUTE); assert.equal(metadata.reportExpiresAt, null);
});

function selectActualProposedViews(db) {
  const source = readFileSync(new URL('../src/recovery/revision-worker.js', import.meta.url), 'utf8');
  const producer = source.match(/function selectProposedViews\(\) \{[\s\S]*?\n\}/)?.[0];
  assert(producer);
  new Function('db', 'generation', 'RECOVERABLE_TABLES', 'recoveryRecordKey', `${producer};selectProposedViews();`)
    (db, proposed, RECOVERABLE_TABLES, recoveryRecordKey);
}
for (const exclude of [true, false]) test(`temperature lookups honor actual proposed ${exclude ? 'exclusion' : 'inclusion'}`, t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.observation(weather(T)); const laterWeather = store.observation(weather(T + MINUTE, { value: 12 }));
  const held = reading(store, store.observation(report(T)));
  const failed = store.observation(report(T + MINUTE, { value: null, unit: 'invalid', quality: ['invalid_unit'] }));
  store.transaction(() => { for (const id of [laterWeather, failed]) store.db.prepare('INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES(?,?,?)')
    .run(exclude ? proposed : 'original', 'observations', String(id)); });
  const current = () => ({ outdoor: recordedOutdoorObservation(store, T + 2 * MINUTE, { input: 'providers' }).value,
    attempt: recordedTemperatureAttempt(store, 'indoor_temperature', T + 2 * MINUTE, 'providers').id,
    metadata: indoorStatusMetadata(held, T + 2 * MINUTE, { store, stale: true }).lastAttemptAt });
  assert.deepEqual(current(), exclude ? { outdoor: 12, attempt: failed, metadata: T + MINUTE }
    : { outdoor: 10, attempt: held.id, metadata: undefined });
  const checkpoint = store.checkpoint(); selectActualProposedViews(store.db);
  assert.deepEqual(current(), exclude ? { outdoor: 10, attempt: held.id, metadata: undefined }
    : { outdoor: 12, attempt: failed, metadata: T + MINUTE });
  assert.deepEqual(store.checkpoint(), checkpoint);
});

test('journal-source temperature readers use the actual unhinted active overlay', async t => {
  const f = fixture(t);
  f.master.observation(weather(T)); f.master.observation(report(T));
  const base = enrollJournalPeer(f.master.db).checkpoint, donor = await f.donor();
  donor.observation(weather(T + MINUTE, { value: 12 }));
  const held = reading(donor, donor.observation(report(T + MINUTE)));
  const failed = donor.observation(report(T + 2 * MINUTE, { value: null, unit: 'invalid', quality: ['invalid_unit'] }));
  const transfers = new PeerTransfers(join(f.directory, 'temperature-wire'));
  const wire = await transfers.export({ dbPath: donor.path, after: base });
  const journalPath = join(f.directory, 'temperature-source.ndjson');
  await writeFile(journalPath, await readFile(join(transfers.directory, `peer-${wire.id}.changes`)), { mode: 0o600 });
  const checkpoint = f.master.checkpoint();
  const source = await openJournalSource({ masterPath: f.master.path, journalPath, yieldControl: async () => {} });
  try {
    assert.equal(source.journalSource, true);
    assert.equal(source.db.prepare("SELECT type FROM temp.sqlite_schema WHERE name='observations'").get().type, 'view');
    assert.equal(recordedOutdoorObservation(source, T + 3 * MINUTE, { input: 'providers' }).value, 12);
    assert.equal(recordedTemperatureAttempt(source, 'indoor_temperature', T + 3 * MINUTE, 'providers').id, failed);
    assert.equal(indoorStatusMetadata(held, T + 3 * MINUTE, { store: source, stale: true }).lastAttemptAt, T + 2 * MINUTE);
    assert.deepEqual(f.master.checkpoint(), checkpoint);
  } finally { source.close(); }
});
