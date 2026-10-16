import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateForecastResource, allocateResourceDirect, planChargers, forecastFixedPlans } from '../src/charging/planner.js';
import { refinePeriods } from '../src/charging/search-refinement.js';
import { chargingPlannerWorkload } from './support/charging-planner-workload.js';
import { minimumCostFlow } from '../src/charging/flow-bound.js';
let seed = 731928;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const now = Date.parse('2026-10-01T00:00:00Z');

test('allocation patterns preserve the scalar allocator across priorities, tiers, scarcity and delivery ceilings', () => {
  for (const priority of ['balanced', 'charger1', 'charger2']) for (let trial = 0; trial < 1800; trial++) {
    const active = ['charger1', 'charger2'].map((id, i) => ({
      charger: { id, requiredGridKwh: 1 + random() * 50, referenceGridKwh: 90,
        capabilities: { externalLoadBalancing: i === 0, currentControl: i === 1 }, values: {} },
      priority, remaining: trial % 9 === i ? 0 : 0.01 + random() * 50,
      requiredCurrentNow: trial % 7 ? Math.floor(random() * 150) : 0,
      targetAt: now + 1000 + random() * 86_400_000,
      allocationHold: trial % 11 ? null : { chargerId: trial % 2 ? 'charger1' : 'charger2', end: now + 10_000 },
      electric: { currentA: 6 + Math.floor(random() * 27) + (trial % 3 ? 0 : random()),
        deliveryCurrentA: trial % 5 ? 16 : 5, voltageV: 220 + random() * 20,
        phases: { count: 3, mask: [1, 1, 1] } },
    }));
    const resource = { phaseHeadroomA: [20, 20, 20], scenarios: Array.from({ length: 4 }, () => ({
      phaseHeadroomA: Array.from({ length: 3 }, () => Math.max(0, trial % 3
        ? random() * 45 : Math.floor(random() * 45) + (trial % 2 ? 1e-8 : -1e-8))), weight: .25,
    })) };
    for (let repeat = 0; repeat < 3; repeat++) {
      assert.deepEqual(allocateForecastResource(active, resource, now),
        allocateResourceDirect(active, resource, now), `${priority}, trial ${trial}, repeat ${repeat}`);
      for (const item of active) {
        item.remaining *= .99;
        if (item.requiredCurrentNow > 40) item.requiredCurrentNow += 100;
      }
    }
  }
});

test('continuous flow reassigns a cheap slot through residual edges, supports negative prices and reports no bound on unfinished work', () => {
  const slots = [
    { capacity: 1, limits: [1, 1], costs: [-5, -5] },
    { capacity: 1, limits: [1, 0], costs: [2, 2] },
  ];
  const actual = minimumCostFlow({ slots, demands: [1, 1] });
  assert.equal(actual.solved, true);
  assert.equal(actual.costCents, -3);
  assert.deepEqual(actual.allocation, [[0, 1], [1, 0]]);
  for (const budget of [{ maxAugmentations: 1 }, { maxRelaxations: 1 }]) {
    const partial = minimumCostFlow({ slots, demands: [1, 1], ...budget });
    assert.equal(partial.solved, false); assert.equal(partial.reason, 'budget'); assert.equal(partial.costCents, null);
  }
  const impossible = minimumCostFlow({ slots, demands: [1, 2] });
  assert.equal(impossible.solved, false); assert.equal(impossible.reason, 'infeasible'); assert.equal(impossible.costCents, null);
});

test('continuous flow agrees with independently enumerated integral assignments on tiny networks', () => {
  for (let trial = 0; trial < 100; trial++) {
    const slots = Array.from({ length: 4 }, () => ({ capacity: 1,
      limits: [Number(random() > .2), Number(random() > .2)], costs: [Math.floor(random() * 21) - 10, Math.floor(random() * 21) - 10] }));
    let expected = Infinity;
    for (let choices = 0; choices < 81; choices++) {
      let digits = choices, a = 0, b = 0, cost = 0, valid = true;
      slots.forEach(row => {
        const j = digits % 3 - 1; digits = Math.floor(digits / 3);
        if (j >= 0) { if (!row.limits[j]) valid = false; j === 0 ? a++ : b++; cost += row.costs[j]; }
      });
      if (valid && a === 1 && b === 2) expected = Math.min(expected, cost);
    }
    const actual = minimumCostFlow({ slots, demands: [1, 2] });
    assert.equal(actual.solved, Number.isFinite(expected));
    assert.equal(actual.costCents, Number.isFinite(expected) ? expected : null);
  }
});



test('retained allocations cannot be poisoned by an earlier full planner result',()=>{
  for(const priority of ['balanced','charger1','charger2']) {
    const input=chargingPlannerWorkload({priority}),original=structuredClone(input);
    const expected=planChargers(input),returned=planChargers(input);
    returned.allocations[0].phaseCurrentA[0]=123456;
    returned.plans.charger1.periods[0].startAt=-1;
    assert.deepEqual(planChargers(input),expected);
    assert.deepEqual(input,original,'Calculation ownership does not mutate the submitted request');
  }
});

test('bounded refinement scores a feasible seed before local moves and returns only simulated improvement',()=>{
  const input=chargingPlannerWorkload();input.chargers=[input.chargers[0]];
  input.chargers[0].requiredGridKwh=4.14;input.chargers[0].deadlineAt=input.now+3*3600_000;
  input.prices=[20,10,1].map((priceCtPerKwh,i)=>({start:input.now+i*3600_000,end:input.now+(i+1)*3600_000,priceCtPerKwh}));
  input.household=[];
  const model={now:input.now,jobs:[{charger:input.chargers[0]}]};
  const periods={charger1:[{startAt:input.now,endAt:null}]},seed={charger1:[{startAt:input.now+2*3600_000,endAt:null}]};
  const simulate=({periods})=>{
    const result=forecastFixedPlans({...input,periodsByCharger:periods});
    return {feasible:result.feasible,costCents:result.plans.charger1.costCents,uncertaintyPremiumCents:0};
  };
  const options={model,periods,simulate,compare:(a,b)=>a.costCents-b.costCents,extraSeeds:[seed]};
  const one=refinePeriods({...options,maxEvaluations:1});assert.equal(one.evaluations,1);assert.equal(one.improvementCents,0);
  const two=refinePeriods({...options,maxEvaluations:2});assert.equal(two.evaluations,2);assert.ok(two.improvementCents>1);
  assert.deepEqual(two.periods,seed);assert.equal(two.result.feasible,true);
  const replay=forecastFixedPlans({...input,periodsByCharger:two.periods});
  assert.ok(Math.abs(replay.plans.charger1.costCents-two.result.costCents)<1e-7);
  assert.throws(()=>refinePeriods({...options,maxEvaluations:Infinity}),/bounded/);
  assert.deepEqual(periods,{charger1:[{startAt:input.now,endAt:null}]});
});
