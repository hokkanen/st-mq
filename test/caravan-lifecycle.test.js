import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/storage/store.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { startMqtt } from '../src/acquisition/mqtt.js';

const START = Date.parse('2026-09-30T10:00:00Z');
const IDENTITY = 'a'.repeat(64);
const RESTORE_KEY = `equipment:caravan-probe-restoration:v1:caravan_dehumidifier:${IDENTITY}`;
const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const store = new Store(':memory:'), client = new EventEmitter(), commands = [];
  let now = START, authority = true, confirmRestoration = true, ended = false;
  const settings = equipmentConfiguration({ devices: [
    { id: 'blu_ht', kind: 'temperature', area: 'garage', connection: 'mqtt:invented/air', signal: 'caravan_temperature',
      mqtt: { state_path: 'temperature', timestamp_path: 'timestamp' },
      readings: [{ key: 'humidity', signal: 'caravan_humidity', path: 'humidity', unit: '%', required: true }] },
    { id: 'caravan', kind: 'power', area: 'garage', connection: 'mqtt:invented/power', record: false,
      max_age_seconds: 180, mqtt: { state_path: 'power', timestamp_path: 'timestamp' } },
    { id: 'caravan_dehumidifier', kind: 'dehumidifier', area: 'garage', connection: 'mqtt:invented/appliance',
      dehumidifier_control: true, temperature_control: { sensor_device_id: 'blu_ht' }, max_age_seconds: 180,
      mqtt: { command_topic: 'invented/appliance/set', timestamp_path: 'timestamp',
        availability_topic: 'invented/appliance/online' } },
  ] });
  const report = (topic, value) => client.emit('message', topic, Buffer.from(JSON.stringify(value)), { retain: false });
  const appliance = power => report('invented/appliance', { identity: IDENTITY, power, timestamp: now, fanSpeed: 'low',
    capabilities: { power: ['off', 'on'], fanSpeed: ['low'] } });
  client.connected = true;
  client.subscribe = (topic, options, done) => done(null, [{ topic, qos: 1 }]);
  client.publish = (topic, payload, options, done) => {
    done?.();
    if (topic !== 'invented/appliance/set') return;
    const command = JSON.parse(payload); commands.push(command.power);
    if (command.power === 'off' && confirmRestoration) setImmediate(() => {
      assert.equal(ended, false, 'Native restoration readback arrives before the MQTT transport closes');
      now++; appliance('off');
    });
  };
  client.end = (force, options, done) => { ended = true; done(); };
  const engine = { clock: () => now, ingest() {} };
  const acquisition = await startMqtt({ engine, store, connect: () => client, canControl: () => authority,
    config: { h66: { readbackTimeoutMs: 120 }, connections: { equipment: settings,
      mqtt: { address: 'mqtt://synthetic.invalid' } } } });
  t.after(async () => { await acquisition.close({ restore: false }); store.close(); });
  client.emit('message', 'invented/appliance/online', Buffer.from('online'), { retain: false });
  report('invented/air', { temperature: 1.5, humidity: 40, timestamp: now });
  appliance('off'); report('invented/power', { power: 100, timestamp: now });
  now += 5000; appliance('off'); report('invented/power', { power: 100, timestamp: now });
  await settle();
  assert.deepEqual(commands, ['on']);
  now++; appliance('on'); now++;
  assert.equal(store.getState(RESTORE_KEY)?.power, 'off');
  return { store, acquisition, commands, ended: () => ended,
    setAuthority: value => { authority = value; }, noReadback: () => { confirmRestoration = false; } };
}

test('MQTT shutdown restores an active Caravan test and accepts native readback before closing', async t => {
  const f = await fixture(t);
  await f.acquisition.close();
  assert.deepEqual(f.commands, ['on', 'off']);
  assert.equal(f.store.getState(RESTORE_KEY), null);
  assert.equal(f.ended(), true);
});

test('authority-loss shutdown preserves the Caravan restoration obligation without another command', async t => {
  const f = await fixture(t); f.setAuthority(false);
  await f.acquisition.close({ restore: false });
  assert.deepEqual(f.commands, ['on']);
  assert.equal(f.store.getState(RESTORE_KEY)?.power, 'off');
  assert.equal(f.ended(), true);
});

test('unconfirmed Caravan shutdown retains the durable obligation and still closes MQTT', async t => {
  const f = await fixture(t); f.noReadback();
  await f.acquisition.close();
  assert.deepEqual(f.commands, ['on', 'off']);
  assert.equal(f.store.getState(RESTORE_KEY)?.power, 'off');
  assert.equal(f.ended(), true);
});
