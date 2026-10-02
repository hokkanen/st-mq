import test from 'node:test';
import assert from 'node:assert/strict';
import { bmwVehicleSetup, teslaVehicleSetup } from '../src/charging/setup.js';
import { chargingSetupView, chargingSetupMarkup, initializeChargingSetup, BMW_SETUP_DESCRIPTORS } from '../chart/charging-setup.js';

const NOW = Date.parse('2026-09-30T09:00:00Z');
const metadata = (age = 0) => ({ measuredAt: NOW - age, receivedAt: NOW - age + 100,
  retained: false, readingId: 'private-reading-token' });
function bmw() {
  return { provider: 'bmw-cardata', soc: 0, chargeLimitSoc: 80, usableCapacityKwh: 74,
    pluggedIn: false, charging: false, atHome: true, ...metadata(1000),
    fields: Object.fromEntries(['chargeLimitSoc', 'usableCapacityKwh', 'pluggedIn', 'charging', 'atHome']
      .map(key => [key, metadata(1000)])), vehicleId: 'private-vehicle-token',
    latitude: 1.234, longitude: 5.678, account: 'private-account-token' };
}
function tesla() {
  const values = { battery_level: 40, charge_limit_soc: 80, plugged_in: false, geofence: 'private-geofence-token',
    state: 'asleep', charging_state: 'Stopped', charger_power: 0, charge_current_request: 0,
    charge_current_request_max: 16, scheduled_charging_start_time: NOW + 3_600_000 };
  return { connected: true, healthy: true, batteryLevel: 40, chargeLimitSoc: 80, pluggedIn: false,
    atHome: true, charging: false, actualPowerKw: 0, requestedCurrentA: 0, maxCurrentA: 16,
    scheduledStartAt: NOW + 3_600_000, association: 'private-source-token',
    fields: Object.fromEntries(Object.entries(values).map(([key, value], sequence) => [key,
      { value, sequence, receivedAt: NOW - 7_200_000, retained: true }])) };
}

test('BMW setup preserves zero, false and independent source clocks without exposing private evidence', () => {
  const reading = bmw(), before = structuredClone(reading);
  reading.fields.chargeLimitSoc = metadata(86_400_000);
  const setup = bmwVehicleSetup(reading, { available: true, now: NOW });
  assert.equal(setup.fields.soc.value, 0);
  assert.equal(setup.fields.pluggedIn.value, false);
  assert.equal(setup.fields.charging.value, false);
  assert.equal(setup.fields.minimumSoc.measuredAt, NOW - 86_400_000);
  assert.equal(setup.fields.minimumSoc.value, 80, 'A sparse vehicle setting retains its original clock');
  assert.doesNotMatch(JSON.stringify(setup), /private-|latitude|longitude|readingId|association|account/);
  assert.equal(reading.soc, before.soc, 'Projection never changes source readings');
});

test('feed loss, future clocks and old charging state remain unavailable while context retains its source time', () => {
  const reading = bmw();
  for (const field of Object.values(bmwVehicleSetup(reading, { now: NOW }).fields)) {
    assert.equal(field.available, false);
    assert.equal(field.value, null);
  }
  reading.fields.pluggedIn = metadata(86_400_001);
  reading.fields.atHome = metadata(14 * 86_400_000);
  reading.measuredAt = NOW + 1;
  reading.fields.charging = metadata(900_001);
  const setup = bmwVehicleSetup(reading, { available: true, now: NOW });
  assert.equal(setup.fields.soc.available, false);
  assert.equal(setup.fields.pluggedIn.available, true);
  assert.equal(setup.fields.atHome.available, true);
  assert.equal(setup.fields.atHome.measuredAt, NOW - 14 * 86_400_000);
  assert.equal(setup.fields.charging.available, false);
  assert.equal(setup.fields.minimumSoc.available, true);
});

test('last confirmed BMW home context stays distinct from a current unknown location', () => {
  const reading = bmw();
  reading.atHome = null;
  reading.fields.atHome = { ...metadata(1000), lastKnown: { ...metadata(3_600_000), value: true } };
  const setup = bmwVehicleSetup(reading, { available: true, now: NOW });
  assert.equal(setup.fields.atHome.value, null);
  assert.equal(setup.homeContext.source, 'last-known');
  assert.equal(setup.homeContext.measuredAt, NOW - 3_600_000);
  assert.equal(bmwVehicleSetup(reading, { available: true, now: NOW + 14 * 86_400_000 }).homeContext.measuredAt, NOW - 3_600_000);
});

test('Tesla setup distinguishes logger health from sleep and preserves receipt provenance and current limits', () => {
  const snapshot = tesla();
  const setup = teslaVehicleSetup(snapshot, { now: NOW });
  assert.equal(setup.available, true);
  assert.equal(setup.state, 'asleep');
  assert.equal(setup.fields.requestedCurrentA.value, 0);
  assert.equal(setup.fields.maxCurrentA.value, 16);
  assert.equal(setup.fields.powerKw.value, 0);
  assert.equal(setup.fields.soc.measuredAt, null);
  assert.equal(setup.fields.soc.receivedAt, NOW - 7_200_000);
  assert.equal(setup.fields.soc.retained, true);
  assert.doesNotMatch(JSON.stringify(setup), /private-|geofence|association/);
  snapshot.healthy = false;
  for (const field of Object.values(teslaVehicleSetup(snapshot, { now: NOW }).fields)) assert.equal(field.available, false);
});

test('Tesla setup does not infer disabled timers from absent or elapsed next-start evidence', () => {
  const snapshot = tesla();
  snapshot.scheduledStartAt = NOW - 1;
  assert.equal(teslaVehicleSetup(snapshot, { now: NOW }).fields.vehicleNotBefore.value, null);
  delete snapshot.fields.battery_level;
  assert.equal(teslaVehicleSetup(snapshot, { now: NOW }).fields.soc.available, false);
});

test('setup summary never equates a broker connection with live vehicle health or association', () => {
  const status = { charging: { vehicleFeeds: [{ id: 'tesla', reception: { brokerConnected: true, subscribed: true }, usedByChargerId: 'charger1' }],
    chargers: [{ id: 'charger1', values: { connected: { available: true, value: true } }, vehicle: { id: 'tesla', state: 'unknown' } }] } };
  const view = chargingSetupView(status);
  assert.equal(view.vehicles.tesla.state, 'pending');
  assert.equal(view.vehicles.bmw.label, 'Not configured');
  assert.match(view.vehicles.tesla.association, /No current physical charger association/);
  status.charging.vehicleFeeds[0].setup = teslaVehicleSetup(tesla(), { now: NOW });
  assert.equal(chargingSetupView(status).vehicles.tesla.label, 'Healthy · Sleeping');
  status.charging.vehicleFeeds[0].reception.invalidReason = '<img src=x onerror=alert(1)>';
  const invalid = chargingSetupView(status);
  assert.equal(invalid.vehicles.tesla.label, 'Invalid report');
  assert.doesNotMatch(JSON.stringify(invalid), /<img|onerror/);
});

test('setup text retains source clocks, privacy and readiness boundaries', () => {
  const status = { charging: { vehicleFeeds: [{ id: 'bmw', reception: { available: true }, setup: bmwVehicleSetup(bmw(), { available: true, now: NOW }) }],
    chargers: [{ id: 'charger2', provider: 'shelly-evse', control: { snapshot: { commissioning: { profileSupported: false } } } }] } };
  const view = chargingSetupView(status);
  assert.match(view.vehicles.bmw.fields.soc, /^0% · Measured/);
  assert.match(view.vehicles.bmw.fields.pluggedIn, /^Unplugged · Measured/);
  assert.equal(view.chargers.charger2, 'Charger profile unavailable · Review the charger card');
  const markup = chargingSetupMarkup();
  for (const [, descriptor] of BMW_SETUP_DESCRIPTORS) assert.ok(markup.includes(descriptor));
  assert.match(markup, /does not send vehicle charging windows/);
  assert.match(markup, /not describe a complete weekly schedule/);
  assert.match(markup, /Optional; configured capacity/);
  assert.doesNotMatch(markup, /ST-MQ|stmq\/|private-/);
});

test('setup initialization binds only guide entry and status polling never replaces open content', () => {
  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { textContent: '', dataset: {}, events: {}, htmlWrites: 0,
      set innerHTML(value) { this.markup = value; this.htmlWrites++; }, addEventListener(name, handler) { this.events[name] = handler; } });
    return elements.get(id);
  } };
  const calls = [], setup = initializeChargingSetup(document, { onStartTest: vehicle => calls.push(vehicle) });
  setup.render({}); setup.render({});
  assert.equal(elements.get('charging-setup-content').htmlWrites, 1);
  assert.deepEqual(calls, []);
  elements.get('charging-setup-bmw-test').events.click();
  elements.get('charging-setup-tesla-test').events.click();
  assert.deepEqual(calls, ['bmw', 'tesla']);
  assert.equal(elements.get('charging-setup-bmw-state').textContent, 'Not configured');
});
