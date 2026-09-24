import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalRates,priceEnergy} from '../src/charging/rates.js';
import {Store} from '../src/storage/store.js';
import {recordedChargingEnergy} from '../src/charging/energy.js';
import {updateSessionCost} from '../src/charging/session-cost.js';
const HOUR=3600000,DAY=24*HOUR,START=1800000000000;
test('authoritative hour revisions replace quarter partitions and preserve uncovered scope',()=>{
 const old=Array.from({length:8},(_,i)=>({start:i*15,end:(i+1)*15,price:10}));
 const revised=canonicalRates(old,[{start:0,end:60,price:40}]);
 assert.equal(priceEnergy([{start:0,end:60,energyKwh:10}],revised).cents,400);
 assert.deepEqual(revised,[{start:0,end:60,priceCtPerKwh:40},{start:60,end:120,priceCtPerKwh:10}]);
 const partial=canonicalRates(revised,[{start:15,end:45,price:-5}]);
 assert.equal(priceEnergy([{start:0,end:60,energyKwh:10}],partial).cents,175);
 assert.deepEqual(canonicalRates(JSON.parse(JSON.stringify(partial))),partial);
});
test('canonical overlap integration matches an independent one-unit reference through revisions and gaps',()=>{
 const publications=[{start:0,end:30,price:5},{start:40,end:100,price:-1},{start:10,end:20,price:0},{start:60,end:75,price:8}];
 const energy=[{start:0,end:100,energyKwh:10},{start:14,end:67,energyKwh:3.4}];
 let cents=0,priced=0;
 for(const interval of energy)for(let at=interval.start;at<interval.end;at++){
  const owner=publications.findLast(row=>row.start<=at&&row.end>at);if(!owner)continue;
  const kwh=interval.energyKwh/(interval.end-interval.start);cents+=kwh*owner.price;priced+=kwh;
 }
 const result=priceEnergy(energy,canonicalRates([],publications));
 assert.ok(Math.abs(result.cents-cents)<1e-10);assert.ok(Math.abs(result.pricedKwh-priced)<1e-10);
});
test('1/7/30/90-day sessions price only actual overlaps including idle periods',t=>{
 for(const days of [1,7,30,90]){
  const prices=Array.from({length:days*96},(_,i)=>({start:START+i*HOUR/4,end:START+(i+1)*HOUR/4,price:(i%4)-2}));
  const energy=Array.from({length:days*24},(_,i)=>({start:START+i*HOUR,end:START+(i+1)*HOUR,energyKwh:i%3?0:2}));
  const result=priceEnergy(energy,canonicalRates([],prices));
  assert.equal(result.cents,-days*8);assert.equal(result.pricedKwh,days*16);assert.equal(result.overlaps,days*96);
  assert.equal(result.unpricedKwh,0);
 }
});
test('90-day current-schema SQL energy and cost reconstruction keeps numeric output across restart',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const days=90;
 store.transaction(()=>{for(let i=0;i<days*24;i++)store.observation({source:'shelly-evse',device:'synthetic-physical-evse',signal:'ev2_energy',value:i%3?0:2,unit:'kWh',sourceTime:START+(i+1)*HOUR,receivedAt:START+(i+1)*HOUR,quality:[],raw:{intervalStart:START+i*HOUR,intervalEnd:START+(i+1)*HOUR}});});
 const prices=Array.from({length:days*96},(_,i)=>({start:START+i*HOUR/4,end:START+(i+1)*HOUR/4,price:(i%4)-2}));
 const charger={id:'charger2',values:{connected:{value:true},soc:{value:80},minimumSoc:{value:80},capacityKwh:{value:57}},configuration:{efficiency:.925},settings:{enabled:false},progress:{connectionAt:START,remainingGridKwh:0}};
 const read=query=>recordedChargingEnergy(store,{...query,device:'synthetic-physical-evse'});
 const begin=performance.now(),cost=updateSessionCost(null,charger,START+days*DAY,prices,read);
 assert.equal(cost.accruedCents,-720);assert.equal(cost.deliveredGridKwh,1440);
 assert.equal(updateSessionCost(JSON.parse(JSON.stringify(cost)),charger,START+days*DAY,[],read).accruedCents,-720);
 t.diagnostic(`90-day SQL + canonical cost + same-format recovery: ${(performance.now()-begin).toFixed(1)} ms; 2160 meter intervals, 8640 rates`);
});
