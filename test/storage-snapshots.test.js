import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { Store, SCHEMA_VERSION } from '../src/storage/store.js';

// Frozen schema-v1 fixture: migration must accept an old database independently
// of how the current constructor initializes a brand-new database.
const V1_SCHEMA = `
CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE imports (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL,
  status TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER,
  row_count INTEGER NOT NULL DEFAULT 0, rejected_count INTEGER NOT NULL DEFAULT 0, UNIQUE(kind, sha256));
CREATE TABLE import_rows (import_id INTEGER NOT NULL REFERENCES imports(id), row_number INTEGER NOT NULL,
  source_time INTEGER, raw TEXT NOT NULL, quality TEXT NOT NULL, PRIMARY KEY(import_id, row_number)) WITHOUT ROWID;
CREATE TABLE observations (id INTEGER PRIMARY KEY, source TEXT NOT NULL, device TEXT NOT NULL, signal TEXT NOT NULL,
  value REAL, unit TEXT NOT NULL, source_time INTEGER, received_at INTEGER NOT NULL,
  quality TEXT NOT NULL, raw TEXT, import_id INTEGER REFERENCES imports(id), row_number INTEGER);
CREATE INDEX observations_signal_time ON observations(signal, source_time, id);
CREATE INDEX observations_time ON observations(source_time, id);
CREATE INDEX observations_signal_id ON observations(signal, id);
CREATE TABLE annotations (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER,
  note TEXT NOT NULL, boundary_confidence TEXT NOT NULL, exclude_training INTEGER NOT NULL,
  provenance TEXT NOT NULL, created_at INTEGER NOT NULL, unique_key TEXT UNIQUE);
CREATE INDEX annotations_time ON annotations(start_at, end_at);
CREATE TABLE counters (id INTEGER PRIMARY KEY, device TEXT NOT NULL, signal TEXT NOT NULL, value REAL NOT NULL,
  unit TEXT NOT NULL, observed_date TEXT NOT NULL, source_time INTEGER, note TEXT NOT NULL,
  provenance TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(device, signal, observed_date, provenance));
PRAGMA user_version = 1;`;

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'stmq-snapshots-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeVersionOne(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec(V1_SCHEMA);
    db.prepare('INSERT INTO state VALUES (?, ?, ?)').run('controller:offline:shadow',
      JSON.stringify({ lastDhwrAt: '2026-09-06T09:00:00.000Z', deficitDegreeHours: 1.25 }), 1788685200000);
    db.prepare('INSERT INTO events (id, type, payload, at) VALUES (?, ?, ?, ?)')
      .run(7, 'decision', JSON.stringify({ action: 'normal' }), 1788685200000);
    db.prepare(`INSERT INTO observations (id,source,device,signal,value,unit,source_time,received_at,quality)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(42, 'historical', 'house', 'indoor_temperature', 21.3, 'degC', 1788685200000, 1788685201000, '[]');
  } finally { db.close(); }
}

test('schema-v1 migration preserves controller recency, observations and event IDs', t => {
  const path = join(directory(t), 'legacy.sqlite');
  makeVersionOne(path);
  let store = new Store(path);
  try {
    assert.equal(store.summary().schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(store.getState('controller:offline:shadow'), {
      lastDhwrAt: '2026-09-06T09:00:00.000Z', deficitDegreeHours: 1.25,
    });
    assert.equal(store.events()[0].id, 7);
    assert.equal(store.observations()[0].id, 42);
    assert.equal(store.observations()[0].value, 21.3);
    assert.deepEqual(store.snapshots(), []);
    store.snapshot({ kind: 'weather', source: 'fixture', fetchedAt: 1788685300000, payload: { forecast: [] } });
  } finally { store.close(); }
  store = new Store(path);
  try {
    assert.equal(store.snapshots().length, 1);
    assert.equal(store.events().length, 1);
    assert.equal(store.observations().length, 1);
  } finally { store.close(); }
});

test('snapshots preserve unknown provider issuance separately from local fetch time', t => {
  const store = new Store(join(directory(t), 'snapshots.sqlite'));
  try {
    const fetchedAt = 1788685200000;
    store.snapshot({ kind: 'weather', source: 'openweathermap', issuedAt: null, fetchedAt,
      payload: { issuedAt: null, issuedAtBasis: 'fetched-snapshot', forecast: [{ outdoorC: 4 }] } });
    store.snapshot({ kind: 'market', source: 'entsoe', issuedAt: fetchedAt - 3600000, fetchedAt,
      payload: { intervals: [{ spotCtPerKwh: -2 }] } });
    const [weather, market] = store.snapshots();
    assert.equal(weather.issuedAt, null);
    assert.equal(weather.fetchedAt, fetchedAt);
    assert.equal(weather.payload.issuedAt, null);
    assert.equal(market.issuedAt, fetchedAt - 3600000);
    assert.equal(market.fetchedAt, fetchedAt);
    assert.throws(() => store.snapshot({ kind: 'weather', source: 'fixture', fetchedAt: null, payload: {} }), /milliseconds/);
    assert.throws(() => store.snapshot({ kind: 'weather', source: 'fixture', fetchedAt, issuedAt: NaN, payload: {} }), /milliseconds/);
  } finally { store.close(); }
});

test('fetched revisions append immutable snapshots while exact ingestion duplicates are idempotent', t => {
  const store = new Store(join(directory(t), 'revisions.sqlite'));
  try {
    const original = { kind: 'weather', source: 'fixture', issuedAt: null, fetchedAt: 1788685200000,
      payload: { forecast: [{ start: 1788688800000, outdoorC: -5 }] } };
    const first = store.snapshot(original);
    assert.equal(store.snapshot(structuredClone(original)), first);
    const revised = { ...original, payload: { forecast: [{ start: 1788688800000, outdoorC: -8 }] } };
    const second = store.snapshot(revised);
    const third = store.snapshot({ ...revised, fetchedAt: original.fetchedAt + 900000 });
    assert.notEqual(second, first);
    assert.notEqual(third, second);
    assert.deepEqual(store.snapshots().map(row => row.payload.forecast[0].outdoorC), [-5, -8, -8]);
    assert.deepEqual(store.snapshots({ afterId: first, limit: 1 }).map(row => row.id), [second]);
    assert.deepEqual(store.snapshots({ kind: 'market' }), []);
  } finally { store.close(); }
});

test('restoring a schema-v1 backup migrates only the new destination and preserves its source', async t => {
  const dir = directory(t), source = join(dir, 'v1-backup.sqlite'), destination = join(dir, 'restored.sqlite');
  makeVersionOne(source);
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const originalHash = hash(source);
  await Store.restore(source, destination);
  const prior = new DatabaseSync(destination, { readOnly: true });
  try { assert.equal(prior.prepare('PRAGMA user_version').get().user_version, 1); }
  finally { prior.close(); }
  const store = new Store(destination);
  try {
    assert.equal(store.summary().schemaVersion, SCHEMA_VERSION);
    assert.equal(store.getState('controller:offline:shadow').deficitDegreeHours, 1.25);
    assert.equal(store.observations()[0].value, 21.3);
    assert.deepEqual(store.snapshots(), []);
  } finally { store.close(); }
  assert.equal(hash(source), originalHash);
  await assert.rejects(Store.restore(source, destination), /new database/);
});

test('a WAL backup includes every fetched forecast revision and its independent issuance metadata', async t => {
  const dir = directory(t), store = new Store(join(dir, 'live.sqlite'));
  const backup = join(dir, 'backup.sqlite');
  try {
    store.snapshot({ kind: 'weather', source: 'fixture', fetchedAt: 1000, issuedAt: null, payload: { temperature: 4 } });
    store.snapshot({ kind: 'weather', source: 'fixture', fetchedAt: 2000, issuedAt: 1500, payload: { temperature: 3 } });
    await store.backup(backup);
  } finally { store.close(); }
  const restored = new Store(backup);
  try {
    assert.deepEqual(restored.snapshots().map(({ issuedAt, fetchedAt, payload }) => ({ issuedAt, fetchedAt, payload })), [
      { issuedAt: null, fetchedAt: 1000, payload: { temperature: 4 } },
      { issuedAt: 1500, fetchedAt: 2000, payload: { temperature: 3 } },
    ]);
  } finally { restored.close(); }
});
