import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/storage/store.js';
import { equipmentConfiguration, equipmentSignature } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { startMqtt } from '../src/acquisition/mqtt.js';

const INITIAL = Date.parse('2026-09-14T10:00:00Z');
const door = { id: 'garage_door1', area: 'garage', kind: 'door', connection: 'mqtt:invented/door/state', cover_control: true,
  mqtt: { command_topic: 'invented/door/command', open_payload: 'open', close_payload: 'closed',
    state_path: 'value', timestamp_path: 'timestamp', cover_state_path: 'cover_state',
    availability_topic: 'invented/door/availability', bridge_availability_topic: 'invented/bridge' } };
function fixture(t, config = door, options = {}) {
  const store = new Store(':memory:'), observations = [], publications = [];
  let now = INITIAL, authority = true;
  const settings = equipmentConfiguration({ devices: [config] });
  const engine = { clock: () => now, ingest: row => observations.push(row) };
  const capture = createEquipmentCapture({ engine, store, settings, canControl: () => authority,
    publish: async (topic, payload, options) => { options.beforePublish?.(); publications.push({ topic, payload, options }); }, ...options });
  t.after(() => { capture.close(); store.close(); });
  const report = (state = 'closed', at = now, retain = false) => capture.receive('invented/door/state', JSON.stringify({
    value: state === 'closed' ? 'closed' : 'open', cover_state: state, timestamp: new Date(at).toISOString(),
  }), { retain });
  const online = () => capture.receive('invented/door/availability', 'online');
  capture.setConnected(true); capture.confirmSubscriptions(capture.topics);
  return { store, engine, capture, settings, observations, publications, report, online,
    advance: milliseconds => { now += milliseconds; }, authority: allowed => { authority = allowed; },
    status: () => capture.status().devices[0] };
}

test('cover configuration permits only explicit distinct MQTT door routes and supported payloads', () => {
  for (const config of [{ ...door, kind: 'switch' }, { ...door, connection: 'shelly:invented/door' },
    { ...door, mqtt: {} }, { ...door, mqtt: { ...door.mqtt, close_payload: 'open' } },
    { ...door, mqtt: { ...door.mqtt, stop_payload: '' } },
    { ...door, mqtt: { ...door.mqtt, command_topic: door.mqtt.availability_topic } }])
    assert.throws(() => equipmentConfiguration({ devices: [config] }));
  assert.throws(() => equipmentConfiguration({ devices: [door, { ...door, id: 'garage_door2', connection: 'mqtt:invented/other' }] }), /dedicated/);
  const supported = equipmentConfiguration({ devices: [{ ...door, mqtt: { ...door.mqtt, stop_payload: 'stop' } }] }).devices[0];
  assert.equal(supported.controlsCover, true); assert.equal(supported.mqtt.stopPayload, 'stop');
  assert.notEqual(equipmentSignature(supported), equipmentSignature(equipmentConfiguration({ devices: [door] }).devices[0]));
  const relay = equipmentConfiguration({ devices: [{ id: 'relay', kind: 'switch', connection: 'mqtt:invented/relay',
    switch_control: true, mqtt: { command_topic: 'invented/relay/set', on_payload: 'ON', off_payload: 'OFF' } }] }).devices[0];
  const previous = structuredClone(relay); delete previous.controlsCover;
  for (const key of ['openPayload', 'closePayload', 'stopPayload', 'coverStatePath']) delete previous.mqtt[key];
  assert.equal(equipmentSignature(relay), equipmentSignature(previous), 'Unchanged switch restoration routes preserve their signature');
});

test('event door observation enters the model only after contact and live availability agree in either order', t => {
  const f = fixture(t); f.advance(600_000); f.report('closed', INITIAL);
  assert.equal(f.observations.length, 0); assert.equal(f.status().available, false);
  f.capture.receive('invented/door/availability', 'online', { retain: true });
  assert.equal(f.observations.length, 0);
  f.online();
  assert.equal(f.observations.length, 1);
  assert.equal(f.observations[0].sourceTime, INITIAL);
  assert.deepEqual(f.observations[0].raw, { timeBasis: 'mqtt-live-status', eventOnly: true,
    availabilityConfirmed: true, confirmedAt: INITIAL + 600_000 });
  f.advance(86_400_000); f.capture.tick(); assert.equal(f.status().available, true);
  f.capture.receive('invented/bridge', 'offline');
  assert.equal(f.observations.at(-1).value, null);
  f.capture.receive('invented/bridge', 'online'); f.online();
  assert.equal(f.status().available, false, 'Availability alone cannot restore cached contact');
  f.report('closed', INITIAL);
  assert.equal(f.status().available, true);
  assert.equal(f.observations.at(-1).sourceTime, INITIAL);
  assert.equal(f.observations.at(-1).raw.confirmedAt, INITIAL + 600_000 + 86_400_000);
});

test('door operations validate selection and authority without publishing unsupported or unavailable actions', async t => {
  const f = fixture(t);
  for (const input of [null, [], {}, { deviceId: door.id, action: 'toggle' }, { deviceId: 'unknown', action: 'open' },
    { deviceId: door.id, action: 'stop' }, { deviceId: door.id, action: 'open', topic: 'invented/arbitrary' },
    { deviceId: door.id, action: 'open' }]) await assert.rejects(f.capture.setCover(input));
  f.report(); f.online(); f.authority(false);
  assert.equal(f.status().cover.available, false);
  await assert.rejects(f.capture.setCover({ deviceId: door.id, action: 'open' }), /unavailable/);
  assert.deepEqual(f.publications, []);
  assert.deepEqual(f.status().controls.cover, { open: true, close: true, stop: false });
});

test('an unanswered explicit door query invalidates event state until live cached-source recovery', async t => {
  const f = fixture(t, { ...door, mqtt: { ...door.mqtt, request_topic: 'invented/door/get', request_payload: 'status_update' } },
    { readbackTimeoutMs: 20 });
  await new Promise(resolve => setImmediate(resolve));
  f.report(); f.online(); assert.equal(f.status().available, true);
  f.advance(600_000);
  const result = await f.capture.recheck({ deviceId: door.id });
  assert.equal(result.devices[0].check.status, 'timeout'); assert.equal(f.status().available, false);
  assert.equal(f.observations.at(-1).value, null);
  assert.equal(f.status().readings.garage_door1_open.value, 0);
  assert.equal(f.status().readings.garage_door1_open.observedAt, INITIAL);
  f.online(); assert.equal(f.status().available, false);
  f.report('closed', INITIAL);
  assert.equal(f.status().available, true); assert.equal(f.observations.at(-1).sourceTime, INITIAL);
  assert.equal(f.observations.at(-1).raw.confirmedAt, INITIAL + 600_000);
});

test('an explicitly finite door deadline expires by source time despite a new cached reply', t => {
  const f = fixture(t, { ...door, max_age_seconds: 120 });
  f.report(); f.online(); assert.equal(f.status().available, true);
  f.advance(120_000); f.report('closed', INITIAL); f.capture.tick();
  assert.equal(f.status().available, false); assert.equal(f.observations.at(-1).value, null);
  assert.equal(f.status().readings.garage_door1_open.observedAt, INITIAL);
});

test('broker acknowledgement and cached/opening contact do not claim observed open; fresh terminal state does', async t => {
  const f = fixture(t); f.report(); f.online(); f.advance(1000);
  const result = await f.capture.setCover({ deviceId: door.id, action: 'open' });
  assert.equal(result.confirmed, false); assert.equal(result.acknowledgement, 'mqtt-broker');
  assert.equal(f.status().cover.operation.status, 'published'); assert.equal(f.status().cover.state, 'closed');
  const { beforePublish, signal, ...flags } = f.publications[0].options;
  assert.equal(typeof beforePublish, 'function'); assert(signal instanceof AbortSignal);
  assert.deepEqual({ ...f.publications[0], options: flags }, { topic: door.mqtt.command_topic, payload: 'open', options: { qos: 1, retain: false, noReplay: true } });
  f.report('open', INITIAL); assert.equal(f.status().cover.operation.status, 'published');
  f.advance(1000); f.report('opening'); assert.equal(f.status().cover.operation.status, 'published');
  f.advance(1000); f.report('open', INITIAL + 3000, true); assert.equal(f.status().cover.operation.status, 'published');
  f.report('open'); assert.equal(f.status().cover.operation.status, 'observed');
  assert.equal(f.status().cover.operation.observedAt, INITIAL + 3000);
});

test('supported Stop can supersede an opening request before its publication completes', async t => {
  const pending = [], sent = [];
  const f = fixture(t, { ...door, mqtt: { ...door.mqtt, stop_payload: 'stop' } }, {
    publish: (topic, payload, options) => { options.beforePublish(); return new Promise(resolve => { sent.push(payload); pending.push(resolve); }); },
  });
  f.report(); f.online();
  const opening = f.capture.setCover({ deviceId: door.id, action: 'open' });
  const stop = f.capture.setCover({ deviceId: door.id, action: 'stop' });
  assert.deepEqual(sent, ['open', 'stop']); assert.equal(f.status().controls.cover.stop, true);
  pending[1](); await stop; pending[0](); await opening;
  assert.equal(f.status().cover.operation.action, 'stop'); assert.equal(f.status().cover.operation.status, 'published');
  f.advance(120_000); f.capture.tick(); assert.equal(f.status().cover.operation.status, 'published');
  assert.equal(f.status().cover.state, 'closed');
});

test('unobserved movement times out honestly and reconnect never repeats a manual command', async t => {
  const f = fixture(t); f.report(); f.online();
  await f.capture.setCover({ deviceId: door.id, action: 'open' });
  f.advance(60_000); f.capture.tick(); assert.equal(f.status().cover.operation.status, 'unconfirmed');
  f.capture.setConnected(false); f.capture.setConnected(true); f.capture.confirmSubscriptions(f.capture.topics);
  assert.equal(f.publications.length, 1); assert.equal(f.status().cover.available, false);
  f.report(); f.online(); await f.capture.setCover({ deviceId: door.id, action: 'close' });
  f.capture.receive('invented/door/availability', 'offline');
  assert.equal(f.status().cover.operation.status, 'unconfirmed');
});

test('a failed publication exposes no broker detail and remains an unconfirmed delivery', async t => {
  const f = fixture(t, door, { publish: async (_topic, _payload, options) => { options.beforePublish(); throw new Error('synthetic broker internals'); } });
  f.report(); f.online(); await assert.rejects(f.capture.setCover({ deviceId: door.id, action: 'open' }), /unconfirmed/);
  assert.equal(f.status().cover.operation.status, 'unconfirmed');
  assert.equal(JSON.stringify(f.status()).includes('internals'), false);
});

test('MQTT removes nonreplayable door packets on disconnect, unsent disconnect and timeout', async t => {
  for (const reason of ['disconnect', 'unsent-disconnect', 'timeout', 'identical-pending']) await t.test(reason, async t => {
    const f = fixture(t), client = new EventEmitter(), sent = [], removed = [], pending = new Map();
    let id = 0;
    client.getLastMessageId = () => id;
    client.subscribe = (topic, options, done) => done(null, [{ topic, qos: 1 }]);
    client.publish = (topic, payload, options, done) => {
      const messageId = ++id; sent.push({ topic, payload, options }); pending.set(messageId, done);
      if (reason === 'unsent-disconnect') client.emit('offline');
      else if (reason !== 'identical-pending') client.emit('packetsend', { cmd: 'publish', messageId, topic, payload });
    };
    client.removeOutgoingMessage = messageId => { removed.push(messageId); pending.get(messageId)?.(new Error('removed')); pending.delete(messageId); };
    client.end = (force, options, done) => done();
    const acquisition = await startMqtt({ engine: f.engine, store: f.store,
      config: { h66: { readbackTimeoutMs: 20 }, connections: { equipment: f.settings, mqtt: { address: 'mqtt://synthetic.invalid' } } }, connect: () => client });
    t.after(() => acquisition.close()); client.emit('connect');
    client.emit('message', 'invented/door/state', Buffer.from(JSON.stringify({ value: 'closed', cover_state: 'closed', timestamp: new Date(INITIAL).toISOString() })), {});
    client.emit('message', 'invented/door/availability', Buffer.from('online'), {});
    const command = acquisition.equipment.setCover({ deviceId: door.id, action: 'open' });
    const repeated = reason === 'identical-pending' ? acquisition.equipment.setCover({ deviceId: door.id, action: 'open' }) : null;
    if (['disconnect', 'identical-pending'].includes(reason)) client.emit('offline');
    await assert.rejects(command, /unconfirmed/);
    if (repeated) await assert.rejects(repeated, /unconfirmed/);
    assert.deepEqual(removed, repeated ? [1, 2] : [1]); assert.equal(pending.size, 0);
    assert.deepEqual(sent[0].options, { qos: 1, retain: false });
    client.emit('connect'); assert.equal(sent.length, repeated ? 2 : 1);
  });
});

test('a door movement never enters an MQTT outgoing replay queue', async t => {
  const f = fixture(t), client = new EventEmitter(), sent = [];
  client.subscribe = (topic, options, done) => done(null, [{ topic, qos: 1 }]);
  client.publish = (...args) => sent.push(args);
  client.end = (force, options, done) => done();
  const acquisition = await startMqtt({ engine: f.engine, store: f.store,
    config: { connections: { equipment: f.settings, mqtt: { address: 'mqtt://synthetic.invalid' } } }, connect: () => client });
  t.after(() => acquisition.close()); client.emit('connect');
  client.emit('message', 'invented/door/state', Buffer.from(JSON.stringify({ value: 'closed', timestamp: new Date(INITIAL).toISOString() })), {});
  client.emit('message', 'invented/door/availability', Buffer.from('online'), {});
  client._storeProcessing = true;
  await assert.rejects(acquisition.equipment.setCover({ deviceId: door.id, action: 'open' }), /unconfirmed/);
  client._storeProcessing = false; client._storeProcessingQueue = [{}];
  await assert.rejects(acquisition.equipment.setCover({ deviceId: door.id, action: 'open' }), /unconfirmed/);
  assert.equal(sent.length, 0);
});
