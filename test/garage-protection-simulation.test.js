import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { garageSettings, GARAGE_POLICY_VERSION } from '../src/garage/settings.js';
import { pipeThermalProperties, pipeCoolingEstimate, simulatePipePulses, garagePipeSensitivityAudit } from '../scripts/garage-pipe-simulation.js';
import { validateOptionFields } from '../src/app/configuration-source.js';

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

test('public defaults and schema agree with the unapproved thermal reserve model', () => {
  const defaults = garageSettings();
  assert.equal(defaults.enabled, false); assert.equal(defaults.protection.approved, false);
  assert.deepEqual(defaults.protection, { approved: false, version: GARAGE_POLICY_VERSION,
    marginC: 1, pipeOutsideDiameterMm: 21, pipeWallMm: 1, heatTransferWPerM2K: 20 });
  const document = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(document.options.garage.enabled, false);
  assert.deepEqual(document.options.garage.protection, defaults.protection);
  assert.doesNotThrow(() => validateOptionFields({ garage: defaults }, document.schema));
});

test('retired private policies are rejected without carrying old approval', () => {
  const document = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  for (const version of ['garage-exposure-v1', 'garage-exposure-v2']) {
    const retired = { enabled: true, protection: { version, approved: true, floorC: 3 } };
    assert.throws(() => validateOptionFields({ garage: retired }, document.schema), /Unknown|Invalid/);
    assert.throws(() => garageSettings(retired), /Unknown|Unsupported/);
  }
});
