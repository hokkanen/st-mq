import test from 'node:test';
import assert from 'node:assert/strict';
import { garageSettings } from '../src/garage/settings.js';
import { createGarageModel, updateGarageModel, replayGarageModel, predictGarageStep, forecastGarage,
  garageModelSummary, normalGarageTemperature, knownGarageEvAt, garageAssumedEvHeat } from '../src/garage/model.js';
const HOUR = 3_600_000, start = Date.parse('2026-01-01T00:00:00Z');
const settings = garageSettings({ enabled: true, maxSensorAgeMs: 4 * HOUR, protection: { approved: true } });
const observation = (hour, extra = {}) => ({ at: start + hour * HOUR, rearC: 7, frontC: 6.7, outdoorC: 0,
  available: true, baselineVerified: true, powerKw: .3, powerQuality: 'provisional', ev1Kw: 0, ev2Kw: 0, ...extra });
function steady(hours = 48, extra = {}) {
  let model = createGarageModel({ seedAt: start });
  for (let i = 0; i <= hours * 4; i++) model = updateGarageModel(model, observation(i / 4, extra), settings);
  return model;
}

test('two independent cooling coefficients and explicit assumptions replace latent heat and pump heat coefficients', () => {
  const model = createGarageModel(), summary = garageModelSummary(model);
  assert.equal(model.rear.values.length, 1); assert.equal(model.front.values.length, 1);
  assert.deepEqual(summary.structure, { thermalStates: 2, learnedCoolingCoefficients: 2 });
  assert.equal(Object.hasOwn(model.state, 'coreC'), false);
  assert.equal(summary.assumptions.evHeatFraction, .075);
  assert.equal(summary.assumptions.recoveryEnergyFactor, 1.25);
  assert.equal(summary.electricity.basis, 'fixed-power-assumption');
});

test('protection parameters do not retune or reset the learner', () => {
  let normal = createGarageModel({ seedAt: start }), changed = structuredClone(normal);
  for (let i = 0; i < 200; i++) {
    const row = observation(i / 4);
    normal = updateGarageModel(normal, row, settings);
    changed = updateGarageModel(changed, row, { ...settings,
      protection: { ...settings.protection, marginC: 2, heatTransferWPerM2K: 30, pipeOutsideDiameterMm: 25 } });
  }
  assert.deepEqual(changed, normal);
});

test('ordered journal replay exactly reconstructs bounded online learning and rejects old algorithms', () => {
  const seed = createGarageModel({ seedAt: start });
  const entries = Array.from({ length: 400 }, (_, i) => ({ observation: observation(i / 4,
    { frontC: i < 100 ? null : 6.7 }), settings }));
  let live = seed;
  for (const entry of entries) live = updateGarageModel(live, entry.observation, entry.settings);
  assert.deepEqual(replayGarageModel(JSON.parse(JSON.stringify(seed)), entries), live);
  assert.ok(JSON.stringify(live).length < 25_000);
  assert.throws(() => replayGarageModel({ ...seed, algorithm: 'committed-garage-v3-event-doors' }, entries), /Unsupported/);
  assert.throws(() => replayGarageModel(seed, [{ ...entries[0], algorithm: 'old' }]), /Mixed/);
});

test('rear-only OFF history fits rear cooling without fabricating front or normal-reference evidence', () => {
  let model = createGarageModel({ seedAt: start });
  for (let i = 0; i < 20; i++) model = updateGarageModel(model, observation(i / 4,
    { available: false, frontC: null, rearC: 7 * Math.exp(-.03 * i / 4) }), settings);
  assert.ok(model.rear.samples > 10); assert.equal(model.front.samples, 0);
  assert.equal(garageModelSummary(model).heldOut.front.n, 0);
  model = updateGarageModel(model, observation(5, { available: false, frontC: 5 }), settings);
  assert.equal(model.front.samples, 0);
  model = updateGarageModel(model, observation(5.25, { available: false, frontC: 4.96 }), settings);
  assert.ok(model.front.samples > 0);
  assert.equal(steady(48, { frontC: null }).normalReference.initialized, false);
});

test('only fresh, newer OFF temperature reports count, including unchanged values', () => {
  let model = updateGarageModel(null, observation(0, { available: false }), settings);
  model = updateGarageModel(model, observation(.25, { available: false }), settings);
  const trained = model.trainedIntervals;
  model = updateGarageModel(model, observation(.5, { available: false, rearAt: start + .25 * HOUR }), settings);
  assert.equal(model.trainedIntervals, trained);
  model = updateGarageModel(model, observation(.75, { available: false }), settings);
  assert.equal(model.trainedIntervals, trained + 1);
  const retained = updateGarageModel(model, observation(1, { available: false, rearRetained: true }), settings);
  assert.equal(retained.trainedIntervals, model.trainedIntervals);
  const backwards = updateGarageModel(model, observation(.5), settings);
  assert.deepEqual(backwards, model);
});

test('normal heating cannot fit OFF cooling; native electricity remains separately measured', () => {
  const model = steady(96), summary = garageModelSummary(model);
  assert.equal(model.rear.samples, 0); assert.equal(model.front.samples, 0);
  assert.equal(summary.heldOut.offRear.n, 0); assert.equal(summary.heldOut.offFront.n, 0);
  assert.ok(summary.heldOut.native.n > 40);
  assert.equal(summary.ready, false);
  assert.equal(summary.electricity.basis, 'observed-normal-power');
});

test('normal reference accepts the explicit owner assumption and excludes pause, recovery, EV and missing baseline', () => {
  let model = steady(72, { baselineVerified: false, baselineAccepted: true });
  const reference = normalGarageTemperature(model);
  assert.ok(model.normalReference.initialized); assert.ok(Math.abs(reference - 7) < .1);
  for (let i = 289; i < 500; i++) model = updateGarageModel(model, observation(i / 4,
    { rearC: 4, frontC: 3.8, managedPause: i < 350, recovering: i >= 350 }), settings);
  assert.equal(normalGarageTemperature(model), reference);
  for (const extra of [{ baselineVerified: false }, { ev1Kw: 7 }, { ev1Kw: null, evEvidenceRequired: { ev1: true } }])
    assert.equal(steady(48, extra).normalReference.initialized, false);
});

test('local temperatures and cooling rates determine the OFF forecast independently', () => {
  const model = createGarageModel();
  const state = { rearC: 7, frontC: 2, differenceC: -5 };
  const prediction = predictGarageStep(model, state, { outdoorC: -3, available: false }, 1);
  assert.ok(Math.abs(prediction.rearC - (-3 + 10 * Math.exp(-.03))) < 1e-12);
  assert.ok(Math.abs(prediction.frontC - (-3 + 5 * Math.exp(-.04))) < 1e-12);
  const changedRear = predictGarageStep(model, { ...state, rearC: 3 }, { outdoorC: -3, available: false }, 1);
  assert.equal(changedRear.frontC, prediction.frontC);
});

test('activity and charger evidence do not become heat-pump watts or fitted charger heat', () => {
  const model = steady(48, { powerKw: null, activity: true });
  assert.equal(model.native.samples, 0); assert.ok(model.nativeActivity.mean > .95);
  const result = predictGarageStep(model, model.state, { outdoorC: 0, available: true, ev1Kw: 8, ev2Kw: 4 }, .25);
  assert.equal(result.electricityBasis, 'fixed-power-assumption');
  assert.equal(result.electricityKwh, .125);
  assert.deepEqual(result.assumedEvHeat.map(row => row.heatKw), [.6, .3]);
  assert.deepEqual(garageAssumedEvHeat({ ev1Kw: -1, ev2Kw: 100 }).map(row => row.heatKw), [null, null]);
});

test('conditional electricity uses elapsed qualified power without changing temperature or assumed delivered heat', () => {
  const model = steady(), initial = { rearC: 6, frontC: 5.7, differenceC: -.3 };
  const steps = [{ start, end: start + HOUR, outdoorC: 0, available: true, priceCtPerKwh: 10 }];
  const ordinary = forecastGarage(model, { now: start, initial, steps, settings });
  const polluted = forecastGarage(model, { now: start, initial,
    steps: steps.map(row => ({ ...row, powerKw: 8, activity: 1, fan: 5, defrost: true })), settings });
  assert.deepEqual(polluted, ordinary);
  const measured = predictGarageStep(model, initial,
    { outdoorC: 0, available: true, powerKw: 1, powerQuality: 'verified' }, 1, { conditional: true });
  assert.equal(measured.electricityKwh, 1); assert.deepEqual(measured.state, ordinary.state);
  const standby = predictGarageStep(model, initial,
    { outdoorC: 0, available: false, powerKw: .01, powerQuality: 'verified' }, 1, { conditional: true });
  assert.equal(standby.electricityKwh, .01); assert.ok(standby.rearC < initial.rearC);
});

test('known charger plans honor decision time and cancellation but never extend the temperature forecast', () => {
  const plans = [{ charger: 1, start, end: start + HOUR, knownAt: start + 1, powerKw: 8 },
    { charger: 2, start, end: start + HOUR, knownAt: start - 1, powerKw: 8, confidence: 1 }];
  assert.equal(knownGarageEvAt(plans, start, start).ev1Kw, 0);
  assert.equal(knownGarageEvAt(plans, start, start).ev2Kw, 8);
  const model = steady(), steps = [{ start, end: start + HOUR, outdoorC: 0, available: false }];
  const planned = forecastGarage(model, { now: start, steps, knownEvPlans: plans });
  const protectedForecast = forecastGarage(model, { now: start, steps, knownEvPlans: plans, protection: true });
  assert.deepEqual(planned.state, protectedForecast.state);
  assert.equal(planned.points[0].assumedEvHeat[1].heatKw, .6);
  assert.equal(protectedForecast.points[0].assumedEvHeat[1].heatKw, 0);
  assert.equal(knownGarageEvAt([...plans, { ...plans[1], knownAt: start, cancelled: true }], start, start).ev2Kw, 0);
});

test('short door and charger events between temperature reports cannot disappear from learning', () => {
  for (const disturbance of [{ inputDisturbed: true }, { doorFront: true }, { ev1Kw: 6 }, { ev1Kw: 0, ev1Active: true }]) {
    let model = updateGarageModel(null, observation(0, { available: false }), settings);
    model = updateGarageModel(model, observation(.1, { available: false, rearAt: start, ...disturbance }), settings);
    model = updateGarageModel(model, observation(.2, { available: false, rearAt: start }), settings);
    model = updateGarageModel(model, observation(.25, { available: false, rearC: 6.8 }), settings);
    assert.equal(model.rear.samples, 0); assert.equal(model.front.samples, 0);
    assert.equal(model.validation.active.clean, false);
  }
});


test('a journaled runtime disturbance flag excludes an otherwise clean interval and replays exactly', () => {
  const seed = createGarageModel({ seedAt: start });
  const entries = [observation(0, { available: false }), observation(.25, { available: false, rearC: 6.9, inputDisturbed: true })];
  const model = replayGarageModel(seed, entries.map(observation => ({ observation, settings })));
  assert.equal(model.rear.samples, 0); assert.equal(model.front.samples, 0);
  assert.equal(model.validation.active.clean, false);
  let online = seed;
  for (const entry of entries) online = updateGarageModel(online, entry, settings);
  assert.deepEqual(online, model);
});


test('one ordinary release between asynchronous front and rear reports preserves clean episode validation', () => {
  const seed = createGarageModel({ seedAt: start });
  const entries = [
    observation(0, { available: false, powerKw: 0 }),
    observation(.25, { available: false, powerKw: 0, rearC: 6.95, frontC: 6.65 }),
    observation(.26, { available: true, rearAt: start + .25 * HOUR, rearC: 6.95, frontC: 6.65 }),
    observation(.27, { available: true, rearAt: start + .25 * HOUR, rearC: 6.95, frontC: 6.65 }),
    observation(.5, { available: true, rearC: 6.97, frontC: 6.67 }),
    observation(.75, { available: true }),
  ];
  let model = seed;
  for (const row of entries) {
    model = updateGarageModel(model, row, settings);
    if (row.at > start) assert.equal(model.validation.active.clean, true);
  }
  assert.equal(model.validation.active.offEndedAt, start + .5 * HOUR);
  assert.equal(model.rear.samples, 1, 'The interval with an OFF/ON edge cannot fit OFF cooling');
  assert.deepEqual(replayGarageModel(seed, entries.map(observation => ({ observation, settings }))), model);
});

test('a native bounce hidden between rear reports excludes fitting and whole-episode validation', () => {
  for (const initialAvailable of [true, false]) {
    let model = updateGarageModel(null, observation(0, { available: initialAvailable }), settings);
    model = updateGarageModel(model, observation(.1, { available: !initialAvailable, rearAt: start }), settings);
    assert.equal(model.intervalDisturbed, false, 'A single edge alone is ordinary operation');
    model = updateGarageModel(model, observation(.2, { available: initialAvailable, rearAt: start }), settings);
    assert.equal(model.intervalDisturbed, true);
    model = updateGarageModel(model, observation(.25, { available: initialAvailable, rearC: 6.9 }), settings);
    assert.equal(model.rear.samples, 0); assert.equal(model.front.samples, 0);
    assert.equal(model.normalReference.availableSince, null);
    if (!initialAvailable) assert.equal(model.validation.active.clean, false);
  }
  // The second edge can arrive with the new rear measurement itself.
  let model = updateGarageModel(null, observation(0, { available: false }), settings);
  model = updateGarageModel(model, observation(.1, { available: true, rearAt: start }), settings);
  model = updateGarageModel(model, observation(.25, { available: false, rearC: 6.9 }), settings);
  assert.equal(model.rear.samples, 0); assert.equal(model.validation.active.clean, false);
});
