import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, dhwrEligible, comfortPenalty, evaluateSchedule } from '../src/control/index.js';

const HOUR = 3_600_000;
const now = Date.parse('2026-09-06T09:00:00Z');
const iso = value => new Date(value).toISOString();
function model(at = now) {
  return { version: 1, trainedAt: iso(at), parameters: { lossPerHour: 0.02, normalHeatCPerHour: 0.8,
    reducedHeatCPerHour: 0.06, recoveryDegreeHoursPerHour: 0.25, uncertaintyCPerHour: 0.03 },
  energy: { verifiedMeter: true, samples: 100, normalKw: 3, reductionKw: 0.3, auxiliaryKw: 0.05,
    recoveryMultiplier: 1.5, relativeUncertainty: 0.3 },
  validation: { chronological: true, accepted: true, samples: 24, maeCPerHour: 0.04 } };
}
function fixture(at = now) {
  return { now: at, settings: { comfort: { targetC: 21 } },
    observations: { indoor: { value: 21, observedAt: iso(at) }, outdoor: { value: 0, observedAt: iso(at) } },
    prices: Array.from({ length: 24 }, (_, i) => ({ start: iso(at + i * HOUR), end: iso(at + (i + 1) * HOUR), allInCentsPerKWh: i < 2 ? 100 : 1 })),
    forecast: [{ start: iso(at), end: iso(at + 24 * HOUR), outdoorC: 0, issuedAt: iso(at) }],
    learned: { model: model(at), health: { status: 'validated-estimates' } },
    state: { lastDecisionAt: iso(at - HOUR / 4), lastAction: 'normal', lastDhwrAt: iso(at - HOUR / 4), deficitDegreeHours: 0 } };
}

test('conservative startup needs no credentials or model and issues normal intents', () => {
  const decision = decide({ now });
  assert.equal(decision.action, 'normal');
  assert.ok(decision.reasons.includes('learning-normal-comfort-reference'));
  assert.ok(decision.reasons.includes('unvalidated-thermal-model'));
  assert.deepEqual(decision.commands, ['circulation', 'normal']);
  assert.equal(decision.comfort.maxDropC, 1.5);
  assert.equal(decision.comfort.targetC, null);
});

test('stable learned target is used and does not follow current room temperature', () => {
  const input = fixture();
  input.settings = {};
  input.learned.comfortReference = { version: 1, targetC: 21.5, source: 'normal-baseline' };
  input.observations.indoor.value = 19;
  const result = decide(input);
  assert.equal(result.comfort.targetC, 21.5);
  assert.equal(result.action, 'normal');
  assert.ok(result.reasons.includes('severe-cooling-protection'));
});

test('a high current price can select a modest reduction after accounting for full recovery', () => {
  const result = decide(fixture());
  assert.equal(result.action, 'reduction');
  assert.deepEqual(result.commands, ['reduction']);
  assert.equal(result.dhwr.requested, false);
  assert.equal(result.plan.baseline.reductionHours, 0);
  assert.ok(result.plan.chosen.reductionHours <= 2);
  assert.ok(result.plan.chosen.costCents < result.plan.baseline.costCents);
  assert.ok(result.plan.chosen.endIndoorC >= result.plan.baseline.endIndoorC - 0.2);
  assert.ok(result.plan.chosen.auxiliaryKwh > 0);
  assert.match(result.plan.evidence, /not measured/);
});

test('flat and negative current prices prefer continuous native operation', () => {
  for (const price of [0, 1, -25]) {
    const input = fixture();
    input.prices = input.prices.map(item => ({ ...item, allInCentsPerKWh: price }));
    const result = decide(input);
    assert.equal(result.action, 'normal', `price ${price}`);
    assert.equal(result.plan.chosen.reductionHours, 0);
  }
});

test('quarter-hour prices preserve duration and support a 24-hour recovery horizon', () => {
  const input = fixture();
  input.prices = Array.from({ length: 96 }, (_, i) => ({ start: iso(now + i * HOUR / 4),
    end: iso(now + (i + 1) * HOUR / 4), allInCentsPerKWh: i < 8 ? 100 : 1 }));
  const result = decide(input);
  assert.equal(result.action, 'reduction');
  assert.equal(result.plan.chosen.steps.length, 96);
  assert.equal(result.plan.horizonEnd, iso(now + 24 * HOUR));
});

test('missing, unusable, suspect, future and zero indoor readings cause normal fallback', () => {
  const readings = [undefined, { value: 21, observedAt: iso(now - HOUR), stale: true }, { value: 0, observedAt: iso(now) },
    { value: 21, observedAt: iso(now), quality: 'suspect' }, { value: 21, observedAt: iso(now), quality: ['unverified-scaling'] },
    { value: 21, observedAt: iso(now), quality: ['retained'] }, { value: 21, observedAt: iso(now + 1000) }];
  for (const reading of readings) {
    const input = fixture(); input.observations.indoor = reading;
    const result = decide(input);
    assert.equal(result.action, 'normal');
    assert.ok(result.reasons.includes('missing-or-stale-observations'));
  }
});

test('slow and disconnected indoor readings remain eligible with their original age', () => {
  for (const age of [2 * HOUR, 24 * HOUR, 7 * 24 * HOUR]) {
    const input = fixture();
    input.observations.indoor = { value: 21, observedAt: iso(now - age), stale: false,
      needsAttention: true, held: true, attentionReasons: ['disconnected', 'old-reading'] };
    const result = decide(input);
    assert.equal(result.action, 'reduction');
    assert.equal(result.reasons.includes('missing-or-stale-observations'), false);
    input.observations.outdoor.observedAt = iso(now - HOUR);
    assert(decide(input).reasons.includes('missing-or-stale-observations'), 'Outdoor still expires');
  }
});

test('weather and prices require complete, fresh, nonoverlapping coverage', () => {
  for (const mutate of [
    input => input.prices.splice(4, 1),
    input => input.prices.push({ ...input.prices[3] }),
    input => input.prices.splice(4),
    input => { input.forecast[0].issuedAt = iso(now - 7 * HOUR); },
    input => { input.forecast[0].end = iso(now + 2 * HOUR); },
    input => { input.prices[0].allInCentsPerKWh = NaN; },
  ]) {
    const input = fixture(); mutate(input);
    const result = decide(input);
    assert.equal(result.action, 'normal');
    assert.ok(result.reasons.includes('missing-or-incomplete-price-weather-horizon'));
  }
});

test('thermal-only or stale models cannot authorize economic dispatch', () => {
  for (const mutate of [input => { input.learned.model.energy = null; },
    input => { input.learned.model.trainedAt = iso(now - 31 * 24 * HOUR); },
    input => { input.learned.model.validation.accepted = false; }]) {
    const input = fixture(); mutate(input);
    assert.equal(decide(input).action, 'normal');
  }
});

test('unknown forecast issuance accepts only an explicit fresh snapshot and cannot revive old issuance', () => {
  const input = fixture();
  input.forecast[0] = { ...input.forecast[0], issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt: now };
  assert.equal(decide(input).action, 'reduction');
  for (const change of [{ issuedAtBasis: undefined }, { fetchedAt: now - 7 * HOUR }, { fetchedAt: now + 1 },
    { issuedAt: iso(now - 7 * HOUR), fetchedAt: now }]) {
    const invalid = structuredClone(input); Object.assign(invalid.forecast[0], change);
    assert.ok(decide(invalid).reasons.includes('missing-or-incomplete-price-weather-horizon'));
  }
  assert.equal(input.forecast[0].issuedAt, null);
});

test('small comfort breaches are soft and deeper/longer breaches cost more', () => {
  assert.equal(comfortPenalty(20, 21, 1), 0);
  assert.ok(comfortPenalty(19.99, 21, 1) > 0);
  assert.ok(comfortPenalty(19, 21, 1) > comfortPenalty(19.8, 21, 1));
  assert.equal(comfortPenalty(19.8, 21, 1, 2), comfortPenalty(19.8, 21, 1) * 2);
});

test('approaching severe cold excludes reductions despite a large price spike', () => {
  const input = fixture(); input.forecast[0].outdoorC = -35;
  const result = decide(input);
  assert.equal(result.action, 'normal');
  assert.ok(result.plan.alternatives.slice(1).every(option => option.severe));
});

test('terminal reserve is costed even when no recovery fits inside a schedule', () => {
  const p = model();
  const result = evaluateSchedule({ intervals: [{ start: now, end: now + HOUR, durationHours: 1, price: 20, outdoorC: 0 }],
    reductionHours: 1, indoorC: 21, targetC: 21, maxDropC: 1, model: p });
  assert.ok(result.endDeficitDegreeHours > 0);
  assert.ok(result.terminalKwh > 0);
  assert.ok(result.terminalCostCents > 0);
});

test('brief normal heating does not erase reserve debt and consecutive reductions accumulate', () => {
  let input = fixture();
  input.state = { ...input.state, lastAction: 'reduction', lastDecisionAt: iso(now - HOUR), deficitDegreeHours: 1 };
  const first = decide(input);
  assert.ok(first.nextState.deficitDegreeHours > 1);
  assert.ok(first.reasons.includes('recovery-deficit'));
  input = fixture(now + HOUR / 4); input.state = first.nextState;
  const second = decide(input);
  assert.ok(second.nextState.deficitDegreeHours > 0.9);
  assert.equal(second.action, 'normal');
  input = fixture(now + HOUR / 2); input.state = { ...second.nextState, lastAction: 'reduction' };
  assert.ok(decide(input).nextState.deficitDegreeHours > second.nextState.deficitDegreeHours);
});

test('restart with stale state reconciles for four hours and keeps prior reserve debt', () => {
  const input = fixture(); input.state.lastDecisionAt = iso(now - 10 * HOUR); input.state.deficitDegreeHours = 2;
  const result = decide(input);
  assert.equal(result.action, 'normal');
  assert.equal(result.nextState.deficitDegreeHours, 2);
  assert.equal(result.nextState.reconcileUntil, iso(now + 4 * HOUR));
});

test('normal override, fault and verified integral warning take precedence', () => {
  const cases = [input => { input.override = { mode: 'normal', expiresAt: iso(now + HOUR) }; },
    input => { input.observations.fault = { active: true }; },
    input => { input.observations.integral = { value: -900, recoveryThreshold: -800, verified: true, observedAt: iso(now) }; }];
  for (const mutate of cases) { const input = fixture(); mutate(input); assert.equal(decide(input).action, 'normal'); }
  const input = fixture(); input.override = { mode: 'normal', expiresAt: iso(now - 1) };
  assert.equal(decide(input).action, 'reduction');
});

test('away planning removes occupied drop limits while retaining native heating and recovery economics', () => {
  const input = fixture();
  input.observations.indoor.value = 18;
  assert.equal(decide(input).action, 'normal');
  input.settings.occupancy = { mode: 'away', returnAt: iso(now + 48 * HOUR) };
  const away = decide(input);
  assert.equal(away.action, 'reduction');
  assert.equal(away.comfort.maxDropApplies, false);
  assert.equal(away.comfort.targetC, 21);
  assert.equal(away.plan.chosen.comfortPenalty, 0);
  assert.ok(away.plan.alternatives.every(option => !option.severe));
  assert.equal(away.plan.chosen.terminalReferenceC, away.plan.baseline.endIndoorC);
  assert.ok(away.plan.chosen.terminalReferenceC < 21);
  assert.ok(away.plan.chosen.terminalCostCents > 0);
  assert.ok(away.plan.chosen.steps.every(step => !step.occupied));
  for (const maxDropC of [0, 2]) {
    const changed = structuredClone(input); changed.settings.comfort.maxDropC = maxDropC;
    assert.deepEqual(decide(changed).plan.chosen, away.plan.chosen);
  }
});

test('away return deadline restores occupied comfort at its precise instant', () => {
  const returnAt = now + 67 * 60_000;
  const occupancy = { mode: 'away', returnAt: iso(returnAt) };
  const schedule = evaluateSchedule({ intervals: [{ start: now, end: now + 8 * HOUR,
    durationHours: 8, price: 10, outdoorC: 0 }], reductionHours: 2, indoorC: 18,
    targetC: 21, maxDropC: 1, model: model(), occupancy });
  assert.ok(schedule.steps.some(step => Date.parse(step.at) === returnAt));
  assert.ok(schedule.steps.filter(step => Date.parse(step.at) <= returnAt).every(step => !step.occupied));
  assert.ok(schedule.steps.filter(step => Date.parse(step.at) > returnAt).every(step => step.occupied));
  assert.ok(schedule.comfortPenalty > 0);
  assert.equal(schedule.severe, true);
  assert.equal(schedule.endsOccupied, true);
  const input = fixture(); input.observations.indoor.value = 18; input.settings.occupancy = occupancy;
  const decision = decide(input);
  assert.equal(decision.action, 'normal');
  assert.equal(decision.plan.occupancy.returnWithinHorizon, true);
  assert.equal(decision.plan.occupancy.returnAt, iso(returnAt));
});

test('return outside the known horizon adds no invented weather or premature occupied target', () => {
  const input = fixture(); input.observations.indoor.value = 18;
  input.settings.occupancy = { mode: 'away', returnAt: iso(now + 48 * HOUR) };
  const first = decide(input);
  input.settings.occupancy.returnAt = iso(now + 72 * HOUR);
  const later = decide(input);
  assert.equal(first.plan.occupancy.returnWithinHorizon, false);
  assert.equal(first.plan.horizonEnd, iso(now + 24 * HOUR));
  assert.deepEqual(first.plan.chosen, later.plan.chosen);
  assert.match(first.plan.terminalPriceBasis, /not a future price forecast/);
  input.settings.occupancy.returnAt = iso(now);
  const returned = decide(input);
  assert.equal(returned.comfort.maxDropApplies, true);
  assert.ok(returned.reasons.includes('severe-cooling-protection'));
});

test('away dispatch rejects apparent savings when measured auxiliary recovery cost outweighs them', () => {
  const input = fixture(); input.observations.indoor.value = 18;
  input.settings.occupancy = { mode: 'away', returnAt: iso(now + 48 * HOUR) };
  const modestAuxiliary = decide(input);
  assert.equal(modestAuxiliary.action, 'reduction');
  input.learned.model.energy.auxiliaryKw = 20;
  const highAuxiliary = decide(input);
  assert.equal(highAuxiliary.action, 'normal');
  assert.ok(highAuxiliary.plan.alternatives.find(option => option.reductionHours === 2).costCents > highAuxiliary.plan.baseline.costCents);
  assert.ok(highAuxiliary.plan.alternatives.find(option => option.reductionHours === 24).terminalAuxiliaryKwh > 0);
});

test('away mode prices heat debt rather than treating a low room temperature as occupied comfort debt', () => {
  const input = fixture(); input.observations.indoor.value = 18;
  input.settings.occupancy = { mode: 'away' };
  input.state.lastAction = 'reduction'; input.state.lastDecisionAt = iso(now - HOUR);
  input.state.deficitDegreeHours = 1;
  const result = decide(input);
  assert.ok(result.plan);
  assert.ok(!result.reasons.includes('recovery-deficit'));
  assert.ok(result.nextState.deficitDegreeHours > 1);
  assert.ok(result.nextState.deficitDegreeHours < 2);
  assert.ok(result.plan.chosen.auxiliaryKwh > 0);
  assert.ok(result.plan.alternatives.at(-1).terminalCostCents > 0);
});

test('away dispatch still requires trustworthy data and obeys pause and native protection', () => {
  const cases = [
    ['timed-normal-override', input => { input.override = { mode: 'normal', expiresAt: iso(now + HOUR) }; }],
    ['equipment-fault-native-protection', input => { input.observations.fault = { active: true }; }],
    ['verified-integral-recovery-warning', input => { input.observations.integral = { value: -900, recoveryThreshold: -800, verified: true, observedAt: iso(now) }; }],
    ['missing-or-stale-observations', input => { input.observations.outdoor.observedAt = iso(now - HOUR); }],
    ['unvalidated-heating-energy-model', input => { input.learned.model.energy = null; }],
    ['unvalidated-thermal-model', input => { input.learned.model.validation.accepted = false; }],
    ['stale-thermal-model', input => { input.learned.model.trainedAt = iso(now - 31 * 24 * HOUR); }],
    ['missing-or-incomplete-price-weather-horizon', input => { input.forecast[0].issuedAt = iso(now - 7 * HOUR); }],
    ['invalid-away-return-time', input => { input.settings.occupancy.returnAt = 'invalid'; }],
  ];
  for (const [reason, mutate] of cases) {
    const input = fixture(); input.settings.occupancy = { mode: 'away', returnAt: iso(now + 48 * HOUR) };
    mutate(input);
    const result = decide(input);
    assert.equal(result.action, 'normal', reason);
    assert.equal(result.plan, null, reason);
    assert.ok(result.reasons.includes(reason), reason);
  }
});

test('DHWR local-time boundaries follow Helsinki in winter, summer and DST transitions', () => {
  for (const [date, offset] of [['2026-01-02', '+02:00'], ['2026-07-02', '+03:00'],
    ['2026-03-29', '+03:00'], ['2026-10-25', '+02:00']]) {
    assert.equal(dhwrEligible(`${date}T05:44:00${offset}`, null), false);
    assert.equal(dhwrEligible(`${date}T05:45:00${offset}`, null), true);
    assert.equal(dhwrEligible(`${date}T19:45:00${offset}`, null), true);
    assert.equal(dhwrEligible(`${date}T19:46:00${offset}`, null), false);
    assert.equal(dhwrEligible(`${date}T02:00:00${offset}`, null), false);
  }
});

test('DHWR recency persists independently and exact 52.5 minutes is eligible', () => {
  assert.equal(dhwrEligible(now, now - 52.5 * 60_000), true);
  assert.equal(dhwrEligible(now, now - 52.5 * 60_000 + 1), false);
  assert.equal(dhwrEligible(now, now + HOUR), false);
  assert.equal(dhwrEligible(now, 'corrupt'), false);
  assert.equal(dhwrEligible(now, null, 'reduction'), false);
  const input = fixture(); input.learned = null; input.state.lastDhwrAt = iso(now - HOUR);
  const pulse = decide(input);
  assert.deepEqual(pulse.commands, ['circulation', 'normal']);
  const restarted = { ...fixture(now + HOUR / 4), state: JSON.parse(JSON.stringify(pulse.nextState)), learned: null };
  assert.deepEqual(decide(restarted).commands, ['normal']);
  assert.equal(decide(restarted).nextState.lastDhwrAt, iso(now));
});

test('multi-day simulation varies building assumptions, outage and restart while preserving service rules', () => {
  for (const loss of [0.015, 0.025, 0.035]) {
    let temperature = 21, state = {}, lastPulse = -Infinity;
    for (let tick = 0; tick < 7 * 96; tick++) {
      const at = now + tick * HOUR / 4;
      const input = fixture(at);
      const outdoorC = 3 + 6 * Math.sin(tick / 96 * 2 * Math.PI);
      input.observations.indoor.value = temperature;
      input.observations.outdoor.value = outdoorC;
      input.forecast[0].outdoorC = outdoorC;
      input.state = state;
      if (tick >= 180 && tick < 192) input.observations.indoor = null;
      if (tick === 400) input.state = { ...JSON.parse(JSON.stringify(state)), lastDecisionAt: iso(at - 2 * HOUR) };
      const result = decide(input);
      if (result.dhwr.requested) {
        assert.ok(dhwrEligible(at, finitePulse(lastPulse) ? lastPulse : null));
        assert.ok(at - lastPulse >= 52.5 * 60_000);
        assert.equal(result.action, 'normal'); lastPulse = at;
      }
      if (tick >= 180 && tick < 192) assert.equal(result.action, 'normal');
      const nativeHeat = Math.min(1.2, Math.max(0, loss * (temperature - outdoorC) + (21 - temperature) * 0.5));
      temperature += ((result.action === 'normal' ? nativeHeat : nativeHeat * 0.2) - loss * (temperature - outdoorC)) / 4;
      assert.ok(temperature > 19, `severe cooling at tick ${tick}, loss ${loss}`);
      assert.ok(temperature <= 21.1);
      state = result.nextState;
    }
  }
});
function finitePulse(value) { return Number.isFinite(value); }
