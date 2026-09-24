import test from 'node:test';
import assert from 'node:assert/strict';
import { garageSettings, GARAGE_POLICY_VERSION, GARAGE_HEAT_TRANSFER_SAFETY_FACTOR } from '../src/garage/settings.js';
import { reserveProperties, createGarageExposure, updateGarageExposure, reconcileGarageExposure,
  projectGarageExposure, projectCurrentGarageExposure, assessGarageProtection, validGarageExposure, garageSensorStatus } from '../src/garage/protection.js';
import { knownGarageReserve } from './helpers/garage-reserve-fixture.js';

const MINUTE = 60_000, START = Date.UTC(2026, 8, 15), settings = garageSettings({ protection: { approved: true } });
const props = reserveProperties(settings);
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} differs from ${expected}`);
const observation = (minute, rearC = 6, frontC = rearC) => ({ at: START + minute * MINUTE,
  rearAt: START + minute * MINUTE, frontAt: START + minute * MINUTE, rearC, frontC });
const seed = (rearC = 6, rearAirC = rearC, frontC = 6) => knownGarageReserve(settings,
  { at: START, rearC, rearAirC, frontC, frontAirC: frontC });

test('material geometry determines the reserve and both conductances from one fixed factor', () => {
  near(props.capacityJPerMK, 1401.8948809599488);
  near(props.waterKgPerM, 0.2835287369864789);
  near(props.coolingTimeConstantMinutes, 8.853908730158732);
  near(props.warmingTimeConstantMinutes, 35.41563492063493);
  assert.equal(GARAGE_HEAT_TRANSFER_SAFETY_FACTOR, 2);
  const assessment = assessGarageProtection(seed(), { now: START, observation: observation(0), settings });
  near(assessment.locations.rear.remainingKjPerM, props.capacityJPerMK * 5 / 1000);
  assert.equal(assessment.safeToPause, true);
  assert.equal(Object.hasOwn(assessment.locations.rear, 'remainingDegreeMinutes'), false);
});

test('a warm one-minute door pulse spends continuous reserve without an air-temperature veto', () => {
  const before = seed(6, -25), original = structuredClone(before);
  const next = updateGarageExposure(before, observation(1, -25, 6), settings);
  const expected = -25 + 31 * Math.exp(-1 / props.coolingTimeConstantMinutes);
  near(next.locations.rear.estimatedC, expected);
  near(next.locations.front.estimatedC, 6);
  assert.ok(expected > 1);
  const check = assessGarageProtection(next, { now: next.at, observation: observation(1, -25, 6), settings });
  assert.equal(check.safeToPause, true);
  assert.ok(check.interventionAt > next.at);
  assert.deepEqual(before, original);
  const soaked = updateGarageExposure(seed(1.1, -25), observation(1, -25, 6), settings);
  assert.equal(assessGarageProtection(soaked, { now: soaked.at, observation: observation(1, -25, 6), settings }).safeToPause, false);
});

test('reserve remembers cooling above 1C and cannot accumulate unlimited warm credit', () => {
  let state = seed(6, 1.1);
  for (let minute = 1; minute <= 120; minute++) state = updateGarageExposure(state, observation(minute, 1.1, 6), settings);
  assert.ok(state.locations.rear.estimatedC < 1.101);
  assert.ok(state.locations.rear.estimatedC > 1.1);
  let warmed = seed(1, 6);
  for (let minute = 1; minute <= 240; minute++) warmed = updateGarageExposure(warmed, observation(minute), settings);
  assert.ok(warmed.locations.rear.estimatedC < 6);
  assert.ok(warmed.locations.rear.estimatedC > 5.99);
});

test('real warmth replenishes immediately at its physical rate without a dwell', () => {
  const mild = updateGarageExposure(seed(1, 4), observation(1, 4, 6), settings);
  const warm = updateGarageExposure(seed(1, 10), observation(1, 10, 6), settings);
  near(mild.locations.rear.estimatedC, 4 - 3 * Math.exp(-1 / props.warmingTimeConstantMinutes));
  near(warm.locations.rear.estimatedC, 10 - 9 * Math.exp(-1 / props.warmingTimeConstantMinutes));
  assert.ok(mild.locations.rear.energyJPerM > props.capacityJPerMK);
  near(warm.locations.rear.estimatedC - 1, 3 * (mild.locations.rear.estimatedC - 1));
});

test('cached ticks cannot earn warmth, refresh clocks or hide the exact source deadline', () => {
  const before = seed(1, 10);
  let state = before;
  for (const seconds of [30, 60, 90]) state = updateGarageExposure(state,
    { ...observation(0, 10, 6), at: START + seconds * 1000 }, settings);
  near(state.locations.rear.energyJPerM, before.locations.rear.energyJPerM);
  assert.equal(state.locations.rear.lastAt, START);
  assert.equal(state.locations.rear.stateAt, START);
  const assessed = assessGarageProtection(state, { now: START + 90_000, observation: observation(0, 10, 6), settings });
  near(assessed.locations.rear.remainingKjPerM, 0);
  assert.equal(garageSensorStatus(observation(0), 'rear', START + 120_000, settings).usable, false);
  assert.equal(garageSensorStatus({ ...observation(0), rearAt: null }, 'rear', START, settings).usable, false);
  assert.equal(garageSensorStatus({ ...observation(0), rearRetained: true }, 'rear', START, settings).usable, false);
});

test('fresh cached cold readings can reduce the provisional assessment without mutating measured energy', () => {
  const before = seed(6, -25), original = structuredClone(before);
  const assessed = assessGarageProtection(before, { now: START + 60_000, observation: observation(0, -25, 6), settings });
  near(assessed.locations.rear.estimatedC, -25 + 31 * Math.exp(-1 / props.coolingTimeConstantMinutes));
  assert.deepEqual(before, original);
});

test('planning anchors cached history before the future and cannot interpolate forecast warmth into the past', () => {
  const before = seed(6, 0), original = structuredClone(before), now = START + 90_000;
  const current = projectCurrentGarageExposure(before, observation(0, 0, 6), now, settings);
  const heldTemperature = 6 * Math.exp(-1.5 / props.coolingTimeConstantMinutes);
  near(current.locations.rear.estimatedC, heldTemperature);
  assert.equal(current.locations.rear.lastAt, START);
  assert.equal(current.locations.rear.stateAt, now);
  const boundary = knownGarageReserve(settings, { at: now, rearC: heldTemperature, rearAirC: 0, frontC: 6 });
  const future = { at: now + 15 * MINUTE, rearC: 6, frontC: 6 };
  const expected = projectGarageExposure(boundary, future, settings);
  const actual = projectGarageExposure(current, future, settings);
  near(actual.exposure.locations.rear.energyJPerM, expected.exposure.locations.rear.energyJPerM);
  assert.deepEqual(before, original);
  const warm = projectCurrentGarageExposure(seed(1.05, 6), observation(0, 6, 6), now, settings);
  near(warm.locations.rear.estimatedC, 1.05);
  assert.equal(warm.locations.rear.lastAt, START);
});

test('a short report gap debits elapsed cooling rather than resetting to fully frozen', () => {
  const before = seed();
  const state = updateGarageExposure(before, { ...observation(3), outdoorC: -5, outdoorAt: START }, settings);
  near(state.locations.rear.estimatedC, -5 + 11 * Math.exp(-3 / props.coolingTimeConstantMinutes));
  assert.ok(state.locations.rear.energyJPerM > 0);
  assert.equal(state.locations.rear.uncertain, true);
  near(state.locations.rear.unknownMinutes, 3);
  const recovered = updateGarageExposure(state, observation(4), settings);
  assert.equal(recovered.locations.rear.uncertain, false);
  assert.ok(recovered.locations.rear.energyJPerM > state.locations.rear.energyJPerM);
});

test('warm return endpoints cannot erase possible freezing during an unobserved overnight gap', () => {
  const before = seed(), returned = { ...observation(12 * 60), outdoorC: 6, outdoorAt: START + 12 * 60 * MINUTE };
  const state = updateGarageExposure(before, returned, settings);
  assert.ok(state.locations.rear.energyJPerM < -props.latentJPerM);
  assert.equal(state.locations.rear.uncertain, true);
  const next = updateGarageExposure(state, observation(12 * 60 + 1), settings);
  assert.ok(next.locations.rear.energyJPerM < 0);
  assert.equal(next.locations.rear.uncertain, true);
  assert.equal(assessGarageProtection(next, { now: next.at, observation: observation(12 * 60 + 1), settings }).safeToPause, false);
});

test('unknown outdoor history uses the cold bound and repeated missing ticks charge elapsed time only once', () => {
  const before = seed();
  const one = updateGarageExposure(before, { ...observation(0), at: START + 3 * MINUTE }, settings);
  const next = updateGarageExposure(one, { ...observation(0), at: START + 4 * MINUTE }, settings);
  const direct = updateGarageExposure(before, { ...observation(0), at: START + 4 * MINUTE }, settings);
  near(next.locations.rear.energyJPerM, direct.locations.rear.energyJPerM);
  assert.ok(next.locations.rear.energyJPerM < 0);
  near(next.locations.rear.unknownMinutes, 4);
  const returned = updateGarageExposure(next, observation(5, 10), settings);
  assert.equal(returned.locations.rear.uncertain, true);
  assert.ok(returned.locations.rear.energyJPerM <= next.locations.rear.energyJPerM);
});

test('possible ice is debt only and must melt before genuine warm reports restore usable reserve', () => {
  let state = seed(0, 10);
  for (const row of Object.values(state.locations)) {
    row.energyJPerM = -props.latentJPerM / 10; row.estimatedC = 0;
    row.lastC = 10; row.uncertain = true; row.uncertaintyReason = 'exposure-history-uncertain';
  }
  for (let minute = 1; minute <= 20; minute++) state = updateGarageExposure(state, observation(minute, 10), settings);
  assert.equal(state.locations.rear.estimatedC, 0);
  assert.equal(state.locations.rear.uncertain, true);
  assert.equal(assessGarageProtection(state, { now: state.at, observation: observation(20, 10), settings }).safeToPause, false);
  for (let minute = 21; minute <= 30; minute++) state = updateGarageExposure(state, observation(minute, 10), settings);
  assert.ok(state.locations.rear.estimatedC > 1);
  assert.equal(state.locations.rear.uncertain, false);
  assert.equal(assessGarageProtection(state, { now: state.at, observation: observation(30, 10), settings }).safeToPause, true);
});

test('unknown initialization recovers automatically through measured energy without inventing a liquid pipe', () => {
  let state = updateGarageExposure(null, observation(0, 10), settings);
  assert.equal(state.locations.rear.uncertaintyReason, 'initializing-reserve');
  assert.equal(state.locations.rear.estimatedC, -40);
  for (let minute = 1; minute <= 200; minute++) state = updateGarageExposure(state, observation(minute, 10), settings);
  assert.equal(state.locations.rear.uncertain, true);
  for (let minute = 201; minute <= 300; minute++) state = updateGarageExposure(state, observation(minute, 10), settings);
  assert.equal(state.locations.rear.uncertain, false);
  assert.ok(state.locations.rear.estimatedC > 1);
  assert.equal(validGarageExposure(state, state.at, settings), true);
});

test('linear-path projection is cadence independent across cooling, melting and warming reversals', () => {
  const initial = seed(2, -25), original = structuredClone(initial), outputs = [];
  for (const cadence of [0.5, 1, 5, 15, 30]) {
    let state = initial, first = null;
    for (let minute = cadence; minute <= 30; minute += cadence) {
      const next = projectGarageExposure(state, { at: START + minute * MINUTE, rearC: -25 + 80 * minute / 30, frontC: 6 }, settings);
      if (first === null) first = next.interventionAt;
      state = next.exposure;
    }
    outputs.push({ energy: state.locations.rear.energyJPerM, first });
    assert.equal(state.locations.rear.lastAt, START);
    assert.equal(state.locations.rear.lastC, -25);
    assert.ok(state.locations.rear.estimatedC > 1);
  }
  for (const output of outputs) { near(output.energy, outputs[0].energy, 1e-6); near(output.first, outputs[0].first, 0.001); }
  assert.deepEqual(initial, original);
});

test('first forecast crossing and restoration lead are located inside a coarse step', () => {
  const before = seed(6, -25);
  const crossing = START + props.coolingTimeConstantMinutes * Math.log(31 / 26) * MINUTE;
  const forecast = [{ at: START + 15 * MINUTE, rearLowerC: -25, frontLowerC: 6 }];
  const projection = projectGarageExposure(before, forecast[0], settings);
  near(projection.locations.rear.interventionAt, crossing, 0.001);
  const a = assessGarageProtection(before, { now: START, observation: observation(0, -25, 6), settings,
    forecast, restorationDelayMs: 2 * MINUTE });
  near(a.interventionAt, crossing, 0.001);
  assert.equal(a.safeToPause, false);
  assert.ok(a.reasons.includes('restoration-margin-exhausted'));
  const zero = projectGarageExposure(before, { at: START, rearC: -25, frontC: 6 }, settings);
  assert.equal(zero.interventionAt, null); near(zero.exposure.locations.rear.energyJPerM, before.locations.rear.energyJPerM);
});

test('missing future local temperatures cannot authorize a pause or become genuine reports', () => {
  const before = seed();
  const a = assessGarageProtection(before, { now: START, observation: observation(0), settings,
    forecast: [{ at: START + 15 * MINUTE, rearLowerC: 5 }] });
  assert.equal(a.safeToPause, false);
  assert.ok(a.reasons.includes('front:forecast-temperature-unavailable'));
  const uncertain = createGarageExposure(settings); uncertain.at = START;
  for (const row of Object.values(uncertain.locations)) Object.assign(row, { stateAt: START, lastAt: START, lastC: 10 });
  const projected = projectGarageExposure(uncertain, { at: START + 600 * MINUTE, rearC: 10, frontC: 10 }, settings);
  assert.equal(projected.exposure.locations.rear.uncertain, true);
});

test('numeric settings changes cannot manufacture usable joules or erase frozen debt', () => {
  const before = seed(), oldRemaining = props.capacityJPerMK * 5;
  for (const protection of [{ marginC: 0.5 }, { pipeOutsideDiameterMm: 30 }, { pipeOutsideDiameterMm: 10 }, { heatTransferWPerM2K: 10 }]) {
    const changed = garageSettings({ protection: { approved: true, ...protection } });
    const next = reconcileGarageExposure(before, changed), p = reserveProperties(changed);
    assert.ok(Math.max(0, next.locations.rear.energyJPerM - p.capacityJPerMK * changed.protection.marginC) <= oldRemaining + 1e-6);
    assert.equal(next.locations.rear.uncertain, true);
    assert.equal(validGarageExposure(next, START, changed), true);
  }
  const unknown = createGarageExposure(settings), changed = { protection: { pipeOutsideDiameterMm: 30 } };
  const next = reconcileGarageExposure(unknown, changed), p = reserveProperties(changed);
  assert.ok(next.locations.rear.energyJPerM <= -p.latentJPerM);
  const slider = reconcileGarageExposure(before, { ...settings, aggressiveness: 100 });
  assert.deepEqual(slider.locations, before.locations);
});

test('retired protection policies and exposure representations are rejected', () => {
  for (const version of ['garage-exposure-v1', 'garage-exposure-v2']) {
    assert.throws(() => garageSettings({ protection: { version } }), /Unsupported/);
    assert.throws(() => reconcileGarageExposure({ version }, settings), /Unsupported/);
  }
  for (const key of ['maxPauseHours', 'maxHorizonHours', 'assumeISave10C'])
    assert.throws(() => garageSettings({ [key]: 1 }), /Unknown/);
  assert.throws(() => garageSettings({ protection: { recoveryDwellMinutes: 20 } }), /Unknown/);
});

test('malformed or future state cannot become permission and replayed clocks cannot warm it', () => {
  const before = seed();
  for (const mutate of [s => { s.locations.front.energyJPerM = Infinity; },
    s => { s.locations.front.estimatedC = 20; }, s => { s.locations.front.lastAt = START + MINUTE; },
    s => { s.locations.front.stateAt = null; s.locations.front.lastAt = null; s.locations.front.lastC = null; }]) {
    const bad = structuredClone(before); mutate(bad);
    assert.equal(validGarageExposure(bad, START, settings), false);
    assert.equal(assessGarageProtection(bad, { now: START, observation: observation(0), settings }).safeToPause, false);
  }
  const next = updateGarageExposure(before, observation(1, 10), settings);
  assert.deepEqual(updateGarageExposure(next, observation(0, 30), settings), next);
});
