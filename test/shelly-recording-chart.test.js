import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { getChartData } from '../src/app/chart-data.js';
import { addRecordedEnergy } from '../src/app/chart-energy.js';
import { historyTooltipLabel } from '../chart/history-tooltips.js';
import { HISTORY_AXIS_BY_KEY } from '../src/domain/history-series.js';
import { energyAuditRow } from '../chart/recording.js';

const MINUTE=60_000, HOUR=60*MINUTE;
const start=Date.parse('2026-08-19T10:00:00Z');
const near=(actual,expected)=>assert(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('charger phase energy coalesces and survives recorder restart without a duplicate total series',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  let recorder=new Recorder(store),last;
  const put=(from,to,power)=>recorder.recordEnergy(last={source:'shelly-evse',device:'invented-car',prefix:'ev2',
    start:from,end:to,energies:[.5,.3,.2].map(share=>share*power*(to-from)/HOUR),
    powers:[.5,.3,.2].map(share=>share*power),quality:['native_counter','phase_allocation_estimated']});
  for(let i=0;i<12;i++) {
    if(i===6)recorder=new Recorder(store);
    put(start+i*MINUTE/2,start+(i+1)*MINUTE/2,7.2);
  }
  assert.equal(recorder.recordEnergy(last).reason,'duplicate-interval');
  recorder.energyGap({source:'shelly-evse',device:'invented-car',prefix:'ev2',start:start+6*MINUTE,end:start+7*MINUTE,quality:['mqtt-disconnected']});
  put(start+7*MINUTE,start+8*MINUTE,3.6);
  recorder.flush(start+8*MINUTE,{force:true});
  const rows=store.observations({limit:100});
  assert(rows.length<24,'steady acquisition is compacted');
  assert.deepEqual([...new Set(rows.map(row=>row.signal))].sort(),['ev2_energy_l1','ev2_energy_l2','ev2_energy_l3']);
  near(rows.filter(row=>Number.isFinite(row.value)).reduce((sum,row)=>sum+row.value,0),0.78);
  assert.equal(rows.filter(row=>row.value===null && row.raw.intervalStart===start+6*MINUTE).length,3);
  assert(rows.filter(row=>row.value!==null).every(row=>row.raw.basis==='native-meter-counter-phase-allocation'));
  assert.equal(recorder.status(start+8*MINUTE).parameters[0].thresholdUnit,'kW');
});

test('charger 2 chart power and timing sum three phase energies, including durable open intervals',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const recorder=new Recorder(store);
  const interval=(a,b,energies)=>recorder.recordEnergy({source:'shelly-evse',device:'invented-car',prefix:'ev2',start:a,end:b,
    energies,powers:energies.map(kwh=>kwh*HOUR/(b-a)),quality:['native_counter','phase_allocation_estimated']});
  interval(start,start+10*MINUTE,[.6,.4,.2]);
  recorder.energyGap({source:'shelly-evse',device:'invented-car',prefix:'ev2',start:start+10*MINUTE,end:start+12*MINUTE});
  interval(start+12*MINUTE,start+22*MINUTE,[.3,.2,.1]);
  interval(start+22*MINUTE,start+32*MINUTE,[.3,.2,.1]);
  const options={store,input:'providers',startDate:'2026-08-19',endDate:'2026-08-19',now:start+HOUR};
  const power=getChartData({...options,left:'power'}),phases=getChartData({...options,left:'phase_energy'});
  const first=power.series.charger2_power.find(row=>row.x===start);
  near(first.y,7.2);
  assert.equal(first.basis,'native-meter-counter-delta');
  assert(power.series.charger2_power.some(row=>row.x===start+12*MINUTE && Math.abs(row.y-3.6)<1e-9));
  assert(power.series.charger2_power.some(row=>row.y===null && row.x>=start+10*MINUTE && row.x<start+12*MINUTE));
  const timing=[];
  addRecordedEnergy({store,range:{from:start,to:start+HOUR},now:start+HOUR,input:'providers',envelopes:{},
    timing:{addEnergy:(charger,from,to,kwh)=>timing.push({charger,from,to,kwh})}});
  assert(timing.every(row=>row.charger==='charger2'));
  near(timing.reduce((sum,row)=>sum+row.kwh,0),2.4);
  const tooltip=(key,point)=>historyTooltipLabel({dataset:{key,label:key,unit:'kWh'},parsed:{x:point.x,y:point.y},raw:point});
  assert.match(tooltip('charger2_power',first),/measured meter energy summed from three phases/);
  for(const [index,kwh] of [.6,.4,.2].entries()) {
    const values=phases.series[`ev2_energy_l${index+1}`];
    near(values.find(row=>row.intervalEnd===start+10*MINUTE).y,kwh);
    assert(values.some(row=>row.pending));
    assert(values.filter(row=>row.y!==null).every(row=>row.basis==='native-meter-counter-phase-allocation'));
    assert.match(tooltip(`ev2_energy_l${index+1}`,values.find(row=>row.y!==null)),/estimated phase allocation/);
  }
  assert.equal(HISTORY_AXIS_BY_KEY.ev2_energy,undefined,'there is no independently selectable stored total');
  assert(!store.observations().some(row=>['charger2_power','ev2_energy'].includes(row.signal)));
});

test('incomplete charger phase history leaves derived total power unavailable',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  for(const phase of [1,2]) store.observation({source:'shelly-evse',device:'invented-car',signal:`ev2_energy_l${phase}`,
    value:1,unit:'kWh',sourceTime:start+HOUR,receivedAt:start+HOUR,quality:[],
    raw:{intervalStart:start,intervalEnd:start+HOUR,basis:'native-meter-counter-phase-allocation'}});
  const result=getChartData({store,input:'providers',startDate:'2026-08-19',endDate:'2026-08-19',now:start+HOUR,left:'power'});
  assert(result.series.charger2_power.every(point=>point.y===null));
  assert.equal(result.timingBenefit.charger2.energyKwh,null);
});

test('energy checks show totals and evidence size with the same meaning for both chargers',()=>{
  const summary={recordedSessions:4,comparedSessions:2,excludedSessions:2,estimatedKwh:22,referenceKwh:20,
    differenceKwh:2,differencePercent:10,start,end:start+HOUR,lastSessionEnd:start+2*HOUR};
  const charger=energyAuditRow({kind:'charging-session-summary',source:'easee',summary});
  const second=energyAuditRow({kind:'charging-session-summary',source:'shelly-evse',summary});
  assert.equal(charger.title,'Charger 1');assert.equal(second.title,'Charger 2');
  assert.equal(charger.subtitle,second.subtitle);
  assert.equal(charger.value,'Recorded energy is 10.0% higher than the meter');
  assert.match(charger.context.join(' '),/22 kWh recorded · 20 kWh metered/);
  assert.match(second.context.join(' '),/Based on 2 of 4 completed sessions/);
  assert.equal(second.detailsLabel,'2 sessions excluded · details');
  const empty=energyAuditRow({kind:'charging-session-summary',source:'shelly-evse',summary:{recordedSessions:0,comparedSessions:0,excludedSessions:0}});
  assert.equal(empty.value,'No completed sessions recorded');
  assert.deepEqual(empty.context,[]);assert.deepEqual(empty.details,[]);
});

test('excluded sessions explain overlapping issues separately from comparison results',()=>{
  const display=energyAuditRow({kind:'charging-session-summary',source:'shelly-evse',summary:{
    recordedSessions:2,comparedSessions:0,excludedSessions:2,
    exclusionReasons:{disconnected:2,stale:2,'missing-start':1,'missing-end':1,'duplicate-suspected':1,
      'invented-private-payload':1},
  }});
  assert.equal(display.value,'No complete comparisons yet');
  assert.deepEqual(display.context,['All 2 sessions excluded from comparison.']);
  const details=display.details.join(' ');
  assert.match(details,/Recording interrupted by a disconnect or restart: 2 sessions/);
  assert.match(details,/Charging data stopped updating: 2 sessions/);
  assert.match(details,/Possible overlap with Charger 1 energy: 1 session/);
  assert.match(details,/Reason counts can overlap/);
  assert(!details.includes('reference is unavailable'));
  assert(!details.includes('invented-private-payload'));
  const easee=energyAuditRow({kind:'charging-session-summary',source:'easee',summary:{
    recordedSessions:1,comparedSessions:0,excludedSessions:1,exclusionReasons:{'incomplete-coverage':1},
  }});
  assert.match(easee.details.join(' '),/Incomplete recording: 1 session/);
  assert(!easee.value.includes('reference needed'));
});

test('tiny samples show their actual totals and session count without false precision or a signed percent',()=>{
  const display=energyAuditRow({kind:'charging-session-summary',source:'easee',summary:{
    recordedSessions:14,comparedSessions:2,excludedSessions:12,estimatedKwh:0.24002,referenceKwh:0.25,
    differenceKwh:-0.00998,differencePercent:-3.992,start,end:start+HOUR,
    exclusionReasons:{'incomplete-coverage':12,'zero-reference':6},
  }});
  assert.equal(display.value,'Recorded energy is 4.0% lower than the meter');
  assert.equal(display.context[0],'0.240 kWh recorded · 0.250 kWh metered');
  assert.equal(display.context[1],'Based on 2 of 14 completed sessions.');
  assert.match(display.details.join(' '),/Incomplete recording: 12 sessions/);
  assert.match(display.details.join(' '),/Meter reference is zero: 6 sessions/);
  assert.doesNotMatch(JSON.stringify(display),/average|energy-weighted|-3.99/);
});
