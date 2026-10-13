import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createChargingController } from '../src/charging/controller.js';
import { createEaseeScheduleAdapter, normalizeScheduleState } from '../src/charging/easee.js';
import { createOcppScheduleAdapter, initialOcppControllerState, ocppPauseInstruction } from '../src/charging/ocpp.js';
import { updateTargetState } from '../src/charging/target.js';
import { updateChargingProgress, restoreChargingProgress } from '../src/charging/progress.js';
import { readChargingRuntime, writeChargingRuntime } from '../src/charging/runtime-storage.js';

const START = Date.parse('2026-01-15T00:00:00Z'), HOUR = 3600_000, MINUTE = 60_000;
const clone = structuredClone;

async function waitingBackendFixture(t, { priorNativeRestriction = false, nativeOffset = -HOUR } = {}) {
  let now = START + HOUR, currentSchedule = normalizeScheduleState({ enabled: 'none' });
  let mode = 2, reason = 54, power = 0, physicalAt = now;
  const store = new Store(':memory:'), writes = [], nativeWrites = [];
  const config = { input: 'mqtt', connections: { easee: { charger_id: 'synthetic-handoff-charger', equalizer_id: 'synthetic-handoff-equalizer' } },
    charging: { defaults: { capacityKwh: 20, manualSoc: 20, minimumSoc: 85, readyBy: '08:00' },
      vehicles: { bmw: { mqttTopic: 'synthetic/handoff/bmw' } },
      chargers: { charger2: { enabled: true, deviceId: 'synthetic-handoff-evse', topicPrefix: 'synthetic/handoff/evse',
        mainFuseA: [16,16,16], marginA: [0,0,0] } } } };
  const runtime = new ChargingRuntime({ engine: {}, store, config, clock: () => now, canControl: () => true });
  // The test advances the production reconciliations explicitly. Background
  // scheduling cannot race the fixture's admitted physical source changes.
  runtime.tick = () => {};
  for (const item of Object.values(runtime.chargers)) item.controls.enabled = false;
  runtime.refreshSettings();
  t.after(async () => { await runtime.close(); store.close(); });
  const item = runtime.chargers.charger1, nativeScope = 'b'.repeat(64);
  const plan = { id: 'synthetic-accepted-joint-program', startAt: START + 2 * HOUR,
    periods: [{ startAt: START + 2 * HOUR, endAt: START + 3 * HOUR }, { startAt: START + 3 * HOUR + 15 * MINUTE, endAt: null }],
    finalStartAt: START + 3 * HOUR + 15 * MINUTE, deadlineAt: START + 6 * HOUR,
    targetAt: START + 4 * HOUR, feasible: true, provisional: false, state: 'waiting' };
  const rows = () => [[80,344],[141,1],[250,true],[31,true],[109,mode],[96,reason],[120,power],
    [47,16],[48,32],[104,32],[22,16],[23,16],[24,16],[111,230],[112,230],[113,230],
    [183,power>0?16:0],[184,power>0?16:0],[185,power>0?16:0],[230,16],[231,16],[232,16]]
    .map(([id,value]) => ({ id,value,timestamp:new Date([109,96,120].includes(id)?physicalAt:START+HOUR).toISOString() }));
  const cloud = createEaseeScheduleAdapter({ chargerId: config.connections.easee.charger_id, equalizerId: config.connections.easee.equalizer_id,
    clock: () => now, canControl: () => true,
    readObservations: async id => id === config.connections.easee.charger_id ? rows()
      : [31,32,33,34,35,36].map(id => ({id,value:id<34?0:230,timestamp:new Date(now).toISOString()})),
    request: async (url, options={}) => {
      if (options.method === 'GET') return url.endsWith('/config') ? {maxAllocatedCurrent:16} : clone(currentSchedule);
      assert.equal(options.controlGuard?.() ?? true, true);
      writes.push({method:options.method,path:url.split('/').slice(-2).join('/')});
      if (url.endsWith('/delayed/disable')) currentSchedule=normalizeScheduleState({...currentSchedule,enabled:'none'});
      else if (url.endsWith('/delayed')) currentSchedule=normalizeScheduleState({...currentSchedule,enabled:'delayed',delayed:JSON.parse(options.body)});
      else assert.fail('Unexpected synthetic cloud mutation');
      return {};
    } });
  // The cloud controller accepts a previously selected joint program through
  // its real producer. Native acquisition below uses the real runtime callback.
  cloud.createController = options => createChargingController({...options,getPlan:()=>clone(plan)});
  await runtime.setAdapter('charger1',cloud);
  await item.controller.update({enabled:true,timezone:'Europe/Helsinki',maximumAmps:16,plan});
  assert(item.controller.status().owned,`cloud fixture did not adopt: ${item.controller.status().errorCode}`);
  item.controls.enabled=true; runtime.refreshSettings(); item.plan=clone(plan);
  runtime.persist();
  const connectedAt=item.controller.status().session.connectedAt;
  const targetFact=(value,at,id)=>({chargeLimitSoc:value,fields:{chargeLimitSoc:{measuredAt:at,receivedAt:at,readingId:id}}});
  item.targetState=updateTargetState(null,{connectedAt,reading:targetFact(100,now,'synthetic-target-100'),now});
  now+=1000;
  item.targetState=updateTargetState(item.targetState,{connectedAt,reading:targetFact(85,now,'synthetic-target-85'),now});
  // Current source context is present, while the filter itself is produced by
  // the same source update function and retains its original clocks.
  runtime.setMqttStatus({connected:true,subscribed:true},'bmw');
  runtime.receiveSoc('synthetic/handoff/bmw',JSON.stringify({provider:'bmw-cardata',chargeLimitSoc:85,measuredAt:now,
    readingId:'synthetic-target-source',fields:{chargeLimitSoc:{measuredAt:now,readingId:'synthetic-target-source'}}}));
  runtime.persist();
  assert(item.targetState?.lower);
  item.request.overrides={capacityKwh:20,minimumSoc:85}; item.request.deadlineAt=START+6*HOUR;
  await item.controller.update({enabled:true,timezone:'Europe/Helsinki',maximumAmps:16,plan});
  runtime.persist(); item.plan=clone(plan);
  assert.equal(item.controller.status().phase,'waiting');
  const nativeState=initialOcppControllerState(nativeScope);
  nativeState.session={transactionId:null,connected:true,connectedAt:connectedAt+nativeOffset,lastDisconnectedAt:null};
  nativeState.nextProfileId=Math.max(nativeState.nextProfileId,702);
  if (priorNativeRestriction) nativeState.owned={...ocppPauseInstruction({profileId:701,transactionId:41,startAt:now+HOUR,now}),requestedAt:now,confirmedAt:now};
  store.setState(`${runtime.key}:charger1:${item.association}:ownership:ocpp`,nativeState);
  const currentNative = () => ({transport:'ocpp',scope:nativeScope,connectionId:'synthetic-returning-authenticated-socket',
    readAt:now,online:true,connectorStatus:'Charging',statusAt:now,statusReceivedAt:now,transactionId:42,
    transactionStartedAt:null,transactionConfirmedAt:now,transactionConfirmed:true,transactionProvenance:'meter-values',
    pluggedIn:true,powerKw:11,powerAt:now,powerReceivedAt:now,appControl:null,
    limits:{chargerA:16,cableA:16,circuitA:[16,16,16],equalizerAvailableA:[16,16,16]},
    supply:{availableCurrentA:[16,16,16],propertyCurrentA:[16,16,16],chargerCurrentA:[16,16,16],voltageV:[230,230,230],
      observationTimes:{property:[now,now,now],charger:[now,now,now],voltage:[now,now,now]}}});
  const native=createOcppScheduleAdapter({scope:nativeScope,clock:()=>now,readSnapshot:currentNative,isCurrent:()=>true,canControl:()=>true,
    request:async(action,payload,options)=>{nativeWrites.push({action,payload:clone(payload)});assert.equal(options.guard(),true);return {status:'Unknown'};}});
  return {runtime,store,item,cloud,native,nativeState,nativeWrites,writes,plan,get now(){return now;},
    advance(ms){now+=ms;},async handoff(){const proof=runtime.ownedCloudBackendChangeProof('charger1',(await cloud.read()).schedule,native.scope);assert.equal(typeof proof,'string');
      await runtime.pauseForBackendChange('charger1',{target:'native',nativeScope:native.scope,ownedCloudProof:proof});await runtime.finishBackendChange('charger1',native);}};
}


for (const [label,nativeOffset] of [['older',-HOUR],['newer',500]]) {
  for (const directPrepare of [false,true]) {
    test(`a recorded ${label} native session boundary fences ${directPrepare?'direct preparation without owned proof':'owned-cloud inspection'} before cleanup`,async t=>{
      const f=await waitingBackendFixture(t,{nativeOffset,priorNativeRestriction:true});
      const original={request:clone(f.item.request),target:clone(f.item.targetState),progress:clone(f.item.progress),
        cost:clone(f.item.sessionCost),plan:clone(f.item.plan),controls:clone(f.item.controls),cloud:clone(f.item.controller.status().owned),
        native:clone(f.store.getState(`${f.runtime.key}:charger1:${f.item.association}:ownership:ocpp`))};
      assert.equal(original.target.lower.value,85);
      assert.equal(original.native.session.connected,true);
      assert(original.native.session.connectedAt<=f.now,'positive native evidence is not a future timestamp');
      assert.notEqual(original.native.session.connectedAt,f.item.controller.status().session.connectedAt);
      const cloudWrites=f.writes.length;
      if (!directPrepare) assert.equal(f.runtime.ownedCloudBackendChangeProof('charger1',(await f.cloud.read()).schedule,f.native.scope),null);
      await assert.rejects(f.runtime.pauseForBackendChange('charger1',{target:'native',nativeScope:f.native.scope}),/Saved native and current cloud session boundaries disagree/);
      assert.equal(f.writes.length,cloudWrites,'the own delayed program is not cleared');
      assert.equal(f.nativeWrites.length,0,'the native profile is not guessed cleared');
      assert.equal(f.item.backendTransition??null,null,'a rejected guard does not suspend cloud reconciliation');
      assert.deepEqual(f.item.request,original.request);
      assert.deepEqual(f.item.targetState,original.target);
      assert.deepEqual(f.item.progress,original.progress);
      assert.deepEqual(f.item.sessionCost,original.cost);
      assert.deepEqual(f.item.plan,original.plan);
      assert.deepEqual(f.item.controls,original.controls);
      assert.deepEqual(f.item.controller.status().owned,original.cloud);
      assert.deepEqual(f.store.getState(`${f.runtime.key}:charger1:${f.item.association}:ownership:ocpp`),original.native);
      assert.equal(f.item.controller.status().phase,'waiting');
    });
  }
}

for (const [label,targetScope] of [['different native setup scope','c'.repeat(64)],['missing target native scope',undefined],['malformed target native scope','unknown']])
  test(`${label} rejects before cloud cleanup even when the saved physical date matches`,async t=>{
    const f=await waitingBackendFixture(t,{nativeOffset:0,priorNativeRestriction:true});
    const original={request:clone(f.item.request),target:clone(f.item.targetState),plan:clone(f.item.plan),cloud:clone(f.item.controller.status().owned),
      native:clone(f.store.getState(`${f.runtime.key}:charger1:${f.item.association}:ownership:ocpp`))};
    assert.equal(original.native.session.connectedAt,f.item.controller.status().session.connectedAt);
    const count=f.writes.length;
    await assert.rejects(f.runtime.pauseForBackendChange('charger1',{target:'native',nativeScope:targetScope}));
    assert.equal(f.writes.length,count);assert.equal(f.nativeWrites.length,0);
    assert.deepEqual(f.item.request,original.request);assert.deepEqual(f.item.targetState,original.target);assert.deepEqual(f.item.plan,original.plan);
    assert.deepEqual(f.item.controller.status().owned,original.cloud);
    assert.deepEqual(f.store.getState(`${f.runtime.key}:charger1:${f.item.association}:ownership:ocpp`),original.native);
  });

for (const [label,change] of [
  ['present request scope mismatch',f=>{f.item.request.scope=`${f.item.association}:${START}`;}],
  ['present request identity mismatch',f=>{f.item.request.sessionId='synthetic-unresolved-session';}],
  ['present target physical mismatch',f=>{f.item.targetState.connectedAt=START;}],
  ['unadmitted current cloud ownership',f=>{f.item.ownershipAdmitted=false;}],
  ['present references with stale published cloud evidence',f=>{f.advance(2*MINUTE);}],
]) test(`${label} cannot hide known saved/current session boundary disagreement`,async t=>{
  const f=await waitingBackendFixture(t,{nativeOffset:-HOUR,priorNativeRestriction:true});
  change(f);
  const original={request:clone(f.item.request),target:clone(f.item.targetState),plan:clone(f.item.plan),cloud:clone(f.item.controller.status().owned),
    native:clone(f.store.getState(`${f.runtime.key}:charger1:${f.item.association}:ownership:ocpp`))};
  const count=f.writes.length;
  await assert.rejects(f.runtime.pauseForBackendChange('charger1',{target:'native',nativeScope:f.native.scope}));
  assert.equal(f.writes.length,count,'unknown current references cannot authorize delayed cleanup');
  assert.equal(f.nativeWrites.length,0);
  assert.deepEqual(f.item.request,original.request);assert.deepEqual(f.item.targetState,original.target);assert.deepEqual(f.item.plan,original.plan);
  assert.deepEqual(f.item.controller.status().owned,original.cloud);
  assert.deepEqual(f.store.getState(`${f.runtime.key}:charger1:${f.item.association}:ownership:ocpp`),original.native);
});

test('current admitted context becoming unknown while adapter preparation waits rejects before cleanup',async t=>{
  const f=await waitingBackendFixture(t,{nativeOffset:0,priorNativeRestriction:true});
  let release;f.item.adapterPending=true;f.item.adapterFlight=new Promise(resolve=>{release=resolve;});
  const count=f.writes.length;
  const operation=f.runtime.pauseForBackendChange('charger1',{target:'native',nativeScope:f.native.scope});
  f.item.ownershipAdmitted=false;f.item.adapterPending=false;release();
  await assert.rejects(operation);
  assert.equal(f.writes.length,count);assert.equal(f.nativeWrites.length,0);
  assert.equal(f.item.backendTransition??null,null,'failed preparation returns ordinary cloud reconciliation');
  assert.equal(f.item.controller.status().phase,'waiting');assert(f.item.controller.status().owned);
});

async function progressOnlyStartup(t,{dormant}) {
  const original=await waitingBackendFixture(t,{nativeOffset:0});
  const sourceAt=original.now, scope=original.item.request.scope;
  const nativeValue=(value,source)=>({value,source,available:true,measuredAt:sourceAt,receivedAt:sourceAt});
  const known={id:'charger1',settings:{manualSoc:20},requiredGridKwh:20,telemetry:{providerConnected:true,vehicle:{state:'identified',id:'bmw',sessionId:scope}},
    values:{soc:nativeValue(50,'bmw-cardata'),connected:{value:true,available:true},minimumSoc:nativeValue(85,'bmw-target-filter'),capacityKwh:nativeValue(69,'bmw-cardata')}};
  const unknown={...known,telemetry:{providerConnected:false,vehicle:{state:'unidentified',reason:'assignment-unresolved'}},
    values:{soc:{value:20,source:'manual-fallback',available:true},connected:{value:null,available:false},
      minimumSoc:{value:80,source:'manual-fallback',available:true},capacityKwh:{value:20,source:'manual-fallback',available:true}}};
  const observed=updateChargingProgress(null,known,sourceAt).state;
  const progress=restoreChargingProgress(updateChargingProgress(dormant?observed:null,unknown,sourceAt+1000).state);
  assert.equal(Boolean(progress.reference.vehicleScope||progress.batteryInputs?.scope),dormant);
  const saved=readChargingRuntime(original.store,original.runtime.key),record=saved.chargers.charger1;
  Object.assign(record,{request:null,targetState:null,vehicleMatch:null,vehicleEvidence:null,vehicleConflict:null,identification:null,
    plan:null,sessionCost:null,progress});
  const store=new Store(':memory:');writeChargingRuntime(store,original.runtime.key,saved);
  const runtime=new ChargingRuntime({engine:{},store,config:original.runtime.config,clock:()=>sourceAt+1000,canControl:()=>true});
  runtime.tick=()=>{};
  let reads=0;
  await runtime.setAdapter('charger1',{read:async()=>{reads++;throw Error('Synthetic startup has no cloud source');}});
  t.after(async()=>{await runtime.close();store.close();});
  return {runtime,store,item:runtime.chargers.charger1,progress,observedProgress:observed,nativeScope:original.native.scope,get reads(){return reads;}};
}

test('real dormant scoped battery/charge progress alone fences native preparation during unknown-source startup',async t=>{
  const f=await progressOnlyStartup(t,{dormant:true});
  assert.equal(f.item.request,null);assert.equal(f.item.targetState,null);assert.equal(f.item.vehicleMatch,null);
  assert(f.item.progress.reference.vehicleScope);assert(f.item.progress.batteryInputs.scope);
  assert.equal(f.item.controller.status().session,null);assert.equal(f.item.controller.status().snapshot,null);
  await assert.rejects(f.runtime.pauseForBackendChange('charger1',{target:'native',nativeScope:f.nativeScope}));
  assert.deepEqual(f.item.progress,f.progress,'original dormant anchor and battery clocks remain unchanged');
  assert.equal(f.reads,0,'unknown historical context is rejected before a cleanup read or action');
  assert.equal(f.item.backendTransition??null,null);
});

test('a genuinely unscoped initial manual fallback does not claim a prior physical charging episode',async t=>{
  const f=await progressOnlyStartup(t,{dormant:false});
  assert.equal(f.item.progress.reference.vehicleScope,null);assert.equal(f.item.progress.batteryInputs,null);
  await f.runtime.pauseForBackendChange('charger1',{target:'native',nativeScope:f.nativeScope});
  assert.equal(f.item.backendTransition.ready,true,'empty current initialization may prepare configured native setup');
  assert.deepEqual(f.item.progress,f.progress);
  assert.equal(f.item.controller.status().owned,null);
  assert.equal(f.item.controller.status().pending,null);
});


test('genuinely absent startup gaining an admitted scoped producer reference across adapterFlight rejects before cleanup',async t=>{
  const f=await progressOnlyStartup(t,{dormant:false});
  assert.equal(f.item.controller.status().session,null);assert.equal(f.item.controller.status().snapshot,null);
  assert.equal(f.item.request,null);assert.equal(f.item.targetState,null);assert.equal(f.item.progress.reference.vehicleScope,null);
  let release;f.item.adapterPending=true;f.item.adapterFlight=new Promise(resolve=>{release=resolve;});
  const operation=f.runtime.pauseForBackendChange('charger1',{target:'native',nativeScope:f.nativeScope});
  // A current producer reference is admitted after the initial empty-context
  // capture. Its own original source clocks are retained, never manufactured
  // by the later backend-preparation receipt.
  await f.runtime.write(()=>{f.item.progress=restoreChargingProgress(f.observedProgress);});
  const admitted=clone(f.item.progress);
  assert(admitted.reference.vehicleScope);assert(admitted.batteryInputs.scope);
  f.item.adapterPending=false;release();
  await assert.rejects(operation);
  assert.equal(f.reads,0,'changed context is rejected before the old backend reads or cleans up');
  assert.equal(f.item.backendTransition??null,null,'unprepared rejection returns ordinary source reconciliation');
  assert.deepEqual(f.item.progress,admitted,'the newer admitted reference is preserved');
});
