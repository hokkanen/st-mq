import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { merossMessage, validMerossMessage } from '../src/acquisition/meross.js';
import { mqttRouting } from '../src/acquisition/mqtt-routing.js';
import { equipmentCoverResult } from '../chart/equipment.js';
import { waitForDoorUpdate } from '../src/app/door-watch.js';
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
    const request = sent.findLast(x => x.body.header.method === (method === 'SETACK' ? 'SET' : 'GET')
      && (method === 'SETACK' ? x.body.payload.state.channel : x.body.payload.state[0].channel) === channel);
    const m = merossMessage(badKey ? '0'.repeat(32) : key, `/appliance/${uuid}/publish`, method,
      { state: [{ channel, open, execute }] }, now + sourceOffsetMs);
    if (['GETACK', 'SETACK'].includes(method) && request) {
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
    { mqtt: { state_path: 'custom' } }, { readings: [{ key: 'other' }] }, { connection: 'mqtt:other' }, { kind: 'switch' },
    { meross: { uuid: [uuid], key, channel: 1 } }, { max_age_seconds: 0.0001 }, { max_age_seconds: 29 }])
    assert.throws(() => equipmentConfiguration({ devices: [{ ...door(1), ...patch }] }));
  assert.throws(() => equipmentConfiguration({ devices: [door(1), { ...door(1), id: 'duplicate' }] }));
  const d = equipmentConfiguration({ devices: [door(3)] }).devices[0];
  assert.equal(d.mqtt.coverStatePath, null, 'Native contact normalization preserves the declared MQTT source mapping');
  assert.equal(mqttRouting({ connections: { mqtt: { address: 'mqtt://local', ha: { address: 'mqtt://ha' } } } }).equipmentBroker(d), 'primary');
});

test('malformed signed headers and ambiguous contact rows are rejected without throwing or refreshing state', async t => {
  const signed = merossMessage(key, `/appliance/${uuid}/publish`, 'PUSH', { state: [{ channel: 1, open: 0 }] });
  for (const [field, value] of [['messageId', [signed.header.messageId]], ['sign', [signed.header.sign]],
    ['sign', {}], ['timestamp', String(signed.header.timestamp)]]) {
    const frame = structuredClone(signed); frame.header[field] = value;
    assert.equal(validMerossMessage(frame, key), false);
  }
  const f = fixture(t); await settle();
  for (const open of [0, 1]) {
    const message = merossMessage(key, `/appliance/${uuid}/publish`, 'PUSH',
      { state: [{ channel: 1, open: 0 }, { channel: 1, open }] }, Date.parse('2026-10-30T10:00:00Z'));
    f.capture.receiveDoors(`/appliance/${uuid}/publish`, JSON.stringify(message));
  }
  assert.ok(f.capture.status().devices.every(d => !d.available));
  f.reply(1); assert.equal(f.capture.status().devices[0].available, true);
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
  assert.equal(f.capture.status().devices[0].cover.operation.startingContact, 0);
  f.reply(1, 1, { method: 'SETACK', execute: 1 });
  assert.equal(f.capture.status().devices[0].readings.door1_open.value, 0);
  f.advance(1000); f.reply(1, 1, { method: 'PUSH' });
  assert.equal(f.capture.status().devices[0].readings.door1_open.value, 1);
  f.authority(false);
  await assert.rejects(f.capture.setCover({ deviceId: 'door2', action: 'open' }));
});

test('matching MSG200 execution receipts notify immediately without manufacturing a contact', async t => {
  const f = fixture(t); await settle(); f.reply(1); f.reply(2); await settle();
  f.advance(250);
  await f.capture.setCover({ deviceId: 'door2', action: 'open' });
  const command = f.sent.at(-1).body;
  const receive = (changes = {}) => {
    const m = merossMessage(key, `/appliance/${uuid}/publish`, 'SETACK',
      { state: [{ channel: 1, open: 1 }, { channel: 2, open: 0 }, 1] }, command.header.timestamp * 1000);
    m.header.messageId = changes.wrongId ? 'f'.repeat(32) : command.header.messageId;
    m.header.sign = createHash('md5').update(`${m.header.messageId}${key}${m.header.timestamp}`).digest('hex');
    if (changes.badSign) m.header.sign = '0'.repeat(32);
    f.capture.receiveDoors(command.header.from, JSON.stringify(m), { retain: changes.retain }, undefined, 'primary');
  };
  const before = f.capture.status(), revision = JSON.stringify(before.doorRevision);
  const waiting = waitForDoorUpdate({ source: f.capture, revision, current: () => true, timeoutMs: 500 });
  receive({ wrongId: true }); receive({ badSign: true }); receive({ retain: true });
  assert.equal(f.capture.status().devices[1].cover.operation.deviceReceipt, undefined);
  f.advance(100); const started = performance.now(); receive();
  const update = await waiting;
  assert.ok(performance.now() - started < 100, 'Receipt wakes a held watcher without a polling interval');
  const device = update.equipment.devices[1];
  assert.equal(device.cover.operation.startingContact, 0);
  assert.equal(device.cover.operation.deviceReceipt.executed, true);
  assert.equal(device.cover.operation.deviceReceipt.receivedAt, device.cover.operation.requestedAt + 100);
  assert.equal(device.readings.door2_open.value, 0); assert.equal(device.cover.operation.status, 'published');
  const after = JSON.stringify(f.capture.status().doorRevision); receive();
  assert.equal(JSON.stringify(f.capture.status().doorRevision), after, 'Duplicate receipt cannot renew animation');
  f.reply(2, 1, { method: 'PUSH' });
  assert.equal(f.capture.status().devices[1].cover.operation.status, 'observed', 'A changed contact in the same source second confirms the request');
});

test('negative execution and source-clock admission remain separate from contact and transport evidence', async t => {
  const f = fixture(t); await settle(); f.reply(1); f.reply(2); await settle();
  await f.capture.setCover({ deviceId: 'door1', action: 'open' });
  f.reply(1, 0, { method: 'SETACK', execute: 1, sourceOffsetMs: 1000 });
  assert.equal(f.capture.status().devices[0].cover.operation.deviceReceipt, undefined);
  f.advance(1000); f.capture.tickDoors();
  assert.equal(f.capture.status().devices[0].cover.operation.deviceReceipt.executed, true);
  f.advance(1000); f.reply(1, 1, { method: 'PUSH' });
  await f.capture.setCover({ deviceId: 'door1', action: 'close' });
  assert.equal(f.capture.status().devices[0].cover.operation.startingContact, 1);
  f.reply(1, 1, { method: 'SETACK', execute: 0 });
  const device = f.capture.status().devices[0];
  assert.equal(device.cover.operation.status, 'failed');
  assert.equal(device.cover.operation.deviceReceipt.executed, false);
  assert.equal(device.readings.door1_open.value, 1);
});

test('door watcher capacity is bounded and a disconnected command cannot acquire a later device receipt', async t => {
  const f = fixture(t); await settle(); f.reply(1); f.reply(2); await settle();
  const releases = Array.from({ length: 32 }, () => f.capture.subscribeDoors(() => {}));
  assert.throws(() => f.capture.subscribeDoors(() => {}), { statusCode: 429 });
  releases.pop()(); const release = f.capture.subscribeDoors(() => {}); release();
  for (const stop of releases) stop();
  await f.capture.setCover({ deviceId: 'door1', action: 'open' });
  f.capture.setConnected(false); f.capture.setConnected(true); f.capture.confirmSubscriptions(f.capture.topics);
  f.reply(1, 0, { method: 'SETACK', execute: 1 });
  assert.equal(f.capture.status().devices[0].cover.operation.deviceReceipt, undefined);
  assert.equal(f.capture.status().devices[0].cover.operation.status, 'unconfirmed');
});

test('fresh native contacts confirm Open and Close receipts in the dashboard without treating SETACK as state', async t => {
  const f = fixture(t); await settle(); f.reply(1); f.reply(2); await settle();
  const device = () => f.capture.status().devices[0];
  assert.equal(device().cover.state, 'closed');
  await f.capture.setCover({ deviceId: 'door1', action: 'open' });
  f.reply(1, 1, { method: 'SETACK', execute: 1 });
  assert.equal(device().cover.operation.status, 'published');
  f.advance(1000); f.reply(1, 1, { method: 'PUSH' });
  assert.equal(device().cover.state, 'open'); assert.equal(device().cover.operation.status, 'observed');
  assert.match(equipmentCoverResult(device(), Date.parse('2026-10-30T10:00:01Z')), /state reported: open/);
  await f.capture.setCover({ deviceId: 'door1', action: 'close' });
  f.reply(1, 0, { retain: true }); assert.equal(device().cover.operation.status, 'published');
  f.advance(1000); f.reply(1, 0, { method: 'PUSH' });
  assert.equal(device().cover.state, 'closed'); assert.equal(device().cover.operation.status, 'observed');
  assert.match(equipmentCoverResult(device(), Date.parse('2026-10-30T10:00:02Z')), /state reported: closed/);
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
