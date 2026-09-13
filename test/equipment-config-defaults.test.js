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
  assert.equal(devices.find(row => row.id === 'garage_heat_pump').enabled, false);
  assert.deepEqual(config.control.indoorSensorWeights,
    { indoor_temperature: 1 / 3, downstairs_temperature: 1 / 3, bedroom_temperature: 1 / 3 });
  assert.equal(devices.find(row => row.id === 'garage').readings.find(row => row.key === 'temperature_2').required, false);
  assert.equal(devices.find(row => row.id === 'garage_mqtt').temperatureSignal, 'garage_temperature_ha');
  assert.equal(devices.filter(row => row.kind === 'door').every(row => row.protocol === 'mqtt' && row.maxAgeMs === 0), true);
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
