import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { merossMessage, validMerossMessage } from '../src/acquisition/meross.js';
import { mqttRouting } from '../src/acquisition/mqtt-routing.js';
const uuid = '0123456789abcdef0123456789abcdef', key = 'abcdef0123456789abcdef0123456789';
const door = channel => ({ id: `door${channel}`, area: 'garage', kind: 'door',
  connection: `mqtt:/appliance/${uuid}/publish`, cover_control: true, meross: { uuid, key, channel } });
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  let now = Date.parse('2026-10-30T10:00:00Z'), authority = true;
  const store = new Store(':memory:'), sent = [], ingested = [];
  const settings = equipmentConfiguration({ devices: [door(1), door(2)] });
  const capture = createEquipmentCapture({ store, settings, engine: { clock: () => now, ingest: row => ingested.push(row) },
    canControl: () => authority, publish: async (topic, body, options) => {
      options.beforePublish?.(); assert.notEqual(options.beforeWrite?.(), false);
      sent.push({ topic, body: JSON.parse(body), options });
    } });
  t.after(() => { capture.close(); store.close(); });
  const reply = (channel, open = 0, { method = 'GETACK', retain = false, badKey = false, execute = 0, sourceOffsetMs = 0 } = {}) => {
    const request = sent.findLast(x => x.body.header.method === 'GET' && x.body.payload.state[0].channel === channel);
    const m = merossMessage(badKey ? '0'.repeat(32) : key, `/appliance/${uuid}/publish`, method,
      { state: [{ channel, open, execute }] }, now + sourceOffsetMs);
    if (method === 'GETACK' && request) {
      m.header.messageId = request.body.header.messageId;
      m.header.sign = createHash('md5').update(`${m.header.messageId}${badKey ? '0'.repeat(32) : key}${m.header.timestamp}`).digest('hex');
    }
    capture.receiveDoors(request?.body.header.from ?? capture.topics[0], JSON.stringify(m), { retain }, now, 'primary');
    return m;
  };
  capture.setConnected(true); capture.confirmSubscriptions(capture.topics);
  return { capture, sent, reply, ingested, advance: ms => now += ms, authority: value => authority = value };
}
test('Meross config enforces exact native identity, channel, finite age and no generic mapping', () => {
  for (const patch of [{ meross: { uuid, key, channel: 0 } }, { meross: { uuid, key } }, { max_age_seconds: 0 },
    { mqtt: { state_path: 'custom' } }, { readings: [{ key: 'other' }] }, { connection: 'mqtt:other' }, { kind: 'switch' }])
    assert.throws(() => equipmentConfiguration({ devices: [{ ...door(1), ...patch }] }));
  assert.throws(() => equipmentConfiguration({ devices: [door(1), { ...door(1), id: 'duplicate' }] }));
  const d = equipmentConfiguration({ devices: [door(3)] }).devices[0];
  assert.equal(mqttRouting({ connections: { mqtt: { address: 'mqtt://local', ha: { address: 'mqtt://ha' } } } }).equipmentBroker(d), 'primary');
});
test('signed queries recover both channels independently; native commands use QoS 0 and transport receipts', async t => {
  const f = fixture(t); await settle();
  assert.equal(f.sent.length, 2);
  for (const row of f.sent) { assert.ok(validMerossMessage(row.body, key)); assert.equal(row.options.qos, 0); }
  f.reply(1); f.reply(2); await settle();
  assert.ok(f.capture.status().devices.every(d => d.available));
  const receipt = await f.capture.setCover({ deviceId: 'door1', action: 'open' });
  const command = f.sent.at(-1);
  assert.deepEqual(command.body.payload, { state: { channel: 1, open: 1 } });
  assert.equal(command.options.noReplay, true); assert.equal(command.options.retain, false);
  assert.equal(command.options.qos, 0); assert.equal(receipt.acknowledgement, 'mqtt-write');
  assert.equal(receipt.confirmed, false);
  f.reply(1, 1, { method: 'SETACK', execute: 1 });
  assert.equal(f.capture.status().devices[0].readings.door1_open.value, 0);
  f.advance(1000); f.reply(1, 1, { method: 'PUSH' });
  assert.equal(f.capture.status().devices[0].readings.door1_open.value, 1);
  f.authority(false);
  await assert.rejects(f.capture.setCover({ deviceId: 'door2', action: 'open' }));
});
test('retained, bad signatures, unmatched acknowledgements and stale reports grant no control; reconnect requires fresh reports', async t => {
  const f = fixture(t); await settle();
  f.reply(1, 0, { retain: true }); f.reply(2, 0, { badKey: true });
  assert.ok(f.capture.status().devices.every(d => !d.available));
  f.reply(1); f.reply(2); await settle();
  f.capture.setConnected(false); f.capture.setConnected(true);
  assert.ok(f.capture.status().devices.every(d => !d.available));
  f.capture.confirmSubscriptions(f.capture.topics); await settle(); f.reply(1); f.reply(2); await settle();
  f.advance(91_000); f.capture.tickDoors();
  assert.ok(f.capture.status().devices.every(d => !d.available));
});

test('native clock leads wait for source time without changing clocks or granting early control', async t => {
  const f = fixture(t); await settle(); f.advance(500);
  const message = f.reply(1, 0, { sourceOffsetMs: 1000 });
  f.reply(2, 0, { sourceOffsetMs: 1000 });
  assert.ok(f.capture.status().devices.every(d => !d.available));
  await assert.rejects(f.capture.setCover({ deviceId: 'door1', action: 'open' }));
  assert.equal(f.sent.filter(row => row.body.header.method === 'SET').length, 0);
  f.advance(499); f.capture.tickDoors();
  assert.ok(f.capture.status().devices.every(d => !d.available));
  f.advance(1); f.capture.tickDoors();
  assert.ok(f.capture.status().devices.every(d => d.available));
  const reading = f.capture.status().devices[0].readings.door1_open;
  assert.equal(reading.observedAt, message.header.timestamp * 1000);
  assert.equal(reading.receivedAt, reading.observedAt - 500);
  assert.deepEqual(reading.timeAdmission, { sourceTime: reading.observedAt,
    receivedAt: reading.receivedAt, admittedAt: reading.observedAt });
});

test('native admission rejects excessive clock leads and cannot restore a disconnected pending report', async t => {
  const f = fixture(t); await settle(); f.advance(500);
  f.reply(1, 0, { sourceOffsetMs: 2000 });
  f.reply(2, 0, { sourceOffsetMs: -11000 });
  assert.ok(f.capture.status().devices.every(d => !d.available));
  f.reply(1, 0, { sourceOffsetMs: 1000 });
  f.capture.setConnected(false); f.capture.setConnected(true);
  f.capture.confirmSubscriptions(f.capture.topics); await settle();
  f.advance(1000); f.capture.tickDoors();
  assert.ok(f.capture.status().devices.every(d => !d.available));
});

test('Home Assistant empty nested Meross sections preserve generic equipment contracts', () => {
  const d = { id: 'contact', kind: 'door', connection: 'mqtt:invented/contact' };
  assert.deepEqual(equipmentConfiguration({ devices: [d] }), equipmentConfiguration({ devices: [{ ...d, meross: {} }] }));
  assert.throws(() => equipmentConfiguration({ devices: [{ ...d, meross: { retired: true } }] }));
});

test('native signed messages use the normal MQTT transport and preserve manual-command fencing', async t => {
  const { EventEmitter } = await import('node:events');
  const { startMqtt } = await import('../src/acquisition/mqtt.js');
  const store = new Store(':memory:'), client = new EventEmitter(), sent = [];
  const now = Date.parse('2026-10-30T10:00:00Z');
  client.subscribe = (topic, options, done) => done(null, [{ topic, qos: 1 }]);
  client.publish = (topic, payload, options, done) => { sent.push({ topic, payload: JSON.parse(payload), options }); done(); };
  client.end = (force, options, done) => done();
  const equipment = equipmentConfiguration({ devices: [door(1)] });
  const reader = await startMqtt({ engine: { clock: () => now, ingest() {} }, store,
    config: { connections: { mqtt: { address: 'mqtt://fixture.invalid' }, equipment } },
    connect: () => client, canControl: () => true });
  t.after(async () => { await reader.close({ restore: false }); store.close(); });
  client.emit('connect'); await settle(); await settle();
  const query = sent.find(x => x.payload.header.method === 'GET');
  assert.ok(query, 'SUBACK triggers a signed native GET on primary');
  const reply = merossMessage(key, `/appliance/${uuid}/publish`, 'GETACK', { state: [{ channel: 1, open: 0 }] }, now);
  reply.header.messageId = query.payload.header.messageId;
  reply.header.sign = createHash('md5').update(`${reply.header.messageId}${key}${reply.header.timestamp}`).digest('hex');
  client.emit('message', query.payload.header.from, Buffer.from(JSON.stringify(reply)), {});
  await settle();
  const result = await reader.equipment.setCover({ deviceId: 'door1', action: 'open' });
  assert.equal(result.acknowledgement, 'mqtt-write'); assert.equal(result.confirmed, false);
  const commands = sent.filter(x => x.payload.header.method === 'SET');
  assert.equal(commands.length, 1); assert.equal(commands[0].options.retain, false);
  client.emit('close'); client.emit('connect'); await settle();
  assert.equal(sent.filter(x => x.payload.header.method === 'SET').length, 1, 'Reconnect never resends a movement');
});

test('Supervisor empty mapping groups preserve a native Meross route without allowing custom overrides', () => {
  assert.deepEqual(equipmentConfiguration({ devices: [door(1)] }),
    equipmentConfiguration({ devices: [{ ...door(1), mqtt: {}, readings: [], temperature_control: {} }] }));
});

test('session establishment acknowledges Bind and Clock without actuating or inventing contact evidence', async t => {
  const f = fixture(t); await settle();
  const deviceTopic = `/appliance/${uuid}/publish`;
  for (const [namespace, method, payload] of [
    ['Appliance.Control.Bind', 'SET', { bind: {} }],
    ['Appliance.System.Clock', 'PUSH', { clock: {} }],
  ]) {
    const message = merossMessage(key, deviceTopic, method, payload, Date.parse('2026-10-30T10:00:00Z'), namespace);
    const before = f.sent.length;
    f.capture.receiveDoors(deviceTopic, JSON.stringify(message), {}, Date.parse('2026-10-30T10:00:00Z'), 'primary');
    await settle();
    assert.equal(f.sent.length, before + 1, 'One appliance response, shared by both configured channels');
    const sent = f.sent.at(-1);
    assert.equal(sent.body.header.namespace, namespace);
    assert.equal(sent.body.header.messageId, message.header.messageId);
    assert.equal(sent.body.header.method, namespace.endsWith('Bind') ? 'SETACK' : 'PUSH');
    assert.equal(sent.options.noReplay, true); assert.equal(sent.options.retain, false);
    assert.equal(f.capture.isReadRequest(sent.topic, JSON.stringify(sent.body), 'primary'), true);
    f.capture.receiveDoors(deviceTopic, JSON.stringify(message), {}, Date.parse('2026-10-30T10:00:00Z'), 'primary');
    await settle(); assert.equal(f.sent.length, before + 1, 'Duplicate session message is not replayed');
  }
  assert.ok(f.capture.status().devices.every(d => !d.available));
  assert.ok(f.sent.every(s => s.body.header.namespace !== 'Appliance.GarageDoor.State' || s.body.header.method === 'GET'));
  f.authority(false);
  const bind = merossMessage(key, deviceTopic, 'SET', {}, Date.parse('2026-10-30T10:00:00Z'), 'Appliance.Control.Bind');
  const before = f.sent.length;
  f.capture.receiveDoors(deviceTopic, JSON.stringify(bind), {}, Date.parse('2026-10-30T10:00:00Z'), 'primary');
  await settle(); assert.equal(f.sent.length, before);
});
