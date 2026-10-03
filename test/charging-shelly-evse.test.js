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
  additiveCurrentVerified:true,marginA:[0,0,0],...extra}}}).chargers.charger2);
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
  const client=new EventEmitter(), values=new Map(), writes=[], energy=[], gaps=[], voltages=[], events=[];
  const roleTypes={current_limit:'number',start_charging:'boolean',work_state:'enum',phase_info:'object'};
  const roles=Object.keys(roleTypes), ids=Object.fromEntries(roles.map((role,i)=>[role,i+200]));
  const settingClock = new Map();
  const fields={current_limit:16,start_charging:true,work_state:'charger_charging',phase_info:{total_power:8.28,total_act_energy:0,phase_a:{voltage:230,current:12,power:2.76},phase_b:{voltage:230,current:12,power:2.76},phase_c:{voltage:230,current:12,power:2.76}}};
  client.subscribe=(topics,_opts,cb)=>{client.topics=topics;cb(null,topics.map(topic=>({topic,qos:0})));};
  client.publish=(topic,payload,options,cb)=>{
    const frame=JSON.parse(payload);writes.push({...frame,topic,options});let result;
    if(frame.method==='Shelly.GetDeviceInfo')result={id:'synthetic-evse',model:'synthetic-model',fw_id:'synthetic-firmware'};
    else if(frame.method==='Service.GetConfig')result=structuredClone(service);
    else if(frame.method==='Schedule.List')result=structuredClone(schedules);
    else if(frame.method==='Schedule.Update') {
      const job=schedules.jobs.find(job=>job.id===frame.params.id);
      assert.ok(job);assert.deepEqual(frame.params,{id:job.id,enable:false});job.enable=false;result={rev:++schedules.rev};
    }
    else if(frame.method==='Service.GetStatus')result=structuredClone(serviceStatus);
    else if(frame.method.endsWith('.GetConfig'))result={id:ids[frame.params.role],owner:'service:0',access:'crw',min:6,max:16,meta:{ui:{step:1}},options:['charger_free','charger_wait','charger_pause','charger_charging','charger_end']};
    else if(frame.method.endsWith('.Set')) {fields[frame.params.role]=frame.params.value;settingClock.set(frame.params.role,{value:frame.params.value,at:now});result=null;}
    else {
      const role=frame.params.role, value=fields[role];
      if (['start_charging','current_limit'].includes(role)) {
        if (settingClock.get(role)?.value !== value) settingClock.set(role,{value,at:now});
        result={value,last_update_ts:settingClock.get(role).at/1000};
      } else result={value:structuredClone(value),last_update_ts:now/1000};
    }
    cb?.();queueMicrotask(()=>client.emit('message',`${frame.src}/rpc`,Buffer.from(JSON.stringify({id:frame.id,src:'synthetic-evse',dst:frame.src,result})),{}));
  };
  const store={getState:key=>structuredClone(values.get(key)),setState:(key,value)=>{if(failSave)throw Error('disk');values.set(key,structuredClone(value));},transaction:fn=>fn(),
    event:(type,payload,at)=>events.push({type,payload,at})};
  const engine={recorder:{recordEnergy:value=>energy.push(value),energyGap:value=>gaps.push(value)},voltage:{ingest:value=>voltages.push(value)}};
  const adapter=createShellyEvseAdapter({config:config(extra),broker:{address:'mqtt://synthetic'},client,store,engine,clock:()=>now,canControl:()=>authority});
  t.after(()=>adapter.close());
  return {adapter,client,fields,writes,energy,gaps,voltages,events,values,service,serviceStatus,schedules,now:()=>now,setNow:value=>now=value,setAuthority:value=>authority=value,setFail:value=>failSave=value,
    setSourceTime(role, at) { settingClock.set(role, { value: fields[role], at }); },
    async ready(){client.emit('connect');client.emit('message','test/evse/online',Buffer.from('true'),{retain:true});await adapter.refresh();},
    notify(role,value,packet={}){if (['start_charging','current_limit'].includes(role) && !packet.retain) settingClock.set(role,{value,at:now});client.emit('message','test/evse/events/rpc',Buffer.from(JSON.stringify({src:'synthetic-evse',method:'NotifyStatus',params:{[`${roleTypes[role]}:${ids[role]}`]:{value,last_update_ts:now/1000}}})),packet);}};
}
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
 const f=fixture(t,{limiterEnabled:true});await f.ready();f.setNow(NOW+1000);f.notify('work_state','unknown-fault');
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
test('a lower native current choice survives explicit automatic takeover',async t=>{
 const f=fixture(t,{limiterEnabled:true});f.fields.current_limit=8;await f.ready();
 const controller=createShellyController({adapter:f.adapter,clock:()=>NOW,canControl:()=>true});t.after(()=>controller.close());
 await controller.update({enabled:false,allocation:{}});
 const result=await controller.update({enabled:true,takeover:controller.status().takeover.token,plan:{periods:[{startAt:NOW,endAt:null}]},allocation:{}});
 assert.equal(result.takeover.state,'confirmed');
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
