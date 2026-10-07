import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chargingConfiguration } from '../src/charging/config.js';
import { createShellyEvseAdapter, createShellyController, shellyAssociation } from '../src/charging/shelly-evse.js';
import { shellyProfile } from '../src/charging/shelly-profile.js';
import { shellyCurrentLimit } from '../src/charging/shelly-limit.js';
import { matchTeslaSession } from '../src/charging/vehicle.js';
import { Engine } from '../src/app/engine.js';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
const NOW = 1800000000000;
const config = extra => shellyProfile(chargingConfiguration({chargers:{charger2:{enabled:true, deviceId:'synthetic-evse',topicPrefix:'test/evse',
  limiterEnabled:false,marginA:[0,0,0],...extra}}}).chargers.charger2);
const reading = (currents, at = NOW) => ({currents,times:[at,at,at],healthy:true,
  evidence:{connected:true,online:true,synchronized:true,epoch:'fixture-epoch'}});
test('phase limiter preserves absolute Shelly capacity, reservation and minimum-current boundary', () => {
  const args={config:config(),now:NOW,property:reading([34,30,32]),easee:reading([12,12,12]),shelly:reading([12,12,12])};
  assert.equal(shellyCurrentLimit(args).currentA,15);
  assert.equal(shellyCurrentLimit({...args,reservationA:8}).currentA,7);
  assert.equal(shellyCurrentLimit({...args,property:reading([44,30,32])}).currentA,0);
  assert.equal(shellyCurrentLimit({...args,property:reading([43,30,32])}).currentA,6);
  assert.equal(shellyCurrentLimit({...args,config:config({marginA:[1,1,1]})}).currentA,14);
  assert.equal(shellyCurrentLimit({...args,property:reading([40,36,38]),easee:reading([18,18,18])}).currentA,15);
});
test('unsynchronized feeds, nonadditive residual and telemetry loss use accepted fallback with tighter known bounds', () => {
  const args={config:config(),now:NOW,property:reading([34,30,32]),easee:reading([12,12,12]),shelly:reading([12,12,12])};
  for(const property of [null,{...reading([34,30,32]),evidence:{connected:true,online:true,synchronized:false,epoch:'fixture-epoch'}},reading([1,1,1])]) {
    const result=shellyCurrentLimit({...args,property});assert.equal(result.currentA,12);assert.equal(result.reason,'telemetry-fallback');assert.equal(result.guaranteedProtection,false);
  }
  assert.equal(shellyCurrentLimit({...args,property:null,vehicleCurrentA:7}).currentA,7);
  assert.equal(shellyCurrentLimit({...args,property:null,allocationA:0}).currentA,0);
});
test('positive vehicle demand below the pilot minimum preserves electrical and zero-current stops', () => {
  const args = { config: config(), now: NOW, property: reading([34, 30, 32]),
    easee: reading([12, 12, 12]), shelly: reading([12, 12, 12]) };
  for (const vehicleCurrentA of [1, 5, 5.5]) {
    assert.equal(shellyCurrentLimit({ ...args, vehicleCurrentA }).currentA, 6,
      'The smallest valid pilot can supply a car that independently draws less');
    assert.equal(shellyCurrentLimit({ ...args, vehicleCurrentA, property: null }).currentA, 6);
    for (const tighter of [{ nativeCurrentA: 5 }, { allocationA: 5 }, { property: reading([44, 30, 32]) }]) {
      const limited = shellyCurrentLimit({ ...args, vehicleCurrentA, ...tighter });
      assert.equal(limited.currentA, 0); assert.equal(limited.pause, true,
        'A native, allocated or physical electrical ceiling below the pilot minimum still stops charging');
    }
  }
  assert.equal(shellyCurrentLimit({ ...args, vehicleCurrentA: 0 }).currentA, 0,
    'A known zero vehicle restriction is not rounded up');
  assert.equal(shellyCurrentLimit({ ...args, vehicleCurrentA: 8 }).currentA, 8);
});
function fixture(t, extra={}) {
  let now=NOW, authority=true, failSave=false;
  const deviceInfo = { id: 'synthetic-evse', model: 'synthetic-model', fw_id: 'synthetic-firmware' };
  const service={id:0,auto_balance:{enable:false},auto_charge:true,global_charge_limit:0,global_time_limit:0},serviceStatus={state:'running'},schedules={rev:1,jobs:[]};
  const client=new EventEmitter(), values=new Map(), writes=[], energy=[], gaps=[], voltages=[], events=[];
  const roleTypes={current_limit:'number',start_charging:'boolean',work_state:'enum',phase_info:'object'};
  const roles=Object.keys(roleTypes), ids=Object.fromEntries(roles.map((role,i)=>[role,i+200]));
  const currentComponent={id:ids.current_limit,owner:'service:0',access:'crw',min:6,max:16,meta:{ui:{step:1}}};
  const settingClock = new Map(), sources = new Map();
  const fields={current_limit:16,start_charging:true,work_state:'charger_charging',phase_info:{total_power:8.28,total_act_energy:0,phase_a:{voltage:230,current:12,power:2.76},phase_b:{voltage:230,current:12,power:2.76},phase_c:{voltage:230,current:12,power:2.76}}};
  client.subscribe=(topics,_opts,cb)=>{client.topics=topics;cb(null,topics.map(topic=>({topic,qos:0})));};
  client.publish=(topic,payload,options,cb)=>{
    const frame=JSON.parse(payload);writes.push({...frame,topic,options});let result;
    if(frame.method==='Shelly.GetDeviceInfo')result=structuredClone(deviceInfo);
    else if(frame.method==='Service.GetConfig')result=structuredClone(service);
    else if(frame.method==='Schedule.List')result=structuredClone(schedules);
    else if(frame.method==='Schedule.Update') {
      const job=schedules.jobs.find(job=>job.id===frame.params.id);
      assert.ok(job);assert.deepEqual(frame.params,{id:job.id,enable:false});job.enable=false;result={rev:++schedules.rev};
    }
    else if(frame.method==='Service.GetStatus')result=structuredClone(serviceStatus);
    else if(frame.method.endsWith('.GetConfig'))result=frame.params.role==='current_limit'?structuredClone(currentComponent):{id:ids[frame.params.role],owner:'service:0',access:'crw',min:6,max:16,meta:{ui:{step:1}},options:['charger_free','charger_wait','charger_pause','charger_charging','charger_end']};
    else if(frame.method.endsWith('.Set')) {fields[frame.params.role]=frame.params.value;settingClock.set(frame.params.role,{value:frame.params.value,at:now});result=null;}
    else {
      const role=frame.params.role, value=fields[role];
      if (['start_charging','current_limit'].includes(role)) {
        if (settingClock.get(role)?.value !== value) settingClock.set(role,{value,at:now});
        result={value,last_update_ts:settingClock.get(role).at/1000,...(sources.has(role)?{source:sources.get(role)}:{})};
      } else result={value:structuredClone(value),last_update_ts:(settingClock.get(role)?.at??now)/1000};
    }
    cb?.();queueMicrotask(()=>client.emit('message',`${frame.src}/rpc`,Buffer.from(JSON.stringify({id:frame.id,src:'synthetic-evse',dst:frame.src,result})),{}));
  };
  const store={getState:key=>structuredClone(values.get(key)),setState:(key,value)=>{if(failSave)throw Error('disk');values.set(key,structuredClone(value));},transaction:fn=>fn(),
    event:(type,payload,at)=>events.push({type,payload,at})};
  const engine={recorder:{recordEnergy:value=>energy.push(value),energyGap:value=>gaps.push(value)},voltage:{ingest:value=>voltages.push(value)}};
  const createAdapter=()=>createShellyEvseAdapter({config:config(extra),broker:{address:'mqtt://synthetic'},client,store,engine,clock:()=>now,canControl:()=>authority});
  let adapter=createAdapter();
  t.after(()=>adapter.close());
  return {get adapter(){return adapter;},client,fields,writes,energy,gaps,voltages,events,values,service,serviceStatus,schedules,sources,currentComponent,deviceInfo,now:()=>now,setNow:value=>now=value,setAuthority:value=>authority=value,setFail:value=>failSave=value,
    restartAdapter() { adapter.close(); adapter=createAdapter(); },
    setSourceTime(role, at) { settingClock.set(role, { value: fields[role], at }); },
    delta(role, delta, { eventAt = now, retained = false, apply = true, method = 'NotifyStatus' } = {}) {
      if (apply) {
        if (Object.hasOwn(delta, 'value')) {
          fields[role] = structuredClone(delta.value);
          settingClock.set(role, { value: delta.value, at: Math.floor(eventAt / 1000) * 1000 });
        }
        if (Object.hasOwn(delta, 'source')) sources.set(role, delta.source);
      }
      client.emit('message', 'test/evse/events/rpc', Buffer.from(JSON.stringify({ src: 'synthetic-evse', method,
        params: { ts: eventAt / 1000, [`${roleTypes[role]}:${ids[role]}`]: delta } })), { retain: retained });
    },
    async ready(){client.emit('connect');client.emit('message','test/evse/online',Buffer.from('true'),{retain:true});await adapter.refresh();},
    notify(role,value,packet={}){if (['start_charging','current_limit'].includes(role) && !packet.retain) settingClock.set(role,{value,at:now});client.emit('message','test/evse/events/rpc',Buffer.from(JSON.stringify({src:'synthetic-evse',method:'NotifyStatus',params:{[`${roleTypes[role]}:${ids[role]}`]:{value,last_update_ts:now/1000}}})),packet);}};
}
test('unplugged capacity keeps updating without current or charging commands', async t => {
  const f = fixture(t, { limiterEnabled: true });
  f.fields.work_state = 'charger_free'; f.fields.start_charging = false; f.fields.current_limit = 6;
  for (const phase of ['phase_a', 'phase_b', 'phase_c']) f.fields.phase_info[phase].current = 0;
  f.fields.phase_info.total_power = 0;
  await f.ready();
  let household = 12, healthy = true, saved;
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
    getAllocation: () => ({ property: { ...reading([household, household, household], f.now()), healthy },
      easee: reading([0, 0, 0], NOW), vehicleCurrentA: 0, nativeCurrentA: 6 }),
    saveState: value => { saved = structuredClone(value); } });
  t.after(() => controller.close());
  for (const [load, expected] of [[12, 13], [19, 6], [20, 0], [9, 16]]) {
    household = load; f.setNow(f.now() + 5000);
    const view = await controller.update({ enabled: true, chargeNow: true });
    assert.equal(view.limiter.loadCurrentA, expected);
    assert.equal(view.limiter.currentA, expected, 'Departed vehicle and native session choices are not carried over');
    assert.equal(view.limiter.fallback, false);
    assert.equal(view.limiter.evaluatedAt, f.now());
    assert.equal(view.phase, 'off'); assert.equal(view.reason, 'disconnected');
  }
  healthy = false; f.setNow(f.now() + 5000);
  assert.equal((await controller.update({ enabled: false })).limiter.fallback, true);
  assert.equal(saved.limiter.currentA, 12);
  assert.equal(f.fields.current_limit, 6); assert.equal(f.fields.start_charging, false);
  assert.equal(f.writes.filter(row => row.method.endsWith('.Set') || row.method === 'Schedule.Update').length, 0);
});

test('unplugged disabled limiter publishes no capacity or device instruction', async t => {
  const f = fixture(t, { limiterEnabled: false }); f.fields.work_state = 'charger_free'; await f.ready();
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
    getAllocation: () => { throw Error('Disabled current adjustment does not assess capacity'); } });
  t.after(() => controller.close());
  assert.equal((await controller.update({ enabled: true })).limiter, null);
  assert.equal(f.writes.filter(row => row.method.endsWith('.Set') || row.method === 'Schedule.Update').length, 0);
});

test('charger product metadata is scoped, read-only and keeps its discovery receipt', async t => {
  const f = fixture(t);
  Object.assign(f.deviceInfo, { ver: '2.0.1', mac: '00:00:00:00:00:00', key: 'synthetic-cloud-key' });
  assert.equal(f.adapter.deviceInfo(), null);
  await f.ready();
  const expected = { model: 'synthetic-model', firmware: '2.0.1', source: 'shelly-device-info', receivedAt: NOW, available: true };
  assert.deepEqual(f.adapter.deviceInfo(), expected);
  const reads = f.writes.filter(row => row.method === 'Shelly.GetDeviceInfo').length;
  f.setNow(NOW + 5000); await f.adapter.refresh();
  assert.deepEqual(f.adapter.deviceInfo(), expected);
  assert.equal(f.writes.filter(row => row.method === 'Shelly.GetDeviceInfo').length, reads);
  assert.equal(f.writes.filter(row => row.method.endsWith('.Set')).length, 0);
  f.client.emit('close');
  assert.deepEqual(f.adapter.deviceInfo(), { ...expected, available: false });
  Object.assign(f.deviceInfo, { model: '<script>invalid</script>', ver: 'x'.repeat(129) });
  await f.ready();
  assert.equal(f.adapter.deviceInfo(), null, 'Malformed metadata is unavailable without disabling supported control');
  assert.equal(f.adapter.snapshot().controlReady, true);
  f.restartAdapter();
  assert.equal(f.adapter.deviceInfo(), null, 'Persisted sessions do not supply discovery metadata');
});

test('missing startup planning evidence preserves an adopted Shelly program through its original transitions', async t => {
  const f = fixture(t, { limiterEnabled: false }); await f.ready();
  advanceCommandClock(f);
  let saved = null, controller;
  const attach = () => createShellyController({ adapter: f.adapter, initialState: saved,
    clock: f.now, canControl: () => true, saveState: value => { saved = structuredClone(value); } });
  controller = attach(); t.after(() => controller.close());
  const original = { id: 'adopted-shelly-program', startAt: NOW + 30 * 60_000, deadlineAt: NOW + 120 * 60_000,
    periods: [{ startAt: NOW + 30 * 60_000, endAt: NOW + 60 * 60_000 },
      { startAt: NOW + 90 * 60_000, endAt: null }], feasible: true };
  await controller.update({ enabled: true, plan: original });
  assert.equal(f.fields.start_charging, false);
  assert.equal(saved.execution.planId, original.id);
  await controller.close(); controller = attach();
  f.setNow(NOW + 60_000);
  const missing = { id: 'missing-inputs', startAt: f.now(), deadlineAt: original.deadlineAt,
    periods: [{ startAt: f.now(), endAt: null }], reason: 'electrical-telemetry-unavailable', feasible: false, provisional: true };
  const writesBefore = f.writes.filter(row => row.method === 'Boolean.Set').length;
  await controller.update({ enabled: true, plan: missing });
  assert.equal(f.fields.start_charging, false);
  assert.equal(saved.execution.planId, original.id);
  assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, writesBefore);
  f.setNow(NOW + 30 * 60_000);
  assert.equal((await controller.update({ enabled: true, plan: missing })).phase, 'active');
  assert.equal(f.fields.start_charging, true);
  f.setNow(NOW + 60 * 60_000);
  assert.equal((await controller.update({ enabled: true, plan: missing })).phase, 'waiting');
  assert.equal(f.fields.start_charging, false);
  f.setNow(NOW + 90 * 60_000);
  const released = await controller.update({ enabled: true, plan: missing });
  assert.equal(released.phase, 'released');
  assert.equal(released.provisional, false);
  assert.equal(f.fields.start_charging, true);
});

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
  assert.deepEqual([...new Set(f.writes.flatMap(row => row.params.role ? [row.params.role] : []))].sort(),
    ['current_limit', 'phase_info', 'start_charging', 'work_state']);
  assert.equal(Object.hasOwn(f.adapter.snapshot(), 'sessionReference'), false);
  f.setNow(NOW+1000);f.fields.phase_info.total_act_energy=.002;await f.adapter.refresh();
  assert.equal(f.energy.length,1);assert.equal(f.energy[0].source,'shelly-evse');assert.equal(f.energy[0].prefix,'ev2');
  assert.equal(f.energy[0].energies.length,3);
  assert.equal(f.energy[0].energies.reduce((sum,value)=>sum+value,0),.002);
  await f.adapter.refresh();assert.equal(f.energy.length,1);
  f.setNow(NOW+2000);f.fields.phase_info.total_act_energy=0;await f.adapter.refresh();assert.equal(f.energy.length,1);
  assert.equal(f.adapter.snapshot().meterError,'evse-counter-reset');
  assert.equal(f.adapter.snapshot().error,null,'Meter quality must not mask control readiness');
  assert.equal(f.gaps.length,1);assert.equal(f.gaps[0].prefix,'ev2');
  assert.deepEqual(f.gaps[0].quality,['meter-counter-reset']);
  f.setNow(NOW+3000);f.fields.phase_info.total_act_energy=.002;await f.adapter.refresh();
  assert.equal(f.adapter.snapshot().meterError,null,'The next accepted meter increment clears the transient warning');
});

test('native kW power agrees with phase current and supplies independent Tesla matching evidence', async t => {
  const f = fixture(t);
  Object.assign(f.fields.phase_info, { total_power: 4.138,
    phase_a: { current: 6.1, voltage: 230, power: 1.402 },
    phase_b: { current: 6.0, voltage: 230, power: 1.379 },
    phase_c: { current: 5.9, voltage: 230, power: 1.357 } });
  await f.ready();
  const physical = f.adapter.normalize(null);
  assert.equal(physical.powerKw.value, 4.138);
  assert.equal(f.adapter.snapshot().powerKw, 4.138);
  assert.equal(physical.actualCurrentA.value, 6.1);
  assert.equal(f.adapter.readings().ev2_active_power.value, 4.138);
  assert.equal(matchTeslaSession({ association: 'synthetic-tesla', healthy: true,
    pluggedIn: true, charging: true, atHome: true, actualPowerKw: 4,
    fields: { charger_power: { value: 4, receivedAt: NOW, retained: false },
      plugged_in: { value: true, receivedAt: NOW, retained: false } } },
  { physical, connectedAt: NOW, chargingAt: [NOW], now: NOW }), true);
  assert.throws(() => f.adapter.accept('phase_info', { last_update_ts: (NOW + 1000) / 1000,
    value: { ...f.fields.phase_info, total_power: 4138 } }, NOW + 1000),
  /invalid-evse-electrical-range/, 'The EVSE profile never guesses an alternative watt unit');
});
test('retired Shelly session state and unused cached native counters reject before mutation', () => {
  const configuration = config(), broker = { address: 'mqtt://synthetic' };
  const association = shellyAssociation(configuration, broker);
  const current = { version: 2, association, fields: {}, connection: null, counter: null, sessionSequence: 0 };
  for (const obsolete of [{ version: 1 }, { sessionCheck: null }, { sessionCheck: { version: 1 } }, { checkSession: null },
    { counter: { powerW: 0 } }, { fields: { energy_charge: { value: 0 } } },
    { fields: { time_charge: { value: 0 } } }]) {
    let writes = 0;
    assert.throws(() => createShellyEvseAdapter({ config: configuration, broker, client: new EventEmitter(),
      store: { getState: () => ({ ...current, ...obsolete }), setState: () => { writes++; } }, engine: {} }),
    /unsupported-shelly-state/);
    assert.equal(writes, 0);
  }
});
test('native Shelly phases expose current, voltage and active power in installed L1–L3 order', async t => {
  const f = fixture(t, { phaseMap: [2, 0, 1] });
  f.serviceStatus.errors = ['synthetic-native-fault'];
  Object.assign(f.fields.phase_info, { total_power: 6.0, total_act_energy: 42.5,
    phase_a: { current: 10, voltage: 231, power: 2.2 },
    phase_b: { current: 8, voltage: 228, power: 1.7 },
    phase_c: { current: 9, voltage: 233, power: 2.1 } });
  await f.ready();
  const readings = f.adapter.readings();
  assert.deepEqual([1, 2, 3].map(n => readings[`ev2_current_l${n}`].value), [9, 10, 8]);
  assert.deepEqual([1, 2, 3].map(n => readings[`ev2_voltage_l${n}`].value), [233, 231, 228]);
  assert.equal(f.voltages.length, 0, 'Shelly voltage remains local electrical evidence and never feeds the shared estimate');
  assert.deepEqual(f.adapter.normalize(null).phaseVoltageV.value, [233, 231, 228]);
  await f.adapter.refresh();
  assert.equal(f.voltages.length, 0);
  assert.deepEqual([1, 2, 3].map(n => readings[`ev2_active_power_l${n}`].value), [2.1, 2.2, 1.7]);
  assert.equal(readings.ev2_active_power.value, 6);
  assert.equal(readings.ev2_import_energy_counter.value, 42.5);
  assert.equal(Object.keys(readings).length, 11);
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
  Object.assign(f.fields.phase_info, { total_power: 6.0, total_act_energy: .002,
    phase_a: { voltage: 230, current: 4, power: 1.0 }, phase_b: { voltage: 230, current: 9, power: 2.0 },
    phase_c: { voltage: 230, current: 13, power: 3.0 } });
  await f.adapter.refresh();
  assert.equal(f.energy.length, 1);
  const [phases] = f.energy;
  assert.equal(phases.prefix, 'ev2');
  assert.deepEqual(phases.powers, [3, 1, 2]);
  const weights = [2760 + 3000, 2760 + 1000, 2760 + 2000];
  phases.energies.forEach((value, index) => assert(Math.abs(value - .002 * weights[index] / weights.reduce((a,b)=>a+b,0)) < 1e-12));
  assert.equal(phases.energies.reduce((a,b)=>a+b,0), .002);
  assert(phases.quality.includes('phase_allocation_estimated'));
  assert(phases.quality.includes('native_counter'));
});

test('C2 single-phase and skewed allocations remain nonnegative and conserve the native delta within machine precision', async t => {
  for (const [delta, shares] of [[.000565, [14, 0, 0]], [.000565, [0, 14, 0]], [.000565, [0, 0, 14]],
    [.000224, [6, 2, 16]], [.000333, [1e-12, 30, 1]], [.000999, [30, 1, 1e-12]]]) {
    const f = fixture(t);
    ['phase_a', 'phase_b', 'phase_c'].forEach((name, index) => f.fields.phase_info[name].power = shares[index] / 10);
    f.fields.phase_info.total_power = shares.reduce((sum, value) => sum + value, 0) / 10;
    await f.ready();
    f.setNow(NOW + 1000); f.fields.phase_info.total_act_energy = delta; await f.adapter.refresh();
    assert.equal(f.energy.length, 1);
    const { energies } = f.energy[0];
    assert(energies.every(value => Number.isFinite(value) && value >= 0));
    assert(Math.abs(energies.reduce((sum, value) => sum + value, 0) - delta) <= delta * Number.EPSILON * 2);
    if (shares.filter(value => value > 0).length === 1)
      assert.deepEqual(energies, shares.map(value => value > 0 ? delta : 0));
    assert.equal(f.gaps.length, 0);
  }
});

test('a positive C2 meter increment with no phase-power evidence remains exceptional evidence and records a phase gap', async t => {
  const f = fixture(t); await f.ready();
  for (const name of ['phase_a','phase_b','phase_c']) f.fields.phase_info[name].power = 0;
  f.fields.phase_info.total_power = 0;
  f.setNow(NOW + 1000); await f.adapter.refresh();
  f.energy.length = 0;
  f.setNow(NOW + 2000); f.fields.phase_info.total_act_energy = .001; await f.adapter.refresh();
  assert.equal(f.energy.length, 0);
  assert.equal(f.gaps.at(-1).prefix, 'ev2');
  assert.deepEqual(f.gaps.at(-1).quality, ['unknown-phase-share']);
  assert.deepEqual(f.events, [{ type: 'charging-energy-unallocated', at: NOW + 2000,
    payload: { source: 'shelly-evse', device: f.adapter.association, start: NOW + 1000, end: NOW + 2000,
      referenceKwh: .001, reason: 'unknown-phase-share' } }]);
  await f.adapter.refresh();
  assert.equal(f.events.length, 1, 'Repeated source evidence cannot duplicate the exceptional increment');
  f.setNow(NOW + 3000); f.notify('work_state', 'charger_free');
  assert.equal(f.events.length, 1, 'Disconnecting does not create a redundant native-meter comparison');
  f.setNow(NOW + 34000); f.notify('current_limit', 16);
  assert.equal(f.events.length, 1, 'Only the unallocated energy diagnostic is recorded');
});

test('a valid zero C2 meter delta requires no positive phase-power weights', async t => {
  const f = fixture(t);
  for (const name of ['phase_a','phase_b','phase_c']) f.fields.phase_info[name].power = 0;
  f.fields.phase_info.total_power = 0;
  await f.ready();
  f.setNow(NOW + 1000); await f.adapter.refresh();
  assert.equal(f.energy.length, 1);
  assert.equal(f.energy[0].prefix, 'ev2');
  assert.deepEqual(f.energy[0].energies, [0, 0, 0]);
  assert.deepEqual(f.energy[0].powers, [0, 0, 0]);
  assert.equal(f.gaps.length, 0);
  assert.equal(f.events.length, 0);
});

test('C2 phase records and unallocated diagnostics commit with their source cursor and survive adapter restart', t => {
  const store = new Store(':memory:');
  const engine = { recorder: new Recorder(store) };
  const create = () => createShellyEvseAdapter({ config: config(), broker: { address: 'mqtt://synthetic' },
    client: new EventEmitter(), store, engine, clock: () => NOW + 5000 });
  let adapter = create();
  t.after(() => { adapter.close(); store.close(); });
  const sample = (at, total, powers) => ({ last_update_ts: at / 1000, value: {
    total_act_energy: total, total_power: powers.reduce((sum, power) => sum + power, 0),
    ...Object.fromEntries(['phase_a', 'phase_b', 'phase_c'].map((name, index) => [name,
      { voltage: 230, current: powers[index] * 1000 / 230, power: powers[index] }])) } });
  adapter.accept('phase_info', sample(NOW, 0, [0, 0, 0]), NOW);
  adapter.accept('work_state', { value: 'charger_charging', last_update_ts: NOW / 1000 }, NOW);
  const key = `charging:shelly:${adapter.association}`;
  const sourceBefore = store.getState(key), setState = store.setState;
  const unallocated = sample(NOW + 1000, .001, [0, 0, 0]);
  const failCursorSave = (name, value) => {
    if (name === key) throw new Error('Synthetic cursor persistence failure');
    return setState.call(store, name, value);
  };
  store.setState = failCursorSave;
  assert.throws(() => adapter.accept('phase_info', unallocated, NOW + 1250), /Synthetic cursor persistence failure/);
  assert.deepEqual(store.getState(key), sourceBefore);
  assert.equal(adapter.snapshot().fields.phase_info.measuredAt, NOW);
  assert.equal(store.observations().length, 0, 'A failed cursor cannot leave committed gap rows');
  assert.equal(store.events().length, 0, 'A failed cursor cannot leave an exceptional event');
  store.setState = setState;
  assert.equal(adapter.accept('phase_info', unallocated, NOW + 1250), true);
  const gaps = store.observations();
  assert.equal(gaps.length, 3);
  assert.deepEqual(gaps.map(row => row.signal).sort(), ['ev2_energy_l1', 'ev2_energy_l2', 'ev2_energy_l3']);
  assert(gaps.every(row => row.value === null && row.quality.includes('unknown-phase-share')));
  assert.deepEqual(store.events().map(({ type, at, payload }) => ({ type, at, payload })), [{
    type: 'charging-energy-unallocated', at: NOW + 1250,
    payload: { source: 'shelly-evse', device: adapter.association, start: NOW, end: NOW + 1000,
      referenceKwh: .001, reason: 'unknown-phase-share' },
  }]);

  adapter.close(); engine.recorder = new Recorder(store); adapter = create();
  assert.equal(adapter.accept('phase_info', unallocated, NOW + 1500), false);
  assert.equal(store.events().length, 1, 'Restart does not duplicate exceptional evidence');
  const allocated = sample(NOW + 2000, .003, [1, 2, 3]);
  store.setState = failCursorSave;
  assert.throws(() => adapter.accept('phase_info', allocated, NOW + 2250), /Synthetic cursor persistence failure/);
  assert.equal(store.observations().length, 3, 'A failed cursor cannot leave any phase energy credited');
  assert.equal(store.getState(key).counter.at, NOW + 1000);
  store.setState = setState;
  assert.equal(adapter.accept('phase_info', allocated, NOW + 2250), true);
  const phases = store.observations().filter(row => row.value !== null);
  assert.equal(phases.length, 3);
  assert.equal(phases.reduce((sum, row) => sum + row.value, 0), .002, 'Unallocated consumption is never added to a later split');
  assert(phases.every(row => row.sourceTime === NOW + 2000 && row.receivedAt === NOW + 2250
    && row.raw.intervalStart === NOW + 1000 && row.raw.intervalEnd === NOW + 2000));
  assert.equal(Object.hasOwn(store.getState(key), 'sessionCheck'), false);
  adapter.close(); engine.recorder = new Recorder(store); adapter = create();
  assert.equal(adapter.accept('phase_info', allocated, NOW + 2500), false);
  assert.equal(store.observations().length, 6);
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
  assert.equal(f.energy.length, 1);
  assert.deepEqual(f.energy[0].energies, [0, 0, 0], 'Only the three phase contributions are recorded');
});
test('each physical negative/positive notification closes its epoch even between polling ticks',async t=>{
  const f=fixture(t);await f.ready();const first=f.adapter.snapshot().session.sessionId;
  f.setNow(NOW+1000);f.notify('work_state','charger_free');f.setNow(NOW+2000);f.notify('work_state','charger_wait');
  assert.notEqual(f.adapter.snapshot().session.sessionId,first);assert.equal(f.adapter.snapshot().session.lastDisconnectedAt,NOW+1000);
});
test('commissioning, authority and subscriptions fence all mutations',async t=>{
  const f=fixture(t,{limiterEnabled:false});await f.ready();
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
  const f=fixture(t,{limiterEnabled:true});f.fields.start_charging=false;f.fields.work_state='charger_pause';await f.ready();
  const controller=createShellyController({adapter:f.adapter,clock:()=>NOW,canControl:()=>true});t.after(()=>controller.close());
  await controller.update({enabled:false,allocation:{}});
  assert.equal(f.writes.some(row=>row.method==='Boolean.Set'&&row.params.value===true),false);
  assert.equal(controller.status().manual.kind,'stop');assert.equal(controller.status().limiter.currentA,12);
});

test('held phase readback remains usable while stopped and preserves original physical clocks', async t => {
  const f = fixture(t, { limiterEnabled: true });
  f.fields.start_charging = false; f.fields.work_state = 'charger_pause';
  f.fields.phase_info.total_power = 0;
  for (const phase of ['phase_a', 'phase_b', 'phase_c']) {
    f.fields.phase_info[phase].current = 0; f.fields.phase_info[phase].power = 0;
  }
  f.setSourceTime('phase_info', NOW); await f.ready();
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
    getAllocation: () => ({ priority: 'charger2', property: reading([3, 3, 3]), easee: reading([0, 0, 0]) }) });
  t.after(() => controller.close());
  for (const at of [NOW, NOW + 20_000, NOW + 3_600_000]) {
    f.setNow(at); const result = await controller.update({ enabled: false });
    assert.equal(result.limiter.currentA, 16); assert.equal(result.limiter.fallback, false);
    assert.equal(f.adapter.liveCurrents().healthy, true);
    assert.equal(f.adapter.snapshot().fields.phase_info.measuredAt, NOW);
    assert.equal(f.adapter.readings().ev2_current_l1.sourceTime, NOW);
    assert.equal(f.adapter.readings().ev2_current_l1.receivedAt, at);
    assert.equal(f.adapter.readings().ev2_current_l1.available, true);
  }
  assert.equal(f.writes.some(row => row.method === 'Boolean.Set' && row.params.value === true), false);
  assert.equal(f.energy.length, 0, 'Held readback produces no synthetic energy samples');
  f.setNow(f.now() + 16_000);
  assert.equal(f.adapter.liveCurrents().healthy, false, 'Missing actual replies still expires confirmation');
  await f.adapter.refresh({ force: true }); assert.equal(f.adapter.liveCurrents().healthy, true);
  f.client.emit('close'); assert.equal(f.adapter.liveCurrents().healthy, false);
});

test('limiter recomputes directly after restart without an allowance baseline', async t => {
  const f = fixture(t, { limiterEnabled: true }); await f.ready(); advanceCommandClock(f);
  let saved = null;
  const attach = () => createShellyController({ adapter: f.adapter, initialState: saved, clock: f.now,
    canControl: () => true, saveState: value => { saved = structuredClone(value); },
    getAllocation: () => ({ priority: 'charger2', property: reading([16, 16, 16]), easee: reading([0, 0, 0]) }) });
  let controller = attach(); t.after(() => controller.close());
  assert.equal((await controller.update({ enabled: false })).limiter.fallback, false);
  await controller.close(); controller = attach();
  const result = await controller.update({ enabled: false });
  assert.equal(result.limiter.currentA, 16); assert.equal(result.limiter.fallback, false);
});

test('identification current restoration uses measured household headroom at 6A', async t => {
  const f = fixture(t, { limiterEnabled: true }); await f.ready(); advanceCommandClock(f);
  let request = null, own = 12;
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
    getIdentification: () => request,
    getAllocation: () => ({ priority: 'charger2', property: reading([4 + own, 4 + own, 4 + own], f.now()),
      easee: reading([0, 0, 0], f.now()) }) });
  t.after(() => controller.close());
  await controller.update({ enabled: false });
  request = { id: 'synthetic-current-comparison', connectedAt: f.adapter.snapshot().session.connectedAt,
    phase: 'charging', minimumCurrent: true };
  let result = await controller.update({ enabled: false });
  assert.equal(result.currentTest.phase, 'active'); assert.equal(f.fields.current_limit, 6);
  own = 6; f.setNow(f.now() + 1000); f.fields.phase_info.total_power = 4.14;
  for (const phase of ['phase_a', 'phase_b', 'phase_c']) {
    f.fields.phase_info[phase].current = own; f.fields.phase_info[phase].power = 1.38;
  }
  request = null;
  result = await controller.update({ enabled: false });
  assert.equal(result.currentTest.phase, 'restored'); assert.equal(result.currentTest.restoreCurrentA, 16);
  assert.equal(f.fields.current_limit, 16, 'The temporary 6A test changes no household entitlement');
  assert.equal(result.limiter.fallback, false);
  assert.deepEqual(f.writes.filter(row => row.method === 'Number.Set').map(row => row.params.value), [6, 16]);
});

test('first-seen timestamped DUP boundaries are admitted and repeats cannot create another epoch',async t=>{
 const f=fixture(t);await f.ready();f.setNow(NOW+1000);f.notify('work_state','charger_free',{dup:true,messageId:19});
 assert.equal(f.adapter.snapshot().session.connected,false);
 f.setNow(NOW+2000);f.notify('work_state','charger_wait',{dup:true,messageId:20});const session=f.adapter.snapshot().session.sessionId;
 f.notify('work_state','charger_wait',{dup:true,messageId:20});assert.equal(f.adapter.snapshot().session.sessionId,session);
});
test('an uncertain saved dispatch reconciles without replaying a different physical setting',async t=>{
 const f=fixture(t,{limiterEnabled:true});await f.ready();const sessionId=f.adapter.snapshot().session.sessionId;
 const initialState={version:1,association:f.adapter.association,sessionId,phase:'uncertain',pending:{stage:'dispatched',role:'current_limit',value:9,dispatchedAt:NOW,sessionId}};
 const controller=createShellyController({adapter:f.adapter,initialState,clock:()=>NOW,canControl:()=>true});t.after(()=>controller.close());
 await controller.update({enabled:false,allocation:{}});assert.equal(controller.status().phase,'uncertain');
 assert.equal(f.writes.some(row=>row.method.endsWith('.Set')),false);
});
test('unmapped work states and mismatched RPC role types cannot authorize charging',async t=>{
 const f=fixture(t,{limiterEnabled:true});await f.ready();f.setNow(NOW+1000);
 f.fields.work_state='unknown-fault';f.notify('work_state','unknown-fault');
 assert.equal(f.adapter.normalize().connected.available,false);
 await assert.rejects(f.adapter.rpc('Number.Set',{owner:'service:0',role:'start_charging',value:true},{mutation:true}));
 const controller=createShellyController({adapter:f.adapter,clock:()=>NOW+1000,canControl:()=>true});t.after(()=>controller.close());
 await controller.update({enabled:true,plan:{periods:[{startAt:NOW,endAt:null}]}});assert.equal(controller.status().phase,'unavailable');
 assert.equal(f.writes.some(row=>row.method.endsWith('.Set')),false);
});

test('native restrictions block control and external auto balance blocks only current control',async t=>{
 const f=fixture(t,{limiterEnabled:true});await f.ready();
 for (const change of [()=>f.serviceStatus.flags=['charge_limit'],()=>{delete f.serviceStatus.flags;f.service.auto_balance.enable=true;}]) {
   change();f.setNow(NOW+1000);await f.adapter.refresh();
   assert.equal(f.adapter.snapshot().controlReady,!f.serviceStatus.flags);
   assert.equal(f.adapter.snapshot().currentControlReady,false);
   await assert.rejects(f.adapter.rpc('Number.Set',{owner:'service:0',role:'current_limit',value:10},{mutation:true}));
 }
 assert.equal(f.writes.some(row=>row.method==='Service.SetConfig'||row.method.endsWith('.Set')),false);
});
test('supported Shelly numeric control confirms variable setpoints without optional UI metadata', async t => {
  for (const metadata of ['missing-step', 'missing-ui', 'null-meta']) await t.test(metadata, async t => {
    const f = fixture(t, { limiterEnabled: true });
    if (metadata === 'missing-step') delete f.currentComponent.meta.ui.step;
    if (metadata === 'missing-ui') delete f.currentComponent.meta.ui;
    if (metadata === 'null-meta') f.currentComponent.meta = null;
    await f.ready(); advanceCommandClock(f);
    assert.equal(f.adapter.snapshot().currentControlReady, true);
    assert.equal(f.writes.some(row => row.method.endsWith('.Set')), false, 'Discovery does not actuate the charger');
    const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true });
    t.after(() => controller.close());
    for (const allocationA of [10, 8]) {
      const before = f.now();
      const view = await controller.update({ enabled: false, allocation: { allocationA } });
      const readback = f.adapter.snapshot().fields.current_limit;
      assert.equal(f.fields.current_limit, allocationA);
      assert.equal(readback.value, allocationA);
      assert.ok(readback.measuredAt > before);
      assert.ok(readback.readback.requestedAt >= readback.measuredAt);
      assert.ok(readback.readback.receivedAt >= readback.readback.requestedAt);
      assert.equal(view.pending, null, 'The numeric command has a correlated native readback');
      assert.equal(f.fields.start_charging, true);
      assert.deepEqual(f.adapter.normalize().phaseCurrentA.value, [12, 12, 12],
        'A confirmed setpoint does not manufacture the corresponding physical current');
    }
    assert.deepEqual(f.writes.filter(row => row.method.endsWith('.Set')).map(row => [row.method, row.params.value]),
      [['Number.Set', 10], ['Number.Set', 8]]);
  });
});

test('withdrawing optional UI step preserves supported current writes but contradictory metadata revokes publication', async t => {
  for (const [label, change] of [
    ['different step', f => { f.currentComponent.meta.ui.step = 2; }],
    ['invalid step', f => { f.currentComponent.meta.ui.step = null; }],
    ['different profile', f => { f.adapter.config.profile = 'unsupported-profile'; }],
    ['different component owner', f => { f.currentComponent.owner = 'service:1'; }],
    ['native balancing', f => { f.service.auto_balance.enable = true; }],
  ]) await t.test(label, async t => {
    const f = fixture(t, { limiterEnabled: true }); await f.ready();
    delete f.currentComponent.meta.ui.step; await f.adapter.refresh();
    assert.equal(f.adapter.snapshot().currentControlReady, true);
    await assert.rejects(f.adapter.rpc('Number.Set', { owner: 'service:0', role: 'current_limit', value: 10 }, {
      mutation: true, beforePublish: async () => { change(f); await f.adapter.refresh(); },
    }), { code: 'evse-command-revoked' });
    assert.equal(f.adapter.snapshot().currentControlReady, false);
    assert.equal(f.writes.some(row => row.method.endsWith('.Set')), false);
  });
});
test('explicit automatic takeover clears a later external current choice and uses normal current allocation', async t => {
 const f = fixture(t, { limiterEnabled: true }); await f.ready(); advanceCommandClock(f);
 const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true }); t.after(() => controller.close());
 await controller.update({ enabled: false });
 f.setNow(f.now() + 1000); f.fields.current_limit = 8; f.notify('current_limit', 8);
 await controller.update({ enabled: false });
 assert.equal(controller.status().manualCurrentA, 8);
 f.setNow(f.now() + 30_000); await f.adapter.refresh();
 const result = await controller.update({ enabled: true, takeover: controller.status().takeover.token,
   plan: { periods: [{ startAt: NOW, endAt: null }] }, allocation: {} });
 assert.equal(result.takeover.state, 'confirmed');
 assert.equal(result.manualCurrentA, null); assert.equal(result.limiter.currentA, 12);
 assert.equal(f.fields.current_limit, 10, 'Normal ramping applies after clearing the external choice');
});

test('a source-only postplug current selection retains its event clock and ceiling across restart', async t => {
 const f = fixture(t, { limiterEnabled: true }); f.fields.current_limit = 9;
 f.sources.set('current_limit', 'sys'); await f.ready();
 const session = f.adapter.snapshot().session;
 f.setNow(NOW + 125); f.delta('current_limit', { source: 'rpc' });
 await f.adapter.refresh({ force: true });
 assert.equal(f.adapter.snapshot().fields.current_limit.measuredAt, NOW);
 assert.equal(f.adapter.snapshot().fields.current_limit.instructionAt, NOW + 125);
 let saved, controller;
 const attach = () => createShellyController({ adapter: f.adapter, initialState: saved, clock: f.now,
   canControl: () => true, saveState: value => { saved = structuredClone(value); } });
 controller = attach(); t.after(() => controller.close());
 await controller.update({ enabled: false });
 assert.equal(saved.manualCurrentA, 9, 'A postplug instruction before the first controller poll still wins');
 await controller.close(); f.restartAdapter(); f.setNow(NOW + 1000); await f.ready(); controller = attach();
 await controller.update({ enabled: false });
 assert.equal(saved.manualCurrentA, 9); assert.deepEqual(f.adapter.snapshot().session, session);
 assert.equal(f.writes.some(row => row.method === 'Number.Set'), false);
});

test('a same-value current selection supersedes identification restoration without renewing native time', async t => {
 const f = fixture(t, { limiterEnabled: true }); f.sources.set('current_limit', 'sys'); await f.ready(); advanceCommandClock(f);
 let request = { id: 'current-choice-test', connectedAt: NOW, phase: 'charging', minimumCurrent: true };
 const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
   getIdentification: () => request }); t.after(() => controller.close());
 await controller.update({ enabled: false });
 assert.equal(controller.status().currentTest.phase, 'active'); assert.equal(f.fields.current_limit, 6);
 const nativeAt = f.adapter.snapshot().fields.current_limit.measuredAt;
 f.setNow(f.now() + 125); f.delta('current_limit', { source: 'rpc' });
 await f.adapter.refresh({ force: true }); request = null;
 const result = await controller.update({ enabled: false });
 assert.equal(result.currentTest.phase, 'superseded'); assert.equal(result.manualCurrentA, 6);
 assert.equal(f.adapter.snapshot().fields.current_limit.measuredAt, nativeAt);
 assert.deepEqual(f.writes.filter(row => row.method === 'Number.Set').map(row => row.params.value), [6]);
});

test('replayed full current status after reconnect does not create a current instruction', async t => {
 const f = fixture(t, { limiterEnabled: true }); f.fields.current_limit = 9;
 f.sources.set('current_limit', 'rpc'); await f.ready();
 f.client.emit('offline'); f.client.emit('connect'); f.setNow(NOW + 1000);
 f.delta('current_limit', { value: 9, source: 'rpc', last_update_ts: NOW / 1000 }, { method: 'NotifyFullStatus', apply: false });
 f.client.emit('message', 'test/evse/online', Buffer.from('true'), {}); await f.adapter.refresh({ force: true });
 assert.equal(f.adapter.snapshot().fields.current_limit.instructionAt, undefined);
 const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true }); t.after(() => controller.close());
 advanceCommandClock(f); await controller.update({ enabled: false });
 assert.equal(controller.status().manualCurrentA, null); assert.equal(f.fields.current_limit, 11);
});

test('a source-only current instruction during explicit takeover wins over that takeover', async t => {
 const f = fixture(t, { limiterEnabled: true }); await f.ready(); advanceCommandClock(f);
 let race = false, injected = false;
 const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
   saveState: async state => {
     if (race && !injected && state.manualCurrentA === null) {
       injected = true; f.setNow(f.now() + 125); f.delta('current_limit', { source: 'rpc' });
       await f.adapter.refresh({ force: true });
     }
   } }); t.after(() => controller.close());
 await controller.update({ enabled: false });
 f.setNow(f.now() + 1000); f.fields.current_limit = 8; f.notify('current_limit', 8);
 await controller.update({ enabled: false }); assert.equal(controller.status().manualCurrentA, 8);
 const writesBefore = f.writes.filter(row => row.method === 'Number.Set').length;
 race = true;
 const result = await controller.update({ enabled: true, takeover: controller.status().takeover.token,
   plan: { periods: [{ startAt: NOW, endAt: null }] } });
 assert.equal(injected, true); assert.equal(result.takeover.state, 'blocked');
 await controller.update({ enabled: false });
 assert.equal(controller.status().manualCurrentA, 8); assert.equal(f.fields.current_limit, 8);
 assert.equal(f.writes.filter(row => row.method === 'Number.Set').length, writesBefore);
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
 await controller.update({enabled:false,plan:{periods:[{startAt:NOW+3600000,endAt:null}]},allocation:{}});
 assert.equal(controller.status().reason,'native-schedule');assert.equal(f.writes.some(row=>row.method==='Boolean.Set'),false);
 f.schedules.jobs=[];await controller.update({enabled:true,plan:{periods:[{startAt:NOW+3600000,endAt:null}]},allocation:{}});
 assert.equal(controller.status().manual.kind,'charge-now');
 assert.equal(f.writes.some(row=>row.method==='Boolean.Set'),false);
 f.setNow(NOW+1000);
 const result=await controller.update({enabled:true,takeover:controller.status().takeover.token,plan:{periods:[{startAt:NOW+3600000,endAt:null}]},allocation:{}});
 assert.equal(result.takeover.state,'confirmed');
 assert.equal(f.writes.filter(row=>row.method==='Boolean.Set'&&row.params.value===false).length,1);
});
test('failed physical persistence restores DUP admission and retries the exact boundary',async t=>{
 const f=fixture(t);await f.ready();f.setNow(NOW+1000);f.setFail(true);f.notify('work_state','charger_free',{dup:true,messageId:71});
 assert.equal(f.adapter.snapshot().session.connected,true);f.setFail(false);f.notify('work_state','charger_free',{dup:true,messageId:71});
 assert.equal(f.adapter.snapshot().session.connected,false);
});
test('a retained physical state can be confirmed live at the same original source clock',async t=>{
 const f=fixture(t);await f.ready();f.setNow(NOW+1000);f.notify('work_state','charger_pause',{retain:true});
 assert.equal(f.adapter.normalize().connected.available,false);
 f.fields.work_state='charger_pause';await f.adapter.refresh();
 assert.equal(f.adapter.normalize().connected.value,true);assert.equal(f.adapter.normalize().connected.measuredAt,NOW+1000);
});
test('a direct work-state query resolves whole-second transitions without changing their source time', async t => {
  const f = fixture(t); await f.ready();
  f.setNow(NOW + 1000); f.notify('work_state', 'charger_pause');
  const session = f.adapter.snapshot().session;
  f.notify('work_state', 'charger_end');
  assert.equal(f.adapter.snapshot().error, 'conflicting-evse-reading');
  assert.equal(f.adapter.snapshot().fields.work_state.value, 'charger_pause');
  const publish = f.client.publish;
  const value = 'charger_end';
  f.client.publish = (topic, payload, options, callback) => {
    const frame = JSON.parse(payload);
    if (frame.method !== 'Enum.GetStatus') return publish(topic, payload, options, callback);
    callback?.();
    queueMicrotask(() => f.client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({
      id: frame.id, src: 'synthetic-evse', dst: frame.src,
      result: { value, last_update_ts: (NOW + 1000) / 1000, source: 'sys' },
    })), {}));
  };
  f.setNow(NOW + 2000); await f.adapter.refresh();
  const actual = f.adapter.snapshot();
  assert.equal(actual.error, null); assert.equal(actual.controlReady, true);
  assert.equal(actual.fields.work_state.value, 'charger_end');
  assert.equal(actual.fields.work_state.measuredAt, NOW + 1000);
  assert.equal(actual.fields.work_state.receivedAt, NOW + 2000);
  assert.deepEqual(actual.session, session, 'Connected state changes retain the physical session');
  assert.equal(actual.charging, false);
  assert.equal(f.writes.some(row => row.method.endsWith('.Set')), false);
});
test('work-state collision recovery rejects old, fractional and in-flight evidence', async t => {
  for (const mode of ['older-clock', 'fractional-clock', 'in-flight', 'invalid-value', 'disconnect', 'unknown-state']) await t.test(mode, async t => {
    const f = fixture(t); await f.ready();
    const originalAt = NOW + (mode === 'fractional-clock' ? 1100 : 1000);
    f.setNow(originalAt); f.notify('work_state', 'charger_pause');
    const publish = f.client.publish;
    let reply, published;
    const requested = new Promise(resolve => { published = resolve; });
    f.client.publish = (topic, payload, options, callback) => {
      const frame = JSON.parse(payload);
      if (frame.method !== 'Enum.GetStatus') return publish(topic, payload, options, callback);
      callback?.();
      const send = () => f.client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({
        id: frame.id, src: 'synthetic-evse', dst: frame.src,
        result: { value: mode === 'invalid-value' ? false : mode === 'disconnect' ? 'charger_free'
          : mode === 'unknown-state' ? 'unknown-fault' : 'charger_end',
          last_update_ts: (mode === 'older-clock' ? NOW : originalAt) / 1000 },
      })), {});
      if (mode === 'in-flight') { reply = send; published(); } else queueMicrotask(send);
    };
    f.setNow(NOW + 2000); const refreshing = f.adapter.refresh();
    if (mode === 'in-flight') {
      await requested;
      assert.equal(typeof reply, 'function');
      f.client.emit('message', 'test/evse/events/rpc', Buffer.from(JSON.stringify({
        src: 'synthetic-evse', method: 'NotifyStatus',
        params: { 'enum:202': { value: 'charger_end', last_update_ts: originalAt / 1000 } },
      })), {});
      reply();
    }
    await refreshing;
    assert.equal(f.adapter.snapshot().controlReady, false);
    assert.equal(f.adapter.snapshot().fields.work_state.value, 'charger_pause');
    assert.equal(f.adapter.snapshot().fields.work_state.measuredAt, originalAt);
    assert.equal(f.writes.some(row => row.method.endsWith('.Set')), false);
  });
});
test('work-state tie recovery does not authorize tied permission, current or power changes', async t => {
  for (const role of ['start_charging', 'current_limit', 'phase_info']) await t.test(role, async t => {
    const f = fixture(t); await f.ready();
    const before = f.adapter.snapshot().fields[role];
    const value = role === 'start_charging' ? false : role === 'current_limit' ? 6 : {
      ...f.fields.phase_info, total_power: 0, ...Object.fromEntries(['phase_a', 'phase_b', 'phase_c']
        .map(phase => [phase, { voltage: 230, current: 0, power: 0 }])),
    };
    const publish = f.client.publish;
    f.client.publish = (topic, payload, options, callback) => {
      const frame = JSON.parse(payload);
      if (!frame.method.endsWith('.GetStatus') || frame.params.role !== role)
        return publish(topic, payload, options, callback);
      callback?.(); queueMicrotask(() => f.client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({
        id: frame.id, src: 'synthetic-evse', dst: frame.src,
        result: { value, last_update_ts: NOW / 1000 },
      })), {}));
    };
    f.setNow(NOW + 2000); await f.adapter.refresh();
    assert.equal(f.adapter.snapshot().controlReady, false);
    assert.equal(f.adapter.snapshot().error, 'conflicting-evse-reading');
    assert.deepEqual(f.adapter.snapshot().fields[role], before);
  });
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

test('Charge Now releases a Shelly economic pause for this session and automatic handover restores the price plan', async t => {
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
  await controller.update({ enabled: false, plan: future, chargeNow: { connectedAt }, allocation: {} });
  assert.equal(f.fields.start_charging, true); assert.equal(controller.status().ownedPause, false);
  assert.equal(controller.status().reason, 'charge-now');
  assert.equal(f.writes.filter(row => row.method === 'Boolean.Set' && row.params.value === true).length, 1);
  await controller.update({ enabled: true, plan: future, chargeNow: null, replan: true, allocation: {} });
  assert.equal(f.fields.start_charging, false); assert.equal(controller.status().reason, 'economic-wait');
});

test('Shelly resumes positive subminimum vehicle demand without an invalid pilot command or weakened stop', async t => {
  for (const limiterEnabled of [false, true]) await t.test(`limiter ${limiterEnabled ? 'on' : 'off'}`, async t => {
    const f = fixture(t, { limiterEnabled }); await f.ready(); advanceCommandClock(f);
    const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true });
    t.after(() => controller.close());
    const future = { periods: [{ startAt: NOW + 3600_000, endAt: null }] };
    await controller.update({ enabled: true, plan: future, allocation: { vehicleCurrentA: 5 } });
    assert.equal(f.fields.start_charging, false, 'The economic delay remains effective');
    const connectedAt = f.adapter.snapshot().session.connectedAt;
    f.setNow(f.now() + f.adapter.config.dwellMs + 1000);
    const request = { enabled: true, plan: future, chargeNow: { connectedAt }, allocation: { vehicleCurrentA: 5 } };
    await controller.update(request);
    assert.equal(f.fields.start_charging, true, 'Positive vehicle demand can resume through a valid pilot');
    assert.equal(f.fields.current_limit, limiterEnabled ? 6 : 16,
      'Optional limiting uses the valid minimum; basic scheduling preserves the native current setting');
    assert.equal(f.writes.some(row => row.method === 'Number.Set' && row.params.value < 6), false);
    await controller.update({ ...request, allocation: { vehicleCurrentA: 0 } });
    assert.equal(f.fields.start_charging, false, 'Charge now cannot override a known zero vehicle restriction');
    f.setNow(f.now() + f.adapter.config.dwellMs + 1000);
    await controller.update(request);
    assert.equal(f.fields.start_charging, true);
    await controller.update({ ...request, allocation: { vehicleCurrentA: 5, allocationA: 5 } });
    assert.equal(f.fields.start_charging, false, 'A shared electrical allocation below 6 A still stops');
  });
});

test('Shelly Charge Now preserves a native stop, native schedule and vehicle start boundary', async t => {
  for (const mode of ['stop', 'schedule', 'vehicle-start']) {
    const f = fixture(t); f.fields.current_limit = 12;
    if (mode === 'stop') { f.fields.start_charging = false; f.fields.work_state = 'charger_pause'; }
    if (mode === 'schedule') f.schedules.jobs = [{ id: 1, enable: true }];
    await f.ready();
    const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true }); t.after(() => controller.close());
    await controller.update({ enabled: false, chargeNow: { connectedAt: f.adapter.snapshot().session.connectedAt },
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
  await controller.update({ enabled: false, chargeNow: { connectedAt }, allocation: { property: reading([44, 30, 32]), easee: reading([12, 12, 12]) } });
  assert.equal(controller.status().limiter.currentA, 0); assert.equal(f.fields.start_charging, false);
  f.setNow(f.now() + 1000); f.notify('work_state', 'charger_free');
  f.setNow(f.now() + f.adapter.config.dwellMs + 1000); f.notify('work_state', 'charger_wait');
  f.fields.work_state = 'charger_wait'; f.fields.start_charging = true;
  assert.notEqual(f.adapter.snapshot().session.connectedAt, connectedAt);
  await controller.update({ enabled: true, chargeNow: { connectedAt }, plan: { periods: [{ startAt: f.now() + 3600000, endAt: null }] }, allocation: {} });
  assert.equal(controller.status().reason, 'economic-wait'); assert.equal(f.fields.start_charging, false);
});

function advanceCommandClock(f) {
  const publish = f.client.publish;
  f.client.publish = (topic, payload, options, callback) => {
    if (JSON.parse(payload).method.endsWith('.Set')) f.setNow(f.now() + 1000);
    return publish(topic, payload, options, callback);
  };
}

test('basic Shelly scheduling preserves native current and balancing and restores only its own pause', async t => {
  const f = fixture(t); f.service.auto_balance.enable = true; await f.ready(); advanceCommandClock(f);
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true });
  t.after(() => controller.close());
  const future = { periods: [{ startAt: NOW + 3600_000, endAt: null }] };
  let view = await controller.update({ enabled: true, plan: future, allocation: {} });
  assert.equal(f.fields.start_charging, false); assert.equal(view.ownedPause, true);
  assert.equal(view.pending, null); assert.equal(f.fields.current_limit, 16);
  f.setNow(f.now() + f.adapter.config.dwellMs);
  view = await controller.update({ enabled: false, allocation: {} });
  assert.equal(f.fields.start_charging, true); assert.equal(view.ownedPause, false);
  assert.deepEqual(f.writes.filter(row => row.method.endsWith('.Set')).map(row => [row.method, row.params.value]),
    [['Boolean.Set', false], ['Boolean.Set', true]]);
  assert.equal(f.service.auto_balance.enable, true);
});

test('native Shelly manual choices survive automatic toggles and restart until explicit takeover', async t => {
  const f = fixture(t); await f.ready(); advanceCommandClock(f);
  let saved, controller;
  const restart = async () => {
    await controller?.close();
    controller = createShellyController({ adapter: f.adapter, initialState: saved, clock: f.now,
      canControl: () => true, saveState: value => { saved = structuredClone(value); } });
  };
  t.after(() => controller?.close()); await restart();
  const future = { periods: [{ startAt: NOW + 3600_000, endAt: null }] };
  await controller.update({ enabled: true, plan: future });
  assert.equal(f.fields.start_charging, false);
  f.setNow(f.now() + 1000); f.notify('start_charging', false);
  let view = await controller.update({ enabled: true, plan: { periods: [{ startAt: NOW, endAt: null }] } });
  assert.equal(view.manual.kind, 'stop'); assert.equal(view.ownedPause, false);
  await controller.update({ enabled: false }); await restart();
  view = await controller.update({ enabled: true, plan: { periods: [{ startAt: NOW, endAt: null }] } });
  assert.equal(view.manual.kind, 'stop'); assert.equal(f.fields.start_charging, false);
  assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, 1);
  f.setNow(f.now() + 1000); f.fields.start_charging = true;
  view = await controller.update({ enabled: true, plan: future });
  assert.equal(view.manual.kind, 'enable'); assert.equal(f.fields.start_charging, true);
  await controller.update({ enabled: false }); await restart();
  view = await controller.update({ enabled: true, plan: future });
  assert.equal(view.manual.kind, 'enable'); assert.equal(f.fields.start_charging, true);
  view = await controller.update({ enabled: true, takeover: controller.status().takeover.token, plan: future });
  assert.equal(view.takeover.state, 'confirmed');
  assert.equal(view.manual, null); assert.equal(f.fields.start_charging, false);
});

test('native Shelly Start cancels an economic pause and yields scheduling for the physical connection', async t => {
  const f = fixture(t); await f.ready(); advanceCommandClock(f);
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true });
  t.after(() => controller.close());
  const future = { periods: [{ startAt: NOW + 3600_000, endAt: null }] };
  await controller.update({ enabled: true, plan: future });
  f.setNow(f.now() + 1000); f.fields.start_charging = true;
  let view = await controller.update({ enabled: true, plan: future });
  assert.equal(view.manual.kind, 'enable'); assert.equal(view.ownedPause, false);
  f.setNow(f.now() + 1000); f.fields.phase_info.total_power = 0; f.fields.work_state = 'charger_pause';
  view = await controller.update({ enabled: true, plan: future });
  assert.equal(view.manual.kind, 'enable', 'A native pause or zero power does not erase app priority');
  assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, 1);
});

test('removing a native Shelly schedule releases only the controller pause and preserves app priority', async t => {
  const f = fixture(t); await f.ready(); advanceCommandClock(f);
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true });
  t.after(() => controller.close());
  const future = { periods: [{ startAt: NOW + 3600_000, endAt: null }] };
  await controller.update({ enabled: true, plan: future });
  f.schedules.jobs = [{ id: 1, enable: true }];
  await controller.update({ enabled: true, plan: future });
  assert.equal(f.fields.start_charging, false);
  f.setNow(f.now() + f.adapter.config.dwellMs); f.schedules.jobs = [];
  const view = await controller.update({ enabled: true, plan: future });
  assert.equal(view.manual.kind, 'charge-now'); assert.equal(view.ownedPause, false);
  assert.equal(f.fields.start_charging, true);
  assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, 2);
});

test('a Shelly Stop discovered during takeover read supersedes the earlier native Start', async t => {
  const f = fixture(t); await f.ready(); advanceCommandClock(f);
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true });
  t.after(() => controller.close());
  const future = { periods: [{ startAt: NOW + 3600_000, endAt: null }] };
  await controller.update({ enabled: false });
  f.setNow(f.now() + 1000); f.notify('start_charging', true);
  await controller.update({ enabled: true, plan: future });
  assert.equal(controller.status().manual.kind, 'enable');
  const refresh = f.adapter.refresh;
  f.adapter.refresh = async () => {
    f.adapter.refresh = refresh;
    f.setNow(f.now() + 1000); f.fields.start_charging = false;
    return refresh();
  };
  const refused = await controller.update({ enabled: true, takeover: controller.status().takeover.token, plan: future });
  assert.equal(refused.takeover.state, 'blocked');
  assert.equal(refused.takeover.reason, 'evse-takeover-changed');
  const view = await controller.update({ enabled: true, plan: future });
  assert.equal(view.manual.kind, 'stop'); assert.equal(f.fields.start_charging, false);
  assert.equal(f.writes.some(row => row.method.endsWith('.Set')), false);
});

const nativeChargingJob = (id = 1, value = true) => ({ id, enable: true, timespec: '0 0 22 * * *',
  calls: [{ method: 'Boolean.Set', params: { owner: 'service:0', role: 'start_charging', value } }] });

test('retired Shelly resume inputs reject before state or physical mutation', async t => {
  const f = fixture(t); await f.ready(); let saves = 0;
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
    saveState: () => { saves++; } }); t.after(() => controller.close());
  const reads = f.writes.length;
  for (const resume of [true, false, null])
    assert.throws(() => controller.update({ enabled: true, resume }), /unsupported-shelly-control-input/);
  assert.equal(saves, 0); assert.equal(f.writes.length, reads);
});

test('explicit Shelly takeover supersedes a native Stop but follows the current economic window', async t => {
  for (const mode of ['charge', 'wait', 'no-plan']) {
    const f = fixture(t); f.fields.start_charging = false; f.fields.work_state = 'charger_pause'; await f.ready();
    const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true });
    t.after(() => controller.close());
    await controller.update({ enabled: false });
    assert.equal(controller.status().manual.kind, 'stop');
    f.setNow(NOW + 1000);
    const { token } = controller.status().takeover;
    const plan = mode === 'no-plan' ? null : { periods: [{ startAt: NOW + (mode === 'wait' ? 3600_000 : 0), endAt: null }] };
    const result = await controller.update({ enabled: true, takeover: token, plan });
    assert.equal(result.takeover.state, 'confirmed', mode);
    assert.equal(result.takeover.attemptToken, token);
    assert.equal(result.manual, null);
    assert.equal(f.fields.start_charging, mode === 'charge');
    assert.equal(f.writes.some(row => row.method === 'Number.Set'), false);
    if (mode !== 'charge') assert.equal(f.writes.some(row => row.method === 'Boolean.Set'), false);
  }
});

test('an adopted Shelly stop never regains manual priority after controller restart or a new connection', async t => {
  const f = fixture(t); f.fields.start_charging = false; f.fields.work_state = 'charger_pause'; await f.ready();
  let saved;
  const options = { adapter: f.adapter, clock: f.now, canControl: () => true, saveState: value => { saved = structuredClone(value); } };
  let controller = createShellyController(options); t.after(() => controller.close());
  const future = { periods: [{ startAt: NOW + 3600_000, endAt: null }] };
  await controller.update({ enabled: true, plan: future });
  await controller.update({ enabled: true, takeover: controller.status().takeover.token, plan: future });
  assert.equal(controller.status().manual, null);
  await controller.close(); controller = createShellyController({ ...options, initialState: saved });
  await controller.update({ enabled: true, plan: future });
  assert.equal(controller.status().manual, null);
  f.setNow(NOW + 1000); f.fields.work_state = 'charger_free';
  await controller.update({ enabled: true, plan: future });
  f.setNow(NOW + 2000); f.fields.work_state = 'charger_pause';
  await controller.update({ enabled: true, plan: future });
  assert.equal(controller.status().manual, null);
  assert.equal(controller.status().ownedPause, true);
  assert.equal(f.fields.start_charging, false);
  f.setNow(NOW + 3600_000); await controller.update({ enabled: true, plan: future });
  assert.equal(f.fields.start_charging, true);
  f.setNow(f.now() + 1000); f.fields.start_charging = false;
  const external = await controller.update({ enabled: true, plan: future });
  assert.equal(external.manual.kind, 'stop');
  assert.equal(external.automaticPermission, null);
  assert.equal(f.fields.start_charging, false, 'a genuinely later external Stop wins again');
});

test('Shelly takeover disables only verified charging jobs permanently and confirms every native write', async t => {
  const f = fixture(t); f.fields.start_charging = false; f.fields.work_state = 'charger_pause';
  const first = nativeChargingJob(1), second = nativeChargingJob(2, false);
  second.calls[0].params = { id: 201, value: false };
  const unrelated = { id: 3, enable: true, timespec: '0 0 12 * * *', calls: [{ method: 'Switch.Set', params: { id: 0, on: true } }] };
  f.schedules.jobs = [first, unrelated, second]; await f.ready();
  let saved;
  const options = { adapter: f.adapter, clock: f.now, canControl: () => true, saveState: value => { saved = structuredClone(value); } };
  let controller = createShellyController(options); t.after(() => controller.close());
  const future = { periods: [{ startAt: NOW + 3600_000, endAt: null }] };
  await controller.update({ enabled: false, plan: future });
  const result = await controller.update({ enabled: true, takeover: controller.status().takeover.token, plan: future });
  assert.equal(result.takeover.state, 'confirmed'); assert.equal(result.manual, null);
  assert.equal(f.fields.start_charging, false, 'handover does not pulse charging during an expensive period');
  assert.deepEqual(f.schedules.jobs, [{ ...first, enable: false }, unrelated, { ...second, enable: false }]);
  const mutations = f.writes.filter(row => row.method === 'Schedule.Update');
  assert.deepEqual(mutations.map(row => row.params), [{ id: 1, enable: false }, { id: 2, enable: false }]);
  assert.ok(mutations.every(row => row.options.retain === false && row.options.qos === 0));
  assert.equal(f.adapter.snapshot().nativeScheduleActive, false, 'unrelated jobs cannot own charging');
  await controller.close(); controller = createShellyController({ ...options, initialState: saved });
  await controller.update({ enabled: true, plan: future });
  assert.equal(controller.status().manual, null);
  assert.equal(f.writes.filter(row => row.method === 'Schedule.Update').length, 2, 'no replay or restoration on restart');
  f.schedules.jobs[0].enable = true; f.schedules.rev++;
  const external = await controller.update({ enabled: true, plan: future });
  assert.equal(external.manual.kind, 'schedule');
  assert.equal(f.writes.filter(row => row.method === 'Schedule.Update').length, 2, 'new external schedule takes precedence');
});

test('automatic and explicit Shelly takeover confirm a stop before removing schedules during a planned wait', async t => {
  for (const automatic of [true, false]) {
    const f = fixture(t); f.schedules.jobs = [nativeChargingJob()]; await f.ready();
    let saved;
    const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
      saveState: value => { saved = structuredClone(value); } });
    t.after(() => controller.close());
    const future = { periods: [{ startAt: NOW + 3600_000, endAt: null }] };
    if (!automatic) await controller.update({ enabled: false, plan: future });
    f.setNow(NOW + 1000);
    const publish = f.client.publish;
    f.client.publish = (topic, payload, options, callback) => {
      const frame = JSON.parse(payload);
      if (frame.method === 'Boolean.Set') {
        assert.equal(frame.params.value, false);
        assert.equal(saved.pending.stage, 'dispatched', 'The protective stop is durable before publication');
      }
      if (frame.method === 'Schedule.Update') {
        assert.equal(f.fields.start_charging, false, 'Schedule removal never exposes a true start permission');
        assert.equal(f.adapter.snapshot().fields.start_charging.value, false, 'A separate native read confirms the stop first');
        assert.equal(saved.pending, null);
        assert.equal(saved.ownedPause, true);
      }
      return publish(topic, payload, options, callback);
    };
    const result = await controller.update({ enabled: true, plan: future,
      ...(!automatic ? { takeover: controller.status().takeover.token } : {}) });
    assert.equal(result.takeover.state, 'confirmed');
    assert.equal(result.manual, null);
    assert.equal(f.fields.start_charging, false);
    assert.deepEqual(f.writes.filter(row => ['Boolean.Set', 'Schedule.Update'].includes(row.method)).map(row => row.method),
      ['Boolean.Set', 'Schedule.Update']);
    assert.equal(result.automaticPermission.value, false);
  }
});

test('an unconfirmed protective Shelly stop leaves native schedules intact and cannot replay on restart', async t => {
  for (const mode of ['rejected', 'lost-reply']) {
    const f = fixture(t); f.schedules.jobs = [nativeChargingJob()]; await f.ready(); f.setNow(NOW + 1000);
    let saved;
    const options = { adapter: f.adapter, clock: f.now, canControl: () => true,
      saveState: value => { saved = structuredClone(value); } };
    let controller = createShellyController(options); t.after(() => controller.close());
    const publish = f.client.publish;
    f.client.publish = (topic, payload, options, callback) => {
      const frame = JSON.parse(payload);
      if (frame.method !== 'Boolean.Set') return publish(topic, payload, options, callback);
      f.writes.push({ ...frame, topic, options });
      if (mode === 'lost-reply') {
        f.fields.start_charging = false; f.notify('start_charging', false);
        callback?.(Error('synthetic lost reply'));
      } else {
        callback?.(); queueMicrotask(() => f.client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({
          id: frame.id, src: 'synthetic-evse', dst: frame.src, error: { code: -1 } })), {}));
      }
    };
    const future = { periods: [{ startAt: NOW + 3600_000, endAt: null }] };
    const result = await controller.update({ enabled: true, plan: future });
    assert.equal(result.takeover.state, 'blocked');
    assert.equal(f.schedules.jobs[0].enable, true);
    assert.equal(saved.pending.role, 'start_charging');
    assert.equal(saved.pending.value, false);
    await controller.close(); controller = createShellyController({ ...options, initialState: saved });
    await controller.update({ enabled: true, plan: future });
    assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, 1);
    assert.equal(f.writes.filter(row => row.method === 'Schedule.Update').length, 0);
    if (mode === 'lost-reply') assert.equal(f.fields.start_charging, false);
  }
});

test('lost schedule-removal confirmation after a new automatic Shelly stop preserves that stop across restart', async t => {
  const f = fixture(t); f.schedules.jobs = [nativeChargingJob()]; await f.ready(); f.setNow(NOW + 1000);
  let saved;
  const options = { adapter: f.adapter, clock: f.now, canControl: () => true,
    saveState: value => { saved = structuredClone(value); } };
  let controller = createShellyController(options); t.after(() => controller.close());
  const publish = f.client.publish;
  f.client.publish = (topic, payload, options, callback) => {
    const frame = JSON.parse(payload);
    if (frame.method !== 'Schedule.Update') return publish(topic, payload, options, callback);
    f.writes.push({ ...frame, topic, options });
    assert.equal(f.fields.start_charging, false);
    f.schedules.jobs[0].enable = false; f.schedules.rev++;
    callback?.(Error('synthetic lost schedule response'));
  };
  const future = { periods: [{ startAt: NOW + 3600_000, endAt: null }] };
  const failed = await controller.update({ enabled: true, plan: future });
  assert.equal(failed.takeover.state, 'blocked');
  assert.equal(saved.scheduleTakeoverPending, true);
  await controller.close(); controller = createShellyController({ ...options, initialState: saved });
  f.setNow(NOW + 3600_000);
  const restored = await controller.update({ enabled: true, plan: future });
  assert.equal(restored.manual.kind, 'takeover-unconfirmed');
  assert.equal(f.fields.start_charging, false, 'Unconfirmed schedule removal cannot become an automatic release');
  assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, 1);
  assert.equal(f.writes.filter(row => row.method === 'Schedule.Update').length, 1);
});

test('mixed or unsupported native Shelly jobs refuse takeover without changing unrelated instructions', async t => {
  for (const job of [
    { id: 1, enable: true },
    { ...nativeChargingJob(), calls: [...nativeChargingJob().calls, { method: 'Switch.Set', params: { id: 0, on: false } }] },
    { ...nativeChargingJob(), calls: [{ method: 'Script.Start', params: { id: 1 } }] },
    { ...nativeChargingJob(), calls: [{ method: 'Boolean.Set', params: { id: 201, value: true, toggle_after: 60 } }] },
  ]) {
    const f = fixture(t); f.schedules.jobs = [job]; await f.ready();
    const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true }); t.after(() => controller.close());
    await controller.update({ enabled: true });
    assert.equal(controller.status().takeover.available, false);
    assert.equal(controller.status().takeover.reason, 'evse-native-schedule-unsupported');
    const result = await controller.update({ enabled: true, takeover: 'invalid', plan: { periods: [{ startAt: NOW, endAt: null }] } });
    assert.equal(result.takeover.state, 'blocked');
    assert.equal(f.writes.some(row => row.method === 'Schedule.Update' || row.method.endsWith('.Set')), false);
  }
});

test('Shelly takeover fences a new native instruction discovered by refresh and a later instruction while planning', async t => {
  for (const during of ['refresh', 'plan']) {
    const f = fixture(t); f.fields.start_charging = false; f.fields.work_state = 'charger_pause'; await f.ready();
    let changeDuringPlan = false;
    const plan = { periods: [{ startAt: NOW, endAt: null }] };
    const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
      getPlan: async () => { if (changeDuringPlan) { f.setNow(f.now() + 1000); f.notify('start_charging', false); } return plan; } });
    t.after(() => controller.close()); await controller.update({ enabled: false });
    const { token } = controller.status().takeover;
    if (during === 'refresh') {
      const refresh = f.adapter.refresh;
      f.adapter.refresh = async () => { f.adapter.refresh = refresh; f.setNow(f.now() + 1000); f.notify('start_charging', false); return refresh(); };
    } else changeDuringPlan = true;
    const result = await controller.update({ enabled: true, takeover: token });
    assert.equal(result.takeover.state, 'blocked');
    assert.equal(result.takeover.reason, 'evse-takeover-changed');
    assert.equal(result.takeover.attemptToken, token);
    assert.equal(f.fields.start_charging, false);
    assert.equal(f.writes.some(row => row.method.endsWith('.Set')), false);
  }
});

test('a newer queued update cannot leave Shelly takeover pending or retain an obsolete result', async t => {
  const f = fixture(t); f.fields.start_charging = false; f.fields.work_state = 'charger_pause'; await f.ready();
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true }); t.after(() => controller.close());
  await controller.update({ enabled: false });
  const takeover = controller.update({ enabled: true, takeover: controller.status().takeover.token });
  const newer = controller.update({ enabled: false });
  const cancelled = await takeover;
  assert.notEqual(cancelled.takeover.state, 'pending');
  await newer;
  assert.equal(controller.status().takeover.state, undefined);
  assert.equal(f.writes.some(row => row.method.endsWith('.Set') || row.method === 'Schedule.Update'), false);
  await controller.update({ enabled: true, takeover: controller.status().takeover.token });
  assert.equal(controller.status().takeover.state, 'confirmed');
  await controller.update({ enabled: true });
  assert.equal(controller.status().takeover.state, undefined, 'later status describes current control rather than the old successful click');
});

test('Shelly preserves an accepted stop when replanning revokes the in-flight intent', async t => {
  const f = fixture(t); await f.ready();
  f.setNow(NOW + 1000);
  let saved;
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
    saveState: value => { saved = structuredClone(value); } });
  t.after(() => controller.close());
  const rpc = f.adapter.rpc;
  f.adapter.rpc = async (...args) => {
    const result = await rpc(...args);
    if (args[0] === 'Boolean.Set') controller.invalidate();
    return result;
  };
  const plan = { periods: [{ startAt: NOW + 3600_000, endAt: null }] };
  await controller.update({ enabled: true, plan });
  assert.equal(saved.pending.stage, 'accepted', 'The native reply remains evidence after intent revocation');
  assert.equal(saved.pending.acceptedAt, NOW + 1000);
  f.adapter.rpc = rpc;
  f.setNow(NOW + 2000);
  const result = await controller.update({ enabled: true, plan });
  assert.equal(result.pending, null);
  assert.equal(result.manual, null, 'Our acknowledged and read-back stop is not a manual stop');
  assert.equal(result.ownedPause, true);
  assert.equal(result.reason, 'economic-wait');
  assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, 1, 'Do not replay the stop');
});

test('Shelly post-write verification drains an older poll before requesting fresh correlated readback', async t => {
  for (const mode of ['current', 'stop', 'start']) await t.test(mode, async t => {
    const f = fixture(t, { limiterEnabled: false }); await f.ready();
    const request = mode === 'current' ? { id: 'concurrent-minimum-readback', connectedAt: NOW,
      phase: 'charging', minimumCurrent: true } : null;
    const controller = createShellyController({ adapter: f.adapter, clock: f.now,
      canControl: () => true, getIdentification: () => request });
    t.after(() => controller.close());
    const waiting = { periods: [{ startAt: NOW + 3600_000, endAt: null }] };
    if (mode === 'start') { f.setNow(NOW + 1000); await controller.update({ enabled: true, plan: waiting }); }
    const writeAt = NOW + (mode === 'start' ? 62_737 : 2737), sourceAt = Math.floor(writeAt / 1000) * 1000;
    f.setNow(writeAt);
    const role = mode === 'current' ? 'current_limit' : 'start_charging';
    const method = mode === 'current' ? 'Number.Set' : 'Boolean.Set';
    const before = f.writes.filter(row => row.method === method).length;
    const rpc = f.adapter.rpc, publish = f.client.publish;
    const reads = [];
    let acceptedAt, releaseRead, enteredRead, paused = false;
    const entered = new Promise(resolve => { enteredRead = resolve; });
    f.client.publish = (topic, payload, options, callback) => {
      const frame = JSON.parse(payload);
      if (frame.params.role === role && frame.method.endsWith('.GetStatus')) {
        reads.push(f.now());
        if (paused && !releaseRead) {
          releaseRead = () => publish(topic, payload, options, callback);
          enteredRead(); return;
        }
      }
      publish(topic, payload, options, callback);
    };
    f.adapter.rpc = async (...args) => {
      const result = await rpc(...args);
      if (args[0] === method) {
        f.setSourceTime(role, sourceAt);
        paused = true;
        void f.adapter.refresh();
        await entered;
        f.setNow(f.now() + 33); acceptedAt = f.now();
        setImmediate(() => { paused = false; f.setNow(f.now() + 400); releaseRead(); });
      }
      return result;
    };
    const result = await controller.update({ enabled: mode !== 'current',
      plan: mode === 'start' ? { periods: [{ startAt: f.now(), endAt: null }] } : waiting });
    assert.equal(f.writes.filter(row => row.method === method).length - before, 1, 'Never repeat the accepted write');
    assert.ok(reads.some(at => at < acceptedAt) && reads.some(at => at >= acceptedAt),
      'The earlier in-flight read is followed by a new post-acknowledgement query');
    assert.equal(f.adapter.snapshot().fields[role].measuredAt, sourceAt, 'Keep the native whole-second clock');
    if (mode === 'current') assert.equal(result.currentTest.phase, 'active');
    else { assert.equal(result.pending, null); assert.equal(result.manual, null); }
  });
});

test('ordinary current recovery uses ordered native readings without shifting clocks or replaying a write', async t => {
  for (const mode of ['confirmed', 'restart', 'missing-ack', 'unchanged-clock', 'uncorrelated', 'pre-ack-read',
    'missing-baseline', 'unchanged-value', 'newer-current', 'newer-same-current', 'restart-newer-current', 'restart-newer-same-current'])
    await t.test(mode, async t => {
      const f = fixture(t, { limiterEnabled: true, dwellMs: 0, rampA: 16 });
      await f.ready(); f.setNow(NOW + 2029);
      let saved;
      const options = { adapter: f.adapter, clock: f.now, canControl: () => true,
        saveState: value => { saved = structuredClone(value); } };
      let controller = createShellyController(options); t.after(() => controller.close());
      const rpc = f.adapter.rpc;
      f.adapter.rpc = async (...args) => {
        const result = await rpc(...args);
        if (args[0] === 'Number.Set') {
          f.setSourceTime('current_limit', NOW + (mode === 'unchanged-clock' ? 0 : 1000));
          if (mode !== 'unchanged-clock') f.delta('current_limit', { value: args[1].value, source: 'rpc' },
            { eventAt: NOW + 1900, apply: false });
          f.setNow(f.now() + 205);
          if (mode === 'missing-ack') throw Object.assign(Error('lost reply'), { code: 'evse-rpc-timeout' });
          if (mode.startsWith('restart') || ['missing-baseline', 'unchanged-value'].includes(mode)) controller.invalidate();
        }
        return result;
      };
      if (['uncorrelated', 'pre-ack-read'].includes(mode)) {
        const snapshot = f.adapter.snapshot;
        f.adapter.snapshot = () => {
          const value = snapshot();
          if (mode === 'uncorrelated') delete value.fields.current_limit.readback;
          else if (value.fields.current_limit.readback) value.fields.current_limit.readback.requestedAt = NOW;
          return value;
        };
      }
      const input = () => ({ enabled: false, allocation: {
        property: reading([25, 25, 25], f.now()), easee: reading([0, 0, 0], f.now()) } });
      let result = await controller.update(input());
      if (mode.startsWith('restart') || ['missing-baseline', 'unchanged-value'].includes(mode)) {
        assert.equal(saved.pending.stage, 'accepted');
        if (mode === 'missing-baseline') delete saved.lastCurrentAtSource;
        if (mode === 'unchanged-value') saved.lastCurrent = saved.pending.value;
        await controller.close(); controller = createShellyController({ ...options, initialState: saved });
        f.setNow(NOW + 5000);
        if (mode.startsWith('restart-newer')) {
          f.delta('current_limit', { value: mode === 'restart-newer-current' ? 8 : 12, source: 'rpc' });
          await f.adapter.refresh();
        }
        result = await controller.update(input());
      }
      if (['missing-ack', 'unchanged-clock', 'uncorrelated', 'pre-ack-read', 'missing-baseline', 'unchanged-value'].includes(mode)) {
        assert.ok(result.pending);
        assert.equal(result.reason, mode === 'missing-ack' ? 'evse-rpc-timeout' : 'evse-command-unconfirmed');
        f.setNow(NOW + 65_000); result = await controller.update(input());
        assert.ok(result.pending, 'Timeout alone never confirms the command');
        assert.equal(result.limiter.loadCurrentA, 12, 'Capacity remains a separate fresh calculation');
      } else if (mode.startsWith('restart-newer')) {
        assert.equal(result.pending, null);
        assert.equal(result.manualCurrentA, mode === 'restart-newer-current' ? 8 : 12,
          'A newer external instruction wins over the pending write after restart');
      } else {
        assert.equal(result.pending, null);
        assert.equal(result.manualCurrentA ?? null, null, 'A verified application write is not an external ceiling');
        assert.equal(result.lastCurrentAtSource, NOW + 1000, 'Keep the actual native clock');
        assert.equal(result.lastCurrentInstructionAt, NOW + 1900, 'Keep the original notification clock too');
        if (mode.startsWith('newer-')) {
          f.setNow(NOW + 5000);
          f.delta('current_limit', { value: mode === 'newer-current' ? 8 : 12, source: 'rpc' });
          await f.adapter.refresh();
          result = await controller.update(input());
          assert.equal(result.manualCurrentA, mode === 'newer-current' ? 8 : 12, 'A later native instruction retains priority');
        }
      }
      assert.equal(f.writes.filter(row => row.method === 'Number.Set').length, 1, 'Never repeat the original command');
      assert.equal(f.writes.some(row => row.method === 'Boolean.Set'), false, 'Current recovery does not grant Start permission');
    });
});

test('Shelly confirms whole-second setting clocks only with post-acknowledgement correlated readback', async t => {
  for (const mode of ['rounded', 'takeover', 'older-second', 'uncorrelated', 'restart', 'newer-stop']) await t.test(mode, async t => {
    const f = fixture(t);
    if (mode === 'takeover') f.schedules.jobs = [nativeChargingJob()];
    await f.ready(); f.setNow(NOW + 2029);
    let saved;
    const options = { adapter: f.adapter, clock: f.now, canControl: () => true,
      saveState: value => { saved = structuredClone(value); } };
    let controller = createShellyController(options); t.after(() => controller.close());
    const rpc = f.adapter.rpc;
    f.adapter.rpc = async (...args) => {
      const result = await rpc(...args);
      if (args[0] === 'Boolean.Set') {
        f.setSourceTime('start_charging', Math.floor(f.now() / 1000) * 1000 - (mode === 'older-second' ? 1000 : 0));
        f.setNow(f.now() + 205);
        if (mode === 'restart' || mode === 'newer-stop') controller.invalidate();
      }
      return result;
    };
    if (mode === 'uncorrelated') {
      const snapshot = f.adapter.snapshot;
      f.adapter.snapshot = () => {
        const value = snapshot(); delete value.fields.start_charging.readback; return value;
      };
    }
    const plan = { periods: [{ startAt: NOW + 3600_000, endAt: null }] };
    let result = await controller.update({ enabled: true, plan,
      ...(mode === 'takeover' ? { takeover: controller.status().takeover.token } : {}) });
    if (mode === 'restart' || mode === 'newer-stop') {
      assert.equal(saved.pending.stage, 'accepted');
      await controller.close(); controller = createShellyController({ ...options, initialState: saved });
      f.setNow(NOW + 3000);
      if (mode === 'newer-stop') f.notify('start_charging', false);
      result = await controller.update({ enabled: true, plan });
    }
    if (['rounded', 'takeover', 'restart'].includes(mode)) {
      assert.equal(result.pending, null);
      assert.equal(result.manual, null);
      assert.equal(result.reason, 'economic-wait');
      assert.equal(result.lastStartAt, NOW + 2000, 'Keep the original source clock');
      if (mode === 'takeover') {
        assert.equal(result.takeover.state, 'confirmed');
        assert.equal(f.schedules.jobs[0].enable, false);
      }
    } else {
      assert.equal(result.reason, 'evse-command-unconfirmed');
      assert.ok(result.pending, 'Old or uncorrelated observations cannot confirm the command');
      if (mode === 'newer-stop') assert.equal(result.manual.kind, 'stop');
    }
    assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, 1);
    if (mode === 'rounded') {
      f.setNow(NOW + 3600_029);
      const started = await controller.update({ enabled: true, plan: { periods: [{ startAt: f.now(), endAt: null }] } });
      assert.equal(f.fields.start_charging, true);
      assert.equal(started.pending, null);
      assert.equal(started.lastStartAt, NOW + 3600_000);
      assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, 2);
    }
  });
});

test('Shelly takeover reports rejected or unconfirmed schedule removal and never starts charging', async t => {
  for (const mode of ['rejected', 'unchanged', 'new-schedule']) {
    const f = fixture(t); f.fields.start_charging = false; f.fields.work_state = 'charger_pause'; f.schedules.jobs = [nativeChargingJob()];
    await f.ready();
    const publish = f.client.publish;
    f.client.publish = (topic, payload, options, callback) => {
      const frame = JSON.parse(payload);
      if (frame.method !== 'Schedule.Update') return publish(topic, payload, options, callback);
      f.writes.push({ ...frame, topic, options });
      if (mode === 'new-schedule') { f.schedules.jobs[0].enable = false; f.schedules.jobs.push(nativeChargingJob(2)); f.schedules.rev += 2; }
      callback?.();
      queueMicrotask(() => f.client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({ id: frame.id,
        src: 'synthetic-evse', dst: frame.src, ...(mode === 'rejected' ? { error: { code: -1 } } : { result: { rev: 2 } }) })), {}));
    };
    const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true }); t.after(() => controller.close());
    await controller.update({ enabled: false });
    const result = await controller.update({ enabled: true, takeover: controller.status().takeover.token,
      plan: { periods: [{ startAt: NOW, endAt: null }] } });
    assert.equal(result.takeover.state, 'blocked');
    assert.equal(result.takeover.reason, mode === 'rejected' ? 'evse-rpc-rejected' : 'evse-native-schedule-unconfirmed');
    assert.equal(f.fields.start_charging, false);
    assert.equal(f.writes.some(row => row.method === 'Boolean.Set'), false);
    await controller.update({ enabled: true });
    assert.equal(f.writes.filter(row => row.method === 'Schedule.Update').length, 1, 'ordinary polling never retries a takeover');
  }
});

test('an unconfirmed Shelly timer removal never becomes native Charge now after restart', async t => {
  const f = fixture(t); await f.ready(); f.setNow(NOW + 1000);
  let saved;
  const options = { adapter: f.adapter, clock: f.now, canControl: () => true, saveState: value => { saved = structuredClone(value); } };
  let controller = createShellyController(options); t.after(() => controller.close());
  const plan = { periods: [{ startAt: NOW + 3600_000, endAt: null }] };
  await controller.update({ enabled: true, plan });
  assert.equal(f.fields.start_charging, false); assert.equal(controller.status().ownedPause, true);
  f.schedules.jobs = [nativeChargingJob()]; f.schedules.rev++;
  await controller.update({ enabled: true, plan });
  assert.equal(controller.status().manual.kind, 'schedule');
  const publish = f.client.publish, beforeSchedules = structuredClone(f.schedules);
  let wrongReadback = false;
  f.client.publish = (topic, payload, options, callback) => {
    const frame = JSON.parse(payload);
    if (frame.method === 'Schedule.Update') wrongReadback = true;
    else if (frame.method === 'Schedule.List' && wrongReadback) {
      wrongReadback = false; callback?.();
      queueMicrotask(() => f.client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({ id: frame.id,
        src: 'synthetic-evse', dst: frame.src, result: beforeSchedules })), {}));
      return;
    }
    return publish(topic, payload, options, callback);
  };
  const result = await controller.update({ enabled: true, takeover: controller.status().takeover.token, plan });
  assert.equal(result.takeover.state, 'blocked');
  assert.equal(f.schedules.jobs[0].enable, false, 'the native change happened despite unusable confirmation');
  await controller.close(); controller = createShellyController({ ...options, initialState: saved });
  f.setNow(f.now() + f.adapter.config.dwellMs);
  await controller.update({ enabled: true, plan });
  assert.equal(controller.status().manual.kind, 'takeover-unconfirmed');
  assert.equal(controller.status().reason, 'evse-native-schedule-unconfirmed');
  assert.equal(f.fields.start_charging, false);
  assert.equal(f.writes.filter(row => row.method === 'Schedule.Update').length, 1);
  assert.equal(f.writes.filter(row => row.method === 'Boolean.Set' && row.params.value).length, 0);
  const retry = await controller.update({ enabled: true, takeover: controller.status().takeover.token, plan });
  assert.equal(retry.takeover.state, 'confirmed'); assert.equal(retry.manual, null);
  assert.equal(f.fields.start_charging, false);
});

test('Shelly takeover cannot relax a native current ceiling, vehicle restriction or native fault', async t => {
  for (const mode of ['current', 'vehicle', 'fault', 'authority']) {
    const f = fixture(t); f.fields.start_charging = false; f.fields.work_state = 'charger_pause'; f.fields.current_limit = 8; await f.ready();
    let allowed = true;
    const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => allowed }); t.after(() => controller.close());
    await controller.update({ enabled: true }); f.setNow(NOW + 1000); const { token } = controller.status().takeover;
    if (mode === 'fault') f.serviceStatus.errors = ['overtemperature'];
    if (mode === 'authority') { allowed = false; f.setAuthority(false); }
    const result = await controller.update({ enabled: true, takeover: token, plan: { periods: [{ startAt: NOW, endAt: null }] },
      allocation: mode === 'vehicle' ? { notBefore: NOW + 3600_000 } : {} });
    assert.equal(result.takeover.state, ['fault', 'authority'].includes(mode) ? 'blocked' : 'confirmed');
    assert.equal(f.fields.current_limit, 8);
    assert.equal(f.writes.some(row => row.method === 'Number.Set' || row.method === 'Service.SetConfig'), false);
    assert.equal(f.fields.start_charging, mode === 'current');
  }
});

test('native Shelly current reduction during persisted automatic intent revokes an older increase', async t => {
  const f = fixture(t, { limiterEnabled: true }); await f.ready(); advanceCommandClock(f);
  let edited = false;
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
    saveState: state => {
      if (!edited && state.pending?.role === 'current_limit' && state.pending.stage === 'proposed') {
        edited = true; f.setNow(f.now() + 1000); f.fields.current_limit = 8; f.notify('current_limit', 8);
      }
    } });
  t.after(() => controller.close());
  await controller.update({ enabled: false });
  assert.equal(f.writes.some(row => row.method === 'Number.Set'), false);
  const view = await controller.update({ enabled: true, plan: { periods: [{ startAt: NOW, endAt: null }] } });
  assert.equal(view.manualCurrentA, 8); assert.equal(f.fields.current_limit, 8);
  assert.equal(f.writes.some(row => row.method === 'Number.Set'), false);
});

test('an enabled Shelly limiter with unavailable current capability withholds scheduling commands', async t => {
  const f = fixture(t, { limiterEnabled: true }); f.service.auto_balance.enable = true; await f.ready();
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true });
  t.after(() => controller.close());
  const view = await controller.update({ enabled: true, plan: { periods: [{ startAt: NOW + 3600_000, endAt: null }] } });
  assert.equal(view.phase, 'unavailable'); assert.equal(view.reason, 'evse-current-control-unavailable');
  assert.equal(f.writes.some(row => row.method.endsWith('.Set')), false);
});

test('a definitely unsent Shelly command recovers after authority returns without sticky dispatch uncertainty', async t => {
  const f = fixture(t); await f.ready(); advanceCommandClock(f);
  let revoked = false;
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
    saveState: state => {
      if (!revoked && state.pending?.stage === 'dispatched') { revoked = true; f.setAuthority(false); }
    } });
  t.after(() => controller.close());
  const input = { enabled: true, plan: { periods: [{ startAt: NOW + 3600_000, endAt: null }] } };
  let view = await controller.update(input);
  assert.equal(view.pending.stage, 'proposed');
  assert.equal(f.writes.some(row => row.method.endsWith('.Set')), false);
  f.setAuthority(true);
  view = await controller.update(input);
  assert.equal(view.pending, null); assert.equal(view.ownedPause, true);
  assert.equal(f.fields.start_charging, false);
  assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, 1);
});

test('a new automatic Shelly session replaces charging schedules and a later pause survives restart', async t => {
  const f = fixture(t); f.fields.start_charging = false; f.fields.work_state = 'charger_pause';
  f.schedules.jobs = [nativeChargingJob()]; await f.ready();
  let saved;
  const options = { adapter: f.adapter, clock: f.now, canControl: () => true, saveState: value => { saved = structuredClone(value); } };
  let controller = createShellyController(options); t.after(() => controller.close());
  const future = { periods: [{ startAt: NOW + 3600_000, endAt: null }] };
  const first = await controller.update({ enabled: true, plan: future });
  assert.equal(first.manual, null); assert.equal(f.schedules.jobs[0].enable, false);
  assert.equal(f.fields.start_charging, false);
  assert.equal(f.writes.filter(row => row.method === 'Schedule.Update').length, 1);
  f.setNow(NOW + 3600_000); await controller.update({ enabled: true, plan: future });
  assert.equal(f.fields.start_charging, true);
  f.setNow(f.now() + 1000); f.fields.start_charging = false;
  const stopped = await controller.update({ enabled: true, plan: future });
  assert.equal(stopped.manual.kind, 'stop');
  await controller.close(); controller = createShellyController({ ...options, initialState: saved });
  const restarted = await controller.update({ enabled: true, plan: future });
  assert.equal(restarted.manual.kind, 'stop'); assert.equal(f.fields.start_charging, false);
  f.setNow(f.now() + 1000); f.fields.work_state = 'charger_free'; await controller.update({ enabled: true, plan: future });
  f.setNow(f.now() + 1000); f.fields.work_state = 'charger_pause';
  f.schedules.jobs[0].enable = true; f.schedules.rev++;
  const replugged = await controller.update({ enabled: true, plan: future });
  assert.equal(replugged.manual, null); assert.equal(f.schedules.jobs[0].enable, false);
  assert.equal(f.fields.start_charging, true);
});


test('partial permission notifications preserve event and native clocks plus omitted source', async t => {
  const f = fixture(t, { limiterEnabled: false });
  f.sources.set('start_charging', 'rpc'); await f.ready();
  const original = structuredClone(f.adapter.snapshot().fields.start_charging);
  f.setNow(NOW + 125); f.delta('start_charging', { value: false, source: 'sys' });
  f.setNow(NOW + 250); f.delta('start_charging', { value: true });
  const observed = f.adapter.snapshot();
  assert.equal(observed.fields.start_charging.measuredAt, original.measuredAt, 'A notification cannot invent last_update_ts');
  assert.equal(observed.controlReady, false, 'Await correlated native readback before another command');
  assert.deepEqual(observed.permissionEvents.map(event => [event.value, event.commandSource, event.eventAt, event.valueUpdatedAt]),
    [[false, 'sys', NOW + 125, null], [true, 'sys', NOW + 250, null]]);
  await f.adapter.refresh({ force: true });
  assert.equal(f.adapter.snapshot().fields.start_charging.measuredAt, NOW, 'Keep the device whole-second clock');
  assert.equal(f.adapter.snapshot().fields.start_charging.commandSource, 'sys');
  assert.equal(f.adapter.snapshot().controlReady, true);
});

test('source-only and full-status deltas never refresh held values or phase measurements', async t => {
  const f = fixture(t); f.sources.set('start_charging', 'rpc'); await f.ready();
  const before = f.adapter.snapshot().fields;
  f.setNow(NOW + 1000); f.delta('start_charging', { source: 'sys' });
  f.delta('phase_info', { source: 'sys' });
  f.setNow(NOW + 1100); f.delta('phase_info', { value: { total_power: 0 } }, { apply: false });
  assert.equal(f.adapter.snapshot().fields.start_charging.measuredAt, before.start_charging.measuredAt);
  assert.equal(f.adapter.snapshot().fields.phase_info.measuredAt, before.phase_info.measuredAt);
  assert.equal(f.adapter.readings().ev2_active_power.available, false, 'An incomplete object does not retain usable phase evidence');
  assert.equal(f.adapter.snapshot().permissionEvents.length, 1);
  f.setNow(NOW + 2000); f.delta('start_charging', { value: true, source: 'sys' }, { method: 'NotifyFullStatus' });
  assert.equal(f.adapter.snapshot().permissionEvents.length, 1, 'A held full status is not another instruction');
  f.setNow(NOW + 3000); f.delta('start_charging', { source: null });
  assert.equal(f.adapter.snapshot().permissionEvents.at(-1).commandSource, null, 'Explicit null removes origin');
});

test('an external RPC false-to-true notification pair between reconciles keeps native authority across restart', async t => {
  const f = fixture(t, { limiterEnabled: false }); f.sources.set('start_charging', 'rpc'); await f.ready();
  let saved;
  const attach = () => createShellyController({ adapter: f.adapter, initialState: saved, clock: f.now,
    saveState: value => { saved = structuredClone(value); }, canControl: () => true });
  let controller = attach(); t.after(() => controller.close());
  const plan = { id: 'notification-plan', startAt: NOW, deadlineAt: NOW + 3600_000,
    periods: [{ startAt: NOW, endAt: null }], feasible: true };
  await controller.update({ enabled: true, plan });
  f.setNow(NOW + 125); f.delta('start_charging', { value: false, source: 'rpc' });
  f.setNow(NOW + 250); f.delta('start_charging', { value: true });
  await controller.close(); controller = attach();
  const result = await controller.update({ enabled: true, plan });
  assert.equal(result.manual?.kind, 'enable');
  assert.equal(result.manual.origin, 'external-command');
  assert.equal(result.manual.detectedAt, NOW + 250);
  assert.equal(result.ownedPause, false);
  assert.equal(f.adapter.snapshot().permissionEvents.length, 0, 'Remove events only after the controller saves its cursor');
  assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, 0);
});

for (const boundary of ['retained', 'old', 'future'])
test(`a ${boundary} permission delta cannot establish an instruction`, async t => {
  const f = fixture(t); await f.ready();
  f.setNow(NOW + 1000);
  f.delta('start_charging', { value: false, source: 'sys' }, { apply: false,
    retained: boundary === 'retained', eventAt: boundary === 'old' ? NOW - 1000 : boundary === 'future' ? NOW + 2000 : f.now() });
  assert.equal(f.adapter.snapshot().permissionEvents?.length ?? 0, 0);
  assert.equal(f.adapter.snapshot().fields.start_charging.value, true);
});


test('partial physical disconnect and reconnect preserve both boundaries between polls', async t => {
  const f = fixture(t); await f.ready();
  const old = f.adapter.snapshot().session;
  f.setNow(NOW + 125); f.delta('work_state', { value: 'charger_free' });
  assert.equal(f.adapter.snapshot().session.connected, false);
  assert.equal(f.adapter.snapshot().session.lastDisconnectedAt, NOW + 125);
  f.setNow(NOW + 250); f.delta('work_state', { value: 'charger_charging' });
  const current = f.adapter.snapshot();
  assert.notEqual(current.session.sessionId, old.sessionId);
  assert.equal(current.session.connectedAt, NOW + 250);
  assert.equal(current.session.lastDisconnectedAt, NOW + 125);
  assert.equal(current.session.boundaryClock, 'notification-event');
  assert.equal(current.fields.work_state.measuredAt, NOW, 'The native field clock was not replaced by notification time');
  assert.equal(current.controlReady, false);
  await f.adapter.refresh({ force: true });
  assert.equal(f.adapter.snapshot().session.sessionId, current.session.sessionId);
  f.client.emit('offline'); f.client.emit('connect');
  f.client.emit('message', 'test/evse/online', Buffer.from('true'), {}); await f.adapter.refresh();
  f.delta('work_state', { value: 'charger_free' }, { eventAt: NOW + 125, apply: false });
  assert.equal(f.adapter.snapshot().session.sessionId, current.session.sessionId, 'An old event cannot create a new disconnect after reconnect');
});

test('permission queue overflow fences control without discarding unconsumed events', async t => {
  const f = fixture(t); await f.ready();
  for (let i = 1; i <= 65; i++) {
    f.setNow(NOW + i); f.delta('start_charging', { value: i % 2 === 0, source: 'sys' });
  }
  assert.equal(f.adapter.snapshot().permissionEvents.length, 64);
  assert.equal(f.adapter.snapshot().permissionOverflow, true);
  await f.adapter.refresh({ force: true });
  assert.equal(f.adapter.snapshot().controlReady, false);
  assert.equal(f.adapter.snapshot().error, 'evse-permission-event-overflow');
  await assert.rejects(f.adapter.rpc('Boolean.Set', { owner: 'service:0', role: 'start_charging', value: true }, { mutation: true }), /evse-control-unavailable/);
});

test('failed controller cursor persistence cannot consume native permission events or issue a command', async t => {
  const f = fixture(t, { limiterEnabled: false }); await f.ready();
  let failing = false, saved;
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
    saveState: value => { if (failing) throw Error('synthetic-cursor-failure'); saved = structuredClone(value); } });
  t.after(() => controller.close());
  await controller.update({ enabled: false });
  f.setNow(NOW + 1000); f.delta('start_charging', { value: false, source: 'rpc' });
  failing = true;
  await assert.rejects(controller.update({ enabled: false }), /synthetic-cursor-failure/);
  assert.equal(f.adapter.snapshot().permissionEvents.length, 1);
  assert.equal(saved.permissionEventCursor, undefined);
  assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, 0);
});


for (const source of ['sys', 'rpc'])
test(`a partial same-value ${source} origin preserves the correct native instruction semantics`, async t => {
  const f = fixture(t, { limiterEnabled: false }); f.fields.start_charging = false;
  f.sources.set('start_charging', source === 'sys' ? 'rpc' : 'sys'); await f.ready();
  const state = { version: 1, association: f.adapter.association, sessionId: f.adapter.snapshot().session.sessionId,
    phase: 'waiting', manual: null, ownedPause: true, pending: null, lastStart: false, lastStartAt: NOW };
  const controller = createShellyController({ adapter: f.adapter, initialState: state, clock: f.now, canControl: () => true });
  t.after(() => controller.close());
  f.setNow(NOW + 125); f.delta('start_charging', { source });
  const result = await controller.update({ enabled: false });
  assert.equal(result.manual?.kind ?? null, source === 'sys' ? null : 'stop');
  if (source === 'rpc') {
    assert.equal(result.manual.detectedAt, NOW + 125);
    assert.equal(result.manual.origin, 'external-command');
    assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, 0);
  }
});

test('an unknown live baseline cannot turn a full-status replay into a new instruction or connection', async t => {
  const f = fixture(t); f.sources.set('start_charging', 'rpc'); await f.ready();
  const before = f.adapter.snapshot();
  f.client.emit('offline'); f.client.emit('connect');
  f.setNow(NOW + 1000);
  f.delta('start_charging', { value: true, source: 'rpc' }, { method: 'NotifyFullStatus', apply: false });
  f.delta('work_state', { value: 'charger_charging' }, { method: 'NotifyFullStatus', apply: false });
  f.setNow(NOW + 1001); f.delta('start_charging', { source: 'rpc' }, { apply: false });
  f.client.emit('message', 'test/evse/online', Buffer.from('true'), {}); await f.adapter.refresh({ force: true });
  assert.equal(f.adapter.snapshot().permissionEvents.length, 0);
  assert.equal(f.adapter.snapshot().session.sessionId, before.session.sessionId);
});

test('a delayed pre-notification read cannot overwrite a changed permission with the same native second', async t => {
  const f = fixture(t); await f.ready();
  const publish = f.client.publish; let held;
  f.client.publish = (topic, payload, options, done) => {
    const frame = JSON.parse(payload);
    if (!held && frame.method === 'Boolean.GetStatus') { held = frame; done?.(); return; }
    publish(topic, payload, options, done);
  };
  f.setNow(NOW + 100);
  const reading = f.adapter.rpc('Boolean.GetStatus', { owner: 'service:0', role: 'start_charging' }, { statusReadback: true });
  await new Promise(resolve => setImmediate(resolve));
  f.setNow(NOW + 250); f.delta('start_charging', { value: false, source: 'rpc' });
  f.client.emit('message', `${held.src}/rpc`, Buffer.from(JSON.stringify({ id: held.id, src: 'synthetic-evse', dst: held.src,
    result: { value: true, source: 'rpc', last_update_ts: NOW / 1000 } })), {});
  await reading;
  assert.equal(f.adapter.snapshot().controlReady, false, 'A query requested before the event cannot settle it');
  f.client.publish = publish; await f.adapter.refresh({ force: true });
  assert.equal(f.adapter.snapshot().fields.start_charging.value, false);
  assert.equal(f.adapter.snapshot().fields.start_charging.measuredAt, NOW);
  assert.equal(f.adapter.snapshot().controlReady, true);
});

for (const scenario of ['own Start', 'own Stop', 'external Stop', 'rejected recovery'])
test(`post-ACK confirmation waits for a query after the late notification: ${scenario}`, async t => {
  const f = fixture(t, { limiterEnabled: false });
  f.fields.start_charging = scenario === 'own Stop';
  f.sources.set('start_charging', 'rpc'); await f.ready();
  let saved;
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
    saveState: value => { saved = structuredClone(value); } }); t.after(() => controller.close());
  await controller.update({ enabled: false });
  const publish = f.client.publish; let sent = false, reads = 0, fenced = false;
  f.setNow(NOW + 1321);
  f.client.publish = (topic, payload, options, done) => {
    const frame = JSON.parse(payload);
    if (frame.method === 'Boolean.Set') {
      sent = true; publish(topic, payload, options, done);
      f.setSourceTime('start_charging', NOW + 1000);
      f.setNow(NOW + 1347); return;
    }
    if (sent && frame.method === 'Boolean.GetStatus') {
      reads++;
      if (reads === 1) {
        f.writes.push({ ...frame, topic, options }); done?.();
        queueMicrotask(() => {
          const ownValue = scenario !== 'own Stop';
          f.setNow(NOW + 2121);
          f.delta('start_charging', { value: ownValue }, { eventAt: NOW + 1340, apply: false });
          if (scenario === 'external Stop') {
            f.setNow(NOW + 2200); f.delta('start_charging', { value: false, source: 'rpc' });
          }
          f.setNow(NOW + 2299);
          f.client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({ id: frame.id,
            src: 'synthetic-evse', dst: frame.src,
            result: { value: ownValue, source: 'rpc', last_update_ts: (NOW + 1000) / 1000 } })), {});
          fenced = !f.adapter.snapshot().controlReady;
          assert.equal(f.adapter.snapshot().fields.start_charging.value, !ownValue,
            'The pre-event query must not confirm even our own accepted command');
        });
        return;
      }
      if (scenario === 'rejected recovery') {
        f.writes.push({ ...frame, topic, options }); done?.();
        queueMicrotask(() => f.client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({ id: frame.id,
          src: 'synthetic-evse', dst: frame.src, error: { code: -1, message: 'synthetic read failure' } })), {}));
        return;
      }
    }
    publish(topic, payload, options, done);
  };
  const result = await controller.update({ enabled: true, takeover: controller.status().takeover.token,
    plan: { id: 'late-notification', deadlineAt: NOW + 7200_000,
      periods: [{ startAt: scenario === 'own Stop' ? NOW + 3600_000 : NOW, endAt: null }] } });
  assert.equal(fenced, true);
  assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, 1, 'Never replay the mutation');
  if (scenario === 'external Stop') {
    assert.equal(result.manual?.kind, 'stop'); assert.equal(f.fields.start_charging, false);
  } else if (scenario === 'rejected recovery') {
    assert.equal(saved.pending?.stage, 'accepted'); assert.equal(result.reason, 'evse-command-unconfirmed');
    assert.equal(f.adapter.snapshot().controlReady, false);
  } else {
    assert.equal(saved.pending, null, 'The already accepted command is confirmed by a later correlated query');
    assert.equal(result.manual, null); assert.equal(result.takeover.state, 'confirmed');
    assert.equal(f.adapter.snapshot().controlReady, true);
    assert.equal(f.adapter.snapshot().fields.start_charging.measuredAt, NOW + 1000);
    assert.ok(f.adapter.snapshot().fields.start_charging.readback.requestedAt >= NOW + 2121);
  }
  assert.ok(reads >= 2 && reads <= 4, 'Recovery has a bounded number of read-only queries');
});

test('a witnessed false-to-true pair revokes a prepared automatic takeover even when native scalars are unchanged', async t => {
  const f = fixture(t, { limiterEnabled: false }); f.sources.set('start_charging', 'sys'); await f.ready();
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true }); t.after(() => controller.close());
  await controller.update({ enabled: false });
  const token = controller.status().takeover.token;
  f.setNow(NOW + 125); f.delta('start_charging', { value: false });
  f.setNow(NOW + 250); f.delta('start_charging', { value: true });
  await f.adapter.refresh({ force: true });
  assert.notEqual(controller.status().takeover.token, token);
  const result = await controller.update({ enabled: true, takeover: token });
  assert.equal(result.takeover.state, 'blocked');
  assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, 0);
});

for (const transition of ['connected work', 'disconnect', 'replug'])
test(`confirmed permission remains distinct from pending ${transition} readback`, async t => {
  const f = fixture(t, { limiterEnabled: false }); f.fields.start_charging = false;
  f.sources.set('start_charging', 'rpc'); await f.ready();
  let saved;
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
    saveState: value => { saved = structuredClone(value); } }); t.after(() => controller.close());
  await controller.update({ enabled: false });
  const refresh = f.adapter.refresh; let events = 0; const readiness = [];
  f.adapter.refresh = async options => {
    await refresh(options);
    if (!f.writes.some(row => row.method === 'Boolean.Set') || events >= 2) return;
    f.setNow(f.now() + 1);
    if (transition === 'connected work') f.delta('work_state', { value: events ? 'charger_charging' : 'charger_wait' });
    else {
      f.delta('work_state', { value: 'charger_free' });
      if (transition === 'replug') { f.setNow(f.now() + 1); f.delta('work_state', { value: 'charger_charging' }); }
    }
    readiness.push(f.adapter.snapshot().controlReady);
    events++;
  };
  f.setNow(NOW + 1000);
  const result = await controller.update({ enabled: true, takeover: controller.status().takeover.token,
    plan: { id: 'synthetic-work-overlap', deadlineAt: NOW + 7200_000, periods: [{ startAt: NOW, endAt: null }] } });
  assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, 1);
  assert.equal(f.adapter.snapshot().fields.start_charging.value, true, 'Permission has a correlated native readback');
  if (transition === 'connected work') {
    assert.equal(saved.pending, null, 'An unrelated connected-state query cannot erase permission confirmation');
    assert.equal(result.takeover.state, 'confirmed');
    assert.equal(result.manual, null);
    assert.ok(readiness.length > 0 && readiness.every(value => value === false),
      'Pending work readback still fences subsequent mutation until the queued query settles');
  } else {
    assert.equal(result.takeover.state, 'blocked');
    assert.equal(saved.pending?.stage, 'accepted', 'A changed physical session cannot confirm the old scoped command');
  }
});

for (const outcome of ['connected work', 'external Stop', 'external current', 'source-only current', 'native schedule', 'fault'])
test(`automatic takeover waits for final work readback: ${outcome}`, async t => {
  const f = fixture(t, { limiterEnabled: false }); f.fields.start_charging = false;
  f.sources.set('start_charging', 'rpc'); await f.ready();
  let saved;
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
    saveState: value => { saved = structuredClone(value); } }); t.after(() => controller.close());
  await controller.update({ enabled: false });
  const refresh = f.adapter.refresh, publish = f.client.publish;
  let injected = false, hold = false, release, resolved = false;
  f.client.publish = (topic, payload, options, done) => {
    const frame = JSON.parse(payload);
    if (hold && frame.method === 'Enum.GetStatus') {
      release = () => { hold = false; publish(topic, payload, options, done); }; return;
    }
    publish(topic, payload, options, done);
  };
  f.adapter.refresh = async options => {
    await refresh(options);
    if (injected || !f.writes.some(row => row.method === 'Boolean.Set')) return;
    injected = true; hold = true; f.setNow(f.now() + 1);
    f.delta('work_state', { value: 'charger_wait' });
  };
  f.setNow(NOW + 1000);
  const action = controller.update({ enabled: true, takeover: controller.status().takeover.token,
    plan: { id: 'held-final-work-read', deadlineAt: NOW + 7200_000,
      periods: [{ startAt: NOW, endAt: null }] } }).then(value => { resolved = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  const currentBefore = f.adapter.snapshot().fields.current_limit;
  try {
    assert.equal(saved.pending, null, 'The acknowledged permission already has its own correlated readback');
    assert.equal(f.adapter.snapshot().controlReady, false, 'The held work read still blocks all new writes');
    assert.equal(resolved, false, 'The explicit action must wait for its bounded final readiness query');
    assert.equal(typeof release, 'function');
    f.setNow(f.now() + 1);
    if (outcome === 'external Stop') f.delta('start_charging', { value: false, source: 'rpc' });
    if (outcome === 'external current') f.delta('current_limit', { value: 10, source: 'rpc' });
    if (outcome === 'source-only current') f.delta('current_limit', { source: 'rpc' });
    if (outcome === 'native schedule') { f.schedules.jobs.push({ id: 1, enable: true, timespec: '0 0 * * * *', calls: [] }); f.schedules.rev++; }
    if (outcome === 'fault') f.delta('work_state', { value: 'synthetic_fault' });
  } finally { release?.(); }
  const result = await action;
  assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, 1, 'Readback recovery never repeats Start');
  assert.equal(saved.pending, null, 'Later evidence does not rewrite the confirmed command as uncertain');
  if (outcome === 'connected work') {
    assert.equal(result.takeover.state, 'confirmed'); assert.equal(result.manual, null);
    assert.equal(f.adapter.snapshot().controlReady, true);
  } else {
    assert.equal(result.takeover.state, 'blocked');
    if (outcome === 'external Stop') assert.equal(result.manual?.kind, 'stop');
    if (outcome === 'external current') assert.equal(f.fields.current_limit, 10);
    if (outcome === 'source-only current') {
      const currentAfter = f.adapter.snapshot().fields.current_limit;
      assert.equal(currentAfter.value, currentBefore.value);
      assert.equal(currentAfter.measuredAt, currentBefore.measuredAt,
        'A newer native instruction still revokes takeover when the current value and native clock are unchanged');
      assert.equal(currentAfter.commandSource, 'rpc');
    }
  }
});


test('an explicit null source survives a matching readback which omits origin', async t => {
  const f = fixture(t); f.sources.set('start_charging', 'rpc'); await f.ready();
  f.setNow(NOW + 1000); f.delta('start_charging', { source: null }); f.sources.delete('start_charging');
  await f.adapter.refresh({ force: true });
  assert.equal(f.adapter.snapshot().fields.start_charging.commandSource, null);
  assert.equal(f.adapter.snapshot().fields.start_charging.measuredAt, NOW);
  await f.adapter.refresh({ force: true });
  assert.equal(f.adapter.snapshot().fields.start_charging.commandSource, null);
});

for (const value of [null, { total_power: 0 }])
test(`a ${value === null ? 'removed' : 'partial'} phase value becomes unavailable until a complete new native sample`, async t => {
  const f = fixture(t); await f.ready();
  const old = structuredClone(f.adapter.snapshot().fields.phase_info);
  f.setNow(NOW + 1000); f.delta('phase_info', { value }, { apply: false });
  assert.equal(f.adapter.readings().ev2_active_power.available, false);
  assert.equal(f.adapter.normalize().phaseCurrentA.available, false);
  assert.equal(f.adapter.liveCurrents().healthy, false);
  assert.equal(f.adapter.snapshot().fields.phase_info.measuredAt, old.measuredAt);
  await f.adapter.refresh({ force: true });
  assert.equal(f.adapter.readings().ev2_active_power.available, true);
  assert.equal(f.adapter.snapshot().fields.phase_info.measuredAt, NOW + 1000);
});

test('complete held phase readback restores load evidence after invalidation without new physical proof', async t => {
  const f = fixture(t); f.setSourceTime('phase_info', NOW); await f.ready();
  f.setNow(NOW + 1000); f.delta('phase_info', { value: null }, { apply: false });
  assert.equal(f.adapter.liveCurrents().healthy, false);
  await f.adapter.refresh({ force: true });
  assert.equal(f.adapter.liveCurrents().healthy, true);
  assert.equal(f.adapter.readings().ev2_current_l1.available, true);
  const field = f.adapter.snapshot().fields.phase_info;
  assert.equal(field.measuredAt, NOW);
  assert.equal(field.invalidatedAt, NOW + 1000, 'A held reply does not erase the physical observation gap');
  assert.equal(field.readback.receivedAt, NOW + 1000);
});

for (const role of ['work_state', 'current_limit'])
test(`an unresolved same-second ${role} delta survives adapter restart before readback`, async t => {
  const f = fixture(t); f.fields[role] = role === 'work_state' ? 'charger_free' : 6; await f.ready();
  f.setNow(NOW + 250); f.delta(role, { value: role === 'work_state' ? 'charger_charging' : 16 });
  const before = f.adapter.snapshot();
  assert.equal(before.fields[role].measuredAt, NOW);
  f.restartAdapter(); await f.ready();
  const result = f.adapter.snapshot();
  assert.equal(result.fields[role].value, role === 'work_state' ? 'charger_charging' : 16);
  assert.equal(result.controlReady, true);
  assert.equal(result.notificationRevision, before.notificationRevision, 'Restart retains the instruction fence');
  if (role === 'work_state') assert.equal(result.session.sessionId, before.session.sessionId);
});


test('source-only unknown value and removed scalar recover from fresh readback without a new value clock', async t => {
  const f = fixture(t); await f.ready();
  f.client.emit('offline'); f.client.emit('connect'); f.setNow(NOW + 1000);
  f.delta('start_charging', { source: 'sys' });
  f.client.emit('message', 'test/evse/online', Buffer.from('true'), {});
  await f.adapter.refresh({ force: true });
  assert.equal(f.adapter.snapshot().controlReady, true);
  assert.equal(f.adapter.snapshot().fields.start_charging.measuredAt, NOW);
  assert.equal(f.adapter.snapshot().permissionEvents.length, 1);
  assert.equal(f.adapter.snapshot().permissionEvents[0].value, null, 'An unknown baseline supplies no borrowed permission value');
  f.setNow(NOW + 2000); f.delta('start_charging', { value: null }, { apply: false });
  assert.equal(f.adapter.snapshot().controlReady, false);
  await f.adapter.refresh({ force: true });
  assert.equal(f.adapter.snapshot().controlReady, true);
  assert.equal(f.adapter.snapshot().fields.start_charging.measuredAt, NOW);
  assert.equal(f.adapter.snapshot().fields.start_charging.value, true);
});

test('invalidated physical zero cannot confirm an owned pause or restore the higher pilot from a held native cache', async t => {
  const f = fixture(t, { limiterEnabled: false });
  f.fields.current_limit = 6; f.fields.start_charging = false; f.fields.work_state = 'charger_pause';
  f.fields.phase_info.total_power = 0;
  for (const phase of ['phase_a', 'phase_b', 'phase_c']) { f.fields.phase_info[phase].current = 0; f.fields.phase_info[phase].power = 0; }
  await f.ready();
  const scope = f.adapter.snapshot().session;
  const initial = { version: 1, association: f.adapter.association, sessionId: scope.sessionId,
    phase: 'waiting', reason: 'economic-wait', manual: null, ownedPause: true, pending: null, lastStart: false, lastStartAt: NOW,
    execution: { planId: 'synthetic-pause', deadlineAt: NOW + 7200_000, finalStartAt: NOW + 3600_000,
      periods: [{ startAt: NOW + 3600_000, endAt: null }] } };
  const observer = createShellyController({ adapter: f.adapter, initialState: initial, clock: f.now }); t.after(() => observer.close());
  assert.equal(observer.status().pauseConfirmed, true);
  f.setNow(NOW + 1000); f.delta('phase_info', { value: null }, { apply: false });
  assert.equal(observer.status().pauseConfirmed, false, 'A removed meter is unknown, including through direct snapshot consumers');
  f.setSourceTime('phase_info', NOW);
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
    initialState: { ...initial, manual: { kind: 'stop', detectedAt: NOW }, currentTest: {
      id: 'synthetic-notification-test', connectedAt: scope.connectedAt, sessionId: scope.sessionId, phase: 'active',
      startedAt: NOW, expiresAt: NOW + 90_000, confirmedAt: NOW, originalCurrentA: 16, appliedCurrentA: 6,
      permissionAt: NOW, restoreCurrentA: null, pending: null } } }); t.after(() => controller.close());
  await controller.update({ enabled: false });
  assert.equal(f.fields.current_limit, 6);
  assert.equal(f.writes.filter(row => row.method === 'Number.Set').length, 0);
  assert.equal(f.adapter.readings().ev2_active_power.available, true, 'A correlated reply confirms current load state');
  assert.equal(observer.status().pauseConfirmed, false, 'That held reply does not restore missing physical proof');
  f.setNow(NOW + 2000); f.setSourceTime('phase_info', NOW + 2000); await controller.update({ enabled: false });
  assert.equal(f.fields.current_limit, 16, 'A new complete physical zero satisfies restoration');
});


test('coarse native value clocks cannot collapse a witnessed disconnect and reconnect', async t => {
  const f = fixture(t); await f.ready();
  const original = f.adapter.snapshot().session.sessionId;
  f.setNow(NOW + 125); f.delta('work_state', { value: 'charger_free', last_update_ts: NOW / 1000 });
  f.setNow(NOW + 250); f.delta('work_state', { value: 'charger_charging', last_update_ts: NOW / 1000 });
  await f.adapter.refresh({ force: true });
  const result = f.adapter.snapshot();
  assert.equal(result.controlReady, true);
  assert.equal(result.session.connected, true);
  assert.notEqual(result.session.sessionId, original);
  assert.equal(result.session.connectedAt, NOW + 250);
  assert.equal(result.session.lastDisconnectedAt, NOW + 125);
  assert.equal(result.session.valueUpdatedAt, NOW);
  assert.equal(result.fields.work_state.measuredAt, NOW);
});

test('a source instruction without a known value remains unresolved after current readback instead of acquiring ownership', async t => {
  const f = fixture(t, { limiterEnabled: false }); await f.ready();
  const sessionId = f.adapter.snapshot().session.sessionId;
  const controller = createShellyController({ adapter: f.adapter, clock: f.now, canControl: () => true,
    initialState: { version: 1, association: f.adapter.association, sessionId, phase: 'off', manual: null,
      pending: null, ownedPause: false, lastStart: true, lastStartAt: NOW } }); t.after(() => controller.close());
  f.client.emit('offline'); f.client.emit('connect'); f.setNow(NOW + 1000);
  f.delta('start_charging', { source: 'rpc' });
  f.client.emit('message', 'test/evse/online', Buffer.from('true'), {}); await f.adapter.refresh({ force: true });
  const result = await controller.update({ enabled: false });
  assert.equal(result.manual.kind, 'instruction-unconfirmed');
  assert.equal(result.reason, 'evse-command-unconfirmed');
  assert.equal(result.ownsInstruction, false);
  assert.equal(f.writes.filter(row => row.method === 'Boolean.Set').length, 0);
});
