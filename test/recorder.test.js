import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';

const MINUTE=60_000,HOUR=60*MINUTE;
function fixture(t,config={}) {
  const store=new Store(':memory:'); t.after(()=>store.close());
  let now=1000;
  const recorder=new Recorder(store,{config,clock:()=>now});
  return {store,recorder,setNow(at){now=at;},put(value,at,extra={}) {
    now=at;
    return recorder.record({source:'synthetic',device:'fixture-house',signal:'indoor_temperature',value,
      unit:'degC',sourceTime:at,receivedAt:at,quality:[],...extra});
  }};
}

test('deadband compares with the last saved value and applies the same learned scale to different units',t=>{
  const {store,recorder,put}=fixture(t);
  put(20,1000);
  const key='recorder:signal:'+JSON.stringify(['synthetic','fixture-house','indoor_temperature']);
  const s=store.getState(key);s.mean=20;s.variance=100;s.scale=10;s.step=0.01;store.setState(key,s);
  for(let i=1;i<=15;i++) assert.equal(put(20+i*0.01,1000+i*1000).saved,false);
  assert.equal(store.observations().length,1);
  assert.equal(put(20.21,17000).saved,true,'slow drift eventually exceeds saved-value threshold');
  assert.equal(recorder.latestCommitted('indoor_temperature').value,20.21);
  assert.equal(recorder.status().parameters.length,1);
});

test('fresh unchanged samples compact coverage and maximum interval preserves a source-backed heartbeat',t=>{
  const {store,recorder,put}=fixture(t);
  put(20,1000);
  for(let i=1;i<20;i++) assert.equal(put(20,1000+i*15000).saved,false);
  assert.equal(store.observations().length,1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM recorder_coverage').get().n,1);
  const held=recorder.latestCommitted('indoor_temperature');
  assert.equal(held.sourceTime,286000);assert.equal(held.raw.recorder.originalSourceTime,1000);
  assert.equal(held.raw.recorder.temporalBasis,'held-recorded-value');
  assert.equal(put(20,301000).reason,'maximum-interval');
  assert.equal(store.observations().length,2);
  const historical=recorder.committedAt('indoor_temperature',151000);
  assert.equal(historical.sourceTime,1000,'later coverage updates cannot leak into an earlier model window');
});

test('old source timestamps do not become fresh measurements; failures and recovery always persist',t=>{
  const {store,recorder,put,setNow}=fixture(t);
  const extra={source:'husdata-h66'};
  put(20,1000,extra);
  for(let i=1;i<=20;i++) put(20,1000+i*15000,{...extra,sourceTime:1000});
  assert.equal(store.observations().length,1);
  put(20,316000,{...extra,sourceTime:1000});
  assert.equal(recorder.latestCommitted('indoor_temperature').value,null);
  assert.equal(recorder.status().parameters[0].status,'stale');
  setNow(330000);
  recorder.recordFailure({source:'husdata-h66',device:'fixture-house',signal:'indoor_temperature',unit:'degC',at:330000});
  assert.equal(recorder.latestCommitted('indoor_temperature').value,null);
  assert.equal(put(20,340000,extra).reason,'quality-or-availability');
  assert.equal(recorder.latestCommitted('indoor_temperature').value,20);
});

test('state changes and pump zero crossings bypass numeric deadband; excluded H66 values stay outside history',t=>{
  const {store,put}=fixture(t);
  put(0,1000,{signal:'brine_pump_speed',unit:'%'});
  assert.equal(put(0.00001,2000,{signal:'brine_pump_speed',unit:'%'}).reason,'state-change');
  put(0,3000,{signal:'compressor_active',unit:'state'});
  assert.equal(put(1,4000,{signal:'compressor_active',unit:'state'}).reason,'state-change');
  assert.equal(put(80,5000,{source:'husdata-h66',signal:'discharge_temperature'}).saved,false);
  assert.equal(put(1,6000,{source:'husdata-h66',signal:'brine_pump_active'}).saved,false);
  assert.equal(put(99,7000,{raw:{acquisitionOnly:true}}).saved,false);
  assert.equal(store.observations().length,4);
});

test('recording spacing cannot change source freshness or turn repeated old timestamps into new readings',t=>{
  const {recorder,put}=fixture(t,{maxIntervalMs:1000});
  put(20,1000,{source:'husdata-h66'});
  assert.equal(put(20,31000,{source:'husdata-h66',sourceTime:1000}).saved,false);
  assert.equal(recorder.status().parameters[0].status,'fresh','H66 source remains within its independent five-minute validity');
  assert.equal(recorder.latestCommitted('indoor_temperature').sourceTime,1000);
});

test('verification changes are recorded immediately even when value and numerical threshold are unchanged',t=>{
  const {put}=fixture(t);
  put(20,1000,{source:'husdata-h66',raw:{verified:false,usableForControl:true}});
  assert.equal(put(20,2000,{source:'husdata-h66',raw:{verified:true,usableForControl:true}}).reason,'quality-or-availability');
});

function energy(start,end,power=3,extra={}) {
  return {source:'easee',device:'fixture-charger',prefix:'ev1',start,end,
    energies:[power*(end-start)/HOUR,0,0],powers:[power,0,0],receivedAt:end,quality:['estimated'],...extra};
}

test('energy integrates all acquisition intervals while only three values per selected block enter history',t=>{
  const {store,recorder}=fixture(t);
  for(let i=0;i<24;i++) recorder.recordEnergy(energy(1000+i*15000,1000+(i+1)*15000));
  // Initial sample plus one five-minute block. Last 45 seconds remain in a
  // fixed-size checkpoint, then flush without estimating beyond the last poll.
  assert.equal(store.observations().length,6);
  assert.equal(recorder.flush(361000,{force:true}).length,3);
  const rows=store.observations();
  assert.equal(rows.length,9);
  assert.ok(Math.abs(rows.reduce((n,o)=>n+o.value,0)-0.3)<1e-12);
  for(const row of rows) {
    assert.equal(row.unit,'kWh');assert.ok(row.raw.durationMs>0);
    assert.equal(row.raw.intervalEnd,row.sourceTime);
  }
  assert.equal(recorder.recordEnergy(energy(346000,361000)).reason,'duplicate-interval');
});

test('energy restart checkpoints, quality boundaries and transaction rollback preserve totals without bridging gaps',t=>{
  const {store,recorder}=fixture(t);
  recorder.recordEnergy(energy(1000,16000));
  recorder.recordEnergy(energy(16000,31000));
  assert.throws(()=>store.transaction(()=>{
    recorder.recordEnergy(energy(31000,46000));throw new Error('synthetic abort');
  }),/synthetic abort/);
  const restarted=new Recorder(store);
  restarted.recordEnergy(energy(31000,46000));
  restarted.recordEnergy(energy(61000,76000));
  restarted.flush(76000,{force:true});
  const rows=store.observations().filter(o=>o.signal==='ev1_energy_l1');
  assert.ok(Math.abs(rows.reduce((n,o)=>n+o.value,0)-0.05)<1e-12);
  assert.ok(rows.some(o=>o.raw.intervalEnd===46000));
  assert.ok(rows.some(o=>o.raw.intervalStart===61000));
  assert.ok(rows.every(o=>!(o.raw.intervalStart<61000&&o.raw.intervalEnd>46000)));
  assert.throws(()=>restarted.recordEnergy(energy(70000,85000)),/Overlapping/);
});

test('electrical threshold baseline is the power reconstructible from saved energy, not a discarded endpoint',t=>{
  const {store,recorder}=fixture(t);
  recorder.recordEnergy(energy(1000,16000,1,{powers:[2,0,0]}));
  assert.equal(recorder.recordEnergy(energy(16000,31000,1)).saved,false);
  assert.equal(store.observations().length,3);
  recorder.flush(31000,{force:true});
  assert.ok(Math.abs(store.observations().reduce((n,row)=>n+row.value,0)-1/120)<1e-12);
});

test('outer rollback also restores numerical recorder state and coverage',t=>{
  const {store,recorder,put}=fixture(t);
  put(20,1000);
  assert.throws(()=>store.transaction(()=>{put(30,2000);throw new Error('synthetic abort');}),/abort/);
  assert.equal(store.observations().length,1);
  assert.equal(recorder.status().parameters[0].lastSavedAt,1000);
  put(30,2000);
  assert.equal(store.observations().length,2);
});

test('availability gaps close pending energy without extrapolation and recovery preserves its own boundary',t=>{
  const {store,recorder}=fixture(t);
  recorder.recordEnergy(energy(1000,16000));
  recorder.recordEnergy(energy(16000,31000));
  recorder.energyGap({device:'fixture-charger',prefix:'ev1',start:31000,end:46000,quality:['provider-error']});
  const rows=store.observations().filter(o=>o.signal==='ev1_energy_l1');
  assert.equal(rows.length,3);assert.equal(rows[1].raw.intervalEnd,31000);assert.equal(rows[2].value,null);
  recorder.recordEnergy(energy(61000,76000));
  const last=store.observations().filter(o=>o.signal==='ev1_energy_l1').at(-1);
  assert.equal(last.raw.intervalStart,61000);assert.equal(last.sourceTime,76000);
});

test('budget feedback is rolling and gradual across year boundaries, never deletes or forces precision by month',t=>{
  const {store,recorder,put}=fixture(t,{annualBudgetBytes:10_000});
  const start=Date.UTC(2026,11,31,23,30);
  put(20,start);
  const original=recorder.status().normalizedTolerance;
  // Grow unrelated actual database pages: the budget accounts for the whole
  // file rather than a guessed fixed bytes-per-observation or yearly counter.
  store.setState('synthetic-growth','x'.repeat(50000));
  put(21,start+HOUR);
  const status=recorder.status(start+HOUR);
  assert.ok(status.normalizedTolerance>original);
  assert.ok(status.normalizedTolerance/original<1.13);
  assert.equal(status.budgetBasis,'soft-rolling-growth');
  assert.ok(status.projectedAnnualBytes>10000);
  assert.equal(store.observations().length,2);
});

test('forecast content is shared across fetches without losing causal availability or per-source age',t=>{
  const {store}=fixture(t);
  const payload={issuedAt:500,fetchedAt:1000,forecast:[{start:3000,end:4000,outdoorC:4,fetchedAt:1000,
    solar:{source:'fixture-fallback',fetchedAt:700}}]};
  const first=store.snapshot({kind:'weather',source:'fixture',issuedAt:500,fetchedAt:1000,payload});
  const second=store.snapshot({kind:'weather',source:'fixture',issuedAt:500,fetchedAt:2000,
    payload:{...payload,fetchedAt:2000,forecast:[{...payload.forecast[0],fetchedAt:2000}]}});
  assert.notEqual(first,second);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM provider_snapshot_contents').get().n,1);
  assert.equal(store.latestSnapshot('weather',1999).id,first);
  const next=store.latestSnapshot('weather',2000);
  assert.equal(next.payload.forecast[0].fetchedAt,2000);
  assert.equal(next.payload.forecast[0].solar.fetchedAt,700);
  assert.equal(next.issuedAt,500);
  assert.equal(store.latestSnapshot('weather',999),null);
  const third=store.snapshot({kind:'weather',source:'fixture',issuedAt:500,fetchedAt:3000,
    payload:{...payload,acquisition:{attempts:[{source:'fixture',success:true,latencyMs:25}]}}});
  const fourth=store.snapshot({kind:'weather',source:'fixture',issuedAt:500,fetchedAt:4000,
    payload:{...payload,acquisition:{attempts:[{source:'fixture',success:true,latencyMs:50}]}}});
  assert.equal(store.snapshotById(third).contentId,store.snapshotById(fourth).contentId);
  assert.equal(store.snapshotById(fourth).contentFirstFetchedAt,1000);
  assert.equal(store.snapshotById(fourth).payload.acquisition.attempts[0].latencyMs,50);
});

test('property meter audit compares only complete matching intervals and never changes history or recorder thresholds',t=>{
  const {store,recorder}=fixture(t);
  const propertyEnergy=(start,end)=>energy(start,end,3,{device:'fixture-property',prefix:'property'});
  const audit=(at,value)=>store.energyAudit({device:'fixture-property',signal:'property_import_energy_counter',
    sourceTime:at,receivedAt:at+1000,value,quality:[]});
  audit(1000,10);
  recorder.recordEnergy(propertyEnergy(1000,16000));
  recorder.recordEnergy(propertyEnergy(16000,31000));
  audit(31000,10.03);
  assert.equal(store.energyAudits()[1].comparison,null,'pending estimates are not forced by audit');
  recorder.flush(31000,{force:true});
  const before=JSON.stringify(store.observations()), threshold=recorder.status().normalizedTolerance;
  const comparison=store.energyAudits()[1].comparison;
  assert.ok(Math.abs(comparison.estimatedKwh-0.025)<1e-12);
  assert.ok(Math.abs(comparison.differencePercent+16.6666666667)<1e-6);
  assert.equal(JSON.stringify(store.observations()),before);
  assert.equal(recorder.status().normalizedTolerance,threshold);
  audit(32000,0);
  assert.ok(store.energyAudits()[2].quality.includes('counter-reset'));
  assert.equal(audit(32000,0),0,'repeated old counter does not grow history');
});

test('learning journal replays samples and episodes in commit order with immutable versioned lineage',t=>{
  const {store}=fixture(t);
  const event={kind:'sample',at:1000,algorithmVersion:'synthetic-v1',configVersion:'settings-a',forecastVersion:7,payload:{timestamp:1000,indoorC:20}};
  const id=store.appendLearningJournal('synthetic',event);
  assert.equal(store.appendLearningJournal('synthetic',event),id);
  store.appendLearningJournal('synthetic',{kind:'episode',at:2000,algorithmVersion:'synthetic-v1',payload:{id:'synthetic-episode'}});
  assert.deepEqual(store.learningJournal({input:'synthetic'}).map(e=>e.kind),['sample','episode']);
  assert.equal(store.learningJournal({input:'synthetic',after:id})[0].at,2000);
  assert.throws(()=>store.appendLearningJournal('synthetic',{...event,payload:{timestamp:1000,indoorC:21}}),/Conflicting/);
});

test('audit windows may cut through estimated intervals using labelled edge averages, but never bridge missing coverage',t=>{
  const {store,recorder}=fixture(t);
  const propertyEnergy=(start,end)=>energy(start,end,3,{device:'fixture-property',prefix:'property'});
  recorder.recordEnergy(propertyEnergy(1000,16000));
  recorder.recordEnergy(propertyEnergy(16000,31000));
  recorder.flush(31000,{force:true});
  const audit=(at,value)=>store.energyAudit({device:'fixture-property',signal:'property_import_energy_counter',
    sourceTime:at,receivedAt:at+100000,value,quality:[]});
  audit(5000,10);audit(25000,10.02);
  const result=store.energyAudits()[1].comparison;
  assert.ok(Math.abs(result.estimatedKwh-3*20000/HOUR)<1e-12);
  assert.equal(result.edgeEstimated,true);assert.match(result.basis,/average-power-at-edges/);
  recorder.recordEnergy(propertyEnergy(46000,61000));recorder.flush(61000,{force:true});
  audit(60000,10.04);
  assert.equal(store.energyAudits()[2].comparison,null);
});

test('charger counters cannot enter cumulative meter storage',t=>{
  const {store}=fixture(t);
  for(const signal of ['ev1_lifetime_energy_counter','ev1_session_energy_counter','ev2_lifetime_energy_counter']) {
    assert.throws(()=>store.energyAudit({device:'fixture-charger',signal,sourceTime:1000,receivedAt:1000,value:10}),
      /Only the property import counter/);
  }
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM energy_audits').get().n,0);
});
