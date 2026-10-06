import test from 'node:test';
import assert from 'node:assert/strict';
import { shellyCurrentLimit } from '../src/charging/shelly-limit.js';
import { ChargingRuntime } from '../src/charging/runtime.js';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const triple = value => [value, value, value];
const config = { maximumCurrentA: 16, minimumCurrentA: 6, currentStepA: 1, fallbackCurrentA: 12,
  mainFuseA: triple(25), marginA: triple(0), maxAgeMs: 15_000 };
const held = currents => ({ healthy: true, currents, times: triple(NOW - 3_600_000),
  evidence: { source: 'easee-stream', connected: true, online: true, synchronized: true, epoch: 'synthetic-feed' } });
const fixture = ({ household = 3, peer = 16, own = 16 } = {}) => ({ config, now: NOW, priority: 'charger2',
  property: held(triple(household + peer + own)), easee: held(triple(peer)),
  shelly: { healthy: true, currents: triple(own), times: triple(NOW - 3_600_000) } });

test('unchanged values remain usable on independently healthy current feeds without renewing clocks', () => {
  const input = fixture(), before = structuredClone(input);
  assert.equal(shellyCurrentLimit(input).currentA, 16);
  assert.equal(shellyCurrentLimit(input).fallback, false);
  assert.deepEqual(input, before);
  assert.equal(shellyCurrentLimit({ ...input, now: NOW + 3_600_000 }).fallback, false);
});

test('the limiter needs no Equalizer allowance, budget or warm-up reference', () => {
  const input = fixture();
  Object.defineProperties(input, {
    allowance: { get() { throw Error('Offered current is not a limiter input'); } },
    nativeBudget: { get() { throw Error('Native budget is not a limiter input'); } },
  });
  for (let poll = 0; poll < 3; poll++) {
    const result = shellyCurrentLimit(input);
    assert.equal(result.currentA, 16); assert.equal(result.fallback, false);
    assert.deepEqual(result.baseCurrentA, triple(3));
  }
});

test('Charger 1 draw and arbitrarily delayed Equalizer response never change an assigned entitlement', () => {
  for (const [priority, allocationA, reservationA, expected] of [
    ['charger2', 0, 16, 16], ['balanced', 13, 9, 13], ['charger1', 6, 16, 6],
  ]) {
    for (const peer of [16, 12, 0, 8, 16, 0]) {
      const result = shellyCurrentLimit({ ...fixture({ peer }), priority, allocationA, reservationA });
      assert.equal(result.currentA, expected); assert.equal(result.fallback, false);
    }
    // Even an hour of combined excess causes no response-time takeover.
    const input = { ...fixture(), priority, allocationA, reservationA, now: NOW + 3_600_000 };
    assert.equal(shellyCurrentLimit(input).currentA, expected);
  }
});

test('property protection acts only on the excess that stopping Charger 1 cannot resolve', () => {
  for (const peer of [0, 8, 16, 32]) {
    assert.equal(shellyCurrentLimit(fixture({ household: 9, peer })).currentA, 16);
    assert.equal(shellyCurrentLimit(fixture({ household: 10, peer })).currentA, 15);
    assert.equal(shellyCurrentLimit(fixture({ household: 19, peer })).currentA, 6);
    const result = shellyCurrentLimit(fixture({ household: 20, peer }));
    assert.equal(result.currentA, 0); assert.equal(result.fallback, false);
    assert.equal(result.reason, 'fuse-limit');
  }
});

test('signed calibration applies exactly once per phase without another reserve', () => {
  const input = fixture({ household: 12 });
  assert.equal(shellyCurrentLimit(input).currentA, 13);
  assert.equal(shellyCurrentLimit({ ...input, config: { ...config, marginA: triple(-2) } }).currentA, 15);
  const unequal = shellyCurrentLimit({ ...input, config: { ...config, marginA: [-2, 1, 0] } });
  assert.deepEqual(unequal.phaseHeadroomA, [15, 12, 13]); assert.equal(unequal.currentA, 12);
  assert.equal(shellyCurrentLimit({ ...input, config: { ...config, marginA: triple(-20) }, nativeCurrentA: 9 }).currentA, 9);
});

test('real feed outages and invalid evidence still select fallback without inventing headroom', () => {
  for (const field of ['property', 'easee', 'shelly']) {
    for (const change of [value => ({ ...value, healthy: false }), value => ({ ...value, currents: [NaN, 0, 0] }),
      value => ({ ...value, times: [NOW + 1, NOW, NOW] }), () => null]) {
      const input = fixture(); input[field] = change(input[field]);
      const result = shellyCurrentLimit(input);
      assert.equal(result.currentA, 12); assert.equal(result.fallback, true);
      assert.ok(result.missing.includes(field));
    }
  }
  for (const field of ['property', 'easee']) for (const flag of ['connected', 'online', 'synchronized', 'epoch']) {
    const input = fixture(); input[field].evidence[flag] = flag === 'epoch' ? null : false;
    assert.equal(shellyCurrentLimit(input).fallback, true);
  }
});

test('fallback ceiling and a tighter native or vehicle limit remain separate diagnostics', () => {
  const input = { ...fixture(), property: null };
  for (const [restriction, reason] of [[{ nativeCurrentA: 9 }, 'native-current-limit'],
    [{ vehicleCurrentA: 7 }, 'vehicle-current-limit']]) {
    const result = shellyCurrentLimit({ ...input, ...restriction });
    assert.equal(result.loadCurrentA, 12); assert.equal(result.loadReason, 'telemetry-fallback');
    assert.equal(result.currentA, restriction.nativeCurrentA ?? restriction.vehicleCurrentA);
    assert.equal(result.reason, reason); assert.equal(result.fallback, true);
  }
  assert.equal(shellyCurrentLimit({ ...input, priority: 'balanced', allocationA: 0 }).currentA, 0);
});

test('contradictory total and charger measurements cannot create headroom', () => {
  const input = fixture(); input.property.currents = triple(1);
  const result = shellyCurrentLimit(input);
  assert.equal(result.fallbackReason, 'non-additive-currents'); assert.equal(result.currentA, 12);
  assert.equal(result.phaseHeadroomA, null);
});

test('uncommissioned Shelly phase correspondence credits only current present on every phase', () => {
  for (const currents of [[6, 12, 16], [16, 6, 12], [12, 16, 6]]) {
    const input = fixture({ household: 9, peer: 0, own: 6 }); input.shelly.currents = currents;
    assert.equal(shellyCurrentLimit(input).currentA, 16);
    input.shelly.currents = [0, 12, 16];
    assert.equal(shellyCurrentLimit(input).currentA, 10);
  }
});

test('allocation context transfers property and charger evidence without polling or writing Easee', () => {
  const input = fixture(); let reads = 0;
  const supply = { propertyCurrentA: input.property.currents, chargerCurrentA: input.easee.currents,
    observationTimes: { property: input.property.times, charger: input.easee.times },
    feedEvidence: { property: input.property.evidence, charger: input.easee.evidence } };
  const fake = { chargers: { charger1: { adapter: { readCurrentSupply() { reads++; return { online: true, supply }; } } } },
    configuration: { chargers: { charger2: config } }, clock: () => NOW, settings: { priority: 'charger2' },
    coordination: { allocations: [] }, views: () => [{ id: 'charger2', settings: { enabled: true }, values: {}, control: {} }] };
  const result = ChargingRuntime.prototype.allocationContext.call(fake);
  assert.equal(reads, 1); assert.deepEqual(result.property, input.property); assert.deepEqual(result.easee, input.easee);
  assert.equal(result.allocationA, null); assert.equal(result.reservationA, 0);
  assert.equal(Object.hasOwn(result, 'allowance'), false); assert.equal(Object.hasOwn(result, 'nativeBudget'), false);
});


test('healthy charger values are admitted before or after property readings without rewriting source times', () => {
  for (const source of ['easee-ocpp', 'easee-stream']) {
    for (const peerAt of [NOW - 3600_000, NOW - 1000]) {
      for (const ownAt of [NOW - 3600_000, NOW - 1000]) {
        const input = fixture({ household: 12, peer: 6, own: 6 });
        input.property.times = triple(NOW - 2000);
        input.easee.times = triple(peerAt); input.easee.evidence.source = source;
        input.shelly.times = triple(ownAt); input.shelly.confirmedAt = ownAt;
        const original = structuredClone(input);
        const result = shellyCurrentLimit(input);
        assert.equal(result.currentA, 13); assert.equal(result.fallback, false);
        assert.equal(result.modelAvailable, true);
        assert.deepEqual(input, original);
      }
    }
  }
});

test('successive property changes immediately revise capacity against unchanged healthy charger readings', () => {
  const input = fixture({ household: 12, peer: 6, own: 6 });
  input.easee.evidence.source = 'easee-ocpp';
  const chargerTimes = structuredClone([input.easee.times, input.shelly.times]);
  for (const [household, expected] of [[12, 13], [19, 6], [20, 0], [9, 16]]) {
    input.now += 1000;
    input.property.times = triple(input.now);
    input.property.currents = triple(household + 12);
    const result = shellyCurrentLimit(input);
    assert.equal(result.currentA, expected); assert.equal(result.fallback, false);
  }
  assert.deepEqual([input.easee.times, input.shelly.times], chargerTimes);
});

test('separate transitions use the latest healthy readings in either arrival order', () => {
  // A one-phase-equivalent fixture starts at 8 A household + 16 A peer + 8 A own.
  // The peer then drops to 8 A. Different arrival orders intentionally produce
  // temporary estimates; the next matching observations restore the same result.
  for (const order of ['property-first', 'charger-first']) {
    const input = fixture({ household: 8, peer: 16, own: 8 });
    input.config = { ...config, maximumCurrentA: 20 };
    input.easee.evidence.source = 'easee-ocpp';
    assert.equal(shellyCurrentLimit(input).currentA, 17);
    const updateProperty = () => { input.property.currents = triple(24); input.property.times = triple(input.now); };
    const updateCharger = () => { input.easee.currents = triple(8); input.easee.times = triple(input.now); };
    input.now += 1000;
    (order === 'property-first' ? updateProperty : updateCharger)();
    const separate = shellyCurrentLimit(input);
    assert.equal(separate.currentA, order === 'property-first' ? 20 : 9);
    assert.equal(separate.fallback, false); assert.equal(separate.modelAvailable, true);
    input.now += 1000;
    (order === 'property-first' ? updateCharger : updateProperty)();
    assert.equal(shellyCurrentLimit(input).currentA, 17);
  }
});

test('a Shelly current change is used immediately even before the property observation follows', () => {
  const input = fixture({ household: 12, peer: 6, own: 6 });
  assert.equal(shellyCurrentLimit(input).currentA, 13);
  input.shelly.currents = triple(10); input.shelly.times = triple(NOW);
  assert.equal(shellyCurrentLimit(input).currentA, 16);
  input.property.currents = triple(28); input.property.times = triple(NOW);
  assert.equal(shellyCurrentLimit(input).currentA, 13);
});

test('latest-reading calculation retains restrictions and real feed outage recovery', () => {
  const input = fixture({ household: 8, peer: 8, own: 8 });
  input.property.times = triple(NOW);
  assert.equal(shellyCurrentLimit({ ...input, nativeCurrentA: 7 }).currentA, 7);
  assert.equal(shellyCurrentLimit({ ...input, vehicleCurrentA: 0 }).currentA, 0);
  const failed = shellyCurrentLimit({ ...input, property: { ...input.property, healthy: false } });
  assert.equal(failed.fallback, true); assert.equal(failed.currentA, 12);
  assert.equal(shellyCurrentLimit(input).fallback, false);
  assert.equal(shellyCurrentLimit(input).currentA, 16);
});
