import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { ElectricityAccumulator } from '../src/domain/electricity.js';
import { recordedChargingEnergy } from '../src/charging/energy.js';
import { pendingEnergyObservations } from '../src/storage/pending-energy.js';
import { recordedEnergyGroups } from '../src/storage/energy-history.js';
import { addRecordedEnergy } from '../src/app/chart-energy.js';
import { Envelope, getChartData, chartRange } from '../src/app/chart-data.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { chargingConfiguration } from '../src/charging/config.js';
import { createShellyEvseAdapter } from '../src/charging/shelly-evse.js';

const HOUR = 3_600_000, START = Date.parse('2026-09-01T00:00:00Z');
const near = (actual,expected) => assert(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);
function fixture(t) {
  const store = new Store(':memory:'); t.after(()=>store.close());
  return {store,recorder:new Recorder(store)};
}
function interval(index,power,{period=15_000,prefix='ev1',quality=['estimated'],energies}={}) {
  const powers = Array.isArray(power) ? power : [power,0,0];
  return {source:prefix.startsWith('ev2')?'shelly-evse':'easee',device:'synthetic-charger',prefix,
    start:START+index*period,end:START+(index+1)*period,powers,
    energies:energies ?? powers.map(value=>value*period/HOUR),quality};
}
function sample(at,power,{sourceTime=at}={}) {
  return [['active_power',power,'kW'],...['current_l1','current_l2','current_l3'].map((signal,i)=>[signal,i===0?1:0,'A'])]
    .map(([signal,value,unit])=>({source:'easee',device:'synthetic-charger',signal:`ev1_${signal}`,
      sourceTime,receivedAt:at,value,unit,quality:[]}));
}
function plotted(store,signal,from,to,now=to) {
  const envelope = new Envelope(from,to,100);
  addRecordedEnergy({store,range:{from,to},now,input:'providers',envelopes:{[signal]:envelope},timing:{addEnergy(){}}});
  return envelope.values();
}

test('one hour of charger idle noise retains every Wh in one cohort and its durable tail',t=>{
  for (const [name,powerAt] of [['zero',()=>0],['steady 2 W',()=>.002],['1/3 W',i=>i%2?.001:.003],['0/2 W',i=>i%2?0:.002]]) {
    const {store,recorder}=fixture(t);
    let expected=0;
    for(let i=0;i<240;i++) {
      const next=interval(i,powerAt(i));expected+=next.energies[0];recorder.recordEnergy(next);
    }
    assert.equal(store.observations().length,3,name);
    const energy=recordedChargingEnergy(store,{id:'charger1',start:START,end:START+HOUR});
    near(energy.gridKwh,expected);assert.equal(energy.coveredMs,HOUR);assert(!energy.incomplete);
    const rows=pendingEnergyObservations(store,{now:START+HOUR});
    assert.equal(rows.length,3);assert.equal(rows[0].source_time,START+HOUR);
    assert.equal(recorder.flush(START+HOUR,{force:true}).length,3);
    near(store.observations().reduce((sum,row)=>sum+row.value,0),expected);
    assert.equal(store.observations().length,6);
    const parameters=recorder.status(START+HOUR).parameters;
    assert(parameters.every(row=>row.threshold===.010 && row.thresholdUnit==='kW'));
  }
});

test('real Easee integration compacts held source clocks and zero phase-weight shortcuts without losing provenance',t=>{
  for (const waveform of ['held-zero','zero-and-2W-blocks']) {
    const {store,recorder}=fixture(t),accumulator=new ElectricityAccumulator();
    let expected=0;
    for(let i=0;i<=240;i++) {
      const at=START+i*15_000,power=waveform==='held-zero'?0:Math.floor(i/4)%2?.002:0;
      const sourceTime=waveform==='held-zero'?START+Math.floor(i/4)*60_000:at;
      const accepted=accumulator.sample(sample(at,power,{sourceTime}),at);
      assert.equal(accepted.gaps.length,0);
      for(const next of accepted.intervals) {expected+=next.energies.reduce((a,b)=>a+b,0);recorder.recordEnergy(next);}
    }
    assert.equal(store.observations().length,3,waveform);
    const tail=pendingEnergyObservations(store,{now:START+HOUR});
    const quality=JSON.parse(tail[0].quality);
    if(waveform==='held-zero') {
      assert(quality.includes('held_source_values'));assert(quality.includes('last_reported_observations'));
    } else assert(quality.includes('current_phase_weights'));
    const recorded=recordedChargingEnergy(store,{id:'charger1',start:START,end:START+HOUR});
    near(recorded.gridKwh,expected);assert.equal(recorded.coveredMs,HOUR);
    assert(plotted(store,'charger_power',START+30*60_000,START+HOUR).some(row=>Number.isFinite(row.y)));
    assert(!plotted(store,'charger_power',START+30*60_000,START+HOUR,START+30*60_000).some(row=>Number.isFinite(row.y)),
      'The later open tail must not leak into an earlier receipt cutoff');
  }
});

test('native counter quantization uses its own power reference while preserving exact meter energy and phase sums',t=>{
  for(const watts of [2,6000]) {
    const {store,recorder}=fixture(t);let total=0;
    for(let i=0;i<240;i++) {
      const delta=i%2===0?0:watts/1000*30_000/HOUR;total+=delta;
      recorder.recordEnergy(interval(i,[watts/3000,watts/3000,watts/3000],{prefix:'ev2',
        energies:[delta/3,delta/3,delta-delta/3-delta/3],quality:['native_counter','phase_allocation_estimated']}));
    }
    assert.equal(store.observations().length,3);
    assert(recorder.status(START+HOUR).parameters.every(row=>row.hour.normalizedRmsChange===0),
      'Native counter quantization must not appear as instantaneous power variation');
    near(recordedChargingEnergy(store,{id:'charger2',start:START,end:START+HOUR}).gridKwh,total);
    const groups=[...recordedEnergyGroups(store,{from:START,to:START+HOUR,now:START+HOUR,input:'providers'})];
    near(groups.filter(row=>row.prefix==='ev2').reduce((sum,row)=>sum+row.values.reduce((a,b)=>a+b,0),0),total);
    assert.equal(recorder.flush(START+HOUR,{force:true}).length,3);
    assert.equal(store.observations().length,6);
  }
});

test('native instantaneous selection survives restart, rollback, gaps and real phase transitions',t=>{
  const {store,recorder:first}=fixture(t);let recorder=first;
  const put=(i,powers)=>recorder.recordEnergy(interval(i,powers,{prefix:'ev2',energies:powers.map(()=>0),quality:['native_counter']}));
  put(0,[2,0,0]);put(1,[2,0,0]);recorder=new Recorder(store);
  assert.equal(put(2,[2,0,0]).saved,false);
  const checkpoint=store.db.prepare('SELECT key,value FROM state ORDER BY key').all();
  assert.throws(()=>store.transaction(()=>{put(3,[0,2,0]);throw Error('synthetic interruption');}),/interruption/);
  assert.deepEqual(store.db.prepare('SELECT key,value FROM state ORDER BY key').all(),checkpoint);
  assert.equal(put(3,[0,2,0]).saved,true);
  const rows=store.observations({signal:'ev2_energy_l1'});
  assert.equal(rows.at(-2).raw.intervalEnd,START+3*15_000);
  assert.equal(rows.at(-1).raw.intervalStart,START+3*15_000);
  assert.equal(put(4,[0,2,0]).saved,false);
  assert.equal(put(5,[0,0,0]).saved,true);
  assert.equal(put(6,[0,0,0]).saved,false);
  recorder.energyGap({source:'shelly-evse',device:'synthetic-charger',prefix:'ev2',
    start:START+7*15_000,end:START+8*15_000,quality:['mqtt-disconnected']});
  assert.equal(put(8,[0,0,0]).saved,true);
  const groups=[...recordedEnergyGroups(store,{from:START,to:START+9*15_000,now:START+9*15_000,input:'providers'})];
  assert(groups.some(row=>row.start===START+7*15_000 && row.end===START+8*15_000 && row.values.every(value=>value===null)));
  assert(groups.filter(row=>row.values.every(Number.isFinite)).every(row=>row.end<=START+7*15_000||row.start>=START+8*15_000));
});

test('idle compression preserves real measurement-basis, aged-value and availability changes',t=>{
  for(const flag of ['reported_active_power','voltage_current_power_estimate','held_power_with_live_telemetry',
    'device_telemetry_confirmed','last_reported_phase_weights','last_reported_zero_phase_weights','local_ocpp','missing']) {
    const {store,recorder}=fixture(t);
    recorder.recordEnergy(interval(0,.002));recorder.recordEnergy(interval(1,.002));
    const result=recorder.recordEnergy(interval(2,.002,{quality:['estimated',flag]}));
    assert.equal(result.saved,true,flag);
    const rows=store.observations({signal:'ev1_energy_l1'});
    assert.equal(rows.at(-2).raw.intervalEnd,START+30_000,flag);
    assert.equal(rows.at(-1).raw.intervalStart,START+30_000,flag);
    assert(rows.at(-1).quality.includes(flag));
  }
  const {store,recorder}=fixture(t);
  recorder.recordEnergy(interval(0,.002,{quality:['estimated','reported_active_power','current_phase_weights']}));
  recorder.recordEnergy(interval(1,.002,{quality:['estimated','reported_active_power','current_phase_weights']}));
  assert(recorder.recordEnergy(interval(2,.002,{quality:['estimated','reported_active_power','voltage_current_phase_weights']})).saved);
  assert.equal(store.observations({signal:'ev1_energy_l1'}).at(-1).raw.intervalStart,START+30_000);
});

async function shellyFixture(t) {
  const {store,recorder}=fixture(t),client=new EventEmitter();let now=START;
  const config=chargingConfiguration({chargers:{charger2:{enabled:true,deviceId:'synthetic-evse',topicPrefix:'test/evse',
    model:'synthetic-model',firmware:'synthetic-firmware',verified:true,connectedStates:['paused'],disconnectedStates:['free'],chargingStates:['charging']}}}).chargers.charger2;
  const phase={total_power:2,total_act_energy:0,phase_a:{voltage:230,current:0,power:2},
    phase_b:{voltage:230,current:0,power:0},phase_c:{voltage:230,current:0,power:0}};
  const fields={current_limit:16,start_charging:false,work_state:'paused',phase_info:phase};
  const ids=Object.fromEntries(Object.keys(fields).map((role,i)=>[role,i+200]));
  client.subscribe=(topics,_options,cb)=>cb(null,topics.map(topic=>({topic,qos:0})));
  client.publish=(_topic,payload,_options,cb)=>{
    const frame=JSON.parse(payload);let result;
    if(frame.method==='Shelly.GetDeviceInfo')result={id:'synthetic-evse',model:'synthetic-model',fw_id:'synthetic-firmware'};
    else if(frame.method==='Service.GetConfig')result={id:0,auto_balance:{enable:false},auto_charge:true,global_charge_limit:0,global_time_limit:0};
    else if(frame.method==='Schedule.List')result={rev:1,jobs:[]};
    else if(frame.method==='Service.GetStatus')result={state:'running'};
    else if(frame.method.endsWith('.GetConfig'))result={id:ids[frame.params.role],owner:'service:0',access:'crw',min:6,max:16,meta:{ui:{step:1}}};
    else result={value:structuredClone(fields[frame.params.role]),last_update_ts:now/1000};
    cb?.();queueMicrotask(()=>client.emit('message',`${frame.src}/rpc`,Buffer.from(JSON.stringify({id:frame.id,src:'synthetic-evse',dst:frame.src,result})),{}));
  };
  const adapter=createShellyEvseAdapter({config,broker:{address:'mqtt://synthetic'},client,store,engine:{recorder},clock:()=>now});
  t.after(()=>adapter.close());client.emit('connect');await adapter.refresh();
  return {store,recorder,notify(at){now=at;client.emit('message','test/evse/events/rpc',Buffer.from(JSON.stringify({src:'synthetic-evse',
    method:'NotifyStatus',params:{[`object:${ids.phase_info}`]:{value:phase,last_update_ts:now/1000}}})),{});}};
}

test('real paused Shelly adapter holds flat native counters to three history rows at 5 s and 15 s cadence',async t=>{
  for(const period of [5000,15000]) {
    const {store,recorder,notify}=await shellyFixture(t);
    for(let elapsed=period;elapsed<=HOUR;elapsed+=period)notify(START+elapsed);
    assert.equal(store.observations().length,3,`${period} ms reports`);
    const recorded=recordedChargingEnergy(store,{id:'charger2',start:START,end:START+HOUR});
    assert.equal(recorded.gridKwh,0);assert.equal(recorded.coveredMs,HOUR);
    assert.equal(pendingEnergyObservations(store,{now:START+HOUR}).length,3);
    assert(plotted(store,'charger2_power',START,START+HOUR).some(row=>row.y===0));
    assert.equal(recorder.flush(START+HOUR,{force:true}).length,3);
    assert(store.observations().every(row=>row.value===0));
  }
});

test('scalar report revision changes with real H66 confirmations while observation history remains compact',t=>{
  const {store,recorder}=fixture(t);
  const put=at=>recorder.record({source:'husdata-h66',device:'synthetic-pump',signal:'auxiliary_output',unit:'%',value:0,
    sourceTime:at,receivedAt:at,quality:[]});
  put(START);const before=recorder.status(START);
  put(START+15_000);const after=recorder.status(START+15_000);
  assert.equal(store.observations().length,1);assert.equal(before.historyRevision,after.historyRevision);
  assert.notEqual(before.sourceReportRevision,after.sourceReportRevision);
  assert(!after.sourceReportRevision.includes('synthetic-pump'));
});

test('real event-only circulation feedback stays visible days later and ends at an actual disconnect',t=>{
  const store=new Store(':memory:'),recorder=new Recorder(store),topic='synthetic/dhwr/power',ingested=[],published=[];
  let now=START;
  const settings=equipmentConfiguration({devices:[{id:'dhwr',label:'Circulation',kind:'power',
    connection:`mqtt:${topic}`,record:false,max_age_seconds:0}]});
  const capture=createEquipmentCapture({store,settings,engine:{clock:()=>now,recorder,ingest:row=>ingested.push(row)},
    publish:(...args)=>{published.push(args);return Promise.resolve();}});
  t.after(()=>{capture.close();store.close();});capture.setConnected(true);capture.confirmSubscriptions([topic]);
  capture.receive(topic,'0');now+=24*HOUR;capture.receive(topic,'0');
  const initial=store.observations({signal:'dhwr_active'});
  assert.equal(initial.length,1);assert.equal(initial[0].raw.eventOnly,true);assert.equal(initial[0].raw.maxAgeMs,0);
  const date='2026-09-03',from=chartRange({startDate:date,now:START+3*24*HOUR}).from;
  now=from+HOUR;
  const chart=()=>getChartData({store,input:'mqtt',startDate:date,endDate:date,now,view:'hot_water'}).series.dhwr_active;
  const held=chart();
  assert(held.some(row=>row.x===from&&row.y===0&&row.observedAt===START),
    'A narrow chart days after the source event must retain the zero feedback line');
  assert(held.some(row=>row.x>=now-1&&row.y===0));
  const disconnectedAt=now;capture.setConnected(false);capture.setConnected(true);capture.confirmSubscriptions([topic]);
  now+=60_000;capture.receive(topic,'0',{retain:true});
  assert(chart().some(row=>row.x===disconnectedAt&&row.y===null));
  assert(!chart().some(row=>row.x>disconnectedAt&&row.y!==null),'Retained replay cannot restore the event-only line');
  const recoveredAt=now;capture.receive(topic,'0');now+=60_000;
  assert(chart().some(row=>row.x===recoveredAt&&row.y===0));
  assert.deepEqual(ingested,[]);assert.deepEqual(published,[]);
});
