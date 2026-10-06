import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/app/engine.js';
import { Executor } from '../src/app/executor.js';
import { validateSettings } from '../src/app/config.js';
import { createHeatingTransport } from '../src/control/mqtt.js';
import { Store } from '../src/storage/store.js';

const INITIAL = Date.parse('2026-09-13T10:00:00Z');
test('missing DHWR configuration reports unavailable feedback', () => {
  const status = Engine.prototype.dhwrStatus.call({ executor: { pulseMs: 600_000, status: () => ({}) },
    clock: () => INITIAL, equipmentStatus: () => ({ devices: [] }), config: {} });
  assert.equal(status.actualOn, null);
  assert.equal(status.confirmed, false);
  assert.deepEqual(status.feedback, { configured: false, stateConfigured: false, powerConfigured: false, deviceId: null, available: false, basis: null, state: null, power: null });
});

function externalPump(t, publishDhwr) {
  const store = new Store(':memory:');
  const engine = new Engine({ store, clock: () => INITIAL, commandTransport: { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) }, publishDhwr, close: async () => {} },
    config: { input: 'mqtt', settings: validateSettings({  }) } });
  const state = { value: 1, unit: 'state', observedAt: INITIAL, stale: false };
  engine.equipment = { status: () => ({ devices: [{ id: 'dhwr', available: true, readings: { dhwr_active: state } }] }) };
  t.after(async () => { await engine.executor.close({ restore: false }); await engine.closeFireplace(); store.close(); });
  return { engine, store, state };
}

test('manual DHWR Stop persists and delivers OFF for a fresh externally started pump', async t => {
  const calls = [];
  const f = externalPump(t, async on => {
    assert.equal(f.store.getState('executor:home').dhwrOutstanding, true, 'OFF obligation precedes delivery');
    calls.push(on); return { sent: true };
  });
  assert.equal(f.engine.dhwrStatus().active, false);
  assert.equal(f.engine.dhwrStatus().actualOn, true);
  const result = await f.engine.stopDhwr();
  assert.deepEqual(calls, [false]);
  assert.equal(f.store.getState('executor:home').dhwrOutstanding, false);
  assert.equal(result.dhwr.actualOn, true, 'Broker acknowledgement cannot replace device feedback');
  assert.equal(result.dhwr.confirmed, false);
  f.state.stale = true;
  await f.engine.stopDhwr();
  f.state.stale = false; f.state.value = 0;
  await f.engine.stopDhwr();
  assert.deepEqual(calls, [false], 'No new OFF without an outstanding obligation or fresh reported ON');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM observations WHERE signal = 'dhwr_request' AND value = 0").get().count, 1);
});

test('failed external DHWR Stop survives restart and retries OFF without starting a run', async t => {
  const f = externalPump(t, async () => { throw Object.assign(new Error('Unconfirmed OFF'), { code: 'SHELLY_READBACK_TIMEOUT' }); });
  await assert.rejects(f.engine.stopDhwr(), { code: 'SHELLY_READBACK_TIMEOUT' });
  assert.equal(f.engine.dhwrStatus().active, false);
  assert.equal(f.engine.dhwrStatus().restorationPending, true);
  assert.equal(f.store.getState('executor:home').dhwrOutstanding, true);
  await f.engine.executor.close({ restore: false });
  const calls = [];
  const restarted = new Executor({ input: 'mqtt', store: f.store, clock: () => INITIAL + 10_000,
    commandTransport: { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) }, publishDhwr: async on => { calls.push(on); return { sent: true }; }, close: async () => {} } });
  try {
    await restarted.restore({ reason: 'restart' });
    assert.deepEqual(calls, [false]);
    assert.equal(restarted.status().dhwrOutstanding, false);
    assert.equal(restarted.status().restorationPending, false);
  } finally { await restarted.close({ restore: false }); }
});

test('external DHWR Stop retains the existing transport authority check', async t => {
  let commands = 0;
  const transport = createHeatingTransport({ canControl: () => false });
  transport.setDhwrRelay(async () => { commands++; return { sent: true }; }, 'fixture-route');
  t.after(() => transport.close());
  const f = externalPump(t, transport.publishDhwr);
  await assert.rejects(f.engine.stopDhwr(), { code: 'MQTT_AUTHORITY_LOST' });
  assert.equal(commands, 0);
  assert.equal(f.engine.dhwrStatus().restorationPending, true);
});
