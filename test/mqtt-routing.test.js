import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/storage/store.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { mqttRouting } from '../src/acquisition/mqtt-routing.js';
import { ChargingRuntime } from '../src/charging/runtime.js';

const initial = Date.parse('2026-10-05T10:00:00Z');
const door = { id: 'garage_door1', area: 'garage', kind: 'door', connection: 'mqtt:fixture/door/state', cover_control: true,
  mqtt: { command_topic: 'fixture/door/set', open_payload: 'open', close_payload: 'closed', state_path: 'value',
    timestamp_path: 'timestamp', availability_topic: 'fixture/door/online', bridge_availability_topic: 'homeassistant/status' } };
const sensor = { id: 'air', area: 'garage', kind: 'temperature', connection: 'mqtt:fixture/air/state', signal: 'caravan_temperature',
  mqtt: { state_path: 'temperature', timestamp_path: 'timestamp', bridge_availability_topic: 'homeassistant/status' } };
const dryer = { id: 'caravan_dehumidifier', area: 'garage', kind: 'dehumidifier', connection: 'mqtt:fixture/dryer/state',
  dehumidifier_control: true, mqtt: { timestamp_path: 'timestamp', command_topic: 'fixture/dryer/set',
    availability_topic: 'fixture/dryer/online', bridge_availability_topic: 'homeassistant/status' } };
const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { separate = true, deferred = false, temperatureControl = false } = {}) {
  const store = new Store(':memory:'), clients = new Map(), observations = [], vehicleMessages = [], vehicleStatus = new Map();
  let now = initial, authority = true;
  const engine = { clock: () => now, ingest: row => observations.push(row),
    charging: { mqttRoutes: () => [{ id: 'bmw', provider: 'bmw-cardata', topic: 'fixture/bmw', label: 'BMW' }],
      setMqttStatus: (status, id = 'bmw') => vehicleStatus.set(id, status),
      receiveSoc: (...args) => { vehicleMessages.push(args); return true; } } };
  const config = { input: 'mqtt', h66: { readbackTimeoutMs: 100 }, connections: {
    mqtt: { address: 'mqtt://primary.invalid', user: 'primary-user', pw: 'synthetic-primary-password',
      ...(separate ? { ha: { address: 'mqtt://ha.invalid', user: 'ha-user', pw: 'synthetic-ha-password' } } : {}) },
    teslamate: { enabled: true }, equipment: equipmentConfiguration({ devices: [door, sensor,
      { ...dryer, ...(temperatureControl ? { temperature_control: { sensor_device_id: 'air' } } : {}) }] }) } };
  const reader = await startMqtt({ store, engine, config, canControl: () => authority, connect: (address, options) => {
    const client = new EventEmitter();
    Object.assign(client, { options, subscriptions: [], publications: [], pending: [], ended: false });
    client.subscribe = (topic, _options, done) => { client.subscriptions.push(topic);
      if (deferred) client.pending.push({ topic, done }); else done(null, [{ topic, qos: 1 }]); };
    client.publish = (topic, payload, options, done) => { client.publications.push({ topic, payload, options, done });
      if (!client.holdPublish) done?.(); };
    client.end = (_force, _options, done) => { client.ended = true; done(); };
    clients.set(address.includes('primary') ? 'primary' : 'ha', client); return client;
  } });
  t.after(async () => { await reader.close({ restore: false }); store.close(); });
  const send = (broker, topic, payload, packet = {}) => clients.get(broker).emit('message', topic,
    Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)), packet);
  const doorReport = (broker = separate ? 'ha' : 'primary', packet = {}) => {
    send(broker, 'fixture/door/online', 'online', packet);
    send(broker, 'fixture/door/state', { value: 'closed', timestamp: initial }, packet);
  };
  return { reader, store, engine, clients, observations, vehicleMessages, vehicleStatus, send, doorReport,
    view: id => reader.equipment.status().devices.find(row => row.id === id),
    advance: ms => { now += ms; }, authority: value => { authority = value; },
    ack: (broker, rejectedTopic = null) => { for (const { topic, done } of clients.get(broker).pending.splice(0))
      done(null, [{ topic, qos: topic === rejectedTopic ? 128 : 1 }]); } };
}

test('one optional HA broker selects exactly the supported integration groups', () => {
  const routing = mqttRouting({ connections: { mqtt: { address: 'mqtt://primary.invalid', ha: { address: 'mqtt://ha.invalid' } } } });
  for (const row of equipmentConfiguration({ devices: [door, sensor, dryer] }).devices)
    assert.equal(routing.equipmentBroker(row), row.id === 'air' ? 'primary' : 'ha');
  assert.equal(routing.vehicleBroker({ provider: 'bmw-cardata' }), 'ha');
  assert.equal(routing.vehicleBroker({ provider: 'other' }), 'primary');
  assert.equal(routing.equipmentBroker({ protocol: 'shelly', area: 'garage', kind: 'switch' }), 'primary');
  assert.equal(mqttRouting({ connections: { mqtt: { address: 'mqtt://primary.invalid' } } }).teslaBroker, 'primary');
});

test('primary readiness and independent observations do not wait for an unavailable HA broker', async t => {
  const f = await fixture(t); f.clients.get('primary').emit('connect'); await f.reader.ready();
  assert.deepEqual(f.reader.status().brokers, { primary: { connected: true, ready: true }, ha: { connected: false, ready: false } });
  assert.deepEqual(f.clients.get('primary').subscriptions.sort(), ['fixture/air/state', 'homeassistant/status']);
  f.send('primary', 'fixture/air/state', { temperature: 7, timestamp: initial });
  f.doorReport('primary'); f.send('primary', 'teslamate/cars/1/battery_level', '85'); f.send('primary', 'fixture/bmw', { soc: 90 });
  assert.equal(f.view('air').available, true); assert.equal(f.view('garage_door1').available, false);
  assert.equal(f.engine.teslamate.snapshot().batteryLevel, undefined); assert.equal(f.vehicleMessages.length, 0);
  assert.deepEqual(f.clients.get('ha').options.username, 'ha-user');
});

test('HA commands, reports and shared availability stay isolated from primary in both outage directions', async t => {
  const f = await fixture(t); for (const client of f.clients.values()) client.emit('connect');
  f.send('primary', 'fixture/air/state', { temperature: 7, timestamp: initial }); f.doorReport();
  f.send('ha', 'teslamate/cars/1/healthy', 'true'); f.send('ha', 'fixture/bmw', { soc: 80 });
  assert.equal(f.vehicleMessages.length, 1); assert.equal(f.view('garage_door1').available, true);
  await f.reader.equipment.setCover({ deviceId: 'garage_door1', action: 'open' });
  assert.deepEqual(f.clients.get('primary').publications, []);
  assert.equal(f.clients.get('ha').publications.at(-1).topic, 'fixture/door/set');
  f.send('ha', 'homeassistant/status', 'offline');
  assert.equal(f.view('garage_door1').available, false); assert.equal(f.view('air').available, true);
  f.send('ha', 'homeassistant/status', 'online'); f.doorReport();
  f.clients.get('primary').emit('offline');
  assert.equal(f.view('air').available, false); assert.equal(f.view('garage_door1').available, true);
  assert.equal(f.vehicleStatus.get('bmw').connected, true);
  await f.reader.equipment.setCover({ deviceId: 'garage_door1', action: 'close' });
  f.clients.get('ha').emit('offline');
  assert.equal(f.view('garage_door1').available, false); assert.equal(f.vehicleStatus.get('bmw').connected, false);
  await assert.rejects(f.reader.equipment.setCover({ deviceId: 'garage_door1', action: 'open' }), /unavailable/);
});

test('each broker fences stale SUBACKs, preserves receipt clocks and rejects retained recovery', async t => {
  const f = await fixture(t, { deferred: true });
  f.clients.get('primary').emit('connect'); f.clients.get('ha').emit('connect');
  f.send('primary', 'fixture/air/state', { temperature: 7, timestamp: initial }); f.doorReport();
  f.advance(1000); f.ack('primary'); await f.reader.ready();
  assert.equal(f.view('air').readings.caravan_temperature.receivedAt, initial);
  assert.equal(f.view('garage_door1').available, false);
  const stale = f.clients.get('ha').pending.splice(0); f.clients.get('ha').emit('offline'); f.clients.get('ha').emit('connect');
  for (const { topic, done } of stale) done(null, [{ topic, qos: 1 }]);
  assert.equal(f.reader.status().brokers.ha.ready, false);
  f.doorReport('ha', { retain: true }); f.ack('ha');
  assert.equal(f.view('garage_door1').available, false);
  f.doorReport(); assert.equal(f.view('garage_door1').available, true);
  assert.equal(f.view('garage_door1').readings.garage_door1_open.observedAt, initial);
});

test('missing secondary uses exactly one connection and shutdown revokes either transport', async t => {
  const f = await fixture(t, { separate: false }); assert.equal(f.clients.size, 1);
  const primary = f.clients.get('primary'); primary.emit('connect'); await f.reader.ready(); f.doorReport();
  assert.equal(f.view('garage_door1').mqttStatus.broker, 'primary');
  assert.equal(primary.subscriptions.filter(topic => topic === 'homeassistant/status').length, 1);
  assert(primary.subscriptions.includes('fixture/bmw')); assert(primary.subscriptions.includes('teslamate/cars/1/#'));
  f.reader.revoke(); await assert.rejects(f.reader.equipment.setCover({ deviceId: 'garage_door1', action: 'open' }), /unconfirmed/);
  assert.equal(primary.publications.length, 0);
  await f.reader.close({ restore: false }); primary.emit('connect');
  assert.equal(primary.ended, true); assert.equal(f.reader.status().brokers.primary.connected, false);
});

test('HA disconnect cancels pending door publication without replay and primary survives', async t => {
  const f = await fixture(t); for (const client of f.clients.values()) client.emit('connect'); f.doorReport();
  const ha = f.clients.get('ha'); ha.holdPublish = true;
  const command = f.reader.equipment.setCover({ deviceId: 'garage_door1', action: 'open' });
  const rejected = assert.rejects(command, /unconfirmed/); ha.emit('offline'); await rejected;
  ha.emit('connect'); ha.publications[0].done(); await settle();
  assert.equal(ha.publications.length, 1); assert.equal(f.reader.status().brokers.primary.ready, true);
  assert.equal(f.view('garage_door1').cover.operation.status, 'unconfirmed');
});

test('Tuya temperature dependency remains on primary while its native commands use HA', async t => {
  const f = await fixture(t, { temperatureControl: true }); for (const client of f.clients.values()) client.emit('connect');
  f.send('primary', 'fixture/air/state', { temperature: 8, timestamp: initial });
  f.send('ha', 'fixture/dryer/online', 'online');
  f.send('ha', 'fixture/dryer/state', { identity: 'a'.repeat(64), power: 'off', fanSpeed: 'low', timestamp: initial,
    fieldTimestamps: { power: initial, fanSpeed: initial },
    capabilities: { power: ['off', 'on'], fanSpeed: ['low', 'high'] } });
  assert.equal(f.view('caravan_dehumidifier').dehumidifier.temperatureControl.temperatureC, 8);
  await f.reader.equipment.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'fanSpeed', value: 'high' });
  assert.equal(f.clients.get('ha').publications.at(-1).topic, 'fixture/dryer/set');
  assert.equal(f.clients.get('primary').publications.length, 0);
  f.clients.get('primary').emit('offline');
  assert.equal(f.view('caravan_dehumidifier').available, true);
  assert.equal(f.view('caravan_dehumidifier').dehumidifier.temperatureControl.temperatureC, null);
});

test('a denied primary route fails readiness while a denied HA route remains isolated', async t => {
  const f = await fixture(t, { deferred: true }); for (const client of f.clients.values()) client.emit('connect');
  f.ack('ha', 'fixture/door/state'); assert.equal(f.reader.status().brokers.ha.ready, false);
  f.ack('primary'); await f.reader.ready();
  f.clients.get('primary').emit('offline'); f.clients.get('primary').emit('connect');
  f.ack('primary', 'fixture/air/state'); await assert.rejects(f.reader.ready(), /subscriptions unavailable/);
});

test('BMW evidence association follows selected HA connection independently of the primary endpoint', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const runtimes = [];
  const association = (address, haAddress) => {
    const config = { input: 'mqtt', connections: { mqtt: { address, user: 'primary', ha: { address: haAddress, user: 'ha' } } } };
    const engine = { clock: () => initial };
    const runtime = new ChargingRuntime({ engine, store, config, clock: engine.clock }); runtimes.push(runtime);
    return runtime.vehicleFeeds.bmw.association;
  };
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); });
  assert.equal(association('mqtt://a.invalid', 'mqtt://ha.invalid'), association('mqtt://b.invalid', 'mqtt://ha.invalid'));
  assert.notEqual(association('mqtt://a.invalid', 'mqtt://ha.invalid'), association('mqtt://a.invalid', 'mqtt://other.invalid'));
});
