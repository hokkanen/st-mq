import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '../storage/store.js';
import { emptyCheckpoint, restoreCheckpoint, updateLearning } from '../control/learning.js';
import { updateAdaptiveLearningBatch } from '../control/adaptive-learning.js';

// History runs in small pages off the command/UI thread. SQLite transactionally
// stores each checkpoint together with the exact cursor that produced it.
const store = new Store(workerData.dbPath);
let stopped = false;
parentPort.on('message', message => { if (message === 'stop') stopped = true; });
try {
  let saved, adaptive;
  try { saved = store.getState('learning:history'); } catch { saved = null; }
  try { adaptive = store.getState('adaptive:history'); } catch { adaptive = null; }
  let checkpoint = restoreCheckpoint(saved?.checkpoint, { now: Date.now() });
  let cursor = saved?.version === 1 && checkpoint.processedThrough && Number.isSafeInteger(saved.cursor) ? saved.cursor : 0;
  if (!cursor) checkpoint = emptyCheckpoint();
  let adaptiveCursor = adaptive?.version === 1 && adaptive.cursor && Number.isSafeInteger(adaptive.historyCursor) ? adaptive.historyCursor : 0;
  if (!adaptiveCursor) adaptive = null;
  let processed = 0;
  while (!stopped) {
    const rows = store.trainingRows({ afterId: Math.min(cursor, adaptiveCursor), limit: 256 });
    if (!rows.length) break;
    const samples = rows.filter(row => row.id > cursor).map(row => ({ timestamp: row.at, indoorC: row.indoorC, outdoorC: row.outdoorC,
      action: row.action, quality: row.quality, regime: row.regime === 'occupied' ? 'occupied' : 'absence' }));
    const sourceNow = Math.max(...rows.map(row => row.at));
    if (samples.length) checkpoint = updateLearning(checkpoint, samples, { now: sourceNow });
    const adaptiveSamples = rows.filter(row => row.id > adaptiveCursor).map(row => ({
      timestamp: row.at, indoorC: row.indoorC, outdoorC: row.outdoorC,
      phase: row.action === 'reduction' ? 'reduction' : 'normal', roomBoostC: 0,
      solarRadiationWm2: null, regime: row.regime === 'occupied' ? 'occupied' : 'away',
      quality: row.quality, actualModeKnown: false, energyBasis: 'unknown', powerKw: null,
      compressorDuty: null, heating: null,
    }));
    if (adaptiveSamples.length) adaptive = updateAdaptiveLearningBatch(adaptive, adaptiveSamples,
      { now: sourceNow, config: workerData.config ?? {} });
    cursor = Math.max(cursor, rows.at(-1).id);
    adaptiveCursor = Math.max(adaptiveCursor, rows.at(-1).id);
    processed += rows.length;
    store.transaction(() => {
      store.setState('learning:history', { version: 1, cursor, checkpoint });
      store.setState('adaptive:history', { ...adaptive, historyCursor: adaptiveCursor,
        reconstruction: { recordedAt: Date.now(), source: 'imported-requested-modes-and-temperatures',
          solar: 'unavailable; contemporary forecasts are never backfilled into history', energy: 'unverified' } });
      store.setState('learning:health', { status: 'rebuilding-history', processed, cursor,
        adaptiveCursor, adaptive: adaptive?.health ?? null, updatedAt: Date.now() });
    });
    // Let ingestion acquire the database between bounded transactions.
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  store.setState('learning:health', { status: stopped ? 'paused' : 'history-current', processed, cursor,
    model: checkpoint.health, reference: checkpoint.comfortReference,
    adaptive: adaptive?.health ?? null, adaptiveCursor,
    evidence: 'Historical requested modes and temperatures; energy and causal savings unverified', updatedAt: Date.now() });
  parentPort.postMessage({ processed, cursor });
} catch (error) {
  parentPort.postMessage({ error: error.message });
} finally { store.close(); parentPort.close(); }
