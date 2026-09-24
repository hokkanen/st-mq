import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { knownIntervals, chartRange, Envelope } from '../src/app/chart-data.js';
import { historicalSpotIntervals } from '../src/app/historical-spot-prices.js';
import { recordedEnergyStart, addRecordedEnergy } from '../src/app/chart-energy.js';
import { DailyTimingBenchmark } from '../src/app/daily-timing-benchmark.js';
import { timingDisplay } from '../chart/timing-model.js';
import { validateContract } from '../src/domain/prices.js';
import { resolveMarketIntervals } from '../src/domain/market-authority.js';
const HOUR=3600000, start=Date.parse('2026-01-01T00:00Z'), range={from:start,to:start+HOUR};
const near=(a,b)=>assert(Math.abs(a-b)<1e-10,`${a} != ${b}`);
function storeFor(t){const store=new Store(':memory:');t.after(()=>store.close());return store;}
function publication(store,{revision,price,fetchedAt=start,source='entsoe',parts=1,documentId='synthetic-document'}){
  const intervals=Array.from({length:parts},(_,i)=>({start:start+i*HOUR/parts,end:start+(i+1)*HOUR/parts,
    spotCtPerKwh:price,source,unit:'c/kWh',vatIncluded:false,documentId,revision,issuedAt:start-1000,fetchedAt}));
  store.snapshot({kind:'market',source,fetchedAt,payload:{source,fetchedAt,intervals}});
}
test('market revision authority survives receipt and insertion reorder, changed partition and source fallback',t=>{
  for(const order of [[2,1],[1,2]]){
    const store=storeFor(t);
    for(const revision of order)publication(store,{revision,price:revision*10,fetchedAt:start+revision*1000,parts:revision===2?4:1});
    const early=knownIntervals(null,store,range,start+1500);assert(early.every(row=>row.spotCtPerKwh===10));
    const result=knownIntervals(null,store,range,start+3000);
    assert(result.every(row=>row.spotCtPerKwh===20&&row.revision===2));
    assert.equal(result.reduce((n,row)=>n+row.end-row.start,0),HOUR);
    publication(store,{revision:1,price:10,fetchedAt:start+4000});
    publication(store,{source:'elering',revision:null,documentId:null,price:99,fetchedAt:start+5000});
    assert(knownIntervals(null,store,range,start+6000).every(row=>row.spotCtPerKwh===20));
  }
});
test('equal-revision conflict is unavailable and cannot be replaced by scalar fallback; partial absence is not withdrawal',t=>{
  const store=storeFor(t);publication(store,{revision:1,price:10});publication(store,{revision:1,price:11,fetchedAt:start+1});
  store.observation({source:'fixture',signal:'spot_price',device:'synthetic',value:90,unit:'c/kWh_ex_vat',sourceTime:start,receivedAt:start});
  assert.deepEqual(knownIntervals(null,store,range,start+2),[]);
  publication(store,{revision:2,price:20,fetchedAt:start+3});
  assert(knownIntervals(null,store,range,start+4).every(row=>row.spotCtPerKwh===20));
  const partial=storeFor(t);publication(partial,{revision:1,price:10});
  partial.snapshot({kind:'market',source:'entsoe',fetchedAt:start+1,payload:{intervals:[{start,end:start+HOUR/4,
    unit:'c/kWh',vatIncluded:false,spotCtPerKwh:20,documentId:'synthetic-document',revision:2,source:'entsoe'}]}});
  assert.deepEqual(knownIntervals(null,partial,range,start+2).map(row=>[row.end-row.start,row.spotCtPerKwh]),[[HOUR/4,20],[3*HOUR/4,10]]);
});
test('interleaved documents cannot restore an older revision through a nontransitive publication comparison',()=>{
  const base={start,end:start+HOUR,source:'entsoe',unit:'c/kWh',vatIncluded:false,fetchedAt:start};
  const a2={...base,documentId:'a',revision:2,issuedAt:100,spotCtPerKwh:20},
    b1={...base,documentId:'b',revision:1,issuedAt:200,spotCtPerKwh:30},
    a1={...base,documentId:'a',revision:1,issuedAt:300,spotCtPerKwh:10};
  for(const rows of [[a2,b1,a1],[a1,b1,a2],[b1,a1,a2],[b1,a2,a1]]){
    const result=resolveMarketIntervals(rows,range);
    assert.equal(result.length,1);assert.equal(result[0].spotCtPerKwh,30);assert.equal(result[0].documentId,'b');
  }
});
test('receipt and current import completion precede price winner selection, including late missing winners',t=>{
  const store=storeFor(t),put=(value,at,extra={})=>store.observation({source:'fixture',device:'synthetic',signal:'spot_price',
    value,unit:'c/kWh_ex_vat',sourceTime:start,receivedAt:at,...extra});
  put(10,start);put(99,start+HOUR);
  assert.equal(historicalSpotIntervals(store,range,start+1)[0].spotCtPerKwh,10);
  assert.equal(historicalSpotIntervals(store,range,start+HOUR)[0].spotCtPerKwh,99);
  put(null,start+2*HOUR);assert.equal(historicalSpotIntervals(store,range,start+HOUR)[0].spotCtPerKwh,99);
  assert.deepEqual(historicalSpotIntervals(store,range,start+2*HOUR),[]);
  const imported=storeFor(t),id=Number(imported.db.prepare("INSERT INTO imports(kind,sha256,path,status,started_at,completed_at) VALUES('stmq','synthetic','synthetic.csv','complete',?,?)").run(start,start+HOUR).lastInsertRowid);
  imported.observation({source:'csv:stmq',device:'legacy_stmq',signal:'spot_price',value:7,unit:'c/kWh_ex_vat',sourceTime:start,receivedAt:start,provenance:{importId:id,rowNumber:1}});
  assert.deepEqual(historicalSpotIntervals(imported,range,start+HOUR-1),[]);
  assert.equal(historicalSpotIntervals(imported,range,start+HOUR)[0].spotCtPerKwh,7);
});
function energy(store,{device='synthetic-a',prefix='ev1',from=start,to=start+HOUR,kwh=3,receivedAt=to,source='easee'}={}){
  const count=prefix==='ev2'?1:3;
  return new Recorder(store).recordEnergy({source,device,prefix,start:from,end:to,receivedAt,
    energies:Array(count).fill(kwh/count),powers:Array(count).fill(kwh*HOUR/(to-from)/count),quality:['estimated']});
}
function projection(store,now=start+2*HOUR){
  const day=chartRange({startDate:'2026-01-01',now}),timing=new DailyTimingBenchmark(range,now,[{start:day.from,end:day.to,totalCtPerKwh:20}]);
  const envelopes=Object.fromEntries(['charger_power','charger2_power','property_power'].map(key=>[key,new Envelope(range.from,range.to,100)]));
  const meta=addRecordedEnergy({store,range,now,input:'providers',envelopes,timing});return{meta,result:timing.result(),envelopes};
}
test('logical energy conflicts quarantine original cohorts without double cost; identical lineage remains idempotent',t=>{
  const store=storeFor(t);energy(store);energy(store);energy(store,{device:'synthetic-b'});
  const result=projection(store);assert.equal(result.meta.conflicts,1);assert.equal(result.result.charger1.energyKwh,null);
  assert(!result.envelopes.charger_power.values().some(row=>Number.isFinite(row.y)));
  assert.equal(store.observations({signal:'ev1_energy_l1'}).length,2,'Conflicting source records remain available for diagnosis');
});
test('exact-edge device transitions remain additive; partial overlap and future receipts cannot acquire authority',t=>{
  const store=storeFor(t);energy(store,{to:start+HOUR/2,kwh:1.5});energy(store,{device:'synthetic-b',from:start+HOUR/2,kwh:1.5});
  near(projection(store).result.charger1.energyKwh,3);
  energy(store,{device:'synthetic-future',receivedAt:start+3*HOUR});near(projection(store).result.charger1.energyKwh,3);
  assert.equal(projection(store,start+3*HOUR).result.charger1.energyKwh,null);
  const future=storeFor(t);energy(future,{receivedAt:start+3*HOUR});
  assert.equal(recordedEnergyStart(future,'ev1','providers',start+2*HOUR),Infinity);
  assert.equal(recordedEnergyStart(future,'ev1','providers',start+3*HOUR),start);
});
test('physical charger timing exposes each scope and combines energy with explicit charger-time coverage',t=>{
  const store=storeFor(t);energy(store);energy(store,{device:'synthetic-c2',prefix:'ev2',source:'shelly-evse',kwh:2});
  const {result}=projection(store);near(result.charger1.energyKwh,3);near(result.charger2.energyKwh,2);near(result.charger.energyKwh,5);
  near(result.charger.actualCostEuro,1);assert.equal(result.charger.coverageDetails.coverageBasis,'charger-time');
  assert.equal(result.charger.coverageDetails.includedMs,2*HOUR);assert.equal(result.charger.coverageDetails.elapsedMs,2*HOUR);
  assert.equal(result.charger.coverage,1);
  const display=timingDisplay('charger',result.charger,{timingBenefit:result,range,now:start+2*HOUR});
  assert.match(display.coverageLabel,/charger-time/);assert(display.breakdown.some(row=>row.startsWith('Charger 2:')));
  const one=storeFor(t);energy(one);const partial=projection(one).result;
  near(partial.charger.energyKwh,3);assert.equal(partial.charger.coverage,0.5);assert.equal(partial.charger.provisional,true);
});
test('native contracts require explicit tax basis; historical inclusive values remain explicit supported facts',()=>{
  const period={from:start,marginCtPerKwh:0,taxCtPerKwh:0,vatRate:0};assert.throws(()=>validateContract({periods:[period]}),/explicitly/);
  assert.equal(validateContract({periods:[{...period,transferRates:{vatIncluded:true,dayCtPerKwh:1,nightCtPerKwh:1,winterDayCtPerKwh:1,otherCtPerKwh:1}}]}).periods[0].transferRates.vatIncluded,true);
});
test('Charger 2 alone retains interval evidence and partial-day coverage sums charger time without inventing Charger 1',()=>{
  const end=start+HOUR,now=start+HOUR/2,day=chartRange({startDate:'2026-01-01',now:end});
  const timing=new DailyTimingBenchmark({from:start,to:end},now,[{start:day.from,end:day.to,totalCtPerKwh:20}]);
  timing.addEnergy('charger2',start,start+HOUR/4,1,{key:'native-shelly-evse-energy'});
  const result=timing.result();
  assert.equal(result.charger1.energyKwh,null);near(result.charger2.energyKwh,1);
  near(result.charger.actualCostEuro,.2);assert.equal(result.charger.evidence.timeBasis,'recorded-interval-time');
  assert.equal(result.charger.coverageDetails.elapsedMs,HOUR);
  assert.equal(result.charger.coverageDetails.includedMs,HOUR/4);
  assert.equal(result.charger.coverageDetails.missingPowerMs,3*HOUR/4);
  assert.equal(result.charger.coverage,.25);assert.equal(result.charger.provisional,true);
});
