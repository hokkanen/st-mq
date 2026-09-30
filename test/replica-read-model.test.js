import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { replicaReadModel } from '../src/app/replica-read-model.js';
import { garageSettings } from '../src/garage/settings.js';
import { GARAGE_SENDER_CONTRACT } from '../src/garage/sender.js';

const at = Date.parse('2026-05-07T12:00:00Z');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const config = {
  settings: { comfort: { maxDropC: 1 } }, recording: { annualBudgetBytes: 2e9 },
  connections: { mqtt: { address: 'mqtt://private-config-marker.invalid', pw: 'fixture-private-config-marker' },
    equipment: { devices: [{ id: 'fixture-door', label: 'Fixture door', area: 'garage', kind: 'door',
      protocol: 'mqtt', source: 'MQTT', enabled: true, controlsCover: true,
      stateSignal: 'garage_door', readings: [] }] } },
};

function fixture(t, setup) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-replica-read-model-'));
  const path = join(directory, 'source.sqlite'), source = new Store(path);
  setup?.(source);
  source.close();
  const store = new Store(path, { readOnly: true });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, path, digest: hash(path), input: 'mqtt', publication: { sourceAt: at,
    verifiedAt: at, generation: 'synthetic-publication', bytes: readFileSync(path).length } };
}

const observation = (source, device, signal, value, extra = {}) => ({ source, device, signal, value,
  unit: 'state', sourceTime: at - 20_000, receivedAt: at - 10_000,
  quality: ['good'], raw: { supported: true, timeBasis: 'source-measured' }, ...extra });

const mode = { version: 1, mode: 'normal', normalTargetC: 10, awayTargetC: 5,
  changedAt: at - 5000, warmingWarning: null, adapterKey: 'a'.repeat(64), targetIdentity: 'b'.repeat(64) };
const adapter = (native, observedAt = at - 5000, receivedAt = observedAt) => ({ version: 2,
  contractVersion: 'shelly-cn105/v2', deviceId: 'synthetic-pill', observedAt, receivedAt,
  control: { targetC: 10, externalEnabled: true, effectiveTargetC: 10, status: 'active',
    sensorTemperatureC: 9, sensorAgeMs: 1000, externalTemperatureC: 16, frostAvailable: false, frostActive: false }, native, health: {},
  lastCommand: null, electrical: null, faultRaw: null });

test('recorded frost parameters preserve configured and reported values without claiming live confirmation', t => {
  const configured = garageSettings({ enabled: true, protection: { approved: true } });
  const reported = { ...configured.protection, approved: false };
  const snapshot = fixture(t, store => {
    store.setState('garage:configuration:mqtt', configured);
    store.setState('garage:sender:mqtt', { version: 1, schema: GARAGE_SENDER_CONTRACT, lastCommand: null,
      state: { deviceId: 'fixture-sender', bootId: 'fixture-boot', challenge: 'fixture-challenge', sequence: 1,
        config: reported, observedAt: at - 1000, receivedAt: at - 1000, retained: false,
        protection: { available: false, active: false, minTargetC: null, reason: 'unapproved',
          locations: { rear: { airC: 8, estimatedC: null, uncertain: true }, front: { airC: 7, estimatedC: null, uncertain: true } } } } });
  });
  const result = replicaReadModel(snapshot, config).garage.protection;
  assert.deepEqual(result.configuredSettings, configured.protection);
  assert.deepEqual(result.settings, reported);
  assert.equal(result.configuration.status, 'unknown');
  assert.equal(result.sender.configuration.status, 'unknown');
  assert.equal(result.sender.available, false);
  assert.equal(result.recorded, true);
  assert.equal(result.readOnly, true);
  assert.equal(hash(snapshot.path), snapshot.digest);
});

test('read projection exposes saved settings and equipment evidence without live authority or database changes', t => {
  const snapshot = fixture(t, store => {
    store.setState('settings:mqtt', { comfort: { maxDropC: .5 } });
    store.setState('providers:health', { market: { status: 'ok', lastSuccessAt: at - 60_000,
      connected: true, healthy: true, recording: true }, temperatures: { status: 'ok' } });
    store.setState('garage:mode:mqtt', mode);
    store.setState('garage:adapter:mqtt', adapter({ power: { value: 'off', measuredAt: at - 5000 } }));
    store.observation(observation('husdata-h66', 'fixture-pump', 'room_setting', 20, { unit: '°C' }));
    store.observation(observation('garage-adapter', 'garage-heat-pump', 'garage_compressor_active', 0));
    store.observation(observation('garage-adapter', 'garage-heat-pump', 'garage_native_indoor_temperature', 0, { unit: 'degC' }));
    store.observation(observation('mqtt-equipment', 'fixture-door', 'garage_door', 0));
  });
  const result = replicaReadModel(snapshot, config);
  assert.equal(Object.hasOwn(result.settings, 'mode'), false, 'Read models contain no global control permission');
  assert.equal(result.settings.comfort.maxDropC, .5);
  assert.equal(result.readView.settingsSource, 'recorded-snapshot');
  assert.equal(result.readView.liveAvailable, false);
  assert.equal(result.providers.market.status, 'snapshot');
  assert.equal(result.providers.market.recordedStatus, 'ok');
  assert.equal(result.providers.market.lastSuccessAt, at - 60_000);
  assert.equal(result.providers.market.connected, null);
  assert.equal(result.providers.market.healthy, null);
  assert.equal(result.providers.market.recording, false);
  assert.equal(result.h66.readings['0203'].value, 20);
  assert.equal(result.h66.readings['0203'].observedAt, at - 20_000);
  assert.equal(result.h66.readings['0203'].available, false);
  assert.equal(result.h66.controlsReady, false);
  assert.equal(result.garage.requestedTargetC, 10);
  assert.equal(result.garage.targetConfirmed, false);
  assert.equal(result.garage.mode, 'normal');
  assert.equal(result.garage.adapter.native.power, 'off');
  assert.equal(result.garage.adapter.native.readbacks.power.available, false);
  assert.equal(result.garage.adapter.telemetry.compressorActive.value, false, 'Recorded false does not disappear');
  assert.equal(result.garage.adapter.telemetry.indoorTemperature.value, 0, 'Recorded zero does not disappear');
  assert.equal(result.garage.adapter.telemetry.compressorActive.usable, false);
  assert.equal(result.garage.adapter.authority.owned, false);
  assert.equal(result.garage.heatingControls.available, false);
  for (const field of Object.values(result.garage.nativeControls.settings)) assert.equal(field.available, false);
  for (const capability of [result.garage.heatingControls, result.heatingTests,
    result.equipmentTests, result.equipmentControls, result.dhwr, result.preheatValves]) assert.equal(capability.available, false);
  const door = result.equipment.devices[0];
  assert.equal(door.readings.garage_door.value, 0);
  assert.equal(door.available, false);
  assert.equal(door.connected, null);
  assert.deepEqual(door.controls.cover, { open: false, close: false, stop: false });
  assert.doesNotMatch(JSON.stringify(result), /private-config-marker/);
  assert.deepEqual(replicaReadModel(snapshot, config), result, 'Projection never advances permissions, plans or source clocks');
  assert.equal(hash(snapshot.path), snapshot.digest);
});

test('read projection respects both evidence clocks and the recorded equipment identity', t => {
  const snapshot = fixture(t, store => {
    store.observation(observation('husdata-h66', 'fixture-pump', 'room_setting', 20));
    store.observation(observation('husdata-h66', 'fixture-pump', 'room_setting', 22,
      { sourceTime: at + 1, receivedAt: at + 1 }));
    store.observation(observation('husdata-h66', 'fixture-pump', 'room_setting', 24,
      { sourceTime: at - 1, receivedAt: at + 1 }));
    store.observation(observation('mqtt-equipment', 'fixture-door', 'garage_door', 0));
    store.observation(observation('mqtt-equipment', 'replacement-door', 'garage_door', 1,
      { sourceTime: at - 1000, receivedAt: at - 1000 }));
    store.setState('garage:adapter:mqtt', adapter({ power: { value: 'on', measuredAt: at + 1 } }));
  });
  const result = replicaReadModel(snapshot, config);
  assert.equal(result.h66.readings['0203'].value, 20);
  assert.equal(result.equipment.devices[0].readings.garage_door.value, 0);
  assert.equal(result.garage.adapter.native.power, null);
  assert.equal(hash(snapshot.path), snapshot.digest);
});

test('recording metrics and unmapped equipment remain readable without sampling, pruning or mapping them to controls', t => {
  const snapshot = fixture(t, store => {
    const recorder = new Recorder(store, { clock: () => at - 60_000 });
    recorder.record(observation('shelly-mqtt', 'unmapped-fixture', 'caravan_temperature', 12,
      { unit: 'degC', sourceTime: at - 60_000, receivedAt: at - 60_000 }));
  });
  const result = replicaReadModel(snapshot, { ...config, connections: {} });
  assert.equal(result.recording.exactParameters.length + result.recording.parameters.length, 1);
  assert.equal(result.recording.snapshotAt, at);
  assert.equal(result.recording.readOnly, true);
  const device = result.equipment.devices[0];
  assert.equal(device.configurationSource, 'recorded-evidence');
  assert.equal(device.readings.caravan_temperature.value, 12);
  assert.equal(device.controls.switch, false);
  assert.equal(hash(snapshot.path), snapshot.digest);
});

test('missing snapshot labels local defaults explicitly and invents no saved readings or native capability', () => {
  const result = replicaReadModel(null, config);
  assert.equal(result.settings.comfort.maxDropC, 1);
  assert.equal(result.readView.settingsSource, 'local-configuration');
  assert.match(result.readView.configurationMessage, /No Home settings were saved/);
  assert.deepEqual(result.h66.readings, {});
  assert.deepEqual(result.providers, {});
  assert.equal(result.garage.requestedTargetC, null);
  assert.equal(result.garage.adapter.native.power, null);
  assert.deepEqual(result.garage.adapter.telemetry, {});
  assert.deepEqual(result.equipment.devices[0].readings, {});
  assert.deepEqual(result.recording.parameters, []);
  assert.deepEqual(result.prices, []);
});

test('malformed or retired room intent is unavailable without hiding unrelated recorded history', t => {
  for (const saved of [{ targetC: 10, adapterKey: 'invalid' }, { targetC: 10, adapterKey: 'a'.repeat(64), expiresAt: at },
    { targetC: 4, adapterKey: 'a'.repeat(64) }]) {
    const snapshot = fixture(t, store => {
      store.setState('garage:mode:mqtt', saved);
      store.observation(observation('husdata-h66', 'fixture-pump', 'room_setting', 20));
    });
    const result = replicaReadModel(snapshot, config);
    assert.equal(result.garage.requestedTargetC, null);
    assert(result.garage.errors.some(error => error.section === 'mode'));
    assert.equal(result.garage.nativeControls.settings.targetC.available, false);
    assert.equal(result.h66.readings['0203'].value, 20);
    assert.equal(hash(snapshot.path), snapshot.digest);
  }
});

test('malformed or unsupported Home settings are unavailable without interpreting them or hiding history', t => {
  for (const saved of [{ retiredRoomPreference: 23 }, { comfort: { maxDropC: 'invalid' } }, 'malformed-json']) {
    const snapshot = fixture(t, store => {
      store.setState('settings:mqtt', saved);
      if (saved === 'malformed-json') store.db.prepare('UPDATE state SET value=? WHERE key=?')
        .run('{invalid', 'settings:mqtt');
      store.observation(observation('husdata-h66', 'fixture-pump', 'room_setting', 20));
    });
    const result = replicaReadModel(snapshot, config);
    assert.equal(result.readView.settingsSource, 'local-configuration');
    assert.match(result.readView.settingsError, /saved Home settings are unavailable/);
    assert.match(result.readView.configurationMessage, /computer’s configuration/);
    assert.equal(result.settings.comfort.maxDropC, config.settings.comfort.maxDropC);
    assert.equal(Object.hasOwn(result.settings, 'retiredRoomPreference'), false);
    assert.equal(result.h66.readings['0203'].value, 20);
    assert.equal(hash(snapshot.path), snapshot.digest);
  }
});
