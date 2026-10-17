import { parentPort, workerData } from 'node:worker_threads';

// Workers request a storage turn synchronously, without blocking the controller.
// Release is acknowledged by the parent queue only after the native work ends.
let sequence = 0, depth = 0;
const signal = workerData?.storageSignal ? new Int32Array(workerData.storageSignal) : null;
export function storageStep(operation) {
  if (!signal || depth) return operation();
  const id = ++sequence;
  Atomics.store(signal, 0, 0);
  parentPort.postMessage({ storage: 'acquire', id });
  while (Atomics.load(signal, 0) === 0) Atomics.wait(signal, 0, 0);
  if (Atomics.load(signal, 0) !== 1)
    throw Object.assign(new Error('Background storage admission was cancelled.'), { code: 'STORAGE_WRITE_CANCELLED' });
  depth++;
  try { return operation(); }
  finally { depth--; parentPort.postMessage({ storage: 'release', id }); }
}

/** A lease survives cancellation until the worker has actually exited. Never
 * release the queue merely because terminate() or an AbortSignal was requested. */
export function attachStorageAdmission(worker, signal, run) {
  if (!signal) return;
  const pending = new Map();
  let exited = false;
  worker.on('message', message => {
    if (!['acquire', 'release'].includes(message?.storage) || !Number.isSafeInteger(message.id) || message.id < 1) return;
    if (message.storage === 'release') { pending.get(message.id)?.(); return; }
    let release;
    const finished = new Promise(resolve => { release = resolve; });
    pending.set(message.id, release);
    void Promise.resolve().then(()=>run(async () => {
      if (exited) return;
      Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
      await finished;
    })).catch(() => {
      if (!exited) { Atomics.store(signal, 0, -1); Atomics.notify(signal, 0); }
    }).finally(() => pending.delete(message.id));
  });
  worker.once('exit', () => { exited = true; for (const release of pending.values()) release(); });
}

/** Read-only SQL retains its original snapshot, but yields storage admission
 * between statements and small cursor batches. CPU processing holds no lease.
 * A single native query step (e.g. an aggregate) is still uninterruptible. */
export function admittedReader(db) {
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
                while (batch.length < 64 && performance.now() - started < 8) {
                  const next = cursor.next();
                  if (next.done) { complete = true; break; }
                  batch.push(next.value);
                }
                return batch;
              });
              yield* rows;
            }
          } finally { if (!complete) storageStep(() => cursor.return?.()); }
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
