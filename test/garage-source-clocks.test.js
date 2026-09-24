import test from 'node:test';
import assert from 'node:assert/strict';
import { createGarageModel, updateGarageModel, replayGarageModel } from '../src/garage/model.js';
const START = Date.parse('2026-01-01T00:00:00Z'), MINUTE = 60_000, HOUR = 60 * MINUTE;
const settings = { maxSensorAgeMs: 3 * MINUTE };

function experiment({ rearStep = MINUTE, frontStep = 2 * MINUTE, offset = 0, jitter = false, disturb = false, metering = 'zero' } = {}) {
  const seed = createGarageModel({ seedAt: START }), entries = [];
  let model = seed, frontAt = START - offset, nextFront = START + frontStep - offset;
  const temperature = (at, rate) => at <= START + HOUR ? 10 * Math.exp(-rate * (at - START) / HOUR)
    : 10 - (10 - 10 * Math.exp(-rate)) * Math.exp(-(at - START - HOUR) / HOUR);
  for (let at = START; at <= START + 5 * HOUR; at += rearStep) {
    if (at >= nextFront) { frontAt = nextFront; nextFront += frontStep + (jitter ? ((entries.length % 3) - 1) * 5000 : 0); }
    const available = at >= START + HOUR;
    const observation = { at, rearAt: at, frontAt, rearC: temperature(at, .03), frontC: temperature(frontAt, .04),
      outdoorC: 0, available, baselineVerified: true, ev1Kw: 0, ev2Kw: 0,
      powerKw: available ? .5 + .625 / 3 : metering === 'missing' ? null : metering === 'standby' ? .02 : 0,
      powerQuality: metering === 'missing' && !available ? 'missing' : 'verified',
      ...(disturb && at === START + 15 * MINUTE ? { doorFront: true } : {}) };
    entries.push({ observation, settings }); model = updateGarageModel(model, observation, settings);
  }
  return { seed, entries, model };
}

test('independent analytic sensor clocks preserve rates, support, clean episodes and replay', () => {
  for (const options of [{}, { rearStep: 30_000, frontStep: MINUTE }, { offset: 15_000 }, { jitter: true }]) {
    const { seed, entries, model } = experiment(options);
    assert.ok(Math.abs(model.rear.values[0] - .03) < 1e-5);
    assert.ok(Math.abs(model.front.values[0] - .04) < 1e-5);
    assert.ok(model.front.hours > .9 && model.front.hours <= 1.01);
    assert.ok(model.validation.episodes[0]?.complete);
    assert.equal(model.validation.episodes[0].clean, true);
    assert.equal(model.validation.episodes[0].thermalPassed, true);
    assert.deepEqual(replayGarageModel(seed, entries), model);
    const half = Math.floor(entries.length / 2);
    assert.deepEqual(replayGarageModel(JSON.parse(JSON.stringify(replayGarageModel(seed, entries.slice(0, half)))), entries.slice(half)), model);
  }
});

test('a genuine disturbance while awaiting the next front report prevents qualification', () => {
  const { model } = experiment({ disturb: true });
  assert.equal(model.validation.episodes[0].clean, false);
  assert.equal(model.validation.episodes[0].thermalPassed, false);
});

test('complete cycle electrical coverage distinguishes unknown OFF, measured zero and standby', () => {
  const missing = experiment({ metering: 'missing' }).model.validation.episodes[0];
  const zero = experiment({ metering: 'zero' }).model.validation.episodes[0];
  const standby = experiment({ metering: 'standby' }).model.validation.episodes[0];
  assert.equal(missing.thermalPassed, true);
  assert.equal(missing.metered, false); assert.equal(missing.electricalPassed, false);
  assert.equal(zero.metered, true); assert.equal(zero.electricalPassed, true);
  assert.equal(standby.metered, true); assert.ok(standby.observedKwh > zero.observedKwh);
});

test('phase-offset front prediction uses ambient changes on its own supported interval', () => {
  const step = START + 20 * MINUTE;
  const temperature = (at, rate) => at < step ? 10 * Math.exp(-rate * (at - START) / HOUR)
    : -5 + (10 * Math.exp(-rate / 3) + 5) * Math.exp(-rate * (at - step) / HOUR);
  let model = createGarageModel({ seedAt: START }), frontAt = START - 15_000;
  for (let minute = 0; minute <= 60; minute++) {
    const at = START + minute * MINUTE;
    if (minute && minute % 2 === 0) frontAt = at - 15_000;
    model = updateGarageModel(model, { at, rearAt: at, frontAt,
      rearC: temperature(at, .03), frontC: temperature(frontAt, .04), outdoorC: at < step ? 0 : -5,
      available: false, powerKw: 0, powerQuality: 'verified' }, settings);
  }
  assert.ok(Math.abs(model.front.values[0] - .04) < 1e-5);
  assert.equal(model.validation.active.clean, true);
  assert.ok(model.validation.active.offFront.maximum < .002);
});

test('held, out-of-order and missing source clocks do not add front evidence', () => {
  const row = at => ({ at, rearAt: at, frontAt: at, rearC: 10, frontC: 10, outdoorC: 0, available: false });
  let model = updateGarageModel(null, row(START), settings);
  model = updateGarageModel(model, row(START + MINUTE), settings);
  const hours = model.front.hours;
  model = updateGarageModel(model, { ...row(START + 2 * MINUTE), frontAt: START + MINUTE }, settings);
  assert.equal(model.front.hours, hours);
  model = updateGarageModel(model, { ...row(START + 3 * MINUTE), frontAt: START }, settings);
  assert.equal(model.front.hours, hours); assert.equal(model.validation.active.clean, false);
  model = updateGarageModel(model, { ...row(START + 4 * MINUTE), frontAt: null }, settings);
  assert.equal(model.front.hours, hours);
});
