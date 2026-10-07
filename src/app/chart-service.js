import { Worker } from 'node:worker_threads';
import { getChartData, chartRequestRange } from './chart-data.js';
import { getDatabaseOverview } from './database-overview.js';
import { prepareChartResponse, encodeChartResponse } from './chart-wire.js';

const aborted = () => Object.assign(new Error('Chart request aborted'), { name: 'AbortError' });

/** At most two lazy read-only workers: requested work and one short speculative
 * view. Cancellation retires only its own worker; speculation cannot flush the
 * foreground cache or occupy its queue. Idle workers release SQLite and RAM. */
export function createChartService({ store, maxQueue = 8, idleMs = 60_000 } = {}) {
  if (!store?.db || !store.path) throw new TypeError('A history store is required');
  let nextId = 1, closed = false;
  const lanes = Object.fromEntries(['foreground', 'prefetch'].map(name => [name,
    { name, worker: null, active: null, queue: [], retiring: null, timer: null }]));
  const cleanup = entry => entry.signal?.removeEventListener('abort', entry.abort);
  const settle = (entry, error, result) => { cleanup(entry); error ? entry.reject(error) : entry.resolve(result); };
  function progress(entry, value) {
    // A presentation callback must never disrupt worker lifecycle cleanup.
    try { entry.onProgress?.(value); } catch { /* Caller owns presentation failures. */ }
  }
  function reset(lane) {
    clearTimeout(lane.timer); lane.timer = null;
    const previous = lane.worker; lane.worker = null;
    if (previous) {
      previous.removeAllListeners();
      lane.retiring = previous.terminate().finally(() => { lane.retiring = null; pump(); });
    }
  }
  function run(lane) {
    if (closed || lane.active || lane.retiring) return;
    if (!lane.queue.length) {
      if (lane.worker && !lane.timer) {
        lane.timer = setTimeout(() => reset(lane), idleMs); lane.timer.unref();
      }
      return;
    }
    if (lane.name === 'prefetch' && (lanes.foreground.active || lanes.foreground.queue.length)) return;
    clearTimeout(lane.timer); lane.timer = null;
    lane.active = lane.queue.shift();
    try {
      if (!lane.worker) {
        lane.worker = new Worker(new URL('./chart-worker.js', import.meta.url), {
          workerData: { dbPath: store.path, cacheLimitBytes: (lane.name === 'prefetch' ? 8 : 24) * 1024 * 1024 },
        });
        const generation = lane.worker;
        lane.worker.on('message', message => {
          if (lane.worker !== generation || message.id !== lane.active?.id) return;
          if (message.progress) { progress(lane.active, message.progress); return; }
          const entry = lane.active; lane.active = null;
          const error = message.error ? Object.assign(new Error(message.error.message), { name: message.error.name }) : null;
          settle(entry, error, message.result); pump();
        });
        const fail = reason => {
          if (lane.worker !== generation) return;
          const entry = lane.active; lane.active = null; reset(lane);
          if (entry) settle(entry, new Error(reason));
          pump();
        };
        lane.worker.on('error', () => fail('Chart history worker failed'));
        lane.worker.on('exit', () => fail('Chart history worker stopped'));
      }
      const entry = lane.active;
      progress(entry, { stage: 'reading-history' });
      if (lane.active === entry && lane.worker) lane.worker.postMessage({ id: entry.id, args: entry.args,
        operation: entry.operation, wire: entry.wire });
    } catch {
      const entry = lane.active; lane.active = null; reset(lane);
      if (entry) settle(entry, new Error('Chart history request could not start'));
      pump();
    }
  }
  function pump() { run(lanes.foreground); run(lanes.prefetch); }
  function query(args, { signal, operation = 'chart', priority = 'foreground', onProgress, wire } = {}) {
    if (closed) return Promise.reject(new Error('Chart service is closed'));
    if (signal?.aborted) return Promise.reject(aborted());
    args = { ...args, now: args?.now ?? Date.now() };
    try {
      if (!Object.hasOwn(lanes, priority)) throw new TypeError('Invalid chart priority');
      if (operation !== 'overview') {
        const { selection } = chartRequestRange(args);
        if (priority === 'prefetch' && Date.parse(selection.endDate) - Date.parse(selection.startDate) >= 7 * 86_400_000)
          throw new RangeError('Chart prefetch is limited to seven calendar days');
      }
      if (wire !== undefined && !['json', 'ndjson'].includes(wire)) throw new TypeError('Invalid chart response format');
    } catch (error) { return Promise.reject(error); }
    if (store.path === ':memory:') {
      try {
        const result = operation === 'overview' ? getDatabaseOverview({ ...args, store }) : getChartData({ ...args, store, onProgress });
        const prepared = operation === 'overview' ? null : prepareChartResponse(result);
        return Promise.resolve(wire ? encodeChartResponse(result, prepared, wire) : result);
      } catch (error) { return Promise.reject(error); }
    }
    const lane = lanes[priority];
    const count = item => item.queue.length + Number(Boolean(item.active));
    if (count(lane) >= (priority === 'prefetch' ? 1 : maxQueue))
      return Promise.reject(new RangeError('Too many pending chart requests'));
    return new Promise((resolve, reject) => {
      const entry = { id: nextId++, args, operation, wire, signal, onProgress, resolve, reject, abort: null };
      entry.abort = () => {
        if (lane.active === entry) { lane.active = null; reset(lane); }
        else { const index = lane.queue.indexOf(entry); if (index < 0) return; lane.queue.splice(index, 1); }
        settle(entry, aborted()); pump();
      };
      signal?.addEventListener('abort', entry.abort, { once: true });
      lane.queue.push(entry); progress(entry, { stage: 'queued' }); pump();
    });
  }
  return {
    overview(options = {}) { return query({}, { ...options, operation: 'overview' }); },
    query,
    queryWire(args, options = {}) { return query(args, { ...options, wire: options.format ?? 'json' }); },
    async close() {
      if (closed) return;
      closed = true;
      for (const lane of Object.values(lanes)) {
        for (const entry of lane.queue.splice(0)) settle(entry, new Error('Chart service is closed'));
        if (lane.active) { settle(lane.active, new Error('Chart service is closed')); lane.active = null; }
        reset(lane);
      }
      await Promise.allSettled(Object.values(lanes).map(lane => lane.retiring).filter(Boolean));
    },
  };
}
