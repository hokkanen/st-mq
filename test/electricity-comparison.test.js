import test from 'node:test';
import assert from 'node:assert/strict';
import { comparableElectricitySnapshot, settledElectricitySnapshot } from '../src/acquisition/electricity-comparison.js';

const now = Date.parse('2026-01-01T12:00:00Z');
const snapshot = overrides => ({ powerKw: 11, sourceTime: now - 15_000, receivedAt: now, ...overrides });
const held = overrides => snapshot({ sourceTime: now - 7 * 60_000, telemetryAt: now - 30_000,
  telemetryConfirmed: true, ...overrides });

test('fresh electrical power remains comparable through the receipt and source age boundaries', () => {
  assert.equal(comparableElectricitySnapshot(snapshot(), now), true);
  assert.equal(comparableElectricitySnapshot(snapshot({ powerKw: 0 }), now), true);
  assert.equal(comparableElectricitySnapshot(snapshot({ sourceTime: now - 60_000, receivedAt: now - 60_000 }), now), true);
  assert.equal(comparableElectricitySnapshot(snapshot({ sourceTime: now - 60_001 }), now), false);
  assert.equal(comparableElectricitySnapshot(snapshot({ sourceTime: now - 60_001, receivedAt: now - 60_001 }), now), false);
});

test('established device telemetry permits held power without changing its original measurement timestamp', () => {
  const input = Object.freeze(held()), original = structuredClone(input);
  assert.equal(comparableElectricitySnapshot(input, now), true);
  assert.deepEqual(input, original);
  assert.equal(input.sourceTime, now - 7 * 60_000);
  const boundary = held({ sourceTime: now - 60 * 60_000, telemetryAt: now - 17 * 60_000 });
  assert.equal(comparableElectricitySnapshot(boundary, now), true);
  assert.equal(comparableElectricitySnapshot({ ...boundary, telemetryAt: boundary.telemetryAt - 1 }, now), false);
});

test('HTTP polls and cached connection state cannot authorize unsupported stale power', () => {
  for (const input of [
    held({ telemetryConfirmed: false }), held({ telemetryConfirmed: undefined }),
    held({ telemetryConfirmed: undefined, connected: true }), held({ telemetryConfirmed: 'true' }),
    held({ telemetryAt: null }), held({ telemetryAt: now - 8 * 60_000 }),
    held({ receivedAt: now - 60_001 }), held({ connected: false }),
  ]) assert.equal(comparableElectricitySnapshot(input, now), false);
});

test('invalid and future measurements never establish comparability', () => {
  for (const input of [null, {}, snapshot({ powerKw: NaN }), snapshot({ powerKw: -1 }),
    snapshot({ sourceTime: now + 1 }), snapshot({ sourceTime: null }),
    snapshot({ sourceTime: now, receivedAt: now - 1 }), snapshot({ receivedAt: now + 1 }),
    snapshot({ receivedAt: null }), held({ telemetryAt: now + 1 }),
    held({ telemetryAt: now, receivedAt: now - 1 }), snapshot({ connected: false }),
  ]) assert.equal(comparableElectricitySnapshot(input, now), false);
  assert.equal(comparableElectricitySnapshot(snapshot(), NaN), false);
});

test('new source measurements become settled only after the configured post-ramp interval', () => {
  const changedAt = now - 10_000;
  assert.equal(settledElectricitySnapshot(snapshot({ sourceTime: changedAt + 5_000 }), now, changedAt), true);
  assert.equal(settledElectricitySnapshot(snapshot({ sourceTime: changedAt + 4_999 }), now, changedAt), false);
  assert.equal(settledElectricitySnapshot(snapshot({ sourceTime: changedAt - 1 }), now, changedAt), false);
});

test('held power needs confirmed telemetry and a successful poll after the longer ramp grace period', () => {
  const changedAt = now - 20_000;
  assert.equal(settledElectricitySnapshot(held(), now, changedAt), true);
  assert.equal(settledElectricitySnapshot(held(), now, changedAt + 1), false);
  assert.equal(settledElectricitySnapshot(held({ receivedAt: now - 1 }), now, changedAt), false);
  assert.equal(settledElectricitySnapshot(held({ receivedAt: changedAt - 1 }), now, changedAt), false);
  assert.equal(settledElectricitySnapshot(held({ telemetryConfirmed: false }), now, changedAt), false);
  // A still-recent but pre-ramp power needs the same independent device support.
  assert.equal(settledElectricitySnapshot(snapshot({ sourceTime: changedAt - 1 }), now, changedAt), false);
  assert.equal(settledElectricitySnapshot(snapshot({ sourceTime: changedAt - 1, telemetryConfirmed: true,
    telemetryAt: now - 10_000 }), now, changedAt), true);
});

test('custom bounds remain consistent and do not bypass invalid change timestamps', () => {
  assert.equal(comparableElectricitySnapshot(held(), now, { maxTelemetryAgeMs: 20_000 }), false);
  assert.equal(comparableElectricitySnapshot(snapshot(), now, { maxAgeMs: 10_000 }), false);
  assert.equal(settledElectricitySnapshot(held(), now, now - 30_000,
    { settleMs: 30_000, heldSettleMs: 20_000 }), true);
  assert.equal(settledElectricitySnapshot(held(), now, now - 29_999,
    { settleMs: 30_000, heldSettleMs: 20_000 }), false);
  for (const changedAt of [null, undefined, NaN, -1, now + 1])
    assert.equal(settledElectricitySnapshot(held(), now, changedAt), false);
  assert.equal(settledElectricitySnapshot(held(), now, now - 30_000, { settleMs: -1 }), false);
});
