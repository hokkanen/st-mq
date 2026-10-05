import test from 'node:test';
import assert from 'node:assert/strict';
import { shellyCurrentLimit } from '../src/charging/shelly-limit.js';

const NOW = 1_800_000_000_000;
const phases = value => ({ healthy: true, currents: [value, value, value], times: [NOW, NOW, NOW],
  evidence: { connected: true, online: true, synchronized: true, epoch: 'fixture-stream-1' } });
const config = { maximumCurrentA: 16, minimumCurrentA: 6, currentStepA: 1,
  mainFuseA: [25, 25, 25], marginA: [1, 1, 1],
  maxAgeMs: 15_000, fallbackCurrentA: 12 };
const input = () => ({ config, now: NOW, property: phases(34), easee: phases(16), shelly: phases(10) });

test('a configured fallback is a cap, with zero and minimum-current behavior preserved', () => {
  for (const [fallbackCurrentA, expected] of [[0, 0], [5, 0], [6, 6], [8, 8], [12, 12], [16, 16]]) {
    const result = shellyCurrentLimit({ ...input(), config: { ...config, fallbackCurrentA }, property: null });
    assert.equal(result.currentA, expected); assert.equal(result.fallback, true);
  }
});

test('Shelly priority permits 16 A despite the present peer overload and a conservative forecast', () => {
  for (const allocationA of [0, 6, 8, 12, 16, null]) {
    const result = shellyCurrentLimit({ ...input(), priority: 'charger2', allocationA, reservationA: 16 });
    assert.equal(result.currentA, 16);
    assert.equal(result.pause, false);
    assert.equal(result.fallback, false);
    assert.equal(result.priority, 'charger2');
    assert.equal(result.evaluatedAt, NOW, 'Assessment time is explicit and does not replace meter source clocks');
    assert.deepEqual(result.baseCurrentA, [8, 8, 8]);
  }
});

test('other shared priorities retain the forecast ceiling and peer reservation', () => {
  for (const priority of ['balanced', 'charger1']) {
    assert.equal(shellyCurrentLimit({ ...input(), priority }).priority, priority);
    assert.equal(shellyCurrentLimit({ ...input(), priority, allocationA: 8 }).currentA, 8);
    assert.equal(shellyCurrentLimit({ ...input(), priority, reservationA: 10 }).currentA, 6);
    assert.equal(shellyCurrentLimit({ ...input(), priority, allocationA: 0 }).pause, true);
  }
  assert.equal(shellyCurrentLimit(input()).priority, null, 'Missing control priority is never inferred from a current value');
});

test('Shelly priority preserves native, vehicle, per-phase fuse and minimum-pilot restrictions', () => {
  const args = { ...input(), priority: 'charger2', allocationA: 0, reservationA: 16 };
  assert.equal(shellyCurrentLimit({ ...args, nativeCurrentA: 8 }).currentA, 8);
  assert.equal(shellyCurrentLimit({ ...args, vehicleCurrentA: 7 }).currentA, 7);
  for (const restriction of [{ nativeCurrentA: 0 }, { nativeCurrentA: 5 }, { vehicleCurrentA: 0 },
    { property: { ...phases(34), currents: [45, 34, 34] } }]) {
    const result = shellyCurrentLimit({ ...args, ...restriction });
    assert.equal(result.currentA, 0); assert.equal(result.pause, true);
  }
  assert.equal(shellyCurrentLimit({ ...args, property: { ...phases(34), currents: [44, 34, 34] } }).currentA, 6);
});

test('Shelly priority uses configured fallback for unavailable or contradictory live evidence', () => {
  const args = { ...input(), priority: 'charger2', allocationA: 0, reservationA: 16 };
  for (const restriction of [{ property: null }, { property: { ...phases(34), healthy: false } },
    { property: { ...phases(34), evidence: { ...phases(34).evidence, synchronized: false } } },
    { property: { ...phases(34), times: [NOW + 1, NOW, NOW] } },
    { property: phases(1) }]) {
    const result = shellyCurrentLimit({ ...args, ...restriction });
    assert.equal(result.currentA, 12); assert.equal(result.reason, 'telemetry-fallback');
    assert.equal(result.modelAvailable, false); assert.equal(result.guaranteedProtection, false);
    assert.equal(shellyCurrentLimit({ ...args, ...restriction, nativeCurrentA: 6 }).currentA, 6);
  }
});
