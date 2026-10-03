// Serialize synthetic sparse equipment with the production HA option writer.
// The independent Supervisor fixture validates this output without its own
// copy of the serialization logic. No installation configuration is loaded.
import { readFileSync } from 'node:fs';
import { homeAssistantOptions } from '../../../src/app/homeassistant-options.js';

const manifest = JSON.parse(readFileSync(new URL('../../../config.json', import.meta.url), 'utf8'));
const options = structuredClone(manifest.options);
options.equipment.devices = [{ id: 'fixture_sensor', area: 'garage', kind: 'temperature',
  connection: 'mqtt:fixture/temperature', readings: [{ key: 'temperature', scale: 0, offset: 0, required: false }] }];
options.mqtt.pw = '!secret fixture_password';
process.stdout.write(`${JSON.stringify(homeAssistantOptions(options, manifest.schema))}\n`);
