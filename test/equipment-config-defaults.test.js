import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/app/config.js';
import { validateOptionFields } from '../src/app/configuration-source.js';

test('public equipment defaults work with broker-only private settings and preserve indoor membership', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-public-equipment-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const privatePath = join(directory, 'fixture.json');
  const privateText = JSON.stringify({ mqtt: { address: 'mqtt://synthetic.invalid', user: 'synthetic-user', pw: 'synthetic-password' } });
  writeFileSync(privatePath, privateText);
  const manifest = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  validateOptionFields(manifest.options, manifest.schema);
  const config = loadConfig({ STMQ_INPUT: 'mqtt', STMQ_CONFIG: privatePath, HOME: directory }, directory);
  const devices = config.connections.equipment.devices;
  assert.deepEqual(devices.filter(row => row.enabled && row.protocol === 'shelly').map(row => row.id).sort(),
    ['caravan', 'garage', 'heat_savings']);
  assert.equal(devices.some(row => row.id === 'garage_heat_pump' || row.id === 'garage_mqtt'), false);
  assert.deepEqual(config.control.indoorSensorWeights,
    { indoor_temperature: 1 / 3, downstairs_temperature: 1 / 3, bedroom_temperature: 1 / 3 });
  assert.equal(devices.find(row => row.id === 'garage').readings.find(row => row.key === 'temperature_2').required, false);
  assert.equal(devices.find(row => row.id === 'garage').maxAgeMs, 120_000);
  assert.equal(devices.filter(row => ['upstairs', 'downstairs', 'bedroom'].includes(row.id)).every(row => row.maxAgeMs === 4_500_000), true);
  assert.equal(config.connections.mqtt.temperatureReportIntervalMs + config.connections.mqtt.temperatureReportGraceMs, 4_500_000);
  assert.equal(devices.filter(row => row.kind === 'door').every(row => row.protocol === 'mqtt' && row.maxAgeMs === 0), true);
  for (const [index, door] of devices.filter(row => row.kind === 'door').entries()) {
    assert.equal(door.controlsCover, true);
    assert.equal(door.mqtt.commandTopic, `stmq/garage/door${index + 1}/command/cover`);
    assert.equal(door.mqtt.openPayload, 'open'); assert.equal(door.mqtt.closePayload, 'closed');
    assert.equal(door.mqtt.stopPayload, null, 'Installed HA covers advertise no Stop capability');
    assert.equal(door.mqtt.coverStatePath, 'cover_state');
  }
  const blu = devices.find(row => row.id === 'blu_ht');
  assert.equal(blu.enabled, true);
  assert.equal(blu.topic, 'stmq/garage/caravan_air/state');
  assert.equal(blu.temperatureSignal, 'caravan_temperature');
  assert.equal(blu.label, 'Caravan air');
  assert.equal(blu.area, 'garage');
  assert.equal(blu.source, 'Shelly');
  assert.equal(devices.find(row => row.id === 'caravan').label, 'Caravan energy');
  assert.equal(blu.maxAgeMs, 180_000);
  assert.equal(blu.mqtt.timestampPath, 'timestamp');
  assert.equal(blu.mqtt.requestTopic, 'stmq/garage/caravan_air/get');
  assert.equal(blu.readings.find(row => row.key === 'humidity').required, true);
  assert.equal(blu.readings.find(row => row.key === 'rssi').record, false);
  assert.equal(blu.readings.find(row => row.key === 'battery').record, false);
  assert.equal(blu.readings.find(row => row.key === 'humidity').signal, 'caravan_humidity');
  const dehumidifier = devices.find(row => row.id === 'caravan_dehumidifier');
  assert.equal(dehumidifier.kind, 'dehumidifier');
  assert.equal(dehumidifier.enabled, true);
  assert.equal(dehumidifier.temperatureControl.sensorDeviceId, 'blu_ht');
  assert.equal(dehumidifier.stateSignal, 'caravan_dehumidifier_active');
  assert.equal(dehumidifier.mqtt.commandTopic, 'stmq/garage/caravan_dehumidifier/set');
  assert.equal(dehumidifier.maxAgeMs, 180_000);
  const dhwr = devices.find(row => row.id === 'dhwr');
  assert.equal(dhwr.enabled, true);
  assert.equal(dhwr.kind, 'power');
  assert.equal(dhwr.topic, 'stmq/home/dhwr/status/power');
  assert.equal(dhwr.powerSignal, 'dhwr_power');
  assert.equal(dhwr.stateSignal, null);
  assert.equal(dhwr.record, false);
  assert.equal(dhwr.maxAgeMs, 0);
  assert.equal(dhwr.controlsSwitch, false);
  assert.equal(config.connections.mqtt.dhwr_topic, 'stmq/home/dhwr/command/switch');
  assert.equal(readFileSync(privatePath, 'utf8'), privateText);
  assert.equal(config.connections.mqtt.pw, 'synthetic-password');
});

test('an explicit device list replaces public defaults without switching protocols or retaining default controllers', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-explicit-equipment-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const privatePath = join(directory, 'fixture.json');
  writeFileSync(privatePath, JSON.stringify({ mqtt: { address: 'mqtt://synthetic.invalid' }, equipment: { devices: [
    { id: 'caravan', kind: 'metered_switch', connection: 'mqtt:synthetic/caravan/state' },
  ] } }));
  const config = loadConfig({ STMQ_INPUT: 'mqtt', STMQ_CONFIG: privatePath, HOME: directory }, directory);
  assert.equal(config.connections.equipment.devices.length, 1);
  assert.equal(config.connections.equipment.devices[0].protocol, 'mqtt');
  assert.equal(config.connections.equipment.devices[0].topic, 'synthetic/caravan/state');
  assert.equal(config.connections.equipment.devices[0].controlsHeat, false);
});
