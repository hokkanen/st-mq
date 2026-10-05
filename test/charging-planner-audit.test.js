import test from 'node:test';
import assert from 'node:assert/strict';
import { planChargers, forecastCharger, forecastFixedPlans, currentChargingAllocation } from '../src/charging/planner.js';

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

test('a 5 A vehicle request forecasts 5 A delivery while reserving a valid 6 A pilot', () => {
  for (const id of ['charger1', 'charger2']) {
    const charger = job(id, 3.45); charger.values.vehicleCurrentA = v(5);
    const result = run([charger]);
    assert.equal(result.plans[id].feasible, true);
    assert.ok(Math.abs(result.plans[id].deliveredGridKwh - 3.45) < 1e-8);
    assert.ok(result.allocations.every(row => row.chargers[id].currentA === 5));
    assert.ok(result.allocations.every(row => row.phaseCurrentA.every(current => current === 6)),
      'The minimum valid pilot is reserved independently of the lower vehicle draw');
    if (id === 'charger2') assert.ok(result.allocations.every(row => row.chargers[id].currentLimitA === 6));
    else assert.ok(result.allocations.every(row => row.chargers[id].currentLimitA === null),
      'An externally balanced charger receives no positive-current command');
    charger.requiredGridKwh = 3.46;
    const shortfall = run([charger]);
    assert.equal(shortfall.plans[id].feasible, false, 'A 6 A pilot cannot be counted as 6 A delivered');
    assert.ok(shortfall.plans[id].deliveredGridKwh <= 3.45 + 1e-8);
  }
});

test('a positive vehicle request below 6 A cannot bypass native ceilings or reserve more shared capacity than exists', () => {
  for (const restriction of ['vehicle-stop', 'native-limit', 'electrical-limit']) {
    const charger = job('charger2', 1); charger.values.vehicleCurrentA = v(restriction === 'vehicle-stop' ? 0 : 5);
    if (restriction === 'native-limit') charger.values.nativeCurrentA = v(5);
    const result = run([charger], restriction === 'electrical-limit' ? { supply: { configuredBudgetCurrentA: [5,5,5] } } : {});
    assert.equal(result.plans.charger2.feasible, false);
    assert.equal(result.plans.charger2.deliveredGridKwh, 0);
    assert.ok(result.allocations.every(row => row.chargers.charger2.currentLimitA === 0));
  }
  const low = job('charger2', 1.725); low.values.vehicleCurrentA = v(5);
  const peer = job('charger1', 2.07); peer.values.vehicleCurrentA = v(6);
  const result = run([peer, low], { supply: { configuredBudgetCurrentA: [11,11,11] } });
  assert.equal(result.feasible, true);
  assert.ok(result.allocations.every(row => !(row.chargers.charger1?.currentA > 0 && row.chargers.charger2?.currentA > 0)),
    'Eleven available amps cannot admit two 6 A pilots even when forecast demand totals eleven');
  assert.ok(result.allocations.every(row => row.phaseCurrentA.every(current => current <= 11)));
});

test('an observed 5 A vehicle forecast keeps expected energy separate from its 6 A reservation', () => {
  const charger = job('charger2', 3.45); charger.values.vehicleCurrentA = v(5); charger.values.charging = v(true);
  charger.values.actualCurrentA = v(5);
  const forecast = forecastCharger({ now, deadlineAt: now + HOUR, charger });
  assert.equal(forecast.currentA, 5); assert.equal(forecast.powerKw, 3.45);
  assert.deepEqual(forecast.phaseCurrentA, [6,6,6]);
  assert.equal(forecast.finishAt, now + HOUR);
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

test('opening the final Equalizer period preserves shared allocation under every priority', () => {
  for (const priority of ['balanced', 'charger1', 'charger2']) {
    const chargers = [job('charger1'), job('charger2')];
    const before = run(chargers, { priority });
    assert.equal(before.feasible, true);
    chargers[0].control = { released: true, phase: 'released' };
    chargers[0].values.charging = v(true);
    chargers[0].values.actualCurrentA = v(before.allocations[0].chargers.charger1.currentA);
    const after = run(chargers, { priority });
    assert.equal(after.feasible, true, priority);
    assert.deepEqual(after.plans.charger1.periods, [{ startAt: now, endAt: null }]);
    assert.equal(after.plans.charger1.state, 'released');
    assert.deepEqual(after.allocations, before.allocations, 'a permission transition cannot consume additional supply');
    assert.equal(after.solver.cashCostCandidateCents, 82.8);
    assert.ok(after.currentLimits.every(row => row.chargerId === 'charger2'));
  }
});

test('observed open manual, Automatic OFF and Charge Now peers retain permission while sharing current', () => {
  for (const mode of ['off', 'manual', 'charge-now']) for (const priority of ['balanced', 'charger1', 'charger2']) {
    const first = job('charger1'), second = job('charger2');
    first.values.charging = v(true); first.values.actualCurrentA = v(8);
    if (mode === 'off') first.settings.enabled = false;
    if (mode === 'manual') first.control = { manual: { kind: 'charge-now' } };
    if (mode === 'charge-now') {
      first.request = { chargeNow: true };
      first.control = { released: true, phase: 'released' };
    }
    const result = run([first, second], { priority });
    assert.equal(result.feasible, true, `${mode}/${priority}`);
    assert.deepEqual(result.plans.charger1.periods, [{ startAt: now, endAt: null }]);
    assert.equal(result.plans.charger1.state, mode === 'off' ? 'disabled' : mode === 'manual' ? 'manual' : 'released');
    const allocation = result.allocations[0].chargers;
    assert.equal(allocation.charger2.currentA, priority === 'charger2' ? 16 : priority === 'charger1' ? 0 : 8);
  }
});

test('joint adopted forecasts preserve exact periods, current priority, energy and per-charger slices', () => {
  const chargers = [job('charger1'), job('charger2')];
  for (const charger of chargers) {
    charger.values.charging = v(true); charger.values.actualCurrentA = v(8); charger.values.currentA = v(8);
    charger.control = { phase: 'active' };
  }
  const periodsByCharger = Object.fromEntries(chargers.map(charger => [charger.id, [{ startAt: now, endAt: null }]]));
  for (const priority of ['balanced', 'charger1', 'charger2']) {
    const result = forecastFixedPlans({ now, chargers, periodsByCharger, priority,
      prices: prices([10,10,10,10]), supply: { configuredBudgetCurrentA: [16,16,16] } });
    assert.equal(result.feasible, true, priority);
    assert.equal(result.assumptions.priority, priority);
    for (const charger of chargers) {
      const plan = result.plans[charger.id], forecast = result.forecasts[charger.id];
      assert.deepEqual(plan.periods, periodsByCharger[charger.id]);
      assert.equal(forecast.feasible, true);
      assert.equal(forecast.finishAt, plan.finishAt);
      assert.ok(plan.finishAt <= now + HOUR);
      const integrated = plan.allocations.reduce((sum, row) => sum + row.powerKw * (row.end - row.start) / HOUR, 0);
      assert.ok(Math.abs(integrated - 4.14) < 1e-8);
      assert.deepEqual(plan.allocations, forecast.allocations);
      if (priority === 'balanced') assert.equal(plan.finishAt, now + 3 * QUARTER);
    }
    assert.equal(result.solver.cashCostCandidateCents, 82.8);
  }
});

test('mixed fixed and optimized periods never move the adopted peer or manufacture shared capacity', () => {
  const chargers = [job('charger1', 2.07), job('charger2', 4.14)];
  const fixed = [{ startAt: now, endAt: now + QUARTER }, { startAt: now + 3 * QUARTER, endAt: null }];
  const result = run(chargers, { priority: 'charger2', prices: prices([20,1,1,20]), fixedPeriods: { charger1: fixed } });
  assert.equal(result.feasible, true);
  assert.deepEqual(result.plans.charger1.periods, fixed);
  assert.ok(result.allocations.every(row => row.phaseCurrentA.every(current => current <= 16)));
  assert.ok(result.plans.charger1.allocations.filter(row => row.start >= now + QUARTER && row.end <= now + 3 * QUARTER)
    .every(row => row.currentA === 0));
});

test('native stops and unknown idle peers cannot acquire charging permission through fixed assessment', () => {
  for (const kind of ['manual-stop', 'telemetry-stop', 'idle', 'disconnected']) {
    const first = job('charger1'), second = job('charger2');
    if (kind === 'manual-stop') first.control = { manual: { kind: 'stop' } };
    if (kind === 'telemetry-stop') first.telemetry.manualStop = true;
    if (kind === 'disconnected') first.values.connected = v(false);
    const result = forecastFixedPlans({ now, chargers: [first, second],
      periodsByCharger: { charger2: [{ startAt: now, endAt: null }] }, supply: { configuredBudgetCurrentA: [16,16,16] } });
    assert.equal(result.plans.charger2.feasible, true, kind);
    assert.ok(result.allocations.every(row => !row.chargers.charger1));
    assert.equal(result.plans.charger2.finishAt, now + 22.5 * 60_000);
  }
});

test('native peer timer and stop bound shared participation; fresh charging overrides a held future vehicle start', () => {
  const first = job('charger1'); first.settings.enabled = false;
  first.values.scheduledStartAt = v(now + HOUR / 2);
  first.values.scheduledEndAt = v(now + 3 * QUARTER);
  first.telemetry.scheduledEndKind = 'scheduled-stop';
  const result = run([first, job('charger2')]);
  assert.deepEqual(result.plans.charger1.periods, [{ startAt: now + HOUR / 2, endAt: now + 3 * QUARTER }]);
  assert.ok(result.plans.charger1.allocations.filter(row => row.end <= now + HOUR / 2 || row.start >= now + 3 * QUARTER)
    .every(row => row.currentA === 0));
  first.values.charging = v(true); first.values.vehicleNotBefore = v(now + 2 * HOUR);
  const observed = run([first, job('charger2')]);
  assert.ok(observed.allocations[0].chargers.charger1.currentA > 0);
  assert.equal(first.values.vehicleNotBefore.value, now + 2 * HOUR, 'observation must not rewrite vehicle telemetry');
});

test('post-target observed demand remains a shared load across its passed deadline', () => {
  const first = job('charger1', 0, { deadlineAt: now - QUARTER });
  first.control = { released: true, phase: 'released' }; first.values.charging = v(true); first.values.actualCurrentA = v(8);
  const result = run([first, job('charger2', 2.07)]);
  assert.equal(result.plans.charger2.feasible, true);
  assert.ok(result.allocations.every(row => Object.hasOwn(row.chargers, 'charger1')));
  assert.ok(result.allocations.some(row => row.start >= result.plans.charger2.finishAt && row.chargers.charger1.currentA > 0));
  assert.equal(result.forecasts.charger1.known, false);
  assert.equal(result.forecasts.charger1.endAt, now + HOUR);
  first.values.charging = v(false); first.values.actualCurrentA = v(0);
  const stopped = run([first, job('charger2', 2.07)]);
  assert.ok(stopped.allocations.every(row => !row.chargers.charger1));
});

test('repeated planning keeps bounded low-current slices and shares recorded progress across unequal deadlines', () => {
  const chargers = [job('charger1', 4.14, { deadlineAt: now + 55 * 60_000 }), job('charger2', 4.14)];
  for (const charger of chargers) {
    charger.control = { released: true, phase: 'released' };
    charger.values.charging = v(true);
    charger.sessionCost = { recordedGridKwh: 0 };
  }
  let previousAllocations = [];
  const selected = [];
  for (let minute = 0; minute < 45; minute += 5) {
    const result = run(chargers, { now: now + minute * 60_000, previousAllocations,
      supply: { configuredBudgetCurrentA: [6,6,6] } });
    const current = result.allocations.find(row => row.start <= now + minute * 60_000 && row.end > now + minute * 60_000);
    const winner = Object.entries(current.chargers).find(([,row]) => row.currentA >= 6)?.[0];
    assert.ok(winner);
    selected.push(winner);
    for (const charger of chargers) if (charger.id === winner) {
      const energy = 4.14 * 5 / 60;
      charger.requiredGridKwh -= energy;
      charger.sessionCost.recordedGridKwh += energy;
      // A source SoC rebase must not erase measured connection progress.
      charger.referenceGridKwh = charger.requiredGridKwh;
    }
    previousAllocations = result.allocations;
  }
  assert.deepEqual(selected.slice(0, 3), ['charger1', 'charger1', 'charger1']);
  assert.deepEqual(selected.slice(3, 6), ['charger2', 'charger2', 'charger2']);
  assert.deepEqual(selected.slice(6, 9), ['charger1', 'charger1', 'charger1']);
  assert.ok(chargers.every(charger => charger.sessionCost.recordedGridKwh >= 1.035 - 1e-8));
});

test('a retained balanced current slice cannot override native limits, explicit priority or an achievable deadline', () => {
  const chargers = [job('charger1'), job('charger2')];
  const initial = run(chargers, { supply: { configuredBudgetCurrentA: [6,6,6] } });
  const at = now + 5 * 60_000;
  for (const charger of chargers) charger.control = { released: true, phase: 'released' };
  const args = { now: at, previousAllocations: initial.allocations, supply: { configuredBudgetCurrentA: [6,6,6] } };
  const preferred = run(chargers, { ...args, priority: 'charger2' });
  assert.equal(preferred.allocations[0].chargers.charger2.currentA, 6);
  chargers[0].values.nativeCurrentA = v(0);
  const restricted = run(chargers, args);
  assert.equal(restricted.allocations[0].chargers.charger1.currentA, 0);
  assert.equal(restricted.allocations[0].chargers.charger2.currentA, 6);
  chargers[0].values.nativeCurrentA = v(6);
  chargers[0].requiredGridKwh = 1.035;
  chargers[1].requiredGridKwh = .345;
  chargers[1].deadlineAt = at + 5 * 60_000;
  const deadline = run(chargers, args);
  assert.equal(deadline.plans.charger2.feasible, true, 'service overrides a held fairness slice');
  assert.equal(deadline.allocations[0].chargers.charger2.currentA, 6);
});

test('cost-estimated missing energy cannot create normalized delivery credit or a false feasible cost bound', () => {
  const chargers = [job('charger1'), job('charger2')];
  chargers[0].sessionCost = { recordedGridKwh: 0, unrecordedGridKwh: 100, deliveredGridKwh: 100 };
  const short = run(chargers, { supply: { configuredBudgetCurrentA: [6,6,6] } });
  assert.equal(short.allocations[0].chargers.charger1.currentA, 6);
  assert.equal(short.solver.cashCostCandidateCents, null);
  assert.equal(short.solver.cashCostLowerBoundCents, null);
  const conflict = job('charger1', 1);
  conflict.values.vehicleCeilingSoc = v(70);
  const constrained = run([conflict]);
  assert.equal(constrained.solver.cashCostCandidateCents, null);
  assert.equal(constrained.solver.cashCostLowerBoundCents, null);
});

test('a met request cannot spend the peer\'s cheap charging opportunity merely because it has priority', () => {
  for (const completed of ['charger1', 'charger2']) for (const priority of ['balanced', 'charger1', 'charger2']) {
    const chargers = ['charger1', 'charger2'].map(id => {
      const charger = job(id, id === completed ? 0 : 4.14);
      charger.control = { released: true, phase: 'released' };
      charger.values.charging = v(true); charger.values.actualCurrentA = v(8);
      charger.values.vehicleCeilingSoc = v(100);
      return charger;
    });
    const result = run(chargers, { priority, prices: prices([1,1,100,100]) });
    const pending = completed === 'charger1' ? 'charger2' : 'charger1';
    assert.equal(result.plans[pending].feasible, true);
    assert.ok(Math.abs(result.plans[pending].costCents - 4.14) < 1e-8, `${completed}/${priority}`);
    assert.ok(result.allocations.some(row => row.start >= result.plans[pending].finishAt && Object.hasOwn(row.chargers, completed)),
      'the open native load is still represented once the requested service is delivered');
    assert.deepEqual(result.plans[completed].periods, [{ startAt: now, endAt: null }]);
  }
});

test('fixed joint forecasts retain honest cost bounds for zero and negative rates and disclose price gaps', () => {
  const chargers = [job('charger1', 1.035), job('charger2', 1.035)];
  const periodsByCharger = Object.fromEntries(chargers.map(charger => [charger.id, [{ startAt: now, endAt: null }]]));
  const forecast = rates => forecastFixedPlans({ now, chargers, periodsByCharger, prices: rates,
    supply: { configuredBudgetCurrentA: [12,12,12] } });
  for (const tariff of [0, -10]) {
    const result = forecast(prices([tariff,tariff,tariff,tariff]));
    assert.equal(result.feasible, true);
    assert.equal(result.solver.kind, 'fixed-execution');
    assert.equal(result.solver.cashCostCandidateCents, 2.07 * tariff);
    assert.equal(result.solver.cashCostLowerBoundCents, 2.07 * tariff);
    assert.equal(result.solver.cashCostGapBoundCents, 0);
    assert.equal(result.solver.globalOptimalityProven, false);
    assert.equal(result.plans.charger1.costCents, 1.035 * tariff);
    assert.equal(result.plans.charger2.costCents, 1.035 * tariff);
    assert.equal(result.plans.charger1.costCents + result.plans.charger2.costCents, result.solver.cashCostCandidateCents);
  }
  const unpriced = forecast([]);
  assert.equal(unpriced.feasible, true, 'unknown rates do not remove physical opportunity');
  assert.equal(unpriced.assumptions.priceCoverage, 'partial');
  assert.equal(unpriced.solver.cashCostCandidateCents, null);
  assert.equal(unpriced.solver.cashCostLowerBoundCents, null);
  assert.equal(unpriced.solver.cashCostGapBoundCents, null);
  const laterGap = forecast(prices([10]));
  assert.equal(laterGap.solver.cashCostCandidateCents, 20.7, 'the fixed candidate itself is entirely priced');
  assert.equal(laterGap.solver.cashCostLowerBoundCents, null, 'unknown alternative prices cannot support an optimality bound');
  assert.equal(laterGap.assumptions.priceCoverage, 'partial');
  const mixed = forecastFixedPlans({ now, chargers, periodsByCharger: { charger1: [{ startAt: now, endAt: null }],
    charger2: [{ startAt: now + HOUR / 2, endAt: null }] }, prices: prices([10]), supply: { configuredBudgetCurrentA: [12,12,12] } });
  assert.equal(mixed.plans.charger1.costCents, 10.35);
  assert.equal(mixed.plans.charger2.costCents, null);
  assert.equal(mixed.solver.cashCostCandidateCents, null);
});

test('native open permission keeps joint entitlement independent of peer draw and Equalizer allowance', () => {
  for (const priority of ['balanced', 'charger1', 'charger2']) {
    const chargers = [job('charger1', 4.14), job('charger2', 8.28)];
    for (const charger of chargers) {
      charger.settings.enabled = false;
      charger.telemetry.currentSharingActive = true;
    }
    const supply = { configuredBudgetCurrentA: [24, 24, 24] };
    const before = run(chargers, { priority, supply });
    assert.ok(before.allocations.some(row => row.chargers.charger1?.currentA > 0), 'A permitted zero-current peer keeps its request');
    for (const actual of [16, 8, 0, 12, 0]) {
      chargers[0].values.actualCurrentA = v(actual);
      chargers[0].values.powerKw = v(actual * .69);
      chargers[0].values.charging = v(actual > 0);
      chargers[0].values.currentA = v(actual);
      const after = run(chargers, { priority, supply: { ...supply,
        propertyCurrentA: [actual + 8, actual + 8, actual + 8], chargerCurrentA: [actual, actual, actual],
        availableCurrentA: [actual, actual, actual] } });
      assert.deepEqual(after.allocations, before.allocations);
      assert.deepEqual(after.currentLimits, before.currentLimits);
    }
  }
});

test('live current allocation uses energy and deadlines without measured peer demand', () => {
  const chargers = [job('charger1', 4.14), job('charger2', 8.28)];
  for (const charger of chargers) charger.telemetry.currentSharingActive = true;
  const input = { now, chargers, priority: 'balanced', budgetCurrentA: [24, 24, 24] };
  const allocation = currentChargingAllocation(input);
  assert.equal(allocation.charger1.currentA, 8);
  assert.equal(allocation.charger2.currentLimitA, 16, 'Balanced follows the unequal energy requirements');
  chargers[0].values.charging = v(true);
  chargers[0].values.actualCurrentA = v(16);
  chargers[0].values.currentA = v(0);
  assert.deepEqual(currentChargingAllocation(input), allocation);
  chargers[0].values.actualCurrentA = v(0);
  chargers[0].values.charging = v(false);
  assert.deepEqual(currentChargingAllocation(input), allocation);
  chargers[0].control.manual = { kind: 'stop' };
  assert.equal(currentChargingAllocation(input).charger1, undefined, 'An explicit native Stop changes participation');
  chargers[0].control.manual = null;
  chargers[0].deadlineAt = now + HOUR / 4;
  assert.ok(currentChargingAllocation(input).charger1.currentA > allocation.charger1.currentA,
    'A changed ready-by request can revise entitlement');
});


test('completed native vehicle targets release current entitlement without using observed draw', () => {
  const chargers = [job('charger1', 0), job('charger2', 4.14)];
  for (const charger of chargers) charger.telemetry.currentSharingActive = true;
  const input = { now, chargers, priority: 'charger1', budgetCurrentA: [16, 16, 16] };
  for (const draw of [0, 8]) {
    chargers[0].values.actualCurrentA = v(draw);
    chargers[0].values.charging = v(draw > 0);
    const selected = currentChargingAllocation(input);
    assert.equal(selected.charger1, undefined);
    assert.equal(selected.charger2.currentLimitA, 16);
  }
});
