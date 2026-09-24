import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '../storage/store.js';
import { LEARNING_ALGORITHM, appendLearningRecord, applyLearningRecord, historicalLearningWindows, validLearningCheckpoint } from './committed-learning.js';

// History runs off the command/UI thread. Only journal/checkpoint writes hold
// SQLite's writer lock; fitting a page can take longer than the busy timeout.
const store = new Store(workerData.dbPath);
let stopped = false;
parentPort.on('message', message => { if (message === 'stop') stopped = true; });
try {
  let adaptive;
  try { adaptive = store.getState('adaptive:history'); } catch { adaptive = null; }
  if (adaptive && (adaptive.algorithmVersion !== LEARNING_ALGORITHM || adaptive.model?.version !== 4))
    throw new Error('Unsupported Home history checkpoint; start with a fresh development database and re-import supported CSV files.');
  const lastEntry = Number.isSafeInteger(adaptive?.journalCursor) && adaptive.journalCursor > 0
    ? store.learningJournal({ input: 'history', after: adaptive.journalCursor - 1, limit: 1, algorithmVersion: LEARNING_ALGORITHM })[0] : null;
  let adaptiveCursor = lastEntry && validLearningCheckpoint(adaptive, lastEntry) && adaptive.cursor
    && Number.isSafeInteger(adaptive.historyCursor) && adaptive.historyResampling ? adaptive.historyCursor : 0;
  if (!adaptiveCursor) adaptive = null;
  let processed = 0;
  while (!stopped) {
    const rows = store.trainingRows({ afterId: adaptiveCursor, limit: 256 });
    if (!rows.length) break;
    const windows = historicalLearningWindows(rows.filter(row => row.id > adaptiveCursor), adaptive?.historyResampling);
    adaptiveCursor = Math.max(adaptiveCursor, rows.at(-1).id);
    processed += rows.length;
    const existingSample = store.db.prepare("SELECT id FROM learning_journal WHERE input='history' AND kind='sample' AND at=? AND algorithm_version=?");
    const entries = store.transaction(() => windows.samples.map(sample => {
      // An interrupted page may already have immutable entries. Their original
      // configuration stays authoritative even if settings changed on restart.
      const id = existingSample.get(sample.timestamp, LEARNING_ALGORITHM)?.id
        ?? appendLearningRecord(store, 'history', 'sample', sample, { config: workerData.config ?? {} });
      return store.learningJournal({ input: 'history', after: id - 1, limit: 1 })[0];
    }));
    // Journal entries are immutable and committed before fitting. A crash before
    // the checkpoint commit leaves the source cursor unchanged, so restart
    // encounters the same entries and applies them in the same order.
    for (const entry of entries) adaptive = applyLearningRecord(adaptive, entry);
    store.transaction(() => {
      adaptive = { ...adaptive, historyCursor: adaptiveCursor, historyResampling: windows.state };
      store.setState('adaptive:history', { ...adaptive,
        reconstruction: { recordedAt: Date.now(), source: 'imported-requested-modes-and-temperatures',
          solar: 'unavailable; contemporary forecasts are never backfilled into history', energy: 'unverified' } });
      store.setState('learning:health', { status: 'rebuilding-history', processed, cursor: adaptiveCursor,
        adaptiveCursor, adaptive: adaptive?.health ?? null, updatedAt: Date.now() });
    });
    // Let ingestion acquire the database between bounded transactions.
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  store.setState('learning:health', { status: stopped ? 'paused' : 'history-current', processed, cursor: adaptiveCursor,
    reference: adaptive?.comfortReference,
    adaptive: adaptive?.health ?? null, adaptiveCursor,
    evidence: 'Historical requested modes and temperatures; energy and causal savings unverified', updatedAt: Date.now() });
  parentPort.postMessage({ processed, cursor: adaptiveCursor });
} catch (error) {
  parentPort.postMessage({ error: error.message });
} finally { store.close(); parentPort.close(); }
