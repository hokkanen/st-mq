import test from 'node:test';
import assert from 'node:assert/strict';
import { homeHeatingConfirmation, garageHeatingConfirmation, garageNativeReadingFresh } from '../chart/heating-status.js';
import { currentPriceDisplay } from '../chart/current-price.js';

const now = Date.parse('2026-09-15T12:00:00Z');
const home = () => ({ now, input: 'providers', mode: 'active', liveWrites: true, decision: { phase: 'normal' },
  observations: { actual: { mode: 'normal', source: 'device-readback', verified: true, observedAt: now - 1000 } } });
const garage = () => ({ now, input: 'providers', garage: { settings: { maxSensorAgeMs: 120_000 }, heatingControls: { confirmed: true },
  adapter: { connected: true, health: { deviceOnline: true, pumpCommunicating: true, driverProgressing: true },
    native: { power: 'on', powerAt: now - 1000 } } } });

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
  status.mode = 'shadow';
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

test('Garage confirmation requires fresh matching native power and healthy communication', () => {
  assert.equal(garageHeatingConfirmation(garage(), 'Normal').state, 'confirmed');
  const status = garage(); status.garage.adapter.native.power = 'off';
  assert.equal(garageHeatingConfirmation(status, 'Reduction').state, 'confirmed');
  assert.match(garageHeatingConfirmation(status, 'Normal').detail, /power is off; the request needs power on/);
  for (const at of [undefined, now + 1, now - 120_000]) {
    status.garage.adapter.native.powerAt = at;
    status.garage.heatingControls.confirmed = false;
    assert.equal(garageHeatingConfirmation(status, 'Off').state, 'attention');
  }
  for (const field of ['deviceOnline', 'pumpCommunicating', 'driverProgressing']) {
    const unhealthy = garage(); unhealthy.garage.adapter.health[field] = false;
    assert.equal(garageHeatingConfirmation(unhealthy, 'Normal').state, 'attention');
  }
  const disconnected = garage(); disconnected.garage.adapter.connected = false;
  assert.match(garageHeatingConfirmation(disconnected, 'Normal').detail, /communication is not confirmed/);
  const unqualified = garage(); unqualified.garage.adapter.native.readbacks = { power: { measuredAt: now, usable: false } };
  assert.equal(garageHeatingConfirmation(unqualified, 'Normal').state, 'attention');
});

test('Garage matching power cannot hide simulation, pending commands, faults or restoration', () => {
  for (const patch of [{ simulation: true }, { restorePending: true }, { faults: ['native-result-unresolved'] },
    { lastCommand: { status: 'published', requestedAt: now - 5000 } },
    { lastCommand: { status: 'accepted', requestedAt: now } },
    { lastCommand: { status: 'failed' } }]) {
    const status = garage(); Object.assign(status.garage.adapter, patch);
    assert.equal(garageHeatingConfirmation(status, 'Normal').state, 'attention', JSON.stringify(patch));
  }
  assert.equal(garageHeatingConfirmation({ ...garage(), role: 'slave' }, 'Normal').state, 'attention');
  const paused = garage(); Object.assign(paused.garage.adapter, { phase: 'paused', restorePending: true });
  paused.garage.adapter.native.power = 'off';
  assert.equal(garageHeatingConfirmation(paused, 'Reduction').state, 'confirmed', 'a valid OFF lease has a future restoration obligation');
  assert.match(garageHeatingConfirmation(garage(), 'Normal').detail, /do not confirm compressor activity/);
});

test('Garage room-sensor age cannot extend native power freshness or override controller confirmation', () => {
  const status = garage();
  status.garage.settings.maxSensorAgeMs = 10 * 60_000;
  status.garage.adapter.native.powerAt = now - 5 * 60_000;
  status.garage.heatingControls.confirmed = false;
  assert.equal(garageHeatingConfirmation(status, 'Normal').state, 'attention');
  assert.equal(garageNativeReadingFresh(status.garage, 'power', now), false);
  assert.doesNotMatch(garageHeatingConfirmation(status, 'Normal').detail, /current native readback/);
  status.garage.adapter.native.powerAt = now - 45_000;
  status.garage.heatingControls.confirmed = false;
  assert.equal(garageHeatingConfirmation(status, 'Normal').state, 'attention', 'the backend enforces a shorter configured adapter age');
  assert.equal(garageNativeReadingFresh(status.garage, 'power', now), false);
  assert.doesNotMatch(garageHeatingConfirmation(status, 'Normal').detail, /current native readback/);
  delete status.garage.heatingControls;
  assert.equal(garageHeatingConfirmation(status, 'Normal').state, 'attention', 'missing authoritative confirmation cannot become green');
  status.garage.adapter.native.powerAt = now - 5 * 60_000;
  status.garage.heatingControls = { confirmed: true };
  assert.equal(garageHeatingConfirmation(status, 'Normal').state, 'confirmed', 'a longer backend adapter age remains authoritative');
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
