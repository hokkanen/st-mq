import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { createH66Controller } from '../src/control/h66.js';
import { createH66Decoder } from '../src/domain/telemetry.js';

const START = Date.parse('2026-09-14T12:00:00Z');
function setup(t, { room = 20, boostC = 5, writableMaximum, circulation = true, writable = true, floor = false } = {}) {
  let now = START;
  const store = new Store(':memory:'), native = { '0203': room, '0212': 44, '0208': 60, '2201': 1 };
  const writes = [], commands = [], switches = [];
  const transport = { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) }, close: async () => {}, publish: async batch => { commands.push(batch); return { status: 'mqtt', sent: true }; },
    ...(circulation ? { publishDhwr: async on => { switches.push(on); return { status: 'mqtt', sent: true }; } } : {}) };
  const engine = new Engine({ store, config: { input: 'providers', settings: {  },
    control: { preheatRoomBoostC: boostC } }, clock: () => now, commandTransport: transport });
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
  if (floor) {
    let active = false;
    engine.floorOverride = engine.executor.floorOverride = {
      status: () => ({ enabled: true, commissioned: true, available: true, active,
        devices: [0, 1].map(group => ({ group: `Synthetic ${group}`, channels: [0, 1].map(id => ({ id, output: active })) })) }),
      async lease() { active = true; return { confirmed: true }; },
      async release() { active = false; return { restorationPending: false }; },
    };
  }
  t.after(async () => {
    await engine.executor.close({ restore: false }); await controller.close();
    await engine.garage.close({ restore: false }); store.close();
  });
  return { engine, controller, store, native, writes, commands, switches, at(value) { now = value; } };
}

for (const [name, options, boost, target] of [
  ['default five-degree increase', {}, 5, 25],
  ['configured increase', { boostC: 4 }, 4, 24],
  ['warmer baseline', { room: 27 }, 5, 32],
  ['device maximum', { room: 33 }, 2, 35],
  ['reported device maximum', { writableMaximum: 24 }, 4, 24],
  ['no ROOM increase at the maximum with floor override', { room: 35, floor: true }, 0, 35],
  ['fractional baseline', { room: 20.5 }, 5, 25.5],
  ['independent DHWR without a circulation transport', { circulation: false }, 5, 25],
]) test(`Preheat selects the ${name} and records its actual increase`, async t => {
  const f = setup(t, options), capability = f.engine.heatingTests();
  assert.equal(capability.preheatAvailable, true);
  assert.equal(capability.preheatRoomBoostC, boost); assert.equal(capability.preheatTargetC, target);
  const result = await f.engine.testHeating({ command: 'preheat' });
  assert.equal(result.roomBoostC, boost); assert.equal(f.native['0203'], target);
  assert.equal(f.engine.applied.roomBoostC, boost);
  const context = f.store.db.prepare("SELECT payload FROM learning_journal WHERE input='providers' AND kind='context' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(context.payload).value.controlContext.roomBoostC, boost);
  assert.deepEqual(f.switches, [], 'Preheating does not initiate a DHWR run');
});

test('Preheat stays unavailable without ROOM headroom or fresh controls', async t => {
  for (const options of [{ writableMaximum: 20 }, { writable: false }, { room: 35 }]) {
    const f = setup(t, options);
    const capability = f.engine.heatingTests();
    assert.equal(capability.preheatAvailable, false);
    assert.equal(capability.preheatRoomBoostC, null); assert.equal(capability.preheatTargetC, null);
    await assert.rejects(f.engine.testHeating({ command: 'preheat' }), /[Pp]reheat/);
    assert.deepEqual(f.writes, []); assert.deepEqual(f.switches, []); assert.deepEqual(f.commands, []);
  }
  const stale = setup(t); stale.at(START + 300_001);
  assert.equal(stale.engine.heatingTests().preheatAvailable, false);
});

test('repeated preheat during a pause uses its original ROOM baseline and restores it when pause ends', async t => {
  const f = setup(t, { room: 22 });
  f.store.setState('override:providers', { id: 'fixture-max-preheat-pause', mode: 'normal', createdAt: START, expiresAt: START + 3_600_000 });
  await f.engine.testHeating({ command: 'preheat' });
  assert.equal(f.controller.status().phase, 'manual-pause');
  f.at(START + 1000);
  const capability = f.engine.heatingTests();
  assert.equal(capability.preheatAvailable, true);
  assert.equal(capability.preheatRoomBoostC, 5); assert.equal(capability.preheatTargetC, 27);
  await f.engine.testHeating({ command: 'preheat' });
  assert.deepEqual(f.writes, [{ register: '0203', value: 27 }]);
  assert.equal(f.native['0203'], 27);
  f.engine.setTemporary({ pauseUntil: null }); await f.engine.dispatchPending;
  assert.equal(f.native['0203'], 22); assert.equal(f.controller.status().manualPreheat, null);
  assert.equal(Boolean(f.engine.executor.status().dhwrOutstanding), false);
  assert.deepEqual(f.switches, []);
});

test('unpaused preheat restores on the next controller update without starting circulation', async t => {
  const f = setup(t);
  await f.engine.testHeating({ command: 'preheat' });
  assert.equal(f.native['0203'], 25);
  assert.equal(f.controller.status().expiresAt, START + 60_000);
  f.at(START + 1000); f.engine.tick(); await f.engine.dispatchPending;
  assert.equal(f.native['0203'], 20);
  assert.equal(f.controller.status().phase, 'normal');
  assert.equal(Boolean(f.engine.executor.status().dhwrOutstanding), false);
  assert.deepEqual(f.switches, []);
});
