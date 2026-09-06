import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '../storage/store.js';
import { emptyCheckpoint, restoreCheckpoint, updateLearning } from '../control/learning.js';

// History runs in small pages off the command/UI thread. SQLite transactionally
// stores each checkpoint together with the exact cursor that produced it.
const store = new Store(workerData.dbPath);
let stopped = false;
parentPort.on('message', message => { if (message === 'stop') stopped = true; });
try {
  let saved;
  try { saved = store.getState('learning:history'); } catch { saved = null; }
  let checkpoint = restoreCheckpoint(saved?.checkpoint, { now: Date.now() });
  let cursor = saved?.version === 1 && checkpoint.processedThrough && Number.isSafeInteger(saved.cursor) ? saved.cursor : 0;
  if (!cursor) checkpoint = emptyCheckpoint();
  let processed = 0;
  while (!stopped) {
    const rows = store.trainingRows({ afterId: cursor, limit: 256 });
    if (!rows.length) break;
    const samples = rows.map(row => ({ timestamp: row.at, indoorC: row.indoorC, outdoorC: row.outdoorC,
      action: row.action, quality: row.quality, regime: row.regime === 'occupied' ? 'occupied' : 'absence' }));
    checkpoint = updateLearning(checkpoint, samples, { now: Math.max(...rows.map(row => row.at)) });
    cursor = rows.at(-1).id;
    processed += rows.length;
    store.transaction(() => {
      store.setState('learning:history', { version: 1, cursor, checkpoint });
      store.setState('learning:health', { status: 'rebuilding-history', processed, cursor, updatedAt: Date.now() });
    });
    // Let ingestion acquire the database between bounded transactions.
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  store.setState('learning:health', { status: stopped ? 'paused' : 'history-current', processed, cursor,
    model: checkpoint.health, reference: checkpoint.comfortReference,
    evidence: 'Historical requested modes and temperatures; energy and causal savings unverified', updatedAt: Date.now() });
  parentPort.postMessage({ processed, cursor });
} catch (error) {
  parentPort.postMessage({ error: error.message });
} finally { store.close(); parentPort.close(); }
