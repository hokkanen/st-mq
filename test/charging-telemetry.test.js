import test from 'node:test';
import assert from 'node:assert/strict';
import { createChargingTeslaCapture, teslamateChargerTelemetry, teslamateChargerAssignment } from '../src/charging/teslamate.js';

const NOW = Date.parse('2026-09-15T18:00:00Z');
test('TeslaMate reception is independent of recording and unchanged retained battery keeps its original clock across restart', () => {
  let saved;
  const capture = createChargingTeslaCapture({ clock: () => NOW, saveState: state => { saved = structuredClone(state); } });
  capture.setConnected(true);
  capture.receive('teslamate/cars/1/battery_level', '80', {}, NOW);
  capture.receive('teslamate/cars/1/state', 'asleep', {}, NOW + 1000);
  assert.equal(capture.reception().subscribed, true);
  assert.equal(capture.reception().lastLiveAt, NOW + 1000);
  assert.equal(capture.reception().chargerId, 'charger2');
  const restored = createChargingTeslaCapture({ initialState: saved });
  assert.equal(restored.reception().connected, false);
  assert.equal(teslamateChargerTelemetry(restored.snapshot()).soc.value, 80);
  assert.equal(teslamateChargerTelemetry(restored.snapshot()).connected.available, false);
  restored.setConnected(true);
  restored.receive('teslamate/cars/1/battery_level', '80', { retain: true }, NOW + 3600_000);
  const battery = teslamateChargerTelemetry(restored.snapshot()).soc;
  assert.equal(battery.receivedAt, NOW); assert.equal(battery.measuredAt, null);
  assert.equal(restored.reception().lastLiveAt, null);
  assert.equal(restored.reception().lastRetainedAt, NOW + 3600_000);
  const changedRoute = createChargingTeslaCapture({ settings: { carId: '2' }, initialState: saved });
  assert.equal(teslamateChargerTelemetry(changedRoute.snapshot()).soc.available, false);
});

test('configured Charger 2 receives battery and schedule without an identification verdict, while an away vehicle is excluded', () => {
  assert.equal(teslamateChargerAssignment({ assignment: 'auto' }, { identified: 'easee' }).chargerId, 'charger2');
  const capture = createChargingTeslaCapture(); capture.setConnected(true);
  const fields = { plugged_in: 'true', geofence: 'Home', battery_level: '80', charge_limit_soc: '100',
    charge_current_request: '16', charge_current_request_max: '16', scheduled_charging_start_time: '2026-09-16T00:00:00Z' };
  for (const [field, value] of Object.entries(fields)) capture.receive(`teslamate/cars/1/${field}`, value, {}, NOW);
  let vehicle = teslamateChargerTelemetry(capture.snapshot(), { now: NOW });
  assert.equal(vehicle.connected.value, true); assert.equal(vehicle.soc.value, 80); assert.equal(vehicle.minimumSoc.value, 100);
  assert.equal(vehicle.currentA.value, 16); assert.equal(vehicle.scheduledStartAt.available, true);
  capture.receive('teslamate/cars/1/geofence', 'Away', {}, NOW + 1000);
  vehicle = teslamateChargerTelemetry(capture.snapshot(), { now: NOW + 1000 });
  assert.equal(vehicle.connected.value, false);
});

test('new retained values after reconnect replace the old connection cache; late replay cannot overwrite current live fields', () => {
  const capture = createChargingTeslaCapture(); capture.setConnected(true);
  capture.receive('teslamate/cars/1/battery_level', '80', {}, NOW);
  capture.setConnected(false); capture.setConnected(true);
  capture.receive('teslamate/cars/1/battery_level', '90', { retain: true }, NOW + 1000);
  assert.equal(capture.snapshot().batteryLevel, 90);
  capture.receive('teslamate/cars/1/battery_level', '91', {}, NOW + 2000);
  capture.receive('teslamate/cars/1/battery_level', '90', { retain: true }, NOW + 3000);
  assert.equal(capture.snapshot().batteryLevel, 91);
  capture.receive('teslamate/cars/1/state', 'online', {}, NOW + 4000);
  capture.receive('teslamate/cars/1/charging_state', 'Charging', {}, NOW + 5000);
  assert.equal(capture.snapshot().charging, true);
  capture.receive('teslamate/cars/1/state', 'online', {}, NOW + 6000);
  assert.equal(capture.snapshot().charging, false, 'Fresh logger state has precedence even if its value is unchanged');
});
