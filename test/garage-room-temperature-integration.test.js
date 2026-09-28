import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGarageAdapter } from '../src/garage/adapter.js';
import { createShellyCn105Transport } from '../src/garage/shelly-cn105.js';
import { SHELLY_CN105_CONTRACT } from '../src/garage/contract.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { Store } from '../src/storage/store.js';
import { mitsubishiControl } from '../chart/mitsubishi.js';
import { knownGarageReserve } from './helpers/garage-reserve-fixture.js';

const TEMPLATE = JSON.parse(readFileSync(new URL('./fixtures/garage-pill-state.json', import.meta.url)));
const BASE = TEMPLATE.observedAt;
const SETTINGS = { driver: 'shelly-cn105', stateTopic: 'invented/room/state',
  telemetryTopic: 'invented/room/telemetry', commandTopic: 'invented/room/command' };
const INTERNAL = { enabled: true, phase: 'internal', temperatureC: null, measuredAt: null, expiresInMs: 0,
  refreshMs: 10_000, maxSourceAgeMs: 180_000, acknowledged: false, restorationPending: false, rearmRequired: false, reason: null };

/** Real runtime, adapter, envelope transport and persistence; only the broker,
 * physical driver's reports and independent room sensor are synthetic. */
function fixture(t, { initialNativeTargetC = 17 } = {}) {
  let now = BASE, sequence = 0, external = { ...INTERNAL }, result = null, manualPending = false;
  const native = { power: 'on', mode: 'heat', targetC: initialNativeTargetC, fan: 'auto', vane: 3, wideVane: 'center', vanes: 'fixed' };
  const published = [], observations = [], store = new Store(':memory:');
  const engine = { latest: {}, lastKnownTemperatures: {}, settings: { mode: 'shadow' } };
  const runtime = new GarageRuntime({ store, engine,
    config: { input: 'mqtt', garage: { enabled: false, adapter: SETTINGS } }, clock: () => now });
  const adapter = createGarageAdapter({ settings: SETTINGS, hostSession: 'invented-room-owner', clock: () => now,
    onObservation: row => observations.push(row),
    onDiagnostic: (row, at) => store.event('garage-external-temperature-diagnostic', row, at),
    onState: snapshot => runtime.adapterChanged(snapshot),
    productionTransport: createShellyCn105Transport({ settings: SETTINGS, publish: async (topic, payload, options) => {
      published.push({ topic, command: JSON.parse(payload), options });
    } }) });
  runtime.setAdapter(adapter); adapter.setConnected(true);
  function state({ nativeAt = now, nativeTimes = {}, baseline = TEMPLATE.baseline,
    feed = external,
    ownerSession = published.length ? 'invented-room-owner' : null } = {}) {
    const value = { ...structuredClone(TEMPLATE), sequence: ++sequence, observedAt: now, mode: 'monitoring',
      baseline: structuredClone(baseline),
      authority: { ownerSession, controlAllowed: false,
        manualControlAllowed: external.phase === 'internal' && !manualPending },
      challenge: { value: `invented-room-challenge-${sequence}`, expiresAt: now + 30_000 },
      native: Object.fromEntries(Object.entries(native).map(([key, value]) => [key, { value, measuredAt: nativeTimes[key] ?? nativeAt, ageMs: now - (nativeTimes[key] ?? nativeAt) }])),
      externalTemperature: { ...feed, expiresInMs: feed.temperatureC === null ? 0
        : Math.max(0, feed.expiresAt - now) }, result, manualPending,
      capabilities: { ...TEMPLATE.capabilities, externalTemperature: true, targetStep: 1,
        manualControls: Object.fromEntries(['power', 'mode', 'targetC', 'fan', 'vane', 'wideVane'].map(key => [key, true])) } };
    for (const field of Object.values(value.health)) { field.measuredAt = now; field.ageMs = 0; }
    assert.equal(adapter.receive(SETTINGS.stateTopic, JSON.stringify(value), {}, now), true);
  }
  function measure(value = 5) {
    engine.latest.garage_temperature_2 = { signal: 'garage_temperature_2', source: 'mqtt-equipment', device: 'invented-room-front',
      value: 5, unit: 'degC', sourceTime: now, receivedAt: now, quality: ['good'], raw: {} };
    engine.latest.outdoor_temperature = { signal: 'outdoor_temperature', source: 'fmi', device: 'invented-outdoor',
      value: 5, sourceTime: now, receivedAt: now, quality: ['good'], raw: {} };
    engine.latest.garage_temperature = { signal: 'garage_temperature', source: 'mqtt-equipment', device: 'invented-room-rear',
      value, unit: 'degC', sourceTime: now, receivedAt: now, quality: ['good'], raw: {} };
  }
  function report(status) {
    const command = published.at(-1).command;
    result = { action: command.action, ownerSession: command.ownerSession, commandId: command.commandId,
      sequence: command.sequence, status, reason: null };
    if (command.action === 'manual') {
      manualPending = status === 'accepted';
      if (status === 'native-confirmed') Object.assign(native, command.settings);
    } else {
      assert.equal(command.action, 'remote-temperature');
      manualPending = false;
      external = command.temperatureC === null
        ? { ...INTERNAL, acknowledged: status === 'acknowledged',
          ...(status === 'acknowledged' ? {} : { phase: 'clearing', restorationPending: true }) }
        : { ...INTERNAL, phase: status === 'acknowledged' ? 'active' : 'arming', restorationPending: true,
          temperatureC: command.temperatureC, measuredAt: command.measuredAt,
          expiresAt: command.requestedExpiryAt,
          expiresInMs: Math.max(0, command.requestedExpiryAt - now), acknowledged: status === 'acknowledged' };
    }
    state();
  }
  function rejectBusy() {
    const command = published.at(-1).command;
    assert.equal(command.action, 'remote-temperature');
    assert.notEqual(command.temperatureC, null);
    result = { action: command.action, ownerSession: command.ownerSession, commandId: command.commandId,
      sequence: command.sequence, status: 'rejected', reason: 'busy' };
    // The driver rejected this renewal before changing the acknowledged feed.
    state();
  }
  async function settle() {
    // Incoming state schedules safety work; publication schedules another state
    // checkpoint. Drain both without advancing the original sensor timestamp.
    for (let turn = 0; turn < 6; turn++) {
      await Promise.resolve();
      await runtime.roomDispatch;
    }
    await runtime.roomTemperatureTick();
  }
  async function advanceReport(status) { now += 1000; report(status); await settle(); }
  async function start() {
    await settle();
    assert.equal(runtime.nativeControls().settings.targetC.min, 5);
    await runtime.setNativeSettings({ setting: 'targetC', value: 5 }); await settle();
    assert.equal(published.length, 1);
    assert.equal(published[0].command.action, 'remote-temperature');
    assert.equal(published[0].command.temperatureC, null);
    await advanceReport('accepted');
    assert.equal(published.length, 1, 'acceptance cannot complete the internal-sensor handover');
    await advanceReport('acknowledged');
    assert.equal(published.length, 2);
    assert.equal(published[1].command.action, 'manual');
    assert.deepEqual(published[1].command.settings, { targetC: 17 }, 'even existing native17 requires an explicit confirmed selection');
    await advanceReport('accepted');
    assert.equal(published.length, 2, 'native acceptance cannot authorize an external temperature');
    await advanceReport('native-confirmed');
    assert.equal(published.length, 2, 'the pre-clear sensor observation cannot start a new permission');
    now += 1000; measure(5); state(); await settle();
    assert.equal(published.length, 3);
    assert.equal(published[2].command.action, 'remote-temperature');
    assert.equal(published[2].command.temperatureC, 17);
    await advanceReport('accepted');
    assert.equal(runtime.status().roomTemperature.acknowledged, false);
    await advanceReport('acknowledged');
    assert.equal(runtime.status().roomTemperature.phase, 'active');
    assert.equal(runtime.status().roomTemperature.acknowledged, true);
  }
  runtime.exposure = knownGarageReserve(runtime.settings, { at: now, rearC: 7, frontC: 7 });
  measure(); state();
  t.after(async () => { await runtime.close({ restore: false }); await adapter.close({ restore: false }); store.close(); });
  return { runtime, adapter, engine, store, native, published, observations, state, report, rejectBusy, measure, settle, advanceReport, start,
    now: () => now, advance(ms = 1000) { now += ms; } };
}

function assertInitialWarmth(runtime, targetC) {
  const reference = runtime.status().learning.normalReference;
  assert.equal(reference.roomTargetC, targetC, 'The model identifies the selected room setting');
  assert.equal(reference.rearC, targetC, 'Initial rear warmth follows the room setting');
  assert.equal(reference.frontC, targetC, 'Initial front warmth follows the room setting');
  assert.equal(reference.initialized, false, 'A chosen setting is not learned temperature evidence');
  assert.equal(reference.samples, 0);
  assert.equal(runtime.read().roomTargetC, targetC, 'Live learning records the same room setting');
}

function loseSensor(f, signal = 'garage_temperature', reason = 'device-offline') {
  f.engine.latest[signal] = { ...f.engine.latest[signal], value: null,
    sourceTime: f.now(), receivedAt: f.now(), quality: ['missing', reason],
    raw: { timeBasis: 'availability-transition', usableForControl: false } };
}

test('transport-only sensor loss holds the acknowledged feed to its original deadline without filling history', async t => {
  for (const signal of ['garage_temperature', 'garage_temperature_2']) await t.test(signal, async t => {
    const f = fixture(t); await f.start();
    const commands = structuredClone(f.published), permission = commands.at(-1).command;
    f.advance(10_000); loseSensor(f, signal); f.state(); await f.settle();
    assert.deepEqual(f.published, commands);
    assert.equal(f.runtime.status().roomTemperature.phase, 'holding');
    assert.equal(f.runtime.status().roomTemperature.acknowledged, false);
    assert.equal(f.engine.latest[signal].value, null, 'control holding must preserve the unavailable observation');
    assert.equal(f.runtime.read()[signal === 'garage_temperature' ? 'rearC' : 'frontC'], null,
      'learning and freeze history continue to see the real acquisition gap');
    f.advance(permission.requestedExpiryAt - f.now() - 1); f.state(); await f.settle();
    assert.deepEqual(f.published, commands);
    assert.equal(f.runtime.status().roomTemperature.phase, 'holding');
    f.advance(1); f.state(); await f.settle();
    assert.equal(f.published.length, commands.length + 1);
    assert.equal(f.published.at(-1).command.temperatureC, null);
    assert.equal(f.runtime.status().roomTemperature.targetC, 5);
  });
});

test('a front sensor outage prevents renewal even when newer rear readings arrive', async t => {
  const f = fixture(t); await f.start(); const commands = structuredClone(f.published);
  f.advance(10_000); loseSensor(f, 'garage_temperature_2');
  const missing = f.engine.latest.garage_temperature_2;
  f.measure(4); f.engine.latest.garage_temperature_2 = missing; f.state(); await f.settle();
  assert.deepEqual(f.published, commands);
  assert.equal(f.runtime.status().roomTemperature.phase, 'holding');
  assert.equal(f.runtime.status().roomTemperature.suppliedC, 17, 'a hold keeps the acknowledged value');
});

test('a real sensor fault during a transport hold clears immediately', async t => {
  const f = fixture(t); await f.start();
  f.advance(); loseSensor(f); f.state(); await f.settle();
  assert.equal(f.runtime.status().roomTemperature.phase, 'holding');
  f.advance(); loseSensor(f, 'garage_temperature', 'sensor-unavailable'); f.state(); await f.settle();
  assert.equal(f.published.at(-1).command.temperatureC, null);
  assert.equal(f.runtime.status().roomTemperature.phase, 'clearing');
});

test('host MQTT loss waits for fresh Pill evidence and never renews a held permission', async t => {
  for (const survives of [true, false]) await t.test(survives ? 'driver retains feed' : 'driver clears feed', async t => {
    const f = fixture(t); await f.start(); const commands = structuredClone(f.published);
    f.advance(10_000); f.adapter.setConnected(false); loseSensor(f); loseSensor(f, 'garage_temperature_2');
    await f.settle();
    assert.deepEqual(f.published, commands);
    assert.equal(f.runtime.status().roomTemperature.phase, 'holding');
    assert.equal(f.adapter.externalTemperature().continuation.confirmed, false);
    f.advance(); f.adapter.setConnected(true); await f.settle();
    assert.deepEqual(f.published, commands, 'reconnecting alone grants no new authority');
    f.state(survives ? {} : { feed: { ...INTERNAL, acknowledged: true } }); await f.settle();
    assert.deepEqual(f.published, commands, 'cached sensor evidence cannot restart or renew the feed');
    assert.equal(f.runtime.status().roomTemperature.phase, survives ? 'holding' : 'waiting');
    assert.equal(Boolean(f.adapter.externalTemperature().continuation), survives);
  });
});

test('freeze reserve and useful-heating delay guard explicit room targets even with economic control disabled', async t => {
  for (const scenario of ['unknown reserve', 'exhausted front reserve']) await t.test(scenario, async t => {
    const f = fixture(t); await f.start();
    assert.equal(f.runtime.settings.enabled, false);
    assert.equal(f.runtime.settings.protection.approved, false);
    f.advance();
    if (scenario === 'unknown reserve') f.runtime.exposure.locations.front.uncertain = true;
    else {
      f.runtime.exposure.locations.front.energyJPerM = 0;
      f.runtime.exposure.locations.front.estimatedC = 0;
    }
    await f.settle();
    assert.equal(f.published.at(-1).command.temperatureC, null);
    assert.equal(f.runtime.status().roomTemperature.targetC, 5);
  });
});

test('front sensor replacement clears the old permission even when replacement readings are warm and fresh', async t => {
  const f = fixture(t); await f.start();
  f.advance(); f.measure(); f.engine.latest.garage_temperature_2.device = 'invented-replacement-front';
  f.state(); await f.settle();
  assert.equal(f.published.at(-1).command.temperatureC, null);
  assert.equal(f.runtime.status().roomTemperature.acknowledged, false);
});

test('recurring protection-assessment failure still attempts explicit cleanup', async t => {
  const f = fixture(t); await f.start(); const count = f.published.length;
  f.runtime.roomTemperatureProtection = () => { throw new Error('invented assessment failure'); };
  f.advance(); await f.settle();
  assert.equal(f.published.length, count + 1);
  assert.equal(f.published.at(-1).command.temperatureC, null);
  await f.settle();
  assert.equal(f.published.length, count + 1, 'pending cleanup must not flood commands');
  assert.equal(f.runtime.status().roomTemperature.acknowledged, false);
});

function appendRoomSample(f, { rearC, frontC, available = true }) {
  const at = f.now();
  f.runtime.append('sample', { ...f.runtime.read(), at, rearC, frontC,
    rearAt: at, frontAt: at, rearUsable: true, frontUsable: true, outdoorC: 0, available, baselineAccepted: true,
    doorFront: false, doorRear: false, ev1Kw: 0, ev2Kw: 0, recovering: false,
    powerKw: available ? .3 : 0, powerQuality: 'provisional' }, `room-reference:${at}`, at);
}

async function learnNormalWarmth(f, rearC, frontC) {
  for (let i = 0; i <= 64; i++) {
    if (i) f.advance(15 * 60_000);
    f.measure(rearC); f.state(); await f.settle();
    appendRoomSample(f, { rearC, frontC });
  }
}

test('initial model warmth follows the UI room setting instead of the native17 external-sensor mapping', async t => {
  const f = fixture(t); await f.start();
  assert.equal(f.runtime.status().adapter.native.targetC, 17);
  assertInitialWarmth(f.runtime, 5);
  await f.runtime.setNativeSettings({ setting: 'targetC', value: 7 }); await f.settle();
  assertInitialWarmth(f.runtime, 7);
  assert.equal(f.runtime.status().adapter.native.targetC, 17, 'The mapping target is not the chosen room temperature');
  assert.equal(f.store.getState(f.runtime.keys.roomTemperature).targetC, 7);
});

test('fresh native room settings seed initial warmth when no UI room setting has been saved', async t => {
  const f = fixture(t); await f.settle();
  f.advance(); f.native.targetC = 20; f.state(); await f.settle();
  assertInitialWarmth(f.runtime, 20);
  assert.equal(f.published.length, 0, 'Reading the current setting must not change the pump');
});

test('missing, stale or invalid native room settings cannot manufacture an initial normal warmth estimate', async t => {
  for (const scenario of ['missing', 'stale', 'unsupported fractional target', 'external sensor without saved room intent']) {
    await t.test(scenario, async t => {
      const f = fixture(t, { initialNativeTargetC: scenario === 'external sensor without saved room intent' ? 17 : null });
      await f.settle();
      if (scenario === 'external sensor without saved room intent') {
        await f.start();
        const next = new GarageRuntime({ store: new Store(':memory:'), engine: f.engine,
          config: { input: 'mqtt', garage: { enabled: false, adapter: SETTINGS } }, clock: f.now });
        next.setAdapter(f.adapter);
        t.after(async () => { await next.close({ restore: false }); next.store.close(); });
        assertInitialWarmth(next, null);
        return;
      }
      if (scenario === 'stale') f.native.targetC = 17;
      if (scenario === 'unsupported fractional target') f.native.targetC = 20.25;
      f.state(scenario === 'stale' ? { nativeAt: f.now() - 120_001 } : {});
      await f.settle();
      assertInitialWarmth(f.runtime, null);
    });
  }
});

test('ordinary UI room selections seed and persist normal warmth before native confirmation and across restart', async t => {
  const f = fixture(t); await f.settle();
  await f.runtime.setNativeSettings({ setting: 'targetC', value: 20 }); await f.settle();
  assert.equal(f.native.targetC, 17, 'The physical pump has not acknowledged the new setting yet');
  assertInitialWarmth(f.runtime, 20);
  assert.equal(f.store.getState(f.runtime.keys.roomTemperature).targetC, 20);
  await f.advanceReport('native-confirmed');
  assertInitialWarmth(f.runtime, 20);
  await f.runtime.close({ restore: false });
  const restarted = new GarageRuntime({ store: f.store, engine: f.engine,
    config: { input: 'mqtt', garage: { enabled: false, adapter: SETTINGS } }, clock: f.now });
  t.after(() => restarted.close({ restore: false }));
  assert.equal(restarted.roomTemperature.targetC, null, 'Ordinary settings must not start external-sensor control');
  assertInitialWarmth(restarted, 20);
});

test('ambiguous native16 remains unknown until an explicit room selection resolves it', async t => {
  const f = fixture(t, { initialNativeTargetC: 16 }); await f.settle();
  assertInitialWarmth(f.runtime, null);
  await f.runtime.setNativeSettings({ setting: 'targetC', value: 16 }); await f.settle();
  assertInitialWarmth(f.runtime, 16);
  await f.advanceReport('native-confirmed');
  assertInitialWarmth(f.runtime, 16);
  assert.equal(f.store.getState(f.runtime.keys.roomTemperature).targetC, 16);
});

test('a device-verified low-heat profile resolves native16 to its actual room target', async t => {
  const f = fixture(t, { initialNativeTargetC: 16 }); await f.settle();
  f.advance();
  f.state({ baseline: { ...TEMPLATE.baseline, verified: true, targetC: 10, measuredAt: f.now() } });
  await f.settle();
  assertInitialWarmth(f.runtime, 10);
  assert.equal(f.runtime.status().adapter.native.targetC, 16);
  assert.equal(f.published.length, 0, 'Verified evidence must not issue thermostat commands');
});

test('reapplying the same room target preserves achieved warmth and changing the target replaces it', async t => {
  const f = fixture(t, { initialNativeTargetC: 20 }); await f.settle();
  await learnNormalWarmth(f, 19.2, 18.8);
  const learned = f.runtime.status().learning.normalReference;
  assert.equal(learned.initialized, true);
  assert.ok(Math.abs(learned.rearC - 19.2) < .01);
  assert.ok(Math.abs(learned.frontC - 18.8) < .01);
  await f.runtime.setNativeSettings({ setting: 'targetC', value: 20 }); await f.settle();
  assert.deepEqual(f.runtime.status().learning.normalReference, learned,
    'Reapplying the same desired temperature preserves learned warmth');
  await f.advanceReport('native-confirmed');
  assert.deepEqual(f.runtime.status().learning.normalReference, learned);
  await f.runtime.setNativeSettings({ setting: 'targetC', value: 7 }); await f.settle();
  assertInitialWarmth(f.runtime, 7);
});

test('stale and offline native readbacks retain the latest observed target and its learning after a physical setting change', async t => {
  const f = fixture(t); await f.settle();
  await f.runtime.setNativeSettings({ setting: 'targetC', value: 20 }); await f.settle();
  await f.advanceReport('native-confirmed');
  f.advance(); f.native.targetC = 22; f.state(); await f.settle();
  assertInitialWarmth(f.runtime, 22);
  assert.equal(f.store.getState(f.runtime.keys.roomTemperature).targetC, 20,
    'The saved command does not override newer observed physical settings');
  await learnNormalWarmth(f, 21.2, 20.8);
  for (let i = 0; i < 2; i++) {
    f.advance(15 * 60_000); f.measure(21 - i * .2); f.state(); await f.settle();
    appendRoomSample(f, { rearC: 21 - i * .2, frontC: 20.6 - i * .2, available: false });
  }
  const retained = structuredClone(f.runtime.checkpoint.model);
  assert.equal(retained.normalReference.roomTargetC, 22);
  assert.equal(retained.normalReference.initialized, true);
  assert.ok(retained.native.hours > 0, 'The fixture has learned normal electricity evidence');
  assert.ok(retained.validation.active, 'The fixture has an observed pause under validation');
  const commands = structuredClone(f.published);
  f.advance(); f.state({ nativeAt: f.now() - 120_001 }); await f.settle();
  assert.equal(f.runtime.read().roomTargetC, 22, 'Stale readback cannot revive the older saved UI choice');
  assert.deepEqual(f.runtime.checkpoint.model, retained, 'Staleness must preserve normal warmth, electricity and cycle evidence');
  f.adapter.setConnected(false); await f.settle();
  assert.equal(f.runtime.read().roomTargetC, 22);
  assert.deepEqual(f.runtime.checkpoint.model, retained, 'Disconnection cannot reset evidence to an obsolete target');
  assert.deepEqual(f.published, commands);
  await f.runtime.close({ restore: false });
  const restarted = new GarageRuntime({ store: f.store, engine: f.engine,
    config: { input: 'mqtt', garage: { enabled: false, savingsStrategy: 'gentle', adapter: SETTINGS } }, clock: f.now });
  t.after(() => restarted.close({ restore: false }));
  assert.equal(restarted.read().roomTargetC, 22);
  assert.deepEqual(restarted.checkpoint.model, retained,
    'A savings-strategy change on restart cannot restore an obsolete room target or reset its learning');
});

test('foreign ownership disables every setting including a saved low room target', async t => {
  const f = fixture(t); await f.start();
  await f.runtime.setNativeSettings({ setting: 'targetC', value: 7 }); await f.settle();
  f.advance(); f.state({ ownerSession: 'invented-previous-controller' }); await f.settle();
  const status = { garage: f.runtime.status() }, count = f.published.length;
  assert.equal(status.garage.roomTemperature.targetC, 7, 'Saved preference survives loss of device authority');
  assert.equal(status.garage.roomTemperature.phase, 'clearing');
  assert.equal(status.garage.nativeControls.available, false);
  for (const setting of ['power', 'mode', 'targetC', 'fan', 'vane', 'wideVane']) {
    assert.equal(status.garage.nativeControls.settings[setting].available, false, setting);
    assert.equal(mitsubishiControl(status, setting).available, false, setting);
    assert.equal(mitsubishiControl(status, setting).reason, 'Another controller owns the heat pump.');
  }
  // Without external-control permission, low targets are outside the advertised
  // native range; ordinary targets and mode changes fail the ownership gate.
  await assert.rejects(f.runtime.setNativeSettings({ setting: 'targetC', value: 8 }), /outside its supported values/);
  for (const request of [{ setting: 'targetC', value: 18 }, { setting: 'mode', value: 'cool' }])
    await assert.rejects(f.runtime.setNativeSettings(request), /Another controller owns/);
  assert.equal(f.published.length, count, 'No command bypasses the foreign owner');
  assert.equal(f.store.getState(f.runtime.keys.roomTemperature).targetC, 7);
});

test('external temperature control retains fault history without numeric feed samples', async t => {
  const f = fixture(t); await f.start();
  assert.equal(f.observations.filter(row => row.signal === 'garage_external_temperature').length, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM events WHERE type='garage-external-temperature-diagnostic'").get().n, 0);
  f.advance(); f.state();
  f.adapter.setConnected(false);
  const event = f.store.db.prepare("SELECT * FROM events WHERE type='garage-external-temperature-diagnostic'").get();
  assert(event);
  assert.equal(f.observations.length, 0);
});

test('real runtime and Pill adapter select5 through clearACK, forced native17 confirmation and room+12', async t => {
  const f = fixture(t); await f.start();
  assert.deepEqual(f.store.getState(f.runtime.keys.roomTemperature), { targetC: 5, adapterKey: f.runtime.roomAdapterKey });
  assert.equal(f.runtime.nativeControls().settings.targetC.value, 5);
  assert.equal(f.runtime.status().adapter.native.targetC, 17);
  assert.equal(f.runtime.status().roomTemperature.offsetC, 12);
  const commands = f.published.map(row => row.command);
  assert.equal(commands[0].measuredAt, undefined); assert.equal(commands[0].requestedExpiryAt, undefined);
  assert.equal(commands[2].measuredAt, f.engine.latest.garage_temperature.sourceTime);
  assert.equal(commands[2].requestedExpiryAt, commands[2].measuredAt + 120_000);
  assert.equal(new Set(commands.map(command => command.challenge)).size, commands.length);
  assert.deepEqual(commands.map(command => command.sequence), [1, 2, 3]);
  for (const { command, topic, options } of f.published) {
    assert.equal(command.schema, SHELLY_CN105_CONTRACT); assert.equal(topic, SETTINGS.commandTopic);
    assert.deepEqual(options, { qos: 0, retain: false, noReplay: true });
    assert.equal(command.episodeId, undefined, 'external room control never opens an automatic OFF episode');
  }
});

test('fresh independent room measurements renew through active externalBusy and polling cannot extend source expiry', async t => {
  const f = fixture(t); await f.start();
  assert.equal(f.adapter.externalTemperature().busy, true);
  assert.equal(f.adapter.externalTemperature().available, true);
  assert.equal(f.adapter.nativeControls().settings.targetC.available, false);
  f.advance(20_000); f.state(); await f.settle();
  assert.equal(f.published.length, 3, 'fresh device polling does not manufacture a new sensor measurement');
  f.measure(4); f.state(); await f.settle();
  assert.equal(f.published.length, 4, 'active external control must permit the next independent room reading');
  assert.equal(f.published[3].command.temperatureC, 16);
  assert.equal(f.published[3].command.measuredAt, f.engine.latest.garage_temperature.sourceTime);
  assert.equal(f.published[3].command.requestedExpiryAt, f.engine.latest.garage_temperature.sourceTime + 120_000);
  await f.advanceReport('acknowledged');
  assert.equal(f.runtime.status().roomTemperature.phase, 'active');
  f.advance(120_000); f.state(); await f.settle();
  assert.equal(f.published.length, 5);
  assert.equal(f.published[4].command.temperatureC, null, 'stale room input clears the external temperature');
  await f.advanceReport('acknowledged');
  assert.equal(f.runtime.status().roomTemperature.phase, 'waiting');
  assert.equal(f.runtime.status().roomTemperature.targetC, 5, 'fallback preserves saved room intent');
  await f.settle(); assert.equal(f.published.length, 5);
});

test('brief busy renewals coalesce fresh room readings during cooldown without clearing or recording a fault', async t => {
  const f = fixture(t); await f.start();
  f.advance(20_000); f.measure(4); f.state(); await f.settle();
  assert.equal(f.published.length, 4);
  const rejected = f.published.at(-1).command;
  f.advance(); f.rejectBusy(); await f.settle();
  assert.equal(f.published.length, 4, 'a new challenge cannot immediately retry a busy renewal');

  for (let update = 1; update <= 3; update++) {
    f.advance(); f.measure(4 + update / 2); f.state(); await f.settle();
    assert.equal(f.published.length, 4, 'fresh source readings cannot bypass the busy cooldown');
    assert.equal(f.adapter.externalTemperature().phase, 'active');
    assert.equal(f.adapter.externalTemperature().temperatureC, 17, 'the previous acknowledged feed remains in use');
  }
  const latest = structuredClone(f.engine.latest.garage_temperature);
  const lastReportAt = f.adapter.snapshot().acceptedEvidence.observedAt;
  f.advance(); f.runtime.safetyTick(); await f.settle();
  assert.equal(f.adapter.snapshot().acceptedEvidence.observedAt, lastReportAt, 'no new adapter report triggers the retry');
  assert.equal(f.published.length, 5, 'the safety tick retries at the cooldown boundary using the already-fresh challenge');
  const retry = f.published.at(-1).command;
  assert.equal(retry.action, 'remote-temperature');
  assert.equal(retry.temperatureC, latest.value + 12);
  assert.equal(retry.measuredAt, latest.sourceTime);
  assert.equal(retry.requestedExpiryAt, latest.sourceTime + 120_000);
  assert.notEqual(retry.measuredAt, f.now(), 'retry time cannot replace the original sensor timestamp');
  assert.equal(retry.issuedAt, f.now());
  assert.equal(retry.sequence, rejected.sequence + 1);
  assert.notEqual(retry.commandId, rejected.commandId);
  assert.notEqual(retry.challenge, rejected.challenge);
  assert.deepEqual(f.engine.latest.garage_temperature, latest);
  assert.ok(f.published.slice(2).every(({ command }) => command.action === 'remote-temperature' && command.temperatureC !== null));

  await f.advanceReport('acknowledged');
  assert.equal(f.runtime.status().roomTemperature.phase, 'active');
  assert.equal(f.runtime.status().roomTemperature.acknowledged, true);
  assert.equal(f.adapter.externalTemperature().temperatureC, latest.value + 12);
  assert.equal(f.now() + f.adapter.externalTemperature().expiresInMs, retry.requestedExpiryAt);
  assert.deepEqual(f.observations, []);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM events WHERE type='garage-external-temperature-diagnostic'").get().n, 0);
});

test('sustained busy renewals back off and record one fault until acknowledged recovery', async t => {
  const f = fixture(t); await f.start();
  f.advance(20_000); f.measure(4); f.state(); await f.settle();
  const first = f.published.at(-1).command;
  f.advance(); f.rejectBusy(); await f.settle();
  const busySince = f.now();
  const diagnostics = () => f.store.db.prepare("SELECT payload FROM events WHERE type='garage-external-temperature-diagnostic' ORDER BY id")
    .all().map(row => JSON.parse(row.payload));
  assert.deepEqual(diagnostics(), []);

  f.advance(4_000); f.state(); await f.settle();
  assert.equal(f.published.length, 5);
  f.rejectBusy(); await f.settle();
  assert.equal(f.published.length, 5);
  for (let update = 0; update < 7; update++) {
    f.advance(); f.state(); await f.settle();
    assert.equal(f.published.length, 5, 'repeated busy doubles the cooldown to eight seconds');
  }
  f.advance(); f.state(); await f.settle();
  assert.equal(f.published.length, 6);
  assert.deepEqual(diagnostics(), [], 'published retries do not end the brief-busy grace');
  f.advance(2_999); f.state(); await f.settle();
  assert.deepEqual(diagnostics(), []);
  f.advance(1); f.state(); await f.settle();
  assert.deepEqual(diagnostics(), [{ status: 'abnormal', reason: 'busy', since: busySince }]);
  f.advance(); f.state(); await f.settle();
  assert.equal(diagnostics().length, 1, 'continued contention cannot repeat the same fault');

  for (const { command } of f.published.slice(4)) {
    assert.equal(command.action, 'remote-temperature');
    assert.equal(command.temperatureC, first.temperatureC);
    assert.equal(command.measuredAt, first.measuredAt);
    assert.equal(command.requestedExpiryAt, first.requestedExpiryAt);
  }
  assert.equal(new Set(f.published.map(({ command }) => command.commandId)).size, f.published.length);
  assert.equal(new Set(f.published.map(({ command }) => command.challenge)).size, f.published.length);
  await f.advanceReport('acknowledged');
  assert.equal(f.runtime.status().roomTemperature.phase, 'active');
  assert.equal(f.runtime.status().roomTemperature.acknowledged, true);
  assert.deepEqual(diagnostics().map(row => row.status), ['abnormal', 'recovered']);
  assert.equal(diagnostics()[1].reason, 'external-feed-confirmed');
  assert.equal(diagnostics()[1].previousReason, 'busy');
  assert.equal(diagnostics()[1].since, busySince);
  assert.deepEqual(f.observations, []);
});

test('a dropped external renewal retries on a new challenge without clearing or changing the original sensor deadline', async t => {
  const f = fixture(t); await f.start();
  f.advance(20_000); f.measure(4); f.state(); await f.settle();
  assert.equal(f.published.length, 4);
  const dropped = f.published.at(-1).command;
  const source = structuredClone(f.engine.latest.garage_temperature);
  assert.equal(f.adapter.externalTemperature().result.status, 'published');

  // The broker drops the numeric request: the driver keeps reporting the
  // previous acknowledged sample and issues fresh, unused challenges.
  f.advance(9999); f.state(); await f.settle();
  assert.equal(f.published.length, 4, 'fresh state alone cannot cause immediate repeated publication');
  f.advance(1); f.state();
  assert.equal(f.adapter.externalTemperature().result.status, 'rejected');
  assert.equal(f.adapter.externalTemperature().result.reason, 'external-renewal-not-admitted');
  await f.settle();
  assert.equal(f.published.length, 5);
  const retry = f.published.at(-1).command;
  assert.equal(retry.action, 'remote-temperature');
  assert.equal(retry.temperatureC, dropped.temperatureC);
  assert.equal(retry.measuredAt, dropped.measuredAt);
  assert.equal(retry.requestedExpiryAt, dropped.requestedExpiryAt);
  assert.deepEqual(f.engine.latest.garage_temperature, source, 'retry does not manufacture another sensor report');
  assert.equal(retry.issuedAt, f.now());
  assert.equal(retry.sequence, dropped.sequence + 1);
  assert.notEqual(retry.commandId, dropped.commandId);
  assert.notEqual(retry.challenge, dropped.challenge);
  assert.ok(f.published.slice(2).every(({ command }) => command.action === 'remote-temperature' && command.temperatureC !== null));
  assert.equal(f.adapter.externalTemperature().temperatureC, 17, 'the acknowledged original feed stays active');

  await f.advanceReport('acknowledged');
  assert.equal(f.runtime.status().roomTemperature.phase, 'active');
  assert.equal(f.runtime.status().roomTemperature.acknowledged, true);
  assert.equal(f.adapter.externalTemperature().temperatureC, 16);
  assert.equal(f.now() + f.adapter.externalTemperature().expiresInMs, source.sourceTime + 120_000);
  assert.deepEqual(f.observations, []);
});

test('repeated lost renewals recover with fresh envelopes while preserving continuous acknowledged coverage', async t => {
  const f = fixture(t); await f.start();
  for (let cycle = 0; cycle < 4; cycle++) {
    f.advance(20_000); f.measure(4 + cycle / 2); f.state(); await f.settle();
    const first = f.published.at(-1).command;
    for (let loss = 0; loss < 2; loss++) {
      const count = f.published.length, previous = f.published.at(-1).command;
      f.advance(10_000); f.state(); await f.settle();
      assert.equal(f.published.length, count + 1, 'a fenced dropped request permits one replacement');
      const retry = f.published.at(-1).command;
      assert.equal(retry.action, 'remote-temperature');
      assert.equal(retry.temperatureC, first.temperatureC);
      assert.equal(retry.measuredAt, first.measuredAt);
      assert.equal(retry.requestedExpiryAt, first.requestedExpiryAt);
      assert.notEqual(retry.commandId, previous.commandId);
      assert.notEqual(retry.challenge, previous.challenge);
      assert.equal(f.adapter.externalTemperature().phase, 'active', 'lost renewals do not trigger an internal-sensor handover');
    }
    await f.advanceReport('acknowledged');
    assert.equal(f.runtime.status().roomTemperature.phase, 'active');
    assert.equal(f.adapter.externalTemperature().measuredAt, first.measuredAt);
    assert.equal(f.now() + f.adapter.externalTemperature().expiresInMs, first.requestedExpiryAt);
  }
  const renewals = f.published.slice(3).map(row => row.command);
  assert.equal(renewals.length, 12);
  assert.ok(renewals.every(command => command.action === 'remote-temperature' && command.temperatureC !== null));
  assert.equal(new Set(f.published.map(row => row.command.challenge)).size, f.published.length);
  assert.deepEqual(f.observations, [], 'numeric feed values never enter history');
  const events = f.store.db.prepare("SELECT payload FROM events WHERE type='garage-external-temperature-diagnostic' ORDER BY id").all().map(row => JSON.parse(row.payload));
  assert.deepEqual(events.map(row => row.status), Array.from({ length: 4 }, () => ['abnormal', 'recovered']).flat());
  assert.equal(f.store.getState(f.runtime.keys.roomTemperature).targetC, 5);
});

test('an accepted external renewal waits for its acknowledgement without being classified as a dropped publication', async t => {
  const f = fixture(t); await f.start();
  f.advance(20_000); f.measure(4); f.state(); await f.settle();
  await f.advanceReport('accepted');
  const commands = structuredClone(f.published);
  for (let report = 0; report < 3; report++) {
    f.advance(10_000); f.state(); await f.settle();
    assert.deepEqual(f.published, commands, 'fresh unused challenges cannot replace an admitted numeric request');
    assert.equal(f.adapter.externalTemperature().result.status, 'accepted');
  }
  await f.advanceReport('acknowledged');
  assert.equal(f.runtime.status().roomTemperature.phase, 'active');
  assert.equal(f.adapter.externalTemperature().result.status, 'acknowledged');
  assert.deepEqual(f.published, commands);
});

test('device setting reports between renewals do not issue commands, and OFF or cooling withdraw active status', async t => {
  const f = fixture(t); await f.start(); const commands = structuredClone(f.published);
  for (const values of [{ targetC: 16 }, { power: 'off' }, { mode: 'cool' }, { targetC: null }]) {
    f.advance(); Object.assign(f.native, values); f.state(); await f.settle();
    assert.deepEqual(f.published, commands, JSON.stringify(values));
    const heating = f.native.power === 'on' && f.native.mode === 'heat';
    assert.equal(f.runtime.status().roomTemperature.phase, heating ? 'active' : 'waiting');
    assert.equal(f.runtime.status().roomTemperature.acknowledged, heating);
  }
  f.advance(); Object.assign(f.native, { targetC: 17, power: 'on', mode: 'heat' });
  f.state({ nativeAt: f.now() - 30_001 }); await f.settle();
  assert.deepEqual(f.published, commands, 'native freshness does not alter an already-admitted room measurement');
  assert.equal(f.runtime.status().roomTemperature.phase, 'active');
});

test('real adapter renewals enforce ON HEAT 17°C evidence without adding clear commands or extending rejected leases', async t => {
  for (const scenario of ['target16', 'unknown', 'off', 'cool', 'stale', 'mixed response']) {
    await t.test(scenario, async t => {
      const f = fixture(t); await f.start(); const commands = structuredClone(f.published);
      const expiry = f.published.at(-1).command.requestedExpiryAt;
      f.advance(20_000); f.measure(4);
      const stateOptions = {};
      if (scenario === 'target16') f.native.targetC = 16;
      if (scenario === 'unknown') f.native.targetC = null;
      if (scenario === 'off') f.native.power = 'off';
      if (scenario === 'cool') f.native.mode = 'cool';
      if (scenario === 'stale') stateOptions.nativeAt = f.now() - 30_001;
      if (scenario === 'mixed response') stateOptions.nativeTimes = { power: f.now() - 1 };
      f.state(stateOptions); await f.settle();
      assert.deepEqual(f.published, commands, 'a failed admission check must not publish any command');
      assert.equal(f.runtime.status().roomTemperature.phase, 'waiting');
      assert.equal(f.adapter.externalTemperature().measuredAt + 120_000, expiry);
      f.advance(); Object.assign(f.native, { power: 'on', mode: 'heat', targetC: 17 });
      f.measure(4); f.state(); await f.settle();
      assert.equal(f.published.length, commands.length + 1);
      assert.equal(f.published.at(-1).command.temperatureC, 16);
      assert.equal(f.published.at(-1).command.requestedExpiryAt, f.engine.latest.garage_temperature.sourceTime + 120_000);
    });
  }
});

test('withheld renewals leave the original 120-second permission to expire', async t => {
  const f = fixture(t); await f.start(); const commands = structuredClone(f.published);
  const expiry = f.published.at(-1).command.requestedExpiryAt;
  f.advance(20_000); f.native.targetC = 16; f.measure(4); f.state(); await f.settle();
  f.advance(expiry - f.now()); f.measure(4); f.state(); await f.settle();
  assert.equal(f.adapter.externalTemperature().expiresInMs, 0);
  assert.deepEqual(f.published, commands, 'fresh source data with the wrong target sends no renewal or clear');
  assert.equal(f.runtime.status().roomTemperature.phase, 'waiting');
  f.advance(); f.native.targetC = 17; f.measure(4); f.state(); await f.settle();
  assert.equal(f.published.length, commands.length + 1);
  assert.equal(f.published.at(-1).command.requestedExpiryAt, f.engine.latest.garage_temperature.sourceTime + 120_000);
});

test('real adapter admits renewal with native readbacks exactly 30 seconds old', async t => {
  const f = fixture(t); await f.start(); f.advance(20_000); f.measure(4);
  f.state({ nativeAt: f.now() - 30_000 }); await f.settle();
  assert.equal(f.published.length, 4); assert.equal(f.published.at(-1).command.temperatureC, 16);
});

test('ordinary targets and powerOFF pass through acknowledged internal-sensor cleanup before native commands', async t => {
  for (const request of [{ setting: 'targetC', value: 16 }, { setting: 'targetC', value: 20 }, { setting: 'power', value: 'off' }]) {
    await t.test(`${request.setting} ${request.value}`, async t => {
      const f = fixture(t); await f.start();
      assert.equal(f.adapter.nativeControls().settings[request.setting].available, false);
      assert.equal(f.runtime.nativeControls().settings[request.setting].available, true);
      await f.runtime.setNativeSettings(request); await f.settle();
      assert.equal(f.published.length, 4);
      assert.equal(f.published[3].command.action, 'remote-temperature');
      assert.equal(f.published[3].command.temperatureC, null);
      assert.equal(f.store.getState(f.runtime.keys.roomTemperature).targetC, request.setting === 'targetC' ? request.value : 5);
      await f.advanceReport('accepted');
      assert.equal(f.published.length, 4, 'an accepted clear must not allow the native command through');
      await f.advanceReport('acknowledged');
      assert.equal(f.published.length, 5);
      assert.equal(f.published[4].command.action, 'manual');
      assert.deepEqual(f.published[4].command.settings, { [request.setting]: request.value });
      await f.advanceReport('native-confirmed');
      assert.equal(f.runtime.status().nativeControls.result.status, 'native-confirmed');
      assert.equal(f.runtime.status().roomTemperature.targetC, request.setting === 'targetC' ? null : 5);
      assert.equal(f.runtime.status().roomTemperature.phase, request.setting === 'targetC' ? 'disabled' : 'waiting');
      assertInitialWarmth(f.runtime, request.setting === 'targetC' ? request.value : 5);
      f.advance(); f.measure(4); f.state(); await f.settle();
      assert.equal(f.published.length, 5, 'cancelled room intent cannot restart the external feed');
    });
  }
});


test('real fan and vane adjustments preserve room intent and model references while confirming each handover', async t => {
  for (const request of [{ setting: 'fan', value: 3 }, { setting: 'vane', value: 2 }, { setting: 'wideVane', value: 'left' }]) {
    await t.test(request.setting, async t => {
      const f = fixture(t); await f.start();
      const reference = structuredClone(f.runtime.status().learning.normalReference);
      await f.runtime.setNativeSettings(request); await f.settle();
      assert.equal(f.published.at(-1).command.temperatureC, null);
      assert.equal(f.runtime.roomTemperature.targetC, 5);
      assert.equal(f.store.getState(f.runtime.keys.roomTemperature).targetC, 5);
      await f.advanceReport('acknowledged');
      assert.deepEqual(f.published.at(-1).command.settings, { [request.setting]: request.value });
      await f.advanceReport('accepted');
      assert.equal(f.published.length, 5, 'A received request is not native confirmation');
      await f.advanceReport('native-confirmed');
      assert.deepEqual(f.published.at(-1).command.settings, { targetC: 17 });
      await f.advanceReport('native-confirmed');
      f.advance(); f.measure(4); f.state(); await f.settle();
      assert.equal(f.published.at(-1).command.temperatureC, 16);
      await f.advanceReport('acknowledged');
      assert.equal(f.runtime.roomTemperature.phase, 'active');
      assert.equal(f.native[request.setting], request.value);
      assert.deepEqual(f.runtime.status().learning.normalReference, reference);
    });
  }
});

test('an inactive saved low target does not overwrite a new physical native target when heating returns', async t => {
  const f = fixture(t); await f.start();
  await f.runtime.setNativeSettings({ setting: 'power', value: 'off' }); await f.settle();
  await f.advanceReport('acknowledged'); await f.advanceReport('native-confirmed');
  const count = f.published.length;
  f.advance(); Object.assign(f.native, { power: 'on', targetC: 20 }); f.measure(); f.state(); await f.settle();
  assert.equal(f.published.length, count, 'A physical room adjustment must not be replaced with native17');
  assert.equal(f.runtime.roomTemperature.targetC, 5, 'The desired external room setting remains remembered');
  assert.equal(f.runtime.roomTemperature.phase, 'waiting');
  assert.match(f.runtime.roomTemperature.reason, /room setting changed/i);
});


test('a rejected native target dispatch does not mask fresh pump settings behind pending room intent', async t => {
  const f = fixture(t); await f.settle();
  const send = f.adapter.setNativeSetting;
  f.adapter.setNativeSetting = async () => { throw new Error('synthetic command admission failure'); };
  await assert.rejects(f.runtime.setNativeSettings({ setting: 'targetC', value: 20 }), /command admission failure/);
  assert.equal(f.published.length, 0);
  assertInitialWarmth(f.runtime, 17);
  f.adapter.setNativeSetting = send;
  f.advance(); f.native.targetC = 22; f.state(); await f.settle();
  assertInitialWarmth(f.runtime, 22);
});
