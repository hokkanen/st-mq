import { validLearningCheckpoint, LEARNING_ALGORITHM } from '../app/committed-learning.js';
import { fireplaceLearningContext } from '../app/fireplace-inputs.js';
import { sensorRevision } from '../app/sensor-inputs.js';
import { projectedSensorContext } from './state.js';
import { selectedHistory, recoveryEvidenceVersion } from './ledger.js';
import { saveLearningCheckpoint } from '../storage/learning-checkpoints.js';

const unavailable = message => Object.assign(new Error(message), { statusCode: 409, code: 'recovery_invalid', public: true });
const journalHead = (store, input) => store.learningJournalHead(input);

// The publication worker owns the surrounding transaction and cancellation
// fence. Each complete model and its selected source history commit together.
export function publishRecovery(store, input, message, { operationToken, previewId }) {
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
    // A valid empty replacement selects no model. Keeping the old cache would
    // pair the new empty epoch with learning from its previous interpretation.
    store.setState(`adaptive:${input}`, checkpoint);
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
  return published;
}

export function publishRevision(store, input, message, { operationToken, previewId, recoveryId, active }) {
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
  return published;
}
