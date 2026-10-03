import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { mkdirSync, existsSync, openSync, closeSync, linkSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { CURRENT_SCHEMA, SCHEMA_VERSION } from './schema.js';
import { recordedEnergyGroups } from './energy-history.js';
import { assertCurrentChargingSessionCheck } from '../app/charging-session-checks.js';
export { SCHEMA_VERSION } from './schema.js';
const MAX_LIMIT = 5000;

// Validate the complete structural contract before any writable pragma or DDL.
// The reference is made from the same single bootstrap definition, not migrations.
const schemaObjects = db => db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name")
  .all().map(({type,name,sql}) => [type,name,sql.replace(/\s+/g,' ').trim()]);
const reference = new DatabaseSync(':memory:');
reference.exec(CURRENT_SCHEMA);
const expectedStructure = JSON.stringify(schemaObjects(reference));
reference.close();
export function validateCurrentDatabase(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version !== SCHEMA_VERSION) throw Object.assign(new Error(`Unsupported database schema ${version}; this application requires schema ${SCHEMA_VERSION}. Use a new empty database; optionally import supported v0.7.5 CSV files. The existing database was not changed.`),
    { code: 'database_schema_mismatch', actualSchema: version, requiredSchema: SCHEMA_VERSION });
  if (JSON.stringify(schemaObjects(db)) !== expectedStructure) throw Object.assign(new Error('Malformed current database schema; use an intact same-version backup or a new empty database. The existing database was not changed.'),
    { code: 'database_schema_invalid', actualSchema: version, requiredSchema: SCHEMA_VERSION });
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Database contains dangling references; restore an intact same-version backup.');
  // Removed charging-check formats are rejected before any writable setup;
  // opening a database never strips or translates its historical evidence.
  for (const row of db.prepare("SELECT payload FROM events WHERE type='charging-session-check'").iterate())
    assertCurrentChargingSessionCheck(JSON.parse(row.payload));
  for (const row of db.prepare("SELECT value FROM state WHERE key GLOB 'charging:shelly:*'").iterate()) {
    const state = JSON.parse(row.value);
    if (!state || state.version !== 2)
      throw new Error('Unsupported Shelly acquisition state; start a fresh development database or restore a compatible backup. The existing database was not changed.');
    if (Object.hasOwn(state, 'checkSession') || Object.hasOwn(state, 'sessionCheck')
      || state.counter && Object.hasOwn(state.counter, 'powerW')
      || Object.keys(state.fields ?? {}).some(role => !['current_limit', 'start_charging', 'work_state', 'phase_info'].includes(role)))
      throw new Error('Unsupported Shelly session-check state; start a fresh development database or restore a compatible backup. The existing database was not changed.');
  }
}

// Fetch timestamps describe acquisition, not forecast content. Keep them in a
// small path map so mixed-source forecasts retain each source's original age.
function snapshotContent(value, metadata, path = []) {
  if (Array.isArray(value)) return value.map((v, i) => snapshotContent(v, metadata, [...path, i]));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (key === 'fetchedAt' || key === 'requestStartedAt' || key === 'snapshotId' || key === 'acquisition') metadata.push([[...path, key], value[key]]);
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
      const empty = version === 0 && this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").get().n === 0;
      if (!readOnly && empty) this.transaction(() => {
        this.db.exec(CURRENT_SCHEMA);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
      else validateCurrentDatabase(this.db);
      if (readOnly) { this.db.exec('PRAGMA query_only = ON;'); return; }
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
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
      } catch (error) {
        try { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); } catch (cleanupError) { if (error && typeof error === 'object') error.cleanupError = cleanupError; }
        throw error;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth = 1; this.savepointSequence ??= 0;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw new TypeError('SQLite transaction callback must be synchronous');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (cleanupError) { if (error && typeof error === 'object') error.cleanupError = cleanupError; }
      throw error;
    }
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

  energyAudits({ device, signal, from, to, after = 0, limit = 100, newestFirst = false, now = Date.now() } = {}) {
    instant(now, 'audit receipt cutoff');
    const clauses = ['id>?', "signal='property_import_energy_counter'", 'source_time<=?', 'received_at<=?'],
      params = [integer(after,'after'),now,now];
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
          const previous = this.previousEnergyAudit(row, now);
          const check = this.checkEnergyAudit(row, previous, now);
          result.comparison = check.comparison;
          if (check.status === 'out-of-order-counter' || check.status === 'counter-reset') result.quality.push(check.status);
          else if (check.status === 'incomplete-coverage' || check.status === 'conflicting-coverage')
            result.quality.push('incomplete-estimated-coverage');
        }
        result.quality = [...new Set(result.quality)];
        return result;
      });
  }

  previousEnergyAudit(row, now = Date.now()) {
    // Receipt order makes a delayed older meter timestamp observable. Use the
    // highest prior meter timestamp so it cannot become a new counter baseline.
    return this.db.prepare(`SELECT * FROM energy_audits WHERE source=? AND device=? AND signal=?
      AND (received_at<? OR received_at=? AND id<?) AND source_time<=? AND received_at<=?
      ORDER BY source_time DESC,received_at,id LIMIT 1`)
      .get(row.source,row.device,row.signal,row.received_at,row.received_at,row.id,now,now) ?? null;
  }

  checkEnergyAudit(row, previous, now = Date.now(), groups) {
    instant(now, 'audit receipt cutoff');
    if (row.signal !== 'property_import_energy_counter') throw new TypeError('Invalid property counter signal');
    if (!previous) return { status:'waiting-for-second-reading', coverage:null, comparison:null };
    if (row.source_time <= previous.source_time) return { status:'out-of-order-counter', coverage:null, comparison:null };
    if (row.value < previous.value) return { status:'counter-reset', coverage:null, comparison:null };
    const start = previous.source_time, end = row.source_time;
    const coverage = { start, end, coveredMs:0, durationMs:end-start, conflictingMs:0 };
    let estimatedKwh = 0, edgeEstimated = false, includesOpenInterval = false;
    for (const group of groups ?? recordedEnergyGroups(this,{from:start,to:end,now,input:'providers',prefix:'property',source:row.source,device:row.device})) {
      if (group.source !== row.source || group.device !== row.device) continue;
      const from = Math.max(group.start,start), until = Math.min(group.end,end);
      if (until <= from) continue;
      // The shared history reader merges overlapping cohorts into unusable
      // conflict spans. Count usable duration across the whole period, including
      // valid intervals after a gap, without filling any of the missing energy.
      if (group.conflict) { coverage.conflictingMs += until-from; continue; }
      if (group.values.length !== 3 || !group.values.every(Number.isFinite)) continue;
      coverage.coveredMs += until-from;
      edgeEstimated ||= from !== group.start || until !== group.end;
      includesOpenInterval ||= group.pending;
      estimatedKwh += group.values.reduce((sum,value)=>sum+value,0)*(until-from)/(group.end-group.start);
    }
    if (coverage.conflictingMs) return { status:'conflicting-coverage', coverage, comparison:null };
    if (coverage.coveredMs !== coverage.durationMs) return { status:'incomplete-coverage', coverage, comparison:null };
    const meteredKwh = row.value-previous.value;
    return { status:'compared', coverage, comparison:{start,end,estimatedKwh,meteredKwh,differenceKwh:estimatedKwh-meteredKwh,
      differencePercent:meteredKwh>0 ? (estimatedKwh-meteredKwh)/meteredKwh*100 : null,
      edgeEstimated,includesOpenInterval,basis:edgeEstimated ? 'diagnostic-only-complete-coverage-with-average-power-at-edges'
        : 'diagnostic-only-matching-complete-intervals'} };
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
      this.db.prepare(`INSERT INTO provider_snapshot_fetches (kind,source,issued_at,fetched_at,digest,content_id,fetch_metadata)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(kind,source,fetched_at,digest) DO NOTHING`)
        .run(kind,source,issuedAt,fetchedAt,digest,contentId,fetchMetadata);
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
    const first = this.db.prepare(`SELECT MIN(fetched_at) AS at
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
    return this.db.prepare(`SELECT o.id, o.source_time, o.value, o.quality, r.canonical,
      EXISTS(SELECT 1 FROM annotations a WHERE a.exclude_training = 1 AND a.start_at <= o.source_time
        AND (a.end_at IS NULL OR a.end_at > o.source_time)) AS annotated
      FROM observations o JOIN imports i ON i.id = o.import_id
      JOIN import_rows r ON r.import_id = o.import_id AND r.row_number = o.row_number
      WHERE o.id > ? AND o.signal = 'indoor_temperature' AND i.kind = 'stmq' AND i.status = 'complete'
      ORDER BY o.id LIMIT ?`).all(integer(afterId, 'afterId'), limitValue(limit)).map(row => {
      const canonical = JSON.parse(row.canonical);
      const heatInput = canonical.find(o => o.signal === 'requested_heat_mode');
      const outdoorInput = canonical.find(o => o.signal === 'outdoor_temperature');
      if (!heatInput || !outdoorInput) throw new Error('Malformed canonical CSV input');
      const heat = heatInput.value, outdoorC = outdoorInput.value;
      const quality = [...JSON.parse(row.quality), ...heatInput.quality, ...outdoorInput.quality];
      if (![0, 15, 60].includes(heat)) quality.push('unknown_legacy_command');
      if (outdoorC === null) quality.push('missing_outdoor');
      const absent = row.annotated || quality.includes('absence_heating_off_approximate');
      if (row.annotated) quality.push('excluded_occupied_training');
      return { id: row.id, at: row.source_time, indoorC: row.value, outdoorC,
        action: heat === 0 ? 'reduction' : [15, 60].includes(heat) ? 'normal' : null, quality: [...new Set(quality)],
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
    const occupied = () => path === this.path || existsSync(path) || existsSync(`${path}-wal`) || existsSync(`${path}-shm`);
    if (occupied()) throw new Error('Backup destination must be a new file without WAL/SHM companions');
    mkdirSync(dirname(path), { recursive: true });
    const staging = `${path}.backup-${randomUUID()}`;
    try {
      closeSync(openSync(staging, 'wx', 0o600));
      await sqliteBackup(this.db, staging);
      if (occupied()) throw new Error('Backup destination must be a new file without WAL/SHM companions');
      // Publish only a completed copy, without replacing a concurrently created
      // destination. Failed backups leave no misleading partial final file.
      linkSync(staging, path);
    } finally { rmSync(staging, { force: true }); }
    return path;
  }

  /** Restore to a new database while the application is stopped; never overwrite a live WAL. */
  static async restore(source, destination) {
    const path = resolve(destination);
    if (existsSync(path) || existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) throw new Error('Restore destination must be a new database path');
    const check = new DatabaseSync(resolve(source), { readOnly: true });
    try {
      if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Backup database failed integrity check');
      validateCurrentDatabase(check);
      mkdirSync(dirname(path), { recursive: true });
      const staging = `${path}.restore-${randomUUID()}`;
      try {
        closeSync(openSync(staging, 'wx', 0o600));
        await sqliteBackup(check, staging);
        const copied = new DatabaseSync(staging, { readOnly: true });
        try { validateCurrentDatabase(copied); }
        finally { copied.close(); }
        // Atomic no-overwrite publication. A failed copy never becomes the destination.
        linkSync(staging, path);
      } finally { rmSync(staging, { force: true }); }
    } finally { check.close(); }
    return path;
  }
}
