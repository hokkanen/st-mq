import { appendLearningRecord, currentComfortReference } from './helpers/home-learning-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { replayLearningJournal, LEARNING_ALGORITHM } from '../src/app/committed-learning.js';
import { Engine } from '../src/app/engine.js';
import { validateSettings, CONTROL_DEFAULTS } from '../src/app/config.js';
import { initialAdaptiveModel, restoreAdaptiveCheckpoint } from '../src/control/adaptive-learning.js';
import { chooseCycle, evaluateCycle } from '../src/control/planner.js';
import { createH66Controller } from '../src/control/h66.js';
import { createH66Decoder, auxiliaryPowerFromOutput } from '../src/domain/telemetry.js';

const HOUR = 3_600_000;

test('native forecast slopes do not extrapolate a preheat target step or controller polling interval', async t => {
  const r = setup(t, { automationEnabled: false }); r.native();
  const native = (integral, target, supply) => {
    for (const [signal, value] of [['heating_integral', integral], ['heating_setpoint', target],
      ['supply_temperature', supply], ['compressor_active', 0], ['dhw_routing', 0]]) r.ingest(signal, value);
  };
  native(90, 30, 28); r.engine.tick(); await r.settle();
  r.advance(13_000);
  // The fixture supplies a confirmed applied phase; only the real Engine's
  // forecast assembly is under test, without changing comfort or model limits.
  r.engine.applied = { ...r.engine.applied, phase: 'preheat', roomBoostC: 3, at: r.now };
  native(0, 39, 28); r.engine.tick(); await r.settle();
  let equipment = r.engine.heatingExplorer.input.equipment;
  assert.equal(equipment.integral, 0);
  assert.equal(equipment.supplyShortfallC, 11, 'The current native point remains available');
  assert.equal(equipment.integralTrendPerHour ?? null, null);
  assert.equal(equipment.supplyShortfallTrendPerHour ?? null, null, 'The commanded step is not continuing water cooling');

  r.advance(60_000); native(-10, 39, 27); r.engine.tick(); await r.settle();
  r.advance(1000); r.engine.tick(); await r.settle();
  r.advance(1000); native(-20, 39, 26); r.engine.tick(); await r.settle();
  equipment = r.engine.heatingExplorer.input.equipment;
  assert.equal(equipment.integralTrendPerHour, -18_000, 'Use the two-second native report separation');
  assert.equal(equipment.supplyShortfallTrendPerHour, 1800, 'An extra controller tick cannot halve the native time span');
  r.advance(100); r.engine.tick(); await r.settle();
  equipment = r.engine.heatingExplorer.input.equipment;
  assert.equal(equipment.integralTrendPerHour, -18_000, 'A later poll of the same dated reports retains their slope');
  assert.equal(equipment.supplyShortfallTrendPerHour, 1800);
});

test('a completed live receipt publishes the bounded cycle summary instead of working learning inputs', async t => {
  const r = setup(t, { delayed: true }); r.plan();
  r.engine.tick();
  assert.equal(r.engine.status().learning.episode, null, 'an unconfirmed command creates no episode');
  await new Promise(resolve => setImmediate(resolve));
  r.acknowledge(); await r.settle();
  const cycle = r.engine.cycles.active();
  assert(cycle, 'the confirmed reduction starts a real tracked cycle');
  const check = () => {
    const episode = r.engine.status().learning.episode, current = r.engine.cycles.active();
    assert.equal(episode.id, cycle.id);
    assert.equal(episode.status, current.status);
    assert.deepEqual(episode.actual, current.actual);
    assert.equal(episode.referenceLabel, current.plan.referenceLabel);
    for (const key of ['plan', 'modelConfig', 'observations', 'lastSample', 'observerState', 'originalPrediction'])
      assert.equal(Object.hasOwn(episode, key), false, `${key} stays in the retained learning state`);
    assert(JSON.stringify(episode).length < 2048, 'status polling stays bounded after command completion');
  };
  check();
  r.transport.publish = async batch => {
    r.commands.push([...batch]); return { status: 'mqtt', sent: true, actual: null };
  };
  r.advance(60_000); r.engine.tick(); await r.settle();
  check();
  assert(r.engine.cycles.active().observationCount > 0, 'working evidence remains retained');
});

test('a live trial continues after exposure grows beyond its initial estimate and stops at the actual budget cap', async t => {
  const r = setup(t), native = r.native(), plan = r.plan();
  native.receive('2201', 2);
  Object.assign(r.engine.control, { learningTrials: true, maxTrialCostCents: 150 });
  plan.equipment = { externalChangeRevision: native.h66.status().externalChangeRevision };
  plan.schedule.reductionEnd = r.now + 2 * HOUR;
  for (const [signal, value] of Object.entries({ compressor_active: 1, dhw_routing: 0,
    auxiliary_output: 0, supply_temperature: 30, heating_setpoint: 30, brine_in_temperature: 0 })) r.ingest(signal, value);
  const initialMarket = r.store.getState('provider:market');
  initialMarket.intervals.forEach(row => { row.spotCtPerKwh = 5; });
  r.store.setState('provider:market', initialMarket);
  plan.trial = true;
  r.engine.tick(); await r.settle();
  const original = r.engine.cycles.active();
  assert.equal(original?.plan.trial, true, JSON.stringify(r.engine.status().decision.reasons));
  const originalPlan = structuredClone(original.plan);
  r.advance(60_000);
  r.ingest('indoor_temperature', 21.19);
  const market = r.store.getState('provider:market');
  market.intervals.forEach((row, i) => { if (i > 0) row.spotCtPerKwh = 10; });
  r.store.setState('provider:market', market);
  r.engine.tick(); await r.settle();
  const continued = r.engine.cycles.active();
  assert.equal(r.engine.status().decision.phase, 'reduction', JSON.stringify(continued?.adjustments));
  assert.equal(continued.id, original.id);
  assert.ok(continued.trialBudget.reservedCents > originalPlan.trialAllowanceCents,
    JSON.stringify({ original: originalPlan.trialAllowanceCents, current: continued.trialBudget }));
  assert.ok(continued.trialBudget.reservedCents < 150);
  assert.deepEqual(continued.plan, originalPlan);
  // High prices alone do not imply that this complete-cycle cost difference
  // exceeds the cap: the observed and Normal prefixes retain different heat.
  const adverseMarket = r.store.getState('provider:market');
  adverseMarket.intervals.forEach((row,i) => { if (i > 0) row.spotCtPerKwh = 5000; });
  r.store.setState('provider:market',adverseMarket);
  r.advance(60_000); r.engine.tick(); await r.settle();
  const funded = r.engine.cycles.active();
  assert.equal(r.engine.status().decision.phase, 'reduction');
  assert(funded.trialBudget.reservedCents > continued.trialBudget.reservedCents);
  assert(funded.trialBudget.reservedCents < 150);
  // With the same recorded prefix, make the actual computed exposure exceed
  // its authorized cap; the real reservation still owns admission and refusal.
  let attemptedExposure;
  const reserve = r.engine.cycles.reserveTrialExposure.bind(r.engine.cycles);
  r.engine.cycles.reserveTrialExposure = value => { attemptedExposure = value; return reserve(value); };
  adverseMarket.intervals.forEach((row,i) => { if (i > 0) row.spotCtPerKwh = 50000; });
  r.store.setState('provider:market',adverseMarket);
  r.engine.tick(); await r.settle();
  assert(attemptedExposure > 150);
  assert.equal(r.engine.status().decision.phase, 'recovery');
  assert.equal(r.engine.cycles.active().adjustments.at(-1).reason, 'trial-exposure-now-exceeds-allowance');
  assert.equal(r.engine.cycles.active().trialBudget.reservedCents, funded.trialBudget.reservedCents);
  assert.equal(r.engine.cycles.active().observationCount, funded.observationCount, 'A forecast change creates no recorded interval');
});

test('a confirmed preheat trial survives its native target step and still ends at a real comfort limit', async t => {
  const r = setup(t), native = r.native({ tariffFeedback: () => ({
    mode: 'normal', verified: true, stale: false, identity: 'c'.repeat(64) }) }), plan = r.plan();
  Object.assign(r.engine.control, { learningTrials: true, maxTrialCostCents: 150, preheatRoomBoostC: 1 });
  Object.assign(plan.schedule, { preheatEnd: r.now + HOUR / 4, reductionStart: r.now + HOUR / 4,
    reductionEnd: r.now + 2 * HOUR, roomBoostC: 1, roomSettingC: 20, treatmentKey: 'room-boost-v1' });
  plan.trial = true;
  plan.equipment = { externalChangeRevision: native.h66.status().externalChangeRevision };
  const observe = (integral, target) => {
    for (const [signal, value] of Object.entries({ compressor_active: 1, dhw_routing: 0,
      auxiliary_output: 0, supply_temperature: 30, heating_setpoint: target,
      heating_integral: integral, brine_in_temperature: 0 })) r.ingest(signal, value);
  };
  r.advance(1); native.receive('0203', 19);
  const market = r.store.getState('provider:market');
  // Cover the delayed preheat peak and enough Normal demand for a useful
  // trial; the ordinary six-hour delivery fixture intentionally lacks both.
  market.intervals = Array.from({ length: 96 }, (_, i) => ({ ...market.intervals[0],
    start: r.now + i * HOUR / 4, end: r.now + (i + 1) * HOUR / 4, spotCtPerKwh: 5 }));
  r.store.setState('provider:market', market);
  const weather = r.store.getState('provider:weather');
  weather.forecast[0].end = r.now + 24 * HOUR; r.store.setState('provider:weather', weather);
  plan.intervals = market.intervals.map(row => ({ start: row.start, end: row.end, price: 5, outdoorC: 10, solarRadiationWm2: 0 }));
  observe(-200, 30); r.engine.tick(); await r.settle();
  const cycle = r.engine.cycles.active();
  assert.ok(cycle, JSON.stringify({ decision: r.engine.status().decision.reasons,
    events: r.store.events().filter(row => ['scheduled-cycle-rejected', 'control-execution-failed'].includes(row.type)).map(row => row.payload) }));
  assert.equal(r.engine.applied.phase, 'preheat');
  assert.equal(native.values['0203'], 20, 'The real H66 fixture confirms the requested ROOM increase');
  const original = structuredClone(cycle.plan);
  r.advance(117); observe(0, 33); r.engine.tick(); await r.settle();
  assert.equal(r.engine.status().decision.phase, 'preheat', JSON.stringify(r.engine.cycles.active()?.adjustments));
  assert.equal(r.engine.cycles.active().id, cycle.id);
  assert.equal(r.engine.cycles.active().adjustments?.length ?? 0, 0);
  assert.deepEqual(r.engine.cycles.active().plan, original, 'The recorded original forecast remains immutable');
  r.advance(1000); r.ingest('indoor_temperature', 24); r.engine.tick(); await r.settle();
  assert.equal(r.engine.status().decision.phase, 'recovery');
  assert.equal(r.engine.cycles.active().adjustments.at(-1).reason, 'indoor-comfort-limit');
  assert.equal(native.values['0203'], 19, 'A real comfort limit still restores normal ROOM');
});

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
  t.after(async()=>{ clearTimeout(engine.executor.timer); engine.executor.closed=true; await engine.h66?.close(); await engine.closeFireplace(); if(!store.closed) store.close(); });
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
      model.forecastValidation = { accepted: true, episodes: 3, maxReductionHours: .5, records: Array.from({length:3},(_,i)=>({id:`synthetic-advance-${i}`, treatmentKey:'reduction-only-v1', roomBoostC:0, preheatHours:0, reductionHours:.5, temperatureMaeC:.2, minimumTemperatureErrorC:.3, energyRelativeError:.2, costRelativeError:.1})) };
      engine.checkpoint=restoreAdaptiveCheckpoint(null);engine.checkpoint.model=model;
      appendLearningRecord(store,'mqtt','context',{timestamp:now},{config:config.control,seed:engine.checkpoint});
      const args={intervals,model,initialState:{indoorC:21.2,reserveC:21.2},targetC:21,config:CONTROL_DEFAULTS};
      engine.pendingPlan={schedule,model,initialState:args.initialState,targetC:21,intervals,reference:null,referenceLabel:'continuous normal operation',
        prediction:evaluateCycle({...args,schedule}),referencePrediction:evaluateCycle(args),trial:false}; return engine.pendingPlan; },
    native({ tariffFeedback } = {}){const values={'0203':19,'0212':47,'0208':62,'2201':1},decoder=createH66Decoder({deviceId:'synthetic'});
      const receive=(index,value)=>{values[index]=value;const decoded=decoder.decode({topic:`synthetic/HP/${index}`,payload:String(value),receivedAt:now});
        h66.ingest(decoded);engine.ingest({source:'husdata-h66',device:'synthetic',signal:decoded.signal,value:decoded.value,unit:decoded.unit,sourceTime:now,receivedAt:now,quality:decoded.issues,raw:{usableForControl:decoded.usableForControl,verified:true}});};
      const h66=createH66Controller({deviceId:'synthetic',store,clock:()=>now,tariffFeedback,
        requestSnapshot: () => { if (tariffFeedback) queueMicrotask(() => receive('0203', values['0203'])); },
        config:{writeEnabled:true,readbackTimeoutMs:30,...(tariffFeedback ? { preheatPreparationMs: 300 } : {})},
        publish:async(topic,payload,options)=>{options.beforePublish(); options.onFirstWrite?.();queueMicrotask(()=>receive(topic.split('/').at(-1),Number(payload)));}});
      h66.setConnected(true);for(const[index,value]of Object.entries(values))receive(index,value);engine.setH66(h66);
      return {values,receive,h66}; }
  };
}

test('controller execution errors retain safe dispatch codes without exposing raw error messages', async t => {
  for (const code of ['MQTT_STORAGE_FAILED', 'MQTT_STORAGE_PENDING', 'unrecognized-private-code']) {
    const r = setup(t); r.plan();
    r.transport.publish = async () => { throw Object.assign(new Error('private synthetic transport details'), { code }); };
    r.engine.tick(); await r.settle();
    const event = r.store.events().find(row => row.type === 'control-execution-failed');
    assert.ok(event);
    assert.equal(event.payload.code, code.startsWith('MQTT_') ? code : undefined);
    assert.equal(JSON.stringify(event).includes('private'), false);
    if (code.startsWith('MQTT_')) {
      assert.match(event.payload.reason, /not sent/);
      assert.equal(r.engine.status().execution.code, code);
    }
  }
});

test('controller waits for an executor-owned restoration without cancelling the active cycle', async t => {
  const r = setup(t); r.plan(); r.engine.tick(); await r.settle();
  const cycleId = r.engine.cycles.active().id;
  const publish = r.transport.publish;
  let acknowledgeRestoration;
  r.transport.publish = commands => {
    r.commands.push([...commands]);
    return new Promise(resolve => { acknowledgeRestoration = () => resolve({ status: 'mqtt', sent: true, actual: null }); });
  };
  const restoring = r.engine.executor.restore({ now: r.now, reason: 'expiry' });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(r.engine.executor.status().busy, true);
    assert.equal(r.engine.dispatchPending, null, 'The executor expiry lane is independent of controller dispatch');
    assert.deepEqual(r.commands, [['reduction'], ['normal']]);
    r.advance(1000);
    await r.store.runWrite(() => r.engine.tick()); await r.settle();
    assert.equal(r.engine.status().execution.status, 'pending');
    assert.equal(r.engine.cycles.active()?.id, cycleId);
    assert.equal(r.store.events().some(row => row.type === 'control-execution-failed'), false);
    assert.deepEqual(r.commands, [['reduction'], ['normal']], 'No duplicate or competing command is dispatched');
  } finally {
    r.transport.publish = publish;
    acknowledgeRestoration?.(); await restoring;
  }
  // A later tick must evaluate the current owner choice, rather than replaying
  // the reduction that could not enter the executor while restoration ran.
  r.engine.setTemporary({ pauseUntil: new Date(r.now + 15 * 60_000).toISOString() });
  await r.settle();
  r.engine.tick(); await r.settle();
  assert.equal(r.engine.status().decision.phase, 'normal');
  assert.equal(r.engine.executor.status().legacyOutstanding, false);
  assert.equal(r.commands.filter(commands => commands.includes('reduction')).length, 1);
});

test('a background heating search is adopted only by a later current controller update', async t => {
  const r = setup(t), plan = r.plan();
  r.engine.pendingPlan = null;
  let finishSearch;
  r.engine.heatingPlanning.service = {
    request: () => new Promise(resolve => { finishSearch = resolve; }),
    async close() {},
  };
  const initial = r.engine.tick();
  assert.equal(initial.decision.phase, 'normal');
  assert.ok(initial.decision.reasons.includes('heating-planning-in-progress'));
  await r.settle();
  const before = r.commands.length;
  finishSearch({ action: 'reduction', phase: 'reduction', reasons: ['synthetic-background-search'], plan });
  await r.engine.heatingPlanning.pending.promise;
  assert.equal(r.commands.length, before, 'Worker completion has no command authority');
  assert.equal(r.engine.cycles.active(), null);
  const adopted = r.engine.tick();
  assert.equal(adopted.decision.phase, 'reduction');
  await r.settle();
  assert.equal(r.engine.cycles.active().plan.initialState.indoorC, 21.2);
});

test('the controller refreshes a future automatic schedule without dropping it while search runs', async t => {
  const r = setup(t), plan = r.plan();
  // Isolate pending-plan lifecycle from this fixture's unobserved pump costs.
  r.engine.control.minimumHomeBenefitCents = -1000;
  for (const key of ['preheatStart','preheatEnd','reductionStart','reductionEnd']) plan.schedule[key] += HOUR;
  const market = r.store.getState('provider:market');
  market.intervals.forEach((row, i) => { row.spotCtPerKwh = i >= 4 && i < 8 ? 2000 : 1; });
  r.store.setState('provider:market', market);
  const requests = [];
  r.engine.heatingPlanning.service = {
    request: input => new Promise(resolve => requests.push({ input, resolve })), async close() {},
  };
  r.engine.tick(); await r.settle();
  assert.equal(requests.length, 1);
  assert.ok(requests[0].input.incumbentPlan, JSON.stringify(r.store.events().filter(row => row.type === 'scheduled-cycle-rejected')));
  assert.deepEqual(requests[0].input.incumbentPlan.schedule, plan.schedule);
  assert.deepEqual(r.engine.pendingPlan.schedule, plan.schedule);
  assert.equal(r.engine.status().decision.reasons[0], 'waiting-for-scheduled-cycle');
  assert.equal(r.engine.cycles.active(), null);
  requests[0].resolve(chooseCycle(requests[0].input));
  await r.engine.heatingPlanning.pending.promise;
  r.engine.tick(); await r.settle();
  assert.ok(r.engine.pendingPlan);
  r.advance(14 * 60_000); r.engine.tick(); await r.settle();
  assert.equal(requests.length, 1);
  r.advance(60_000); r.engine.tick(); await r.settle();
  assert.equal(requests.length, 2);
  assert.ok(r.engine.pendingPlan, 'The pending plan is retained during the next refresh');
});

test('periodic optimization preserves the exact future manually approved schedule', async t => {
  const r = setup(t), plan = r.plan(), explorer = r.engine.heatingExplorer;
  for (const key of ['preheatStart','preheatEnd','reductionStart','reductionEnd']) plan.schedule[key] += HOUR;
  explorer.capture({ now:r.now,settings:r.engine.settings,config:r.engine.control,
    checkpoint:r.engine.checkpoint,observations:{},equipment:{} }, { phase:'normal',reasons:[],plan:null });
  r.engine.pendingPlan = null;
  explorer.worker = { async run() { return {version:1,executablePlan:plan}; }, async close() {} };
  const view = await explorer.view(), preview = await explorer.simulate({snapshotId:view.snapshotId,
    limits:{maxReductionHours:8,minimumHomeBenefitCents:-1000}});
  assert.equal(preview.application.allowed, true);
  explorer.apply({previewId:preview.previewId});
  let searches = 0;
  r.engine.heatingPlanning.service = { async request() { searches++; return null; }, async close() {} };
  r.engine.tick(); await r.settle();
  const reviewed = structuredClone(r.engine.pendingPlan.schedule);
  r.advance(15 * 60_000); r.engine.tick(); await r.settle();
  assert.equal(searches, 0);
  assert.deepEqual(r.engine.pendingPlan.schedule, reviewed);
  assert.equal(r.engine.pendingPlan.userTrial.id, explorer.publicTrial().id);
});

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

test('an approved scenario uses the initial response when learned response is unavailable', async t => {
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
  assert.equal(decision.decision.phase, 'reduction');
  assert.ok(r.engine.cycles.active());
  assert.equal(r.engine.checkpoint.model.equipmentResponse, null, 'Approval creates no response validation');
  assert.equal(r.commands.some(commands => commands.includes('reduction')), true);
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

test('a reviewed cycle runs while Home is paused and disabled, then cancellation restores without changing that choice',async t=>{
  const r=setup(t,{automationEnabled:false}),plan=r.plan(),explorer=r.engine.heatingExplorer;
  const saved=structuredClone(r.store.getState('automation:mqtt'));
  explorer.capture({now:r.now,settings:r.engine.settings,config:r.engine.control,
    checkpoint:r.engine.checkpoint,observations:{},equipment:{}},{phase:'normal',reasons:['heating-paused'],plan:null},'heating-paused');
  r.engine.pendingPlan=null;
  explorer.worker={async run(){return {version:1,executablePlan:plan};},async close(){}};
  const view=await explorer.view(),preview=await explorer.simulate({snapshotId:view.snapshotId,
    limits:{maxReductionHours:8,minimumHomeBenefitCents:-1000}});
  assert.equal(preview.application.allowed,true);explorer.apply({previewId:preview.previewId});
  r.engine.tick();await r.settle();
  assert.equal(r.engine.cycles.active()?.plan.userTrial.id,explorer.publicTrial().id);
  assert.ok(r.commands.some(commands=>commands.includes('reduction')));
  assert.deepEqual(r.store.getState('automation:mqtt'),saved);
  r.advance(60_000);r.engine.tick();await r.settle();
  assert.equal(r.engine.status().decision.phase,'reduction',JSON.stringify(r.engine.status().decision));
  explorer.cancel({});r.engine.tick();await r.settle();
  assert.equal(r.engine.executor.status().legacyOutstanding,false);
  assert.ok(r.commands.some(commands=>commands.includes('normal')));
  assert.deepEqual(r.store.getState('automation:mqtt'),saved);
});

test('changing Automatic to Pause preserves an independently approved running cycle until its cancellation',async t=>{
  const r=setup(t),plan=r.plan(),explorer=r.engine.heatingExplorer;
  explorer.capture({now:r.now,settings:r.engine.settings,config:r.engine.control,
    checkpoint:r.engine.checkpoint,observations:{},equipment:{}},{phase:'normal',reasons:[],plan:null});
  r.engine.pendingPlan=null;
  explorer.worker={async run(){return {version:1,executablePlan:plan};},async close(){}};
  const view=await explorer.view(),preview=await explorer.simulate({snapshotId:view.snapshotId,
    limits:{maxReductionHours:8,minimumHomeBenefitCents:-1000}});
  explorer.apply({previewId:preview.previewId});r.engine.tick();await r.settle();
  const id=r.engine.cycles.active().id;
  await r.engine.setAutomation({feature:'home',enabled:false});await r.settle();
  assert.equal(r.engine.automationStatus().home.enabled,false);
  assert.equal(r.engine.cycles.active()?.id,id);
  assert.equal(explorer.publicTrial().status,'running');
  assert.equal(r.engine.executor.status().phase,'reduction');
  explorer.cancel({});r.engine.tick();await r.settle();
  assert.equal(r.engine.executor.status().legacyOutstanding,false);
  assert.equal(r.engine.automationStatus().home.enabled,false);
});

test('reviewed trial permission stays in plan configuration while the explorer captures the automatic allowance', async t => {
  const r = setup(t), explorer = r.engine.heatingExplorer;
  r.engine.control.trialBudgetCentsPerDay = 0;
  r.engine.cycles.config.trialBudgetCentsPerDay = 0;
  const plan = r.plan();
  assert.equal(r.engine.control.learningTrials, false);
  explorer.capture({ now: r.now, settings: r.engine.settings, config: r.engine.control,
    checkpoint: r.engine.checkpoint, observations: {}, equipment: {}, trialBudgetRemainingCents: 0 },
  { phase: 'normal', reasons: [], plan: null });
  r.engine.pendingPlan = null;
  explorer.worker = { async run(_input, overrides) { return { version: 1,
    executablePlan: { ...structuredClone(plan), config: { ...plan.config,
      maxTrialCostCents: overrides.maxTrialCostCents ?? r.engine.control.maxTrialCostCents } } }; }, async close() {} };
  const view = await explorer.view(), preview = await explorer.simulate({ snapshotId: view.snapshotId,
    limits: { learningTrials: true, maxTrialCostCents: 151, maxReductionHours: 8, minimumHomeBenefitCents: -1000 } });
  explorer.apply({ previewId: preview.previewId });
  assert(!Object.hasOwn(explorer.trial().limits, 'learningTrials'));
  assert.equal(explorer.trial().plan.config.learningTrials, true);
  r.engine.tick(); await r.settle();
  assert.equal(explorer.input.config.learningTrials, false, 'The automatic baseline retains saved permission');
  assert.equal(explorer.input.currentConfig.learningTrials, true, 'The reviewed cycle uses its bound permission');
  assert.equal(explorer.input.currentConfig.maxTrialCostCents, 151);
  assert.equal(explorer.input.trialBudgetRemainingCents, 0, 'A manual allowance cannot become the automatic baseline');
  assert.equal(r.engine.control.learningTrials, false);
  explorer.cancel({}); r.engine.tick(); await r.settle();
  assert.equal(explorer.input.currentConfig.learningTrials, false);
  assert.equal(explorer.input.trialBudgetRemainingCents, 0);
});
