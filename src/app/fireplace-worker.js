import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { applyLearningRecord, LEARNING_ALGORITHM } from './committed-learning.js';
import { fireplaceRevision } from './fireplace.js';
import { fireplaceLearningContext } from './fireplace-inputs.js';

// This connection cannot migrate schemas, alter events, or publish checkpoints.
const db = workerData.dbPath === ':memory:' ? null : new DatabaseSync(workerData.dbPath, { readOnly: true });
if (db) db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');
let checkpoint = null, source = null, processed = 0;
const decode = row => ({ id: row.id, key: row.key, kind: row.kind, at: row.at,
  algorithmVersion: row.algorithm_version, configVersion: row.config_version === null ? null : JSON.parse(row.config_version),
  forecastVersion: row.forecast_version === null ? null : JSON.parse(row.forecast_version), payload: JSON.parse(row.payload) });

parentPort.on('message', message => {
  try {
    if (message.type === 'rebuild') {
      checkpoint = null; processed = 0;
      source = db ? fireplaceLearningContext({ db }, workerData.input, message.revision) : message.source;
    }
    if (!source || source.fireplaceRevision !== message.revision
      || db && fireplaceRevision({ db }, workerData.input) !== message.revision) {
      parentPort.postMessage({ type: 'stale', revision: message.revision }); return;
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
      parentPort.postMessage({ type: 'progress', revision: source.fireplaceRevision, processed, journalCursor: after });
    }
    if (db && fireplaceRevision({ db }, workerData.input) !== message.revision) {
      parentPort.postMessage({ type: 'stale', revision: message.revision }); return;
    }
    parentPort.postMessage({ type: 'ready', revision: source.fireplaceRevision, checkpoint, processed, head: after });
  } catch {
    parentPort.postMessage({ type: 'failed', revision: message.revision, error: 'Fireplace model replay failed.' });
  }
});
