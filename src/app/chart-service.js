import { chartNeedsAssessment } from './chart-dependencies.js';
import { DEFAULT_CHART_CACHE } from '../domain/chart-cache.js';
import { createDerivedCacheAnchorOwner,derivedCacheId } from '../storage/derived-cache-anchor.js';
import { storageOperationHealth } from '../storage/operation-health.js';
import { Worker } from 'node:worker_threads';
import { getChartData, chartRequestRange } from './chart-data.js';
import { createInventoryService } from './inventory-service.js';
import { createEnergyChecksService } from './energy-checks-service.js';
import { prepareChartResponse, encodeChartResponse } from './chart-wire.js';
import { attachStorageAdmission } from '../storage/worker-admission.js';

const aborted = () => Object.assign(new Error('Chart request aborted'), { name: 'AbortError' });

/** Recent charts share a resident source window. Archive work owns a separate
 * bounded worker, so broad selections cannot evict that window. Maintenance
 * reads short batches only when no requested chart is waiting. */
export function createChartService({ store, maxQueue = 8, idleMs = 60_000, cacheDays = DEFAULT_CHART_CACHE.cacheDays, cacheBytes = DEFAULT_CHART_CACHE.cacheBytes, clock = Date.now, warmCache = true, projectionCachePath = store?.path, derivedCacheAnchor, cacheIdentity = '' } = {}) {
  if (!store?.db || !store.path) throw new TypeError('A history store is required');
  storageOperationHealth.register('history-query'); storageOperationHealth.register('storage-inventory');
  let nextId = 1, closed = false, maintenanceTimer, pinned = false, warming = warmCache;
  let settings = { cacheDays, cacheBytes };
  let projectionRetryAt=0,projectionFailures=0;
  let projectionRequested=false,projectionWritable=true,projectionRetirement=null,projectionRetireAck=null; const projectionInputs=new Set(),projectionDemands=new Map(),anchorFlights=new Set();
  const projectionCacheId=derivedCacheId(projectionCachePath,cacheIdentity);
  const anchor=derivedCacheAnchor??(!store.readOnly&&typeof store.runWrite==='function'?(request,{isCurrent})=>createDerivedCacheAnchorOwner({store,cacheId:projectionCacheId,purpose:'firewood',isCurrent})(request):null);
  const validSettings = value => value && Number.isInteger(value.cacheDays) && value.cacheDays >= 0 && value.cacheDays <= 14
    && Number.isSafeInteger(value.cacheBytes) && value.cacheBytes >= 64 * 1024 * 1024 && value.cacheBytes <= 2048 * 1024 * 1024;
  if (!validSettings(settings)) throw new TypeError('Invalid chart cache settings');
  const lanes = Object.fromEntries(['resident', 'archive'].map(name => [name,
    { name, worker: null, active: null, queue: [], retiring: null, timer: null, observations: new Map() }]));
  let inventoryService, energyChecksService;
  const inventory = () => inventoryService ??= createInventoryService({ store, clock });
  const energy = () => energyChecksService ??= createEnergyChecksService({ store, clock });
  const inspect = (service, method, args, options = {}) => {
    if (closed) return Promise.reject(new Error('Chart service is closed'));
    if (options.signal?.aborted) return Promise.reject(aborted());
    const context = { ...options, checkpoint: options.checkpoint ?? store.expectedCheckpoint };
    return service()[method](...args, context);
  };
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
    for(const flight of anchorFlights) if(flight.lane===lane) flight.controller.abort();
    const previous = lane.worker; lane.worker = null;
    if (previous) {
      // Admission cleanup must observe release/exit through termination. The
      // service's own handlers already ignore this retired worker generation.
      const observations = [...lane.observations.values()]; lane.observations.clear();
      lane.retiring = previous.terminate().finally(() => {
        for (const entry of observations) entry.observation?.finish(outcome, { reason });
        lane.retiring = null; if(lane.name==='resident') {projectionRetireAck?.();projectionRetireAck=null;} pump();
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
        lane.timer = setTimeout(() => reset(lane), idleMs); lane.timer.unref();
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
          workerData: { dbPath: store.path, projectionCachePath, projectionCacheId, projectionWritable:projectionWritable&&lane.name==='resident', anchorAvailable:Boolean(anchor), resident: lane.name === 'resident', settings,
            storageSignal: storageSignal.buffer, requestSignal: lane.requestSignal.buffer, storageLeaseMs: 25 },
        });
        attachStorageAdmission(lane.worker, storageSignal, (operation, { maintenance }) => store.runStorageTask(operation, { kind: maintenance ? 'chart-cache' : 'history' }));
        const generation = lane.worker;
        lane.worker.on('message', message => {
          if (lane.worker !== generation) return;
          if(message.type==='derived-cache-anchor-cancel') {for(const flight of anchorFlights) if(flight.lane===lane&&flight.requestId===message.requestId) flight.controller.abort();return;}
          if(message.type==='projection-retired') {projectionRetireAck?.();projectionRetireAck=null;return;}
          if(message.type==='derived-cache-anchor') {
            const response=new Int32Array(message.response,0,2),bytes=new Uint8Array(message.response,8);
            const complete=value=>{
              if(Atomics.load(response,0)!==0) return;
              const encoded=new TextEncoder().encode(JSON.stringify(value));
              if(encoded.length>bytes.length) {Atomics.store(response,0,-1);Atomics.notify(response,0);return;}
              bytes.set(encoded);Atomics.store(response,1,encoded.length);Atomics.compareExchange(response,0,0,1);Atomics.notify(response,0);
            };
            const entry=lane.active,controller=new AbortController();
            const isCurrent=()=>!closed&&projectionWritable&&!controller.signal.aborted&&lane.worker===generation&&lane.active===entry
              &&entry?.id===message.operationId&&!entry.aborted;
            if(!isCurrent()) {complete({error:'The firewood cache worker changed.'});return;}
            entry.anchorControllers??=new Set();entry.anchorControllers.add(controller);
            const flight={lane,controller,requestId:message.requestId};anchorFlights.add(flight);
            const abortedFlight=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(aborted()),{once:true}));
            const operation=Promise.resolve().then(()=>{
              if(!isCurrent()||!anchor) throw new Error('Derived cache proof unavailable');
              return anchor(message.request,{isCurrent,signal:controller.signal});
            });
            flight.promise=Promise.race([operation,abortedFlight]).then(proof=>complete(isCurrent()?{proof}:{error:'The firewood cache worker changed.'}),
              error=>complete({error:'The disposable firewood comparison proof is unavailable.',code:error.code==='DERIVED_CACHE_ANCHOR_REFUSED'?error.code:undefined})).finally(()=>{
                anchorFlights.delete(flight);entry.anchorControllers.delete(controller);
              });
            return;
          }
          if (message.storage) return;
          if (message.cacheStatus) {
            lane.cacheStatus=message.cacheStatus;
            const firewood=message.cacheStatus.firewood;
            if(firewood?.failed) projectionRetryAt=Date.now()+Math.min(30_000,1000*2**Math.min(5,projectionFailures++));
            else if(firewood&&!firewood.retrying) {projectionFailures=0;projectionRetryAt=0;}
            return;
          }
          if (message.storageOperationComplete) {
            const observed = lane.observations.get(message.id); lane.observations.delete(message.id);
            if (message.cacheHit) observed?.observation?.discard();
            else observed?.observation?.finish(observed.aborted ? 'cancelled' : message.failed ? 'failed' : 'completed',
              { reason: observed.aborted ? 'cancelled' : message.failed ? 'operation-failed' : null });
            if (message.id === lane.active?.id) {
              const entry = lane.active; lane.active = null;
              const response = entry.response;
              const error = response?.error ? Object.assign(new Error(response.error.message), { name: response.error.name }) : null;
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
    if (closed || !projectionWritable || !warming && !projectionRequested || store.path === ':memory:') return;
    if (!Object.values(lanes).some(lane => lane.active || lane.queue.length || lane.retiring)) {
      void query({ now: clock(), inputs:[...projectionInputs], demands:[...projectionDemands.values()], skipFirewood:Date.now()<projectionRetryAt }, { operation: 'maintain' }).catch(() => {});
    }
    maintenanceTimer = setTimeout(maintain, lanes.resident.cacheStatus?.complete ? 1000 : lanes.resident.cacheStatus?.firewood?.complete === false ? 25 : 250); maintenanceTimer.unref();
  }
  function startWarming() {
    warming = true;
    if(!projectionWritable) return;
    if (!closed && (settings.cacheDays||projectionRequested) && !maintenanceTimer) { maintenanceTimer = setTimeout(maintain, 250); maintenanceTimer.unref(); }
  }
  if (warming) startWarming();
  function query(args, { signal, operation = 'chart', onProgress, wire, checkpoint = store.expectedCheckpoint } = {}) {
    if (closed) return Promise.reject(new Error('Chart service is closed'));
    if (signal?.aborted) return Promise.reject(aborted());
    args = { ...args, now: args?.now ?? Date.now() };
    try {
      if (!['chart', 'pin', 'pin-archive', 'maintain'].includes(operation)) throw new TypeError('Invalid history operation');
      if (operation === 'chart') {
        chartRequestRange(args);
        if(!['mqtt','providers','simulated','offline'].includes(args.input??'offline')) throw new TypeError('Unknown chart input');
      }
      if (wire !== undefined && !['json', 'ndjson'].includes(wire)) throw new TypeError('Invalid chart response format');
    } catch (error) { return Promise.reject(error); }
    if(operation==='chart'&&projectionWritable&&chartNeedsAssessment(args)) {
      projectionInputs.add(args.input??'offline');projectionRequested=true;
      const from=chartRequestRange(args).range.from,key=`${args.input??'offline'}:${from}`;
      projectionDemands.delete(key);projectionDemands.set(key,{input:args.input??'offline',from});
      while(projectionDemands.size>8) projectionDemands.delete(projectionDemands.keys().next().value);
      if(!maintenanceTimer&&store.path!==':memory:') {maintenanceTimer=setTimeout(maintain,25);maintenanceTimer.unref();}
    }
    if (store.path === ':memory:') {
      const observation = ['pin', 'pin-archive', 'maintain'].includes(operation) ? null : storageOperationHealth.begin('history-query', { scope: 'history' });
      try {
        if (['pin', 'pin-archive'].includes(operation)) return Promise.resolve({ ready: true });
        const result = getChartData({ ...args, store, onProgress });
        const prepared = operation === 'chart' ? prepareChartResponse(result) : null;
        const response = wire ? encodeChartResponse(result, prepared, wire) : result;
        observation?.finish('completed'); return Promise.resolve(response);
      } catch (error) { observation?.finish('failed', { reason: 'operation-failed' }); return Promise.reject(error); }
    }
    const range = operation === 'chart' ? chartRequestRange(args).range : null;
    const residentFrom = settings.cacheDays ? clock() - settings.cacheDays * 86_400_000 : Infinity;
    const lane = operation === 'maintain' || operation === 'pin' || range && range.from >= residentFrom - 86_400_000
      ? lanes.resident : lanes.archive;
    const count = item => item.queue.length + Number(Boolean(item.active && !item.active.aborted));
    if (count(lane) >= maxQueue) {
      storageOperationHealth.refuse('history-query');
      return Promise.reject(new RangeError('Too many pending chart requests'));
    }
    return new Promise((resolve, reject) => {
      const entry = { id: nextId++, args, operation, wire, checkpoint, signal, onProgress, resolve, reject, abort: null,
        observation: ['pin', 'pin-archive', 'maintain'].includes(operation) ? null : storageOperationHealth.begin('history-query', { queued: true, scope: 'history' }) };
      entry.abort = () => {
        for(const controller of entry.anchorControllers??[]) controller.abort();
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
  return {
    async pin(options = {}) {
      // Replica leases may outlive a path's publication. Open both file handles
      // before that path can be retired, and retain them until this lease owner closes.
      pinned = true;
      for (const lane of Object.values(lanes)) { clearTimeout(lane.timer); lane.timer = null; }
      await Promise.all(['pin', 'pin-archive'].map(operation => query({}, { ...options, operation })));
      return { ready: true };
    },
    overview(options = {}) { return inspect(inventory, 'view', [], options); },
    overviewAction(input, options = {}) { return inspect(inventory, 'action', [input], options); },
    energyChecks(args = {}, options = {}) { return inspect(energy, 'view', [], { ...args, ...options }); },
    energyChecksAction(input, args = {}, options = {}) { return inspect(energy, 'action', [input], { ...args, ...options }); },
    query,
    retireProjection() {
      if(projectionRetirement) return projectionRetirement;
      projectionWritable=false;clearTimeout(maintenanceTimer);maintenanceTimer=null;
      for(const pendingLane of Object.values(lanes)) for(const entry of [...pendingLane.queue]) if(entry.operation==='maintain') {
        pendingLane.queue.splice(pendingLane.queue.indexOf(entry),1);settle(entry,aborted());
      }
      for(const flight of anchorFlights) flight.controller.abort();
      const lane=lanes.resident;
      const stopped=!lane.worker?(lane.retiring??Promise.resolve()):new Promise(resolve=>{
        projectionRetireAck=resolve;
        lane.worker.postMessage({retireProjection:true});
      });
      projectionRetirement=stopped.then(()=>Promise.allSettled(Array.from(anchorFlights,flight=>flight.promise)));
      return projectionRetirement;
    },
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
      await Promise.allSettled([...Object.values(lanes).map(lane => lane.retiring),...Array.from(anchorFlights,flight=>flight.promise),
        inventoryService?.close(), energyChecksService?.close()].filter(Boolean));
    },
  };
}
