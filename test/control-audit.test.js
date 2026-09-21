import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { CycleTracker } from '../src/app/cycles.js';
import { Engine } from '../src/app/engine.js';
import { initialAdaptiveModel, restoreAdaptiveCheckpoint } from '../src/control/adaptive-learning.js';
import { evaluateCycle, recoveryPolicy, revalidatePlan } from '../src/control/planner.js';
import { CONTROL_DEFAULTS, controlConfiguration } from '../src/app/config.js';

const now=Date.parse('2026-09-01T00:00Z'),H=3600000;
function rig(t, intervals, configuration={}) {
  const store=new Store(':memory:');t.after(()=>store.close());
  const config={...CONTROL_DEFAULTS,circulationKw:0,...configuration};
  const model=initialAdaptiveModel(config),tracker=new CycleTracker({store,input:'fixture',config});
  const schedule={preheatStart:now,preheatEnd:now,reductionStart:now,reductionEnd:now+H/2,roomBoostC:0};
  const args={model,initialState:{indoorC:21,reserveC:21},intervals,targetC:21,config};
  const plan={...args,schedule,reference:null,referenceLabel:'normal',
    prediction:evaluateCycle({...args,schedule}),referencePrediction:evaluateCycle(args)};
  tracker.start(plan,sample(now,now,0),now);
  return {tracker,store,plan};
}
function sample(start,end,powerKw,extra={}) {
  return {timestamp:end,windowStart:start,windowEnd:end,indoorC:21,outdoorC:21,solarRadiationWm2:0,
    phase:'reduction',powerKw,compressorDuty:powerKw/3,compressorPowerKw:3,
    thermalCompressorDuty:powerKw/3,thermalAuxKw:0,auxKw:0,auxRoute:'space',
    energyBasis:'estimated',compressorActivityObserved:true,auxiliaryObserved:true,auxiliaryRouteKnown:true,...extra};
}

test('completed power stays on its own side of a 100-to-1 price boundary',t=>{
  const prices=[{start:now,end:now+60000,price:100},{start:now+60000,end:now+H,price:1}];
  const {tracker}=rig(t,prices.map(row=>({...row,outdoorC:21,solarRadiationWm2:0})));
  tracker.record(sample(now,now+60000,3,{priceIntervals:prices}),now+60000);
  tracker.record(sample(now+60000,now+120000,0,{priceIntervals:prices}),now+120000);
  assert.ok(Math.abs(tracker.active().actual.electricityKwh-.05)<1e-12);
  assert.ok(Math.abs(tracker.active().actual.costCents-5)<1e-12);
  assert.deepEqual(tracker.active().observations.map(o=>o.powerKw),[3,0]);
});

test('joint route segments separate DHW compressor and AUX from space recovery',t=>{
  const {tracker}=rig(t,[{start:now,end:now+H,price:10,outdoorC:21,solarRadiationWm2:0}]);
  const space={...sample(now,now+10*60000,3),start:now,end:now+10*60000,phase:'recovery'};
  const dhw={...sample(now+10*60000,now+15*60000,6),start:now+10*60000,end:now+15*60000,
    phase:'recovery',compressorDuty:1,thermalCompressorDuty:0,auxKw:3,thermalAuxKw:0,auxRoute:'dhw'};
  tracker.record(sample(now,now+15*60000,4,{inputSegments:[space,dhw]}),now+15*60000);
  const a=tracker.active().actual;
  assert.ok(Math.abs(a.electricityKwh-1)<1e-12);
  assert.ok(Math.abs(a.spaceHeatingKwh-.5)<1e-12);
  assert.ok(Math.abs(a.dhwKwh-.5)<1e-12);
  assert.ok(Math.abs(a.dhwAuxKwh-.25)<1e-12);
  assert.equal(a.recoveryAuxKwh,0);
});

test('missing thermal interval invalidates reserve even if a newer live model says recovered',t=>{
  const {tracker}=rig(t,[{start:now,end:now+H,price:10,outdoorC:21,solarRadiationWm2:0}]);
  tracker.record(sample(now,now+60000,null,{thermalCompressorDuty:null}),now+60000,{thermalState:{reserveC:50}});
  tracker.record(sample(now+60000,now+120000,3),now+120000,{thermalState:{reserveC:50}});
  assert.equal(tracker.active().observerState,null);
  assert.equal(tracker.active().stableSince,null);
});

test('incomplete attempts retain covered cost and remain visible outside completed profit',t=>{
  const {tracker}=rig(t,[{start:now,end:now+H,price:10,outdoorC:21,solarRadiationWm2:0}]);
  tracker.record(sample(now,now+60000,3),now+60000);
  tracker.cancel(now+60000,'comfort-fallback-test');
  const o=tracker.outcomes();
  assert.equal(o.attempted,1);assert.equal(o.incomplete,1);assert.equal(o.assessed,0);
  assert.equal(o.observedCostCents,.5);assert.equal(tracker.metrics(21).profit.count,0);
  assert.ok(tracker.controlHold(now+2*H));assert.equal(tracker.controlHold(now+25*H),null);
});

test('native compressor demand can run at full duty in the observed reduction phase',()=>{
  const result=evaluateCycle({model:initialAdaptiveModel(),initialState:{indoorC:20,reserveC:20,integral:-1000},
    intervals:[{start:now,end:now+H/4,outdoorC:-15,solarRadiationWm2:0,price:20}],targetC:21,
    schedule:{preheatStart:now,preheatEnd:now,reductionStart:now,reductionEnd:now+H/4,roomBoostC:0},
    equipment:{observedPhase:'reduction',h66Available:true,supplyShortfallC:30},
    config:{compressorIntegralA1:-100,compressorHysteresisC:10}});
  assert.equal(result.trajectory[0].compressorDuty,1);
  assert.equal(result.trajectory[0].auxiliaryKw,0);
});

test('recovery starts compressor-only and falls back for comfort, trend, timeout or lost readback',()=>{
  const args={now:now+H/2,reductionEnd:now,indoorC:21,targetC:21,equipment:{h66Available:true}};
  assert.equal(recoveryPolicy(args).recoveryCompressorOnly,true);
  for(const change of [{indoorC:20.4},{indoorTrendCPerHour:-1.2},{now:now+H},{equipment:{}},{fallbackAt:now}])
    assert.equal(recoveryPolicy({...args,...change}).recoveryCompressorOnly,false);
  assert.equal(controlConfiguration({}).recoveryCompressorOnly,true);
  assert.equal(controlConfiguration({recovery_compressor_only:false}).recoveryCompressorOnly,false);
  assert.throws(()=>controlConfiguration({recovery_compressor_only:'yes'}));
});

test('a stale stored promise cannot bypass current evidence at dispatch',()=>{
  const model=initialAdaptiveModel(),schedule={preheatStart:now,preheatEnd:now,reductionStart:now,reductionEnd:now+4*H,roomBoostC:0};
  const result=revalidatePlan({plan:{schedule,model,trial:false},now,
    observations:{indoor:{value:21,observedAt:now}},checkpoint:{model,baselineC:21},
    settings:{comfort:{targetC:21,maxDropC:1},occupancy:{mode:'occupied'}},equipment:{h66Available:true}});
  assert.equal(result.valid,false);assert.equal(result.reason,'scheduled-cycle-response-evidence-unavailable');
});

test('an admitted trial retains its bounded safety rule on the following engine tick',t=>{
  const store=new Store(':memory:');let clock=now;
  const engine=new Engine({store,clock:()=>clock,config:{input:'simulated',
    settings:{mode:'active',comfort:{targetC:21,maxDropC:2,maxRiseC:2}},control:{trialBudgetCentsPerDay:100,maxTrialCostCents:100}}});
  t.after(()=>{clearTimeout(engine.executor.timer);engine.executor.closed=true;store.close();});
  const cp=restoreAdaptiveCheckpoint(null);cp.baselineC=21;
  cp.samples=Array.from({length:4},(_,i)=>({...sample(now-(5-i)*H/4,now-(4-i)*H/4,1.5),
    timestamp:new Date(now-(4-i)*H/4).toISOString(),phase:'normal',regime:'occupied',quality:[]}));
  cp.cursor=cp.samples.at(-1).timestamp;cp.health.usableSamples=4;engine.checkpoint=cp;
  const first=engine.tick();
  assert.equal(first.decision.plan?.trial,true);
  assert.equal(first.decision.phase,'reduction');
  assert.ok(engine.cycles.active());
  clock+=60000;
  const next=engine.tick();
  assert.equal(next.decision.phase,'reduction');
  assert.equal(engine.cycles.active().adjustments,undefined);
});

test('forecast recovery never re-blocks AUX after its comfort fallback',()=>{
  const result=evaluateCycle({model:initialAdaptiveModel(),initialState:{indoorC:20.4,reserveC:21},targetC:21,
    intervals:[{start:now,end:now+H,outdoorC:21,solarRadiationWm2:500,price:10}],
    schedule:{preheatStart:now,preheatEnd:now,reductionStart:now,reductionEnd:now,roomBoostC:0},
    equipment:{h66Available:true,nativeAuxAllowed:true}});
  assert.equal(result.trajectory[0].recoveryCompressorOnly,false);
  assert.ok(result.trajectory.every(row=>row.recoveryCompressorOnly===false));
});

test('unfinished recovery prices the same slow-node capacity used by the thermal model',()=>{
  const model=initialAdaptiveModel();model.equipmentResponse.phases.reduction={ratio:0,treatmentKey:'reduction-only-v1'};
  const r=evaluateCycle({model,initialState:{indoorC:21,reserveC:21},targetC:21,
    intervals:[{start:now,end:now+H,outdoorC:0,solarRadiationWm2:0,price:10}],
    schedule:{preheatStart:now,preheatEnd:now,reductionStart:now,reductionEnd:now+H,roomBoostC:0}});
  const p=model.parameters,deficit=Math.max(0,r.nativeEndState.indoorC-r.endState.indoorC)
    +p.memoryExchangePerHour*p.reserveTimeHours*Math.max(0,r.nativeEndState.reserveC-r.endState.reserveC);
  assert.ok(r.terminalKwh>0);
  assert.ok(Math.abs(r.terminalKwh-deficit/p.hydronicCPerKwh/4.24)<1e-10);
});
