import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '../storage/store.js';
import { LEARNING_ALGORITHM, appendLearningRecord, applyLearningRecord, historicalLearningWindows, validLearningCheckpoint } from './committed-learning.js';
import { storageStep } from '../storage/worker-admission.js';
import { coefficientProjectionAt, persistCoefficientBatch } from '../storage/coefficient-history.js';
import { projectCoefficientTransition, compactCoefficientProjection } from '../domain/coefficient-projection.js';

// History runs off the command/UI thread. Only journal/checkpoint writes hold
// SQLite's writer lock; fitting a page can take longer than the busy timeout.
const store = storageStep(()=>new Store(workerData.dbPath,{managedCheckpoints:workerData.managedCheckpoints}));
let stopped = false;
parentPort.on('message', message => { if (message === 'stop') stopped = true; });
try {
  let adaptive;
  try { adaptive = storageStep(()=>store.getState('adaptive:history')); } catch { adaptive = null; }
  if (adaptive && (adaptive.algorithmVersion !== LEARNING_ALGORITHM || adaptive.model?.version !== 4))
    throw new Error('Unsupported Home history checkpoint; start with a fresh development database and re-import supported CSV files.');
  const lastEntry = Number.isSafeInteger(adaptive?.journalCursor) && adaptive.journalCursor > 0
    ? store.learningJournal({ input: 'history', after: adaptive.journalCursor - 1, limit: 1, algorithmVersion: LEARNING_ALGORITHM })[0] : null;
  let adaptiveCursor = lastEntry && validLearningCheckpoint(adaptive, lastEntry) && adaptive.cursor
    && Number.isSafeInteger(adaptive.historyCursor) && adaptive.historyResampling ? adaptive.historyCursor : 0;
  if (!adaptiveCursor) adaptive = null;
  const projection = coefficientProjectionAt(store,{input:'history',cursor:adaptive?.journalCursor??0});
  let processed = 0, scanned = null;
  while (!stopped) {
    const source = storageStep(() => {
      // An empty suffix includes native rows too. Bind its high-water mark and
      // imported selection to the same read snapshot; an import completing after
      // this snapshot allocates later observation IDs and cannot be skipped.
      store.db.exec('BEGIN');
      try {
        const through = store.db.prepare('SELECT COALESCE(MAX(id),0) id FROM observations').get().id;
        const basis = { version: 1, databaseId: store.checkpoint().databaseId,
          selection: store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation,
          imports: JSON.stringify(store.db.prepare("SELECT id,row_count,completed_at FROM active_imports WHERE kind='stmq' AND status='complete' ORDER BY id").all()),
          historyCursor: adaptiveCursor, checkpointDigest: adaptive?.checkpointDigest ?? null };
        const saved = store.getState('learning:history-scan');
        const valid = saved && typeof saved === 'object' && !Array.isArray(saved)
          && Object.keys(saved).length === Object.keys(basis).length + 1
          && Object.entries(basis).every(([key, value]) => saved[key] === value)
          && Number.isSafeInteger(saved.cursor) && saved.cursor >= adaptiveCursor && saved.cursor <= through;
        const rows = store.trainingRows({ afterId: valid ? saved.cursor : adaptiveCursor, throughId: through, limit: 64 });
        return { rows, empty: { ...basis, cursor: through } };
      } finally { store.db.exec('ROLLBACK'); }
    });
    const { rows } = source;
    if (!rows.length) scanned = source.empty;
    if (!rows.length) break;
    const windows = historicalLearningWindows(rows.filter(row => row.id > adaptiveCursor), adaptive?.historyResampling);
    adaptiveCursor = Math.max(adaptiveCursor, rows.at(-1).id);
    processed += rows.length;
    const existingSample = store.db.prepare("SELECT id FROM learning_journal WHERE input='history' AND kind='sample' AND at=? AND algorithm_version=?");
    const entries = storageStep(()=>store.transaction(() => windows.samples.map(sample => {
      // An interrupted page may already have immutable entries. Their original
      // configuration stays authoritative even if settings changed on restart.
      const id = existingSample.get(sample.timestamp, LEARNING_ALGORITHM)?.id
        ?? appendLearningRecord(store, 'history', 'sample', sample, { config: workerData.config ?? {} });
      return store.learningJournal({ input: 'history', after: id - 1, limit: 1 })[0];
    })));
    // Journal entries are immutable and committed before fitting. A crash before
    // the checkpoint commit leaves the source cursor unchanged, so restart
    // encounters the same entries and applies them in the same order.
    const baseCursor=adaptive?.journalCursor??0,events=[];
    for (const entry of entries) {
      const prior=adaptive; adaptive=applyLearningRecord(prior,entry);
      const event=projectCoefficientTransition(projection,entry,prior,adaptive);
      if(event)events.push({...event,projection:compactCoefficientProjection(projection)});
    }
    storageStep(()=>store.transaction(() => {
      if(entries.length)persistCoefficientBatch(store,'history',{epoch:store.learningEpoch('history'),
        selection:store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation,
        fireplaceRevision:adaptive?.fireplaceRevision??0,sensorRevision:adaptive?.sensorRevision??0,
        baseCursor,events,projection:compactCoefficientProjection(projection),cursor:projection.cursor,throughAt:projection.at});
      adaptive = { ...adaptive, historyCursor: adaptiveCursor, historyResampling: windows.state };
      store.setState('adaptive:history', { ...adaptive,
        reconstruction: { recordedAt: Date.now(), source: 'imported-requested-modes-and-temperatures',
          solar: 'unavailable; contemporary forecasts are never backfilled into history', energy: 'unverified' } });
      store.setState('learning:health', { status: 'rebuilding-history', processed, cursor: adaptiveCursor,
        adaptiveCursor, adaptive: adaptive?.health ?? null, updatedAt: Date.now() });
    }));
    // Let ingestion acquire the database between bounded transactions.
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  storageStep(()=>store.transaction(() => {
    if (scanned) store.setState('learning:history-scan', scanned);
    store.setState('learning:health', { status: stopped ? 'paused' : 'history-current', processed, cursor: adaptiveCursor,
      reference: adaptive?.comfortReference,
      adaptive: adaptive?.health ?? null, adaptiveCursor,
      evidence: 'Historical requested modes and temperatures; energy and causal savings unverified', updatedAt: Date.now() });
  }));
  parentPort.postMessage({ processed, cursor: adaptiveCursor });
} catch (error) {
  parentPort.postMessage({ error: error.message });
} finally { storageStep(()=>store.close()); parentPort.close(); }
