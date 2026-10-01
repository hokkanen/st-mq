import { withReportDatabase } from './helpers/report-database.js';
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

test('a live home-zone correction can identify the measured session without refreshing GPS or battery age', () => {
  const initial = accepted(facts(START, { atHome: false })).reading;
  const stoppedAt = START + 30_000;
  const stopped = accepted({ provider: 'bmw-cardata', charging: false,
    fields: { charging: { measuredAt: stoppedAt, readingId: 'charging-stopped' } } }, initial, false, stoppedAt).reading;
  const options = { connectedAt: START, chargingAt: START, stoppedAt, now: START + MINUTE };
  assert.equal(matchBmwSession(stopped, options), false);
  const corrected = accepted({ provider: 'bmw-cardata', atHome: true,
    fields: { atHome: { measuredAt: START, readingId: 'home-corrected' } } }, stopped, false, options.now);
  assert.equal(corrected.accepted, true); assert.equal(corrected.reading.atHome, true);
  assert.equal(corrected.reading.fields.atHome.measuredAt, START);
  assert.equal(corrected.reading.measuredAt, START); assert.equal(corrected.reading.receivedAt, START);
  for (const key of ['pluggedIn', 'charging']) assert.deepEqual(corrected.reading.fields[key], stopped.fields[key]);
  assert.equal(matchBmwSession(corrected.reading, options), true);
});

test('same-clock home corrections reject retained rollback, duplicates and older or invalid GPS clocks', () => {
  const home = (value, readingId, measuredAt = START) => ({ provider: 'bmw-cardata', atHome: value,
    fields: { atHome: { measuredAt, readingId } } });
  const initial = accepted(home(false, 'home-away'), null, true).reading;
  const now = START + MINUTE;
  const corrected = accepted(home(true, 'home-corrected'), initial, false, now).reading;
  assert.equal(corrected.atHome, true, 'A live correction can replace the initial retained home calculation');
  for (const [packet, retained] of [[home(false, 'home-away'), true], [home(true, 'home-corrected'), false],
    [home(false, 'home-corrected'), false], [home(false, 'home-older', START - 1), false]]) {
    const replayed = accepted(packet, corrected, retained, now + MINUTE);
    assert.equal(replayed.accepted, false); assert.deepEqual(replayed.reading, corrected);
  }
  const future = accepted(home(false, 'home-future', now + 6 * MINUTE), corrected, false, now);
  assert.equal(future.accepted, false); assert.equal(future.reason, 'invalid-field-metadata');
  const away = accepted(home(false, 'home-away-again'), corrected, false, now + MINUTE);
  assert.equal(away.accepted, true); assert.equal(away.reading.atHome, false);
  assert.equal(accepted(home(true, 'home-corrected'), away.reading, true, now + MINUTE).accepted, false);
});

test('home recomputation cannot manufacture plug or charging events or refresh original home measurements', () => {
  const initial = accepted(facts(START, { atHome: false, pluggedIn: false, charging: false })).reading;
  const packet = facts();
  for (const field of Object.values(packet.fields)) field.readingId += '-revised';
  const corrected = accepted(packet, initial, false, START + MINUTE).reading;
  assert.equal(corrected.atHome, true);
  for (const key of ['pluggedIn', 'charging']) {
    assert.equal(corrected[key], false); assert.deepEqual(corrected.fields[key], initial.fields[key]);
  }
  const staleAt = START - 25 * 60 * MINUTE;
  const oldHome = accepted({ provider: 'bmw-cardata', atHome: false,
    fields: { atHome: { measuredAt: staleAt, readingId: 'old-away' } } }).reading;
  const staleCorrection = accepted({ provider: 'bmw-cardata', atHome: true,
    fields: { atHome: { measuredAt: staleAt, readingId: 'old-home-corrected' } } }, oldHome, false, START).reading;
  assert.equal(staleCorrection.fields.atHome.measuredAt, staleAt);
  const stoppedAt = START + 30_000;
  const stopped = accepted({ provider: 'bmw-cardata', charging: false,
    fields: { charging: { measuredAt: stoppedAt, readingId: 'stop' } } }, accepted(facts()).reading, false, stoppedAt).reading;
  assert.equal(matchBmwSession({ ...stopped, fields: { ...stopped.fields, atHome: staleCorrection.fields.atHome } },
    { connectedAt: START, chargingAt: START, stoppedAt, now: START + MINUTE }), true);
});

test('BMW matching requires live current-session source events, home context and corresponding Easee charging', () => {
  const reading = accepted({ provider: 'bmw-cardata', charging: false, fields: { charging: { measuredAt: START + 30_000, readingId: 'stop' } } }, accepted(facts()).reading, false, START + MINUTE).reading;
  const options = { connectedAt: START, chargingAt: START, stoppedAt: START + 30_000, now: START + MINUTE };
  assert.equal(matchBmwSession(reading, options), true);
  for (const override of [{ chargingAt: null }, { stoppedAt: null }, { connectedAt: START + 5 * MINUTE },
    { chargingAt: START + 8 * MINUTE }, { consumedPlugId: reading.fields.pluggedIn.readingId }])
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

function fixture(chargingConfig = {}) {
  let now = START, connected = true, charging = true, sessionAt = START, verdict = null, identifiedAt = null;
  const tesla = { association: 'synthetic-tesla-feed', connected: true, pluggedIn: true, atHome: true, assignment: 'auto', batteryLevel: 75, chargeLimitSoc: 90 };
  const values = new Map(), store = { getState: key => structuredClone(values.get(key)),
    setState: (key, value) => { if (store.fail) throw new Error('database unavailable'); values.set(key, structuredClone(value)); } };
  withReportDatabase(store);
  const engine = {};
  const config = { input: 'mqtt', charging: chargingConfig };
  const create = () => {
    const runtime = new ChargingRuntime({ engine, store, config, clock: () => now });
    runtime.setMqttStatus({connected:true,subscribed:true},'bmw');
    const item = runtime.chargers.charger1;
    item.adapter = { normalize: () => ({ connected: { value: connected, available: true },
      charging: { value: charging, available: true, measuredAt: now }, powerKw:{value:charging?7:0,available:true,measuredAt:now} }) };
    item.controller = { status: () => ({ session: { connectedAt: sessionAt }, snapshot: { readAt: now }, phase: 'off' }), async update() {}, close() {} };
    runtime.teslaCapture = { topic: 'teslamate/cars/1/#', snapshot: () => tesla, reception: () => ({ connected: true }) };
    return runtime;
  };
  return { create, store, config, tesla, setNow: value => { now = value; }, setConnection: (value, at = now) => { connected = value; sessionAt = at; },
    setCharging: value => { charging = value; }, setTeslaEvidence: (value, at = now) => { tesla.healthy=value==='easee'; tesla.charging=charging; tesla.actualPowerKw=7; tesla.fields={charger_power:{receivedAt:at,retained:false},plugged_in:{receivedAt:sessionAt,retained:false}}; } };
}
const view = runtime => runtime.status().chargers[0];
const sessionEdit = (runtime, changes) => {
  const current = view(runtime);
  return { scope: 'session', association: current.association, sessionId: current.request.sessionId,
    revision: current.request.revision, changes };
};
const publish = (runtime, value, packet) => runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, JSON.stringify(value), packet);
function pauseBmw(runtime, f, at = START + MINUTE) {
  f.setNow(at); f.setCharging(false); runtime.tick();
  publish(runtime, { provider: 'bmw-cardata', charging: false,
    fields: { charging: { measuredAt: at, readingId: `stop-${at}` } } });
}


test('visitor keeps manual defaults until positive BMW correlation, then each available field takes precedence', async t => {
  const f = fixture({ defaults: { manualSoc: 25, minimumSoc: 80, capacityKwh: 50 } }), runtime = f.create(); t.after(() => runtime.close());
  publish(runtime, facts(START - 60 * MINUTE), { retain: true });
  assert.equal(view(runtime).vehicle.state, 'unidentified'); assert.equal(view(runtime).values.soc.value, 25);
  publish(runtime, facts(START - MINUTE, { pluggedIn: false, charging: false }));
  publish(runtime, facts(START, { usableCapacityKwh: 72 }));
  assert.equal(view(runtime).vehicle.state, 'identifying', 'Simultaneous starts remain pending until a corresponding stop');
  assert.equal(view(runtime).vehicle.reason, 'awaiting-stop-confirmation');
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
  assert.equal(view(restarted).vehicle.id, 'bmw'); assert.equal(view(restarted).values.soc.value, 25);
  assert.equal(view(restarted).progress.estimatedSoc, 60, 'The last same-session vehicle anchor survives while awaiting a live bridge report');
  publish(restarted, facts(START, { usableCapacityKwh: 72 }));
  assert.equal(view(restarted).values.soc.value, 60);
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

test('BMW bridge silence expires automatic fields while preserving same-session progress and manual control inputs', async t => {
  const f = fixture({ defaults: { manualSoc: 90, minimumSoc: 85 } }), runtime = f.create(); t.after(() => runtime.close());
  publish(runtime, facts(START, { usableCapacityKwh: 74, chargeLimitSoc: 85 })); pauseBmw(runtime, f);
  runtime.readEnergy = () => ({ gridKwh: 4, coveredMs: MINUTE }); runtime.tick();
  const before = view(runtime);
  assert.equal(before.vehicle.id, 'bmw'); assert.ok(before.progress.estimatedSoc < 85);
  const original = structuredClone(runtime.vehicleFeeds.bmw.reading);
  f.setNow(START + 12 * MINUTE); runtime.tick();
  const silent = view(runtime);
  assert.equal(silent.vehicleMqtt.brokerConnected, true);
  assert.equal(silent.vehicleMqtt.available, false); assert.equal(silent.vehicleMqtt.reason, 'vehicle-feed-stale');
  assert.equal(silent.automatic.soc.available, false); assert.equal(silent.automatic.minimumSoc.available, false);
  assert.equal(silent.values.soc.value, 90, 'The saved fallback remains a separate editable value');
  assert.equal(silent.progress.estimatedSoc, before.progress.estimatedSoc);
  assert.equal(silent.progress.retainedVehicleReference, true);
  assert.equal(silent.requiredGridKwh, before.requiredGridKwh, 'Feed loss cannot turn an incomplete battery into a completed target');
  assert.deepEqual(runtime.vehicleFeeds.bmw.reading, original, 'Expiry does not alter the original report or clocks');
  runtime.readEnergy = () => null;
  const request = silent.request;
  await runtime.setChargerSettings('charger1', { scope: 'session', association: silent.association,
    sessionId: request.sessionId, revision: request.revision,
    changes: { manualSoc: 35, minimumSoc: 80, capacityKwh: 70, readyBy: '07:00' } });
  const manual = view(runtime);
  assert.equal(manual.progress.estimatedSoc, 35); assert.equal(manual.progress.retainedVehicleReference, false);
  assert.equal(manual.values.minimumSoc.value, 80); assert.equal(manual.values.capacityKwh.value, 70);
  assert.equal(manual.settings.readyBy, '07:00'); assert.ok(manual.requiredGridKwh > 0);
});

test('only valid live BMW heartbeats restore source availability without refreshing battery measurement clocks', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  const report = facts(START, { chargeLimitSoc: 85 });
  publish(runtime, report); pauseBmw(runtime, f);
  const original = structuredClone(runtime.vehicleFeeds.bmw.reading);
  f.setNow(START + 12 * MINUTE);
  for (const packet of [{ retain: true }, { dup: true }]) {
    publish(runtime, report, packet);
    assert.equal(view(runtime).vehicleMqtt.available, false);
  }
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, '{invalid');
  assert.equal(view(runtime).vehicleMqtt.available, false);
  publish(runtime, report);
  assert.equal(view(runtime).vehicleMqtt.available, true); assert.equal(view(runtime).values.soc.source, 'bmw-cardata');
  assert.deepEqual(runtime.vehicleFeeds.bmw.reading, original);
  runtime.setMqttStatus({ connected: false, subscribed: false, reason: 'mqtt-disconnected' });
  runtime.setMqttStatus({ connected: true, subscribed: true, reason: null });
  assert.equal(view(runtime).vehicleMqtt.available, false, 'A broker reconnect awaits new bridge traffic');
  publish(runtime, report); assert.equal(view(runtime).vehicleMqtt.available, true);
});

test('negative Tesla verdict is not BMW evidence; positive Tesla moves one session and stale verdict cannot match a new connection', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  f.setTeslaEvidence('other'); runtime.tick(); assert.equal(view(runtime).vehicle.state, 'unidentified');
  f.setTeslaEvidence('easee'); runtime.tick();
  assert.equal(view(runtime).vehicle.id, 'tesla'); assert.equal(view(runtime).values.soc.value, 75);
  const second = runtime.status().chargers[1];
  assert.equal(second.vehicle.id, null);
  assert.equal(second.values.connected.value, null); assert.equal(second.automatic.soc.available, false);
  f.setTeslaEvidence(null); f.setCharging(false); runtime.tick(); assert.equal(view(runtime).vehicle.id, 'tesla');
  f.setConnection(false); runtime.tick(); f.setNow(START + MINUTE); f.setConnection(true);
  f.setTeslaEvidence('easee', START); runtime.tick(); assert.equal(view(runtime).vehicle.state, 'unidentified');
});

test('competing positive evidence remains unidentified for the connection', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  f.setTeslaEvidence('easee'); publish(runtime, facts()); pauseBmw(runtime, f);
  assert.equal(view(runtime).vehicle.state, 'conflict');
  assert.equal(view(runtime).vehicle.reason, 'conflicting-vehicle-evidence');
  assert.equal(view(runtime).values.soc.source, 'manual-fallback');
  f.setTeslaEvidence(null); runtime.tick(); assert.equal(view(runtime).vehicle.state, 'conflict');
});

test('new timestamps on unchanged plugged/charging states cannot turn a parked BMW into a new connection event', () => {
  const old = accepted(facts(START - 60 * MINUTE), null, true).reading;
  const updated = accepted(facts(), old, false).reading;
  assert.equal(updated.fields.pluggedIn.measuredAt, START);
  assert.equal(updated.fields.pluggedIn.positiveEvent.measuredAt, START - 60 * MINUTE);
  assert.equal(matchBmwSession(updated, { connectedAt: START, chargingAt: START, now: START }), false);
  const unplugged = accepted(facts(START + MINUTE, { pluggedIn: false, charging: false }), updated, false, START + MINUTE).reading;
  const replugged = accepted(facts(START + 2 * MINUTE), unplugged, false, START + 2 * MINUTE).reading;
  assert.equal(matchBmwSession(replugged, { connectedAt: START + 2 * MINUTE, chargingAt: START + 2 * MINUTE, now: START + 2 * MINUTE }), false, 'A fresh start still needs a corresponding pause');
});

test('later competing evidence revokes an earlier association without selecting a different car', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  publish(runtime, facts()); pauseBmw(runtime, f); assert.equal(view(runtime).vehicle.id, 'bmw');
  f.setNow(START + 2 * MINUTE); f.setCharging(true); f.setTeslaEvidence('easee'); runtime.tick();
  assert.equal(view(runtime).vehicle.state, 'conflict');
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
    assert.equal(replay.fields.pluggedIn.positiveEvent.retained, true);
    assert.equal(replay.fields.pluggedIn.positiveEvent.measuredAt, START);
    assert.equal(matchBmwSession(replay, { connectedAt: START, chargingAt: START, now: START + 20_000 }), false);
  }
});

test('late negative source evidence revokes BMW even when its source clock precedes receipt-time identification', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  runtime.tick(); f.setNow(START + 4 * MINUTE); publish(runtime, facts());
  pauseBmw(runtime, f, START + 4 * MINUTE);
  assert.equal(view(runtime).vehicle.id, 'bmw');
  f.setNow(START + 5 * MINUTE); publish(runtime, facts(START + 3 * MINUTE, { pluggedIn: false }));
  assert.equal(view(runtime).vehicle.state, 'disconnected');
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
  assert.equal(view(runtime).values.minimumSoc.value, 95); assert.equal(view(runtime).values.minimumSoc.source, 'bmw-target-filter');
  assert.equal(view(runtime).values.soc.value, 85);
  assert.deepEqual({ measuredAt: view(runtime).values.soc.measuredAt, receivedAt: view(runtime).values.soc.receivedAt }, anchor);
  assert.equal(view(runtime).referenceGridKwh, 72 * .1 / .925);
});

test('session capacity edit preserves configured Tesla and unidentified defaults across disconnect and restart', async t => {
  const f = fixture({ defaults: { capacityKwh: 50 }, vehicles: { tesla: { defaults: { capacityKwh: 60 } } } });
  const runtime = f.create(); t.after(() => runtime.close());
  f.setTeslaEvidence('easee'); runtime.tick();
  assert.equal(view(runtime).settings.capacityKwh, 60); assert.equal(view(runtime).values.capacityKwh.value, 60);
  const initial = view(runtime);
  await runtime.setChargerSettings('charger1', { scope: 'session', association: initial.association,
    sessionId: initial.request.sessionId, revision: initial.request.revision, changes: { capacityKwh: 58 } });
  assert.equal(view(runtime).settings.capacityKwh, 58); assert.equal(view(runtime).values.capacityKwh.value, 58);
  assert.equal(runtime.settings.chargers.charger1.capacityKwh, 50); assert.equal(runtime.settings.vehicles.tesla.capacityKwh, 60);
  assert.equal(view(runtime).referenceGridKwh, 58 * .15 / .925);
  const restarted = f.create(); t.after(() => restarted.close());
  assert.equal(view(restarted).values.capacityKwh.value, 58);
  assert.equal(restarted.settings.vehicles.tesla.capacityKwh, 60);
  f.setConnection(false); restarted.tick(); assert.equal(view(restarted).settings.capacityKwh, 50);
  assert.equal(view(restarted).values.capacityKwh.value, 50);
});

test('old Tesla plug state cannot rebound from unplugged Easee into a duplicate Charger 2 session, including restart', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  f.setTeslaEvidence('easee'); runtime.tick(); f.setNow(START + MINUTE); f.setConnection(false); runtime.tick();
  assert.equal(runtime.status().chargers[1].values.connected.value, null);
  const restarted = f.create(); t.after(() => restarted.close());
  assert.equal(restarted.status().chargers[1].values.connected.value, null);
  f.setNow(START + 2 * MINUTE); f.tesla.fields = { plugged_in: { receivedAt: START + 2 * MINUTE, retained: true } };
  restarted.tick(); assert.equal(restarted.status().chargers[1].values.connected.value, null);
  f.tesla.fields.plugged_in.retained = false; restarted.tick();
  assert.equal(restarted.status().chargers[1].values.connected.value, null);
});

test('fresh Tesla unplug evidence revokes a match and stale probe verdict cannot restore it', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  f.setTeslaEvidence('easee'); runtime.tick();
  f.setNow(START + MINUTE); f.tesla.pluggedIn = false;
  f.tesla.fields = { plugged_in: { receivedAt: START + MINUTE, retained: false } };
  runtime.tick(); assert.equal(view(runtime).vehicle.state, 'unidentified');
  f.setNow(START + 2 * MINUTE); f.tesla.pluggedIn = true; f.tesla.fields.plugged_in.receivedAt = START + 2 * MINUTE;
  runtime.tick(); assert.equal(view(runtime).vehicle.state, 'unidentified');
  f.setTeslaEvidence('easee'); runtime.tick(); assert.equal(view(runtime).vehicle.id, 'tesla');
});

test('a failed identity persistence cannot consume an event or leave a phantom match', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  publish(runtime, facts()); f.setNow(START + MINUTE); f.setCharging(false); runtime.tick();
  const original = structuredClone(runtime.vehicleFeeds.bmw.reading);
  const pause = { provider: 'bmw-cardata', charging: false,
    fields: { charging: { measuredAt: START + MINUTE, readingId: 'pause' } } };
  f.store.fail = true; assert.throws(() => publish(runtime, pause), /database unavailable/);
  assert.equal(view(runtime).vehicle.state, 'identifying'); assert.equal(view(runtime).vehicle.id, null);
  assert.deepEqual(runtime.vehicleFeeds.bmw.reading, original);
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
    else { f.setTeslaEvidence('easee'); runtime.tick(); }
    assert.equal(view(runtime).vehicle.id, vehicle);
    f.setConnection(null, START); f.setNow(START + 2 * MINUTE);
    if (vehicle === 'bmw') publish(runtime, facts(START + 2 * MINUTE, { pluggedIn: false }));
    else {
      f.tesla.pluggedIn = false;
      f.tesla.fields = { plugged_in: { receivedAt: START + 2 * MINUTE, retained: false } };
      runtime.tick();
    }
    assert.equal(view(runtime).vehicle.state, vehicle === 'bmw' ? 'disconnected' : 'unidentified');
    assert.equal(view(runtime).values.soc.source, 'manual-fallback');
    f.setConnection(true, START); f.tesla.pluggedIn = true; runtime.tick();
    assert.equal(view(runtime).vehicle.state, vehicle === 'bmw' ? 'disconnected' : 'unidentified',
      'Old positive evidence cannot restore a revoked match');
  });
});

test('session capacity edits reject stale revisions, wrong charging points and disconnected sessions without changing defaults', async t => {
  const f = fixture({ defaults: { capacityKwh: 50 } }), runtime = f.create(); t.after(() => runtime.close());
  f.setTeslaEvidence('easee'); runtime.tick();
  const initial = view(runtime), before = structuredClone(runtime.settings);
  const request = { scope: 'session', association: initial.association, sessionId: initial.request.sessionId,
    revision: initial.request.revision, changes: { capacityKwh: 58 } };
  await runtime.setChargerSettings('charger1', request);
  assert.deepEqual(runtime.settings, before);
  assert.equal(view(runtime).values.capacityKwh.value, 58);
  await assert.rejects(runtime.setChargerSettings('charger1', request), /connection changed/);
  await assert.rejects(runtime.setChargerSettings('charger2', request), /connection changed/);
  await assert.rejects(runtime.setChargerSettings('charger1', { capacityKwh: 58, capacityProfile: 'tesla' }), /configuration/);
  f.setConnection(false); runtime.tick();
  await assert.rejects(runtime.setChargerSettings('charger1', request), /connection changed/);
  assert.equal(runtime.settings.vehicles.tesla.capacityKwh, 57);
  assert.equal(view(runtime).values.capacityKwh.value, 50);
});


const publishTarget = (runtime, value, at, packet) => publish(runtime, {
  provider: 'bmw-cardata', chargeLimitSoc: value,
  fields: { chargeLimitSoc: { measuredAt: at, readingId: `target-${at}` } },
}, packet);

test('one BMW 100 to X transition holds the latest lower target across restart without altering raw telemetry', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  publish(runtime, facts(START, { chargeLimitSoc: 100 })); pauseBmw(runtime, f);
  assert.equal(view(runtime).targetSelection.conflict, false);
  assert.equal(view(runtime).values.minimumSoc.value, 100);
  f.setNow(START + 3 * MINUTE); publishTarget(runtime, 85, START + 3 * MINUTE);
  const confirmed = view(runtime);
  assert.equal(confirmed.targetSelection.conflict, true);
  assert.equal(confirmed.values.minimumSoc.value, 85);
  const selectedAt = confirmed.values.minimumSoc.measuredAt;
  f.setNow(START + 4 * MINUTE); publishTarget(runtime, 100, START + 4 * MINUTE);
  const held = view(runtime);
  assert.equal(held.values.minimumSoc.value, 85);
  assert.equal(held.values.minimumSoc.source, 'bmw-target-filter');
  assert.equal(held.values.minimumSoc.measuredAt, selectedAt);
  assert.equal(held.automatic.minimumSoc.value, 100);
  assert.equal(held.automaticSoc.chargeLimitSoc, 100);
  assert.equal(held.targetSelection.raw.measuredAt, START + 4 * MINUTE);
  assert.equal(held.values.soc.value, 60);
  assert.equal(runtime.settings.chargers.charger1.minimumSoc, 80);
  assert(held.requiredGridKwh < 74 * .4 / .925, 'Energy estimate uses 85%, not the conflicting 100%');
  f.setNow(START + 5 * MINUTE); publishTarget(runtime, 90, START + 5 * MINUTE);
  assert.equal(view(runtime).values.minimumSoc.value, 90, 'A newly selected lower target replaces the previous lower value');
  f.setNow(START + 6 * MINUTE); publishTarget(runtime, 100, START + 6 * MINUTE);
  assert.equal(view(runtime).values.minimumSoc.value, 90);
  const restarted = f.create(); t.after(() => restarted.close());
  assert.equal(view(restarted).values.minimumSoc.value, 80, 'Automatic targets wait for a live bridge heartbeat after restart');
  publishTarget(restarted, 100, START + 6 * MINUTE);
  assert.equal(view(restarted).values.minimumSoc.value, 90);
  assert.equal(view(restarted).targetSelection.raw.value, 100);
  f.setConnection(false); restarted.tick();
  assert.equal(restarted.chargers.charger1.targetState, null);
  f.setNow(START + 7 * MINUTE); f.setConnection(true); restarted.tick();
  assert.equal(view(restarted).targetSelection, null, 'The next unknown car cannot inherit BMW selection');
  assert.equal(restarted.chargers.charger1.targetState, null);
});

test('normal Save overrides a held BMW target with 84 or 100 for this connection across restart', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  publish(runtime, facts(START, { chargeLimitSoc: 100 })); pauseBmw(runtime, f);
  f.setNow(START + 2 * MINUTE); publishTarget(runtime, 85, START + 2 * MINUTE);
  f.setNow(START + 3 * MINUTE); publishTarget(runtime, 100, START + 3 * MINUTE);
  const held = view(runtime), before = structuredClone(runtime.settings);
  assert.equal(held.values.minimumSoc.value, 85);
  assert.equal(held.values.minimumSoc.source, 'bmw-target-filter');
  const request = sessionEdit(runtime, { minimumSoc: 84 });
  await assert.rejects(runtime.setChargerSettings('charger1', { ...request, sessionId: 'different-session' }), /connection changed/);
  await runtime.setChargerSettings('charger1', request);
  await assert.rejects(runtime.setChargerSettings('charger1', request), /connection changed/);
  let current = view(runtime);
  assert.equal(current.values.minimumSoc.value, 84);
  assert.equal(current.values.minimumSoc.source, 'session-request');
  assert.deepEqual(current.targetSelection, held.targetSelection, 'Saving preserves source conflict evidence and raw clocks');
  assert.equal(current.automatic.minimumSoc.value, 100);
  assert.ok(Math.abs(current.referenceGridKwh - current.values.capacityKwh.value * .24 / current.configuration.efficiency) < 1e-9);
  const restarted = f.create(); t.after(() => restarted.close());
  assert.equal(view(restarted).values.minimumSoc.value, 84, 'Session choice remains usable before a live bridge heartbeat');
  assert.equal(view(restarted).values.minimumSoc.source, 'session-request');
  f.setNow(START + 4 * MINUTE); publishTarget(restarted, 100, START + 4 * MINUTE);
  assert.equal(view(restarted).targetSelection.selected.value, 85);
  assert.equal(view(restarted).values.minimumSoc.value, 84, 'A later raw 100% does not replace the saved target');
  await restarted.setChargerSettings('charger1', sessionEdit(restarted, { minimumSoc: 100 }));
  current = view(restarted);
  assert.equal(current.values.minimumSoc.value, 100);
  assert.equal(current.values.minimumSoc.source, 'session-request');
  assert.equal(current.targetSelection.selected.value, 85);
  assert.equal(current.targetSelection.raw.value, 100);
  assert.ok(Math.abs(current.referenceGridKwh - current.values.capacityKwh.value * .4 / current.configuration.efficiency) < 1e-9);
  assert.deepEqual(restarted.settings, before, 'Session target edits leave configured defaults intact');
  const again = f.create(); t.after(() => again.close());
  assert.equal(view(again).values.minimumSoc.value, 100);
  const stale = sessionEdit(again, { minimumSoc: 84 });
  f.setConnection(false); again.tick();
  await assert.rejects(again.setChargerSettings('charger1', stale), /connection changed/);
  f.setNow(START + 5 * MINUTE); f.setConnection(true); again.tick();
  assert.equal(again.chargers.charger1.targetState, null);
  assert.deepEqual(view(again).request.overrides, {});
  assert.equal(view(again).values.minimumSoc.value, 80);
  await assert.rejects(again.setChargerSettings('charger1', stale), /connection changed/);
});

test('retired BMW target state and saved selection fields fail before any persistence', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  publish(runtime, facts(START, { chargeLimitSoc: 100 })); pauseBmw(runtime, f);
  f.setNow(START + 2 * MINUTE); publishTarget(runtime, 85, START + 2 * MINUTE);
  const saved = f.store.getState(runtime.key);
  const cases = [];
  for (const override of [null, { value: 100, selectedAt: START }]) {
    const state = structuredClone(saved); state.chargers.charger1.targetState.override = override; cases.push(state);
  }
  for (const mode of ['automatic', 'full']) {
    const state = structuredClone(saved); state.view.chargers[0].targetSelection.mode = mode; cases.push(state);
  }
  for (const state of cases) {
    f.store.setState(runtime.key, state);
    f.store.fail = true;
    assert.throws(() => f.create(), /Unsupported saved charging target.*fresh development database/);
    assert.deepEqual(f.store.getState(runtime.key), state, 'Rejected saved data remains unchanged');
    f.store.fail = false;
  }
  f.store.setState(runtime.key, saved);
  const restarted = f.create(); t.after(() => restarted.close());
  publishTarget(restarted, 100, START + 2 * MINUTE);
  assert.equal(view(restarted).values.minimumSoc.value, 85);
});

test('ordinary target saves reject retired BMW mode payloads', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  publish(runtime, facts(START, { chargeLimitSoc: 85 })); pauseBmw(runtime, f);
  const request = sessionEdit(runtime, { minimumSoc: 100 });
  for (const input of [{ connectedAt: START, mode: 'full' }, { ...request, mode: 'full' },
    { ...request, changes: { minimumSoc: 100, mode: 'full' } }])
    await assert.rejects(runtime.setChargerSettings('charger1', input), /configuration|Invalid session/);
  await runtime.setChargerSettings('charger1', request);
  assert.equal(view(runtime).values.minimumSoc.source, 'session-request');
});

test('failed target persistence rolls back evidence and explicit session choices', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  publish(runtime, facts(START, { chargeLimitSoc: 85 })); pauseBmw(runtime, f);
  f.setNow(START + 2 * MINUTE); publishTarget(runtime, 100, START + 2 * MINUTE);
  const before = structuredClone(runtime.chargers.charger1.targetState);
  f.store.fail = true; f.setNow(START + 3 * MINUTE);
  assert.throws(() => publishTarget(runtime, 85, START + 3 * MINUTE), /database unavailable/);
  assert.deepEqual(runtime.chargers.charger1.targetState, before);
  assert.equal(view(runtime).targetSelection.conflict, false);
  assert.equal(runtime.vehicleFeeds.bmw.reading.chargeLimitSoc, 100);
  const request = structuredClone(runtime.chargers.charger1.request), revision = runtime.revision;
  await assert.rejects(runtime.setChargerSettings('charger1', sessionEdit(runtime, { minimumSoc: 100 })), /database unavailable/);
  assert.deepEqual(runtime.chargers.charger1.request, request);
  assert.equal(runtime.revision, revision);
  assert.deepEqual(runtime.chargers.charger1.targetState, before);
  f.store.fail = false;
});

test('a retained target transition cannot activate the conflict filter through views or later live republication', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  publish(runtime, facts(START, { chargeLimitSoc: 85 })); pauseBmw(runtime, f);
  f.setNow(START + 2 * MINUTE); publishTarget(runtime, 100, START + 2 * MINUTE, { retain: true });
  view(runtime); view(runtime);
  publishTarget(runtime, 100, START + 2 * MINUTE);
  f.setNow(START + 3 * MINUTE); publishTarget(runtime, 85, START + 3 * MINUTE);
  assert.equal(view(runtime).targetSelection.conflict, false);
  f.setNow(START + 4 * MINUTE); publishTarget(runtime, 100, START + 4 * MINUTE);
  assert.equal(view(runtime).values.minimumSoc.value, 100);
});

test('pending BMW stop confirmation remains identifying with manual values throughout its connection', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  publish(runtime, facts());
  f.setNow(START + 4 * MINUTE); f.setCharging(false); runtime.tick();
  assert.equal(view(runtime).vehicle.state, 'identifying');
  assert.equal(view(runtime).vehicle.reason, 'awaiting-stop-confirmation');
  assert.equal(view(runtime).values.soc.source, 'manual-fallback');
  f.setNow(START + 10 * MINUTE); runtime.tick();
  assert.equal(view(runtime).vehicle.state, 'identifying');
  assert.equal(view(runtime).vehicle.reason, 'awaiting-stop-confirmation');
});

test('confirmed target holds and choices survive a telemetry gap but clear on direct BMW unplug evidence', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  publish(runtime, facts(START, { chargeLimitSoc: 85 })); pauseBmw(runtime, f);
  for (const [minutes, target] of [[2, 100], [3, 85], [4, 100]]) {
    f.setNow(START + minutes * MINUTE); publishTarget(runtime, target, START + minutes * MINUTE);
  }
  assert.equal(view(runtime).values.minimumSoc.value, 85);
  await runtime.setChargerSettings('charger1', sessionEdit(runtime, { minimumSoc: 100 }));
  f.setConnection(null, START); runtime.tick();
  assert.equal(view(runtime).vehicle.id, 'bmw');
  assert.equal(view(runtime).targetSelection.conflict, true);
  assert.equal(view(runtime).values.minimumSoc.source, 'session-request');
  const restarted = f.create(); t.after(() => restarted.close());
  assert.equal(restarted.chargers.charger1.targetState.conflict, true);
  assert.equal(view(restarted).values.minimumSoc.value, 100);
  const stale = sessionEdit(restarted, { minimumSoc: 84 });
  f.setNow(START + 5 * MINUTE);
  publish(restarted, { provider: 'bmw-cardata', pluggedIn: false,
    fields: { pluggedIn: { measuredAt: START + 5 * MINUTE, readingId: 'unplug-during-gap' } } });
  assert.equal(view(restarted).targetSelection, null);
  assert.equal(restarted.chargers.charger1.targetState, null);
  assert.equal(view(restarted).values.minimumSoc.source, 'manual-fallback');
  await assert.rejects(restarted.setChargerSettings('charger1', stale), /connection changed/);
});

test('a failed BMW unplug save cannot queue a phantom charger disconnect', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  publish(runtime, facts()); pauseBmw(runtime, f);
  f.setNow(START + 2 * MINUTE); f.store.fail = true;
  const unplug = { provider: 'bmw-cardata', pluggedIn: false,
    fields: { pluggedIn: { measuredAt: START + 2 * MINUTE, readingId: 'failed-unplug' } } };
  assert.throws(() => publish(runtime, unplug), /database unavailable/);
  assert.equal(runtime.chargers.charger1.vehicleDisconnect, null);
  assert.equal(view(runtime).vehicle.id, 'bmw');
  f.store.fail = false; publish(runtime, unplug);
  assert.equal(runtime.chargers.charger1.vehicleDisconnect.endedConnectedAt, START);
  assert.equal(view(runtime).vehicle.id, null);
  const restarted = f.create(); t.after(() => restarted.close());
  assert.deepEqual(restarted.chargers.charger1.vehicleDisconnect, runtime.chargers.charger1.vehicleDisconnect);
});
test('BMW native ceiling and SoC stay independent of pinned capacity and one-time charge edits',async t=>{
 const f=fixture(),runtime=f.create();t.after(()=>runtime.close());
 publish(runtime,facts(START,{chargeLimitSoc:80,usableCapacityKwh:72}));pauseBmw(runtime,f);
 const initial=view(runtime);assert.equal(initial.vehicle.id,'bmw');assert.equal(initial.values.vehicleCeilingSoc.value,80);
 await runtime.setChargerSettings('charger1',{scope:'session',association:initial.association,sessionId:initial.request.sessionId,revision:initial.request.revision,
  changes:{capacityKwh:65,manualSoc:30,minimumSoc:95}});
 let current=view(runtime);assert.equal(current.values.capacityKwh.value,65);assert.equal(current.values.soc.value,30);
 assert.equal(current.values.minimumSoc.value,95);assert.equal(current.values.vehicleCeilingSoc.value,80);
 f.setNow(START+2*MINUTE);publish(runtime,facts(START+2*MINUTE,{soc:62,charging:false,chargeLimitSoc:80,usableCapacityKwh:72}));
 current=view(runtime);assert.equal(current.values.soc.value,62);assert.equal(current.values.capacityKwh.value,65);
 assert.equal(current.values.minimumSoc.value,95);assert.equal(current.values.vehicleCeilingSoc.value,80);
 assert.equal(current.request.overrides.manualSoc,undefined);
});
