import test from 'node:test';
import assert from 'node:assert/strict';
import { economicPlanningState, economicPlanningChange, economicProgressChange, backgroundPlanDeadline } from '../src/charging/replanning.js';
import { chargingPlannerWorkload } from './support/charging-planner-workload.js';
import { fixture } from './helpers/charging-joint-fixture.js';
const state = options => economicPlanningState(options, { session: 'same', authority: true });

test('economic identity ignores idle current, receipt clocks and live voltage behind the published voltage model', () => {
  const options = chargingPlannerWorkload(); options.supply.planningVoltageV = [230,230,230];
  const before = state(options);
  options.now += 60_000;
  for (const charger of options.chargers) {
    charger.values.actualCurrentA.value = .01;
    charger.values.powerKw.value = .007;
    charger.values.voltageV.value += .3;
    charger.values.soc.receivedAt = options.now;
    charger.control.owned = { confirmedAt: options.now };
    charger.control.phase = 'paused';
  }
  assert.equal(economicPlanningChange(before, state(options), options.now), null);
  options.supply.planningVoltageV = [230.9,230.9,230.9];
  assert.equal(economicPlanningChange(before, state(options), options.now), null);
  options.supply.planningVoltageV = [231.1,231.1,231.1];
  assert.equal(economicPlanningChange(before, state(options), options.now), 'soft', 'Small drift accumulates against the accepted model');
});

test('real requests, effective restrictions, published rates and source quality change economic scope', () => {
  for (const change of [
    o => { o.chargers[0].deadlineAt -= 1000; },
    o => { o.chargers[0].values.soc.value += 1; },
    o => { o.chargers[0].values.capacityKwh = {value:74,available:true,assumed:false}; },
    o => { o.chargers[0].values.maximumCurrentA.value = 8; },
    o => { o.chargers[0].values.connected.available = false; },
    o => { o.chargers[0].values.vehicleCurrentA = { value:null, available:false, knownLimitA:5 }; },
    o => { o.chargers[0].request = { pause:true }; },
  ]) {
    const options = chargingPlannerWorkload(), before=state(options); change(options);
    assert.equal(economicPlanningChange(before,state(options),options.now),'hard');
  }
  const options=chargingPlannerWorkload(), before=state(options);
  options.prices[3].priceCtPerKwh += 1;
  assert.equal(economicPlanningChange(before,state(options),options.now),'hard-price');
  options.prices[3].predicted=true;
  const predicted=state(options); options.prices[3].priceCtPerKwh += 1;
  assert.equal(economicPlanningChange(predicted,state(options),options.now),'soft');
});

test('elapsed intervals and refreshed but numerically unchanged household models do not trigger search', () => {
  const options=chargingPlannerWorkload(), before=state(options);
  options.now += 16*60_000;
  options.household=options.household.filter(row=>row.end>options.now).map(row=>({...row,start:Math.max(row.start,options.now),generatedAt:options.now}));
  options.prices=options.prices.filter(row=>row.end>options.now).map(row=>({...row,fetchedAt:options.now}));
  assert.equal(economicPlanningChange(before,state(options),options.now),null);
});

test('soft changes get ten quiet seconds with a fixed sixty second maximum and urgent bypass', () => {
  let result=backgroundPlanDeadline({now:1000,key:'first'});
  assert.equal(result.until,11000);
  result=backgroundPlanDeadline({now:9000,key:'first',pending:result.pending});
  assert.equal(result.until,11000,'Unchanged receipts do not extend settling');
  result=backgroundPlanDeadline({now:10000,key:'second',pending:result.pending});
  assert.equal(result.until,20000);
  for(let now=19000;now<61000;now+=9000)result=backgroundPlanDeadline({now,key:String(now),pending:result.pending});
  assert.equal(result.until,61000);
  assert.equal(backgroundPlanDeadline({now:61000,key:'last',pending:result.pending}).until,null);
  assert.deepEqual(backgroundPlanDeadline({now:61000,key:'last',pending:result.pending,urgent:true}),{pending:null,until:null});
});

test('metered progress matching accepted delivery does not search; a two minute finish deviation is material', () => {
  const previous={at:0,requests:[{id:'charger1',remaining:10}]};
  const plans={charger1:{accounting:[{start:0,end:3_600_000,energyKwh:10}]}};
  assert.equal(economicProgressChange(previous,{requests:[{id:'charger1',remaining:9}]},plans,360_000),false);
  assert.equal(economicProgressChange(previous,{requests:[{id:'charger1',remaining:10}]},plans,360_000),true);
});

async function waiting(t) {
  const f=await fixture(t);
  await f.automatic('charger1',true);await f.automatic('charger2',true);await f.plan();
  await f.connect('charger1');await f.connect('charger2');await f.plan();await f.settle();
  return f;
}

test('idle minute ticks, native receipts and thirty second age create no additional optimizer jobs', async t => {
  const f=await waiting(t), initial=f.runtime.coordination.at;
  const request=f.runtime.plannerService.request.bind(f.runtime.plannerService);let calls=0;
  f.runtime.plannerService.request=options=>{calls++;return request(options);};
  const programs=['charger1','charger2'].map(id=>structuredClone(f.view(id).control.execution));
  for(const delta of [1000,29000,30000,60000]) {
    f.advance(delta);await f.runtime.chargers.charger2.adapter.refresh();await f.runtime.tick();await f.settle();
  }
  assert.equal(calls,0);assert.equal(f.runtime.coordination.at,initial);
  assert.deepEqual(['charger1','charger2'].map(id=>f.view(id).control.execution),programs);
  assert.equal(f.runtime.backgroundPlanDueAt,null,'No periodic economic retry is armed');
});

test('one meaningful household update settles once while unchanged receipts cannot extend the wait',async t=>{
  const f=await waiting(t);const request=f.runtime.plannerService.request.bind(f.runtime.plannerService);let calls=0;
  f.runtime.plannerService.request=options=>{calls++;return request(options);};
  f.runtime.household=f.runtime.household.map(row=>({...row,phaseCurrentA:row.phaseCurrentA.map(n=>n+1)}));
  await f.runtime.updatePlan(f.now,{background:true});
  assert.equal(calls,0);const due=f.runtime.backgroundPlanDueAt;assert.equal(due,f.now+10000);
  f.advance(5000);await f.runtime.updatePlan(f.now,{background:true});assert.equal(f.runtime.backgroundPlanDueAt,due);
  f.advance(5000);await f.runtime.updatePlan(f.now,{background:true});assert.equal(calls,1);
  await f.runtime.updatePlan(f.now,{background:true});assert.equal(calls,1);
});


test('economic snapshots retain independent household values when a provider changes its source object',()=>{
  const input=chargingPlannerWorkload(),before=state(input);
  input.household[0].phaseCurrentA[0]+=1;
  assert.equal(economicPlanningChange(before,state(input),input.now),'soft');
});

test('pending vehicle admission coalesces background work until the original source settles', async t => {
  const f = await waiting(t), runtime = f.runtime;
  let pending = true, searches = 0, writes = 0;
  t.mock.method(runtime, 'vehicleAdmissionBasis', () => pending ? [['tesla', true, false]] : null);
  const request = runtime.plannerService.request.bind(runtime.plannerService), write = runtime.write.bind(runtime);
  t.mock.method(runtime.plannerService, 'request', options => { searches++; return request(options); });
  t.mock.method(runtime, 'write', (...args) => { writes++; return write(...args); });
  const before = runtime.coordination;
  const calls = Array.from({ length: 8 }, () => runtime.updatePlan(f.now, { background: true }));
  await runtime.planningFlight;
  assert.equal(searches, 0);
  assert.equal(writes, 0, 'Waiting for durability creates no extra storage turns');
  assert.equal(runtime.planningWaiters.size, calls.length, 'An unassessed request has not borrowed another publication');
  runtime.vehicleInputSettled();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(searches, 0, 'A remaining packet still holds the assessment');
  pending = false;
  runtime.vehicleInputSettled(); runtime.vehicleInputSettled();
  await Promise.all(calls);
  assert.equal(searches, 0, 'Unchanged committed values retain the accepted program');
  assert.equal(runtime.coordination, before);
  assert.equal(runtime.planningAdmissionDeferred, false);
});

test('a changed published price is assessed once after queued vehicle packets settle', async t => {
  const f = await waiting(t), runtime = f.runtime;
  let pending = true, searches = 0;
  t.mock.method(runtime, 'vehicleAdmissionBasis', () => pending ? [['tesla', true, false]] : null);
  const request = runtime.plannerService.request.bind(runtime.plannerService);
  t.mock.method(runtime.plannerService, 'request', options => { searches++; return request(options); });
  runtime.prices = runtime.prices.map(row => ({ ...row, priceCtPerKwh: row.priceCtPerKwh + 1 }));
  const call = runtime.updatePlan(f.now, { background: true });
  await runtime.planningFlight;
  assert.equal(searches, 0);
  pending = false; runtime.vehicleInputSettled();
  await call;
  assert.equal(searches, 1);
  await runtime.updatePlan(f.now, { background: true });
  assert.equal(searches, 1, 'Settlement does not become a periodic search');
});

test('closing during deferred vehicle admission resolves callers without late work', async t => {
  const f = await waiting(t), runtime = f.runtime;
  t.mock.method(runtime, 'vehicleAdmissionBasis', () => [['tesla', true, false]]);
  const call = runtime.updatePlan(f.now, { background: true });
  await runtime.planningFlight;
  runtime.vehicleInputSettled();
  await runtime.close(); await call;
  assert.equal(runtime.closed, true);
});
