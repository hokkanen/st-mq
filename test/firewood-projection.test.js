import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChartService } from '../src/app/chart-service.js';
import { Store } from '../src/storage/store.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { recordLearningContext,replayLearningJournal,applyLearningRecord } from '../src/app/committed-learning.js';
import { fireplaceLearningContext } from '../src/app/fireplace-inputs.js';
import { addFireplace,removeFireplace } from '../src/app/fireplace.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';
import { getFirewoodBenefit,maintainFirewoodProjection } from '../src/app/firewood-benefit.js';
import { FirewoodProjectionCache } from '../src/app/firewood-projection-cache.js';
import { compactJournal,checkpointAt } from '../src/storage/journal.js';

const HOUR=3_600_000,DAY=24*HOUR,WINDOW=HOUR/4,START=Date.UTC(2026,0,1);
function fixture(t,{days=24,withContexts=false,trained=false,file=false}={}) {
  const directory=mkdtempSync(join(tmpdir(),'stmq-firewood-projection-'));
  const path=join(directory,'synthetic.sqlite');
  const source=new Store(file?path:':memory:');
  let projection=new FirewoodProjectionCache(path);
  const model=initialAdaptiveModel();if(trained) model.trainedAt=new Date(START-DAY).toISOString();
  const seed=trained?{version:1,samples:[],model,baselineC:21}:null;
  const loads=[addFireplace(source,'mqtt',{kg:8,requestId:'first-synthetic-load'},START),
    addFireplace(source,'mqtt',{kg:8,requestId:'last-synthetic-load'},START+(days-2)*DAY)];
  function append(index) {
    const at=START+index*WINDOW;
    appendLearningRecord(source,'mqtt','sample',{timestamp:at,windowStart:at-WINDOW,indoorC:21,
      outdoorC:0,solarRadiationWm2:0,targetC:21,phase:'normal',regime:'occupied',quality:[],
      compressorDuty:1,thermalCompressorDuty:1,auxKw:0,thermalAuxKw:0,
      actualModeKnown:true,compressorActivityObserved:true,auxiliaryObserved:true,auxiliaryRouteKnown:true},{seed});
  }
  for(let i=0;i<=days*96;i++) {
    if(withContexts&&i&&i%96===0) recordLearningContext(source,'mqtt',{phase:i%192?'normal':'reduction',regime:'occupied',targetC:21},START+i*WINDOW+5*60_000);
    append(i);
  }
  const now=START+days*DAY;
  const args={store:source,input:'mqtt',now,range:{from:now-DAY,to:now},priceIntervals:[{start:now-DAY,end:now,price:20}]};
  t.after(()=>{projection.close();source.close();rmSync(directory,{recursive:true,force:true});});
  return {source,args,loads,append,projection,attach(){source.firewoodProjection=projection;},
    reopen(){projection.close();projection=new FirewoodProjectionCache(path);source.firewoodProjection=projection;return projection;},
    size(){return statSync(join(directory,'temporary-firewood-projection','synthetic.sqlite.sqlite')).size;}};
}
function finish(args) {
  let turns=0,result;
  do {result=maintainFirewoodProjection({...args,maxRows:128});assert.ok(result.processed<=128);assert.ok(++turns<100);} while(!result.complete);
  return turns;
}
async function until(predicate,message,timeout=15_000) {
  const deadline=Date.now()+timeout;
  while(!predicate()) {assert.ok(Date.now()<deadline,typeof message==='function'?message():message);await new Promise(resolve=>setTimeout(resolve,20));}
}

test('cold firewood requests return preparing; bounded maintenance and restart retain exact recent comparison',t=>{
  const f=fixture(t),expected=getFirewoodBenefit(f.args);
  f.attach();
  const cold=getFirewoodBenefit(f.args);
  assert.equal(cold.summary.preparing,true);
  assert.equal(cold.summary.valueEuro,null);
  assert.ok(finish(f.args)>1);
  const actual=getFirewoodBenefit(f.args);
  assert.deepEqual(actual,expected);
  assert.ok(f.size()<256*1024,'Sparse prior-state checkpoints should remain small for a month');
  const beforeChanges=f.source.firewoodProjection.db.prepare('SELECT total_changes() n').get().n;
  for(let i=0;i<10;i++) assert.equal(maintainFirewoodProjection(f.args).complete,true);
  assert.equal(f.source.firewoodProjection.db.prepare('SELECT total_changes() n').get().n,beforeChanges,'Unchanged maintenance must not rewrite sidecar or LRU pages');
  f.reopen();
  // A new projection instance must read the sidecar rather than the object result cache.
  const alternate={db:f.source.db,firewoodProjection:f.source.firewoodProjection};
  assert.deepEqual(getFirewoodBenefit({...f.args,store:alternate}),expected);
});

test('off-grid selected and prior price boundaries resume before their first split with exact evidence',t=>{
  const f=fixture(t),now=f.args.now;
  const queries=[
    {...f.args,range:{from:now-DAY+5*60_000,to:now-7*60_000},priceIntervals:[{start:now-DAY+3*60_000,end:now-3*HOUR,price:12},{start:now-3*HOUR,end:now,price:-30}]},
    {...f.args,priceIntervals:[{start:now-5*DAY+11*60_000,end:now-4*DAY+7*60_000,price:15},...f.args.priceIntervals]},
  ];
  const expected=queries.map(getFirewoodBenefit);
  f.attach();finish(f.args);
  queries.forEach((args,i)=>assert.deepEqual(getFirewoodBenefit(args),expected[i]));
});

test('firewood correction invalidates the prefix and can never return stale savings',t=>{
  const f=fixture(t);f.attach();finish(f.args);
  const before=getFirewoodBenefit(f.args);assert.ok(before.summary.electricityAvoidedKwh>0);
  removeFireplace(f.source,'mqtt',{id:f.loads[1].id,requestId:'synthetic-correction'},f.args.now);
  assert.equal(getFirewoodBenefit(f.args).summary.preparing,true);
  finish(f.args);
  const rebuilt=getFirewoodBenefit(f.args);
  delete f.source.firewoodProjection;
  assert.deepEqual(rebuilt,getFirewoodBenefit(f.args));
});

test('ordinary forward journal appends catch up without reconstructing the archive',t=>{
  const f=fixture(t);f.attach();finish(f.args);
  const retained=f.source.firewoodProjection.latest('mqtt').cursor;
  f.append(24*96+1);
  const args={...f.args,now:f.args.now+WINDOW,range:{from:f.args.range.from,to:f.args.now+WINDOW},
    priceIntervals:[{...f.args.priceIntervals[0],end:f.args.now+WINDOW}]};
  const step=maintainFirewoodProjection(args);
  assert.equal(step.processed,1);assert.equal(step.complete,true);
  assert.ok(f.source.firewoodProjection.latest('mqtt').cursor>retained);
  const result=getFirewoodBenefit(args);delete f.source.firewoodProjection;
  assert.deepEqual(result,getFirewoodBenefit(args));
});

test('sidecar bodies and disk budget are independently bounded',t=>{
  const directory=mkdtempSync(join(tmpdir(),'stmq-firewood-sidecar-')),source=new Store(':memory:');
  const projection=new FirewoodProjectionCache(join(directory,'source.sqlite'),{maxBytes:4096});
  t.after(()=>{projection.close();source.close();rmSync(directory,{recursive:true,force:true});});
  projection.generation('mqtt','synthetic-signature',source.db,0,START);
  for(let i=1;i<=50;i++) projection.save('mqtt',{at:START+i*DAY,cursor:i,state:{value:Array.from({length:200},(_,n)=>`${i}:${n}:${Math.sin(n+i)}`)}},{checkpoint:true});
  const bytes=projection.db.prepare('SELECT SUM(length(payload)) bytes FROM snapshots').get().bytes;
  assert.ok(bytes<=4096);assert.equal(projection.nearest('mqtt',START+DAY),null);
  assert.throws(()=>projection.save('mqtt',{at:START,cursor:999,state:{tooLarge:'a'.repeat(5*1024*1024)}}),/bounded working size/);
});

test('off-grid control contexts do not move the completed-sample checkpoint boundary',t=>{
  const f=fixture(t,{days:10,withContexts:true}),expected=getFirewoodBenefit(f.args);
  f.attach();finish(f.args);
  assert.deepEqual(getFirewoodBenefit(f.args),expected);
});

test('future activation survives multiple maintenance batches and restart',t=>{
  const f=fixture(t,{days:10});
  f.append(15*96);
  for(let i=10*96+1;i<=12*96;i++) f.append(i);
  let args={...f.args,now:START+12*DAY,range:{from:START+11*DAY,to:START+12*DAY},priceIntervals:[{start:START+11*DAY,end:START+12*DAY,price:20}]};
  f.attach();finish(args);
  assert.equal(f.source.firewoodProjection.db.prepare('SELECT next_at FROM generation WHERE input=?').get('mqtt').next_at,START+15*DAY);
  f.reopen();
  args={...args,now:START+15*DAY,range:{from:START+11*DAY,to:START+15*DAY},priceIntervals:[{start:START+11*DAY,end:START+15*DAY,price:20}]};
  finish(args);
  const rebuilt=getFirewoodBenefit(args);delete f.source.firewoodProjection;
  assert.deepEqual(rebuilt,getFirewoodBenefit(args));
});

test('damaged valid-JSON cache bodies and malformed metadata are discarded and rebuilt',t=>{
  const f=fixture(t,{days:10});f.attach();finish(f.args);
  const projection=f.source.firewoodProjection;
  const row=projection.db.prepare('SELECT cursor FROM snapshots ORDER BY cursor DESC LIMIT 1').get();
  projection.db.prepare('UPDATE snapshots SET at=at+1 WHERE cursor=?').run(row.cursor);
  assert.equal(projection.latest('mqtt'),null,'Envelope metadata binds cursor and time as well as body bytes');
  projection.db.prepare("UPDATE generation SET proof='{}' WHERE input='mqtt'").run();
  finish(f.args);
  const rebuilt=getFirewoodBenefit(f.args);delete f.source.firewoodProjection;
  assert.deepEqual(rebuilt,getFirewoodBenefit(f.args));
});

test('manual projection rejects a later removal when the source clock moves backwards',t=>{
  const f=fixture(t,{days:10});
  removeFireplace(f.source,'mqtt',{id:f.loads[0].id,requestId:'rollback-time-removal'},START+9*DAY);
  f.attach();finish(f.args);f.reopen();
  const args={...f.args,now:START+2*DAY,range:{from:START,to:START+2*DAY},priceIntervals:[{start:START,end:START+2*DAY,price:20}]};
  finish(args);
  const rolled=getFirewoodBenefit(args);delete f.source.firewoodProjection;
  assert.deepEqual(rolled,getFirewoodBenefit(args));
  assert.equal(rolled.summary.fireplaceRevision,f.loads[0].revision,'Future removal and future load cannot enter earlier source revision');
});

test('weekly state retains nonzero electrical holdout cells and all prefix evidence exactly',t=>{
  const f=fixture(t,{days:12,trained:true});
  addFireplace(f.source,'mqtt',{kg:6,requestId:'third-independent-burn'},START+2*DAY);
  const expected=getFirewoodBenefit(f.args);
  assert.ok(expected.summary.evidence.normalObservedHours>=200);
  assert.equal(expected.summary.evidence.independentBurns,3);
  assert.ok(expected.summary.evidence.matchedFireHours>0);
  f.attach();finish(f.args);f.reopen();
  assert.deepEqual(getFirewoodBenefit(f.args),expected);
});

test('archive requests prepare through the sole resident owner even with raw chart warming disabled',async t=>{
  const f=fixture(t,{days:12,file:true});
  const service=createChartService({store:f.source,cacheDays:0,cacheBytes:64*1024*1024,warmCache:false,clock:()=>f.args.now});
  t.after(()=>service.close());
  const args={input:'mqtt',now:f.args.now,startDate:'2026-01-12',view:'power',summaryOnly:true};
  const cold=await service.query(args);assert.equal(cold.firewoodBenefit.preparing,true);
  const deadline=Date.now()+15_000;
  while(!service.cacheStatus().resident?.firewood?.complete) {
    assert.ok(Date.now()<deadline,'Requested firewood work must advance without recent raw-cache warming');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  const ready=await service.query(args);
  assert.notEqual(ready.firewoodBenefit.preparing,true);
  const anchor=f.source.db.prepare("SELECT value FROM state WHERE key GLOB 'derived-cache-anchor:firewood:*'").get();
  const proof=JSON.parse(anchor.value).active;
  assert.ok(proof,'Completed cache has a durable source-owned prefix proof');
  await service.close();
  f.source.setState('unrelated-synthetic-change',{value:1});
  compactJournal(f.source.db,{maxCommits:1,maxBytes:1024});
  assert.equal(checkpointAt(f.source.db,proof.source.sequence),null);
  const restarted=createChartService({store:f.source,cacheDays:0,cacheBytes:64*1024*1024,warmCache:false,clock:()=>f.args.now});
  try {
    const afterPruning=await restarted.query(args);
    assert.notEqual(afterPruning.firewoodBenefit.preparing,true,'The published source pin must survive normal transaction-journal pruning');
    assert.deepEqual(afterPruning.firewoodBenefit,ready.firewoodBenefit);
  } finally {await restarted.close();}
});

test('real chart maintenance leaves source proofs and sidecar unchanged for first-history demands',async t=>{
  const f=fixture(t,{days:3,file:true});
  const service=createChartService({store:f.source,cacheDays:14,cacheBytes:64*1024*1024,warmCache:false,clock:()=>f.args.now});
  t.after(()=>service.close());
  // Finnish midnight precedes this fixture's first UTC sample. A completed
  // projection must not keep replaying it to seek an impossible earlier point.
  await service.query({input:'mqtt',now:f.args.now,startDate:'2026-01-01',view:'power',summaryOnly:true});
  await until(()=>service.cacheStatus().resident?.firewood?.complete&&!service.cacheStatus().resident.firewood.failed,
    'The real owner should publish its completed comparison');
  const anchor=f.source.db.prepare("SELECT value FROM state WHERE key GLOB 'derived-cache-anchor:firewood:*'").get();
  assert.ok(JSON.parse(anchor.value).active);
  // A queued request left by an interrupted turn is cleared once as well.
  f.projection.request('mqtt',START-2*HOUR);
  const demands=[START-2*HOUR,START,START+DAY].map(from=>({input:'mqtt',from}));
  const maintain=()=>service.query({now:f.args.now,inputs:['mqtt'],demands},{operation:'maintain'});
  await maintain();
  assert.equal(f.projection.requested('mqtt'),null);
  const head=f.source.db.prepare('SELECT sequence FROM journal_meta WHERE id=1').get().sequence;
  const version=f.projection.db.prepare('PRAGMA data_version').get().data_version;
  const bytes=readFileSync(f.projection.path);
  for(let i=0;i<10;i++) await maintain();
  assert.equal(f.source.db.prepare('SELECT sequence FROM journal_meta WHERE id=1').get().sequence,head,
    'Idle real-owner maintenance must not append pin/publication commits to its source');
  assert.equal(f.projection.db.prepare('PRAGMA data_version').get().data_version,version,
    'Unchanged first-history demands must not commit sidecar updates');
  assert.deepEqual(readFileSync(f.projection.path),bytes);
  assert.equal(f.source.db.prepare("SELECT value FROM state WHERE key GLOB 'derived-cache-anchor:firewood:*'").get().value,anchor.value);
});

test('a transient projection lock never replaces another owner’s valid file',t=>{
  const f=fixture(t,{days:1}),projection=f.projection;
  const before=statSync(projection.path);
  projection.db.exec('BEGIN EXCLUSIVE');
  try {assert.throws(()=>new FirewoodProjectionCache(f.source.path===':memory:'?join(projection.path,'..','..','synthetic.sqlite'):f.source.path),/locked|busy/i);}
  finally {projection.db.exec('ROLLBACK');}
  assert.equal(statSync(projection.path).ino,before.ino);assert.equal(projection.current(),true);
});

test('held background proofs leave queries responsive and retirement fences every restarted worker',async t=>{
  const f=fixture(t,{days:3,file:true});let calls=0,abortedProof=false;
  const service=createChartService({store:f.source,cacheDays:0,cacheBytes:64*1024*1024,warmCache:false,idleMs:30,clock:()=>f.args.now,
    derivedCacheAnchor:(_request,{signal})=>{calls++;signal.addEventListener('abort',()=>{abortedProof=true;},{once:true});return new Promise(()=>{});}});
  t.after(()=>service.close());
  const args={input:'mqtt',now:f.args.now,startDate:'2026-01-03',view:'power',summaryOnly:true};
  assert.equal((await service.query(args)).firewoodBenefit.valueEuro,null);
  await until(()=>calls>0,'Background preparation should ask for a proof');
  const started=performance.now();
  const second=(await service.query(args)).firewoodBenefit;
  assert.ok(Number.isFinite(second.valueEuro)||second.status==='unavailable');
  assert.ok(performance.now()-started<1200,'A held proof must not hold foreground chart work');
  const retiring=performance.now();await service.retireProjection();
  assert.ok(performance.now()-retiring<1000,'Retirement must abort or bound an outstanding proof wait');assert.equal(abortedProof,true);
  const afterRetirement=readFileSync(f.projection.path),count=calls;
  await new Promise(resolve=>setTimeout(resolve,100));
  await service.pin();await service.query(args);
  assert.equal(calls,count,'A retired owner cannot regain proof/writing permission after idle worker replacement');
  assert.deepEqual(readFileSync(f.projection.path),afterRetirement);
  await service.close();
});

test('worker termination settles retirement even while a proof owner never replies',async t=>{
  const f=fixture(t,{days:2,file:true});let calls=0;
  const service=createChartService({store:f.source,cacheDays:0,cacheBytes:64*1024*1024,warmCache:false,clock:()=>f.args.now,
    derivedCacheAnchor:()=>{calls++;return new Promise(()=>{});}});
  await service.query({input:'mqtt',now:f.args.now,startDate:'2026-01-02',view:'power',summaryOnly:true});
  await until(()=>calls>0,'The proof should be held before terminating its worker');
  const started=performance.now();await Promise.all([service.retireProjection(),service.close()]);
  assert.ok(performance.now()-started<1000,'Lost workers must not leave a retirement acknowledgement pending');
});

test('standalone read-only sources prepare a cache without trying to publish source-owned state',async t=>{
  const f=fixture(t,{days:3,file:true}),reader=new Store(f.source.path,{readOnly:true});
  const service=createChartService({store:reader,cacheDays:0,cacheBytes:64*1024*1024,warmCache:false,clock:()=>f.args.now});
  try {
    const args={input:'mqtt',now:f.args.now,startDate:'2026-01-03',view:'power',summaryOnly:true};
    assert.equal((await service.query(args)).firewoodBenefit.preparing,true);
    await until(()=>service.cacheStatus().resident?.firewood?.complete,()=>`Frozen read-only histories should prepare without a writable owner: ${JSON.stringify(service.cacheStatus())}`);
    assert.notEqual((await service.query(args)).firewoodBenefit.preparing,true);
    assert.equal(reader.db.prepare("SELECT COUNT(*) n FROM state WHERE key GLOB 'derived-cache-anchor:firewood:*'").get().n,0);
  } finally {await service.close();reader.close();}
});

test('definitively rejected pending publication repins and retries without a source append',t=>{
  const f=fixture(t,{days:3});f.attach();let pins=0,publishes=0;
  f.projection.anchor=request=>{
    if(request.operation==='pin') {pins++;return {token:`00000000-0000-0000-0000-${String(pins).padStart(12,'0')}`,source:request.source,selection:request.selection};}
    if(++publishes===1) throw Object.assign(new Error('Synthetic stale pending token'),{code:'DERIVED_CACHE_ANCHOR_REFUSED'});
    const {operation,input,...proof}=request;return proof;
  };
  assert.throws(()=>finish(f.args),{code:'DERIVED_CACHE_ANCHOR_REFUSED'});
  const last=f.projection.latest('mqtt').cursor;
  const retried=maintainFirewoodProjection(f.args);
  assert.equal(retried.processed,0);assert.equal(retried.complete,true);
  assert.equal(f.projection.latest('mqtt').cursor,last);assert.equal(pins,2);assert.equal(publishes,2);
  assert.ok(f.projection.db.prepare('SELECT published FROM generation WHERE input=?').get('mqtt').published);
});

test('a verified current checkpoint changes the comparison, while a cursor-only checkpoint update retains its prefix',t=>{
  const f=fixture(t,{days:3});f.attach();finish(f.args);
  const oldSignature=f.projection.db.prepare('SELECT signature FROM generation WHERE input=?').get('mqtt').signature;
  const checkpoint=replayLearningJournal(f.source,'mqtt');
  f.source.setState('adaptive:mqtt',checkpoint);
  assert.equal(getFirewoodBenefit(f.args).summary.preparing,true,'Selecting a newly verified current model must invalidate its seed-model prefix');
  finish(f.args);
  const signature=f.projection.db.prepare('SELECT signature FROM generation WHERE input=?').get('mqtt').signature;
  assert.notEqual(signature,oldSignature);
  const ready=getFirewoodBenefit(f.args);delete f.source.firewoodProjection;
  assert.deepEqual(ready,getFirewoodBenefit(f.args));f.attach();
  f.append(3*96+1);
  const entry=f.source.learningJournal({input:'mqtt',after:checkpoint.journalCursor,limit:1})[0];
  const next=applyLearningRecord(checkpoint,entry,fireplaceLearningContext(f.source,'mqtt'));
  assert.deepEqual(next.model,checkpoint.model,'This normal sample must be between refits');
  f.source.setState('adaptive:mqtt',next);
  const args={...f.args,now:f.args.now+WINDOW,range:{from:f.args.range.from,to:f.args.now+WINDOW}};
  const step=maintainFirewoodProjection(args);
  assert.equal(step.processed,1);assert.equal(step.complete,true);
  assert.equal(f.projection.db.prepare('SELECT signature FROM generation WHERE input=?').get('mqtt').signature,signature);
  const caughtUp=getFirewoodBenefit(args);delete f.source.firewoodProjection;
  assert.deepEqual(caughtUp,getFirewoodBenefit(args));
});
