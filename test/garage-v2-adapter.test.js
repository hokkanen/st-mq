import test from 'node:test';
import assert from 'node:assert/strict';
import { garageV2Fixture, GARAGE_TEST_AT, GARAGE_TEST_ADAPTER } from './helpers/garage-v2.js';
import { createGarageAdapter } from '../src/garage/adapter.js';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { garageAdapterSettings, validateGarageAdapterSnapshot } from '../src/garage/contract.js';

test('v2 requires fresh native readback and retained state never grants authority', async () => {
  const f = garageV2Fixture();
  assert.equal(f.update({}, { retain: true }), false);
  await assert.rejects(f.adapter.setControl({ targetC: 5, externalEnabled: true }), /fresh heat-pump controller status/);
  assert.equal(f.update({ health: { nativeFresh: false } }), true);
  await assert.rejects(f.adapter.setControl({ targetC: 5, externalEnabled: true }), /communication/);
  f.update(); assert.equal(f.adapter.status().controlAvailable, true);
  await f.adapter.setControl({ targetC: 5, externalEnabled: true });
  assert.equal(f.publications.length, 1);
  assert.deepEqual(f.publications[0].settings, { qos: 0, retain: false, noReplay: true });
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
