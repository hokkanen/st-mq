import { Worker } from 'node:worker_threads';
import { rm } from 'node:fs/promises';
import { learningVersion, validLearningCheckpoint, LEARNING_ALGORITHM } from '../app/committed-learning.js';
import { fireplaceLearningContext } from '../app/fireplace-inputs.js';
import { sensorRevision } from '../app/sensor-inputs.js';
import { markRecoveryFailed, projectedSensorContext } from './state.js';

const running = new WeakSet();
const validInput = input => {
  if (!['mqtt', 'providers', 'simulated', 'history'].includes(input)) throw new TypeError('Choose an existing learning input for recovery');
  return input;
};
const unavailable = message => Object.assign(new Error(message), { statusCode: 409 });
const journalHead = (store, input) => store.db.prepare('SELECT COALESCE(MAX(id),0) id FROM learning_journal WHERE input=?').get(input).id;

/** Read-only comparison. The worker scans a private SQLite backup, so a preview
 * never changes the live application database or waits for provider polling. */
export function recoveryPreview({ masterPath, donorPath, input = 'mqtt', workDirectory, onProgress = () => {}, signal }) {
  return workerJob({ mode: 'preview', masterPath, donorPath, input: validInput(input), workDirectory }, { onProgress, signal });
}
export const previewRecovery = recoveryPreview;

/** Accepted source rows commit in bounded worker batches. Until publication,
 * live learning continues appending to its original selected epoch. A crash
 * leaves idempotent source imports and an unpublished projection, never half a
 * checkpoint. onPublish runs synchronously with no intervening control tick. */
export async function recoverHistory({ store, donorPath, input = 'mqtt', preview, isCurrent = () => true,
  onPublish = () => {}, onProgress = () => {}, signal }) {
  validInput(input);
  if (store.path === ':memory:' || store.readOnly) throw new TypeError('Recovery requires the writable master database on disk');
  if (running.has(store)) throw unavailable('A recovery is already running');
  const { previewId, ...signed } = preview ?? {};
  if (typeof previewId !== 'string' || previewId !== learningVersion(signed)) throw unavailable('Check the other instance before recovering');
  if (!isCurrent()) throw unavailable('Recovery requires the current master');
  running.add(store);
  try {
    return await workerJob({ mode: 'recover', masterPath: store.path, donorPath, input, preview }, {
      signal, onProgress, onReady(message, worker) {
        if (!isCurrent()) throw unavailable('Master authority changed; recovery remains protected');
        const result = store.transaction(() => {
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
            const row = store.db.prepare(`SELECT * FROM learning_journal_all WHERE epoch=? AND input=? AND algorithm_version=? ORDER BY id DESC LIMIT 1`)
              .get(message.epoch, input, LEARNING_ALGORITHM);
            const last = row && { id: row.id, key: row.key, kind: row.kind, at: row.at, algorithmVersion: row.algorithm_version,
              configVersion: row.config_version === null ? null : JSON.parse(row.config_version),
              forecastVersion: row.forecast_version === null ? null : JSON.parse(row.forecast_version), payload: JSON.parse(row.payload) };
            if (message.sensorRevision !== projectedRevision
              || last && (last.algorithmVersion !== LEARNING_ALGORITHM || !validLearningCheckpoint(checkpoint, last)
                || (checkpoint.fireplaceRevision ?? 0) !== revision || (checkpoint.sensorRevision ?? 0) !== projectedRevision)
              || !last && checkpoint !== null) throw unavailable('Reconstructed model verification failed');
            store.db.prepare('INSERT INTO learning_epochs(input,epoch) VALUES(?,?) ON CONFLICT(input) DO UPDATE SET epoch=excluded.epoch')
              .run(input, message.epoch);
            if (checkpoint) store.setState(`adaptive:${input}`, checkpoint);
          }
          const report = { ...message.report, previewId, status: 'complete', imported: message.report.counts.missing,
            model: { ...message.report.model, status: message.runId ? 'rebuilt' : 'unchanged' } };
          store.setState(`recovery:active:${input}`, { status: 'complete', epoch: message.epoch, completedAt: Date.now(), report });
          store.setState(`pending-plan:${input}`, null);
          if (message.runId) store.setState(`fireplace:rebuild:${input}`, { status: 'current', revision,
            sensorRevision: message.sensorRevision, epoch: message.epoch, requiresRebuild: false, recoveryEpoch: message.epoch });
          if (message.runId) store.db.prepare("UPDATE recovery_runs SET status='complete',completed_at=?,report=?,source_head=?,fireplace_revision=? WHERE id=?")
            .run(Date.now(), JSON.stringify(report), message.sourceHead, revision, message.runId);
          store.event('history-recovery-completed', { input, imported: report.imported, skipped: report.counts.skipped,
            conflicts: report.counts.conflicts, epoch: message.epoch });
          return { report, checkpoint, epoch: message.epoch };
        });
        if (!result) { onProgress({ phase: 'catching-up', processed: 0 }); worker.postMessage({ type: 'catchup', report: message.report }); return null; }
        onPublish(result);
        return result;
      },
    });
  } catch (error) {
    try { markRecoveryFailed(store, input); } catch {}
    throw error;
  } finally { running.delete(store); }
}

function workerJob(workerData, { onProgress, onReady, signal }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData });
    let settled = false, temporary = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort);
      // Termination releases SQLite writer locks and disposes private scan
      // memory even if a peer loses authority during a large recovery.
      worker.postMessage({ type: 'close' });
      void worker.terminate().then(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); })
        .then(() => error ? reject(error) : resolve(result), () => error ? reject(error) : resolve(result));
    };
    const abort = () => finish(unavailable('Recovery was cancelled; the other instance remains protected'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('error', () => finish(new Error('Recovery worker failed; the previous model remains available.')));
    worker.on('exit', code => { if (!settled) finish(new Error(`Recovery worker stopped before completion (${code}).`)); });
    worker.on('message', message => {
      if (settled) return;
      try {
        if (message.type === 'temporary') temporary = message.path;
        else if (message.type === 'progress') onProgress?.({ phase: message.phase, processed: message.processed });
        else if (message.type === 'failed') finish(new Error(message.error));
        else if (message.type === 'complete') finish(null, message.report);
        else if (message.type === 'ready') { const result = onReady(message, worker); if (result) finish(null, result); }
      } catch (error) { finish(error); }
    });
  });
}
