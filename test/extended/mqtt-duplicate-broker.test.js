import test from 'node:test';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import mqttPacket from 'mqtt-packet';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEquipmentCapture } from '../../src/acquisition/equipment.js';
import { equipmentConfiguration } from '../../src/acquisition/equipment-config.js';

// A real local broker and MQTT.js are used; the proxy changes only the transport
// DUP bit and redelivers one frame to exercise receiver-local admission.
test('MQTT.js plus isolated broker admits first DUP once with original sensor clock', { timeout: 15_000 }, async t => {
  const available = spawnSync('mosquitto', ['-h'], { stdio: 'ignore' });
  if (available.error?.code === 'ENOENT' && process.env.STMQ_REQUIRE_MQTT_TESTS !== '1') {
    t.skip('Install mosquitto for the isolated transport regression'); return;
  }
  assert.equal(available.error, undefined, 'Install mosquitto for the isolated transport regression');
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const directory = mkdtempSync(join(tmpdir(), 'stmq-mqtt-dup-'));
  const configPath = join(directory, 'mosquitto.conf');
  writeFileSync(configPath, `listener ${port} 127.0.0.1\nallow_anonymous true\npersistence false\n`);
  const broker = spawn('mosquitto', ['-c', configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise((resolve, reject) => {
    broker.once('error', reject); broker.once('exit', code => reject(new Error(`Isolated broker exited: ${code}`)));
    broker.stderr.on('data', chunk => { if (chunk.toString().includes('running')) resolve(); });
  });
  const sockets = new Set();
  const proxy = net.createServer(client => {
    const upstream = net.connect(port, '127.0.0.1'); sockets.add(client); sockets.add(upstream);
    client.pipe(upstream); client.on('error', () => {}); upstream.on('error', () => {});
    const parser = mqttPacket.parser();
    parser.on('packet', packet => {
      if (packet.cmd === 'publish') {
        const duplicated = mqttPacket.generate({ ...packet, dup: true });
        client.write(duplicated); client.write(duplicated);
      } else client.write(mqttPacket.generate(packet));
    });
    upstream.on('data', data => parser.parse(data));
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const subscriber = mqtt.connect(`mqtt://127.0.0.1:${proxy.address().port}`, { reconnectPeriod: 0 });
  const publisher = mqtt.connect(`mqtt://127.0.0.1:${port}`, { reconnectPeriod: 0 });
  const observations = [], packets = [];
  const now = Date.parse('2026-01-01T00:00:00Z');
  const capture = createEquipmentCapture({ store: { getState() {}, setState() {} },
    engine: { clock: () => now, ingest: row => observations.push(row) }, publish: async () => {},
    settings: equipmentConfiguration({ devices: [{ id: 'fixture', kind: 'temperature', signal: 'indoor_temperature',
      connection: 'mqtt:invented/temperature', mqtt: { timestamp_path: 'timestamp' } }] }) });
  t.after(async () => {
    capture.close(); subscriber.end(true); publisher.end(true);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => proxy.close(resolve));
    broker.kill('SIGTERM'); await once(broker, 'close'); rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all([once(subscriber, 'connect'), once(publisher, 'connect')]); capture.setConnected(true);
  const delivered = new Promise(resolve => subscriber.on('message', (topic, payload, packet) => {
    packets.push(packet); capture.receive(topic, payload, packet, now);
    if (packets.length === 2) resolve();
  }));
  await subscriber.subscribeAsync('invented/temperature', { qos: 1 });
  await publisher.publishAsync('invented/temperature', JSON.stringify({ value: 21, timestamp: now }), { qos: 1 });
  await delivered;
  assert.equal(packets[0].dup, true); assert.equal(packets[1].dup, true);
  assert.equal(packets[0].messageId, packets[1].messageId);
  assert.equal(observations.length, 1); assert.equal(observations[0].sourceTime, now);
  assert.equal(observations[0].value, 21);
});
