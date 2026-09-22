import test from 'node:test';
import assert from 'node:assert/strict';
import { GarageRoomTemperature } from '../src/garage/room-temperature.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { Store } from '../src/storage/store.js';

const BASE = 1_800_000_000_000;
function fixture(targetC = 5) {
  let now = BASE;
  const controller = new GarageRoomTemperature({ targetC, now });
  const sent = [];
  const native = { power: 'on', mode: 'heat', targetC: 16, fan: 'auto', vane: 3 };
  const external = { supported: true, enabled: true, configurable: true, available: true,
    clearAvailable: true, busy: false, pending: false, phase: 'internal', restorationPending: false,
    acknowledged: true, rearmRequired: false, sourceEpoch: 'invented-session', result: null };
  const controls = { available: true, busy: false, result: null, settings: {
    targetC: { supported: true, usable: true, available: true, value: 16, min: 16, max: 31, step: 1 },
    power: { supported: true, usable: true, available: true, value: 'on', values: ['on', 'off'] },
    mode: { supported: true, usable: true, available: true, value: 'heat', values: ['heat', 'cool'] },
  } };
  const adapter = {
    externalTemperature: () => ({ ...external }),
    nativeControls: () => structuredClone(controls),
    status: () => ({ native: { ...native }, blockedReasons: [], electrical: {}, health: {} }),
    async setExternalTemperature(input, at) {
      sent.push({ ...input, requestedAt: at });
      external.result = { ...input, requestedAt: at, status: 'published' }; external.pending = true;
      return { ...external.result };
    },
    async setNativeSetting(input, at) {
      sent.push({ ...input, requestedAt: at });
      controls.result = { ...input, requestedAt: at, status: 'published' };
      return { ...controls.result };
    },
  };
  let observation = { signal: 'garage_temperature', source: 'mqtt-equipment', device: 'invented-rear',
    value: 5, sourceTime: now, receivedAt: now, quality: ['good'], raw: {} };
  function ack() {
    const command = sent.at(-1);
    if (Object.hasOwn(command, 'temperatureC')) {
      const clearing = command.temperatureC === null;
      Object.assign(external, { phase: clearing ? 'internal' : 'active', pending: false, busy: !clearing,
        restorationPending: !clearing, temperatureC: command.temperatureC,
        measuredAt: command.measuredAt ?? null, expiresInMs: clearing ? 0 : command.requestedExpiryAt - now,
        acknowledged: true, result: { ...command, status: 'acknowledged' } });
    } else {
      native[command.setting] = command.value;
      controls.result = { ...command, status: 'native-confirmed' };
    }
  }
  const tick = (sourceUsable = true) => controller.tick({ adapter, observation, now, canControl: true, sourceUsable });
  const advance = (ms = 1000) => { now += ms; };
  function measure(value = observation.value, at = now) { observation = { ...observation, value, sourceTime: at, receivedAt: now }; }
  async function start() {
    await tick(); assert.equal(sent.at(-1).temperatureC, null); ack();
    advance(); measure(); await tick(); assert.equal(sent.at(-1).setting, 'targetC'); ack();
    advance(); measure(); await tick(); assert.equal(sent.at(-1).temperatureC, observation.value + 16 - targetC); ack();
    await tick(); assert.equal(controller.status(observation).phase, 'active');
  }
  return { controller, adapter, sent, native, external, controls, tick, ack, advance, measure, start,
    now: () => now, observation: () => observation };
}

test('5°C selects and confirms native16 even when readback is16, then supplies independent room+11', async () => {
  const f = fixture(); await f.start();
  assert.deepEqual(f.sent.map(c => [c.setting ?? 'external', c.value ?? c.temperatureC]),
    [['external', null], ['targetC', 16], ['external', 16]]);
  assert.equal(f.sent[2].measuredAt, f.observation().sourceTime);
  assert.equal(f.sent[2].requestedExpiryAt, f.observation().sourceTime + 90_000);
  assert.equal(f.controller.status(f.observation()).offsetC, 11);
  assert.equal(f.controller.status(f.observation()).acknowledged, true);
});

test('new original measurements refresh active control, repeated polling cannot extend source expiry', async () => {
  const f = fixture(); await f.start(); const count = f.sent.length;
  f.advance(20_000); await f.tick(); assert.equal(f.sent.length, count);
  f.measure(4.8); await f.tick(); assert.equal(f.sent.length, count + 1);
  assert.equal(f.sent.at(-1).temperatureC, 16, 'round to the driver half-degree input');
  assert.equal(f.sent.at(-1).measuredAt, f.observation().sourceTime);
  f.ack(); f.advance(90_000); await f.tick();
  assert.equal(f.sent.at(-1).temperatureC, null); assert.equal(f.controller.phase, 'clearing');
  f.ack(); await f.tick(); assert.equal(f.controller.phase, 'waiting');
  const cleared = f.sent.length; await f.tick(); assert.equal(f.sent.length, cleared);
  f.advance(); f.measure(5); await f.tick(); assert.equal(f.sent.at(-1).temperatureC, 16);
});

test('invalid, echoed, stale and out-of-range inputs clear rather than clamp or freshen readings', async () => {
  for (const scenario of ['invalid', 'echo', 'stale', 'range']) {
    const f = fixture(); await f.start(); f.advance();
    if (scenario === 'echo') f.observation().source = 'garage-adapter';
    if (scenario === 'stale') f.advance(90_000);
    if (scenario === 'range') f.measure(35);
    await f.tick(scenario !== 'invalid');
    assert.equal(f.sent.at(-1).temperatureC, null, scenario);
  }
});

test('changing low target clears and selects16 again, then requires a new source timestamp', async () => {
  const f = fixture(); await f.start();
  f.controller.select(10, f.now()); await f.tick(); f.ack(); f.advance(); await f.tick();
  assert.equal(f.sent.at(-1).setting, 'targetC'); f.ack();
  await f.tick(); assert.equal(f.controller.phase, 'waiting');
  f.advance(); f.measure(7); await f.tick(); assert.equal(f.sent.at(-1).temperatureC, 13);
});

test('ordinary power and native targets wait for acknowledged internal-sensor handover', async () => {
  for (const request of [{ setting: 'power', value: 'off' }, { setting: 'targetC', value: 19 }]) {
    const f = fixture(); await f.start(); f.controller.cancel(request, f.now());
    await f.tick(); assert.equal(f.sent.at(-1).temperatureC, null);
    await f.tick(); assert.equal(f.sent.at(-1).temperatureC, null);
    f.ack(); f.advance(); await f.tick();
    assert.equal(f.sent.at(-1).setting, request.setting); assert.equal(f.sent.at(-1).value, request.value);
    assert.equal(f.controller.targetC, null);
  }
});

test('visible native changes stop external feed until an explicit new room selection', async () => {
  const f = fixture(); await f.start(); f.advance(); f.native.targetC = 17;
  await f.tick(); assert.equal(f.sent.at(-1).temperatureC, null); f.ack(); await f.tick();
  assert.equal(f.controller.phase, 'blocked'); const count = f.sent.length;
  f.advance(); f.measure(5); await f.tick(); assert.equal(f.sent.length, count);
  f.controller.select(5, f.now()); await f.tick(); assert.equal(f.sent.length, count + 1);
});

test('restart and driver session changes discard prior native setup and never replay cached samples', async () => {
  const f = fixture(); await f.start();
  f.advance(); f.external.sourceEpoch = 'invented-next-session';
  await f.tick(); assert.equal(f.sent.at(-1).temperatureC, null); f.ack(); await f.tick();
  assert.equal(f.sent.at(-1).setting, 'targetC'); f.ack(); await f.tick();
  assert.equal(f.controller.phase, 'waiting');
  f.advance(); f.measure(); await f.tick(); assert.equal(f.sent.at(-1).temperatureC, 16);
});

test('unknown capability, disabled input and lost ownership never publish numeric input', async () => {
  for (const change of [{ supported: false }, { enabled: false, clearAvailable: false },
    { configurable: false, available: false, clearAvailable: false, clearReason: 'Another owner' }]) {
    const f = fixture(); Object.assign(f.external, change); await f.tick();
    assert.equal(f.sent.length, 0);
  }
});

test('a failed native16 confirmation inhibits repeated writes and external activation', async () => {
  const f = fixture(); await f.tick(); f.ack(); f.advance(); f.measure(); await f.tick();
  f.controls.result.status = 'uncertain'; await f.tick();
  assert.equal(f.controller.phase, 'blocked'); const count = f.sent.length;
  f.advance(); f.measure(); await f.tick(); assert.equal(f.sent.length, count);
});

test('an uncertain external publication is cleared before a new measurement can resume control', async () => {
  const f = fixture(); await f.start(); f.advance(); f.measure(6); await f.tick();
  f.external.pending = false; f.external.available = false;
  f.external.result.status = 'uncertain';
  await f.tick(); assert.equal(f.sent.at(-1).temperatureC, null);
  f.ack(); f.external.available = true; await f.tick();
  assert.equal(f.controller.phase, 'waiting');
  f.advance(); f.measure(6); await f.tick(); assert.equal(f.sent.at(-1).temperatureC, 17);
});

test('loss of host authority withdraws active status and sends no further commands', async () => {
  const f = fixture(); await f.start(); const count = f.sent.length;
  await f.controller.tick({ adapter: f.adapter, observation: f.observation(), now: f.now(), canControl: false, sourceUsable: true });
  assert.equal(f.controller.acknowledged, false);
  assert.equal(f.controller.phase, 'waiting');
  assert.equal(f.sent.length, count);
});

test('missing startup sensor data still establishes the native16 fallback without sending a number', async () => {
  const f = fixture(); await f.tick(false); f.ack(); f.advance(); await f.tick(false);
  assert.equal(f.sent.at(-1).setting, 'targetC'); f.ack(); await f.tick(false);
  assert.equal(f.controller.phase, 'waiting');
  assert.equal(f.sent.filter(command => Number.isFinite(command.temperatureC)).length, 0);
});

test('runtime persists room intent atomically, restores only the intent, and removes it for ordinary settings', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const f = fixture(null), engine = { latest: {}, settings: { mode: 'shadow' } };
  const options = { engine, store, config: { input: 'mqtt', garage: { enabled: false } }, clock: f.now };
  const runtime = new GarageRuntime(options); runtime.setAdapter(f.adapter);
  t.after(() => runtime.close({ restore: false }));
  await runtime.setNativeSettings({ setting: 'targetC', value: 5 });
  await runtime.roomDispatch;
  assert.deepEqual(store.getState(runtime.keys.roomTemperature), { targetC: 5 });
  assert.equal(runtime.nativeControls().settings.targetC.value, 5);
  assert.equal(runtime.nativeControls().settings.targetC.min, 5);
  const restarted = new GarageRuntime(options); t.after(() => restarted.close({ restore: false }));
  assert.equal(restarted.roomTemperature.targetC, 5); assert.equal(restarted.roomTemperature.prepared, false);
  assert.equal(restarted.roomTemperature.lastMeasuredAt, undefined);
  f.ack(); await runtime.roomTemperatureTick();
  await runtime.setNativeSettings({ setting: 'targetC', value: 18 });
  await runtime.roomDispatch;
  assert.deepEqual(store.getState(runtime.keys.roomTemperature), { targetC: null });
  assert.equal(runtime.roomTemperature.targetC, null);
});

test('runtime rejects stale preference API, unsupported low target, replicas and failed persistence', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const f = fixture(null), engine = { latest: {}, settings: { mode: 'shadow' } };
  let owner = true;
  const runtime = new GarageRuntime({ engine, store, config: { input: 'mqtt', garage: {} }, clock: f.now, canControl: () => owner });
  runtime.setAdapter(f.adapter); t.after(() => runtime.close({ restore: false }));
  assert.equal(runtime.setPreferences, undefined);
  for (const input of [{ setting: 'targetC', value: 4 }, { setting: 'targetC', value: 5, extra: true },
    { setting: 'targetC', value: '5' }]) await assert.rejects(runtime.setNativeSettings(input));
  f.external.configurable = false; await assert.rejects(runtime.setNativeSettings({ setting: 'targetC', value: 5 }));
  f.external.configurable = true; owner = false;
  await assert.rejects(runtime.setNativeSettings({ setting: 'targetC', value: 5 })); owner = true;
  const setState = store.setState.bind(store);
  store.setState = (key, value) => { if (key === runtime.keys.roomTemperature) throw new Error('storage failure'); return setState(key, value); };
  await assert.rejects(runtime.setNativeSettings({ setting: 'targetC', value: 5 }), /storage failure/);
  assert.equal(runtime.roomTemperature.targetC, null); assert.equal(f.sent.length, 0);
});
