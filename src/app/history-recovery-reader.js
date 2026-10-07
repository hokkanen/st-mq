import { Worker } from 'node:worker_threads';

const unavailable = 'Previous recoveries are unavailable. Refresh to retry.';
function validate(input, options) {
  const cursor = options?.before;
  if (!['mqtt', 'providers', 'simulated', 'history', 'offline'].includes(input)
    || !options || Object.keys(options).some(key => !['before', 'limit'].includes(key))
    || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100
    || cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 180 || !/^\d+:[a-zA-Z0-9-]+$/.test(cursor)
      || !Number.isSafeInteger(Number(cursor.split(':')[0]))))
    throw Object.assign(new Error('Choose a bounded recovery history page.'), { statusCode: 400 });
}

/** Keep large contribution counts off the HTTP/control thread. Duplicate polls
 * share a request; both pending work and the short-lived page cache are bounded. */
export function createRecoveryHistoryReader(store, { WorkerClass = Worker, clock = Date.now } = {}) {
  let worker = null, closed = false, sequence = 0, generation = 0;
  const pending = new Map(), cache = new Map(), terminating = new Set();
  const keyOf = (input, options) => JSON.stringify([input, options.before ?? null, options.limit]);
  function remember(entry, value) {
    if (entry.generation !== generation) return;
    cache.delete(entry.key); cache.set(entry.key, { at: clock(), ...value });
    while (cache.size > 8) cache.delete(cache.keys().next().value);
  }
  function terminate(current) {
    const completion = Promise.resolve(current.terminate()).catch(() => {});
    terminating.add(completion);
    void completion.finally(() => terminating.delete(completion));
    return completion;
  }
  const start = () => {
    if (worker) return;
    worker = new WorkerClass(new URL('./history-recovery-reader-worker.js', import.meta.url), { workerData: { path: store.path },
      ...(process.execArgv.some(value => value.startsWith('--input-type')) ? { execArgv: [] } : {}) });
    const current = worker;
    worker.on('message', message => {
      if (worker !== current) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      remember(entry, message.error ? { error: unavailable, rows: cache.get(entry.key)?.rows ?? [] } : { rows: message.rows });
    });
    const stop = () => {
      if (worker !== current) return;
      worker = null;
      for (const entry of pending.values()) remember(entry, { error: unavailable, rows: cache.get(entry.key)?.rows ?? [] });
      pending.clear();
      void terminate(current);
    };
    worker.on('error', stop);
    worker.on('exit', stop);
  };
  return {
    invalidate() { generation++; cache.clear(); },
    snapshot(input, options, { refresh = true } = {}) {
      validate(input, options);
      if (closed || store.path === ':memory:') return { rows: [], loading: false, error: unavailable };
      const key = keyOf(input, options), hit = cache.get(key);
      const inflight = [...pending.values()].some(entry => entry.key === key && entry.generation === generation);
      if ((!hit || (refresh || hit.error) && clock() - hit.at >= 1000) && !inflight) {
        if (pending.size >= 8) return { rows: hit?.rows ?? [], loading: false, error: unavailable };
        const id = ++sequence, entry = { key, generation };
        try { start(); pending.set(id, entry); worker.postMessage({ id, input, options }); }
        catch { pending.delete(id); remember(entry, { error: unavailable, rows: hit?.rows ?? [] }); }
      }
      const result = cache.get(key);
      return { rows: result?.rows ?? [], loading: !result, error: result?.error ?? null };
    },
    async close() {
      closed = true;
      const previous = worker; worker = null;
      pending.clear(); cache.clear();
      if (previous) void terminate(previous);
      await Promise.all([...terminating]);
    },
  };
}
