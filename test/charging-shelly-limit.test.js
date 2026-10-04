import test from 'node:test';
import assert from 'node:assert/strict';
import { shellyCurrentLimit } from '../src/charging/shelly-limit.js';

const NOW = 1_800_000_000_000;
const phases = value => ({ healthy: true, currents: [value, value, value], times: [NOW, NOW, NOW],
  evidence: { connected: true, online: true, synchronized: true, epoch: 'fixture-stream-1' } });
const config = { maximumCurrentA: 16, minimumCurrentA: 6, currentStepA: 1,
  mainFuseA: [25, 25, 25], marginA: [1, 1, 1],
  maxAgeMs: 15_000, agreementToleranceA: 2, fallbackCurrentA: 12 };
const input = () => ({ config, now: NOW, property: phases(34), easee: phases(16), shelly: phases(10), allowance: phases(7) });

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
    { property: { ...phases(34), currents: [45, 34, 34] }, allowance: { ...phases(7), currents: [0, 7, 7] } }]) {
    const result = shellyCurrentLimit({ ...args, ...restriction });
    assert.equal(result.currentA, 0); assert.equal(result.pause, true);
  }
  assert.equal(shellyCurrentLimit({ ...args, property: { ...phases(34), currents: [44, 34, 34] }, allowance: { ...phases(7), currents: [0, 7, 7] } }).currentA, 6);
});

test('Shelly priority uses configured fallback for unavailable or contradictory live evidence', () => {
  const args = { ...input(), priority: 'charger2', allocationA: 0, reservationA: 16 };
  for (const restriction of [{ property: null }, { property: { ...phases(34), healthy: false } },
    { property: { ...phases(34), evidence: { ...phases(34).evidence, synchronized: false } } },
    { property: { ...phases(34), times: [NOW + 1, NOW, NOW] } },
    { property: phases(1) }, { allowance: null }]) {
    const result = shellyCurrentLimit({ ...args, ...restriction });
    assert.equal(result.currentA, 12); assert.equal(result.reason, 'telemetry-fallback');
    assert.equal(result.modelAvailable, false); assert.equal(result.guaranteedProtection, false);
    assert.equal(shellyCurrentLimit({ ...args, ...restriction, nativeCurrentA: 6 }).currentA, 6);
  }
});

test('unscheduled balanced control recovers an owned pause and admits an independently confirmed waiting peer', () => {
  const args = { ...input(), priority: 'balanced', liveUnscheduled: true, allocationA: 0, reservationA: 16 };
  assert.equal(shellyCurrentLimit({ ...args, property: phases(24), easee: phases(16), shelly: phases(0), allowance: phases(17) }).currentA, 8);
  const blockedPeer = { ...args, property: phases(24), easee: phases(0), shelly: phases(16), allowance: phases(1) };
  assert.equal(shellyCurrentLimit({ ...blockedPeer, peerDemandA: 16 }).currentA, 8);
  assert.equal(shellyCurrentLimit(blockedPeer).currentA, 16, 'Connection alone supplies no demand evidence for an idle peer');
  assert.equal(shellyCurrentLimit({ ...blockedPeer, peerDemandA: 16, nativeCurrentA: 7 }).currentA, 7);
  assert.equal(shellyCurrentLimit({ ...blockedPeer, peerDemandA: 16, vehicleCurrentA: 0 }).pause, true);
  assert.equal(shellyCurrentLimit({ ...blockedPeer, property: phases(29), peerDemandA: 16 }).currentA, 11,
    'Below two valid pilots, preserve the current physical turn instead of alternating permission');
});

test('unscheduled Charger 1 priority uses live peer demand instead of an economic forecast ceiling', () => {
  const args = { ...input(), priority: 'charger1', liveUnscheduled: true, allocationA: 7, reservationA: 16,
    property: phases(16), easee: phases(0), shelly: phases(8), allowance: phases(9) };
  assert.equal(shellyCurrentLimit(args).currentA, 16, 'A stopped peer does not reserve future charging capacity');
  assert.equal(shellyCurrentLimit({ ...args, peerDemandA: 8 }).currentA, 8);
  assert.equal(shellyCurrentLimit({ ...args, peerDemandA: 16 }).pause, true,
    'A confirmed open priority peer can recover from Equalizer yielding its current');
  assert.equal(shellyCurrentLimit({ ...args, property: phases(24), easee: phases(8) }).currentA, 8,
    'Measured peer draw remains reserved even when its open instruction is unavailable');
  assert.equal(shellyCurrentLimit({ ...args, nativeCurrentA: 6 }).currentA, 6);
  assert.equal(shellyCurrentLimit({ ...args, vehicleCurrentA: 0 }).pause, true);
  const fallback = shellyCurrentLimit({ ...args, allowance: null });
  assert.equal(fallback.currentA, 12); assert.equal(fallback.fallback, true);
});
