import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingConfiguration } from '../src/charging/config.js';
import { chargingSettings } from '../src/charging/settings.js';
import { teslamateConfiguration } from '../src/app/config.js';
test('physical EVSE defaults keep uncommissioned Shelly control disabled', () => {
  const config = chargingConfiguration();
  assert.equal(config.chargers.charger2.enabled, false);
  assert.equal(config.chargers.charger2.verified, false);
  assert.equal(config.chargers.charger2.fallbackCurrentA, 12);
  assert.deepEqual(chargingConfiguration(config), config);
  assert.equal(config.vehicles.bmw.mqttTopic, 'stmq/vehicles/bmw');
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
test('priority and usable capacity belong to explicit current settings', () => {
  const settings = chargingSettings({priority:'charger2',vehicles:{tesla:{capacityKwh:61}}});
  assert.equal(settings.priority,'charger2'); assert.equal(settings.vehicles.tesla.capacityKwh,61);
  assert.throws(() => chargingSettings({priority:'tesla'}));
});
