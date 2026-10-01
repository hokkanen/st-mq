import test from 'node:test';
import assert from 'node:assert/strict';
import { createChargingTeslaCapture, decodeChargingTeslaField } from '../src/charging/teslamate.js';
import { householdProfile } from '../src/charging/history.js';

test('advance telemetry uses requested current at zero measured power and retains separate receipt clocks', () => {
  const capture = createChargingTeslaCapture({ settings: { carId: '7', homeGeofence: 'Home' } });
  capture.setConnected(true);
  const send = (field, value, at, packet) => capture.receive(`teslamate/cars/7/${field}`, String(value), packet, at);
  send('battery_level', 40, 1000); send('charger_power', 0, 1100);
  send('charge_current_request', 13, 1200); send('charge_current_request_max', 16, 1300);
  send('geofence', 'Home', 1400); send('plugged_in', true, 1500);
  send('scheduled_charging_start_time', '2026-09-15T23:00:00Z', 2000);
  let snapshot = capture.snapshot();
  assert.equal(snapshot.actualPowerKw, 0);
  assert.equal(snapshot.requestedCurrentA, 13);
  assert.equal(snapshot.maxCurrentA, 16);
  assert.equal(snapshot.fields.battery_level.receivedAt, 1000);
  assert.equal(snapshot.fields.battery_level.measuredAt, null);
  assert.equal(snapshot.atHome, true);
  send('charge_current_request', 6, 2100, { retain: true });
  assert.equal(capture.snapshot().requestedCurrentA, 13);
  send('charge_current_request', 'bad', 2200);
  assert.equal(capture.snapshot().requestedCurrentA, null, 'Invalid current cannot retain an apparently valid forecast');
  capture.setConnected(false);
  snapshot = capture.snapshot();
  assert.equal(snapshot.connected, false);
  assert.equal(snapshot.atHome, undefined);
  assert.equal(snapshot.batteryLevel, 40, 'Broker loss preserves the last valid charge and its original clock; connection status is separate');
  capture.setConnected(true);
  send('battery_level', 42, 3000, { dup: true });
  assert.equal(capture.snapshot().batteryLevel, 40, 'Duplicate packets cannot establish fresh evidence');
  send('geofence', 'x'.repeat(201), 3100);
  assert.equal(capture.snapshot().atHome, undefined, 'Invalid location is not known-away evidence');
});

test('Tesla charging decoder rejects malformed numbers and timezone-free schedules', () => {
  assert.equal(decodeChargingTeslaField('battery_level', 101), null);
  assert.equal(decodeChargingTeslaField('charge_current_request', '13A'), null);
  assert.equal(decodeChargingTeslaField('scheduled_charging_start_time', '2026-09-15T06:00:00'), null);
  assert.equal(decodeChargingTeslaField('scheduled_charging_start_time', 'null'), null);
  assert.equal(decodeChargingTeslaField('plugged_in', 'yes'), null);
  assert.equal(decodeChargingTeslaField('latitude', '1'), undefined);
});

const HOUR = 3_600_000, start = Date.parse('2026-09-14T12:00:00Z');
function energy(signal, value, from = start, to = start + HOUR) {
  return { signal, value, unit: 'kWh', raw: { intervalStart: from, intervalEnd: to }, quality: [] };
}
test('household forecast intersects clocks and subtracts both three-phase chargers on each phase', () => {
  const rows = [1, 2, 3].flatMap(p => [energy(`property_energy_l${p}`, 3), energy(`ev1_energy_l${p}`, 1)]);
  rows.push(...[1,2,3].map(phase=>energy(`ev2_energy_l${phase}`,2/3,start+HOUR/2,start+HOUR)));
  const profile = householdProfile(rows, { timezone: 'UTC', voltageV: 230 });
  assert.equal(profile[12].coverageMs, HOUR);
  assert.ok(profile[12].phaseCurrentA.every(current => Math.abs(current - 4000 / 3 / 230) < 1e-9),
    'Known Charger 2 energy is subtracted only over its overlap; unknown earlier consumption remains in the reference');
  assert.equal(profile[13], null);
  assert.equal(householdProfile(rows.slice(0, 6), { timezone: 'UTC', voltageV: 230 })[12].unknownCharger2, true,
    'Missing Charger 2 records retain useful household history with attribution uncertainty');
});

test('household forecast preserves phase imbalance and requires automatic voltage', () => {
  const rows = [1, 2, 3].flatMap(phase => [energy(`property_energy_l${phase}`, phase + 1), energy(`ev1_energy_l${phase}`, 1)]);
  rows.push(...[1,2,3].map(phase=>energy(`ev2_energy_l${phase}`,1)));
  const profile = householdProfile(rows, { timezone: 'UTC', voltageV: [220, 230, 240] });
  assert.deepEqual(profile[12].phaseCurrentA, [0, 1000 / 230, 2000 / 240]);
  assert.equal(householdProfile(rows, { timezone: 'UTC' })[12], null);
});

test('overlapping source intervals and negative residuals cannot create headroom', () => {
  const rows = [1, 2, 3].flatMap(p => [energy(`property_energy_l${p}`, 1), energy(`ev1_energy_l${p}`, 1)]);
  rows.push(...[1,2,3].map(phase=>energy(`ev2_energy_l${phase}`,2/3)));
  assert.equal(householdProfile(rows, { timezone: 'UTC', voltageV: 230 })[12], null);
  rows.filter(row=>row.signal.startsWith('ev2_energy_l')).forEach(row=>{row.value=0;});
  rows.push(energy('property_energy_l1', 2));
  assert.equal(householdProfile(rows, { timezone: 'UTC', voltageV: 230 })[12], null);
});

test('household demand is a duration-weighted expectation without an implicit high-load reserve', () => {
  const quarter = HOUR / 4;
  const rows = [1, 2, 3].flatMap(phase => [
    energy(`property_energy_l${phase}`, 3, start, start + quarter),
    energy(`property_energy_l${phase}`, 0.75, start + quarter, start + HOUR),
    energy(`ev1_energy_l${phase}`, 0),
  ]);
  rows.push(...[1,2,3].map(phase=>energy(`ev2_energy_l${phase}`,0)));
  const profile = householdProfile(rows, { timezone: 'UTC', voltageV: 230 });
  assert.equal(profile[12].coverageMs, HOUR);
  assert.equal(profile[12].method, 'duration-weighted-mean');
  assert.ok(profile[12].phaseCurrentA.every(current => Math.abs(current - 3750 / 230) < 1e-9),
    '15 minutes at 12 kW and 45 minutes at 1 kW average 3.75 kW per phase, not the upper reading');
});
