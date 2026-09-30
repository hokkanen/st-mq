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

test('manual Preheat re-arms the controller for its exact off-minute ROOM and floor deadline', async t => {
  const f = setup(t, { floor: true });
  f.at(START + 17_345);
  const deadlines = [];
  f.engine.onTemporaryChange = () => deadlines.push(f.engine.nextTemporaryDeadline());
  const result = await f.engine.testHeating({ command: 'preheat' });
  const deadline = START + 917_000;
  assert.equal(result.expiresAt, deadline);
  assert.equal(f.controller.status().expiresAt, deadline);
  assert.equal(f.engine.nextTemporaryDeadline(), deadline);
  assert.deepEqual(deadlines, [deadline]);
  assert.notEqual(deadline % 60_000, 0, 'The controller deadline follows the lease instead of the next regular minute');
  await f.engine.testHeating({ command: 'normal' });
  assert.equal(f.engine.nextTemporaryDeadline(), Infinity);
  assert.deepEqual(deadlines, [deadline, Infinity]);
});

test('repeated preheat during a pause uses its original ROOM baseline and restores it when pause ends', async t => {
  const f = setup(t, { room: 22 });
  f.engine.automation.set('home', false, { pauseUntil: START + 3_600_000 });
  await f.engine.testHeating({ command: 'preheat' });
  assert.equal(f.controller.status().phase, 'preheat');
  f.at(START + 1000);
  const capability = f.engine.heatingTests();
  assert.equal(capability.preheatAvailable, true);
  assert.equal(capability.preheatRoomBoostC, 5); assert.equal(capability.preheatTargetC, 27);
  await f.engine.testHeating({ command: 'preheat' });
  assert.deepEqual(f.writes, [{ register: '0203', value: 27 }]);
  assert.equal(f.native['0203'], 27);
  await f.engine.setAutomation({ feature: 'home', enabled: true }); await f.engine.dispatchPending;
  assert.equal(f.native['0203'], 22); assert.equal(f.controller.status().manualPreheat, null);
  assert.deepEqual(f.switches, [true], 'Resuming Automatic restores ordinary circulation eligibility.');
});

test('automatic-mode manual preheat survives controller updates and restores at its single lease deadline', async t => {
  const f = setup(t);
  f.engine.automation.set('home', true);
  await f.engine.testHeating({ command: 'preheat' });
  assert.equal(f.native['0203'], 25);
  assert.equal(f.controller.status().expiresAt, START + 900_000);
  f.at(START + 1000); f.engine.tick(); await f.engine.dispatchPending;
  assert.equal(f.native['0203'], 25);
  assert.deepEqual(f.switches, [], 'Manual Preheat never starts DHWR.');
  f.at(START + 900_000);
  Object.entries(f.native).forEach(([register, value]) => f.controller.ingest(createH66Decoder({ deviceId: 'fixture-max-preheat' }).decode({ topic: `fixture-max-preheat/HP/${register}`, payload: String(value), receivedAt: START + 900_000 })));
  f.engine.tick(); await f.engine.dispatchPending;
  assert.equal(f.native['0203'], 20);
  assert.equal(f.controller.status().phase, 'normal');
  assert.equal(f.engine.executor.status().manualPreheatReport.roomOutcome, 'restored');
  assert.deepEqual(f.switches, [true], 'Automatic normal service resumes after the manual lease ends.');
});
