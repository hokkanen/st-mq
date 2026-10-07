import { parentPort, workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { yieldToController as yieldTurn } from './scheduler.js';
import { Store } from '../storage/store.js';
import { RECOVERABLE_TABLES, recoveryRecordKey } from '../storage/schema.js';
import { selectedHistory, recoverySource, recoveryEvidenceVersion, recoveryCoverageEvidence } from './ledger.js';
import { applyLearningRecord, learningVersion, LEARNING_ALGORITHM } from '../app/committed-learning.js';
import { fireplaceLearningContext } from '../app/fireplace-inputs.js';
import { sensorRevision } from '../app/sensor-inputs.js';
import { HistoryMerge } from './merge.js';
import { pendingEnergyObservationsFromStates } from '../storage/pending-energy.js';
import { validEnergyQuality } from '../storage/energy-history.js';
import { recoveryFailure } from './errors.js';

const path = workerData.mode === 'revision-preview'
  ? join(workerData.temporaryDirectory, 'candidate.sqlite') : workerData.masterPath;
parentPort.postMessage({ type: 'progress', phase: 'validating', processed: 0 });
const store = new Store(path);
if (workerData.mode === 'revision-preview') store.db.exec('PRAGMA synchronous=OFF;');
store.db.exec('PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-8192;');
const db = store.db, input = workerData.input;
const generation = randomUUID(), epoch = `revision:${generation}`;
const decode = row => ({ id: row.id, key: row.key, kind: row.kind, at: row.at,
  algorithmVersion: row.algorithm_version, configVersion: row.config_version === null ? null : JSON.parse(row.config_version),
  forecastVersion: row.forecast_version === null ? null : JSON.parse(row.forecast_version), payload: JSON.parse(row.payload) });
const fail = (message, code) => { throw Object.assign(new Error(message), { public: true, code }); };
const head = () => db.prepare('SELECT COALESCE(MAX(id),0) n FROM learning_journal WHERE input=?').get(input).n;
const selection = selectedHistory(store), sourceEpoch = store.learningEpoch(input);
const sourceFireplace = fireplaceLearningContext(store, input).fireplaceRevision, sourceSensor = sensorRevision(store, input);
let sourceHead = head(), checkpoint = null, report, source, processed = 0, busy = false, closed = false;
let restorationToken = null, restorationVerified = null;
const pendingStates = source => source.db.prepare("SELECT key,value FROM state WHERE key LIKE 'recorder:energy:%' ORDER BY key").all();
const observationHead = source => source.db.prepare('SELECT COALESCE(MAX(id),0) n FROM observations').get().n;
const excluded = db.prepare('SELECT 1 FROM recovery_exclusions WHERE generation=? AND table_name=? AND record_key=?');
const exclude = db.prepare('INSERT OR IGNORE INTO recovery_exclusions(generation,table_name,record_key) VALUES(?,?,?)');
const conflict = db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key,reason) VALUES(?,?,?,'conflict') ON CONFLICT DO UPDATE SET reason='conflict'");
const rootId = id => db.prepare('SELECT COALESCE(source_entry_id,id) id FROM learning_journal_entries WHERE id=?').get(id)?.id ?? id;
const hidden = (table, id) => id != null && Boolean(excluded.get(generation, table, String(table === 'learning_journal' ? rootId(id) : id)));
let progressAt = 0, progressPhase = null;
const progress = (phase, values = {}) => {
  if (Date.now() - progressAt < 100 && phase === progressPhase && values.processed !== values.total) return;
  parentPort.postMessage({ type: 'progress', phase, processed,
    ...(phase === 'checking' ? { unit: 'records' } : {}), ...values });
  progressAt = Date.now(); progressPhase = phase;
};
const publishedRoot = `(e.epoch='original' OR e.epoch=?
  OR EXISTS(SELECT 1 FROM recovery_runs r WHERE r.epoch=e.epoch AND r.status='complete')
  OR EXISTS(SELECT 1 FROM recovery_decisions d WHERE d.epoch=e.epoch)
  OR EXISTS(SELECT 1 FROM recovery_members m WHERE m.table_name='learning_journal' AND m.record_key=CAST(e.id AS TEXT)))`;

function assertSource() {
  if (selectedHistory(store) !== selection || store.learningEpoch(input) !== sourceEpoch)
    fail('Selected history changed. Review this recovery again.');
  // The temporary views select the proposed fireplace history. Read the actual
  // source through an independent connection when checking concurrent edits.
  const current = new Store(workerData.masterPath, { readOnly: true });
  try {
    if (fireplaceLearningContext(current, input).fireplaceRevision !== sourceFireplace || sensorRevision(current, input) !== sourceSensor)
      fail('Source corrections changed. Review this recovery again.');
  } finally { current.close(); }
}

function selectProposedViews() {
  // Temporary views affect only this worker's read interpretation. Live charts,
  // control and other readers keep the previously published selection.
  for (const table of RECOVERABLE_TABLES) db.exec(`CREATE TEMP VIEW active_${table} AS SELECT r.* FROM main.${table} r
    WHERE NOT EXISTS(SELECT 1 FROM main.recovery_exclusions x WHERE x.generation='${generation}'
      AND x.table_name='${table}' AND x.record_key=${recoveryRecordKey(table)});`);
}

function referencesRejected(value) {
  if (!value || typeof value !== 'object') return false;
  for (const [key, item] of Object.entries(value)) {
    if (['observationId', 'sourceObservationId'].includes(key) && hidden('observations', item)
      || key === 'coverageId' && hidden('recorder_coverage', item)
      || key === 'snapshotId' && hidden('provider_snapshot_fetches', item)
      || ['cycleId', 'episodeId'].includes(key) && hidden('learning_cycles', item)) return true;
    if (key === 'observations' && Array.isArray(item) && item.some(id => hidden('observations', id))) return true;
    if (key === 'coverage' && Array.isArray(item) && item.some(id => hidden('recorder_coverage', id))) return true;
    if (key === 'journal' && Array.isArray(item) && item.some(id => hidden('learning_journal', id))) return true;
    if (key === 'forecastVersion' && item && hidden('provider_snapshot_fetches', item.id)) return true;
    if (key === 'sensorRevert' && item && hidden('learning_journal', item.id)) return true;
    if (referencesRejected(item)) return true;
  }
  return false;
}

async function prepareSelection() {
  const operation = db.prepare('SELECT * FROM history_recoveries WHERE id=? AND input=?').get(workerData.recoveryId, input);
  if (!operation || typeof workerData.active !== 'boolean') fail('Choose an existing recovery.');
  if (Boolean(operation.active) === workerData.active) fail('This recovery already has the selected state.');
  let rejectedAfter = '';
  for (;;) {
    const rejectedRows = db.prepare('SELECT id FROM history_recoveries WHERE CASE WHEN id=? THEN ? ELSE active END=0 AND id>? ORDER BY id LIMIT 64')
      .all(operation.id, Number(workerData.active), rejectedAfter);
    if (!rejectedRows.length) break;
    for (const rejected of rejectedRows) {
      let table = '', key = '';
      for (;;) {
        const rows = db.prepare(`SELECT table_name,record_key FROM recovery_members WHERE recovery_id=?
          AND (table_name,record_key)>(?,?) ORDER BY table_name,record_key LIMIT 128`).all(rejected.id, table, key);
        if (!rows.length) break;
        store.transaction(() => { for (const row of rows) {
          if (!['provider_snapshot_contents', 'imports'].includes(row.table_name)) exclude.run(generation, row.table_name, row.record_key);
          table = row.table_name; key = row.record_key;
        } });
        await yieldTurn();
      }
      rejectedAfter = rejected.id;
    }
  }
  // Content-addressed blobs and CSV container metadata remain when another
  // source refers to them. Their rejected observations/fetches/rows are excluded.
  let conflictTable = '', conflictKey = '';
  for (;;) {
    const rows = db.prepare(`SELECT x.table_name,x.record_key FROM recovery_exclusions x
      WHERE x.generation=? AND x.reason='conflict' AND (x.table_name,x.record_key)>(?,?)
      AND EXISTS(SELECT 1 FROM recovery_members m JOIN history_recoveries r ON r.id=m.recovery_id
        WHERE m.table_name=x.table_name AND m.record_key=x.record_key AND r.id<>? AND r.active=1)
      ORDER BY x.table_name,x.record_key LIMIT 128`).all(selection, conflictTable, conflictKey, operation.id);
    if (!rows.length) break;
    store.transaction(() => { for (const row of rows) {
      conflict.run(generation, row.table_name, row.record_key); conflictTable = row.table_name; conflictKey = row.record_key;
    } });
    await yieldTurn();
  }
  selectProposedViews();
  // A reverted gap may since have acquired independent local evidence. Current
  // records keep precedence when restoring, including full phase-energy cohorts.
  if (workerData.active) {
    restorationToken = restorationVerified = await restorationConflicts({ apply: true });
  }
  for (const [table, parent, field] of [['recorder_coverage', 'observations', 'observation_id'], ['fireplace_events', 'fireplace_events', 'target_id']]) {
    let after = 0;
    for (;;) {
      const rows = db.prepare(`SELECT r.id FROM ${table} r JOIN recovery_exclusions x ON x.table_name=?
        AND x.record_key=CAST(r.${field} AS TEXT) WHERE x.generation=? AND r.id>? ORDER BY r.id LIMIT 128`).all(parent, generation, after);
      if (!rows.length) break;
      store.transaction(() => { for (const row of rows) { exclude.run(generation, table, String(row.id)); after = row.id; } });
      await yieldTurn();
    }
  }
  await scanDependencies();
  await invalidateAssessments();
  await checkOtherInputs();
  const tables = db.prepare(`SELECT table_name name,COUNT(*) count FROM recovery_exclusions WHERE generation=?
    AND NOT EXISTS(SELECT 1 FROM recovery_exclusions old WHERE old.generation=?
      AND old.table_name=recovery_exclusions.table_name AND old.record_key=recovery_exclusions.record_key)
    GROUP BY table_name`).all(workerData.active ? selection : generation, workerData.active ? generation : selection);
  const saved = operation.report ? JSON.parse(operation.report) : {};
  report = { recoveryId: operation.id, active: workerData.active, source: recoverySource(JSON.parse(operation.source)),
    sourceSelection: selection, sourceEpoch, sourceHead, sourceFireplace, sourceSensor,
    decisionHead: db.prepare('SELECT COALESCE(MAX(id),0) n FROM recovery_decisions').get().n,
    contributionHead: db.prepare('SELECT COUNT(*) n FROM recovery_members').get().n,
    conflictVersion: restorationToken?.token ?? null,
    period: saved.period ?? { from: null, to: null }, tables,
    counts: { affected: tables.reduce((sum, row) => sum + row.count, 0) }, model: { status: 'rebuild-required' } };
  report.previewId = learningVersion(report);
}

async function scanDependencies(after = 0) {
  // One ordered pass handles journal references to preceding entries. Roots
  // from every published epoch include observations recorded after recovery.
  for (;;) {
    const rows = db.prepare(`SELECT e.* FROM learning_journal_entries e WHERE e.input=? AND e.source_entry_id IS NULL AND e.id>?
      AND ${publishedRoot} ORDER BY e.id LIMIT 64`).all(input, after, sourceEpoch);
    if (!rows.length) break;
    store.transaction(() => {
      for (const row of rows) {
        if (referencesRejected(JSON.parse(row.payload))) exclude.run(generation, 'learning_journal', String(row.id));
        after = row.id; processed++;
      }
    });
    progress('checking'); await yieldTurn();
  }
}

async function checkOtherInputs() {
  // Physical observations are shared, but each input owns its journal/model.
  // Never publish a correction that would silently leave another supported
  // input's saved learning dependent on rejected physical evidence.
  let after = 0;
  for (;;) {
    const rows = db.prepare('SELECT id,payload FROM learning_journal WHERE input<>? AND id>? ORDER BY id LIMIT 64').all(input, after);
    if (!rows.length) break;
    for (const row of rows) {
      if (referencesRejected(JSON.parse(row.payload))) fail(
        'This recovery affects saved learning in another input. Keep it active or use a separate database for that input.',
        'recovery_other_input');
      after = row.id;
    }
    await yieldTurn();
  }
}

async function invalidateAssessments() {
  const earliest = db.prepare(`SELECT MIN(e.at) at FROM learning_journal_entries e
    JOIN recovery_exclusions x ON x.table_name='learning_journal' AND x.record_key=CAST(e.id AS TEXT)
    WHERE x.generation=? AND e.input=?`).get(generation, input).at;
  let after = '';
  for (;;) {
    const rows = db.prepare('SELECT id,started_at,payload FROM active_learning_cycles WHERE input=? AND id>? ORDER BY id LIMIT 32').all(input, after);
    if (!rows.length) break;
    store.transaction(() => { for (const row of rows) {
      const cycle = JSON.parse(row.payload), trained = cycle.plan?.model?.trainedAt;
      const trainedAt = Number.isFinite(trained) ? trained : Date.parse(trained);
      // Frozen plans have no complete model-journal boundary. If their model
      // could contain rejected learning, its derived savings are unknown; the
      // original plan and observed outcome remain intact and inspectable.
      const modelAffected = earliest !== null && cycle.plan?.model
        && (Number.isFinite(trainedAt) ? trainedAt >= earliest : row.started_at >= earliest);
      const episodeAffected = db.prepare(`SELECT 1 FROM learning_journal_entries e
        JOIN recovery_exclusions x ON x.table_name='learning_journal' AND x.record_key=CAST(e.id AS TEXT)
        WHERE x.generation=? AND e.input=? AND e.kind='episode' AND json_extract(e.payload,'$.value.id')=? LIMIT 1`)
        .get(generation, input, row.id);
      if (referencesRejected(cycle) || modelAffected || episodeAffected) exclude.run(generation, 'cycle_assessments', row.id);
      after = row.id;
    } });
    await yieldTurn();
  }
}

async function restorationConflicts({ apply = false } = {}) {
  const current = new Store(workerData.masterPath, { readOnly: true });
  // One consistent source snapshot makes this digest meaningful even while
  // the recorder continues to append independent observations.
  current.db.exec('BEGIN');
  try {
    const merge = new HistoryMerge({ target: current, donor: current, donorDigest: '', input });
    let after = 0, token = null, maximumAt = -Infinity;
    for (;;) {
      const rows = db.prepare(`SELECT o.* FROM observations o JOIN recovery_members m ON m.table_name='observations'
        AND m.record_key=CAST(o.id AS TEXT) WHERE m.recovery_id=? AND o.id>? ORDER BY o.id LIMIT 64`).all(workerData.recoveryId, after);
      if (!rows.length) break;
      for (const row of rows) {
        // Every overlap predicate is bounded by a source or receipt clock in
        // the recovered row. Future live evidence can be verified as a suffix
        // without rescanning all these immutable contributions.
        const raw = row.raw === null ? null : JSON.parse(row.raw);
        maximumAt = Math.max(maximumAt, row.received_at, row.source_time ?? -Infinity,
          Number.isFinite(raw?.intervalEnd) ? raw.intervalEnd : -Infinity);
        const own = current.db.prepare('SELECT 1 FROM active_observations WHERE id=?').get(row.id);
        const old = own ? null : merge.observationOverlap(row, raw, { pendingAt: merge.now });
        if (apply && old) {
          const rejected = [row.id];
          if (/^(property|ev1|ev2)_energy_l[123]$/.test(row.signal)) {
            for (const peer of db.prepare(`SELECT id FROM observations WHERE source=? AND device=?
              AND signal IN (?,?,?) AND source_time IS ? AND received_at=?`).iterate(row.source, row.device,
                ...[1,2,3].map(n => row.signal.replace(/l[123]$/, `l${n}`)), row.source_time, row.received_at))
              rejected.push(peer.id);
          }
          store.transaction(() => { for (const id of rejected) conflict.run(generation, 'observations', String(id)); });
        }
        token = learningVersion({ previous: token, id: row.id, conflicting: Boolean(old) });
        after = row.id;
      }
      await yieldTurn();
    }
    return { token, version: recoveryEvidenceVersion(current, { now: merge.now }), observationHead: observationHead(current),
      pendingStates: pendingStates(current), pendingAt: merge.now, coverage: recoveryCoverageEvidence(current), maximumAt };
  } finally { current.close(); }
}

const laterObservation = (row, maximumAt) => {
  if (!Number.isFinite(row.source_time) || row.source_time <= maximumAt || row.received_at <= maximumAt) return false;
  let raw; try { raw = row.raw === null ? null : JSON.parse(row.raw); } catch { return false; }
  return raw?.intervalStart === undefined || Number.isFinite(raw.intervalStart) && raw.intervalStart >= maximumAt;
};
function laterPending(value, maximumAt) {
  if (value === undefined) return true;
  let state; try { state = JSON.parse(value); } catch { return false; }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  if (state.pending == null) return true;
  const pending = state.pending;
  return Number.isFinite(pending.start) && pending.start >= maximumAt && Number.isFinite(pending.end)
    && pending.end > pending.start && Number.isFinite(pending.receivedAt) && pending.receivedAt > maximumAt;
}

function unchangedEarlierPending(key, before, after, previous, now) {
  if (before === undefined || after === undefined) return false;
  const oldRows = pendingEnergyObservationsFromStates([{ key, value: before }], { now: previous.pendingAt });
  const newRows = pendingEnergyObservationsFromStates([{ key, value: after }], { now });
  if (!oldRows.length || oldRows.length !== newRows.length) return false;
  // An already overlapping tail may continue accumulating for days. Once its
  // end is beyond all recovered intervals, extending that same valid stream
  // cannot add or remove an older overlap. Values may change, but a changed
  // scope, start or quality must still receive the complete conflict scan.
  return oldRows.every((old, index) => {
    const next = newRows[index];
    return ['source', 'device', 'signal', 'unit', 'quality'].every(key => old[key] === next[key])
      && validEnergyQuality(JSON.parse(old.quality))
      && JSON.parse(old.raw).intervalStart === JSON.parse(next.raw).intervalStart
      && old.source_time > previous.maximumAt && next.source_time >= old.source_time;
  });
}

const coverageAfter = (row, maximumAt) => row.start_at > maximumAt && row.end_at >= row.start_at;
function unchangedEarlierCoverage(before, after, maximumAt) {
  if (!after) return false;
  if (Object.keys(before).every(key => before[key] === after[key])) return true;
  if (coverageAfter(before, maximumAt) && coverageAfter(after, maximumAt)) return true;
  // Extending a span which already ended beyond every recovered point cannot
  // add older coverage. The same referenced measurement and status must remain.
  return ['id', 'source', 'device', 'signal', 'status', 'start_at', 'observation_id'].every(key => before[key] === after[key])
    && before.end_at > maximumAt && after.end_at >= before.end_at;
}

async function laterCoverage(current, previous, next, maximumAt) {
  const known = new Set(previous.rows.map(row => row.id));
  if (next.rows.some(row => !known.has(row.id) && !coverageAfter(row, maximumAt))) return false;
  for (const before of previous.rows) {
    const after = current.db.prepare(`SELECT id,source,device,signal,status,start_at,end_at,source_time,observation_id
      FROM recorder_coverage WHERE id=?`).get(before.id);
    if (!unchangedEarlierCoverage(before, after, maximumAt)) return false;
  }
  let cursor = previous.head;
  for (;;) {
    const rows = current.db.prepare('SELECT id,start_at,end_at FROM recorder_coverage WHERE id>? AND id<=? ORDER BY id LIMIT 64')
      .all(cursor, next.head);
    if (!rows.length) return true;
    if (!rows.every(row => coverageAfter(row, maximumAt))) return false;
    cursor = rows.at(-1).id; await yieldTurn();
  }
}

async function verifyRestoration() {
  const previous = restorationVerified, current = new Store(workerData.masterPath, { readOnly: true });
  current.db.exec('BEGIN');
  let tail = null;
  try {
    const pendingAt = Date.now();
    const version = recoveryEvidenceVersion(current, { now: pendingAt });
    if (version === previous.version) return previous;
    const states = pendingStates(current), before = new Map(previous.pendingStates.map(row => [row.key, row.value])),
      after = new Map(states.map(row => [row.key, row.value]));
    const samePending = key => before.get(key) === after.get(key)
      && learningVersion(pendingEnergyObservationsFromStates([{ key, value: before.get(key) }], { now: previous.pendingAt }))
        === learningVersion(pendingEnergyObservationsFromStates([{ key, value: after.get(key) }], { now: pendingAt }));
    let later = [...new Set([...before.keys(), ...after.keys()])].every(key => samePending(key)
      || laterPending(before.get(key), previous.maximumAt) && laterPending(after.get(key), previous.maximumAt)
      || unchangedEarlierPending(key, before.get(key), after.get(key), previous, pendingAt));
    const coverage = recoveryCoverageEvidence(current);
    if (later) later = await laterCoverage(current, previous.coverage, coverage, previous.maximumAt);
    let cursor = previous.observationHead, checked = 0;
    while (later) {
      const rows = current.db.prepare('SELECT id,source_time,received_at,raw FROM observations WHERE id>? ORDER BY id LIMIT 64').all(cursor);
      if (!rows.length) break;
      later = rows.every(row => laterObservation(row, previous.maximumAt)); cursor = rows.at(-1).id;
      checked += rows.length;
      progress('catching-up', { processed: checked, unit: 'records' }); await yieldTurn();
    }
    if (later) tail = { ...previous, version, observationHead: observationHead(current), pendingStates: states, pendingAt, coverage };
  } finally { current.close(); }
  // Backdated, overlapping or unknown evidence requires the full conservative
  // check. Keep its exact verified snapshot boundary: a later retry then checks
  // only what arrived during this scan, never guesses a newer version token.
  restorationVerified = tail ?? await restorationConflicts();
  return restorationVerified;
}

async function buildProjection() {
  processed = 0; progress('projecting', { processed: 0, unit: 'entries' });
  db.exec('CREATE TEMP TABLE revision_map(original INTEGER PRIMARY KEY,projected INTEGER NOT NULL)');
  // Only original payloads participate, including new live records written in
  // later epochs. Compact copied ordering references never become new evidence.
  let cursor = null;
  for (;;) {
    const rows = db.prepare(`SELECT e.*,CASE kind WHEN 'context' THEN 0 WHEN 'sample' THEN 1 ELSE 2 END rank
      FROM learning_journal_entries e WHERE input=? AND source_entry_id IS NULL AND id<=?
      AND NOT EXISTS(SELECT 1 FROM recovery_exclusions x WHERE x.generation=? AND x.table_name='learning_journal' AND x.record_key=CAST(e.id AS TEXT))
      AND ${publishedRoot}
      AND (? IS NULL OR (at,CASE kind WHEN 'context' THEN 0 WHEN 'sample' THEN 1 ELSE 2 END,id)>(?,?,?))
      ORDER BY at,rank,id LIMIT 64`).all(input, sourceHead, generation, sourceEpoch, cursor?.at ?? null, cursor?.at ?? 0, cursor?.rank ?? 0, cursor?.id ?? 0);
    if (!rows.length) break;
    store.transaction(() => { for (const row of rows) { stage(row); cursor = row; } });
    progress('projecting', { unit: 'entries' }); await yieldTurn();
  }
  await remapAndReplay();
}

function stage(row) {
  if (row.algorithm_version !== LEARNING_ALGORITHM) fail('Unsupported learning history cannot be reconstructed.');
  const duplicate = db.prepare(`SELECT map.projected FROM recovery_members original
    JOIN recovery_members accepted ON accepted.table_name=original.table_name AND accepted.fingerprint=original.fingerprint
    JOIN revision_map map ON CAST(map.original AS TEXT)=accepted.record_key
    WHERE original.table_name='learning_journal' AND original.record_key=? LIMIT 1`).get(String(row.id));
  if (duplicate) {
    db.prepare('INSERT INTO revision_map(original,projected) VALUES(?,?)').run(row.id, duplicate.projected);
    return;
  }
  // Recoveries can replace a missing local placeholder. Prefer the usable
  // accepted window while it is active, restoring the original on reversal.
  if (row.kind === 'sample') {
    const sample = JSON.parse(row.payload).value;
    const usable = value => {
      const m = value.measurementInputs ?? value;
      return Number.isFinite(m.indoorC) && Number.isFinite(m.outdoorC)
        && !(m.quality ?? []).some(flag => /missing|invalid|unavailable|stale|failed/.test(flag));
    };
    const selected = db.prepare("SELECT * FROM learning_journal WHERE input=? AND kind='sample' AND at=? ORDER BY id DESC LIMIT 1").get(input, row.at);
    if (selected && rootId(selected.id) !== row.id && !hidden('learning_journal', selected.id)
      && usable(JSON.parse(selected.payload).value)) return;
    const old = db.prepare("SELECT * FROM learning_journal_all WHERE epoch=? AND input=? AND kind='sample' AND at=?").get(epoch, input, row.at);
    if (old) {
      if (usable(JSON.parse(old.payload).value) || !usable(sample)) return;
      db.prepare('DELETE FROM revision_map WHERE projected=?').run(old.id);
      db.prepare('DELETE FROM learning_journal_entries WHERE id=? AND epoch=?').run(old.id, epoch);
    }
  }
  const first = !db.prepare('SELECT 1 FROM revision_map LIMIT 1').get();
  let payload = JSON.parse(row.payload);
  // If all earlier source history was rejected, restart from documented passive
  // priors. Never adopt the rejected recovery's trained checkpoint as a seed.
  const explicit = first && !Object.hasOwn(payload, 'seed');
  if (explicit) payload = { ...payload, seed: null };
  const id = Number(db.prepare(`INSERT INTO learning_journal_entries(epoch,input,key,kind,at,algorithm_version,config_version,forecast_version,payload,source_entry_id)
    VALUES(?,?,?,?,?,?,NULL,NULL,?,?)`).run(epoch, input, `revision:${row.id}`, row.kind, row.at, row.algorithm_version,
      explicit ? JSON.stringify(payload) : null, row.id).lastInsertRowid);
  db.prepare('INSERT INTO revision_map(original,projected) VALUES(?,?)').run(row.id, id); processed++;
}

async function remapAndReplay(after = 0) {
  for (;;) {
    const rows = db.prepare('SELECT * FROM learning_journal_all WHERE epoch=? AND id>? ORDER BY id LIMIT 64').all(epoch, after);
    if (!rows.length) break;
    store.transaction(() => {
      for (const row of rows) {
        const payload = JSON.parse(row.payload);
        if (payload.value?.sensorRevert) {
          const target = db.prepare('SELECT projected FROM revision_map WHERE original=?').get(rootId(payload.value.sensorRevert.id));
          if (!target) fail('A sensor correction has no remaining source entry.');
          payload.value.sensorRevert.id = target.projected;
          db.prepare('UPDATE learning_journal_entries SET payload=? WHERE id=?').run(JSON.stringify(payload), row.id);
        }
        after = row.id;
      }
    });
    await yieldTurn();
  }
  const reversals = db.prepare(`SELECT id,json_extract(payload,'$.value.sensorRevert.id') target FROM learning_journal_all
    WHERE epoch=? AND kind='context' AND json_type(payload,'$.value.sensorRevert')='object' ORDER BY id`).all(epoch);
  source = { ...fireplaceLearningContext(store, input), sensorRevision: reversals.at(-1)?.id ?? 0,
    revertedSensorChanges: [...new Set(reversals.map(row => row.target))] };
  // New corrections are fenced; catch-up only appends samples/contexts and
  // replays the appended suffix with the same selected source revision.
  after = checkpoint?.journalCursor ?? 0;
  let replayed = 0;
  const total = db.prepare('SELECT COUNT(*) total FROM learning_journal_entries WHERE epoch=? AND id>?').get(epoch, after).total;
  progress('rebuilding', { processed: 0, total, unit: 'entries' });
  for (;;) {
    const rows = db.prepare('SELECT * FROM learning_journal_all WHERE epoch=? AND id>? ORDER BY id LIMIT 64').all(epoch, after);
    if (!rows.length) break;
    for (const row of rows) { checkpoint = applyLearningRecord(checkpoint, decode(row), source); after = row.id; replayed++; }
    progress('rebuilding', { processed: replayed, total, unit: 'entries' }); await yieldTurn();
  }
}

async function catchup() {
  progress('catching-up', { processed: 0, unit: 'entries' });
  assertSource();
  const through = head();
  const previousHead = sourceHead;
  await scanDependencies(sourceHead);
  await invalidateAssessments();
  await checkOtherInputs();
  for (;;) {
    const rows = db.prepare('SELECT * FROM learning_journal_all WHERE epoch=? AND input=? AND id>? AND id<=? ORDER BY id LIMIT 64')
      .all(sourceEpoch, input, sourceHead, through);
    if (!rows.length) break;
    store.transaction(() => {
      for (const row of rows) {
        if (row.at < (checkpoint?.cursor ? Date.parse(checkpoint.cursor) : -Infinity)) fail('Backdated learning requires a new recovery review.');
        const root = rootId(row.id);
        if (!hidden('learning_journal', root) && !db.prepare('SELECT 1 FROM revision_map WHERE original=?').get(root))
          stage(db.prepare('SELECT * FROM learning_journal_entries WHERE id=?').get(root));
        sourceHead = row.id;
      }
    });
    progress('catching-up'); await yieldTurn();
  }
  if (sourceHead !== previousHead) await remapAndReplay(checkpoint?.journalCursor ?? 0);
  // Verify after potentially lengthy dependency scans and replay so their
  // execution cannot repeatedly age an otherwise unchanged evidence proof.
  // Publication still checks this exact version and the caught-up journal head
  // atomically on the live connection.
  let evidenceVersion = null;
  if (workerData.active) {
    const current = await verifyRestoration();
    if (current.token !== restorationToken.token) fail('New local evidence changes this restoration. Review its impact again.');
    evidenceVersion = current.version;
  }
  progress('publishing', { processed: 0 });
  parentPort.postMessage({ type: 'ready', revision: true, generation, epoch, sourceEpoch, sourceHead,
    sourceSelection: selection, sourceFireplace, sourceSensor, fireplaceRevision: source.fireplaceRevision,
    sensorRevision: source.sensorRevision, checkpoint, evidenceVersion, report });
}

function close() { if (!closed) { closed = true; store.close(); parentPort.close(); } }
function failed(error) { parentPort.postMessage({ type: 'failed', ...recoveryFailure(error) }); close(); }
async function start() {
  if (workerData.mode !== 'revision-preview') await discardUnpublished();
  await prepareSelection();
  if (workerData.mode === 'revision-preview') {
    db.prepare('DELETE FROM recovery_exclusions WHERE generation=?').run(generation);
    parentPort.postMessage({ type: 'complete', report }); close(); return;
  }
  const { previewId, ...checked } = workerData.preview ?? {};
  if (previewId !== learningVersion(checked) || checked.recoveryId !== report.recoveryId || checked.active !== report.active
    || checked.sourceSelection !== selection || checked.sourceEpoch !== sourceEpoch
    || checked.sourceFireplace !== sourceFireplace || checked.sourceSensor !== sourceSensor
    || checked.conflictVersion !== report.conflictVersion
    || checked.decisionHead !== report.decisionHead || checked.contributionHead !== report.contributionHead)
    fail('Recovery review is stale. Review the impact again.');
  await buildProjection(); await catchup();
}

async function discardUnpublished() {
  // Only abandoned projections are disposable. Every published decision keeps
  // its epoch and exclusion generation so earlier interpretations remain valid.
  for (;;) {
    const rows = db.prepare(`SELECT generation,table_name,record_key FROM recovery_exclusions x
      WHERE generation<>(SELECT generation FROM history_selection WHERE id=1)
      AND NOT EXISTS(SELECT 1 FROM recovery_decisions d WHERE d.generation=x.generation) LIMIT 128`).all();
    if (!rows.length) break;
    store.transaction(() => { for (const row of rows)
      db.prepare('DELETE FROM recovery_exclusions WHERE generation=? AND table_name=? AND record_key=?')
        .run(row.generation,row.table_name,row.record_key); });
    await yieldTurn();
  }
  for (;;) {
    const rows = db.prepare(`SELECT id FROM learning_journal_entries e WHERE epoch LIKE 'revision:%'
      AND NOT EXISTS(SELECT 1 FROM recovery_decisions d WHERE d.epoch=e.epoch)
      AND NOT EXISTS(SELECT 1 FROM learning_epochs selected WHERE selected.epoch=e.epoch) LIMIT 64`).all();
    if (!rows.length) break;
    store.transaction(() => { for (const row of rows) db.prepare('DELETE FROM learning_journal_entries WHERE id=?').run(row.id); });
    await yieldTurn();
  }
}
await start().catch(failed);
parentPort.on('message', async message => {
  if (closed || busy) return;
  if (message.type === 'close') { close(); return; }
  if (message.type !== 'catchup') return;
  busy = true;
  try { await catchup(); } catch (error) { failed(error); } finally { busy = false; }
});
