import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { Engine } from '../src/app/engine.js';
import { loadConfig } from '../src/app/config.js';
import { Store } from '../src/storage/store.js';
import { H66_REGISTERS } from '../src/domain/telemetry.js';
import { providerFixture } from '../scripts/lib/provider-fixture.js';

const initial = Date.parse('2026-09-07T12:00:00Z');
function broker({ rejectedTopic } = {}) {
  const client = new EventEmitter();
  client.subscriptions = []; client.publications = [];
  client.subscribe = (topic, options, done) => {
    client.subscriptions.push(topic);
    done(topic === rejectedTopic ? new Error('Private broker error must stay private') : null);
  };
  client.publish = (topic, payload, options, done) => { client.publications.push({ topic, payload }); done(); };
  client.end = (force, options, done) => { client.emit('close'); done(); };
  return client;
}

test('standalone entry receives indoor and garage MQTT temperatures without an H66 device', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-mqtt-temperatures-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = providerFixture(initial), client = broker();
  let now = initial;
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, directory), input: 'mqtt', deviceId: null,
    connections: { ...fixture.connections, mqtt: { address: 'mqtt://example.invalid', temperatureTopics: {
      indoor_temperature: 'invented/indoor', garage_temperature: 'invented/garage',
    } } } };
  const app = await start({ config, clock: () => now, mqttOptions: {
    connect: (_address, options) => options?.clientId?.startsWith('stmq-identity-') ? broker() : client,
  }, providerOptions: fixture.providerOptions });
  try {
    client.emit('connect');
    assert.deepEqual(client.subscriptions, ['invented/indoor', 'invented/garage']);
    assert.equal(client.publications.length, 0, 'Standalone temperature acquisition sends no H66 commands');
    client.emit('message', 'invented/indoor', Buffer.from('20.25'));
    client.emit('message', 'invented/garage', Buffer.from('10.5'));
    assert.equal(app.engine.recorder.latestCommitted('indoor_temperature').value, 20.25);
    assert.equal(app.engine.recorder.latestCommitted('garage_temperature').value, 10.5);
    now += 15_000;
    client.emit('offline'); client.emit('close');
    for (const signal of ['indoor_temperature', 'garage_temperature']) {
      const committed = app.engine.recorder.latestCommitted(signal);
      assert.equal(committed.value, null);
      assert.equal(committed.sourceTime, initial, 'Disconnection cannot make the previous measurement newer');
      assert(committed.quality.includes('failed'));
      assert.equal(app.engine.latest[signal].value, null, 'Known outages also invalidate the same live sensor immediately');
    }
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM observations WHERE source='mqtt-temperature' AND value IS NULL").get().n, 2);
    now += 15_000;
    client.emit('connect');
    assert.equal(app.engine.recorder.latestCommitted('indoor_temperature').value, null, 'Broker reconnection alone is not a new measurement');
    client.emit('message', 'invented/indoor', Buffer.from('20.25'));
    assert.equal(app.engine.recorder.latestCommitted('indoor_temperature').value, 20.25);
    assert.equal(app.engine.latest.indoor_temperature.value, 20.25);
    assert.equal(app.engine.recorder.latestCommitted('garage_temperature').value, null, 'Each sensor must recover independently');
  } finally { await app.close(); }
});

test('H66 broker loss records all thirty included signals once and preserves canonical units and recovery', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-mqtt-availability-'));
  const store = new Store(join(directory, 'test.sqlite'));
  let now = initial;
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory }, directory), input: 'mqtt', deviceId: 'invented-h66',
    connections: { mqtt: { address: 'mqtt://example.invalid', temperatureTopics: { garage_temperature: 'invented/garage' } } } };
  const engine = new Engine({ store, config, clock: () => now }), client = broker();
  const reader = await startMqtt({ engine, store, config, connect: () => client });
  t.after(async () => { await reader.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  client.emit('connect');
  client.emit('message', 'invented-h66/HP/8105', Buffer.from('-100'));
  client.emit('message', 'invented-h66/HP/0008', Buffer.from('21.2'));
  now += 15_000;
  client.emit('offline'); client.emit('close'); client.emit('offline');
  const missing = store.db.prepare("SELECT * FROM observations WHERE source='husdata-h66' AND value IS NULL").all();
  assert.equal(missing.length, 30);
  assert.deepEqual(missing.map(row => row.signal).sort(), Object.values(H66_REGISTERS)
    .map(row => row.signal === 'integral' ? 'heating_integral' : row.signal).sort());
  for (const row of missing) {
    assert.equal(row.device, 'invented-h66'); assert.equal(row.source_time, null);
    assert(JSON.parse(row.quality).includes('mqtt-disconnected'));
  }
  assert.equal(missing.find(row => row.signal === 'heating_integral').unit, 'degree-minutes');
  assert.equal(engine.recorder.latestCommitted('heating_integral').value, null);
  assert.equal(engine.recorder.latestCommitted('heating_integral').sourceTime, initial);
  client.emit('message', 'invented-h66/HP/8105', Buffer.from('-90'));
  assert.equal(engine.recorder.latestCommitted('heating_integral').value, null, 'Buffered packets received while disconnected cannot revive coverage');
  now += 15_000; client.emit('connect');
  assert.equal(engine.recorder.latestCommitted('heating_integral').value, null);
  client.emit('message', 'invented-h66/HP/8105', Buffer.from('-100'));
  assert.equal(engine.recorder.latestCommitted('heating_integral').value, -100);
  assert.equal(engine.recorder.latestCommitted('indoor_temperature').value, null);
});

test('temperature subscription rejection records failure without exposing broker errors', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-mqtt-subscribe-'));
  const store = new Store(join(directory, 'test.sqlite'));
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory }, directory), input: 'mqtt', deviceId: null,
    connections: { mqtt: { address: 'mqtt://example.invalid', temperatureTopics: { garage_temperature: 'invented/garage' } } } };
  const engine = new Engine({ store, config, clock: () => initial }), client = broker({ rejectedTopic: 'invented/garage' });
  const reader = await startMqtt({ engine, store, config, connect: () => client });
  t.after(async () => { await reader.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  client.emit('connect');
  const failure = store.latestObservation('garage_temperature');
  assert.equal(failure.value, null); assert(failure.quality.includes('mqtt-subscription-failed'));
  assert.equal(JSON.stringify(store.events()).includes('Private broker'), false);
  assert.equal(reader.h66, null); assert.equal(reader.status().connected, true);
});

test('Downstairs and Bedroom MQTT temperatures are recorded independently across one sensor outage', async t => {
  const store = new Store(':memory:');
  const config = { ...loadConfig({ HOME: '/missing-stmq-test-home' }, '/missing-repository'), input: 'mqtt', deviceId: null,
    connections: { mqtt: { address: 'mqtt://example.invalid', temperatureTopics: {
      downstairs_temperature: 'invented/downstairs', bedroom_temperature: 'invented/bedroom',
    } } } };
  const engine = new Engine({ store, config, clock: () => initial }), client = broker();
  const reader = await startMqtt({ engine, store, config, connect: () => client });
  t.after(async () => { await reader.close(); store.close(); });
  client.emit('connect');
  assert.deepEqual(client.subscriptions, ['invented/downstairs', 'invented/bedroom']);
  client.emit('message', 'invented/downstairs', Buffer.from('20.5'));
  client.emit('message', 'invented/bedroom', Buffer.from('{"value":66.2,"unit":"F"}'));
  assert.equal(engine.recorder.latestCommitted('downstairs_temperature').value, 20.5);
  assert(Math.abs(engine.recorder.latestCommitted('bedroom_temperature').value - 19) < 1e-10);
  client.emit('message', 'invented/downstairs', Buffer.from('{"value":null}'));
  assert.equal(engine.recorder.latestCommitted('downstairs_temperature').value, null);
  assert(Math.abs(engine.latest.bedroom_temperature.value - 19) < 1e-10);
  assert.equal(engine.latest.indoor_temperature, undefined);
});

test('configured Upstairs MQTT sensor owns room history and model input alongside H66 indoor publications', async t => {
  const store = new Store(':memory:');
  const config = { ...loadConfig({ HOME: '/missing-stmq-test-home' }, '/missing-repository'), input: 'mqtt', deviceId: 'invented-h66',
    connections: { mqtt: { address: 'mqtt://example.invalid', temperatureTopics: {
      indoor_temperature: 'invented/smoke/1/temperature',
    } } } };
  let now = initial;
  const engine = new Engine({ store, config, clock: () => now }), client = broker();
  const reader = await startMqtt({ engine, store, config, connect: () => client });
  t.after(async () => { await reader.close(); store.close(); });
  client.emit('connect');
  client.emit('message', 'invented-h66/HP/0008', Buffer.from('25'));
  assert.equal(engine.latest.indoor_temperature, undefined, 'The configured room remains missing until its own sensor publishes');
  client.emit('message', 'invented/smoke/1/temperature', Buffer.from('21'));
  now += 60_000;
  client.emit('message', 'invented-h66/HP/0008', Buffer.from('26'));
  assert.equal(engine.status().observations.upstairs.value, 21);
  assert.equal(engine.status().observations.indoor.value, 21);
  assert.equal(engine.recorder.latestCommitted('indoor_temperature').source, 'mqtt-temperature');
  assert(store.observations({ signal: 'indoor_temperature' }).every(row => row.source === 'mqtt-temperature'));
  now += 31 * 60_000;
  client.emit('message', 'invented-h66/HP/0008', Buffer.from('26'));
  assert.equal(engine.status().observations.indoor.stale, true, 'Gateway updates cannot refresh a stale configured room sensor');
  client.emit('offline');
  assert(store.observations({ signal: 'indoor_temperature' }).every(row => row.source === 'mqtt-temperature'),
    'Gateway availability transitions cannot contaminate the configured room history either');
});
