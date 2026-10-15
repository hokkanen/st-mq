import { parentPort, workerData } from 'node:worker_threads';
import { serialize, deserialize } from 'node:v8';
import { Store } from './store.js';
import { prepareJournalCommit, commitPreparedJournal, journalCommitTiming,
  readCheckpoint, setJournalControllerBounds } from './journal.js';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_SQL_BYTES = 256 * 1024;
const MAX_STATEMENTS = 256;
const MAX_RESULT_ROWS = 65_536;
const failure = code => Object.assign(new Error('The recording writer rejected the operation.'), { code });
const invalid = () => { throw failure('STORAGE_WRITER_PROTOCOL'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const safeError = error => ({
  name: ['TypeError', 'RangeError'].includes(error?.name) ? error.name : 'Error',
  ...(typeof error?.code === 'string' && /^(?:STORAGE_[A-Z_]+|ERR_SQLITE_[A-Z_]+|journal_[a-z_]+|database_[a-z_]+)$/.test(error.code)
    ? { code: error.code } : {}),
  ...(Number.isInteger(error?.errcode) ? { errcode: error.errcode } : {}),
  ...(error?.committed === true ? { committed: true } : {}),
});
const signal = new Int32Array(workerData.syncSignal);
const syncPort = workerData.syncPort;
let store, phase = 'idle', closed = false;
const statements = new Map();

function encode(message) {
  const frame = serialize(message);
  if (frame.byteLength > MAX_FRAME_BYTES) throw failure('STORAGE_WRITER_FRAME_TOO_LARGE');
  return frame;
}
function sqlValue(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > MAX_SQL_BYTES) invalid();
  return value;
}
function statement({ sql, method, params = [], settings = {} }) {
  sqlValue(sql);
  if (!['idle', 'active'].includes(phase) || !['get', 'all', 'run', 'iterate', 'columns'].includes(method)
    || !Array.isArray(params) || !keys(settings, ['setReadBigInts', 'setAllowBareNamedParameters', 'setAllowUnknownNamedParameters', 'setReturnArrays'])
    || Object.values(settings).some(value => typeof value !== 'boolean')) invalid();
  const cacheKey = JSON.stringify([sql, settings]);
  let prepared = statements.get(cacheKey);
  if (!prepared) {
    prepared = store.db.prepare(sql);
    for (const [setter, value] of Object.entries(settings)) {
      if (typeof prepared[setter] !== 'function') invalid();
      prepared[setter](value);
    }
    statements.set(cacheKey, prepared);
    if (statements.size > MAX_STATEMENTS) statements.delete(statements.keys().next().value);
  }
  if (method === 'iterate') {
    const rows = [];
    for (const row of prepared.iterate(...params)) {
      if (rows.length >= MAX_RESULT_ROWS) throw failure('STORAGE_WRITER_FRAME_TOO_LARGE');
      rows.push(row);
    }
    return rows;
  }
  return prepared[method](...params);
}
function begin() {
  if (phase !== 'idle' || store.db.isTransaction) invalid();
  store.db.exec('BEGIN IMMEDIATE'); phase = 'active';
  return { checkpoint: readCheckpoint(store.db), changes: store.databaseChanges() };
}
function seal() {
  if (phase !== 'active') invalid();
  const prepared = prepareJournalCommit(store.db); phase = 'sealed';
  return { ...prepared, changes: store.databaseChanges() };
}
function commit(synchronous) {
  if (phase === 'active' && synchronous) seal();
  if (phase !== 'sealed') invalid();
  // Retain the prepared checkpoint across COMMIT; another specialized writer
  // may advance the database immediately after this connection releases it.
  const checkpoint = readCheckpoint(store.db);
  commitPreparedJournal(store.db); phase = 'idle';
  return { checkpoint, timing: journalCommitTiming(store.db), changes: store.databaseChanges() };
}
function rollback() {
  if (store.db.isTransaction) store.db.exec('ROLLBACK');
  phase = 'idle';
  return { rolledBack: true };
}
function execute(op, args, synchronous) {
  if (closed) throw failure('STORAGE_CLOSED');
  if (op === 'statement') {
    if (!synchronous || !keys(args, ['sql', 'method', 'params', 'settings'])) invalid();
    return statement(args);
  }
  if (op === 'exec') {
    if (!synchronous || !keys(args, ['sql'])) invalid();
    const sql = sqlValue(args.sql), start = sql.trim();
    if (/^BEGIN\s+(?:IMMEDIATE|TRANSACTION)\s*;?$/i.test(start) || /^BEGIN\s*;?$/i.test(start)) return begin();
    if (/^(?:COMMIT|END)(?:\s+TRANSACTION)?\s*;?$/i.test(start)) return commit(true);
    if (/^ROLLBACK(?:\s+TRANSACTION)?\s*;?$/i.test(start)) return rollback();
    if (!['idle', 'active'].includes(phase)) invalid();
    store.db.exec(sql);
    return undefined;
  }
  if (!keys(args, []) || !['begin', 'seal', 'commit', 'rollback', 'close'].includes(op)) invalid();
  if (op === 'begin') return begin();
  if (op === 'seal') return seal();
  if (op === 'commit') return commit(synchronous);
  if (op === 'rollback') return rollback();
  if (op === 'close') {
    if (synchronous || phase !== 'idle') invalid();
    store.close(); closed = true;
    return { closed: true };
  }
}
function receive(frame, synchronous) {
  let id = null, response;
  try {
    if (!(frame instanceof Uint8Array) || frame.byteLength > MAX_FRAME_BYTES) invalid();
    const message = deserialize(frame);
    if (!keys(message, ['id', 'op', 'args']) || !Number.isSafeInteger(message.id) || message.id < 1
      || typeof message.op !== 'string' || !object(message.args)) invalid();
    id = message.id;
    response = encode({ id, ok: true, result: execute(message.op, message.args, synchronous) });
  } catch (error) { response = encode({ id, ok: false, error: safeError(error) }); }
  if (synchronous) {
    syncPort.postMessage(response);
    Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
  } else parentPort.postMessage(response);
  if (closed) { syncPort.close(); parentPort.close(); }
}

try {
  if (!object(workerData) || typeof workerData.path !== 'string' || workerData.path === ':memory:') invalid();
  store = new Store(workerData.path);
  setJournalControllerBounds(store.db);
  // Lock contention belongs to asynchronous admission, never a hidden sleep
  // inside a synchronous statement request.
  store.db.exec('PRAGMA busy_timeout=0');
  syncPort.on('message', frame => receive(frame, true));
  parentPort.on('message', frame => receive(frame, false));
  parentPort.postMessage(encode({ type: 'ready', ok: true, result: { checkpoint: readCheckpoint(store.db) } }));
} catch (error) {
  parentPort.postMessage(encode({ type: 'ready', ok: false, error: safeError(error) }));
  try { store?.close(); } catch {}
  syncPort.close(); parentPort.close();
}
