import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { garageSettings, GARAGE_POLICY_VERSION } from '../src/garage/settings.js';
import { createGarageExposure, updateGarageExposure, upgradeGarageExposure, assessGarageProtection } from '../src/garage/protection.js';
import { pipeThermalProperties, pipeCoolingEstimate, simulatePipePulses, garagePipeSensitivityAudit } from '../scripts/garage-pipe-simulation.js';
import { validateOptionFields } from '../src/app/configuration-source.js';

const MINUTE = 60_000, start = Date.parse('2026-01-01T00:00:00Z');
const settings = garageSettings({ maxSensorAgeMs: 4 * 3_600_000, protection: { approved: true } });
const observation = (minute, rearC, frontC = rearC) => ({ at: start + minute * MINUTE, rearC, frontC });
const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

test('bare 21mm pipe sensitivity separates sensible cooling from phase change', () => {
  const properties = pipeThermalProperties();
  close(properties.waterKgPerM, .2835287369864789);
  close(properties.capacityJPerMK, 1401.8948809599488);
  const cold = pipeCoolingEstimate({ initialC: 2, airC: -10, surfaceTransferWPerM2K: 30 });
  const warm = pipeCoolingEstimate({ initialC: 10, airC: -10, surfaceTransferWPerM2K: 30 });
  close(cold.bulkZeroMinutes, 2.152344564525501);
  close(warm.bulkZeroMinutes, 8.182749164326147);
  assert.ok(cold.latentMinutes > cold.bulkZeroMinutes * 30);
  close(cold.latentMinutes, warm.latentMinutes);
  // The later complete-freeze result must never be labelled the onset time.
  assert.ok(cold.fullPhaseChangeMinutes > 80);
});

test('432 geometry/weather/heat-transfer combinations retain physical monotonicity', () => {
  const { matrix } = garagePipeSensitivityAudit();
  assert.equal(matrix.length, 432);
  for (const row of matrix) {
    assert.ok(row.bulkZeroMinutes > 0 && row.fullPhaseChangeMinutes > row.bulkZeroMinutes);
    const fasterTransfer = pipeCoolingEstimate({ ...row, surfaceTransferWPerM2K: row.surfaceTransferWPerM2K * 2 });
    assert.ok(fasterTransfer.bulkZeroMinutes < row.bulkZeroMinutes);
    const colderAir = pipeCoolingEstimate({ ...row, airC: row.airC * 2 });
    assert.ok(colderAir.bulkZeroMinutes < row.bulkZeroMinutes);
    const insulated = pipeCoolingEstimate({ ...row, insulationMm: row.insulationMm + 10 });
    assert.ok(insulated.bulkZeroMinutes > row.bulkZeroMinutes);
  }
});

test('independent pulse integration agrees with analytic constant-air onset and latent energy', () => {
  for (const initialC of [2, 10]) for (const surfaceTransferWPerM2K of [5, 10, 30, 60]) {
    const expected = pipeCoolingEstimate({ initialC, surfaceTransferWPerM2K });
    const actual = simulatePipePulses({ initialC, surfaceTransferWPerM2K,
      segments: [{ airC: -10, durationMinutes: expected.fullPhaseChangeMinutes + 1 }] });
    close(actual.bulkZeroAtMinute, expected.bulkZeroMinutes);
    close(actual.fullPhaseChangeAtMinute, expected.fullPhaseChangeMinutes);
    assert.equal(actual.maximumIceFraction, 1);
  }
});

test('identical short door pulse has different results after warmth versus a cold soak', () => {
  const segments = [{ airC: -10, durationMinutes: 5 }, { airC: 8, durationMinutes: 60, surfaceTransferWPerM2K: 10 }];
  const warm = simulatePipePulses({ initialC: 10, surfaceTransferWPerM2K: 30, segments });
  const cold = simulatePipePulses({ initialC: 2, surfaceTransferWPerM2K: 30, segments });
  assert.equal(warm.bulkZeroAtMinute, null);
  assert.ok(warm.minimumBulkC > 3);
  assert.ok(cold.bulkZeroAtMinute < 3 && cold.maximumIceFraction > 0);
  assert.ok(cold.maximumIceFraction < .05);
  assert.equal(cold.trace.at(-1).iceFraction, 0);
  assert.ok(cold.trace.at(-1).temperatureC > 5);
});

test('repeated pulses retain thermal debt when each intervening recovery is short', () => {
  const pulse = [{ airC: -10, durationMinutes: 2 }, { airC: 8, durationMinutes: 2, surfaceTransferWPerM2K: 10 }];
  const once = simulatePipePulses({ initialC: 10, surfaceTransferWPerM2K: 30, segments: pulse });
  const repeated = simulatePipePulses({ initialC: 10, surfaceTransferWPerM2K: 30, segments: Array(10).fill(pulse).flat() });
  assert.equal(once.bulkZeroAtMinute, null);
  assert.notEqual(repeated.bulkZeroAtMinute, null);
  assert.ok(repeated.maximumIceFraction > 0);
});

test('defaults tolerate brief near-zero air while retaining explicit approval and independent locations', () => {
  const defaults = garageSettings();
  assert.equal(defaults.enabled, false); assert.equal(defaults.protection.approved, false);
  assert.deepEqual(defaults.protection, { approved: false, version: GARAGE_POLICY_VERSION,
    floorC: 2, hardMinimumC: -1, budgetDegreeMinutes: 90, recoveryAboveC: 4,
    recoveryDegreeMinutesPerMinute: 1, recoveryDwellMinutes: 20 });
  const document = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  function policies(value) {
    if (!value || typeof value !== 'object') return [];
    return [...(value.garage?.protection?.floorC === 2 ? [value.garage.protection] : []), ...Object.values(value).flatMap(policies)];
  }
  assert.deepEqual(policies(document), [defaults.protection]);
  let state = updateGarageExposure(null, observation(0, 8, -.5), settings);
  state = updateGarageExposure(state, observation(5, 8, -.5), settings);
  close(state.locations.front.degreeMinutes, 12.5); assert.equal(state.locations.rear.degreeMinutes, 0);
  const assessment = assessGarageProtection(state, { now: state.at, observation: observation(5, 8, -.5), settings });
  assert.equal(assessment.safeToPause, true);
  const deepPlunge = assessGarageProtection(state, { now: state.at, observation: observation(5, 8, -1), settings });
  assert.equal(deepPlunge.safeToPause, false); assert.equal(deepPlunge.interventionAt, state.at);
});

test('protection accumulates short door pulses without allowing rear warmth to erase front debt', () => {
  let state = updateGarageExposure(null, observation(0, 8, 0), settings);
  for (let minute = 1; minute <= 60; minute++) {
    const frontC = minute % 10 < 4 ? 0 : 8;
    state = updateGarageExposure(state, observation(minute, 8, frontC), settings);
  }
  assert.ok(state.locations.front.degreeMinutes > 30);
  assert.equal(state.locations.rear.degreeMinutes, 0);
});

test('an exhausted allowance requires 110 sustained warm minutes and never an ON acknowledgement alone', () => {
  let state = updateGarageExposure(null, observation(0, 4), settings);
  state.locations.front.degreeMinutes = 90; state.locations.front.uncertain = true;
  state = updateGarageExposure(state, observation(20, 4), settings);
  assert.equal(state.locations.front.degreeMinutes, 90);
  state = updateGarageExposure(state, { ...observation(109, 4), available: true }, settings);
  assert.equal(state.locations.front.degreeMinutes, 1); assert.equal(state.locations.front.uncertain, true);
  state = updateGarageExposure(state, observation(110, 4), settings);
  assert.equal(state.locations.front.degreeMinutes, 0); assert.equal(state.locations.front.uncertain, false);
});

test('exposure and warm-threshold crossings agree at 1/5/15/30 minute sample cadences', () => {
  const profile = minute => minute < 60 ? 8 - minute * 8 / 60 : minute < 120 ? (minute - 60) * 8 / 60 : 8;
  const outputs = [1, 5, 15, 30].map(cadence => {
    let state;
    for (let minute = 0; minute <= 150; minute += cadence) state = updateGarageExposure(state, observation(minute, profile(minute)), settings);
    return state.locations.front;
  });
  for (const state of outputs.slice(1)) {
    close(state.degreeMinutes, outputs[0].degreeMinutes);
    close(state.recoveryMinutes, outputs[0].recoveryMinutes);
  }
});

test('warm-then-cold coarse interval repays earlier debt before adding subsequent cold exposure', () => {
  let state = updateGarageExposure(null, observation(0, 8), settings);
  state.locations.front.degreeMinutes = 10; state.locations.front.recoveryMinutes = 40;
  state = updateGarageExposure(state, observation(60, 0), settings);
  close(state.locations.front.degreeMinutes, 15);
  assert.equal(state.locations.front.recoveryMinutes, 0);
});

test('forecast catches a hard limit within a coarse step and reserves restoration time', () => {
  const state = updateGarageExposure(null, observation(0, 5), settings);
  const assessment = assessGarageProtection(state, { now: start, observation: observation(0, 5), settings,
    restorationDelayMs: 14 * MINUTE, forecast: [{ ...observation(15, 5, -2) }] });
  close((assessment.interventionAt - start) / MINUTE, 15 * 6 / 7, 1e-6);
  assert.equal(assessment.limitingLocation, 'front'); assert.equal(assessment.safeToPause, false);
});

test('forecast catches budget exhaustion earlier than a later hard minimum in the same step', () => {
  const state = updateGarageExposure(null, observation(0, 5, 1), settings);
  state.locations.front.degreeMinutes = 85;
  const assessment = assessGarageProtection(state, { now: start, observation: observation(0, 5, 1), settings,
    restorationDelayMs: 10 * MINUTE, forecast: [observation(15, 5, -2)] });
  // Integral from front 1C declining .2C/min: t + .1t² = 5 degree-minutes.
  close((assessment.interventionAt - start) / MINUTE, (-1 + Math.sqrt(3)) / .2, 1e-6);
  assert.equal(assessment.safeToPause, false);
});

test('forecast cannot conceal temporary exhaustion by recharging before its next endpoint', () => {
  const state = updateGarageExposure(null, observation(0, 5, 0), settings);
  state.locations.front.degreeMinutes = 88;
  const assessment = assessGarageProtection(state, { now: start, observation: observation(0, 5, 0), settings,
    restorationDelayMs: 2 * MINUTE, forecast: [observation(120, 5, 8)] });
  assert.ok(assessment.interventionAt < start + 2 * MINUTE);
  assert.equal(assessment.safeToPause, false);
});

test('supported recovery forecast replaces a false constant-cold extrapolation', () => {
  const state = updateGarageExposure(null, observation(0, 5, 0), settings);
  const assessment = assessGarageProtection(state, { now: start, observation: observation(0, 5, 0), settings,
    restorationDelayMs: 60 * MINUTE, forecast: [observation(30, 5, 8)] });
  assert.equal(assessment.interventionAt, null); assert.equal(assessment.safeToPause, true);
});

test('unavailable future local temperature does not become protection permission', () => {
  const state = updateGarageExposure(null, observation(0, 5), settings);
  const assessment = assessGarageProtection(state, { now: start, observation: observation(0, 5), settings,
    forecast: [observation(30, 5, null)] });
  assert.equal(assessment.safeToPause, false);
  assert.ok(assessment.reasons.includes('front:forecast-temperature-unavailable'));
});

test('v1 upgrade preserves independent debt and requires recovery instead of fresh entitlement', () => {
  const old = { ...createGarageExposure(settings), version: 'garage-exposure-v1', at: start };
  Object.assign(old.locations.front, { degreeMinutes: 125, lastAt: start, lastC: 5, recoveryMinutes: 80 });
  Object.assign(old.locations.rear, { degreeMinutes: 3, lastAt: start, lastC: 5 });
  const before = structuredClone(old), upgraded = upgradeGarageExposure(old, settings);
  assert.deepEqual(old, before);
  assert.equal(upgraded.version, GARAGE_POLICY_VERSION); assert.equal(upgraded.previousVersion, 'garage-exposure-v1');
  assert.equal(upgraded.locations.front.degreeMinutes, 125); assert.equal(upgraded.locations.rear.degreeMinutes, 90);
  assert.equal(upgraded.locations.front.recoveryMinutes, 0); assert.equal(upgraded.locations.front.lastC, 5);
  assert.equal(upgraded.locations.front.uncertain, true);
  const recovered = updateGarageExposure(upgraded, observation(110, 5), settings);
  assert.equal(recovered.locations.rear.uncertain, false); assert.equal(recovered.locations.front.uncertain, true);
  close(recovered.locations.front.degreeMinutes, 35);
  assert.throws(() => upgradeGarageExposure({ ...old, version: 'garage-exposure-v99' }, settings), /Unsupported/);
});

test('explicit v1 configuration still loads and retains custom numbers and approval', () => {
  const legacy = { enabled: true, protection: { version: 'garage-exposure-v1', approved: true,
    floorC: 3, hardMinimumC: 0, budgetDegreeMinutes: 105, recoveryAboveC: 5,
    recoveryDegreeMinutesPerMinute: .7, recoveryDwellMinutes: 25 } };
  const before = structuredClone(legacy);
  const document = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => validateOptionFields({ garage: legacy }, document.schema));
  const resolved = garageSettings(legacy);
  assert.deepEqual(resolved.protection, { ...legacy.protection, version: GARAGE_POLICY_VERSION });
  assert.equal(resolved.enabled, true); assert.deepEqual(legacy, before);
  const exposure = upgradeGarageExposure({ ...createGarageExposure(resolved), version: 'garage-exposure-v1' }, resolved);
  assert.equal(exposure.locations.front.uncertain, true);
  assert.equal(exposure.locations.front.degreeMinutes, 105);
  assert.throws(() => garageSettings({ protection: { version: 'garage-exposure-v99' } }), /Unsupported/);
});
