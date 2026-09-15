import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingSettings, mergeChargingSettings, migrateChargingSettings } from '../src/charging/settings.js';
import { buildCharger, CHARGER_DEFINITIONS } from '../src/charging/model.js';
import { acceptSocReading, createManualSoc } from '../src/charging/soc.js';

const now = Date.parse('2026-01-15T00:00:00Z');
const config = chargingSettings();
const make = (index = 0, extra = {}) => buildCharger({ definition: CHARGER_DEFINITIONS[index],
  settings: config.chargers[CHARGER_DEFINITIONS[index].id], now, ...extra });

test('identical preference structures retain first-use values independently and deep-merge patches', () => {
  assert.deepEqual(Object.keys(config.chargers.charger1), Object.keys(config.chargers.charger2));
  assert.deepEqual(Object.values(config.chargers).map(item => [item.enabled, item.minimumSoc, item.readyBy, item.manualSoc, item.capacityKwh]),
    [[false, 80, '06:00', 40, 74], [false, 80, '06:00', 40, 57]]);
  const saved = mergeChargingSettings(config, { chargers: { charger2: { capacityKwh: 60, mqtt: { topic: 'garage/second' } } } });
  assert.equal(saved.chargers.charger1.capacityKwh, 74);
  assert.equal(saved.chargers.charger2.mqtt.vehicleId, 'charger2-vehicle');
  assert.deepEqual(chargingSettings(JSON.parse(JSON.stringify(saved))), saved);
  assert.throws(() => chargingSettings({ installation: { charger1MaxA: 32 } }), /Unknown/);
  assert.throws(() => mergeChargingSettings(config, { chargers: { charger1: { currentA: 32 } } }), /Unknown/);
  assert.throws(() => mergeChargingSettings(config, { chargers: { charger1: { mqtt: { topic: 'bad/#' } } } }), /wildcards/);
  assert.throws(() => mergeChargingSettings(config, { chargers: { charger2: { mqtt: { topic: config.chargers.charger1.mqtt.topic } } } }), /separate/);
});

test('legacy persisted preferences migrate without restoring guessed electrical limits', () => {
  const migrated = migrateChargingSettings({ enabled: true, minimumSoc: 77, readyBy: '07:15', manualSoc: 33,
    capacity1Kwh: 62, capacity2Kwh: 55, efficiency1: .85, mqttTopic: 'old/vehicle',
    installation: { mainFuseA: 35, charger1MaxA: 32, charger2MaxA: 25, circuitA: 16 } });
  assert.equal(migrated.chargers.charger1.enabled, true);
  assert.equal(migrated.chargers.charger1.minimumSoc, 77);
  assert.equal(migrated.chargers.charger1.manualSoc, 33);
  assert.equal(migrated.chargers.charger1.capacityKwh, 62);
  assert.equal(migrated.chargers.charger2.capacityKwh, 55);
  assert.equal(migrated.chargers.charger2.enabled, false);
  assert.equal(migrated.installation.mainFuseA, 35);
  assert.equal(Object.hasOwn(migrated.installation, 'circuitA'), false);
  assert.deepEqual(migrateChargingSettings(migrated), migrated);
});

test('each charger uses valid automatic capacity and target before identical manual fallbacks', () => {
  for (const index of [0, 1]) {
    const charger = make(index, { telemetry: { capacityKwh: { value: 65, source: 'vehicle', measuredAt: now - 1000 },
      minimumSoc: { value: 90, source: 'vehicle' }, soc: { value: 50, source: 'vehicle' } } });
    assert.equal(charger.values.capacityKwh.value, 65);
    assert.equal(charger.values.capacityKwh.source, 'vehicle');
    assert.equal(charger.values.minimumSoc.value, 90);
    assert.equal(charger.requiredGridKwh, 65 * .4 / .9);
    const fallback = make(index, { telemetry: { capacityKwh: -1, minimumSoc: 101, soc: null } });
    assert.equal(fallback.values.capacityKwh.value, config.chargers[fallback.id].capacityKwh);
    assert.equal(fallback.values.minimumSoc.value, 80);
    assert.equal(fallback.values.soc.value, 40);
    assert.equal(fallback.values.soc.source, 'manual-fallback');
    assert.equal(fallback.values.soc.assumed, true);
    assert.equal(fallback.values.connected.available, false);
    assert.equal(fallback.values.currentA.available, false);
  }
});

test('manual override expires at its saved deadline and the latest automatic value stays underneath', () => {
  const manualSoc = createManualSoc(35, { now, readyBy: '06:00', timezone: 'Europe/Helsinki' });
  const automaticSoc = { soc: 61, measuredAt: now + 60_000, receivedAt: now + 120_000 };
  const overriding = make(1, { now: now + 180_000, manualSoc, automaticSoc });
  assert.equal(overriding.values.soc.value, 35);
  assert.equal(overriding.values.soc.source, 'manual');
  assert.equal(overriding.values.soc.expiresAt, manualSoc.expiresAt);
  assert.equal(overriding.automatic.soc.value, 61);
  const expired = make(1, { now: manualSoc.expiresAt, manualSoc, automaticSoc });
  assert.equal(expired.values.soc.value, 61);
  assert.equal(expired.values.soc.source, 'mqtt');
  assert.equal(expired.values.soc.measuredAt, now + 60_000);
  assert.equal(expired.values.soc.receivedAt, now + 120_000);
  assert.equal(make(1, { now: manualSoc.expiresAt, manualSoc }).values.soc.source, 'manual-fallback');
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

test('vehicle MQTT can carry explicit usable capacity and target with its existing trusted identity', () => {
  const payload = { soc: 46, usableCapacityKwh: 70, chargeLimitSoc: 88, vehicleId: 'charger1-vehicle',
    sourceId: 'vehicle-telemetry', readingId: 'first', measuredAt: now };
  const accepted = acceptSocReading(null, payload, { now });
  assert.equal(accepted.accepted, true);
  const charger = make(0, { automaticSoc: JSON.parse(JSON.stringify(accepted.reading)) });
  assert.equal(charger.values.capacityKwh.value, 70);
  assert.equal(charger.values.minimumSoc.value, 88);
  assert.equal(charger.values.minimumSoc.source, 'mqtt');
  assert.equal(charger.values.minimumSoc.measuredAt, now);
  const update = acceptSocReading(accepted.reading, { soc: 47, vehicleId: payload.vehicleId, sourceId: payload.sourceId,
    readingId: 'second', measuredAt: now + 60_000 }, { now: now + 90_000 });
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

test('per-phase circuit ceilings only use confirmed active phases', () => {
  const charger = make(0, { telemetry: { phases: [0, 1, 0], maxCurrentA: 32,
    limits: { circuitA: [0, 13, 0], cableA: 20 } } });
  assert.equal(charger.values.maximumCurrentA.value, 13);
});
