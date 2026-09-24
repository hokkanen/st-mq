import test from 'node:test';
import assert from 'node:assert/strict';
import { createGarageModel, updateGarageModel, replayGarageModel, garageModelSummary, predictGarageStep,
  forecastGarage, predictGarageNative, GARAGE_ALGORITHM_VERSION } from '../src/garage/model.js';
import { createGarageRegression, fitGarageRegression } from '../src/garage/model-fit.js';
import { createPlant, plantInputs, stepPlant, observedPlant, randomSource, AUDIT_START, HOUR } from './helpers/garage-plant.js';
const settings = { maxSensorAgeMs: 4 * HOUR };
const row = (hour, extra = {}) => ({ at: AUDIT_START + hour * HOUR, rearC: 7, frontC: 6.7, outdoorC: 0,
  available: true, baselineVerified: true, powerKw: .3, powerQuality: 'verified', ev1Kw: 0, ev2Kw: 0, ...extra });
function steady(cadenceMinutes, hours = 48) {
  let model = createGarageModel({ seedAt: AUDIT_START });
  for (let minute = 0; minute <= hours * 60; minute += cadenceMinutes)
    model = updateGarageModel(model, row(minute / 60), settings);
  return model;
}
function experiment({ cadenceMinutes = 5, days = 8, offHours = .5, activityOnly = false, door = false } = {}) {
  const plant = createPlant({ activityOnly }), random = randomSource(41), entries = [];
  let model = createGarageModel({ seedAt: AUDIT_START });
  for (let minute = 0; minute <= days * 1440; minute++) {
    const hour = minute / 60;
    const available = hour < 40 || (hour - 40) % 40 >= offHours;
    const input = { ...plantInputs(plant, hour, { available }), available };
    if (minute % cadenceMinutes === 0) {
      const observation = observedPlant(plant, hour, input, random);
      if (door && !available) observation.doorFront = true;
      entries.push({ observation, settings });
      model = updateGarageModel(model, observation, settings);
    }
    if (minute < days * 1440) stepPlant(plant, input);
  }
  return { model, entries };
}

test('simple OFF learning has an explicit epoch and refuse previous learning semantics', () => {
  assert.equal(GARAGE_ALGORITHM_VERSION, 'committed-garage-v6-source-clocks');
  assert.throws(() => updateGarageModel({ ...createGarageModel(), algorithm: 'committed-garage-v4-simple-off' }, row(1)), /Unsupported/);
  assert.throws(() => updateGarageModel({ ...createGarageModel(), algorithm: 'committed-garage-v3-event-doors' }, row(1)), /Unsupported/);
  assert.throws(() => updateGarageModel({ ...createGarageModel(), algorithm: 'committed-garage-v1-coupled' }, row(1)), /Unsupported/);
  assert.throws(() => updateGarageModel({ ...createGarageModel(), algorithm: 'committed-garage-v2-sparse' }, row(1)), /Unsupported/);
});

test('an adapter source epoch interrupts intervals without erasing learned cooling or completed evidence', () => {
  let model = updateGarageModel(null, row(0, { sourceEpoch: 'adapter-boot-one' }), settings);
  model.rear.values[0] = .035;
  model.validation.episodes = [{ id: 0, complete: true, clean: true, offHours: 2 }];
  const after = updateGarageModel(model, row(.1, { sourceEpoch: 'adapter-boot-two', rearC: 6 }), settings);
  assert.equal(after.rear.values[0], .035);
  assert.equal(Object.hasOwn(after.state, 'coreC'), false);
  assert.equal(after.state.rearC, 6);
  assert.deepEqual(after.validation.episodes, model.validation.episodes);
  assert.equal(after.rear.samples, model.rear.samples, 'No fit crosses the boot boundary');
});

test('thousands of thermostat rows cannot fit OFF cooling or fabricate additional coefficients', () => {
  const model = steady(1), summary = garageModelSummary(model);
  assert.deepEqual(model.rear.values, [.03]); assert.deepEqual(model.front.values, [.04]);
  assert.deepEqual(model.rear.active, [false]); assert.deepEqual(model.front.active, [false]);
  assert.equal(summary.ready, false); assert.equal(summary.validatedOffHours, 0);
  assert.equal(summary.coefficients.rear[0].basis, 'fixed-prior');
  assert.equal(summary.coefficients.front[0].basis, 'fixed-prior');
  assert.equal(summary.coefficients.native.length, 1);
});

test('reference and native learning depend on elapsed duration rather than row count', () => {
  const minute = steady(1), quarter = steady(15);
  assert.equal(minute.normalReference.initialized, true); assert.equal(quarter.normalReference.initialized, true);
  assert.ok(Math.abs(minute.normalReference.interceptC - quarter.normalReference.interceptC) < .015);
  assert.ok(Math.abs(minute.native.values[0] - quarter.native.values[0]) < .015);
  assert.ok(minute.native.samples > quarter.native.samples * 10);
  assert.equal(minute.native.values.length, 1, 'Normal power is one duration-weighted observed mean');
});

test('a single twenty-minute episode crossing the old daily split never validates itself', () => {
  let model = steady(1, 17);
  for (let minute = 17 * 60 + 1; minute <= 22 * 60; minute++) {
    const available = minute < 17 * 60 + 50 || minute >= 18 * 60 + 10;
    model = updateGarageModel(model, row(minute / 60, { available, powerKw: available ? .3 : 0 }), settings);
  }
  const summary = garageModelSummary(model);
  assert.equal(summary.validation.trainingEpisodes, 1);
  assert.equal(summary.validation.validationEpisodes, 0);
  assert.equal(summary.heldOut.offRear.n, 0);
  assert.ok(Math.abs(model.validation.episodes[0].offHours - 1 / 3) < 1e-8);
  assert.equal(summary.ready, false); assert.equal(summary.electricalReady, false);
});

test('whole later episodes record validated duration evidence with exact deterministic replay', () => {
  const { model, entries } = experiment(), summary = garageModelSummary(model);
  assert.ok(summary.validation.trainingEpisodes >= 2);
  assert.ok(summary.validation.validationEpisodes >= 1);
  assert.equal(summary.thermalReady, true);
  assert.ok(summary.validatedOffHours > .49 && summary.validatedOffHours < .51);
  assert.deepEqual(model.validation.episodes.slice(0, 3).map(e => e.role), ['training', 'training', 'validation']);
  assert.deepEqual(replayGarageModel(createGarageModel({ seedAt: AUDIT_START }), entries), model);
  assert.ok(JSON.stringify(model).length < 32_000);
});

test('door-disturbed observations remain physical state but cannot establish validated duration evidence', () => {
  const { model } = experiment({ door: true });
  assert.ok(model.validation.episodes.length >= 3);
  assert.ok(model.validation.episodes.every(e => !e.clean));
  assert.equal(garageModelSummary(model).thermalReady, false);
  assert.equal(garageModelSummary(model).validatedOffHours, 0);
});

test('thermal observations without electrical measurements never qualify economic electricity', () => {
  const { model } = experiment({ activityOnly: true, offHours: 2 });
  const summary = garageModelSummary(model);
  assert.ok(model.evidence.activityHours > 0); assert.equal(model.native.samples, 0);
  assert.equal(summary.electricalReady, false);
  assert.ok(model.validation.episodes.every(e => !e.electricalPassed));
});

test('a clean later failed rollout revokes older thermal and energy validation', () => {
  const { model } = experiment();
  assert.equal(garageModelSummary(model).thermalReady, true);
  const latest = model.validation.episodes.at(-1);
  model.validation.episodes.push({ ...latest, id: latest.id + 1, role: 'validation', complete: true,
    clean: true, metered: true, thermalPassed: false, electricalPassed: false, rearRmse: 2, frontRmse: 2 });
  const summary = garageModelSummary(model);
  assert.equal(summary.thermalReady, false); assert.equal(summary.electricalReady, false); assert.equal(summary.validatedOffHours, 0);
});

test('an episode freezes its coefficients and advance state before later observations arrive', () => {
  const { model: prepared } = experiment({ days: 2 });
  let model = prepared;
  for (let i = 0; i <= 4; i++) model = updateGarageModel(model, row(80 + i / 12, { available: false, powerKw: 0 }), settings);
  const active = model.validation.active;
  assert.ok(active);
  const frozen = structuredClone(active.forecast);
  const expected = predictGarageStep(active.forecast, active.state, { available: false, outdoorC: 0, ev1Kw: 0, ev2Kw: 0 }, 1 / 12);
  model = updateGarageModel(model, row(80 + 5 / 12, { available: false, rearC: 5, frontC: 4.7,
    powerKw: 7, fan: 5, defrost: true }), settings);
  assert.deepEqual(model.validation.active.forecast, frozen);
  assert.deepEqual(model.validation.active.state, expected.state);
  assert.notEqual(model.validation.active.state.rearC, model.state.rearC);
});

test('routine heating cannot age retained OFF sufficient statistics', () => {
  const { model: original } = experiment({ days: 3 });
  const retained = structuredClone(original.rear.statistics.off);
  let model = original;
  for (let i = 1; i <= 4 * 48; i++) model = updateGarageModel(model, row(72 + i / 4), settings);
  assert.deepEqual(model.rear.statistics.off, retained);
});

test('duration weighting retains rare OFF evidence and bounds an ill-conditioned fit', () => {
  const specs = [['coolingPerHour', .03, .001, .3]];
  const minute = createGarageRegression(specs), quarter = createGarageRegression(specs);
  for (let i = 0; i < 120; i++) fitGarageRegression(minute, specs, [-10], -.35, 1 / 60);
  for (let i = 0; i < 8; i++) fitGarageRegression(quarter, specs, [-10], -.35, .25);
  assert.ok(Math.abs(minute.values[0] - quarter.values[0]) < 1e-12);
  assert.ok(Math.abs(quarter.values[0] - .035) < .001);
  const before = structuredClone(quarter);
  for (let i = 0; i < 1000; i++) fitGarageRegression(quarter, specs, [-10], 1, .25, 'normal');
  assert.deepEqual(quarter, before);
  fitGarageRegression(quarter, specs, [.01], 5, 1);
  assert.deepEqual(quarter, before, 'Tiny outdoor difference carries no cooling information');
  fitGarageRegression(quarter, specs, [-10], -100, 1);
  assert.equal(quarter.values[0], .3);
});

test('advance forecast margins continue growing beyond six hours without future-input leakage', () => {
  const model = steady(15), steps = Array.from({ length: 12 }, (_, i) => ({ start: model.at + i * HOUR,
    end: model.at + (i + 1) * HOUR, outdoorC: -10, available: false }));
  const result = forecastGarage(model, { now: model.at, steps, settings });
  const polluted = forecastGarage(model, { now: model.at, steps: steps.map(s => ({ ...s, powerKw: 8, activity: 1, fan: 5 })), settings });
  assert.deepEqual(result, polluted);
  const margin = i => result.points[i].rearC - result.points[i].rearLowerC;
  assert.ok(margin(11) > margin(5));
});


test('observed boolean activity predicts dimensionless duty independently of modeled watts', () => {
  let model = createGarageModel({ seedAt: AUDIT_START });
  for (let i = 0; i <= 48 * 12; i++) model = updateGarageModel(model,
    row(i / 12, { powerKw: null, activity: true }), settings);
  assert.ok(model.nativeActivity.hours > 12); assert.ok(model.nativeActivity.mean > .95);
  assert.equal(model.native.samples, 0);
  const ordinary = predictGarageNative(model, model.state, { outdoorC: 0, available: true });
  const changedElectricalPrior = structuredClone(model);
  changedElectricalPrior.native.values[0] = 1.5;
  changedElectricalPrior.native.active[0] = true;
  const changed = predictGarageNative(changedElectricalPrior, model.state, { outdoorC: 0, available: true });
  assert.equal(ordinary.activity, changed.activity); assert.ok(ordinary.activity > .95);
  assert.notEqual(ordinary.powerKw, changed.powerKw);
  assert.equal(garageModelSummary(model).electricalReady, false);
});

test('a long continuously observed OFF period stays one frozen episode beyond 48 hours', () => {
  let model = steady(15, 24);
  for (let i = 1; i <= 55 * 4; i++) model = updateGarageModel(model,
    row(24 + i / 4, { available: false, powerKw: 0 }), settings);
  assert.equal(model.validation.nextId, 1);
  assert.equal(model.validation.episodes.length, 0);
  assert.ok(model.validation.active.offHours > 54);
  assert.equal(model.validation.active.offEndedAt, null);
  assert.equal(garageModelSummary(model).ready, false);
});

test('a 60-hour holdout stays frozen through 75 hours of recovery with bounded state and exact replay', () => {
  const seed = createGarageModel({ seedAt: AUDIT_START });
  seed.validation.nextId = 2;
  const entries = [];
  let model = seed, frozen, activeBytes;
  for (let i = 0; i <= 135 * 4; i++) {
    const hours = i / 4;
    const observation = row(hours, { outdoorC: 7, available: hours >= 60, powerKw: hours >= 60 ? .6 : 0 });
    entries.push({ observation, settings });
    model = updateGarageModel(model, observation, settings);
    if (hours === 1) frozen = structuredClone(model.validation.active.forecast);
    if (hours === 20) activeBytes = JSON.stringify(model).length;
    if (hours === 60 || hours === 72 || hours === 134.75) {
      assert.equal(model.validation.nextId, 3);
      assert.equal(model.validation.episodes.length, 0, 'No OFF or recovery duration truncates the experiment');
      assert.equal(model.validation.active.role, 'validation');
      assert.deepEqual(model.validation.active.forecast, frozen);
      assert.equal(model.rear.samples, 0, 'Held-out evidence never leaks into cooling fitting');
      assert.ok(JSON.stringify(model).length < activeBytes + 1000, 'The live experiment stores sufficient statistics, not a growing trajectory');
    }
  }
  assert.equal(model.validation.active, null);
  assert.equal(model.validation.episodes.length, 1);
  assert.equal(model.validation.episodes[0].offHours, 60);
  assert.equal(model.validation.episodes[0].recoveryHours, 75);
  assert.equal(model.validation.episodes[0].complete, true);
  assert.deepEqual(replayGarageModel(seed, entries), model);
});

test('failed short-pause recovery times out only after observed normal heating', () => {
  let model = createGarageModel({ seedAt: AUDIT_START });
  for (let i = 0; i <= 13 * 4; i++) {
    const hours = i / 4;
    model = updateGarageModel(model, row(hours, { available: hours >= 1,
      rearC: hours ? 6.8 : 7, frontC: hours ? 6.5 : 6.7 }), settings);
    if (hours === 4) {
      assert.ok(model.validation.active);
      assert.equal(model.validation.episodes.length, 0);
    }
  }
  assert.equal(model.validation.active, null);
  assert.equal(model.validation.episodes.length, 1);
  assert.equal(model.validation.episodes[0].complete, false);
  assert.equal(model.validation.episodes[0].recoveryHours, 12);
});

test('adapter source-clock boundaries preserve completed rare episodes without fitting across reboot', () => {
  const { model } = experiment();
  const completed = structuredClone(model.validation.episodes);
  model.sourceEpoch = 'adapter-boot-a';
  const next = updateGarageModel(model, row((model.at - AUDIT_START) / HOUR + .25, { sourceEpoch: 'adapter-boot-b' }), settings);
  assert.deepEqual(next.validation.episodes, completed);
  assert.equal(next.trainedIntervals, model.trainedIntervals);
});
