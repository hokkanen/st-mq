import { parentPort, workerData } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { yieldToController as yieldTurn } from './scheduler.js';
import { Store } from '../storage/store.js';
import { HistoryMerge, RECOVERY_POLICY } from './merge.js';
import { RECOVERABLE_TABLES } from '../storage/schema.js';
import { markRecoveryFailed, projectedSensorContext } from './state.js';
import { applyLearningRecord, learningVersion, LEARNING_ALGORITHM, LEARNING_WINDOW_MS } from '../app/committed-learning.js';
import { fireplaceLearningContext } from '../app/fireplace-inputs.js';
import { sensorRevision } from '../app/sensor-inputs.js';
import { beginRecovery, rememberContribution, selectedHistory } from './ledger.js';
import { assessRecoverySource } from './source-scope.js';
import { recoveryFailure } from './errors.js';

const json = JSON.stringify;
const decode = row => ({ id: row.id, key: row.key, kind: row.kind, at: row.at,
  algorithmVersion: row.algorithm_version, configVersion: row.config_version === null ? null : JSON.parse(row.config_version),
  forecastVersion: row.forecast_version === null ? null : JSON.parse(row.forecast_version), payload: JSON.parse(row.payload) });
const head = (store, input) => store.db.prepare('SELECT COALESCE(MAX(id),0) id FROM learning_journal WHERE input=?').get(input).id;
const epochOf = (store, input) => store.learningEpoch(input);
const invalid = message => Object.assign(new Error(message), { code: 'RECOVERY_INVALID' });
let target, donor, running = false, projection = null;
let originalFireplaceRevision = 0;
let recoveryId = null, sourceSelection = null, sourceAssessment = null;
let progressAt = 0;
const progress = value => {
  if (Date.now() - progressAt > 100 || value.phase !== 'importing') { parentPort.postMessage({ type: 'progress', ...value }); progressAt = Date.now(); }
};

async function fileDigest(path) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex');
}

async function open() {
  donor = new Store(workerData.donorPath, { readOnly: true });
  donor.db.exec('BEGIN'); donor.db.prepare('PRAGMA schema_version').get();
  if (donor.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
    throw Object.assign(new Error('Donor database integrity check failed'), { code: 'recovery_database_corrupt' });
  sourceAssessment = assessRecoverySource(donor, workerData.input);
  // Semantic rows with missing references are rejected individually by merge;
  // only physical database corruption prevents scanning the donor altogether.
  const donorDigest = await fileDigest(workerData.donorPath);
  if (workerData.mode === 'preview') target = new Store(workerData.masterPath, { readOnly: true });
  else {
    if (donorDigest !== workerData.preview?.donorDigest || workerData.preview?.input !== workerData.input)
      throw invalid('Recovery preview is stale; check the other instance again');
    target = new Store(workerData.masterPath);
    if (workerData.preview?.sourceSelection !== selectedHistory(target)) throw invalid('Selected history changed; check the source again');
  }
  return donorDigest;
}

// A check validates the frozen source and inventories its selected records. It
// does not attempt an import or claim which records the advancing master lacks.
// Actual acceptance, conflicts and model impact are decided once by the merge.
async function checkSource(donorDigest) {
  const tables = [];
  for (const name of RECOVERABLE_TABLES) {
    const count = donor.db.prepare(`SELECT COUNT(*) count FROM active_${name}`).get().count;
    tables.push({ name, count });
    progress({ phase: 'checking', processed: tables.length }); await yieldTurn();
  }
  tables.push({ name: 'learning_journal', count: donor.db.prepare('SELECT COUNT(*) count FROM learning_journal WHERE input=?').get(workerData.input).count });
  tables.push({ name: 'charging_session_keys', count: donor.db.prepare("SELECT COUNT(*) count FROM state WHERE key LIKE 'charging-session-check:%'").get().count });
  tables.push({ name: 'recorder_pending_energy', count: donor.db.prepare(`SELECT COUNT(*) count FROM state
    WHERE key LIKE 'recorder:energy:%' AND json_valid(value) AND json_type(value,'$.pending')='object'`).get().count });
  if (sourceAssessment.skippedLearningRecords)
    tables.push({ name: 'other_learning_inputs', count: sourceAssessment.skippedLearningRecords });
  const unsupported = ['charging_reports', 'charging_report_events'].map(name => ({ name,
    count: donor.db.prepare(`SELECT COUNT(*) count FROM ${name}`).get().count,
    reason: 'Saved charging reports are not included in history recovery.' })).filter(row => row.count > 0);
  const report = { status: 'checked', policy: RECOVERY_POLICY, tables, model: { status: 'not-assessed' },
    donorDigest, input: workerData.input, sourceSelection, sourceAssessment, unsupported };
  report.previewId = learningVersion(report);
  parentPort.postMessage({ type: 'complete', report }); cleanup();
}

function journalReferences(value, masterIds, donorIds, source) {
  const result = structuredClone(value);
  if (result.value?.sensorRevert) {
    const id = result.value.sensorRevert.id;
    const target = id < 0 ? donorIds.get(-id) : masterIds.get(id);
    if (!target) throw invalid('A sensor correction has no matching change in recovered history');
    result.value.sensorRevert.id = target;
  }
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    for (const [key, item] of Object.entries(node)) {
      if (key === 'journal' && Array.isArray(item)) node[key] = item.map(id => id < 0 ? donorIds.get(-id) ?? null : masterIds.get(id) ?? id);
      else visit(item);
    }
  };
  visit(result);
  // The projection keeps a compact source pointer. Original source bytes stay
  // in their epoch; this field cannot accidentally relabel them as new inputs.
  return { ...result, recoverySource: source };
}

async function createProjection(merge, runId) {
  const input = workerData.input;
  const snapshot = new Store(target.path, { readOnly: true });
  snapshot.db.exec('BEGIN'); snapshot.db.prepare('PRAGMA schema_version').get();
  // The head and selected epoch belong to exactly the snapshot being copied.
  // Sampling them before pinning could copy a concurrent append here and then
  // copy it a second time during catch-up.
  const sourceEpoch = epochOf(snapshot, input), sourceHead = head(snapshot, input);
  const sourceSensorRevision = sensorRevision(snapshot, input);
  const epoch = `recovery-v1:${runId}`;
  target.db.prepare(`INSERT INTO recovery_runs(id,input,donor_digest,previous_epoch,epoch,status,started_at,report,previous_fireplace_revision,source_head)
    VALUES(?,?,?,?,?,'rebuilding',?,?,?,?)`).run(runId, input, merge.digest, sourceEpoch, epoch, Date.now(), json(merge.report), originalFireplaceRevision, sourceHead);
  const originals = snapshot.db.prepare('SELECT * FROM learning_journal WHERE input=? ORDER BY at,CASE kind WHEN \'context\' THEN 0 WHEN \'sample\' THEN 1 ELSE 2 END,id').iterate(input);
  const recovered = [];
  for (const entry of merge.journal) {
    const old = snapshot.db.prepare('SELECT * FROM learning_journal WHERE input=? AND kind=? AND at=? ORDER BY id DESC LIMIT 1')
      .get(input, entry.row.kind, entry.row.at);
    // Live recording continues during the source scan. If it filled this
    // window meanwhile, its committed input wins before staging the projection.
    let conflicts = old && old.id !== entry.replacesMissing;
    if (entry.row.kind === 'sample') {
      const value = entry.payload.value;
      conflicts = snapshot.db.prepare(`SELECT 1 FROM learning_journal WHERE input=? AND kind='sample'
        AND json_valid(payload) AND json_type(payload,CASE
          WHEN json_extract(payload,'$.value.sensorInputVersion')=1 AND json_type(payload,'$.value.measurementInputs')='object'
          THEN '$.value.measurementInputs.indoorC' ELSE '$.value.indoorC' END) IN ('integer','real')
        AND json_type(payload,CASE
          WHEN json_extract(payload,'$.value.sensorInputVersion')=1 AND json_type(payload,'$.value.measurementInputs')='object'
          THEN '$.value.measurementInputs.outdoorC' ELSE '$.value.outdoorC' END) IN ('integer','real')
        AND NOT EXISTS (SELECT 1 FROM json_each(learning_journal.payload,CASE
          WHEN json_extract(payload,'$.value.sensorInputVersion')=1 AND json_type(payload,'$.value.measurementInputs')='object'
          THEN '$.value.measurementInputs.quality' ELSE '$.value.quality' END) q
          WHERE q.value LIKE '%missing%' OR q.value LIKE '%invalid%' OR q.value LIKE '%stale%'
            OR q.value LIKE '%unavailable%' OR q.value LIKE '%failed%')
        AND COALESCE(json_extract(payload,'$.value.windowStart'),at-?)<?
        AND COALESCE(json_extract(payload,'$.value.windowEnd'),at)>? LIMIT 1`)
        .get(input, LEARNING_WINDOW_MS, value.windowEnd ?? entry.row.at, value.windowStart ?? entry.row.at - LEARNING_WINDOW_MS);
    }
    if (conflicts) {
      merge.count('learning_journal', 'conflicts');
      merge.report.counts.missing--; merge.report.tables.find(row => row.name === 'learning_journal').missing--;
      if (entry.row.kind === 'sample') merge.report.model.acceptedSamples--;
      if (old) merge.maps.learning_journal.set(entry.row.id, { id: old.id, disposition: 'conflicts' });
    } else recovered.push(entry);
  }
  const rejectedContext = value => {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, item]) => key === 'journal' && Array.isArray(item)
      ? item.some(id => id < 0 && merge.maps.learning_journal.get(-id)?.disposition === 'conflicts')
      : key === 'sensorRevert' && item?.id < 0 && merge.maps.learning_journal.get(-item.id)?.disposition === 'conflicts'
        || rejectedContext(item));
  };
  for (let index = recovered.length - 1; index >= 0; index--) if (rejectedContext(recovered[index].payload)) {
    const [entry] = recovered.splice(index, 1);
    merge.count('learning_journal', 'skipped');
    merge.report.counts.missing--; merge.report.tables.find(row => row.name === 'learning_journal').missing--;
    if (entry.row.kind === 'sample') merge.report.model.acceptedSamples--;
  }
  recovered.sort((a, b) => a.row.at - b.row.at || rank(a.row.kind) - rank(b.row.kind) || a.row.id - b.row.id);
  const replaced = new Set(recovered.map(entry => entry.replacesMissing).filter(id => id != null));
  let nextDonor = 0, batch = [], total = 0;
  const masterIds = new Map(), donorIds = new Map(), sources = new Map();
  const insert = target.db.prepare(`INSERT INTO learning_journal_entries(epoch,input,key,kind,at,algorithm_version,config_version,forecast_version,payload,source_entry_id)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const stage = (row, payload, origin) => {
    const key = origin === 'master' ? row.key : row.kind === 'sample' ? `${LEARNING_ALGORITHM}:sample:${row.at}`
      : `recovery:${runId}:${row.kind}:${row.id}`;
    const sourceId = origin === 'master' ? target.db.prepare('SELECT COALESCE(source_entry_id,id) id FROM learning_journal_entries WHERE id=?').get(row.id).id : null;
    // Sensor targets are journal IDs. Copy only that compact correction before
    // remapping it; ordinary master inputs keep their original source pointer.
    const value = origin === 'master' ? (row.kind === 'context' && JSON.parse(row.payload).value?.sensorRevert ? row.payload : null) : json(payload);
    const forecast = origin === 'master' ? null : row.forecast_version === null ? null
      : json(merge.remap({ forecastVersion: JSON.parse(row.forecast_version) }, { strict: true }).forecastVersion);
    const id = Number(insert.run(epoch, input, key, row.kind, row.at, row.algorithm_version, origin === 'master' ? null : row.config_version,
      forecast, value, sourceId).lastInsertRowid);
    (origin === 'master' ? masterIds : donorIds).set(row.id, id);
    sources.set(id, { origin, id: row.id, epoch: origin === 'master' ? sourceEpoch : null, donor: origin === 'donor' ? merge.digest : null });
  };
  const flush = async () => {
    target.transaction(() => { for (const row of batch) stage(...row); });
    total += batch.length; batch = []; progress({ phase: 'rebuilding', processed: total }); await yieldTurn();
  };
  const enqueue = async (row, payload, origin) => { batch.push([row, payload, origin]); if (batch.length === 64) await flush(); };
  try {
    for (const master of originals) {
      while (nextDonor < recovered.length && before(recovered[nextDonor].row, master)) {
        const row = recovered[nextDonor++]; await enqueue(row.row, row.payload, 'donor');
      }
      if (!replaced.has(master.id)) await enqueue(master, null, 'master');
    }
    while (nextDonor < recovered.length) { const row = recovered[nextDonor++]; await enqueue(row.row, row.payload, 'donor'); }
    if (batch.length) await flush();
  } finally { snapshot.close(); }
  // Remap journal provenance only after every projection ID is allocated.
  // The first explicit seed must precede the accepted history; recovery cannot
  // claim a later trained checkpoint as the seed for an earlier missing week.
  let after = 0, firstProjection = true;
  for (;;) {
    const rows = target.db.prepare('SELECT * FROM learning_journal_all WHERE epoch=? AND input=? AND id>? ORDER BY id LIMIT 64').all(epoch, input, after);
    if (!rows.length) break;
    target.transaction(() => {
      for (const row of rows) {
        let payload = JSON.parse(row.payload);
        if (firstProjection && row.algorithm_version === LEARNING_ALGORITHM) {
          if (!Object.hasOwn(payload, 'seed')) throw invalid('Recovered history has no valid seed before its first sample');
          firstProjection = false;
        }
        if (sources.get(row.id).origin === 'donor' || payload.value?.sensorRevert) {
          payload = journalReferences(payload, masterIds, donorIds, sources.get(row.id));
          target.db.prepare('UPDATE learning_journal_entries SET payload=? WHERE id=? AND epoch=?').run(json(payload), row.id, epoch);
        }
      }
    });
    after = rows.at(-1).id; await yieldTurn();
  }
  // Only fully remapped inputs are accepted immutable contributions. A worker
  // stopped during staging must not expose unresolved donor IDs as recoverable
  // history. Once any root is accepted, retain its full supporting epoch.
  after = 0;
  for (;;) {
    const rows = target.db.prepare('SELECT * FROM learning_journal_entries WHERE epoch=? AND source_entry_id IS NULL AND id>? ORDER BY id LIMIT 64').all(epoch, after);
    if (!rows.length) break;
    target.transaction(() => { for (const row of rows) {
      const original = donor.db.prepare('SELECT * FROM learning_journal WHERE id=?').get(sources.get(row.id).id);
      rememberContribution(target, recoveryId, 'learning_journal', row, original, donor);
      after = row.id;
    } });
    await yieldTurn();
  }
  const source = { ...fireplaceLearningContext(target, input), ...projectedSensorContext(target, input, epoch) };
  projection = { runId, epoch, sourceEpoch, sourceHead, sourceSensorRevision, source, sourceRevision: source.fireplaceRevision,
    masterIds, donorIds, checkpoint: null, after: 0, processed: 0, lastAt: -Infinity, merge };
  await replayProjection();
  return projection;
}
function rank(kind) { return kind === 'context' ? 0 : kind === 'sample' ? 1 : 2; }
function before(a, b) { return a.at < b.at || a.at === b.at && rank(a.kind) < rank(b.kind); }

async function replayProjection() {
  const p = projection;
  for (;;) {
    const rows = target.db.prepare('SELECT * FROM learning_journal_all WHERE epoch=? AND input=? AND id>? ORDER BY id LIMIT 64')
      .all(p.epoch, workerData.input, p.after);
    if (!rows.length) break;
    for (const row of rows) {
      if (row.algorithm_version !== LEARNING_ALGORITHM) { p.after = row.id; continue; }
      p.checkpoint = applyLearningRecord(p.checkpoint, decode(row), p.source);
      p.lastAt = Math.max(p.lastAt, row.at); p.after = row.id; p.processed++;
    }
    progress({ phase: 'rebuilding', processed: p.processed }); await yieldTurn();
  }
}

async function catchup() {
  const p = projection, input = workerData.input;
  if (epochOf(target, input) !== p.sourceEpoch || fireplaceLearningContext(target, input).fireplaceRevision !== p.sourceRevision
    || sensorRevision(target, input) !== p.sourceSensorRevision)
    throw invalid('Recovery source changed; check the other instance again');
  const through = head(target, input);
  for (;;) {
    const rows = target.db.prepare('SELECT * FROM learning_journal WHERE input=? AND id>? AND id<=? ORDER BY id LIMIT 64')
      .all(input, p.sourceHead, through);
    if (!rows.length) break;
    target.transaction(() => {
      for (const row of rows) {
        if (row.at < p.lastAt) throw invalid('A backdated master journal record requires a fresh recovery rebuild');
        const sourceId = target.db.prepare('SELECT COALESCE(source_entry_id,id) id FROM learning_journal_entries WHERE id=?').get(row.id).id;
        const id = Number(target.db.prepare(`INSERT INTO learning_journal_entries(epoch,input,key,kind,at,algorithm_version,source_entry_id)
          VALUES(?,?,?,?,?,?,?)`).run(p.epoch, input, row.key, row.kind, row.at, row.algorithm_version, sourceId).lastInsertRowid);
        p.masterIds.set(row.id, id); p.sourceHead = row.id;
      }
    });
    progress({ phase: 'catching-up', processed: p.processed }); await yieldTurn();
  }
  await replayProjection();
  parentPort.postMessage({ type: 'ready', epoch: p.epoch, sourceEpoch: p.sourceEpoch, sourceHead: p.sourceHead,
    sourceSensorRevision: p.sourceSensorRevision, sensorRevision: p.source.sensorRevision,
    fireplaceRevision: p.sourceRevision, checkpoint: p.checkpoint, runId: p.runId, recoveryId, sourceSelection, report: p.merge.report });
}

async function start() {
  const donorDigest = await open();
  sourceSelection = selectedHistory(target);
  if (workerData.mode === 'preview') { await checkSource(donorDigest); return; }
  recoveryId = beginRecovery(target, { input: workerData.input, donorDigest,
    source: workerData.source, operationId: workerData.operationId });
  originalFireplaceRevision = target.getState(`adaptive:${workerData.input}`)?.fireplaceRevision
    ?? fireplaceLearningContext(target, workerData.input).fireplaceRevision;
  const merge = new HistoryMerge({ target, donor, donorDigest, input: workerData.input, recoveryId, progress, yieldControl: yieldTurn });
  target.setState(`recovery:active:${workerData.input}`, { status: 'importing', recoveryId, startedAt: Date.now() });
  // A stopped worker can leave an unpublished projection. Remove only those
  // abandoned staging epochs, in bounded batches; successful prior epochs
  // remain the reconstruction archive for their original checkpoints.
  const abandoned = target.db.prepare(`SELECT r.id,r.epoch FROM recovery_runs r WHERE r.input=? AND r.status<>'complete'
    AND NOT EXISTS(SELECT 1 FROM learning_epochs e WHERE e.epoch=r.epoch)
    AND NOT EXISTS(SELECT 1 FROM learning_journal_entries j JOIN recovery_members m
      ON m.table_name='learning_journal' AND m.record_key=CAST(j.id AS TEXT) WHERE j.epoch=r.epoch)`).all(workerData.input);
  for (const run of abandoned) {
    for (;;) {
      const removed = target.db.prepare(`DELETE FROM learning_journal_entries WHERE id IN
        (SELECT id FROM learning_journal_entries WHERE epoch=? LIMIT 64)`).run(run.epoch).changes;
      if (!removed) break;
      await yieldTurn();
    }
    target.db.prepare('DELETE FROM recovery_runs WHERE id=?').run(run.id);
  }
  const report = await merge.run();
  report.sourceAssessment = sourceAssessment;
  if (sourceAssessment.skippedLearningRecords) {
    report.counts.skipped += sourceAssessment.skippedLearningRecords;
    report.tables.push({ name: 'other_learning_inputs', missing: 0, conflicts: 0, duplicates: 0,
      skipped: sourceAssessment.skippedLearningRecords });
  }
  if (recoveryId) target.db.prepare('UPDATE history_recoveries SET report=?,status=? WHERE id=?')
    .run(JSON.stringify(report), 'rebuilding', recoveryId);
  target.setState(`recovery:active:${workerData.input}`, { status: 'rebuilding', startedAt: Date.now() });
  // Nothing affected learning: still return a guarded publication message so
  // permission to overwrite the donor follows successful source verification.
  if (report.model.status === 'unchanged') {
    parentPort.postMessage({ type: 'ready', epoch: epochOf(target, workerData.input), sourceEpoch: epochOf(target, workerData.input),
      sourceHead: head(target, workerData.input), fireplaceRevision: fireplaceLearningContext(target, workerData.input).fireplaceRevision,
      sourceSensorRevision: sensorRevision(target, workerData.input), sensorRevision: sensorRevision(target, workerData.input),
      checkpoint: target.getState(`adaptive:${workerData.input}`), runId: null, recoveryId, sourceSelection, report });
    return;
  }
  await createProjection(merge, randomUUID());
  await catchup();
}

function cleanup() {
  try { donor?.close(); } catch {} try { target?.close(); } catch {}
  parentPort.close();
}
function failed(error) {
  try { if (target && workerData.mode !== 'preview') markRecoveryFailed(target, workerData.input); } catch {}
  parentPort.postMessage({ type: 'failed', ...recoveryFailure(error) }); cleanup();
}
async function handleMessage(message) {
  if (running) return;
  running = true;
  try {
    if (message.type === 'catchup') {
      if (projection) await catchup();
      else parentPort.postMessage({ type: 'ready', epoch: epochOf(target, workerData.input), sourceEpoch: epochOf(target, workerData.input),
        sourceHead: head(target, workerData.input), fireplaceRevision: fireplaceLearningContext(target, workerData.input).fireplaceRevision,
        sourceSensorRevision: sensorRevision(target, workerData.input), sensorRevision: sensorRevision(target, workerData.input),
        checkpoint: target.getState(`adaptive:${workerData.input}`), runId: null, recoveryId, sourceSelection, report: message.report });
    } else if (message.type === 'close') cleanup();
  } catch (error) { failed(error); }
  finally { running = false; }
}
// Startup does not accept catch-up commands. Register the listener afterwards:
// a referenced idle message port can stall asynchronous SQLite backup on Node 26.8.2.
// Messages sent after the ready response remain queued until this listener exists.
running = true;
await start().catch(failed);
running = false;
parentPort.on('message', handleMessage);
