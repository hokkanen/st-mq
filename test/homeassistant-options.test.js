import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homeAssistantOptions } from '../src/app/homeassistant-options.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';

const manifest = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

test('shipped defaults already include the collections required by Supervisor', () => {
  assert.deepEqual(homeAssistantOptions(manifest.options, manifest.schema), manifest.options);
});

test('sparse equipment replacement gains empty HA containers with identical runtime meaning', () => {
  const devices = [{ id: 'fixture_sensor', area: 'garage', kind: 'temperature', connection: 'mqtt:fixture/temperature' }];
  const options = structuredClone(manifest.options);
  options.equipment.devices = devices;
  const result = homeAssistantOptions(options, manifest.schema);
  assert.deepEqual(result.equipment.devices, [{ ...devices[0], temperature_control: {}, mqtt: {}, readings: [] }]);
  assert.deepEqual(equipmentConfiguration(result.equipment), equipmentConfiguration(options.equipment));
  assert.equal(Object.hasOwn(devices[0], 'temperature_control'), false, 'The source import stays unchanged');
  assert.deepEqual(homeAssistantOptions(result, manifest.schema), result);
});

test('container completion preserves explicit mappings, zeros, false and HA secret references', () => {
  const options = structuredClone(manifest.options);
  options.mqtt.pw = '!secret fixture_mqtt_password';
  options.equipment.devices = [{ id: 'fixture_sensor', area: 'garage', kind: 'temperature', enabled: false,
    connection: 'mqtt:fixture/temperature', mqtt: { state_path: 'value' },
    readings: [{ key: 'temperature', scale: 0, offset: 0, required: false }] }];
  const result = homeAssistantOptions(options, manifest.schema);
  assert.equal(result.mqtt.pw, '!secret fixture_mqtt_password');
  assert.equal(result.equipment.devices[0].enabled, false);
  assert.deepEqual(result.equipment.devices[0].mqtt, options.equipment.devices[0].mqtt);
  assert.deepEqual(result.equipment.devices[0].readings, options.equipment.devices[0].readings);
});

test('missing required scalars and malformed containers fail before a Supervisor save', () => {
  const options = structuredClone(manifest.options);
  options.equipment.devices = [{ area: 'garage', kind: 'temperature', connection: 'mqtt:fixture/temperature' }];
  assert.throws(() => homeAssistantOptions(options, manifest.schema), /required.*equipment\.devices\.id/);
  for (const value of [null, false, 'fixture-private-content']) {
    const malformed = structuredClone(manifest.options);
    malformed.equipment.devices[0].mqtt = value;
    assert.throws(() => homeAssistantOptions(malformed, manifest.schema), error =>
      error.message.includes('equipment.devices.mqtt') && !error.message.includes('fixture-private-content'));
  }
  const missingWiring = { devices: [{ control: {} }] };
  assert.throws(() => homeAssistantOptions(missingWiring, { devices: [{ control: { sensor: 'str' } }] }), /devices\.control\.sensor/);
});
