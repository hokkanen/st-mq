import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { LiveLearning } from '../src/app/live-learning.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';
import { replayLearningJournal } from '../src/app/committed-learning.js';
import { readCoefficientCoverage, readCoefficientEvents, persistCoefficientBatch, createCoefficientGeneration, coefficientProjectionAt } from '../src/storage/coefficient-history.js';

const start=Date.parse('2026-10-01T12:00:00Z');
function context(store,index){appendLearningRecord(store,'mqtt','context',{timestamp:start+index*60_000,
  historySeed:{model:initialAdaptiveModel({thermalPriors:{lossPerHour:.02+index/100_000}}),source:{basis:'invented-bounded-live-replay'}},
},{config:{}});}
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'stmq-bounded-live-coefficients-')),store=new Store(join(directory,'source.sqlite')),workers=[];
  t.after(async()=>{for(const worker of workers)await worker.close();await store.close();rmSync(directory,{recursive:true,force:true});});
  return{store,worker(){const worker=new LiveLearning({store,input:'mqtt'});workers.push(worker);return worker;}};
}

test('large new coefficient tails stage bounded writes, retain every transition and skip already recorded history on cache reconstruction',async t=>{
  const f=fixture(t),count=3200;
  for(let at=0;at<count;at+=64)f.store.transaction(()=>{for(let index=at;index<Math.min(count,at+64);index++)context(f.store,index);});
  await f.store.startWriter();
  const sizes=[],request=f.store.writer.request.bind(f.store.writer);
  f.store.writer.request=async(operation,...args)=>{const result=await request(operation,...args);
    if(operation==='seal'&&result.timing?.journal?.tables.includes('coefficient_events'))sizes.push(result.timing.journal.bytes);return result;};
  const worker=f.worker(),pages=[],stage=worker.stage.bind(worker);
  worker.stage=async(owner,message)=>{if(message.type==='coefficient-page')pages.push(message.events.length);return stage(owner,message);};
  const began=performance.now(),checkpoint=await worker.calculate('replay',{config:{}},null),batch=worker.takeCoefficientBatch(checkpoint);
  const elapsedMs=performance.now()-began;
  assert(batch.coefficientGeneration);assert.equal(batch.events,undefined,'The final result does not accumulate historical coefficient arrays');
  assert(Buffer.byteLength(JSON.stringify(batch))<1024,'Final pointer publication is small');
  assert.equal(readCoefficientCoverage(f.store,{input:'mqtt'}),null,'Staging never selects a partial replacement');
  assert(pages.length>2&&Math.max(...pages)<=128);
  const staged=readCoefficientEvents(f.store,{input:'mqtt',generation:batch.coefficientGeneration});
  assert.equal(staged.length,count);
  for(let index=0;index<count;index++)assert.equal(staged[index].coefficients.model_coefficient_heat_loss.value,.02+index/100_000);
  await f.store.runWrite(()=>{persistCoefficientBatch(f.store,'mqtt',batch);worker.commitCoefficientBatch(batch);f.store.setState('adaptive:mqtt',checkpoint);});
  assert.equal(readCoefficientEvents(f.store,{input:'mqtt'}).length,count);
  assert.equal(f.store.getState('live-learning:coefficient-stage:mqtt'),null);
  assert(sizes.length>2&&Math.max(...sizes)<1024*1024,'Every new-tail write stays comfortably below the 4 MiB capture limit');
  const generation=readCoefficientCoverage(f.store,{input:'mqtt'}).generation;
  await f.store.runWrite(()=>f.store.setState('adaptive:mqtt',null));
  const cold=f.worker(),before=f.store.checkpoint(),rebuilt=await cold.calculate('replay',{config:{}},null);
  assert.deepEqual(rebuilt,checkpoint);
  assert.equal(cold.takeCoefficientBatch(rebuilt),undefined,'An intact committed chart prefix is not backfilled when rebuilding only the model cache');
  assert.deepEqual(f.store.checkpoint(),before);
  assert.equal(readCoefficientCoverage(f.store,{input:'mqtt'}).generation,generation);
  t.diagnostic(JSON.stringify({transitions:count,elapsedMs,pages:pages.length,maxPageEvents:Math.max(...pages),maxCommitBytes:Math.max(...sizes)}));
});

test('a changed control fence discards its owned unselected generation without altering prior selected history',async t=>{
  const f=fixture(t);
  for(let index=0;index<8;index++)context(f.store,index);
  const prior=replayLearningJournal(f.store,'mqtt'),original=readCoefficientCoverage(f.store,{input:'mqtt'});
  for(let at=8;at<608;at+=64)f.store.transaction(()=>{for(let index=at;index<Math.min(608,at+64);index++)context(f.store,index);});
  await f.store.startWriter();
  let current=true,stagedGeneration;
  const worker=f.worker(),stage=worker.stage.bind(worker);
  worker.stage=async(owner,message)=>{await stage(owner,message);
    if(message.type==='coefficient-page'){stagedGeneration=message.coefficientGeneration;current=false;}};
  await assert.rejects(worker.calculate('replay',{config:{}},prior,{isCurrent:()=>current}),{code:'LIVE_LEARNING_FAILED'});
  await worker.close();
  assert(stagedGeneration);
  assert.equal(readCoefficientCoverage(f.store,{input:'mqtt'}).generation,original.generation);
  assert.equal(readCoefficientEvents(f.store,{input:'mqtt'}).length,8);
  assert.equal(f.store.db.prepare('SELECT id FROM coefficient_generations WHERE id=?').get(stagedGeneration),undefined);
  assert.equal(f.store.getState('live-learning:coefficient-stage:mqtt'),null);
  assert.equal(f.store.learningJournal({input:'mqtt',limit:1000}).length,608,'Immutable new source entries remain available for a fresh turn');
});

test('a new live owner cleans only its durably named interrupted stage and retains the selected prefix',async t=>{
  const f=fixture(t);for(let index=0;index<8;index++)context(f.store,index);
  const checkpoint=replayLearningJournal(f.store,'mqtt'),selected=readCoefficientCoverage(f.store,{input:'mqtt'});
  let abandoned;
  f.store.transaction(()=>{
    abandoned=createCoefficientGeneration(f.store,'mqtt',{prefixCursor:selected.cursor,
      projection:coefficientProjectionAt(f.store,{input:'mqtt',cursor:selected.cursor})});
    f.store.setState('live-learning:coefficient-stage:mqtt',{generation:abandoned});
  });
  await f.store.startWriter();
  const owner=f.worker(),value=await owner.calculate('replay',{config:{}},checkpoint);
  assert.deepEqual(value,checkpoint);
  assert.equal(f.store.db.prepare('SELECT id FROM coefficient_generations WHERE id=?').get(abandoned),undefined);
  assert.equal(f.store.getState('live-learning:coefficient-stage:mqtt'),null);
  assert.equal(readCoefficientCoverage(f.store,{input:'mqtt'}).generation,selected.generation);
  assert.equal(readCoefficientEvents(f.store,{input:'mqtt'}).length,8);
});
