import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGarageAdapter } from '../src/garage/adapter.js';
import { createShellyCn105Transport } from '../src/garage/shelly-cn105.js';
import { SHELLY_CN105_CONTRACT } from '../src/garage/contract.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { Store } from '../src/storage/store.js';

const TEMPLATE = JSON.parse(readFileSync(new URL('./fixtures/garage-pill-state.json', import.meta.url)));
const BASE = TEMPLATE.observedAt;
const SETTINGS = { driver: 'shelly-cn105', stateTopic: 'invented/room/state',
  telemetryTopic: 'invented/room/telemetry', commandTopic: 'invented/room/command' };
const INTERNAL = { enabled: true, phase: 'internal', temperatureC: null, measuredAt: null, expiresInMs: 0,
  refreshMs: 10_000, maxSourceAgeMs: 90_000, acknowledged: false, restorationPending: false, rearmRequired: false, reason: null };

/** Real runtime, adapter, envelope transport and persistence; only the broker,
 * physical driver's reports and independent room sensor are synthetic. */
function fixture(t) {
  let now = BASE, sequence = 0, external = { ...INTERNAL }, result = null, manualPending = false;
  const native = { power: 'on', mode: 'heat', targetC: 17, fan: 'auto', vane: 3, wideVane: 'center', vanes: 'fixed' };
  const published = [], observations = [], store = new Store(':memory:');
  const engine = { latest: {}, lastKnownTemperatures: {}, settings: { mode: 'shadow' } };
  const runtime = new GarageRuntime({ store, engine,
    config: { input: 'mqtt', garage: { enabled: false, baselineC: 16, adapter: SETTINGS } }, clock: () => now });
  const adapter = createGarageAdapter({ settings: SETTINGS, baselineC: 16, hostSession: 'invented-room-owner', clock: () => now,
    onObservation: row => observations.push(row),
    onState: snapshot => runtime.adapterChanged(snapshot),
    productionTransport: createShellyCn105Transport({ settings: SETTINGS, publish: async (topic, payload, options) => {
      published.push({ topic, command: JSON.parse(payload), options });
    } }) });
  runtime.setAdapter(adapter); adapter.setConnected(true);
  function state({ nativeAt = now, nativeTimes = {} } = {}) {
    const value = { ...structuredClone(TEMPLATE), sequence: ++sequence, observedAt: now, mode: 'monitoring',
      authority: { ownerSession: published.length ? 'invented-room-owner' : null, controlAllowed: false,
        manualControlAllowed: external.phase === 'internal' && !manualPending },
      challenge: { value: `invented-room-challenge-${sequence}`, expiresAt: now + 30_000 },
      native: Object.fromEntries(Object.entries(native).map(([key, value]) => [key, { value, measuredAt: nativeTimes[key] ?? nativeAt, ageMs: now - (nativeTimes[key] ?? nativeAt) }])),
      externalTemperature: { ...external, expiresInMs: external.temperatureC === null ? 0
        : Math.max(0, external.measuredAt + 90_000 - now) }, result, manualPending,
      capabilities: { ...TEMPLATE.capabilities, externalTemperature: true, targetStep: 1,
        manualControls: Object.fromEntries(['power', 'mode', 'targetC', 'fan', 'vane', 'wideVane'].map(key => [key, true])) } };
    for (const field of Object.values(value.health)) { field.measuredAt = now; field.ageMs = 0; }
    assert.equal(adapter.receive(SETTINGS.stateTopic, JSON.stringify(value), {}, now), true);
  }
  function measure(value = 5) {
    engine.latest.garage_temperature = { signal: 'garage_temperature', source: 'mqtt-equipment', device: 'invented-room-rear',
      value, sourceTime: now, receivedAt: now, quality: ['good'], raw: {} };
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
          expiresInMs: Math.max(0, command.requestedExpiryAt - now), acknowledged: status === 'acknowledged' };
    }
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
  measure(); state();
  t.after(async () => { await runtime.close({ restore: false }); await adapter.close({ restore: false }); store.close(); });
  return { runtime, adapter, engine, store, native, published, observations, state, report, measure, settle, advanceReport, start,
    now: () => now, advance(ms = 1000) { now += ms; } };
}

test('external temperature history begins only after device acknowledgement and ends at its actual deadline', async t => {
  const f = fixture(t); await f.start();
  const feed = f.observations.filter(row => row.signal === 'garage_external_temperature');
  assert.equal(feed.length, 1);
  assert.equal(feed[0].value, 17);
  assert.equal(feed[0].sourceTime, f.now(), 'Do not draw a temperature feed before the acknowledgement');
  assert.equal(feed[0].raw.measuredAt, f.published[2].command.measuredAt);
  assert.equal(feed[0].raw.expiresAt, feed[0].raw.measuredAt + 90_000);
  assert.equal(feed[0].sourceTime + feed[0].raw.reportIntervalMs, feed[0].raw.expiresAt);
  f.advance(); f.state();
  assert.equal(f.observations.length, 1, 'Republished state cannot extend the original sample');
  f.adapter.setConnected(false);
  assert.equal(f.observations.at(-1).value, null);
  assert.equal(f.observations.at(-1).raw.timeBasis, 'availability-transition');
});

test('real runtime and Pill adapter select5 through clearACK, forced native17 confirmation and room+12', async t => {
  const f = fixture(t); await f.start();
  assert.deepEqual(f.store.getState(f.runtime.keys.roomTemperature), { targetC: 5 });
  assert.equal(f.runtime.nativeControls().settings.targetC.value, 5);
  assert.equal(f.runtime.status().adapter.native.targetC, 17);
  assert.equal(f.runtime.status().roomTemperature.offsetC, 12);
  const commands = f.published.map(row => row.command);
  assert.equal(commands[0].measuredAt, undefined); assert.equal(commands[0].requestedExpiryAt, undefined);
  assert.equal(commands[2].measuredAt, f.engine.latest.garage_temperature.sourceTime);
  assert.equal(commands[2].requestedExpiryAt, commands[2].measuredAt + 90_000);
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
  assert.equal(f.published[3].command.requestedExpiryAt, f.engine.latest.garage_temperature.sourceTime + 90_000);
  await f.advanceReport('acknowledged');
  assert.equal(f.runtime.status().roomTemperature.phase, 'active');
  f.advance(90_000); f.state(); await f.settle();
  assert.equal(f.published.length, 5);
  assert.equal(f.published[4].command.temperatureC, null, 'stale room input clears the external temperature');
  await f.advanceReport('acknowledged');
  assert.equal(f.runtime.status().roomTemperature.phase, 'waiting');
  assert.equal(f.runtime.status().roomTemperature.targetC, 5, 'fallback preserves saved room intent');
  await f.settle(); assert.equal(f.published.length, 5);
});

test('device setting reports between renewals do not issue commands or invalidate the current room sample', async t => {
  const f = fixture(t); await f.start(); const commands = structuredClone(f.published);
  for (const values of [{ targetC: 16 }, { power: 'off' }, { mode: 'cool' }, { targetC: null }]) {
    f.advance(); Object.assign(f.native, values); f.state(); await f.settle();
    assert.deepEqual(f.published, commands, JSON.stringify(values));
    assert.equal(f.runtime.status().roomTemperature.phase, 'active');
    assert.equal(f.runtime.status().roomTemperature.acknowledged, true);
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
      assert.equal(f.adapter.externalTemperature().measuredAt + 90_000, expiry);
      f.advance(); Object.assign(f.native, { power: 'on', mode: 'heat', targetC: 17 });
      f.measure(4); f.state(); await f.settle();
      assert.equal(f.published.length, commands.length + 1);
      assert.equal(f.published.at(-1).command.temperatureC, 16);
      assert.equal(f.published.at(-1).command.requestedExpiryAt, f.engine.latest.garage_temperature.sourceTime + 90_000);
    });
  }
});

test('withheld renewals leave the original 90-second permission to expire', async t => {
  const f = fixture(t); await f.start(); const commands = structuredClone(f.published);
  const expiry = f.published.at(-1).command.requestedExpiryAt;
  f.advance(20_000); f.native.targetC = 16; f.measure(4); f.state(); await f.settle();
  f.advance(expiry - f.now()); f.measure(4); f.state(); await f.settle();
  assert.equal(f.adapter.externalTemperature().expiresInMs, 0);
  assert.deepEqual(f.published, commands, 'fresh source data with the wrong target sends no renewal or clear');
  assert.equal(f.runtime.status().roomTemperature.phase, 'waiting');
  f.advance(); f.native.targetC = 17; f.measure(4); f.state(); await f.settle();
  assert.equal(f.published.length, commands.length + 1);
  assert.equal(f.published.at(-1).command.requestedExpiryAt, f.engine.latest.garage_temperature.sourceTime + 90_000);
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
      assert.deepEqual(f.store.getState(f.runtime.keys.roomTemperature), { targetC: null });
      await f.advanceReport('accepted');
      assert.equal(f.published.length, 4, 'an accepted clear must not allow the native command through');
      await f.advanceReport('acknowledged');
      assert.equal(f.published.length, 5);
      assert.equal(f.published[4].command.action, 'manual');
      assert.deepEqual(f.published[4].command.settings, { [request.setting]: request.value });
      await f.advanceReport('native-confirmed');
      assert.equal(f.runtime.status().nativeControls.result.status, 'native-confirmed');
      assert.equal(f.runtime.status().roomTemperature.targetC, null);
      assert.equal(f.runtime.status().roomTemperature.phase, 'disabled');
      f.advance(); f.measure(4); f.state(); await f.settle();
      assert.equal(f.published.length, 5, 'cancelled room intent cannot restart the external feed');
    });
  }
});
