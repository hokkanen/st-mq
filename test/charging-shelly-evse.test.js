import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chargingConfiguration } from '../src/charging/config.js';
import { createShellyEvseAdapter, createShellyController } from '../src/charging/shelly-evse.js';
import { shellyCurrentLimit } from '../src/charging/shelly-limit.js';
import { Engine } from '../src/app/engine.js';
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
  const client=new EventEmitter(), values=new Map(), writes=[], energy=[], gaps=[];
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
  const engine={recorder:{recordEnergy:value=>energy.push(value),energyGap:value=>gaps.push(value)}};
  const adapter=createShellyEvseAdapter({config:config(extra),broker:{address:'mqtt://synthetic'},client,store,engine,clock:()=>now,canControl:()=>authority});
  t.after(()=>adapter.close());
  return {adapter,client,fields,writes,energy,gaps,values,service,serviceStatus,schedules,now:()=>now,setNow:value=>now=value,setAuthority:value=>authority=value,setFail:value=>failSave=value,
    async ready(){client.emit('connect');client.emit('message','test/evse/online',Buffer.from('true'),{retain:true});await adapter.refresh();},
    notify(role,value,packet={}){client.emit('message','test/evse/events/rpc',Buffer.from(JSON.stringify({src:'synthetic-evse',method:'NotifyStatus',params:{[`${roleTypes[role]}:${ids[role]}`]:{value,last_update_ts:now/1000}}})),packet);}};
}
test('MQTT diagnostics distinguish subscription health from charger availability and use real routes', async t => {
  const f = fixture(t);
  assert.deepEqual(f.adapter.snapshot().mqtt, { brokerConnected: false, subscribed: false,
    subscriptionStatus: 'disconnected', lastLiveAt: null });
  let subscribed, acknowledge;
  f.client.subscribe = (topics, _options, callback) => { subscribed = topics; acknowledge = callback; };
  f.client.emit('connect');
  assert.equal(f.adapter.snapshot().mqtt.subscriptionStatus, 'pending');
  assert.equal(f.adapter.snapshot().mqtt.brokerConnected, true);
  acknowledge(null, subscribed.map((topic, index) => ({ topic, qos: index === 0 ? 128 : 0 })));
  assert.equal(f.adapter.snapshot().mqtt.subscriptionStatus, 'failed');
  assert.equal(f.adapter.snapshot().mqtt.subscribed, false);
  assert.equal(f.adapter.snapshot().mqtt.lastLiveAt, null);
  assert.equal(f.writes.length, 0);

  f.client.emit('connect');
  acknowledge(null, subscribed.map(topic => ({ topic, qos: 0 })));
  await f.adapter.refresh();
  const snapshot = f.adapter.snapshot();
  assert.equal(snapshot.mqtt.subscriptionStatus, 'subscribed');
  assert.equal(snapshot.mqtt.lastLiveAt, NOW);
  assert.equal(snapshot.online, false, 'RPC reception does not invent charger availability');
  assert.deepEqual(snapshot.topics.filter(row => row.direction === 'subscribe').map(row => row.topic), subscribed);
  assert.deepEqual(snapshot.topics.find(row => row.direction === 'publish'),
    { role: 'RPC requests', topic: 'test/evse/rpc', direction: 'publish' });
  assert.ok(f.writes.every(row => row.topic === snapshot.topics.find(row => row.direction === 'publish').topic));
  snapshot.topics[0].topic = 'modified';
  assert.notEqual(f.adapter.snapshot().topics[0].topic, 'modified');

  const provider = Engine.prototype.providerStatus.call({ config: { input: 'offline' }, store: { getState: () => null },
    charging: { chargers: { charger2: { adapter: f.adapter } }, configuration: { chargers: { charger2: { enabled: true } } } } })['shelly-evse'];
  assert.deepEqual(provider.mqttStatus, snapshot.mqtt);
  assert.deepEqual(provider.topics, f.adapter.snapshot().topics);
});
test('MQTT live receipt time excludes retained, duplicate, unrelated and disconnected packets', async t => {
  const f = fixture(t); await f.ready();
  f.setNow(NOW + 1000);
  f.notify('current_limit', 16, { retain: true });
  f.client.emit('message', 'test/evse/online', Buffer.from('true'), { retain: true });
  f.client.emit('message', 'test/evse/events/rpc', Buffer.from(JSON.stringify({ src: 'another-device', method: 'NotifyStatus', params: {} })), {});
  assert.equal(f.adapter.snapshot().mqtt.lastLiveAt, NOW);
  f.notify('current_limit', 16, { dup: true, messageId: 81 });
  assert.equal(f.adapter.snapshot().mqtt.lastLiveAt, NOW + 1000);
  f.setNow(NOW + 2000);
  f.client.emit('message', 'test/evse/events/rpc', Buffer.from(JSON.stringify({ src: 'synthetic-evse', method: 'NotifyStatus',
    params: { 'number:200': { value: 16, last_update_ts: (NOW + 1000) / 1000 } } })), { dup: true, messageId: 81 });
  assert.equal(f.adapter.snapshot().mqtt.lastLiveAt, NOW + 1000);
  f.client.emit('offline');
  f.notify('current_limit', 16);
  assert.deepEqual(f.adapter.snapshot().mqtt, { brokerConnected: false, subscribed: false,
    subscriptionStatus: 'disconnected', lastLiveAt: NOW + 1000 });
});
test('official-shaped role RPC discovers capabilities and canonical C2 energy never uses a vehicle feed', async t=>{
  const f=fixture(t);await f.ready();assert.equal(f.adapter.snapshot().controlReady,true);
  f.setNow(NOW+1000);f.fields.phase_info.total_act_energy=.002;await f.adapter.refresh();
  assert.equal(f.energy.length,2);assert.equal(f.energy[0].source,'shelly-evse');assert.equal(f.energy[0].prefix,'ev2');assert.equal(f.energy[0].energies[0],.002);
  assert.equal(f.energy[1].prefix,'ev2-phase');
  assert.equal(f.energy[1].energies.reduce((sum,value)=>sum+value,0),.002);
  await f.adapter.refresh();assert.equal(f.energy.length,2);
  f.setNow(NOW+2000);f.fields.phase_info.total_act_energy=0;await f.adapter.refresh();assert.equal(f.energy.length,2);
  assert.equal(f.adapter.snapshot().error,'evse-counter-reset');
});
test('native Shelly phases expose current, voltage and active power in installed L1–L3 order', async t => {
  const f = fixture(t, { phaseMap: [2, 0, 1], verified: false });
  Object.assign(f.fields.phase_info, { total_power: 6000, total_act_energy: 42.5,
    phase_a: { current: 10, voltage: 231, power: 2200 },
    phase_b: { current: 8, voltage: 228, power: 1700 },
    phase_c: { current: 9, voltage: 233, power: 2100 } });
  f.fields.energy_charge = 3.75;
  await f.ready();
  const readings = f.adapter.readings();
  assert.deepEqual([1, 2, 3].map(n => readings[`ev2_current_l${n}`].value), [9, 10, 8]);
  assert.deepEqual([1, 2, 3].map(n => readings[`ev2_voltage_l${n}`].value), [233, 231, 228]);
  assert.deepEqual([1, 2, 3].map(n => readings[`ev2_active_power_l${n}`].value), [2.1, 2.2, 1.7]);
  assert.equal(readings.ev2_active_power.value, 6);
  assert.equal(readings.ev2_import_energy_counter.value, 42.5);
  assert.equal(readings.ev2_session_energy.value, 3.75);
  assert.deepEqual(readings.ev2_active_power_l1, { value: 2.1, unit: 'kW', source: 'shelly-evse',
    sourceTime: NOW, receivedAt: NOW, available: true, quality: [], acquisitionOnly: true });
  assert.ok(Object.values(readings).every(row => row.available), 'Read-only measurements do not require permission to control');
  assert.equal(f.adapter.snapshot().controlReady, false);
  const provider = Engine.prototype.providerStatus.call({ config: { input: 'offline' }, store: { getState: () => null },
    charging: { chargers: { charger2: { adapter: f.adapter } }, configuration: { chargers: { charger2: { enabled: true } } } } })['shelly-evse'];
  assert.deepEqual(provider.readings, readings);
  assert.equal(provider.maxAgeMs, 15000);
  assert.equal(f.energy.length, 0, 'A live phase snapshot does not create another history channel');
  readings.ev2_current_l1.value = 999;
  assert.equal(f.adapter.readings().ev2_current_l1.value, 9, 'Public values cannot mutate the native snapshot');
});

test('C2 phase energy follows measured changing phase shares in installation order and conserves its native total', async t => {
  const f = fixture(t, { phaseMap: [2, 0, 1] }); await f.ready();
  f.setNow(NOW + 1000);
  Object.assign(f.fields.phase_info, { total_power: 6000, total_act_energy: .002,
    phase_a: { voltage: 230, current: 4, power: 1000 }, phase_b: { voltage: 230, current: 9, power: 2000 },
    phase_c: { voltage: 230, current: 13, power: 3000 } });
  await f.adapter.refresh();
  const [total, phases] = f.energy;
  assert.equal(total.prefix, 'ev2'); assert.equal(phases.prefix, 'ev2-phase');
  assert.deepEqual(phases.powers, [3, 1, 2]);
  const weights = [2760 + 3000, 2760 + 1000, 2760 + 2000];
  phases.energies.forEach((value, index) => assert(Math.abs(value - .002 * weights[index] / weights.reduce((a,b)=>a+b,0)) < 1e-12));
  assert.equal(phases.energies.reduce((a,b)=>a+b,0), total.energies[0]);
  assert(phases.quality.includes('phase_allocation_estimated'));
});

test('a positive C2 meter increment with no phase-power evidence preserves total and records a phase gap', async t => {
  const f = fixture(t); await f.ready();
  for (const name of ['phase_a','phase_b','phase_c']) f.fields.phase_info[name].power = 0;
  f.fields.phase_info.total_power = 0;
  f.setNow(NOW + 1000); await f.adapter.refresh();
  f.energy.length = 0;
  f.setNow(NOW + 2000); f.fields.phase_info.total_act_energy = .001; await f.adapter.refresh();
  assert.equal(f.energy.length, 1);
  assert.deepEqual(f.energy[0].energies, [.001]);
  assert.equal(f.gaps.at(-1).prefix, 'ev2-phase');
  assert.deepEqual(f.gaps.at(-1).quality, ['unknown-phase-share']);
});
test('public Shelly phase readings preserve source age and withdraw availability on retained, stale or offline evidence', async t => {
  const f = fixture(t);
  assert.equal(f.adapter.readings().ev2_current_l1.value, null);
  assert.deepEqual(f.adapter.readings().ev2_current_l1.quality, ['missing', 'mqtt-disconnected']);
  await f.ready();
  f.setNow(NOW + 1000);
  f.notify('phase_info', f.fields.phase_info, { retain: true });
  assert.deepEqual(f.adapter.readings().ev2_current_l1.quality, ['retained']);
  assert.equal(f.adapter.readings().ev2_current_l1.available, false);
  await f.adapter.refresh();
  assert.equal(f.adapter.readings().ev2_current_l1.available, true);
  assert.equal(f.adapter.readings().ev2_current_l1.sourceTime, NOW + 1000);
  f.setNow(NOW + 16001);
  for (const reading of Object.values(f.adapter.readings())) {
    assert.equal(reading.available, false);
    assert.deepEqual(reading.quality, ['stale']);
    assert.equal(reading.sourceTime, NOW + 1000);
  }
  assert.equal(f.adapter.readings().ev2_active_power.value, 8.28, 'Keep stale values for diagnosis');
  assert.equal(f.adapter.readings(NOW).ev2_active_power.quality[0], 'future_source_time');
  f.setNow(NOW + 2000);
  f.client.emit('offline');
  assert.deepEqual(f.adapter.readings().ev2_active_power.quality, ['mqtt-disconnected']);
  assert.equal(f.adapter.readings().ev2_active_power.available, false);
});
test('invalid or future Shelly phase packets cannot replace supported electrical readings', async t => {
  const f = fixture(t); await f.ready();
  f.setNow(NOW + 1000);
  const incomplete = structuredClone(f.fields.phase_info); delete incomplete.phase_b.current;
  assert.throws(() => f.adapter.accept('phase_info', { value: incomplete, last_update_ts: f.now() / 1000 }), /invalid-evse-electrical-units/);
  assert.equal(f.adapter.accept('phase_info', { value: f.fields.phase_info, last_update_ts: (f.now() + 1000) / 1000 }), false);
  assert.equal(f.adapter.readings().ev2_current_l2.sourceTime, NOW);
  assert.equal(f.adapter.readings().ev2_current_l2.value, 12);
  f.fields.phase_info.phase_a = { current: 0, voltage: 0, power: 0 };
  f.fields.phase_info.phase_b = { current: 0, voltage: 0, power: 0 };
  f.fields.phase_info.phase_c = { current: 0, voltage: 0, power: 0 };
  f.fields.phase_info.total_power = 0;
  await f.adapter.refresh();
  assert.ok(Object.values(f.adapter.readings()).every(row => row.available));
  assert.equal(f.adapter.readings().ev2_active_power_l3.value, 0, 'Reported idle zero is a valid measurement');
  assert.equal(f.energy.length, 2);
  assert.equal(f.energy[0].energies.length, 1, 'Native total energy remains a single physical contribution');
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

test('Charge Now releases a Shelly economic pause for this session and Use automatic restores the price plan', async t => {
  const f = fixture(t); await f.ready();
  const publish = f.client.publish;
  f.client.publish = (topic, payload, options, callback) => {
    if (JSON.parse(payload).method.endsWith('.Set')) f.setNow(f.now() + 1000);
    return publish(topic, payload, options, callback);
  };
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true }); t.after(() => controller.close());
  const future = { periods: [{ startAt: NOW + 3600000, endAt: null }] };
  await controller.update({ enabled: true, plan: future, allocation: {} });
  assert.equal(f.fields.start_charging, false); assert.equal(controller.status().ownedPause, true);
  const connectedAt = f.adapter.snapshot().session.connectedAt;
  f.setNow(NOW + f.adapter.config.dwellMs + 1000);
  await controller.update({ enabled: true, plan: future, chargeNow: { connectedAt }, allocation: {} });
  assert.equal(f.fields.start_charging, true); assert.equal(controller.status().ownedPause, false);
  assert.equal(controller.status().reason, 'charge-now');
  assert.equal(f.writes.filter(row => row.method === 'Boolean.Set' && row.params.value === true).length, 1);
  await controller.update({ enabled: true, plan: future, chargeNow: null, resume: true, allocation: {} });
  assert.equal(f.fields.start_charging, false); assert.equal(controller.status().reason, 'economic-wait');
});

test('Shelly Charge Now preserves a native stop, native schedule and vehicle start boundary', async t => {
  for (const mode of ['stop', 'schedule', 'vehicle-start']) {
    const f = fixture(t); f.fields.current_limit = 12;
    if (mode === 'stop') { f.fields.start_charging = false; f.fields.work_state = 'paused'; }
    if (mode === 'schedule') f.schedules.jobs = [{ id: 1, enable: true }];
    await f.ready();
    const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true }); t.after(() => controller.close());
    await controller.update({ enabled: true, chargeNow: { connectedAt: f.adapter.snapshot().session.connectedAt },
      allocation: mode === 'vehicle-start' ? { notBefore: NOW + 3600000 } : {} });
    assert.equal(controller.status().reason, mode === 'stop' ? 'manual-stop' : mode === 'schedule' ? 'native-schedule' : 'vehicle-not-before');
    assert.equal(f.writes.some(row => row.method === 'Boolean.Set'), false, `${mode} cannot be overridden by Charge Now`);
    assert.equal(f.writes.some(row => row.method === 'Service.SetConfig'), false);
  }
});

test('Shelly Charge Now still pauses for the property fuse limit and rejects a previous connection’s override', async t => {
  const f = fixture(t, { limiterEnabled: true }); await f.ready();
  const publish = f.client.publish;
  f.client.publish = (topic, payload, options, callback) => {
    if (JSON.parse(payload).method.endsWith('.Set')) f.setNow(f.now() + 1000);
    return publish(topic, payload, options, callback);
  };
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true }); t.after(() => controller.close());
  const connectedAt = f.adapter.snapshot().session.connectedAt;
  await controller.update({ enabled: true, chargeNow: { connectedAt }, allocation: { property: reading([44, 30, 32]), easee: reading([12, 12, 12]) } });
  assert.equal(controller.status().limiter.currentA, 0); assert.equal(f.fields.start_charging, false);
  f.setNow(f.now() + 1000); f.notify('work_state', 'free');
  f.setNow(f.now() + f.adapter.config.dwellMs + 1000); f.notify('work_state', 'connected');
  f.fields.work_state = 'connected'; f.fields.start_charging = true;
  assert.notEqual(f.adapter.snapshot().session.connectedAt, connectedAt);
  await controller.update({ enabled: true, chargeNow: { connectedAt }, plan: { periods: [{ startAt: f.now() + 3600000, endAt: null }] }, allocation: {} });
  assert.equal(controller.status().reason, 'economic-wait'); assert.equal(f.fields.start_charging, false);
});
