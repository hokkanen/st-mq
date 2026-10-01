import { CHART_VIEW_BY_KEY } from '../src/domain/chart-views.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Envelope, getChartData } from '../src/app/chart-data.js';
import { historyDatasets } from '../chart/history-model.js';
const start=Date.parse('2026-01-01T00:00Z'),HOUR=3600000;
function source(store,signal,value,at,{unit='kW',raw,device='synthetic'}={}){
  store.observation({source:'fixture',device,signal,value,unit,sourceTime:at,receivedAt:at,raw});
}
function energy(store,prefix,kw,from,to){
  for(let phase=1;phase<=3;phase++)source(store,`${prefix}_energy_l${phase}`,
    kw*(to-from)/HOUR/3,to,{unit:'kWh',raw:{intervalStart:from,intervalEnd:to},device:prefix});
}
function noCrossings(result,raw){
  for(let i=1;i<result.length;i++)if(Number.isFinite(result[i-1].y)&&Number.isFinite(result[i].y))
    assert(!raw.some(point=>point.y===null&&point.x>result[i-1].x&&point.x<result[i].x),`Invented edge ${result[i-1].x}..${result[i].x}`);
}
test('bounded scalar envelopes retain repeated missing topology and conservatively mask overflowing outage buckets',()=>{
  for(const points of [100,800,2000])for(const gaps of [2,3,5000]){
    const raw=Array.from({length:gaps*2+1},(_,i)=>({x:100+i*100,y:i%2?null:i%6?10:20}));
    raw.push({x:raw.at(-1).x,y:null});
    const envelope=new Envelope(0,100000000000,points);
    for(const point of raw)envelope.add(point.x,point.y);
    const values=envelope.values();noCrossings(values,raw);assert(values.length<=16,'One bucket retains bounded topology metadata');
  }
});
test('the real chart producer preserves scalar outages on overview and detail responses',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const raw=[[100,10],[200,null],[300,10],[400,null],[500,20],[600,10]].map(([x,y])=>({x:start+x,y}));
  for(const point of raw)source(store,'indoor_temperature',point.y,point.x,{unit:'degC'});
  for(const points of [100,800,2000])for(const detail of [false,true]){
    const result=getChartData({store,input:'offline',now:start+HOUR,startDate:'2026-01-01',endDate:'2026-01-01',points,
      ...(detail?{viewFrom:start,viewTo:start+1000}:{})});
    noCrossings(result.series.indoor_temperature,raw);
    assert(result.series.indoor_temperature.some(point=>point.y===null&&point.x>=start+400));
  }
});
test('production power reduction preserves independent auxiliary maxima and every visible charging sum',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const auxiliary=[0,6,0,3,0],one=[1,0,7,6,1],two=[0,0,4,3,0],property=[8,25,20,17,8];
  for(let i=0;i<5;i++){
    const at=start+(i+1)*100,end=at+100;
    source(store,'auxiliary_power',auxiliary[i],at);
    for(const [prefix,kw] of [['property',property[i]],['ev1',one[i]],['ev2',two[i]]])energy(store,prefix,kw,at,end);
  }
  const keys=['auxiliary_power','charger_power','charger2_power'];
  for(const points of [100,800,2000]){
    const result=getChartData({store,input:'offline',now:start+HOUR,startDate:'2026-01-01',endDate:'2026-01-01',points});
    assert(result.meta.relatedSampling,'Exercises the shipped reduction and reprojection path');
    for(let mask=1;mask<8;mask++){
      const selected=keys.filter((_,i)=>mask&(1<<i));
      const preferences=Object.fromEntries(keys.map((key,i)=>[key,Boolean(mask&(1<<i))]));
      const datasets=historyDatasets(result.series, CHART_VIEW_BY_KEY.power,preferences);
      const chargers=selected.filter(key=>key!=='auxiliary_power');
      const expected=chargers.length?Math.max(...one.map((value,i)=>(preferences.charger_power?value:0)+(preferences.charger2_power?two[i]:0))):Math.max(...auxiliary);
      const top=datasets.find(dataset=>dataset.key===selected.at(-1));
      const actual=Math.max(...top.data.filter(point=>Number.isFinite(point.y)).map(point=>point.y));
      assert(Math.abs(actual-expected)<1e-9,`${mask}: ${actual} != ${expected}`);
      const aux=datasets.find(dataset=>dataset.key==='auxiliary_power');
      assert.equal(aux.fill,false);
      assert.equal(Math.max(...aux.data.map(point=>point.y).filter(Number.isFinite)),Math.max(...auxiliary));
    }
  }
});
test('interval energy remains visible as separate kWh marks across a multi-day gap and at clipped viewports',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  energy(store,'ev1',3,start,start+HOUR);energy(store,'ev1',3,start+48*HOUR,start+49*HOUR);
  for(const points of [100,2000]){
    const payload=getChartData({store,input:'offline',now:start+72*HOUR,startDate:'2026-01-01',endDate:'2026-01-03',left:'phase_energy',points});
    const dataset=historyDatasets(payload.series, CHART_VIEW_BY_KEY.interval_energy).find(row=>row.key==='ev1_energy_l1');
    assert.equal(dataset.kind,'interval-energy');assert.equal(dataset.showLine,false);assert(dataset.pointRadius>0);
    assert.deepEqual(dataset.data.filter(point=>Number.isFinite(point.y)).map(point=>point.y),[1,1]);
    assert.deepEqual(dataset.data.filter(point=>Number.isFinite(point.y)).map(point=>point.intervalEnd-point.intervalStart),[HOUR,HOUR]);
  }
});
