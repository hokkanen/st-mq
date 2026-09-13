import test from 'node:test';
import assert from 'node:assert/strict';
import { garageSettings, garageWarmthPrice } from '../src/garage/settings.js';
import { createGarageExposure, updateGarageExposure, assessGarageProtection } from '../src/garage/protection.js';
import { createGarageModel, updateGarageModel, replayGarageModel, predictGarageStep, forecastGarage,
  garageModelSummary, normalGarageTemperature, knownGarageEvAt } from '../src/garage/model.js';
import { planGarage } from '../src/garage/planner.js';
const HOUR = 3_600_000, MINUTE = 60_000, start = Date.parse('2026-01-01T00:00:00Z');
const settings = garageSettings({ enabled: true, maxSensorAgeMs: 4 * HOUR,
  protection: { approved: true } });
const observation = (i, extra = {}) => ({ at: start + i * HOUR, rearC: 7, frontC: 6.7, outdoorC: 0,
  available: true, baselineVerified: true, powerKw: .3, powerQuality: 'provisional', ev1Kw: 0, ev2Kw: 0, ...extra });
function trainedModel(hours = 96) {
  let model = createGarageModel({ seedAt: start });
  for (let i = 0; i < hours * 4; i++) model = updateGarageModel(model, observation(i / 4), settings);
  return model;
}
function plannerModel() {
  const model = trainedModel();
  model.evidence.offIntervals = 12;
  for (const metrics of Object.values(model.heldOut)) Object.assign(metrics, { n: 30, absolute: 1.5, square: .15, signed: 0 });
  model.rear.values = [.02, .10, .55, .5, .012, .012, .04, .04];
  model.front.values = [.55, .012, .07, .06, 0, 0, 0, 0];
  model.native.values = [.26, .012, .35, .1];
  return model;
}
function outlook(values) {
  return { prices: values.map((value, i) => ({ start: start + i * HOUR, end: start + (i + 1) * HOUR, allInCentsPerKWh: value })),
    forecast: [{ start, end: start + values.length * HOUR, outdoorC: 0, issuedAt: start }] };
}

test('owner policy is explicit, versioned and independent of stable economic preference', () => {
  assert.equal(garageSettings().enabled, false); assert.equal(garageSettings().protection.approved, false);
  assert.throws(() => garageSettings({ aggressiveness: 101 }));
  assert.throws(() => garageSettings({ protection: { hardMinimumC: 5 } }));
  assert.throws(() => garageSettings({ secret: 'unused-test-value' }), /Unknown garage setting/);
  assert.throws(() => garageSettings({ protection: { extra: true } }), /Unknown garage protection/);
  const values = [0, 25, 50, 75, 100].map(garageWarmthPrice);
  assert.ok(values.every((value, i) => i === 0 || value <= values[i - 1]));
  assert.equal(garageWarmthPrice(100), 0);
});

test('alternating cold locations retain independent exposure; warmer front can limit first', () => {
  let state = createGarageExposure(settings);
  state = updateGarageExposure(state, observation(0, { rearC: 5, frontC: 3 }), settings);
  state = updateGarageExposure(state, observation(1, { rearC: 5, frontC: 3 }), settings);
  assert.equal(state.locations.front.degreeMinutes, 60); assert.equal(state.locations.rear.degreeMinutes, 0);
  state = updateGarageExposure(state, observation(2, { rearC: 3, frontC: 5 }), settings);
  assert.equal(state.locations.front.degreeMinutes, 75); assert.equal(state.locations.rear.degreeMinutes, 15);
  const assessment = assessGarageProtection(state, { now: start + 2 * HOUR, observation: observation(2, { rearC: 3.8, frontC: 3.9 }), settings });
  assert.equal(assessment.limitingLocation, 'front');
  assert.equal(assessment.locations.front.degreeMinutes, 75);
  const replayed = JSON.parse(JSON.stringify(state));
  assert.deepEqual(assessGarageProtection(replayed, { now: start + 2 * HOUR, observation: observation(2, { rearC: 3.8, frontC: 3.9 }), settings }), assessment);
});

test('brief warmth and rear recovery cannot erase front debt; policy changes preserve exposure', () => {
  let state = createGarageExposure(settings);
  state = updateGarageExposure(state, observation(0, { frontC: 3 }), settings);
  state = updateGarageExposure(state, observation(1, { frontC: 3 }), settings);
  state = updateGarageExposure(state, observation(1.1, { frontC: 7 }), settings);
  const debt = state.locations.front.degreeMinutes;
  state = updateGarageExposure(state, observation(1.2, { frontC: 7 }), settings);
  assert.equal(state.locations.front.degreeMinutes, debt);
  state = updateGarageExposure(state, observation(1.3, { frontC: 7 }), { ...settings, aggressiveness: 100 });
  assert.equal(state.locations.front.degreeMinutes, debt);
  assert.equal(state.locations.rear.degreeMinutes, 0);
  state = updateGarageExposure(state, observation(2.3, { frontC: 7 }), settings);
  assert.ok(state.locations.front.degreeMinutes < debt && state.locations.front.degreeMinutes > 0);
});

test('stale/missing front stops permission, retains unknown exposure and cannot substitute rear', () => {
  const config = { ...settings, maxSensorAgeMs: 2 * MINUTE };
  let state = updateGarageExposure(null, observation(0), config);
  state = updateGarageExposure(state, observation(1, { frontC: null }), config);
  const assessment = assessGarageProtection(state, { now: start + HOUR, observation: observation(1, { frontC: null, pumpIndoorC: 10 }), settings: config });
  assert.equal(assessment.safeToPause, false); assert.equal(assessment.requiredFresh, false);
  assert.equal(state.locations.front.uncertain, true); assert.ok(state.locations.front.degreeMinutes > 0);
  const recovered = updateGarageExposure(state, observation(1 + 1 / 60), config);
  assert.equal(recovered.locations.front.uncertain, true);
});

test('restoration margin and independent forecast lower bounds trigger the limiting location', () => {
  const state = updateGarageExposure(null, observation(0, { frontC: 3 }), settings);
  const future = [{ at: start + HOUR, rearC: 7, frontC: 3, rearLowerC: 6.5, frontLowerC: 2 }];
  const assessment = assessGarageProtection(state, { now: start, observation: observation(0, { frontC: 3 }), settings,
    forecast: future, restorationDelayMs: HOUR });
  assert.equal(assessment.safeToPause, false); assert.equal(assessment.limitingLocation, 'front');
});

test('ordered replay from saved seed/settings exactly matches online learning and stays bounded', () => {
  const seed = createGarageModel({ seedAt: start });
  const entries = Array.from({ length: 400 }, (_, i) => ({ observation: observation(i / 4, { frontC: i < 100 ? null : 6.7 }), settings }));
  let live = seed;
  for (const entry of entries) live = updateGarageModel(live, entry.observation, entry.settings);
  const rebuilt = replayGarageModel(JSON.parse(JSON.stringify(seed)), entries);
  assert.deepEqual(rebuilt, live);
  assert.ok(JSON.stringify(live).length < 25_000);
  assert.throws(() => replayGarageModel({ ...seed, algorithm: 'old-unsupported' }, entries), /Unsupported/);
});

test('rear-only history is useful without fabricating front evidence when front is commissioned', () => {
  let model = createGarageModel({ seedAt: start });
  for (let i = 0; i < 100; i++) model = updateGarageModel(model, observation(i / 4, { frontC: null }), settings);
  assert.ok(model.rear.samples > 50); assert.equal(model.front.samples, 0);
  assert.equal(garageModelSummary(model).heldOut.front.n, 0);
  const before = model.front.samples;
  model = updateGarageModel(model, observation(25, { frontC: 5 }), settings);
  assert.equal(model.front.samples, before);
  model = updateGarageModel(model, observation(25.25, { frontC: 5.1 }), settings);
  assert.ok(model.front.samples > before);
});

test('only genuinely newer temperature reports count, including identical values', () => {
  let model = updateGarageModel(null, observation(0), settings);
  model = updateGarageModel(model, observation(.25), settings);
  const trained = model.trainedIntervals;
  const repeated = updateGarageModel(model, observation(.5, { rearAt: start + .25 * HOUR }), settings);
  assert.equal(repeated.trainedIntervals, trained);
  const fresh = updateGarageModel(repeated, observation(.75), settings);
  assert.equal(fresh.trainedIntervals, trained + 1);
  const retained = updateGarageModel(fresh, observation(1, { rearRetained: true }), settings);
  assert.equal(retained.trainedIntervals, fresh.trainedIntervals);
});

test('temporally held-out rear/front and advance/native errors are distinct evidence', () => {
  const model = trainedModel();
  const summary = garageModelSummary(model);
  assert.ok(summary.heldOut.rear.n > 40); assert.ok(summary.heldOut.front.n > 40);
  assert.ok(summary.heldOut.advanceRear.rmse >= 0); assert.ok(summary.heldOut.advanceFront.rmse >= 0);
  assert.ok(summary.heldOut.native.n > 40); assert.ok(model.rear.samples < model.updates);
  assert.equal(summary.ready, false, 'No OFF observations means cooling remains unvalidated');
});

test('normal reference learns verified continuous native warmth and cannot absorb pauses or EV warmth', () => {
  let model = trainedModel(72);
  assert.ok(model.normalReference.initialized);
  const reference = normalGarageTemperature(model, 0);
  assert.ok(reference < 7.3 && reference > 6.9);
  for (let i = 288; i < 500; i++) model = updateGarageModel(model, observation(i / 4,
    { rearC: 4, frontC: 3.8, managedPause: i < 350, recovering: i >= 350 }), settings);
  assert.equal(normalGarageTemperature(model, 0), reference);
  const unverified = createGarageModel({ seedAt: start });
  let unknown = unverified;
  for (let i = 0; i < 100; i++) unknown = updateGarageModel(unknown, observation(i, { baselineVerified: false }), settings);
  assert.equal(unknown.normalReference.samples, 0);
  assert.equal(unverified.normalReference.interceptC, 10, 'No invented fixed near-pipe offset');
});

test('front door plunge preserves slow rear memory; thoroughly cold history predicts weaker rebound', () => {
  let warm = trainedModel(48);
  warm = updateGarageModel(warm, observation(48, { frontC: 2 }), settings);
  assert.ok(warm.state.coreC > 6.5); assert.equal(warm.state.frontC, 2);
  const cold = { ...warm, state: { ...warm.state, coreC: 2, rearC: 3, frontC: 2, differenceC: -1 } };
  const a = predictGarageStep(warm, warm.state, { outdoorC: 0, available: false }, 1);
  const b = predictGarageStep(cold, cold.state, { outdoorC: 0, available: false }, 1);
  assert.ok(a.frontC > b.frontC); assert.ok(a.coreC > b.coreC);
});

test('activity-only heating and both EV sources learn effective responses without invented metering', () => {
  let model = createGarageModel({ seedAt: start });
  for (let i = 0; i < 250; i++) model = updateGarageModel(model, observation(i / 4, {
    powerKw: null, activity: i % 4 < 2, ev1Kw: i % 5 < 2 ? 5 : 0,
    ev2Kw: null, ev2Active: i % 7 < 3, frontC: 6.7 + .05 * (i % 4) }), settings);
  assert.equal(model.evidence.powerIntervals, 0); assert.ok(model.evidence.activityIntervals > 100);
  assert.ok(model.evidence.ev[0].powerIntervals > 30); assert.ok(model.evidence.ev[1].activityIntervals > 30);
  assert.equal(model.native.samples, 0);
  const prediction = predictGarageStep(model, model.state, { outdoorC: 0, available: true }, .25);
  assert.equal(prediction.electricityBasis, 'prior-modeled-electricity');
});

test('advance forecasts ignore future actual power, fan and defrost; conditional assessment can use elapsed measured power', () => {
  const model = plannerModel(), initial = { rearC: 7, frontC: 6.7, coreC: 7, differenceC: -.3 };
  const steps = [{ start, end: start + HOUR, outdoorC: 0, available: true, priceCtPerKwh: 10 }];
  const ordinary = forecastGarage(model, { now: start, initial, steps, settings });
  const leaked = forecastGarage(model, { now: start, initial, steps: steps.map(s => ({ ...s, powerKw: 8, activity: 1, fan: 5, defrost: false })), settings });
  assert.deepEqual(leaked.state, ordinary.state); assert.equal(leaked.electricityKwh, ordinary.electricityKwh);
  const measured = predictGarageStep(model, initial, { outdoorC: 0, available: true, powerKw: 1, powerQuality: 'verified' }, 1, { conditional: true });
  assert.equal(measured.electricityKwh, 1);
  assert.ok(measured.rearC > ordinary.state.rearC);
});

test('EV plans use only decision-time knowledge, retain both identities and protection assumes cancellation', () => {
  const plans = [{ charger: 1, start, end: start + HOUR, knownAt: start + 1, powerKw: 8 },
    { charger: 2, start, end: start + HOUR, knownAt: start - 1, active: true, confidence: .5 }];
  assert.equal(knownGarageEvAt(plans, start, start).ev1Kw, 0);
  assert.equal(knownGarageEvAt(plans, start, start).ev2Active, .5);
  const model = plannerModel(), steps = [{ start, end: start + HOUR, outdoorC: 0, available: false }];
  const initial = { rearC: 7, frontC: 6.7, coreC: 7, differenceC: -.3 };
  const planned = forecastGarage(model, { now: start, initial, steps, knownEvPlans: plans, settings });
  const protectedForecast = forecastGarage(model, { now: start, initial, steps, knownEvPlans: plans, protection: true, settings });
  assert.ok(planned.state.rearC > protectedForecast.state.rearC);
});

test('flat prices and aggression zero always preserve normal availability and zero timing benefit', () => {
  const args = { now: start, model: plannerModel(), observation: observation(0), exposure: createGarageExposure(settings), settings, ...outlook(Array(12).fill(12)) };
  const flat = planGarage(args);
  assert.equal(flat.nextAction, 'available'); assert.equal(flat.timingBenefitEur, 0); assert.match(flat.reason, /flat/);
  const disabled = planGarage({ ...args, settings: { ...settings, aggressiveness: 0 }, ...outlook([2, 100, 100, 2, 2, 2]) });
  assert.equal(disabled.nextAction, 'available'); assert.equal(disabled.reason, 'normal-heating-preference');
});

test('planner covers multiple opportunities, retains terminal debt and monotonic warmth preference', () => {
  const args = { now: start, model: plannerModel(), observation: observation(0), exposure: createGarageExposure(settings),
    ...outlook([5, 5, 35, 35, 5, 5, 5, 5, 5, 90, 90, 90, 5, 5, 5, 5]) };
  const results = [25, 50, 75, 100].map(aggressiveness => planGarage({ ...args, settings: { ...settings, aggressiveness } }));
  assert.ok(results.some(result => result.timingBenefitEur > 0));
  assert.ok(results.at(-1).steps.some(step => step.phase === 'pause'));
  assert.ok(results.at(-1).steps.some(step => step.phase === 'recovery'));
  assert.ok(results.at(-1).heatDebt.effectiveKwh >= 0);
  assert.ok(results.at(-1).uncertainty.terminalPriceEurPerKwh >= .9);
  for (let i = 1; i < results.length; i++) assert.ok((results[i].coolingDegreeHours ?? 0) + 1e-8 >= (results[i - 1].coolingDegreeHours ?? 0));
});

test('planner never pauses with one protection sensor even when rear-only monitoring is configured', () => {
  const result = planGarage({ now: start, model: plannerModel(), observation: observation(0, { frontC: null }), settings,
    ...outlook([100, 100, 1, 1, 1, 1]) });
  assert.equal(result.nextAction, 'available'); assert.match(result.reason, /front/);
});

test('native OFF still records qualified observed standby electricity without treating it as delivered heat', () => {
  const model = createGarageModel({ seedAt: start });
  const state = { rearC: 7, frontC: 6.7, coreC: 7, differenceC: -.3 };
  const predicted = predictGarageStep(model, state, { available: false, outdoorC: 0, powerKw: .01, powerQuality: 'verified' }, 1, { conditional: true });
  assert.ok(Math.abs(predicted.electricityKwh - .01) < 1e-10);
  assert.ok(predicted.rearC < 7);
});

test('rich independent synthetic thermal evidence changes bounded coefficients and validates OFF on later blocks', () => {
  const truth = createGarageModel({ seedAt: start });
  truth.rear.values[0] = .035; truth.rear.values[2] = .9;
  truth.rear.values[4] = .03; truth.rear.values[5] = .05;
  let actual = { rearC: 7, frontC: 6.7, coreC: 8, differenceC: -.3 };
  let model = createGarageModel({ seedAt: start });
  const configs = { ...settings, baselineC: 10 };
  const samples = [];
  for (let i = 0; i < 14 * 96; i++) {
    const hour = i / 4, available = i % 32 < 24, outdoorC = 2 + 6 * Math.sin(hour / 21);
    const powerKw = available ? [.3, .6, .9, .45][Math.floor(i / 16) % 4] : 0;
    const ev1Kw = i % 40 < 8 ? 6 : 0, ev2Kw = i % 40 >= 20 && i % 40 < 28 ? 8 : 0;
    const input = { outdoorC, available, powerKw, powerQuality: 'verified', ev1Kw, ev2Kw };
    const row = observation(hour, { ...input, rearC: actual.rearC, frontC: actual.frontC });
    samples.push({ observation: row, settings: configs });
    model = updateGarageModel(model, row, configs);
    actual = predictGarageStep(truth, actual, input, .25, { conditional: true }).state;
  }
  const summary = garageModelSummary(model);
  assert.ok(model.rear.values[0] > .026 && model.rear.values[0] < .06);
  assert.ok(model.rear.values[2] > .65 && model.rear.values[2] < 1.1);
  assert.ok(summary.heldOut.offRear.n >= 12 && summary.heldOut.offFront.n >= 12);
  assert.ok(summary.heldOut.offRear.rmse < .15 && summary.heldOut.offFront.rmse < .2);
  assert.ok(model.evidence.ev.every(ev => ev.independentIntervals >= 24));
  assert.deepEqual(replayGarageModel(createGarageModel({ seedAt: start }), samples), model);
});

test('48 hour plan uses ordinary peaks, reserves preparation and never credits unknown cheap terminal recovery', () => {
  const model = plannerModel(), values = Array.from({ length: 48 }, (_, i) => i % 24 >= 17 && i % 24 <= 20 ? 40 : 7);
  const result = planGarage({ now: start, model, settings: { ...settings, aggressiveness: 75 }, observation: observation(0), ...outlook(values) });
  assert.equal(result.reason, 'prepare-for-later-price-opportunity');
  assert.equal(result.steps.length, 192);
  assert.ok(result.timingBenefitEur > .05);
  assert.equal(result.steps[0].phase, 'preparation');
  assert.ok(result.steps.some(step => step.start >= start + 24 * HOUR && step.phase === 'pause'));
  assert.ok(result.uncertainty.terminalPriceEurPerKwh >= .4);
});

test('same-episode renewals remain bounded by their original authorization endpoint', () => {
  const endpoint = start + HOUR;
  const result = planGarage({ now: start, model: plannerModel(), settings: { ...settings, aggressiveness: 100 },
    observation: observation(0, { available: false, availableChangedAt: start - HOUR }),
    activeEpisode: { state: 'active', authorizedEndAt: endpoint }, ...outlook([60, 60, 5, 5, 5, 5, 5, 5]) });
  assert.equal(result.nextAction, 'renew'); assert.ok(result.pauseUntil <= endpoint);
  assert.ok(result.steps.filter(step => step.available === false).every(step => step.end <= endpoint));
});

test('later opportunities retain frozen host debt while scoring only incremental future choices', () => {
  const model = plannerModel();
  model.state = { rearC: 6.5, frontC: 6.2, coreC: 6.6, differenceC: -.3 };
  const args = { now: start, model, observation: observation(0, { rearC: 6.5, frontC: 6.2 }),
    settings: { ...settings, aggressiveness: 100 }, ...outlook([65, 65, 5, 5, 5, 5, 5, 5]) };
  const continuation = planGarage(args);
  const outstanding = planGarage({ ...args, referenceInitialState: { rearC: 7, frontC: 6.7, coreC: 7, differenceC: -.3 } });
  assert.equal(outstanding.nextAction, 'pause');
  assert.equal(outstanding.obligationReference.basis, 'frozen-host-normal-reference');
  assert.ok(outstanding.heatDebt.coreC > continuation.heatDebt.coreC);
  assert.ok(outstanding.continuationDebt.effectiveKwh > 0);
  assert.ok(outstanding.timingBenefitEur > 0, 'Existing recovery debt must not be charged as the new opportunity entry cost');
  assert.ok(outstanding.heatDebt.effectiveKwh >= outstanding.continuationDebt.effectiveKwh);
});
