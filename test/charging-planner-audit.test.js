import test from 'node:test';
import assert from 'node:assert/strict';
import { planChargers, forecastCharger } from '../src/charging/planner.js';

const now = Date.parse('2026-09-24T00:00:00Z'), HOUR = 3_600_000, QUARTER = HOUR / 4;
const v = value => ({ value, available: value !== null, assumed: false });
const job = (id, energy = 4.14, extra = {}) => ({ id, label: id, requiredGridKwh: energy, deadlineAt: now + HOUR,
  settings: { enabled: true }, capabilities: { scheduling: true, currentControl: id === 'charger2', externalLoadBalancing: id === 'charger1' },
  values: { connected: v(true), charging: v(false), currentA: v(16), maximumCurrentA: v(16), actualCurrentA: v(0),
    voltageV: v(230), powerKw: v(0), minimumSoc: v(80), vehicleCeilingSoc: v(80), soc: v(20) }, control: {}, telemetry: {}, ...extra });
const prices = numbers => numbers.map((priceCtPerKwh,i) => ({ start: now + i * QUARTER, end: now + (i+1) * QUARTER, priceCtPerKwh }));
const run = (chargers, extra = {}) => planChargers({ now, chargers, prices: prices([10,10,10,10]),
  supply: { configuredBudgetCurrentA: [16,16,16] }, ...extra });

test('current commanded limits bound C2 delivery in every household scenario', () => {
  const result = run([job('charger2', 8)], { household: [{ start: now, end: now + HOUR, phaseCurrentA: [4,4,4],
    scenarios: [{ phaseCurrentA: [8,8,8], weight: 1 }, { phaseCurrentA: [0,0,0], weight: 1 }] }] });
  assert.equal(result.plans.charger2.feasible, false);
  assert.ok(result.plans.charger2.deliveredGridKwh <= 5.52 + 1e-8);
  for (const row of result.allocations) assert.equal(row.chargers.charger2.currentA, row.chargers.charger2.currentLimitA);
});

test('configured capacity is usable without an Equalizer estimate; clipped live data is not reconstructed', () => {
  assert.equal(run([job('charger1', 10)]).feasible, true);
  const clipped = run([job('charger1', 10)], { supply: { availableCurrentA: [0,0,0], propertyCurrentA: [30,30,30], chargerCurrentA: [0,0,0] } });
  assert.equal(clipped.feasible, false);
  assert.equal(clipped.assumptions.supply, 'equalizer-live');
});

test('native start, current and vehicle ceiling constrain physical charger plans', () => {
  const charger = job('charger2', 2.07);
  charger.values.vehicleNotBefore = v(now + HOUR / 2);
  charger.values.vehicleCurrentA = v(6);
  const result = run([charger], { prices: prices([-100,-100,10,10]) });
  assert.equal(result.feasible, true);
  assert.ok(result.plans.charger2.startAt >= now + HOUR / 2);
  assert.ok(result.allocations.every(row => row.start >= now + HOUR / 2 && row.chargers.charger2.currentA <= 6));
  charger.values.vehicleCeilingSoc = v(70);
  const constrained = run([charger]);
  assert.equal(constrained.feasible, false);
  assert.equal(constrained.plans.charger2.feasible, false);
  assert.match(constrained.plans.charger2.warnings.join(' '), /vehicle limit/);
});

test('a vehicle timer beyond ready-by releases that charger without disabling its peer plan', () => {
  const blocked = job('charger1', 2.07), peer = job('charger2', 2.07);
  blocked.values.vehicleNotBefore = v(now + 2 * HOUR);
  const result = run([blocked, peer], { prices: prices([100,100,1,1]) });
  assert.equal(result.feasible, false);
  assert.equal(result.plans.charger1.reason, 'vehicle-start-after-deadline');
  assert.equal(result.plans.charger1.state, 'release');
  assert.equal(result.plans.charger1.provisional, true);
  assert.equal(result.plans.charger1.feasible, false);
  assert.equal(result.plans.charger2.feasible, true);
  assert.ok(result.plans.charger2.startAt >= now + HOUR / 2);
});

test('a native start beyond published price coverage yields a provisional release without crashing', () => {
  const charger = job('charger1', 2.07);
  charger.values.vehicleNotBefore = v(now + HOUR / 2);
  const result = run([charger], { prices: prices([10]) });
  assert.equal(result.plans.charger1.state, 'release');
  assert.equal(result.plans.charger1.provisional, true);
  assert.equal(result.plans.charger1.feasible, false);
  assert.equal(result.plans.charger1.reason, 'price-coverage-unavailable');
});

test('releasing a timer-blocked car reserves its later load without the removed charger hold', () => {
  const blocked = job('charger1', 2.07, { deadlineAt: now + QUARTER });
  blocked.values.vehicleNotBefore = v(now + HOUR / 2);
  blocked.values.scheduledStartAt = v(now + HOUR);
  const result = run([blocked, job('charger2', 5.52)], { prices: prices([10,10,1,1]) });
  assert.equal(result.forecasts.charger1.startAt, now + HOUR / 2);
  assert.equal(result.plans.charger2.feasible, true);
  assert.ok(result.plans.charger2.finishAt <= now + HOUR / 2);
});

test('an uncontrolled peer vehicle timer reserves load only after its native start', () => {
  const peer = job('charger1', 8, { settings: { enabled: false } });
  peer.values.vehicleNotBefore = v(now + HOUR / 2);
  const forecast = forecastCharger({ now, deadlineAt: now + HOUR, charger: peer });
  assert.equal(forecast.startAt, now + HOUR / 2);
  assert.equal(forecast.scheduled, true);
  const result = run([peer, job('charger2', 5.52)], { prices: prices([10,10,1,1]) });
  assert.equal(result.plans.charger2.feasible, true);
  assert.ok(result.plans.charger2.finishAt <= now + HOUR / 2);
  peer.control = { released: true };
  const releasedForecast = forecastCharger({ now, deadlineAt: now + HOUR, charger: peer });
  assert.equal(releasedForecast.startAt, now + HOUR / 2, 'charger permission does not override the car timer');
  assert.equal(releasedForecast.charging, false);
  peer.values.charging = v(true);
  assert.equal(forecastCharger({ now, deadlineAt: now + HOUR, charger: peer }).startAt, now,
    'observed charging proves the vehicle currently accepts power');
});

test('joint planning retains post-target load when the native vehicle ceiling is higher', () => {
  const first=job('charger1',1,{deadlineAt:now+QUARTER}), second=job('charger2',7);
  first.values.vehicleCeilingSoc=v(90);
  const result=run([first,second]);
  const finish=result.plans.charger1.finishAt;
  assert(finish<=now+QUARTER);
  assert(result.allocations.some(row=>row.start>=finish && row.chargers.charger1?.currentA>0));
  assert(result.forecasts.charger1.endAt>finish);
  assert.equal(result.forecasts.charger1.known,false);
  assert(result.allocations.every(row=>row.phaseCurrentA.every(current=>current<=16+1e-8)));
});

test('a native C2 user current cap constrains both scheduling and active peer forecasts', () => {
  const charger=job('charger2',8);
  charger.values.nativeCurrentA=v(8);
  const result=run([charger]);
  assert.equal(result.feasible,false);
  assert(result.plans.charger2.deliveredGridKwh<=5.52+1e-8);
  assert(result.allocations.every(row=>row.chargers.charger2.currentA<=8));
  charger.values.charging=v(true);
  const forecast=forecastCharger({now,deadlineAt:now+HOUR,charger});
  assert.equal(forecast.currentA,8);
  assert.equal(forecast.powerKw,5.52);
});

test('priority preserves an achievable early secondary deadline and does not buy preference-only expensive energy', () => {
  for (const preferred of ['charger1','charger2']) {
    const secondary = preferred === 'charger1' ? 'charger2' : 'charger1';
    const result = run([job(preferred, 5.52), job(secondary, 5.52, { deadlineAt: now + HOUR / 2 })], { priority: preferred });
    assert.equal(result.feasible, true);
    assert.ok(result.plans[secondary].finishAt <= now + HOUR / 2 + 1);
    const economic = run([job(preferred, 2.07), job(secondary, 2.07)], { priority: preferred, prices: prices([100,100,1,1]) });
    assert.equal(economic.feasible, true);
    assert.ok(economic.allocations.every(row => row.start >= now + HOUR / 2));
    assert.ok(Math.abs(economic.plans[preferred].costCents + economic.plans[secondary].costCents - 4.14) < 1e-8);
  }
});

test('in unavoidable shortage priority maximizes the preferred request while balanced time slices share normalized shortfall', () => {
  const args = { supply: { configuredBudgetCurrentA: [6,6,6] } };
  for (const priority of ['charger1','charger2']) {
    const result = run([job('charger1', 4.14), job('charger2', 4.14)], { ...args, priority });
    assert.equal(result.feasible, false);
    assert.ok(Math.abs(result.plans[priority].deliveredGridKwh - 4.14) < 1e-8);
  }
  const balanced = run([job('charger1', 4.14), job('charger2', 4.14)], args);
  assert.equal(balanced.feasible, false);
  for (const plan of Object.values(balanced.plans)) assert.ok(Math.abs(plan.deliveredGridKwh - 2.07) < 1e-8);
  for (const row of balanced.allocations) assert.ok(Object.values(row.chargers).every(charger => charger.currentA === 0 || charger.currentA >= 6));
});

// Independent exhaustive quarter-hour oracle: each vehicle accepts exactly 6 A
// and needs an integer number of slots. It does not reuse planner internals.
function enumerate(raw, budgets, required, deadlines) {
  let best = Infinity;
  function visit(i, delivered, cost) {
    if (i === raw.length) { if (delivered.every((n,j) => n >= required[j])) best = Math.min(best, cost); return; }
    for (const a of [0,1]) for (const b of [0,1]) {
      if ((a+b)*6 > budgets[i]) continue;
      const extra = [a,b];
      if (extra.some((n,j) => n && (i >= deadlines[j] || delivered[j] >= required[j]))) continue;
      visit(i+1, delivered.map((n,j) => n+extra[j]), cost + (a+b)*1.035*raw[i]);
    }
  }
  visit(0,[0,0],0); return best;
}

test('small two-job enumeration independently checks feasibility, cash objective and the reported bound', () => {
  for (const fixture of [
    { raw: [4,1,1,4], budgets: [12,12,12,12], required: [2,2], deadlines: [4,4] },
    { raw: [4,1,1,4], budgets: [6,6,6,6], required: [2,2], deadlines: [3,4] },
    { raw: [4,-1,1,4], budgets: [6,12,6,12], required: [1,2], deadlines: [3,4] },
  ]) for (const priority of ['balanced','charger1','charger2']) {
    const chargers = ['charger1','charger2'].map((id,i) => {
      const charger = job(id, fixture.required[i]*1.035, { deadlineAt: now + fixture.deadlines[i]*QUARTER });
      charger.values.maximumCurrentA = v(6); return charger;
    });
    const result = run(chargers, { priority, prices: prices(fixture.raw), supply: { configuredBudgetCurrentA: [12,12,12] },
      household: fixture.budgets.map((n,i) => ({ start: now+i*QUARTER, end: now+(i+1)*QUARTER, phaseCurrentA: [12-n,12-n,12-n] })) });
    const optimum = enumerate(fixture.raw, fixture.budgets, fixture.required, fixture.deadlines);
    assert.equal(result.feasible, Number.isFinite(optimum), JSON.stringify({fixture,priority}));
    const actual = Object.values(result.plans).reduce((sum,plan) => sum+plan.costCents,0);
    assert.ok(Math.abs(actual-optimum) < 1e-6, `${priority}: ${actual} versus independent ${optimum}`);
    assert.equal(result.solver.globalOptimalityProven, false);
    assert.ok(result.solver.cashCostLowerBoundCents <= optimum + 1e-6);
    assert.ok(result.solver.cashCostGapBoundCents + 1e-6 >= actual-optimum);
  }
});
