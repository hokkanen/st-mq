import test from 'node:test';
import assert from 'node:assert/strict';
import { createShellyCurrentLimiter, shellyCurrentLimit } from '../src/charging/shelly-limit.js';
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

const scope = { authorized: true, connected: true, association: 'synthetic-shelly', sessionId: 'synthetic-session',
  connectedAt: NOW - 60_000, generation: 1 };
const sample = ({ at = NOW, household = 2, peer = 16, own = 12 } = {}) => {
  const input = { ...fixture({ household, peer, own }), now: at, priority: 'balanced', allocationA: 10, reservationA: 12,
    currentSetting: { currentA: 10, confirmed: true } };
  for (const key of ['property', 'easee', 'shelly']) input[key].times = triple(at);
  input.shelly.confirmedAt = at;
  input.easee.evidence.source = 'easee-ocpp';
  return input;
};

test('separate peer and property arrivals cannot stop Shelly or cause a timeout takeover', () => {
  for (const order of ['peer-first', 'property-first']) {
    const limiter = createShellyCurrentLimiter();
    assert.equal(limiter.evaluate(sample(), scope).currentA, 10);
    const next = sample({ at: NOW + 30_000, peer: 0 });
    if (order === 'peer-first') next.property = sample().property;
    else next.easee = sample().easee;
    for (const elapsed of [30_000, 90_000, 3_600_000]) {
      next.now = NOW + elapsed; next.shelly.confirmedAt = next.now;
      const result = limiter.evaluate(next, scope);
      assert.equal(result.currentA, 10); assert.equal(result.measurementPending, true);
      assert.equal(result.modelAvailable, false); assert.equal(result.fallback, false);
    }
    const joined = limiter.evaluate(sample({ at: NOW + 3_601_000, peer: 0 }), scope);
    assert.equal(joined.currentA, 10); assert.equal(joined.measurementPending, undefined);
    assert.deepEqual(joined.baseCurrentA, triple(2));
  }
});

test('household changes wait for actual charger confirmation and then apply the measured budget', () => {
  const limiter = createShellyCurrentLimiter(); limiter.evaluate(sample(), scope);
  const input = sample({ at: NOW + 20_000, household: 9 });
  input.easee = sample().easee;
  assert.equal(limiter.evaluate(input, scope).measurementPending, true);
  input.easee.times = triple(NOW + 30_000); input.now = NOW + 30_000;
  input.shelly.confirmedAt = input.now;
  const confirmed = limiter.evaluate(input, scope);
  assert.equal(confirmed.measurementPending, undefined); assert.equal(confirmed.currentA, 0);
  assert.equal(confirmed.fallback, false); assert.deepEqual(confirmed.baseCurrentA, triple(9));
});

test('separate own-current arrivals hold the confirmed setting without inventing household consumption', () => {
  const limiter = createShellyCurrentLimiter(); limiter.evaluate(sample(), scope);
  const input = sample({ at: NOW + 10_000, own: 10 }); input.property = sample().property;
  assert.equal(limiter.evaluate(input, scope).currentA, 10);
  assert.equal(limiter.evaluate(input, scope).measurementPending, true);
  const joined = limiter.evaluate(sample({ at: NOW + 20_000, own: 10 }), scope);
  assert.equal(joined.currentA, 10); assert.equal(joined.measurementPending, undefined);
});

test('pending observations cannot increase or bypass new restrictions, and outages withdraw held evidence', () => {
  const limiter = createShellyCurrentLimiter(); limiter.evaluate(sample(), scope);
  const input = sample({ at: NOW + 30_000, peer: 0 }); input.property = sample().property;
  assert.equal(limiter.evaluate({ ...input, allocationA: 16, reservationA: 0 }, scope).currentA, 10);
  assert.equal(limiter.evaluate({ ...input, nativeCurrentA: 7 }, scope).currentA, 7);
  assert.equal(limiter.evaluate({ ...input, vehicleCurrentA: 0 }, scope).currentA, 0);
  const failed = limiter.evaluate({ ...input, property: { ...input.property, healthy: false } }, scope);
  assert.equal(failed.fallback, true); assert.equal(failed.measurementPending, undefined);
  const recovered = limiter.evaluate(sample({ at: NOW + 40_000, peer: 0 }), { ...scope, generation: 2 });
  assert.equal(recovered.fallback, false); assert.equal(recovered.currentA, 10);
});


test('unchanged healthy cloud peer state does not block genuine household changes indefinitely', () => {
  const limiter = createShellyCurrentLimiter(), first = sample(); first.easee.evidence.source = 'easee-stream';
  limiter.evaluate(first, scope);
  const next = sample({ at: NOW + 3_600_000, household: 9 }); next.easee = first.easee;
  const result = limiter.evaluate(next, scope);
  assert.equal(result.measurementPending, undefined); assert.equal(result.currentA, 0);
  assert.equal(result.fallback, false); assert.deepEqual(result.baseCurrentA, triple(9));
});

test('simultaneous own and peer changes cannot use an intervening property observation as their combined total', () => {
  const limiter = createShellyCurrentLimiter(); limiter.evaluate(sample(), scope);
  const next = sample({ at: NOW + 20_000, own: 16, peer: 0 });
  next.property = sample({ at: NOW + 12_000, own: 16, peer: 16 }).property;
  next.shelly.times = triple(NOW + 12_000);
  const pending = limiter.evaluate(next, scope);
  assert.equal(pending.measurementPending, true); assert.equal(pending.currentA, 10);
  next.property = sample({ at: NOW + 22_000, own: 16, peer: 0, household: 3 }).property;
  next.now = NOW + 50_000; next.easee.times = triple(next.now); next.shelly.confirmedAt = next.now;
  const result = limiter.evaluate(next, scope);
  assert.equal(result.measurementPending, undefined, 'Unchanged periodic peer reports cannot move the transition forward');
  assert.deepEqual(result.baseCurrentA, triple(3)); assert.equal(result.currentA, 10);
});
