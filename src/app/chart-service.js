import { DEFAULT_CHART_CACHE } from '../domain/chart-cache.js';
import { storageOperationHealth } from '../storage/operation-health.js';
import { Worker } from 'node:worker_threads';
import { getChartData, chartRequestRange } from './chart-data.js';
import { getDatabaseOverview } from './database-overview.js';
import { energyCheckSummaries } from './energy-checks.js';
import { prepareChartResponse, encodeChartResponse } from './chart-wire.js';
import { attachStorageAdmission } from '../storage/worker-admission.js';
import { CHART_VIEW_BY_KEY } from '../domain/chart-views.js';
import { HISTORY_AXIS_BY_KEY, MODEL_COEFFICIENT_INFO } from '../domain/history-series.js';

const aborted = () => Object.assign(new Error('Chart request aborted'), { name: 'AbortError' });

/** Recent charts share a resident source window. Archive work owns a separate
 * bounded worker, so broad selections cannot evict that window. Maintenance
 * reads short batches only when no requested chart is waiting. */
export function createChartService({ store, maxQueue = 8, idleMs = 60_000, replayIdleMs = 15 * 60_000, cacheDays = DEFAULT_CHART_CACHE.cacheDays, cacheBytes = DEFAULT_CHART_CACHE.cacheBytes, clock = Date.now, warmCache = true } = {}) {
  if (!store?.db || !store.path) throw new TypeError('A history store is required');
  storageOperationHealth.register('history-query'); storageOperationHealth.register('storage-inventory');
  let nextId = 1, closed = false, maintenanceTimer, pinned = false, warming = warmCache;
  let settings = { cacheDays, cacheBytes };
  const validSettings = value => value && Number.isInteger(value.cacheDays) && value.cacheDays >= 0 && value.cacheDays <= 14
    && Number.isSafeInteger(value.cacheBytes) && value.cacheBytes >= 64 * 1024 * 1024 && value.cacheBytes <= 2048 * 1024 * 1024;
  if (!validSettings(settings)) throw new TypeError('Invalid chart cache settings');
  const lanes = Object.fromEntries(['resident', 'archive'].map(name => [name,
    { name, worker: null, active: null, queue: [], retiring: null, timer: null, replayCache: false, observations: new Map() }]));
  const overviewRequests = new Map();
  const cleanup = entry => entry.signal?.removeEventListener('abort', entry.abort);
  const settle = (entry, error, result) => {
    if (entry.settled) return; entry.settled = true;
    cleanup(entry);
    if (!entry.started) entry.observation?.finish(error ? error.name === 'AbortError' || closed ? 'cancelled' : 'failed' : 'completed',
      { reason: error ? error.name === 'AbortError' || closed ? 'cancelled' : 'operation-failed' : null });
    error ? entry.reject(error) : entry.resolve(result);
  };
  function progress(entry, value) {
    // A presentation callback must never disrupt worker lifecycle cleanup.
    try { if (!entry.settled) entry.onProgress?.(value); } catch { /* Caller owns presentation failures. */ }
  }
  function reset(lane, outcome = 'failed', reason = 'worker-lost') {
    clearTimeout(lane.timer); lane.timer = null;
    lane.replayCache = false;
    const previous = lane.worker; lane.worker = null;
    if (previous) {
      // Admission cleanup must observe release/exit through termination. The
      // service's own handlers already ignore this retired worker generation.
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
      if (!pinned && lane.worker && !lane.timer && (lane.name === 'archive' || !settings.cacheDays)) {
        lane.timer = setTimeout(() => reset(lane), lane.replayCache ? Math.max(idleMs, replayIdleMs) : idleMs); lane.timer.unref();
      }
      return;
    }
    clearTimeout(lane.timer); lane.timer = null;
    lane.active = lane.queue.shift();
    lane.active.started = true; lane.active.observation?.start(); lane.observations.set(lane.active.id, lane.active);
    try {
      if (!lane.worker) {
        const storageSignal = new Int32Array(new SharedArrayBuffer(4));
        lane.requestSignal = new Int32Array(new SharedArrayBuffer(4));
        lane.worker = new Worker(new URL('./chart-worker.js', import.meta.url), {
          workerData: { dbPath: store.path, resident: lane.name === 'resident', settings,
            storageSignal: storageSignal.buffer, requestSignal: lane.requestSignal.buffer, storageLeaseMs: 25 },
        });
        attachStorageAdmission(lane.worker, storageSignal, (operation, { maintenance }) => store.runStorageTask(operation, { kind: maintenance ? 'chart-cache' : 'history' }));
        const generation = lane.worker;
        lane.worker.on('message', message => {
          if (lane.worker !== generation) return;
          if (message.storage) return;
          if (message.cacheStatus) { lane.cacheStatus = message.cacheStatus; return; }
          if (message.storageOperationComplete) {
            const observed = lane.observations.get(message.id); lane.observations.delete(message.id);
            if (message.cacheHit) observed?.observation?.discard();
            else observed?.observation?.finish(observed.aborted ? 'cancelled' : message.failed ? 'failed' : 'completed',
              { reason: observed.aborted ? 'cancelled' : message.failed ? 'operation-failed' : null });
            if (message.id === lane.active?.id) {
              const entry = lane.active; lane.active = null;
              const response = entry.response;
              const error = response?.error ? Object.assign(new Error(response.error.message), { name: response.error.name }) : null;
              if (entry.replay && !error && !entry.aborted) lane.replayCache = true;
              settle(entry, error, response?.result); pump();
            }
            return;
          }
          if (message.id !== lane.active?.id) return;
          if (message.progress) { progress(lane.active, message.progress); return; }
          lane.active.response = message;
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
      if (lane.active === entry && lane.worker) { Atomics.store(lane.requestSignal, 0, 0); lane.worker.postMessage({ id: entry.id, args: entry.args,
        operation: entry.operation, wire: entry.wire, checkpoint: entry.checkpoint }); }
    } catch {
      const entry = lane.active; lane.active = null; reset(lane);
      if (entry) settle(entry, new Error('Chart history request could not start'));
      pump();
    }
  }
  function pump() { run(lanes.resident); run(lanes.archive); }
  function maintain() {
    maintenanceTimer = null;
    if (closed || !warming || !settings.cacheDays || store.path === ':memory:') return;
    if (settings.cacheDays && !Object.values(lanes).some(lane => lane.active || lane.queue.length || lane.retiring)) {
      void query({ now: clock() }, { operation: 'maintain' }).catch(() => {});
    }
    maintenanceTimer = setTimeout(maintain, lanes.resident.cacheStatus?.complete ? 1000 : 250); maintenanceTimer.unref();
  }
  function startWarming() {
    warming = true;
    if (!closed && settings.cacheDays && !maintenanceTimer) { maintenanceTimer = setTimeout(maintain, 250); maintenanceTimer.unref(); }
  }
  if (warming) startWarming();
  function query(args, { signal, operation = 'chart', onProgress, wire, checkpoint = store.expectedCheckpoint } = {}) {
    if (closed) return Promise.reject(new Error('Chart service is closed'));
    if (signal?.aborted) return Promise.reject(aborted());
    args = { ...args, now: args?.now ?? Date.now() };
    try {
      if (!['chart', 'overview', 'energy-checks', 'pin', 'pin-archive', 'maintain'].includes(operation)) throw new TypeError('Invalid history operation');
      if (operation === 'chart') {
        chartRequestRange(args);
      }
      if (wire !== undefined && !['json', 'ndjson'].includes(wire)) throw new TypeError('Invalid chart response format');
    } catch (error) { return Promise.reject(error); }
    if (store.path === ':memory:') {
      const observation = ['pin', 'pin-archive', 'maintain'].includes(operation) ? null : storageOperationHealth.begin(operation === 'overview' ? 'storage-inventory' : 'history-query', { scope: 'history' });
      try {
        if (['pin', 'pin-archive'].includes(operation)) return Promise.resolve({ ready: true });
        const result = operation === 'overview' ? getDatabaseOverview({ ...args, store })
          : operation === 'energy-checks' ? energyCheckSummaries(store, args) : getChartData({ ...args, store, onProgress });
        const prepared = operation === 'chart' ? prepareChartResponse(result) : null;
        const response = wire ? encodeChartResponse(result, prepared, wire) : result;
        observation?.finish('completed'); return Promise.resolve(response);
      } catch (error) { observation?.finish('failed', { reason: 'operation-failed' }); return Promise.reject(error); }
    }
    const range = operation === 'chart' ? chartRequestRange(args).range : null;
    // Cold coefficient reconstruction can replay the entire learning journal.
    // Keep that work in the existing archive lane even for today's selection,
    // so it cannot hold ordinary recent plots and comparisons behind it.
    const signals = CHART_VIEW_BY_KEY[args.view]?.leftSignals ?? HISTORY_AXIS_BY_KEY[args.left]?.signals ?? [];
    const replay = operation === 'chart' && signals.some(signal => Object.hasOwn(MODEL_COEFFICIENT_INFO, signal));
    const residentFrom = settings.cacheDays ? clock() - settings.cacheDays * 86_400_000 : Infinity;
    const lane = operation === 'maintain' || operation === 'pin' || !replay && range && range.from >= residentFrom - 86_400_000
      ? lanes.resident : lanes.archive;
    const count = item => item.queue.length + Number(Boolean(item.active && !item.active.aborted));
    if (count(lane) >= maxQueue) {
      storageOperationHealth.refuse(operation === 'overview' ? 'storage-inventory' : 'history-query');
      return Promise.reject(new RangeError('Too many pending chart requests'));
    }
    return new Promise((resolve, reject) => {
      const entry = { id: nextId++, args, operation, wire, checkpoint, signal, onProgress, resolve, reject, replay, abort: null,
        observation: ['pin', 'pin-archive', 'maintain'].includes(operation) ? null : storageOperationHealth.begin(operation === 'overview' ? 'storage-inventory' : 'history-query', { queued: true, scope: 'history' }) };
      entry.abort = () => {
        if (lane.active === entry) {
          if (lane.name === 'resident' || pinned) { entry.aborted = true; Atomics.store(lane.requestSignal, 0, 1); }
          else { lane.active = null; reset(lane, 'cancelled', 'cancelled'); }
        }
        else { const index = lane.queue.indexOf(entry); if (index < 0) return; lane.queue.splice(index, 1); }
        settle(entry, aborted()); pump();
      };
      signal?.addEventListener('abort', entry.abort, { once: true });
      lane.queue.push(entry); progress(entry, { stage: 'queued' }); pump();
    });
  }
  // Concurrent inventory readers share one bounded worker scan. Each caller
  // owns its cancellation; leaving the view never aborts another reader.
  function overview({force=false,signal,checkpoint=store.expectedCheckpoint,...options}={}) {
    if(typeof force!=='boolean')return Promise.reject(new TypeError('Invalid inventory refresh option'));
    if(signal?.aborted)return Promise.reject(aborted());
    const key=JSON.stringify([force,checkpoint??null]);
    let entry=overviewRequests.get(key);
    if(!entry) {
      const controller=new AbortController();entry={controller,readers:0,promise:null};
      entry.promise=query({force},{...options,checkpoint,signal:controller.signal,operation:'overview'}).finally(()=>{
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
    async pin(options = {}) {
      // Replica leases may outlive a path's publication. Open both file handles
      // before that path can be retired, and retain them until this lease owner closes.
      pinned = true;
      for (const lane of Object.values(lanes)) { clearTimeout(lane.timer); lane.timer = null; }
      await Promise.all(['pin', 'pin-archive'].map(operation => query({}, { ...options, operation })));
      return { ready: true };
    },
    overview,
    energyChecks(args = {}, options = {}) { return query(args, { ...options, operation: 'energy-checks' }); },
    query,
    startWarming,
    configure(value = DEFAULT_CHART_CACHE) {
      if (!validSettings(value)) throw new TypeError('Invalid chart cache settings');
      if (value.cacheDays === settings.cacheDays && value.cacheBytes === settings.cacheBytes) return;
      settings = { cacheDays: value.cacheDays, cacheBytes: value.cacheBytes };
      clearTimeout(maintenanceTimer); maintenanceTimer = null; if (warming) startWarming();
      for (const lane of Object.values(lanes)) { lane.cacheStatus = null; lane.worker?.postMessage({ configure: settings }); }
    },
    cacheStatus() { return { ...settings, resident: lanes.resident.cacheStatus ?? null }; },
    queryWire(args, options = {}) { return query(args, { ...options, wire: options.format ?? 'json' }); },
    async close() {
      if (closed) return;
      closed = true; clearTimeout(maintenanceTimer);
      for (const lane of Object.values(lanes)) {
        for (const entry of lane.queue.splice(0)) settle(entry, new Error('Chart service is closed'));
        if (lane.active) { settle(lane.active, new Error('Chart service is closed')); lane.active = null; }
        reset(lane, 'cancelled', 'cancelled');
      }
      await Promise.allSettled(Object.values(lanes).map(lane => lane.retiring).filter(Boolean));
    },
  };
}
