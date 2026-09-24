import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chargingConfiguration } from '../src/charging/config.js';
import { createShellyEvseAdapter, createShellyController } from '../src/charging/shelly-evse.js';
import { shellyCurrentLimit } from '../src/charging/shelly-limit.js';
const NOW = 1800000000000;
const config = extra => chargingConfiguration({chargers:{charger2:{enabled:true, deviceId:'synthetic-evse',topicPrefix:'test/evse',model:'synthetic-model',firmware:'synthetic-firmware',verified:true,
  connectedStates:['connected','paused'],disconnectedStates:['free'],chargingStates:['charging'],additiveCurrentVerified:true,marginA:[0,0,0],...extra}}}).chargers.charger2;
const reading = currents => ({currents,times:[NOW,NOW,NOW],healthy:true});
test('phase limiter preserves absolute Shelly capacity, reservation and minimum-current boundary', () => {
  const args={config:config(),now:NOW,property:reading([34,30,32]),easee:reading([12,12,12]),shelly:reading([12,12,12])};
  assert.equal(shellyCurrentLimit(args).currentA,15);
  assert.equal(shellyCurrentLimit({...args,reservationA:8}).currentA,7);
  assert.equal(shellyCurrentLimit({...args,property:reading([44,30,32])}).currentA,0);
  assert.equal(shellyCurrentLimit({...args,property:reading([43,30,32])}).currentA,6);
  assert.equal(shellyCurrentLimit({...args,config:config({marginA:[1,1,1]})}).currentA,14);
  assert.equal(shellyCurrentLimit({...args,property:reading([40,36,38]),easee:reading([18,18,18])}).currentA,15);
});
test('skew, nonadditive residual and telemetry loss use accepted fallback with tighter known bounds', () => {
  const args={config:config(),now:NOW,property:reading([34,30,32]),easee:reading([12,12,12]),shelly:reading([12,12,12])};
  for(const property of [null,{...reading([34,30,32]),times:[NOW-6000,NOW,NOW]},reading([1,1,1])]) {
    const result=shellyCurrentLimit({...args,property});assert.equal(result.currentA,12);assert.equal(result.reason,'telemetry-fallback');assert.equal(result.guaranteedProtection,false);
  }
  assert.equal(shellyCurrentLimit({...args,property:null,vehicleCurrentA:7}).currentA,7);
  assert.equal(shellyCurrentLimit({...args,property:null,allocationA:0}).currentA,0);
});
function fixture(t, extra={}) {
  let now=NOW, authority=true, failSave=false;
  const service={id:0,auto_balance:{enable:false},auto_charge:true,global_charge_limit:0,global_time_limit:0},serviceStatus={state:'running'},schedules={rev:1,jobs:[]};
  const client=new EventEmitter(), values=new Map(), writes=[], energy=[];
  const roleTypes={current_limit:'number',start_charging:'boolean',work_state:'enum',phase_info:'object',energy_charge:'number',time_charge:'number'};
  const roles=Object.keys(roleTypes), ids=Object.fromEntries(roles.map((role,i)=>[role,i+200]));
  const fields={current_limit:16,start_charging:true,work_state:'charging',phase_info:{total_power:8280,total_act_energy:0,phase_a:{voltage:230,current:12,power:2760},phase_b:{voltage:230,current:12,power:2760},phase_c:{voltage:230,current:12,power:2760}},energy_charge:0,time_charge:0};
  client.subscribe=(topics,_opts,cb)=>{client.topics=topics;cb(null,topics.map(topic=>({topic,qos:0})));};
  client.publish=(topic,payload,options,cb)=>{
    const frame=JSON.parse(payload);writes.push({...frame,topic,options});let result;
    if(frame.method==='Shelly.GetDeviceInfo')result={id:'synthetic-evse',model:'synthetic-model',fw_id:'synthetic-firmware'};
    else if(frame.method==='Service.GetConfig')result=structuredClone(service);
    else if(frame.method==='Schedule.List')result=structuredClone(schedules);
    else if(frame.method==='Service.GetStatus')result=structuredClone(serviceStatus);
    else if(frame.method.endsWith('.GetConfig'))result={id:ids[frame.params.role],owner:'service:0',access:'crw',min:6,max:16,meta:{ui:{step:1}}};
    else if(frame.method.endsWith('.Set')) {fields[frame.params.role]=frame.params.value;result=null;}
    else result={value:structuredClone(fields[frame.params.role]),last_update_ts:now/1000};
    cb?.();queueMicrotask(()=>client.emit('message',`${frame.src}/rpc`,Buffer.from(JSON.stringify({id:frame.id,src:'synthetic-evse',dst:frame.src,result})),{}));
  };
  const store={getState:key=>structuredClone(values.get(key)),setState:(key,value)=>{if(failSave)throw Error('disk');values.set(key,structuredClone(value));},transaction:fn=>fn(),event:()=>1};
  const engine={recorder:{recordEnergy:value=>energy.push(value)}};
  const adapter=createShellyEvseAdapter({config:config(extra),broker:{address:'mqtt://synthetic'},client,store,engine,clock:()=>now,canControl:()=>authority});
  t.after(()=>adapter.close());
  return {adapter,client,fields,writes,energy,values,service,serviceStatus,schedules,now:()=>now,setNow:value=>now=value,setAuthority:value=>authority=value,setFail:value=>failSave=value,
    async ready(){client.emit('connect');client.emit('message','test/evse/online',Buffer.from('true'),{retain:true});await adapter.refresh();},
    notify(role,value,packet={}){client.emit('message','test/evse/events/rpc',Buffer.from(JSON.stringify({src:'synthetic-evse',method:'NotifyStatus',params:{[`${roleTypes[role]}:${ids[role]}`]:{value,last_update_ts:now/1000}}})),packet);}};
}
test('official-shaped role RPC discovers capabilities and canonical C2 energy never uses a vehicle feed', async t=>{
  const f=fixture(t);await f.ready();assert.equal(f.adapter.snapshot().controlReady,true);
  f.setNow(NOW+1000);f.fields.phase_info.total_act_energy=.002;await f.adapter.refresh();
  assert.equal(f.energy.length,1);assert.equal(f.energy[0].source,'shelly-evse');assert.equal(f.energy[0].prefix,'ev2');assert.equal(f.energy[0].energies[0],.002);
  await f.adapter.refresh();assert.equal(f.energy.length,1);
  f.setNow(NOW+2000);f.fields.phase_info.total_act_energy=0;await f.adapter.refresh();assert.equal(f.energy.length,1);
  assert.equal(f.adapter.snapshot().error,'evse-counter-reset');
});
test('each physical negative/positive notification closes its epoch even between polling ticks',async t=>{
  const f=fixture(t);await f.ready();const first=f.adapter.snapshot().session.sessionId;
  f.setNow(NOW+1000);f.notify('work_state','free');f.setNow(NOW+2000);f.notify('work_state','connected');
  assert.notEqual(f.adapter.snapshot().session.sessionId,first);assert.equal(f.adapter.snapshot().session.lastDisconnectedAt,NOW+1000);
});
test('commissioning, authority and subscriptions fence all mutations',async t=>{
  const f=fixture(t,{verified:false});await f.ready();
  await assert.rejects(f.adapter.rpc('Number.Set',{owner:'service:0',role:'current_limit',value:10},{mutation:true}));
  assert.equal(f.writes.some(row=>row.method.endsWith('.Set')),false);
  const ready=fixture(t);await ready.ready();ready.setAuthority(false);
  await assert.rejects(ready.adapter.rpc('Number.Set',{owner:'service:0',role:'current_limit',value:10},{mutation:true}));
  await assert.rejects(ready.adapter.rpc('Switch.Set',{id:0,on:false},{mutation:true}));
});
test('fuse pause is an EVSE Boolean action and reply/readback is distinct from physical effect',async t=>{
  const f=fixture(t,{limiterEnabled:true});await f.ready();
  let saved;const controller=createShellyController({adapter:f.adapter,clock:()=>NOW,canControl:()=>true,saveState:value=>saved=structuredClone(value)});
  t.after(()=>controller.close());
  await controller.update({enabled:false,allocation:{property:reading([44,30,32]),easee:reading([12,12,12])}});
  const commands=f.writes.filter(row=>row.method.endsWith('.Set'));
  assert.equal(commands.length,1);assert.equal(commands[0].method,'Boolean.Set');assert.equal(commands[0].params.value,false);assert.equal(commands[0].options.retain,false);
  assert.notEqual(controller.status().executionStage,'physical-effect');assert.equal(saved.association,f.adapter.association);
});
test('telemetry fallback limits current without starting a manual stop',async t=>{
  const f=fixture(t,{limiterEnabled:true});f.fields.start_charging=false;f.fields.work_state='paused';await f.ready();
  const controller=createShellyController({adapter:f.adapter,clock:()=>NOW,canControl:()=>true});t.after(()=>controller.close());
  await controller.update({enabled:false,allocation:{}});
  assert.equal(f.writes.some(row=>row.method==='Boolean.Set'&&row.params.value===true),false);
  assert.equal(controller.status().manual.kind,'stop');assert.equal(controller.status().limiter.currentA,12);
});

test('first-seen timestamped DUP boundaries are admitted and repeats cannot create another epoch',async t=>{
 const f=fixture(t);await f.ready();f.setNow(NOW+1000);f.notify('work_state','free',{dup:true,messageId:19});
 assert.equal(f.adapter.snapshot().session.connected,false);
 f.setNow(NOW+2000);f.notify('work_state','connected',{dup:true,messageId:20});const session=f.adapter.snapshot().session.sessionId;
 f.notify('work_state','connected',{dup:true,messageId:20});assert.equal(f.adapter.snapshot().session.sessionId,session);
});
test('an uncertain saved dispatch reconciles without replaying a different physical setting',async t=>{
 const f=fixture(t,{limiterEnabled:true});await f.ready();const sessionId=f.adapter.snapshot().session.sessionId;
 const initialState={version:1,association:f.adapter.association,sessionId,phase:'uncertain',pending:{stage:'dispatched',role:'current_limit',value:9,dispatchedAt:NOW,sessionId}};
 const controller=createShellyController({adapter:f.adapter,initialState,clock:()=>NOW,canControl:()=>true});t.after(()=>controller.close());
 await controller.update({enabled:false,allocation:{}});assert.equal(controller.status().phase,'uncertain');
 assert.equal(f.writes.some(row=>row.method.endsWith('.Set')),false);
});
test('unmapped work states and mismatched RPC role types cannot authorize charging',async t=>{
 const f=fixture(t,{limiterEnabled:true});await f.ready();f.setNow(NOW+1000);f.notify('work_state','unknown-fault');
 assert.equal(f.adapter.normalize().connected.available,false);
 await assert.rejects(f.adapter.rpc('Number.Set',{owner:'service:0',role:'start_charging',value:true},{mutation:true}));
 const controller=createShellyController({adapter:f.adapter,clock:()=>NOW+1000,canControl:()=>true});t.after(()=>controller.close());
 await controller.update({enabled:true,plan:{periods:[{startAt:NOW,endAt:null}]}});assert.equal(controller.status().phase,'unavailable');
 assert.equal(f.writes.some(row=>row.method.endsWith('.Set')),false);
});

test('native restrictions and external auto balance withdraw control without clearing native caps',async t=>{
 const f=fixture(t,{limiterEnabled:true});await f.ready();
 for (const change of [()=>f.serviceStatus.flags=['charge_limit'],()=>{delete f.serviceStatus.flags;f.service.auto_balance.enable=true;}]) {
   change();f.setNow(NOW+1000);await f.adapter.refresh();assert.equal(f.adapter.snapshot().controlReady,false);
   await assert.rejects(f.adapter.rpc('Boolean.Set',{owner:'service:0',role:'start_charging',value:true},{mutation:true}));
 }
 assert.equal(f.writes.some(row=>row.method==='Service.SetConfig'||row.method.endsWith('.Set')),false);
});
test('a lower native current choice is preserved until explicit resume',async t=>{
 const f=fixture(t,{limiterEnabled:true});f.fields.current_limit=8;await f.ready();
 const controller=createShellyController({adapter:f.adapter,clock:()=>NOW,canControl:()=>true});t.after(()=>controller.close());
 await controller.update({enabled:false,allocation:{}});
 assert.equal(controller.status().manualCurrentA,8);assert.equal(controller.status().limiter.currentA,8);
 assert.equal(f.writes.some(row=>row.method.endsWith('.Set')),false);
});
test('a successful current command needs fresh native readback and then observed physical effect',async t=>{
 const f=fixture(t,{limiterEnabled:true});await f.ready();
 const publish=f.client.publish;f.client.publish=(topic,payload,options,cb)=>{
   if(JSON.parse(payload).method==='Number.Set')f.setNow(NOW+1000);
   return publish(topic,payload,options,cb);
 };
 const controller=createShellyController({adapter:f.adapter,clock:f.now,canControl:()=>true});t.after(()=>controller.close());
 await controller.update({enabled:false,allocation:{}});
 assert.equal(controller.status().executionStage,'physical-effect');
 assert.equal(controller.status().pending,null);
 assert.equal(f.writes.filter(row=>row.method==='Number.Set').length,1);
});
test('an enabled native schedule owns start and stop while current limiting stays available',async t=>{
 const f=fixture(t,{limiterEnabled:true});f.fields.current_limit=12;f.schedules.jobs=[{id:1,enable:true}];await f.ready();
 const controller=createShellyController({adapter:f.adapter,clock:f.now,canControl:()=>true});t.after(()=>controller.close());
 await controller.update({enabled:true,plan:{periods:[{startAt:NOW+3600000,endAt:null}]},allocation:{}});
 assert.equal(controller.status().reason,'native-schedule');assert.equal(f.writes.some(row=>row.method==='Boolean.Set'),false);
 f.schedules.jobs=[];await controller.update({enabled:true,plan:{periods:[{startAt:NOW+3600000,endAt:null}]},allocation:{}});
 assert.equal(f.writes.filter(row=>row.method==='Boolean.Set'&&row.params.value===false).length,1);
});
test('failed physical persistence restores DUP admission and retries the exact boundary',async t=>{
 const f=fixture(t);await f.ready();f.setNow(NOW+1000);f.setFail(true);f.notify('work_state','free',{dup:true,messageId:71});
 assert.equal(f.adapter.snapshot().session.connected,true);f.setFail(false);f.notify('work_state','free',{dup:true,messageId:71});
 assert.equal(f.adapter.snapshot().session.connected,false);
});
test('a retained physical state can be confirmed live at the same original source clock',async t=>{
 const f=fixture(t);await f.ready();f.setNow(NOW+1000);f.notify('work_state','paused',{retain:true});
 assert.equal(f.adapter.normalize().connected.available,false);
 f.fields.work_state='paused';await f.adapter.refresh();
 assert.equal(f.adapter.normalize().connected.value,true);assert.equal(f.adapter.normalize().connected.measuredAt,NOW+1000);
});
test('a newer allocation revokes an older queued current intent before publication',async t=>{
 const f=fixture(t,{limiterEnabled:true});await f.ready();let release,proposed;
 const held=new Promise(resolve=>release=resolve),seen=new Promise(resolve=>proposed=resolve);let first=true;
 const controller=createShellyController({adapter:f.adapter,clock:f.now,canControl:()=>true,saveState:async state=>{
  if(first&&state.pending?.stage==='proposed'){first=false;proposed();await held;}
 }});t.after(()=>controller.close());
 const one=controller.update({enabled:false,allocation:{}});await seen;
 const two=controller.update({enabled:false,allocation:{vehicleCurrentA:6}});release();await Promise.all([one,two]);
 assert.deepEqual(f.writes.filter(row=>row.method==='Number.Set').map(row=>row.params.value),[6]);
});
test('absolute command expiry after durable intent persistence prevents an unsent publication',async t=>{
 const f=fixture(t,{limiterEnabled:true});await f.ready();
 const controller=createShellyController({adapter:f.adapter,clock:f.now,canControl:()=>true,saveState:async state=>{
  if(state.pending?.stage==='proposed')f.setNow(NOW+11000);
 }});t.after(()=>controller.close());await controller.update({enabled:false,allocation:{}});
 assert.equal(f.writes.some(row=>row.method.endsWith('.Set')),false);assert.equal(controller.status().pending,null);
});
