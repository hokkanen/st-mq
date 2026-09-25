import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingSettings, mergeChargingSettings } from '../src/charging/settings.js';
import { buildCharger, CHARGER_DEFINITIONS } from '../src/charging/model.js';
import { acceptSocReading } from '../src/charging/soc.js';

const now = Date.parse('2026-01-15T00:00:00Z');
const config = chargingSettings();
const make = (index = 0, extra = {}) => buildCharger({ definition: CHARGER_DEFINITIONS[index],
  settings: config.chargers[CHARGER_DEFINITIONS[index].id], now, ...extra });

test('both unidentified chargers share config defaults and session patches remain independently validated', () => {
  assert.deepEqual(Object.keys(config.chargers.charger1), Object.keys(config.chargers.charger2));
  assert.deepEqual(Object.values(config.chargers).map(item => [item.enabled, item.minimumSoc, item.readyBy, item.manualSoc, item.capacityKwh]),
    [[false, 80, '06:00', 20, 74], [false, 80, '06:00', 20, 74]]);
  const saved = mergeChargingSettings(config, { chargers: { charger2: { capacityKwh: 60, manualSoc: 35 } } });
  assert.equal(saved.chargers.charger1.capacityKwh, 74);
  assert.equal(saved.chargers.charger2.manualSoc, 35);
  assert.deepEqual(chargingSettings(JSON.parse(JSON.stringify(saved))), saved);
  assert.throws(() => chargingSettings({ installation: { charger1MaxA: 32 } }), /Unknown/);
  assert.throws(() => mergeChargingSettings(config, { chargers: { charger1: { currentA: 32 } } }), /Unknown/);
  for (const patch of [{ timezone: 'UTC' }, { readinessMarginMinutes: 10 },
    { chargers: { charger1: { mqttTopic: 'garage/vehicle' } } }, { chargers: { charger2: { efficiency: .8 } } }])
    assert.throws(() => mergeChargingSettings(config, patch), /Unknown/);
});

test('retired native charging settings are rejected instead of translated', () => {
  for (const old of [{enabled:true,capacity1Kwh:62}, {timezone:'UTC'}, {chargers:{charger1:{efficiency:.925}}}])
    assert.throws(() => chargingSettings(old));
});

test('each charger uses valid automatic capacity and target before identical manual fallbacks', () => {
  for (const index of [0, 1]) {
    const charger = make(index, { telemetry: { capacityKwh: { value: 65, source: 'vehicle', measuredAt: now - 1000 },
      minimumSoc: { value: 90, source: 'vehicle' }, soc: { value: 50, source: 'vehicle' } } });
    assert.equal(charger.values.capacityKwh.value, 65);
    assert.equal(charger.values.capacityKwh.source, 'vehicle');
    assert.equal(charger.values.minimumSoc.value, 90);
    assert.equal(charger.requiredGridKwh, 65 * .4 / .925);
    const fallback = make(index, { telemetry: { capacityKwh: -1, minimumSoc: 101, soc: null } });
    assert.equal(fallback.values.capacityKwh.value, config.chargers[fallback.id].capacityKwh);
    assert.equal(fallback.values.minimumSoc.value, 80);
    assert.equal(fallback.values.soc.value, 20);
    assert.equal(fallback.values.soc.source, 'manual-fallback');
    assert.equal(fallback.values.soc.assumed, true);
    assert.equal(fallback.values.connected.available, false);
    assert.equal(fallback.values.currentA.available, false);
  }
});

test('automatic SoC always wins and the remembered fallback remains available without an expiry', () => {
  const settings = { ...config.chargers.charger2, manualSoc: 35 };
  const automaticSoc = { soc: 61, measuredAt: now + 60_000, receivedAt: now + 120_000 };
  const automatic = make(1, { now: now + 180_000, settings, automaticSoc });
  assert.equal(automatic.values.soc.value, 61);
  assert.equal(automatic.values.soc.source, 'mqtt');
  assert.equal(automatic.values.soc.measuredAt, now + 60_000);
  assert.equal(automatic.values.soc.receivedAt, now + 120_000);
  assert.equal(automatic.settings.manualSoc, 35);
  assert.equal(Object.hasOwn(automatic.values.soc, 'expiresAt'), false);
  const fallback = make(1, { now: now + 48 * 3_600_000, settings: JSON.parse(JSON.stringify(settings)) });
  assert.equal(fallback.values.soc.value, 35);
  assert.equal(fallback.values.soc.source, 'manual-fallback');
});

test('grid energy applies the explicit fixed 7.5% modeling assumption', () => {
  const charger = make(0, { configuration: {},
    telemetry: { capacityKwh: 60, soc: 40, minimumSoc: 80 } });
  assert.equal(charger.requiredGridKwh, 24 / .925);
  assert.equal(charger.configuration.efficiency, .925);
  assert.equal(Object.hasOwn(charger.settings, 'efficiency'), false);
  assert.equal(Object.hasOwn(charger.settings, 'mqttTopic'), false);
});

test('automatic connection has no manual substitute and an away vehicle contributes no house load', () => {
  assert.equal(make(1).values.connected.value, null);
  assert.equal(make(1, { telemetry: { connected: true, atHome: false } }).values.connected.value, false);
  assert.equal(make(1, { telemetry: { connected: true, atHome: undefined } }).values.connected.value, null);
});

test('Equalizer allowance and hardware ceiling remain distinct, with every reported limit respected', () => {
  const charger = make(0, { telemetry: { currentA: { value: 0, source: 'easee-equalizer' },
    maxCurrentA: { value: 32, source: 'easee' }, limits: { chargerA: 32, cableA: 20, circuitA: 16 } } });
  assert.equal(charger.values.currentA.value, 0);
  assert.equal(charger.values.maximumCurrentA.value, 16);
  assert.equal(charger.capabilities.externalLoadBalancing, true);
});

test('vehicle MQTT can carry explicit usable capacity and target through its configured topic association', () => {
  const payload = { soc: 46, usableCapacityKwh: 70, chargeLimitSoc: 88, readingId: 'first', measuredAt: now };
  const accepted = acceptSocReading(null, payload, { now });
  assert.equal(accepted.accepted, true);
  const charger = make(0, { automaticSoc: JSON.parse(JSON.stringify(accepted.reading)) });
  assert.equal(charger.values.capacityKwh.value, 70);
  assert.equal(charger.values.minimumSoc.value, 88);
  assert.equal(charger.values.minimumSoc.source, 'mqtt');
  assert.equal(charger.values.minimumSoc.measuredAt, now);
  const update = acceptSocReading(accepted.reading, { soc: 47, readingId: 'second', measuredAt: now + 60_000 }, { now: now + 90_000 });
  const refreshed = make(0, { automaticSoc: update.reading });
  assert.equal(refreshed.values.soc.measuredAt, now + 60_000);
  assert.equal(refreshed.values.capacityKwh.value, 70);
  assert.equal(refreshed.values.capacityKwh.measuredAt, now);
  assert.equal(refreshed.values.capacityKwh.receivedAt, now);
  assert.equal(refreshed.values.minimumSoc.measuredAt, now);
  assert.equal(acceptSocReading(null, { ...payload, usableCapacityKwh: 0 }, { now }).reason, 'invalid-capacity');
  assert.equal(acceptSocReading(null, { ...payload, chargeLimitSoc: 110 }, { now }).reason, 'invalid-charge-limit');
});

test('an unavailable canonical adapter field cannot be revived by stale raw aliases', () => {
  const charger = make(0, { telemetry: {
    connected: { value: null, available: false, source: 'easee', reason: 'offline' }, pluggedIn: true,
    currentA: { value: null, available: false, source: 'easee' }, requestedCurrentA: 16,
    soc: { value: null, available: false, source: 'vehicle' }, batteryLevel: 70,
  } });
  assert.equal(charger.values.connected.available, false);
  assert.equal(charger.values.connected.reason, 'offline');
  assert.equal(charger.values.currentA.available, false);
  assert.equal(charger.values.soc.source, 'manual-fallback');
  const supplied = make(0, { telemetry: { capacityKwh: 72, soc: 55, minimumSoc: 90 } });
  assert.equal(supplied.capabilities.automatic.capacityKwh, true);
  assert.equal(supplied.capabilities.automatic.soc, true);
  assert.equal(supplied.capabilities.automatic.minimumSoc, true);
});

test('offline provider limits cannot revive a current ceiling from the raw stored snapshot', () => {
  const charger = make(0, { telemetry: { providerConnected: false,
    currentA: { value: null, available: false }, maxCurrentA: { value: null, available: false },
    limits: { chargerA: 32, cableA: 20, circuitA: [16, 16, 16] }, readAt: now - 10 * 60_000 } });
  assert.equal(charger.values.currentA.available, false);
  assert.equal(charger.values.maximumCurrentA.available, false);
  assert.equal(charger.values.maximumCurrentA.value, null);
});

test('three-phase assumption uses all circuit ceilings even when an old active phase mask differs', () => {
  const charger = make(0, { telemetry: { phases: [0, 1, 0], maxCurrentA: 32,
    limits: { circuitA: [10, 13, 16], cableA: 20 } } });
  assert.equal(charger.values.maximumCurrentA.value, 10);
  assert.equal(charger.values.phases.value, 3);
  assert.equal(charger.values.phases.assumed, true);
  assert.equal(make(0, { telemetry: { phases: null } }).values.phases.value, 3);
});
