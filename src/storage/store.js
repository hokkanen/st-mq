import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';

import { CURRENT_SCHEMA, SCHEMA_VERSION } from './schema.js';
import { previousEnergyAudit, checkEnergyAudit } from './energy-audit.js';
import { assertCurrentChargingSessionCheck } from '../app/charging-session-checks.js';
import { validateSavedChargingState } from '../charging/saved-state.js';
import { createDatabaseBackup } from './backup.js';
import { cycleAssessmentExcluded } from './cycle-assessment.js';
import { LEARNING_ALGORITHM } from '../domain/learning-contract.js';
import { validateExecutorState, validateH66ControlState } from '../domain/heating-control-state.js';
import { validateEquipmentTestState } from '../domain/equipment-test-state.js';
import { createWriteHealth } from './write-health.js';
import { WriteQueue, sqliteContention } from './write-queue.js';
import { readAdaptiveBudget } from './adaptive-recording-budget.js';
import { readStorageMetrics } from './recording-metrics.js';
import { registerJournalFunctions } from './journal-codec.js';
import { initializeJournal, installJournal, validateCheckpoint, readCheckpoint, checkpointAt,
  commonCheckpoint, exportChanges, changedRecordKeys, journalBase, compactJournal } from './journal.js';
export { SCHEMA_VERSION } from './schema.js';
const MAX_LIMIT = 5000;

/** Seek direct entries and compact prefix boundaries instead of aggregating a
 * union of every historical learning row after a correction. */
export function learningJournalHead(db, input, epoch) {
  epoch ??= db.prepare('SELECT epoch FROM learning_epochs WHERE input=?').get(input)?.epoch ?? 'original';
  const row=db.prepare(`SELECT MAX(
    COALESCE((SELECT MAX(id) FROM learning_journal_entries WHERE epoch=? AND input=?),0),
    COALESCE((SELECT MAX(through_id) FROM learning_epoch_segments WHERE epoch=? AND input=?),0)) id`)
    .get(epoch,input,epoch,input);
  return row.id;
}

/** Each immutable prefix range supplies at most one page. A UNION query with
 * an outer LIMIT can sort every inherited row before yielding its first entry. */
export function learningJournalRows(db, { input, epoch, after = 0, limit = 256 }) {
  label(input, 'input'); integer(after, 'after'); limit=limitValue(limit);
  if (!limit) return [];
  epoch ??= db.prepare('SELECT epoch FROM learning_epochs WHERE input=?').get(input)?.epoch ?? 'original';
  const ranges=db.prepare(`SELECT source_epoch,after_id,through_id FROM learning_epoch_segments
    WHERE epoch=? AND input=? AND through_id>?`).all(epoch,input,after);
  ranges.push({source_epoch:epoch,after_id:after,through_id:Number.MAX_SAFE_INTEGER});
  const page=db.prepare(`SELECT e.id,e.input,e.key,e.kind,e.at,e.algorithm_version,
    COALESCE(e.config_version,s.config_version) AS config_version,
    COALESCE(e.forecast_version,s.forecast_version) AS forecast_version,
    COALESCE(e.payload,s.payload) AS payload,e.source_entry_id
    FROM learning_journal_entries e LEFT JOIN learning_journal_entries s ON s.id=e.source_entry_id
    WHERE e.epoch=? AND e.input=? AND e.id>? AND e.id<=? ORDER BY e.id LIMIT ?`);
  return ranges.flatMap(range=>page.all(range.source_epoch,input,Math.max(after,range.after_id),range.through_id,limit))
    .sort((a,b)=>a.id-b.id).slice(0,limit);
}

// Validate the complete structural contract before any writable pragma or DDL.
// The reference is made from the same single bootstrap definition, not migrations.
const schemaObjects = db => db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name")
  .all().map(({type,name,sql}) => [type,name,sql.replace(/\s+/g,' ').trim()]);
const reference = new DatabaseSync(':memory:');
reference.exec(CURRENT_SCHEMA);
const expectedStructure = JSON.stringify(schemaObjects(reference));
reference.close();
/** Format/integrity gate for runtime and explicit read-only diagnostics. This
 * does not grant runtime readiness; Store additionally validates saved state. */
export function validateCurrentDatabaseFormat(db, { full = false } = {}) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version !== SCHEMA_VERSION) throw Object.assign(new Error(`Unsupported database schema ${version}; this application requires schema ${SCHEMA_VERSION}. Use a new empty database; optionally import supported v0.7.5 CSV files. The existing database was not changed.`),
    { code: 'database_schema_mismatch', actualSchema: version, requiredSchema: SCHEMA_VERSION });
  if (JSON.stringify(schemaObjects(db)) !== expectedStructure) throw Object.assign(new Error('Malformed current database schema; use an intact same-version backup or a new empty database. The existing database was not changed.'),
    { code: 'database_schema_invalid', actualSchema: version, requiredSchema: SCHEMA_VERSION });
  validateCheckpoint(db);
  // Two indexed range seeks reject every unsupported algorithm before writable
  // setup, including inactive epochs, without scanning a growing valid journal.
  if (db.prepare(`SELECT 1 FROM learning_journal_entries WHERE algorithm_version<?
    UNION ALL SELECT 1 FROM learning_journal_entries WHERE algorithm_version>? LIMIT 1`)
    .get(LEARNING_ALGORITHM, LEARNING_ALGORITHM))
    throw Object.assign(new Error('Unsupported Home learning journal algorithm; use a new empty database or an intact current-version backup. The existing database was not changed.'),
      { code: 'database_algorithm_mismatch' });
  if (full && db.prepare('PRAGMA foreign_key_check').get()) throw Object.assign(new Error('Database contains dangling references; restore an intact same-version backup.'),
    { code: 'database_integrity_failed' });
}

export function validateCurrentDatabase(db, { full = false } = {}) {
  validateCurrentDatabaseFormat(db, { full });
  // Reject an unsupported recorder before writable setup or paired source-state
  // initialization. A genuinely absent prospective budget needs no backfill.
  readAdaptiveBudget(db);
  readStorageMetrics(db);
  // Control-state rejection must precede writable setup and Engine construction,
  // whose unrelated initialization may otherwise mutate a rejected database.
  for (const row of db.prepare("SELECT key,value FROM state WHERE key IN ('executor:home','executor:simulated','equipment-tests:v1') OR key GLOB 'h66:control:*'").iterate()) {
    const equipmentTest = row.key === 'equipment-tests:v1';
    let saved;
    try { saved = JSON.parse(row.value); }
    catch {
      throw Object.assign(new Error(`Unreadable ${equipmentTest ? 'equipment test' : 'heating control'} state. Safely restore equipment, then use an intact current-version backup or a new empty database. The existing database was not changed.`),
        { code: equipmentTest ? 'EQUIPMENT_TEST_STATE_UNREADABLE' : 'HEATING_CONTROL_STATE_UNREADABLE' });
    }
    try { (equipmentTest ? validateEquipmentTestState : row.key.startsWith('h66:control:') ? validateH66ControlState : validateExecutorState)(saved); }
    catch (error) {
      throw Object.assign(new Error(`${error.message} The existing database was not changed.`), { code: error.code });
    }
  }
  // Removed charging-check formats are rejected before any writable setup;
  // opening a database never strips or translates its historical evidence.
  if (full) for (const row of db.prepare("SELECT payload FROM events WHERE type='charging-session-check'").iterate()) {
    try { assertCurrentChargingSessionCheck(JSON.parse(row.payload)); }
    catch { throw Object.assign(new Error('Unsupported or unreadable charging-check history. Preserve this database and use an intact current-version backup.'),
      { code: 'database_state_incompatible' }); }
  }
  validateSavedChargingState(db);
}

const emptyDatabase = db => db.prepare('PRAGMA user_version').get().user_version === 0
  && db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").get().n === 0;
const databaseFileIdentity = path => {
  const stat = statSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};

export function validateWalHeader(path) {
  let file;
  try { file=openSync(`${path}-wal`,'r'); }
  catch(error) { if(error.code==='ENOENT') return; throw error; }
  try {
    const header=Buffer.alloc(32),bytes=readSync(file,header,0,32,0);
    if(bytes===0) return;
    const magic=bytes>=4 ? header.readUInt32BE(0) : 0;
    const pageSize=bytes>=12 ? header.readUInt32BE(8) : 0;
    // SQLite can ignore a checksum-invalid header and expose an older main-file
    // checkpoint. Check the bounded header before SQLite opens any companion.
    // https://www.sqlite.org/fileformat2.html#checksum_algorithm
    let checksum1=0,checksum2=0;
    if(bytes===32 && [0x377f0682,0x377f0683].includes(magic)) {
      const word=offset=>magic===0x377f0682 ? header.readUInt32LE(offset) : header.readUInt32BE(offset);
      for(let offset=0;offset<24;offset+=8) {
        checksum1=(checksum1+word(offset)+checksum2)>>>0;
        checksum2=(checksum2+word(offset+4)+checksum1)>>>0;
      }
    }
    if(bytes!==32 || ![0x377f0682,0x377f0683].includes(magic) || header.readUInt32BE(4)!==3007000
      || pageSize<512 || pageSize>65536 || (pageSize & (pageSize-1))!==0
      || checksum1!==header.readUInt32BE(24) || checksum2!==header.readUInt32BE(28))
      throw Object.assign(new Error('The SQLite write-ahead journal header is invalid. Preserve the database and its companions for verification.'),
        {code:'database_integrity_failed'});
  } finally { closeSync(file); }
}

function preflightExistingDatabase(path) {
  try { statSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const source = new DatabaseSync(path, { readOnly: true });
  const identity = databaseFileIdentity(path);
  try {
    source.exec('PRAGMA busy_timeout=5000; BEGIN');
    if (!emptyDatabase(source)) validateCurrentDatabase(source);
  } finally { source.close(); }
  // Workers also open the active master while recording advances. Content and
  // WAL timestamps may legitimately change; the locked validation below checks
  // the latest committed state. Only replacing the file breaks this identity.
  if (identity !== databaseFileIdentity(path))
    throw Object.assign(new Error('The database changed during startup validation. Stop other writers and retry.'),
      { code: 'database_changed_during_startup' });
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
    this.writeQueue = new WriteQueue({ transaction: fn => this._transaction(fn, true),
      onFailure: error => this.writeHealth.failure(error) });
    this.writeHealth = createWriteHealth(Date.now, () => this.writeQueue.status());
    if (path !== ':memory:') validateWalHeader(this.path);
    if (!readOnly && path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    // Closing the last writable connection can checkpoint an existing WAL even
    // when validation only read data. Reject unsupported files through a genuine
    // read-only connection first, preserving both main bytes and WAL evidence.
    if (!readOnly && path !== ':memory:') preflightExistingDatabase(this.path);
    this.db = new DatabaseSync(this.path, { readOnly });
    try {
      this.changeCount = this.db.prepare('SELECT total_changes() AS n');
      // Startup has no active control callbacks. Runtime writer admission below
      // retries asynchronously; background connections may block their own worker.
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const empty = emptyDatabase(this.db);
      if (!readOnly && empty) this.transaction(() => {
        this.db.exec(CURRENT_SCHEMA);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        initializeJournal(this.db);
      });
      // Check again against this connection's locked boundary: a different
      // process must not replace validated state between preflight and opening.
      else if (!readOnly) {
        this.db.exec('BEGIN IMMEDIATE');
        try { validateCurrentDatabase(this.db); }
        finally { this.db.exec('ROLLBACK'); }
      } else {
        // A concurrent writer may advance between the checkpoint's individual
        // indexed reads. Validate one committed snapshot, then release it.
        this.db.exec('BEGIN');
        try { validateCurrentDatabase(this.db); }
        finally { this.db.exec('ROLLBACK'); }
      }
      if (readOnly) { registerJournalFunctions(this.db); this.db.exec(`PRAGMA query_only = ON; PRAGMA busy_timeout = ${isMainThread ? 0 : 5000};`); return; }
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      installJournal(this.db);
      this.insertObservation = this.db.prepare(`INSERT INTO observations
        (source, device, signal, value, unit, source_time, received_at, quality, raw, import_id, row_number)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      this.insertEvent = this.db.prepare('INSERT INTO events (type, payload, at) VALUES (?, ?, ?)');
      if (isMainThread) this.db.exec('PRAGMA busy_timeout = 0;');
    } catch (error) { this.db.close(); throw error; }
  }

  close() { this.writeQueue.close(); this.db.close(); }

  checkpoint() { return readCheckpoint(this.db); }
  journalBase() { return journalBase(this.db); }
  compactJournal(options) { return compactJournal(this.db,options); }
  checkpointAt(sequence) { return checkpointAt(this.db, sequence); }
  commonCheckpoint(other) { return commonCheckpoint(this.db, other.db ?? other); }
  exportChanges(options) { return exportChanges(this.db, options); }
  changedRecordKeys(options) { return changedRecordKeys(this.db, options); }

  runWrite(fn, options = {}) {
    if (this.readOnly) return Promise.reject(Object.assign(new Error('This recording storage is read-only.'),
      { code: 'ERR_SQLITE_ERROR', errcode: 8 }));
    // Descendants depend on the parent commit regardless of how that parent
    // acquired its transaction. Enqueuing during a running job must not let a
    // child escape the parent's rollback or a discarded nested savepoint.
    if (this.transactionDepth) return new Promise((resolve, reject) => {
      this.afterCommit(() => { this.writeQueue.run(fn, options).then(resolve, reject); });
      this.afterRollback(() => reject(Object.assign(new Error('The preceding save was rolled back.'), { code: 'STORAGE_WRITE_ROLLED_BACK' })));
    });
    return this.writeQueue.run(fn, options);
  }

  writeQueueStatus() { return this.writeQueue.status(); }

  afterCommit(effect) {
    if (typeof effect !== 'function') throw new TypeError('A commit effect must be a function');
    if (this.transactionDepth) this.commitEffects.push(effect);
    else return effect();
  }

  afterRollback(effect) {
    if (typeof effect !== 'function') throw new TypeError('A rollback effect must be a function');
    if (this.transactionDepth) this.rollbackEffects.push(effect);
  }

  databaseChanges() {
    try { return this.changeCount.get().n; } catch { return null; }
  }

  transaction(fn) {
    return this._transaction(fn);
  }

  _transaction(fn, admission = false) {
    // Acquisition and recorder methods deliberately compose atomic operations.
    // SAVEPOINT keeps an inner failure from leaving half an interval behind.
    if (this.transactionDepth) {
      const savepoint = `nested_${++this.savepointSequence}`;
      const before = this.databaseChanges(), discardedBefore = this.discardedChanges;
      const committedBefore = this.commitEffects.length, rollbackBefore = this.rollbackEffects.length;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = fn();
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(() => {});
          throw new TypeError('SQLite transaction callback must be synchronous');
        }
        this.db.exec(`RELEASE ${savepoint}`); return result;
      } catch (error) {
        try { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); } catch (cleanupError) { if (error && typeof error === 'object') error.cleanupError = cleanupError; }
        this.commitEffects.length = committedBefore;
        for (const effect of this.rollbackEffects.splice(rollbackBefore).reverse()) {
          try { effect(); } catch (cleanupError) { if (error && typeof error === 'object') error.cleanupError ??= cleanupError; }
        }
        const after = this.databaseChanges();
        // total_changes also includes rolled-back savepoint writes. They cannot
        // prove that recording resumed when the caller catches the inner error.
        if (before === null || after === null) this.writeEvidenceUnknown = true;
        else this.discardedChanges = discardedBefore + after - before;
        throw error;
      }
    }
    // Diagnostic counters cannot introduce a new failure after a commit or
    // leave an opened transaction behind if the database becomes unreadable.
    const changesBefore = this.databaseChanges();
    const timing = { beginMs: 0, bodyMs: 0, commitMs: 0, totalMs: 0, committed: false };
    const transactionStarted = performance.now();
    const recordTiming = () => {
      timing.totalMs = performance.now() - transactionStarted;
      // Diagnostics cannot change a transaction's outcome or durable authority.
      try { this.writeHealth.transaction(timing); } catch {}
    };
    try { this.db.exec('BEGIN IMMEDIATE'); }
    catch (error) {
      timing.beginMs = performance.now() - transactionStarted; recordTiming();
      if (!admission || !sqliteContention(error)) this.writeHealth.failure(error);
      throw error;
    }
    timing.beginMs = performance.now() - transactionStarted;
    this.transactionDepth = 1; this.savepointSequence ??= 0;
    this.commitEffects = []; this.rollbackEffects = [];
    this.discardedChanges = 0; this.writeEvidenceUnknown = changesBefore === null;
    let result, committed = false;
    const bodyStarted = performance.now();
    try {
      result = fn();
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new TypeError('SQLite transaction callback must be synchronous');
      }
      const changesAfter = this.databaseChanges();
      const changed = !this.writeEvidenceUnknown && changesAfter !== null && changesAfter - changesBefore > this.discardedChanges;
      timing.bodyMs = performance.now() - bodyStarted;
      const commitStarted = performance.now();
      try { this.db.exec('COMMIT'); }
      finally { timing.commitMs = performance.now() - commitStarted; }
      committed = true; timing.committed = true;
      if (changed) this.writeHealth.success();
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (cleanupError) { if (error && typeof error === 'object') error.cleanupError = cleanupError; }
      for (const effect of this.rollbackEffects.splice(0).reverse()) {
        try { effect(); } catch (cleanupError) { if (error && typeof error === 'object') error.cleanupError ??= cleanupError; }
      }
      this.writeHealth.failure(error);
      throw error;
    }
    finally {
      if (!timing.bodyMs && !timing.commitMs) timing.bodyMs = performance.now() - bodyStarted;
      recordTiming();
      this.transactionDepth = 0; if (!committed) this.commitEffects = []; this.rollbackEffects = [];
    }
    const effects = this.commitEffects; this.commitEffects = [];
    const failures = [];
    for (const effect of effects) {
      try { effect(); } catch (error) { failures.push(error); }
    }
    // Persistence succeeded. Never roll back, retry the body or strand a later
    // callback merely because a consumer failed after that durable boundary.
    if (failures.length) throw Object.assign(new AggregateError(failures, 'A saved operation could not finish its follow-up.'),
      { code: 'STORAGE_COMMIT_EFFECT_FAILED', committed: true });
    return result;
  }

  getState(key) {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(label(key, 'key'));
    return row ? JSON.parse(row.value) : null;
  }

  setState(key, value) {
    return this.write(() => this.db.prepare(`INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE state.value <> excluded.value`)
      .run(label(key, 'key'), json(value), Date.now()));
  }

  write(operation) {
    try {
      const result = operation();
      // A nested successful statement is not evidence of an outer commit.
      if (!this.transactionDepth && (typeof result !== 'object' || result?.changes > 0)) this.writeHealth.success();
      return result;
    } catch (error) {
      if (!this.transactionDepth) this.writeHealth.failure(error);
      throw error;
    }
  }

  appendLearningJournal(input, { kind, at, algorithmVersion, configVersion = null, forecastVersion = null, payload, key }) {
    if (!['sample', 'episode', 'context'].includes(kind)) throw new TypeError('Invalid learning journal kind');
    label(input, 'input'); instant(at, 'journal timestamp');
    if (algorithmVersion !== LEARNING_ALGORITHM) throw new TypeError('Unsupported Home learning journal algorithm; start fresh.');
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

  learningJournalHead(input, epoch = this.learningEpoch(input)) { return learningJournalHead(this.db,input,epoch); }

  learningJournal({ input, after = 0, limit = 256, algorithmVersion } = {}) {
    if (algorithmVersion !== undefined && algorithmVersion !== LEARNING_ALGORITHM)
      throw new TypeError('Unsupported Home learning journal algorithm; start fresh.');
    // Do not filter unsupported rows out of replay. Writer admission and each
    // bounded read reject unsupported rows; full historical audits are optional.
    const rows = learningJournalRows(this.db,{input,after,limit});
    if (rows.some(row => row.algorithm_version !== LEARNING_ALGORITHM))
      throw new TypeError('Unsupported Home learning journal algorithm; start fresh.');
    return rows.map(row => ({ id: row.id, key: row.key,
      kind: row.kind, at: row.at, algorithmVersion: row.algorithm_version,
      configVersion: row.config_version === null ? null : JSON.parse(row.config_version),
      forecastVersion: row.forecast_version === null ? null : JSON.parse(row.forecast_version), payload: JSON.parse(row.payload) }));
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
    return this.db.prepare(`SELECT * FROM active_energy_audits AS energy_audits WHERE ${clauses.join(' AND ')}
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
    return previousEnergyAudit(this, row, now);
  }

  checkEnergyAudit(row, previous, now = Date.now(), groups) {
    return checkEnergyAudit(this, row, previous, now, groups);
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
    return this.db.prepare(`SELECT payload FROM active_learning_cycles AS learning_cycles WHERE input=? ${completedOnly ? "AND status='completed'" : ''}
      ORDER BY started_at DESC LIMIT ?`).all(label(input, 'input'), limitValue(limit)).map(row => JSON.parse(row.payload));
  }

  /** Dashboard/control summaries avoid materializing complete observation tapes. */
  cycleSummaries({ input, limit = 100, completedOnly = false } = {}) {
    return this.db.prepare(`SELECT id,status,started_at AS startedAt,ended_at AS endedAt,
      CASE WHEN NOT ${cycleAssessmentExcluded('learning_cycles.id')}
        THEN json_extract(payload,'$.assessment.profitCents') END AS profitCents,
      json_extract(payload,'$.actual.costCents') AS actualCostCents,
      CASE WHEN NOT ${cycleAssessmentExcluded('learning_cycles.id')}
        THEN json_extract(payload,'$.assessment.uncertaintyCents') END AS uncertaintyCents,
      CASE WHEN NOT ${cycleAssessmentExcluded('learning_cycles.id')}
        THEN json_extract(payload,'$.assessment.recoveryErrorCents') END AS recoveryErrorCents,
      json_extract(payload,'$.actual.missingHours') AS missingHours,
      json_extract(payload,'$.actual.auxiliarySpaceObserved') AS auxiliarySpaceObserved,
      json_extract(payload,'$.incompleteReason') AS incompleteReason
      FROM active_learning_cycles AS learning_cycles WHERE input=? ${completedOnly ? "AND status='completed'" : ''}
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
    return this.db.prepare(`SELECT v.*,f.fetch_metadata FROM active_provider_snapshots v JOIN active_provider_snapshot_fetches f ON f.id=v.id
      WHERE v.id > ? ${kind === undefined ? '' : 'AND v.kind = ?'} ORDER BY v.id LIMIT ?`).all(...params)
      .map(row => ({ id: row.id, kind: row.kind, source: row.source, issuedAt: row.issued_at, fetchedAt: row.fetched_at,
        payload: restoreSnapshot(row.payload,row.fetch_metadata) }));
  }

  snapshotById(id) {
    const row = this.db.prepare(`SELECT v.*,f.fetch_metadata,f.content_id FROM active_provider_snapshots v
      JOIN active_provider_snapshot_fetches f ON f.id=v.id WHERE v.id=?`).get(integer(id,'snapshot id'));
    if (!row) return null;
    const first = this.db.prepare(`SELECT MIN(fetched_at) AS at
      FROM active_provider_snapshot_fetches AS provider_snapshot_fetches WHERE content_id=? AND kind=? AND source=?`).get(row.content_id,row.kind,row.source).at;
    return {id:row.id,kind:row.kind,source:row.source,issuedAt:row.issued_at,fetchedAt:row.fetched_at,
      contentId:row.content_id,contentFirstFetchedAt:first,digest:row.digest,payload:restoreSnapshot(row.payload,row.fetch_metadata)};
  }

  latestSnapshot(kind,at) {
    if (!['market','weather'].includes(kind)) throw new TypeError('Invalid snapshot kind');
    const row = this.db.prepare('SELECT id FROM active_provider_snapshot_fetches AS provider_snapshot_fetches WHERE kind=? AND fetched_at<=? ORDER BY fetched_at DESC,id DESC LIMIT 1')
      .get(kind,instant(at,'snapshot as-of timestamp'));
    return row ? this.snapshotById(row.id) : null;
  }

  event(type, payload, at = Date.now()) {
    return this.write(() => Number(this.insertEvent.run(label(type, 'event type'), json(payload), instant(at, 'at')).lastInsertRowid));
  }

  /** No cursor gives the newest page in chronological insertion order. A cursor follows it. */
  events({ after = 0, limit = 100 } = {}) {
    integer(after, 'after'); limit = limitValue(limit);
    const rows = after > 0
      ? this.db.prepare('SELECT * FROM active_events AS events WHERE id > ? ORDER BY id LIMIT ?').all(after, limit)
      : this.db.prepare('SELECT * FROM (SELECT * FROM active_events AS events ORDER BY id DESC LIMIT ?) ORDER BY id').all(limit);
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
    return this.db.prepare(`SELECT o.* FROM active_observations o LEFT JOIN active_imports i ON i.id = o.import_id
      WHERE ${clauses.join(' AND ')} ORDER BY o.id LIMIT ?`).all(...params).map(observationResult);
  }

  latestObservation(signal) {
    const row = this.db.prepare(`SELECT o.* FROM active_observations o LEFT JOIN active_imports i ON i.id = o.import_id
      WHERE o.signal = ? AND (o.import_id IS NULL OR i.status = 'complete') ORDER BY o.source_time DESC, o.id DESC LIMIT 1`)
      .get(label(signal, 'signal'));
    return row ? observationResult(row) : null;
  }

  /** Original historical episodes in ingestion order; callers reject non-increasing time. */
  trainingRows({ afterId = 0, limit = 256 } = {}) {
    return this.db.prepare(`SELECT o.id, o.source_time, o.value, o.quality, r.canonical,
      EXISTS(SELECT 1 FROM active_annotations a WHERE a.exclude_training = 1 AND a.start_at <= o.source_time
        AND (a.end_at IS NULL OR a.end_at > o.source_time)) AS annotated
      FROM active_observations o JOIN active_imports i ON i.id = o.import_id
      JOIN active_import_rows r ON r.import_id = o.import_id AND r.row_number = o.row_number
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
    const row = this.db.prepare('SELECT * FROM active_import_rows AS import_rows WHERE import_id = ? AND row_number = ?')
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
    return this.db.prepare(`SELECT * FROM active_annotations AS annotations WHERE ${clauses.join(' AND ')} ORDER BY start_at, id LIMIT ?`).all(...params)
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
    return this.db.prepare(`SELECT * FROM active_counters AS counters WHERE id > ?${clause} ORDER BY id LIMIT ?`).all(...params)
      .map(row => ({ id: row.id, device: row.device, signal: row.signal, value: row.value, unit: row.unit,
        observedDate: row.observed_date, sourceTime: row.source_time, note: row.note, provenance: row.provenance }));
  }

  summary() {
    return {
      schemaVersion: this.db.prepare('PRAGMA user_version').get().user_version,
      observations: this.db.prepare('SELECT COUNT(*) AS count, MIN(source_time) AS first, MAX(source_time) AS last FROM active_observations AS observations').get(),
      imports: this.db.prepare('SELECT * FROM active_imports AS imports ORDER BY id DESC LIMIT 100').all(),
      events: this.db.prepare('SELECT COUNT(*) AS count FROM active_events AS events').get().count,
      counters: this.db.prepare('SELECT COUNT(*) AS count FROM active_counters AS counters').get().count,
      annotations: this.annotations(),
      interpretation: 'Current snapshots are amperes, not metered energy. Historical heat values are requests, not compressor activity. Savings and causal auxiliary attribution are unproven.',
    };
  }

  async backup(destination, { signal, onProgress, exportedAt } = {}) {
    if (resolve(destination) === this.path) throw new Error('Backup destination must be a new file without SQLite companions');
    if (!this.db.isOpen) throw new Error('Recording storage is closed.');
    return createDatabaseBackup({ ...(this.path === ':memory:' ? { database: this.db } : { sourcePath: this.path }),
      destination, signal, onProgress, exportedAt });
  }

  /** Restore to a new database while the application is stopped; never overwrite a live WAL. */
  static async restore(source, destination) {
    // Restores need the same validated, self-contained snapshot and durable,
    // no-overwrite publication as backups; keep one implementation of both.
    try {
      return await createDatabaseBackup({ sourcePath: resolve(source), destination });
    } catch (error) {
      if (['database_destination_occupied', 'EEXIST'].includes(error.code))
        error.message = 'Restore destination must be a new database path without SQLite companions';
      else if (error.code === 'backup_source_incompatible')
        error.message = 'Unsupported database schema or structure in backup; use an intact current-version backup or a new empty database. The source was not changed.';
      else if (error.code === 'backup_source_invalid')
        error.message = 'Malformed backup database or saved state; use an intact current-version backup. The source was not changed.';
      throw error;
    }
  }
}
