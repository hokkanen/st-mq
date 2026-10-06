import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHeatingTransport, HEATING_COMMANDS } from '../src/control/mqtt.js';

test('heating dispatcher requires configured direct relays and rejects retired circulation batches', async () => {
  const transport = createHeatingTransport();
  assert.deepEqual(HEATING_COMMANDS, ['reduction', 'normal', 'circulation']);
  assert.ok(Object.isFrozen(HEATING_COMMANDS));
  for (const commands of [null, [], Array(1), 'reduction', ['reduction', 'unknown'], ['HEATOFF'], ['reduction '], ['circulation'], [7]])
    await assert.rejects(transport.publish(commands), { code: 'MQTT_COMMAND_INVALID' });
  await assert.rejects(transport.publish(['normal']), { code: 'MQTT_RELAY_UNAVAILABLE' });
  await assert.rejects(transport.publishDhwr(true), { code: 'MQTT_DHWR_UNAVAILABLE' });
  await assert.rejects(transport.publishDhwr('ON'), { code: 'MQTT_COMMAND_INVALID' });
  await transport.close();
});

test('native heating and circulation share exclusivity and wait for device confirmation', async () => {
  const transport = createHeatingTransport(), delivered = [];
  let confirm;
  transport.setDhwrRelay(on => { delivered.push(on); return new Promise(resolve => { confirm = resolve; }); }, 'circulation');
  const pending = transport.publishDhwr(true);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(transport.publish(['normal']), { code: 'MQTT_BUSY' });
  await assert.rejects(transport.publishDhwr(false), { code: 'MQTT_BUSY' });
  assert.deepEqual(delivered, [true]);
  confirm({ sent: true, confirmed: true });
  assert.equal((await pending).confirmed, true);
  let commands;
  transport.setHeatingRelay(async batch => { commands = batch; return { sent: true }; });
  const batch = ['normal'], completion = transport.publish(batch); batch[0] = 'invalid';
  await completion; assert.deepEqual(commands, ['normal']); await transport.close();
});

test('shutdown drains bounded native work and prohibits later dispatch', async () => {
  const transport = createHeatingTransport();
  const steps = []; let confirm;
  transport.setHeatingRelay(async commands => {
    for (const command of commands) { steps.push(command); await new Promise(resolve => { confirm = resolve; }); }
    return { sent: true };
  }, 'route');
  const pending = transport.publish(['reduction', 'normal']);
  const rejection = assert.rejects(pending, { code: 'MQTT_CLOSED' });
  await new Promise(resolve => setImmediate(resolve));
  let closed = false; const closing = transport.close().then(() => { closed = true; });
  assert.equal(closed, false);
  confirm(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(steps, ['reduction', 'normal']); assert.equal(closed, false);
  confirm(); await closing; await rejection;
  await assert.rejects(transport.publishDhwr(false), { code: 'MQTT_CLOSED' });
  assert.deepEqual(steps, ['reduction', 'normal']);
});

test('native identities fence routes while tariff identity retains its current representation', async () => {
  const transport = createHeatingTransport();
  assert.deepEqual(transport.targetIdentity, { tariff: null, dhwr: null });
  let route = 'fixture-one';
  transport.setHeatingRelay(async () => ({ sent: true }), () => route);
  transport.setDhwrRelay(async () => ({ sent: true }), () => route);
  const original = transport.targetIdentity;
  assert.equal(original.tariff, createHash('sha256').update(JSON.stringify({ protocol: 'mqtt-tariff', route })).digest('hex'));
  route = 'fixture-two'; assert.notEqual(transport.targetIdentity.dhwr, original.dhwr);
  await assert.rejects(transport.publish(['normal'], { expectedTarget: original.tariff }), { code: 'EXECUTOR_EXPIRED' });
  await assert.rejects(transport.publish(['normal'], { validUntil: 10, clock: () => 10 }), { code: 'EXECUTOR_EXPIRED' });
  await transport.close();
});

test('circulation dispatch cannot cross a native identity change queued before its RPC', async () => {
  let route = 'first-native-relay', calls = 0;
  const transport = createHeatingTransport();
  transport.setDhwrRelay(async () => { calls++; return { sent: true }; }, () => route);
  const pending = transport.publishDhwr(true); route = 'replacement-native-relay';
  await assert.rejects(pending, { code: 'EXECUTOR_EXPIRED' });
  assert.equal(calls, 0); await transport.close();
});
