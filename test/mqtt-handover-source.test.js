import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createChargingTeslaCapture } from '../src/charging/teslamate.js';
import { createShellyController } from '../src/charging/shelly-evse.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { mqttRouting } from '../src/acquisition/mqtt-routing.js';
import { createMqttSourceContext, mqttSourceIdentity } from '../src/pairing/mqtt-source-context.js';
import { HeatingAutomation } from '../src/app/automation.js';
import { GarageRuntime } from '../src/garage/runtime.js';

const initial = Date.parse('2026-10-05T12:00:00Z');

test('verified HA to Ubuntu to HA handover preserves current controls, native holds, source clocks and consumed episodes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-source-roundtrip-'));
  const store = new Store(join(directory, 'current.sqlite'));
  const runtimes = [], captures = [], controllers = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    for (const capture of captures) capture.close();
    for (const controller of controllers) await controller.close();
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const equipment = equipmentConfiguration({ devices: [
    { id: 'air', area: 'garage', kind: 'temperature', signal: 'caravan_temperature', connection: 'mqtt:fixture/air',
      mqtt: { state_path: 'temperature', timestamp_path: 'timestamp' } },
    { id: 'caravan_dehumidifier', area: 'garage', kind: 'dehumidifier', connection: 'mqtt:fixture/dryer',
      dehumidifier_control: true, temperature_control: { sensor_device_id: 'air' },
      mqtt: { timestamp_path: 'timestamp', command_topic: 'fixture/dryer/set', availability_topic: 'fixture/dryer/online' } },
  ] });
  const baseline = { topology: 'pair', input: 'mqtt', pair: { pairId: 'fixture-pair', token: 'fixture-pair-token-'.repeat(3),
    vip: { address: '192.0.2.50' } }, connections: { mqtt: { address: 'mqtt://ha-internal.invalid', user: 'fixture-user' },
    teslamate: { enabled: true }, equipment }, charging: { chargers: { charger2: {
      enabled: true, deviceId: 'fixture-evse', topicPrefix: 'fixture/evse', limiterEnabled: false,
    } } } };
  const sourceConfig = structuredClone(baseline), ubuntuConfig = structuredClone(baseline), returnConfig = structuredClone(baseline);
  ubuntuConfig.connections.mqtt = { address: 'mqtt://127.0.0.1:1883', user: 'fixture-ubuntu',
    ha: { address: 'mqtt://192.0.2.51:1885', user: 'fixture-user' } };
  let now = initial;
  const makeRuntime = config => {
    const runtime = new ChargingRuntime({ store, config, engine: { clock: () => now }, clock: () => now });
    runtime.updatePlan = async () => {}; runtimes.push(runtime); return runtime;
  };
  const makeTesla = config => {
    const capture = createChargingTeslaCapture({ settings: config.connections.teslamate, clock: () => now,
      brokerIdentity: mqttSourceIdentity(config, 'ha'), initialState: store.getState('charging:teslamate'),
      saveState: value => store.setState('charging:teslamate', value) }); captures.push(capture); return capture;
  };
  const makeEquipment = config => {
    const routing = mqttRouting(config);
    const capture = createEquipmentCapture({ store, engine: { clock: () => now, ingest() {} }, settings: config.connections.equipment,
      brokerIdentity: routing.identity('primary'), brokerForDevice: routing.equipmentBroker,
      brokerIdentityForDevice: routing.equipmentIdentity, publish: async () => {} }); captures.push(capture); return capture;
  };
  const dryerReport = capture => {
    capture.setConnected(true); capture.confirmSubscriptions(capture.topics);
    capture.receive('fixture/dryer/online', 'online');
    capture.receive('fixture/dryer', JSON.stringify({ identity: 'a'.repeat(64), timestamp: now, power: 'off', fanSpeed: 'low',
      capabilities: { power: ['off', 'on'], fanSpeed: ['low', 'high'] } }));
  };
  const before = makeRuntime(sourceConfig), tesla = makeTesla(sourceConfig), appliances = makeEquipment(sourceConfig);
  const home = new HeatingAutomation({ store, config: sourceConfig, targetIdentity: () => 'b'.repeat(64), clock: () => now });
  home.set('home', true);
  const garage = new GarageRuntime({ store, config: sourceConfig, engine: {}, clock: () => now });
  garage.setAdapter({ status: () => ({ targetIdentity: 'c'.repeat(64), control: { targetC: 18, effectiveTargetC: 18 } }) });
  const originalHome = structuredClone(home.features.home), originalGarage = structuredClone(garage.selection);
  await before.setControl('charger2', { association: before.chargers.charger2.association, revision: 0, enabled: true });
  const bmwTopic = before.mqttRoutes().find(row => row.id === 'bmw').topic;
  const bmwValues = { soc: 55, pluggedIn: true, charging: true };
  before.receiveSoc(bmwTopic, JSON.stringify({ provider: 'bmw-cardata', ...bmwValues,
    measuredAt: initial, readingId: 'fixture-episode',
    fields: Object.fromEntries(Object.keys(bmwValues).map(field => [field, { measuredAt: initial, readingId: 'fixture-episode' }])) }), {}, initial);
  assert.ok(before.vehicleFeeds.bmw.reading);
  before.vehicleFeeds.bmw.consumedPlugId = 'fixture-episode';
  before.vehicleFeeds.bmw.consumedChargingId = 'fixture-episode';
  tesla.setConnected(true);
  for (const [field, value] of Object.entries({ plugged_in: true, charger_actual_current: 6, charger_power: 4.1 }))
    tesla.receive(`teslamate/cars/1/${field}`, String(value));
  const originalTesla = tesla.snapshot();
  before.consumedTeslaCurrent = { association: originalTesla.association, receivedAt: initial };
  before.consumedTeslaPower = { association: originalTesla.association, receivedAt: initial };
  before.persist();
  dryerReport(appliances);
  await appliances.setDehumidifierTemperatureControl({ deviceId: 'caravan_dehumidifier', enabled: false, offAtC: 0, onAtC: 3 });
  const policyKey = 'equipment:dehumidifier-temperature-control:v1:caravan_dehumidifier';
  const originalPolicy = store.getState(policyKey), originalCharger = before.chargers.charger2.association;
  const ownershipKey = before.ownershipKey('charger2');
  const deviceHold = { sessionId: 'fixture-session', connectedAt: initial - 1000, eventAt: initial, receivedAt: initial };
  store.setState(ownershipKey, { version: 1, association: originalCharger, phase: 'off', manual: null,
    ownedPause: false, pending: null, deviceHold });
  const originalBmw = structuredClone(before.vehicleFeeds.bmw.reading);
  await before.close(); tesla.close(); appliances.close();
  const source = createMqttSourceContext({ configuration: () => sourceConfig, directory: join(directory, 'ha') });
  await source.activate(sourceConfig, store, { allowSeed: true });
  assert.deepEqual(mqttSourceIdentity(sourceConfig, 'primary'), { address: 'mqtt://ha-internal.invalid', username: 'fixture-user' },
    'Initializing absent current context preserves the exact existing identity bytes');
  let previous = source;
  for (const [config, name] of [[ubuntuConfig, 'ubuntu'], [returnConfig, 'ha']]) {
    const context = createMqttSourceContext({ configuration: () => config, directory: join(directory, name) });
    const requirements = previous.requirements(store), token = randomUUID();
    await context.prepare({ requirements, token });
    context.verify({ dbPath: store.path, requirements, token });
    await context.authorize({ dbPath: store.path, requirements, token });
    await context.activate(config, store);
    now += 60_000;
    const runtime = makeRuntime(config), vehicle = makeTesla(config), equipment = makeEquipment(config);
    const restoredHome = new HeatingAutomation({ store, config, targetIdentity: () => 'b'.repeat(64), clock: () => now });
    assert.deepEqual(restoredHome.features.home, originalHome, 'Home automatic permission keeps the same current equipment binding');
    const restoredGarage = new GarageRuntime({ store, config, engine: {}, clock: () => now, canControl: () => false });
    assert.deepEqual(restoredGarage.selection, originalGarage, 'Garage target intent survives transport relocation without sending commands');
    assert.equal(runtime.chargers.charger2.association, originalCharger);
    assert.equal(runtime.chargers.charger2.controls.enabled, true);
    assert.equal(runtime.ownershipKey('charger2'), ownershipKey);
    const adapter = { association: runtime.chargers.charger2.association, config: runtime.configuration.chargers.charger2,
      snapshot: () => ({ association: originalCharger, online: false, fields: {}, session: null }) };
    const controller = createShellyController({ adapter, initialState: store.getState(runtime.ownershipKey('charger2')),
      clock: () => now, canControl: () => false }); controllers.push(controller);
    assert.deepEqual(controller.status().deviceHold, deviceHold, 'Restored native Stop remains restrictive without fresh evidence');
    assert.equal(controller.status().ownsInstruction, false);
    assert.deepEqual(runtime.vehicleFeeds.bmw.reading, originalBmw);
    assert.equal(runtime.vehicleFeeds.bmw.consumedPlugId, 'fixture-episode');
    assert.equal(runtime.vehicleFeeds.bmw.consumedChargingId, 'fixture-episode');
    assert.deepEqual(runtime.consumedTeslaCurrent, { association: originalTesla.association, receivedAt: initial });
    assert.deepEqual(runtime.consumedTeslaPower, { association: originalTesla.association, receivedAt: initial });
    vehicle.setConnected(true);
    for (const [field, value] of Object.entries({ plugged_in: true, charger_actual_current: 6, charger_power: 4.1 })) {
      vehicle.receive(`teslamate/cars/1/${field}`, String(value), { retain: true });
      vehicle.receive(`teslamate/cars/1/${field}`, String(value), {});
    }
    assert.deepEqual(vehicle.snapshot().fields, originalTesla.fields, 'Reconnection cannot mint new vehicle current/plug clocks');
    assert.deepEqual(vehicle.snapshot().boundaries, originalTesla.boundaries);
    dryerReport(equipment);
    const policy = equipment.status().devices.find(row => row.id === 'caravan_dehumidifier').dehumidifier.temperatureControl;
    assert.equal(policy.enabled, false); assert.equal(policy.offAtC, 0); assert.equal(policy.onAtC, 3);
    assert.deepEqual(store.getState(policyKey), originalPolicy, 'Handover does not rewrite durable dashboard choice');
    await runtime.close(); vehicle.close(); equipment.close(); previous = context;
  }
});
