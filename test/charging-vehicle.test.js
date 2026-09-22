import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptVehicleReading, matchBmwSession } from '../src/charging/vehicle.js';
import { ChargingRuntime } from '../src/charging/runtime.js';

const START = Date.parse('2026-09-20T10:00:00Z'), MINUTE = 60_000;
const facts = (at = START, extra = {}) => ({ provider: 'bmw-cardata', soc: 60, readingId: `soc-${at}`, measuredAt: at,
  pluggedIn: true, charging: true, atHome: true, fields: Object.fromEntries(['pluggedIn', 'charging', 'atHome'].map(key =>
    [key, { readingId: `${key}-${at}`, measuredAt: at }])), ...extra });
function accepted(value, previous, retained = false, now = START) {
  return acceptVehicleReading(previous, value, { association: 'stmq/vehicles/bmw', retained, now });
}

test('independent identity updates preserve battery and field measurement clocks; unknown clears old facts', () => {
  const first = accepted(facts()).reading;
  const packet = facts(START + MINUTE); delete packet.soc; delete packet.readingId; delete packet.measuredAt;
  const next = accepted(packet, first, false, START + MINUTE).reading;
  assert.equal(next.soc, 60); assert.equal(next.measuredAt, START); assert.equal(next.receivedAt, START);
  assert.equal(next.fields.pluggedIn.measuredAt, START + MINUTE);
  const unknown = { provider: 'bmw-cardata', atHome: null, fields: { atHome: { measuredAt: null, readingId: 'home-unknown' } } };
  const cleared = accepted(unknown, next, false, START + 2 * MINUTE);
  assert.equal(cleared.accepted, true); assert.equal(cleared.reading.atHome, null);
  assert.equal(accepted(unknown, cleared.reading, false, START + 3 * MINUTE).accepted, false);
  assert.equal(accepted(unknown, next, true, START + 2 * MINUTE).accepted, false,
    'An old retained unknown does not replace already observed live facts');
  const initialIdentityOnly = accepted(packet, null, false, START + MINUTE).reading;
  assert.equal(initialIdentityOnly.soc, undefined); assert.equal(initialIdentityOnly.pluggedIn, true);
});

test('BMW matching requires fresh live source events, home context and corresponding Easee charging', () => {
  const reading = accepted({ provider: 'bmw-cardata', charging: false, fields: { charging: { measuredAt: START + 30_000, readingId: 'stop' } } }, accepted(facts()).reading, false, START + MINUTE).reading;
  const options = { connectedAt: START, chargingAt: START, stoppedAt: START + 30_000, now: START + MINUTE };
  assert.equal(matchBmwSession(reading, options), true);
  for (const override of [{ chargingAt: null }, { stoppedAt: null }, { connectedAt: START + 5 * MINUTE },
    { chargingAt: START + 8 * MINUTE }, { now: START + 16 * MINUTE }, { consumedPlugId: reading.fields.pluggedIn.readingId }])
    assert.equal(matchBmwSession(reading, { ...options, ...override }), false);
  assert.equal(matchBmwSession({ ...reading, atHome: false }, options), false);
  assert.equal(matchBmwSession({ ...reading, atHome: null }, options), false);
  const retained = accepted(facts(), null, true).reading;
  assert.equal(matchBmwSession(retained, options), false);
  const repeatedLive = accepted(facts(), retained, false, START + MINUTE);
  assert.equal(repeatedLive.accepted, false);
  assert.equal(matchBmwSession(repeatedLive.reading, options), false, 'Repeating cached measurements live cannot manufacture a new plug event');
});

test('BMW pre-poll evidence is bounded and remains subject to disconnect and replay safeguards', () => {
  const startedAt = START - 90_000, stoppedAt = START + 30_000;
  const initial = accepted(facts(startedAt), null, false, startedAt).reading;
  const reading = accepted({ provider: 'bmw-cardata', charging: false,
    fields: { charging: { measuredAt: stoppedAt, readingId: 'stop' } } }, initial, false, stoppedAt).reading;
  const options = { connectedAt: START, chargingAt: startedAt, stoppedAt, now: stoppedAt };
  assert.equal(matchBmwSession(reading, options), true);
  assert.equal(matchBmwSession(reading, { ...options, connectedAt: START + 1 }), false,
    'Events more than 90 seconds before the first poll are excluded');
  assert.equal(matchBmwSession(reading, { ...options, lastDisconnectedAt: startedAt - 1 }), true);
  assert.equal(matchBmwSession(reading, { ...options, lastDisconnectedAt: startedAt }), false,
    'Source events at or before the most recent disconnected poll belong outside this connection');
  assert.equal(matchBmwSession(reading, { ...options, consumedPlugId: initial.fields.pluggedIn.positiveEvent.readingId }), false);
  const retained = structuredClone(reading); retained.fields.pluggedIn.positiveEvent.retained = true;
  assert.equal(matchBmwSession(retained, options), false);
  const earlyReceipt = structuredClone(reading); earlyReceipt.fields.pluggedIn.positiveEvent.receivedAt = startedAt - 1;
  assert.equal(matchBmwSession(earlyReceipt, options), false, 'The receipt-time tolerance is also bounded');
  assert.equal(matchBmwSession(reading, { ...options, chargingAt: startedAt - 1 }), false,
    'Easee evidence must be within the same connection window');
});

function fixture() {
  let now = START, connected = true, charging = true, sessionAt = START, verdict = null, identifiedAt = null;
  const tesla = { connected: true, pluggedIn: true, atHome: true, assignment: 'auto', batteryLevel: 75, chargeLimitSoc: 90 };
  const values = new Map(), store = { getState: key => structuredClone(values.get(key)),
    setState: (key, value) => { if (store.fail) throw new Error('database unavailable'); values.set(key, structuredClone(value)); } };
  const engine = { chargerIdentification: { status: () => ({ verdict, identifiedAt }) } };
  const config = { input: 'mqtt' };
  const create = () => {
    const runtime = new ChargingRuntime({ engine, store, config, clock: () => now });
    const item = runtime.chargers.charger1;
    item.adapter = { normalize: () => ({ connected: { value: connected, available: true },
      charging: { value: charging, available: true, measuredAt: now } }) };
    item.controller = { status: () => ({ session: { connectedAt: sessionAt }, snapshot: { readAt: now }, phase: 'off' }), async update() {}, close() {} };
    runtime.teslaCapture = { topic: 'teslamate/cars/1/#', snapshot: () => tesla, reception: () => ({ connected: true }) };
    return runtime;
  };
  return { create, store, config, tesla, setNow: value => { now = value; }, setConnection: (value, at = now) => { connected = value; sessionAt = at; },
    setCharging: value => { charging = value; }, setVerdict: (value, at = now) => { verdict = value; identifiedAt = at; } };
}
const view = runtime => runtime.status().chargers[0];
const publish = (runtime, value, packet) => runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, JSON.stringify(value), packet);
function pauseBmw(runtime, f, at = START + MINUTE) {
  f.setNow(at); f.setCharging(false); runtime.tick();
  publish(runtime, { provider: 'bmw-cardata', charging: false,
    fields: { charging: { measuredAt: at, readingId: `stop-${at}` } } });
}


test('visitor keeps manual defaults until positive BMW correlation, then each available field takes precedence', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  await runtime.setChargerSettings('charger1', { manualSoc: 25, minimumSoc: 80, capacityKwh: 50 });
  publish(runtime, facts(START - 60 * MINUTE), { retain: true });
  assert.equal(view(runtime).vehicle.state, 'unidentified'); assert.equal(view(runtime).values.soc.value, 25);
  publish(runtime, facts(START - MINUTE, { pluggedIn: false, charging: false }));
  publish(runtime, facts(START, { usableCapacityKwh: 72 }));
  assert.equal(view(runtime).vehicle.state, 'unidentified', 'Simultaneous charging starts alone do not identify BMW');
  pauseBmw(runtime, f);
  const identified = view(runtime);
  assert.equal(identified.vehicle.id, 'bmw'); assert.equal(identified.vehicle.state, 'identified');
  assert.equal(identified.values.soc.value, 60); assert.equal(identified.values.soc.source, 'bmw-cardata');
  assert.equal(identified.values.capacityKwh.value, 72); assert.equal(identified.values.minimumSoc.value, 80);
  assert.equal(identified.values.minimumSoc.source, 'manual-fallback');
  assert.equal(runtime.settings.chargers.charger1.manualSoc, 25); assert.equal(runtime.settings.chargers.charger1.capacityKwh, 50);
  assert.equal(runtime.status().vehicleFeeds.find(feed => feed.id === 'bmw').usedByChargerId, 'charger1');
  f.setCharging(false); f.setNow(START + 2 * MINUTE); runtime.tick();
  assert.equal(view(runtime).vehicle.id, 'bmw');
  const restarted = f.create(); t.after(() => restarted.close());
  assert.equal(view(restarted).vehicle.id, 'bmw'); assert.equal(view(restarted).values.soc.value, 60);
  f.setConnection(false); restarted.tick(); assert.equal(view(restarted).vehicle.state, 'disconnected');
  f.setNow(START + 3 * MINUTE); f.setConnection(true); restarted.tick();
  assert.equal(view(restarted).vehicle.state, 'unidentified'); assert.equal(view(restarted).values.soc.value, 25);
});

test('identity-only BMW can match without imposing absent battery fields', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  const packet = facts(); delete packet.soc; delete packet.readingId; delete packet.measuredAt;
  publish(runtime, packet); pauseBmw(runtime, f);
  assert.equal(view(runtime).vehicle.id, 'bmw'); assert.equal(view(runtime).values.soc.source, 'manual-fallback');
  assert.equal(view(runtime).values.minimumSoc.source, 'manual-fallback');
});

test('negative Tesla verdict is not BMW evidence; positive Tesla moves one session and stale verdict cannot match a new connection', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  f.setVerdict('other'); runtime.tick(); assert.equal(view(runtime).vehicle.state, 'unidentified');
  f.setVerdict('easee'); runtime.tick();
  assert.equal(view(runtime).vehicle.id, 'tesla'); assert.equal(view(runtime).values.soc.value, 75);
  const second = runtime.status().chargers[1];
  assert.equal(second.vehicle.state, 'elsewhere'); assert.equal(second.vehicle.chargerId, 'charger1');
  assert.equal(second.values.connected.value, false); assert.equal(second.automatic.soc.available, false);
  f.setVerdict(null); f.setCharging(false); runtime.tick(); assert.equal(view(runtime).vehicle.id, 'tesla');
  f.setConnection(false); runtime.tick(); f.setNow(START + MINUTE); f.setConnection(true);
  f.setVerdict('easee', START); runtime.tick(); assert.equal(view(runtime).vehicle.state, 'unidentified');
});

test('competing positive evidence remains unidentified for the connection', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  f.setVerdict('easee'); publish(runtime, facts()); pauseBmw(runtime, f);
  assert.equal(view(runtime).vehicle.state, 'unidentified');
  assert.equal(view(runtime).vehicle.reason, 'conflicting-vehicle-evidence');
  assert.equal(view(runtime).values.soc.source, 'manual-fallback');
  f.setVerdict(null); runtime.tick(); assert.equal(view(runtime).vehicle.state, 'unidentified');
});

test('new timestamps on unchanged plugged/charging states cannot turn a parked BMW into a new connection event', () => {
  const old = accepted(facts(START - 60 * MINUTE), null, true).reading;
  const updated = accepted(facts(), old, false).reading;
  assert.equal(updated.fields.pluggedIn.measuredAt, START);
  assert.equal(updated.fields.pluggedIn.event.measuredAt, START - 60 * MINUTE);
  assert.equal(matchBmwSession(updated, { connectedAt: START, chargingAt: START, now: START }), false);
  const unplugged = accepted(facts(START + MINUTE, { pluggedIn: false, charging: false }), updated, false, START + MINUTE).reading;
  const replugged = accepted(facts(START + 2 * MINUTE), unplugged, false, START + 2 * MINUTE).reading;
  assert.equal(matchBmwSession(replugged, { connectedAt: START + 2 * MINUTE, chargingAt: START + 2 * MINUTE, now: START + 2 * MINUTE }), false, 'A fresh start still needs a corresponding pause');
});

test('later competing evidence revokes an earlier association without selecting a different car', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  publish(runtime, facts()); pauseBmw(runtime, f); assert.equal(view(runtime).vehicle.id, 'bmw');
  f.setNow(START + MINUTE); f.setVerdict('easee'); runtime.tick();
  assert.equal(view(runtime).vehicle.state, 'unidentified');
  assert.equal(view(runtime).vehicle.reason, 'conflicting-vehicle-evidence');
});

test('target and capacity remain independent automatic fields when SoC is absent', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  const packet = facts(undefined, { usableCapacityKwh: 68, chargeLimitSoc: 88 });
  delete packet.soc; delete packet.readingId; delete packet.measuredAt;
  for (const key of ['usableCapacityKwh', 'chargeLimitSoc']) packet.fields[key] = { measuredAt: START, readingId: `${key}-1` };
  publish(runtime, packet); pauseBmw(runtime, f);
  assert.equal(view(runtime).vehicle.id, 'bmw'); assert.equal(view(runtime).values.soc.source, 'manual-fallback');
  assert.equal(view(runtime).values.capacityKwh.value, 68); assert.equal(view(runtime).values.minimumSoc.value, 88);
  const previous = structuredClone(runtime.vehicleFeeds.bmw.reading);
  f.setNow(START + MINUTE); publish(runtime, packet);
  assert.deepEqual(runtime.vehicleFeeds.bmw.reading, previous);
  publish(runtime, facts(START + MINUTE));
  assert.equal(view(runtime).values.soc.value, 60); assert.equal(view(runtime).values.capacityKwh.value, 68);
});

test('future source clocks cannot identify a charging session before those observations occur', () => {
  const future = accepted({ provider: 'bmw-cardata', charging: false,
    fields: { charging: { measuredAt: START + 90_000, readingId: 'future-stop' } } }, accepted(facts(START + MINUTE)).reading).reading;
  assert.equal(matchBmwSession(future, { connectedAt: START - MINUTE, chargingAt: START - 30_000, stoppedAt: START, now: START }), false);
  const current = accepted({ provider: 'bmw-cardata', charging: false,
    fields: { charging: { measuredAt: START + 30_000, readingId: 'stop' } } }, accepted(facts()).reading, false, START + MINUTE).reading;
  const options = { connectedAt: START, chargingAt: START, stoppedAt: START + 30_000, now: START + MINUTE };
  assert.equal(matchBmwSession(current, options), true);
  current.fields.atHome.measuredAt = START + 2 * MINUTE;
  assert.equal(matchBmwSession(current, options), false);
  assert.equal(acceptVehicleReading(null, { provider: 'bmw-cardata', atHome: null,
    fields: { atHome: { measuredAt: null, readingId: 'unknown' } } }).accepted, true);
});

test('unknown gaps cannot promote retained or unchanged source facts into new live events', () => {
  const initial = accepted(facts(), null, true).reading;
  const missing = { provider: 'bmw-cardata', pluggedIn: null, charging: null,
    fields: Object.fromEntries(['pluggedIn', 'charging'].map(key => [key, { measuredAt: null, readingId: `unknown-${key}` }])) };
  const unknown = accepted(missing, initial, false, START + 10_000).reading;
  assert.equal(unknown.pluggedIn, null);
  for (const at of [START, START + 20_000]) {
    const replay = accepted(facts(at), unknown, false, START + 20_000).reading;
    assert.equal(replay.pluggedIn, true);
    assert.equal(replay.fields.pluggedIn.event.retained, true);
    assert.equal(replay.fields.pluggedIn.event.measuredAt, START);
    assert.equal(matchBmwSession(replay, { connectedAt: START, chargingAt: START, now: START + 20_000 }), false);
  }
});

test('late negative source evidence revokes BMW even when its source clock precedes receipt-time identification', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  runtime.tick(); f.setNow(START + 4 * MINUTE); publish(runtime, facts());
  pauseBmw(runtime, f, START + 4 * MINUTE);
  assert.equal(view(runtime).vehicle.id, 'bmw');
  f.setNow(START + 5 * MINUTE); publish(runtime, facts(START + 3 * MINUTE, { pluggedIn: false }));
  assert.equal(view(runtime).vehicle.state, 'unidentified');
});

test('BMW target can change independently from 100 to 95 without rebasing its 85 percent measurement', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  const packet = facts(START, { soc: 85, chargeLimitSoc: 100, usableCapacityKwh: 72 });
  packet.fields.chargeLimitSoc = { measuredAt: START, readingId: 'target-100' };
  publish(runtime, packet); pauseBmw(runtime, f);
  const anchor = { measuredAt: view(runtime).values.soc.measuredAt, receivedAt: view(runtime).values.soc.receivedAt };
  f.setNow(START + 2 * MINUTE);
  publish(runtime, { ...packet, chargeLimitSoc: 95,
    fields: { ...packet.fields, chargeLimitSoc: { measuredAt: START + 2 * MINUTE, readingId: 'target-95' } } });
  assert.equal(view(runtime).values.minimumSoc.value, 95); assert.equal(view(runtime).values.minimumSoc.source, 'bmw-cardata');
  assert.equal(view(runtime).values.soc.value, 85);
  assert.deepEqual({ measuredAt: view(runtime).values.soc.measuredAt, receivedAt: view(runtime).values.soc.receivedAt }, anchor);
  assert.equal(view(runtime).referenceGridKwh, 72 * .1 / .925);
});

test('editing Tesla capacity at Charger 1 edits its vehicle fallback and preserves visitor capacity', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  await runtime.setChargerSettings('charger1', { capacityKwh: 50 });
  await runtime.setChargerSettings('charger2', { capacityKwh: 60 });
  f.setVerdict('easee'); runtime.tick();
  assert.equal(view(runtime).settings.capacityKwh, 60); assert.equal(view(runtime).values.capacityKwh.value, 60);
  await runtime.setChargerSettings('charger1', { capacityKwh: 58 });
  assert.equal(view(runtime).settings.capacityKwh, 58); assert.equal(view(runtime).values.capacityKwh.value, 58);
  assert.equal(runtime.settings.chargers.charger1.capacityKwh, 50); assert.equal(runtime.settings.chargers.charger2.capacityKwh, 58);
  assert.equal(view(runtime).referenceGridKwh, 58 * .15 / .925);
  f.setConnection(false); runtime.tick(); assert.equal(view(runtime).settings.capacityKwh, 50);
  assert.equal(view(runtime).values.capacityKwh.value, 50);
});

test('old Tesla plug state cannot rebound from unplugged Easee into a duplicate Charger 2 session, including restart', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  f.setVerdict('easee'); runtime.tick(); f.setNow(START + MINUTE); f.setConnection(false); runtime.tick();
  assert.equal(runtime.status().chargers[1].values.connected.value, false);
  const restarted = f.create(); t.after(() => restarted.close());
  assert.equal(restarted.status().chargers[1].values.connected.value, false);
  f.setNow(START + 2 * MINUTE); f.tesla.fields = { plugged_in: { receivedAt: START + 2 * MINUTE, retained: true } };
  restarted.tick(); assert.equal(restarted.status().chargers[1].values.connected.value, false);
  f.tesla.fields.plugged_in.retained = false; restarted.tick();
  assert.equal(restarted.status().chargers[1].values.connected.value, true);
});

test('fresh Tesla unplug evidence revokes a match and stale probe verdict cannot restore it', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  f.setVerdict('easee'); runtime.tick();
  f.setNow(START + MINUTE); f.tesla.pluggedIn = false;
  f.tesla.fields = { plugged_in: { receivedAt: START + MINUTE, retained: false } };
  runtime.tick(); assert.equal(view(runtime).vehicle.state, 'unidentified');
  f.setNow(START + 2 * MINUTE); f.tesla.pluggedIn = true; f.tesla.fields.plugged_in.receivedAt = START + 2 * MINUTE;
  runtime.tick(); assert.equal(view(runtime).vehicle.state, 'unidentified');
  f.setVerdict('easee'); runtime.tick(); assert.equal(view(runtime).vehicle.id, 'tesla');
});

test('a failed identity persistence cannot consume an event or leave a phantom match', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  publish(runtime, facts()); f.setNow(START + MINUTE); f.setCharging(false); runtime.tick();
  const original = structuredClone(runtime.vehicleFeeds.bmw.reading);
  const pause = { provider: 'bmw-cardata', charging: false,
    fields: { charging: { measuredAt: START + MINUTE, readingId: 'pause' } } };
  f.store.fail = true; assert.throws(() => publish(runtime, pause), /database unavailable/);
  assert.equal(view(runtime).vehicle.state, 'unidentified'); assert.deepEqual(runtime.vehicleFeeds.bmw.reading, original);
  assert.equal(runtime.vehicleFeeds.bmw.consumedPlugId, null);
  f.store.fail = false; publish(runtime, pause); assert.equal(view(runtime).vehicle.id, 'bmw');
});

test('known vehicle readings survive temporary unknown charger state without reverting to visitor defaults', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  publish(runtime, facts(START, { usableCapacityKwh: 72, chargeLimitSoc: 90 })); pauseBmw(runtime, f);
  const before = view(runtime);
  f.setConnection(null, START); runtime.tick();
  const offline = view(runtime);
  assert.equal(offline.values.connected.value, null); assert.equal(offline.vehicle.id, 'bmw');
  for (const key of ['soc', 'minimumSoc', 'capacityKwh']) assert.deepEqual(offline.values[key], before.values[key]);
  assert.equal(offline.referenceGridKwh, before.referenceGridKwh);
});

test('independent source topics never inherit another vehicle previous battery or identity facts', () => {
  const previous = accepted(facts()).reading;
  const result = acceptVehicleReading(previous, { provider: 'bmw-cardata', atHome: true,
    fields: { atHome: { measuredAt: START, readingId: 'different-home' } } }, { association: 'another/vehicle', now: START });
  assert.equal(result.accepted, true); assert.equal(result.reading.soc, undefined); assert.equal(result.reading.pluggedIn, undefined);
});

test('replacing or disabling a BMW source invalidates its saved charger match', async t => {
  for (const mqttTopic of ['stmq/test/replacement-bmw', null]) await t.test(String(mqttTopic), async t => {
    const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
    publish(runtime, facts()); pauseBmw(runtime, f);
    assert.equal(view(runtime).vehicle.id, 'bmw');
    f.config.charging = { vehicles: { bmw: { mqttTopic } } };
    const restarted = f.create(); t.after(() => restarted.close());
    assert.equal(view(restarted).vehicle.state, 'unidentified');
    assert.equal(restarted.vehicleFeeds.bmw.consumedPlugId, null);
    if (mqttTopic) publish(restarted, { provider: 'bmw-cardata', soc: 90, measuredAt: START + MINUTE, readingId: 'replacement-soc' });
    assert.equal(view(restarted).values.soc.source, 'manual-fallback', 'A replacement battery feed cannot inherit the previous vehicle identification');
  });
});

test('vehicle unplug evidence revokes identification even while charger connection telemetry is unknown', async t => {
  for (const vehicle of ['bmw', 'tesla']) await t.test(vehicle, async t => {
    const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
    if (vehicle === 'bmw') { publish(runtime, facts()); pauseBmw(runtime, f); }
    else { f.setVerdict('easee'); runtime.tick(); }
    assert.equal(view(runtime).vehicle.id, vehicle);
    f.setConnection(null, START); f.setNow(START + 2 * MINUTE);
    if (vehicle === 'bmw') publish(runtime, facts(START + 2 * MINUTE, { pluggedIn: false }));
    else {
      f.tesla.pluggedIn = false;
      f.tesla.fields = { plugged_in: { receivedAt: START + 2 * MINUTE, retained: false } };
      runtime.tick();
    }
    assert.equal(view(runtime).vehicle.state, 'unidentified');
    assert.equal(view(runtime).values.soc.source, 'manual-fallback');
    f.setConnection(true, START); f.tesla.pluggedIn = true; runtime.tick();
    assert.equal(view(runtime).vehicle.state, 'unidentified', 'Old positive evidence cannot restore a revoked match');
  });
});

test('capacity edits reject a changed vehicle profile and always use Tesla capacity on its observation card', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  await runtime.setChargerSettings('charger1', { capacityKwh: 50, capacityProfile: 'generic:charger1' });
  f.setVerdict('easee'); runtime.tick();
  const before = structuredClone(runtime.settings);
  await assert.rejects(runtime.setChargerSettings('charger1', { capacityKwh: 70, capacityProfile: 'generic:charger1' }), /Vehicle changed/);
  assert.deepEqual(runtime.settings, before);
  await runtime.setChargerSettings('charger1', { capacityKwh: 58, capacityProfile: 'tesla' });
  await runtime.setChargerSettings('charger2', { capacityKwh: 59, capacityProfile: 'tesla' });
  assert.equal(runtime.settings.chargers.charger2.capacityKwh, 59);
  assert.equal(runtime.settings.chargers.charger1.capacityKwh, 50);
  f.setConnection(false); runtime.tick();
  await assert.rejects(runtime.setChargerSettings('charger1', { capacityKwh: 60, capacityProfile: 'tesla' }), /Vehicle changed/);
  await runtime.setChargerSettings('charger2', { capacityKwh: 61, capacityProfile: 'tesla' });
  assert.equal(runtime.settings.chargers.charger2.capacityKwh, 61);
  await assert.rejects(runtime.setChargerSettings('charger1', { capacityProfile: 'generic:charger1' }), /requires a capacity setting/);
});
