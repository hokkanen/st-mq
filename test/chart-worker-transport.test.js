import { storageOperationHealth } from '../src/storage/operation-health.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { createChartService } from '../src/app/chart-service.js';
import { createAppServer } from '../src/app/server.js';
import { getChartData } from '../src/app/chart-data.js';

const now = Date.parse('2026-09-07T09:00:00Z');
const args = { input: 'providers', now, startDate: '2026-09-06', endDate: '2026-09-06', view: 'garage', points: 100 };
function fixture(t, options) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-chart-transport-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  store.observation({ source: 'synthetic-chart', device: 'invented-garage', signal: 'garage_native_indoor_temperature',
    sourceTime: now - 86_400_000, receivedAt: now - 86_400_000, value: 12, unit: 'degC' });
  const service = createChartService({ store, clock: () => now, ...options });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, service };
}

test('prepared JSON and streamed result carry identical evidence and stable semantic revision', async t => {
  const { service } = fixture(t), progress = [];
  const observationBefore = storageOperationHealth.status().coverage.find(row => row.kind === 'history-query').week.completed;
  const plain = JSON.parse(Buffer.from(await service.queryWire(args, { onProgress: value => progress.push(value) })));
  const streamed = JSON.parse(Buffer.from(await service.queryWire(args, { format: 'ndjson' })));
  assert.equal(streamed.type, 'result');
  assert.equal(streamed.data.meta.cacheHit, true);
  assert.match(plain.meta.contentRevision, /^[a-f0-9]{64}$/);
  assert.equal(streamed.data.meta.contentRevision, plain.meta.contentRevision);
  assert.deepEqual(streamed.data.series, plain.series);
  assert(progress.some(value => value.stage === 'queued'));
  assert(progress.some(value => value.stage === 'preparing-response'));
  assert(progress.every(value => value.total === undefined || value.completed >= 0 && value.completed <= value.total));
  // Completion is a separate worker receipt sent after releasing its snapshot.
  await service.pin(); // FIFO worker messages join both earlier completion receipts.
  const observed = storageOperationHealth.status().coverage.find(row => row.kind === 'history-query');
  assert.equal(observed.running, 0);
  assert.equal(observed.week.completed, observationBefore + 1, 'the cached request is not another completed storage job');
});

test('canceling archive work retains the resident cache and queue capacity', async t => {
  const { service } = fixture(t, { maxQueue: 1 });
  await service.query(args);
  const cancellation = new AbortController();
  const speculative = service.query({ ...args, startDate: '2025-01-01', view: 'power' }, { signal: cancellation.signal });
  const foreground = service.query(args);
  cancellation.abort();
  await assert.rejects(speculative, { name: 'AbortError' });
  assert.equal((await foreground).meta.cacheHit, true);
  assert.equal((await service.query(args)).meta.cacheHit, true);
});

test('new foreground selection starts after obsolete worker retirement and stale work never publishes', async t => {
  const { store, service } = fixture(t);
  const from = Date.parse('2025-01-01T00:00:00Z');
  for (let offset = 0; offset < 20_000; offset += 256) store.transaction(() => {
    for (let index = offset; index < Math.min(20_000, offset + 256); index++) store.observation({ source: 'synthetic-chart', device: 'invented-garage',
      signal: 'garage_native_indoor_temperature', sourceTime: from + index * 900_000,
      receivedAt: from + index * 900_000, value: 10 + index % 5, unit: 'degC' });
  });
  const cancellation = new AbortController();
  let beganTraversal = false;
  const old = service.query({ ...args, startDate: '2025-01-01', endDate: '2025-12-31' }, {
    signal: cancellation.signal, onProgress: value => {
      // This is emitted inside the real worker, after opening its read snapshot.
      if (value.stage === 'reading-history' && value.total > 0) { beganTraversal = true; cancellation.abort(); }
    },
  });
  await assert.rejects(old, { name: 'AbortError' });
  assert.equal(beganTraversal, true);
  const fresh = await service.query(args);
  assert.equal(fresh.range.startDate, '2026-09-06');
  assert(fresh.series.garage_native_indoor_temperature.some(point => point.y === 12));
});

test('archive work cannot evict resident results and cache configuration applies without restart', async t => {
  const { service } = fixture(t);
  const first = await service.query(args);
  await service.query({ ...args, startDate: '2025-01-01' });
  assert.equal((await service.query(args)).meta.cacheHit, true);
  service.configure(service.cacheStatus());
  assert.equal((await service.query(args)).meta.cacheHit, true, 'Unchanged cache settings retain prepared history');
  service.configure({ cacheDays: 0, cacheBytes: 64 * 1024 * 1024 });
  const fresh = await service.query(args);
  assert.notEqual(fresh.meta.cacheHit, true); assert.deepEqual(fresh.series, first.series);
  assert.equal(service.cacheStatus().cacheDays, 0);
});

test('idle workers release their cache and reopen without changing evidence', async t => {
  const { service } = fixture(t, { idleMs: 10, cacheDays: 0 });
  const first = await service.query(args);
  await new Promise(resolve => setTimeout(resolve, 60));
  const reopened = await service.query(args);
  assert.notEqual(reopened.meta.cacheHit, true);
  assert.deepEqual(reopened.series, first.series);
  assert.equal(reopened.meta.contentRevision, first.meta.contentRevision);
});

async function serverFixture(t, options = {}) {
  const { store, service } = fixture(t);
  const engine = { clock: () => now, config: { input: 'providers' }, contract: () => null };
  const server = createAppServer({ store, engine, chartService: service, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { service, server, base: `http://127.0.0.1:${server.address().port}` };
}

test('NDJSON HTTP sends stage progress then one current chart result and rejects the retired prefetch header', async t => {
  const { base } = await serverFixture(t);
  const headers = { Accept: 'application/x-ndjson' };
  const response = await fetch(`${base}/api/chart?start=2026-09-06&view=garage`, { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const messages = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages[0].type, 'progress');
  assert.equal(messages.at(-1).type, 'result');
  assert.equal(messages.filter(value => value.type === 'result').length, 1);
  assert(messages.at(-1).data.series.garage_native_indoor_temperature.some(point => point.y === 12));
  const invalid = await fetch(`${base}/api/chart?start=2026-09-01&end=2026-09-08`, {
    headers: { ...headers, 'X-Chart-Prefetch': '1' },
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /Unsupported chart header/);
});

test('streamed chart cannot send prepared history after web access is revoked', async t => {
  let access = { enabled: true, token: '', familyToken: '', tokenRequired: false };
  const { base, service } = await serverFixture(t, { getAccess: () => access });
  const queryWire = service.queryWire.bind(service);
  service.queryWire = async (request, options) => {
    const bytes = await queryWire(request, options);
    access = { ...access, enabled: false };
    return bytes;
  };
  const response = await fetch(`${base}/api/chart?start=2026-09-06&view=garage`, { headers: { Accept: 'application/x-ndjson' } });
  const messages = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert(messages.some(value => value.type === 'progress'));
  assert(!messages.some(value => value.type === 'result'));
  assert.deepEqual(messages.at(-1), { type: 'error', message: 'Direct web access is disabled', status: 503 });
});

test('worker startup failures release their lane and allow the next valid selection', async t => {
  const { service } = fixture(t);
  await assert.rejects(service.query({ ...args, uncloneable: () => {} }), /could not start/);
  const result = await service.query(args);
  assert.equal(result.range.startDate, args.startDate);
});

test('recording continues during concurrent chart snapshots and later queries see the committed evidence', async t => {
  const { store, service } = fixture(t);
  const from = Date.parse('2026-09-01T00:00:00Z');
  for (let offset = 0; offset < 20_000; offset += 256) store.transaction(() => {
    for (let index = offset; index < Math.min(20_000, offset + 256); index++) store.observation({ source: 'synthetic-chart', device: 'invented-garage',
      signal: 'garage_native_indoor_temperature', sourceTime: from + index * 20_000,
      receivedAt: from + index * 20_000, value: 10 + index % 5, unit: 'degC' });
  });
  const selection = { ...args, startDate: '2026-09-01', endDate: '2026-09-07' };
  let foreground, writes, entered = false, written = 0;
  function recording() {
    return new Promise((resolve, reject) => {
      const write = () => {
        try {
          const at = now - 60_000 + written;
          store.observation({ source: 'synthetic-chart', device: 'invented-garage', signal: 'garage_native_indoor_temperature',
            sourceTime: at, receivedAt: at, value: 33, unit: 'degC' });
          store.setState('synthetic-recording-checkpoint', { written: ++written });
          if (written < 20) setImmediate(write); else resolve();
        } catch (error) { reject(error); }
      };
      write();
    });
  }
  const speculative = service.query({ ...selection, startDate: '2025-01-01' }, { onProgress(value) {
    if (foreground || value.stage !== 'reading-history' || !value.total) return;
    foreground = service.query(selection, { onProgress(progress) {
      if (!entered && progress.stage === 'reading-history' && progress.total) {
        entered = true; writes = recording();
      }
    } });
  } });
  await speculative;
  const result = await foreground;
  await writes;
  assert.equal(entered, true, 'Recording began inside the foreground traversal stage');
  assert.equal(written, 20);
  assert(!result.series.garage_native_indoor_temperature.some(point => point.y === 33),
    'A chart reads one committed snapshot while the writer continues');
  const refreshed = await service.query(selection);
  assert(refreshed.series.garage_native_indoor_temperature.some(point => point.y === 33),
    'The next chart invalidates its cache and admits newly committed evidence');
});

test('new observations outside the selected dates retain completed plots, late rows inside refresh them', async t => {
  const { store, service } = fixture(t);
  await service.query(args);
  store.observation({ source: 'synthetic-chart', device: 'invented-garage', signal: 'garage_native_indoor_temperature',
    sourceTime: now, receivedAt: now, value: 18, unit: 'degC' });
  assert.equal((await service.query(args)).meta.cacheHit, true);
  store.observation({ source: 'synthetic-chart', device: 'invented-garage', signal: 'garage_native_indoor_temperature',
    sourceTime: now - 86400000 + 1000, receivedAt: now, value: 19, unit: 'degC' });
  const changed = await service.query(args);
  assert.notEqual(changed.meta.cacheHit, true);
  assert(changed.series.garage_native_indoor_temperature.some(point => point.y === 19));
});

test('receipt clock movement outside completed dates retains plots while delayed in-range evidence becomes visible', async t => {
 const {store,service}=fixture(t,{warmCache:false});
 await service.query(args);
 store.observation({source:'synthetic-chart',device:'invented-garage',signal:'garage_native_indoor_temperature',
  sourceTime:now+1000,receivedAt:now+1000,value:18,unit:'degC'});
 assert.equal((await service.query(args)).meta.cacheHit,true,'A future receipt outside the selected dates is irrelevant');
 assert.equal((await service.query({...args,now:now+2000})).meta.cacheHit,true,'Admitting that unrelated receipt is irrelevant');
 store.observation({source:'synthetic-chart',device:'invented-garage',signal:'garage_native_indoor_temperature',
  sourceTime:now-86400000+2000,receivedAt:now+4000,value:19,unit:'degC'});
 assert(!(await service.query({...args,now:now+2000})).series.garage_native_indoor_temperature.some(point=>point.y===19));
 assert((await service.query({...args,now:now+5000})).series.garage_native_indoor_temperature.some(point=>point.y===19),
  'A delayed receipt inside the selection invalidates when it becomes admissible');
});

test('admitting delayed energy refreshes shared reconstruction contexts at the same committed head', async t => {
 const {store,service}=fixture(t,{warmCache:false}),from=now-86400000;
 const selection={...args,view:undefined,left:'phase_energy'};
 const record=(start,end,value,receivedAt)=>store.transaction(()=>{
  for(let phase=1;phase<=3;phase++)store.observation({source:'easee',device:'invented-charger',
   signal:`ev1_energy_l${phase}`,value,unit:'kWh',sourceTime:end,receivedAt,quality:['estimated'],
   raw:{intervalStart:start,intervalEnd:end,durationMs:end-start,basis:'integrated-power-phase-allocation'}});
 });
 record(from,from+3600000,1,now);await service.query(selection);
 record(from+3600000,from+7200000,2,now+4000);
 const before=await service.query({...selection,now:now+2000}),head=store.db.prepare('SELECT MAX(id) n FROM observations').get().n;
 const after=await service.query({...selection,now:now+5000});
 assert.equal(store.db.prepare('SELECT MAX(id) n FROM observations').get().n,head);
 assert.notDeepEqual(after.series.ev1_energy_l1,before.series.ev1_energy_l1);
 assert.deepEqual(after.series,getChartData({...selection,now:now+5000,store}).series);
});

test('resident maintenance releases every read snapshot and configuration can disable and reenable it', async t => {
  const { store, service } = fixture(t);
  const until = Date.now() + 6000;
  while (!service.cacheStatus().resident?.ready && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(service.cacheStatus().resident?.ready, true);
  assert.equal(service.cacheStatus().resident.rows, 1);
  store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  assert.equal(store.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get().busy, 0);
  service.configure({cacheDays: 0, cacheBytes: 64 * 1024 * 1024});
  await service.pin();
  service.configure({cacheDays: 14, cacheBytes: 64 * 1024 * 1024});
  assert.equal(service.cacheStatus().cacheDays, 14);
});

test('HTTP negotiates gzip for JSON and progress streams and respects explicit gzip refusal', async t => {
  const { base } = await serverFixture(t);
  for (const accept of ['application/json', 'application/x-ndjson']) {
    const response = await fetch(`${base}/api/chart?start=2026-09-06&view=garage`, {
      headers: {Accept: accept, 'Accept-Encoding': 'gzip'} });
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.equal(response.headers.get('vary'), 'Accept-Encoding');
    const text = await response.text();
    const result = accept === 'application/json' ? JSON.parse(text) : JSON.parse(text.trim().split('\n').at(-1)).data;
    assert(result.series.garage_native_indoor_temperature.some(point => point.y === 12));
  }
  const response = await fetch(`${base}/api/chart?start=2026-09-06&view=garage`, {headers: {'Accept-Encoding':'gzip;q=0, identity'}});
  assert.equal(response.headers.get('content-encoding'), null); assert((await response.json()).series);
});

test('cancelling a requested recent view preserves the resident worker and already prepared plots', async t => {
  const { service } = fixture(t, {maxQueue:1});
  await service.query(args);
  const cancellation = new AbortController();
  const old = service.query({...args,view:'power'}, {signal:cancellation.signal,onProgress(progress) {
    if(progress.stage==='preparing-chart') cancellation.abort();
  }});
  await assert.rejects(old,{name:'AbortError'});
  const returned = await service.query(args);
  assert.equal(returned.meta.cacheHit,true);
});

test('revoking access during a compressed progress stream ends it once without a history payload', async t => {
 let access={enabled:true,token:'',familyToken:'',tokenRequired:false};
 const {base,service}=await serverFixture(t,{getAccess:()=>access});
 const queryWire=service.queryWire.bind(service);
 service.queryWire=(request,options)=>queryWire(request,{...options,onProgress(value){
  if(value.stage==='preparing-chart')access={...access,enabled:false};
  options.onProgress?.(value);
 }});
 const response=await fetch(`${base}/api/chart?start=2026-09-06&view=garage`,{headers:{Accept:'application/x-ndjson','Accept-Encoding':'gzip'}});
 const messages=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(response.headers.get('content-encoding'),'gzip');
 assert(!messages.some(value=>value.type==='result'));
 assert.equal(messages.filter(value=>value.type==='error').length,1);
 assert.equal(messages.at(-1).status,503);
});

test('cooperative cancellation closes a real SQL cursor before releasing its snapshot', async t => {
 const {store,service}=fixture(t,{warmCache:false});
 const from=now-26*3600000;
 for(let offset=0;offset<20000;offset+=256)store.transaction(()=>{
  for(let index=offset;index<Math.min(20000,offset+256);index++)store.observation({
   source:'synthetic-chart',device:'invented-garage',signal:'garage_native_indoor_temperature',value:10+index%5,unit:'degC',
   sourceTime:from+index*1000,receivedAt:from+index*1000});
 });
 const cancellation=new AbortController();let traversing=false;
 const pending=service.query(args,{signal:cancellation.signal,onProgress(progress){
  if(progress.stage==='reading-history'&&progress.completed>0&&progress.completed<progress.total){traversing=true;cancellation.abort();}
 }});
 await assert.rejects(pending,{name:'AbortError'});assert(traversing);
 await service.pin();
 assert.equal(store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy,0);
 const fresh=await service.query(args);
 assert(fresh.series.garage_native_indoor_temperature.some(point=>point.y===14));
});

test('warming can wait for startup and a zero-day configuration schedules no resident work', async t => {
 const {service}=fixture(t,{warmCache:false});
 await new Promise(resolve=>setTimeout(resolve,300));assert.equal(service.cacheStatus().resident,null);
 service.startWarming();
 const until=Date.now()+6000;
 while(!service.cacheStatus().resident?.ready&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,25));
 assert(service.cacheStatus().resident?.ready);
 service.configure({cacheDays:0,cacheBytes:64*1024*1024});
 await new Promise(resolve=>setTimeout(resolve,300));assert.equal(service.cacheStatus().resident,null);
});

test('queued chart requests retain their own checkpoint after the service default advances', async t => {
 const {store,service}=fixture(t,{warmCache:false});
 let release,entered;const waiting=new Promise(resolve=>{release=resolve}),started=new Promise(resolve=>{entered=resolve});
 const run=store.runStorageTask.bind(store);let held=false;
 store.runStorageTask=(operation,options)=>{
  if(!held){held=true;entered();return waiting.then(()=>run(operation,options));}
  return run(operation,options);
 };
 t.after(()=>release());
 store.expectedCheckpoint=store.checkpoint();
 const first=service.query(args);await started;
 const queued=service.query(args);
 store.expectedCheckpoint={...store.expectedCheckpoint,hash:'0'.repeat(64)};
 release();await first;assert.equal((await queued).meta.cacheHit,true);
 await assert.rejects(service.query(args),/checkpoint advanced/);
});

test('a pinned archive cancellation retains the open reader after its published file is removed', async t => {
 const directory=mkdtempSync(join(tmpdir(),'stmq-pinned-archive-')),path=join(directory,'synthetic.sqlite');
 const writer=new Store(path);
 writer.observation({source:'synthetic-chart',device:'invented-garage',signal:'garage_native_indoor_temperature',
  sourceTime:now-86400000,receivedAt:now-86400000,value:12,unit:'degC'});writer.close();
 const store=new Store(path,{readOnly:true}),service=createChartService({store,warmCache:false,clock:()=>now});
 t.after(async()=>{await service.close();await store.close();rmSync(directory,{recursive:true,force:true});});
 await service.pin();
 const selection={...args,startDate:'2026-01-01'},controller=new AbortController();
 const pending=service.query(selection,{signal:controller.signal,onProgress(progress){
  if(progress.stage==='preparing-chart')controller.abort();
 }});
 await assert.rejects(pending,{name:'AbortError'});unlinkSync(path);
 const next=await service.query(selection);
 assert(next.series.garage_native_indoor_temperature.some(point=>point.y===12));
});
