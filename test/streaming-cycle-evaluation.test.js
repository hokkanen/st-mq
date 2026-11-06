import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { evaluateCycle, advanceCycleEvaluation } from '../src/control/planner.js';

const HOUR=3600000, START=Date.parse('2026-01-12T03:07:00Z');
function fixture(kind='normal', count=80) {
 const model=initialAdaptiveModel(kind==='preheat'?{floorThermalPriors:{capacityKwhPerC:4,nativeCapacityKwhPerC:12,exchangeKwPerC:.6,groundLossKwPerC:.05,groundC:8}}:{});
 let cursor=START;
 const intervals=Array.from({length:count},(_,i)=>{const start=cursor;cursor+=(i%3===0?11:17)*60000;return {start,end:cursor,outdoorC:-9+(i%7),solarRadiationWm2:i%9===0?null:(i%5)*75,price:i%8===0?-17:i%8===1?0:8+(i%6)*11};});
 const config={compressorIntegralA1:-60,compressorHysteresisC:4,auxIntegralA2:-300,recoveryHoldMinutes:37};
 const equipment={nativeProjection:{integral:{observedAt:START,spanMs:47000},shortfall:{observedAt:START,spanMs:18000}},observedPhase:'normal',supplyC:35,normalSupplyC:34,maximumSupplyC:48,brineC:0,h66Available:true,nativeAuxAllowed:true,integralTrendPerHour:-90,supplyShortfallC:2,supplyShortfallTrendPerHour:3,heatingDemand:{normalAuxiliaryKw:.45,observedThrough:START-60000},indoorUncertaintyC:0};
 let schedule=null,occupancy={mode:'occupied'};
 if(kind!=='normal')schedule={preheatStart:START+7*60000,preheatEnd:kind==='preheat'?START+43*60000:START+7*60000,reductionStart:kind==='preheat'?START+43*60000:START+7*60000,reductionEnd:START+191*60000,roomBoostC:kind==='preheat'?2:0,floorOverride:kind==='preheat',treatmentKey:kind==='preheat'?'room-boost-floor-v1':'reduction-only-v1'};
 if(kind==='preheat'){equipment.fireplaceEvents=[{at:START-30*60000,kg:1.75}];occupancy={mode:'away',returnAt:new Date(START+125*60000).toISOString()};}
 if(kind==='estimated')Object.assign(equipment,{indoorEstimated:true,indoorUncertaintyC:.2,indoorUncertaintyGrowthCPerHour:.04,indoorEstimateValidUntil:START+4*HOUR,h66Available:false});
 return {model,initialState:{indoorC:21.25,reserveC:24.1,slabC:22.2,integral:-80},targetC:21,intervals,schedule,occupancy,maxDropC:1.25,maxRiseC:1.75,config,equipment};
}

// Fixed current-algorithm results for the invented fixtures above. The v21
// boundary deliberately changes native projections; all scalar and trajectory
// fields remain exactly equal between whole and streamed evaluation.
const originalDigests = {
 normal: 'ca8f0c673294cf1fac83000001141e29c609cb4b47ad598797465f40c30a50e0',
 reduction: '6bb7747dd5e6bda2f7a169571771ba2ac4dc7814acb75514244c805abdbe8bab',
 preheat: 'e8d83293c0c61a2f52f915caeb765ad933726b4aa4c1f4f93a8e78927c46ea35',
 estimated: '2be3728dd91246c3f439c96a67c8ffe3560b55aade7c5a05b30d422004c46343',
};
const roundtrip = value => JSON.parse(JSON.stringify(value));
for (const kind of Object.keys(originalDigests)) {
 test('streaming preserves the current '+kind+' evaluation exactly across restart', () => {
  const args=fixture(kind), expected=evaluateCycle(args);
  assert.equal(createHash('sha256').update(JSON.stringify(expected)).digest('hex'),originalDigests[kind]);
  for (const size of [1,7,23,args.intervals.length]) {
   let continuation=null, result; const trajectory=[];
   for(let i=0;i<args.intervals.length;i+=size){
    const step=advanceCycleEvaluation({...args,intervals:args.intervals.slice(i,i+size),
      includeTail:i+size>=args.intervals.length},continuation);
    result=step.result;trajectory.push(...result.trajectory);
    continuation=roundtrip(step.continuation);
   }
   assert.deepEqual({...result,trajectory},expected);
   assert.equal(continuation.origin,args.intervals[0].start);
   assert.equal(continuation.previousEnd,args.intervals.at(-1).end);
   assert(!Object.hasOwn(continuation,'trajectory'));
  }
 });
}
test('rolling assessment excludes terminal debt and final empty chunk charges it once at the last quote', () => {
 const args=fixture('reduction',11), expected=evaluateCycle(args);
 assert(expected.terminalCostCents>0,'The fixture must exercise a priced outstanding heat debt');
 let continuation=null, rolling;
 for(const interval of args.intervals){
  const step=advanceCycleEvaluation({...args,intervals:[interval],includeTail:false,captureTrajectory:false},continuation);
  continuation=roundtrip(step.continuation);rolling=step.result;
  assert.equal(rolling.terminalKwh,0);assert.equal(rolling.terminalCostCents,0);
  assert.deepEqual(rolling.trajectory,[]);
 }
 const final=advanceCycleEvaluation({...args,intervals:[],captureTrajectory:false},continuation);
 assert.deepEqual(final.result,{...expected,trajectory:[]});
 assert.equal(final.result.costCents,rolling.costCents+final.result.terminalCostCents);
 assert.throws(()=>advanceCycleEvaluation({...args,intervals:[]},final.continuation),/continuation/);
 // Assessment cannot mutate a reusable unfinalized physical prefix.
 assert.deepEqual(advanceCycleEvaluation({...args,intervals:[],captureTrajectory:false},roundtrip(continuation)).result,final.result);
});
test('recovery settlement and native fallback stay latched across chunk boundaries', () => {
 for(const h66Available of [true,false]){
  const args=fixture('reduction',32);
  args.schedule={preheatStart:START,preheatEnd:START,reductionStart:START,reductionEnd:START+HOUR/4,roomBoostC:0};
  Object.assign(args.config,{scenarioReductionScale:1,compressorIntegralA1:null,compressorHysteresisC:null});
  Object.assign(args.equipment,{nativeAuxAllowed:false,h66Available});
  args.maxDropC=args.maxRiseC=10;
  const expected=evaluateCycle(args);assert(Number.isFinite(expected.recoveredAt));
  assert(expected.trajectory.some(row=>row.at>expected.recoveredAt&&row.phase==='normal'));
  if(h66Available)assert(expected.trajectory.some(row=>row.recoveryHoldActive&&row.recoveryCompressorOnly));
  else assert(expected.trajectory.filter(row=>row.phase==='recovery').every(row=>!row.recoveryCompressorOnly));
  let continuation=null,firstFallbackAt=null;const trajectory=[];
  for(const interval of args.intervals){
   const step=advanceCycleEvaluation({...args,intervals:[interval],includeTail:false},continuation);
   continuation=roundtrip(step.continuation);trajectory.push(...step.result.trajectory);
   if(continuation.recoveryFallbackAt!==null){
    firstFallbackAt??=continuation.recoveryFallbackAt;
    assert.equal(continuation.recoveryFallbackAt,firstFallbackAt,'A fallback cannot renew on a later chunk');
   }
  }
  const final=advanceCycleEvaluation({...args,intervals:[]},continuation);
  assert.deepEqual({...final.result,trajectory},expected);
  assert(Number.isFinite(firstFallbackAt));
 }
});
test('continuations reject gaps, overlaps, changed frozen assumptions and malformed state without changing their prefix', () => {
 const args=fixture('preheat'), first=advanceCycleEvaluation({...args,intervals:args.intervals.slice(0,3),includeTail:false});
 const saved=roundtrip(first.continuation), next={...args,intervals:args.intervals.slice(3,6),includeTail:false};
 for(const delta of [-1,1])assert.throws(()=>advanceCycleEvaluation({...next,intervals:[{...next.intervals[0],start:next.intervals[0].start+delta}]},saved),/continuous/);
 for(const changed of [{targetC:args.targetC+.1},{config:{...args.config,recoveryHoldMinutes:1}},
  {occupancy:{mode:'occupied'}},{maxDropC:args.maxDropC+.1},
  {equipment:{...args.equipment,integralTrendPerHour:0}},{schedule:{...args.schedule,reductionEnd:args.schedule.reductionEnd+1000}},
  {initialState:{...args.initialState,reserveC:args.initialState.reserveC+1}},
  {model:{...args.model,parameters:{...args.model.parameters,lossPerHour:.08}}}]){
  assert.throws(()=>advanceCycleEvaluation({...next,...changed},saved),/continuation/);
 }
 for(const mutate of [c=>{c.version=0;},c=>{c.state.indoorC=null;},c=>{c.totals.costCents=null;},
  c=>{c.violations=Array(25).fill({});},c=>{c.lastPrice=null;},c=>{c.unrecognized=true;},c=>{delete c.previousEnd;}]){
  const damaged=roundtrip(saved);mutate(damaged);
  assert.throws(()=>advanceCycleEvaluation(next,damaged),/continuation/);
 }
 assert.deepEqual(first.continuation,saved);
 const result=advanceCycleEvaluation(next,saved);
 result.result.endState.indoorC=999;result.result.discomfort.cold=999;
 assert.notEqual(result.continuation.state.indoorC,999);
 assert.notEqual(result.continuation.discomfort.cold,999);
 assert.deepEqual(saved,first.continuation);
 const reordered={...next,config:Object.fromEntries(Object.entries(next.config).reverse()),
  equipment:Object.fromEntries(Object.entries(next.equipment).reverse())};
 assert.deepEqual(advanceCycleEvaluation(reordered,saved),advanceCycleEvaluation(next,saved),
  'Equivalent serialized configuration order does not invalidate the physical prefix');
});
test('long trajectory-free evaluation keeps restart state bounded while preserving every cumulative result', () => {
 const args=fixture('reduction',0), count=10000;
 args.intervals=Array.from({length:count},(_,i)=>({start:START+i*60000,end:START+(i+1)*60000,
  outdoorC:-5+(i%4),solarRadiationWm2:i%10===0?null:0,price:i%5===0?-8:11}));
 const expected=evaluateCycle({...args,captureTrajectory:false});
 let continuation=null,result,maxBytes=0;
 for(let i=0;i<count;i+=37){
  const step=advanceCycleEvaluation({...args,intervals:args.intervals.slice(i,i+37),
   includeTail:false,captureTrajectory:false},continuation);
  result=step.result;continuation=roundtrip(step.continuation);
  assert.equal(result.trajectory.length,0);
  maxBytes=Math.max(maxBytes,JSON.stringify(continuation).length);
  assert(continuation.violations.length<=24);
 }
 const final=advanceCycleEvaluation({...args,intervals:[],captureTrajectory:false},continuation);
 assert.deepEqual(final.result,expected);
 assert(maxBytes<8192,'Continuation size must not grow with elapsed interval count');
 assert.equal(continuation.previousEnd,args.intervals.at(-1).end);
});
test('empty default evaluation and zero-origin native inputs preserve valid zero values', () => {
 const empty={model:initialAdaptiveModel(),initialState:{indoorC:21,reserveC:21},targetC:21,intervals:[]};
 assert.equal(evaluateCycle(empty).costCents,0);
 assert.equal(evaluateCycle(empty).completeRecoveryPredicted,true);
 const args=fixture('normal',3), shift=args.intervals[0].start;
 args.intervals=args.intervals.map(row=>({...row,start:row.start-shift,end:row.end-shift,price:0}));
 args.equipment.heatingDemand.observedThrough=-60000;
 let continuation=null,last;const trajectory=[];
 for(const row of args.intervals){last=advanceCycleEvaluation({...args,intervals:[row],includeTail:false},continuation);continuation=roundtrip(last.continuation);trajectory.push(...last.result.trajectory);}
 const end=advanceCycleEvaluation({...args,intervals:[]},continuation);
 assert.deepEqual({...end.result,trajectory},evaluateCycle(args));
 assert.equal(continuation.origin,0);
 assert.equal(end.result.costCents,0);
});
