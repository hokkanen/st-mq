import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { readCheckpoint, checkpointAt, matchingCheckpoint } from '../storage/journal.js';
import { selectedHistoryPredicate } from '../storage/schema.js';
import { recordedTransport } from '../domain/recording-source.js';
import { isRecordedEnergyGap } from '../storage/energy-history.js';
import { pendingEnergyObservations } from '../storage/pending-energy.js';
import { observationTimeAdmitted } from '../domain/time-evidence.js';
import { energyCheckSummaries } from './energy-checks.js';
import { admittedReader, storageStep, releaseStorageLease, setStorageRequestActive } from '../storage/worker-admission.js';

const source = admittedReader(storageStep(() => new DatabaseSync(workerData.dbPath, { readOnly: true })), { batchRows: 128 });
source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE;');
const SIGNAL = 'property_import_energy_counter', PHASES = [1, 2, 3].map(phase => `property_energy_l${phase}`);
const BATCH = 128;
let evidence = null, previous = null, priorGuardId = null;
const sameRange = (a, b) => a?.from === b?.from && a?.to === b?.to;

// SQLite owns an unnamed, disk-backed temporary database and removes it when
// this worker closes. Only comparison inputs are copied; recorder payloads,
// credentials, unrelated signals and learning history never enter this cache.
function freshEvidence() {
  evidence?.close();
  priorGuardId = null;
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
    const continuous = previous && sameRange(previous.range, range) && previous.selection === selection && previous.head.databaseId === head.databaseId
      && now >= previous.now && matchingCheckpoint(checkpointAt(source, previous.head.sequence), previous.head)
      && ['audits', 'observations', 'events'].every(key => (heads[key] ?? 0) >= previous[key]) && appendOnly(head);
    if (!continuous) { freshEvidence(); previous = null; }
    const cursors = { audits: previous?.audits ?? 0, observations: previous?.observations ?? 0, events: previous?.events ?? 0 };
    // A period owns its disposable evidence. Cold time seeks skip unrelated old
    // prefixes; append refreshes use the global ID suffix and retain future
    // clocks inside the period for later admission by the shared evaluator.
    // Append clock rejection happens after the raw ID-suffix read so a large
    // out-of-period append cannot hide an archive scan in one native step.
    const audits = source.prepare(`SELECT id,source,device,signal,source_time,received_at,value,quality,
      ${selectedHistoryPredicate('energy_audits', 'r')} selected FROM energy_audits r
      WHERE ${previous ? 'id>? AND id<=?' : range ? 'signal=? AND source_time>=? AND source_time<=?' : 'id<=?'}
      ORDER BY ${!previous && range ? 'source_time,id' : 'id'}`);
    const insertAudit = evidence.prepare('INSERT INTO energy_audits VALUES(?,?,?,?,?,?,?,?)');
    const copy = (rows, stage, write) => {
      let batch = [];
      const flush = () => {
        if (!batch.length) return;
        evidence.exec('BEGIN');
        try { for (const row of batch) write(row); evidence.exec('COMMIT'); }
        catch (error) { evidence.exec('ROLLBACK'); throw error; }
        processed += batch.length; batch = []; progress(stage);
      };
      for (const row of rows) { batch.push(row); if (batch.length >= BATCH) flush(); }
      flush();
    };
    if (priorGuardId !== null) { evidence.prepare('DELETE FROM energy_audits WHERE id=?').run(priorGuardId); priorGuardId = null; }
    copy(audits.iterate(...(previous ? [cursors.audits, heads.audits ?? 0]
      : range ? [SIGNAL, range.from, range.to] : [heads.audits ?? 0])), 'reading-meter-history', row => {
      if (row.selected && row.signal === SIGNAL && (!range || row.source_time >= range.from && row.source_time <= range.to))
        insertAudit.run(row.id, row.source, row.device, row.signal, row.source_time, row.received_at, row.value, row.quality);
    });
    parentPort.postMessage({ id, latest: preview(now, range) });
    let latest = null;
    if (range) {
      latest = evidence.prepare(`SELECT * FROM energy_audits WHERE signal=? AND source_time>=? AND source_time<=? AND received_at<=?
        ORDER BY received_at DESC,id DESC LIMIT 1`).get(SIGNAL, range.from, Math.min(now, range.to), now);
      // A delayed in-period reading can follow a newer-source meter timestamp
      // outside the period. Preserve that exact out-of-order baseline as one
      // replaceable guard; older lower-side context is already rejected by the
      // evaluator's current range check and cannot supply a comparison.
      let guard = null;
      if (latest) {
        const candidates = source.prepare(`SELECT r.*,${selectedHistoryPredicate('energy_audits', 'r')} selected
          FROM (SELECT id,source,device,signal,source_time,received_at,value,quality
            FROM energy_audits INDEXED BY energy_audits_device_time
            WHERE device=? AND (source_time,id)<=(?,?) AND source_time>?
            ORDER BY source_time DESC,id DESC LIMIT ?) r ORDER BY source_time DESC,id DESC`);
        let time = now, before = Number.MAX_SAFE_INTEGER, complete = false;
        while (!complete) {
          const rows = candidates.all(latest.device, time, before, range.to, BATCH);
          if (!rows.length) break;
          processed += rows.length; progress('reading-meter-history');
          for (const row of rows) {
            if (guard && row.source_time < guard.source_time) { complete = true; break; }
            if (!row.selected || row.source !== latest.source || row.signal !== SIGNAL || row.received_at > now
              || !(row.received_at < latest.received_at || row.received_at === latest.received_at && row.id < latest.id)) continue;
            // Finish the highest eligible source-time cohort before choosing
            // its earliest receipt/ID; native ID order alone is insufficient.
            if (!guard || row.received_at < guard.received_at || row.received_at === guard.received_at && row.id < guard.id) guard = row;
          }
          const last = rows.at(-1); time = last.source_time; before = last.id - 1;
        }
      }
      if (guard) {
        insertAudit.run(guard.id, guard.source, guard.device, guard.signal, guard.source_time, guard.received_at, guard.value, guard.quality);
        priorGuardId = guard.id;
      }
    }
    progress('reading-recorded-energy', true);
    const insertObservation = evidence.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    const insertEnergy = row => insertObservation.run(row.id, row.source, row.device, row.signal, row.value, row.unit, row.source_time,
      row.received_at, row.quality, comparisonRaw(row.raw), null);
    if (range) {
      // Only an explicit check/refresh reaches this pass. Re-seeking its small
      // energy scope avoids retaining invalidated cluster state when a delayed
      // row or current pending energy changes the overlap interpretation.
      evidence.exec('DELETE FROM observations');
      if (latest) {
        // Bound the native candidate step before rejecting overlap, source or
        // quality. Otherwise a single next() for an empty old period can walk
        // an arbitrarily long later suffix while holding writer admission.
        const observations = source.prepare(`SELECT r.*,${selectedHistoryPredicate('observations', 'r')} selected
          FROM (SELECT id,source,device,signal,value,unit,source_time,received_at,quality,raw,import_id
            FROM observations INDEXED BY observations_signal_time
            WHERE signal=? AND (source_time,id)>(?,?) AND source_time<=?
            ORDER BY source_time,id LIMIT ?) r ORDER BY source_time,id`);
        function* candidates(phase) {
          let time = range.from, after = Number.MAX_SAFE_INTEGER;
          for (;;) {
            const rows = observations.all(phase, time, after, now, BATCH);
            if (!rows.length) return;
            yield* rows;
            const last = rows.at(-1); time = last.source_time; after = last.id;
          }
        }
        const tails = pendingEnergyObservations({ db: source }, { now, input: 'providers', prefix: 'property',
          source: latest.source, device: latest.device });
        let lower = null, through = Math.min(range.to, now);
        for (;;) {
          let next = through;
          for (const tail of tails) {
            const raw = JSON.parse(tail.raw);
            if (tail.source_time > range.from && raw.intervalStart < through) next = Math.max(next, tail.source_time);
          }
          for (const phase of PHASES) copy(candidates(phase), 'reading-recorded-energy', row => {
            if (!row.selected || row.source !== latest.source || row.device !== latest.device
              || row.import_id !== null || row.source === 'simulation' || row.received_at > now) return;
            // The shared fallback comparison groups through now. A long
            // interval may therefore conflict with a later cohort outside the
            // selected dates. Preserve the complete actual overlap closure.
            let raw, quality;
            try { raw = JSON.parse(row.raw); } catch { return; }
            if (!Number.isSafeInteger(raw?.intervalStart) || !Number.isSafeInteger(raw.intervalEnd)
              || raw.intervalEnd <= raw.intervalStart || raw.intervalEnd !== row.source_time
              || raw.timeBasis === 'completed-hour' || raw.intervalStart >= through
              || lower !== null && raw.intervalStart < lower) return;
            insertEnergy(row);
            try { quality = JSON.parse(row.quality); } catch { return; }
            if (observationTimeAdmitted({ sourceTime: row.source_time, receivedAt: row.received_at, raw }, now)
              && !isRecordedEnergyGap(row, raw, quality)) next = Math.max(next, row.source_time);
          });
          if (next <= through) break;
          lower = through; through = next;
        }
      }
    } else {
      const observations = source.prepare(`SELECT id,source,device,signal,value,unit,source_time,received_at,quality,raw,import_id,
        ${selectedHistoryPredicate('observations', 'r')} selected FROM observations r INDEXED BY observations_signal_id
        WHERE signal=? AND id>? AND id<=? ORDER BY id`);
      for (const phase of PHASES) copy(observations.iterate(phase, cursors.observations, heads.observations ?? 0),
        'reading-recorded-energy', row => { if (row.selected && row.import_id === null && row.source !== 'simulation') insertEnergy(row); });
    }
    progress('reading-charging-sessions', true);
    const events = source.prepare(`SELECT id,type,payload,at,${selectedHistoryPredicate('events', 'r')} selected
      FROM events r WHERE type='charging-session-check'
      ${previous ? 'AND id>? AND id<=?' : ''} ${!previous && range ? 'AND at>=? AND at<=?' : ''}
      ORDER BY ${!previous && range ? 'at,id' : 'id'}`);
    const insertEvent = evidence.prepare('INSERT INTO events VALUES(?,?,?,?)');
    copy(events.iterate(...(previous ? [cursors.events, heads.events ?? 0] : range ? [range.from, range.to] : [])),
      'reading-charging-sessions', row => {
        if (row.selected && (!range || row.at >= range.from && row.at <= range.to)) insertEvent.run(row.id, row.type, row.payload, row.at);
      });
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
    previous = { head, selection, now, range, audits: heads.audits ?? 0,
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
