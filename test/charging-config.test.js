import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingConfiguration } from '../src/charging/config.js';
import { chargingSettings, chargingSettingsFromConfiguration } from '../src/charging/settings.js';
import { teslamateConfiguration } from '../src/app/config.js';
test('physical EVSE defaults keep acquisition disabled and discover control readiness', () => {
  const config = chargingConfiguration();
  assert.equal(config.chargers.charger2.enabled, false);
  assert.equal(Object.hasOwn(config.chargers.charger2, 'verified'), false);
  assert.equal(Object.hasOwn(config.chargers.charger2, 'sessionEnergyVerified'), false);
  assert.equal(config.chargers.charger2.fallbackCurrentA, 12);
  assert.deepEqual(chargingConfiguration(config), config);
  assert.equal(config.vehicles.bmw.mqttTopic, 'stmq/vehicles/bmw');
});
test('retired Shelly commissioning assertions are rejected even when disabled', () => {
  for (const key of ['sessionEnergyVerified', 'verified', 'model', 'firmware', 'connectedStates', 'disconnectedStates', 'chargingStates', 'minimumCurrentA', 'currentStepA'])
    for (const value of [false, true, 'true', null])
    assert.throws(() => chargingConfiguration({ chargers: { charger2: { [key]: value } } }),
      /current physical-EVSE configuration/);
});
test('completed report retention is a bounded configuration default, independent of charging settings', () => {
  assert.equal(chargingConfiguration().report_retention_days, 30);
  for (const days of [1, 90, 3650]) assert.equal(chargingConfiguration({ report_retention_days: days }).report_retention_days, days);
  for (const days of [0, -1, 3651, 1.5, '30', null, false])
    assert.throws(() => chargingConfiguration({ report_retention_days: days }), /report_retention_days/);
  assert.equal(Object.hasOwn(chargingSettingsFromConfiguration(chargingConfiguration({ report_retention_days: 90 })), 'report_retention_days'), false);
});
test('retired vehicle-on-charger topics, efficiencies, assignment aliases and settings fail closed', () => {
  for (const field of [{mqttTopic:'test/vehicle'}, {efficiency:.925}, {vehicleId:'test'}])
    for (const id of ['charger1','charger2']) assert.throws(() => chargingConfiguration({chargers:{[id]:field}}));
  for (const field of [{car_id:'1'}, {chargerAssignment:'easee'}, {charger_identification:true}, {max_age_seconds:180}])
    assert.throws(() => teslamateConfiguration(field));
  assert.throws(() => chargingSettings({capacity1Kwh:74}));
});
test('installation safety inputs, disjoint working states and concrete routes are validated', () => {
  for (const field of [{phaseMap:[0,0,1]}, {minimumCurrentA:3}, {minimumCurrentA:8}, {currentStepA:2}, {mainFuseA:[0,0,0]}, {verified:true},
    {enabled:true}, {topicPrefix:'test/#'}, {maxAgeMs:600001}, {connectedStates:['charging'],chargingStates:['charging']}])
    assert.throws(() => chargingConfiguration({chargers:{charger2:field}}));
  assert.throws(() => chargingConfiguration({vehicles:{bmw:{mqttTopic:'cars/#'}}}));
});
test('configuration owns shared unidentified defaults and sparse vehicle defaults independently of the charging point', () => {
  const config = chargingConfiguration({ defaults: { readyBy: '07:15', minimumSoc: 85, capacityKwh: 65 },
    vehicles: { tesla: { defaults: { capacityKwh: 61, manualSoc: 30 } }, bmw: { defaults: { minimumSoc: 90 } } } });
  const settings = chargingSettingsFromConfiguration(config, { priority: 'charger2', chargers: { charger1: { enabled: true } } });
  assert.equal(settings.priority, 'charger2');
  assert.deepEqual(settings.chargers.charger1, { enabled: true, readyBy: '07:15', manualSoc: 20, minimumSoc: 85, capacityKwh: 65 });
  assert.deepEqual(settings.chargers.charger2, { ...settings.chargers.charger1, enabled: false });
  assert.deepEqual(settings.vehicles.tesla, { readyBy: '07:15', manualSoc: 30, minimumSoc: 85, capacityKwh: 61 });
  assert.deepEqual(settings.vehicles.bmw, { readyBy: '07:15', manualSoc: 20, minimumSoc: 90, capacityKwh: 74 });
  assert.equal(config.chargers.charger2.enabled, false);
  assert.deepEqual(chargingConfiguration(config), config);
  assert.equal(chargingSettingsFromConfiguration(config).priority, 'balanced');
  assert.equal(chargingSettingsFromConfiguration(config).chargers.charger1.enabled, false);
});
test('charging default paths validate values and reject retired durable preference fields', () => {
  for (const defaults of [{ readyBy: '24:01' }, { readyBy: 600 }, { manualSoc: -1 }, { minimumSoc: 101 },
    { capacityKwh: 0 }, { capacityKwh: 301 }, { enabled: true }, { unknown: 1 }]) {
    assert.throws(() => chargingConfiguration({ defaults }));
    assert.throws(() => chargingConfiguration({ vehicles: { tesla: { defaults } } }));
  }
  for (const invalid of [{ priority: 'balanced' }, { priority: 'tesla' }, { chargers: { charger1: { enabled: true } } },
    { chargers: { charger1: { schedulingEnabled: false } } }, { chargers: { charger2: { schedulingEnabled: true } } },
    { vehicles: { tesla: { capacityKwh: 61 } } }])
    assert.throws(() => chargingConfiguration(invalid));
});
