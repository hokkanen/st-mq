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

const START = Date.parse('2026-10-07T09:00:00Z'), DEVICE = 'contention-fixture';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = performance.now() + 3000;
  while (!predicate()) { assert.ok(performance.now() < end, 'Condition did not settle'); await delay(5); }
}
async function fixture(t, input = 'mqtt') {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-acquisition-contention-'));
  const store = new Store(join(directory, 'recording.sqlite')), writer = new DatabaseSync(store.path);
  let now = START, locked = false;
  const config = { input, deviceId: DEVICE, h66: { writeEnabled: true, readbackTimeoutMs: 1000 },
    garage: { enabled: false }, connections: { mqtt: { address: 'mqtt://fixture.invalid' }, equipment: equipmentConfiguration({ devices: [] }) } };
  const engine = new Engine({ store, config, clock: () => now });
  const client = new EventEmitter(), commands = [];
  client.subscribe = (_topic, _options, done) => done();
  client.publish = (topic, payload, _options, done) => { commands.push({ topic, payload }); done(); };
  client.end = (_force, _options, done) => done();
  const reader = input === 'mqtt' ? await startMqtt({ engine, store, config, connect: () => client }) : null;
  client.emit('connect');
  t.after(async () => {
    if (locked) writer.exec('ROLLBACK');
    await reader?.close({ restore: false }); await engine.garage.close({ restore: false });
    await engine.charging.close(); await engine.closeFireplace(); await engine.executor.close({ restore: false });
    writer.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, engine, config, client, reader, commands, clock: () => now, at: at => { now = at; },
    lock() { writer.exec('BEGIN IMMEDIATE'); locked = true; },
    unlock() { writer.exec('ROLLBACK'); locked = false; },
    send(register, value, packet = {}) { client.emit('message', `${DEVICE}/HP/${register}`, Buffer.from(String(value)), packet); } };
}

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
