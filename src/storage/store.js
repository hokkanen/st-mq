import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { mkdirSync, existsSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const SCHEMA_VERSION = 1;
const MAX_LIMIT = 5000;
const schema = `
CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE imports (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL,
  status TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER,
  row_count INTEGER NOT NULL DEFAULT 0, rejected_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(kind, sha256)
);
CREATE TABLE import_rows (
  import_id INTEGER NOT NULL REFERENCES imports(id), row_number INTEGER NOT NULL,
  source_time INTEGER, raw TEXT NOT NULL, quality TEXT NOT NULL,
  PRIMARY KEY(import_id, row_number)
) WITHOUT ROWID;
CREATE TABLE observations (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, device TEXT NOT NULL, signal TEXT NOT NULL,
  value REAL, unit TEXT NOT NULL, source_time INTEGER, received_at INTEGER NOT NULL,
  quality TEXT NOT NULL, raw TEXT, import_id INTEGER REFERENCES imports(id), row_number INTEGER
);
CREATE INDEX observations_signal_time ON observations(signal, source_time, id);
CREATE INDEX observations_time ON observations(source_time, id);
CREATE INDEX observations_signal_id ON observations(signal, id);
CREATE TABLE annotations (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER,
  note TEXT NOT NULL, boundary_confidence TEXT NOT NULL, exclude_training INTEGER NOT NULL,
  provenance TEXT NOT NULL, created_at INTEGER NOT NULL, unique_key TEXT UNIQUE
);
CREATE INDEX annotations_time ON annotations(start_at, end_at);
CREATE TABLE counters (
  id INTEGER PRIMARY KEY, device TEXT NOT NULL, signal TEXT NOT NULL, value REAL NOT NULL,
  unit TEXT NOT NULL, observed_date TEXT NOT NULL, source_time INTEGER,
  note TEXT NOT NULL, provenance TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(device, signal, observed_date, provenance)
);`;

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}
function instant(value, name) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8640000000000000) throw new TypeError(`${name} must be a UTC timestamp in milliseconds`);
  return value;
}
function label(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new TypeError(`${name} must be a nonempty string of at most 500 characters`);
  return value;
}
function json(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('value must be JSON serializable');
  return encoded;
}
function limitValue(value) { return Math.min(integer(value, 'limit'), MAX_LIMIT); }
function observationResult(row) {
  return {
    id: row.id, source: row.source, device: row.device, signal: row.signal,
    value: row.value, unit: row.unit, sourceTime: row.source_time, receivedAt: row.received_at,
    quality: JSON.parse(row.quality), raw: row.raw === null ? null : JSON.parse(row.raw),
    provenance: row.import_id === null ? null : { importId: row.import_id, rowNumber: row.row_number },
  };
}

/** Local authoritative history. All timestamps are UTC milliseconds; queries are bounded. */
export class Store {
  constructor(path) {
    label(path, 'database path');
    this.path = path === ':memory:' ? path : resolve(path);
    if (path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > SCHEMA_VERSION) throw new Error(`Database schema ${version} is newer than supported version ${SCHEMA_VERSION}`);
      if (version === 0) this.transaction(() => { this.db.exec(schema); this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`); });
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.insertObservation = this.db.prepare(`INSERT INTO observations
        (source, device, signal, value, unit, source_time, received_at, quality, raw, import_id, row_number)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      this.insertEvent = this.db.prepare('INSERT INTO events (type, payload, at) VALUES (?, ?, ?)');
    } catch (error) { this.db.close(); throw error; }
  }

  close() { this.db.close(); }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw new TypeError('SQLite transaction callback must be synchronous');
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getState(key) {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(label(key, 'key'));
    return row ? JSON.parse(row.value) : null;
  }

  setState(key, value) {
    this.db.prepare(`INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(label(key, 'key'), json(value), Date.now());
  }

  event(type, payload, at = Date.now()) {
    return Number(this.insertEvent.run(label(type, 'event type'), json(payload), instant(at, 'at')).lastInsertRowid);
  }

  /** No cursor gives the newest page in chronological insertion order. A cursor follows it. */
  events({ after = 0, limit = 100 } = {}) {
    integer(after, 'after'); limit = limitValue(limit);
    const rows = after > 0
      ? this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(after, limit)
      : this.db.prepare('SELECT * FROM (SELECT * FROM events ORDER BY id DESC LIMIT ?) ORDER BY id').all(limit);
    return rows.map(row => ({ id: row.id, type: row.type, payload: JSON.parse(row.payload), at: row.at }));
  }

  observation({ source, device, signal, value, unit, sourceTime, receivedAt = Date.now(), quality = [], raw = null, provenance = null }) {
    label(source, 'source'); label(device, 'device'); label(signal, 'signal'); label(unit, 'unit');
    if (sourceTime !== null) instant(sourceTime, 'sourceTime');
    instant(receivedAt, 'receivedAt');
    if (value !== null && !Number.isFinite(value)) throw new TypeError('observation value must be finite or null');
    if (!Array.isArray(quality) || !quality.every(flag => typeof flag === 'string')) throw new TypeError('quality must be an array of string flags');
    const flags = [...new Set(value === null ? [...quality, 'missing'] : quality)];
    return Number(this.insertObservation.run(source, device, signal, value, unit, sourceTime, receivedAt,
      json(flags), raw === null ? null : json(raw), provenance?.importId ?? null, provenance?.rowNumber ?? null).lastInsertRowid);
  }

  /** Pages in ingestion/id order so incremental learning can resume without full-history scans. */
  observations({ signal, from, to, limit = 1000, afterId = 0 } = {}) {
    const clauses = ['o.id > ?', "(o.import_id IS NULL OR i.status = 'complete')"];
    const params = [integer(afterId, 'afterId')];
    if (signal !== undefined) { clauses.push('o.signal = ?'); params.push(label(signal, 'signal')); }
    if (from !== undefined) { clauses.push('o.source_time >= ?'); params.push(instant(from, 'from')); }
    if (to !== undefined) { clauses.push('o.source_time < ?'); params.push(instant(to, 'to')); }
    params.push(limitValue(limit));
    return this.db.prepare(`SELECT o.* FROM observations o LEFT JOIN imports i ON i.id = o.import_id
      WHERE ${clauses.join(' AND ')} ORDER BY o.id LIMIT ?`).all(...params).map(observationResult);
  }

  latestObservation(signal) {
    const row = this.db.prepare(`SELECT o.* FROM observations o LEFT JOIN imports i ON i.id = o.import_id
      WHERE o.signal = ? AND (o.import_id IS NULL OR i.status = 'complete') ORDER BY o.source_time DESC, o.id DESC LIMIT 1`)
      .get(label(signal, 'signal'));
    return row ? observationResult(row) : null;
  }

  /** Original historical episodes in ingestion order; callers reject non-increasing time. */
  trainingRows({ afterId = 0, limit = 256 } = {}) {
    return this.db.prepare(`SELECT o.id, o.source_time, o.value, o.quality, r.raw,
      EXISTS(SELECT 1 FROM annotations a WHERE a.exclude_training = 1 AND a.start_at <= o.source_time
        AND (a.end_at IS NULL OR a.end_at > o.source_time)) AS annotated
      FROM observations o JOIN imports i ON i.id = o.import_id
      JOIN import_rows r ON r.import_id = o.import_id AND r.row_number = o.row_number
      WHERE o.id > ? AND o.signal = 'indoor_temperature' AND i.kind = 'stmq' AND i.status = 'complete'
      ORDER BY o.id LIMIT ?`).all(integer(afterId, 'afterId'), limitValue(limit)).map(row => {
      // Imports validate numeric-only source columns, including optionally quoted scalars.
      const cells = row.raw.split(',').map(cell => cell.replace(/^"|"$/g, '').trim());
      const numeric = cell => cell !== '' && Number.isFinite(Number(cell)) ? Number(cell) : null;
      const heat = numeric(cells[2]); const outdoorC = numeric(cells[5]);
      const quality = JSON.parse(row.quality);
      if (![0, 15, 60].includes(heat)) quality.push('unknown_legacy_command');
      if (outdoorC === null) quality.push('missing_outdoor');
      if (outdoorC !== null && (outdoorC < -60 || outdoorC > 70)) quality.push('implausible_temperature');
      const absent = row.annotated || quality.includes('absence_heating_off_approximate');
      if (row.annotated) quality.push('excluded_occupied_training');
      return { id: row.id, at: row.source_time, indoorC: row.value, outdoorC,
        action: heat === 0 ? 'reduction' : 'normal', quality: [...new Set(quality)],
        regime: absent ? 'absence_uncertain' : 'occupied' };
    });
  }

  importRow(importId, rowNumber) {
    const row = this.db.prepare('SELECT * FROM import_rows WHERE import_id = ? AND row_number = ?')
      .get(integer(importId, 'importId'), integer(rowNumber, 'rowNumber'));
    return row ? { importId: row.import_id, rowNumber: row.row_number, sourceTime: row.source_time, raw: row.raw, quality: JSON.parse(row.quality) } : null;
  }

  annotation({ kind, startAt, endAt = null, note, boundaryConfidence = 'exact', excludeTraining = true, provenance = 'manual', uniqueKey = null }) {
    label(kind, 'kind'); label(note, 'note'); label(provenance, 'provenance'); instant(startAt, 'startAt');
    if (endAt !== null && instant(endAt, 'endAt') <= startAt) throw new TypeError('endAt must be after startAt');
    if (!['exact', 'approximate', 'unknown'].includes(boundaryConfidence)) throw new TypeError('Invalid boundary confidence');
    if (typeof excludeTraining !== 'boolean') throw new TypeError('excludeTraining must be boolean');
    const result = this.db.prepare(`INSERT INTO annotations
      (kind, start_at, end_at, note, boundary_confidence, exclude_training, provenance, created_at, unique_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(unique_key) DO NOTHING`)
      .run(kind, startAt, endAt, note, boundaryConfidence, Number(excludeTraining), provenance, Date.now(), uniqueKey);
    return result.changes ? Number(result.lastInsertRowid) : this.db.prepare('SELECT id FROM annotations WHERE unique_key = ?').get(uniqueKey).id;
  }

  annotations({ from, to, limit = 1000 } = {}) {
    const clauses = ['1 = 1']; const params = [];
    if (from !== undefined) { clauses.push('(end_at IS NULL OR end_at > ?)'); params.push(instant(from, 'from')); }
    if (to !== undefined) { clauses.push('start_at < ?'); params.push(instant(to, 'to')); }
    params.push(limitValue(limit));
    return this.db.prepare(`SELECT * FROM annotations WHERE ${clauses.join(' AND ')} ORDER BY start_at, id LIMIT ?`).all(...params)
      .map(row => ({ id: row.id, kind: row.kind, startAt: row.start_at, endAt: row.end_at, note: row.note,
        boundaryConfidence: row.boundary_confidence, excludeTraining: Boolean(row.exclude_training), provenance: row.provenance, createdAt: row.created_at }));
  }

  counter({ device = 'heat_pump', signal, value, unit = 'h', observedDate, sourceTime = null, note = '', provenance = 'manual' }) {
    label(device, 'device'); label(signal, 'signal'); label(unit, 'unit'); label(provenance, 'provenance');
    if (!Number.isFinite(value) || value < 0) throw new TypeError('Counter value must be finite and non-negative');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(observedDate) || !Number.isFinite(Date.parse(`${observedDate}T00:00:00Z`)) || new Date(`${observedDate}T00:00:00Z`).toISOString().slice(0, 10) !== observedDate) throw new TypeError('observedDate must be a real ISO calendar date');
    if (sourceTime !== null) instant(sourceTime, 'sourceTime');
    if (typeof note !== 'string' || note.length > 4000) throw new TypeError('Invalid counter note');
    const existing = this.db.prepare('SELECT id, value, unit FROM counters WHERE device = ? AND signal = ? AND observed_date = ? AND provenance = ?').get(device, signal, observedDate, provenance);
    if (existing) {
      if (existing.value !== value || existing.unit !== unit) throw new Error('Conflicting dated counter; preserve the original and use distinct correction provenance');
      return existing.id;
    }
    return Number(this.db.prepare(`INSERT INTO counters
      (device, signal, value, unit, observed_date, source_time, note, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(device, signal, value, unit, observedDate, sourceTime, note, provenance, Date.now()).lastInsertRowid);
  }

  counters({ signal, afterId = 0, limit = 1000 } = {}) {
    const clause = signal === undefined ? '' : ' AND signal = ?';
    const params = [integer(afterId, 'afterId')];
    if (signal !== undefined) params.push(label(signal, 'signal'));
    params.push(limitValue(limit));
    return this.db.prepare(`SELECT * FROM counters WHERE id > ?${clause} ORDER BY id LIMIT ?`).all(...params)
      .map(row => ({ id: row.id, device: row.device, signal: row.signal, value: row.value, unit: row.unit,
        observedDate: row.observed_date, sourceTime: row.source_time, note: row.note, provenance: row.provenance }));
  }

  summary() {
    return {
      schemaVersion: this.db.prepare('PRAGMA user_version').get().user_version,
      observations: this.db.prepare('SELECT COUNT(*) AS count, MIN(source_time) AS first, MAX(source_time) AS last FROM observations').get(),
      imports: this.db.prepare('SELECT * FROM imports ORDER BY id DESC LIMIT 100').all(),
      events: this.db.prepare('SELECT COUNT(*) AS count FROM events').get().count,
      counters: this.db.prepare('SELECT COUNT(*) AS count FROM counters').get().count,
      annotations: this.annotations(),
      interpretation: 'Current snapshots are amperes, not metered energy. Historical heat values are requests, not compressor activity. Savings and causal auxiliary attribution are unproven.',
    };
  }

  async backup(destination) {
    const path = resolve(destination);
    if (path === this.path || existsSync(path)) throw new Error('Backup destination must be a new file');
    mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(path, 'wx', 0o600));
    await sqliteBackup(this.db, path);
    return path;
  }

  /** Restore to a new database while the application is stopped; never overwrite a live WAL. */
  static async restore(source, destination) {
    const path = resolve(destination);
    if (existsSync(path) || existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) throw new Error('Restore destination must be a new database path');
    const check = new DatabaseSync(resolve(source), { readOnly: true });
    try {
      if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Backup database failed integrity check');
      if (check.prepare('PRAGMA user_version').get().user_version !== SCHEMA_VERSION) throw new Error('Unsupported backup schema');
      check.prepare('SELECT key, value FROM state LIMIT 1').all();
      mkdirSync(dirname(path), { recursive: true });
      closeSync(openSync(path, 'wx', 0o600));
      await sqliteBackup(check, path);
    } finally { check.close(); }
    return path;
  }
}
