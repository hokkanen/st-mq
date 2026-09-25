import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createChargingTeslaCapture } from '../src/charging/teslamate.js';
import { matchTeslaSession } from '../src/charging/vehicle.js';

const NOW = 1800000000000;
const identityValues = { plugged_in: 'true', charging_state: 'Charging', state: 'charging', geofence: 'Home', charger_power: '7' };
function fixture(initialState) {
  let now = NOW, saved;
  const boundaries = [];
  const capture = createChargingTeslaCapture({ initialState, clock: () => now,
    saveState: state => { saved = state; }, onBoundary: event => boundaries.push(event) });
  capture.setConnected(true);
  return { capture, boundaries, setNow(value) { now = value; }, saved: () => structuredClone(saved),
    send(field, value, packet = {}) { return capture.receive(`teslamate/cars/1/${field}`, value, packet); } };
}
test('vehicle observation cannot create canonical grid energy or a charger session check',()=>{
  const captured=[];const capture=createChargingTeslaCapture({saveState:value=>captured.push(value),clock:()=>1800000000000});capture.setConnected(true);
  for(const [field,value]of Object.entries({healthy:'true',plugged_in:'true',charging_state:'Charging',geofence:'Home',charger_power:'11',charge_energy_added:'1'}))capture.receive(`teslamate/cars/1/${field}`,value);
  assert.equal(capture.status().recording,false);assert.equal(captured.length,6);
  assert.equal(existsSync(new URL('../src/acquisition/teslamate.js',import.meta.url)),false);
  assert.doesNotMatch(readFileSync(new URL('../src/charging/teslamate.js',import.meta.url),'utf8'),/recordEnergy|recordChargingSessionCheck/);
});

test('identical live publications preserve retained identity provenance while healthy pulses renew availability', () => {
  const f = fixture();
  for (const [field, value] of Object.entries(identityValues)) f.send(field, value, { retain: true });
  const original = f.capture.snapshot().fields;
  const connectedAt = NOW + 120000;
  f.setNow(connectedAt);
  for (const [field, value] of Object.entries(identityValues)) f.send(field, value);
  f.send('healthy', 'true');
  const snapshot = f.capture.snapshot();
  assert.equal(snapshot.healthy, true);
  for (const field of Object.keys(identityValues)) assert.deepEqual(snapshot.fields[field], original[field], field);
  assert.equal(f.boundaries.length, 0);
  assert.equal(matchTeslaSession(snapshot, { connectedAt, now: connectedAt, chargingAt: [connectedAt],
    physical: { charging: { value: true }, powerKw: { available: true, value: 7, measuredAt: connectedAt } } }), false);
  f.setNow(connectedAt + 1000); f.send('healthy', 'true');
  assert.equal(f.capture.snapshot().fields.healthy.receivedAt, connectedAt + 1000);
});

test('periodic live identity repeats cannot renew plug, power or start clocks', () => {
  const f = fixture();
  for (const [field, value] of Object.entries(identityValues)) f.send(field, value);
  const original = f.capture.snapshot().fields, boundaryCount = f.boundaries.length;
  f.setNow(NOW + 60000);
  for (const [field, value] of Object.entries(identityValues)) f.send(field, value);
  const snapshot = f.capture.snapshot();
  for (const field of Object.keys(identityValues)) assert.deepEqual(snapshot.fields[field], original[field], field);
  assert.equal(f.boundaries.length, boundaryCount);
});

test('actual live plug and charging changes retain their own receipt times and can identify the new session', () => {
  const f = fixture();
  for (const [field, value] of Object.entries(identityValues)) f.send(field, value, { retain: true });
  f.setNow(NOW + 1000);
  for (const [field, value] of Object.entries({ plugged_in: 'false', charging_state: 'Disconnected', state: 'online', charger_power: '0' })) f.send(field, value);
  const connectedAt = NOW + 2000;
  f.setNow(connectedAt);
  for (const [field, value] of Object.entries(identityValues)) f.send(field, value);
  f.send('healthy', 'true');
  const snapshot = f.capture.snapshot();
  for (const field of ['plugged_in', 'charging_state', 'state', 'charger_power']) {
    assert.equal(snapshot.fields[field].receivedAt, connectedAt, field);
    assert.equal(snapshot.fields[field].retained, false, field);
  }
  assert.deepEqual(f.boundaries.filter(event => event.field === 'plugged_in').map(event => event.value), [false, true]);
  assert.equal(matchTeslaSession(snapshot, { connectedAt, lastDisconnectedAt: NOW + 1000,
    now: connectedAt, chargingAt: [connectedAt], physical: {
      charging: { value: true, available: true, measuredAt: connectedAt },
      powerKw: { available: true, value: 7, measuredAt: connectedAt },
    } }), true);
});

test('unknown identity gaps and same-value recovery preserve provenance across restart', () => {
  for (const retained of [false, true]) {
    const f = fixture();
    for (const [field, value] of Object.entries(identityValues)) f.send(field, value, { retain: retained });
    const original = f.capture.snapshot().fields;
    f.setNow(NOW + 1000);
    for (const field of ['plugged_in', 'charging_state', 'state', 'charger_power']) f.send(field, 'invalid');
    f.send('geofence', 'x'.repeat(201));
    for (const field of Object.keys(identityValues)) assert.equal(f.capture.snapshot().fields[field].value, null, field);
    const restarted = fixture(f.saved()); restarted.setNow(NOW + 2000);
    for (const [field, value] of Object.entries(identityValues)) restarted.send(field, value);
    for (const field of Object.keys(identityValues)) assert.deepEqual(restarted.capture.snapshot().fields[field], original[field], `${field}, retained=${retained}`);
    assert.deepEqual(restarted.boundaries, []);
  }
});

test('an actual negative plug after an unknown gap still records a departure', () => {
  const f = fixture(); f.send('plugged_in', 'true');
  f.setNow(NOW + 1000); f.send('plugged_in', 'invalid');
  f.setNow(NOW + 2000); f.send('plugged_in', 'false');
  assert.deepEqual(f.boundaries.map(event => [event.value, event.at]), [[true, NOW], [false, NOW + 2000]]);
  assert.equal(f.capture.snapshot().pluggedIn, false);
});
