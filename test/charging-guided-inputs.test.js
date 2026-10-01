import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingTestReadings } from '../chart/charging-tests.js';
import { chargingTestClock, nextChargingTestTime } from '../chart/charging-test-time.js';

const now = Date.parse('2026-09-30T20:15:00Z');
const reading = (value, metadata = {}) => ({ value, available: true, measuredAt: now - 600_000,
  receivedAt: now - 120_000, timeBasis: 'measurement', ...metadata });
const status = (bmw = {}, tesla = {}) => ({ now, charging: { chargers: [],
  settings: { vehicles: { bmw: { capacityKwh: 74 }, tesla: { capacityKwh: 57 } } },
  vehicleFeeds: [{ id: 'bmw', setup: { fields: bmw } }, { id: 'tesla', setup: { fields: tesla } }] } });

test('preparation loads BMW readings without a charger and retains their original measurement clocks', () => {
  const values = chargingTestReadings(status({ soc: reading(0), minimumSoc: reading(85), capacityKwh: reading(71) }), 'bmw');
  assert.equal(values.soc.value, 0);
  assert.equal(values.nativeTargetSoc.value, 85);
  assert.equal(values.capacityKwh.value, 71);
  assert.equal(values.capacityKwh.source, 'BMW CarData');
  assert.equal(values.soc.at, now - 600_000);
  assert.equal(values.soc.timeBasis, 'measurement');
  assert.equal(values.vehicleStartAt, undefined);
  assert.equal(chargingTestReadings(status({ soc: reading(100) }), 'bmw').soc.value, 100,
    'A full battery remains visible so preparation can explain insufficient headroom');
});

test('Tesla uses receipt provenance, configured capacity and only a future reported schedule', () => {
  const state = status({}, { soc: reading(40, { timeBasis: 'receipt-only' }),
    minimumSoc: reading(80, { timeBasis: 'receipt-only' }),
    vehicleNotBefore: reading(now + 3600_000, { timeBasis: 'receipt-only' }) });
  const values = chargingTestReadings(state, 'tesla');
  assert.equal(values.soc.at, now - 120_000);
  assert.equal(values.soc.source, 'TeslaMate');
  assert.equal(values.capacityKwh.value, 57);
  assert.equal(values.capacityKwh.source, 'Configured usable capacity');
  assert.equal(values.capacityKwh.at, null);
  assert.equal(values.vehicleStartAt.value, now + 3600_000);
  state.charging.vehicleFeeds[1].setup.fields.vehicleNotBefore.value = now - 1;
  assert.equal(chargingTestReadings(state, 'tesla').vehicleStartAt, undefined);
});

test('missing, unavailable and invalid values stay empty instead of borrowing another vehicle or configured targets', () => {
  const state = status({ soc: reading(60, { available: false }), minimumSoc: reading(null), capacityKwh: reading(0) },
    { soc: reading(35), minimumSoc: reading(90) });
  state.charging.settings.vehicles.bmw.minimumSoc = 80;
  state.charging.settings.vehicles.bmw.manualSoc = 20;
  const values = chargingTestReadings(state, 'bmw');
  assert.equal(values.soc, undefined);
  assert.equal(values.nativeTargetSoc, undefined);
  assert.equal(values.capacityKwh.value, 74);
  delete state.charging.settings;
  assert.deepEqual(chargingTestReadings(state, 'bmw'), {});
});

test('time-only vehicle schedules use installation day instead of browser time, including midnight and year boundaries', () => {
  assert.equal(chargingTestClock(now, 'Europe/Helsinki'), '23:15');
  assert.equal(nextChargingTestTime('23:45', 'Europe/Helsinki', now), Date.parse('2026-09-30T20:45:00Z'));
  assert.equal(nextChargingTestTime('00:30', 'Europe/Helsinki', now), Date.parse('2026-09-30T21:30:00Z'));
  assert.equal(nextChargingTestTime('23:15', 'Europe/Helsinki', now), Date.parse('2026-10-01T20:15:00Z'));
  assert.equal(nextChargingTestTime('00:30', 'Europe/Helsinki', Date.parse('2026-12-31T21:30:00Z')),
    Date.parse('2026-12-31T22:30:00Z'));
});

test('time-only schedules respect calendar days across DST and reject ambiguous or missing local times', () => {
  assert.equal(nextChargingTestTime('04:30', 'Europe/Helsinki', Date.parse('2026-03-28T20:00:00Z')),
    Date.parse('2026-03-29T01:30:00Z'));
  assert.equal(nextChargingTestTime('04:30', 'Europe/Helsinki', Date.parse('2026-10-24T20:00:00Z')),
    Date.parse('2026-10-25T02:30:00Z'));
  for (const date of ['2026-03-28T20:00:00Z', '2026-10-24T20:00:00Z']) {
    assert.throws(() => nextChargingTestTime('03:30', 'Europe/Helsinki', Date.parse(date)), /unambiguous/);
  }
  for (const value of ['', '3:30', '24:00', '12:60', '2026-10-01T12:00']) {
    assert.throws(() => nextChargingTestTime(value, 'Europe/Helsinki', now), /HH:mm/);
  }
});
