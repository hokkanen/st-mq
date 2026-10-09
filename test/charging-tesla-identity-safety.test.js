import { admitChargingObservation } from './helpers/charging-observation.js';
import { withReportDatabase } from './helpers/report-database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchTeslaSession } from '../src/charging/vehicle.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { teslamateVehicleTelemetry, createChargingTeslaCapture } from '../src/charging/teslamate.js';

const NOW = 1800000000000;
const SOURCE = 'synthetic-tesla-source';
function evidence() {
  return {
    tesla: { association: SOURCE, connected: true, healthy: true, pluggedIn: true, atHome: true,
      charging: true, actualPowerKw: 7, boundaries: [], fields: {
        plugged_in: { value: true, retained: false, receivedAt: NOW },
        charging_state: { value: 'Charging', retained: false, receivedAt: NOW },
        charger_power: { value: 7, retained: false, receivedAt: NOW },
      } },
    options: { connectedAt: NOW, lastDisconnectedAt: NOW - 1000, now: NOW + 10000,
      chargingAt: [NOW], physical: {
        charging: { available: true, value: true, measuredAt: NOW },
        powerKw: { available: true, value: 7, measuredAt: NOW + 10000 },
      } },
  };
}

test('all Tesla matching paths require current-session physical power with a valid fresh source time', async t => {
  const baseline = evidence();
  assert.equal(matchTeslaSession(baseline.tesla, baseline.options), true);
  for (const [name, change] of Object.entries({
    missing: f => { delete f.options.physical.powerKw.measuredAt; },
    unavailable: f => { f.options.physical.powerKw.available = false; },
    stale: f => { f.options.physical.powerKw.measuredAt = f.options.now - 60001; },
    future: f => { f.options.physical.powerKw.measuredAt = f.options.now + 1; },
    'before-session': f => { f.options.physical.powerKw.measuredAt = NOW - 1000; },
    'zero-Tesla-power': f => {
      f.tesla.actualPowerKw = 0; f.tesla.fields.charger_power.value = 0;
      f.options.physical.powerKw.value = 0.6;
    },
  })) await t.test(name, () => {
    const f = evidence(); change(f);
    assert.equal(matchTeslaSession(f.tesla, f.options), false);
  });
});

test('a Tesla departure fences pre-unplug evidence when the charger misses a quick unplug and replug', () => {
  const f = evidence();
  assert.equal(matchTeslaSession(f.tesla, f.options), true);
  f.tesla.boundaries = [
    { association: SOURCE, field: 'plugged_in', value: false, at: NOW + 1000 },
    { association: SOURCE, field: 'plugged_in', value: true, at: NOW + 2000 },
  ];
  f.tesla.fields.plugged_in.receivedAt = NOW + 2000;
  assert.equal(matchTeslaSession(f.tesla, f.options), false,
    'The new plug reading cannot revive power and charging evidence from before the departure');
  f.tesla.fields.charger_power.receivedAt = NOW + 3000;
  f.tesla.fields.charging_state.receivedAt = NOW + 3000;
  f.options.chargingAt = [NOW + 3000];
  assert.equal(matchTeslaSession(f.tesla, f.options), true,
    'Independent charging evidence after the departure can identify the ongoing physical scope');
});

test('negative boundaries from another vehicle source cannot fence the current Tesla', () => {
  const f = evidence();
  f.tesla.boundaries = [{ association: 'replacement-source', field: 'plugged_in', value: false, at: NOW + 1000 }];
  assert.equal(matchTeslaSession(f.tesla, f.options), true);
});

test('initial live Home evidence admits charging, but leaving and returning fences the earlier power', () => {
  const capture = createChargingTeslaCapture({ clock: () => NOW + 10000 }); capture.setConnected(true);
  const send = (field, value, at) => capture.receive(`teslamate/cars/1/${field}`, String(value), {}, at);
  for (const [field, value] of Object.entries({ healthy: true, geofence: 'Home', plugged_in: true,
    charging_state: 'Charging', charger_power: 7 })) send(field, value, NOW);
  const options = evidence().options;
  assert.equal(matchTeslaSession(capture.snapshot(), options), true,
    'The first observation of Home is not a departure');
  send('geofence', 'Elsewhere', NOW + 1000); send('geofence', 'Home', NOW + 2000);
  assert.equal(matchTeslaSession(capture.snapshot(), options), false,
    'The return to Home cannot revive power evidence from before leaving');
});

test('consumed Tesla power cannot identify another connection until a new live change arrives', () => {
  const f = evidence();
  assert.equal(matchTeslaSession(f.tesla, { ...f.options, consumedPowerAt: null }), true);
  for (const consumedPowerAt of [NOW, NOW + 1]) {
    assert.equal(matchTeslaSession(f.tesla, { ...f.options, consumedPowerAt }), false);
  }
  f.tesla.fields.charger_power.receivedAt = NOW + 2000;
  assert.equal(matchTeslaSession(f.tesla, { ...f.options, consumedPowerAt: NOW }), true);
});

function runtimeFixture(t) {
  let now = NOW;
  const saved = new Map();
  const store = { getState: key => structuredClone(saved.get(key)),
    setState: (key, value) => saved.set(key, structuredClone(value)) };
  withReportDatabase(store, t);
  const physical = {
    charger1: { connected: true, charging: true, connectedAt: NOW, at: NOW, power: 7 },
    charger2: { connected: false, charging: false, connectedAt: null, at: NOW, power: 0 },
  };
  const config = { input: 'mqtt', connections: { easee: { charger_id: 'synthetic-charger' } } };
  function create() {
    const runtime = new ChargingRuntime({ engine: {}, store, config, clock: () => now });
    for (const [id, state] of Object.entries(physical)) {
      runtime.chargers[id].controller = { status: () => ({ phase: 'off',
        session: { connected: state.connected, connectedAt: state.connectedAt,
          lastDisconnectedAt: state.lastDisconnectedAt }, snapshot: { online: true } }), close() {}, async update() {} };
      runtime.chargers[id].adapter = { normalize() {
        const signal = value => ({ value, available: value != null, measuredAt: state.at, receivedAt: state.at });
        return { providerConnected: true, connected: signal(state.connected), charging: signal(state.charging),
          powerKw: signal(state.power), currentA: signal(16), maximumCurrentA: signal(16), voltageV: signal(230) };
      } };
    }
    t.after(() => runtime.close());
    return runtime;
  }
  function capture({ settings = {}, brokerIdentity = 'synthetic-broker', identifying = true } = {}) {
    const capture = createChargingTeslaCapture({ settings, brokerIdentity, clock: () => now });
    capture.setConnected(true);
    const send = (field, value, packet = {}) => capture.receive(capture.topic.replace('#', field), String(value), packet);
    send('geofence', settings.homeGeofence ?? 'Home', { retain: true });
    send('healthy', true); send('battery_level', identifying ? 40 : 90);
    if (identifying) for (const [field, value] of Object.entries({ plugged_in: true, charging_state: 'Charging', charger_power: 7 })) send(field, value);
    return { capture, send };
  }
  return { create, capture, physical, setNow(value) { now = value; }, get now() { return now; } };
}

test('saved Tesla identity is bound to the actual source, including car, broker, namespace and home zone', async t => {
  for (const [name, replacement] of Object.entries({
    car: { settings: { carId: '2' } }, broker: { brokerIdentity: 'another-synthetic-broker' },
    namespace: { settings: { namespace: 'another' } }, home: { settings: { homeGeofence: 'Other Home' } },
    disabled: null,
  })) await t.test(name, t => {
    const f = runtimeFixture(t), runtime = f.create(), original = f.capture();
    runtime.teslaCapture = original.capture; admitChargingObservation(runtime);
    assert.equal(runtime.telemetry(f.now).charger1.vehicle.id, 'tesla');
    assert.equal(runtime.chargers.charger1.vehicleMatch.vehicleAssociation, original.capture.snapshot().association);
    runtime.persist();
    const restarted = f.create();
    if (replacement) restarted.teslaCapture = f.capture({ ...replacement, identifying: false }).capture;
    const telemetry = restarted.telemetry(f.now).charger1;
    assert.equal(telemetry.vehicle.id, null);
    assert.notEqual(telemetry.soc?.value, 90, 'The replacement vehicle cannot lend battery data to the old assignment');
  });
});

test('Tesla power consumption survives restart and fences a quick move to another charger', t => {
  const f = runtimeFixture(t), runtime = f.create(), source = f.capture(); runtime.teslaCapture = source.capture; admitChargingObservation(runtime);
  assert.equal(runtime.telemetry(f.now).charger1.vehicle.id, 'tesla');
  f.setNow(NOW + 1000);
  Object.assign(f.physical.charger1, { connected: false, charging: false, at: f.now,
    connectedAt: null, lastDisconnectedAt: f.now, power: 0 });
  runtime.persist();
  f.setNow(NOW + 2000);
  Object.assign(f.physical.charger2, { connected: true, charging: true, connectedAt: f.now, at: f.now, power: 7 });
  const restarted = f.create(); restarted.teslaCapture = source.capture;
  assert.equal(restarted.telemetry(f.now).charger2.vehicle.id, null,
    'The previous charger already consumed this power evidence before restart');
  f.setNow(NOW + 3000); source.send('charger_power', 6);
  f.setNow(NOW + 4000); source.send('charger_power', 7);
  f.physical.charger2.at = f.now; admitChargingObservation(restarted);
  assert.equal(restarted.telemetry(f.now).charger2.vehicle.id, 'tesla');
});


test('Tesla start correlation survives a long same-session logger gap without renewing change-only clocks', () => {
  const minute = 60_000, homeAt = NOW - 14 * 24 * 60 * minute;
  let now = homeAt, saved;
  let capture = createChargingTeslaCapture({ clock: () => now, saveState: state => { saved = structuredClone(state); } });
  capture.setConnected(true);
  const send = (field, value, packet = {}) => capture.receive(`teslamate/cars/1/${field}`, String(value), packet, now);
  send('geofence', 'Home', { retain: true }); send('plugged_in', true, { retain: true });
  now = NOW; send('healthy', false); send('charging_state', 'Charging'); send('charger_power', 7);
  const options = { ...evidence().options, now };
  assert.equal(matchTeslaSession(capture.snapshot(), options), false);
  const original = capture.snapshot();
  now = NOW + 78 * minute; send('healthy', true);
  const resumed = capture.snapshot(), later = { ...options, now,
    physical: { charging: { available: true, value: true, measuredAt: NOW },
      powerKw: { available: true, value: 7, measuredAt: now } } };
  assert.equal(resumed.atHome, true);
  assert.equal(resumed.fields.geofence.receivedAt, homeAt);
  assert.deepEqual(resumed.fields.charging_state, original.fields.charging_state);
  assert.deepEqual(resumed.fields.charger_power, original.fields.charger_power);
  assert.equal(matchTeslaSession(resumed, later), true);
  assert.equal(matchTeslaSession(resumed, { ...later, consumedPowerAt: NOW }), false);
  assert.equal(matchTeslaSession(resumed, { ...later, chargingAt: [] }), false);
  assert.equal(matchTeslaSession(resumed, { ...later, chargingAt: NOW + 30_001 }), false);
  assert.equal(matchTeslaSession({ ...resumed, healthy: false }, later), false);
  assert.equal(matchTeslaSession(resumed, { ...later, physical: { ...later.physical,
    powerKw: { ...later.physical.powerKw, measuredAt: now - minute - 1 } } }), false);
  assert.equal(matchTeslaSession(resumed, { ...later, connectedAt: NOW + 2 * minute,
    lastDisconnectedAt: NOW + minute }), false);
  capture = createChargingTeslaCapture({ clock: () => now, initialState: saved });
  capture.setConnected(true);
  assert.equal(matchTeslaSession(capture.snapshot(), later), false, 'Saved health alone cannot grant live evidence');
  now += 1000; send('healthy', true);
  assert.equal(matchTeslaSession(capture.snapshot(), { ...later, now }), true);
  assert.equal(capture.snapshot().fields.charger_power.receivedAt, NOW);
});

test('Tesla held home, battery and target are context rather than reusable charging proof', () => {
  let now = NOW - 14 * 24 * 60 * 60_000;
  const capture = createChargingTeslaCapture({ clock: () => now }); capture.setConnected(true);
  const send = (field, value, packet = {}) => capture.receive(`teslamate/cars/1/${field}`, String(value), packet, now);
  for (const [field, value] of Object.entries({ geofence: 'Home', plugged_in: true,
    battery_level: 42, charge_limit_soc: 85, charging_state: 'Charging', charger_power: 7 })) send(field, value, { retain: true });
  now = NOW; send('healthy', true);
  const before = capture.snapshot();
  assert.equal(before.atHome, true);
  const telemetry = teslamateVehicleTelemetry(before, { now });
  assert.equal(telemetry.soc.value, 42); assert.equal(telemetry.minimumSoc.value, 85);
  assert.equal(telemetry.soc.receivedAt, NOW - 14 * 24 * 60 * 60_000);
  assert.equal(matchTeslaSession(before, evidence().options), false,
    'Healthy held target and home cannot promote a retained power or start into a live edge');
  send('battery_level', 43); send('charge_limit_soc', 90);
  assert.equal(matchTeslaSession(capture.snapshot(), evidence().options), false,
    'Battery and target changes do not reset consumed or retained charging evidence');
  send('plugged_in', false); now += 1000; send('plugged_in', true);
  assert.equal(capture.snapshot().atHome, true, 'Unplug/replug does not invalidate held Home');
  assert.equal(matchTeslaSession(capture.snapshot(), { ...evidence().options, now }), false);
  send('geofence', 'Elsewhere');
  assert.equal(capture.snapshot().atHome, false);
  now += 1000; send('geofence', 'Home');
  assert.equal(matchTeslaSession(capture.snapshot(), { ...evidence().options, now }), false,
    'Returning home does not revive charging proof predating departure');
});
