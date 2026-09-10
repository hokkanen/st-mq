import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { mkdirSync, existsSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 12;
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

const snapshotsSchema = `
CREATE TABLE provider_snapshots (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, source TEXT NOT NULL,
  issued_at INTEGER, fetched_at INTEGER NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL,
  UNIQUE(kind, source, fetched_at, digest)
);
CREATE INDEX snapshots_kind_time ON provider_snapshots(kind, fetched_at, id);`;

// Phase event timestamps can differ within one complete Easee API response.
// Chart queries recover the other phases without rescanning unrelated history.
const easeeAcquisitionIndex = `
CREATE INDEX observations_easee_acquisition ON observations(device, received_at, id)
WHERE source='easee' AND import_id IS NULL;`;

const learningSchema = `
CREATE TABLE learning_samples (
 id INTEGER PRIMARY KEY, input TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL,
 UNIQUE(input, at));
CREATE INDEX learning_samples_input_at ON learning_samples(input, at);
CREATE TABLE learning_cycles (
 id TEXT PRIMARY KEY, input TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
 status TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX learning_cycles_input_at ON learning_cycles(input, started_at);`;

// Existing payloads remain byte-for-byte intact. New fetches reference immutable
// content; the compatibility view keeps historical SQL readers working.
const recorderSchema = `
ALTER TABLE provider_snapshots RENAME TO provider_snapshot_fetches;
ALTER TABLE provider_snapshot_fetches ADD COLUMN content_id INTEGER REFERENCES provider_snapshot_contents(id);
ALTER TABLE provider_snapshot_fetches ADD COLUMN fetch_metadata TEXT;
CREATE INDEX snapshots_content_fetch ON provider_snapshot_fetches(content_id,kind,source,fetched_at);
CREATE TABLE provider_snapshot_contents (
 id INTEGER PRIMARY KEY, digest TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
CREATE VIEW provider_snapshots AS SELECT f.id,f.kind,f.source,f.issued_at,f.fetched_at,
 COALESCE(c.payload,f.payload) AS payload,f.digest
 FROM provider_snapshot_fetches f LEFT JOIN provider_snapshot_contents c ON c.id=f.content_id;
CREATE TABLE recorder_coverage (
 id INTEGER PRIMARY KEY, source TEXT NOT NULL, device TEXT NOT NULL, signal TEXT NOT NULL,
 status TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
 source_time INTEGER, observation_id INTEGER REFERENCES observations(id), samples INTEGER NOT NULL);
CREATE INDEX recorder_coverage_signal_time ON recorder_coverage(signal,end_at,id);
CREATE INDEX recorder_coverage_stream ON recorder_coverage(source,device,signal,id);
CREATE INDEX recorder_coverage_outages ON recorder_coverage(start_at,id) WHERE status<>'fresh';
CREATE TABLE recorder_metrics (
 key TEXT NOT NULL,bucket INTEGER NOT NULL,polls INTEGER NOT NULL,records INTEGER NOT NULL,
 bytes INTEGER NOT NULL,error_squared_time REAL NOT NULL,error_time REAL NOT NULL,
 stale INTEGER NOT NULL,failed INTEGER NOT NULL,unavailable INTEGER NOT NULL,
 PRIMARY KEY(key,bucket)) WITHOUT ROWID;
CREATE INDEX recorder_metrics_bucket ON recorder_metrics(bucket);
CREATE TABLE energy_audits (
 id INTEGER PRIMARY KEY, source TEXT NOT NULL, device TEXT NOT NULL, signal TEXT NOT NULL,
 source_time INTEGER NOT NULL, received_at INTEGER NOT NULL, value REAL NOT NULL,
 quality TEXT NOT NULL, comparison TEXT,
 UNIQUE(source,device,signal,source_time,value));
CREATE INDEX energy_audits_device_time ON energy_audits(device,source_time,id);
CREATE TABLE learning_journal (
 id INTEGER PRIMARY KEY, input TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL,
 at INTEGER NOT NULL, algorithm_version TEXT NOT NULL, config_version TEXT,
 forecast_version TEXT, payload TEXT NOT NULL, UNIQUE(input,key));
CREATE INDEX learning_journal_input_id ON learning_journal(input,id);`;

// Fetch timestamps describe acquisition, not forecast content. Keep them in a
// small path map so mixed-source forecasts retain each source's original age.
function snapshotContent(value, metadata, path = []) {
  if (Array.isArray(value)) return value.map((v, i) => snapshotContent(v, metadata, [...path, i]));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (key === 'fetchedAt' || key === 'snapshotId' || key === 'acquisition') metadata.push([[...path, key], value[key]]);
    else result[key] = snapshotContent(value[key], metadata, [...path, key]);
  }
  return result;
}
export function restoreSnapshot(payload, metadata) {
  const result = JSON.parse(payload);
  for (const [path, value] of metadata ? JSON.parse(metadata) : []) {
    let object = result;
    for (const part of path.slice(0, -1)) object = object?.[part];
    if (object && typeof object === 'object') object[path.at(-1)] = value;
  }
  return result;
}

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
  constructor(path, { readOnly = false } = {}) {
    label(path, 'database path');
    this.path = path === ':memory:' ? path : resolve(path);
    this.readOnly = readOnly;
    if (!readOnly && path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path, { readOnly });
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (readOnly) {
        if (version !== SCHEMA_VERSION) throw new Error('Replica database schema does not match this application version');
        this.db.exec('PRAGMA query_only = ON;');
        return;
      }
      if (version > SCHEMA_VERSION) throw new Error(`Database schema ${version} is newer than supported version ${SCHEMA_VERSION}`);
      if (version < SCHEMA_VERSION) this.transaction(() => {
        if (version === 0) this.db.exec(schema);
        if (version < 2) this.db.exec(snapshotsSchema);
        if (version < 3) this.db.exec(easeeAcquisitionIndex);
        if (version < 4) this.db.exec(learningSchema);
        if (version < 5) this.db.exec(recorderSchema);
        if (version < 7) this.db.exec('CREATE INDEX IF NOT EXISTS events_type_time ON events(type,at,id)');
        // Chart results are reconstructed from original history. Discard the
        // obsolete display caches; their pages become available for reuse.
        if (version < 8) this.db.exec('DROP TABLE IF EXISTS chart_rollups; DROP TABLE IF EXISTS chart_rollup_meta;');
        if (version < 9) this.db.exec(`CREATE INDEX IF NOT EXISTS learning_journal_context_time ON learning_journal(input,kind,at,id);
          CREATE INDEX IF NOT EXISTS learning_journal_algorithm ON learning_journal(input,algorithm_version,id);`);
        if (version < 10) this.db.exec(`CREATE TABLE fireplace_events (
          id INTEGER PRIMARY KEY, input TEXT NOT NULL, request_id TEXT NOT NULL,
          at INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('load','remove')),
          kg INTEGER, target_id INTEGER REFERENCES fireplace_events(id),
          UNIQUE(input,request_id),
          CHECK((kind='load' AND kg BETWEEN 2 AND 10 AND target_id IS NULL)
            OR (kind='remove' AND kg IS NULL AND target_id IS NOT NULL)));
          CREATE INDEX fireplace_events_input_time ON fireplace_events(input,at,id);`);
        if (version < 11) this.db.exec(`
          CREATE TABLE learning_epochs (input TEXT PRIMARY KEY, epoch TEXT NOT NULL);
          CREATE TABLE learning_journal_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT, epoch TEXT NOT NULL,
            input TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
            algorithm_version TEXT NOT NULL, config_version TEXT, forecast_version TEXT,
            payload TEXT, source_entry_id INTEGER REFERENCES learning_journal_entries(id),
            CHECK(payload IS NOT NULL OR source_entry_id IS NOT NULL), UNIQUE(epoch,input,key));
          INSERT INTO learning_journal_entries(id,epoch,input,key,kind,at,algorithm_version,config_version,forecast_version,payload)
            SELECT id,'original',input,key,kind,at,
            algorithm_version,config_version,forecast_version,payload FROM learning_journal;
          DROP TABLE learning_journal;
          CREATE INDEX learning_entries_epoch_input ON learning_journal_entries(epoch,input,id);
          CREATE INDEX learning_entries_time ON learning_journal_entries(epoch,input,kind,at,id);
          CREATE VIEW learning_journal_all AS SELECT e.id,e.epoch,e.input,e.key,e.kind,e.at,e.algorithm_version,
            COALESCE(e.config_version,s.config_version) AS config_version,
            COALESCE(e.forecast_version,s.forecast_version) AS forecast_version,
            COALESCE(e.payload,s.payload) AS payload,e.source_entry_id
            FROM learning_journal_entries e LEFT JOIN learning_journal_entries s ON s.id=e.source_entry_id;
          CREATE VIEW learning_journal AS SELECT id,input,key,kind,at,algorithm_version,
            config_version,forecast_version,payload FROM learning_journal_all e
            WHERE epoch=COALESCE((SELECT epoch FROM learning_epochs WHERE input=e.input),'original');
          CREATE TABLE recovery_runs (id TEXT PRIMARY KEY, input TEXT NOT NULL, donor_digest TEXT NOT NULL,
            previous_epoch TEXT NOT NULL, epoch TEXT NOT NULL, status TEXT NOT NULL,
            started_at INTEGER NOT NULL, completed_at INTEGER, report TEXT,
            previous_fireplace_revision INTEGER, source_head INTEGER, fireplace_revision INTEGER);
          CREATE TABLE recovery_provenance (donor_digest TEXT NOT NULL, table_name TEXT NOT NULL,
            donor_id TEXT NOT NULL, target_id TEXT, disposition TEXT NOT NULL,
            PRIMARY KEY(donor_digest,table_name,donor_id)) WITHOUT ROWID;
          CREATE INDEX recovery_provenance_target ON recovery_provenance(table_name,target_id);
          CREATE INDEX observations_recovery_energy ON observations(device,signal,
            CASE WHEN json_valid(raw) THEN json_extract(raw,'$.intervalEnd') END);
        `);
        // A new learning algorithm starts after archived journal entries. Its
        // first/current-page lookups must not rescan that archive while a
        // history batch holds SQLite's single writer lock.
        if (version < 12) this.db.exec(`CREATE INDEX learning_entries_algorithm
          ON learning_journal_entries(epoch,input,algorithm_version,id)`);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      // Experimental charger counter history is superseded by one finalized
      // session reference. Keep property checks, source observations and imports.
      this.db.exec("DELETE FROM energy_audits WHERE signal IN ('ev1_lifetime_energy_counter','ev1_session_energy_counter')");
      this.insertObservation = this.db.prepare(`INSERT INTO observations
        (source, device, signal, value, unit, source_time, received_at, quality, raw, import_id, row_number)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      this.insertEvent = this.db.prepare('INSERT INTO events (type, payload, at) VALUES (?, ?, ?)');
    } catch (error) { this.db.close(); throw error; }
  }

  close() { this.db.close(); }

  transaction(fn) {
    // Acquisition and recorder methods deliberately compose atomic operations.
    // SAVEPOINT keeps an inner failure from leaving half an interval behind.
    if (this.transactionDepth) {
      const savepoint = `nested_${++this.savepointSequence}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = fn();
        if (result && typeof result.then === 'function') throw new TypeError('SQLite transaction callback must be synchronous');
        this.db.exec(`RELEASE ${savepoint}`); return result;
      } catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth = 1; this.savepointSequence ??= 0;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw new TypeError('SQLite transaction callback must be synchronous');
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionDepth = 0; }
  }

  getState(key) {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(label(key, 'key'));
    return row ? JSON.parse(row.value) : null;
  }

  setState(key, value) {
    this.db.prepare(`INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE state.value <> excluded.value`)
      .run(label(key, 'key'), json(value), Date.now());
  }

  learningSample(input, sample) {
    label(input, 'input'); instant(sample.timestamp, 'sample timestamp');
    return this.db.prepare('INSERT INTO learning_samples(input,at,payload) VALUES(?,?,?) ON CONFLICT(input,at) DO NOTHING')
      .run(input, sample.timestamp, json(sample)).changes > 0;
  }

  learningSamples({ input, after = 0, limit = 256 } = {}) {
    return this.db.prepare('SELECT id,payload FROM learning_samples WHERE input=? AND id>? ORDER BY id LIMIT ?')
      .all(label(input, 'input'), integer(after, 'after'), limitValue(limit))
      .map(row => ({ id: row.id, ...JSON.parse(row.payload) }));
  }

  appendLearningJournal(input, { kind, at, algorithmVersion, configVersion = null, forecastVersion = null, payload, key }) {
    if (!['sample', 'episode', 'context'].includes(kind)) throw new TypeError('Invalid learning journal kind');
    label(input, 'input'); instant(at, 'journal timestamp'); label(algorithmVersion, 'algorithm version');
    key ??= `${kind}:${kind === 'episode' ? payload.id ?? payload.episodeId ?? at : at}`;
    label(key, 'journal key');
    const encoded = json(payload), config = configVersion === null ? null : json(configVersion);
    const forecast = forecastVersion === null ? null : json(forecastVersion);
    this.db.prepare(`INSERT INTO learning_journal_entries(epoch,input,key,kind,at,algorithm_version,config_version,forecast_version,payload)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(epoch,input,key) DO NOTHING`)
      .run(this.learningEpoch(input),input,key,kind,at,algorithmVersion,config,forecast,encoded);
    const row = this.db.prepare('SELECT * FROM learning_journal WHERE input=? AND key=?').get(input,key);
    if (row.kind !== kind || row.at !== at || row.algorithm_version !== algorithmVersion || row.payload !== encoded
      || row.config_version !== config || row.forecast_version !== forecast) throw new Error('Conflicting immutable learning journal entry');
    return row.id;
  }

  learningEpoch(input) {
    return this.db.prepare('SELECT epoch FROM learning_epochs WHERE input=?').get(label(input, 'input'))?.epoch ?? 'original';
  }

  learningJournal({ input, after = 0, limit = 256, algorithmVersion } = {}) {
    const values = [label(input,'input'),integer(after,'after')];
    if (algorithmVersion !== undefined) values.push(label(algorithmVersion,'algorithm version'));
    values.push(limitValue(limit));
    return this.db.prepare(`SELECT * FROM learning_journal WHERE input=? AND id>?${algorithmVersion === undefined ? '' : ' AND algorithm_version=?'} ORDER BY id LIMIT ?`)
      .all(...values).map(row => ({ id:row.id,key:row.key,
        kind:row.kind,at:row.at,algorithmVersion:row.algorithm_version,
        configVersion:row.config_version === null ? null : JSON.parse(row.config_version),
        forecastVersion:row.forecast_version === null ? null : JSON.parse(row.forecast_version),payload:JSON.parse(row.payload) }));
  }

  energyAudit({ source = 'easee', device, signal, sourceTime, receivedAt, value, quality = [], comparison = null }) {
    label(source,'source'); label(device,'device'); label(signal,'signal'); instant(sourceTime,'sourceTime'); instant(receivedAt,'receivedAt');
    if (signal !== 'property_import_energy_counter') throw new TypeError('Only the property import counter is retained for cumulative meter checks');
    if (!Number.isFinite(value) || value < 0) throw new TypeError('Invalid audit energy counter');
    if (!Array.isArray(quality) || quality.some(q => typeof q !== 'string')) throw new TypeError('Invalid audit quality');
    return Number(this.db.prepare(`INSERT INTO energy_audits(source,device,signal,source_time,received_at,value,quality,comparison)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source,device,signal,source_time,value) DO NOTHING`)
      .run(source,device,signal,sourceTime,receivedAt,value,json(quality),comparison === null ? null : json(comparison)).changes);
  }

  energyAudits({ device, signal, from, to, after = 0, limit = 100, newestFirst = false } = {}) {
    const clauses = ['id>?', "signal='property_import_energy_counter'"], params = [integer(after,'after')];
    if (device !== undefined) { clauses.push('device=?'); params.push(label(device,'device')); }
    if (signal !== undefined) { clauses.push('signal=?'); params.push(label(signal,'signal')); }
    if (from !== undefined) { clauses.push('source_time>=?'); params.push(instant(from,'from')); }
    if (to !== undefined) { clauses.push('source_time<?'); params.push(instant(to,'to')); }
    params.push(limitValue(limit));
    return this.db.prepare(`SELECT * FROM energy_audits WHERE ${clauses.join(' AND ')}
      ORDER BY ${newestFirst ? 'source_time DESC,id DESC' : 'id'} LIMIT ?`).all(...params)
      .map(row => {
        const result = { id:row.id,source:row.source,device:row.device,signal:row.signal,sourceTime:row.source_time,
          receivedAt:row.received_at,value:row.value,quality:JSON.parse(row.quality),
          comparison:row.comparison === null ? null : JSON.parse(row.comparison) };
        if (!result.comparison) {
          const previous = this.db.prepare(`SELECT * FROM energy_audits WHERE source=? AND device=? AND signal=? AND id<?
            ORDER BY source_time DESC,id DESC LIMIT 1`).get(row.source,row.device,row.signal,row.id);
          if (previous) {
            if (row.source_time <= previous.source_time) result.quality.push('out-of-order-counter');
            else if (row.value < previous.value) result.quality.push('counter-reset');
            else {
              result.comparison = this.compareEnergyAudit(row,previous);
              if (!result.comparison) result.quality.push('incomplete-estimated-coverage');
            }
          }
        }
        result.quality = [...new Set(result.quality)];
        return result;
      });
  }

  compareEnergyAudit(row,previous) {
    if (row.signal !== 'property_import_energy_counter') return null;
    const start = previous.source_time, end = row.source_time;
    const totals = []; let edgeEstimated = false;
    for (let phase=1;phase<=3;phase++) {
      const values = this.db.prepare(`SELECT value,raw,quality FROM observations WHERE device=? AND signal=?
        AND source_time>? ORDER BY source_time,id`).iterate(row.device,`property_energy_l${phase}`,start);
      let cursor = start, total = 0;
      for (const value of values) {
        const raw = value.raw ? JSON.parse(value.raw) : null, quality = JSON.parse(value.quality);
        if (!raw || !Number.isSafeInteger(raw.intervalStart) || !Number.isSafeInteger(raw.intervalEnd)
          || raw.intervalStart > cursor || raw.intervalStart < cursor && cursor !== start || raw.intervalEnd <= cursor
          || !Number.isFinite(value.value) || value.value < 0
          || quality.some(q => /missing|stale|unavailable|gap|failed/.test(q))) return null;
        const until = Math.min(raw.intervalEnd,end);
        edgeEstimated ||= cursor !== raw.intervalStart || until !== raw.intervalEnd;
        total += value.value*(until-cursor)/(raw.intervalEnd-raw.intervalStart); cursor = until;
        if (cursor === end) break;
      }
      if (cursor !== end) return null;
      totals.push(total);
    }
    const estimatedKwh = totals.reduce((n,v)=>n+v,0), meteredKwh = row.value-previous.value;
    return {start,end,estimatedKwh,meteredKwh,differenceKwh:estimatedKwh-meteredKwh,
      differencePercent:meteredKwh>0 ? (estimatedKwh-meteredKwh)/meteredKwh*100 : null,
      edgeEstimated,basis:edgeEstimated ? 'diagnostic-only-complete-coverage-with-average-power-at-edges'
        : 'diagnostic-only-matching-complete-intervals'};
  }

  databaseBytes() {
    return this.db.prepare('PRAGMA page_count').get().page_count * this.db.prepare('PRAGMA page_size').get().page_size;
  }

  cycle(input, cycle) {
    if (!['active','completed','incomplete'].includes(cycle?.status)) throw new TypeError('Invalid cycle status');
    if (cycle.endedAt != null && instant(cycle.endedAt,'cycle end') < cycle.startedAt) throw new TypeError('Cycle end precedes its start');
    this.db.prepare(`INSERT INTO learning_cycles(id,input,started_at,ended_at,status,payload) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at,status=excluded.status,payload=excluded.payload`)
      .run(label(cycle.id, 'cycle id'), label(input, 'input'), instant(cycle.startedAt, 'cycle start'),
        cycle.endedAt ?? null, label(cycle.status, 'cycle status'), json(cycle));
  }

  cycles({ input, limit = 100, completedOnly = false } = {}) {
    return this.db.prepare(`SELECT payload FROM learning_cycles WHERE input=? ${completedOnly ? "AND status='completed'" : ''}
      ORDER BY started_at DESC LIMIT ?`).all(label(input, 'input'), limitValue(limit)).map(row => JSON.parse(row.payload));
  }

  /** Dashboard/control summaries avoid materializing complete observation tapes. */
  cycleSummaries({ input, limit = 100, completedOnly = false } = {}) {
    return this.db.prepare(`SELECT id,status,started_at AS startedAt,ended_at AS endedAt,
      json_extract(payload,'$.assessment.profitCents') AS profitCents,
      json_extract(payload,'$.actual.costCents') AS actualCostCents,
      json_extract(payload,'$.assessment.uncertaintyCents') AS uncertaintyCents,
      json_extract(payload,'$.assessment.recoveryErrorCents') AS recoveryErrorCents,
      json_extract(payload,'$.actual.missingHours') AS missingHours,
      json_extract(payload,'$.actual.auxiliarySpaceObserved') AS auxiliarySpaceObserved,
      json_extract(payload,'$.incompleteReason') AS incompleteReason
      FROM learning_cycles WHERE input=? ${completedOnly ? "AND status='completed'" : ''}
      ORDER BY started_at DESC LIMIT ?`).all(label(input, 'input'), limitValue(limit))
      .map(row => ({ ...row, auxiliarySpaceObserved: row.auxiliarySpaceObserved === 1 }));
  }

  snapshot({ kind, source, issuedAt = null, fetchedAt, payload }) {
    if (!['market', 'weather'].includes(kind)) throw new Error('Invalid provider snapshot kind');
    label(source, 'source'); instant(fetchedAt, 'fetchedAt');
    if (issuedAt !== null) instant(issuedAt, 'issuedAt');
    const metadata = [], encoded = json(snapshotContent(payload, metadata));
    if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new Error('Provider snapshot is too large');
    const contentDigest = createHash('sha256').update(encoded).digest('hex');
    // Include issuance and metadata in acquisition identity; equal content from
    // a new run must not inherit the old run's availability or issue time.
    const fetchMetadata = json(metadata);
    const digest = createHash('sha256').update(json([contentDigest,issuedAt,fetchMetadata])).digest('hex');
    return this.transaction(() => {
      this.db.prepare('INSERT INTO provider_snapshot_contents(digest,payload) VALUES(?,?) ON CONFLICT(digest) DO NOTHING').run(contentDigest,encoded);
      const contentId = this.db.prepare('SELECT id FROM provider_snapshot_contents WHERE digest=?').get(contentDigest).id;
      this.db.prepare(`INSERT INTO provider_snapshot_fetches (kind,source,issued_at,fetched_at,payload,digest,content_id,fetch_metadata)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(kind,source,fetched_at,digest) DO NOTHING`)
        .run(kind,source,issuedAt,fetchedAt,'',digest,contentId,fetchMetadata);
      return this.db.prepare('SELECT id FROM provider_snapshot_fetches WHERE kind=? AND source=? AND fetched_at=? AND digest=?').get(kind,source,fetchedAt,digest).id;
    });
  }

  snapshots({ kind, afterId = 0, limit = 100 } = {}) {
    if (kind !== undefined && !['market', 'weather'].includes(kind)) throw new Error('Invalid provider snapshot kind');
    const params = [integer(afterId, 'afterId')];
    if (kind !== undefined) params.push(kind);
    params.push(limitValue(limit));
    return this.db.prepare(`SELECT v.*,f.fetch_metadata FROM provider_snapshots v JOIN provider_snapshot_fetches f ON f.id=v.id
      WHERE v.id > ? ${kind === undefined ? '' : 'AND v.kind = ?'} ORDER BY v.id LIMIT ?`).all(...params)
      .map(row => ({ id: row.id, kind: row.kind, source: row.source, issuedAt: row.issued_at, fetchedAt: row.fetched_at,
        payload: restoreSnapshot(row.payload,row.fetch_metadata) }));
  }

  snapshotById(id) {
    const row = this.db.prepare(`SELECT v.*,f.fetch_metadata,f.content_id FROM provider_snapshots v
      JOIN provider_snapshot_fetches f ON f.id=v.id WHERE v.id=?`).get(integer(id,'snapshot id'));
    if (!row) return null;
    const first = row.content_id === null ? row.fetched_at : this.db.prepare(`SELECT MIN(fetched_at) AS at
      FROM provider_snapshot_fetches WHERE content_id=? AND kind=? AND source=?`).get(row.content_id,row.kind,row.source).at;
    return {id:row.id,kind:row.kind,source:row.source,issuedAt:row.issued_at,fetchedAt:row.fetched_at,
      contentId:row.content_id,contentFirstFetchedAt:first,digest:row.digest,payload:restoreSnapshot(row.payload,row.fetch_metadata)};
  }

  latestSnapshot(kind,at) {
    if (!['market','weather'].includes(kind)) throw new TypeError('Invalid snapshot kind');
    const row = this.db.prepare('SELECT id FROM provider_snapshot_fetches WHERE kind=? AND fetched_at<=? ORDER BY fetched_at DESC,id DESC LIMIT 1')
      .get(kind,instant(at,'snapshot as-of timestamp'));
    return row ? this.snapshotById(row.id) : null;
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
    return this.transaction(() => {
      const id = Number(this.insertObservation.run(source, device, signal, value, unit, sourceTime, receivedAt,
        json(flags), raw === null ? null : json(raw), provenance?.importId ?? null, provenance?.rowNumber ?? null).lastInsertRowid);
      return id;
    });
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
      const version = check.prepare('PRAGMA user_version').get().user_version;
      if (version < 1 || version > SCHEMA_VERSION) throw new Error('Unsupported backup schema');
      check.prepare('SELECT key, value FROM state LIMIT 1').all();
      mkdirSync(dirname(path), { recursive: true });
      closeSync(openSync(path, 'wx', 0o600));
      await sqliteBackup(check, path);
    } finally { check.close(); }
    return path;
  }
}
