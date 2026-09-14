import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { createH66Controller } from '../src/control/h66.js';
import { createH66Decoder } from '../src/domain/telemetry.js';

const START = Date.parse('2026-09-14T12:00:00Z');
function setup(t, { room = 20, maximumBoost = 5, writableMaximum, circulation = true, writable = true } = {}) {
  let now = START;
  const store = new Store(':memory:'), native = { '0203': room, '0212': 44, '0208': 60, '2201': 1 };
  const writes = [], commands = [], switches = [];
  const transport = { close: async () => {}, publish: async batch => { commands.push(batch); return { status: 'mqtt', sent: true }; },
    ...(circulation ? { publishDhwr: async on => { switches.push(on); return { status: 'mqtt', sent: true }; } } : {}) };
  const engine = new Engine({ store, config: { input: 'providers', settings: { mode: 'shadow' },
    control: { maxRoomBoostC: maximumBoost } }, clock: () => now, commandTransport: transport });
  const deviceId = 'fixture-max-preheat', decoder = createH66Decoder({ deviceId });
  let controller;
  const feed = register => controller.ingest(decoder.decode({ topic: `${deviceId}/HP/${register}`,
    payload: String(native[register]), receivedAt: now }));
  controller = createH66Controller({ deviceId, store, clock: () => now,
    config: { writeEnabled: writable, readbackTimeoutMs: 100 },
    publish: async (topic, payload) => {
      const register = topic.split('/').at(-1);
      writes.push({ register, value: Number(payload) }); native[register] = Number(payload);
      queueMicrotask(() => feed(register));
    } });
  if (writableMaximum != null) {
    const status = controller.status;
    controller.status = at => {
      const value = status(at); value.controls['0203'].max = writableMaximum; return value;
    };
  }
  controller.setConnected(true); Object.keys(native).forEach(feed); engine.setH66(controller);
  t.after(async () => {
    await engine.executor.close({ restore: false }); await controller.close();
    await engine.garage.close({ restore: false }); store.close();
  });
  return { engine, controller, store, native, writes, commands, switches, at(value) { now = value; } };
}

for (const [name, options, boost, target] of [
  ['configured maximum', { maximumBoost: 3 }, 3, 23],
  ['native ROOM limit', { room: 33 }, 2, 35],
  ['reported writable maximum', { room: 20, writableMaximum: 24 }, 4, 24],
  ['fractional remaining ROOM headroom', { room: 33.5 }, 1.5, 35],
  ['native supported boost ceiling', { maximumBoost: 8 }, 5, 25],
]) test(`Max preheating selects the ${name} and records the selected boost`, async t => {
  const f = setup(t, options), capability = f.engine.heatingTests();
  assert.equal(capability.preheatAvailable, true);
  assert.equal(capability.preheatRoomBoostC, boost); assert.equal(capability.preheatTargetC, target);
  const result = await f.engine.testHeating({ command: 'preheat' });
  assert.equal(result.roomBoostC, boost); assert.equal(f.native['0203'], target);
  assert.equal(f.engine.applied.roomBoostC, boost);
  const context = f.store.db.prepare("SELECT payload FROM learning_journal WHERE input='providers' AND kind='context' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(context.payload).value.controlContext.roomBoostC, boost);
  assert.deepEqual(f.switches, [true]);
});

test('Max preheating stays unavailable without a complete valid boost and fresh writable controls', async t => {
  for (const options of [{ room: 34.5 }, { room: 35 }, { circulation: false }, { writable: false }]) {
    const f = setup(t, options);
    const capability = f.engine.heatingTests();
    assert.equal(capability.preheatAvailable, false);
    assert.equal(capability.preheatRoomBoostC, null); assert.equal(capability.preheatTargetC, null);
    await assert.rejects(f.engine.testHeating({ command: 'preheat' }), /Max preheating needs/);
    assert.deepEqual(f.writes, []); assert.deepEqual(f.switches, []); assert.deepEqual(f.commands, []);
  }
  const stale = setup(t); stale.at(START + 300_001);
  assert.equal(stale.engine.heatingTests().preheatAvailable, false);
});

test('repeated Max preheating during a pause uses the saved ROOM base and restores it when pause ends', async t => {
  const f = setup(t, { room: 32 });
  f.store.setState('override:providers', { id: 'fixture-max-preheat-pause', mode: 'normal', createdAt: START, expiresAt: START + 3_600_000 });
  await f.engine.testHeating({ command: 'preheat' });
  assert.equal(f.controller.status().phase, 'manual-pause');
  f.at(START + 1000);
  const capability = f.engine.heatingTests();
  assert.equal(capability.preheatAvailable, true);
  assert.equal(capability.preheatRoomBoostC, 3); assert.equal(capability.preheatTargetC, 35);
  await f.engine.testHeating({ command: 'preheat' });
  assert.deepEqual(f.writes, [{ register: '0203', value: 35 }]);
  assert.equal(f.native['0203'], 35);
  f.engine.setTemporary({ pauseUntil: null }); await f.engine.dispatchPending;
  assert.equal(f.native['0203'], 32); assert.equal(f.controller.status().manualPreheat, null);
  assert.equal(f.engine.executor.status().dhwrOutstanding, true, 'circulation keeps its independent full timer');
  assert.deepEqual(f.switches, [true, true]);
});

test('unpaused Max preheating restores on the next controller update while circulation keeps its full timer', async t => {
  const f = setup(t);
  await f.engine.testHeating({ command: 'preheat' });
  assert.equal(f.native['0203'], 25);
  assert.equal(f.controller.status().expiresAt, START + 60_000);
  f.at(START + 1000); f.engine.tick(); await f.engine.dispatchPending;
  assert.equal(f.native['0203'], 20);
  assert.equal(f.controller.status().phase, 'normal');
  assert.equal(f.engine.executor.status().dhwrOutstanding, true);
  assert.deepEqual(f.switches, [true]);
});
