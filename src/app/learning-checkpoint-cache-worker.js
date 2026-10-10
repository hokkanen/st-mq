import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '../storage/store.js';
import { LEARNING_ALGORITHM, learningVersion, validLearningCheckpoint } from './committed-learning.js';
import { sensorRevision } from './sensor-inputs.js';

const cancelled = new Int32Array(workerData.cancellation);
const writable = () => Atomics.load(cancelled, 0) === 0;
const boundary = (store, epoch, cursor) => {
  const row = store.db.prepare('SELECT * FROM learning_journal_all WHERE epoch=? AND input=? AND id=?')
    .get(epoch, workerData.input, cursor);
  return row && { id: row.id, key: row.key, kind: row.kind, at: row.at, algorithmVersion: row.algorithm_version,
    configVersion: row.config_version === null ? null : JSON.parse(row.config_version),
    forecastVersion: row.forecast_version === null ? null : JSON.parse(row.forecast_version), payload: JSON.parse(row.payload) };
};
const matchesBoundary = (checkpoint, entry) => entry && checkpoint.journalCursor === entry.id
  && entry.algorithmVersion === LEARNING_ALGORITHM && checkpoint.configVersion === entry.configVersion
  && checkpoint.journalEntryHash === learningVersion(entry);
let store;
try {
  // A missing or replaced path must not become a new writable database.
  const source = new Store(workerData.dbPath, { readOnly: true });
  try {
    if (!writable() || source.checkpoint().databaseId !== workerData.databaseId) throw new Error('stale');
  } finally { source.close(); }
  if (!writable()) throw new Error('cancelled');
  store = new Store(workerData.dbPath);
  // Admission retries belong to this worker, while the parent remains free to
  // revoke its shared cancellation flag and join termination during demotion.
  store.db.exec('PRAGMA busy_timeout=0;');
  parentPort.on('message', async message => {
    if (message?.type !== 'save') return;
    let status = 'failed', journalCursor = null;
    try {
      const checkpoint = JSON.parse(message.payload), fences = message.fences;
      // Hash the complete candidate before taking SQLite's sole writer lock.
      // Immutable-boundary identity and current source fences are checked inside.
      if (!validLearningCheckpoint(checkpoint)) throw new Error('invalid checkpoint');
      status = await store.runWrite(() => {
        if (!writable()) return 'cancelled';
        if (store.checkpoint().databaseId !== fences.databaseId || store.learningEpoch(workerData.input) !== fences.epoch
          || store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation !== fences.selection
          || store.db.prepare('SELECT COALESCE(MAX(id),0) revision FROM active_fireplace_events WHERE input=?')
            .get(workerData.input).revision !== fences.fireplaceRevision
          || sensorRevision(store, workerData.input) !== fences.sensorRevision
          || (checkpoint?.fireplaceRevision ?? 0) !== fences.fireplaceRevision
          || (checkpoint?.sensorRevision ?? 0) !== fences.sensorRevision) return 'stale';
        const last = boundary(store, fences.epoch, checkpoint?.journalCursor);
        if (!matchesBoundary(checkpoint, last)) throw new Error('invalid checkpoint');
        // An advancing candidate needs only saved boundary metadata. A same-head
        // or older candidate must also check the saved digest, so a corrupt cache
        // cannot prevent its own replacement from the intact journal.
        const saved = store.db.prepare(`SELECT json_type(value,'$.algorithmVersion') algorithmType,
          json_extract(value,'$.algorithmVersion') algorithmVersion,
          json_extract(value,'$.journalCursor') journalCursor,json_extract(value,'$.configVersion') configVersion,
          json_extract(value,'$.journalEntryHash') journalEntryHash,
          json_extract(value,'$.fireplaceRevision') fireplaceRevision,
          json_extract(value,'$.sensorRevision') sensorRevision FROM state WHERE key=? AND json_type(value)<>'null'`)
          .get(`adaptive:${workerData.input}`);
        if (saved) {
          // An explicitly empty cache or a current pre-journal seed has no
          // authoritative boundary. Never interpret a declared older algorithm.
          if (saved.algorithmType !== null && saved.algorithmVersion !== LEARNING_ALGORITHM)
            throw new Error('unsupported checkpoint');
          const savedLast = Number.isSafeInteger(saved.journalCursor) && saved.journalCursor > 0
            ? boundary(store, fences.epoch, saved.journalCursor) : null;
          if ((saved.fireplaceRevision ?? 0) === fences.fireplaceRevision && (saved.sensorRevision ?? 0) === fences.sensorRevision
            && matchesBoundary(saved, savedLast) && saved.journalCursor >= checkpoint.journalCursor
            && validLearningCheckpoint(store.getState(`adaptive:${workerData.input}`), savedLast)) {
            journalCursor = saved.journalCursor;
            return 'current';
          }
        }
        if (!writable()) return 'cancelled';
        store.setState(`adaptive:${workerData.input}`, checkpoint);
        if (!writable()) throw new Error('cancelled');
        journalCursor = checkpoint.journalCursor;
        return 'saved';
      }, { isCurrent: writable });
    } catch { status = writable() ? 'failed' : 'cancelled'; }
    parentPort.postMessage({ type: 'result', id: message.id, status, journalCursor });
  });
  parentPort.on('close', () => { try { store.close(); } catch {} });
  parentPort.postMessage({ type: 'ready' });
} catch {
  try { store?.close(); } catch {}
  parentPort.postMessage({ type: 'failed' }); parentPort.close();
}
