import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createHeatingTransport } from '../src/control/mqtt.js';
import { Executor } from '../src/app/executor.js';
import { Store } from '../src/storage/store.js';

test('authority lost before direct circulation dispatch prevents the native command', async () => {
  let allowed = true;
  const messages = [], transport = createHeatingTransport({ canControl: () => allowed });
  transport.setDhwrRelay(async on => { messages.push(on); return { sent: true }; }, 'fixture-route');
  const completion = transport.publishDhwr(true);
  allowed = false;
  await assert.rejects(completion, { code: 'MQTT_AUTHORITY_LOST' });
  assert.deepEqual(messages, []); await transport.close();
});

test('authority lost after native readback prevents the next circulation command', async () => {
  let allowed = true;
  const messages = [], transport = createHeatingTransport({ canControl: () => allowed });
  transport.setDhwrRelay(async on => { messages.push(on); return { sent: true }; }, 'fixture-route');
  await transport.publishDhwr(true); allowed = false;
  await assert.rejects(transport.publishDhwr(false), { code: 'MQTT_AUTHORITY_LOST' });
  assert.deepEqual(messages, [true]); await transport.close();
});

test('authority-loss executor close preserves obligations without publishing restoration', async () => {
  const store = new Store(':memory:');
  const messages = [];
  const transport = { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) }, publish: async values => { messages.push(...values); return { sent: true }; }, close: async () => {} };
  const executor = new Executor({ store, input: 'mqtt', commandTransport: transport });
  executor.target('tariff', { acquire: true });
  executor.state.legacyOutstanding = true; executor.state.phase = 'reduction';
  executor.state.expiresAt = Date.now() + 10; executor.persist(); executor.armExpiry();
  await executor.close({ restore: false }); await delay(30);
  assert.equal(messages.length, 0); assert.equal(executor.closed, true);
  assert.equal(store.getState('executor:home').legacyOutstanding, true);
  store.close();
});
