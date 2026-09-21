import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { ChargingRuntime } from '../src/charging/runtime.js';

const initial = Date.parse('2026-09-20T12:00:00Z');

async function fixture(t) {
  let now = initial;
  const saved = new Map(), acknowledgements = [], client = new EventEmitter();
  const store = { getState: key => structuredClone(saved.get(key)),
    setState: (key, value) => saved.set(key, structuredClone(value)), event() {} };
  const config = { input: 'mqtt', connections: { mqtt: { address: 'mqtt://invented.invalid' } } };
  const engine = { clock: () => now };
  engine.charging = new ChargingRuntime({ engine, store, config, clock: engine.clock });
  client.subscribe = (topic, _options, done) => acknowledgements.push({ topic, done });
  client.end = (_force, _options, done) => done();
  const reader = await startMqtt({ engine, store, config, connect: () => client });
  t.after(async () => { await reader.close(); await engine.charging.close(); });
  const topic = engine.charging.mqttRoutes()[0].topic;
  const view = () => ({ mqtt: engine.charging.status().vehicleFeeds.find(item => item.id === 'bmw').reception,
    automaticSoc: engine.charging.vehicleFeeds.bmw.reading });
  const payload = { provider: 'bmw-cardata', soc: 51, chargeLimitSoc: 80, usableCapacityKwh: 72,
    measuredAt: initial - 3600_000, readingId: 'invented-reading' };
  const send = (value = payload, packet = {}) => client.emit('message', topic, Buffer.from(JSON.stringify(value)), packet);
  const acknowledge = (qos = 1, index = acknowledgements.length - 1) => acknowledgements[index].done(null, [{ topic, qos }]);
  return { client, reader, view, send, acknowledge, setNow: value => { now = value; } };
}

test('vehicle MQTT reports acknowledged subscriptions and retained/live reception independently of old battery measurements', async t => {
  const f = await fixture(t);
  assert.equal(f.view().mqtt.brokerConnected, false);
  f.client.emit('connect');
  assert.equal(f.view().mqtt.brokerConnected, true); assert.equal(f.view().mqtt.subscriptionStatus, 'pending');
  f.send(undefined, { retain: true });
  assert.equal(f.view().automaticSoc, null, 'Pending subscriptions cannot supply readings before broker acknowledgement');
  f.setNow(initial + 1000); f.acknowledge();
  let view = f.view();
  assert.equal(view.mqtt.provider, 'bmw-cardata'); assert.equal(view.mqtt.subscriptionStatus, 'subscribed');
  assert.equal(view.mqtt.lastRetainedAt, initial); assert.equal(view.mqtt.lastLiveAt, null);
  assert.equal(view.automaticSoc.measuredAt, initial - 3600_000); assert.equal(view.automaticSoc.receivedAt, initial);
  f.send();
  view = f.view();
  assert.equal(view.mqtt.lastLiveAt, initial + 1000); assert.equal(view.mqtt.lastValidAt, initial + 1000);
  assert.equal(view.automaticSoc.receivedAt, initial, 'Unchanged live publications do not pretend the BMW measurement is new');
  f.client.emit('offline');
  assert.equal(f.view().mqtt.subscriptionStatus, 'disconnected');
  f.setNow(initial + 2000); f.send();
  assert.equal(f.view().mqtt.lastLiveAt, initial + 1000, 'Disconnected packets cannot revive live evidence');
  f.client.emit('connect');
  f.send(undefined, { retain: true }); f.acknowledge(128);
  view = f.view();
  assert.equal(view.mqtt.brokerConnected, true); assert.equal(view.mqtt.subscribed, false);
  assert.equal(view.mqtt.subscriptionStatus, 'failed'); assert.equal(view.mqtt.reason, 'mqtt-subscription-failed');
  assert.equal(view.mqtt.lastRetainedAt, initial, 'A denied route cannot replay its pending packets');
  f.send(); assert.equal(f.view().mqtt.lastLiveAt, initial + 1000);
});

test('obsolete vehicle subscription callbacks and shutdown cannot restore live state', async t => {
  const f = await fixture(t);
  f.client.emit('connect'); f.send(undefined, { retain: true });
  f.client.emit('offline'); f.client.emit('connect');
  f.acknowledge(1, 0);
  assert.equal(f.view().mqtt.subscriptionStatus, 'pending'); assert.equal(f.view().automaticSoc, null);
  f.acknowledge(); f.send();
  assert.equal(f.view().mqtt.subscriptionStatus, 'subscribed');
  f.acknowledge(128);
  assert.equal(f.view().mqtt.subscriptionStatus, 'subscribed', 'A completed acknowledgement cannot change route status a second time');
  await f.reader.close();
  assert.equal(f.view().mqtt.brokerConnected, false); assert.equal(f.view().mqtt.subscribed, false);
  assert.equal(f.view().mqtt.subscriptionStatus, 'disconnected');
  f.client.emit('connect');
  assert.equal(f.view().mqtt.brokerConnected, false);
});
