import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { compactJournal } from '../src/storage/journal.js';
import { CycleTracker } from '../src/app/cycles.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { LiveLearning } from '../src/app/live-learning.js';
import { assessCycle, rebuildCycleWorking } from '../src/app/cycle-evaluation.js';

const START = Date.parse('2026-01-01T00:00:00Z'), HOUR = 3600000;
function fixture(t,{file=false,reductionHours=72,equipment={nativeAuxAllowed:false}}={}) {
  const directory = file ? mkdtempSync(join(tmpdir(),'stmq-cycle-evidence-')) : null;
  const store = new Store(file ? join(directory,'synthetic.sqlite') : ':memory:');
  t.after(async()=>{await store.close();if(directory)rmSync(directory,{recursive:true,force:true});});
  const tracker = new CycleTracker({store,input:'synthetic',config:{recoveryTimeoutHours:8}});
  const model = initialAdaptiveModel();
  const plan = {model,initialState:{indoorC:21,reserveC:21},targetC:21,reference:null,
    referenceLabel:'continuous normal operation',occupancy:{mode:'occupied'},maxDropC:1,
    intervals:[{start:START,end:START+HOUR,outdoorC:21,solarRadiationWm2:0,price:0}],
    equipment,schedule:{preheatStart:START,preheatEnd:START,reductionStart:START,
      reductionEnd:START+reductionHours*HOUR,roomBoostC:0}};
  tracker.start(plan,sample(START),START);
  return {store,tracker,plan};
}
function sample(timestamp,changes={}) {
  return {timestamp,indoorC:21,outdoorC:21,solarRadiationWm2:0,indoorTrendCPerHour:0,
    priceCents:0,priceStart:START,priceEnd:START+200*HOUR,powerKw:0,compressorDuty:0,
    thermalCompressorDuty:0,thermalAuxKw:0,auxKw:0,auxRoute:'space',compressorActivityObserved:true,
    auxiliaryObserved:true,auxiliaryRouteKnown:true,energyBasis:'measured',...changes};
}

test('cycle append is atomic, immutable and keeps valid zero evidence with original provenance',t=>{
  const {store,tracker}=fixture(t),id=tracker.active().id;
  const provenance={forecastVersion:'invented-original',sourceTime:START-1000,receivedAt:START,observations:[7,7]};
  tracker.record(sample(START+60000,{provenance}),START+60000);
  const saved=tracker.active(),before=store.checkpoint();
  const rows=[...store.cycleEvidence(id)];
  assert.equal(rows.length,1);assert.equal(rows[0].powerKw,0);assert.equal(rows[0].price,0);
  assert.deepEqual(rows[0].provenance,provenance);
  assert.equal(Object.hasOwn(saved,'observations'),false);
  assert.deepEqual(store.getState(tracker.key),{id});
  const malformed={...saved,observationCount:2,lastSample:{timestamp:START+120000}};
  assert.throws(()=>store.appendCycleEvidence('synthetic',malformed,
    [{start:START+60001,end:START+120000,powerKw:0}],{sampleAt:START+120000}),{code:'CYCLE_EVIDENCE_INVALID'});
  assert.deepEqual(store.checkpoint(),before);assert.deepEqual([...store.cycleEvidence(id)],rows);
  assert.throws(()=>store.cycle('synthetic',{...saved,plan:{...saved.plan,targetC:22}}),{code:'CYCLE_EVIDENCE_INVALID'});
  assert.throws(()=>store.cycle('synthetic',{...saved,observations:[]}),{code:'CYCLE_EVIDENCE_INVALID'});
  assert.throws(()=>store.cycle('synthetic',{...saved,observationCount:99}),{code:'CYCLE_EVIDENCE_INVALID'});
  for(const table of ['learning_cycle_definitions','learning_cycle_samples','learning_cycle_observations'])
    assert.throws(()=>store.db.prepare(`UPDATE ${table} SET ${table === 'learning_cycle_samples' ? 'context=context' : 'payload=payload'}`).run(),/immutable/);
});

test('byte-bounded pages share provenance once per group and pin a stable evidence prefix',t=>{
  const {store,tracker}=fixture(t),id=tracker.active().id;
  const provenance={basis:'invented-page-test',detail:'synthetic'.repeat(1500)};
  const end=START+60000;
  tracker.record(sample(end,{provenance,inputSegments:Array.from({length:100},(_,i)=>({start:START+i*600,end:START+(i+1)*600,
    powerKw:0,thermalCompressorDuty:0,thermalAuxKw:0}))}),end);
  const first=store.cycleEvidencePage({id,maxBytes:20000});
  assert(first.rows.length>0 && first.rows.length<100);
  assert.equal(first.samples.length,1);assert.deepEqual(first.samples[0].provenance,provenance);
  tracker.record(sample(end+60000),end+60000);
  let after=-1,count=0,sourceGroups=0;
  for(;;){const page=store.cycleEvidencePage({id,after,through:first.through,maxBytes:20000});
    count+=page.rows.length;sourceGroups+=page.samples.length;
    assert(Buffer.byteLength(JSON.stringify(page))<25000);
    if(page.complete)break;after=page.next;
  }
  assert.equal(count,100);assert(sourceGroups>1);
  assert.equal([...store.cycleEvidence(id)].length,101);
  assert.throws(()=>store.cycleEvidencePage({id,through:102}),{code:'CYCLE_EVIDENCE_INVALID'});
});

test('a three-day cycle exceeds the former observation cap with constant-size control writes and exact reconstruction',t=>{
  const {store,tracker}=fixture(t),id=tracker.active().id;
  const definition=store.db.prepare('SELECT payload FROM learning_cycle_definitions WHERE id=?').get(id).payload;
  let earlyBytes,lastBytes,largestHeader=0;
  const started=performance.now();
  for(let minute=1;minute<=4320;minute++) {
    const at=START+minute*60000;
    tracker.record(sample(at),at);
    assert(tracker.active(),'Duration and sample count cannot end an otherwise valid reduction');
    const bytes=store.db.prepare('SELECT bytes FROM journal_commits ORDER BY sequence DESC LIMIT 1').get().bytes;
    if(minute===100)earlyBytes=bytes;
    if(minute===4320)lastBytes=bytes;
    if(minute%256===0)compactJournal(store.db,{maxBytes:4*1024*1024,maxCommits:256});
    if(minute%100===0)largestHeader=Math.max(largestHeader,Buffer.byteLength(store.db.prepare('SELECT payload FROM learning_cycles WHERE id=?').get(id).payload));
  }
  const saved=tracker.active();
  assert.equal(saved.observationCount,4320);assert(Math.abs(saved.actual.coveredHours-72)<1e-9);
  assert.equal(saved.actual.electricityKwh,0);assert.equal(saved.actual.costCents,0);
  assert(largestHeader<6000,`header bytes ${largestHeader}`);
  assert(lastBytes<earlyBytes*1.25,JSON.stringify({earlyBytes,lastBytes}));
  assert.equal(store.db.prepare('SELECT payload FROM learning_cycle_definitions WHERE id=?').get(id).payload,definition);
  const rebuilt=rebuildCycleWorking(store,{id,count:4320});
  assert.deepEqual(rebuilt.observer,saved.observerState);
  assert.deepEqual(rebuilt.reference,store.getState(tracker.workingKey(saved)).reference);
  let episode;
  for(let quarter=1;quarter<=4;quarter++){const at=START+72*HOUR+quarter*HOUR/4;episode=tracker.record(sample(at),at)??episode;}
  assert.equal(tracker.active(),null);
  assert.equal(store.cycleById({id}).status,'completed');
  assert.equal(episode.complete,true);
  assert.equal(episode.forecastValidation.eligible,false,'An original short forecast cannot validate a later unforecast cycle');
  assert.equal([...store.cycleEvidence(id)].length,4324);
  t.diagnostic(JSON.stringify({intervals:4320,headerBytes:largestHeader,earlyWriteBytes:earlyBytes,lastWriteBytes:lastBytes,elapsedMs:Math.round(performance.now()-started)}));
});

test('worker reconstruction and full assessment match inline evaluation without delaying queued writes',async t=>{
  const {store,tracker}=fixture(t,{file:true,reductionHours:1});
  for(let minute=1;minute<=59;minute++){const at=START+minute*60000;tracker.record(sample(at),at);}
  const id=tracker.active().id,options={id,count:59,now:START+59*60000,fireplaceEvents:[]};
  const expectedWorking=rebuildCycleWorking(store,options),expectedAssessment=assessCycle(store,options);
  await store.startWriter();const learning=new LiveLearning({store,input:'synthetic'});
  try {
    const working=learning.calculate('cycle-working',options);
    await store.runWrite(()=>store.setState('synthetic-concurrent-write',{valid:true}));
    assert.deepEqual(await working,expectedWorking);
    assert.deepEqual(await learning.calculate('cycle-assess',options),expectedAssessment);
    let current=false;
    await assert.rejects(learning.calculate('cycle-assess',options,null,{isCurrent:()=>current}),{code:'STORAGE_WRITE_CANCELLED'});
    assert.equal(store.cycleById({id}).status,'active','A worker cannot publish or finish a cycle itself');
  } finally {await learning.close();}
});

test('missing or damaged current working caches rebuild exactly without restarting an established recovery hold',t=>{
  for(const damaged of [false,true]){
    const {store,tracker}=fixture(t,{reductionHours:0.5});
    for(const hours of [0.5,0.75]){const at=START+hours*HOUR;tracker.record(sample(at),at);}
    const before=tracker.active(),key=tracker.workingKey(before);
    assert.equal(before.stableSince,START+0.5*HOUR);
    if(damaged){const value=store.getState(key);value.reference.continuation.state.indoorC=99;store.setState(key,value);}
    else store.db.prepare('DELETE FROM state WHERE key=?').run(key);
    assert(tracker.workingJob());
    tracker.record(sample(START+HOUR),START+HOUR);
    assert.equal(tracker.active().stableSince,before.stableSince);
    const episode=tracker.record(sample(START+1.5*HOUR),START+1.5*HOUR);
    assert.equal(episode.complete,true);assert.equal(tracker.active(),null);
    assert.equal(store.db.prepare('SELECT 1 FROM state WHERE key=?').get(key),undefined,'Completed cycles retain no working-cache rows');
    assert.equal([...store.cycleEvidence(before.id)].length,4,'Original source intervals survive cache replacement');
  }
});

test('an unknown working-cache format rejects writable startup before changing main or WAL bytes',async t=>{
  const {store,tracker}=fixture(t,{file:true}),cycle=tracker.active(),path=store.path;
  const value=store.getState(tracker.workingKey(cycle));value.version=99;
  store.setState(tracker.workingKey(cycle),value);
  const {readFileSync}=await import('node:fs');
  const before=readFileSync(path),wal=readFileSync(path+'-wal');
  assert.throws(()=>new Store(path),{code:'CYCLE_WORKING_STATE_INVALID'});
  assert.deepEqual(readFileSync(path),before);assert.deepEqual(readFileSync(path+'-wal'),wal);
});

test('terminal header, pointer and working-cache removal publish atomically',t=>{
  const {store,tracker}=fixture(t),before=tracker.active(),checkpoint=store.checkpoint();
  const cycle=structuredClone(before);cycle.status='incomplete';cycle.endedAt=START+60000;
  const setState=store.setState;
  store.setState=function(key,...args){if(key===tracker.key)throw Error('Synthetic pointer failure');return setState.call(this,key,...args);};
  try{assert.throws(()=>tracker.save(cycle),/Synthetic pointer failure/);}finally{store.setState=setState;}
  assert.deepEqual(tracker.active(),before);assert.deepEqual(store.checkpoint(),checkpoint);
  assert(store.getState(tracker.workingKey(before)),'The previous valid cache remains selected');
});

test('a failed final hold update rolls back its complete sample rather than retaining stale recovery proof',t=>{
  const {store,tracker}=fixture(t,{reductionHours:0.5});tracker.record(sample(START+HOUR/2),START+HOUR/2);
  const before=tracker.active(),checkpoint=store.checkpoint(),save=store.cycle;
  store.cycle=()=>{throw Error('Synthetic hold publication failure');};
  try{assert.throws(()=>tracker.record(sample(START+HOUR*0.75,{indoorC:19}),START+HOUR*0.75),/Synthetic hold publication failure/);}finally{store.cycle=save;}
  assert.deepEqual(tracker.active(),before);assert.deepEqual(store.checkpoint(),checkpoint);
  assert.equal([...store.cycleEvidence(before.id)].length,1);
  tracker.record(sample(START+HOUR*0.75,{indoorC:19}),START+HOUR*0.75);
  assert.equal(tracker.active().stableSince,null);
  assert.equal([...store.cycleEvidence(before.id)].length,2);
});

test('a changed historical fireplace interpretation cannot retain an earlier recovery hold',t=>{
  const {store,tracker}=fixture(t,{reductionHours:0.5});tracker.record(sample(START+HOUR/2),START+HOUR/2);
  const before=tracker.active();assert.equal(before.stableSince,START+HOUR/2);
  tracker.fireplaceContext={fireplaceRevision:1,fireplaceEvents:[{id:1,kind:'load',at:START,kg:8}]};
  tracker.record(sample(START+HOUR*0.75),START+HOUR*0.75);
  const after=tracker.active();assert.notDeepEqual(after.referenceState,before.referenceState);
  assert.notEqual(after.stableSince,before.stableSince,'Only a hold established under the current interpretation is retained');
  assert.equal([...store.cycleEvidence(before.id)].length,2);
});

test('known stale continuation bindings reconstruct while unknown nested formats reject before mutation',t=>{
  const {store,tracker}=fixture(t,{reductionHours:0.5});tracker.record(sample(START+HOUR/2),START+HOUR/2);
  const cycle=tracker.active(),key=tracker.workingKey(cycle),value=store.getState(key);
  value.reference.continuation.binding='a'.repeat(64);
  // Keep this known shape sealed: semantic binding still needs its own check.
  const {digest:ignored,...body}=value;
  return import('../src/domain/cycle-working-state.js').then(({sealCycleWorking})=>{
    store.setState(key,sealCycleWorking(body));assert(tracker.workingJob());
    tracker.record(sample(START+HOUR*0.75),START+HOUR*0.75);
    assert.equal(tracker.active().stableSince,cycle.stableSince);
    assert.notEqual(store.getState(key).reference.continuation.binding,'a'.repeat(64));
  });
});

test('nested unknown predictor-state formats reject file startup before touching evidence',async t=>{
  const {store,tracker}=fixture(t,{file:true,reductionHours:0.5});tracker.record(sample(START+HOUR/2),START+HOUR/2);
  const key=tracker.workingKey(tracker.active()),value=store.getState(key);value.reference.continuation.version=99;
  store.setState(key,value);const{readFileSync}=await import('node:fs'),before=readFileSync(store.path),wal=readFileSync(store.path+'-wal');
  assert.throws(()=>new Store(store.path),{code:'CYCLE_WORKING_STATE_INVALID'});
  assert.deepEqual(readFileSync(store.path),before);assert.deepEqual(readFileSync(store.path+'-wal'),wal);
});

test('failed working-state adoption cannot publish a cache from an uncommitted interpretation',t=>{
  const {store,tracker}=fixture(t);tracker.record(sample(START+HOUR/4),START+HOUR/4);
  const cycle=tracker.active(),key=tracker.workingKey(cycle),before=store.getState(key),checkpoint=store.checkpoint();
  const events=[{id:1,kind:'load',at:START+HOUR,kg:8}];
  const result=rebuildCycleWorking(store,{id:cycle.id,count:cycle.observationCount,fireplaceEvents:events});
  tracker.fireplaceContext={fireplaceRevision:1,fireplaceEvents:events};
  const save=store.cycle;store.cycle=()=>{throw Error('Synthetic adoption publication failure');};
  try{assert.throws(()=>tracker.adoptWorking(result),/Synthetic adoption publication failure/);}finally{store.cycle=save;}
  assert.deepEqual(store.getState(key),before);assert.deepEqual(tracker.active(),cycle);assert.deepEqual(store.checkpoint(),checkpoint);
});


test('valid zero native-demand history never requires an invented interval before the first source sample',t=>{
  const {store,tracker}=fixture(t,{equipment:{nativeAuxAllowed:false,heatingDemand:{normalAuxiliaryKw:0,observedThrough:START}}});
  assert.equal(tracker.workingJob(),null);
  const cycle=tracker.active();store.db.prepare('DELETE FROM state WHERE key=?').run(tracker.workingKey(cycle));
  const job=tracker.workingJob();assert(job);
  const rebuilt=rebuildCycleWorking(store,job);assert.equal(rebuilt.reference,null);
  tracker.adoptWorking(rebuilt);assert.equal(tracker.workingJob(),null);
  tracker.record(sample(START+60000),START+60000);
  assert.equal(tracker.active().observationCount,1);
  assert.equal(store.getState(tracker.workingKey(cycle)).reference.continuation.origin,START);
  assert.equal([...store.cycleEvidence(cycle.id)][0].start,START);
});

test('a resealed stale time cursor reconstructs its original interval boundary before the next sample',async t=>{
  const {store,tracker}=fixture(t);tracker.record(sample(START+HOUR/4),START+HOUR/4);
  const cycle=tracker.active(),key=tracker.workingKey(cycle),value=store.getState(key);
  value.reference.continuation.previousEnd+=1000;
  const{sealCycleWorking}=await import('../src/domain/cycle-working-state.js');store.setState(key,sealCycleWorking(value));
  assert(tracker.workingJob());
  tracker.record(sample(START+HOUR/2),START+HOUR/2);
  assert.equal(tracker.active().observationCount,2);assert.equal(tracker.workingJob(),null);
  assert.equal(store.getState(key).reference.continuation.previousEnd,START+HOUR/2);
});

test('cycle start cannot attach a mismatched or missing interval endpoint to a new execution',t=>{
  const {store,tracker,plan}=fixture(t);tracker.cancel(START,'invented-fixture-reset');const before=store.checkpoint();
  for(const endpoint of [null,{},sample(START+1),sample(START-1)])assert.throws(()=>tracker.start(plan,endpoint,START),/actual acknowledged start sample/);
  assert.equal(tracker.active(),null);assert.deepEqual(store.checkpoint(),before);
});
