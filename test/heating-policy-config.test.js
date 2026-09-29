import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSettings, controlConfiguration, loadConfig, configurationSource } from '../src/app/config.js';
import { HEATING_STRATEGIES, heatingStrategy } from '../src/domain/heating-strategy.js';
import { garageSettings } from '../src/garage/settings.js';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { floorOverrideConfiguration } from '../src/control/floor-override.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';

const floorMapping = { storage: { topic_prefix: 'invented-floor-storage' }, living: { topic_prefix: 'invented-floor-living' } };

test('Home defaults to Balanced and Garage rejects every automatic savings strategy', () => {
  assert.equal(validateSettings().savingsStrategy, 'balanced');
  assert.equal(Object.hasOwn(garageSettings(), 'savingsStrategy'), false);
  assert.equal(heatingStrategy().id, 'balanced');
  for (const { id } of HEATING_STRATEGIES) assert.throws(() => garageSettings({ savingsStrategy: id }), /Unknown garage setting/);
  for (const value of [0, 50, 100, 'conservative', 'Balanced', '', null, false, {}]) {
    assert.throws(() => garageSettings({ savingsStrategy: value }));
    assert.throws(() => heatingStrategy(value));
  }
  assert.throws(() => validateSettings({ savingsAggressiveness: 50 }), /Unknown heating setting/);
  assert.throws(() => validateSettings({ savingsStrategy: 'balanced', savingsAggressiveness: 50 }), /Unknown heating setting/);
  assert.throws(() => garageSettings({ aggressiveness: 50 }), /Unknown garage setting/);
  assert.throws(() => garageSettings({ frontRequired: false }), /Unknown garage setting/);
  assert.throws(() => controlConfiguration({ savings_aggressiveness: 50 }), /Unknown controller setting/);
});

test('configuration startup and reload accept named strategies and reject retired fields without rewriting sources', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-heating-strategy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.json');
  const write = value => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  write({ controller: { savings_strategy: 'gentle' }, garage: { awayTargetC: 5 } });
  const config = loadConfig({ STMQ_CONFIG: path }, directory);
  assert.equal(config.settings.savingsStrategy, 'gentle');
  assert.equal(config.garage.awayTargetC, 5);
  const source = configurationSource(config);
  write({ controller: { savings_strategy: 'savings' }, garage: { awayTargetC: 3 } });
  const prepared = await source.prepare();
  assert.equal(prepared.config.settings.savingsStrategy, 'savings');
  assert.equal(prepared.config.garage.awayTargetC, 3);
  for (const value of [
    { controller: { savings_aggressiveness: 50 } }, { garage: { aggressiveness: 50 } },
    { controller: { savings_strategy: 50 } }, { garage: { savingsStrategy: 'unknown' } },
  ]) {
    write(value);
    const original = readFileSync(path, 'utf8');
    assert.throws(() => loadConfig({ STMQ_CONFIG: path }, directory), /configuration field/);
    await assert.rejects(source.prepare(), /configuration field/);
    assert.equal(readFileSync(path, 'utf8'), original);
  }
});

test('retired persisted home settings are rejected before any database mutation', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.setState('settings:offline', { savingsAggressiveness: 50 });
  const before = store.db.prepare('SELECT * FROM state ORDER BY key').all();
  assert.throws(() => new Engine({ store, config: { input: 'offline', settings: validateSettings() } }), /saved heating settings.*fresh development database/);
  assert.deepEqual(store.db.prepare('SELECT * FROM state ORDER BY key').all(), before);
});

test('heating preference boundaries preserve hard temperature limits and baseline-relative ROOM units', () => {
  for (const savingsStrategy of ['gentle', 'balanced', 'savings']) {
    const value = validateSettings({ savingsStrategy });
    assert.equal(value.savingsStrategy, savingsStrategy);
    assert.equal(value.comfort.maxRiseC, 1.5);
    assert.equal(value.comfort.maxDropC, 1.5);
    assert.equal(value.preheatRoomBoostC, 5);
  }
  for (const value of [0, 50, 100, 'conservative', 'Balanced', '', null, false, {}, NaN, Infinity]) assert.throws(() => validateSettings({ savingsStrategy: value }));
  for (const maxRiseC of [0.25, 1, 2]) assert.equal(validateSettings({ comfort: { maxRiseC } }).comfort.maxRiseC, maxRiseC);
  for (const maxRiseC of [0, 0.24, 2.01, '1', Infinity]) assert.throws(() => validateSettings({ comfort: { maxRiseC } }));
  for (const preheatRoomBoostC of [1, 3, 5]) {
    assert.equal(validateSettings({ preheatRoomBoostC }).preheatRoomBoostC, preheatRoomBoostC);
    assert.equal(controlConfiguration({ preheat_room_boost_c: preheatRoomBoostC }).preheatRoomBoostC, preheatRoomBoostC);
  }
  for (const value of [0, 6, 2.5, '5']) {
    assert.throws(() => validateSettings({ preheatRoomBoostC: value }));
    assert.throws(() => controlConfiguration({ preheat_room_boost_c: value }));
  }
});

test('one bounded recovery hold configures hot-water restrictions and optional AUX restriction', () => {
  assert.equal(controlConfiguration().recoveryHoldMinutes, 60);
  assert.equal(controlConfiguration().recoveryCompressorOnly, true);
  for (const recoveryHoldMinutes of [1, 60, 240]) {
    const value = controlConfiguration({ recovery_hold_minutes: recoveryHoldMinutes, recovery_compressor_only: false });
    assert.equal(value.recoveryHoldMinutes, recoveryHoldMinutes);
    assert.equal(value.recoveryCompressorOnly, false);
  }
  for (const value of [0, 241, 1.5, '60', null, Infinity])
    assert.throws(() => controlConfiguration({ recovery_hold_minutes: value }));
});

test('floor control has strict flags, two exclusive device mappings and bounded renewal periods', () => {
  for (const key of ['enabled', 'commissioned']) for (const value of ['true', 'false', 0, 1, null, []])
    assert.throws(() => floorOverrideConfiguration({ ...floorMapping, [key]: value }));
  for (const value of [null, [], 'configuration']) assert.throws(() => floorOverrideConfiguration(value));
  assert.throws(() => floorOverrideConfiguration({ storage: 'invented-device' }));
  assert.throws(() => floorOverrideConfiguration({ enabled: true, storage: floorMapping.storage }));
  for (const prefix of ['invented-floor-storage', 'invented-floor-storage/child'])
    assert.throws(() => floorOverrideConfiguration({ storage: floorMapping.storage, living: { topic_prefix: prefix } }));
  for (const prefix of ['invented/#', 'invented/+', ' invented', 'invented with space', '/invented', 'invented/'])
    assert.throws(() => floorOverrideConfiguration({ storage: { topic_prefix: prefix } }));
  for (const values of [{ renew_seconds: 29 }, { renew_seconds: 451 }, { renew_seconds: '300' }, { renew_seconds: null },
    { lease_seconds: 901 }, { lease_seconds: null }, { renew_seconds: 300, lease_seconds: 599 }])
    assert.throws(() => floorOverrideConfiguration(values));
  assert.equal(floorOverrideConfiguration({ renew_seconds: 30, lease_seconds: 60 }).leaseSeconds, 60);
  assert.equal(floorOverrideConfiguration({ renew_seconds: 450, lease_seconds: 900 }).renewSeconds, 450);
});

test('public defaults expose floor thermal priors while physical overrides stay disabled', () => {
  const publicConfig = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.deepEqual(publicConfig.options.controller.floor_thermal_priors, {
    capacity_kwh_per_c: 3.2, exchange_kw_per_c: 0.266667, ground_loss_kw_per_c: 0.013596,
    ground_c: 10, open_allocation_fraction: 0.4, closed_allocation_fraction: 0.05,
    native_capacity_kwh_per_c: 8.832,
  });
  const model = initialAdaptiveModel(controlConfiguration(publicConfig.options.controller));
  assert.equal(model.floor.enabled, true);
  assert.equal(model.floor.capacityKwhPerC, 3.2);
  assert.equal(model.floor.nativeCapacityKwhPerC, 8.832);
  assert.equal(publicConfig.options.controller.floor_preheat.enabled, false);
  assert.equal(publicConfig.options.controller.floor_preheat.commissioned, false);
  assert.equal(publicConfig.options.controller.floor_preheat.storage.topic_prefix, '');
  assert.equal(publicConfig.options.controller.floor_preheat.living.topic_prefix, '');
  assert.equal(publicConfig.schema.controller.floor_preheat.lease_seconds, 'int(60,900)');
  assert.equal(controlConfiguration().floorThermalPriors, undefined);
  assert.equal(initialAdaptiveModel(controlConfiguration()).floor.enabled, false);
});

test('private thermal priors load into physical model assumptions without silently fitting them', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-thermal-prior-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.json');
  const options = { controller: { input: 'simulated', savings_strategy: 'gentle', max_rise_c: 0.5,
    preheat_room_boost_c: 4, heat_pump_model_confirmed: true,
    floor_thermal_priors: { capacity_kwh_per_c: 2.4, native_capacity_kwh_per_c: 6,
      exchange_kw_per_c: 0.2, ground_loss_kw_per_c: 0.03, ground_c: 9,
      open_allocation_fraction: 0.45, closed_allocation_fraction: 0.04 },
    floor_preheat: { enabled: false, commissioned: false, ...floorMapping },
  } };
  const original = JSON.stringify(options); writeFileSync(path, original, { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: path }, directory);
  assert.equal(config.settings.savingsStrategy, 'gentle');
  assert.equal(config.settings.comfort.maxRiseC, 0.5);
  assert.equal(config.control.preheatRoomBoostC, 4);
  assert.equal(config.control.heatPumpModelConfirmed, true);
  const model = initialAdaptiveModel(config.control);
  assert.equal(model.floor.enabled, true);
  assert.equal(model.floor.capacityKwhPerC, 2.4);
  assert.equal(model.floor.nativeCapacityKwhPerC, 6);
  assert.equal(model.floor.groundC, 9);
  assert.equal(model.floor.openAllocationFraction, 0.45);
  assert.equal(model.floor.storageParameterFitted, false);
  assert.equal(JSON.stringify(config.control).includes('invented-floor'), false, 'Thermal learning configuration excludes transport identities');
  assert.equal(readFileSync(path, 'utf8'), original, 'Validation does not rewrite private configuration');
});

test('invalid thermal prior units and names are rejected before model construction', () => {
  for (const floor_thermal_priors of [
    { capacity_kwh_per_c: 0 }, { capacity_kwh_per_c: -1 }, { capacity_kwh_per_c: '2' },
    { capacity_kwh_per_c: 2, open_allocation_fraction: 1.01 },
    { capacity_kwh_per_c: 2, closed_allocation_fraction: -0.1 },
    { capacity_kwh_per_c: 2, unknown_parameter: 1 },
  ]) assert.throws(() => controlConfiguration({ floor_thermal_priors }));
  for (const heat_pump_model_confirmed of ['true', 1, null]) assert.throws(() => controlConfiguration({ heat_pump_model_confirmed }));
});

test('configured priors are preserved exactly instead of accepted then silently clamped', () => {
  for (const prior of [
    { capacity_kwh_per_c: 0.01 },
    { capacity_kwh_per_c: 2, native_capacity_kwh_per_c: 0 },
    { capacity_kwh_per_c: 2, exchange_kw_per_c: 0 },
    { capacity_kwh_per_c: 2, ground_loss_kw_per_c: 11 },
    { capacity_kwh_per_c: 2, ground_c: 26 },
    [], 'invalid',
  ]) assert.throws(() => controlConfiguration({ floor_thermal_priors: prior }));
  const control = controlConfiguration({ floor_thermal_priors: { capacity_kwh_per_c: 2, ground_c: -3 } });
  assert.equal(initialAdaptiveModel(control).floor.groundC, -3);
});

test('live floor mappings cannot share another control role or omit their MQTT broker', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-floor-role-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.json');
  const base = { controller: { input: 'providers', floor_preheat: { enabled: true, commissioned: false, ...floorMapping } },
    mqtt: { address: 'mqtt://invented.invalid' }, equipment: { devices: [] } };
  const read = options => {
    writeFileSync(path, JSON.stringify(options), { mode: 0o600 });
    return loadConfig({ STMQ_CONFIG: path }, directory);
  };
  assert.equal(read(base).floorPreheat.devices.length, 2);
  for (const extra of [
    { equipment: { devices: [{ id: 'fixture', kind: 'switch', connection: 'shelly:invented-floor-storage', switch_control: true }] } },
    { equipment: { devices: [{ id: 'fixture', kind: 'switch', connection: 'mqtt:invented/other-state', switch_control: true,
      mqtt: { command_topic: 'invented-floor-storage/command/switch:0', on_payload: 'ON', off_payload: 'OFF' } }] } },
    { mqtt: { address: 'mqtt://invented.invalid', dhwr_topic: 'invented-floor-storage/command/switch:0' } },
  ]) assert.throws(() => read({ ...base, ...extra }), /dedicated MQTT prefixes/);
  assert.throws(() => read({ ...base, mqtt: { address: '' } }), /MQTT broker/);
});
