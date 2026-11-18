import test from 'node:test';
import assert from 'node:assert/strict';
import { shellyCurrentLimit } from '../src/charging/shelly-limit.js';
import { currentChargingAllocation } from '../src/charging/planner.js';

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

test('rounding the same electrical ceiling does not invent a priority restriction', () => {
  const args = { ...input(), property: { ...phases(34), currents: [40.2, 34, 34] }, priority: 'balanced' };
  for (const shared of [{ allocationA: 9 }, { reservationA: .4 },
    { allocateCurrent: () => ({ allocationA: 9, reservationA: 0 }) }]) {
    const result = shellyCurrentLimit({ ...args, ...shared });
    assert.equal(result.currentA, 9);
    assert.equal(result.loadCurrentA, 9);
    assert.equal(result.loadReason, 'fuse-limit');
    assert.equal(result.reason, 'fuse-limit');
  }
  for (const shared of [{ allocationA: 8 }, { reservationA: 1.2 }]) {
    const result = shellyCurrentLimit({ ...args, ...shared });
    assert.equal(result.currentA, 8);
    assert.equal(result.loadReason, 'priority-allocation');
    assert.equal(result.reason, 'priority-allocation');
  }
});

test('native and vehicle reasons change only when they lower the supported current', () => {
  const args = { ...input(), property: { ...phases(34), currents: [40.2, 34, 34] } };
  for (const restriction of [{ nativeCurrentA: 9.2 }, { vehicleCurrentA: 9.2 }]) {
    const result = shellyCurrentLimit({ ...args, ...restriction });
    assert.equal(result.currentA, 9);
    assert.equal(result.reason, 'fuse-limit');
  }
  for (const [restriction, reason] of [[{ nativeCurrentA: 8.7 }, 'native-current-limit'],
    [{ vehicleCurrentA: 8.7 }, 'vehicle-current-limit']]) {
    const result = shellyCurrentLimit({ ...args, ...restriction });
    assert.equal(result.currentA, 8);
    assert.equal(result.reason, reason);
    assert.equal(result.loadCurrentA, 9);
    assert.equal(result.loadReason, 'fuse-limit');
  }
});

test('minimum-pilot reasons preserve the binding electrical or shared ceiling', () => {
  for (const [propertyA, allocationA, reason] of [[44.1, 0, 'fuse-limit'], [43.8, 5.9, 'priority-allocation']]) {
    const result = shellyCurrentLimit({ ...input(), property: { ...phases(34), currents: [propertyA, 34, 34] }, allocationA });
    assert.equal(result.currentA, 0);
    assert.equal(result.pause, true);
    assert.equal(result.reason, reason);
  }
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

test('a completed vehicle target keeps permitted continuing load in live sharing without a stop/start feedback loop', () => {
  const reading = value => ({ value, available: true, assumed: false });
  const chargers = ['charger1', 'charger2'].map((id, index) => ({
    id, requiredGridKwh: 0, deadlineAt: NOW - 10 * 60_000,
    settings: { enabled: true }, control: {}, telemetry: { currentSharingActive: true },
    capabilities: { scheduling: true, currentControl: index === 1, externalLoadBalancing: index === 0 },
    values: { connected: reading(true), soc: reading(index ? 100 : 85), minimumSoc: reading(index ? 100 : 85),
      vehicleCeilingSoc: reading(100), maximumCurrentA: reading(16), currentA: reading(12), voltageV: reading(230) },
  }));
  const limit = (draw, householdA = 2) => {
    let selected;
    const result = shellyCurrentLimit({ config: { ...config, marginA: [0, 0, 0] }, now: NOW, priority: 'balanced',
      property: { ...phases(0), currents: draw.map(value => value + householdA) }, easee: phases(0),
      shelly: { ...phases(0), currents: draw },
      allocateCurrent: budgetCurrentA => {
        selected = currentChargingAllocation({ now: NOW, chargers, budgetCurrentA, priority: 'balanced' });
        return { allocationA: selected.charger2?.currentLimitA ?? null, reservationA: selected.charger1?.currentA ?? 0 };
      } });
    return { result, selected };
  };
  for (const draw of [[0, 0, 0], [5, 0, 0], [0, 0, 0], [0, 5, 0], [0, 0, 5], [5, 5, 5]]) {
    const { result, selected } = limit(draw);
    assert.ok(selected.charger2, 'Reaching the native target does not revoke an independently permitted continuing load');
    assert.ok(result.currentA >= 6, 'Its own uneven draw must not alternate an available shared pilot with Stop');
    assert.equal(result.pause, false);
    assert.ok(selected.charger1.currentA + result.currentA <= Math.min(...result.phaseHeadroomA),
      'Continuing loads share the same conservative headroom without borrowing peer entitlement');
  }
  const overloaded = limit([5, 0, 0], 20).result;
  assert.equal(overloaded.currentA, 0, 'A real household shortage still requests Stop');
  chargers[1].values.vehicleCurrentA = reading(0);
  assert.equal(limit([0, 0, 0]).result.currentA, 0, 'An explicit vehicle zero remains binding after completion');
  chargers[1].telemetry.currentSharingActive = false;
  assert.equal(limit([0, 0, 0]).selected.charger2, undefined, 'A completed target grants no native participation');
});
