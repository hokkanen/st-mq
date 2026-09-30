import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { mitsubishiControl, mitsubishiResult } from '../chart/mitsubishi.js';
import { garageSettings } from '../src/garage/settings.js';
import { validateGarageModeState } from '../src/garage/room-temperature.js';
import { garageV2Fixture, GARAGE_TEST_AT, GARAGE_TEST_ADAPTER } from './helpers/garage-v2.js';
function fixture(t, options = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const engine = { latest: {}, recorder: { recordEnergy: value => value }, ingest: row => { engine.latest[row.signal] = row; } };
  const config = { input: 'mqtt', garage: { enabled: true, awayTargetC: 5, adapter: GARAGE_TEST_ADAPTER }, connections: {}, ...options.config };
  let runtime = null;
  const f = garageV2Fixture({ onState: value => runtime?.adapterChanged(value) });
  const recreate = () => { runtime = new GarageRuntime({ engine, store, config, clock: f.now, canControl: () => true }); runtime.setAdapter(f.adapter); return runtime; };
  recreate(); f.update();
  return { ...f, engine, store, config, runtime, recreate };
}

test('Away is explicit and indefinite, Normal target survives reboot, and neither selection forces power on', async t => {
  const f = fixture(t);
  assert.equal(f.runtime.status().normalTargetC, 10);
  assert.equal(f.runtime.status().mode, 'normal');
  await f.runtime.setHeating({ mode: 'away' });
  assert.equal(f.runtime.status().mode, 'away'); assert.equal(f.runtime.status().requestedTargetC, 5);
  assert.equal(f.runtime.status().targetConfirmed, false);
  f.update({ control: { targetC: 5, effectiveTargetC: 5 } });
  assert.equal(f.runtime.status().targetConfirmed, true);
  f.at(GARAGE_TEST_AT + 7 * 86_400_000);
  const restarted = f.recreate();
  f.update({ control: { targetC: 5, effectiveTargetC: 5 } }); restarted.tick();
  assert.equal(restarted.status().mode, 'away'); assert.equal(restarted.status().normalTargetC, 10);
  assert.equal(f.publications.length, 1);
  await restarted.setHeating({ mode: 'normal' });
  assert.equal(f.publications.at(-1).targetC, 10);
  assert(f.publications.every(command => command.action === 'control'));
  assert.equal(restarted.status().warmingWarning.toC, 10);
  assert.equal(f.adapter.status().native.power, 'off');
});

test('warming advisory survives restart and expires independently from mode; lowering temperature does not erase it', async t => {
  const f = fixture(t); await f.runtime.setHeating({ mode: 'normal', targetC: 12 });
  f.update({ control: { targetC: 12, effectiveTargetC: 12 } });
  const warning = f.runtime.status().warmingWarning;
  f.at(GARAGE_TEST_AT + 1000); f.update({ control: { targetC: 12, effectiveTargetC: 12 } });
  await f.runtime.setHeating({ mode: 'away' });
  assert.deepEqual(f.runtime.status().warmingWarning, warning);
  const next = f.recreate();
  assert.deepEqual(next.status().warmingWarning, warning);
  f.at(warning.until); next.tick();
  assert.equal(next.status().warmingWarning, null); assert.equal(next.status().mode, 'away');
});

test('Pill fallback or frost-induced target rise also produces an advisory without issuing a host command', t => {
  const f = fixture(t); f.update({ control: { effectiveTargetC: 16, status: 'sensor-stale' } });
  assert.equal(f.runtime.status().warmingWarning.toC, 16);
  assert.equal(f.publications.length, 0);
  assert.equal(f.runtime.status().protection.available, false);
});

test('equipment identity changes discard authority and bootstrap only from fresh device readback', async t => {
  const f = fixture(t); await f.runtime.setHeating({ mode: 'away' });
  f.update({ deviceId: 'replacement-pill', bootId: 'replacement-boot', control: { targetC: 9, effectiveTargetC: 9 } });
  assert.equal(f.runtime.status().mode, null);
  assert.equal(f.publications.length, 1);
  await f.runtime.setHeating({ mode: 'normal' });
  assert.equal(f.runtime.status().normalTargetC, 9); assert.equal(f.publications.at(-1).targetC, 9);
});

test('current settings reject price automation and expiring modes', async t => {
  const f = fixture(t);
  assert.throws(() => garageSettings({ savingsStrategy: 'balanced' }), /Unknown/);
  assert.throws(() => garageSettings({ minOnMs: 300_000 }), /Unknown/);
  await assert.rejects(f.runtime.setHeating({ mode: 'away', expiresAt: GARAGE_TEST_AT + 1000 }), /Choose Normal or Away/);
  await assert.rejects(f.runtime.setHeating({ mode: 'off' }), /Choose Normal or Away/);
  assert.throws(() => validateGarageModeState({ targetC: 10 }), /Unsupported/);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM learning_journal WHERE input LIKE 'garage:%'").get().n, 0);
});

test('actual backend status enables supported native UI controls and reports confirmed edits', async t => {
  const f = fixture(t);
  const status = () => ({ now: f.now(), input: 'mqtt', garage: f.runtime.status() });
  assert.equal(mitsubishiControl(status(), 'power').available, true);
  assert.equal(mitsubishiControl(status(), 'fan').available, true);
  assert.equal(mitsubishiControl(status(), 'fan').usable, true);
  assert.equal(mitsubishiControl(status(), 'power').usable, true);
  assert.equal(mitsubishiControl(status(), 'power').value, 'off');
  assert.equal(mitsubishiControl(status(), 'wideVane').available, false);
  assert.equal(mitsubishiControl(status(), 'targetC').available, false);
  await f.runtime.setNativeSettings({ setting: 'fan', value: 2 });
  assert.equal(mitsubishiControl(status(), 'power').available, false);
  assert.match(mitsubishiResult(status().garage.nativeControls.result, status().now), /Fan setting: 2.*waiting/);
  f.update({ result: { commandId: f.publications[0].commandId, status: 'native-confirmed', reason: null } });
  assert.match(mitsubishiResult(status().garage.nativeControls.result, status().now), /Fan setting: 2.*Confirmed by the pump/);
  assert.equal(mitsubishiControl(status(), 'power').available, true);
});

test('changing Away preset or telemetry limits never changes a running target or loses the saved Normal choice', async t => {
  const f = fixture(t);
  await f.runtime.setHeating({ mode: 'away' });
  f.update({ control: { targetC: 5, effectiveTargetC: 5 } });
  f.config.garage = { ...f.config.garage, awayTargetC: 3,
    adapter: { ...f.config.garage.adapter, maxAgeMs: 90_000, electricalSource: 'native-counter' } };
  const next = f.recreate();
  assert.equal(next.status().mode, 'away');
  assert.equal(next.status().normalTargetC, 10);
  assert.equal(next.status().awayTargetC, 3, 'The button offers the newly configured preset.');
  assert.equal(next.status().requestedTargetC, 5, 'The running selection retains its original target.');
  assert.equal(f.publications.length, 1);
  await next.setHeating({ mode: 'away' });
  assert.equal(f.publications.at(-1).targetC, 3, 'Only the explicit selection applies the new preset.');
});
