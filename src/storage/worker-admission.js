import { parentPort, workerData } from 'node:worker_threads';

// Workers request a storage turn synchronously, without blocking the controller.
// Release is acknowledged by the parent queue only after the native work ends.
const admissions = new WeakMap();
let sequence = 0, depth = 0, requestActive = false;
const cancellation = workerData?.requestSignal ? new Int32Array(workerData.requestSignal) : null;
export function setStorageRequestActive(value) { requestActive = value; }
export function checkStorageRequest() {
  if (requestActive && cancellation && Atomics.load(cancellation, 0))
    throw Object.assign(new Error('Chart request aborted'), { name: 'AbortError' });
}
const signal = workerData?.storageSignal ? new Int32Array(workerData.storageSignal) : null;
// A requested chart may share one short turn across small SQL calls.
// Idle maintenance always releases after each operation.
const storageLeaseMs = Number(workerData?.storageLeaseMs ?? 0);
let held = null, releaseTimer = null, maintenance = false;
export function releaseStorageLease() {
  if (depth) return; // An enclosing native batch still owns this turn.
  clearTimeout(releaseTimer); releaseTimer = null;
  if (held) { const id = held.id; held = null; parentPort.postMessage({ storage: 'release', id }); }
}
export function setStorageMaintenance(value) {
  if (maintenance !== Boolean(value)) releaseStorageLease();
  maintenance = Boolean(value);
}

export function storageStep(operation) {
  checkStorageRequest();
  if (!signal || depth) return operation();
  if (held && performance.now() >= held.deadline) releaseStorageLease();
  if (!held) {
    const id = ++sequence;
    Atomics.store(signal, 0, 0); parentPort.postMessage({ storage: 'acquire', id, maintenance });
    while (Atomics.load(signal, 0) === 0) Atomics.wait(signal, 0, 0);
    if (Atomics.load(signal, 0) !== 1)
      throw Object.assign(new Error('Background storage admission was cancelled.'), { code: 'STORAGE_WRITE_CANCELLED' });
    held = { id, deadline: performance.now() + (maintenance ? 0 : storageLeaseMs) };
  }
  depth++;
  try { return operation(); }
  finally {
    depth--;
    if (maintenance || storageLeaseMs <= 0 || performance.now() >= held.deadline) releaseStorageLease();
    else {
      clearTimeout(releaseTimer);
      releaseTimer = setTimeout(releaseStorageLease, Math.max(1, held.deadline - performance.now()));
      releaseTimer.unref();
    }
  }
}

function storageCleanup(operation) {
  const active = requestActive; requestActive = false;
  try { return storageStep(operation); } finally { requestActive = active; }
}

/** A lease survives cancellation until the worker has actually exited. Never
 * release the queue merely because terminate() or an AbortSignal was requested. */
export function attachStorageAdmission(worker, signal, run) {
  if (!signal) return;
  const pending = new Map();
  let exited = false, retiring = false;
  const cancelWait = () => { Atomics.store(signal, 0, -1); Atomics.notify(signal, 0); };
  admissions.set(worker, () => { retiring = true; cancelWait(); });
  worker.on('message', message => {
    if (!['acquire', 'release'].includes(message?.storage) || !Number.isSafeInteger(message.id) || message.id < 1) return;
    if (message.storage === 'release') { pending.get(message.id)?.(); return; }
    // A worker can finish startup and request admission after terminate().
    // Wake that late wait too; it must never acquire fresh storage permission.
    if (retiring || exited) { cancelWait(); return; }
    let release;
    const finished = new Promise(resolve => { release = resolve; });
    pending.set(message.id, release);
    void Promise.resolve().then(()=>run(async () => {
      if (exited) return;
      if (retiring) cancelWait();
      else { Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); }
      await finished;
    }, { maintenance: message.maintenance === true })).catch(() => {
      if (!exited) { Atomics.store(signal, 0, -1); Atomics.notify(signal, 0); }
    }).finally(() => pending.delete(message.id));
  });
  worker.once('exit', () => { exited = true; admissions.delete(worker); for (const release of pending.values()) release(); });
}

/** Cancel admission before requesting termination, including a late startup wait.
 * Already admitted work retains its reservation until the actual exit event. */
export function terminateStorageWorker(worker) {
  admissions.get(worker)?.();
  return worker.terminate();
}

/** Read-only SQL retains its original snapshot, but yields storage admission
 * between statements and small cursor batches. CPU processing holds no lease.
 * A single native query step (e.g. an aggregate) is still uninterruptible. */
export function admittedReader(db, { batchRows = 64 } = {}) {
  if (!signal) return db;
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return sql => {
        const statement = storageStep(() => target.prepare(sql));
        function* iterate(...params) {
          const cursor = storageStep(() => statement.iterate(...params));
          let complete = false;
          try {
            while (!complete) {
              const rows = storageStep(() => {
                const batch = [], started = performance.now();
                while (batch.length < batchRows && performance.now() - started < 8) {
                  const next = cursor.next();
                  if (next.done) { complete = true; break; }
                  batch.push(next.value);
                }
                return batch;
              });
              releaseStorageLease();
              yield* rows;
            }
          } finally { if (!complete) storageCleanup(() => cursor.return?.()); }
        }
        return new Proxy(statement, {
          get(value, property) {
            if (property === 'iterate') return iterate;
            if (property === 'all') return (...params) => [...iterate(...params)];
            const member = Reflect.get(value, property, value);
            return typeof member === 'function' ? (...args) => storageStep(() => member.apply(value, args)) : member;
          },
        });
      };
      const member = Reflect.get(target, key, target);
      return typeof member === 'function' ? (...args) => storageStep(() => member.apply(target, args)) : member;
    },
  });
}
