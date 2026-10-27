import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { Duplex } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mqtt from 'mqtt';
import mqttPacket from 'mqtt-packet';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { createAppServer } from '../src/app/server.js';
import { validateSettings } from '../src/app/config.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { garageDoorControl } from '../chart/garage-doors.js';
import { verifyJournal } from '../src/storage/journal.js';

const START = Date.parse('2026-10-27T09:00:00Z'), TOKEN = 'synthetic-garage-writer-admin-token';
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const deadline = performance.now() + 5000;
  while (!predicate()) { assert(performance.now() < deadline, 'The isolated door fixture did not settle'); await flush(); }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { native = false, heartbeat = false, shared = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-live-doors-')), store = new Store(join(directory, 'recording.sqlite'));
  let now = START, authority = true, denied = null, holdOutgoing = false;
  const commands = [], delayed = [], subscriptions = new Map(), streams = [];
  const door = { id: 'garage_door1', area: 'garage', kind: 'door', connection: 'mqtt:fixture/door/state', cover_control: true,
    mqtt: { command_topic: 'fixture/door/set', open_payload: 'open', close_payload: 'closed', stop_payload: 'stop',
      state_path: 'value', timestamp_path: 'timestamp', cover_state_path: 'cover_state', availability_topic: 'fixture/door/online',
      ...(shared ? { bridge_availability_topic: 'fixture/bridge' } : {}),
      ...(heartbeat ? { heartbeat_topic: 'fixture/heartbeat', heartbeat_seconds: 30 } : {}) } };
  const devices = [door, { id: 'switch', kind: 'switch', connection: 'mqtt:fixture/switch/state', switch_control: true,
    mqtt: { command_topic: 'fixture/switch/set', on_payload: 'ON', off_payload: 'OFF',
      state_path: 'value', availability_topic: 'fixture/switch/online', ...(shared ? { bridge_availability_topic: 'fixture/bridge' } : {}) } }];
  const engine = new Engine({ store, config: { input: 'mqtt', settings: validateSettings({}) }, clock: () => now });
  let reader, server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await reader?.close({ restore: false });
    engine.beginShutdown({ restore: false });
    await engine.closeFireplace(); await engine.executor.close({ restore: false });
    await engine.learningWorker?.close?.();
    await store.close(); rmSync(directory, { recursive: true, force: true });
  });
  // Establish an ordinary complete controller view before enabling the real
  // writer, just as startup does before exposing the running dashboard.
  await engine.update();
  engine.status();
  await store.startWriter();
  let client;
  if (native) {
    const outgoing = new mqtt.Store(), put = outgoing.put.bind(outgoing);
    outgoing.put = (packet, callback) => put(packet, error => {
      if (holdOutgoing && packet.cmd === 'publish' && packet.topic === 'fixture/door/set') delayed.push(() => callback(error));
      else callback(error);
    });
    client = new mqtt.MqttClient(() => {
      const parser = mqttPacket.parser();
      const stream = new Duplex({ read() {}, write(chunk, _encoding, callback) { parser.parse(chunk); callback(); } });
      streams.push(stream);
      parser.on('packet', packet => {
        if (packet.cmd === 'connect') queueMicrotask(() => stream.push(mqttPacket.generate({ cmd: 'connack', returnCode: 0, sessionPresent: false })));
        if (packet.cmd === 'subscribe') queueMicrotask(() => stream.push(mqttPacket.generate({ cmd: 'suback', messageId: packet.messageId,
          granted: packet.subscriptions.map(row => row.topic === denied ? 128 : 1) })));
        if (packet.cmd === 'publish') {
          commands.push({ topic: packet.topic, payload: String(packet.payload) });
          queueMicrotask(() => stream.push(mqttPacket.generate({ cmd: 'puback', messageId: packet.messageId })));
        }
      });
      return stream;
    }, { outgoingStore: outgoing, reconnectPeriod: 0, clean: true, keepalive: 0, queueQoSZero: false });
    client.on('error', () => {});
  } else {
    client = new EventEmitter();
    client.subscribe = (topic, _options, done) => {
      subscriptions.set(topic, done); done(null, [{ topic, qos: topic === denied ? 128 : 1 }]);
    };
    client.publish = (topic, payload, _options, done) => { commands.push({ topic, payload: String(payload) }); done(); };
    client.end = (_force, _options, done) => done?.();
  }
  reader = await startMqtt({ engine, store,
    config: { input: 'mqtt', h66: { readbackTimeoutMs: 1000 }, connections: {
      equipment: equipmentConfiguration({ devices }), mqtt: { address: 'mqtt://fixture.invalid' } } },
    connect: () => client, canControl: () => authority, reportStorageFailure: () => {} });
  if (native) { if (!client.connected) await once(client, 'connect'); }
  else client.emit('connect');
  const send = (topic, value, packet = {}) => client.emit('message', topic, Buffer.from(typeof value === 'object' ? JSON.stringify(value) : String(value)), packet);
  const report = (state = 'closed', timestamp = now, packet) => send('fixture/door/state', {
    value: state === 'closed' ? 'closed' : 'open', cover_state: state, timestamp: new Date(timestamp).toISOString() }, packet);
  const online = () => { send('fixture/door/online', 'online'); if (shared) send('fixture/bridge', 'online'); if (heartbeat) send('fixture/heartbeat', 'live'); };
  const status = () => reader.equipment.status().devices.find(device => device.id === door.id);
  await until(() => status().mqttStatus.subscriptionStatus === 'subscribed');
  report(); online();
  send('fixture/switch/state', { value: false }); send('fixture/switch/online', 'online');
  await until(() => store.writeQueueStatus().pending === 0);
  engine.status();
  server = createAppServer({ engine, store, token: TOKEN,
    familyToken: 'synthetic-garage-writer-family-token',
    controlAuthority: { canControl: () => authority, status: () => ({ protected: !authority }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, input, token = TOKEN, extra = {}) => {
    const response = await fetch(base + route, { method: input === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(2000), ...extra });
    return { code: response.status, body: await response.json() };
  };
  return { store, engine, reader, client, commands, delayed, subscriptions, streams, status, send, report, online, request,
    command: action => reader.equipment.setCover({ deviceId: door.id, action }),
    post: (action, token, extra) => request('/api/equipment/cover', { deviceId: door.id, action }, token, extra),
    at: value => { now = value; }, authority: value => { authority = value; }, deny: topic => { denied = topic; },
    holdOutgoing: value => { holdOutgoing = value; },
    async killWriter() { await store.writer.worker.terminate(); await until(() => Boolean(store.writer.failed)); },
  };
}

for (const lostReply of [false, true]) test(`door HTTP, current UI state and feedback survive a held ${lostReply ? 'lost' : 'failed'} COMMIT`, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const request = f.store.writer.request.bind(f.store.writer);
  f.store.writer.request = async (operation, ...args) => {
    if (operation !== 'commit') return request(operation, ...args);
    if (lostReply) await request(operation, ...args);
    entered.resolve(); await release.promise;
    if (lostReply) { f.store.writer.fail(Object.assign(new Error('synthetic lost reply'), { code: 'STORAGE_WRITER_UNAVAILABLE' })); throw f.store.writer.failed; }
    throw Object.assign(new Error('synthetic commit refusal'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
  };
  const saving = f.store.runWrite(() => {
    f.store.setState('fixture:unrelated', true);
    f.reader.equipment.receiveRecorded('fixture/switch/state', '{"value":true}', {}, START, 'primary');
  }).catch(error => error);
  await entered.promise;
  try {
    f.at(START + 1000);
    const opened = await f.post('open');
    assert.equal(opened.code, 200); assert.equal(opened.body.storagePending, true);
    assert.equal(opened.body.equipment.devices[0].cover.operation.status, 'published');
    f.at(START + 2000); f.report('open');
    const response = await f.request('/api/status');
    assert.equal(response.code, 200);
    const device = response.body.equipment.devices.find(row => row.id === 'garage_door1');
    assert.equal(response.body.equipment.devices.find(row => row.id === 'switch').readings.switch_active.value, 0,
      'Only door rows may cross the pending transaction boundary');
    assert.equal(device.cover.operation.status, 'observed'); assert.equal(device.cover.state, 'open');
    assert.equal(device.readings.garage_door1_open.observedAt, START + 2000);
    assert.equal(garageDoorControl(response.body, device).disabled, false);
    assert.equal((await f.post('stop')).code, 200);
    assert.deepEqual(f.commands.filter(row => row.topic === 'fixture/door/set').map(row => row.payload), ['open', 'stop']);
  } finally { release.resolve(); await saving; f.store.writer.request = request; }
  assert.equal(f.status().cover.state, 'open'); assert.equal(f.status().cover.operation.action, 'stop');
  await until(() => f.store.writeQueueStatus().pending === 0);
  assert.equal(f.commands.filter(row => row.topic === 'fixture/door/set').length, 2);
});

test('dead writer leaves only door controls available, including family access and MQTT reconnect', async t => {
  const f = await fixture(t, { shared: true }); await f.killWriter();
  f.at(START + 1000); assert.equal((await f.post('open', 'synthetic-garage-writer-family-token')).code, 200);
  f.report('open'); assert.equal(f.status().cover.operation.status, 'observed');
  assert.equal((await f.request('/api/garage/heating', { mode: 'away' })).code, 503);
  assert.equal((await f.request('/api/charging/settings', {})).code, 503);
  assert.equal((await f.request('/api/equipment/switch', { deviceId: 'switch', on: true })).code, 503);
  f.client.emit('offline'); assert.equal(f.status().cover.available, false);
  f.client.emit('connect'); f.online();
  f.report('closed', START, { retain: true }); assert.equal(f.status().cover.available, false);
  f.at(START + 2000); f.report('open');
  assert.equal(f.status().cover.available, true); assert.equal((await f.post('close')).code, 200);
  assert.equal((await f.post('stop', 'invalid-token')).code, 401);
  assert.equal((await f.post('stop', TOKEN, { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Origin: 'https://other.invalid' } })).code, 403);
  f.authority(false); assert.equal((await f.post('stop')).code, 409);
  assert.equal(f.commands.filter(row => row.topic === 'fixture/switch/set').length, 0);
});

test('dead writer cannot conceal offline, heartbeat expiry, future timestamps or denied subscriptions', async t => {
  const f = await fixture(t, { heartbeat: true }); await f.killWriter();
  f.at(START + 1000); f.report('open', START + 1400);
  assert.equal(f.status().cover.available, false); await assert.rejects(f.command('open'));
  f.at(START + 1400); f.reader.equipment.tickDoors();
  assert.equal(f.status().cover.available, true); assert.equal(f.status().readings.garage_door1_open.observedAt, START + 1400);
  f.at(START + 31_000); f.reader.equipment.tickDoors();
  assert.equal(f.status().cover.available, false); await assert.rejects(f.command('stop'));
  f.at(START + 32_000); f.online(); f.report('open');
  assert.equal(f.status().cover.available, true);
  f.send('fixture/door/online', 'offline'); assert.equal(f.status().cover.available, false);
  f.deny('fixture/door/state'); f.client.emit('offline'); f.client.emit('connect'); f.report(); f.online();
  assert.equal(f.status().cover.available, false); await assert.rejects(f.command('open'));
});

for (const change of ['stop', 'state', 'offline', 'authority', 'revoke', 'timeout', 'reconnect', 'shutdown'])
  test(`installed MQTT.js: ${change} fences delayed door bytes while writer is dead`, async t => {
    const f = await fixture(t, { native: true }); await f.killWriter(); f.holdOutgoing(true);
    const opening = f.command('open'); const rejected = assert.rejects(opening, /unconfirmed/);
    await until(() => f.delayed.length === 1);
    let stopping;
    if (change === 'stop') { f.holdOutgoing(false); stopping = f.command('stop'); }
    if (change === 'state') { f.at(START + 1000); f.report('opening'); }
    if (change === 'offline') f.send('fixture/door/online', 'offline');
    if (change === 'authority') f.authority(false);
    if (change === 'revoke') f.reader.revoke();
    if (change === 'timeout') f.at(START + 2000);
    if (change === 'reconnect') { f.streams.at(-1).destroy(); await once(f.client, 'close'); }
    if (change === 'shutdown') await f.reader.close({ restore: false });
    for (const resume of f.delayed.splice(0)) resume();
    await rejected; if (stopping) await stopping;
    assert.deepEqual(f.commands.filter(row => row.topic === 'fixture/door/set').map(row => row.payload), change === 'stop' ? ['stop'] : []);
    if (change === 'reconnect') { f.client.reconnect(); await once(f.client, 'connect'); await flush();
      assert.equal(f.commands.filter(row => row.topic === 'fixture/door/set').length, 0); }
  });

for (const admissionFailure of [false, true]) test(`an isolated failed door save (${admissionFailure ? 'admission' : 'commit'}) records a gap without undoing live state or inventing missed transitions`, async t => {
  const f = await fixture(t), original = f.store.writer.request.bind(f.store.writer);
  let fail = true;
  if (admissionFailure) {
    const write = f.store.runWrite.bind(f.store);
    t.mock.method(f.store, 'runWrite', (...args) => {
      if (fail) { fail = false; return Promise.reject(Object.assign(new Error('synthetic full queue'), { code: 'STORAGE_QUEUE_FULL' })); }
      return write(...args);
    });
  } else f.store.writer.request = async (operation, ...args) => {
    if (operation === 'commit' && fail) { fail = false; throw Object.assign(new Error('synthetic disk error'), { code: 'ERR_SQLITE_ERROR', errcode: 13 }); }
    return original(operation, ...args);
  };
  f.at(START + 1000); f.report('open');
  await until(() => f.store.writeQueueStatus().pending === 0);
  assert.equal(f.status().cover.state, 'open');
  f.at(START + 2000); f.report('closed');
  await until(() => f.store.writeQueueStatus().pending === 0);
  const rows = f.store.observations({ source: 'mqtt-equipment', device: 'garage_door1', signal: 'garage_door1_open' });
  assert(rows.some(row => row.value === null && row.quality.includes('recording-failed') && row.receivedAt === START + 1000));
  assert(!rows.some(row => row.value === 1), 'A lost open transition is not reconstructed as recorded evidence');
  assert(rows.some(row => row.value === 0 && row.sourceTime === START + 2000));
  assert.equal(f.store.getState('equipment:door:v1:garage_door1').reading.observedAt, START + 2000);
  assert(verifyJournal(f.store.db).commits > 0);
});
