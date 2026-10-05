import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import mqtt from 'mqtt';
import { Store } from '../../src/storage/store.js';
import { startMqtt } from '../../src/acquisition/mqtt.js';
import { equipmentConfiguration } from '../../src/acquisition/equipment-config.js';

const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

test('two real local brokers preserve primary telemetry across HA outage and require fresh HA recovery', { timeout: 25_000 }, async t => {
  const available = spawnSync('mosquitto', ['-h'], { stdio: 'ignore' });
  if (available.error?.code === 'ENOENT' && process.env.STMQ_REQUIRE_MQTT_TESTS !== '1') {
    t.skip('Install mosquitto for the isolated two-broker regression'); return;
  }
  assert.equal(available.error, undefined);
  const directory = mkdtempSync(join(tmpdir(), 'stmq-two-brokers-'));
  const processes = [], publishers = [], store = new Store(':memory:');
  let reader;
  t.after(async () => {
    await reader?.close({ restore: false });
    await Promise.all(publishers.map(client => client.endAsync(true)));
    for (const broker of processes) if (broker.exitCode === null && broker.signalCode === null) {
      const closed = once(broker, 'close'); broker.kill('SIGTERM'); await closed;
    }
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const startBroker = async name => {
    const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const path = join(directory, `${name}.conf`);
    writeFileSync(path, `listener ${port} 127.0.0.1\nallow_anonymous true\npersistence false\n`);
    const start = async () => {
      const process = spawn('mosquitto', ['-c', path], { stdio: ['ignore', 'ignore', 'pipe'] }); processes.push(process);
      await new Promise((resolve, reject) => {
        process.once('error', reject); process.once('exit', () => reject(new Error('Synthetic broker startup failed')));
        process.stderr.on('data', bytes => { if (bytes.toString().includes('running')) resolve(); });
      });
      return process;
    };
    return { address: `mqtt://127.0.0.1:${port}`, process: await start(), restart: start };
  };
  const primary = await startBroker('primary'), ha = await startBroker('ha');
  const settings = equipmentConfiguration({ devices: [
    { id: 'independent', area: 'home', kind: 'temperature', signal: 'indoor_temperature', connection: 'mqtt:fixture/room',
      mqtt: { timestamp_path: 'timestamp' } },
    { id: 'garage_door1', area: 'garage', kind: 'door', connection: 'mqtt:fixture/door/state', cover_control: true,
      mqtt: { state_path: 'value', timestamp_path: 'timestamp', availability_topic: 'fixture/door/online',
        command_topic: 'fixture/door/set', open_payload: 'open', close_payload: 'closed' } },
  ] });
  let now = Date.parse('2026-10-05T12:00:00Z');
  const observations = [], engine = { clock: () => now, ingest: row => observations.push(row) };
  reader = await startMqtt({ store, engine, config: { input: 'mqtt', connections: {
    mqtt: { address: primary.address, ha: { address: ha.address } }, equipment: settings } } });
  await reader.ready(); await waitFor(() => reader.status().brokers.ha.ready, 'HA subscriptions did not complete');
  const publisher = async address => {
    const client = mqtt.connect(address, { reconnectPeriod: 0 }); publishers.push(client);
    await once(client, 'connect'); return client;
  };
  const direct = await publisher(primary.address); let fixed = await publisher(ha.address);
  const state = id => reader.equipment.status().devices.find(device => device.id === id);
  const reportDoor = async (client, retain = false) => {
    await client.publishAsync('fixture/door/online', 'online', { qos: 1, retain });
    await client.publishAsync('fixture/door/state', JSON.stringify({ value: 'closed', timestamp: now }), { qos: 1, retain });
  };
  await direct.publishAsync('fixture/room', JSON.stringify({ value: 20, timestamp: now }), { qos: 1 });
  await reportDoor(fixed); await waitFor(() => state('independent').available && state('garage_door1').available, 'Initial live evidence unavailable');
  const commands = [];
  await fixed.subscribeAsync('fixture/door/set'); fixed.on('message', (topic, payload) => commands.push({ topic, payload: payload.toString() }));
  await reader.equipment.setCover({ deviceId: 'garage_door1', action: 'open' });
  await waitFor(() => commands.length === 1, 'Door command did not reach the selected HA broker');
  assert.equal(commands[0].payload, 'open');
  const closed = once(ha.process, 'close'); ha.process.kill('SIGTERM'); await closed;
  await waitFor(() => !reader.status().brokers.ha.connected, 'HA outage not detected');
  now += 1000;
  await direct.publishAsync('fixture/room', JSON.stringify({ value: 21, timestamp: now }), { qos: 1 });
  await waitFor(() => state('independent').readings.indoor_temperature.value === 21, 'Independent input stopped with HA');
  assert.equal(state('independent').available, true); assert.equal(state('garage_door1').available, false);
  await assert.rejects(reader.equipment.setCover({ deviceId: 'garage_door1', action: 'close' }), /unavailable/);
  await ha.restart(); fixed = await publisher(ha.address); await reportDoor(fixed, true);
  await waitFor(() => reader.status().brokers.ha.ready, 'HA MQTT client did not reconnect');
  await waitFor(() => state('garage_door1').mqttStatus.lastRetainedAt !== null, 'Retained recovery context missing');
  assert.equal(state('garage_door1').available, false, 'Saved broker state cannot restore a live HA route');
  now += 1000; await reportDoor(fixed);
  await waitFor(() => state('garage_door1').available, 'Fresh HA reports did not recover');
  assert.equal(reader.status().brokers.primary.ready, true);
  assert.equal(observations.filter(row => row.signal === 'indoor_temperature' && row.value === 21).length, 1);
});
