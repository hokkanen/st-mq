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
  await assert.rejects(f.adapter.setControl({ targetC: 5, externalEnabled: true }), /fresh Pill/);
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

test('Pill source temperature retains its own clock and never masquerades as a garage probe', () => {
  const f = garageV2Fixture(); f.update({ control: { sensorTemperatureC: 0, sensorAgeMs: 60_000 } });
  const row = f.observations.find(row => row.signal === 'garage_ble_temperature');
  assert.equal(row.value, 0); assert.equal(row.sourceTime, GARAGE_TEST_AT - 60_000);
  assert.equal(f.observations.some(row => row.signal === 'garage_temperature'), false);
  assert.equal(f.observations.find(row => row.signal === 'garage_native_power').value, 0);
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
