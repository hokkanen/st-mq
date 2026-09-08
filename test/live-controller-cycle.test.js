import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { validateSettings, CONTROL_DEFAULTS } from '../src/app/config.js';
import { initialAdaptiveModel, restoreAdaptiveCheckpoint } from '../src/control/adaptive-learning.js';
import { evaluateCycle } from '../src/control/planner.js';
import { createH66Controller } from '../src/control/h66.js';
import { createH66Decoder, auxiliaryPowerFromOutput } from '../src/domain/telemetry.js';

const HOUR = 3_600_000;
function setup(t, { mode = 'active', delayed = false, store = new Store(':memory:') } = {}) {
  let now = Date.parse('2026-09-07T21:00Z'), acknowledge;
  const commands = [], config = { input:'mqtt', settings:validateSettings({mode,comfort:{targetC:21}}), control:{...CONTROL_DEFAULTS,learningTrials:false} };
  const transport = { publish: batch => {
    commands.push([...batch]);
    if (delayed) return new Promise(resolve => { acknowledge = () => resolve({status:'mqtt',sent:true,actual:null}); });
    return Promise.resolve({status:'mqtt',sent:true,actual:null});
  } };
  const engine = new Engine({store,config,clock:()=>now,commandTransport:transport});
  const ingest = (signal,value) => engine.ingest({source:signal==='outdoor_temperature'?'fmi':'synthetic',device:'fixture',signal,value,unit:'degC',sourceTime:now,receivedAt:now,quality:[],raw:null});
  const intervals = Array.from({length:24},(_,i)=>({start:now+i*900000,end:now+(i+1)*900000,outdoorC:10,price:20,solarRadiationWm2:0}));
  store.setState('provider:market',{fetchedAt:now,intervals:[{start:now,end:now+6*HOUR,spotCtPerKwh:20,unit:'c/kWh',vatIncluded:false}]});
  store.setState('provider:weather',{issuedAt:now,fetchedAt:now,forecast:[{start:now,end:now+6*HOUR,outdoorC:10,solarRadiationWm2:0,issuedAt:now,fetchedAt:now,source:'fixture'}]});
  store.setState('contract:mqtt',{mode:'billing',periods:[{from:0,to:null,marginCtPerKwh:0,taxCtPerKwh:0,vatRate:0,tariff:'day-night',transferRates:{vatIncluded:false,dayCtPerKwh:0,nightCtPerKwh:0,winterDayCtPerKwh:0,otherCtPerKwh:0}}]});
  ingest('indoor_temperature',21.2); ingest('outdoor_temperature',10);
  t.after(async()=>{ clearTimeout(engine.executor.timer); engine.executor.closed=true; await engine.h66?.close(); if(!store.closed) store.close(); });
  return {engine,store,config,transport,commands,intervals,ingest,get now(){return now;},
    advance(ms){now+=ms;ingest('indoor_temperature',21.2);ingest('outdoor_temperature',10);},
    acknowledge(){acknowledge();},async settle(){await engine.dispatchPending;},
    plan(){ const model=initialAdaptiveModel(), schedule={preheatStart:now,preheatEnd:now,reductionStart:now,reductionEnd:now+900000,roomBoostC:0};
      const args={intervals,model,initialState:{indoorC:21.2,reserveC:21.2},targetC:21,config:CONTROL_DEFAULTS};
      engine.pendingPlan={schedule,model,initialState:args.initialState,targetC:21,intervals,reference:null,referenceLabel:'continuous normal operation',
        prediction:evaluateCycle({...args,schedule}),referencePrediction:evaluateCycle(args),trial:false}; return engine.pendingPlan; },
    native(){const values={'0203':19,'0212':47,'0208':62,'2201':1},decoder=createH66Decoder({deviceId:'synthetic'});
      const receive=(index,value)=>{values[index]=value;const decoded=decoder.decode({topic:`synthetic/HP/${index}`,payload:String(value),receivedAt:now});
        h66.ingest(decoded);engine.ingest({source:'husdata-h66',device:'synthetic',signal:decoded.signal,value:decoded.value,unit:decoded.unit,sourceTime:now,receivedAt:now,quality:decoded.issues,raw:{usableForControl:decoded.usableForControl,verified:true}});};
      const h66=createH66Controller({deviceId:'synthetic',store,clock:()=>now,config:{writeEnabled:true,readbackTimeoutMs:30},publish:async(topic,payload)=>queueMicrotask(()=>receive(topic.split('/').at(-1),Number(payload)))});
      h66.setConnected(true);for(const[index,value]of Object.entries(values))receive(index,value);engine.setH66(h66);
      return {values,receive,h66}; }
  };
}

test('a due base cycle remains intent until broker acknowledgement, then pause restores normal', async t=>{
  const r=setup(t,{delayed:true});r.plan();
  const status=r.engine.tick(); assert.equal(status.decision.phase,'reduction',JSON.stringify({reasons:status.decision.reasons,prices:status.priceStatus,weather:status.weatherStatus}));assert.equal(status.h66.available,false);assert.equal(status.execution.status,'pending');
  assert.equal(r.engine.cycles.active(),null);assert.equal(r.store.getState('applied:mqtt'),null);
  await Promise.resolve();r.acknowledge();await r.settle();
  assert.equal(r.engine.applied.phase,'reduction');assert.ok(r.engine.cycles.active());
  assert.deepEqual(r.commands,[['heatoff']]);
  r.engine.setOverride(15);await Promise.resolve();r.acknowledge();await r.settle();
  assert.equal(r.engine.applied.phase,'recovery');assert.deepEqual(r.commands.at(-1),['heaton15']);
  const request=r.store.latestObservation('controller_phase');assert.equal(request.raw.expiresAt,r.now+1_800_000);assert.equal(request.raw.verified,false);
});

test('native setting tests remain active for their bounded interval across controller ticks',async t=>{
  const r=setup(t);const native=r.native();
  await r.engine.testH66({register:'0212',value:40,durationMinutes:2});
  assert.equal(native.values['0212'],40);
  assert.equal(r.engine.tick().execution.status,'manual-test-in-progress');assert.equal(r.commands.length,0);
  r.advance(60_000);assert.equal(r.engine.tick().execution.status,'manual-test-in-progress');assert.equal(native.values['0212'],40);
  r.advance(60_000);await native.h66.reconcile({now:r.now});
  assert.equal(native.values['0212'],47);r.engine.tick();await r.settle();assert.deepEqual(r.commands.at(-1),['heaton15']);
});

test('a restarted interrupted live cycle is incomplete while relay restoration remains durable',async t=>{
  const r=setup(t);r.plan();r.engine.tick();await r.settle();assert.ok(r.engine.cycles.active());
  clearTimeout(r.engine.executor.timer);
  const restarted=new Engine({store:r.store,config:{...r.config,settings:validateSettings({mode:'shadow'})},clock:()=>r.now,commandTransport:r.transport});
  t.after(()=>{clearTimeout(restarted.executor.timer);restarted.executor.closed=true;});
  assert.equal(restarted.cycles.active(),null);assert.equal(restarted.applied.at,null);
  assert.equal(r.store.cycles({input:'mqtt'})[0].status,'incomplete');
  restarted.tick();await restarted.dispatchPending;
  assert.deepEqual(r.commands.at(-1),['heaton15']);assert.equal(restarted.executor.status().legacyOutstanding,false);
});

test('history baseline arriving after startup is adopted without replacing live temperature records',async t=>{
  const r=setup(t,{mode:'shadow'});r.engine.tick();const cursor=r.engine.checkpoint.cursor;
  const history=restoreAdaptiveCheckpoint(null);history.baselineC=21.4;history.comfortReference={targetC:21.4};
  r.store.setState('adaptive:history',history);r.engine.tick();
  assert.equal(r.engine.checkpoint.baselineC,21.4);assert.equal(r.engine.checkpoint.cursor,cursor);
});

test('corrupt checkpoint replays persisted samples and corrupt background JSON cannot break live status',async t=>{
  const r=setup(t,{mode:'shadow'});
  for(let i=0;i<3;i++)r.store.learningSample('mqtt',{timestamp:r.now-(3-i)*900000,indoorC:21.2,outdoorC:10,phase:'normal',regime:'occupied',quality:[]});
  r.store.db.prepare('INSERT INTO state(key,value,updated_at) VALUES(?,?,?)').run('adaptive:mqtt','{broken',0);
  r.store.db.prepare('INSERT INTO state(key,value,updated_at) VALUES(?,?,?)').run('adaptive:history','{broken',0);
  assert.doesNotThrow(()=>r.engine.tick());assert.equal(r.engine.checkpoint.samples.length,4);
  assert.ok(r.store.events().some(e=>e.type==='checkpoint-rebuild'));
  const valid=r.engine.checkpoint;r.engine.checkpoint=null;r.store.setState('adaptive:mqtt',{version:1,samples:[],model:{},health:{}});
  assert.doesNotThrow(()=>r.engine.tick());assert.ok(r.engine.checkpoint.model.parameters.lossPerHour>0);
  assert.equal(r.engine.checkpoint.cursor,valid.cursor);
});

test('manual ROOM change resets the indoor reference while preserving learned physics and excluding old history',async t=>{
  const r=setup(t,{mode:'shadow'});const native=r.native();r.engine.tick();
  r.engine.checkpoint.baselineC=21.4;r.engine.checkpoint.comfortReference={targetC:21.4};
  r.store.setState('adaptive:history',structuredClone(r.engine.checkpoint));const parameters=structuredClone(r.engine.checkpoint.model.parameters);
  r.advance(60_000);native.receive('0203',18);r.engine.tick();
  assert.equal(r.engine.checkpoint.baselineC,null);assert.deepEqual(r.engine.checkpoint.model.parameters,parameters);
  r.engine.tick();assert.equal(r.engine.checkpoint.baselineC,null);
});

test('near-third H66 output maps to nominal stages and other percentages stay explicitly proportional',()=>{
  assert.deepEqual([0,33,67,100].map(p=>auxiliaryPowerFromOutput(p).kw),[0,3,6,9]);
  assert.deepEqual(auxiliaryPowerFromOutput(50),{kw:4.5,stage:null,basis:'proportional-output-estimate'});
});
