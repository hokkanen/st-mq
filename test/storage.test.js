import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { Store, SCHEMA_VERSION } from '../src/storage/store.js';
import { importCsv, exportCsv, seedHandoffObservations, parseCsvLine } from '../src/storage/history.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'stmq-storage-'));
  const path = join(dir, 'history.sqlite'); const store = new Store(path);
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { store, dir, path };
}
const stHeader = 'unix_time,price,heat_on,temp_in,temp_ga,temp_out\n';
const evHeader = 'unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3\n';

test('schema migrates once, checkpoints survive restart, future schema is rejected', t => {
  const { store, path } = fixture(t);
  assert.equal(store.summary().schemaVersion, SCHEMA_VERSION);
  assert.equal(store.getState('missing'), null);
  store.setState('learning', { version: 1, cursor: 23, parameters: [1, 2] });
  store.close();
  const reopened = new Store(path);
  assert.deepEqual(reopened.getState('learning'), { version: 1, cursor: 23, parameters: [1, 2] });
  reopened.close();
  const raw = new DatabaseSync(path); raw.exec('PRAGMA user_version = 999'); raw.close();
  assert.throws(() => new Store(path), /newer/);
});

test('schema-v2 migration preserves observations and indexes complete Easee acquisitions', t => {
  const { store, path } = fixture(t);
  const receivedAt = 4_000_000;
  for (const phase of [1, 2, 3]) store.observation({
    source: 'easee', device: 'example-equalizer', signal: `property_current_l${phase}`,
    value: phase, unit: 'A', sourceTime: phase * 1_000_000, receivedAt,
  });
  store.observation({ source: 'mqtt', device: 'example-equalizer', signal: 'property_current_l1',
    value: 7, unit: 'A', sourceTime: receivedAt, receivedAt });
  store.setState('checkpoint', { cursor: 42 });
  const before = store.observations();
  store.close();

  const prior = new DatabaseSync(path);
  prior.exec(`DROP INDEX observations_easee_acquisition; DROP TABLE learning_samples; DROP TABLE learning_cycles;
    DROP VIEW provider_snapshots;
    DROP INDEX snapshots_content_fetch;
    ALTER TABLE provider_snapshot_fetches DROP COLUMN content_id;
    ALTER TABLE provider_snapshot_fetches DROP COLUMN fetch_metadata;
    ALTER TABLE provider_snapshot_fetches RENAME TO provider_snapshots;
    DROP TABLE provider_snapshot_contents; DROP TABLE recorder_coverage; DROP TABLE recorder_metrics;
    DROP TABLE energy_audits; DROP TABLE learning_journal;
    DROP TABLE chart_rollups; DROP TABLE chart_rollup_meta; PRAGMA user_version = 2`);
  prior.close();
  const migrated = new Store(path);
  try {
    assert.equal(migrated.summary().schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(migrated.observations(), before);
    assert.deepEqual(migrated.getState('checkpoint'), { cursor: 42 });
    const sql = `SELECT signal,source_time FROM observations
      WHERE source='easee' AND import_id IS NULL AND device=? AND received_at=? ORDER BY id`;
    const params = ['example-equalizer', receivedAt];
    assert.equal(migrated.db.prepare(sql).all(...params).length, 3);
    assert(migrated.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
      .some(row => /SEARCH observations USING INDEX observations_easee_acquisition/.test(row.detail)),
    'Acquisition lookup must use the migrated index instead of scanning observation history');
  } finally { migrated.close(); }
});

test('events return a chronological tail and a cursor follows new events', t => {
  const { store } = fixture(t);
  for (let n = 1; n <= 7; n++) store.event('decision', { n }, n * 1000);
  assert.deepEqual(store.events({ limit: 3 }).map(event => event.id), [5, 6, 7]);
  assert.deepEqual(store.events({ after: 2, limit: 2 }).map(event => event.id), [3, 4]);
  assert.throws(() => store.events({ limit: -1 }), /non-negative/);
  assert.throws(() => store.events({ after: 1.3 }), /integer/);
});

test('observation storage preserves unknown readings and rejects non-finite values', t => {
  const { store } = fixture(t);
  const base = { source: 'mqtt', device: 'pump', signal: 'indoor_temperature', unit: 'degC', sourceTime: 1000, receivedAt: 2000 };
  store.observation({ ...base, value: null, raw: { input: 'NaN' } });
  store.observation({ ...base, sourceTime: 3000, value: 0 });
  const rows = store.observations({ signal: base.signal, to: 3000 });
  assert.equal(rows.length, 1); assert.equal(rows[0].value, null);
  assert.deepEqual(rows[0].quality, ['missing']); assert.deepEqual(rows[0].raw, { input: 'NaN' });
  assert.equal(store.latestObservation(base.signal).value, 0);
  assert.throws(() => store.observation({ ...base, value: NaN }), /finite or null/);
  assert.throws(() => store.observation({ ...base, value: 20, sourceTime: 'now' }), /milliseconds/);
  assert.throws(() => store.observation({ ...base, value: 20, quality: 'good' }), /array/);
});

test('CSV import is idempotent across paths and preserves source provenance, negative price and missing data', async t => {
  const { store, dir } = fixture(t); const file = join(dir, 'old.csv');
  const csv = stHeader + '1701842401,-4.2,60,21.3,NaN,-5.3\n1701846002,0,0,0,,-5.6\nbad,3,0,21,4,5\n';
  writeFileSync(file, csv);
  const imported = await importCsv(store, file, { kind: 'stmq', batchSize: 1 });
  assert.equal(imported.rows, 3); assert.equal(imported.rejected, 1);
  assert.equal(store.observations().length, 10);
  assert.equal(store.observations({ signal: 'spot_price' })[0].value, -4.2);
  assert.equal(store.observations({ signal: 'garage_temperature' })[0].value, null);
  const indoor = store.observations({ signal: 'indoor_temperature' });
  assert(indoor[1].quality.includes('suspect_zero_indoor'));
  assert.equal(store.importRow(imported.importId, 1).raw, csv.split('\n')[1]);
  assert.equal(indoor[0].provenance.importId, imported.importId);
  writeFileSync(join(dir, 'renamed.csv'), csv);
  assert.equal((await importCsv(store, join(dir, 'renamed.csv'), { kind: 'stmq' })).skipped, true);
  assert.equal(store.observations().length, 10);
});

test('interrupted imports remain hidden and retry without duplicate committed batches', async t => {
  const { store, dir } = fixture(t); const file = join(dir, 'old.csv');
  writeFileSync(file, stHeader + '1701842401,3,60,21.3,NaN,-5.3\n1701846002,4,0,21.2,,-5.6\n');
  await assert.rejects(importCsv(store, file, { kind: 'stmq', batchSize: 1, onProgress: () => { throw new Error('simulated interruption'); } }), /interruption/);
  assert.equal(store.observations().length, 0);
  assert.equal(store.trainingRows().length, 0);
  const imported = await importCsv(store, file, { kind: 'stmq', batchSize: 1 });
  assert.equal(imported.rows, 2); assert.equal(store.observations().length, 10);
});

test('current snapshots retain anomaly flags without inventing power or energy', async t => {
  const { store, dir } = fixture(t); const file = join(dir, 'easee.csv');
  writeFileSync(file, evHeader + '1701842400,16,16,16,0,0,0\n1702102400,NaN,0,0,12,12,12\n');
  await importCsv(store, file, { kind: 'easee' });
  const rows = store.observations();
  assert.equal(rows.length, 12); assert(rows.every(row => row.unit === 'A'));
  assert(rows[0].quality.includes('current_snapshot_not_energy'));
  assert(rows[0].quality.includes('ev_exceeds_property_current'));
  assert(rows[3].quality.includes('all_zero_property_current'));
  assert.equal(rows[3].value, 0);
  assert(rows[6].quality.includes('gap_before')); assert.equal(rows[6].value, null);
});

test('handoff counters and approximate absence are idempotent and not converted to precise telemetry', async t => {
  const { store, dir } = fixture(t);
  seedHandoffObservations(store); seedHandoffObservations(store);
  assert.equal(store.counters().length, 84);
  const last = store.counters({ signal: 'dhw_runtime' }).at(-1);
  assert.equal(last.value, 12216); assert.equal(last.observedDate, '2026-09-06'); assert.equal(last.sourceTime, null);
  const annotations = store.annotations(); assert.equal(annotations.length, 1);
  assert.equal(annotations[0].boundaryConfidence, 'approximate'); assert.equal(annotations[0].excludeTraining, true);
  const file = join(dir, 'absence.csv');
  writeFileSync(file, stHeader + `${Date.parse('2026-02-28T21:00:00Z') / 1000},2,60,21.3,NaN,-5.3\n${Date.parse('2026-04-02T21:00:00Z') / 1000},2,0,12,NaN,1\n`);
  await importCsv(store, file, { kind: 'stmq' });
  const rows = store.trainingRows();
  assert.equal(rows[0].regime, 'occupied'); assert.equal(rows[0].action, 'normal');
  assert.equal(rows[1].regime, 'absence_uncertain'); assert.equal(rows[1].action, 'reduction');
  assert(rows[1].quality.includes('excluded_occupied_training'));
  assert.equal(store.trainingRows({ afterId: rows[0].id, limit: 1 })[0].id, rows[1].id);
});

test('manual counters and annotations validate facts and preserve conflicting provenance', t => {
  const { store } = fixture(t);
  assert.throws(() => store.counter({ signal: 'compressor_runtime', value: -1, observedDate: '2026-09-06' }), /non-negative/);
  assert.throws(() => store.counter({ signal: 'compressor_runtime', value: 1, observedDate: '2026-02-30' }), /real ISO/);
  const counter = { signal: 'compressor_runtime', value: 10, observedDate: '2026-09-06' };
  const id = store.counter(counter); assert.equal(store.counter(counter), id);
  assert.throws(() => store.counter({ ...counter, value: 20 }), /Conflicting/);
  assert.throws(() => store.annotation({ kind: 'absence', startAt: 2000, endAt: 1000, note: 'Away' }), /after/);
  store.annotation({ kind: 'absence', startAt: 1000, endAt: 2000, note: 'Away' });
  assert.equal(store.annotations({ from: 2000 }).length, 0);
  assert.equal(store.annotations({ to: 1000 }).length, 0);
  assert.equal(store.annotations({ from: 1500, to: 1600 }).length, 1);
});

test('transactions roll back and WAL backups restore complete state to a new destination', async t => {
  const { store, dir, path } = fixture(t);
  assert.throws(() => store.transaction(() => { store.setState('partial', true); throw new Error('crash'); }), /crash/);
  assert.equal(store.getState('partial'), null);
  store.setState('checkpoint', { cursor: 42 }); store.event('test', { ok: true });
  const backup = join(dir, 'backup.sqlite'); await store.backup(backup);
  await assert.rejects(store.backup(backup), /new file/);
  await assert.rejects(Store.restore(backup, path), /new database/);
  const restored = join(dir, 'restored.sqlite'); await Store.restore(backup, restored);
  const copy = new Store(restored);
  try { assert.deepEqual(copy.getState('checkpoint'), { cursor: 42 }); assert.equal(copy.events().length, 1); }
  finally { copy.close(); }
});

test('CSV export is bounded, preserves quality/unknowns and refuses overwriting files', async t => {
  const { store, dir } = fixture(t); const file = join(dir, 'old.csv'); const output = join(dir, 'export.csv');
  writeFileSync(file, stHeader + '1701842401,-4.2,60,21.3,NaN,-5.3\n');
  await importCsv(store, file, { kind: 'stmq' });
  assert.equal((await exportCsv(store, output, { signal: 'garage_temperature' })).rows, 1);
  const lines = readFileSync(output, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const row = parseCsvLine(lines[1]); assert.equal(row[4], ''); assert(JSON.parse(row[8]).includes('missing'));
  await assert.rejects(exportCsv(store, output), /EEXIST/);
});

test('offline CLI accepts counter and annotation input, rejects unknown options', t => {
  const { path } = fixture(t);
  const invoke = args => execFileSync(process.execPath, ['scripts/history.js', ...args, '--db', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const result = JSON.parse(invoke(['counter', '--signal', 'compressor_runtime', '--value', '38300', '--date', '2026-09-06']));
  assert.equal(result.id, 1);
  assert.throws(() => invoke(['summary', '--unknown', 'yes']), /Unknown option/);
  assert.throws(() => invoke(['annotate', '--kind', 'absence', '--from', '2026-01-01', '--to', '2026-02-01', '--note', 'Away']), /UTC offset/);
});

test('CSV parser accepts quoted scalars and rejects malformed source records', () => {
  assert.deepEqual(parseCsvLine('"1",2,"a""b"'), ['1', '2', 'a"b']);
  assert.throws(() => parseCsvLine('"1'), /Unterminated/);
  assert.throws(() => parseCsvLine('"1"x,2'), /Invalid/);
});
