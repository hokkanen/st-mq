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
  for (const vehicle of ['bmw', 'tesla']) for (const [reason, label, state] of [
    ['vehicle-observation-storage-pending', 'Saving vehicle report', 'pending'],
    ['vehicle-observation-admission-failed', 'Vehicle report not accepted', 'attention'],
  ]) {
    const unavailable = vehicle === 'tesla' ? teslaVehicleSetup({ ...tesla(), healthy: false }, { now: NOW })
      : bmwVehicleSetup(bmw(), { available: false, now: NOW });
    const waiting = chargingSetupView({ charging: { vehicleFeeds: [{ id: vehicle,
      reception: { brokerConnected: true, subscribed: true, available: false, reason }, setup: unavailable }] } }).vehicles[vehicle];
    assert.equal(waiting.label, label); assert.equal(waiting.state, state);
    assert.match(waiting.detail, /Vehicle readings are unavailable.*original times/);
    assert.match(waiting.fields.soc, /^Unavailable/);
    assert.doesNotMatch(waiting.detail, /logger|publisher|private-|storage-pending|admission-failed/);
  }
});

test('setup text retains source clocks, privacy and readiness boundaries', () => {
  const status = { charging: { vehicleFeeds: [{ id: 'bmw', reception: { available: true }, setup: bmwVehicleSetup(bmw(), { available: true, now: NOW }) }],
    chargers: [{ id: 'charger2', provider: 'shelly-evse', control: { snapshot: { commissioning: { profileSupported: false } } } }] } };
  const view = chargingSetupView(status);
  assert.match(view.vehicles.bmw.fields.soc, /^0% · Measured/);
  assert.match(view.vehicles.bmw.fields.pluggedIn, /^Unplugged · Measured/);
  assert.equal(view.chargers.charger2.readiness, 'Charger profile unsupported');
  const markup = chargingSetupMarkup();
  for (const [, descriptor] of BMW_SETUP_DESCRIPTORS) assert.ok(markup.includes(descriptor));
  assert.match(markup, /does not send vehicle charging windows/);
  assert.match(markup, /not describe a complete weekly schedule/);
  assert.match(markup, /Optional; configured capacity/);
  assert.doesNotMatch(markup, /ST-MQ|stmq\/|private-/);
});

test('Tesla setup distinguishes inferred charging connection from the original unplugged report', () => {
  const snapshot = tesla();
  Object.assign(snapshot, { charging: true, actualCurrentA: 6, actualPowerKw: 4 });
  for (const [key, value] of [['charging_state', 'Charging'], ['charger_actual_current', 6], ['charger_power', 4]])
    snapshot.fields[key] = { value, sequence: 20, receivedAt: NOW - 1000, retained: false };
  for (const field of Object.values(snapshot.fields)) Object.assign(field, { measuredAt: null, timeBasis: 'receipt-only' });
  const setup = teslaVehicleSetup(snapshot, { now: NOW });
  assert.equal(setup.fields.pluggedIn.value, false);
  assert.equal(setup.fields.pluggedIn.retained, true);
  assert.equal(setup.connectionContext.source, 'live-charging');
  const view = chargingSetupView({ charging: { vehicleFeeds: [{ id: 'tesla', setup }] } });
  assert.match(view.vehicles.tesla.fields.pluggedIn, /^Unplugged.*Retained/);
  assert.match(view.vehicles.tesla.connectionContext, /inferred from live vehicle charging.*reported plug field.*not confirmed.*physical charger evidence/);
  assert.doesNotMatch(JSON.stringify(setup), /private-|geofence|association/);
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


test('setup separates reported firmware from requirements and preserves the device receipt through polling and loss', () => {
  const charger = { id: 'charger1', provider: 'easee', capabilities: { scheduling: true },
    control: { snapshot: { transport: 'ocpp' } }, device: { model: 'Fixture charger', firmware: '999-fixture',
      source: 'ocpp-boot', receivedAt: NOW - 3_600_000, available: true } };
  const state = { now: NOW, charging: { chargers: [charger] } };
  const first = chargingSetupView(state).chargers.charger1;
  assert.equal(first.firmware, 'Reported firmware 999-fixture');
  assert.match(first.firmwareSource, /^OCPP boot report · Received /);
  assert.equal(first.connection, 'Local OCPP · native Equalizer');
  state.now += 3_600_000;
  assert.equal(chargingSetupView(state).chargers.charger1.firmwareSource, first.firmwareSource, 'Polling retains the original report clock');
  charger.device.available = false;
  const lost = chargingSetupView(state).chargers.charger1;
  assert.equal(lost.firmware, 'Last reported firmware 999-fixture');
  assert.ok(lost.firmwareSource.startsWith(first.firmwareSource));
  assert.match(lost.firmwareSource, /Current device report unavailable$/);
  charger.device.available = true;
  state.readOnly = true;
  const recorded = chargingSetupView(state).chargers.charger1;
  assert.equal(recorded.firmware, lost.firmware);
  assert.equal(recorded.firmwareSource, lost.firmwareSource);
  assert.equal(recorded.readiness, 'Recorded status · current readiness unknown');
  charger.device = null;
  assert.equal(chargingSetupView(state).chargers.charger1.firmware, 'Reported firmware unavailable');
  const markup = chargingSetupMarkup();
  assert.match(markup, /Local OCPP requires firmware 344 or later/);
  assert.doesNotMatch(markup, /Tested firmware|Reported firmware 344/);
  assert.match(markup, /shelly\.md#hardware-verification-still-required[^>]+>Limited checks on firmware 1\.7\.1/);
  assert.doesNotMatch(markup, /Reported firmware 1\.7\.1/);
  for (const path of ['charging.md', 'charging/user-guide.md', 'charging/integrations/easee.md', 'charging/integrations/shelly.md', 'charging/integrations/bmw.md', 'charging/integrations/teslamate.md', 'charging/guided-assessments.md', 'charging/testing.md'])
    assert.ok(markup.includes(`/docs/${path}`), `Guide linked: ${path}`);
});

test('setup keeps commissioning and identification capabilities separate from current limiter permission', () => {
  const charger = { id: 'charger2', provider: 'shelly-evse', capabilities: { scheduling: true, currentControl: false },
    configuration: { limiterEnabled: false }, telemetry: { identificationCurrentReady: true,
      commissioning: { profileSupported: true, controlReady: true, currentControlReady: true } },
    device: { firmware: '2.0.0-fixture', source: 'shelly-device-info', receivedAt: NOW, available: true } };
  const view = chargingSetupView({ charging: { chargers: [charger] } }).chargers.charger2;
  assert.equal(view.readiness, 'Start/stop available');
  assert.equal(view.current, 'Disabled in configuration');
  assert.equal(view.identification, 'Temporary minimum available');
  assert.equal(view.fallback, 'Autonomous fallback unverified');
  assert.equal(view.firmware, 'Reported firmware 2.0.0-fixture');
  assert.match(view.firmwareSource, /^Shelly device discovery · Received/);
  assert.equal(chargingSetupView({}).chargers.charger2.connection, 'Shelly XT1 · MQTT RPC');
  charger.telemetry.commissioning.profileSupported = false;
  assert.equal(chargingSetupView({ charging: { chargers: [charger] } }).chargers.charger2.identification, 'Readiness unavailable');
});
