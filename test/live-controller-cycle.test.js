import { appendLearningRecord, currentComfortReference } from './helpers/home-learning-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { replayLearningJournal, LEARNING_ALGORITHM } from '../src/app/committed-learning.js';
import { Engine } from '../src/app/engine.js';
import { validateSettings, CONTROL_DEFAULTS } from '../src/app/config.js';
import { initialAdaptiveModel, restoreAdaptiveCheckpoint } from '../src/control/adaptive-learning.js';
import { evaluateCycle } from '../src/control/planner.js';
import { createH66Controller } from '../src/control/h66.js';
import { createH66Decoder, auxiliaryPowerFromOutput } from '../src/domain/telemetry.js';

const HOUR = 3_600_000;
function setup(t, { automationEnabled = true, delayed = false, store = new Store(':memory:') } = {}) {
  let now = Date.parse('2026-09-07T21:00Z'), acknowledge;
  const commands = [], config = { input:'mqtt', settings:validateSettings({comfort:{targetC:21,maxDropC:2,maxRiseC:2}}), control:{...CONTROL_DEFAULTS,learningTrials:false} };
  const transport = { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) }, publish: batch => {
    commands.push([...batch]);
    if (delayed) return new Promise(resolve => { acknowledge = () => resolve({status:'mqtt',sent:true,actual:null}); });
    return Promise.resolve({status:'mqtt',sent:true,actual:null});
  } };
  const engine = new Engine({store,config,clock:()=>now,commandTransport:transport});
  engine.automation.set('home', automationEnabled);
  engine.automation.set('home', automationEnabled);
  const ingest = (signal,value) => engine.ingest({source:signal==='outdoor_temperature'?'fmi':'synthetic',device:'fixture',signal,value,unit:'degC',sourceTime:now,receivedAt:now,quality:[],raw:null});
  const intervals = Array.from({length:24},(_,i)=>({start:now+i*900000,end:now+(i+1)*900000,outdoorC:10,price:i===0?2000:1,solarRadiationWm2:0}));
  store.setState('provider:market',{fetchedAt:now,intervals:intervals.map(row=>({...row,spotCtPerKwh:row.price,unit:'c/kWh',vatIncluded:false}))});
  store.setState('provider:weather',{issuedAt:now,fetchedAt:now,forecast:[{start:now,end:now+6*HOUR,outdoorC:10,solarRadiationWm2:0,issuedAt:now,fetchedAt:now,source:'fixture'}]});
  store.setState('contract:mqtt',{mode:'billing',periods:[{from:0,to:null,marginCtPerKwh:0,taxCtPerKwh:0,vatRate:0,tariff:'day-night',transferRates:{vatIncluded:false,dayCtPerKwh:0,nightCtPerKwh:0,winterDayCtPerKwh:0,otherCtPerKwh:0}}]});
  ingest('indoor_temperature',21.2); ingest('outdoor_temperature',10);
  t.after(async()=>{ clearTimeout(engine.executor.timer); engine.executor.closed=true; await engine.h66?.close(); if(!store.closed) store.close(); });
  return {engine,store,config,transport,commands,intervals,ingest,get now(){return now;},
    advance(ms){now+=ms;ingest('indoor_temperature',21.2);ingest('outdoor_temperature',10);},
    acknowledge(){acknowledge();},async settle(){await engine.dispatchPending;},
    plan(){ const model=initialAdaptiveModel(), schedule={preheatStart:now,preheatEnd:now,reductionStart:now,reductionEnd:now+900000,roomBoostC:0,treatmentKey:'reduction-only-v1'};
      // Synthetic accepted evidence isolates delivery/restoration from model fitting.
      model.validation={accepted:true,kind:'conditional-thermal',samples:3,
        parameterEvidence:{lossPerHour:{status:'identified'},hydronicCPerKwh:{status:'identified'}}};
      model.equipmentResponse={phases:{reduction:{ratio:.1,trainingEpisodes:3,treatmentKey:'reduction-only-v1'}},
        validation:{phases:{reduction:{accepted:true,episodes:3,maeDuty:.05,maxDurationHours:.5,treatmentKey:'reduction-only-v1'}}}};
      model.uncertainty={points:[{hours:.25,errorC:.1},{hours:24,errorC:.1}],extrapolationCPerHour:.05};
      model.forecastValidation={accepted:true,episodes:3,maxReductionHours:.5};
      engine.checkpoint=restoreAdaptiveCheckpoint(null);engine.checkpoint.model=model;
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
  await new Promise(resolve=>setImmediate(resolve));r.acknowledge();await r.settle();
  assert.equal(r.engine.applied.phase,'reduction');assert.ok(r.engine.cycles.active());
  assert.deepEqual(r.commands,[['reduction']]);
  r.engine.setTemporary({ pauseUntil: new Date(r.engine.clock() + 15 * 60_000).toISOString() });await new Promise(resolve=>setImmediate(resolve));r.acknowledge();await r.settle();
  assert.equal(r.engine.applied.phase,'normal');assert.deepEqual(r.commands.at(-1),['normal']);
  const request=r.store.latestObservation('controller_phase');assert.equal(request.raw.expiresAt,r.now+1_800_000);assert.equal(request.raw.verified,false);
});

test('native setting tests remain active for their bounded interval across controller ticks',async t=>{
  const r=setup(t);const native=r.native();
  await r.engine.testH66({register:'0212',value:40,durationMinutes:2});
  assert.equal(native.values['0212'],40);
  assert.equal(r.engine.tick().execution.status,'manual-test-in-progress');assert.equal(r.commands.length,0);
  r.advance(60_000);assert.equal(r.engine.tick().execution.status,'manual-test-in-progress');assert.equal(native.values['0212'],40);
  r.advance(60_000);await native.h66.reconcile({now:r.now});
  assert.equal(native.values['0212'],47);r.engine.tick();await r.settle();assert.deepEqual(r.commands.at(-1),['normal']);
});

test('direct native settings survive automatic controller updates without an expiry', async t => {
  const r = setup(t, { automationEnabled: false }), native = r.native();
  r.engine.tick(); await r.settle();
  await assert.rejects(r.engine.setH66Setting({ register: '0203', value: 20, durationMinutes: 2 }), /Choose an H66/);
  const changed = await r.engine.setH66Setting({ register: '0203', value: 20 });
  assert.equal(changed.h66.lastManual.confirmed, true);
  assert.equal(native.values['0203'], 20);
  assert.equal(r.engine.heatingTestBusy, false);
  assert.equal(changed.h66.expiresAt, null);
  assert.deepEqual(changed.h66.obligations, {});
  r.advance(1000); r.engine.tick(); await r.settle();
  assert.equal(native.values['0203'], 20);
  r.advance(60_000); r.engine.tick(); await r.settle();
  assert.equal(native.values['0203'], 20);
  assert.equal(native.h66.status().expiresAt, null);
  assert.deepEqual(native.h66.status().obligations, {});
  r.engine.dispatchPending = Promise.resolve();
  await assert.rejects(r.engine.setH66Setting({ register: '0203', value: 21 }), /current heating operation/);
  r.engine.dispatchPending = null;
});

test('ending a price-control pause preserves permanent native edits made during it', async t => {
  const r = setup(t, { automationEnabled: false }), native = r.native();
  r.engine.setTemporary({ pauseUntil: new Date(r.engine.clock() + 15 * 60_000).toISOString() }); await r.settle();
  await r.engine.setH66Setting({ register: '0212', value: 46 });
  assert.equal(native.values['0212'], 46);
  assert.equal(native.h66.status().pauseId, null);
  r.advance(15 * 60_000);
  for (const [register, value] of Object.entries(native.values)) native.receive(register, value);
  r.engine.tick(); await r.settle();
  assert.equal(r.engine.status().override, null);
  assert.equal(native.values['0212'], 46);
  assert.deepEqual(native.h66.status().obligations, {});
});

test('a restarted interrupted live cycle is incomplete while relay restoration remains durable',async t=>{
  const r=setup(t);r.plan();r.engine.tick();await r.settle();assert.ok(r.engine.cycles.active());
  clearTimeout(r.engine.executor.timer);
  const restarted=new Engine({store:r.store,config:{...r.config,settings:validateSettings()},clock:()=>r.now,commandTransport:r.transport});
  t.after(()=>{clearTimeout(restarted.executor.timer);restarted.executor.closed=true;});
  assert.equal(restarted.cycles.active(),null);assert.equal(restarted.applied.at,null);
  assert.equal(r.store.cycles({input:'mqtt'})[0].status,'incomplete');
  restarted.tick();await restarted.dispatchPending;
  assert.deepEqual(r.commands.at(-1),['normal']);assert.equal(restarted.executor.status().legacyOutstanding,false);
});

test('history baseline arriving after startup is adopted without replacing live temperature records',async t=>{
  const r=setup(t,{automationEnabled: false});r.engine.tick();const cursor=r.engine.checkpoint.cursor;
  const history=restoreAdaptiveCheckpoint(null);history.algorithmVersion=LEARNING_ALGORITHM;history.baselineC=21.4;history.comfortReference=currentComfortReference(21.4,r.now);
  r.store.setState('adaptive:history',history);r.engine.tick();
  assert.equal(r.engine.checkpoint.baselineC,21.4);assert.equal(r.engine.checkpoint.cursor,cursor);
  assert.equal(r.store.learningJournal({input:'mqtt'}).at(-1).kind,'context');
  assert.deepEqual(replayLearningJournal(r.store,'mqtt',null,{rebuild:true}),r.engine.checkpoint);
});

test('corrupt checkpoint replays persisted samples and corrupt background JSON cannot break live status',async t=>{
  const r=setup(t,{automationEnabled: false});
  for(let i=0;i<3;i++)appendLearningRecord(r.store,'mqtt','sample',{timestamp:r.now-(3-i)*900000,indoorC:21.2,outdoorC:10,phase:'normal',regime:'occupied',quality:[]});
  r.store.db.prepare('INSERT INTO state(key,value,updated_at) VALUES(?,?,?)').run('adaptive:mqtt','{broken',0);
  r.store.db.prepare('INSERT INTO state(key,value,updated_at) VALUES(?,?,?)').run('adaptive:history','{broken',0);
  assert.doesNotThrow(()=>r.engine.tick());assert.equal(r.engine.checkpoint.samples.length,4);
  assert.ok(r.store.events().some(e=>e.type==='checkpoint-rebuild'));
  const valid=r.engine.checkpoint;r.engine.checkpoint=null;r.store.setState('adaptive:mqtt',{version:1,samples:[],model:{version:4},health:{}});
  assert.doesNotThrow(()=>r.engine.tick());assert.ok(r.engine.checkpoint.model.parameters.lossPerHour>0);
  assert.equal(r.engine.checkpoint.cursor,valid.cursor);
});

test('manual ROOM change preserves the aggregate reference and learned physics while invalidating action evidence',async t=>{
  const r=setup(t,{automationEnabled: false});const native=r.native();r.engine.tick();
  const history=restoreAdaptiveCheckpoint(null);history.algorithmVersion=LEARNING_ALGORITHM;
  history.baselineC=21.4;history.comfortReference=currentComfortReference(21.4,r.now);
  r.store.setState('adaptive:history',history);r.engine.tick();
  const reference=structuredClone(r.engine.checkpoint.comfortReference), parameters=structuredClone(r.engine.checkpoint.model.parameters);
  r.advance(60_000);native.receive('0203',18);r.engine.tick();
  assert.equal(r.engine.checkpoint.baselineC,21.4);assert.deepEqual(r.engine.checkpoint.comfortReference,reference);
  assert.deepEqual(r.engine.checkpoint.model.parameters,parameters);
  assert.deepEqual(r.engine.checkpoint.model.equipmentResponse,{ phases: {}, validation: null });assert.equal(r.engine.checkpoint.model.forecastValidation,null);
  r.engine.tick();assert.equal(r.engine.checkpoint.baselineC,21.4);
  assert.equal(r.store.learningJournal({input:'mqtt'}).at(-1).kind,'context');
  assert.deepEqual(replayLearningJournal(r.store,'mqtt',null,{rebuild:true}),r.engine.checkpoint);
});

test('near-third H66 output maps to nominal stages and other percentages stay explicitly proportional',()=>{
  assert.deepEqual([0,33,67,100].map(p=>auxiliaryPowerFromOutput(p).kw),[0,3,6,9]);
  assert.deepEqual(auxiliaryPowerFromOutput(50),{kw:4.5,stage:null,basis:'proportional-output-estimate'});
});

test('admin scenario consent uses effective limits for exactly the reviewed cycle and keeps learning exposure context', async t => {
  const r = setup(t), plan = r.plan();
  const explorer = r.engine.heatingExplorer;
  explorer.capture({ now: r.now, settings: r.engine.settings, config: r.engine.control,
    checkpoint: r.engine.checkpoint, observations: {}, equipment: {} }, { phase: 'normal', reasons: [], plan: null });
  r.engine.pendingPlan = null;
  explorer.worker = { async run() { return { version: 1, executablePlan: plan }; }, async close() {} };
  const view = await explorer.view();
  const comparison = await explorer.simulate({ snapshotId: view.snapshotId, limits: { maxReductionHours: 8, maxRiseC: 1.75 } });
  assert.equal(comparison.application.allowed, true, comparison.application.reason);
  const consent = explorer.apply({ previewId: comparison.previewId });
  const settings = structuredClone(r.engine.settings), config = structuredClone(r.engine.control);
  const status = r.engine.tick(); await r.settle();
  assert.equal(status.decision.phase, 'reduction');
  const cycle = r.engine.cycles.active();
  assert.equal(cycle.plan.userTrial.id, consent.activeTrial.id);
  assert.equal(cycle.plan.maxRiseC, 1.75); assert.equal(cycle.modelConfig.maxReductionHours, 8);
  assert.equal(explorer.input.currentSettings.comfort.maxRiseC, 1.75);
  assert.equal(explorer.publicTrial().status, 'running');
  assert.equal(r.engine.status().heatingScenario.status, 'running');
  assert.deepEqual(r.engine.settings, settings); assert.deepEqual(r.engine.control, config);
  const journal = r.store.learningJournal({ input: 'mqtt' });
  assert.ok(journal.every(row => row.kind !== 'episode'), 'no completed training outcome is fabricated at approval or command time');
  explorer.cancel({});
  const recovery = r.engine.tick(); await r.settle();
  assert.equal(recovery.decision.phase, 'recovery');
  assert.equal(explorer.publicTrial().status, 'cancelled');
  assert.equal(r.engine.status().heatingScenario.status, 'cancelled');
  assert.equal(r.engine.cycles.active().plan.userTrial.id, consent.activeTrial.id, 'cancel preserves actual exposure provenance');
  assert.equal(r.engine.pendingPlan, null);
  assert.equal(explorer.input.currentPlan.schedule.reductionEnd, r.now);
  assert.equal(explorer.input.currentDecision.phase, 'recovery');
  assert.equal(explorer.input.currentSettings.comfort.maxRiseC, r.engine.settings.comfort.maxRiseC);
  assert.equal(explorer.input.currentConfig.maxReductionHours, r.engine.control.maxReductionHours);
});

test('an approved scenario cannot bypass current response evidence', async t => {
  const r = setup(t), plan = r.plan();
  const explorer = r.engine.heatingExplorer;
  explorer.capture({ now: r.now, settings: r.engine.settings, config: r.engine.control,
    checkpoint: r.engine.checkpoint, observations: {}, equipment: {} }, { phase: 'normal', reasons: [], plan: null });
  r.engine.pendingPlan = null;
  explorer.worker = { async run() { return { version: 1, executablePlan: plan }; }, async close() {} };
  const view = await explorer.view(), comparison = await explorer.simulate({ snapshotId: view.snapshotId, limits: { maxReductionHours: 8 } });
  explorer.apply({ previewId: comparison.previewId });
  // Evidence changes after approval but before the next ordinary control tick.
  r.engine.checkpoint.model.equipmentResponse = null;
  const decision = r.engine.tick(); await r.settle();
  assert.notEqual(decision.decision.phase, 'reduction');
  assert.equal(explorer.publicTrial().status, 'rejected');
  assert.equal(r.engine.cycles.active(), null);
  assert.equal(r.commands.some(commands => commands.includes('reduction')), false);
});

test('one-cycle preferred limits cannot suppress the absolute two-degree occupied comfort guard', async t => {
  const r = setup(t), plan = r.plan(), explorer = r.engine.heatingExplorer;
  explorer.capture({ now: r.now, settings: r.engine.settings, config: r.engine.control,
    checkpoint: r.engine.checkpoint, observations: {}, equipment: {} }, { phase: 'normal', reasons: [], plan: null });
  r.engine.pendingPlan = null;
  explorer.worker = { async run() { return { version: 1, executablePlan: plan }; }, async close() {} };
  const view = await explorer.view(), comparison = await explorer.simulate({ snapshotId: view.snapshotId,
    limits: { maxReductionHours: 8, maxDropC: 2 } });
  explorer.apply({ previewId: comparison.previewId });
  r.ingest('indoor_temperature', 19);
  const status = r.engine.tick(); await r.settle();
  assert.equal(status.decision.phase, 'normal');
  assert.ok(status.decision.reasons.includes('hard-comfort-limit'));
  assert.equal(explorer.publicTrial().status, 'rejected');
  assert.equal(r.commands.some(commands => commands.includes('reduction')), false);
});

test('a copied pending scenario plan cannot act as its own approval', async t => {
  const r = setup(t), plan = r.plan();
  plan.userTrial = { id: 'orphan-scenario', limits: { maxReductionHours: 8 } };
  const status = r.engine.tick(); await r.settle();
  assert.equal(status.decision.plan?.userTrial, undefined);
  assert.equal(r.engine.pendingPlan?.userTrial, undefined);
  assert.equal(r.engine.cycles.active()?.plan.userTrial, undefined,
    'ordinary automation may choose its own admissible plan, but never inherit orphan scenario consent');
});
