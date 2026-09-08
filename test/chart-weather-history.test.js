import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { historicalSolar } from '../src/app/chart-weather.js';
import { getChartData } from '../src/app/chart-data.js';

const HOUR=3_600_000,at=Date.parse('2026-09-08T09:00:00Z');
function save(store,fetchedAt,value,{issuedAt=at,solar={}}={}) {
  return store.snapshot({kind:'weather',source:'fmi',fetchedAt,issuedAt,
    payload:{source:'fmi',fetchedAt,forecast:[{start:at,end:at+12*HOUR,source:'fmi',outdoorC:10,
      solarRadiationWm2:value,fetchedAt,issuedAt,issuedAtBasis:'provider-result-time',
      solar:{source:'fmi',fetchedAt,issuedAt,issuedAtBasis:'provider-result-time',...solar}}]}});
}
test('solar history uses forecast versions only after acquisition and does not rewrite the past',()=>{
  const store=new Store(':memory:');
  try {
    save(store,at,100);save(store,at+HOUR,200);save(store,at+3*HOUR,900);
    const rows=[...historicalSolar(store,{from:at-HOUR,to:at+4*HOUR},at+2*HOUR)];
    assert.deepEqual(rows.map(r=>[r.start,r.end,r.solarRadiationWm2]),[[at,at+HOUR,100],[at+HOUR,at+2*HOUR,200]]);
    assert.equal(store.observations({signal:'solar_radiation'}).length,0);
    const chart=getChartData({store,input:'providers',now:at+2*HOUR,startDate:'2026-09-08',left:'solar_radiation'});
    assert(chart.series.solar_radiation.some(p=>p.y===100));assert(chart.series.solar_radiation.some(p=>p.y===200));
    assert(!chart.series.solar_radiation.some(p=>p.y===900));
  }finally{store.close();}
});
test('forecast refetches preserve issuance freshness and mixed solar source metadata',()=>{
  const store=new Store(':memory:');
  try {
    save(store,at,100,{solar:{source:'openmeteo'}});
    save(store,at+5*HOUR,100,{solar:{source:'openmeteo',fetchedAt:at}});
    const rows=[...historicalSolar(store,{from:at,to:at+10*HOUR},at+10*HOUR)];
    assert(rows.length>0);assert.equal(Math.max(...rows.map(r=>r.end)),at+6*HOUR);
    assert(rows.every(r=>r.solar.source==='openmeteo'&&r.solar.fetchedAt===at));
  }finally{store.close();}
});
test('unchanged unknown-issuance solar does not become fresh again after seven hours',()=>{
  const store=new Store(':memory:');
  try {
    for(const fetchedAt of [at,at+7*HOUR])save(store,fetchedAt,100,{issuedAt:null,solar:{issuedAtBasis:'fetched-snapshot'}});
    const rows=[...historicalSolar(store,{from:at+7*HOUR,to:at+9*HOUR},at+9*HOUR)];
    assert.deepEqual(rows,[]);
  }finally{store.close();}
});
