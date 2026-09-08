import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { chartRollupRows,rollupWatermark,energyRollupRows,ENERGY_ROLLUP_MS } from '../src/storage/chart-rollups.js';

const HOUR=3_600_000,MINUTE=60_000;
test('hourly temperature envelope preserves extrema, chronology and unavailable periods',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  for(const [at,value] of [[0,20],[MINUTE,25],[2*MINUTE,15],[3*MINUTE,null],[4*MINUTE,21]])
    store.observation({source:'synthetic',device:'fixture-house',signal:'indoor_temperature',value,unit:'degC',sourceTime:at,receivedAt:at});
  const rows=[...chartRollupRows(store.db,{from:0,to:HOUR,signals:['indoor_temperature']})];
  assert.deepEqual(rows.map(r=>r.value),[20,25,15,null,21]);
  assert.equal(rollupWatermark(store.db),0);
});

test('quarter-hour energy aggregation conserves phase energy across boundaries and leaves gaps unavailable',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const add=(start,end,value)=>store.observation({source:'easee',device:'fixture-charger',signal:'ev1_energy_l1',value,unit:'kWh',
    sourceTime:end,receivedAt:end,quality:['estimated'],raw:{intervalStart:start,intervalEnd:end,durationMs:end-start}});
  add(HOUR-2*MINUTE,HOUR+2*MINUTE,0.2);
  add(HOUR+2*MINUTE,HOUR+3*MINUTE,0.05);
  let rows=[...chartRollupRows(store.db,{from:0,to:2*HOUR,signals:['ev1_energy_l1']})];
  assert.ok(Math.abs(rows.reduce((n,r)=>n+r.value,0)-0.25)<1e-12);
  assert.equal(JSON.parse(rows[0].raw).durationMs,2*MINUTE);
  add(HOUR+4*MINUTE,HOUR+5*MINUTE,0.05);
  rows=[...chartRollupRows(store.db,{from:HOUR,to:2*HOUR,signals:['ev1_energy_l1']})];
  assert.equal(rows[0].value,null,'one minute without observations must not become zero consumption');
});

test('energy rollups separate quarter-hour price boundaries without averaging one tariff into another',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  for(let i=0;i<30;i++) store.observation({source:'easee',device:'fixture-charger',signal:'ev1_energy_l1',
    value:i<15?0.01:0.03,unit:'kWh',sourceTime:(i+1)*MINUTE,receivedAt:(i+1)*MINUTE,
    quality:['estimated'],raw:{intervalStart:i*MINUTE,intervalEnd:(i+1)*MINUTE,durationMs:MINUTE}});
  const rows=[...energyRollupRows(store.db,{from:0,to:HOUR})];
  assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.bucket),[0,ENERGY_ROLLUP_MS]);
  assert.ok(Math.abs(rows[0].energy-0.15)<1e-12);assert.ok(Math.abs(rows[1].energy-0.45)<1e-12);
  assert.ok(rows.every(r=>r.valid&&r.coveredMs===ENERGY_ROLLUP_MS&&r.count===15));
});

test('rollup updates participate in observation transaction rollback',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  assert.throws(()=>store.transaction(()=>{
    store.observation({source:'synthetic',device:'fixture',signal:'garage_temperature',value:10,unit:'degC',sourceTime:1000,receivedAt:1000});
    throw new Error('synthetic abort');
  }),/abort/);
  assert.equal(store.observations().length,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM chart_rollups').get().n,0);
});
