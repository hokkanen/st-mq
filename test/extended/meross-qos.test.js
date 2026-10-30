import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import mqtt from 'mqtt';
import mqttPacket from 'mqtt-packet';
import { Store } from '../../src/storage/store.js';
import { createEquipmentCapture } from '../../src/acquisition/equipment.js';
import { equipmentConfiguration } from '../../src/acquisition/equipment-config.js';
import { merossMessage } from '../../src/acquisition/meross.js';
import { createHash } from 'node:crypto';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 4000;
  while (!predicate()) { assert.ok(Date.now() < end, 'fixture response timed out'); await delay(10); }
}

test('native QoS 0 keeps polling when firmware leaves QoS 1 deliveries unacknowledged', { timeout: 15000 }, async t => {
  if (spawnSync('mosquitto', ['-h'], { stdio: 'ignore' }).error?.code === 'ENOENT') {
    assert.notEqual(process.env.STMQ_REQUIRE_MQTT_TESTS, '1'); t.skip('Requires an isolated Mosquitto broker'); return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'stmq-meross-qos-'));
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const path = join(directory, 'broker.conf');
  await writeFile(path, `listener ${port} 127.0.0.1\nallow_anonymous true\npersistence false\nmax_inflight_messages 2\n`);
  const broker = spawn('mosquitto', ['-c', path], { stdio: ['ignore', 'ignore', 'pipe'] });
  let app, device, capture, store;
  t.after(async () => {
    capture?.close(); store?.close(); device?.destroy(); await app?.endAsync(true);
    if (broker.exitCode === null) { const closed = once(broker, 'close'); broker.kill(); await closed; }
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    broker.once('error', reject); broker.once('exit', code => reject(Error(`Fixture broker exited (${code})`)));
    broker.stderr.on('data', b => { if (b.toString().includes('running')) resolve(); });
  });
  const uuid = '0123456789abcdef0123456789abcdef', key = 'abcdef0123456789abcdef0123456789';
  const commandTopic = `/appliance/${uuid}/subscribe`, deviceTopic = `/appliance/${uuid}/publish`;
  const packets = [], responses = new Set(), parser = mqttPacket.parser(); let subscribed = false, droppedRead = false;
  device = createConnection({ host: '127.0.0.1', port });
  device.on('data', data => parser.parse(data));
  parser.on('packet', packet => {
    if (packet.cmd === 'connack') device.write(mqttPacket.generate({ cmd: 'subscribe', messageId: 1, qos: 1,
      subscriptions: [{ topic: commandTopic, qos: 1 }] }));
    if (packet.cmd === 'suback') subscribed = true;
    if (packet.cmd !== 'publish') return;
    packets.push(packet);
    // Model firmware that processes requests but omits protocol PUBACK at QoS 1.
    const query = JSON.parse(packet.payload);
    if (query.header.method !== 'GET') return;
    if (packet.qos === 0 && !droppedRead) { droppedRead = true; return; }
    const reply = merossMessage(key, deviceTopic, 'GETACK', { state: [{ channel: 1, open: 0 }] });
    reply.header.messageId = query.header.messageId;
    reply.header.sign = createHash('md5').update(reply.header.messageId + key + reply.header.timestamp).digest('hex');
    device.write(mqttPacket.generate({ cmd: 'publish', qos: 0, retain: false,
      topic: query.header.from, payload: JSON.stringify(reply) }));
  });
  device.write(mqttPacket.generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4,
    clientId: 'synthetic-meross', clean: true, keepalive: 0 }));
  await until(() => subscribed);
  app = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clean: true, reconnectPeriod: 0 });
  await once(app, 'connect');
  app.on('message', (topic, body, metadata) => {
    const frame = JSON.parse(body); responses.add(frame.header.messageId);
    capture?.receiveDoors(topic, body, metadata, Date.now(), 'primary');
  });
  const probeTopic = '/app/fixture-qos/subscribe'; await app.subscribeAsync(probeTopic, { qos: 0 });
  const probes = [];
  for (let i = 0; i < 3; i++) {
    const query = merossMessage(key, probeTopic, 'GET', { state: [{ channel: 1 }] }); probes.push(query);
    await app.publishAsync(commandTopic, JSON.stringify(query), { qos: 1, retain: false });
  }
  await until(() => responses.size === 2); await delay(100);
  assert.equal(packets.length, 2, 'the next QoS 1 delivery waits behind unacknowledged requests');
  assert.equal(responses.has(probes[2].header.messageId), false);
  store = new Store(':memory:');
  capture = createEquipmentCapture({ store, settings: equipmentConfiguration({ devices: [{ id: 'fixture_door',
    kind: 'door', area: 'garage', connection: 'mqtt:' + deviceTopic, cover_control: true, meross: { uuid, key, channel: 1 } }] }),
    engine: { clock: Date.now, ingest() {} }, canControl: () => true,
    publish: (topic, payload, options) => { options.beforePublish?.(); assert.notEqual(options.beforeWrite?.(), false);
      return app.publishAsync(topic, payload, options); } });
  await app.subscribeAsync(capture.topics, { qos: 0 }); capture.setConnected(true); capture.confirmSubscriptions(capture.topics);
  await until(() => capture.status().devices[0].available);
  assert.equal(droppedRead, true, 'A lost QoS 0 read recovers through a new bounded query');
  for (let i = 0; i < 25; i++) {
    const result = await capture.recheck({ deviceId: 'fixture_door' }); assert.equal(result.devices[0].available, true);
  }
  assert.ok(packets.filter(p => p.qos === 0).length >= 26);
  const receipt = await capture.setCover({ deviceId: 'fixture_door', action: 'open' });
  await until(() => packets.some(p => JSON.parse(p.payload).header.method === 'SET'));
  assert.equal(packets.at(-1).qos, 0); assert.equal(receipt.acknowledgement, 'mqtt-write'); assert.equal(receipt.confirmed, false);
});
