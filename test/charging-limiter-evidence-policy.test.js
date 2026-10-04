import test from 'node:test';
import assert from 'node:assert/strict';
import { shellyCurrentLimit } from '../src/charging/shelly-limit.js';
import { ChargingRuntime } from '../src/charging/runtime.js';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const triple = value => [value, value, value];
const config = { maximumCurrentA: 16, minimumCurrentA: 6, currentStepA: 1, fallbackCurrentA: 12,
  mainFuseA: triple(25), marginA: triple(1), maxAgeMs: 15_000, agreementToleranceA: 2 };
const held = (currents, epoch = '1:0') => ({ healthy: true, currents, times: triple(NOW - 3_600_000),
  evidence: { source: 'easee-stream', connected: true, online: true, synchronized: true, epoch,
    receivedAt: NOW - 3_600_000, activityAt: null, sourceAt: null } });
const native = currents => ({ healthy: true, currents, times: triple(NOW), evidence: {
  source: 'easee-ocpp', connected: true, online: true, synchronized: true, epoch: 'synthetic-connection',
  receivedAt: NOW, activityAt: NOW, sourceAt: NOW } });
const fixture = () => ({ config, now: NOW, priority: 'charger2', liveUnscheduled: true,
  property: held(triple(8)), easee: native(triple(0)), allowance: held(triple(17)),
  shelly: { healthy: true, currents: triple(0), times: triple(NOW) } });

test('synchronized online held values allow the full pilot without converting them into new measurements', () => {
  const input = fixture(), before = structuredClone(input);
  const result = shellyCurrentLimit(input);
  assert.equal(result.currentA, 16);
  assert.equal(result.fallback, false);
  assert.deepEqual(input, before, 'Evaluation must not renew timestamps or mutate observations');
});

test('Shelly priority retains 16A through Equalizer zero clipping, peer excess and stale forecast reservations', () => {
  const input = fixture();
  input.property = held(triple(40));
  input.easee = native(triple(16));
  input.shelly.currents = triple(16);
  input.allowance = held(triple(0));
  input.reservationA = 16;
  input.allocationA = 0;
  for (const liveUnscheduled of [true, false]) {
    const result = shellyCurrentLimit({ ...input, liveUnscheduled });
    assert.equal(result.currentA, 16, 'Household 8A plus Shelly 16A fits the 25A fuse with 1A reserve; Easee must yield');
    assert.equal(result.fallback, false, 'A clipped zero allowance does not disprove the property budget');
  }
});

test('a native Equalizer delay or reserve cannot double-subtract the configured margin from Shelly entitlement', () => {
  for (const lowerAllowance of [15, 16, 17]) {
    const input = fixture(); input.allowance = held(triple(lowerAllowance));
    const result = shellyCurrentLimit(input);
    assert.equal(result.currentA, 16);
    assert.equal(result.fallback, false);
  }
});

test('a materially lower allowance contradicts held low property load and triggers fallback', () => {
  const input = fixture(); input.allowance = held(triple(0));
  const result = shellyCurrentLimit(input);
  assert.equal(result.currentA, 12);
  assert.equal(result.fallback, true);
  assert.equal(result.fallbackReason, 'allowance-disagreement');
});

test('valid insufficient property capacity pauses dynamically instead of selecting 12A fallback', () => {
  const input = fixture();
  input.property = held([22, 24, 25]); input.allowance = held([3, 1, 0]);
  const result = shellyCurrentLimit(input);
  assert.equal(result.currentA, 0);
  assert.equal(result.pause, true);
  assert.equal(result.fallback, false);
  assert.equal(result.reason, 'fuse-limit');
});

test('lost or contradictory allowance still preserves independently known tighter property and priority bounds', () => {
  for (const kind of ['disconnected', 'unsynchronized', 'optimistic-allowance']) {
    const input = fixture(); input.property = held(triple(20)); input.allowance = held(triple(5));
    if (kind === 'disconnected') input.allowance.evidence.connected = false;
    if (kind === 'unsynchronized') input.allowance.evidence.synchronized = false;
    if (kind === 'optimistic-allowance') input.allowance.currents = triple(25);
    let result = shellyCurrentLimit(input);
    assert.equal(result.currentA, 0, `${kind}: the fallback cap cannot override a known 4A property ceiling`);
    assert.equal(result.fallback, true);
    input.property = held(triple(8));
    input.priority = 'charger1'; input.peerDemandA = 16;
    result = shellyCurrentLimit(input);
    assert.equal(result.currentA, 0, `${kind}: Easee priority reserves demand even before actual current ramps`);
    assert.equal(result.fallback, true);
  }
});

test('held phase timestamps never authorize a disconnected, offline or unsynchronized stream generation', () => {
  for (const [field, value] of [['connected', false], ['online', false], ['synchronized', false], ['epoch', null]]) {
    const input = fixture(); input.property.evidence[field] = value;
    const result = shellyCurrentLimit(input);
    assert.equal(result.currentA, 12, field);
    assert.equal(result.fallback, true, field);
  }
  const input = fixture(); input.property.evidence.epoch = '2:0';
  assert.equal(shellyCurrentLimit(input).currentA, 16, 'A newly synchronized product epoch can supply held state again');
});

test('Shelly contribution is conservative under every phase permutation', () => {
  const input = fixture(); input.property = held([20, 21, 24]); input.easee = native(triple(2));
  input.allowance = held([7, 6, 3]);
  for (const currents of [[14.5, 15, 16], [14.5, 16, 15], [15, 14.5, 16], [15, 16, 14.5], [16, 14.5, 15], [16, 15, 14.5]]) {
    input.shelly.currents = currents;
    const result = shellyCurrentLimit(input);
    assert.equal(result.currentA, 16);
    assert.deepEqual(result.baseCurrentA, [3.5, 4.5, 7.5]);
    assert.equal(result.fallback, false);
  }
});

test('recent native meter receipts are separate from permissive held stream clocks', () => {
  for (const age of [120_001, -1]) {
    const input = fixture(); input.easee.evidence.receivedAt = NOW - age; input.easee.evidence.activityAt = NOW - age;
    const result = shellyCurrentLimit(input);
    assert.equal(result.currentA, 12);
    assert.equal(result.fallback, true);
  }
});

test('allocation context transfers independent field evidence without polling or writing Easee', () => {
  const input = fixture(); let reads = 0;
  const supply = { propertyCurrentA: input.property.currents, chargerCurrentA: input.easee.currents,
    availableCurrentA: input.allowance.currents, observationTimes: { property: input.property.times,
      charger: input.easee.times, allowance: input.allowance.times }, feedEvidence: {
      property: input.property.evidence, charger: input.easee.evidence, allowance: input.allowance.evidence } };
  const fake = { chargers: { charger1: { adapter: { readCurrentSupply() { reads++; return { online: true, supply }; } } } },
    clock: () => NOW, settings: { priority: 'charger2' }, coordination: { allocations: [] },
    views: () => [{ id: 'charger2', settings: { enabled: true }, values: {}, control: {} }] };
  const result = ChargingRuntime.prototype.allocationContext.call(fake);
  assert.equal(reads, 1);
  assert.deepEqual(result.property, input.property);
  assert.deepEqual(result.easee, input.easee);
  assert.deepEqual(result.allowance, input.allowance);
  assert.equal(result.allocationA, null);
  assert.equal(result.reservationA, 0);
});
