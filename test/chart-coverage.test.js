import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { getChartData,chartRange } from '../src/app/chart-data.js';
import { chartCoverageRows } from '../src/app/chart-coverage.js';
import { createChartLoader, historySeriesAt } from '../chart/history-model.js';
import { recordingChangedForSelection } from '../chart/history-chart.js';

const MINUTE=60_000,HOUR=60*MINUTE;
function fixture(t) {
  const store=new Store(':memory:');t.after(()=>store.close());
  const recorder=new Recorder(store),date='2026-01-15';
  const start=chartRange({startDate:date,now:Date.UTC(2026,0,16)}).from;
  const put=(signal,value,at,extra={})=>recorder.record({source:'husdata-h66',device:'synthetic-heatpump',signal,
    value,unit:signal==='compressor_active'||signal==='dhw_routing'?'state':'°C',sourceTime:at,receivedAt:at,
    quality:[],raw:{verified:true,usableForControl:true},...extra});
  return {store,recorder,date,start,put};
}

test('stale source values preserve their historical reading and create an availability gap on the receipt clock',t=>{
  const {store,date,start,put}=fixture(t);
  put('outdoor_temperature',20,start,{source:'fmi'});
  put('outdoor_temperature',20,start+31*MINUTE,{source:'fmi',sourceTime:start});
  put('outdoor_temperature',21,start+35*MINUTE,{source:'fmi'});
  const result=getChartData({store,input:'mqtt',startDate:date,endDate:date,now:start+HOUR,left:'outdoor_temperature'});
  const rows=result.series.outdoor_temperature;
  assert.ok(rows.some(row=>row.x===start&&row.y===20),'original point is not erased by a later stale poll');
  assert.ok(rows.some(row=>row.x===start+31*MINUTE&&row.y===null));
  assert.ok(rows.some(row=>row.x===start+35*MINUTE&&row.y===21));
  const long=getChartData({store,input:'mqtt',startDate:'2026-01-01',endDate:date,now:start+HOUR,left:'outdoor_temperature'});
  assert.ok(long.series.outdoor_temperature.some(row=>row.x===start&&row.y===20),'long views preserve the same original value');
  assert.equal(long.meta.historyBasis,'original-recorded-history');
  assert.ok(long.series.outdoor_temperature.some(row=>row.x===start+31*MINUTE&&row.y===null));
});

test('unavailable equipment immediately ends compressor shading rather than using its remaining five-minute hold',t=>{
  const {store,recorder,date,start,put}=fixture(t);
  put('compressor_active',1,start);put('dhw_routing',0,start);
  recorder.recordFailure({source:'husdata-h66',device:'synthetic-heatpump',signal:'compressor_active',unit:'state',at:start+MINUTE});
  const result=getChartData({store,input:'mqtt',startDate:date,endDate:date,now:start+4*MINUTE,left:'compressor_active'});
  assert.ok(result.series.compressor_active.some(row=>row.x===start+MINUTE&&row.y===null));
  assert.deepEqual(result.shading.compressorHome, [{start,end:start+MINUTE,value:1}]);
});

test('outages beginning before the range seed missing coverage and fresh recovery uses committed values only',t=>{
  const {store,recorder,start,put}=fixture(t);
  put('garage_temperature',10,start);
  recorder.recordFailure({source:'husdata-h66',device:'synthetic-heatpump',signal:'garage_temperature',unit:'°C',at:start+MINUTE});
  // No subsequent polls are needed: unavailable stays in effect until the
  // next confirmed state transition, not merely until the last failed poll.
  put('garage_temperature',11,start+3*HOUR);
  const rows=[...chartCoverageRows(store,{from:start+HOUR,to:start+4*HOUR,input:'mqtt',signals:['garage_temperature']})];
  assert.equal(rows[0].source_time,start+HOUR);assert.equal(rows[0].value,null);
  assert.equal(rows.at(-1).source_time,start+3*HOUR);assert.equal(rows.at(-1).value,11);
});

const periodic={source:'mqtt-temperature',raw:{reportIntervalMs:15*MINUTE,reportGraceMs:2*MINUTE}};

test('days of unchanged periodic temperatures remain flat in historical, long and narrow views',t=>{
  const {store,date,start,put}=fixture(t),first=start-24*HOUR,last=start+48*HOUR;
  for(let at=first;at<=last;at+=15*MINUTE) put('indoor_temperature',20,at,periodic);
  assert.equal(store.observations().length,1);
  for(const options of [{startDate:date,endDate:date},
    {startDate:'2026-01-01',endDate:'2026-01-16'},
    {startDate:date,endDate:date,viewFrom:start+5*HOUR,viewTo:start+5*HOUR+MINUTE}]) {
    const result=getChartData({store,input:'mqtt',now:last+HOUR,left:'indoor_temperature',...options});
    const rows=result.series.indoor_temperature;
    assert.ok(rows.length>=2);assert.ok(rows.every(row=>row.y===20));
    assert.ok(rows.every(row=>row.periodicCoverage&&row.displayBoundary&&row.observedAt===first));
    assert.ok(rows.some(row=>row.x===Math.max(first,result.range.from)));
    assert.ok(rows.some(row=>row.x===result.range.to));
  }
});

test('missing periodic messages break the chart at the report deadline and identical recovery stays separate',t=>{
  const {store,date,start,put}=fixture(t);
  put('indoor_temperature',20,start,periodic);
  put('indoor_temperature',20,start+15*MINUTE,periodic);
  put('indoor_temperature',20,start+60*MINUTE,periodic);
  const result=getChartData({store,input:'mqtt',startDate:date,endDate:date,now:start+90*MINUTE,left:'indoor_temperature'});
  const rows=result.series.indoor_temperature;
  assert.equal(store.observations().length,1);
  assert.ok(rows.some(row=>row.x===start+32*MINUTE&&row.y===null));
  assert.ok(rows.some(row=>row.x===start+60*MINUTE&&row.y===20));
  assert.ok(rows.some(row=>row.x===start+77*MINUTE&&row.y===null));
  assert.ok(rows.every(row=>row.y===null||row.x<start+32*MINUTE||row.x>=start+60*MINUTE));
  const gap=getChartData({store,input:'mqtt',startDate:date,endDate:date,now:start+90*MINUTE,
    left:'indoor_temperature',viewFrom:start+40*MINUTE,viewTo:start+45*MINUTE});
  assert.ok(gap.series.indoor_temperature.filter(row=>!row.displayContext).every(row=>row.y===null));
});

test('explicit disconnect ends periodic coverage immediately; cached browser tails expire without a new API response',t=>{
  const {store,recorder,date,start,put}=fixture(t);
  put('indoor_temperature',20,start,periodic);
  const payload=getChartData({store,input:'mqtt',startDate:date,endDate:date,now:start+MINUTE,left:'indoor_temperature'});
  const before=historySeriesAt(payload,start+10*MINUTE).indoor_temperature;
  assert.equal(before.at(-1).y,20);assert.equal(before.at(-1).observedAt,start);
  const expired=historySeriesAt(payload,start+18*MINUTE).indoor_temperature;
  assert.equal(expired.at(-1).x,start+17*MINUTE);assert.equal(expired.at(-1).y,null);
  recorder.recordFailure({source:'mqtt-temperature',device:'synthetic-heatpump',signal:'indoor_temperature',unit:'°C',at:start+2*MINUTE});
  put('indoor_temperature',20,start+10*MINUTE,periodic);
  const result=getChartData({store,input:'mqtt',startDate:date,endDate:date,now:start+15*MINUTE,left:'indoor_temperature'});
  assert.ok(result.series.indoor_temperature.some(row=>row.x===start+2*MINUTE&&row.y===null));
  assert.ok(result.series.indoor_temperature.some(row=>row.x===start+10*MINUTE&&row.y===20));
  assert.ok(result.series.indoor_temperature.every(row=>row.y===null||row.x<start+2*MINUTE||row.x>=start+10*MINUTE));
});

test('periodic source projection retains recorded holds while exposing neighbouring knots for cubic display',t=>{
  const {store,date,start,put}=fixture(t);
  put('indoor_temperature',20,start,periodic);
  put('indoor_temperature',20,start+15*MINUTE,periodic);
  put('indoor_temperature',21,start+30*MINUTE,periodic);
  const chart=getChartData({store,input:'mqtt',startDate:date,endDate:date,now:start+35*MINUTE,
    left:'indoor_temperature',viewFrom:start+20*MINUTE,viewTo:start+25*MINUTE});
  assert.equal(store.observations().length,2);
  assert.ok(chart.series.indoor_temperature.length>=2);
  assert.ok(chart.series.indoor_temperature.filter(point=>!point.displayContext).every(point=>point.y===20));
  assert.ok(chart.series.indoor_temperature.some(point=>point.displayContext&&point.x===start+30*MINUTE&&point.y===21));
});

test('live long-view caches renew report deadlines promptly while ordinary measurements retain their longer TTL',async t=>{
  const {store,recorder,date,start,put}=fixture(t),selection={startDate:'2026-01-01',endDate:date,left:'indoor_temperature'};
  let now=start+14*MINUTE,calls=0;
  put('indoor_temperature',20,start,periodic);
  const loader=createChartLoader({now:()=>now,api:async()=>{calls++;return getChartData({store,input:'mqtt',now,...selection});}});
  t.after(()=>loader.close());
  let previous=recorder.status(now);
  await loader.load(selection);
  now+=30_000;put('heating_integral',-100,now);
  let current=recorder.status(now);
  await loader.load(selection,{force:recordingChangedForSelection(selection,date,previous,current)});
  assert.equal(calls,1,'fast nonperiodic measurements do not force an expensive long view');
  previous=current;now=start+15*MINUTE;put('indoor_temperature',20,now,periodic);current=recorder.status(now);
  const refreshed=await loader.load(selection,{force:recordingChangedForSelection(selection,date,previous,current)});
  assert.equal(calls,2,'an unchanged genuine report refreshes before the five-minute TTL');
  assert.equal(refreshed.meta.lastReadings.indoor_temperature.reportExpiresAt,start+32*MINUTE);
  now=start+18*MINUTE;
  const display=historySeriesAt(await loader.load(selection),now).indoor_temperature;
  assert.equal(calls,2);assert.equal(display.at(-1).y,20,'the old seventeen-minute deadline does not create a false gap');
  assert.equal(recordingChangedForSelection({...selection,endDate:'2026-01-03'},date,previous,current),false);
  assert.equal(recordingChangedForSelection({...selection,startDate:'2026-01-20',endDate:'2026-01-30'},date,previous,current),false);
});

test('unchanged auxiliary zero and compressor shading survive compact multi-day source coverage',t=>{
  const {store,date,start,put}=fixture(t),first=start-24*HOUR,last=start+24*HOUR;
  for(let at=first;at<=last;at+=4*MINUTE) {
    put('auxiliary_output',0,at,{unit:'%',raw:{verified:true,usableForControl:true,ratedPowerKw:9}});
    put('auxiliary_power',0,at,{source:'controller-estimate',device:'mqtt',unit:'kW',quality:['estimated']});
    put('compressor_active',0,at);
    put('dhw_routing',0,at);
    put('operating_mode',1,at,{unit:'state'});
  }
  assert.equal(store.observations().length,5,'Steady idle values require one observation per signal');
  for(const options of [{startDate:date,endDate:date},
    {startDate:'2026-01-01',endDate:date},
    {startDate:date,endDate:date,viewFrom:start+5*HOUR,viewTo:start+5*HOUR+MINUTE}]) {
    const result=getChartData({store,input:'mqtt',now:last+HOUR,left:'power',...options});
    const rows=result.series.auxiliary_power;
    assert.ok(rows.length>=2);
    assert.ok(rows.every(row=>row.y===0));
    assert.ok(rows.every(row=>row.sourceCoverage&&row.observedAt===first));
    assert.deepEqual(result.shading.compressorHome,[{start:Math.max(first,result.range.from),end:result.range.to,value:0}]);
    assert.deepEqual(result.operatingModes,[{start:Math.max(first,result.range.from),end:result.range.to,value:1}]);
  }
});

test('source coverage preserves silent gaps, immediate failures, source expiry and unchanged recovery',t=>{
  const {store,recorder,date,start,put}=fixture(t);
  const record=at=>{
    put('compressor_active',1,at);put('dhw_routing',0,at);
    put('auxiliary_output',0,at,{unit:'%',raw:{verified:true,usableForControl:true,ratedPowerKw:9}});
  };
  record(start);record(start+4*MINUTE);record(start+12*MINUTE);
  recorder.recordFailure({source:'husdata-h66',device:'synthetic-heatpump',signal:'compressor_active',unit:'state',at:start+13*MINUTE});
  record(start+14*MINUTE);
  const result=getChartData({store,input:'mqtt',startDate:date,endDate:date,now:start+22*MINUTE,left:'compressor_active'});
  assert.deepEqual(result.shading.compressorHome,[
    {start,end:start+9*MINUTE,value:1},
    {start:start+12*MINUTE,end:start+13*MINUTE,value:1},
    {start:start+14*MINUTE,end:start+19*MINUTE,value:1},
  ]);
  for(const minute of [9,13,19]) assert.ok(result.series.compressor_active.some(row=>row.x===start+minute*MINUTE&&row.y===null));
  assert.ok(result.series.compressor_active.some(row=>row.x===start+14*MINUTE&&row.y===1));
});

test('as-of charts cannot borrow future compact source or periodic confirmations',t=>{
  const {store,date,start,put}=fixture(t);
  for(let minute=0;minute<=10;minute++) {
    put('compressor_active',1,start+minute*MINUTE);put('dhw_routing',0,start+minute*MINUTE);
    put('indoor_temperature',20,start+minute*MINUTE,{source:'mqtt-temperature',raw:{reportIntervalMs:5*MINUTE,reportGraceMs:0}});
  }
  const result=getChartData({store,input:'mqtt',startDate:date,endDate:date,now:start+8*MINUTE,left:'compressor_active'});
  assert.deepEqual(result.shading.compressorHome,[{start,end:start+5*MINUTE,value:1}]);
  for(const signal of ['compressor_active','indoor_temperature']) {
    assert.ok(result.series[signal].some(row=>row.x===start+5*MINUTE&&row.y===null));
    assert.ok(result.series[signal].every(row=>row.y===null||row.x<start+5*MINUTE));
  }
});

test('unchanged equipment confirmation refreshes current short selections while long and past dates retain their TTL',t=>{
  const {recorder,date,start,put}=fixture(t),selection={startDate:'2026-01-01',endDate:date,left:'power'};
  put('compressor_active',0,start);
  const before=recorder.status(start);
  put('compressor_active',0,start+MINUTE);
  const after=recorder.status(start+MINUTE);
  assert.equal(before.historyRevision,after.historyRevision);
  assert.notEqual(before.sourceReportRevision,after.sourceReportRevision);
  assert.equal(recordingChangedForSelection({...selection,startDate:date},date,before,after),true);
  assert.equal(recordingChangedForSelection(selection,date,before,after),false);
  assert.equal(recordingChangedForSelection({...selection,endDate:'2026-01-03'},date,before,after),false);
});

test('compact circulation feedback keeps zero visible with its configured expiry and real recovery',t=>{
  const {store,recorder,date,start,put}=fixture(t),first=start-6*HOUR;
  const feedback={source:'mqtt-equipment',device:'synthetic-circulation',unit:'state',
    raw:{maxAgeMs:2*MINUTE,reportIntervalMs:2*MINUTE,reportGraceMs:0,eventOnly:false,timeBasis:'mqtt-receipt'}};
  for(let at=first;at<=start+HOUR;at+=MINUTE) put('dhwr_active',0,at,feedback);
  assert.equal(store.observations({signal:'dhwr_active'}).length,1);
  put('dhwr_active',0,start+HOUR+5*MINUTE,feedback);
  recorder.recordFailure({source:feedback.source,device:feedback.device,signal:'dhwr_active',unit:'state',
    at:start+HOUR+6*MINUTE,quality:['mqtt-disconnected']});
  const result=getChartData({store,input:'mqtt',startDate:date,endDate:date,now:start+2*HOUR,view:'hot_water'});
  const rows=result.series.dhwr_active;
  assert.ok(rows.some(row=>row.x===start&&row.y===0&&row.observedAt===first));
  assert.ok(rows.some(row=>row.x===start+HOUR+2*MINUTE&&row.y===null));
  assert.ok(rows.some(row=>row.x===start+HOUR+5*MINUTE&&row.y===0));
  assert.ok(rows.some(row=>row.x===start+HOUR+6*MINUTE&&row.y===null));
  assert.ok(rows.every(row=>row.y===null||row.x<start+HOUR+2*MINUTE
    ||row.x>=start+HOUR+5*MINUTE&&row.x<start+HOUR+6*MINUTE));
});
