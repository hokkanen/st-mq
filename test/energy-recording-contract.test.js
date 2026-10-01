import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { seedVoltage } from './voltage-fixture.js';
import { Recorder } from '../src/storage/recorder.js';
import { pendingEnergyObservations } from '../src/storage/pending-energy.js';
import { recordedEnergyStart } from '../src/storage/energy-history.js';
import { addRecordedEnergy, recordedEnergyGroups } from '../src/app/chart-energy.js';
import { recordedChargingEnergy } from '../src/charging/energy.js';
import { householdSpans, householdReference } from '../src/charging/history.js';
import { Envelope } from '../src/app/chart-data.js';

const HOUR = 3_600_000, start = Date.parse('2026-09-01T00:00:00Z');
const near = (a,b) => assert(Math.abs(a-b)<1e-10, `${a} != ${b}`);
function fixture(t) {
  const store = new Store(':memory:'); t.after(()=>store.close());
  return { store, recorder: new Recorder(store) };
}
function record(recorder, prefix, from, to, powers, receivedAt = to) {
  return recorder.recordEnergy({ source: prefix.startsWith('ev2') ? 'shelly-evse' : 'easee', device: 'synthetic-meter',
    prefix, start: from, end: to, powers, energies: powers.map(value=>value*(to-from)/HOUR), quality: [], receivedAt });
}
function project(store, from, to, now) {
  const names = ['property_power','charger_power','charger2_power', ...[1,2,3].map(n=>`ev2_current_l${n}`)];
  const envelopes = Object.fromEntries(names.map(name=>[name,new Envelope(from,to,100)]));
  const credits = [];
  addRecordedEnergy({ store, range: {from,to}, now, input: 'providers', envelopes,
    timing: { addEnergy(...args) { credits.push(args); } } });
  return { series: Object.fromEntries(names.map(name=>[name,envelopes[name].values()])), credits };
}

test('steady multi-day energy remains durable, visible without writes, and available after finalization', t => {
  const { store, recorder } = fixture(t);
  for(let hour=0;hour<50;hour++) record(recorder,'ev1',start+hour*HOUR,start+(hour+1)*HOUR,[1,2,0]);
  assert.equal(store.observations().length,3,'One initial phase cohort; no elapsed-time copies');
  const from=start+24*HOUR,to=from+HOUR,now=start+50*HOUR;
  const before=store.db.prepare('SELECT key,value,updated_at FROM state ORDER BY key').all();
  const plotted=project(store,from,to,now);
  assert(plotted.series.charger_power.some(row=>row.y===3));
  assert.equal(recordedChargingEnergy(store,{id:'charger1',start,end:now}).gridKwh,150);
  assert.deepEqual(store.db.prepare('SELECT key,value,updated_at FROM state ORDER BY key').all(),before);
  assert.equal(store.observations().length,3);
  assert(!project(store,from,to,to).series.charger_power.some(row=>Number.isFinite(row.y)), 'A later durable tail cannot leak into an earlier receipt cutoff');
  recorder.flush(now,{force:true});
  assert.equal(store.observations().length,6);
  assert(project(store,from,to,now).series.charger_power.some(row=>row.y===3),'An interval longer than one day is still selected across a narrow viewport');
});

test('native C2 total alone supplies power and charging credit while phase energy supplies only phase history', t => {
  const {store,recorder}=fixture(t),end=start+HOUR;
  seedVoltage(store, start);
  record(recorder,'ev2',start,end,[6]);
  record(recorder,'ev2-phase',start,end,[1,2,3]);
  const chart=project(store,start,end,end);
  assert(chart.series.charger2_power.some(row=>row.y===6));
  [1,2,3].forEach(n=>near(chart.series[`ev2_current_l${n}`].find(row=>row.y!==null).y,n/.23));
  assert.equal(chart.credits.length,1); assert.equal(chart.credits[0][3],6);
  assert.equal(recordedChargingEnergy(store,{id:'charger2',start,end}).gridKwh,6);
});

test('pending receipt cutoff and overlap conflicts cannot manufacture energy', t => {
  const {store,recorder}=fixture(t);
  record(recorder,'ev2',start,start+HOUR,[2]);
  record(recorder,'ev2',start+HOUR,start+2*HOUR,[2],start+3*HOUR);
  assert.equal(pendingEnergyObservations(store,{now:start+2*HOUR}).length,0);
  assert.equal(pendingEnergyObservations(store,{now:start+3*HOUR}).length,1);
  store.observation({source:'shelly-evse',device:'other-synthetic-meter',signal:'ev2_energy',unit:'kWh',value:1,
    sourceTime:start+2*HOUR,receivedAt:start+2*HOUR,quality:[],raw:{intervalStart:start+HOUR,intervalEnd:start+2*HOUR}});
  const groups=[...recordedEnergyGroups(store,{from:start,to:start+3*HOUR,now:start+3*HOUR,input:'providers'})];
  assert(groups.some(group=>group.conflict));
  const credited=recordedChargingEnergy(store,{id:'charger2',start,end:start+3*HOUR});
  assert.equal(credited.gridKwh,2,'Overlapping committed/pending ownership receives no charging credit');
});

test('shared energy history preserves phase lineage and rejects invalid acquisition evidence', t => {
  const {store,recorder}=fixture(t);
  record(recorder,'ev1',start,start+HOUR,[1,1,1]);
  const good=[...recordedEnergyGroups(store,{from:start,to:start+HOUR,now:start+HOUR,input:'providers'})][0];
  assert.equal(good.observationIds.length,3); assert.equal(good.receivedAt,start+HOUR);
  for (const quality of ['stale','retained','failed','mqtt-disconnected','out_of_order_source_time','future_source_time']) {
    store.observation({source:'shelly-evse',device:`synthetic-${quality}`,signal:'ev2_energy',unit:'kWh',value:0,
      sourceTime:start+HOUR,receivedAt:start+HOUR,quality:[quality],raw:{intervalStart:start,intervalEnd:start+HOUR}});
    const groups=[...recordedEnergyGroups(store,{from:start,to:start+HOUR,now:start+HOUR,input:'providers',prefix:'ev2',device:`synthetic-${quality}`})];
    assert.equal(groups[0].values[0],null,quality);
  }
  for (const marker of ['auditOnly','acquisitionOnly']) {
    store.observation({source:'shelly-evse',device:`synthetic-${marker}`,signal:'ev2_energy',unit:'kWh',value:0,
      sourceTime:start+HOUR,receivedAt:start+HOUR,quality:[],raw:{intervalStart:start,intervalEnd:start+HOUR,[marker]:true}});
    const groups=[...recordedEnergyGroups(store,{from:start,to:start+HOUR,now:start+HOUR,input:'providers',prefix:'ev2',device:`synthetic-${marker}`})];
    assert.equal(groups[0].values[0],null,marker);
  }
});

test('household phase subtraction uses native phase shares and retains an upper estimate when shares are unknown', () => {
  const row=(signal,value)=>({signal,value,unit:'kWh',quality:[],raw:{intervalStart:start,intervalEnd:start+HOUR}});
  const base=[1,2,3].flatMap(n=>[row(`property_energy_l${n}`,4),row(`ev1_energy_l${n}`,0)]);
  const total=row('ev2_energy',3);
  const unknown=householdSpans([...base,total],{voltageV:230})[0];
  assert(unknown.unknownCharger2); unknown.phaseCurrentA.forEach(value=>near(value,4/.23));
  const known=householdSpans([...base,total,row('ev2_energy_l1',1),row('ev2_energy_l2',0),row('ev2_energy_l3',2)],{voltageV:230})[0];
  assert(!known.unknownCharger2); [3,4,2].forEach((kw,index)=>near(known.phaseCurrentA[index],kw/.23));
});

test('household forecast cache refreshes durable energy tails without new observation rows', t => {
  const {store,recorder}=fixture(t);
  const sample=(a,b)=>{record(recorder,'property',a,b,[1,2,3]);record(recorder,'ev1',a,b,[0,0,0]);record(recorder,'ev2',a,b,[0]);};
  sample(start,start+HOUR);
  const first=householdReference(store,{now:start+HOUR,input:'live',voltageV:230,timezone:'UTC'});
  const initialHours=first.entries().length;
  sample(start+HOUR,start+2*HOUR);
  const before=store.observations().length;
  const second=householdReference(store,{now:start+2*HOUR,input:'live',voltageV:230,timezone:'UTC'});
  assert.equal(second,first);
  assert.equal(store.observations().length,before);
  assert.equal(second.entries().length,initialHours+1);
  assert(second.entries().some(entry=>entry.hour===1));
});

test('generic hourly equipment sharing an energy name cannot impersonate or conflict with a physical charger', t => {
  const {store,recorder}=fixture(t),end=start+HOUR;
  const hourly={source:'mqtt-equipment',device:'ev2',signal:'ev2_energy',unit:'kWh',value:0,
    sourceTime:end,receivedAt:end,quality:[],raw:{intervalStart:start,intervalEnd:end,timeBasis:'completed-hour',learningRole:'history-only'}};
  store.observation(hourly);
  assert.equal(recordedEnergyStart(store,'ev2','providers',end),Infinity);
  assert.deepEqual([...recordedEnergyGroups(store,{from:start,to:end,now:end,input:'providers',prefix:'ev2'})],[]);
  assert(!project(store,start,end,end).series.charger2_power.some(row=>Number.isFinite(row.y)));
  const phases=[1,2,3].flatMap(n=>[
    {signal:`property_energy_l${n}`,value:2,unit:'kWh',quality:[],raw:{intervalStart:start,intervalEnd:end}},
    {signal:`ev1_energy_l${n}`,value:0,unit:'kWh',quality:[],raw:{intervalStart:start,intervalEnd:end}},
  ]);
  assert(householdSpans([...phases,hourly],{voltageV:230})[0].unknownCharger2,'An unrelated zero cannot prove an idle charger');
  record(recorder,'ev2',start,end,[2]);
  const groups=[...recordedEnergyGroups(store,{from:start,to:end,now:end,input:'providers',prefix:'ev2'})];
  assert.equal(groups.length,1); assert(!groups[0].conflict); assert.deepEqual(groups[0].values,[2]);
  assert(project(store,start,end,end).series.charger2_power.some(row=>row.y===2));
});

test('live integration resumes after recovered energy without overlapping it or inventing the uncovered remainder', t => {
  for (const prefix of ['ev1','ev2']) {
    const {store,recorder}=fixture(t),powers=prefix==='ev1'?[1,1,1]:[3],edge=start+60_000;
    record(recorder,prefix,start,edge,powers);
    const donor=new Store(':memory:');
    try {
      const writer=new Recorder(donor);
      record(writer,prefix,edge,edge+30_000,powers);
      for (const row of donor.observations()) {
        const id=store.observation(row);
        store.db.prepare('INSERT INTO recovery_provenance(donor_digest,table_name,donor_id,target_id,disposition) VALUES(?,?,?,?,?)')
          .run('synthetic-donor','observations',String(row.id),String(id),'missing');
      }
    } finally { donor.close(); }
    const result=record(recorder,prefix,edge,edge+60_000,powers);
    assert.equal(result.reason,'recovered-interval-overlap');
    const gap=store.observations().filter(row=>row.value===null);
    assert.equal(gap.length,powers.length);
    for(const row of gap) { assert.equal(row.raw.intervalStart,edge+30_000); assert.equal(row.raw.intervalEnd,edge+60_000); }
    record(recorder,prefix,edge+60_000,edge+120_000,powers);
    const groups=[...recordedEnergyGroups(store,{from:start,to:edge+120_000,now:edge+120_000,input:'providers',prefix})];
    assert(groups.every(group=>!group.conflict));
    near(groups.filter(group=>group.values.every(Number.isFinite)).reduce((n,group)=>n+group.values.reduce((a,b)=>a+b,0),0),3*150_000/HOUR);
    assert(groups.some(group=>group.start===edge+60_000&&group.end===edge+120_000&&group.values.every(Number.isFinite)),
      'The next acquisition resumes without replacing recovered history or retaining an old integration cursor');
  }
});
