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
import { recordChargingSessionCheck } from '../src/app/charging-session-checks.js';
import { recordedCaravanEnergy } from '../src/acquisition/shelly-energy.js';

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

const caravanConfig = { ...config, connections: { equipment: { maxAgeMs: 120_000, devices: [
  { id: 'blu_ht', label: 'Caravan air', area: 'garage', kind: 'temperature', protocol: 'mqtt', enabled: true,
    temperatureSignal: 'caravan_temperature', readings: [{ signal: 'caravan_humidity', label: 'Relative humidity' }] },
  { id: 'caravan', label: 'Caravan energy', area: 'garage', kind: 'metered_switch', protocol: 'shelly', enabled: true, readings: [] },
  { id: 'caravan_dehumidifier', label: 'Dehumidifier', area: 'garage', kind: 'dehumidifier', protocol: 'mqtt', enabled: true,
    stateSignal: 'caravan_dehumidifier_state', readings: [] },
] } } };
const applianceIdentity = 'a'.repeat(64);
const savedPolicy = { signature: 'b'.repeat(64), identity: applianceIdentity, settings: { enabled: true, offAtC: 1, onAtC: 2 } };
const meterState = { version: 3, device: 'synthetic-meter-lineage', day: '2026-05-07', dailyKwh: 0,
  dailyCoveredMs: 60_000, previous: { at: at - 1000, counterKwh: 10 }, reset: false, gap: false };

test('Caravan snapshot projects recorded air, interval power, dated daily energy and bound dashboard choices without native authority', t => {
  const snapshot = fixture(t, store => {
    for (const [signal, value, unit] of [['caravan_temperature', 0, 'degC'], ['caravan_humidity', 55, '%']])
      store.observation(observation('mqtt-equipment', 'blu_ht', signal, value, { unit }));
    store.observation(observation('mqtt-temperature', 'wrong-source', 'caravan_temperature', 99, { unit: 'degC' }));
    store.observation(observation('shelly-mqtt', 'caravan', 'caravan_energy', .01, { unit: 'kWh', raw: {
      intervalStart: at - 80_000, intervalEnd: at - 20_000, durationMs: 60_000, basis: 'meter-counter-delta' } }));
    store.observation(observation('mqtt-equipment', 'caravan_dehumidifier', 'caravan_dehumidifier_state', 3, { raw: { identity: applianceIdentity } }));
    store.setState('shelly:caravan-energy:v2', meterState);
    store.setState('equipment:dehumidifier-temperature-control:v1:caravan_dehumidifier', savedPolicy);
  });
  const [air, energy, appliance] = replicaReadModel(snapshot, caravanConfig).equipment.devices;
  assert.equal(air.readings.caravan_temperature.value, 0, 'Generic MQTT air uses its actual source, retaining zero');
  assert.equal(air.readings.caravan_humidity.value, 55);
  assert.equal(energy.readings.caravan_power.value, .6, '0.01 measured kWh over one minute is 0.6 kW average');
  assert.equal(energy.readings.caravan_power.intervalStart, at - 80_000);
  assert.equal(energy.energy.dailyKwh, 0);
  assert.equal(energy.energy.day, '2026-05-07');
  assert.equal(energy.energy.partial, true);
  assert.deepEqual(appliance.readings.caravan_dehumidifier_state.stateLabels, { 0: 'Off', 1: 'Low', 2: 'Medium', 3: 'High' });
  assert.deepEqual(appliance.recordedSettings.temperatureControl, savedPolicy.settings);
  assert.equal(appliance.dehumidifier, undefined, 'No native capabilities, current qualification or settings are manufactured');
  for (const device of [air, energy, appliance]) {
    assert.equal(device.available, false); assert.equal(device.connected, null);
    assert.equal(device.controls.switch, false); assert.equal(device.controls.dehumidifier, false);
    assert(Object.values(device.readings).every(row => row.readOnly && !row.usableForControl));
  }
  assert.equal(hash(snapshot.path), snapshot.digest);
});

test('Caravan malformed saved sections, identity mismatch and latest gaps cannot replace independent history with defaults or older values', t => {
  const snapshot = fixture(t, store => {
    store.observation(observation('shelly-mqtt', 'caravan', 'caravan_energy', .02, { unit: 'Wh', raw: {
      intervalStart: at - 80_000, intervalEnd: at - 20_000, durationMs: 60_000, basis: 'meter-counter-delta' } }));
    store.observation(observation('mqtt-equipment', 'caravan_dehumidifier', 'caravan_dehumidifier_state', 1, { raw: { identity: applianceIdentity } }));
    store.observation(observation('mqtt-equipment', 'caravan_dehumidifier', 'caravan_dehumidifier_state', null,
      { sourceTime: at - 5000, receivedAt: at - 4000, raw: { identity: applianceIdentity } }));
    store.setState('shelly:caravan-energy:v2', { ...meterState, version: 2 });
    store.setState('equipment:dehumidifier-temperature-control:v1:caravan_dehumidifier', { ...savedPolicy, identity: 'c'.repeat(64) });
  });
  const [, energy, appliance] = replicaReadModel(snapshot, caravanConfig).equipment.devices;
  assert.equal(energy.readings.caravan_power.value, null, 'Wrong-unit energy cannot be interpreted as kWh');
  assert.match(energy.recordedEnergyError, /unavailable/);
  assert.equal(appliance.readings.caravan_dehumidifier_state.value, null);
  assert.equal(appliance.recordedSettings.temperatureControl, null);
  assert.match(appliance.recordedSettings.error, /unavailable/);
  assert.equal(hash(snapshot.path), snapshot.digest);
});

test('recorded Caravan daily totals retain their date through midnight/DST and reject future or unsupported checkpoints', () => {
  for (const [day, end] of [['2026-03-29', '2026-03-29T20:59:00Z'], ['2026-10-25', '2026-10-25T21:59:00Z']]) {
    const timestamp = Date.parse(end), state = { ...meterState, day, dailyKwh: 1.25, previous: { at: timestamp, counterKwh: 11.25 }, reset: true };
    const before = structuredClone(state), result = recordedCaravanEnergy(state, timestamp + 120_000, 120_000);
    assert.equal(result.day, day); assert.equal(result.dailyKwh, 1.25);
    assert.equal(result.counterReset, true); assert.equal(result.partial, true);
    assert.deepEqual(state, before, 'Reading does not advance or reset the saved day');
    assert.throws(() => recordedCaravanEnergy(state, timestamp - 1, 120_000), /unavailable/);
  }
  assert.equal(recordedCaravanEnergy(null, at, 120_000), null);
  assert.throws(() => recordedCaravanEnergy({ ...meterState, version: 2 }, at, 120_000), /Unsupported/);
  assert.throws(() => recordedCaravanEnergy({ ...meterState, retiredField: true }, at, 120_000), /unavailable/);
});

test('replicas retain separate heating and circulation reports without granting control', t => {
  const heating = { command: 'normal', at: at - 1000, status: 'mqtt', sent: true };
  const circulation = { command: 'circulation', at, status: 'failed', sent: false };
  const snapshot = fixture(t, store => {
    store.setState('heating-test:mqtt', circulation);
    store.setState('heating-test:mqtt:heating', heating);
    store.setState('heating-test:mqtt:circulation', circulation);
    store.setState('executor:home', { version: 2, targetBindings: {}, phase: 'normal',
      pulseUntil: 0, expiresAt: null, legacyOutstanding: false, dhwrOutstanding: false,
      dhwrRequested: { on: false, at } });
  });
  const view = replicaReadModel(snapshot, config);
  assert.deepEqual(view.heatingTests.lastResult, circulation);
  assert.deepEqual(view.heatingTests.lastResults, { heating, circulation });
  assert.equal(view.heatingTests.available, false);
  assert.equal(view.dhwr.stopRequestedAt, at);
  assert.equal(view.dhwr.actualOn, null);
  assert.equal(view.dhwr.confirmed, false);
  assert.equal(hash(snapshot.path), snapshot.digest);
});

test('replica garage temperatures keep rear/front names and primary-first order without live authority', t => {
  const snapshot = fixture(t, store => {
    store.observation(observation('shelly-mqtt', 'garage', 'garage_temperature', 12.1, { unit: 'degC' }));
    store.observation(observation('shelly-mqtt', 'garage', 'garage_temperature_2', 12.6, { unit: 'degC' }));
  });
  const settings = { ...config, connections: { equipment: { devices: [{ id: 'garage', label: 'Garage temperatures',
    area: 'garage', kind: 'temperature', protocol: 'shelly', source: 'Shelly', enabled: true,
    temperatureSignal: 'garage_temperature', readings: [{ signal: 'garage_temperature_2', label: 'Garage front' }] }] } } };
  const device = replicaReadModel(snapshot, settings).equipment.devices[0];
  assert.deepEqual(Object.entries(device.readings).map(([signal, row]) => [signal, row.label, row.value]),
    [['garage_temperature', 'Garage rear', 12.1], ['garage_temperature_2', 'Garage front', 12.6]]);
  assert(Object.values(device.readings).every(row => row.recorded && !row.usableForControl));
  assert.equal(hash(snapshot.path), snapshot.digest);
});

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
  assert.equal(result.observedAt, at - 1000);
  assert.equal(result.receivedAt, at - 1000);
  assert.equal(result.sender.receivedAt, at - 1000);
  assert.equal(result.recorded, true);
  assert.equal(result.readOnly, true);
  assert.equal(hash(snapshot.path), snapshot.digest);
});

test('replica electricity uses recorded observations, including zero, without borrowing live-only values or crossing publication', t => {
  const snapshot = fixture(t, store => {
    store.setState('providers:health', { easee: { status: 'ok', lastSuccessAt: at - 60_000 } });
    store.energyAudit({ device: 'fixture-property', signal: 'property_import_energy_counter', value: 123,
      sourceTime: at - 20_000, receivedAt: at - 10_000 });
    store.energyAudit({ device: 'fixture-property', signal: 'property_import_energy_counter', value: 124,
      sourceTime: at - 1000, receivedAt: at + 1 });
    recordChargingSessionCheck(store, { source: 'easee', sessionKey: 'fixture-session',
      start: at - 120_000, end: at - 60_000, referenceKwh: .2, estimatedKwh: .19, complete: true });
    store.observation(observation('easee', 'fixture-equalizer', 'property_energy_l1', .01, { unit: 'kWh' }));
    store.observation(observation('shelly-evse', 'fixture-evse', 'ev2_energy_l1', 0, { unit: 'kWh' }));
    store.observation(observation('shelly-evse', 'fixture-evse', 'ev2_energy_l2', null, { unit: 'kWh', quality: ['missing'] }));
    store.observation(observation('shelly-evse', 'fixture-evse', 'ev2_energy_l1', 1,
      { unit: 'kWh', sourceTime: at + 1, receivedAt: at + 1 }));
    store.observation(observation('shelly-evse', 'fixture-evse', 'ev2_energy_l1', 2,
      { unit: 'kWh', sourceTime: at - 1, receivedAt: at + 1 }));
  });
  const result = replicaReadModel(snapshot, config);
  assert.equal(result.providers.easee.readings.property_energy_l1.value, .01);
  assert.equal(result.providers.easee.readings.property_import_energy_counter.value, 123);
  assert.equal(result.providers.easee.readings.property_import_energy_counter.receivedAt, at - 10_000);
  assert.equal(result.providers.easee.readings.ev1_session_energy_check.value, .2);
  assert.equal(result.providers.easee.readings.ev1_session_energy_check.sourceTime, at - 60_000);
  assert.equal(result.providers.easee.readings.ev1_session_energy_check.receivedAt, null);
  assert.equal(result.providers['shelly-evse'].readings.ev2_energy_l1.value, 0);
  assert.equal(result.providers['shelly-evse'].readings.ev2_energy_l1.sourceTime, at - 20_000);
  assert.equal(result.providers['shelly-evse'].readings.ev2_energy_l2.value, null);
  assert.equal(result.providers['shelly-evse'].readings.ev2_current_l1, undefined);
  assert.equal(result.providers['shelly-evse'].status, 'snapshot');
  assert.equal(result.providers['shelly-evse'].controlReady, false);
  assert.equal(result.providers['shelly-evse'].readings.ev2_energy_l1.available, false);
  assert.equal(hash(snapshot.path), snapshot.digest);
});

test('replica circulation retains compact operation evidence and provenance without inventing watts or live confirmation', t => {
  const snapshot = fixture(t, store => {
    store.observation(observation('shelly-mqtt', 'dhwr', 'dhwr_active', 0,
      { raw: { basis: 'measured-power', timeBasis: 'mqtt-live-status' } }));
  });
  const result = replicaReadModel(snapshot, { ...config, connections: { equipment: { devices: [
    { id: 'dhwr', label: 'Circulation pump', protocol: 'shelly', source: 'Shelly', enabled: true,
      stateSignal: 'dhwr_active', readings: [{ signal: 'dhwr_power' }] },
  ] } } });
  assert.equal(result.equipment.devices[0].protocol, 'shelly');
  assert.equal(result.dhwr.feedback.configured, true);
  assert.equal(result.dhwr.feedback.state.value, 0);
  assert.equal(result.dhwr.feedback.state.observedAt, at - 20_000);
  assert.equal(result.dhwr.feedback.state.receivedAt, at - 10_000);
  assert.equal(result.dhwr.feedback.basis, 'measured-power');
  assert.equal(result.dhwr.feedback.power, null);
  assert.equal(result.dhwr.feedback.available, false);
  assert.equal(result.dhwr.actualOn, null);
  assert.equal(result.dhwr.confirmed, false);
  assert.equal(hash(snapshot.path), snapshot.digest);
});

test('read projection exposes saved settings and equipment evidence without live authority or database changes', t => {
  const snapshot = fixture(t, store => {
    store.setState('settings:mqtt', { comfort: { maxDropC: .5 } });
    store.setState('providers:health', { market: { status: 'ok', lastSuccessAt: at - 60_000,
      connected: true, healthy: true, recording: true }, temperatures: { status: 'ok' } });
    store.setState('garage:mode:mqtt', mode);
    store.event('garage-mode-changed', { mode: 'normal', targetC: 10, commandId: 'fixture-selection' }, mode.changedAt);
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
  assert.deepEqual(result.garage.selectionReceipt, {
    at: mode.changedAt, mode: 'normal', targetC: 10, commandId: 'fixture-selection',
  });
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
  for (const enabled of [false, true]) {
    const result = replicaReadModel(null, { ...config, electricityForecast: { enabled } });
    assert.equal(result.settings.comfort.maxDropC, 1);
    assert.equal(result.readView.settingsSource, 'local-configuration');
    assert.match(result.readView.configurationMessage, /No Home settings were saved/);
    assert.deepEqual(result.h66.readings, {});
    assert.deepEqual(Object.keys(result.providers), ['electricityForecast']);
    const forecast = result.providers.electricityForecast;
    assert.equal(forecast.enabled, enabled);
    assert.equal(forecast.available, false);
    assert.equal(forecast.readOnly, true);
    assert.equal(forecast.status, enabled ? 'read-only' : 'disabled');
    assert.equal(forecast.reason, enabled ? 'read-only-instance' : 'not-enabled');
    for (const clock of ['lastAttemptAt', 'lastSuccessAt', 'nextAttemptAt', 'fetchedAt', 'generatedAt', 'modelUpdatedAt', 'expiresAt'])
      assert.equal(forecast[clock], null, `${clock} cannot imply a forecast acquisition`);
    assert.equal(forecast.intervals, undefined);
    assert.equal(result.garage.requestedTargetC, null);
    assert.equal(result.garage.adapter.native.power, null);
    assert.deepEqual(result.garage.adapter.telemetry, {});
    assert.deepEqual(result.equipment.devices[0].readings, {});
    assert.deepEqual(result.recording.parameters, []);
    assert.deepEqual(result.prices, []);
  }
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
