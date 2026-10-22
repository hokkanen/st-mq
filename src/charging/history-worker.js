import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { forecastHousehold, householdReferenceIdentity } from './history.js';
import { createHouseholdHistoryCache } from './history-cache.js';

// The worker owns a read-only source connection and a bounded derived cache.
// Its disposable sidecar never changes source rows or an authoritative model.
let db;
try {
  db = new DatabaseSync(workerData.path, { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
  const cachePath = workerData.cachePath ?? workerData.path, cacheId = workerData.cacheId;
  const cache = createHouseholdHistoryCache({ path: cachePath, db, cacheId });
  const store = { db, householdCache: cache };
  let sequence = 0;
  const requests = new Map();
  const anchor = (id, request) => new Promise(resolve => {
    const requestId = ++sequence; requests.set(requestId, resolve);
    parentPort.postMessage({ type: 'derived-cache-anchor', id, requestId, request });
  });
  parentPort.on('message', async message => {
    if (message?.type === 'derived-cache-anchor') {
      const resolve = requests.get(message.requestId); requests.delete(message.requestId); resolve?.(message.proof ?? null); return;
    }
    if (message?.type !== 'forecast') return;
    try {
      db.exec('BEGIN');
      const head = db.prepare('SELECT database_id,sequence,hash FROM journal_meta WHERE id=1').get();
      const source = { databaseId: head.database_id, sequence: head.sequence, hash: head.hash };
      const identity = householdReferenceIdentity(store, message.options);
      store.householdIdentity = identity;
      const voltage = Array.isArray(message.options.voltageV) ? message.options.voltageV : Array(3).fill(message.options.voltageV);
      const voltageReady = voltage.length === 3 && voltage.every(value => Number.isFinite(value) && value >= 200 && value <= 250);
      const pin = () => anchor(message.id, { operation: 'pin', input: identity.input, source, selection: identity.selection });
      let proof = cache.wantsProof(identity, voltageReady) ? await pin() : null;
      cache.begin(proof);
      const rows = forecastHousehold(store, message.options);
      if (cache.needsProof() && !proof) {
        proof = await pin(); cache.begin(proof);
      }
      if (proof) cache.flush();
      const publication = cache.publication();
      db.exec('COMMIT');
      if (publication) {
        const published = await anchor(message.id, { operation: 'publish', input: publication.input, ...publication.proof });
        if (!published) cache.publicationFailed();
      }
      parentPort.postMessage({ type: 'forecast', id: message.id, rows });
    } catch {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the safe original failure. */ }
      // A database/decoder exception may contain private paths or source data.
      parentPort.postMessage({ type: 'error', id: message.id, code: 'history-unavailable' });
    } finally { delete store.householdIdentity; }
  });
} catch {
  parentPort.postMessage({ type: 'error', id: null, code: 'history-unavailable' });
  db?.close();
  parentPort.close();
}
