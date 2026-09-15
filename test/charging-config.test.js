import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingConfiguration } from '../src/charging/config.js';
import { chargingSettings } from '../src/charging/settings.js';

test('charger connection topics and efficiencies are configuration while user choices remain preferences', () => {
  const configuration = chargingConfiguration({ chargers: {
    charger1: { mqttTopic: 'garage/first/vehicle', efficiency: .85 },
    charger2: { mqttTopic: 'garage/second/vehicle', efficiency: .95 },
  } });
  assert.equal(configuration.chargers.charger1.efficiency, .85);
  assert.equal(configuration.chargers.charger2.efficiency, .95);
  assert.equal(configuration.chargers.charger1.mqttTopic, 'garage/first/vehicle');
  assert.equal(configuration.chargers.charger2.mqttTopic, 'garage/second/vehicle');
  assert.throws(() => chargingSettings(configuration), /Unknown/);
  assert.throws(() => chargingConfiguration({ chargers: { charger1: { readyBy: '07:00' } } }), /Invalid/);
});

test('default vehicle topic works without vehicle identities and a topic may be disabled', () => {
  const defaults = chargingConfiguration();
  assert.equal(defaults.chargers.charger1.mqttTopic, 'stmq/garage/charger1/vehicle');
  assert.equal(defaults.chargers.charger2.mqttTopic, null);
  assert.equal(defaults.chargers.charger1.efficiency, .9);
  assert.equal(defaults.chargers.charger2.efficiency, .9);
  assert.equal(chargingConfiguration({ chargers: { charger1: { mqttTopic: null } } }).chargers.charger1.mqttTopic, null);
  assert.deepEqual(Object.keys(defaults.chargers.charger1), ['mqttTopic', 'efficiency']);
});

test('vehicle topics cannot overlap, contain wildcard subscriptions or target unknown chargers', () => {
  for (const mqttTopic of ['', ' ', 'garage/#', 'garage/+/vehicle', 'garage/\u0000vehicle', 'garage/\nvehicle', 42])
    assert.throws(() => chargingConfiguration({ chargers: { charger1: { mqttTopic } } }), /concrete topic/);
  assert.throws(() => chargingConfiguration({ chargers: {
    charger1: { mqttTopic: 'garage/vehicle' }, charger2: { mqttTopic: 'garage/vehicle' },
  } }), /different vehicle MQTT topic/);
  assert.throws(() => chargingConfiguration({ chargers: { unknown: { efficiency: .9 } } }), /Unknown charger/);
});

test('efficiency rejects invalid grid-energy conversions and installation guesses cannot return through config', () => {
  for (const efficiency of [0, .49, 1.01, NaN, Infinity, '.9', null])
    assert.throws(() => chargingConfiguration({ chargers: { charger1: { efficiency } } }), /efficiency/);
  for (const efficiency of [.5, 1])
    assert.equal(chargingConfiguration({ chargers: { charger1: { efficiency } } }).chargers.charger1.efficiency, efficiency);
  for (const input of [{ installation: { mainFuseA: 25 } }, { timezone: 'UTC' }, { chargers: [] },
    { chargers: { charger1: { vehicleId: 'example' } } }, { chargers: { charger1: { currentA: 16 } } }])
    assert.throws(() => chargingConfiguration(input), /Invalid/);
});
