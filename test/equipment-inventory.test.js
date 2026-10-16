import test from 'node:test';
import assert from 'node:assert/strict';
import { equipmentConnectionSummary, equipmentDevices, equipmentInventory, equipmentReadingRows } from '../chart/equipment.js';
import { floorManualAllowed } from '../chart/floor-preheat.js';
import { floorOverrideConfiguration, floorOverrideStatus } from '../src/control/floor-override.js';

const now = Date.parse('2026-09-14T12:00:00Z');
const temperature = (value, extra = {}) => ({ value, observedAt: now - 1000, stale: false, source: 'mqtt-temperature', ...extra });
const signals = devices => devices.flatMap(device => Object.keys(device.readings ?? {}));
function withoutUnknownFloor(status, inventory = equipmentInventory(status)) {
  const floor = inventory.filter(device => device.kind === 'floor_override');
  assert.equal(floor.length, 1, 'One floor setup card remains discoverable without usable GPIO feedback');
  assert.equal(floor[0].id, 'floor-override:groundfloor');
  assert.equal(floor[0].area, 'home');
  assert.equal(floor[0].source, 'SONOFF');
  assert.equal(floor[0].available, false);
  assert.deepEqual(floor[0].controls, { switch: false, tariff: false });
  assert.deepEqual(Object.values(floor[0].readings).map(reading => reading.value), [null, null, null, null]);
  assert.deepEqual(equipmentReadingRows(floor[0]).map(reading => reading.value), ['Unknown', 'Unknown', 'Unknown', 'Unknown']);
  for (const channel of [1, 2, 3, 4]) for (const enabled of [true, false])
    assert.equal(floorManualAllowed(status, channel, enabled), false);
  return inventory.filter(device => device !== floor[0]);
}

test('floor setup stays visible with unknown outputs before current feedback and commissioning', () => {
  const statuses = [
    [undefined, 'Status unavailable'],
    [{ now, preheatValves: floorOverrideStatus() }, 'Not configured'],
    [{ now, preheatValves: floorOverrideStatus(floorOverrideConfiguration({ device_mac: '02:00:00:00:00:01' })) }, 'Disconnected'],
    [{ now, preheatValves: floorOverrideStatus(floorOverrideConfiguration({ device_mac: '02:00:00:00:00:01', commissioned: true, enabled: false })) }, 'Disconnected'],
  ];
  for (const [status, label] of statuses) {
    const inventory = equipmentInventory(status);
    assert.deepEqual(withoutUnknownFloor(status, inventory), []);
    assert.equal(inventory[0].connectionState.label, label);
  }
});

test('floor connection availability follows current evidence independently of operational permissions', () => {
  const floor = { integrationSupported: true, configured: true, connected: true, enabled: true, commissioned: true,
    manualAvailable: true, available: true, devices: [{ group: 'groundfloor', available: true, at: now,
      channels: [1, 2, 3, 4].map(id => ({ id, output: false, at: now, outputEvidence: 'gpio_output_readback', quality: [] })) }] };
  for (const restriction of [{}, { commissioned: false, manualAvailable: false, available: false }, { enabled: false },
    { restorationPending: true, manualAvailable: false, available: false }, { stateUnknown: true, manualAvailable: false, available: false }]) {
    const status = { now, preheatValves: { ...floor, ...restriction } };
    const device = equipmentDevices(status)[0], summary = equipmentConnectionSummary(device);
    assert.equal(device.available, true);
    assert.equal(summary.label, 'Available');
    assert.equal(summary.state, 'available');
    assert.match(summary.recent, /^Reported /);
    assert.doesNotMatch(summary.recent, /ready|commission|release|override/i);
  }
  const live = { ...floor, mode: 'manual', devices: [{ ...floor.devices[0],
    channels: floor.devices[0].channels.map(channel => ({ ...channel, output: true })) }] };
  assert.equal(equipmentConnectionSummary(equipmentDevices({ now, preheatValves: live })[0]).label, 'Available');
  const lost = { ...floor, connected: false, devices: [{ ...floor.devices[0], available: false }] };
  const device = equipmentDevices({ now, preheatValves: lost })[0];
  assert.equal(equipmentConnectionSummary(device).label, 'Disconnected');
  assert.deepEqual(equipmentReadingRows(device).map(row => row.value), ['Unknown', 'Unknown', 'Unknown', 'Unknown']);
  const recorded = equipmentDevices({ now, readOnly: true, preheatValves: floor })[0];
  assert.equal(equipmentConnectionSummary(recorded).label, 'Recorded snapshot');
  assert.equal(recorded.available, false);
});

test('inventory uses the current equipment contract and retains tariff relays, meters and doors', () => {
  const relay = { id: 'heat_savings', area: 'home', source: 'Shelly', available: true,
    controls: { tariff: true }, readings: { heat_savings_active: { value: 0, unit: 'state', stale: false, observedAt: now } } };
  const door = { id: 'garage_door1', area: 'garage', kind: 'door', available: true,
    readings: { garage_door1_open: { value: 0, unit: 'state', stale: false, observedAt: now - 7 * 86400000 } } };
  const status = { now, equipment: { devices: [{ ...relay, label: 'Current relay' }, door,
    { id: 'caravan', area: 'garage', kind: 'metered_switch', available: true }] } };
  const devices = equipmentDevices(status), inventory = equipmentInventory(status);
  assert.equal(devices.length, 4);
  assert.equal(devices.find(device => device.id === relay.id).label, 'Current relay');
  assert.equal(inventory.find(device => device.id === relay.id).area, 'home');
  assert.equal(inventory.find(device => device.id === 'caravan').area, 'garage');
  assert.equal(equipmentReadingRows(inventory.find(device => device.id === door.id))[0].value, 'Closed');
});

test('configured and observed rooms use canonical held readings and do not duplicate an existing sensor', () => {
  const status = { now, equipment: { devices: [{ id: 'room_probe', label: 'Upstairs probe', area: 'home', kind: 'temperature',
    available: false, readings: { indoor_temperature: { ...temperature(19), stale: true, label: 'Upstairs' } } }] },
  sensorChanges: { sensors: [{ signal: 'indoor_temperature', configured: true }, { signal: 'downstairs_temperature', configured: true }] },
  observations: { upstairs: temperature(21.5, { held: true, needsAttention: true, attentionReasons: ['disconnected'] }),
    bedroom: temperature(20), indoor: temperature(21) } };
  const original = structuredClone(status), inventory = equipmentInventory(status);
  assert.equal(signals(inventory).filter(signal => signal === 'indoor_temperature').length, 1);
  assert.equal(signals(inventory).includes('downstairs_temperature'), true);
  assert.equal(signals(inventory).includes('bedroom_temperature'), true);
  assert.equal(inventory.some(device => /average/i.test(device.label)), false);
  const upstairs = equipmentReadingRows(inventory.find(device => device.id === 'room_probe'))[0];
  assert.equal(upstairs.value, '21.5 °C');
  assert.equal(upstairs.qualifier, 'Needs attention');
  assert.match(upstairs.detail, /disconnected/);
  const downstairs = inventory.find(device => device.readings.downstairs_temperature);
  assert.equal(equipmentReadingRows(downstairs)[0].value, 'Unavailable');
  assert.equal(downstairs.inventoryOnly, true);
  assert.deepEqual(downstairs.controls, { switch: false, tariff: false });
  assert.deepEqual(status, original);
});

test('a missed periodic report is unavailable even when an equipment packet and numeric value remain', () => {
  const inventory = equipmentInventory({ now,
    equipment: { devices: [{ id: 'upstairs', area: 'home', kind: 'temperature', available: true, readings: {} }] },
    sensorChanges: { sensors: [{ signal: 'indoor_temperature', configured: true }, { signal: 'bedroom_temperature', configured: true }] },
    observations: { upstairs: temperature(20.5), bedroom: temperature(21, { periodicReports: true, reportExpiresAt: now - 1,
      lastReportAt: now - 70000, reportMaxAgeMs: 60000 }) } });
  assert.equal(inventory.some(device => device.id === 'inventory:sensor:indoor_temperature'), false);
  assert.equal(equipmentReadingRows(inventory.find(device => device.id === 'upstairs'))[0].value, '20.5 °C');
  const row = equipmentReadingRows(inventory.find(device => device.readings.bedroom_temperature))[0];
  assert.equal(row.value, 'Unavailable');
  assert.match(row.detail, /report missing/i);
});

test('H66 temperatures stay in the dedicated pump readings instead of duplicate inventory sections', () => {
  const h66Reading = value => ({ value, observedAt: now - 1000, available: true, usableForControl: true, stale: false });
  const status = { now, h66: { connected: true, readings: {
    '0007': h66Reading(-2), '0001': h66Reading(28), '0002': h66Reading(33), '0009': h66Reading(50),
    '0005': h66Reading(4), '0006': h66Reading(1), '0203': h66Reading(21), '0008': h66Reading(22),
  } }, observations: { outdoor: temperature(-2, { source: 'husdata-h66' }), indoor: temperature(21) },
  sensorChanges: { sensors: [{ signal: 'outdoor_temperature', configured: true }] } };
  assert.deepEqual(withoutUnknownFloor(status), []);
  const weather = { now, observations: { outdoor: temperature(-1, { source: 'fmi' }) },
    sensorChanges: { sensors: [{ signal: 'outdoor_temperature', configured: true }] } };
  assert.deepEqual(withoutUnknownFloor(weather), []);
});

test('garage probes remain distinct and native Mitsubishi temperatures do not create an extra inventory card', () => {
  const rear = temperature(10), front = temperature(8);
  const status = { now, equipment: { devices: [{ id: 'garage_sensor', kind: 'temperature', area: 'garage',
    available: true, readings: { garage_temperature: { ...rear, unit: 'degC' } } }] },
  garage: { observations: { rear, front }, adapter: { telemetry: {
    garage_native_indoor_temperature: { value: 15, sourceTime: now, supported: true, usable: true },
    garage_native_outdoor_temperature: { value: null, sourceTime: null, supported: false, usable: false },
  } } } };
  const inventory = equipmentInventory(status);
  assert.equal(signals(inventory).filter(signal => signal === 'garage_temperature').length, 1);
  assert.equal(signals(inventory).filter(signal => signal === 'garage_temperature_2').length, 1);
  assert.equal(signals(inventory).includes('garage_native_indoor_temperature'), false);
  assert.equal(signals(inventory).includes('garage_native_outdoor_temperature'), false);
  assert(withoutUnknownFloor(status, inventory).every(device => device.area === 'garage'));
});
