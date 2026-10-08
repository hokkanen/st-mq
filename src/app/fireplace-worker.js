import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { applyLearningRecord, LEARNING_ALGORITHM } from './committed-learning.js';
import { fireplaceRevision } from './fireplace.js';
import { fireplaceLearningContext } from './fireplace-inputs.js';
import { sensorLearningContext, sensorRevision } from './sensor-inputs.js';
import { findLearningPrefix, withPrefixRevisions } from '../recovery/learning-prefix.js';

// This connection cannot migrate schemas, alter events, or publish checkpoints.
const db = workerData.dbPath === ':memory:' ? null : new DatabaseSync(workerData.dbPath, { readOnly: true });
if (db) db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');
const store = db && { db, getState: key => {
  const row = db.prepare('SELECT value FROM state WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : null;
} };
let checkpoint = null, source = null, processed = 0, selection = null;
const currentEpoch = () => db?.prepare('SELECT epoch FROM learning_epochs WHERE input=?').get(workerData.input)?.epoch ?? 'original';
const decode = row => ({ id: row.id, key: row.key, kind: row.kind, at: row.at,
  algorithmVersion: row.algorithm_version, configVersion: row.config_version === null ? null : JSON.parse(row.config_version),
  forecastVersion: row.forecast_version === null ? null : JSON.parse(row.forecast_version), payload: JSON.parse(row.payload) });

// Prefix lookup yields while holding a read snapshot. Keep later catch-up
// requests behind it so they cannot replace the shared candidate mid-replay.
let messages = Promise.resolve();
parentPort.on('message', message => { messages = messages.then(() => replay(message)); });
async function replay(message) {
  const requested = { revision: message.revision, sensorRevision: message.sensorRevision, epoch: message.epoch };
  const stale = () => !selection || !source || selection.epoch !== message.epoch
    || source.fireplaceRevision !== message.revision || source.sensorRevision !== message.sensorRevision
    || db && (selection.epoch !== currentEpoch()
      || fireplaceRevision({ db }, workerData.input) !== message.revision
      || sensorRevision({ db }, workerData.input) !== message.sensorRevision);
  try {
    if (message.type === 'rebuild') {
      checkpoint = null; processed = 0;
      selection = requested;
      if (db) db.exec('BEGIN');
      try {
        source = db ? { ...fireplaceLearningContext({ db }, workerData.input, message.revision),
          ...sensorLearningContext({ db }, workerData.input, message.sensorRevision) } : message.source;
        // Corrections affect learning from the original load/sensor boundary,
        // not their later receipt. Source context and prefix proof share one
        // snapshot; absent proof still replays from the seed.
        if (store && Number.isFinite(message.affectedAt)) {
          const prefix = await findLearningPrefix(store, { input: workerData.input, epoch: message.epoch,
            earliest: message.affectedAt, fireplaceRevision: message.revision, sensorRevision: message.sensorRevision,
            yieldControl: () => new Promise(resolve => setImmediate(resolve)) });
          checkpoint = withPrefixRevisions(prefix?.checkpoint, source);
        }
      } finally { if (db) db.exec('ROLLBACK'); }
    }
    if (stale()) {
      parentPort.postMessage({ type: 'stale', ...requested }); return;
    }
    let after = checkpoint?.journalCursor ?? 0;
    for (;;) {
      const entries = db ? db.prepare(`SELECT * FROM learning_journal WHERE input=? AND algorithm_version=?
        AND id>? AND id<=? ORDER BY id LIMIT 128`).all(workerData.input, LEARNING_ALGORITHM, after, message.head).map(decode)
        : message.entries.filter(entry => entry.algorithmVersion === LEARNING_ALGORITHM && entry.id > after && entry.id <= message.head).slice(0, 128);
      if (!entries.length) break;
      for (const entry of entries) checkpoint = applyLearningRecord(checkpoint, entry,
        source);
      after = entries.at(-1).id; processed += entries.length;
      parentPort.postMessage({ type: 'progress', ...selection, processed, journalCursor: after });
    }
    if (stale()) {
      parentPort.postMessage({ type: 'stale', ...requested }); return;
    }
    parentPort.postMessage({ type: 'ready', ...selection, checkpoint, processed, head: after });
  } catch {
    parentPort.postMessage({ type: 'failed', ...requested, error: 'Model replay failed.' });
  }
}
