import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import mqttPacket from 'mqtt-packet';
import { createHeatingTransport, HEATING_COMMANDS } from '../src/control/mqtt.js';

async function broker(t, onPacket, returnCode = 0) {
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const parser = mqttPacket.parser();
    parser.on('packet', packet => {
      if (packet.cmd === 'connect') socket.write(mqttPacket.generate({ cmd: 'connack', returnCode }));
      onPacket(packet, socket);
    });
    socket.on('data', data => parser.parse(data));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { address: `mqtt://127.0.0.1:${server.address().port}` };
}
function fakeClient() {
  const client = new EventEmitter();
  client.published = [];
  client.publish = (topic, payload, options, callback) => client.published.push({ topic, payload, options, callback });
  client.endCalls = [];
  client.end = (force, options, callback) => { client.endCalls.push({ force, options }); callback(); };
  return client;
}

test('real MQTT publishes legacy commands in order only after PUBACK, without retaining, over fresh connections', { timeout: 5000 }, async t => {
  const packets = [];
  const published = new EventEmitter();
  const connection = await broker(t, (packet, socket) => {
    packets.push(packet);
    if (packet.cmd === 'publish') published.emit('publish', { packet, socket });
  });
  const transport = createHeatingTransport({ connection, timeoutMs: 2000 });
  t.after(() => transport.close());
  const next = () => new Promise(resolve => published.once('publish', resolve));
  let firstPacket = next();
  let settled = false;
  const result = transport.publish(['heaton15', 'heatoff']).then(value => { settled = true; return value; });
  const first = await firstPacket;
  await delay(25);
  assert.equal(settled, false, 'Writing a packet is not reported as broker acknowledgement');
  assert.equal(packets.filter(packet => packet.cmd === 'publish').length, 1, 'Second command waits for first PUBACK');
  let secondPacket = next();
  first.socket.write(mqttPacket.generate({ cmd: 'puback', messageId: first.packet.messageId }));
  const second = await secondPacket;
  assert.equal(settled, false);
  second.socket.write(mqttPacket.generate({ cmd: 'puback', messageId: second.packet.messageId }));
  assert.deepEqual(await result, { status: 'mqtt', sent: true, actual: null });

  const thirdPacket = next();
  const thirdResult = transport.publish(['heatoff']);
  const third = await thirdPacket;
  third.socket.write(mqttPacket.generate({ cmd: 'puback', messageId: third.packet.messageId }));
  await thirdResult;
  assert.equal(packets.filter(packet => packet.cmd === 'connect').length, 2);
  assert.ok(packets.filter(packet => packet.cmd === 'connect').every(packet => packet.clean));
  assert.deepEqual(packets.filter(packet => packet.cmd === 'publish').map(packet => ({
    topic: packet.topic, command: packet.payload.toString(), qos: packet.qos, retain: packet.retain,
  })), ['heaton15', 'heatoff', 'heatoff'].map(command => ({ topic: 'from_stmq/heat/action', command, qos: 1, retain: false })));
});

test('commands are all validated before dialing and copied before awaiting connection', async () => {
  assert.deepEqual(HEATING_COMMANDS, ['heatoff', 'heaton15', 'heaton60']);
  assert.ok(Object.isFrozen(HEATING_COMMANDS));
  const client = fakeClient();
  let calls = 0;
  const transport = createHeatingTransport({ connection: { address: 'mqtt://example.invalid' }, connect: () => { calls++; return client; } });
  for (const commands of [null, [], Array(1), 'heatoff', ['heatoff', 'unknown'], ['HEATOFF'], ['heatoff '], ['heaton60'], [7]]) {
    await assert.rejects(transport.publish(commands), { code: 'MQTT_COMMAND_INVALID' });
  }
  assert.equal(calls, 0);
  const commands = ['heatoff'];
  const result = transport.publish(commands);
  commands[0] = 'invalid';
  client.emit('connect');
  assert.equal(client.published[0].payload, 'heatoff');
  client.published[0].callback();
  await result;
  await transport.close();
});

test('pending acknowledgement blocks concurrent commands and shutdown cancels the batch without late sends', async () => {
  const client = fakeClient();
  let options;
  const transport = createHeatingTransport({ connection: { address: 'mqtt://example.invalid', user: 'example', pw: 'example-password' },
    connect: (address, opts) => { options = opts; return client; } });
  const result = transport.publish(['heaton15', 'heatoff']);
  const rejected = assert.rejects(result, { code: 'MQTT_CLOSED' });
  client.emit('connect');
  assert.equal(options.reconnectPeriod, 0);
  assert.equal(options.queueQoSZero, false);
  assert.equal(options.clean, true);
  assert.equal(options.username, 'example');
  assert.equal(options.password, 'example-password');
  await assert.rejects(transport.publish(['heatoff']), { code: 'MQTT_BUSY' });
  await transport.close();
  await rejected;
  assert.equal(client.endCalls.length, 1);
  assert.equal(client.endCalls[0].force, true);
  client.published[0].callback();
  client.emit('connect');
  client.emit('error', new Error('late private broker failure'));
  assert.equal(client.published.length, 1);
  await assert.rejects(transport.publish(['heatoff']), { code: 'MQTT_CLOSED' });
});

test('connection and PUBACK timeouts close clients and cannot publish delayed commands', async () => {
  for (const connected of [false, true]) {
    const client = fakeClient();
    const transport = createHeatingTransport({ connection: { address: 'mqtt://example.invalid' }, connect: () => client, timeoutMs: 15 });
    const result = transport.publish(['heaton15', 'heatoff']);
    if (connected) client.emit('connect');
    await assert.rejects(result, error => {
      assert.equal(error.code, connected ? 'MQTT_TIMEOUT' : 'MQTT_CONNECTION_TIMEOUT');
      assert.match(error.message, connected ? /may have reached the device/ : /No command was sent/);
      return true;
    });
    assert.equal(client.endCalls[0].force, true);
    client.emit('connect');
    client.published[0]?.callback();
    assert.equal(client.published.length, connected ? 1 : 0);
    await transport.close();
  }
});

test('factory, broker, publish, and disconnect errors are safe and stop the rest of a batch', async () => {
  for (const fail of ['factory', 'broker', 'callback', 'publish', 'disconnect']) {
    const client = fakeClient();
    const rawError = new Error('invented secret broker credential must not escape');
    const transport = createHeatingTransport({ connection: { address: 'mqtt://example.invalid' }, connect: () => {
      if (fail === 'factory') throw rawError;
      return client;
    } });
    if (fail === 'publish') client.publish = () => { throw rawError; };
    const result = transport.publish(['heaton15', 'heatoff']);
    if (fail !== 'factory') {
      if (fail === 'broker') client.emit('error', rawError);
      else {
        client.emit('connect');
        if (fail === 'callback') client.published[0].callback(rawError);
        if (fail === 'disconnect') client.emit('close');
      }
    }
    await assert.rejects(result, error => {
      assert.equal(error.code, ['factory', 'broker'].includes(fail) ? 'MQTT_CONNECTION_FAILED' : 'MQTT_UNAVAILABLE');
      assert.doesNotMatch(error.message, /invented|secret|credential/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.ok(client.published.length <= 1);
    if (fail !== 'factory') assert.equal(client.endCalls[0].force, true);
    await transport.close();
  }
});

test('connection failures identify the cause without exposing broker details or sending commands', async () => {
  for (const [rawCode, expected] of [
    ['ECONNREFUSED', 'MQTT_CONNECTION_REFUSED'], ['EHOSTUNREACH', 'MQTT_NETWORK_UNREACHABLE'],
    ['ENETUNREACH', 'MQTT_NETWORK_UNREACHABLE'], ['ENOTFOUND', 'MQTT_DNS_FAILED'],
    ['EAI_AGAIN', 'MQTT_DNS_FAILED'], [4, 'MQTT_AUTH_FAILED'], [5, 'MQTT_AUTH_FAILED'],
    [134, 'MQTT_AUTH_FAILED'], [135, 'MQTT_AUTH_FAILED'], ['ETIMEDOUT', 'MQTT_CONNECTION_TIMEOUT'],
    ['CERT_HAS_EXPIRED', 'MQTT_TLS_FAILED'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'MQTT_TLS_FAILED'],
    ['unrecognized-private-code', 'MQTT_CONNECTION_FAILED'],
  ]) {
    const client = fakeClient();
    const transport = createHeatingTransport({ connection: { address: 'mqtt://example.invalid' }, connect: () => client });
    const result = transport.publish(['heaton15', 'heatoff']);
    client.emit('error', Object.assign(new Error('private broker credentials must not escape'), { code: rawCode }));
    await assert.rejects(result, error => {
      assert.equal(error.code, expected);
      assert.match(error.message, /No command was sent/);
      assert.doesNotMatch(error.message, /private|example\.invalid|may have reached/);
      assert.equal(error.cause, undefined);
      return true;
    });
    client.emit('connect');
    assert.equal(client.published.length, 0, 'A late connection must not send the failed test');
    await transport.close();
  }
});

test('real broker login rejection is reported before publishing', { timeout: 5000 }, async t => {
  const packets = [];
  const connection = await broker(t, packet => packets.push(packet), 5);
  const transport = createHeatingTransport({ connection, timeoutMs: 2000 });
  t.after(() => transport.close());
  await assert.rejects(transport.publish(['heaton15']), error => {
    assert.equal(error.code, 'MQTT_AUTH_FAILED');
    assert.match(error.message, /rejected the login or access permissions/);
    assert.match(error.message, /No command was sent/);
    return true;
  });
  assert.equal(packets.filter(packet => packet.cmd === 'connect').length, 1);
  assert.equal(packets.filter(packet => packet.cmd === 'publish').length, 0);
});

test('network errors after a publish keep delivery uncertainty and stop the remaining batch', async () => {
  const client = fakeClient();
  const transport = createHeatingTransport({ connection: { address: 'mqtt://example.invalid' }, connect: () => client });
  const result = transport.publish(['heaton15', 'heatoff']);
  client.emit('connect');
  client.emit('error', Object.assign(new Error('private broker address'), { code: 'EHOSTUNREACH' }));
  await assert.rejects(result, error => {
    assert.equal(error.code, 'MQTT_UNAVAILABLE');
    assert.match(error.message, /may have reached the device/);
    assert.doesNotMatch(error.message, /No command was sent|private/);
    return true;
  });
  client.published[0].callback();
  assert.equal(client.published.length, 1);
  await transport.close();
});

test('DHWR uses nonretained ON and OFF switch messages and refuses untimed button intents', async () => {
  const clients = [];
  const transport = createHeatingTransport({ connection: { address: 'mqtt://example.invalid', dhwr_topic: 'example/dhwr/set' },
    connect: () => { const client = fakeClient(); clients.push(client); return client; } });
  for (const on of [true, false]) {
    const result = transport.publishDhwr(on), client = clients.at(-1);
    client.emit('connect');
    assert.equal(client.published[0].topic, 'example/dhwr/set');
    assert.equal(client.published[0].payload, on ? 'ON' : 'OFF');
    assert.deepEqual(client.published[0].options, { qos: 1, retain: false });
    client.published[0].callback();
    assert.equal((await result).sent, true);
  }
  await assert.rejects(transport.publish(['heaton60']), { code: 'MQTT_COMMAND_INVALID' });
  await assert.rejects(transport.publishDhwr('ON'), { code: 'MQTT_COMMAND_INVALID' });
  assert.equal(clients.length, 2);
  await transport.close();
});

test('direct heating routing preserves DHWR transport and prevents queued dispatch after authority loss', async () => {
  let owns = true, calls = 0;
  const transport = createHeatingTransport({ connection: { address: 'mqtt://example.invalid' }, canControl: () => owns,
    connect() { throw new Error('Legacy heating broker route must not be used'); } });
  transport.setHeatingRelay(async commands => { calls++; assert.deepEqual(commands, ['heatoff']); return { sent: true }; });
  assert.equal((await transport.publish(['heatoff'])).sent, true);
  const pending = transport.publish(['heatoff']); owns = false;
  await assert.rejects(pending, { code: 'MQTT_AUTHORITY_LOST' });
  assert.equal(calls, 1);
  await transport.close();
});
