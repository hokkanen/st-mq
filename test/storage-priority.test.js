import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { Store } from '../src/storage/store.js';
import { attachStorageAdmission } from '../src/storage/worker-admission.js';
import { peerOperation } from '../src/replication/coalesced.js';
import { enrollJournalPeer, preparePeerTransfer, peerTransferRows, applyPeerTransfer, acknowledgePeer } from '../src/storage/journal-peer.js';
import { verifyJournal } from '../src/storage/journal.js';
import { createChartService } from '../src/app/chart-service.js';

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'stmq-storage-priority-'));
  const store=new Store(join(directory,'source.sqlite'));
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});
  return {store,directory};
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('controller writes overtake queued storage batches without interrupting an admitted batch',async t=>{
  const {store}=await fixture(t);await store.startWriter();store.walMaintenance.close();
  const order=[];let release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const first=store.runStorageTask(async()=>{order.push('batch1');started();await new Promise(resolve=>{release=resolve;});order.push('batch1-end');});
  await entered;
  const second=store.runStorageTask(()=>order.push('batch2'));
  const normal=store.runWrite(()=>{store.setState('ordinary',1);order.push('normal');});
  const control=store.runWrite(()=>{store.setState('control',1);order.push('control');},{priority:'control'});
  await turn();assert.deepEqual(order,['batch1']);
  release();await Promise.all([first,second,normal,control]);
  assert.deepEqual(order,['batch1','batch1-end','control','normal','batch2']);
  assert.equal(store.getState('control'),1);verifyJournal(store.db);
});

test('worker cancellation releases its storage reservation only after worker exit',async t=>{
  const {store}=await fixture(t);await store.startWriter();store.walMaintenance.close();
  const signal=new Int32Array(new SharedArrayBuffer(4));
  const url=new URL('../src/storage/worker-admission.js',import.meta.url).href;
  const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(`
    import {parentPort} from 'node:worker_threads';import {storageStep} from ${JSON.stringify(url)};
    storageStep(()=>{parentPort.postMessage({entered:true});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});
  `)),{workerData:{storageSignal:signal.buffer}});
  t.after(()=>worker.terminate());
  attachStorageAdmission(worker,signal,operation=>store.runStorageTask(operation));
  await once(worker,'message');
  // The first message requests admission; wait for the actual native section.
  await once(worker,'message');
  let exited=false,committed=false;worker.once('exit',()=>{exited=true;});
  const urgent=store.runWrite(()=>{assert(exited);store.setState('after-exit',true);committed=true;},{priority:'control'});
  await turn();assert.equal(committed,false);
  await worker.terminate();await urgent;assert.equal(store.getState('after-exit'),true);
});

test('cancelling a chart releases storage admission requested before worker termination',async t=>{
  const {store}=await fixture(t);await store.startWriter();store.walMaintenance.close();
  const charts=createChartService({store}),controller=new AbortController();
  let releaseHeld,entered,requested,admitted,rescue;
  const heldEntered=new Promise(resolve=>{entered=resolve;});
  const historyRequested=new Promise(resolve=>{requested=resolve;});
  const historyAdmitted=new Promise(resolve=>{admitted=resolve;});
  const rescued=new Promise(resolve=>{rescue=resolve;});
  const held=store.runStorageTask(async()=>{entered();await new Promise(resolve=>{releaseHeld=resolve;});});
  await heldEntered;
  const original=store.runStorageTask;let historyTurn,completed=false;
  store.runStorageTask=function(operation,options={}) {
    if(options.kind!=='history')return original.call(this,operation,options);
    historyTurn=original.call(this,async()=>{
      const work=operation();admitted();
      // Rescue a broken reservation in cleanup so a regression cannot hang
      // the suite while closing the real Store.
      await Promise.race([work,rescued]);
    },options).then(()=>{completed=true;});
    requested();return historyTurn;
  };
  try {
    const rejected=assert.rejects(charts.pin({signal:controller.signal}),{name:'AbortError'});
    await historyRequested;controller.abort();await rejected;
    await charts.close(); // Join termination while its admission is still queued.
    releaseHeld();await held;await historyAdmitted;await turn();
    assert.equal(completed,true,'A terminated chart worker must release its queued storage turn');
    await store.runWrite(()=>store.setState('after-chart-cancel',true),{priority:'control'});
    assert.equal(store.getState('after-chart-cancel'),true);
  } finally {
    rescue();releaseHeld();await held;await historyTurn;
    store.runStorageTask=original;await charts.close();
  }
});

test('continuous ordinary ingestion cannot starve background maintenance',async t=>{
  const {store}=await fixture(t);await store.startWriter();store.walMaintenance.close();
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});const order=[];
  const held=store.runStorageTask(async()=>{entered();await new Promise(resolve=>{release=resolve;});});
  await started;
  const background=store.runStorageTask(()=>order.push('maintenance'));
  const writes=Array.from({length:64},(_,i)=>store.runWrite(()=>order.push(i)));
  release();await Promise.all([held,background,...writes]);
  assert.equal(order.indexOf('maintenance'),32);
  assert.deepEqual(order.filter(value=>typeof value==='number'),Array.from({length:64},(_,i)=>i));
});

test('batched private staging preserves one frozen target while later writes continue',async t=>{
  const {store,directory}=await fixture(t);enrollJournalPeer(store.db);
  const base=store.checkpoint();await store.backup(join(directory,'replica.sqlite'));
  const replica=new Store(join(directory,'replica.sqlite'));t.after(()=>replica.close());
  for(let i=0;i<48;i++)store.setState(`item:${i}`,{value:i,text:'synthetic'.repeat(400)});
  const target=store.checkpoint();let turns=0,changed=false;
  const metadata=preparePeerTransfer(store.db,{after:base,step:operation=>{
    const result=operation();turns++;
    if(!changed&&store.db.isTransaction&&turns>7) {
      // A second connection writes after the read snapshot has been pinned.
      const concurrent=new Store(store.path);try{concurrent.setState('after-freeze',true);}finally{concurrent.close();}changed=true;
    }
    return result;
  }});
  assert(changed);assert(turns>15);assert.deepEqual(metadata.target,target);
  const changes=[];let ordinal=-1;
  for(;;){const rows=peerTransferRows(store.db,{id:metadata.id,afterOrdinal:ordinal,limit:3,maxBytes:1024});if(!rows.length)break;
    for(const row of rows){changes.push(row.change);ordinal=row.ordinal;}}
  applyPeerTransfer(replica.db,{...metadata,changes});
  assert.equal(replica.getState('after-freeze'),null);assert.deepEqual(replica.checkpoint(),target);
  let result;do{result=acknowledgePeer(store.db,{checkpoint:target,limit:3,maxBytes:1024});}while(!result.complete);
  const next=preparePeerTransfer(store.db,{after:target});assert(next.rows>0);verifyJournal(store.db);verifyJournal(replica.db);
});

test('a coordinated mirror worker admits a real urgent save between file/database steps',async t=>{
  const {store,directory}=await fixture(t);enrollJournalPeer(store.db);const base=store.checkpoint();
  for(let i=0;i<64;i++)store.setState(`payload:${i}`,{text:'synthetic'.repeat(1000),i});
  await store.startWriter();let turns=0,urgent;
  const delivery=await peerOperation('export',{dbPath:store.path,directory:join(directory,'exports'),after:base,
    managedCheckpoints:true,onYield:()=>store.runWrite(()=>{}),onStorage:operation=>store.runStorageTask(async()=>{
      turns++;if(turns===10)urgent=store.runWrite(()=>store.setState('urgent',true),{priority:'control'});
      return operation();
    })});
  await urgent;assert(turns>20);assert.equal(store.getState('urgent'),true);assert(delivery.rows>=64);
  assert(store.storageTurns.some(row=>row.kind==='mirror'));verifyJournal(store.db);
});

test('managed checkpoint owns FULL synchronization and leaves ordinary saves outside native checkpoint work',async t=>{
  const {store}=await fixture(t);await store.startWriter();store.walMaintenance.close();
  const policy=await store.runPublication(()=>({auto:store.writer.call('statement',{sql:'PRAGMA wal_autocheckpoint',method:'get'}).wal_autocheckpoint,
    synchronous:store.writer.call('statement',{sql:'PRAGMA synchronous',method:'get'}).synchronous}));
  assert.deepEqual(policy,{auto:0,synchronous:2});
  // Accumulate beyond the current trigger without relying on its old value.
  for (let n=0;n<8;n++) await store.runWrite(()=>store.setState('large-'+n,{text:'x'.repeat(512*1024)}));
  const checkpoint=await store.runStorageTask(()=>store.writer.request('checkpoint'),{kind:'checkpoint'});
  assert.equal(checkpoint.ran,true);assert.equal(checkpoint.log,checkpoint.checkpointed);
  assert.equal(store.getState('large-7').text.length,512*1024);verifyJournal(store.db);
});

for (const worker of [false, true]) test(`chart warming yields to every requested storage task (${worker ? 'worker' : 'direct'} writer)`, async t => {
  const { store } = await fixture(t); if (worker) await store.startWriter(); store.walMaintenance?.close();
  const order = []; let enter, release;
  const started = new Promise(resolve => { enter = resolve; });
  const held = store.runStorageTask(async () => { enter(); await new Promise(resolve => { release = resolve; }); });
  await started;
  const cache = store.runStorageTask(() => order.push('cache'), {kind: 'chart-cache'});
  const history = store.runStorageTask(() => order.push('history'), {kind: 'history'});
  const mirror = store.runStorageTask(() => order.push('mirror'), {kind: 'mirror'});
  const writes = Array.from({length: 40}, () => store.runWrite(() => order.push('write')));
  release(); await Promise.all([held, cache, history, mirror, ...writes]);
  assert.equal(order.at(-1), 'cache'); assert(order.indexOf('history') < order.indexOf('mirror'));
});

test('an enclosing cache batch retains its turn through cursor yields and releases only after ROLLBACK', async t => {
 const {store}=await fixture(t);await store.startWriter();store.walMaintenance.close();
 const signal=new Int32Array(new SharedArrayBuffer(4)),gate=new Int32Array(new SharedArrayBuffer(4));
 const url=new URL('../src/storage/worker-admission.js',import.meta.url).href;
 const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(`
  import {parentPort,workerData} from 'node:worker_threads';import {DatabaseSync} from 'node:sqlite';
  import {storageStep,admittedReader,setStorageMaintenance} from ${JSON.stringify(url)};
  setStorageMaintenance(true);const db=admittedReader(storageStep(()=>new DatabaseSync(workerData.path,{readOnly:true})));
  storageStep(()=>{db.exec('BEGIN');let n=0;
   for(const row of db.prepare('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<256) SELECT x FROM n').iterate())
    if(++n===64){parentPort.postMessage({midpoint:true});Atomics.wait(new Int32Array(workerData.gate),0,0);}
   db.exec('ROLLBACK');
  });db.close();parentPort.close();
 `)),{workerData:{storageSignal:signal.buffer,gate:gate.buffer,path:store.path}});
 t.after(()=>{Atomics.store(gate,0,1);Atomics.notify(gate,0);return worker.terminate();});
 attachStorageAdmission(worker,signal,(operation,{maintenance})=>store.runStorageTask(operation,{kind:maintenance?'chart-cache':'history'}));
 await new Promise(resolve=>worker.on('message',message=>{if(message.midpoint)resolve();}));
 let committed=false;const urgent=store.runWrite(()=>{committed=true;store.setState('after-cache-batch',1);},{priority:'control'});
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(committed,false);
 const exited=once(worker,'exit');Atomics.store(gate,0,1);Atomics.notify(gate,0);await urgent;await exited;
 assert.equal(store.getState('after-cache-batch'),1);
});
