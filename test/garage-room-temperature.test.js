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
  const native = { power: 'on', mode: 'heat', targetC: 17, fan: 'auto', vane: 3 };
  const readNative = values => Object.assign(native, values);
  const external = { supported: true, enabled: true, configurable: true, available: true,
    clearAvailable: true, busy: false, pending: false, phase: 'internal', restorationPending: false,
    acknowledged: true, rearmRequired: false, sourceEpoch: 'invented-session', result: null };
  const controls = { available: true, busy: false, result: null, settings: {
    targetC: { supported: true, usable: true, available: true, value: 17, min: 16, max: 31, step: 1 },
    power: { supported: true, usable: true, available: true, value: 'on', values: ['on', 'off'] },
    mode: { supported: true, usable: true, available: true, value: 'heat', values: ['heat', 'cool'] },
  } };
  const adapter = {
    externalTemperature: () => ({ ...external }),
    nativeControls: () => structuredClone(controls),
    status: () => ({ native: { ...native }, blockedReasons: [], electrical: {}, health: {} }),
    async setExternalTemperature(input, at) {
      if (input.temperatureC !== null && native.targetC !== 17) {
        const error = new Error('External temperature requires a confirmed native 17°C target.');
        error.code = 'external-native-target-required';
        throw error;
      }
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
    advance(); measure(); await tick(); assert.equal(sent.at(-1).temperatureC, observation.value + 17 - targetC); ack();
    await tick(); assert.equal(controller.status(observation).phase, 'active');
  }
  return { controller, adapter, sent, native, readNative, external, controls, tick, ack, advance, measure, start,
    now: () => now, observation: () => observation };
}

test('5°C selects and confirms native17 even when readback is17, then supplies independent room+12', async () => {
  const f = fixture(); await f.start();
  assert.deepEqual(f.sent.map(c => [c.setting ?? 'external', c.value ?? c.temperatureC]),
    [['external', null], ['targetC', 17], ['external', 17]]);
  assert.equal(f.sent[2].measuredAt, f.observation().sourceTime);
  assert.equal(f.sent[2].requestedExpiryAt, f.observation().sourceTime + 90_000);
  assert.equal(f.controller.status(f.observation()).offsetC, 12);
  assert.equal(f.controller.status(f.observation()).acknowledged, true);
});

test('new original measurements refresh active control, repeated polling cannot extend source expiry', async () => {
  const f = fixture(); await f.start(); const count = f.sent.length;
  f.advance(20_000); await f.tick(); assert.equal(f.sent.length, count);
  f.measure(4.8); await f.tick(); assert.equal(f.sent.length, count + 1);
  assert.equal(f.sent.at(-1).temperatureC, 17, 'round to the driver half-degree input');
  assert.equal(f.sent.at(-1).measuredAt, f.observation().sourceTime);
  f.ack(); f.advance(90_000); await f.tick();
  assert.equal(f.sent.at(-1).temperatureC, null); assert.equal(f.controller.phase, 'clearing');
  f.ack(); await f.tick(); assert.equal(f.controller.phase, 'waiting');
  const cleared = f.sent.length; await f.tick(); assert.equal(f.sent.length, cleared);
  f.advance(); f.measure(5); await f.tick(); assert.equal(f.sent.at(-1).temperatureC, 17);
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

test('changing low target clears and selects17 again, then requires a new source timestamp', async () => {
  const f = fixture(); await f.start();
  f.controller.select(10, f.now()); await f.tick(); f.ack(); f.advance(); await f.tick();
  assert.equal(f.sent.at(-1).setting, 'targetC'); f.ack();
  await f.tick(); assert.equal(f.controller.phase, 'waiting');
  f.advance(); f.measure(7); await f.tick(); assert.equal(f.sent.at(-1).temperatureC, 14);
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

test('native readback changes between renewals leave the admitted sample untouched', async () => {
  const f = fixture(); await f.start();
  const commands = structuredClone(f.sent), status = f.controller.status(f.observation());
  for (const values of [{ targetC: 16 }, { power: 'off' }, { mode: 'cool' }, { targetC: null }, { fan: 3 }]) {
    f.advance(); f.readNative(values); await f.tick();
    assert.deepEqual(f.sent, commands, JSON.stringify(values));
    assert.equal(f.controller.phase, 'active');
    assert.equal(f.controller.inhibited, null);
    assert.equal(f.controller.status(f.observation()).acknowledged, status.acknowledged);
  }
});

test('a native target admission failure withholds renewal without clearing or requiring manual reapplication', async t => {
  const cases = [
    ['ambiguous 16°C', f => f.readNative({ targetC: 16 })],
    ['unknown target', f => f.readNative({ targetC: null })],
    ['native context unavailable', f => { f.external.available = false; f.external.reason = 'Fresh native HEAT and ON settings are required.'; }],
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    const f = fixture(); await f.start(); const commands = structuredClone(f.sent);
    const expiry = f.sent.at(-1).requestedExpiryAt;
    f.advance(20_000); f.measure(4); change(f); await f.tick();
    assert.deepEqual(f.sent, commands, 'invalid renewal must send neither a numeric value nor a clear or native command');
    assert.equal(f.controller.phase, 'waiting');
    assert.equal(f.controller.inhibited, null, 'baseline mismatch is not a manual-reapply latch');
    assert.match(f.controller.reason, /17|fresh|ON|HEAT/i);
    f.advance(); await f.tick(); assert.deepEqual(f.sent, commands);
    assert.equal(f.external.measuredAt + 90_000, expiry, 'the active lease retains its original measurement deadline');
    f.advance(); f.readNative({ power: 'on', mode: 'heat', targetC: 17 }); f.external.available = true; f.measure(4); await f.tick();
    assert.equal(f.sent.length, commands.length + 1, 'a later new measurement can resume with valid native evidence');
    assert.equal(f.sent.at(-1).temperatureC, 16);
    assert.equal(f.sent.at(-1).requestedExpiryAt, f.observation().sourceTime + 90_000);
  });
});

test('native confirmation is checked again before the first numeric sample is admitted', async () => {
  const f = fixture(); await f.tick(); f.ack(); f.advance(); f.measure(); await f.tick(); f.ack();
  f.advance(); f.measure(); f.readNative({ targetC: 16 }); await f.tick();
  assert.equal(f.sent.length, 2);
  assert.equal(f.controller.phase, 'waiting');
  assert.equal(f.controller.prepared, true, 'command confirmation alone does not authorize external input');
  f.advance(); f.readNative({ targetC: 17 }); f.measure(); await f.tick();
  assert.equal(f.sent.length, 3); assert.equal(f.sent.at(-1).temperatureC, 17);
});

test('a mismatched baseline cannot extend the original lease even as fresh room measurements arrive', async () => {
  const f = fixture(); await f.start(); const commands = structuredClone(f.sent);
  const expiry = f.sent.at(-1).requestedExpiryAt;
  f.advance(20_000); f.readNative({ targetC: 16 }); f.measure(4); await f.tick();
  f.advance(expiry - f.now()); f.readNative(); f.measure(4); await f.tick();
  assert.deepEqual(f.sent, commands);
  assert.equal(f.external.measuredAt + 90_000, f.now(), 'the driver permission expires on its original deadline');
  Object.assign(f.external, { phase: 'internal', temperatureC: null, measuredAt: null,
    expiresInMs: 0, restorationPending: false, acknowledged: false });
  await f.tick(); assert.deepEqual(f.sent, commands);
  assert.equal(f.controller.phase, 'waiting');
});

test('a driver rearm requirement still requires an explicit new room selection', async () => {
  const f = fixture(); await f.start(); f.advance(); f.external.rearmRequired = true;
  await f.tick(); assert.equal(f.sent.at(-1).temperatureC, null);
  f.external.rearmRequired = false; f.ack(); await f.tick();
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
  f.advance(); f.measure(); await f.tick(); assert.equal(f.sent.at(-1).temperatureC, 17);
});

test('unknown capability, disabled input and lost ownership never publish numeric input', async () => {
  for (const change of [{ supported: false }, { enabled: false, clearAvailable: false },
    { configurable: false, available: false, clearAvailable: false, clearReason: 'Another owner' }]) {
    const f = fixture(); Object.assign(f.external, change); await f.tick();
    assert.equal(f.sent.length, 0);
  }
});

test('a failed native17 confirmation inhibits repeated writes and external activation', async () => {
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
  f.advance(); f.measure(6); await f.tick(); assert.equal(f.sent.at(-1).temperatureC, 18);
});

test('loss of host authority withdraws active status and sends no further commands', async () => {
  const f = fixture(); await f.start(); const count = f.sent.length;
  await f.controller.tick({ adapter: f.adapter, observation: f.observation(), now: f.now(), canControl: false, sourceUsable: true });
  assert.equal(f.controller.acknowledged, false);
  assert.equal(f.controller.phase, 'waiting');
  assert.equal(f.sent.length, count);
});

test('missing startup sensor data still establishes the native17 fallback without sending a number', async () => {
  const f = fixture(); await f.tick(false); f.ack(); f.advance(); await f.tick(false);
  assert.equal(f.sent.at(-1).setting, 'targetC'); f.ack(); await f.tick(false);
  assert.equal(f.controller.phase, 'waiting');
  assert.equal(f.sent.filter(command => Number.isFinite(command.temperatureC)).length, 0);
});

test('runtime persists room intent atomically and keeps ordinary room selections without external control on restart', async t => {
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
  assert.deepEqual(store.getState(runtime.keys.roomTemperature), { targetC: 18 });
  assert.equal(runtime.roomTemperature.targetC, null);
  assert.equal(runtime.status().learning.normalReference.rearC, 18);
  assert.equal(runtime.status().learning.normalReference.frontC, 18);
  const nativeRestart = new GarageRuntime(options); t.after(() => nativeRestart.close({ restore: false }));
  assert.equal(nativeRestart.roomTemperature.targetC, null, 'Native-range intent does not restart external sensing');
  assert.equal(nativeRestart.status().learning.normalReference.rearC, 18);
  assert.equal(nativeRestart.status().learning.normalReference.frontC, 18);
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
  const referenceBeforeFailure = structuredClone(runtime.status().learning.normalReference);
  const setState = store.setState.bind(store);
  store.setState = (key, value) => { if (key === runtime.keys.roomTemperature) throw new Error('storage failure'); return setState(key, value); };
  await assert.rejects(runtime.setNativeSettings({ setting: 'targetC', value: 5 }), /storage failure/);
  assert.equal(runtime.roomTemperature.targetC, null); assert.equal(f.sent.length, 0);
  assert.deepEqual(runtime.status().learning.normalReference, referenceBeforeFailure,
    'Failed persistence cannot publish model estimates for a room setting that was not saved');
});
