import test from 'node:test';
import assert from 'node:assert/strict';
import { homeHeatingConfirmation } from '../chart/heating-status.js';
import { currentPriceDisplay } from '../chart/current-price.js';

const now = Date.parse('2026-09-15T12:00:00Z');
const home = () => ({ now, input: 'providers', automation: { home: { enabled: true }, garage: { enabled: true } }, decision: { phase: 'normal' },
  observations: { actual: { mode: 'normal', source: 'device-readback', verified: true, observedAt: now - 1000 } } });
test('Home confirmation requires current verified evidence matching the requested phase', () => {
  assert.equal(homeHeatingConfirmation(home()).state, 'confirmed');
  const mismatch = home(); mismatch.observations.actual.mode = 'reduction';
  assert.equal(homeHeatingConfirmation(mismatch).state, 'attention');
  assert.match(homeHeatingConfirmation(mismatch).detail, /Actual reduction does not match/);
  const phaseMismatch = home(); phaseMismatch.decision.phase = 'preheat'; phaseMismatch.observations.actual.phase = 'normal';
  assert.equal(homeHeatingConfirmation(phaseMismatch).state, 'attention');
  delete phaseMismatch.observations.actual.phase;
  assert.match(homeHeatingConfirmation(phaseMismatch).detail, /does not confirm the requested preheat settings/);
  const stale = home(); stale.observations.actual.observedAt = now - 5 * 60_000;
  assert.match(homeHeatingConfirmation(stale).detail, /stale/);
  for (const patch of [{ stale: true }, { verified: false }, { source: 'mqtt-request' }, { observedAt: undefined }, { observedAt: now + 1 }]) {
    const status = home(); Object.assign(status.observations.actual, patch);
    assert.equal(homeHeatingConfirmation(status).state, 'attention', JSON.stringify(patch));
  }
  const held = home(); held.decision.manualHold = { phase: 'reduction', until: now + 60_000 };
  held.observations.actual.mode = 'reduction';
  assert.equal(homeHeatingConfirmation(held).state, 'confirmed', 'the held request overrides the automatic plan');
});

test('Home confirmation retains simulation, pending delivery, restoration, alarms and native-setting mismatches', () => {
  for (const patch of [{ input: 'simulated' }, { role: 'slave' },
    { execution: { status: 'pending' } }, { execution: { status: 'failed' } }, { execution: { restorationPending: true } },
    { h66: { enabled: true, connected: false } }]) {
    assert.equal(homeHeatingConfirmation({ ...home(), ...patch }).state, 'attention', JSON.stringify(patch));
  }
  const status = home(); status.h66 = { connected: true, readings: {
    '1A20': { value: 1, available: true, observedAt: now } } };
  assert.match(homeHeatingConfirmation(status).detail, /active alarm/);
  status.h66 = { connected: true, requested: { '0203': 22 }, readings: {
    '0203': { value: 20, available: true, observedAt: now } } };
  assert.match(homeHeatingConfirmation(status).detail, /awaiting matching current readbacks/);
  status.h66.readings['0203'].value = 22;
  assert.equal(homeHeatingConfirmation(status).state, 'confirmed');
  const unverified = home(); unverified.observations.actual.source = 'mqtt-request';
  unverified.h66 = { connected: true, readings: { '1A01': { value: 1, available: true, observedAt: now } } };
  assert.equal(homeHeatingConfirmation(unverified).state, 'attention', 'compressor activity cannot verify the tariff relay');
  assert.match(homeHeatingConfirmation(unverified).detail, /tariff relay has no verified device readback/);
});

test('Home manual requests are confirmed from relay feedback while automatic control is disabled', () => {
  const status = home();
  status.automation.home.enabled = false;
  status.decision.phase = 'normal';
  Object.assign(status.observations.actual, { source: 'equipment-state-readback', stale: false,
    requestedPhase: 'reduction', phase: 'reduction', mode: 'reduction' });
  assert.equal(homeHeatingConfirmation(status).state, 'confirmed');
  assert.match(homeHeatingConfirmation(status).detail, /device feedback still verifies manual requests/);
  status.observations.actual.verified = false;
  assert.equal(homeHeatingConfirmation(status).state, 'attention');
  status.observations.actual.verified = true;
  status.observations.actual.stale = true;
  assert.equal(homeHeatingConfirmation(status).state, 'attention');
});

test('both heating summaries use the same current all-in rate, spot fallback and simulation provenance', () => {
  const status = { now, prices: [
    { start: now - 900_000, end: now, allInCentsPerKWh: 99 },
    { start: now, end: now + 900_000, allInCentsPerKWh: 7.71, spotCtPerKwh: 2.3 },
  ] };
  const price = currentPriceDisplay(status);
  assert.equal(price.value, '7.71'); assert.equal(price.label, 'ALL-IN PRICE'); assert.equal(price.unit, 'c/kWh');
  assert.match(price.detail, /including variable charges/); assert.match(price.detail, /Spot price: 2.30/);
  const spot = currentPriceDisplay({ now, prices: [], spot: [{ start: now, end: now + 900_000, spotCtPerKwh: -1.1 }] });
  assert.equal(spot.value, '-1.10'); assert.equal(spot.label, 'SPOT PRICE'); assert.match(spot.detail, /excludes VAT/);
  const missing = currentPriceDisplay({ now: now + 900_000, prices: status.prices, priceStatus: 'missing-market-data' });
  assert.equal(missing.value, '—'); assert.equal(missing.unit, ''); assert.match(missing.detail, /Waiting for market prices/);
  const simulation = currentPriceDisplay({ ...status, input: 'simulated' });
  assert.equal(simulation.label, 'EXAMPLE ALL-IN PRICE'); assert.match(simulation.detail, /Synthetic simulation data/);
});
