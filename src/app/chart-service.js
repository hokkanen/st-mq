import { storageOperationHealth } from '../storage/operation-health.js';
import { Worker } from 'node:worker_threads';
import { getChartData, chartRequestRange } from './chart-data.js';
import { getDatabaseOverview } from './database-overview.js';
import { energyCheckSummaries } from './energy-checks.js';
import { prepareChartResponse, encodeChartResponse } from './chart-wire.js';

const aborted = () => Object.assign(new Error('Chart request aborted'), { name: 'AbortError' });

/** At most two lazy read-only workers: requested work and one short speculative
 * view. Cancellation retires only its own worker; speculation cannot flush the
 * foreground cache or occupy its queue. Idle workers release SQLite and RAM. */
export function createChartService({ store, maxQueue = 8, idleMs = 60_000 } = {}) {
  if (!store?.db || !store.path) throw new TypeError('A history store is required');
  storageOperationHealth.register('history-query'); storageOperationHealth.register('storage-inventory');
  let nextId = 1, closed = false;
  const lanes = Object.fromEntries(['foreground', 'prefetch'].map(name => [name,
    { name, worker: null, active: null, queue: [], retiring: null, timer: null, observations: new Map() }]));
  const overviewRequests = new Map();
  const cleanup = entry => entry.signal?.removeEventListener('abort', entry.abort);
  const settle = (entry, error, result) => {
    cleanup(entry);
    if (!entry.started) entry.observation?.finish(error ? error.name === 'AbortError' || closed ? 'cancelled' : 'failed' : 'completed',
      { reason: error ? error.name === 'AbortError' || closed ? 'cancelled' : 'operation-failed' : null });
    error ? entry.reject(error) : entry.resolve(result);
  };
  function progress(entry, value) {
    // A presentation callback must never disrupt worker lifecycle cleanup.
    try { entry.onProgress?.(value); } catch { /* Caller owns presentation failures. */ }
  }
  function reset(lane, outcome = 'failed', reason = 'worker-lost') {
    clearTimeout(lane.timer); lane.timer = null;
    const previous = lane.worker; lane.worker = null;
    if (previous) {
      previous.removeAllListeners();
      const observations = [...lane.observations.values()]; lane.observations.clear();
      lane.retiring = previous.terminate().finally(() => {
        for (const entry of observations) entry.observation?.finish(outcome, { reason });
        lane.retiring = null; pump();
      });
    } else {
      for (const entry of lane.observations.values()) entry.observation?.finish(outcome, { reason });
      lane.observations.clear();
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
    lane.active.started = true; lane.active.observation?.start(); lane.observations.set(lane.active.id, lane.active);
    try {
      if (!lane.worker) {
        lane.worker = new Worker(new URL('./chart-worker.js', import.meta.url), {
          workerData: { dbPath: store.path, cacheLimitBytes: (lane.name === 'prefetch' ? 8 : 24) * 1024 * 1024 },
        });
        const generation = lane.worker;
        lane.worker.on('message', message => {
          if (lane.worker !== generation) return;
          if (message.storageOperationComplete) {
            const observed = lane.observations.get(message.id); lane.observations.delete(message.id);
            if (message.cacheHit) observed?.observation?.discard();
            else observed?.observation?.finish(message.failed ? 'failed' : 'completed', { reason: message.failed ? 'operation-failed' : null });
            return;
          }
          if (message.id !== lane.active?.id) return;
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
        operation: entry.operation, wire: entry.wire, checkpoint: store.expectedCheckpoint });
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
      if (!['chart', 'overview', 'energy-checks', 'pin'].includes(operation)) throw new TypeError('Invalid history operation');
      if (operation === 'chart') {
        const { selection } = chartRequestRange(args);
        if (priority === 'prefetch' && Date.parse(selection.endDate) - Date.parse(selection.startDate) >= 7 * 86_400_000)
          throw new RangeError('Chart prefetch is limited to seven calendar days');
      }
      if (wire !== undefined && !['json', 'ndjson'].includes(wire)) throw new TypeError('Invalid chart response format');
    } catch (error) { return Promise.reject(error); }
    if (store.path === ':memory:') {
      const observation = operation === 'pin' ? null : storageOperationHealth.begin(operation === 'overview' ? 'storage-inventory' : 'history-query', { scope: 'history' });
      try {
        if (operation === 'pin') return Promise.resolve({ ready: true });
        const result = operation === 'overview' ? getDatabaseOverview({ ...args, store })
          : operation === 'energy-checks' ? energyCheckSummaries(store, args) : getChartData({ ...args, store, onProgress });
        const prepared = operation === 'chart' ? prepareChartResponse(result) : null;
        const response = wire ? encodeChartResponse(result, prepared, wire) : result;
        observation?.finish('completed'); return Promise.resolve(response);
      } catch (error) { observation?.finish('failed', { reason: 'operation-failed' }); return Promise.reject(error); }
    }
    const lane = lanes[priority];
    const count = item => item.queue.length + Number(Boolean(item.active));
    if (count(lane) >= (priority === 'prefetch' ? 1 : maxQueue)) {
      storageOperationHealth.refuse(operation === 'overview' ? 'storage-inventory' : 'history-query');
      return Promise.reject(new RangeError('Too many pending chart requests'));
    }
    return new Promise((resolve, reject) => {
      const entry = { id: nextId++, args, operation, wire, signal, onProgress, resolve, reject, abort: null,
        observation: operation === 'pin' ? null : storageOperationHealth.begin(operation === 'overview' ? 'storage-inventory' : 'history-query', { queued: true, scope: 'history' }) };
      entry.abort = () => {
        if (lane.active === entry) { lane.active = null; reset(lane, 'cancelled', 'cancelled'); }
        else { const index = lane.queue.indexOf(entry); if (index < 0) return; lane.queue.splice(index, 1); }
        settle(entry, aborted()); pump();
      };
      signal?.addEventListener('abort', entry.abort, { once: true });
      lane.queue.push(entry); progress(entry, { stage: 'queued' }); pump();
    });
  }
  // Concurrent inventory readers share one bounded worker scan. Each caller
  // owns its cancellation; leaving the view never aborts another reader.
  function overview({force=false,signal,...options}={}) {
    if(typeof force!=='boolean')return Promise.reject(new TypeError('Invalid inventory refresh option'));
    if(signal?.aborted)return Promise.reject(aborted());
    const key=JSON.stringify([force,store.expectedCheckpoint??null]);
    let entry=overviewRequests.get(key);
    if(!entry) {
      const controller=new AbortController();entry={controller,readers:0,promise:null};
      entry.promise=query({force},{...options,signal:controller.signal,operation:'overview'}).finally(()=>{
        if(overviewRequests.get(key)===entry)overviewRequests.delete(key);
      });
      overviewRequests.set(key,entry);
    }
    entry.readers++;
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error,value)=>{
        if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);entry.readers--;
        error?reject(error):resolve(value);
      };
      const cancel=()=>{
        finish(aborted());
        if(!entry.readers) {
          if(overviewRequests.get(key)===entry)overviewRequests.delete(key);
          entry.controller.abort();
        }
      };
      signal?.addEventListener('abort',cancel,{once:true});
      entry.promise.then(value=>finish(null,value),error=>finish(error));
    });
  }
  return {
    pin(options = {}) { return query({}, { ...options, operation: 'pin' }); },
    overview,
    energyChecks(args = {}, options = {}) { return query(args, { ...options, operation: 'energy-checks', priority: 'foreground' }); },
    query,
    queryWire(args, options = {}) { return query(args, { ...options, wire: options.format ?? 'json' }); },
    async close() {
      if (closed) return;
      closed = true;
      for (const lane of Object.values(lanes)) {
        for (const entry of lane.queue.splice(0)) settle(entry, new Error('Chart service is closed'));
        if (lane.active) { settle(lane.active, new Error('Chart service is closed')); lane.active = null; }
        reset(lane, 'cancelled', 'cancelled');
      }
      await Promise.allSettled(Object.values(lanes).map(lane => lane.retiring).filter(Boolean));
    },
  };
}
