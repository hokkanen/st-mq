import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { startProviders } from '../src/acquisition/providers.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createHeatingTransport } from '../src/control/mqtt.js';

const START = Date.parse('2026-10-07T09:00:00Z'), DEVICE = 'contention-fixture';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = performance.now() + 3000;
  while (!predicate()) { assert.ok(performance.now() < end, 'Condition did not settle'); await delay(5); }
}
async function fixture(t, input = 'mqtt', devices = []) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-acquisition-contention-'));
  const store = new Store(join(directory, 'recording.sqlite')), writer = new DatabaseSync(store.path);
  let now = START, locked = false, control = true;
  const config = { input, deviceId: DEVICE, h66: { writeEnabled: true, readbackTimeoutMs: 1000 },
    garage: { enabled: false }, connections: { mqtt: { address: 'mqtt://fixture.invalid' }, equipment: equipmentConfiguration({ devices }) } };
  const engine = new Engine({ store, config, clock: () => now });
  const client = new EventEmitter(), commands = [];
  client.subscribe = (_topic, _options, done) => done();
  client.publish = (topic, payload, _options, done) => { commands.push({ topic, payload }); done(); };
  client.end = (_force, _options, done) => done();
  const reader = input === 'mqtt' ? await startMqtt({ engine, store, config, connect: () => client, canControl: () => control }) : null;
  client.emit('connect');
  t.after(async () => {
    if (locked) writer.exec('ROLLBACK');
    await reader?.close({ restore: false }); await engine.garage.close({ restore: false });
    await engine.charging.close(); await engine.closeFireplace(); await engine.executor.close({ restore: false });
    writer.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, engine, config, client, reader, commands, clock: () => now, at: at => { now = at; },
    authority: value => { control = value; },
    lock() { writer.exec('BEGIN IMMEDIATE'); locked = true; },
    unlock() { writer.exec('ROLLBACK'); locked = false; },
    send(register, value, packet = {}) { client.emit('message', `${DEVICE}/HP/${register}`, Buffer.from(String(value)), packet); } };
}

async function relayFixture(t) {
  const f = await fixture(t, 'mqtt', [{ id: 'dhwr', kind: 'switch', connection: 'shelly:fixture-circulation', generation: 3 }]);
  const requests = method => f.commands.filter(row => row.topic === 'fixture-circulation/rpc')
    .map(row => JSON.parse(row.payload)).filter(row => row.method === method);
  const reply = (method, result) => {
    const request = requests(method).at(-1); assert.ok(request, `Expected ${method}`);
    f.client.emit('message', `${request.src}/rpc`, Buffer.from(JSON.stringify({
      id: request.id, src: 'fixture-circulation', dst: request.src, result,
    })), {});
  };
  reply('Shelly.GetDeviceInfo', { id: 'fixture-circulation', gen: 3 });
  reply('Shelly.GetStatus', { 'switch:0': { id: 0, output: false } });
  f.send('0203', 20);
  const transport = createHeatingTransport();
  transport.setDhwrRelay(f.reader.equipment.publishDhwr, () => f.reader.equipment.signature('dhwr'));
  t.after(() => transport.close());
  return { ...f, requests, reply, transport };
}

test('circulation waits for queued observations then publishes once and requires committed native readback', async t => {
  const f = await relayFixture(t);
  f.lock(); f.at(START + 1000); f.send('0203', 21);
  let result;
  const pending = f.transport.publishDhwr(true).then(value => { result = value; }, error => { result = error; });
  await delay(40);
  assert.equal(result, undefined, 'A short observation backlog must wait, not fail the circulation request');
  assert.equal(f.requests('Switch.Set').length, 0);
  assert.equal(f.reader.h66.status().readings['0203'].value, 20, 'Queued evidence is not yet usable');
  f.unlock(); await until(() => f.requests('Switch.Set').length === 1);
  assert.equal(f.reader.h66.status().readings['0203'].value, 21);
  assert.equal(f.requests('Switch.Set')[0].params.on, true);
  assert.equal(result, undefined, 'Broker delivery is not native confirmation');
  f.reply('Switch.Set', { was_on: false });
  await until(() => f.requests('Switch.GetStatus').length === 1);
  f.lock(); f.reply('Switch.GetStatus', { id: 0, output: true }); await delay(40);
  assert.equal(result, undefined, 'Readback must also commit');
  f.unlock(); await pending;
  assert.equal(result.confirmed, true); assert.equal(f.requests('Switch.Set').length, 1);
});

for (const interruption of ['authority', 'revocation', 'reconnect', 'expiry', 'identity', 'stale-feedback', 'recording-failure', 'shutdown']) {
  test(`waiting circulation rejects ${interruption} and never publishes after the backlog clears`, async t => {
    const f = await relayFixture(t);
    f.lock(); f.at(START + 1000); f.send('0203', 21);
    const pending = f.transport.publishDhwr(true, { validUntil: interruption === 'stale-feedback' ? Infinity : START + 60_000, clock: f.clock });
    const rejected = assert.rejects(pending);
    await delay(20); assert.equal(f.requests('Switch.Set').length, 0);
    if (interruption === 'authority') f.authority(false);
    if (interruption === 'revocation') { f.reader.revoke(); await rejected; }
    if (interruption === 'reconnect') { f.client.emit('offline'); f.client.emit('connect'); }
    if (interruption === 'expiry') f.at(START + 60_000);
    if (interruption === 'stale-feedback') f.at(START + 60 * 60_000);
    if (interruption === 'identity') f.client.emit('message', 'fixture-circulation/online', Buffer.from('true'), {});
    if (interruption === 'recording-failure') failNextCommit(f.store);
    if (interruption === 'shutdown') await f.reader.close({ restore: false });
    f.unlock(); await rejected; await until(() => f.store.writeQueueStatus().pending === 0);
    assert.equal(f.requests('Switch.Set').length, 0);
  });
}

test('circulation timeout cancels an unsent command before a later storage recovery', async t => {
  const f = await relayFixture(t);
  f.lock(); f.send('0203', 21);
  await assert.rejects(f.transport.publishDhwr(true), { code: 'SHELLY_READBACK_TIMEOUT' });
  f.unlock(); await until(() => f.store.writeQueueStatus().pending === 0); await delay(20);
  assert.equal(f.requests('Switch.Set').length, 0, 'An expired request cannot escape after storage recovers');
});

test('a failed observation retains its specific dispatch failure and no raw transport error', async t => {
  const f = await relayFixture(t);
  failNextCommit(f.store); f.send('0203', 21); await delay(0);
  await assert.rejects(f.transport.publishDhwr(true), { code: 'MQTT_STORAGE_FAILED' });
  assert.equal(f.requests('Switch.Set').length, 0);
});

test('Gen1 relay waits for observations and requires new committed state after dispatch', async t => {
  const f = await fixture(t, 'mqtt', [{ id: 'relay', kind: 'switch', connection: 'shelly:shellies/fixture-relay',
    generation: 1, switch_control: true }]);
  const commands = () => f.commands.filter(row => row.topic.endsWith('/relay/0/command'));
  f.client.emit('message', 'shellies/fixture-relay/relay/0', Buffer.from('off'), {});
  f.lock(); f.at(START + 1000); f.send('0203', 21);
  let result;
  const pending = f.reader.equipment.setSwitch('relay', false).then(value => { result = value; }, error => { result = error; });
  await delay(20); assert.equal(result, undefined); assert.equal(commands().length, 0);
  f.client.emit('message', 'shellies/fixture-relay/relay/0', Buffer.from('off'), {});
  f.unlock(); await until(() => commands().length === 1);
  assert.equal(result, undefined, 'A matching state received before dispatch cannot confirm this command');
  assert.equal(commands()[0].payload, 'off');
  f.lock(); f.client.emit('message', 'shellies/fixture-relay/relay/0', Buffer.from('off'), {});
  await delay(20); assert.equal(result, undefined, 'The new state must commit before confirmation');
  f.unlock(); await pending;
  assert.equal(result.confirmed, true); assert.equal(commands().length, 1);
});

for (const interruption of ['reconnect', 'device-offline', 'stale-feedback', 'changed-state', 'caller-scope', 'revocation']) {
  test(`waiting Gen1 relay rejects ${interruption} without late dispatch`, async t => {
    const f = await fixture(t, 'mqtt', [{ id: 'relay', kind: 'switch', connection: 'shelly:shellies/fixture-relay',
      generation: 1, switch_control: true }]);
    f.client.emit('message', 'shellies/fixture-relay/relay/0', Buffer.from('on'), {});
    f.lock(); f.at(START + 1000); f.send('0203', 21);
    let current = true;
    const rejected = assert.rejects(f.reader.equipment.setSwitch('relay', false, { beforePublish: () => {
      assert.equal(current, true, 'The original manual or timed action must remain current');
    } }));
    await delay(20);
    if (interruption === 'reconnect') { f.client.emit('offline'); f.client.emit('connect'); }
    if (interruption === 'device-offline') f.client.emit('message', 'shellies/fixture-relay/online', Buffer.from('false'), {});
    if (interruption === 'stale-feedback') f.at(START + 60 * 60_000);
    if (interruption === 'changed-state') f.client.emit('message', 'shellies/fixture-relay/relay/0', Buffer.from('off'), {});
    if (interruption === 'caller-scope') current = false;
    if (interruption === 'revocation') f.reader.revoke();
    f.unlock(); await rejected; await until(() => f.store.writeQueueStatus().pending === 0);
    assert.equal(f.commands.some(row => row.topic.endsWith('/relay/0/command')), false);
  });
}

test('Gen1 timeout cancels the unsent command before later storage recovery', async t => {
  const f = await fixture(t, 'mqtt', [{ id: 'relay', kind: 'switch', connection: 'shelly:shellies/fixture-relay',
    generation: 1, switch_control: true }]);
  f.client.emit('message', 'shellies/fixture-relay/relay/0', Buffer.from('on'), {});
  f.lock(); f.send('0203', 21);
  await assert.rejects(f.reader.equipment.setSwitch('relay', false), { code: 'SHELLY_READBACK_TIMEOUT' });
  f.unlock(); await until(() => f.store.writeQueueStatus().pending === 0); await delay(20);
  assert.equal(f.commands.some(row => row.topic.endsWith('/relay/0/command')), false);
});

test('Gen1 saved restoration can wait and dispatch with unknown starting state but still needs new readback', async t => {
  const f = await fixture(t, 'mqtt', [{ id: 'relay', kind: 'switch', connection: 'shelly:shellies/fixture-relay',
    generation: 1, switch_control: true }]);
  assert.equal(f.reader.equipment.status().devices[0].available, false);
  f.lock(); f.send('0203', 21);
  let checked = false, result;
  const pending = f.reader.equipment.setSwitch('relay', false, { restoring: true, beforePublish: () => { checked = true; } })
    .then(value => { result = value; });
  await delay(20); assert.equal(checked, false); assert.equal(result, undefined);
  f.unlock(); await until(() => f.commands.some(row => row.topic.endsWith('/relay/0/command')));
  assert.equal(checked, true); assert.equal(result, undefined);
  f.client.emit('message', 'shellies/fixture-relay/relay/0', Buffer.from('off'), {});
  await pending; assert.equal(result.confirmed, true);
});

for (const switchControl of [false, true]) {
  test(`generic tariff Normal waits and confirms from unknown feedback with switch control ${switchControl}`, async t => {
    const f = await fixture(t, 'mqtt', [{ id: 'heat_savings', kind: 'switch', connection: 'mqtt:invented/tariff/state',
      tariff_control: true, switch_control: switchControl,
      mqtt: { command_topic: 'invented/tariff/set', on_payload: 'ON', off_payload: 'OFF' } }]);
    const transport = createHeatingTransport();
    transport.setHeatingRelay(f.reader.equipment.publishHeating, () => f.reader.equipment.signature('heat_savings'));
    t.after(() => transport.close());
    assert.equal(f.reader.equipment.status().devices[0].available, false);
    f.lock(); f.send('0203', 21);
    let result;
    const pending = transport.publish(['normal'], { validUntil: START + 60_000, clock: f.clock })
      .then(value => { result = value; });
    await delay(20);
    assert.equal(f.commands.some(row => row.topic === 'invented/tariff/set'), false);
    f.unlock(); await until(() => f.commands.some(row => row.topic === 'invented/tariff/set'));
    assert.equal(result, undefined, 'Tariff restoration still needs a new admitted relay report');
    assert.deepEqual(f.commands.filter(row => row.topic === 'invented/tariff/set').map(row => row.payload), ['OFF']);
    f.client.emit('message', 'invented/tariff/state', Buffer.from('OFF'), {});
    await pending; assert.equal(result.confirmed, true);

    f.lock(); f.send('0203', 22);
    const rejected = assert.rejects(transport.publish(['reduction'], { validUntil: START + 1000, clock: f.clock }));
    await delay(20); f.at(START + 1000); f.unlock(); await rejected;
    await until(() => f.store.writeQueueStatus().pending === 0);
    assert.equal(f.commands.filter(row => row.topic === 'invented/tariff/set').length, 1,
      'The same tariff path must still respect the executor deadline after waiting');
  });
}

function failNextCommit(store) {
  const transaction = store._transaction.bind(store); let armed = true;
  store._transaction = (action, admission) => admission && armed ? transaction(() => {
    armed = false; action(); throw new Error('synthetic observation commit failure');
  }, admission) : transaction(action, admission);
}

test('MQTT control recovers after a newer matching observation commits without reconnecting', async t => {
  const f = await fixture(t);
  f.send('0203', 20); f.at(START + 1000);
  failNextCommit(f.store); f.send('0203', 21); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, false);
  assert.equal(f.reader.h66.status().readings['0203'].value, 20);
  await assert.rejects(f.reader.h66.setSetting({ register: '0203', value: 22 }), /not confirmed/);
  assert.equal(f.commands.some(row => row.topic.includes('/SET/')), false);

  for (const [register, value, packet] of [
    ['0007', 7, {}], ['0203', 21, { retain: true }],
    ['0203', 21, { dup: true, messageId: 7 }], ['0203', 'invalid', {}],
  ]) {
    f.at(f.clock() + 1000); f.send(register, value, packet); await delay(0);
    assert.equal(f.reader.status().brokers.primary.ready, false, 'Unrelated, replayed or invalid evidence cannot resolve the failed setting');
  }
  f.at(f.clock() + 1000); f.send('0203', 21); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, true);
  const command = f.reader.h66.setSetting({ register: '0203', value: 22 });
  await until(() => f.commands.some(row => row.topic.endsWith('/SET/0203')));
  f.send('0203', 22); await command;
  assert.equal(f.reader.h66.status().lastManual.status, 'confirmed');
});

test('each failed MQTT input recovers independently and late rejection cannot undo a newer commit', async t => {
  const f = await fixture(t);
  f.send('0203', 20); f.send('0208', 50);
  f.at(START + 1000); failNextCommit(f.store); f.send('0203', 21);
  // Do not yield between failure and success: the failure Promise is pending.
  f.at(START + 2000); f.send('0203', 22); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, true);
  failNextCommit(f.store); f.send('0203', 23); await delay(0);
  failNextCommit(f.store); f.send('0208', 51); await delay(0);
  f.at(START + 3000); f.send('0203', 23); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, false);
  failNextCommit(f.store); f.send('0208', 51); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, false, 'Continued recording failures stay fenced');
  f.at(START + 4000); f.send('0208', 51); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, true);
});

test('a queued older receipt cannot clear a newer overflow; fresh matching delivery resolves it', async t => {
  const f = await fixture(t); f.send('0203', 20); f.lock();
  f.at(START + 1000); f.send('0203', 21);
  const fill = f.store.runWrite(() => {}, { bytes: f.store.writeQueueStatus().byteLimit - f.store.writeQueueStatus().bytes });
  f.at(START + 2000); f.send('0203', 22); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, false);
  f.unlock(); await fill; await until(() => f.store.writeQueueStatus().pending === 0);
  assert.equal(f.reader.h66.status().readings['0203'].value, 21);
  assert.equal(f.reader.status().brokers.primary.ready, false);
  f.at(START + 3000); f.send('0203', 22); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, true);
});

test('recovered storage never renews queued observation freshness or revoked control authority', async t => {
  const f = await fixture(t); f.send('0203', 20);
  f.at(START + 1000); failNextCommit(f.store); f.send('0203', 21); await delay(0);
  f.lock(); f.at(START + 2000); f.send('0203', 22);
  f.at(START + 60 * 60_000); f.unlock(); await until(() => f.store.writeQueueStatus().pending === 0);
  assert.equal(f.reader.status().brokers.primary.ready, true, 'Storage has recovered independently of native freshness');
  assert.equal(f.reader.h66.status().readings['0203'].receivedAt, START + 2000);
  await assert.rejects(f.reader.h66.setSetting({ register: '0203', value: 23 }), /live|fresh|unavailable/i);
  assert.equal(f.commands.some(row => row.topic.includes('/SET/')), false);
  f.send('0203', 22); f.lock(); f.at(f.clock() + 1000); f.send('0203', 23); f.authority(false);
  f.unlock(); await until(() => f.store.writeQueueStatus().pending === 0);
  assert.equal(f.reader.h66.status().readings['0203'].value, 22);
  await assert.rejects(f.reader.h66.setSetting({ register: '0203', value: 24 }), /not confirmed/);
  assert.equal(f.commands.some(row => row.topic.includes('/SET/')), false);
});

test('unrecognized MQTT routes cannot leave control fenced after a rejected save', async t => {
  const f = await fixture(t); f.send('0203', 20);
  failNextCommit(f.store); f.send('FFFF', 1); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, true);
});

test('MQTT equipment health pulses and runtime-only readings recover without inventing recorded measurements', async t => {
  const f = await fixture(t, 'mqtt', [{ id: 'switch', kind: 'switch', connection: 'mqtt:fixture/state', record: false,
    mqtt: { heartbeat_topic: 'fixture/pulse', heartbeat_seconds: 60, availability_topic: 'fixture/online' } }]);
  const send = (topic, value, packet = {}) => f.client.emit('message', topic, Buffer.from(value), packet);
  for (const [topic, value] of [['fixture/state', '1'], ['fixture/online', 'online'], ['fixture/pulse', 'pulse']]) {
    f.at(f.clock() + 1000); failNextCommit(f.store); send(topic, value); await delay(0);
    assert.equal(f.reader.status().brokers.primary.ready, false);
    send(topic, value, { retain: true }); await delay(0);
    assert.equal(f.reader.status().brokers.primary.ready, false);
    f.at(f.clock() + 1000); send(topic, value); await delay(0);
    assert.equal(f.reader.status().brokers.primary.ready, true);
  }
  assert.equal(f.store.observations().filter(row => row.device === 'switch').length, 0);
});

test('obsolete MQTT completion cannot alter a newer connection reception fence', async t => {
  const f = await fixture(t); f.send('0203', 20);
  failNextCommit(f.store); f.send('0203', 21);
  f.client.emit('offline'); f.client.emit('connect');
  f.at(START + 1000); f.send('0203', 22);
  await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, true, 'Prior connection rejection cannot block the new connection');
  failNextCommit(f.store); f.send('0203', 23); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, false);
  f.at(START + 2000); f.send('0203', 23); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, true);
});

test('native MQTT recovery permits status queries and correlates replies to the failed device', async t => {
  const f = await fixture(t, 'mqtt', ['first', 'second'].map(id => ({ id, kind: 'switch',
    connection: `shelly:fixture-${id}`, generation: 2, switch_control: true })));
  const request = (device, method) => f.commands.filter(row => row.topic === `fixture-${device}/rpc`)
    .map(row => JSON.parse(row.payload)).findLast(row => row.method === method);
  const reply = (device, method, result) => {
    const sent = request(device, method);
    assert.ok(sent, `${method} was permitted for ${device}`);
    f.client.emit('message', `${sent.src}/rpc`, Buffer.from(JSON.stringify({
      id: sent.id, src: `fixture-${device}`, dst: sent.src, result,
    })), {});
  };
  for (const device of ['first', 'second']) {
    reply(device, 'Shelly.GetDeviceInfo', { id: `fixture-${device}`, gen: 2 });
    reply(device, 'Shelly.GetStatus', { 'switch:0': { id: 0, output: false } });
  }
  f.at(START + 1000); failNextCommit(f.store);
  f.client.emit('message', 'fixture-first/events/rpc', Buffer.from(JSON.stringify({
    src: 'fixture-first', method: 'NotifyStatus', params: { ts: f.clock() / 1000, 'switch:0': { id: 0, output: true } },
  })), {}); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, false);
  await assert.rejects(f.reader.equipment.setSwitch('first', true), { code: 'MQTT_STORAGE_FAILED' });
  assert.equal(f.commands.some(row => row.topic.endsWith('/rpc') && JSON.parse(row.payload).method === 'Switch.Set'), false);
  f.at(START + 31_000); f.reader.equipment.tick(f.clock());
  reply('second', 'Shelly.GetStatus', { 'switch:0': { id: 0, output: false } }); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, false, 'Another native device cannot clear the failed device fence');
  reply('first', 'Shelly.GetStatus', { 'switch:0': { id: 0, output: true } }); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, true);

  // The failure may itself be a correlated reply on the shared response topic.
  f.at(START + 62_000); f.reader.equipment.tick(f.clock());
  failNextCommit(f.store); reply('first', 'Shelly.GetStatus', { 'switch:0': { id: 0, output: false } }); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, false);
  f.at(START + 93_000); f.reader.equipment.tick(f.clock());
  reply('first', 'Shelly.GetStatus', { 'switch:0': { id: 0, output: false } }); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, true);

  // A failure and ignored frame can share the last valid observation's clock.
  // Neither that cached time nor another device's shared RPC topic is evidence.
  failNextCommit(f.store);
  f.client.emit('message', 'fixture-first/events/rpc', Buffer.from(JSON.stringify({
    src: 'fixture-first', method: 'NotifyStatus', params: { 'switch:0': { id: 0, output: true } },
  })), {}); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, false);
  f.client.emit('message', 'fixture-first/events/rpc', Buffer.from(JSON.stringify({
    src: 'fixture-first', method: 'NotifyStatus', params: { 'switch:0': { id: 99, output: true } },
  })), {}); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, false, 'Ignored wrong-component frame cannot reuse cached same-clock state');
  f.reader.equipment.tick(f.clock() + 31_000);
  reply('second', 'Shelly.GetStatus', { 'switch:0': { id: 0, output: false } }); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, false);
  reply('first', 'Shelly.GetStatus', { 'switch:0': { id: 0, output: false } }); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, true);

  failNextCommit(f.store);
  f.client.emit('message', 'fixture-first/ignored', Buffer.from('1'), {}); await delay(0);
  assert.equal(f.reader.status().brokers.primary.ready, true, 'Unknown native wildcard topic never acquires a fence');
});

test('MQTT observations wait through contention in receipt order without renewing their clocks', async t => {
  const f = await fixture(t);
  f.lock();
  let heartbeats = 0;
  const timer = setInterval(() => { heartbeats++; }, 10);
  t.after(() => clearInterval(timer));
  for (const [offset, value] of [[0, 0], [1000, 1], [2000, 0]]) {
    f.at(START + offset); f.send('1A01', value);
  }
  f.at(START + 30_000);
  await delay(180);
  assert.ok(heartbeats >= 5, 'Database waiting leaves independent timers running');
  assert.equal(f.store.observations().length, 0, 'Uncommitted packets are not observations yet');
  assert.equal(f.store.writeHealth.status().failing, false);
  f.unlock();
  await until(() => f.store.writeQueueStatus().pending === 0);
  const rows = f.store.observations().filter(row => row.signal === 'compressor_active');
  assert.deepEqual(rows.map(row => [row.value, row.receivedAt, row.sourceTime]),
    [[0, START, START], [1, START + 1000, START + 1000], [0, START + 2000, START + 2000]]);
  assert.equal(f.reader.h66.status().readings['1A01'].receivedAt, START + 2000);
  assert.equal(f.store.writeHealth.status().failing, false);
});

test('queued H66 readback confirms a command only after its actual database commit', async t => {
  const f = await fixture(t);
  f.send('0203', 20);
  f.at(START + 1000);
  let confirmed = false;
  const operation = f.reader.h66.writeSettings({ '0203': 21 }, { expiresAt: START + 60_000 })
    .then(() => { confirmed = true; });
  await until(() => f.commands.some(command => command.topic.endsWith('/SET/0203')));
  f.lock(); f.send('0203', 21);
  await delay(150);
  assert.equal(confirmed, false);
  assert.equal(f.reader.h66.status().readings['0203'].value, 20);
  assert.equal(f.store.getState(`h66:control:${DEVICE}`).obligations['0203'].confirmed, false);
  f.unlock(); await operation;
  assert.equal(confirmed, true);
  assert.equal(f.store.getState(`h66:control:${DEVICE}`).obligations['0203'].confirmed, true);
});

test('a packet waiting across MQTT disconnect cannot gain authority in the new connection', async t => {
  const f = await fixture(t);
  f.send('0203', 20); f.lock(); f.at(START + 1000); f.send('0203', 21);
  f.client.emit('offline'); f.client.emit('connect');
  f.unlock(); await until(() => f.store.writeQueueStatus().pending === 0);
  assert.equal(f.reader.h66.status().readings['0203'].value, 20);
  assert.equal(f.reader.h66.status().readings['0203'].available, false);
  assert.equal(f.commands.some(command => command.topic.includes('/SET/')), false);
});

test('a completed provider observation survives a contended save with its original acquisition time', async t => {
  const f = await fixture(t, 'providers');
  let finish;
  const providers = startProviders({ engine: f.engine, store: f.store, config: f.config, clock: f.clock,
    automatic: false, http: { close() {} }, devices: { temperatures: () => new Promise(resolve => { finish = resolve; }) } });
  t.after(() => providers.close());
  const flight = providers.runDue();
  f.lock();
  finish([{ source: 'mqtt-temperature', device: 'fixture-room', signal: 'indoor_temperature', value: 21,
    unit: 'degC', sourceTime: START, receivedAt: START, quality: [] }]);
  await delay(100); f.at(START + 30_000);
  assert.equal(f.store.observations().length, 0);
  assert.equal(f.store.writeHealth.status().failing, false);
  f.unlock(); await flight;
  const observed = f.store.observations().find(row => row.signal === 'indoor_temperature');
  assert.equal(observed.receivedAt, START); assert.equal(observed.sourceTime, START);
  assert.equal(f.store.getState('providers:health').temperatures.status, 'ok');
  assert.equal(f.store.writeHealth.status().failing, false);
  await providers.close();
});

test('provider shutdown cancels a waiting observation without hanging on the writer lock', async t => {
  const f = await fixture(t, 'providers');
  let finish;
  const providers = startProviders({ engine: f.engine, store: f.store, config: f.config, clock: f.clock,
    automatic: false, http: { close() {} }, devices: { temperatures: () => new Promise(resolve => { finish = resolve; }) } });
  const flight = providers.runDue(); f.lock();
  finish([{ source: 'mqtt-temperature', device: 'fixture-room', signal: 'indoor_temperature', value: 21,
    unit: 'degC', sourceTime: START, receivedAt: START, quality: [] }]);
  await delay(30); await providers.close(); await flight;
  assert.equal(f.store.observations().length, 0);
  f.unlock();
});
