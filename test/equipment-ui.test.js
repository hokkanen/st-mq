import test from 'node:test';
import assert from 'node:assert/strict';
import { createEquipmentActions, equipmentReadingRows, equipmentTestAllowed, equipmentSource } from '../chart/equipment.js';
import { historyDatasets, historyValueLabel } from '../chart/history-model.js';
import { providerName } from '../chart/provider-status.js';

const now = Date.parse('2026-09-13T12:00:00Z');
const plug = { id: 'caravan', label: 'Caravan', area: 'garage', kind: 'metered_switch', source: 'MQTT-shelly',
  connection: 'shelly:invented-caravan', available: true, controls: { switch: true },
  readings: { caravan_active: { value: 1, unit: 'state', label: 'Switch', observedAt: now, stale: false },
    caravan_current: { value: 1.2, unit: 'A', label: 'Current', estimated: true, observedAt: now },
    caravan_power: { value: 0.28, unit: 'kW', label: 'Power', observedAt: now } },
  energy: { dailyKwh: 1.23, partial: true, observedAt: now } };
const status = (overrides = {}) => ({ role: 'primary', now, equipment: { configured: true, devices: [structuredClone(plug)] },
  equipmentTests: { available: true, busy: false }, ...overrides });

test('monitoring keeps physically named probes independent and only renders configured channels', () => {
  const device = { kind: 'temperature', available: true, readings: {
    garage_temperature: { value: 18.25, unit: 'degC', label: 'By the entrance', observedAt: now },
    garage_temperature_2: { value: 16.5, unit: 'degC', label: 'By the back wall', observedAt: now },
  } };
  const rows = equipmentReadingRows(device);
  assert.deepEqual(rows.map(row => [row.label, row.value]), [['By the entrance', '18.3 °C'], ['By the back wall', '16.5 °C']]);
  device.available = false;
  device.readings.garage_temperature.stale = true;
  device.readings.garage_temperature_2.stale = false;
  assert.deepEqual(equipmentReadingRows(device).map(row => row.value), ['Unavailable', '16.5 °C'], 'A missing probe does not hide its healthy neighbour');
  delete device.readings.garage_temperature_2;
  assert.equal(equipmentReadingRows(device).length, 1);
});

test('a quiet door keeps its reported state while unhealthy and retained-only state remain explicitly unknown', () => {
  const door = { kind: 'door', available: true, readings: {
    garage_door1_open: { value: 0, unit: 'state', label: 'Door 1', observedAt: now - 7 * 86400000, stale: false },
  } };
  assert.equal(equipmentReadingRows(door)[0].value, 'Closed', 'The UI does not invent a report age timeout');
  door.available = false;
  door.readings.garage_door1_open.stale = true;
  let row = equipmentReadingRows(door)[0];
  assert.equal(row.value, 'Unknown'); assert.match(row.detail, /Last reported Closed.*Sept/);
  door.readings.garage_door1_open.observedAt = null;
  row = equipmentReadingRows(door)[0]; assert.match(row.detail, /Last reported Closed.*time unavailable/);
  door.readings.garage_door1_open.value = null;
  assert.equal(equipmentReadingRows(door)[0].detail, 'No usable reading received');
});

test('Caravan and future heat-pump monitoring preserve estimation, coverage and relay meaning', () => {
  const rows = equipmentReadingRows(plug);
  assert.equal(rows.find(row => row.signal === 'caravan_current').label, 'Current (estimate)');
  assert.equal(rows.find(row => row.signal === 'daily_energy').value, '1.230 kWh');
  assert.match(rows.find(row => row.signal === 'daily_energy').detail, /Finnish day.*partial coverage/);
  const heatPump = equipmentReadingRows({ kind: 'heat_pump', available: true,
    readings: { garage_heat_pump_active: { value: true, unit: 'state', label: 'Compressor', observedAt: now } } });
  assert.equal(heatPump[0].label, 'Power enabled'); assert.equal(heatPump[0].value, 'On');
});

test('transport labels match throughout equipment, providers and chart tooltips', () => {
  assert.equal(equipmentSource(plug), 'Shelly');
  assert.equal(equipmentSource({ source: 'MQTT' }), 'MQTT');
  assert.equal(providerName('mqtt-temperature'), 'MQTT'); assert.equal(providerName('shelly-mqtt'), 'Shelly');
  assert.equal(historyValueLabel('garage_door1_open', 1, 'state'), 'Open');
  assert.equal(historyValueLabel('garage_door2_open', 0, 'state'), 'Closed');
  for (const key of ['garage_temperature', 'garage_temperature_2']) {
    const dataset = historyDatasets({}, 'temperatures').find(row => row.key === key);
    assert.equal(dataset.cubicInterpolationMode, 'monotone'); assert.equal(dataset.stepped, false);
  }
});

test('test availability requires switch capability, fresh readback, authority and no concurrent test', () => {
  assert(equipmentTestAllowed(status(), plug));
  for (const next of [status({ role: 'replica' }), status({ equipmentTests: { available: false } }),
    status({ equipmentTests: { available: true, busy: true } }), status({ equipmentTests: { available: true, active: { deviceId: 'caravan' } } })])
    assert.equal(equipmentTestAllowed(next, plug), false);
  for (const device of [{ ...plug, available: false }, { ...plug, controls: { switch: false } },
    { ...plug, controls: { switch: true, tariff: true } },
    { ...plug, readings: { caravan_active: { value: 1, unit: 'state', stale: false } } },
    { ...plug, readings: { caravan_active: { value: 1, unit: 'state', stale: false, observedAt: now + 1 } } },
    { ...plug, readings: { caravan_active: plug.readings.caravan_active, extra_active: plug.readings.caravan_active } },
    { ...plug, readings: { caravan_active: { value: 1, unit: 'state', stale: true } } }])
    assert.equal(equipmentTestAllowed(status(), device), false);
});

test('recheck posts only the explicit device identity, prevents repeated clicks and applies the returned status', async () => {
  let finish; const calls = [], received = [];
  const actions = createEquipmentActions({ request: (path, body) => {
    calls.push({ path, body }); return new Promise(resolve => { finish = resolve; });
  }, onStatus: result => received.push(result) });
  actions.update(status());
  assert.equal(await actions.recheck('unknown-device'), false);
  const pending = actions.recheck('caravan'); assert.equal(await actions.recheck(), false);
  assert.deepEqual(calls, [{ path: '/api/equipment/recheck', body: { deviceId: 'caravan' } }]);
  assert.equal(actions.snapshot().actionKind, 'recheck');
  const next = status({ now: now + 1000 }); finish(next); assert.equal(await pending, true);
  assert.equal(received[0], next);
  const all = actions.recheck(); assert.deepEqual(calls[1], { path: '/api/equipment/recheck', body: {} });
  finish(next); await all;
});

test('timed tests use exact values, preserve an active test through polling and expose explicit restoration', async () => {
  let finish; const calls = [];
  const actions = createEquipmentActions({ request: (path, body) => {
    calls.push({ path, body }); return new Promise(resolve => { finish = resolve; });
  } });
  actions.update(status());
  for (const duration of [0, 16, 1.5, '5']) assert.equal(await actions.test('caravan', false, duration), false);
  assert.equal(await actions.test('caravan', 'off', 5), false);
  const pending = actions.test('caravan', false, 5);
  assert.deepEqual(calls[0], { path: '/api/equipment/test', body: { deviceId: 'caravan', on: false, durationMinutes: 5 } });
  assert.equal(actions.snapshot().actionKind, 'test'); assert.equal(actions.snapshot().actionDeviceId, 'caravan');
  actions.update(status({ now: now - 1000 }));
  const active = status({ equipmentTests: { available: true, active: { deviceId: 'caravan', on: false, previousOn: true, until: now + 300000 } } });
  finish(active); await pending;
  assert.equal(await actions.test('caravan', true, 5), false);
  const restore = actions.restore(); assert.deepEqual(calls[1], { path: '/api/equipment/test/restore', body: {} });
  assert.equal(actions.snapshot().actionDeviceId, 'caravan', 'Restoration feedback remains scoped to its device after active state clears');
  finish(status()); await restore;
  assert.equal(actions.snapshot().status.equipmentTests.active, undefined);
});

test('failed requests retain monitoring, hide transport error details and replicas cannot recheck or operate', async () => {
  let count = 0;
  const actions = createEquipmentActions({ request: async () => { count++; throw new Error('invented-private-broker-detail'); } });
  const initial = status(); actions.update(initial);
  assert.equal(await actions.recheck(), false); assert.equal(actions.snapshot().status, initial);
  assert.doesNotMatch(actions.snapshot().message, /invented-private/);
  assert.equal(actions.snapshot().busy, false);
  actions.update(status({ role: 'replica' }));
  assert.equal(await actions.recheck(), false); assert.equal(await actions.test('caravan', true, 5), false);
  assert.equal(count, 1);
});
