import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createHeatingTransport } from '../src/control/mqtt.js';
import { Executor } from '../src/app/executor.js';
import { Store } from '../src/storage/store.js';

test('authority lost while connecting prevents the first device publish', async () => {
  const client = new EventEmitter(), messages = [];
  client.publish = (...args) => messages.push(args);
  client.end = (_force, _options, callback) => callback();
  let allowed = true;
  const transport = createHeatingTransport({ connection: { address: 'mqtt://invented.invalid' },
    connect: () => client, canControl: () => allowed });
  const completion = transport.publish(['heatoff']);
  allowed = false; client.emit('connect');
  await assert.rejects(completion, error => error.code === 'MQTT_AUTHORITY_LOST');
  assert.equal(messages.length, 0); await transport.close();
});

test('authority lost between acknowledgements cancels the remaining batch', async () => {
  const client = new EventEmitter(), messages = [];
  client.publish = (topic, payload, options, callback) => messages.push({ topic, payload, callback });
  client.end = (_force, _options, callback) => callback();
  let allowed = true;
  const transport = createHeatingTransport({ connection: { address: 'mqtt://invented.invalid' },
    connect: () => client, canControl: () => allowed });
  const completion = transport.publish(['heaton60', 'heaton15']);
  client.emit('connect');
  assert.equal(messages.length, 1);
  allowed = false; messages[0].callback();
  await assert.rejects(completion, error => error.code === 'MQTT_AUTHORITY_LOST');
  assert.equal(messages.length, 1); await transport.close();
});

test('authority-loss executor close preserves obligations without publishing restoration', async () => {
  const store = new Store(':memory:');
  const messages = [];
  const transport = { publish: async values => { messages.push(...values); return { sent: true }; }, close: async () => {} };
  const executor = new Executor({ store, input: 'mqtt', commandTransport: transport });
  executor.state.legacyOutstanding = true; executor.state.phase = 'reduction';
  executor.state.expiresAt = Date.now() + 10; executor.persist(); executor.armExpiry();
  await executor.close({ restore: false }); await delay(30);
  assert.equal(messages.length, 0); assert.equal(executor.closed, true);
  assert.equal(store.getState('executor:mqtt').legacyOutstanding, true);
  store.close();
});
