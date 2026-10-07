import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { LEARNING_ALGORITHM } from '../src/app/committed-learning.js';
import { importCsv } from '../src/storage/history.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MINUTE=60_000,HOUR=60*MINUTE;
const parameters=(recorder,now)=>{const status=recorder.status(now);return [...status.parameters,...status.exactParameters];};
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
  const {store,recorder,put:record}=fixture(t);
  const put=(value,at)=>record(value,at,{signal:'supply_temperature'});
  put(20,1000);
  const key='recorder:signal:'+JSON.stringify(['synthetic','fixture-house','supply_temperature','degC','adaptive-value']);
  const s=store.getState(key);s.mean=20;s.variance=100;s.scale=10;s.step=0.01;store.setState(key,s);
  for(let i=1;i<=15;i++) assert.equal(put(20+i*0.01,1000+i*1000).saved,false);
  assert.equal(store.observations().length,1);
  assert.equal(put(20.21,17000).saved,true,'slow drift eventually exceeds saved-value threshold');
  assert.equal(recorder.latestCommitted('supply_temperature').value,20.21);
  assert.equal(parameters(recorder).length,1);
});

test('fresh unchanged samples extend coverage without any maximum recording interval',t=>{
  const {store,recorder,put}=fixture(t);
  put(20,1000);
  for(let i=1;i<20;i++) assert.equal(put(20,1000+i*15000).saved,false);
  assert.equal(store.observations().length,1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM recorder_coverage').get().n,1);
  const held=recorder.latestCommitted('indoor_temperature');
  assert.equal(held.sourceTime,286000);assert.equal(held.raw.recorder.originalSourceTime,1000);
  assert.equal(held.raw.recorder.temporalBasis,'held-recorded-value');
  assert.equal(put(20,301000).saved,false);
  assert.equal(store.observations().length,1);
  const historical=recorder.committedAt('indoor_temperature',151000);
  assert.equal(historical.sourceTime,1000,'later coverage updates cannot leak into an earlier model window');
});

const periodicReport={source:'mqtt-temperature',raw:{reportIntervalMs:15*MINUTE,reportGraceMs:2*MINUTE}};

test('recording diagnostics expire report coverage without changing saved acquisition status or history',t=>{
  const {store,put,recorder}=fixture(t);
  put(20,1000,periodicReport);
  put(20,1000+15*MINUTE,periodicReport);
  put(20,1000+30*MINUTE,periodicReport);
  const savedState=store.db.prepare('SELECT key,value FROM state ORDER BY key').all();
  const savedCoverage=store.db.prepare('SELECT * FROM recorder_coverage').all();
  const deadline=1000+47*MINUTE;
  const fresh=parameters(recorder,deadline-1)[0];
  assert.equal(fresh.freshness.status,'fresh');
  assert.equal(fresh.freshness.sourceObservedAt,1000+30*MINUTE);
  assert.equal(fresh.freshness.savedValueAt,1000);
  assert.equal(fresh.freshness.maxAgeMs,17*MINUTE);
  assert.equal(fresh.freshness.reportIntervalMs,15*MINUTE);
  assert.equal(fresh.freshness.reportGraceMs,2*MINUTE);
  assert.equal(fresh.freshness.ageBasis,'periodic-report');
  assert.equal(fresh.hour.averageIntervalMs,null,'One saved value still has no average saving interval');
  const stale=parameters(recorder,deadline)[0];
  assert.equal(stale.status,'fresh','The recorded acquisition remains classified as fresh');
  assert.equal(stale.freshness.status,'stale');
  assert.deepEqual(stale.freshness.reasons,['missing-report']);
  assert.equal(store.observations().length,1);
  assert.deepEqual(store.db.prepare('SELECT key,value FROM state ORDER BY key').all(),savedState);
  assert.deepEqual(store.db.prepare('SELECT * FROM recorder_coverage').all(),savedCoverage);
  assert(!Object.hasOwn(stale.freshness,'device'));
});

test('recording diagnostics distinguish H66 expiry, held temperatures, and completed energy intervals',t=>{
  const {put,recorder}=fixture(t);
  put(20,1000,{source:'husdata-h66',signal:'supply_temperature'});
  assert.equal(parameters(recorder,1000+5*MINUTE)[0].freshness.status,'fresh');
  const stale=parameters(recorder,1001+5*MINUTE)[0].freshness;
  assert.equal(stale.status,'stale');assert.equal(stale.maxAgeMs,5*MINUTE);
  assert.deepEqual(stale.reasons,['source-expired']);
  put(20,1000);
  const indoor=parameters(recorder,1001+2*HOUR).find(row=>row.signal==='indoor_temperature').freshness;
  assert.equal(indoor.status,'held-attention');assert.equal(indoor.maxAgeMs,null);
  assert.equal(indoor.attentionAfterMs,2*HOUR);
  recorder.recordEnergy({source:'shelly-evse',device:'invented-car',prefix:'ev2',start:1000,end:2000,energies:[0.01,0,0],powers:[36,0,0]});
  const energy=parameters(recorder,72*HOUR).find(row=>row.signal==='ev2_energy_l1').freshness;
  assert.equal(energy.status,'recorded-interval');assert.equal(energy.maxAgeMs,null);
});

test('recording diagnostic failure reasons are safe and distinguish time rollback from measurement age',t=>{
  const {put,recorder}=fixture(t);
  put(20,2000);
  put(21,3000,{sourceTime:1000});
  assert.deepEqual(parameters(recorder)[0].freshness.reasons,['out-of-order-source-time']);
  put(21,4000,{sourceTime:5000});
  assert(parameters(recorder,6000)[0].freshness.reasons.includes('source-time-after-receipt'));
  recorder.recordFailure({source:'synthetic',device:'fixture-house',signal:'indoor_temperature',unit:'degC',at:7000,
    quality:['mqtt-disconnected','invented-private-failure']});
  const unavailable=parameters(recorder,7000)[0].freshness;
  assert.equal(unavailable.status,'failed');
  assert.deepEqual(unavailable.reasons,['mqtt-disconnected']);
  assert(!JSON.stringify(unavailable).includes('invented-private-failure'));
});

test('periodic temperatures save only exact changes while days of reports occupy one coverage span',t=>{
  const {store,put,recorder,setNow}=fixture(t);
  const first=1000;
  put(20,first,periodicReport);
  for(let i=1;i<=3*24*4;i++) assert.equal(put(20,first+i*15*MINUTE,periodicReport).saved,false);
  assert.equal(store.observations().length,1);
  const spans=store.db.prepare('SELECT * FROM recorder_coverage').all();
  assert.equal(spans.length,1);assert.equal(spans[0].samples,289);
  assert.equal(spans[0].source_time,first+72*HOUR);
  const latest=recorder.latestCommitted('indoor_temperature');
  assert.equal(latest.sourceTime,first,'unchanged reports never rewrite the value observation clock');
  assert.equal(latest.reportObservedAt,first+72*HOUR);
  setNow(first+72*HOUR+18*MINUTE);
  assert.equal(recorder.latestCommitted('indoor_temperature').value,null,'deadline expires without another poll');
  assert.equal(put(20.0000001,first+72*HOUR+19*MINUTE,periodicReport).saved,true,'every real temperature change survives the adaptive budget');
  assert.equal(store.observations().length,2);
});

test('periodic duplicate polls cannot confirm coverage or recover an explicit outage',t=>{
  const {store,recorder,put}=fixture(t);
  put(20,1000,periodicReport);
  put(20,1000+MINUTE,{...periodicReport,sourceTime:1000});
  let spans=store.db.prepare('SELECT * FROM recorder_coverage').all();
  assert.equal(spans[0].end_at,1000);assert.equal(spans[0].samples,1);
  recorder.recordFailure({source:'mqtt-temperature',device:'fixture-house',signal:'indoor_temperature',unit:'degC',at:1000+2*MINUTE});
  put(20,1000+3*MINUTE,{...periodicReport,sourceTime:1000});
  assert.equal(recorder.latestCommitted('indoor_temperature').value,null);
  put(20,1000+4*MINUTE,{...periodicReport,sourceTime:1000+MINUTE});
  assert.equal(recorder.latestCommitted('indoor_temperature').value,null,'buffered report predating the outage does not recover it');
  put(20,1000+5*MINUTE,periodicReport);
  assert.equal(recorder.latestCommitted('indoor_temperature').value,20);
  spans=store.db.prepare("SELECT * FROM recorder_coverage WHERE status='fresh'").all();
  assert.equal(spans.length,2);assert.equal(spans[1].start_at,1000+5*MINUTE);
});

test('restart and absent polls preserve separate periodic spans around a missed deadline',t=>{
  const {store,put}=fixture(t);
  put(20,1000,periodicReport);
  const recorder=new Recorder(store);
  const result=recorder.record({...periodicReport,device:'fixture-house',signal:'indoor_temperature',value:20,unit:'degC',
    sourceTime:1000+40*MINUTE,receivedAt:1000+40*MINUTE,quality:[]});
  assert.equal(result.saved,false);
  const spans=store.db.prepare('SELECT * FROM recorder_coverage').all();
  assert.equal(spans.length,2);assert.equal(spans[0].observation_id,spans[1].observation_id);
  assert.equal(recorder.committedAt('indoor_temperature',1000+25*MINUTE).value,null);
  assert.equal(recorder.committedAt('indoor_temperature',1000+41*MINUTE).value,20);
});

test('disabling periodic reporting clears inherited policy and retains the explicit boundary',t=>{
  const {store,recorder,put,setNow}=fixture(t);
  put(20,1000,periodicReport);
  assert.equal(put(20,1000+MINUTE,{source:'mqtt-temperature',raw:{reportIntervalMs:0}}).reason,'quality-or-availability');
  setNow(1000+HOUR);
  assert.equal(recorder.latestCommitted('indoor_temperature').value,20);
  recorder.recordFailure({source:'mqtt-temperature',device:'fixture-house',signal:'indoor_temperature',unit:'degC',at:1000+HOUR});
  assert.equal(store.observations().at(-1).raw.reportIntervalMs,undefined);
  put(20,1000+HOUR+MINUTE,{source:'mqtt-temperature'});
  setNow(1000+3*HOUR);
  assert.equal(recorder.latestCommitted('indoor_temperature').value,20);
});

test('periodic retained packets neither establish coverage, end genuine coverage nor recover a disconnect',t=>{
  const {store,recorder,put}=fixture(t);
  const retained={...periodicReport,quality:['retained'],raw:{...periodicReport.raw,retained:true}};
  assert.equal(put(19,500,retained).reason,'retained-periodic-report');
  assert.equal(store.observations().length,0);
  put(20,1000,periodicReport);
  const original=store.db.prepare('SELECT * FROM recorder_coverage').all();
  for(const [value,sourceTime] of [[20,1000],[20,1000+MINUTE],[21,1000+2*MINUTE]])
    assert.equal(put(value,1000+3*MINUTE,{...retained,sourceTime}).saved,false);
  assert.equal(store.observations().length,1);
  assert.deepEqual(store.db.prepare('SELECT * FROM recorder_coverage').all(),original);
  assert.equal(recorder.latestCommitted('indoor_temperature').value,20);
  recorder.recordFailure({source:'mqtt-temperature',device:'fixture-house',signal:'indoor_temperature',unit:'degC',at:1000+4*MINUTE});
  const outage=store.db.prepare('SELECT * FROM recorder_coverage').all();
  put(22,1000+5*MINUTE,retained);
  assert.deepEqual(store.db.prepare('SELECT * FROM recorder_coverage').all(),outage);
  assert.equal(recorder.latestCommitted('indoor_temperature').value,null);
  put(20,1000+6*MINUTE,periodicReport);
  assert.equal(recorder.latestCommitted('indoor_temperature').value,20);
});

test('temperature report revision follows genuine confirmations and outages independently of fast recording',t=>{
  const {recorder,put}=fixture(t);
  put(20,1000,periodicReport);
  const original=recorder.status();
  assert.equal(original.exactParameters.find(row=>row.signal==='indoor_temperature').threshold,null);
  put(20,1000+MINUTE,{...periodicReport,sourceTime:1000});
  assert.equal(recorder.status().temperatureReportRevision,original.temperatureReportRevision);
  put(-100,1000+2*MINUTE,{signal:'heating_integral',unit:'degMin'});
  const power=recorder.status();
  assert.notEqual(power.historyRevision,original.historyRevision);
  assert.equal(power.temperatureReportRevision,original.temperatureReportRevision);
  put(20,1000+15*MINUTE,periodicReport);
  const confirmed=recorder.status();
  assert.equal(confirmed.historyRevision,power.historyRevision,'same-value confirmation changes no row IDs');
  assert.notEqual(confirmed.temperatureReportRevision,power.temperatureReportRevision);
  assert.doesNotMatch(confirmed.temperatureReportRevision,/fixture-house/,'revision excludes device identifiers');
  recorder.recordFailure({source:'mqtt-temperature',device:'fixture-house',signal:'indoor_temperature',unit:'degC',at:1000+16*MINUTE});
  assert.notEqual(recorder.status().temperatureReportRevision,confirmed.temperatureReportRevision);
});

test('old H66 source timestamps do not become fresh measurements; failures and recovery always persist',t=>{
  const {store,recorder,put,setNow}=fixture(t);
  const extra={source:'husdata-h66',signal:'supply_temperature'};
  put(20,1000,extra);
  for(let i=1;i<=20;i++) put(20,1000+i*15000,{...extra,sourceTime:1000});
  assert.equal(store.observations().length,1);
  put(20,316000,{...extra,sourceTime:1000});
  assert.equal(recorder.latestCommitted('supply_temperature').value,null);
  assert.equal(parameters(recorder)[0].status,'stale');
  setNow(330000);
  recorder.recordFailure({source:'husdata-h66',device:'fixture-house',signal:'supply_temperature',unit:'degC',at:330000});
  assert.equal(recorder.latestCommitted('supply_temperature').value,null);
  assert.equal(put(20,340000,extra).reason,'quality-or-availability');
  assert.equal(recorder.latestCommitted('supply_temperature').value,20);
});

test('room and garage recording accepts old source timestamps without inventing new measurements',t=>{
  const {store,recorder,put}=fixture(t);
  const sourceTime=1000;
  for(const signal of ['indoor_temperature','downstairs_temperature','bedroom_temperature','garage_temperature']) {
    const extra={source:'mqtt-temperature',signal,sourceTime};
    put(20,sourceTime+2*HOUR,extra);
    const first=recorder.latestCommitted(signal);
    assert.equal(first.value,20);
    assert.equal(first.sourceTime,sourceTime);
    assert.equal(first.receivedAt,sourceTime+2*HOUR);
    assert.equal(first.raw.recorder.status,'fresh');
    assert.equal(put(20,sourceTime+7*24*HOUR,extra).saved,false,'Elapsed time alone cannot manufacture another observation');
    const held=recorder.latestCommitted(signal);
    assert.equal(held.sourceTime,sourceTime);
    assert.equal(held.raw.recorder.originalSourceTime,sourceTime);
    assert.equal(held.value,20);
  }
  assert.equal(store.observations().length,4);
});

test('H66 indoor is not recorded while H66 equipment retains its expiry',t=>{
  const {recorder,put}=fixture(t);
  put(20,2*HOUR,{source:'husdata-h66',sourceTime:1000});
  assert.equal(recorder.latestCommitted('indoor_temperature'),null);
  put(30,2*HOUR,{source:'husdata-h66',signal:'supply_temperature',sourceTime:1000});
  assert.equal(recorder.latestCommitted('supply_temperature').value,null);
});

test('held room readings still record unavailable, retained, future and out-of-order acquisitions honestly',t=>{
  const {recorder,put}=fixture(t);
  const extra={source:'mqtt-temperature',signal:'garage_temperature'};
  put(12,1000,extra);
  put(12,2*HOUR,{...extra,sourceTime:1000,quality:['retained'],raw:{retained:true}});
  assert.equal(parameters(recorder)[0].status,'unavailable');
  assert.equal(recorder.latestCommitted('garage_temperature').value,null);
  assert.equal(recorder.latestCommitted('garage_temperature').sourceTime,1000);
  put(13,2*HOUR+1000,{...extra,sourceTime:2*HOUR});
  assert.equal(recorder.latestCommitted('garage_temperature').value,13);
  put(99,2*HOUR+2000,{...extra,sourceTime:500});
  assert.equal(parameters(recorder)[0].status,'stale');
  put(99,2*HOUR+3000,{...extra,sourceTime:3*HOUR});
  assert.equal(parameters(recorder)[0].status,'stale');
  put(null,2*HOUR+4000,{...extra,sourceTime:null,quality:['missing','source_time_unknown']});
  assert.equal(parameters(recorder)[0].status,'unavailable');
  recorder.recordFailure({...extra,device:'fixture-house',unit:'degC',at:2*HOUR+5000});
  assert.equal(parameters(recorder)[0].status,'failed');
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

test('change-only recording cannot change source freshness or turn repeated old timestamps into new readings',t=>{
  const {recorder,put}=fixture(t);
  put(20,1000,{source:'husdata-h66',signal:'supply_temperature'});
  assert.equal(put(20,31000,{source:'husdata-h66',signal:'supply_temperature',sourceTime:1000}).saved,false);
  assert.equal(parameters(recorder)[0].status,'fresh','H66 source remains within its independent five-minute validity');
  assert.equal(recorder.latestCommitted('supply_temperature').sourceTime,1000);
});

test('verification changes are recorded immediately even when value and numerical threshold are unchanged',t=>{
  const {put}=fixture(t);
  put(20,1000,{source:'husdata-h66',signal:'supply_temperature',raw:{verified:false,usableForControl:true}});
  assert.equal(put(20,2000,{source:'husdata-h66',signal:'supply_temperature',raw:{verified:true,usableForControl:true}}).reason,'quality-or-availability');
});

function energy(start,end,power=3,extra={}) {
  return {source:'easee',device:'fixture-charger',prefix:'ev1',start,end,
    energies:[power*(end-start)/HOUR,0,0],powers:[power,0,0],receivedAt:end,quality:['estimated'],...extra};
}

test('energy integrates all acquisition intervals while only three values per selected block enter history',t=>{
  const {store,recorder}=fixture(t);
  for(let i=0;i<24;i++) recorder.recordEnergy(energy(1000+i*15000,1000+(i+1)*15000));
  // Constant power retains one bounded durable open interval until an explicit
  // boundary. Routine ticks never create time-based history.
  assert.equal(recorder.flush(361000).length,0);
  assert.equal(store.observations().length,3);
  assert.equal(recorder.flush(361000,{force:true}).length,3);
  const rows=store.observations();
  assert.equal(rows.length,6);
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
  assert.equal(parameters(recorder)[0].lastSavedAt,1000);
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

test('adaptive payload budget feedback is gradual across year boundaries and never removes history',t=>{
  const {store,recorder,put}=fixture(t,{annualBudgetBytes:10_000});
  const start=Date.UTC(2026,11,31,23,30);
  put(20,start,{signal:'supply_temperature'});
  const original=recorder.status().normalizedTolerance;
  put(21,start+HOUR,{signal:'supply_temperature'});
  const status=recorder.status(start+HOUR);
  assert.ok(status.normalizedTolerance>original);
  assert.ok(status.normalizedTolerance/original<1.13);
  assert.equal(status.budgetBasis,'adaptive-observation-payload');
  assert.ok(status.adaptiveProjectedAnnualBytes>10000);
  assert.equal(status.adaptiveAccountingStartedAt,start);
  assert.ok(status.adaptiveEstimatedBytes>500,'payload estimate includes observation metadata');
  assert.equal(store.observations().length,2);
});

test('unused adaptive allowance gradually restores precision even while exact history grows',t=>{
  const {store,recorder,put}=fixture(t),start=Date.UTC(2026,0,1);
  put(35,start,{signal:'supply_temperature'});
  const original=recorder.status(start).normalizedTolerance;
  store.setState('synthetic-growth','x'.repeat(500_000));
  put(21,start+HOUR);
  assert.equal(recorder.status(start+HOUR).normalizedTolerance,original,'Exact writes do not advance adaptive feedback');
  put(35,start+HOUR,{signal:'supply_temperature'});
  const status=recorder.status(start+HOUR);
  assert(status.normalizedTolerance<original);
  assert(status.normalizedTolerance/original>0.88,'Restoring precision is gradual as well');
  assert.equal(store.observations().filter(o=>o.signal==='supply_temperature').length,1,'No heartbeat is invented');
});

test('exact writes, imports, journals and indexes cannot change adaptive precision or byte accounting',async t=>{
  const baseline=fixture(t,{annualBudgetBytes:100_000}), loaded=fixture(t,{annualBudgetBytes:100_000});
  const directory=mkdtempSync(join(tmpdir(),'stmq-budget-isolation-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'st-mq.csv'), start=Date.UTC(2026,0,1);
  writeFileSync(path,'unix_time,price,heat_on,temp_in,temp_ga,temp_out\n'
    +Array.from({length:120},(_,i)=>`${start/1000+i},3,15,20,10,-1`).join('\n')+'\n');
  const sequence=f=>{
    for(let i=0;i<120;i++) {
      const at=start+i*MINUTE;
      f.put(35+Math.sin(i/9),at,{signal:'supply_temperature'});
      f.recorder.recordEnergy(energy(at,at+MINUTE,3+Math.sin(i/12),{prefix:'property'}));
    }
  };
  for(const f of [baseline,loaded]) f.put(35,start-MINUTE,{signal:'supply_temperature'});
  await importCsv(loaded.store,path,{kind:'stmq'});
  for(let i=0;i<250;i++) {
    loaded.put(20+i/1000,start-MINUTE+i);
    loaded.store.appendLearningJournal('synthetic',{kind:'sample',at:start+i,algorithmVersion:LEARNING_ALGORITHM,
      key:`sample-${i}`,payload:{timestamp:start+i,indoorC:20+i/1000}});
  }
  loaded.store.setState('synthetic-unrelated-growth','x'.repeat(200_000));
  loaded.store.db.exec('CREATE INDEX synthetic_budget_index ON observations(raw,source,signal)');
  sequence(baseline);sequence(loaded);
  for(const f of [baseline,loaded]) f.recorder.flush(start+2*HOUR,{force:true});
  const left=baseline.recorder.status(start+2*HOUR),right=loaded.recorder.status(start+2*HOUR);
  assert.deepEqual(loaded.store.getState('recorder:adaptive-budget:v1'),baseline.store.getState('recorder:adaptive-budget:v1'));
  const adaptiveRows=store=>store.observations({limit:10_000}).filter(o=>o.raw?.recorder?.policy.startsWith('adaptive-'))
    .map(({id,...row})=>row);
  assert.deepEqual(adaptiveRows(loaded.store),adaptiveRows(baseline.store));
  assert.equal(right.normalizedTolerance,left.normalizedTolerance);
  assert.ok(right.measuredDatabaseBytes>left.measuredDatabaseBytes+200_000);
  assert.ok(right.totalDatabaseProjectedAnnualBytes>left.totalDatabaseProjectedAnnualBytes);
  assert.ok(right.adaptiveEstimatedBytes>0);
  assert(!Object.hasOwn(right,'projectedAnnualBytes'),'ambiguous total-growth API is removed');
});

test('prospective budget starts only on adaptive recording and never reads historical growth or old tolerance',t=>{
  const {store,recorder,put}=fixture(t);
  put(20,1000);
  const oldCache={version:'recording-contract-v2',tolerance:9,bytesPerDay:1e12,energyRevision:987654321};
  store.setState('recorder:global:v2',oldCache);
  store.observation({source:'synthetic',device:'old-history',signal:'supply_temperature',value:20,
    unit:'degC',sourceTime:1000,receivedAt:1000,raw:{recorder:{policy:'adaptive-value'}}});
  recorder.flush(1000+HOUR);
  assert.deepEqual(store.getState('recorder:global:v2'),oldCache,'Unconsumed retired cache bytes remain untouched');
  const metrics=store.getState('recorder:storage-metrics:v1');
  assert.equal(metrics.energyRevision,0);assert(metrics.bytesPerDay<1e12);
  const before=store.db.prepare('SELECT key,value FROM state ORDER BY key').all();
  const restarted=new Recorder(store),empty=restarted.status(1000+2*HOUR);
  assert.equal(empty.adaptiveAccountingStartedAt,null);
  assert.equal(empty.adaptiveEstimatedBytes,0);
  assert.equal(empty.normalizedTolerance,0.02);
  assert.deepEqual(store.db.prepare('SELECT key,value FROM state ORDER BY key').all(),before,'diagnostics initialize no state');
  put(30,1000+2*HOUR,{signal:'supply_temperature'});
  const status=restarted.status(1000+2*HOUR);
  assert.equal(status.adaptiveAccountingStartedAt,1000+2*HOUR);
  assert.equal(status.adaptiveMeasurementHours,0);
  assert.equal(status.normalizedTolerance,0.02);
  assert.ok(status.adaptiveEstimatedBytes>0&&status.adaptiveEstimatedBytes<1000);
  assert.equal(store.observations().length,3,'existing history is retained without a backfill');
});

test('adaptive budget counters and energy boundaries roll back with the observations and survive restart',t=>{
  const {store,recorder,put}=fixture(t);
  put(20,1000,{signal:'supply_temperature'});
  recorder.recordEnergy(energy(1000,16000));
  recorder.recordEnergy(energy(16000,31000));
  const snapshot=()=>({budget:store.getState('recorder:adaptive-budget:v1'),rows:store.observations(),
    states:store.db.prepare('SELECT key,value FROM state ORDER BY key').all(),metrics:store.db.prepare('SELECT * FROM recorder_metrics').all()});
  const before=snapshot();
  assert.throws(()=>store.transaction(()=>{
    put(30,32000,{signal:'supply_temperature'});
    recorder.energyGap({device:'fixture-charger',prefix:'ev1',start:31000,end:46000,quality:['provider-error']});
    throw new Error('synthetic outer abort');
  }),/outer abort/);
  assert.deepEqual(snapshot(),before);
  const setState=store.setState.bind(store);
  store.setState=(key,value)=>{if(key==='recorder:adaptive-budget:v1')throw new Error('synthetic budget failure');return setState(key,value);};
  assert.throws(()=>recorder.flush(46000,{force:true}),/budget failure/);
  assert.deepEqual(snapshot(),before);
  store.setState=setState;
  const restarted=new Recorder(store);
  restarted.energyGap({device:'fixture-charger',prefix:'ev1',start:31000,end:46000,quality:['provider-error']});
  assert.ok(store.getState('recorder:adaptive-budget:v1').estimatedBytes>before.budget.estimatedBytes);
  const rows=store.observations().filter(o=>o.signal==='ev1_energy_l1');
  assert.equal(rows.at(-1).value,null,'mandatory gap survives any budget pressure');
  assert.ok(Math.abs(rows.reduce((sum,o)=>sum+(o.value??0),0)-3*30000/HOUR)<1e-12);
  const saved=store.getState('recorder:adaptive-budget:v1');
  assert.equal(new Recorder(store).status(46000).adaptiveEstimatedBytes,saved.estimatedBytes);
  assert.deepEqual(store.getState('recorder:adaptive-budget:v1'),saved);
});

test('malformed or unsupported prospective adaptive budget is rejected without rewriting state',t=>{
  const {store,put}=fixture(t);
  put(20,1000,{signal:'supply_temperature'});
  const valid=store.getState('recorder:adaptive-budget:v1');
  for(const state of [null,{...valid,version:2},{...valid,estimatedBytes:-1},{...valid,tolerance:NaN},
    {...valid,unknown:1},{...valid,measuredBytes:valid.estimatedBytes+1}]) {
    store.setState('recorder:adaptive-budget:v1',state);
    const before=store.db.prepare("SELECT value FROM state WHERE key='recorder:adaptive-budget:v1'").get().value;
    assert.throws(()=>new Recorder(store),/Unsupported adaptive recording budget/);
    assert.equal(store.db.prepare("SELECT value FROM state WHERE key='recorder:adaptive-budget:v1'").get().value,before);
  }
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
  const pendingAudit = store.energyAudits()[1].comparison;
  assert.equal(pendingAudit.includesOpenInterval,true,'diagnostics include durable energy without forcing history');
  assert.ok(Math.abs(pendingAudit.estimatedKwh-0.025)<1e-12);
  assert.equal(store.observations().length,3);
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
  const event={kind:'sample',at:1000,algorithmVersion:LEARNING_ALGORITHM,configVersion:'settings-a',forecastVersion:7,payload:{timestamp:1000,indoorC:20}};
  const id=store.appendLearningJournal('synthetic',event);
  assert.equal(store.appendLearningJournal('synthetic',event),id);
  store.appendLearningJournal('synthetic',{kind:'episode',at:2000,algorithmVersion:LEARNING_ALGORITHM,payload:{id:'synthetic-episode'}});
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

test('days of fresh unchanged measurements and exact states never create heartbeat records', t => {
  const { store, recorder, put } = fixture(t);
  for (let i = 0; i <= 3 * 24 * 12; i++) {
    const at = 1000 + i * 5 * MINUTE;
    put(30, at, { source: 'husdata-h66', signal: 'supply_temperature' });
    put(1, at, { source: 'husdata-h66', signal: 'compressor_active', unit: 'state' });
    recorder.flush(at);
  }
  assert.equal(store.observations().length, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM recorder_coverage').get().n, 2);
  assert.deepEqual(recorder.status().parameters.map(row => row.signal), ['supply_temperature']);
  assert.deepEqual(recorder.status().exactParameters.map(row => row.signal), ['compressor_active']);
  assert.equal(recorder.latestCommitted('supply_temperature').value, 30);
  assert.throws(() => recorder.configure({ maxIntervalMs: 300_000 }), /Unsupported/);
});

test('report deadlines do not turn continuous diagnostics into exact channels; learning endpoints stay exact', t => {
  const { store, recorder, put } = fixture(t);
  const report = { source: 'garage-adapter', signal: 'garage_compressor_frequency', unit: 'Hz',
    raw: { reportIntervalMs: 2 * MINUTE, reportGraceMs: 0 } };
  put(40, 1000, report);
  const key = 'recorder:signal:' + JSON.stringify(['garage-adapter', 'fixture-house', report.signal, 'Hz', 'adaptive-value']);
  const state = store.getState(key);
  Object.assign(state, { scale: 100, variance: 10000, mean: 40, step: 0.01 }); store.setState(key, state);
  assert.equal(put(40.01, 2000, report).saved, false);
  assert.equal(recorder.status().parameters[0].policy, 'adaptive-value');
  put(20, 3000, periodicReport);
  assert.equal(put(20.0000001, 4000, periodicReport).saved, true);
  assert.equal(recorder.status().exactParameters[0].policy, 'change-only');
  assert.equal(recorder.status().exactParameters[0].threshold, null);
});

test('open energy survives long steady operation and restart, revises history, and closes only the selected session', t => {
  const { store, recorder } = fixture(t);
  const at = 1000, period = MINUTE;
  for (const prefix of ['ev1', 'property']) recorder.recordEnergy(energy(at, at + period, 3, { prefix, device: prefix }));
  const revision = recorder.status(at + period).historyRevision;
  for (let i = 1; i <= 25 * 60; i++) recorder.recordEnergy(energy(at + i * period, at + (i + 1) * period, 3,
    { prefix: 'ev1', device: 'ev1' }));
  const end = at + 1501 * period;
  recorder.recordEnergy(energy(at + period, end, 3, { prefix: 'property', device: 'property' }));
  assert.equal(store.observations().length, 6);
  assert.equal(recorder.flush(end).length, 0);
  const restarted = new Recorder(store, { clock: () => end });
  const status = restarted.status();
  assert.notEqual(status.historyRevision, revision);
  assert.equal(status.parameters.find(row => row.signal === 'ev1_energy_l1').openInterval.end, end);
  const finalized = restarted.flush(end, { force: true, source: 'easee', device: 'ev1', prefix: 'ev1' });
  assert.equal(finalized.length, 3);
  assert.ok(Math.abs(finalized.reduce((sum, row) => sum + row.value, 0) - 75) < 1e-9);
  assert.equal(restarted.status().parameters.find(row => row.signal === 'ev1_energy_l1').openInterval, null);
  assert.notEqual(restarted.status().parameters.find(row => row.signal === 'property_energy_l1').openInterval, null);
  assert.equal(restarted.flush(end, { force: true, prefix: 'ev1' }).length, 0);
});

test('Charger 2 phase group preserves measured-total allocation and commits all phases atomically', t => {
  const { store, recorder } = fixture(t);
  const interval = { source: 'shelly-evse', device: 'invented-charger', prefix: 'ev2', start: 1000, end: 61000,
    receivedAt: 62000, energies: [0.01, 0.02, 0.03], powers: [0.6, 1.2, 1.8], quality: ['phase-allocation-estimated'] };
  recorder.recordEnergy(interval);
  assert.deepEqual(store.observations().map(row => row.signal), ['ev2_energy_l1', 'ev2_energy_l2', 'ev2_energy_l3']);
  assert(store.observations().every(row => row.raw.basis === 'native-meter-counter-phase-allocation'));
  assert.throws(() => recorder.recordEnergy({ ...interval, energies: [0.06], powers: [3.6] }), /Invalid phase energy interval/);
  assert.throws(() => recorder.recordEnergy({ ...interval, prefix: 'ev2-phase' }), /Invalid phase energy interval/);
  assert.equal(recorder.recordEnergy(interval).reason, 'duplicate-interval');
  assert.throws(() => recorder.recordEnergy({ ...interval, start: 61000, end: 121000, receivedAt: 120000 }), /Invalid/);
  assert.throws(() => store.transaction(() => {
    recorder.recordEnergy({ ...interval, start: 61000, end: 121000, receivedAt: 122000 });
    throw new Error('synthetic interruption');
  }), /synthetic interruption/);
  assert.equal(store.observations().length, 3);
  assert.equal(recorder.status(122000).parameters.filter(row => row.openInterval).length, 0);
});

test('a sharp power step cannot be spread backwards into a multi-day steady interval', t => {
  const { store, recorder } = fixture(t);
  recorder.recordEnergy(energy(1000,61000,1));
  const edge = 1000+50*HOUR;
  recorder.recordEnergy(energy(61000,edge,1));
  recorder.recordEnergy(energy(edge,edge+MINUTE,10));
  const rows = store.observations({signal:'ev1_energy_l1'});
  assert.equal(rows.length,3);
  const steady = rows.find(row=>row.raw.intervalStart===61000);
  const changed = rows.find(row=>row.raw.intervalStart===edge);
  assert.equal(steady.raw.intervalEnd,edge);
  assert.equal(steady.value*HOUR/steady.raw.durationMs,1);
  assert.equal(changed.value*HOUR/changed.raw.durationMs,10);
  assert.equal(changed.raw.durationMs,MINUTE);
});

test('energy receipts and delayed gaps retain their real causal publication times', t => {
  const { store, recorder } = fixture(t);
  recorder.recordEnergy(energy(1000,16000,3,{receivedAt:50000}));
  recorder.recordEnergy(energy(16000,31000,3,{receivedAt:60000}));
  assert.throws(()=>recorder.recordEnergy(energy(31000,46000,3,{receivedAt:55000})),/Out-of-order energy receipt/);
  assert.throws(()=>recorder.energyGap({device:'fixture-charger',prefix:'ev1',start:31000,end:40000}),/Out-of-order/);
  const gap = recorder.energyGap({device:'fixture-charger',prefix:'ev1',start:31000,end:40000,receivedAt:70000});
  assert(gap.every(row=>row.receivedAt===70000));
  assert.equal(store.observations({signal:'ev1_energy_l1'}).find(row=>row.value===null).sourceTime,40000);
  const saved = JSON.stringify(store.observations());
  assert.throws(()=>recorder.recordEnergy(energy(40000,55000,3,{receivedAt:65000})),/Out-of-order/);
  assert.equal(JSON.stringify(store.observations()),saved);
});

test('recording interval statistics use actual retained timestamps and exact window membership', t => {
  const { recorder, put } = fixture(t);
  for (const [at,value] of [[1000,1],[1000+HOUR-1,2],[1000+HOUR+MINUTE,3],[1000+2*HOUR,4]])
    put(value,at,{signal:'heating_integral',unit:'degMin'});
  const row = recorder.status(1000+2*HOUR).parameters[0];
  assert.equal(row.hour.records,2,'the observation just outside the rolling window is excluded');
  assert.equal(row.hour.averageIntervalMs,59*MINUTE);
  assert.equal(row.day.records,4);
  assert.equal(row.day.averageIntervalMs,2*HOUR/3);
});

test('hour buckets preserve exact rolling timestamp counts at partial boundaries and historical upper cutoffs', t => {
  const {store,recorder,put}=fixture(t), DAY=24*HOUR, now=9*DAY+37*MINUTE+321;
  const times=[now-7*DAY-1,now-7*DAY,now-6*DAY,now-DAY-1,now-DAY,
    now-HOUR-1,now-HOUR,now-10*MINUTE,now,now+1];
  times.forEach((at,index)=>put(index+1,at,{signal:'heating_integral',unit:'degMin'}));
  const row=recorder.status(now).parameters[0];
  for(const [name,span] of [['hour',HOUR],['day',DAY],['week',7*DAY]]) {
    const expected=times.filter(at=>at>=now-span&&at<=now);
    assert.equal(row[name].records,expected.length,name);
    assert.equal(row[name].averageIntervalMs,(expected.at(-1)-expected[0])/(expected.length-1),name);
  }
  const bucket=store.db.prepare('SELECT records,first_saved_at,last_saved_at FROM recorder_metrics WHERE bucket=?')
    .get(Math.floor(now/HOUR)*HOUR);
  assert.equal(bucket.records,3);
  assert.equal(bucket.first_saved_at,now-10*MINUTE);
  assert.equal(bucket.last_saved_at,now+1);
});

test('saved extrema ignore unsaved polls, retain same-millisecond records and survive restart atomically', t => {
  const {store,recorder,put}=fixture(t);
  put(1,1000,{signal:'heating_integral',unit:'degMin'});
  put(1,HOUR+1000,{signal:'heating_integral',unit:'degMin'});
  let bucket=store.db.prepare('SELECT * FROM recorder_metrics WHERE bucket=?').get(HOUR);
  assert.equal(bucket.records,0); assert.equal(bucket.first_saved_at,null); assert.equal(bucket.last_saved_at,null);
  const sample={source:'synthetic',device:'same-ms',signal:'custom_reading',unit:'state',value:0,sourceTime:HOUR+2000,receivedAt:HOUR+2000,quality:[]};
  recorder.record(sample,{force:true}); recorder.record({...sample,value:1},{force:true});
  const before=store.db.prepare('SELECT * FROM recorder_metrics ORDER BY key,bucket').all();
  assert.throws(()=>store.transaction(()=>{recorder.record({...sample,value:0,sourceTime:HOUR+3000,receivedAt:HOUR+3000},{force:true});throw Error('rollback');}),/rollback/);
  assert.deepEqual(store.db.prepare('SELECT * FROM recorder_metrics ORDER BY key,bucket').all(),before);
  const resumed=new Recorder(store), status=parameters(resumed,HOUR+3000);
  const row=status.find(row=>row.signal==='custom_reading');
  assert.equal(row.hour.records,2); assert.equal(row.hour.averageIntervalMs,0);
  bucket=store.db.prepare('SELECT * FROM recorder_metrics WHERE records=2').get();
  assert.equal(bucket.first_saved_at,HOUR+2000); assert.equal(bucket.last_saved_at,HOUR+2000);
});

test('historical spacing remains exact after hourly metrics were pruned and the recorder restarted', t => {
  const {store,put}=fixture(t),DAY=24*HOUR;
  for(let day=0;day<=12;day++) put(day+1,1000+day*DAY,{signal:'heating_integral',unit:'degMin'});
  assert(store.db.prepare('SELECT MIN(bucket) first FROM recorder_metrics').get().first>3*DAY);
  const resumed=new Recorder(store),row=resumed.status(1000+2*DAY).parameters[0];
  assert.equal(row.week.records,3); assert.equal(row.week.averageIntervalMs,DAY);
  assert.equal(row.day.records,2); assert.equal(row.day.averageIntervalMs,DAY);
  assert.equal(row.hour.records,1); assert.equal(row.hour.averageIntervalMs,null);
});

test('changed configurable units and policies retain distinct historical streams and statistics after restart', t => {
  const { store, recorder, put } = fixture(t);
  for (const [unit, at] of [['degC', 1000], ['%', 2000], ['state', 3000]])
    put(1, at, { signal: 'custom_reading', unit });
  const reopened = new Recorder(store, { clock: () => 3000 });
  const status = reopened.status();
  assert.deepEqual(status.parameters.map(row => row.unit).sort(), ['%', 'degC']);
  assert.deepEqual(status.exactParameters.map(row => row.unit), ['state']);
  const rows = [...status.parameters, ...status.exactParameters];
  assert.equal(new Set(rows.map(row => row.streamId)).size, 3);
  for (const row of rows) {
    assert.equal(row.week.records, 1, `${row.unit} counts only its own policy and unit`);
    assert.equal(row.week.averageIntervalMs, null);
  }
  put(2, 4000, { signal: 'custom_reading', unit: 'degC' });
  const updated = recorder.status(4000).parameters.find(row => row.unit === 'degC');
  assert.equal(updated.week.records, 2);
  assert.equal(updated.week.averageIntervalMs, 3000);
  assert.equal(recorder.status(4000).parameters.find(row => row.unit === '%').week.records, 1);
});
