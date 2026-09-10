import { parentPort, workerData } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { Store } from '../storage/store.js';
import { HistoryMerge } from './merge.js';
import { markRecoveryFailed } from './state.js';
import { applyLearningRecord, learningVersion, LEARNING_ALGORITHM, LEARNING_WINDOW_MS } from '../app/committed-learning.js';
import { fireplaceLearningContext } from '../app/fireplace-inputs.js';

const json = JSON.stringify;
const decode = row => ({ id: row.id, key: row.key, kind: row.kind, at: row.at,
  algorithmVersion: row.algorithm_version, configVersion: row.config_version === null ? null : JSON.parse(row.config_version),
  forecastVersion: row.forecast_version === null ? null : JSON.parse(row.forecast_version), payload: JSON.parse(row.payload) });
const head = (store, input) => store.db.prepare('SELECT COALESCE(MAX(id),0) id FROM learning_journal WHERE input=?').get(input).id;
const epochOf = (store, input) => store.learningEpoch(input);
const invalid = message => Object.assign(new Error(message), { code: 'RECOVERY_INVALID' });
let target, donor, temporary, running = false, projection = null;
let originalFireplaceRevision = 0;
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
  if (donor.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw invalid('Donor database integrity check failed');
  // Semantic rows with missing references are rejected individually by merge;
  // only physical database corruption prevents scanning the donor altogether.
  const donorDigest = await fileDigest(workerData.donorPath);
  if (workerData.mode === 'preview') {
    const base = workerData.workDirectory ?? join(dirname(workerData.masterPath), 'recovery');
    mkdirSync(base, { recursive: true, mode: 0o700 });
    temporary = mkdtempSync(join(base, 'preview-')); chmodSync(temporary, 0o700);
    parentPort.postMessage({ type: 'temporary', path: temporary });
    const master = new Store(workerData.masterPath, { readOnly: true });
    try { await master.backup(join(temporary, 'candidate.sqlite')); } finally { master.close(); }
    target = new Store(join(temporary, 'candidate.sqlite'));
  } else {
    if (donorDigest !== workerData.preview?.donorDigest || workerData.preview?.input !== workerData.input)
      throw invalid('Recovery preview is stale; check the other instance again');
    target = new Store(workerData.masterPath);
  }
  return donorDigest;
}

function journalReferences(value, masterIds, donorIds, source) {
  const result = structuredClone(value);
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
        AND json_valid(payload) AND json_type(payload,'$.value.indoorC') IN ('integer','real')
        AND json_type(payload,'$.value.outdoorC') IN ('integer','real')
        AND NOT EXISTS (SELECT 1 FROM json_each(learning_journal.payload,'$.value.quality') q
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
      ? item.some(id => id < 0 && merge.maps.learning_journal.get(-id)?.disposition === 'conflicts') : rejectedContext(item));
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
    const value = origin === 'master' ? null : json(payload);
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
        if (sources.get(row.id).origin === 'donor') {
          payload = journalReferences(payload, masterIds, donorIds, sources.get(row.id));
          target.db.prepare('UPDATE learning_journal_entries SET payload=? WHERE id=? AND epoch=?').run(json(payload), row.id, epoch);
        }
      }
    });
    after = rows.at(-1).id; await yieldTurn();
  }
  const source = fireplaceLearningContext(target, input);
  projection = { runId, epoch, sourceEpoch, sourceHead, source, sourceRevision: source.fireplaceRevision,
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
  if (epochOf(target, input) !== p.sourceEpoch || fireplaceLearningContext(target, input).fireplaceRevision !== p.sourceRevision)
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
    fireplaceRevision: p.sourceRevision, checkpoint: p.checkpoint, runId: p.runId, report: p.merge.report });
}

async function start() {
  const donorDigest = await open();
  originalFireplaceRevision = target.getState(`adaptive:${workerData.input}`)?.fireplaceRevision
    ?? fireplaceLearningContext(target, workerData.input).fireplaceRevision;
  const merge = new HistoryMerge({ target, donor, donorDigest, input: workerData.input, progress });
  if (workerData.mode !== 'preview') {
    target.setState(`recovery:active:${workerData.input}`, { status: 'importing', startedAt: Date.now() });
    // A stopped worker can leave an unpublished projection. Remove only those
    // abandoned staging epochs, in bounded batches; successful prior epochs
    // remain the reconstruction archive for their original checkpoints.
    const abandoned = target.db.prepare(`SELECT r.id,r.epoch FROM recovery_runs r WHERE r.input=? AND r.status<>'complete'
      AND NOT EXISTS(SELECT 1 FROM learning_epochs e WHERE e.epoch=r.epoch)`).all(workerData.input);
    for (const run of abandoned) {
      for (;;) {
        const removed = target.db.prepare(`DELETE FROM learning_journal_entries WHERE id IN
          (SELECT id FROM learning_journal_entries WHERE epoch=? LIMIT 64)`).run(run.epoch).changes;
        if (!removed) break;
        await yieldTurn();
      }
      target.db.prepare('DELETE FROM recovery_runs WHERE id=?').run(run.id);
    }
  }
  const report = await merge.run();
  if (workerData.mode === 'preview') {
    const publicReport = { ...report, donorDigest, input: workerData.input };
    publicReport.previewId = learningVersion(publicReport);
    parentPort.postMessage({ type: 'complete', report: publicReport }); cleanup(); return;
  }
  target.setState(`recovery:active:${workerData.input}`, { status: 'rebuilding', startedAt: Date.now() });
  // Nothing affected learning: still return a guarded publication message so
  // permission to overwrite the donor follows successful source verification.
  if (report.model.status === 'unchanged') {
    parentPort.postMessage({ type: 'ready', epoch: epochOf(target, workerData.input), sourceEpoch: epochOf(target, workerData.input),
      sourceHead: head(target, workerData.input), fireplaceRevision: fireplaceLearningContext(target, workerData.input).fireplaceRevision,
      checkpoint: target.getState(`adaptive:${workerData.input}`), runId: null, report });
    return;
  }
  await createProjection(merge, randomUUID());
  await catchup();
}

function cleanup() {
  try { donor?.close(); } catch {} try { target?.close(); } catch {}
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  parentPort.close();
}
function failed(error) {
  try { if (target && workerData.mode !== 'preview') markRecoveryFailed(target, workerData.input); } catch {}
  parentPort.postMessage({ type: 'failed', error: error?.code === 'RECOVERY_INVALID' ? error.message
    : 'Recovery failed; accepted history remains valid and the previous model remains active.' }); cleanup();
}
parentPort.on('message', async message => {
  if (running) return;
  running = true;
  try {
    if (message.type === 'catchup') {
      if (projection) await catchup();
      else parentPort.postMessage({ type: 'ready', epoch: epochOf(target, workerData.input), sourceEpoch: epochOf(target, workerData.input),
        sourceHead: head(target, workerData.input), fireplaceRevision: fireplaceLearningContext(target, workerData.input).fireplaceRevision,
        checkpoint: target.getState(`adaptive:${workerData.input}`), runId: null, report: message.report });
    } else if (message.type === 'close') cleanup();
  } catch (error) { failed(error); }
  finally { running = false; }
});
running = true;
start().catch(failed).finally(() => { running = false; });
