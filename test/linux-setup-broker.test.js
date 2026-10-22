import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { probeMQTTBroker, canProvisionBroker, linuxHAMqttRoute, newBrokerCredentials, verifySetupBrokers, BrokerProbeError } from '../scripts/lib/linux-setup-broker.js';

const secret = 'synthetic-private-password';

async function broker(t, { accepted = true, answer = true } = {}) {
  const received = [], sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let data = Buffer.alloc(0);
    socket.on('data', bytes => {
      data = Buffer.concat([data, bytes]);
      while (data.length >= 2) {
        let length = 0, multiplier = 1, offset = 1, octet;
        do { if (offset >= data.length) return; octet = data[offset++]; length += (octet & 127) * multiplier; multiplier *= 128; } while (octet & 128);
        if (data.length < offset + length) return;
        const packet = Buffer.from(data.subarray(0, offset + length)); received.push(packet); data = data.subarray(offset + length);
        if (packet[0] === 0x10 && answer) socket.write(Buffer.from([0x20, 0x02, 0x00, accepted ? 0 : 5]));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { address: `mqtt://127.0.0.1:${server.address().port}`, received };
}

function connectPayload(packet) {
  let offset = 1; while (packet[offset++] & 128) {}
  const utf8 = () => { const size = packet.readUInt16BE(offset); offset += 2; const value = packet.subarray(offset, offset + size).toString('utf8'); offset += size; return value; };
  const protocol = utf8(), version = packet[offset++], flags = packet[offset++], keepalive = packet.readUInt16BE(offset); offset += 2;
  return { protocol, version, flags, keepalive, clientId: utf8(), username: flags & 0x80 ? utf8() : undefined, password: flags & 0x40 ? utf8() : undefined };
}

test('live disposable MQTT authentication creates only one clean ephemeral CONNECT and no equipment messages', async t => {
  const f = await broker(t);
  assert.deepEqual(await probeMQTTBroker({ address: f.address, user: 'synthetic-device', pw: secret }), { authenticated: true });
  assert.equal(f.received.length, 1); assert.equal(f.received[0][0], 0x10);
  const wire = connectPayload(f.received[0]);
  assert.deepEqual({ ...wire, clientId: undefined }, { protocol: 'MQTT', version: 4, flags: 0xc2, keepalive: 0,
    clientId: undefined, username: 'synthetic-device', password: secret });
  assert.match(wire.clientId, /^st-mq-setup-[a-f0-9-]{36}$/);
  assert.equal(wire.flags & 0x04, 0, 'no MQTT will is installed');
  assert.equal(f.received.some(packet => [0x30, 0x80].includes(packet[0] & 0xf0)), false);
});

test('broker authentication rejection is distinct from availability and never exposes credentials', async t => {
  const f = await broker(t, { accepted: false });
  await assert.rejects(probeMQTTBroker({ address: f.address, user: 'synthetic-user', pw: secret }), error =>
    error instanceof BrokerProbeError && error.code === 'authentication_failed' && !error.message.includes(secret));
  assert.equal(f.received.length, 1, 'refused connection is never retried');
});

test('silent broker and cancellation both have bounded completion with no retries', async t => {
  const f = await broker(t, { answer: false });
  const start = performance.now();
  await assert.rejects(probeMQTTBroker({ address: f.address }, { timeoutMs: 30 }), error => error.code === 'unavailable');
  assert(performance.now() - start < 1000); assert.equal(f.received.length, 1);
  const abort = new AbortController();
  const pending = probeMQTTBroker({ address: f.address, user: 'synthetic-user', pw: secret }, { signal: abort.signal });
  abort.abort(); await assert.rejects(pending, error => error.code === 'cancelled');
});

test('invalid origins, credential shapes and cancelled work never open a connection', async () => {
  let calls = 0; const connect = () => { calls++; throw new Error(secret); };
  for (const connection of [null, {}, { address: 'http://broker.invalid' }, { address: 'mqtt://user:private@broker.invalid' },
    { address: 'mqtt://broker.invalid/path' }, { address: 'mqtt://broker.invalid?clientId=other' },
    { address: 'mqtt://broker.invalid', user: 42 }, { address: 'mqtt://broker.invalid', pw: secret }]) {
    await assert.rejects(probeMQTTBroker(connection, { connect }), error => error.code === 'invalid_configuration' && !error.message.includes(secret));
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(probeMQTTBroker({ address: 'mqtt://broker.invalid' }, { connect, signal: abort.signal }), error => error.code === 'cancelled');
  assert.equal(calls, 0);
});

test('MQTT transport settings suppress reconnect, subscriptions, queues and any inherited session', async () => {
  let captured, ended = 0;
  const connect = (address, options) => {
    captured = { address, options }; const client = new EventEmitter(); client.end = force => { assert.equal(force, true); ended++; };
    queueMicrotask(() => client.emit('connect')); return client;
  };
  await probeMQTTBroker({ address: 'wss://broker.example.invalid/mqtt', user: 'synthetic', pw: secret }, { connect });
  assert.equal(captured.address, 'wss://broker.example.invalid/mqtt');
  assert.equal(captured.options.reconnectPeriod, 0); assert.equal(captured.options.resubscribe, false);
  assert.equal(captured.options.queueQoSZero, false); assert.equal(captured.options.clean, true);
  assert.equal(captured.options.will, undefined); assert.equal(captured.options.protocolVersion, 4);
  assert.equal(ended, 1);
});

test('arbitrary MQTT error text and late errors never become diagnostics or second attempts', async () => {
  let calls = 0, client;
  const connect = () => {
    calls++; client = new EventEmitter(); client.end = () => {};
    queueMicrotask(() => client.emit('error', Object.assign(new Error(secret), { code: 'synthetic-private-code' }))); return client;
  };
  await assert.rejects(probeMQTTBroker({ address: 'mqtt://broker.example.invalid', user: 'synthetic', pw: secret }, { connect }), error =>
    error instanceof BrokerProbeError && error.code === 'unavailable' && !error.message.includes(secret) && !error.message.includes('synthetic-private'));
  client.emit('error', new Error('synthetic-late-private-error')); assert.equal(calls, 1);
});

test('broker provisioning is restricted to the supported loopback listener and absent, managed or inactive stock installs', () => {
  assert.equal(canProvisionBroker('mqtt://127.0.0.1', { installed: false }), true);
  assert.equal(canProvisionBroker('mqtt://localhost', { installed: true, managed: true, active: true }), true);
  assert.equal(canProvisionBroker('mqtt://127.0.0.1:1883', { installed: true, stock: true, active: false }), true);
  for (const status of [{ installed: true, managed: false, active: false }, { installed: true, stock: false, active: true },
    { installed: true, stock: true, active: true }, {}]) assert.equal(canProvisionBroker('mqtt://127.0.0.1', status), false);
  for (const address of ['mqtts://127.0.0.1', 'mqtt://127.0.0.1:1885', 'mqtt://192.0.2.10', 'mqtt://remote.invalid'])
    assert.equal(canProvisionBroker(address, { installed: false }), false);
});

test('new broker credentials reuse file values or generate one account without per-credential interaction', () => {
  assert.deepEqual(newBrokerCredentials({ user: 'device', pw: secret }), { user: 'device', password: secret });
  const value = newBrokerCredentials({}, { random: bytes => Buffer.alloc(bytes, 1) });
  assert.equal(value.user, 'st-mq'); assert.equal(value.password, '01'.repeat(32));
});

test('HA settings import derives the separate Linux HA route from the actual published port and fixed peer host', () => {
  const sourceOptions = { mqtt: { address: 'mqtt://core-mosquitto', user: 'synthetic-ha', pw: secret } };
  assert.deepEqual(linuxHAMqttRoute({ sourceOptions, peerUrl: 'http://192.0.2.10:1244', brokerPort: 1885 }),
    { address: 'mqtt://192.0.2.10:1885', user: 'synthetic-ha', pw: secret });
  const newCredentials = { user: 'new-ha-user', password: 'synthetic-new-password' };
  assert.deepEqual(linuxHAMqttRoute({ sourceOptions, peerUrl: 'http://[2001:db8::10]:1244', brokerPort: 1886, newCredentials }),
    { address: 'mqtt://[2001:db8::10]:1886', user: 'new-ha-user', pw: 'synthetic-new-password' });
  assert.equal(sourceOptions.mqtt.ha, undefined, 'source is unchanged');
});

test('HA import preserves an explicit destination route rather than replacing its chosen broker or credentials', () => {
  const existingRoute = { address: 'mqtts://other-broker.example.invalid:8883', user: 'existing-user', pw: secret };
  const result = linuxHAMqttRoute({ existingRoute });
  assert.deepEqual(result, existingRoute); assert.notEqual(result, existingRoute);
});

test('nonstandard source origins, TLS and unknown published HA ports require whole-file route review', () => {
  const source = { address: 'mqtt://core-mosquitto', user: 'synthetic-ha', pw: secret };
  for (const [address, brokerPort] of [['mqtt://core-mosquitto', null], ['mqtt://core-mosquitto', undefined],
    ['mqtt://core-mosquitto', 1883], ['mqtts://core-mosquitto', 1885], ['mqtt://other-broker.invalid', 1885],
    ['mqtt://core-mosquitto:1886', 1885]]) {
    assert.throws(() => linuxHAMqttRoute({ sourceOptions: { mqtt: { ...source, address } }, peerUrl: 'http://192.0.2.10:1244', brokerPort }),
      error => /mqtt\.ha/.test(error.message) && /private draft/.test(error.message) && !error.message.includes(secret));
  }
});

test('runtime broker verification skips simulation, permits remote standalone and checks the explicit HA route independently', async () => {
  const seen = [], probe = async value => { seen.push(value.address); return { authenticated: true }; };
  await verifySetupBrokers({ input: 'simulated', connections: { mqtt: { address: 'mqtt://not-used.invalid' } } }, { probe });
  assert.deepEqual(seen, []);
  const config = { input: 'providers', connections: { mqtt: { address: 'mqtt://remote.invalid', ha: { address: 'mqtt://ha.invalid' } } } };
  await verifySetupBrokers(config, { probe }); assert.deepEqual(seen, ['mqtt://remote.invalid', 'mqtt://ha.invalid']);
  seen.length = 0; await verifySetupBrokers(config, { probe, skipPrimary: true }); assert.deepEqual(seen, ['mqtt://ha.invalid']);
});
