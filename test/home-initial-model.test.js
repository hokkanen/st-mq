import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAdaptiveModel, restoreAdaptiveCheckpoint, updateAdaptiveLearning, updateAdaptiveEpisode, thermalObservationIntervals, evaluateThermalModel, predictThermalStep, predictEquipmentDuty, fitEquipmentResponse, equipmentResponseEstimate, actionEvidenceReady, thermalUncertaintyC } from '../src/control/adaptive-learning.js';
import { initialHomeState, homeModelConfiguration, DEFAULT_HOME_MODEL } from '../src/domain/home-model.js';
import publicConfiguration from '../config.json' with {type:'json'};
import { chooseCycle, revalidatePlan, learningReadiness, validatedReductionHours, preheatRoomRequest, evaluateCycle, forecastIntervals, economicAdmission } from '../src/control/planner.js';
import { controlConfiguration,validateSettings } from '../src/app/config.js';
import { heatingExplorerFixture } from './helpers/heating-explorer-fixture.js';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { replayLearningJournal } from '../src/app/committed-learning.js';

const HOUR=3_600_000;
test('fresh programmatic and public configuration models use the shared calibration without invented validation',()=>{
  const publicModel=initialAdaptiveModel(controlConfiguration(publicConfiguration.options.controller));
  const direct=initialAdaptiveModel();
  assert.deepEqual(publicModel.parameters,direct.parameters);
  assert.deepEqual(homeModelConfiguration({}),DEFAULT_HOME_MODEL);
  assert.equal(publicModel.initialModel.basis,'calibrated-initial-estimate');
  for(const model of [direct,publicModel]){
    assert.equal(model.initialModel.lossPerHour,DEFAULT_HOME_MODEL.lossPerHour);
    assert.equal(model.initialModel.hydronicCPerKwh,DEFAULT_HOME_MODEL.hydronicCPerKwh);
    assert.equal(model.initialModel.trainingSamples,undefined);
    assert.equal(model.initialModel.trainingDigest,undefined);
    assert.equal(model.validation,null);assert.equal(model.trainedAt,null);
  }
});

test('response learning retains independent treatments when pure and coupled reductions alternate',()=>{
  const model=initialAdaptiveModel(),training=[],heldout=[];
  for(const key of ['reduction-only-v1','room-boost-v1'])for(let i=0;i<6;i++){
    const start=i*24*HOUR;
    const row={episodeId:`${key}-${i}`,timestamp:start,indoorC:21,reserveC:23,dt:2,
      segments:[{start,end:start+2*HOUR,episodeId:`${key}-${i}`,treatmentKey:key,phase:'reduction',
        outdoorC:0,solarRadiationWm2:0,targetC:21,compressorDuty:key==='reduction-only-v1'?.1:.2,auxKw:0}]};
    (i<3?training:heldout).push(row);
  }
  model.equipmentResponse=fitEquipmentResponse(model,training,heldout,
    training.map(row=>({id:row.episodeId})),heldout.map(row=>({id:row.episodeId})));
  const pure=equipmentResponseEstimate(model,'reduction','reduction-only-v1');
  const coupled=equipmentResponseEstimate(model,'reduction','room-boost-v1');
  assert.equal(pure.trainingEpisodes,3);assert.equal(coupled.trainingEpisodes,3);
  assert.notEqual(pure.ratio,coupled.ratio);
  assert.equal(equipmentResponseEstimate(model,'reduction','toString'),null);
  assert.equal(equipmentResponseEstimate(model,'reduction','__proto__'),null);
});

test('another treatment cannot lend its validated ROOM boost or duration to an untested request',()=>{
  const model=heatingExplorerFixture().checkpoint.model;
  const estimate=(key,boost)=>({ratio:1,trainingEpisodes:3,treatmentKey:key,validation:{
    accepted:true,episodes:3,treatmentKey:key,maxDurationHours:1,maxRoomBoostC:boost,intervalMaeDuty:.12}});
  const room=estimate('room-boost-v1',1),floor=estimate('room-boost-floor-v1',5);
  model.equipmentResponse.treatments={preheat:{'room-boost-v1':room,'room-boost-floor-v1':floor}};
  model.equipmentResponse.phases.preheat=floor;
  model.equipmentResponse.validation.phases.preheat=floor.validation;
  assert.equal(actionEvidenceReady(model,'preheat',1,'room-boost-v1',1),true);
  assert.equal(actionEvidenceReady(model,'preheat',1,'room-boost-v1',5),false);
  assert.equal(actionEvidenceReady(model,'preheat',1,'room-boost-floor-v1',5),true);
  const inputs={phase:'preheat',targetC:21,outdoorC:0,supplyC:35,brineC:0,solarRadiationWm2:0,
    treatmentKey:'room-boost-v1',roomBoostC:1,phaseHours:1};
  const checked=thermalUncertaintyC(model,1,inputs);
  assert.ok(thermalUncertaintyC(model,1,{...inputs,roomBoostC:5})>checked);
  assert.ok(thermalUncertaintyC(model,1,{...inputs,phaseHours:2})>checked);
  assert.equal(predictEquipmentDuty(model,{indoorC:21,reserveC:23},{...inputs,roomBoostC:5}).actionEvidence,'observed-unchecked');
});

test('re-evaluating an ongoing treatment retains its elapsed duration when assessing evidence',()=>{
  const x=heatingExplorerFixture(),model=x.checkpoint.model,key='room-boost-v1',now=x.now;
  const evidence={accepted:true,episodes:3,treatmentKey:key,maxDurationHours:1,maxRoomBoostC:1};
  model.equipmentResponse.phases.preheat={ratio:1,trainingEpisodes:3,treatmentKey:key,validation:evidence};
  const args={model,intervals:forecastIntervals(x.prices,x.forecast,now),initialState:x.thermalState,
    targetC:21,equipment:x.equipment,config:x.config};
  const schedule={preheatStart:now,preheatEnd:now+HOUR/2,reductionStart:now+HOUR/2,
    reductionEnd:now+HOUR,roomBoostC:1,treatmentKey:key};
  const fresh=evaluateCycle({...args,schedule});
  const ongoing=evaluateCycle({...args,schedule:{...schedule,preheatStart:now-2*HOUR}});
  assert.ok(ongoing.trajectory[0].uncertaintyC>fresh.trajectory[0].uncertaintyC,
    'A new forecast boundary cannot make the third treatment hour look like its first hour');
});

test('hot-water diversion is not learned as suppression caused by a heating treatment',()=>{
  const model=initialAdaptiveModel(),key='reduction-only-v1';
  const space={start:0,end:HOUR,phase:'reduction',treatmentKey:key,outdoorC:0,
    solarRadiationWm2:0,targetC:21,compressorDuty:.1,auxKw:0,auxRoute:'space'};
  const row=segments=>({episodeId:'manual',indoorC:21,reserveC:23,segments});
  const fit=segments=>fitEquipmentResponse(model,[row(segments)],[],[{id:'manual'}],[]);
  const normal=fit([space]),diverted=fit([space,{...space,start:HOUR,end:2*HOUR,compressorDuty:0,auxRoute:'dhw'}]);
  assert.deepEqual(diverted.phases.reduction,normal.phases.reduction);
  assert.deepEqual(fit([{...space,compressorDuty:0,auxRoute:'dhw'}]).phases,{});
  assert.deepEqual(fit([{...space,compressorDuty:0,fireplaceKgPerHour:1}]).phases,{},
    'Known wood heat cannot be credited to a reduction request either');
});

test('actual unchanged, partial and suppressed demand promptly replace the initial response estimate',()=>{
  const model=initialAdaptiveModel(),state=initialHomeState(model,21,0);
  const inputs={outdoorC:0,targetC:21,solarRadiationWm2:0,supplyC:35,brineC:0};
  const observed=predictEquipmentDuty(model,state,{...inputs,phase:'normal'},2).compressorDuty;
  for(const response of [0,.7,1]){
    const row={episodeId:'observed',...state,segments:[{...inputs,start:0,end:2*HOUR,phase:'reduction',
      treatmentKey:'reduction-only-v1',compressorDuty:observed*response,auxKw:0,auxRoute:'space'}]};
    const result=fitEquipmentResponse(model,[row],[],[{id:'observed'}],[]);
    assert.ok(Math.abs(result.phases.reduction.ratio-response)<1e-12);
    assert.equal(result.validation.phases.reduction.accepted,false);
  }
});

test('observed full runtime is not clipped to twice a small normal-demand estimate',()=>{
  const model=initialAdaptiveModel(),state=initialHomeState(model,21,12);
  const inputs={outdoorC:12,targetC:21,solarRadiationWm2:0,supplyC:35,brineC:0};
  const nominal=predictEquipmentDuty(model,state,{...inputs,phase:'normal'},2).compressorDuty;
  assert.ok(nominal>0&&nominal<.5);
  const key='reduction-only-v1';
  const row={episodeId:'manual',...state,segments:[{...inputs,start:0,end:2*HOUR,phase:'reduction',
    treatmentKey:key,compressorDuty:1,auxKw:0,auxRoute:'space'}]};
  model.equipmentResponse=fitEquipmentResponse(model,[row],[],[{id:'manual'}],[]);
  const prediction=predictEquipmentDuty(model,state,{...inputs,phase:'reduction',treatmentKey:key},2);
  assert.ok(model.equipmentResponse.phases.reduction.ratio>2);
  assert.ok(Math.abs(prediction.compressorDuty-1)<1e-12,
    'A contrary manual observation must not be turned into invented suppression');
});

test('earlier validation cannot freeze a response against contrary newly covered manual observations',()=>{
  const cp=restoreAdaptiveCheckpoint(null),start=Date.parse('2026-01-01T00:00Z'),key='reduction-only-v1';
  cp.model.equipmentResponse={phases:{reduction:{ratio:0,trainingEpisodes:3,treatmentKey:key}},
    validation:{phases:{reduction:{accepted:true,episodes:3,treatmentKey:key,maxDurationHours:2}}}};
  const inputs={outdoorC:0,solarRadiationWm2:0,targetC:21};
  const duty=predictEquipmentDuty(cp.model,initialHomeState(cp.model,21,0),{...inputs,phase:'normal'},.25).compressorDuty;
  cp.samples=Array.from({length:9},(_,i)=>({...inputs,timestamp:start+i*HOUR/4,indoorC:21,phase:'reduction',
    regime:'occupied',quality:[],compressorDuty:duty,auxKw:0,episodeId:'new-manual',treatmentKey:key}));
  const updated=updateAdaptiveEpisode(cp,{id:'new-manual',startedAt:start,endedAt:start+2*HOUR,phases:['reduction'],
    treatmentKey:key,responseComplete:true,complete:false,recoveryComplete:false});
  const response=equipmentResponseEstimate(updated.model,'reduction',key);
  assert.ok(Math.abs(response.ratio-1)<1e-12);
  assert.equal(response.validation.accepted,false,'Earlier checks do not validate the changed estimate');
});
function startup({peak=true,lead=6}={}) {
  const x=heatingExplorerFixture({hours:48,outdoorC:0,price:2});
  x.checkpoint={model:initialAdaptiveModel({heatPumpModelConfirmed:true}),health:{usableSamples:0},baselineC:null};
  x.settings.comfort.targetC=null;
  x.settings.savingsStrategy='savings';
  x.thermalState=null;
  Object.assign(x.equipment,{preheatAvailable:true,roomSettingC:21,observedPhase:'normal',normalSupplyC:30,supplyC:30});
  Object.assign(x.config,{learningTrials:true,maxTrialCostCents:150,trialBudgetCentsPerDay:300});
  x.trialBudgetRemainingCents=300;
  x.prices.forEach((p,i)=>{p.allInCentsPerKWh=peak&&i>=lead*4&&i<(lead+4)*4?150:2;});
  return x;
}

test('an empty model schedules useful preheat and peak reduction without completed trials',()=>{
  const x=startup();x.config.learningTrials=false;
  const saved=structuredClone(x.checkpoint),r=chooseCycle(x);
  assert.ok(r.plan);
  assert.equal(r.plan.trial,false);
  assert.ok(r.plan.schedule.preheatEnd>r.plan.schedule.preheatStart);
  assert.ok(r.plan.schedule.reductionStart>=x.now+6*HOUR);
  assert.ok(r.plan.estimatedBenefitCents>0);
  assert.equal(r.plan.readiness.thermalValidated,false);
  assert.equal(r.plan.readiness.actionValidated,false);
  assert.deepEqual(x.checkpoint,saved,'Planning cannot manufacture fitted evidence or a comfort reference');
  assert.equal(revalidatePlan({...x,plan:r.plan}).valid,true);
});

test('a supplied training cutoff changes validation provenance without delaying empty-model control or trials',()=>{
  const x=startup(),through=new Date(x.now).toISOString();
  x.config.homeModel={...homeModelConfiguration({training_through:through})};
  x.checkpoint.model=initialAdaptiveModel(x.config);x.config.learningTrials=false;
  const economic=chooseCycle(x);
  assert.ok(economic.plan?.schedule.roomBoostC>0);
  assert.equal(economic.plan.readiness.initialReady,true);
  assert.equal(economic.plan.readiness.actionValidated,false);
  const cheap=startup({peak:false});cheap.config.homeModel=x.config.homeModel;
  cheap.checkpoint.model=initialAdaptiveModel(cheap.config);
  const trial=chooseCycle(cheap);
  assert.equal(trial.plan?.trial,true);
  assert.ok(trial.plan.schedule.roomBoostC>0);
  for(const value of [null,'not-a-time','2026-01-01',through.replace('Z','+00:00')])
    assert.throws(()=>homeModelConfiguration({training_through:value}),/training cutoff/);
});

test('the complete shipped configuration plans peak optimization before any new evidence or experiments',()=>{
  for(const lead of [6,24]){
    const x=startup({lead});x.config=controlConfiguration(publicConfiguration.options.controller);
    x.config.learningTrials=false;x.trialBudgetRemainingCents=0;
    x.settings=validateSettings();
    x.checkpoint={model:initialAdaptiveModel(x.config),baselineC:null,health:{usableSamples:0}};
    const r=chooseCycle(x);
    assert.ok(x.checkpoint.model.floor.enabled,'Exercise the entire shipped model, including its optional slab defaults');
    assert.ok(r.plan?.schedule.preheatEnd>r.plan?.schedule.preheatStart);
    assert.equal(r.plan.trial,false);assert.equal(r.plan.readiness.actionValidated,false);
    assert.equal(revalidatePlan({...x,plan:r.plan}).valid,true);
  }
});

test('tomorrow price peaks remain visible beyond the first price-change shortlist',()=>{
  const x=startup({lead:24});
  x.prices.forEach((p,i)=>{if(i<96)p.allInCentsPerKWh=2+(i%4)*.1;});
  x.config.learningTrials=false;x.trialBudgetRemainingCents=0;x.equipment.learningTrialsToday=10;
  const r=chooseCycle(x);
  assert.ok(r.plan,'Neither trial targets nor a zero experimental budget prohibit economic operation');
  assert.equal(r.plan.trial,false);
  assert.ok(r.plan.schedule.preheatEnd>r.plan.schedule.preheatStart);
  assert.ok(r.plan.schedule.reductionStart>=x.now+24*HOUR);
});

test('a long moderately priced plateau cannot hide a short expensive peak and its useful preheat',()=>{
  const x=startup();x.config=controlConfiguration(publicConfiguration.options.controller);
  x.config.learningTrials=false;x.trialBudgetRemainingCents=0;x.settings=validateSettings();
  x.checkpoint={model:initialAdaptiveModel(x.config),baselineC:null,health:{usableSamples:0}};
  Object.assign(x.equipment,{normalSupplyC:35,supplyC:35,maximumSupplyC:45});
  // Invented quarter-hour prices: an early short peak followed by a long
  // plateau. Recovery during that plateau is expensive too.
  x.prices.forEach((p,i)=>{p.allInCentsPerKWh=i>=24&&i<28?200:
    i>=80&&i<120?100+(i%4)*.05:2+(i%4)*.05;});
  const result=chooseCycle(x),model=x.checkpoint.model;
  const args={model,intervals:forecastIntervals(x.prices,x.forecast,x.now),targetC:21,
    initialState:initialHomeState(model,21,0,0),config:x.config,equipment:x.equipment,
    occupancy:x.settings.occupancy,maxDropC:x.settings.comfort.maxDropC,maxRiseC:x.settings.comfort.maxRiseC};
  const schedule={preheatStart:x.now+4*HOUR,preheatEnd:x.now+6*HOUR,
    reductionStart:x.now+6*HOUR,reductionEnd:x.now+7*HOUR,
    roomBoostC:5,roomSettingC:26,treatmentKey:'room-boost-v1'};
  const benchmark=economicAdmission({args,schedule,settings:x.settings,
    prediction:evaluateCycle({...args,schedule}),referencePrediction:evaluateCycle(args)});
  assert.equal(benchmark.admitted,true,'The explicit preheat and short-peak cycle is a feasible benchmark');
  assert.ok(result.plan?.schedule.preheatEnd>result.plan?.schedule.preheatStart);
  assert.ok(result.plan.schedule.reductionStart>=x.now+6*HOUR&&result.plan.schedule.reductionStart<x.now+7*HOUR);
  assert.ok(result.plan.economics.lowerBenefitCents>=benchmark.lowerBenefitCents-1e-6,
    'The bounded search must retain this useful coupled opportunity');
});

test('warmer heating water uses a supported smaller ROOM increase instead of losing preheat entirely',()=>{
  const x=startup();x.config.learningTrials=false;
  Object.assign(x.equipment,{normalSupplyC:40,supplyC:40,maximumSupplyC:null});
  assert.equal(preheatRoomRequest(x.equipment,x.config).roomBoostC,3);
  const r=chooseCycle(x);
  assert.ok(r.plan?.schedule.preheatEnd>r.plan?.schedule.preheatStart);
  assert.equal(r.plan.schedule.roomBoostC,3);
  assert.equal(revalidatePlan({...x,plan:r.plan}).valid,true);
  x.equipment.maximumSupplyC=45;
  assert.equal(preheatRoomRequest(x.equipment,x.config).roomBoostC,5,
    'A verified native ceiling permits the configured ROOM increase without exceeding its water limit');
});

test('checked pure reduction does not label a new coupled preheat treatment independently validated',()=>{
  const x=startup();x.config.learningTrials=false;
  const checked=heatingExplorerFixture().checkpoint.model;
  x.checkpoint.model.validation=checked.validation;
  x.checkpoint.model.equipmentResponse=checked.equipmentResponse;
  x.checkpoint.model.equipmentResponse.phases.reduction.ratio=.25;
  x.checkpoint.model.forecastValidation=checked.forecastValidation;
  const result=chooseCycle(x),plan=result.plan;
  assert.ok(plan.schedule.preheatEnd>plan.schedule.preheatStart);
  assert.equal(plan.schedule.treatmentKey,'room-boost-v1');
  assert.equal(plan.readiness.thermalValidated,true);
  assert.equal(plan.readiness.actionValidated,false);
  assert.equal(revalidatePlan({...x,plan}).plan.readiness.actionValidated,false);
});

test('cheap preheating experiments can run before any thermal or reduction validation',()=>{
  const x=startup({peak:false}),r=chooseCycle(x);
  assert.equal(r.plan?.trial,true);
  assert.equal(r.phase,'preheat');
  assert.ok(r.plan.trialAllowanceCents<=150);
  assert.equal(revalidatePlan({...x,plan:r.plan}).valid,true);
  x.equipment.learningTrialsToday=20;
  assert.equal(revalidatePlan({...x,plan:r.plan}).reason,'daily-learning-trial-target-reached','Unvalidated learning cannot bypass the daily attempt limit');
});

test('zero experimental budget permits useful free trials but never paid experimentation',()=>{
  const x=startup({peak:false});
  x.prices.forEach(row=>{row.allInCentsPerKWh=0;});
  x.config.maxTrialCostCents=0;x.trialBudgetRemainingCents=0;
  x.equipment.trialBudgetRemainingCents=0;
  x.config.minimumHomeBenefitCents=1_000_000;
  const free=chooseCycle(x);
  assert.equal(free.plan?.trial,true);
  assert.equal(free.plan.trialAllowanceCents,0);
  assert.equal(revalidatePlan({...x,plan:free.plan}).valid,true);
  x.prices.forEach(row=>{row.allInCentsPerKWh=2;});
  const paid=chooseCycle(x);
  assert.ok(!paid.plan || paid.plan.trialAllowanceCents===0, 'A zero budget cannot admit positive cost exposure');
  assert.ok(!paid.plan || !paid.plan.schedule.roomBoostC, 'The paid preheat is replaced by a free reduction');
  x.prices.forEach(row=>{row.allInCentsPerKWh=0;});x.config.learningTrials=false;
  assert.equal(chooseCycle(x).plan,null,'The explicit experiment switch still disables free trials');
});

test('new planning still requires current temperatures and actual preheat capability',()=>{
  const x=startup();x.observations.indoor.stale=true;
  assert.equal(chooseCycle(x).plan,null);
  x.observations.indoor.stale=false;x.equipment.preheatAvailable=false;
  const r=chooseCycle(x);
  assert.ok(!r.plan || r.plan.schedule.preheatStart===r.plan.schedule.preheatEnd);
});

test('provisional reference quality adds no initial temperature or preheat-duration cap',()=>{
  const x=startup();x.equipment.comfortReferenceProvisional=true;
  x.settings.comfort.maxDropC=2;x.config.maxPreheatHours=2;
  const r=chooseCycle(x);
  assert.ok(r.plan);assert.equal(r.plan.maxDropC,2);
  assert.equal(revalidatePlan({...x,plan:r.plan}).valid,true);
});

test('a historical weather-demand curve cannot force a different modern indoor target to drift',()=>{
  const model=initialAdaptiveModel({homeModel:{lossPerHour:.012,hydronicCPerKwh:.06,internalCPerHour:.04,
    dutyPerDegree:.1,balanceTemperatureC:25}});
  let state=initialHomeState(model,18,0);
  for(let i=0;i<96;i++)state=predictThermalStep(model,state,{phase:'normal',targetC:18,outdoorC:0,solarRadiationWm2:0,auxKw:0},.25);
  assert.ok(Math.abs(state.indoorC-18)<.25);
});

test('private starting profiles validate provenance and do not claim installed fit acceptance',()=>{
  const options={loss_per_hour:.009,hydronic_c_per_kwh:.06,internal_c_per_hour:.03,
    duty_per_degree:.025,balance_temperature_c:16,trajectory_error_c:.4,
    training_samples:2000,training_sha256:'a'.repeat(64)};
  const cfg=controlConfiguration({home_model:options}),m=initialAdaptiveModel(cfg);
  assert.equal(m.parameters.lossPerHour,.009);
  assert.equal(m.initialModel.trainingSamples,2000);
  assert.equal(m.initialModel.basis,'historically-trained-initial-estimate');
  assert.equal(m.validation,null);assert.equal(m.trainedAt,null);
  assert.ok(initialHomeState(m,21,0).reserveC>21);
  for(const bad of [{made_up:1},{toString:1},{constructor:1},JSON.parse('{"__proto__":1}'),
    {loss_per_hour:0},{training_samples:2},{training_sha256:'secret'},null])
    assert.throws(()=>homeModelConfiguration(bad));
});

test('a genuine update from one contributing room supplies new aggregate evidence, all-held readings do not',()=>{
  const at=Date.parse('2026-01-01T00:00:00Z');
  const row=(i,fresh)=>({timestamp:at+i*HOUR/4,indoorC:21,outdoorC:0,phase:'normal',regime:'occupied',quality:[],
    indoorSensors:{indoor_temperature:{weight:.5,observedAt:fresh?at+i*HOUR/4:at},bedroom_temperature:{weight:.5,observedAt:at}},
    compressorDuty:.5,auxKw:0,solarRadiationWm2:0});
  const held=thermalObservationIntervals([row(0,false),row(1,false),row(2,false)]);
  assert.equal(held.at(-1).temperatureObservationFresh,false);
  const changed=thermalObservationIntervals([row(0,false),row(1,true),row(2,false)]);
  assert.ok(changed.some(x=>x.timestamp===at+HOUR/4&&x.temperatureObservationFresh!==false));
});

test('closed manual response evidence stays useful without claiming complete recovery or forecast validation',()=>{
  const start=Date.parse('2026-01-01T00:00:00Z');let cp=null;
  for(let i=0;i<12;i++){
    const timestamp=start+i*HOUR/4;
    cp=updateAdaptiveLearning(cp,{timestamp,indoorC:21,outdoorC:0,phase:i<8?'reduction':'normal',regime:'occupied',quality:[],
      solarRadiationWm2:0,compressorDuty:0,auxKw:0,thermalCompressorDuty:0,thermalAuxKw:0,actualModeKnown:true,
      episodeId:i<8?'manual:example':null,treatmentKey:'reduction-only-v1'}, {now:timestamp});
  }
  cp=updateAdaptiveEpisode(cp,{id:'manual:example',startedAt:start,endedAt:start+2*HOUR,
    phases:['reduction'],treatmentKey:'reduction-only-v1',responseComplete:true,complete:false,recoveryComplete:false});
  assert.equal(cp.episodeArchive.at(-1).responseOnly,true);
  assert.equal(cp.model.energy.episodes,0);
  assert.equal(cp.model.forecastValidation,undefined);
  assert.ok(cp.model.equipmentResponse.phases.reduction?.trainingEpisodes>=1);
  assert.equal(cp.model.equipmentResponse.validation.phases.reduction.accepted,false);
  const again=updateAdaptiveEpisode(cp,{id:'manual:example',startedAt:start,endedAt:start+2*HOUR,
    phases:['reduction'],treatmentKey:'reduction-only-v1',responseComplete:true,complete:false,recoveryComplete:false});
  assert.equal(again.episodeArchive.length,cp.episodeArchive.length);
});

test('initial reserve selection cannot use the scored endpoint or later temperature evidence',()=>{
  const start=Date.parse('2026-01-01T00:00Z'),model=initialAdaptiveModel();
  const rows=Array.from({length:48},(_,i)=>({timestamp:start+i*HOUR/4,indoorC:21,
    outdoorC:0,solarRadiationWm2:0,compressorDuty:.5,auxKw:0,phase:'normal',regime:'occupied',quality:[]}));
  const before=evaluateThermalModel(model,rows,{rollout:false,requireWarmup:true});
  assert.ok(before.predictions.length>0);
  assert.ok(before.predictions[0].timestamp>=start+6*HOUR);
  const changed=structuredClone(rows);
  for(const row of changed)if(row.timestamp>=before.predictions[0].timestamp)row.indoorC+=.2;
  const after=evaluateThermalModel(model,changed,{rollout:false,requireWarmup:true});
  assert.equal(before.predictions[0].predictedC,after.predictions[0].predictedC);
  assert.notEqual(before.predictions[0].actualC,after.predictions[0].actualC);
});

test('the first preheat remains useful after several reductions without claiming recent data is held out',()=>{
  const start=Date.parse('2026-01-01T00:00Z');let cp=null;
  for(let episode=0;episode<6;episode++){
    const begin=start+episode*6*HOUR,preheat=episode>=4,id=`manual-${episode}`;
    const phase=preheat?'preheat':'reduction',treatmentKey=preheat?'room-boost-v1':'reduction-only-v1';
    for(let i=0;i<=8;i++){
      const timestamp=begin+i*HOUR/4;
      cp=updateAdaptiveLearning(cp,{timestamp,indoorC:21,outdoorC:0,solarRadiationWm2:0,
        phase,regime:'occupied',quality:[],compressorDuty:preheat?.8:.1,auxKw:0,
        episodeId:id,treatmentKey,roomBoostC:preheat?2:0,targetC:21,actualModeKnown:true},{now:timestamp});
    }
    cp=updateAdaptiveEpisode(cp,{id,startedAt:begin,endedAt:begin+2*HOUR,
      phases:[phase],treatmentKey,responseComplete:true,complete:false,recoveryComplete:false});
  }
  const response=equipmentResponseEstimate(cp.model,'preheat','room-boost-v1');
  assert.equal(response.trainingEpisodes,2,'A global last-three holdout must not remove the first preheat evidence');
  assert.equal(response.validation.accepted,false);
  assert.equal(response.validation.episodes,0,'Immediate adaptation is explicitly unchecked');
  assert.equal(equipmentResponseEstimate(cp.model,'reduction','reduction-only-v1').trainingEpisodes,4);
});

test('sparse genuine endpoints retain complete heat windows without inventing intervening room reports',()=>{
  const start=Date.parse('2026-01-01T00:00Z'),model=initialAdaptiveModel();
  const rows=Array.from({length:65},(_,i)=>({timestamp:start+i*HOUR/4,indoorC:21,
    outdoorC:0,solarRadiationWm2:0,compressorDuty:.5,auxKw:0,phase:'normal',regime:'occupied',quality:[],
    indoorSensors:{room:{weight:1,observedAt:start+Math.floor(i/32)*8*HOUR}}}));
  const result=evaluateThermalModel(model,rows,{rollout:false,requireWarmup:true});
  assert.equal(result.predictions.length,1);
  assert.equal(result.predictions[0].dt,8);
  assert.equal(result.predictions[0].segments.length,32);
  rows[40].compressorDuty=null;
  assert.equal(evaluateThermalModel(model,rows,{rollout:false,requireWarmup:true}).predictions.length,0,
    'Missing heat inside the long interval remains unknown');
});

test('manual treatment identity survives ticks and restart, then closes as replayable response evidence',async t=>{
  const store=new Store(':memory:');let now=Date.parse('2026-01-01T00:00Z');
  const config={input:'offline',control:{homeModel:homeModelConfiguration({loss_per_hour:.012})}};
  const make=()=>{
    const engine=new Engine({store,config,clock:()=>now});
    t.after(async()=>{clearTimeout(engine.executor.timer);engine.executor.closed=true;await engine.heatingPlanning.close();await engine.closeFireplace();});
    return engine;
  };
  t.after(()=>store.close());
  const first=make();first.recordManualHeating('reduction',now);
  const id=store.getState('manual-learning:offline').id;
  now+=HOUR/4;first.tick();
  assert.equal(store.getState('manual-learning:offline').id,id);
  const restarted=make();
  now+=HOUR/4;restarted.recordManualHeating('normal',now);
  assert.equal(store.getState('manual-learning:offline'),null);
  const episode=store.learningJournal({input:'offline'}).find(row=>row.kind==='episode');
  assert.equal(episode.payload.value.id,id);
  assert.equal(episode.payload.value.responseComplete,true);
  assert.equal(episode.payload.value.complete,false);
  const replay=replayLearningJournal(store,'offline',null,{rebuild:true,persistCheckpoint:false,persistCoefficients:false});
  assert.equal(replay.model.parameters.lossPerHour,.012);
  assert.equal(replay.episodeArchive.find(row=>row.id===id)?.responseOnly,true);
  assert.equal(replay.model.energy.episodes,0);
});

test('a timed manual treatment closes its learning episode when control returns to Normal',async t=>{
  const store=new Store(':memory:');let now=Date.parse('2026-01-01T00:00Z');
  const engine=new Engine({store,config:{input:'offline'},clock:()=>now});
  t.after(async()=>{clearTimeout(engine.executor.timer);engine.executor.closed=true;
    await engine.heatingPlanning.close();await engine.closeFireplace();store.close();});
  engine.recordManualHeating('preheat',now,2);
  const id=store.getState('manual-learning:offline').id;
  now+=HOUR;engine.applied={phase:'normal',at:now,roomBoostC:0,verified:false};
  engine.tick();
  assert.equal(store.getState('manual-learning:offline'),null);
  const episodes=()=>store.learningJournal({input:'offline'}).filter(row=>row.kind==='episode');
  assert.equal(episodes().length,1);assert.equal(episodes()[0].payload.value.id,id);
  assert.equal(episodes()[0].payload.value.endedAt,now);
  now+=HOUR/4;engine.tick();assert.equal(episodes().length,1);
  const context=store.learningJournal({input:'offline'}).filter(row=>row.kind==='context').at(-1);
  assert.equal(context.payload.value.controlContext.episodeId,null);
});

test('manual treatment transitions roll back identity, evidence and applied state together',async t=>{
  const store=new Store(':memory:'),now=Date.parse('2026-01-01T00:00Z');
  const engine=new Engine({store,config:{input:'offline'},clock:()=>now});
  t.after(async()=>{clearTimeout(engine.executor.timer);engine.executor.closed=true;
    await engine.heatingPlanning.close();await engine.closeFireplace();store.close();});
  engine.recordManualHeating('preheat',now,2);
  const manual=store.getState('manual-learning:offline'),applied=structuredClone(engine.applied);
  const journal=store.learningJournal({input:'offline'});
  assert.throws(()=>store.transaction(()=>{engine.recordManualHeating('normal',now+HOUR);throw Error('synthetic rollback');}));
  assert.deepEqual(store.getState('manual-learning:offline'),manual);
  assert.deepEqual(engine.applied,applied);
  assert.deepEqual(store.learningJournal({input:'offline'}),journal);
});


test('overall readiness and duration summaries cannot combine checks from different treatments',()=>{
  const x=heatingExplorerFixture(),model=x.checkpoint.model;
  model.forecastValidation.records=model.forecastValidation.records.map(record=>({...record,treatmentKey:'room-boost-v1',roomBoostC:2,preheatHours:1}));
  model.forecastValidation.treatmentKey='room-boost-v1';
  const readiness=learningReadiness(x.checkpoint,x.config,x.equipment);
  assert.equal(readiness.responseValidated,true);
  assert.equal(readiness.advanceValidated,false);
  assert.equal(readiness.actionValidated,false);
  assert.equal(validatedReductionHours(model),0);
  assert.equal(readiness.reasons.includes('awaiting-held-out-tariff-response'),false,
    'A missing matching forecast does not erase already checked requested-mode response');
  assert.equal(readiness.reasons.includes('awaiting-frozen-advance-cycle-predictions'),true);
});
