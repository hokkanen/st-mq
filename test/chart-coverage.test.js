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
  put('outdoor_temperature',20,start);
  put('outdoor_temperature',20,start+6*MINUTE,{sourceTime:start});
  put('outdoor_temperature',21,start+10*MINUTE);
  const result=getChartData({store,input:'mqtt',startDate:date,endDate:date,now:start+HOUR,left:'outdoor_temperature'});
  const rows=result.series.outdoor_temperature;
  assert.ok(rows.some(row=>row.x===start&&row.y===20),'original point is not erased by a later stale poll');
  assert.ok(rows.some(row=>row.x===start+6*MINUTE&&row.y===null));
  assert.ok(rows.some(row=>row.x===start+10*MINUTE&&row.y===21));
  const long=getChartData({store,input:'mqtt',startDate:'2026-01-01',endDate:date,now:start+HOUR,left:'outdoor_temperature'});
  assert.ok(long.series.outdoor_temperature.some(row=>row.x===start&&row.y===20),'long views preserve the same original value');
  assert.equal(long.meta.historyBasis,'original-recorded-history');
  assert.ok(long.series.outdoor_temperature.some(row=>row.x===start+6*MINUTE&&row.y===null));
});

test('unavailable equipment immediately ends compressor shading rather than using its remaining five-minute hold',t=>{
  const {store,recorder,date,start,put}=fixture(t);
  put('compressor_active',1,start);put('dhw_routing',0,start);
  recorder.recordFailure({source:'husdata-h66',device:'synthetic-heatpump',signal:'compressor_active',unit:'state',at:start+MINUTE});
  const result=getChartData({store,input:'mqtt',startDate:date,endDate:date,now:start+4*MINUTE,left:'compressor_active'});
  assert.ok(result.series.compressor_active.some(row=>row.x===start+MINUTE&&row.y===null));
  assert.ok(result.shading.compressorSpace.every(row=>row.end<=start+MINUTE));
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
  assert.ok(gap.series.indoor_temperature.every(row=>row.y===null));
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

test('a changed periodic reading steps from the confirmed prior value without a fifteen-minute interpolation ramp',t=>{
  const {store,date,start,put}=fixture(t);
  put('indoor_temperature',20,start,periodic);
  put('indoor_temperature',20,start+15*MINUTE,periodic);
  put('indoor_temperature',21,start+30*MINUTE,periodic);
  const chart=getChartData({store,input:'mqtt',startDate:date,endDate:date,now:start+35*MINUTE,
    left:'indoor_temperature',viewFrom:start+20*MINUTE,viewTo:start+25*MINUTE});
  assert.equal(store.observations().length,2);
  assert.ok(chart.series.indoor_temperature.length>=2);
  assert.ok(chart.series.indoor_temperature.every(point=>point.y===20));
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
