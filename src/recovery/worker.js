import { parentPort, workerData } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { yieldToController as yieldTurn } from './scheduler.js';
import { Store } from '../storage/store.js';
import { readBackupMetadata } from '../storage/backup-metadata.js';
import { HistoryMerge, RECOVERY_POLICY } from './merge.js';
import { RECOVERABLE_TABLES } from '../storage/schema.js';
import { markRecoveryFailed, projectedSensorContext } from './state.js';
import { applyLearningRecord, learningVersion, LEARNING_ALGORITHM, LEARNING_WINDOW_MS } from '../app/committed-learning.js';
import { fireplaceLearningContext } from '../app/fireplace-inputs.js';
import { sensorRevision } from '../app/sensor-inputs.js';
import { beginRecovery, rememberContribution, selectedHistory } from './ledger.js';
import { assessRecoverySource } from './source-scope.js';
import { recoveryFailure } from './errors.js';
import { ScratchMap } from './scratch.js';
import { recoveryCoverageReport } from './coverage-report.js';
import { commonCheckpoint, changedRecordKeys } from '../storage/journal.js';
import { scopeIncrementalSource, openJournalSource } from './incremental-source.js';
import { findLearningPrefix, retainLearningPrefix, prefixSourceId, withPrefixRevisions } from './learning-prefix.js';

const json = JSON.stringify;
const decode = row => ({ id: row.id, key: row.key, kind: row.kind, at: row.at,
  algorithmVersion: row.algorithm_version, configVersion: row.config_version === null ? null : JSON.parse(row.config_version),
  forecastVersion: row.forecast_version === null ? null : JSON.parse(row.forecast_version), payload: JSON.parse(row.payload) });
const head = (store, input) => store.learningJournalHead(input);
const epochOf = (store, input) => store.learningEpoch(input);
const invalid = message => Object.assign(new Error(message), { code: 'RECOVERY_INVALID' });
let target, donor, running = false, projection = null;
let originalFireplaceRevision = 0;
let recoveryId = null, sourceSelection = null, sourceAssessment = null;
let progressAt = 0, progressPhase = null;
const progress = value => {
  if (Date.now() - progressAt > 100 || value.phase !== progressPhase || value.total === value.processed) {
    parentPort.postMessage({ type: 'progress', ...value }); progressAt = Date.now(); progressPhase = value.phase;
  }
};

async function fileDigest(path) {
  const hash = createHash('sha256'), total = (await stat(path)).size;
  let processed = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk); processed += chunk.length; progress({ phase: 'validating', processed, total, unit: 'bytes' });
  }
  return hash.digest('hex');
}

async function open() {
  progress({ phase:'validating',processed:0 });
  target=new Store(workerData.masterPath,{readOnly:workerData.mode==='preview'});
  if(workerData.mode==='preview') { target.db.exec('BEGIN'); target.db.prepare('PRAGMA schema_version').get(); }
  let donorDigest;
  if(workerData.donorJournalPath) {
    donor=await openJournalSource({masterPath:workerData.masterPath,journalPath:workerData.donorJournalPath});
    donorDigest=donor.incremental.checkpoint.hash;
  } else {
    const sourceFile=await stat(workerData.donorPath);
    donor=new Store(workerData.donorPath,{readOnly:true});
    donor.db.exec('BEGIN'); donor.db.prepare('PRAGMA schema_version').get();
    const base=commonCheckpoint(target.db,donor.db);
    if(base) {
      const checkpoint=donor.checkpoint();
      await scopeIncrementalSource(donor,{base,checkpoint,changes:changedRecordKeys(donor.db,{after:base,through:checkpoint})});
      donorDigest=checkpoint.hash;
    } else {
      // An unrelated external backup has no authenticated common prefix.
      // Its complete inventory is an explicit exceptional source repair.
      if(donor.db.prepare('PRAGMA journal_mode').get().journal_mode!=='delete')
        throw Object.assign(new Error('Recovery requires a self-contained database snapshot'),{code:'recovery_source_not_snapshot'});
      if(donor.db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')
        throw Object.assign(new Error('Donor database integrity check failed'),{code:'recovery_database_corrupt'});
      donorDigest=await fileDigest(workerData.donorPath);
      const checkedFile=await stat(workerData.donorPath);
      if(['dev','ino','size','mtimeMs','ctimeMs'].some(field=>sourceFile[field]!==checkedFile[field]))
        throw invalid('The source database changed while checking it. Use a saved export and check again.');
    }
  }
  sourceAssessment=assessRecoverySource(donor,workerData.input);
  if(workerData.mode!=='preview') {
    if(donorDigest!==workerData.preview?.donorDigest || workerData.preview?.input!==workerData.input)
      throw invalid('Recovery preview is stale; check the other instance again');
    if(workerData.preview?.sourceSelection!==selectedHistory(target)) throw invalid('Selected history changed; check the source again');
    if(Boolean(workerData.preview?.incremental)!==Boolean(donor.incremental)
      || donor.incremental && learningVersion(workerData.preview.incremental)!==learningVersion(donor.incremental))
      throw invalid('The shared recovery checkpoint changed; check the source again');
  }
  target.db.exec('PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-8192;');
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
  tables.push({ name: 'learning_journal', count: donor.db.prepare(`SELECT COUNT(*) count FROM ${donor.recoveryJournal ?? 'learning_journal'} WHERE input=?`).get(workerData.input).count });
  tables.push({ name: 'charging_session_keys', count: donor.db.prepare(`SELECT COUNT(*) count FROM ${donor.recoveryState ?? 'state'} WHERE key LIKE 'charging-session-check:%'`).get().count });
  tables.push({ name: 'recorder_pending_energy', count: donor.db.prepare(`SELECT COUNT(*) count FROM ${donor.recoveryState ?? 'state'}
    WHERE key LIKE 'recorder:energy:%' AND json_valid(value) AND json_type(value,'$.pending')='object'`).get().count });
  if (sourceAssessment.skippedLearningRecords)
    tables.push({ name: 'other_learning_inputs', count: sourceAssessment.skippedLearningRecords });
  const unsupported = ['charging_reports', 'charging_report_events'].map(name => ({ name,
    count: donor.incremental ? donor.db.prepare('SELECT COUNT(*) count FROM recovery_source_keys WHERE table_name=?').get(name).count : donor.db.prepare(`SELECT COUNT(*) count FROM ${name}`).get().count,
    reason: 'Saved charging reports are not included in history recovery.' })).filter(row => row.count > 0);
  const report = { status: 'checked', policy: RECOVERY_POLICY, tables, model: { status: 'not-assessed' },
    donorDigest, input: workerData.input, sourceSelection, sourceAssessment, unsupported };
  const sourceSoftware = readBackupMetadata(donor.db);
  if (sourceSoftware) report.sourceSoftware = sourceSoftware;
  if (donor.incremental) report.incremental = donor.incremental;
  else report.coverage = await recoveryCoverageReport({ master: target, donor, input: workerData.input,
    yieldControl: yieldTurn, progress });
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
  target.db.exec('CREATE TEMP TABLE recovery_accepted_journal(id INTEGER PRIMARY KEY,at INTEGER,rank INTEGER,entry TEXT,replaces_missing INTEGER)');
  const accept = target.db.prepare('INSERT INTO recovery_accepted_journal(id,at,rank,entry,replaces_missing) VALUES(?,?,?,?,?)');
  for (const entry of merge.journal) {
    const old = snapshot.db.prepare('SELECT * FROM learning_journal WHERE input=? AND kind=? AND at=? ORDER BY id DESC LIMIT 1')
      .get(input, entry.row.kind, entry.row.at);
    // Live recording continues during the source scan. If it filled this
    // window meanwhile, its committed input wins before staging the projection.
    let conflicts = old && old.id !== entry.replacesMissing;
    if (entry.row.kind === 'sample') {
      const value = entry.payload.value;
      conflicts = snapshot.db.prepare(`SELECT 1 FROM learning_journal WHERE input=? AND kind='sample' AND at>? AND at<?
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
        .get(input,value.windowStart??entry.row.at-LEARNING_WINDOW_MS,(value.windowEnd??entry.row.at)+LEARNING_WINDOW_MS,
          LEARNING_WINDOW_MS,value.windowEnd??entry.row.at,value.windowStart??entry.row.at-LEARNING_WINDOW_MS);
    }
    if (conflicts) {
      merge.count('learning_journal', 'conflicts');
      merge.report.counts.missing--; merge.report.tables.find(row => row.name === 'learning_journal').missing--;
      if (entry.row.kind === 'sample') merge.report.model.acceptedSamples--;
      if (old) merge.maps.learning_journal.set(entry.row.id, { id: old.id, disposition: 'conflicts' });
    } else accept.run(entry.row.id, entry.row.at, rank(entry.row.kind), json(entry), entry.replacesMissing ?? null);
  }
  const rejectedContext = value => {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, item]) => key === 'journal' && Array.isArray(item)
      ? item.some(id => id < 0 && merge.maps.learning_journal.get(-id)?.disposition === 'conflicts')
      : key === 'sensorRevert' && item?.id < 0 && merge.maps.learning_journal.get(-item.id)?.disposition === 'conflicts'
        || rejectedContext(item));
  };
  let acceptedAfter = 0;
  for (;;) {
    const rows = target.db.prepare('SELECT id,entry FROM recovery_accepted_journal WHERE id>? ORDER BY id LIMIT 64').all(acceptedAfter);
    if (!rows.length) break;
    for (const row of rows) {
      const entry = JSON.parse(row.entry);
      if (rejectedContext(entry.payload)) {
        target.db.prepare('DELETE FROM recovery_accepted_journal WHERE id=?').run(row.id);
        merge.count('learning_journal', 'skipped');
        merge.report.counts.missing--; merge.report.tables.find(row => row.name === 'learning_journal').missing--;
        if (entry.row.kind === 'sample') merge.report.model.acceptedSamples--;
      }
      acceptedAfter = row.id;
    }
    await yieldTurn();
  }
  target.db.exec('CREATE INDEX recovery_accepted_order ON recovery_accepted_journal(at,rank,id); CREATE INDEX recovery_accepted_replacement ON recovery_accepted_journal(replaces_missing)');
  let earliest=target.db.prepare('SELECT MIN(at) at FROM recovery_accepted_journal').get().at ?? Infinity;
  for(const row of target.db.prepare(`SELECT entry FROM recovery_accepted_journal
    WHERE json_type(entry,'$.payload.value.sensorRevert')='object'`).iterate()) {
    const targetId=JSON.parse(row.entry).payload.value.sensorRevert.id;
    const affected=targetId<0 ? target.db.prepare('SELECT at FROM recovery_accepted_journal WHERE id=?').get(-targetId)
      : snapshot.db.prepare('SELECT at FROM learning_journal_entries WHERE id=? AND input=?').get(targetId,input);
    earliest=Math.min(earliest,affected?.at??-Infinity);
  }
  // Removing a load changes heat from the load's original time. Its later
  // correction/report time cannot license reuse of an already affected model.
  const fireplace=target.db.prepare(`SELECT MIN(CASE WHEN e.kind='remove' THEN p.at ELSE e.at END) at
    FROM active_fireplace_events e
    LEFT JOIN fireplace_events p ON p.id=e.target_id
    WHERE e.id>? AND e.input=?`).get(originalFireplaceRevision,input);
  if(fireplace.at!==null) earliest=Math.min(earliest,fireplace.at);
  const prefix=await findLearningPrefix(snapshot,{input,epoch:sourceEpoch,earliest,
    fireplaceRevision:originalFireplaceRevision,sensorRevision:sourceSensorRevision});
  retainLearningPrefix(target,{input,epoch,prefix});
  const originals=snapshot.db.prepare(`SELECT * FROM learning_journal WHERE input=? AND id>?
    ORDER BY at,CASE kind WHEN 'context' THEN 0 WHEN 'sample' THEN 1 ELSE 2 END,id`).iterate(input,prefix?.cursor??0);

  function* acceptedRows() {
    let cursor = null;
    for (;;) {
      const rows = target.db.prepare(`SELECT id,at,rank,entry FROM recovery_accepted_journal
        WHERE ? IS NULL OR (at,rank,id)>(?,?,?) ORDER BY at,rank,id LIMIT 64`)
        .all(cursor?.id ?? null, cursor?.at ?? 0, cursor?.rank ?? 0, cursor?.id ?? 0);
      if (!rows.length) return;
      for (const row of rows) { cursor = row; yield row; }
    }
  }
  // A TEMP iterator on the writer connection can keep later MAIN reads pinned
  // across a yield. Finalize each bounded read before another commit begins.
  const recovered = acceptedRows();
  let nextDonor = recovered.next(), batch = [], total = 0;
  const masterIds = new ScratchMap(target.db, 'projection-master'), donorIds = new ScratchMap(target.db, 'projection-donor'),
    sources = new ScratchMap(target.db, 'projection-sources');
  for (const map of [masterIds, donorIds, sources]) map.initialize();
  const lookupMaster=masterIds.get.bind(masterIds);
  masterIds.get=id=>lookupMaster(id)??prefixSourceId(target,{input,epoch:sourceEpoch,prefix,id});
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
    total += batch.length; batch = []; progress({ phase: 'projecting', processed: total, unit: 'entries' }); await yieldTurn();
  };
  const enqueue = async (row, payload, origin) => { batch.push([row, payload, origin]); if (batch.length === 64) await flush(); };
  try {
    for (const master of originals) {
      while (!nextDonor.done && before(JSON.parse(nextDonor.value.entry).row, master)) {
        const row = JSON.parse(nextDonor.value.entry); await enqueue(row.row, row.payload, 'donor'); nextDonor = recovered.next();
      }
      if (!target.db.prepare('SELECT 1 FROM recovery_accepted_journal WHERE replaces_missing=? LIMIT 1').get(master.id))
        await enqueue(master, null, 'master');
    }
    while (!nextDonor.done) {
      const row = JSON.parse(nextDonor.value.entry); await enqueue(row.row, row.payload, 'donor'); nextDonor = recovered.next();
    }
    if (batch.length) await flush();
  } finally { snapshot.close(); }
  // Remap journal provenance only after every projection ID is allocated.
  // The first explicit seed must precede the accepted history; recovery cannot
  // claim a later trained checkpoint as the seed for an earlier missing week.
  let after = prefix?.cursor??0, firstProjection = !prefix;
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
  const prefixCheckpoint = withPrefixRevisions(prefix?.checkpoint,source);
  projection = { runId, epoch, sourceEpoch, sourceHead, sourceSensorRevision, source, sourceRevision: source.fireplaceRevision,
    masterIds, donorIds, prefixCheckpoint, checkpoint: prefixCheckpoint, after: prefix?.cursor??0, processed: 0, lastAt: prefix?.at??-Infinity, merge };
  await replayProjection();
  return projection;
}
function rank(kind) { return kind === 'context' ? 0 : kind === 'sample' ? 1 : 2; }
function before(a, b) { return a.at < b.at || a.at === b.at && rank(a.kind) < rank(b.kind); }

async function replayProjection() {
  const p = projection;
  const total = target.db.prepare('SELECT COUNT(*) total FROM learning_journal_entries WHERE epoch=? AND input=?').get(p.epoch, workerData.input).total;
  for (;;) {
    const rows = target.db.prepare('SELECT * FROM learning_journal_all WHERE epoch=? AND input=? AND id>? ORDER BY id LIMIT 64')
      .all(p.epoch, workerData.input, p.after);
    if (!rows.length) break;
    for (const row of rows) {
      if (row.algorithm_version !== LEARNING_ALGORITHM) { p.after = row.id; continue; }
      p.checkpoint = applyLearningRecord(p.checkpoint, decode(row), p.source);
      p.lastAt = Math.max(p.lastAt, row.at); p.after = row.id; p.processed++;
    }
    progress({ phase: 'rebuilding', processed: p.processed, total, unit: 'entries' }); await yieldTurn();
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
  progress({ phase: 'publishing', processed: 0 });
  parentPort.postMessage({ type: 'ready', epoch: p.epoch, sourceEpoch: p.sourceEpoch, sourceHead: p.sourceHead,
    sourceSensorRevision: p.sourceSensorRevision, sensorRevision: p.source.sensorRevision,
    fireplaceRevision: p.sourceRevision, checkpoint: p.checkpoint, prefixCheckpoint:p.prefixCheckpoint,
    runId: p.runId, recoveryId, sourceSelection, report: p.merge.report });
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
  target.setState(`recovery:active:${workerData.input}`, { status: 'importing', recoveryId, operationToken: workerData.operationToken, startedAt: Date.now() });
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
    target.db.prepare('DELETE FROM learning_epoch_segments WHERE epoch=?').run(run.epoch);
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
  target.setState(`recovery:active:${workerData.input}`, { status: 'rebuilding', recoveryId, operationToken: workerData.operationToken, startedAt: Date.now() });
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
  try { if (target && workerData.mode !== 'preview') markRecoveryFailed(target, workerData.input, { operationToken: workerData.operationToken }); } catch {}
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
