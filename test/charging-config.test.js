import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingConfiguration } from '../src/charging/config.js';
import { chargingSettings } from '../src/charging/settings.js';

test('charger topics are configured while the 7.5% loss stays fixed for both chargers', () => {
  const configuration = chargingConfiguration({ chargers: {
    charger1: { mqttTopic: 'garage/first/vehicle', efficiency: .85 },
    charger2: { mqttTopic: 'garage/second/vehicle', efficiency: .95 },
  } });
  assert.equal(configuration.chargers.charger1.efficiency, .925);
  assert.equal(configuration.chargers.charger2.efficiency, .925);
  assert.equal(configuration.chargers.charger1.mqttTopic, 'garage/first/vehicle');
  assert.equal(configuration.chargers.charger2.mqttTopic, 'garage/second/vehicle');
  assert.throws(() => chargingSettings(configuration), /Unknown/);
  assert.throws(() => chargingConfiguration({ chargers: { charger1: { readyBy: '07:00' } } }), /Invalid/);
});

test('default vehicle topic works without vehicle identities and a topic may be disabled', () => {
  const defaults = chargingConfiguration();
  assert.equal(defaults.chargers.charger1.mqttTopic, null);
  assert.equal(defaults.vehicles.bmw.mqttTopic, 'stmq/vehicles/bmw');
  assert.equal(defaults.chargers.charger2.mqttTopic, null);
  assert.equal(defaults.chargers.charger1.efficiency, .925);
  assert.equal(defaults.chargers.charger2.efficiency, .925);
  assert.equal(chargingConfiguration({ chargers: { charger1: { mqttTopic: null } } }).chargers.charger1.mqttTopic, null);
  assert.equal(chargingConfiguration({ chargers: { charger1: { mqttTopic: '' } } }).chargers.charger1.mqttTopic, null);
  assert.equal(chargingConfiguration({ chargers: { charger2: { mqttTopic: '' } } }).chargers.charger2.mqttTopic, null);
  assert.deepEqual(Object.keys(defaults.chargers.charger1), ['mqttTopic', 'efficiency']);
});

test('vehicle topics cannot overlap, contain wildcard subscriptions or target unknown chargers', () => {
  for (const mqttTopic of [' ', 'garage/#', 'garage/+/vehicle', 'garage/\u0000vehicle', 'garage/\nvehicle', 42])
    assert.throws(() => chargingConfiguration({ chargers: { charger1: { mqttTopic } } }), /concrete topic/);
  assert.throws(() => chargingConfiguration({ chargers: {
    charger1: { mqttTopic: 'garage/vehicle' }, charger2: { mqttTopic: 'garage/vehicle' },
  } }), /different vehicle MQTT topic/);
  assert.throws(() => chargingConfiguration({ chargers: { unknown: { efficiency: .9 } } }), /Unknown charger/);
});

test('retired efficiencies normalize to the fixed loss while malformed values and installation guesses are rejected', () => {
  for (const efficiency of [0, .49, 1.01, NaN, Infinity, '.9', null])
    assert.throws(() => chargingConfiguration({ chargers: { charger1: { efficiency } } }), /efficiency/);
  for (const efficiency of [.5, .85, .9, .925, .95, 1])
    assert.equal(chargingConfiguration({ chargers: { charger1: { efficiency } } }).chargers.charger1.efficiency, .925);
  for (const input of [{ installation: { mainFuseA: 25 } }, { timezone: 'UTC' }, { chargers: [] },
    { chargers: { charger1: { vehicleId: 'example' } } }, { chargers: { charger1: { currentA: 16 } } }])
    assert.throws(() => chargingConfiguration(input), /Invalid/);
});

test('BMW source naming and routing are independent of the fixed charging efficiency and normalize idempotently', () => {
  const input = { chargers: { charger1: { mqttTopic: 'legacy/vehicle', efficiency: .85 } },
    vehicles: { bmw: { label: 'BMW', provider: 'bmw-cardata', mqttTopic: 'stmq/vehicles/bmw' } } };
  const configuration = chargingConfiguration(input);
  assert.equal(configuration.vehicles.bmw.mqttTopic, 'stmq/vehicles/bmw');
  assert.equal(configuration.chargers.charger1.efficiency, .925);
  assert.deepEqual(chargingConfiguration(configuration), configuration);
  for (const value of [{ provider: 'unknown' }, { mqttTopic: 'cars/#' }, { label: '' }, { label: 'unsafe\nlabel' }])
    assert.throws(() => chargingConfiguration({ vehicles: { bmw: value } }));
  assert.throws(() => chargingConfiguration({ vehicles: { unknown: {} } }));
});
