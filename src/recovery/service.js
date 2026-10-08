import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { learningVersion, validLearningCheckpoint, LEARNING_ALGORITHM } from '../app/committed-learning.js';
import { fireplaceLearningContext } from '../app/fireplace-inputs.js';
import { sensorRevision } from '../app/sensor-inputs.js';
import { markRecoveryFailed, projectedSensorContext } from './state.js';
import { selectedHistory, recoveryEvidenceVersion } from './ledger.js';
import { RECOVERY_ERROR_CODES, recoveryFailure } from './errors.js';
import { saveLearningCheckpoint } from '../storage/learning-checkpoints.js';
export { listRecoveries } from './ledger.js';

const running = new WeakSet();
const validInput = input => {
  if (!['mqtt', 'providers', 'simulated', 'history'].includes(input)) throw new TypeError('Choose an existing learning input for recovery');
  return input;
};
const unavailable = message => Object.assign(new Error(message), { statusCode: 409, code: 'recovery_invalid', public: true });
const journalHead = (store, input) => store.learningJournalHead(input);

async function finishInterruptedRecovery(store, input, operationToken) {
  // Recording an interrupted job grants no publication or control authority.
  // Try only the immediately available writer turn: shutdown must not wait for
  // this diagnostic, and a queued cleanup must never outlive its operation.
  const cancellation = new AbortController();
  try {
    const saved = store.runWrite(() => markRecoveryFailed(store, input, { operationToken }), { signal: cancellation.signal });
    cancellation.abort();
    await saved;
  } catch { /* Startup reconciles a retained in-progress record if storage could not be admitted. */ }
}

/** Read-only source validation and inventory. No master backup or trial merge
 * is created; recovery makes acceptance decisions against current master data. */
export function recoveryPreview({ masterPath, donorPath, donorJournalPath, input = 'mqtt', onProgress = () => {}, signal }) {
  return workerJob({ mode: 'preview', masterPath, donorPath, donorJournalPath, input: validInput(input) }, { onProgress, signal });
}

/** Accepted source rows commit in bounded worker batches. Until publication,
 * live learning continues appending to its original selected epoch. A crash
 * leaves idempotent source imports and an unpublished projection, never half a
 * checkpoint. onPublish runs synchronously with no intervening control tick. */
export async function recoverHistory({ store, donorPath, donorJournalPath, input = 'mqtt', preview, isCurrent = () => true,
  onPublish = () => {}, onProgress = () => {}, signal, source, operationId }) {
  validInput(input);
  if (store.path === ':memory:' || store.readOnly) throw new TypeError('Recovery requires the writable master database on disk');
  if (running.has(store)) throw unavailable('A recovery is already running');
  const { previewId, ...signed } = preview ?? {};
  if (preview?.status !== 'checked' || preview?.model?.status !== 'not-assessed'
    || preview.counts !== undefined
    || typeof previewId !== 'string' || previewId !== learningVersion(signed)) throw unavailable('Check the other instance before recovering');
  if (!isCurrent()) throw unavailable('Recovery requires the current master');
  const operationToken = randomUUID();
  running.add(store);
  try {
    return await workerJob({ mode: 'recover', masterPath: store.path, donorPath, donorJournalPath, input, preview, source, operationId, operationToken }, {
      signal, onProgress,
      onYield: () => store.runWrite(() => {
        if (!isCurrent()) throw unavailable('Recovery authority changed; the previous model remains selected');
      }, { signal }),
      async onReady(message, worker) {
        if (!isCurrent()) throw unavailable('Master authority changed; recovery remains protected');
        const result = await store.runWrite(() => {
          if (signal?.aborted || !isCurrent()) throw unavailable('Recovery authority changed while waiting for storage');
          if (store.getState(`recovery:active:${input}`)?.operationToken !== operationToken)
            throw unavailable('The active recovery operation changed; review again');
          if (selectedHistory(store) !== message.sourceSelection) throw unavailable('Selected recovery history changed; check again');
          if (store.learningEpoch(input) !== message.sourceEpoch)
            throw unavailable('The selected model history changed during recovery');
          const revision = fireplaceLearningContext(store, input).fireplaceRevision;
          if (revision !== message.fireplaceRevision) throw unavailable('Manual source history changed; check the other instance again');
          if (sensorRevision(store, input) !== message.sourceSensorRevision)
            throw unavailable('Sensor correction history changed; check the other instance again');
          if (journalHead(store, input) !== message.sourceHead) return null;
          const checkpoint = message.checkpoint;
          if (message.runId) {
            const projectedRevision = projectedSensorContext(store, input, message.epoch).sensorRevision;
            const row = store.db.prepare(`SELECT * FROM learning_journal_all WHERE epoch=? AND input=? AND id=?`)
              .get(message.epoch, input, store.learningJournalHead(input,message.epoch));
            const last = row && { id: row.id, key: row.key, kind: row.kind, at: row.at, algorithmVersion: row.algorithm_version,
              configVersion: row.config_version === null ? null : JSON.parse(row.config_version),
              forecastVersion: row.forecast_version === null ? null : JSON.parse(row.forecast_version), payload: JSON.parse(row.payload) };
            if (message.sensorRevision !== projectedRevision
              || last && (last.algorithmVersion !== LEARNING_ALGORITHM || !validLearningCheckpoint(checkpoint, last)
                || (checkpoint.fireplaceRevision ?? 0) !== revision || (checkpoint.sensorRevision ?? 0) !== projectedRevision)
              || !last && checkpoint !== null) throw unavailable('Reconstructed model verification failed');
            store.db.prepare('INSERT INTO learning_epochs(input,epoch) VALUES(?,?) ON CONFLICT(input) DO UPDATE SET epoch=excluded.epoch')
              .run(input, message.epoch);
            saveLearningCheckpoint(store.db, { input, epoch:message.epoch, checkpoint:message.prefixCheckpoint });
            if (checkpoint) store.setState(`adaptive:${input}`, checkpoint);
          }
          const report = { ...message.report, previewId, status: 'complete', imported: message.report.counts.missing,
            recoveryId: message.recoveryId,
            model: { ...message.report.model, status: message.runId ? 'rebuilt' : 'unchanged' } };
          store.setState(`recovery:active:${input}`, { status: 'complete', epoch: message.epoch, completedAt: Date.now(), report });
          if (message.recoveryId) store.db.prepare('UPDATE history_recoveries SET status=?,completed_at=?,report=? WHERE id=?')
            .run('complete', Date.now(), JSON.stringify(report), message.recoveryId);
          store.setState(`pending-plan:${input}`, null);
          if (message.runId) store.setState(`fireplace:rebuild:${input}`, { status: 'current', revision,
            sensorRevision: message.sensorRevision, epoch: message.epoch, requiresRebuild: false, recoveryEpoch: message.epoch });
          if (message.runId) store.db.prepare("UPDATE recovery_runs SET status='complete',completed_at=?,report=?,source_head=?,fireplace_revision=? WHERE id=?")
            .run(Date.now(), JSON.stringify(report), message.sourceHead, revision, message.runId);
          store.event('history-recovery-completed', { input, imported: report.imported, skipped: report.counts.skipped,
            conflicts: report.counts.conflicts, epoch: message.epoch });
          const published = { report, checkpoint, epoch: message.epoch };
          store.afterCommit(() => onPublish(published));
          return published;
        }, { signal, isCurrent });
        if (!result) { await onProgress({ phase: 'catching-up', processed: 0 }); worker.postMessage({ type: 'catchup', report: message.report }); return null; }
        return result;
      },
    });
  } catch (error) {
    await finishInterruptedRecovery(store, input, operationToken);
    throw error;
  } finally { running.delete(store); }
}

async function workerJob(workerData, { onProgress, onReady, onYield, signal }) {
  if (signal?.aborted) throw unavailable('Recovery was cancelled; the other instance remains protected');
  try {
  return await new Promise((resolve, reject) => {
    const worker = new Worker(new URL(workerData.mode.startsWith('revision') ? './revision-worker.js' : './worker.js', import.meta.url), { workerData,
      ...(process.execArgv.some(value => value.startsWith('--input-type')) ? { execArgv: [] } : {}) });
    let settled = false, messages = Promise.resolve();
    const finish = (error, result) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort);
      // Termination releases SQLite writer locks and disposes private scan
      // memory even if a peer loses authority during a large recovery.
      worker.postMessage({ type: 'close' });
      void worker.terminate().then(() => error ? reject(error) : resolve(result), () => error ? reject(error) : resolve(result));
    };
    const abort = () => finish(unavailable('Recovery was cancelled; the other instance remains protected'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('error', error => {
      const failure = recoveryFailure(error, 'recovery_worker_failed');
      finish(Object.assign(new Error(failure.error), { code: failure.code }));
    });
    worker.on('exit', () => {
      // The final message may already be received while earlier asynchronous
      // progress persistence is still draining. Judge exit after those messages.
      messages = messages.then(() => {
        if (!settled) {
          const failure = recoveryFailure(null, 'recovery_worker_failed');
          finish(Object.assign(new Error(failure.error), { code: failure.code }));
        }
      });
    });
    worker.on('message', message => {
      messages = messages.then(async () => {
      if (settled) return;
      try {
        if (message.type === 'progress') {
          const { type, ...progress } = message; await onProgress?.(progress);
        }
        else if (message.type === 'yield') {
          // A turn alone can precede WriteQueue's delayed contention retry,
          // letting the worker repeatedly take its next lock first. A no-op
          // admitted behind pending controller writes is a durable ordering
          // barrier; it creates no journal commit of its own.
          await new Promise(resolve => setImmediate(resolve));
          if (settled) return;
          await onYield?.();
          if (!settled) worker.postMessage({ type: 'continue', id: message.id });
        }
        else if (message.type === 'failed') finish(Object.assign(new Error(message.error),
          { code: RECOVERY_ERROR_CODES.includes(message.code) ? message.code : 'recovery_failed' }));
        else if (message.type === 'complete') finish(null, message.report);
        else if (message.type === 'ready') { const result = await onReady(message, worker); if (result) finish(null, result); }
      } catch (error) {
        const failure = recoveryFailure(error);
        finish(Object.assign(new Error(failure.error), { code: failure.code, statusCode: error?.statusCode }));
      }
      });
    });
  });
  } catch (error) {
    if (signal?.aborted) throw unavailable('Recovery was cancelled; the other instance remains protected');
    throw error;
  }
}

export function previewRecoveryRevision({ store, input = 'mqtt', recoveryId, active, onProgress = () => {}, signal }) {
  validInput(input);
  if (store.readOnly || store.path === ':memory:' || typeof active !== 'boolean' || typeof recoveryId !== 'string')
    throw new TypeError('Choose a recovery in the current writable database');
  return workerJob({ mode: 'revision-preview', masterPath: store.path, input, recoveryId, active }, { onProgress, signal });
}

/** Publish the selected source revision and a complete caught-up model together.
 * Retained evidence is never deleted, and runtime permissions are never copied. */
export async function reviseRecovery({ store, input = 'mqtt', recoveryId, active, preview, isCurrent = () => true,
  onPublish = () => {}, onProgress = () => {}, signal }) {
  validInput(input);
  if (store.readOnly || store.path === ':memory:' || typeof active !== 'boolean' || typeof recoveryId !== 'string')
    throw new TypeError('Choose a recovery in the current writable database');
  if (running.has(store)) throw unavailable('A recovery is already running');
  if (!isCurrent()) throw unavailable('Recovery requires current write authority');
  const { previewId, ...checked } = preview ?? {};
  if (previewId !== learningVersion(checked) || checked.recoveryId !== recoveryId || checked.active !== active)
    throw unavailable('Review this recovery before changing it');
  const operationToken = randomUUID();
  running.add(store);
  try {
    await store.runWrite(() => store.setState(`recovery:active:${input}`, { status: 'rebuilding', recoveryId, revision: true, operationToken, startedAt: Date.now() }), { signal, isCurrent });
    return await workerJob({ mode: 'revision', masterPath: store.path, input, recoveryId, active, preview }, {
      signal, onProgress,
      onYield: () => store.runWrite(() => {
        if (!isCurrent()) throw unavailable('Recovery authority changed; the previous model remains selected');
      }, { signal }),
      async onReady(message, worker) {
        if (!isCurrent()) throw unavailable('Control authority changed; the previous history remains selected');
        const result = await store.runWrite(() => {
          if (signal?.aborted || !isCurrent()) throw unavailable('Recovery authority changed while waiting for storage');
          if (store.getState(`recovery:active:${input}`)?.operationToken !== operationToken)
            throw unavailable('The active recovery operation changed; review again');
          if (selectedHistory(store) !== message.sourceSelection || store.learningEpoch(input) !== message.sourceEpoch
            || fireplaceLearningContext(store, input).fireplaceRevision !== message.sourceFireplace
            || sensorRevision(store, input) !== message.sourceSensor)
            throw unavailable('Source history changed during reconstruction; review again');
          if (journalHead(store, input) !== message.sourceHead) return null;
          if (message.evidenceVersion !== null && message.evidenceVersion !== recoveryEvidenceVersion(store)) return null;
          const row = store.db.prepare('SELECT * FROM learning_journal_all WHERE epoch=? AND input=? AND id=?')
            .get(message.epoch, input,store.learningJournalHead(input,message.epoch));
          const last = row && { id: row.id, key: row.key, kind: row.kind, at: row.at, algorithmVersion: row.algorithm_version,
            configVersion: row.config_version === null ? null : JSON.parse(row.config_version),
            forecastVersion: row.forecast_version === null ? null : JSON.parse(row.forecast_version), payload: JSON.parse(row.payload) };
          if (message.modelChanged !== false && (last ? !validLearningCheckpoint(message.checkpoint, last) : message.checkpoint !== null))
            throw unavailable('The reconstructed model could not be verified');
          const report = { ...message.report, previewId, status: 'complete', model: { status: message.modelChanged === false ? 'unchanged' : 'rebuilt' } };
          store.db.prepare('UPDATE history_selection SET generation=? WHERE id=1').run(message.generation);
          store.db.prepare('INSERT INTO learning_epochs(input,epoch) VALUES(?,?) ON CONFLICT(input) DO UPDATE SET epoch=excluded.epoch')
            .run(input, message.epoch);
          if (message.modelChanged !== false)
            saveLearningCheckpoint(store.db, { input, epoch:message.epoch, checkpoint:message.prefixCheckpoint });
          store.db.prepare('UPDATE history_recoveries SET active=? WHERE id=? AND input=?').run(Number(active), recoveryId, input);
          store.db.prepare('INSERT INTO recovery_decisions(recovery_id,active,at,generation,epoch,report) VALUES(?,?,?,?,?,?)')
            .run(recoveryId, Number(active), Date.now(), message.generation, message.epoch, JSON.stringify(report));
          if (message.modelChanged !== false) store.setState(`adaptive:${input}`, message.checkpoint);
          store.setState(`pending-plan:${input}`, null);
          store.setState(`fireplace:rebuild:${input}`, { status: 'current', revision: message.fireplaceRevision,
            sensorRevision: message.sensorRevision, epoch: message.epoch, requiresRebuild: false });
          store.setState(`recovery:active:${input}`, { status: 'complete', epoch: message.epoch, completedAt: Date.now(), report });
          store.event(active ? 'history-recovery-restored' : 'history-recovery-reverted', { recoveryId, input }, Date.now());
          const published = { report, checkpoint: message.checkpoint, epoch: message.epoch };
          store.afterCommit(() => onPublish(published));
          return published;
        }, { signal, isCurrent });
        if (!result) { await onProgress({ phase: 'catching-up', processed: 0 }); worker.postMessage({ type: 'catchup' }); return null; }
        return result;
      },
    });
  } catch (error) {
    await finishInterruptedRecovery(store, input, operationToken);
    throw error;
  } finally { running.delete(store); }
}
