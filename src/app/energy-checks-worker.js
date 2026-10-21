import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { readCheckpoint, checkpointAt, matchingCheckpoint } from '../storage/journal.js';
import { selectedHistoryPredicate } from '../storage/schema.js';
import { recordedTransport } from '../domain/recording-source.js';
import { energyCheckSummaries } from './energy-checks.js';
import { admittedReader, storageStep, releaseStorageLease, setStorageRequestActive } from '../storage/worker-admission.js';

const source = admittedReader(storageStep(() => new DatabaseSync(workerData.dbPath, { readOnly: true })), { batchRows: 128 });
source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE;');
const SIGNAL = 'property_import_energy_counter', PHASES = [1, 2, 3].map(phase => `property_energy_l${phase}`);
const BATCH = 128;
let evidence = null, previous = null;

// SQLite owns an unnamed, disk-backed temporary database and removes it when
// this worker closes. Only comparison inputs are copied; recorder payloads,
// credentials, unrelated signals and learning history never enter this cache.
function freshEvidence() {
  evidence?.close();
  evidence = new DatabaseSync('');
  evidence.exec(`PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
    CREATE TABLE observations(id INTEGER PRIMARY KEY,source TEXT,device TEXT,signal TEXT,value REAL,unit TEXT,
      source_time INTEGER,received_at INTEGER,quality TEXT,raw TEXT,import_id INTEGER);
    CREATE TABLE energy_audits(id INTEGER PRIMARY KEY,source TEXT,device TEXT,signal TEXT,source_time INTEGER,
      received_at INTEGER,value REAL,quality TEXT);
    CREATE TABLE events(id INTEGER PRIMARY KEY,type TEXT,payload TEXT,at INTEGER);
    CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE history_selection(id INTEGER PRIMARY KEY,generation TEXT);
    INSERT INTO history_selection VALUES(1,'original');
    CREATE TABLE recovery_exclusions(generation TEXT,table_name TEXT,record_key TEXT,PRIMARY KEY(generation,table_name,record_key));
    CREATE VIEW active_energy_audits AS SELECT * FROM energy_audits;
    CREATE VIEW active_events AS SELECT * FROM events;
    CREATE INDEX audit_receipts ON energy_audits(signal,received_at,id);
    CREATE INDEX audit_meter_receipts ON energy_audits(source,device,signal,received_at,id);
    CREATE INDEX audit_meter_times ON energy_audits(source,device,signal,source_time DESC,received_at,id);
    CREATE INDEX observations_signal_time ON observations(signal,source_time,id);
    CREATE INDEX observations_energy_geometry ON observations(
      json_extract(CASE WHEN json_valid(raw) THEN raw ELSE '{}' END,'$.intervalStart'),source_time,source,device,
      CASE WHEN signal LIKE 'ev1_%' THEN 'ev1' WHEN signal LIKE 'ev2_energy_l%' THEN 'ev2'
      WHEN signal='caravan_energy' THEN 'caravan' ELSE 'property' END,id)
      WHERE signal IN ('property_energy_l1','property_energy_l2','property_energy_l3','ev1_energy_l1','ev1_energy_l2','ev1_energy_l3',
      'ev2_energy_l1','ev2_energy_l2','ev2_energy_l3','caravan_energy') AND import_id IS NULL;
    CREATE INDEX event_times ON events(type,at,id);`);
}
function comparisonRaw(encoded) {
  let raw;
  try { raw = JSON.parse(encoded); } catch { return '{}'; }
  if (!raw || typeof raw !== 'object') return '{}';
  const fields = ['intervalStart', 'intervalEnd', 'timeBasis', 'basis', 'auditOnly', 'acquisitionOnly',
    'timeAdmission', 'transport', 'pending'];
  return JSON.stringify(Object.fromEntries(fields.filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]])));
}
function preview(now, range) {
  const row = evidence.prepare(`SELECT * FROM active_energy_audits WHERE signal=? AND source_time>=? AND source_time<=? AND received_at<=?
    ORDER BY received_at DESC,id DESC LIMIT 1`).get(SIGNAL, range?.from ?? 0, Math.min(now, range?.to ?? now), now);
  if (!row) return { kind: 'property-meter-summary', signal: SIGNAL, summary: { status: 'no-readings', readingCount: 0,
    latestReading: null, previousReading: null, coverage: null, comparison: null, lastSuccessfulComparison: null } };
  return { kind: 'property-meter-summary', signal: SIGNAL, summary: { status: 'comparison-pending', readingCount: null,
    latestReading: { valueKwh: row.value, sourceTime: row.source_time, receivedAt: row.received_at, transport: recordedTransport(row) },
    previousReading: null, coverage: null, comparison: null, lastSuccessfulComparison: null } };
}

function appendOnly(head) {
  if (!previous || previous.head.sequence === head.sequence) return Boolean(previous);
  // A retained common checkpoint proves ancestry, while this bounded pass
  // separately proves that cached evidence has not been changed or removed.
  // Recovery can change selection without changing its generation string.
  const changes = source.prepare(`SELECT sequence,ordinal,table_name,record_key,
    CASE WHEN table_name IN ('observations','energy_audits','events') THEN json_extract(payload,'$.beforeHash') END AS before_hash
    FROM journal_changes WHERE sequence>=? AND (sequence>? OR ordinal>?) AND sequence<=?
    ORDER BY sequence,ordinal LIMIT ?`);
  let sequence = previous.head.sequence, ordinal = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const rows = changes.all(sequence, sequence, ordinal, head.sequence, BATCH);
    if (!rows.length) return true;
    for (const row of rows) {
      if (['history_selection', 'recovery_exclusions'].includes(row.table_name)) return false;
      const key = { observations: 'observations', energy_audits: 'audits', events: 'events' }[row.table_name];
      if (key) {
        const [id] = JSON.parse(row.record_key);
        if (row.before_hash !== null || !Number.isSafeInteger(id) || id <= previous[key]) return false;
      }
    }
    sequence = rows.at(-1).sequence; ordinal = rows.at(-1).ordinal;
  }
}

parentPort.on('message', ({ id, now, checkpoint, range }) => {
  setStorageRequestActive(true);
  let processed = 0, progressAt = 0;
  const progress = (stage, force = false) => {
    const at = performance.now();
    if (force || at - progressAt > 50) { parentPort.postMessage({ id, progress: { stage, processed } }); progressAt = at; }
  };
  try {
    source.exec('BEGIN');
    const head = readCheckpoint(source);
    if (checkpoint && !matchingCheckpoint(head, checkpoint))
      throw Object.assign(new Error('History changed'), { code: 'ENERGY_CHECKPOINT_CHANGED' });
    progress('reading-meter-history', true);
    const selection = source.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation;
    const heads = source.prepare(`SELECT (SELECT MAX(id) FROM energy_audits) audits,
      (SELECT MAX(id) FROM observations) observations,(SELECT MAX(id) FROM events) events`).get();
    const continuous = previous && previous.selection === selection && previous.head.databaseId === head.databaseId
      && now >= previous.now && matchingCheckpoint(checkpointAt(source, previous.head.sequence), previous.head)
      && ['audits', 'observations', 'events'].every(key => (heads[key] ?? 0) >= previous[key]) && appendOnly(head);
    if (!continuous) { freshEvidence(); previous = null; }
    const cursors = { audits: previous?.audits ?? 0, observations: previous?.observations ?? 0, events: previous?.events ?? 0 };
    const audits = source.prepare(`SELECT id,source,device,signal,source_time,received_at,value,quality,
      ${selectedHistoryPredicate('energy_audits', 'r')} selected FROM energy_audits r WHERE id>? ORDER BY id LIMIT ?`);
    const insertAudit = evidence.prepare('INSERT INTO energy_audits VALUES(?,?,?,?,?,?,?,?)');
    while (cursors.audits < (heads.audits ?? 0)) {
      const rows = audits.all(cursors.audits, BATCH);
      if (!rows.length) break;
      evidence.exec('BEGIN');
      try { for (const row of rows) if (row.selected && row.signal === SIGNAL)
        insertAudit.run(row.id, row.source, row.device, row.signal, row.source_time, row.received_at, row.value, row.quality);
      } finally { evidence.exec('COMMIT'); }
      cursors.audits = rows.at(-1).id; processed += rows.length; progress('reading-meter-history');
    }
    parentPort.postMessage({ id, latest: preview(now, range) });
    progress('reading-recorded-energy', true);
    const observations = source.prepare(`SELECT id,source,device,signal,value,unit,source_time,received_at,quality,raw,import_id,
      ${selectedHistoryPredicate('observations', 'r')} selected FROM observations r INDEXED BY observations_signal_id
      WHERE signal=? AND id>? ORDER BY id LIMIT ?`);
    const insertObservation = evidence.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    for (const phase of PHASES) {
      let cursor = cursors.observations;
      while (cursor < (heads.observations ?? 0)) {
        const rows = observations.all(phase, cursor, BATCH);
        if (!rows.length) break;
        evidence.exec('BEGIN');
        try { for (const row of rows) if (row.selected && row.import_id === null && row.source !== 'simulation')
          insertObservation.run(row.id, row.source, row.device, row.signal, row.value, row.unit, row.source_time,
            row.received_at, row.quality, comparisonRaw(row.raw), null);
        } finally { evidence.exec('COMMIT'); }
        cursor = rows.at(-1).id; processed += rows.length; progress('reading-recorded-energy');
      }
    }
    progress('reading-charging-sessions', true);
    const events = source.prepare(`SELECT id,type,payload,at,${selectedHistoryPredicate('events', 'r')} selected
      FROM events r INDEXED BY events_type_id WHERE type='charging-session-check' AND id>? ORDER BY id LIMIT ?`);
    const insertEvent = evidence.prepare('INSERT INTO events VALUES(?,?,?,?)');
    while (cursors.events < (heads.events ?? 0)) {
      const rows = events.all(cursors.events, BATCH);
      if (!rows.length) break;
      evidence.exec('BEGIN');
      try { for (const row of rows) if (row.selected) insertEvent.run(row.id, row.type, row.payload, row.at);
      } finally { evidence.exec('COMMIT'); }
      cursors.events = rows.at(-1).id; processed += rows.length; progress('reading-charging-sessions');
    }
    evidence.exec('DELETE FROM state');
    const states = source.prepare('SELECT key,value FROM state WHERE key>? AND key<? ORDER BY key LIMIT ?');
    const insertState = evidence.prepare('INSERT INTO state VALUES(?,?)');
    let cursor = 'recorder:energy:';
    for (;;) {
      const rows = states.all(cursor, 'recorder:energy;', BATCH);
      if (!rows.length) break;
      for (const row of rows) {
        let identity; try { identity = JSON.parse(row.key.slice('recorder:energy:'.length)); } catch { continue; }
        if (Array.isArray(identity) && identity[2] === 'property') insertState.run(row.key, row.value);
      }
      cursor = rows.at(-1).key;
    }
    // No long-lived source snapshot is held during comparison or scratch sorts.
    source.exec('ROLLBACK'); releaseStorageLease();
    previous = { head, selection, now, audits: heads.audits ?? 0,
      observations: heads.observations ?? 0, events: heads.events ?? 0 };
    progress('comparing-energy', true);
    const result = energyCheckSummaries({ db: evidence }, { now, range });
    const evidenceBytes = evidence.prepare('PRAGMA page_count').get().page_count
      * evidence.prepare('PRAGMA page_size').get().page_size;
    parentPort.postMessage({ id, result, evidenceBytes, evictEvidence: evidenceBytes > workerData.evidenceCacheBytes });
  } catch (error) {
    previous = null;
    const code = error?.code === 'ENERGY_CHECKPOINT_CHANGED' ? error.code
      : error?.errcode === 5 || error?.errcode === 6 || error?.code === 'STORAGE_WRITE_CANCELLED' ? 'ENERGY_STORAGE_BUSY'
        : error?.errcode === 11 || error?.errcode === 26 ? 'ENERGY_DATABASE_UNREADABLE' : 'ENERGY_CHECK_FAILED';
    parentPort.postMessage({ id, error: { code } });
  } finally {
    setStorageRequestActive(false);
    try { if (source.isTransaction) source.exec('ROLLBACK'); } finally { releaseStorageLease(); }
  }
});
