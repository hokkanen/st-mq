import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreChargingProgress, updateChargingProgress } from '../src/charging/progress.js';

const now = Date.parse('2026-09-15T00:00:00Z'), MINUTE = 60_000;
const value = (number, extra = {}) => ({ value: number, available: true, assumed: false, source: 'test', ...extra });
const charger = (at = now, powerKw = 6, extra = {}) => ({ id: 'charger1', requiredGridKwh: 40,
  configuration: { efficiency: .9 }, telemetry: {},
  values: { connected: value(true), powerKw: value(powerKw, { measuredAt: at }),
    soc: value(20, { source: 'manual-fallback', assumed: true }), capacityKwh: value(60), minimumSoc: value(80), ...extra } });

test('adjacent measured power contributes trapezoidal grid energy without altering the SoC', () => {
  const initial = updateChargingProgress(null, charger(), now);
  assert.equal(initial.state.creditKwh, 0);
  const input = charger(now + MINUTE, 12), original = structuredClone(input);
  const next = updateChargingProgress(initial.state, input, now + MINUTE);
  assert.ok(Math.abs(next.state.creditKwh - .15) < 1e-9);
  assert.ok(Math.abs(next.remainingGridKwh - 39.85) < 1e-9);
  assert.equal(next.basis.source, 'integrated-measured-power');
  assert.equal(next.basis.status, 'tracking');
  assert.deepEqual(input, original);
  assert.deepEqual(Object.keys(next.state).sort(), ['connected', 'creditKwh', 'lastSample', 'reference']);
});

test('duplicate, reordered and conflicting power samples cannot invent delivered energy', () => {
  let result = updateChargingProgress(null, charger(), now);
  result = updateChargingProgress(result.state, charger(now + MINUTE), now + MINUTE);
  assert.equal(result.state.creditKwh, .1);
  const duplicate = updateChargingProgress(result.state, charger(now + MINUTE), now + MINUTE + 1000);
  assert.equal(duplicate.state.creditKwh, .1);
  assert.equal(duplicate.state.lastSample.observedAt, now + MINUTE);
  const older = updateChargingProgress(duplicate.state, charger(now), now + MINUTE + 2000);
  assert.equal(older.state.creditKwh, .1);
  assert.equal(older.state.lastSample.measuredAt, now + MINUTE);
  const conflict = updateChargingProgress(older.state, charger(now + MINUTE, 8), now + MINUTE + 3000);
  assert.equal(conflict.state.creditKwh, .1);
  assert.equal(conflict.state.lastSample, null);
});

test('unknown connection and provider interruption preserve credit but break measurement continuity', () => {
  let result = updateChargingProgress(null, charger(), now);
  result = updateChargingProgress(result.state, charger(now + MINUTE), now + MINUTE);
  const input = charger(now + 2 * MINUTE);
  input.telemetry.providerConnected = false;
  result = updateChargingProgress(result.state, input, now + 2 * MINUTE);
  assert.equal(result.state.creditKwh, .1);
  assert.equal(result.state.lastSample, null);
  assert.equal(result.basis.status, 'connection-unknown');
  result = updateChargingProgress(result.state, charger(now + 3 * MINUTE), now + 3 * MINUTE);
  assert.equal(result.state.creditKwh, .1);
  assert.equal(result.basis.status, 'awaiting-next-power-measurement');
  const unplugged = updateChargingProgress(result.state, charger(now + 4 * MINUTE, 0, { connected: value(false) }), now + 4 * MINUTE);
  assert.equal(unplugged.state.creditKwh, 0);
  assert.equal(unplugged.state.reference, null);
  const reconnected = updateChargingProgress(unplugged.state, charger(now + 5 * MINUTE), now + 5 * MINUTE);
  assert.equal(reconnected.state.creditKwh, 0);
});

test('startup, long measurement gaps and receipt-only power never receive guessed energy credit', () => {
  let result = updateChargingProgress(null, charger(), now);
  result = updateChargingProgress(result.state, charger(now + MINUTE), now + MINUTE);
  const restored = restoreChargingProgress(JSON.parse(JSON.stringify(result.state)));
  assert.equal(restored.creditKwh, .1);
  assert.equal(restored.lastSample, null);
  const restart = updateChargingProgress(restored, charger(now + 2 * MINUTE), now + 2 * MINUTE);
  assert.equal(restart.state.creditKwh, .1);
  const gap = updateChargingProgress(result.state, charger(now + 4 * MINUTE), now + 4 * MINUTE);
  assert.equal(gap.state.creditKwh, .1);
  assert.equal(gap.basis.status, 'measurement-gap');
  const receipt = updateChargingProgress(result.state, charger(now + 2 * MINUTE, 6, {
    powerKw: value(6, { measuredAt: null, receivedAt: now + 2 * MINUTE }),
  }), now + 2 * MINUTE);
  assert.equal(receipt.state.creditKwh, .1);
  assert.equal(receipt.state.lastSample, null);
});

test('new SoC or changed capacity, target and efficiency create a new energy reference', () => {
  let result = updateChargingProgress(null, charger(), now);
  result = updateChargingProgress(result.state, charger(now + MINUTE), now + MINUTE);
  for (const changed of [
    { soc: value(21, { source: 'mqtt', readingId: 'new-reading', measuredAt: now + 2 * MINUTE }) },
    { soc: value(25, { source: 'manual-fallback', assumed: true }) },
    { capacityKwh: value(65) }, { minimumSoc: value(90) },
  ]) {
    const next = updateChargingProgress(result.state, charger(now + 2 * MINUTE, 6, changed), now + 2 * MINUTE);
    assert.equal(next.state.creditKwh, 0);
    assert.equal(next.basis.status, 'reference-established');
  }
  const input = charger(now + 2 * MINUTE); input.configuration.efficiency = .85;
  assert.equal(updateChargingProgress(result.state, input, now + 2 * MINUTE).state.creditKwh, 0);
});

test('power credit cannot precede the SoC measurement or exceed the requested grid energy', () => {
  const soc = value(20, { source: 'mqtt', readingId: 'future-reading', measuredAt: now + MINUTE / 2 });
  let result = updateChargingProgress(null, charger(now, 6, { soc }), now);
  result = updateChargingProgress(result.state, charger(now + MINUTE, 12, { soc }), now + MINUTE);
  assert.ok(Math.abs(result.state.creditKwh - .0875) < 1e-9);
  const input = charger(now + 2 * MINUTE, 12, { soc }); input.requiredGridKwh = .1;
  const capped = updateChargingProgress(result.state, input, now + 2 * MINUTE);
  assert.equal(capped.state.creditKwh, .1);
  assert.equal(capped.remainingGridKwh, 0);
});

test('continuous zero-power coverage distinguishes undelivered charging from missing measurements', () => {
  let result = updateChargingProgress(null, charger(now, 0), now);
  for (let minute = 1; minute <= 3; minute++)
    result = updateChargingProgress(result.state, charger(now + minute * MINUTE, 0), now + minute * MINUTE);
  assert.equal(result.state.creditKwh, 0);
  assert.equal(result.remainingGridKwh, 40);
  assert.equal(result.basis.continuousSince, now);
  assert.equal(result.basis.lastMeasuredAt, now + 3 * MINUTE);
  const restarted = updateChargingProgress(restoreChargingProgress(result.state), charger(now + 4 * MINUTE, 0), now + 4 * MINUTE);
  assert.equal(restarted.basis.continuousSince, now + 4 * MINUTE, 'Restart cannot certify the preceding period');
  const gap = updateChargingProgress(result.state, charger(now + 6 * MINUTE, 0), now + 6 * MINUTE);
  assert.equal(gap.basis.continuousSince, now + 6 * MINUTE, 'A gap starts new measurement coverage');
  const unknown = updateChargingProgress(result.state, charger(now + 4 * MINUTE, 0, {
    powerKw: value(0, { receivedAt: now + 4 * MINUTE }),
  }), now + 4 * MINUTE);
  assert.equal(unknown.basis.continuousSince, null, 'Receipt-only zero power does not establish coverage');
});
