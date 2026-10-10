import test from 'node:test';
import assert from 'node:assert/strict';
import { garageV2Fixture, GARAGE_TEST_AT, GARAGE_TEST_ADAPTER } from './helpers/garage-v2.js';
import { createGarageAdapter } from '../src/garage/adapter.js';
import { createShellyCn105Transport } from '../src/garage/shelly-cn105.js';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { garageAdapterSettings, validateGarageAdapterSnapshot } from '../src/garage/contract.js';

test('tiny-ahead Garage status waits, retains original receipt and does not extend challenge lifetime', async () => {
  const f = garageV2Fixture(); f.update();
  f.at(GARAGE_TEST_AT + 1000);
  f.update({ observedAt: GARAGE_TEST_AT + 1004 });
  assert.equal(f.adapter.status().controlAvailable, false);
  await assert.rejects(f.adapter.setControl({ targetC: 5, externalEnabled: true }), /source clock/);
  f.at(GARAGE_TEST_AT + 1004); f.adapter.tick();
  assert.equal(f.adapter.status().controlAvailable, true);
  const saved = f.adapter.snapshot();
  assert.equal(saved.observedAt, GARAGE_TEST_AT + 1004);
  assert.equal(saved.receivedAt, GARAGE_TEST_AT + 1000);
  assert.equal(saved.admittedAt, GARAGE_TEST_AT + 1004);
  assert.doesNotThrow(() => validateGarageAdapterSnapshot(saved));
  assert.throws(() => validateGarageAdapterSnapshot({ ...saved, admittedAt: GARAGE_TEST_AT + 1003 }));
  f.at(GARAGE_TEST_AT + 15_000);
  assert.equal(f.adapter.status().controlAvailable, false, 'Delivery headroom expires from original receipt, not the future source clock');
  await f.adapter.close();
});

test('expired newer Garage status cannot revive the older command challenge', async () => {
  let elapsed = 0;
  const f = garageV2Fixture({ monotonicClock: () => elapsed }); f.update();
  f.update({ observedAt: GARAGE_TEST_AT + 400 });
  elapsed = 5000; f.adapter.tick();
  assert.equal(f.adapter.status().controlAvailable, false);
  await assert.rejects(f.adapter.setControl({ targetC: 5, externalEnabled: true }), /fresh heat-pump controller status/);
  f.at(GARAGE_TEST_AT + 1000); f.update();
  assert.equal(f.adapter.status().controlAvailable, true);
  assert.equal(f.publications.length, 0);
  await f.adapter.close();
});

test('v2 requires fresh native readback and retained state never grants authority', async () => {
  const f = garageV2Fixture();
  assert.equal(f.update({}, { retain: true }), false);
  await assert.rejects(f.adapter.setControl({ targetC: 5, externalEnabled: true }), /fresh heat-pump controller status/);
  assert.equal(f.update({ health: { nativeFresh: false } }), true);
  await assert.rejects(f.adapter.setControl({ targetC: 5, externalEnabled: true }), /communication/);
  f.update(); assert.equal(f.adapter.status().controlAvailable, true);
  await f.adapter.setControl({ targetC: 5, externalEnabled: true });
  assert.equal(f.publications.length, 1);
  const { beforePublish, signal, ...wireSettings } = f.publications[0].settings;
  assert.equal(typeof beforePublish, 'function'); assert(signal instanceof AbortSignal);
  assert.deepEqual(wireSettings, { qos: 0, retain: false, noReplay: true });
  assert.equal(f.publications[0].action, 'control');
  assert.equal(f.adapter.status().control.targetC, 10, 'published request is separate from actual target');
  assert.equal(f.adapter.status().lastCommand.status, 'published');
});

test('readback confirms durable target, challenges are single use, no disconnect/restart/shutdown command is generated', async () => {
  const f = garageV2Fixture(); f.update();
  await f.adapter.setControl({ targetC: 5, externalEnabled: true });
  await assert.rejects(f.adapter.setControl({ targetC: 10, externalEnabled: true }), /challenge|previous command/);
  f.at(GARAGE_TEST_AT + 1000); f.update({ control: { targetC: 5, effectiveTargetC: 5 } });
  assert.equal(f.adapter.status().lastCommand.status, 'applied');
  assert.equal(f.adapter.status().native.power, 'off');
  f.adapter.setConnected(false); f.adapter.setConnected(true); f.update();
  await f.adapter.close();
  assert.equal(f.publications.length, 1);
});

test('command expiry and delivery headroom block edits while controller readback remains fresh', async () => {
  const f = garageV2Fixture(); f.update();
  f.at(GARAGE_TEST_AT + 13_999);
  assert.equal(f.adapter.status().controlAvailable, true);
  f.at(GARAGE_TEST_AT + 14_000);
  assert.equal(f.adapter.status().controlAvailable, false);
  assert.equal(f.adapter.status().health.pumpCommunicating, true);
  assert.equal(f.adapter.status().control.targetC, 10);
  await assert.rejects(f.adapter.setControl({ targetC: 5, externalEnabled: true }), /fresh command challenge/);
  assert.throws(() => f.adapter.setNativeSetting({ setting: 'power', value: 'off' }), /fresh command challenge/);
  f.at(GARAGE_TEST_AT + 30_000);
  assert.equal(f.adapter.status().lastCommand, null, 'an unsent expired request never becomes uncertain');
  assert.equal(f.publications.length, 0);
  f.update();
  await f.adapter.setControl({ targetC: 5, externalEnabled: true });
  assert.equal(f.publications.length, 1, 'only the new explicit request uses the refreshed challenge');
});

test('source transit delay and repeated publications cannot renew command authority', async () => {
  const f = garageV2Fixture();
  f.at(GARAGE_TEST_AT + 14_000);
  assert.equal(f.update({ observedAt: GARAGE_TEST_AT }), true);
  await assert.rejects(f.adapter.setControl({ targetC: 5, externalEnabled: true }), /fresh command challenge/);
  f.update({ challenge: { value: 'fixture-shared-challenge', expiresInMs: 15_000 } });
  f.at(GARAGE_TEST_AT + 22_000);
  f.update({ challenge: { value: 'fixture-shared-challenge', expiresInMs: 15_000 } });
  f.at(GARAGE_TEST_AT + 28_000);
  assert.equal(f.adapter.status().controlAvailable, false, 'the first deadline still bounds a republished token');
  assert.equal(f.publications.length, 0);
});

test('monotonic expiry fences wall-clock rollback and timestamp-free controller state', async () => {
  let elapsed = 0;
  const f = garageV2Fixture({ monotonicClock: () => elapsed });
  f.update({ observedAt: null, observedAgeMs: 0 });
  elapsed = 5000; f.at(GARAGE_TEST_AT + 5000);
  assert.equal(f.adapter.status().controlAvailable, true);
  elapsed = 14_000; f.at(GARAGE_TEST_AT + 1000);
  assert.equal(f.adapter.status().controlAvailable, false);
  await assert.rejects(f.adapter.setControl({ targetC: 5, externalEnabled: true }, GARAGE_TEST_AT), /fresh command challenge/);
  assert.equal(f.publications.length, 0);
});

test('reported source age bounds native and telemetry freshness without rewriting source UTC', () => {
  let elapsed = 0;
  const f = garageV2Fixture({ monotonicClock: () => elapsed });
  const measuredAt = GARAGE_TEST_AT - 1000;
  f.update({ native: { power: { value: 'off', measuredAt, ageMs: 119_000 } },
    readback: { measuredAt, ageMs: 119_000 } });
  f.adapter.receive(GARAGE_TEST_ADAPTER.telemetryTopic, JSON.stringify({
    schema: 'shelly-cn105/v2', deviceId: 'synthetic-pill', bootId: 'boot-one', sequence: 2,
    observedAt: GARAGE_TEST_AT, fields: { compressorActive: {
      value: true, measuredAt, ageMs: 119_000, supported: true, decodeVerified: true, unit: 'boolean',
    } },
  }));
  assert.equal(f.adapter.status().native.power, 'off');
  assert.equal(f.adapter.status().health.pumpCommunicating, true);
  assert.equal(f.adapter.status().telemetry.compressorActive.diagnosticAvailable, true);
  elapsed = 1000;
  assert.equal(f.adapter.status().native.power, null);
  assert.equal(f.adapter.status().health.pumpCommunicating, false);
  assert.equal(f.adapter.status().telemetry.compressorActive.diagnosticAvailable, false);
  assert.equal(f.adapter.status().telemetry.compressorActive.sourceTime, measuredAt);
  assert.equal(f.adapter.snapshot().native.power.measuredAt, measuredAt);
  validateGarageAdapterSnapshot(f.adapter.snapshot());
  assert.equal(f.observations.find(row => row.signal === 'garage_compressor_active').raw.reportIntervalMs, 2000,
    'recorded coverage ends at the actual remaining lifetime');
  elapsed = 120_000;
  assert.equal(f.adapter.status().health.driverProgressing, false, 'a stalled wall clock cannot extend publisher freshness');
  assert.equal(f.adapter.status().control, null);
});

test('expired or malformed source ages cannot revive after source UTC moves back into range', () => {
  for (const ageMs of [120_000, 300_000, -1, 1.5, '1000']) {
    const f = garageV2Fixture();
    f.update({ native: { power: { value: 'off', measuredAt: GARAGE_TEST_AT, ageMs } },
      readback: { measuredAt: GARAGE_TEST_AT, ageMs } });
    assert.equal(f.adapter.status().native.power, null);
    assert.equal(f.adapter.status().health.pumpCommunicating, false);
    assert.equal(f.adapter.status().controlAvailable, false);
    const power = f.observations.find(row => row.signal === 'garage_native_power');
    assert(power.quality.includes('stale'));
  }
  const delayed = garageV2Fixture();
  delayed.update({ observedAt: GARAGE_TEST_AT - 10_000,
    native: { power: { value: 'off', measuredAt: GARAGE_TEST_AT - 10_000, ageMs: 110_000 } },
    readback: { measuredAt: GARAGE_TEST_AT - 10_000, ageMs: 110_000 } });
  assert.equal(delayed.adapter.status().health.pumpCommunicating, false, 'transit also consumes the source-age deadline');
  assert.equal(delayed.adapter.status().native.power, null);
});

test('republishing the same native measurement cannot renew its monotonic deadline', () => {
  let elapsed = 0;
  const f = garageV2Fixture({ monotonicClock: () => elapsed });
  const measuredAt = GARAGE_TEST_AT - 1000;
  const state = ageMs => ({ native: { power: { value: 'off', measuredAt, ageMs } }, readback: { measuredAt, ageMs } });
  f.update(state(119_000));
  elapsed = 1000;
  f.update(state(0));
  assert.equal(f.adapter.status().native.power, null);
  assert.equal(f.adapter.status().health.pumpCommunicating, false);
  assert.equal(f.adapter.status().controlAvailable, false);
});

test('expiry is checked again after persisting the request and before MQTT publication', async () => {
  let f;
  f = garageV2Fixture({ onState(snapshot) {
    if (snapshot.lastCommand?.status === 'published') f.at(GARAGE_TEST_AT + 15_000);
  } });
  f.update();
  await assert.rejects(f.adapter.setControl({ targetC: 5, externalEnabled: true }), /expired before sending/);
  assert.equal(f.publications.length, 0);
  assert.equal(f.adapter.status().lastCommand.status, 'rejected');
});

test('unsupported or malformed challenge expiry never authorizes a command', () => {
  for (const challenge of [
    { value: 'fixture-token' }, { value: 'fixture-token', expiresInMs: -1 },
    { value: 'fixture-token', expiresInMs: 15_001 }, { value: 'fixture-token', expiresInMs: 1.5 },
    { value: 'fixture-token', expiresInMs: '15000' }, { value: null, expiresInMs: 15_000 },
    { value: 'fixture-token', expiresInMs: 15_000, expiresAt: GARAGE_TEST_AT + 15_000 },
  ]) {
    const f = garageV2Fixture();
    assert.equal(f.update({ challenge }), false);
    assert.equal(f.adapter.status().controlAvailable, false);
  }
});

test('a consumed challenge does not discard applied readback or native confirmation', async () => {
  for (const action of ['control', 'set']) {
    const f = garageV2Fixture(); f.update();
    if (action === 'control') await f.adapter.setControl({ targetC: 5, externalEnabled: true });
    else await f.adapter.setNativeSetting({ setting: 'power', value: 'off' });
    f.at(GARAGE_TEST_AT + 1000);
    assert.equal(f.update({ challenge: { value: null, expiresInMs: 0 },
      control: { targetC: 5, effectiveTargetC: 5 },
      result: { commandId: f.publications[0].commandId, status: action === 'control' ? 'applied' : 'native-confirmed', reason: null } }), true);
    assert.equal(f.adapter.status().lastCommand.status, action === 'control' ? 'applied' : 'native-confirmed');
    assert.equal(f.adapter.status().controlAvailable, false);
    assert.equal(f.adapter.status().control.targetC, 5);
    assert.equal(f.adapter.status().native.power, 'off');
  }
});

test('a late publication failure preserves device confirmation and its original request receipt', async () => {
  for (const action of ['control', 'set']) {
    const publications = [];
    const f = garageV2Fixture({ productionTransport: createShellyCn105Transport({ settings: GARAGE_TEST_ADAPTER,
      publish: (_topic, payload, options) => { options.beforePublish(); return new Promise((resolve, reject) => publications.push({ ...JSON.parse(payload), resolve, reject })); } }) });
    f.update();
    const first = action === 'control' ? f.adapter.setControl({ targetC: 5, externalEnabled: true })
      : f.adapter.setNativeSetting({ setting: 'power', value: 'off' });
    const commandId = publications[0].commandId;
    f.at(GARAGE_TEST_AT + 1000);
    f.update({ control: { targetC: 5, effectiveTargetC: 5 },
      ...(action === 'set' ? { result: { commandId, status: 'native-confirmed', reason: null } } : {}) });
    const confirmed = f.adapter.status().lastCommand;
    assert.equal(confirmed.status, action === 'control' ? 'applied' : 'native-confirmed');
    publications[0].reject(new Error('fixture-delayed-publication-failure'));
    assert.deepEqual(await first, confirmed);
    assert.deepEqual(f.adapter.status().lastCommand, confirmed);

    f.update();
    const previous = f.adapter.setNativeSetting({ setting: 'power', value: 'off' });
    f.update({ result: { commandId: publications[1].commandId, status: 'native-confirmed', reason: null } });
    const previousReceipt = f.adapter.status().lastCommand;
    const newest = f.adapter.setNativeSetting({ setting: 'power', value: 'on' });
    const newestReceipt = f.adapter.status().lastCommand;
    publications[1].reject(new Error('fixture-older-publication-failure'));
    assert.deepEqual(await previous, previousReceipt);
    assert.deepEqual(f.adapter.status().lastCommand, newestReceipt, 'older publication cannot mutate the newer command');
    publications[2].resolve();
    assert.deepEqual(await newest, newestReceipt);
    assert.equal(publications.length, 3, 'no attempt is replayed');
  }
});

test('a publication failure before device evidence remains uncertain without replay', async () => {
  const f = garageV2Fixture({ productionTransport: createShellyCn105Transport({ settings: GARAGE_TEST_ADAPTER,
    publish: async () => { throw new Error('fixture-publication-failure'); } }) });
  f.update();
  await assert.rejects(f.adapter.setControl({ targetC: 5, externalEnabled: true }), /delivery is unconfirmed/);
  assert.equal(f.adapter.status().lastCommand.status, 'uncertain');
});

test('a final rejection or disconnect cannot turn publication failure into successful delivery', async () => {
  for (const outcome of ['rejected', 'failed', 'disconnected']) {
    let command, reject;
    const f = garageV2Fixture({ productionTransport: createShellyCn105Transport({ settings: GARAGE_TEST_ADAPTER,
      publish: (_topic, payload, options) => { options.beforePublish(); command = JSON.parse(payload); return new Promise((_resolve, fail) => { reject = fail; }); } }) });
    f.update();
    const request = f.adapter.setControl({ targetC: 5, externalEnabled: true });
    if (outcome === 'disconnected') f.adapter.setConnected(false);
    else f.update({ result: { commandId: command.commandId, status: outcome, reason: 'fixture-driver-rejection' } });
    const receipt = f.adapter.status().lastCommand;
    reject(new Error('fixture-transport-failure'));
    await assert.rejects(request, /MQTT disconnected|fixture-driver-rejection/);
    assert.deepEqual(f.adapter.status().lastCommand, receipt, 'preserve the actual failure receipt');
  }
});

test('explicit driver expiry rejection completes the attempt without waiting or replaying', async () => {
  const f = garageV2Fixture(); f.update();
  await f.adapter.setControl({ targetC: 5, externalEnabled: true });
  f.at(GARAGE_TEST_AT + 2000);
  f.update({ result: { commandId: f.publications[0].commandId, status: 'rejected', reason: 'challenge-expired' } });
  assert.equal(f.adapter.status().lastCommand.status, 'rejected');
  assert.equal(f.adapter.status().lastCommand.reason, 'challenge-expired');
  assert.equal(f.adapter.status().controlAvailable, true);
  f.at(GARAGE_TEST_AT + 35_000); f.update();
  assert.equal(f.adapter.status().lastCommand.status, 'rejected');
  assert.equal(f.publications.length, 1);
});

test('native OFF and mode choices are explicit; external-owned thermostat and unsupported settings are unavailable', async () => {
  const f = garageV2Fixture(); f.update();
  assert.equal(f.adapter.nativeControls().settings.targetC.available, false);
  assert.equal(f.adapter.nativeControls().settings.wideVane.available, false);
  assert.throws(() => f.adapter.setNativeSetting({ setting: 'targetC', value: 18 }), /Normal target/);
  assert.throws(() => f.adapter.setNativeSetting({ setting: 'fan', value: 'quiet' }), /does not support/);
  await f.adapter.setNativeSetting({ setting: 'power', value: 'off' });
  const sent = f.publications[0];
  assert.equal(sent.action, 'set'); assert.equal(sent.field, 'power'); assert.equal(sent.value, 'off');
  f.at(GARAGE_TEST_AT + 1000);
  f.update({ result: { commandId: sent.commandId, status: 'native-confirmed', reason: null } });
  assert.equal(f.adapter.status().lastCommand.status, 'native-confirmed');
});

test('native target edits respect active heating regulation and independent freeze protection', async () => {
  for (const [mode, externalEnabled, frostActive, frostRescue, allowed] of [
    ['heat', true, false, false, false], ['heat', false, true, false, false],
    ['heat', false, false, true, false], ['cool', false, false, true, false],
    ['cool', true, true, true, false], ['heat', false, false, false, true],
    ['cool', true, false, false, true], ['cool', false, true, false, true],
  ]) {
    const f = garageV2Fixture();
    f.update({ control: { externalEnabled, frostActive, frostRescue },
      native: { mode: { value: mode, measuredAt: GARAGE_TEST_AT - 100 },
        targetC: { value: 17, measuredAt: GARAGE_TEST_AT - 100 } } });
    const target = f.adapter.nativeControls().settings.targetC;
    assert.equal(target.available, allowed, JSON.stringify({ mode, externalEnabled, frostActive, frostRescue }));
    if (allowed) {
      await f.adapter.setNativeSetting({ setting: 'targetC', value: 18 });
      assert.equal(f.publications[0].field, 'targetC');
    } else {
      assert.match(target.reason, frostActive || frostRescue ? /freeze protection/ : /Normal target/);
      assert.throws(() => f.adapter.setNativeSetting({ setting: 'targetC', value: 18 }), /freeze protection|Normal target/);
      assert.equal(f.publications.length, 0);
    }
  }
});

test('stale status does not describe regulation as current, replayed boots and sequences cannot restore authority', () => {
  const f = garageV2Fixture(); f.update();
  assert.equal(f.update({ sequence: 1 }), false);
  f.at(GARAGE_TEST_AT + 120_000);
  assert.equal(f.adapter.status().control, null);
  assert.equal(f.adapter.status().native.power, null);
  assert.equal(f.update({ bootId: 'boot-two', sequence: 1 }), true);
  assert.equal(f.update({ bootId: 'boot-one', sequence: 1000 }), false);
  assert.equal(f.adapter.status().control.targetC, 10);
});

test('read-only authority, retired drivers and persisted formats fail closed', async () => {
  const f = garageV2Fixture({ canControl: () => false }); f.update();
  await assert.rejects(f.adapter.setControl({ targetC: 5, externalEnabled: true }), /read-only/);
  assert.throws(() => garageAdapterSettings({ driver: 'fixture' }), /Unsupported/);
  assert.throws(() => createGarageAdapter({ settings: GARAGE_TEST_ADAPTER, persisted: { version: 1 } }), /Unsupported saved/);
  assert.equal(f.update({ schema: 'shelly-cn105/v1' }), false);
  assert.equal(f.publications.length, 0);
});

test('Pill source temperature stays in diagnostic readback without a duplicate history stream', () => {
  const f = garageV2Fixture(); f.update({ control: { sensorTemperatureC: 0, sensorAgeMs: 60_000 } });
  assert.equal(f.adapter.status().control.sensorTemperatureC, 0);
  assert.equal(f.adapter.status().control.sensorAgeMs, 60_000);
  assert.equal(f.observations.some(row => row.signal === 'garage_temperature'), false);
  assert.equal(f.observations.find(row => row.signal === 'garage_native_power').value, 0);
  f.adapter.setConnected(false);
  assert.equal(f.observations.some(row => row.signal === 'garage_ble_temperature'), false);
});

test('malformed current snapshots reject before startup mutates the database', t => {
  const f = garageV2Fixture(); f.update();
  const valid = f.adapter.snapshot();
  assert.equal(validateGarageAdapterSnapshot(valid), valid);
  for (const change of [
    value => { value.control.targetC = 31.5; },
    value => { value.control.frostActive = 'false'; },
    value => { value.control.status = 'lease'; },
    value => { value.native.power.value = 'unknown'; },
    value => { value.native.power.measuredAt = value.receivedAt + 1; },
    value => { value.health.pump.value = 1; },
    value => { value.observedAt = value.receivedAt + 1; },
    value => { value.electrical.lastEnd = -1; },
  ]) {
    const store = new Store(':memory:'); t.after(() => store.close());
    const value = structuredClone(valid); change(value); store.setState('garage:adapter:mqtt', value);
    const before = store.db.prepare('SELECT total_changes() n').get().n;
    assert.throws(() => new Engine({ store, config: { input: 'mqtt', connections: {} } }), /Unsupported saved Garage adapter/);
    assert.equal(store.db.prepare('SELECT total_changes() n').get().n, before);
  }
});

test('a malformed remote readback clock stays unavailable without corrupting the saved snapshot', () => {
  const f = garageV2Fixture();
  f.update({ readback: { measuredAt: null, ageMs: 9_000_000_000_000 } });
  assert.equal(f.adapter.status().health.pumpCommunicating, false);
  assert.doesNotThrow(() => validateGarageAdapterSnapshot(f.adapter.snapshot()));
});

test('disconnect and restart preserve original recorded readback without restoring live readiness', async () => {
  const f = garageV2Fixture(); f.update();
  const before = f.adapter.snapshot();
  f.at(GARAGE_TEST_AT + 5000); f.adapter.setConnected(false);
  assert.equal(f.adapter.status().control, null);
  assert.equal(f.adapter.status().targetIdentity, null);
  assert.equal(f.adapter.snapshot().observedAt, before.observedAt);
  assert.deepEqual(f.adapter.snapshot().native, before.native);
  const restarted = createGarageAdapter({ settings: GARAGE_TEST_ADAPTER, persisted: f.adapter.snapshot() });
  restarted.setConnected(true);
  assert.equal(restarted.status().control, null);
  assert.equal(restarted.status().health.pumpCommunicating, false);
  assert.deepEqual(restarted.snapshot().native, before.native);
  await restarted.close();
});

function waitingGarageFixture(options = {}) {
  let release, publication;
  const sent = [];
  const f = garageV2Fixture({ ...options, productionTransport: createShellyCn105Transport({ settings: GARAGE_TEST_ADAPTER,
    publish: (_topic, payload, flags) => new Promise((resolve, reject) => {
      publication = flags;
      flags.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      release = () => { try { flags.beforePublish(); sent.push(JSON.parse(payload)); resolve(); } catch (error) { reject(error); } };
    }) }) });
  return { ...f, sent, release: () => release(), flags: () => publication };
}

test('Garage commands wait for storage while preserving current challenge and native checks', async () => {
  for (const action of ['control', 'set']) {
    const f = waitingGarageFixture(); f.update();
    const request = action === 'control' ? f.adapter.setControl({ targetC: 5, externalEnabled: true })
      : f.adapter.setNativeSetting({ setting: 'power', value: 'on' });
    assert.equal(f.sent.length, 0);
    f.release(); await request;
    assert.equal(f.sent.length, 1); assert.equal(f.adapter.status().lastCommand.status, 'published');
    await f.adapter.close();
  }
});

test('Garage storage wait rejects stale, superseded or revoked actions and cannot confirm unsent edits', async () => {
  for (const scenario of ['challenge', 'native-change', 'control-change', 'capability', 'expiry', 'clock-rollback', 'disconnect', 'close', 'authority']) {
    let allowed = true;
    const f = waitingGarageFixture({ canControl: () => allowed }); f.update();
    const request = f.adapter.setNativeSetting({ setting: 'power', value: 'on' });
    const rejected = assert.rejects(request);
    const challenge = { value: 'challenge-1', expiresInMs: 15_000 };
    if (scenario === 'challenge') f.update();
    if (scenario === 'native-change') f.update({ challenge, native: { power: { value: 'on', measuredAt: f.now() } },
      result: { commandId: f.adapter.status().lastCommand.commandId, status: 'native-confirmed' } });
    if (scenario === 'control-change') f.update({ challenge, control: { targetC: 6 } });
    if (scenario === 'capability') f.update({ challenge, capabilities: { manualControls: [] } });
    if (scenario === 'expiry') f.at(GARAGE_TEST_AT + 14_000);
    if (scenario === 'clock-rollback') f.at(GARAGE_TEST_AT - 1);
    if (scenario === 'disconnect') { f.adapter.setConnected(false); f.adapter.setConnected(true); f.update(); }
    if (scenario === 'close') await f.adapter.close();
    if (scenario === 'authority') allowed = false;
    assert.notEqual(f.adapter.status().lastCommand.status, 'native-confirmed');
    f.release(); await rejected;
    assert.equal(f.sent.length, 0, scenario);
    await f.adapter.close();
  }
});
