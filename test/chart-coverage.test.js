import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { getChartData,chartRange } from '../src/app/chart-data.js';
import { chartCoverageRows } from '../src/app/chart-coverage.js';

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
