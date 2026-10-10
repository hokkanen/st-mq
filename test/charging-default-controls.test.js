import { readChargingRuntime, writeChargingRuntime } from '../src/charging/runtime-storage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { ChargingRuntime } from '../src/charging/runtime.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-defaults-'));
  const path = join(directory, 'current.sqlite');
  const config = { input: 'mqtt', connections: {
    easee: { charger_id: 'synthetic-default-easee', equalizer_id: 'synthetic-default-equalizer' },
    mqtt: { address: 'mqtt://synthetic-default.invalid' },
  }, charging: { defaults: { readyBy: '07:15', minimumSoc: 85 }, chargers: {
    charger2: { enabled: true, deviceId: 'synthetic-default-shelly', topicPrefix: 'synthetic/default/shelly' },
  } } };
  let store = new Store(path), runtime;
  const create = () => runtime = new ChargingRuntime({ store, config, engine: {},
    clock: () => Date.parse('2026-10-09T10:00:00Z') });
  const restart = async () => { await runtime.close(); store.close(); store = new Store(path); return create(); };
  t.after(async () => { await runtime?.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { config, create, restart, get store() { return store; } };
}

test('fresh charging state initializes Automatic ON for both equipment identities and persists the choices', async t => {
  const f = fixture(t), runtime = f.create();
  for (const view of runtime.status().chargers) {
    assert.equal(view.controls.enabled, true);
    assert.equal(view.settings.enabled, true);
    assert.equal(view.settings.readyBy, '07:15');
    assert.equal(view.settings.minimumSoc, 85);
    assert.equal(view.request, null, 'The default does not invent a physical connection');
  }
  assert.equal(runtime.settings.priority, 'balanced');
  await runtime.write(() => runtime.persist());
  const restarted = await f.restart();
  assert.equal(restarted.settings.chargers.charger1.enabled, true);
  assert.equal(restarted.settings.chargers.charger2.enabled, true);
  assert.deepEqual(readChargingRuntime(f.store, runtime.key).chargers.charger2.controls, { enabled: true, revision: 0 });
});

test('saved Automatic OFF survives restart and replacement equipment receives no initial ON permission', async t => {
  const f = fixture(t), runtime = f.create(), first = runtime.chargers.charger1;
  await runtime.setControl('charger1', { association: first.association, revision: first.controls.revision, enabled: false });
  const restarted = await f.restart();
  assert.equal(restarted.settings.chargers.charger1.enabled, false);
  assert.equal(restarted.settings.chargers.charger2.enabled, true);
  f.config.charging.chargers.charger2.deviceId = 'synthetic-replacement-shelly';
  const replaced = await f.restart();
  assert.equal(replaced.settings.chargers.charger1.enabled, false);
  assert.equal(replaced.settings.chargers.charger2.enabled, false);
});

test('a different input environment cannot acquire fresh-start Automatic permission from an existing database', async t => {
  for (const input of ['mqtt', 'providers', 'simulated', 'offline']) await t.test(input, async t => {
    const f = fixture(t);
    f.config.input = input;
    const runtime = f.create(), first = runtime.chargers.charger1;
    // Seed the supported format directly: offline/simulation has no live
    // dashboard command authority, but its recorded choices still exist.
    first.controls.enabled = false;
    runtime.refreshSettings();
    await runtime.write(() => runtime.persist());
    f.config.input = input === 'mqtt' ? 'providers' : 'mqtt';
    const changed = await f.restart();
    assert.equal(changed.settings.chargers.charger1.enabled, false);
    assert.equal(changed.settings.chargers.charger2.enabled, false);
    assert.equal(f.store.getState(changed.key), null, 'The new namespace has no saved permission');
    assert.equal(readChargingRuntime(f.store, runtime.key).chargers.charger1.controls.enabled, false);
  });
});

test('malformed empty state is rejected and omitted current controls cannot acquire first-start permission', async t => {
  for (const saved of [null, {}, { version: 6 }]) await t.test(JSON.stringify(saved), async t => {
    const f = fixture(t);
    f.store.setState('charging:mqtt', saved);
    assert.throws(() => f.create(), /Unsupported or incomplete charging state/);
    assert.deepEqual(f.store.getState('charging:mqtt'), saved, 'Rejection does not rewrite the saved record');
  });
  const f = fixture(t), runtime = f.create();
  await runtime.write(() => runtime.persist());
  const saved = readChargingRuntime(f.store, runtime.key);
  delete saved.chargers.charger1.controls;
  writeChargingRuntime(f.store, runtime.key, saved);
  const restarted = await f.restart();
  assert.equal(restarted.settings.chargers.charger1.enabled, false);
  assert.equal(restarted.settings.chargers.charger2.enabled, true);
});

test('invalid persisted controls cannot acquire the initial Automatic ON default', async t => {
  const f = fixture(t), runtime = f.create();
  await runtime.write(() => runtime.persist());
  const saved = readChargingRuntime(f.store, runtime.key);
  saved.chargers.charger1.controls.enabled = 'true';
  const key = `${runtime.key}:runtime:charger/charger1/controls`;
  f.store.setState(key, { value: saved.chargers.charger1.controls });
  assert.throws(() => f.create(), /Unsupported saved charging controls/);
  assert.deepEqual(f.store.getState(key), { value: saved.chargers.charger1.controls });
});
