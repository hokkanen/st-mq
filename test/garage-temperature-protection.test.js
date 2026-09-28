import test from 'node:test';
import assert from 'node:assert/strict';
import { assessGarageTemperaturePermission } from '../src/garage/temperature-protection.js';
import { createGarageExposure, reserveProperties } from '../src/garage/protection.js';

const START = 1_800_000_000_000;
const observation = (overrides = {}) => ({ at: START, rearAt: START, frontAt: START,
  rearC: 8, frontC: 8, rearUsable: true, frontUsable: true, ...overrides });
function reserve({ rear = 8, front = 8, measured = observation() } = {}) {
  const result = createGarageExposure(), properties = reserveProperties();
  result.at = START;
  for (const [location, temperature] of Object.entries({ rear, front })) Object.assign(result.locations[location], {
    energyJPerM: properties.capacityJPerMK * temperature, estimatedC: temperature,
    stateAt: START, lastAt: measured[`${location}At`], lastC: measured[`${location}C`],
    uncertain: false, unknownMinutes: 0, uncertaintyReason: null,
  });
  return result;
}
const assess = (exposure = reserve(), options = {}) => assessGarageTemperaturePermission(exposure, {
  now: START, observation: observation(), expiresAt: START + 180_000, heatingDelayMs: 60_000, ...options,
});

test('external protection remains active without authorizing economic pauses', () => {
  const exposure = reserve(), before = structuredClone(exposure), settings = { protection: { approved: false } };
  const result = assess(exposure, { settings });
  assert.equal(result.allowed, true);
  assert.equal(result.expiresAt, START + 120_000);
  assert.equal(result.protection.approved, false);
  assert.equal(result.protection.safeToPause, false);
  assert.deepEqual(result.protection.reasons, ['owner-protection-policy-not-approved']);
  assert.deepEqual(exposure, before);
  assert.equal(settings.protection.approved, false);
});

test('cold front limits permission despite a warm rear and reserves useful heating time', () => {
  const measured = observation({ rearC: 8, frontC: -10 });
  const exposure = reserve({ rear: 8, front: 4, measured });
  const result = assess(exposure, { observation: measured });
  assert.equal(result.allowed, true);
  assert.equal(result.protection.limitingLocation, 'front');
  assert.ok(result.expiresAt > START + 60_000 && result.expiresAt < START + 70_000);
  assert.ok(result.expiresAt + 60_000 < result.protection.interventionAt);
  assert.equal(assess(exposure, { observation: measured, heatingDelayMs: 130_000 }).allowed, false);
});

test('both original source ages use the strict 120 second boundary and configured shorter limit', () => {
  assert.equal(assess(reserve(), { now: START + 119_999 }).allowed, true);
  for (const patch of [{ now: START + 120_000 }, { observation: observation({ frontAt: START - 120_000 }) },
    { observation: observation({ rearAt: START + 1 }) }, { observation: observation({ frontAt: null }) },
    { now: START + 60_000, settings: { maxSensorAgeMs: 60_000 } }])
    assert.equal(assess(reserve(), patch).allowed, false);
  const older = observation({ frontAt: START - 30_000 });
  assert.equal(assess(reserve({ measured: older }), { observation: older }).expiresAt, START + 90_000);
  assert.equal(assess(reserve(), { settings: { maxSensorAgeMs: 60_000 } }).expiresAt, START + 60_000);
});

test('unknown reserve, faults and unknown useful-heating response block external suppression', () => {
  for (const exposure of [null, createGarageExposure(), { ...reserve(), at: START + 1 }])
    assert.equal(assess(exposure).allowed, false);
  const uncertain = reserve(); uncertain.locations.front.uncertain = true;
  assert.equal(assess(uncertain).allowed, false);
  const invalid = reserve(); invalid.locations.front.energyJPerM = NaN;
  assert.equal(assess(invalid).allowed, false);
  for (const heatingDelayMs of [null, undefined, NaN, Infinity, -1])
    assert.equal(assess(reserve(), { heatingDelayMs }).allowed, false);
  for (const patch of [{ frontUsable: false }, { rearUsable: false, rearHeld: true },
    { frontC: null }, { frontRetained: true }])
    assert.equal(assess(reserve(), { observation: observation(patch) }).allowed, false);
  assert.equal(assess(reserve(), { expiresAt: START }).allowed, false);
});

test('held communications project cold exposure from the original anchor without warming or mutation', () => {
  const measured = observation({ rearC: 12, frontC: 12, rearHeld: true, frontHeld: true,
    outdoorC: 0, outdoorAt: START, outdoorUsable: true });
  const exposure = reserve({ rear: 8, front: 8, measured }), before = structuredClone(exposure);
  const result = assess(exposure, { now: START + 60_000, observation: measured });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.heldBounds, { rear: 0, front: 0 });
  assert.ok(result.protection.locations.rear.estimatedC < 8);
  assert.ok(result.protection.locations.front.estimatedC < 8);
  assert.equal(result.expiresAt, START + 120_000);
  assert.deepEqual(exposure, before);
  const later = assess(exposure, { now: START + 90_000, observation: measured });
  assert.ok(later.protection.locations.front.estimatedC < result.protection.locations.front.estimatedC);
  assert.equal(later.expiresAt, result.expiresAt);
  assert.deepEqual(exposure, before);
});

test('missing or non-covering outside evidence uses the conservative cold envelope for held samples', () => {
  const measured = observation({ rearHeld: true, frontHeld: true });
  for (const outdoor of [{}, { outdoorC: 10, outdoorAt: START + 1 },
    { outdoorC: 10, outdoorAt: START - 30 * 60_000 },
    { outdoorC: 10, outdoorAt: START, outdoorRetained: true }]) {
    const result = assess(reserve(), { now: START + 60_000, observation: { ...measured, ...outdoor }, heatingDelayMs: 0 });
    assert.equal(result.allowed, true);
    assert.deepEqual(result.heldBounds, { rear: -40, front: -40 });
    assert.ok(result.protection.locations.front.estimatedC < 3);
    assert.ok(result.expiresAt < START + 90_000);
  }
  assert.equal(assess(reserve(), { now: START + 90_000, observation: measured }).allowed, false);
});

test('held temperatures cannot supply newer measurements or earn warmth from warmer outside air', () => {
  const measured = observation({ rearC: 12, frontC: 12, rearHeld: true, frontHeld: true,
    outdoorC: 20, outdoorAt: START });
  const exposure = reserve({ rear: 8, front: 8, measured });
  const result = assess(exposure, { now: START + 60_000, observation: measured });
  assert.equal(result.allowed, true);
  assert.equal(result.protection.locations.front.estimatedC, 8);
  assert.equal(result.protection.locations.rear.estimatedC, 8);
  assert.equal(assess(exposure, { now: START + 60_000,
    observation: { ...measured, frontAt: START + 1 } }).allowed, false);
  assert.equal(assess(exposure, { now: START + 60_000,
    observation: { ...measured, rearC: 13 } }).allowed, false);
  const colder = assess(exposure, { now: START + 60_000,
    observation: { ...measured, frontC: -10 }, heatingDelayMs: 0 });
  assert.equal(colder.allowed, true);
  assert.equal(colder.heldBounds.front, -10);
  assert.ok(colder.protection.locations.front.estimatedC < 8);
});

test('a gap at one probe cannot hide another probe fault or known exhausted reserve', () => {
  const uncertain = reserve();
  uncertain.locations.rear.uncertain = true;
  uncertain.locations.rear.uncertaintyReason = 'exposure-history-uncertain';
  const invalidFront = assess(uncertain, { observation: observation({ frontUsable: false }) });
  assert.equal(invalidFront.allowed, false);
  assert.deepEqual(invalidFront.reasons, [
    'rear:exposure-history-uncertain', 'front:unqualified-or-stale-temperature',
  ]);
  const initializing = structuredClone(uncertain);
  initializing.locations.front.uncertain = true;
  initializing.locations.front.uncertaintyReason = 'initializing-reserve';
  assert.deepEqual(assess(initializing).reasons, [
    'rear:exposure-history-uncertain', 'front:initializing-reserve',
  ]);
  const exhausted = reserve({ front: 1 });
  exhausted.locations.rear = structuredClone(uncertain.locations.rear);
  const result = assess(exhausted);
  assert.equal(result.allowed, false);
  assert.deepEqual(result.reasons, ['rear:exposure-history-uncertain', 'front:thermal-reserve-exhausted']);
  const bothMissing = assess(reserve(), { observation: observation({ rearC: null, frontC: null }) });
  assert.deepEqual(bothMissing.reasons, ['rear:missing-temperature', 'front:missing-temperature']);
});
