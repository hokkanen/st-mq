import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurationSource, loadConfig } from '../src/app/config.js';
import { validateOptionFields } from '../src/app/configuration-source.js';
import { garageSettings } from '../src/garage/settings.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { Store } from '../src/storage/store.js';
import { replicaReadModel } from '../src/app/replica-read-model.js';

const manifest = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

test('one bounded Garage travel time defaults to 18 seconds for both doors and directions', () => {
  assert.equal(manifest.options.garage.door_travel_seconds, 18);
  assert.equal(garageSettings().door_travel_seconds, 18);
  for (const seconds of [1, 18, 22.5, 300]) {
    const garage = { door_travel_seconds: seconds };
    validateOptionFields({ garage }, manifest.schema);
    assert.equal(garageSettings(garage).door_travel_seconds, seconds);
  }
  for (const seconds of [null, 0, -1, 0.5, 301, '18', true, NaN, Infinity, {}, []]) {
    const garage = { door_travel_seconds: seconds };
    assert.throws(() => validateOptionFields({ garage }, manifest.schema));
    assert.throws(() => garageSettings(garage));
  }
});

test('sparse travel-time configuration reloads and removing the override restores the shared default', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-door-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.json');
  const options = JSON.stringify({ garage: { door_travel_seconds: 22.5 } });
  writeFileSync(path, options);
  const config = loadConfig({ HOME: directory, STMQ_CONFIG: path }, directory);
  assert.equal(config.garage.door_travel_seconds, 22.5);
  assert.equal(config.garage.enabled, false);
  assert.equal(readFileSync(path, 'utf8'), options);
  writeFileSync(path, '{}');
  const reloaded = (await configurationSource(config).prepare()).config;
  assert.equal(reloaded.garage.door_travel_seconds, 18);
  assert.equal(readFileSync(path, 'utf8'), '{}');
});

test('live and replica status expose configured travel time without manufacturing door evidence', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const now = Date.parse('2026-09-20T12:00:00Z');
  const config = { input: 'mqtt', garage: { door_travel_seconds: 24 }, connections: {} };
  const engine = { latest: {} };
  const runtime = new GarageRuntime({ engine, store, config, clock: () => now });
  const status = runtime.status();
  assert.equal(status.doorTravelSeconds, 24);
  assert.equal(status.doors.garage_door1_open.open, null);
  assert.equal(status.doors.garage_door2_open.open, null);
  assert.equal(status.controlAvailable, false);
  assert.deepEqual(engine.latest, {});
  const snapshot = { store, input: 'mqtt', publication: { sourceAt: now } };
  const recorded = replicaReadModel(snapshot, { ...config, garage: { door_travel_seconds: 18 } }).garage;
  assert.equal(recorded.doorTravelSeconds, 24, 'Replicas use saved source configuration, not the local duration');
  assert.equal(recorded.readOnly, true);
  assert.equal(recorded.nativeControls.available, false);
  assert.deepEqual(engine.latest, {});
});
