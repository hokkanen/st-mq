import test from 'node:test';
import assert from 'node:assert/strict';
import { GarageRoomTemperature } from '../src/garage/room-temperature.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { garageSettings } from '../src/garage/settings.js';
import { replayGarageJournal } from '../src/garage/learning.js';
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
    fan: { supported: true, usable: true, available: true, value: 'auto', values: ['auto', 1, 2, 3, 4] },
    vane: { supported: true, usable: true, available: true, value: 3, values: [1, 2, 3, 4, 5] },
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
        continuation: clearing ? null : { temperatureC: command.temperatureC, measuredAt: command.measuredAt,
          expiresAt: command.requestedExpiryAt, confirmed: true },
        acknowledged: true, result: { ...command, status: 'acknowledged' } });
    } else {
      native[command.setting] = command.value;
      controls.result = { ...command, status: 'native-confirmed' };
    }
  }
  const tick = (sourceUsable = true, overrides = {}) => controller.tick({ adapter, observation, now, canControl: true, sourceUsable,
    protection: { allowed: true, expiresAt: observation.sourceTime + 120_000 },
    holdProtection: { allowed: true, expiresAt: observation.sourceTime + 120_000 }, ...overrides });
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
  assert.equal(f.sent[2].requestedExpiryAt, f.observation().sourceTime + 120_000);
  assert.equal(f.controller.status(f.observation()).offsetC, 12);
  assert.equal(f.controller.status(f.observation()).acknowledged, true);
});

test('a shorter new thermal allowance clears the longer acknowledged permission immediately', async () => {
  const f = fixture(); await f.start(); const expiry = f.external.continuation.expiresAt;
  f.advance();
  await f.tick(true, { holdProtection: { allowed: true, expiresAt: expiry - 30_000 } });
  assert.equal(f.sent.at(-1).temperatureC, null);
  assert.equal(f.controller.phase, 'clearing');
});

test('a held sensor cannot start a new external permission', async () => {
  const f = fixture(); await f.start(); const count = f.sent.length;
  f.external.continuation = null;
  f.external.phase = 'internal'; f.external.restorationPending = false;
  f.external.temperatureC = null;
  f.advance();
  await f.tick(true, { sourceHeld: true });
  assert.equal(f.sent.length, count);
  assert.equal(f.controller.phase, 'waiting');
});

test('a new out-of-range room measurement cannot hold an older feed through a front outage', async () => {
  const f = fixture(); await f.start();
  f.advance(); f.measure(35);
  await f.tick(true, { sourceHeld: true });
  assert.equal(f.sent.at(-1).temperatureC, null);
  assert.equal(f.controller.phase, 'clearing');
});

test('new original measurements refresh active control, repeated polling cannot extend source expiry', async () => {
  const f = fixture(); await f.start(); const count = f.sent.length;
  f.advance(20_000); await f.tick(); assert.equal(f.sent.length, count);
  f.measure(4.8); await f.tick(); assert.equal(f.sent.length, count + 1);
  assert.equal(f.sent.at(-1).temperatureC, 17, 'round to the driver half-degree input');
  assert.equal(f.sent.at(-1).measuredAt, f.observation().sourceTime);
  f.ack(); f.advance(120_000); await f.tick();
  assert.equal(f.sent.at(-1).temperatureC, null); assert.equal(f.controller.phase, 'clearing');
  f.ack(); await f.tick(); assert.equal(f.controller.phase, 'waiting');
  const cleared = f.sent.length; await f.tick(); assert.equal(f.sent.length, cleared);
  f.advance(); f.measure(5); await f.tick(); assert.equal(f.sent.at(-1).temperatureC, 17);
});

test('invalid, echoed, stale and out-of-range inputs clear rather than clamp or freshen readings', async () => {
  for (const scenario of ['invalid', 'echo', 'stale', 'range']) {
    const f = fixture(); await f.start(); f.advance();
    if (scenario === 'echo') f.observation().source = 'garage-adapter';
    if (scenario === 'stale') f.advance(120_000);
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

test('an automatic effective target changes only the offset and retains the owner setting and source clock', async () => {
  const f = fixture(8); await f.start(); const before = f.sent.length, originalAt = f.observation().sourceTime;
  const until = f.now() + 45_000;
  f.controller.setEffectiveTarget(5, until, f.now());
  await f.tick();
  assert.equal(f.sent.length, before + 1);
  assert.equal(f.sent.at(-1).temperatureC, 17);
  assert.equal(f.sent.at(-1).measuredAt, originalAt);
  assert.equal(f.sent.at(-1).requestedExpiryAt, until);
  assert.equal(f.controller.targetC, 8);
  assert.equal(f.controller.prepared, true);
  assert.equal(f.controller.status(f.observation(), f.now()).acknowledged, false);
  f.ack(); await f.tick();
  assert.equal(f.controller.status(f.observation(), f.now()).effectiveTargetC, 5);
  f.controller.setEffectiveTarget(null, null, f.now()); await f.tick();
  assert.equal(f.sent.at(-1).temperatureC, 14);
  assert.equal(f.sent.at(-1).measuredAt, originalAt);
  assert.ok(f.sent.slice(before).every(command => Number.isFinite(command.temperatureC)));
});

test('expired or invalid automatic target choices cannot replace the owner room target', async () => {
  const f = fixture(8); await f.start();
  for (const target of [-.5, 8, 9, 5.25, '5'])
    assert.throws(() => f.controller.setEffectiveTarget(target, f.now() + 30_000, f.now()), /bounded lower/);
  assert.throws(() => f.controller.setEffectiveTarget(5, f.now(), f.now()), /bounded lower/);
  const until = f.now() + 30_000;
  f.controller.setEffectiveTarget(5, until, f.now());
  f.advance(30_000);
  assert.equal(f.controller.effectiveTarget(f.now()), 8);
  assert.equal(f.controller.status(f.observation(), f.now()).targetSource, 'owner');
  f.controller.select(7, f.now());
  assert.equal(f.controller.automaticTarget, null);
  assert.equal(f.controller.targetC, 7);
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
    assert.equal(f.external.measuredAt + 120_000, expiry, 'the active lease retains its original measurement deadline');
    f.advance(); f.readNative({ power: 'on', mode: 'heat', targetC: 17 }); f.external.available = true; f.measure(4); await f.tick();
    assert.equal(f.sent.length, commands.length + 1, 'a later new measurement can resume with valid native evidence');
    assert.equal(f.sent.at(-1).temperatureC, 16);
    assert.equal(f.sent.at(-1).requestedExpiryAt, f.observation().sourceTime + 120_000);
  });
});

test('native confirmation is checked again before the first numeric sample is admitted', async () => {
  const f = fixture(); await f.tick(); f.ack(); f.advance(); f.measure(); await f.tick(); f.ack();
  f.advance(); f.measure(); f.readNative({ targetC: 16 }); await f.tick();
  assert.equal(f.sent.length, 2);
  assert.equal(f.controller.phase, 'waiting');
  assert.equal(f.controller.acknowledged, false, 'command confirmation alone does not authorize external input');
  f.advance(); f.readNative({ targetC: 17 }); f.measure(); await f.tick();
  assert.equal(f.sent.length, 3); assert.equal(f.sent.at(-1).temperatureC, 17);
});

test('a mismatched baseline cannot extend the original lease even as fresh room measurements arrive', async () => {
  const f = fixture(); await f.start(); const commands = structuredClone(f.sent);
  const expiry = f.sent.at(-1).requestedExpiryAt;
  f.advance(20_000); f.readNative({ targetC: 16 }); f.measure(4); await f.tick();
  f.advance(expiry - f.now()); f.readNative(); f.measure(4); await f.tick();
  assert.deepEqual(f.sent, commands);
  assert.equal(f.external.measuredAt + 120_000, f.now(), 'the driver permission expires on its original deadline');
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

test('a new driver session cannot overwrite a physical native target selected since external setup', async () => {
  const f = fixture(); await f.start(); f.advance();
  f.external.sourceEpoch = 'invented-replacement-session'; f.readNative({ targetC: 20 });
  await f.tick(); assert.equal(f.sent.at(-1).temperatureC, null);
  f.ack(); f.advance(); await f.tick();
  const count = f.sent.length;
  f.advance(); f.measure(); await f.tick();
  assert.equal(f.sent.length, count); assert.equal(f.native.targetC, 20);
  assert.equal(f.controller.targetC, 5); assert.equal(f.controller.phase, 'waiting');
  assert.match(f.controller.reason, /room setting changed/i);
  f.controller.select(7, f.now()); await f.tick(); f.ack(); f.advance(); await f.tick();
  assert.equal(f.sent.at(-1).setting, 'targetC'); assert.equal(f.sent.at(-1).value, 17,
    'An explicit new low room choice can deliberately establish external control');
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

test('runtime persists device-bound room settings across restart and explicit native-range replacements', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const f = fixture(null), engine = { latest: {}, automationEnabled: () => false };
  const options = { engine, store, config: { input: 'mqtt', garage: { enabled: false } }, clock: f.now };
  const runtime = new GarageRuntime(options); runtime.setAdapter(f.adapter);
  t.after(() => runtime.close({ restore: false }));
  await runtime.setNativeSettings({ setting: 'targetC', value: 5 });
  await runtime.roomDispatch;
  assert.deepEqual(store.getState(runtime.keys.roomTemperature), { targetC: 5, adapterKey: runtime.roomAdapterKey });
  assert.equal(runtime.nativeControls().settings.targetC.value, 5);
  assert.equal(runtime.nativeControls().settings.targetC.min, 5);
  const restarted = new GarageRuntime(options); t.after(() => restarted.close({ restore: false }));
  assert.equal(restarted.roomTemperature.targetC, 5); assert.equal(restarted.roomTemperature.prepared, false);
  assert.equal(restarted.roomTemperature.lastMeasuredAt, undefined);
  f.ack(); await runtime.roomTemperatureTick();
  await runtime.setNativeSettings({ setting: 'targetC', value: 18 });
  await runtime.roomDispatch;
  assert.equal(store.getState(runtime.keys.roomTemperature).targetC, 18);
  assert.equal(runtime.roomTemperature.targetC, null);
  assert.equal(runtime.status().learning.normalReference.rearC, 18);
  assert.equal(runtime.status().learning.normalReference.frontC, 18);
  const nativeRestart = new GarageRuntime(options); t.after(() => nativeRestart.close({ restore: false }));
  assert.equal(nativeRestart.roomTemperature.targetC, null, 'Native-range intent does not restart external sensing');
  assert.equal(nativeRestart.status().learning.normalReference.rearC, 18);
  assert.equal(nativeRestart.status().learning.normalReference.frontC, 18);
});

test('room settings remain unchanged after two hours, the next day and restart', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const f = fixture(null), options = { store, engine: { latest: {}, automationEnabled: () => false },
    config: { input: 'mqtt', garage: {} }, clock: f.now };
  const runtime = new GarageRuntime(options); runtime.setAdapter(f.adapter);
  t.after(() => runtime.close({ restore: false }));
  await runtime.setNativeSettings({ setting: 'targetC', value: 7 }); await runtime.roomDispatch;
  for (const elapsed of [2 * 3_600_000, 24 * 3_600_000]) {
    f.advance(elapsed); runtime.expireControls(f.now());
    assert.equal(runtime.roomTemperature.targetC, 7);
    assert.equal(runtime.status().learning.normalReference.rearC, 7);
    assert.deepEqual(store.getState(runtime.keys.roomTemperature), { targetC: 7, adapterKey: runtime.roomAdapterKey });
    assert.equal(Object.hasOwn(runtime.roomTemperatureStatus(), 'overrideUntil'), false);
  }
  const restarted = new GarageRuntime(options); t.after(() => restarted.close({ restore: false }));
  assert.equal(restarted.roomTemperature.targetC, 7);
  assert.equal(restarted.status().learning.normalReference.rearC, 7);
  assert.equal(restarted.roomTemperature.prepared, false, 'Persistent intent grants no cached native permission');
});

test('fan and vane handovers retain the room target and await confirmation before rearming', async t => {
  for (const request of [{ setting: 'fan', value: 3 }, { setting: 'vane', value: 2 }]) await t.test(request.setting, async () => {
    const f = fixture(7); await f.start();
    f.controller.handover(request, f.now()); await f.tick();
    assert.equal(f.controller.targetC, 7);
    assert.equal(f.sent.at(-1).temperatureC, null);
    f.ack(); f.advance(); await f.tick();
    assert.equal(f.sent.at(-1).setting, request.setting);
    const count = f.sent.length; await f.tick(); assert.equal(f.sent.length, count);
    f.ack(); f.advance(); await f.tick();
    assert.deepEqual(f.sent.at(-1), { setting: 'targetC', value: 17, requestedAt: f.now() });
    f.ack(); f.advance(); f.measure(6); await f.tick();
    assert.equal(f.sent.at(-1).temperatureC, 16);
    assert.equal(f.native[request.setting], request.value);
    assert.equal(f.controller.targetC, 7);
  });
});

test('power OFF and cooling retain room intent without forcing ON or HEAT, then resume with compatible evidence', async t => {
  for (const request of [{ setting: 'power', value: 'off' }, { setting: 'mode', value: 'cool' }]) await t.test(request.setting, async () => {
    const f = fixture(7); await f.start(); f.controller.handover(request, f.now());
    await f.tick(); f.ack(); f.advance(); await f.tick(); f.ack(); f.advance(); await f.tick();
    const commands = structuredClone(f.sent);
    for (let i = 0; i < 3; i++) { f.advance(120_000); f.measure(); await f.tick(); }
    assert.deepEqual(f.sent, commands);
    assert.equal(f.controller.targetC, 7); assert.equal(f.controller.phase, 'waiting');
    f.readNative({ power: 'on', mode: 'heat' }); f.advance(); f.measure(); await f.tick();
    assert.equal(f.sent.at(-1).setting, 'targetC'); assert.equal(f.sent.at(-1).value, 17);
    f.ack(); f.advance(); f.measure(); await f.tick();
    assert.equal(f.sent.at(-1).temperatureC, 15);
    assert.equal(f.sent.some(command => command.setting === 'power' && command.value === 'on'
      || command.setting === 'mode' && command.value === 'heat'), false);
  });
});

test('a changed adapter starts without applying old room intent or changing its historical record', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const f = fixture(null), options = { store, engine: { latest: {}, automationEnabled: () => false },
    config: { input: 'mqtt', garage: {} }, clock: f.now };
  const runtime = new GarageRuntime(options); runtime.setAdapter(f.adapter);
  t.after(() => runtime.close({ restore: false }));
  await runtime.setNativeSettings({ setting: 'targetC', value: 7 }); await runtime.roomDispatch;
  await runtime.close({ restore: false });
  const before = store.getState(runtime.keys.roomTemperature);
  const history = store.learningJournal({ input: 'garage:mqtt' });
  const restarted = new GarageRuntime({ ...options,
    config: { input: 'mqtt', garage: { adapter: { driver: 'shelly-cn105',
      stateTopic: 'invented/replacement/state', commandTopic: 'invented/replacement/command' } } } });
  t.after(() => restarted.close({ restore: false }));
  restarted.setAdapter(f.adapter);
  const commands = f.sent.length;
  await restarted.roomTemperatureTick();
  assert.equal(f.sent.length, commands, 'The replacement must not receive the old room target');
  assert.equal(restarted.roomTemperature.targetC, null);
  assert.equal(restarted.selectedRoomTargetC, null);
  assert.equal(restarted.read().roomTargetC, null, 'The old learning reference is not live intent');
  assert.equal(restarted.status().learning.normalReference.roomTargetC, null);
  assert.deepEqual(store.getState(runtime.keys.roomTemperature), before);
  assert.deepEqual(store.learningJournal({ input: 'garage:mqtt' }).slice(0, history.length), history);
  assert.deepEqual(replayGarageJournal(store, 'mqtt'), restarted.checkpoint,
    'The association boundary must be exactly reconstructable');
});

test('MQTT route changes start with inactive saved intent, while password rotation preserves the equipment binding', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const f = fixture(null), options = { store, engine: { latest: {}, automationEnabled: () => false },
    config: { input: 'mqtt', garage: {}, connections: { mqtt: { address: 'mqtt://invented-first', user: 'invented-owner' } } }, clock: f.now };
  const runtime = new GarageRuntime(options); runtime.setAdapter(f.adapter);
  t.after(() => runtime.close({ restore: false }));
  await runtime.setNativeSettings({ setting: 'targetC', value: 7 }); await runtime.roomDispatch;
  await runtime.close({ restore: false });
  const before = store.getState(runtime.keys.roomTemperature);
  for (const mqtt of [{ address: 'mqtt://invented-other', user: 'invented-owner' },
    { address: 'mqtt://invented-first', user: 'invented-other' }]) {
    const restarted = new GarageRuntime({ ...options, config: { ...options.config, connections: { mqtt } } });
    assert.equal(restarted.roomTemperature.targetC, null);
    assert.equal(restarted.read().roomTargetC, null);
    assert.equal(restarted.status().learning.normalReference.roomTargetC, null);
    assert.deepEqual(store.getState(runtime.keys.roomTemperature), before);
    await restarted.close({ restore: false });
  }
  const restarted = new GarageRuntime({ ...options, config: { ...options.config,
    connections: { mqtt: { ...options.config.connections.mqtt, pw: 'synthetic-password-rotation' } } } });
  t.after(() => restarted.close({ restore: false }));
  assert.equal(restarted.roomTemperature.targetC, 7);
});

test('paired providers can change to the local broker without replaying low or native-range intent', async t => {
  for (const targetC of [7, 18]) await t.test(`${targetC} C`, async t => {
    const store = new Store(':memory:'); t.after(() => store.close());
    const f = fixture(null), options = { store, engine: { latest: {}, automationEnabled: () => false },
      config: { input: 'providers', garage: {}, topology: 'pair', pair: {},
        connections: { mqtt: { address: 'mqtt://invented-shared-broker', user: 'invented-owner' } } }, clock: f.now };
    const runtime = new GarageRuntime(options); runtime.setAdapter(f.adapter);
    runtime.saveRoomTarget(targetC, f.now());
    await runtime.close({ restore: false });
    const recorded = store.getState(runtime.keys.roomTemperature);
    const config = { ...options.config, connections: { mqtt: { address: 'mqtt://127.0.0.1', user: 'invented-owner' } } };
    const restarted = new GarageRuntime({ ...options, config });
    t.after(() => restarted.close({ restore: false }));
    restarted.setAdapter(f.adapter);
    await restarted.roomTemperatureTick();
    assert.deepEqual(f.sent, [], 'Bootstrap must issue no saved device choice over the new route');
    assert.equal(restarted.selectedRoomTargetC, null);
    assert.equal(restarted.roomTemperature.targetC, null);
    assert.equal(restarted.read().roomTargetC, null);
    assert.equal(restarted.status().learning.normalReference.roomTargetC, null);
    assert.deepEqual(store.getState(runtime.keys.roomTemperature), recorded);
    const journalLength = store.learningJournal({ input: 'garage:providers' }).length;
    const again = new GarageRuntime({ ...options, config });
    t.after(() => again.close({ restore: false }));
    assert.equal(again.read().roomTargetC, null);
    assert.equal(store.learningJournal({ input: 'garage:providers' }).length, journalLength,
      'An already unknown reference needs no duplicate boundary on another restart');
    f.adapter.status = () => ({ connected: true, health: { pumpCommunicating: true, deviceOnline: true },
      native: { targetC: 21, readbacks: { targetC: { measuredAt: f.now(), supported: true, usable: true } } } });
    restarted.syncRoomReference(f.now());
    assert.equal(restarted.read().roomTargetC, 21, 'Only fresh native evidence establishes the new reference');
    assert.equal(restarted.status().learning.normalReference.roomTargetC, 21);
    assert.equal(restarted.roomTemperature.targetC, null);
    assert.deepEqual(store.getState(runtime.keys.roomTemperature), recorded);
    assert.deepEqual(replayGarageJournal(store, 'providers'), restarted.checkpoint);
  });
});

test('retired timed overrides, unbound settings and room configuration fail before database mutation', t => {
  for (const saved of [{ targetC: 7 }, { targetC: 7, adapterKey: 'invented-key' },
    { targetC: 7, adapterKey: 42 }, { targetC: 4, adapterKey: 'a'.repeat(64) },
    { targetC: 7, adapterKey: 'a'.repeat(64), extra: true }, { targetC: 7, createdAt: BASE, expiresAt: BASE + 7_200_000,
    restoreTargetC: 17, adapterKey: 'invented-key' }]) {
    const store = new Store(':memory:'); t.after(() => store.close());
    store.setState('garage:roomTemperature:mqtt', saved);
    const original = store.setState; store.setState = () => { throw new Error('unexpected mutation'); };
    assert.throws(() => new GarageRuntime({ store, engine: { latest: {}, automationEnabled: () => false },
      config: { input: 'mqtt', garage: {} }, clock: () => BASE }), /Unsupported saved Garage room setting/);
    store.setState = original;
  }
  for (const roomTargetC of [null, 7, 7.5, 10, 20]) assert.throws(() => garageSettings({ roomTargetC }), /Unknown garage setting: roomTargetC/);
});

test('runtime rejects stale preference API, unsupported low target, replicas and failed persistence', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const f = fixture(null), engine = { latest: {}, automationEnabled: () => false };
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
