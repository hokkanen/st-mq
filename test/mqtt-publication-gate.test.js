import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import mqtt from 'mqtt';
import mqttPacket from 'mqtt-packet';
import { gateMqttPublications } from '../src/control/mqtt-publication-gate.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, { holdStore = false, timeoutMs = 1000 } = {}) {
  let allowed = true, acknowledge = false;
  const wire = [], streams = [], delayed = [];
  const store = new mqtt.Store(), put = store.put.bind(store);
  store.put = (packet, callback) => put(packet, error => {
    if (holdStore && packet.cmd === 'publish') delayed.push(() => callback(error)); else callback(error);
  });
  const client = new mqtt.MqttClient(() => {
    const parser = mqttPacket.parser();
    const stream = new Duplex({ read() {}, write(chunk, _encoding, callback) { parser.parse(chunk); callback(); } });
    streams.push(stream);
    parser.on('packet', packet => {
      if (packet.cmd === 'connect') queueMicrotask(() => stream.push(mqttPacket.generate({ cmd: 'connack', returnCode: 0, sessionPresent: false })));
      if (packet.cmd === 'publish') {
        wire.push({ topic: packet.topic, allowed });
        if (acknowledge) queueMicrotask(() => stream.push(mqttPacket.generate({ cmd: 'puback', messageId: packet.messageId })));
      }
    });
    return stream;
  }, { reconnectPeriod: 0, clean: true, keepalive: 0, outgoingStore: store, queueQoSZero: false });
  client.on('error', () => {});
  const gate = gateMqttPublications(client, { canControl: () => allowed, timeoutMs });
  t.after(async () => { gate.revoke(); await client.endAsync(true); });
  await once(client, 'connect');
  const publish = (topic = 'invented/switch/set', { signal } = {}) => new Promise((resolve, reject) => client.publish(topic, 'ON', { qos: 1, retain: false, signal }, error => error ? reject(error) : resolve()));
  return { client, gate, wire, streams, delayed, store, publish,
    authority: value => { allowed = value; }, acknowledge: value => { acknowledge = value; },
    pendingCount: () => store._inflights.size };
}

test('installed MQTT.js: an asynchronous outgoing-store callback cannot dispatch after revocation', async t => {
  for (const topic of ['invented/switch/set', 'invented/gen1/relay/0/command', 'invented/gen2/rpc']) {
    const f = await fixture(t, { holdStore: true });
    const pending = f.publish(topic); const rejected = assert.rejects(pending, /unconfirmed/);
    assert.equal(f.pendingCount(), 1); assert.equal(f.wire.length, 0);
    f.authority(false); f.gate.revoke(); f.delayed.shift()(); await rejected; await flush();
    assert.equal(f.wire.length, 0); assert.equal(f.pendingCount(), 0);
  }
});

test('installed MQTT.js: sent but unacknowledged commands are removed before reconnect replay', async t => {
  const f = await fixture(t); const pending = f.publish(); const rejected = assert.rejects(pending, /unconfirmed/);
  await flush(); assert.equal(f.wire.length, 1); assert.equal(f.pendingCount(), 1);
  f.streams.at(-1).destroy(); await once(f.client, 'close'); await rejected;
  assert.equal(f.pendingCount(), 0);
  f.client.reconnect(); await once(f.client, 'connect'); await flush();
  assert.equal(f.wire.length, 1);
  f.acknowledge(true); await f.publish(); assert.equal(f.wire.length, 2, 'fresh same-owner intent remains supported');
});

test('installed MQTT.js: revocation from packetsend is checked before the first byte reaches the stream', async t => {
  const f = await fixture(t);
  f.client.on('packetsend', packet => { if (packet.cmd === 'publish') f.authority(false); });
  await assert.rejects(f.publish(), /unconfirmed/);
  assert.equal(f.wire.length, 0); assert.equal(f.pendingCount(), 0);
});

test('installed MQTT.js: timeout and failed entry authority leave no command queued for later store completion', async t => {
  const f = await fixture(t, { holdStore: true, timeoutMs: 20 });
  // The in-memory stream owns no socket handle, while the production deadline
  // deliberately does not keep an otherwise stopped process alive. Advance
  // that deadline explicitly instead of relying on another test's live handle.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(f.publish(), /unconfirmed/);
  t.mock.timers.tick(19);
  assert.equal(f.pendingCount(), 1); assert.equal(f.wire.length, 0);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(f.pendingCount(), 0, 'timeout cancels the stored command before the delayed callback');
  t.mock.timers.reset();
  f.delayed.shift()(); await flush();
  assert.equal(f.wire.length, 0); assert.equal(f.pendingCount(), 0);
  f.authority(false); await assert.rejects(f.publish(), /unconfirmed/);
  assert.equal(f.delayed.length, 0); assert.equal(f.pendingCount(), 0);
});

test('installed MQTT.js: an already cancelled command never enters the outgoing store', async t => {
  const f = await fixture(t, { holdStore: true }), cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(f.publish(undefined, { signal: cancellation.signal }), /unconfirmed/);
  assert.equal(f.delayed.length, 0); assert.equal(f.pendingCount(), 0); assert.equal(f.wire.length, 0);
});

test('installed MQTT.js: the caller deadline cancels delayed dispatch before the transport deadline', async t => {
  const f = await fixture(t, { holdStore: true, timeoutMs: 1000 }), cancellation = new AbortController();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(f.publish(undefined, { signal: cancellation.signal }), /unconfirmed/);
  setTimeout(() => cancellation.abort(), 20);
  t.mock.timers.tick(19);
  assert.equal(f.pendingCount(), 1); assert.equal(f.wire.length, 0);
  t.mock.timers.tick(1); await rejected;
  assert.equal(f.pendingCount(), 0, 'The original request deadline owns cancellation after a storage wait');
  t.mock.timers.reset(); f.delayed.shift()(); await flush();
  assert.equal(f.wire.length, 0); assert.equal(f.pendingCount(), 0);
});

test('installed MQTT.js: caller cancellation at packetsend prevents the first byte reaching the stream', async t => {
  const f = await fixture(t), cancellation = new AbortController();
  f.client.on('packetsend', packet => { if (packet.cmd === 'publish') cancellation.abort(); });
  await assert.rejects(f.publish(undefined, { signal: cancellation.signal }), /unconfirmed/);
  assert.equal(f.wire.length, 0); assert.equal(f.pendingCount(), 0);
});
