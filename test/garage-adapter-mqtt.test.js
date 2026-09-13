import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { startMqtt } from '../src/acquisition/mqtt.js';

test('MQTT exposes provisional garage telemetry and both external sensors with no garage publication path', async () => {
  const base = 1_800_000_000_000, client = new EventEmitter(), subscribed = [], published = [], observations = [];
  const states = new Map(); let adapter, now = base;
  client.subscribe = (topic, options, done) => { subscribed.push(topic); done(null, [{ topic, qos: options.qos }]); };
  client.publish = (topic, payload, options, done) => { published.push({ topic, payload, options }); done(); };
  client.end = (_force, _options, done) => done();
  const store = { event() {}, getState: key => states.get(key), setState: (key, value) => states.set(key, value) };
  const engine = { clock: () => now, configureTemperatureReports() {}, ingest: row => observations.push(row),
    garage: { setAdapter(value) { adapter = value; }, adapterChanged(snapshot) { store.setState('garage:adapter:mqtt', snapshot); } } };
  const capture = await startMqtt({ engine, store, config: { input: 'mqtt',
    connections: { mqtt: { address: 'mqtt://example.invalid', temperatureTopics: {
      garage_temperature: 'fixture/garage/rear', garage_temperature_2: 'fixture/garage/front' } } },
    garage: { adapter: { stateTopic: 'fixture/garage/state', telemetryTopic: 'fixture/garage/telemetry' } } },
    connect: (_address, options) => { assert.equal(options.queueQoSZero, false); return client; } });
  try {
    client.emit('connect');
    assert.deepEqual(subscribed, ['fixture/garage/rear', 'fixture/garage/front', 'fixture/garage/state', 'fixture/garage/telemetry']);
    client.emit('message', 'fixture/garage/rear', Buffer.from('8.5'));
    client.emit('message', 'fixture/garage/front', Buffer.from('7.5'));
    assert.deepEqual(observations.map(row => [row.signal, row.value]), [['garage_temperature', 8.5], ['garage_temperature_2', 7.5]]);
    const state = JSON.parse(readFileSync(new URL('./fixtures/garage-provisional-state.json', import.meta.url)));
    client.emit('message', 'fixture/garage/state', Buffer.from(JSON.stringify(state)));
    assert.equal(adapter.status().contractStatus, 'provisional-fixture-only');
    assert.equal(adapter.status().liveControlSupported, false);
    await adapter.plannerTick({ now, valid: true, recoveryReady: true,
      plan: { id: 'fixture-pause', pauseFrom: now, pauseUntil: now + 60_000 } });
    assert.equal(published.length, 0);
    now += 1000; client.emit('offline');
    assert.equal(adapter.status().connected, false);
    assert.equal(states.get('garage:adapter:mqtt').contractVersion, 'stmq-garage-fixture/v1');
  } finally { await capture.close({ restore: false }); }
  assert.equal(adapter, null);
  assert.equal(published.length, 0);
});
