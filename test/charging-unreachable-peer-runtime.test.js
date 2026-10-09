import { admitChargingObservation } from './helpers/charging-observation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createChargingTeslaCapture } from '../src/charging/teslamate.js';
import { withReportDatabase } from './helpers/report-database.js';

const START = Date.parse('2026-10-09T09:00:00Z'), MINUTE = 60_000;
const REQUEST = START + 2000, STOP = START + 5000;
const IDS = ['charger1', 'charger2'];

// Real ingestion, runtime candidate selection, physical pause validation and
// simultaneous assignment. Synthetic controller readback cannot send commands.
function fixture(t, id, { vehicle = 'tesla', retained = false, minimumCurrent = false } = {}) {
  let now = START, runtime, capture, savedTesla;
  const currentA = minimumCurrent ? 6 : 10, powerKw = minimumCurrent ? 4 : 7;
  const peerId = IDS.find(value => value !== id), states = new Map();
  const store = withReportDatabase({ getState: key => structuredClone(states.get(key)),
    setState: (key, value) => states.set(key, structuredClone(value)) }, t);
  const config = { input: 'mqtt', connections: {
    easee: { charger_id: 'synthetic-unreachable', equalizer_id: 'synthetic-unreachable-equalizer' },
    mqtt: { address: 'mqtt://synthetic.invalid', user: 'synthetic-unreachable' },
    teslamate: { enabled: true, carId: '1', homeGeofence: 'Home' } },
  charging: { vehicles: { bmw: { mqttTopic: 'synthetic/unreachable/bmw' } },
    chargers: { charger2: { enabled: true, deviceId: 'synthetic-unreachable-shelly', topicPrefix: 'synthetic/unreachable/shelly' } } } };
  const controls = Object.fromEntries(IDS.map((key, index) => [key, {
    enabled: true, session: { sessionId: `synthetic-${key}`, connected: true,
      connectedAt: START - 5 * MINUTE, lastDisconnectedAt: START - 6 * MINUTE, transactionId: index + 1 },
    owned: null, pending: null, manual: null, ownsInstruction: false, pauseConfirmed: false,
    snapshot: { transport: key === 'charger1' ? 'ocpp' : 'shelly-evse', online: key === id,
      pluggedIn: true, transactionConfirmed: true, transactionId: index + 1,
      transactionStartedAt: START - 5 * MINUTE, connectorStatus: key === id ? 'Charging' : 'SuspendedEV',
      statusAt: START - 2 * MINUTE, charging: key === id, powerKw: key === id ? powerKw : 0,
      currentA: key === id ? currentA : 0, controlReady: true, identificationReady: true,
      identificationCurrentReady: minimumCurrent && key === id, nativeScheduleActive: false,
      appControl: { controlKnown: true, enabled: true, stopped: false, schedule: { enabled: 'none' } },
      fields: { start_charging: { value: true, measuredAt: START - 2 * MINUTE, retained: false } },
    },
  }]));
  const create = () => {
    const target = new ChargingRuntime({ engine: {}, store, config, clock: () => now });
    target.tick = () => {};
    capture = createChargingTeslaCapture({ settings: config.connections.teslamate, clock: () => now,
      initialState: savedTesla, saveState: value => { savedTesla = structuredClone(value); },
      brokerIdentity: 'synthetic-unreachable' });
    capture.setConnected(true); target.teslaCapture = capture;
    target.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
    for (const [key, control] of Object.entries(controls)) {
      const item = target.chargers[key];
      item.controller = { supportsIdentification: true, status: () => structuredClone({ ...control,
        snapshot: { ...control.snapshot, readAt: now, powerAt: now } }), close: async () => {} };
      item.adapter = { config: { maxAgeMs: MINUTE }, normalize: snapshot => {
        const signal = (value, measuredAt = now) => ({ value: snapshot.online ? value : null,
          measuredAt, available: snapshot.online, retained: false });
        return { providerConnected: snapshot.online, connected: signal(snapshot.pluggedIn),
          charging: signal(snapshot.charging, snapshot.statusAt), powerKw: signal(snapshot.powerKw),
          phaseCurrentA: signal([snapshot.currentA, snapshot.currentA, snapshot.currentA]),
          actualCurrentA: signal(snapshot.currentA), maximumCurrentA: signal(16), voltageV: signal(230) };
      } };
    }
    t.after(() => target.close()); return target;
  };
  const tesla = (fields, packet = {}, at = now) => {
    for (const [key, value] of Object.entries(fields))
      assert.equal(capture.receive(`teslamate/cars/1/${key}`, String(value), packet, at), true);
  };
  const bmw = (values, at, packet = {}) => assert.equal(runtime.receiveSoc('synthetic/unreachable/bmw',
    JSON.stringify({ provider: 'bmw-cardata', ...values, fields: Object.fromEntries(Object.keys(values).map(key =>
      [key, { measuredAt: at, readingId: `synthetic-${key}-${at}` }])) }), packet, now), true);
  runtime = create();
  if (vehicle === 'tesla') {
    tesla({ healthy: true, plugged_in: true, geofence: 'Home' });
    tesla({ charging_state: 'Charging', charger_actual_current: currentA, charger_power: powerKw }, { retain: retained });
  } else {
    bmw({ atHome: true, pluggedIn: true }, START - 10 * MINUTE, { retain: true });
    bmw({ charging: true }, START - MINUTE);
  }
  const observe = () => admitChargingObservation(runtime, now);
  return { id, peerId, controls, states, tesla, bmw, observe,
    get runtime() { return runtime; }, get item() { return runtime.chargers[id]; }, get now() { return now; },
    setNow(value) { now = value; },
    begin() { observe(); now = START + 1000; return observe()[id].vehicle; },
    beginCurrentTest() {
      observe();
      const state = runtime.chargers[id].identification, control = controls[id];
      control.currentTest = { id: state.id, connectedAt: control.session.connectedAt,
        sessionId: control.session.sessionId, phase: 'active', startedAt: START,
        confirmedAt: START, expiresAt: START + 90_000, permissionAt: START,
        appliedCurrentA: 6, originalCurrentA: 12, restoreCurrentA: null, pending: null };
      control.snapshot.fields.current_limit = { value: 6, measuredAt: START, receivedAt: START,
        retained: false, commandSource: 'rpc' };
      now = START + 4000; return observe()[id].vehicle;
    },
    physicalStop({ owned = true, requestedAt = REQUEST, stoppedAt = STOP, readback = true } = {}) {
      const state = runtime.chargers[id].identification, control = controls[id];
      assert.equal(state.phase, 'pausing');
      Object.assign(control, { ownsInstruction: owned, pauseConfirmed: owned,
        owned: owned ? { purpose: 'identification', identificationId: state.id,
          identificationConnectedAt: control.session.connectedAt, sessionId: control.session.sessionId,
          transactionId: control.session.transactionId, requestedAt, pauseRequestedAt: requestedAt,
          confirmedAt: stoppedAt, startAt: state.pauseUntil } : null });
      Object.assign(control.snapshot, { charging: false, connectorStatus: 'SuspendedEVSE',
        powerKw: 0, currentA: 0, statusAt: stoppedAt });
      control.snapshot.fields.start_charging = { value: false, measuredAt: stoppedAt, retained: false };
      now = stoppedAt + 1000; return readback ? observe()[id].vehicle : null;
    },
    vehicleStop(packet = {}) {
      if (vehicle === 'tesla') tesla({ charging_state: 'Stopped', charger_actual_current: 0, charger_power: 0 }, packet);
      else bmw({ charging: false }, STOP, packet);
      return observe()[id].vehicle;
    },
    peerTransition(at = REQUEST + 1000) {
      Object.assign(controls[peerId].snapshot, { online: true, charging: true,
        connectorStatus: 'Charging', statusAt: at, powerKw: 7, currentA: 10 });
    },
    independentRamp() {
      const control = controls[id], peer = controls[peerId];
      Object.assign(control, { owned: null, ownsInstruction: false, pauseConfirmed: false });
      Object.assign(control.snapshot, { charging: true, connectorStatus: 'Charging',
        powerKw: 8, currentA: 11, statusAt: now });
      control.snapshot.fields.start_charging = { value: true, measuredAt: now, retained: false };
      Object.assign(peer.snapshot, { online: true, pluggedIn: false, charging: false,
        connectorStatus: 'Available', powerKw: 0, currentA: 0, statusAt: now });
      tesla({ healthy: true, charging_state: 'Charging', charger_actual_current: 11, charger_power: 8 });
      return observe()[id].vehicle;
    },
    async restart() {
      runtime.persist(); await runtime.close(); runtime = create();
      if (vehicle === 'tesla') tesla({ healthy: true });
      else bmw({}, now);
    },
  };
}

for (const id of IDS) {
  test(`${id}: an unreachable peer permits Tesla's bounded pause but static matching draw never identifies`, t => {
    const f = fixture(t, id);
    assert.equal(f.begin().id, null);
    assert.equal(f.item.identification.phase, 'pausing');
    assert.equal(f.item.identification.candidate.kind, 'tesla');
    assert.equal(f.observe()[f.peerId].vehicle.id, null);
    assert.equal(f.physicalStop().id, null, 'Physical Stop still needs Tesla corroboration');
    assert.equal(f.vehicleStop().id, 'tesla');
    assert.equal(f.item.identification.phase, 'completed');
    assert.equal(f.observe()[f.peerId].vehicle.id, null, 'The unavailable peer gains no identity by elimination');
  });

  test(`${id}: BMW keeps its existing live stop matching while the unreachable peer permits a pause`, t => {
    const f = fixture(t, id, { vehicle: 'bmw' });
    assert.equal(f.begin().id, null);
    assert.equal(f.item.identification.phase, 'pausing');
    assert.equal(f.item.identification.candidate.kind, 'ongoing');
    assert.equal(f.physicalStop().id, null);
    assert.equal(f.vehicleStop().id, 'bmw');
    assert.equal(f.observe()[f.peerId].vehicle.id, null);
  });

  test(`${id}: retained Tesla draw cannot request a peer-unavailable identification pause`, t => {
    const f = fixture(t, id, { retained: true });
    assert.equal(f.begin().id, null);
    assert.equal(f.item.identification.candidate, null);
    assert.equal(f.item.identification.phase, 'charging');
    f.setNow(START + 10_000);
    f.tesla({ charging_state: 'Charging', charger_actual_current: 10, charger_power: 7 });
    assert.equal(f.observe()[id].vehicle.id, null, 'Unchanged re-publication retains original evidence provenance');
    assert.equal(f.item.identification.candidate, null);
  });

  test(`${id}: retained Tesla zero and an unowned physical stop cannot identify`, t => {
    const f = fixture(t, id); f.begin(); f.physicalStop({ owned: false });
    assert.equal(f.vehicleStop().id, null);
    assert.equal(f.item.identification.pause, null);
    const retained = fixture(t, id); retained.begin(); retained.physicalStop();
    assert.equal(retained.vehicleStop({ retain: true }).id, null);
  });

  test(`${id}: restart preserves the candidate, stop obligation and original Tesla clocks`, async t => {
    const f = fixture(t, id); f.begin(); f.physicalStop();
    const before = structuredClone(f.item.identification);
    const owned = structuredClone(f.controls[id].owned);
    await f.restart();
    assert.deepEqual(f.item.identification, before);
    assert.deepEqual(f.controls[id].owned, owned);
    assert.equal(f.vehicleStop().id, 'tesla');
    await f.restart();
    assert.equal(f.observe()[id].vehicle.id, 'tesla');
    assert.equal(f.item.identification.candidate.powerReceivedAt, START);
  });

  test(`${id}: a late peer transition withdraws a Tesla pause-only identity without authorizing a new test`, async t => {
    const f = fixture(t, id); f.begin(); f.physicalStop();
    assert.equal(f.vehicleStop().id, 'tesla');
    const pause = structuredClone(f.item.identification.pause), owned = structuredClone(f.controls[id].owned);
    f.setNow(STOP + 10_000); f.peerTransition();
    assert.equal(f.observe()[id].vehicle.id, null);
    assert.equal(f.item.identification.phase, 'observing');
    assert.deepEqual(f.item.identification.pause, pause);
    assert.deepEqual(f.controls[id].owned, owned);
    await f.restart();
    assert.equal(f.observe()[id].vehicle.id, null);
  });

  test(`${id}: a failed pause cannot contaminate a later independent Tesla match or its consumption watermark`, async t => {
    const f = fixture(t, id); f.begin(); f.physicalStop();
    const originalCandidateAt = f.item.identification.candidate.powerReceivedAt;
    f.setNow(f.item.identification.pauseUntil + 1000);
    assert.equal(f.observe()[id].vehicle.id, null);
    assert.equal(f.item.identification.phase, 'inconclusive', 'Tesla never corroborated the original stop');
    assert.equal(f.independentRamp().id, 'tesla');
    assert.equal(f.item.vehicleMatch.pauseRequestedAt, undefined, 'Independent evidence carries no old pause dependency');
    const independentAt = f.now, independent = structuredClone(f.item.vehicleMatch);
    assert.ok(independentAt > originalCandidateAt);
    assert.equal(f.runtime.consumedTeslaPower.receivedAt, independentAt,
      'Consume the winning power evidence, not the abandoned candidate baseline');
    f.setNow(independentAt + 1000);
    f.runtime.chargers[f.peerId].streamEvidence = { chargingTimes: [REQUEST + 1000] };
    assert.equal(f.observe()[id].vehicle.id, 'tesla');
    assert.equal(f.item.vehicleEvidence.teslaContestedPauseRequestedAt, REQUEST);
    assert.deepEqual(f.item.vehicleMatch, independent);
    assert.equal(f.runtime.consumedTeslaPower.receivedAt, independentAt);
    await f.restart();
    assert.equal(f.observe()[id].vehicle.id, 'tesla');
    assert.deepEqual(f.item.vehicleMatch, independent);
    assert.equal(f.runtime.consumedTeslaPower.receivedAt, independentAt);
  });

  test(`${id}: later independent Tesla evidence removes an established pause dependency`, async t => {
    const f = fixture(t, id); f.begin(); f.physicalStop();
    assert.equal(f.vehicleStop().id, 'tesla');
    assert.equal(f.item.vehicleMatch.pauseRequestedAt, REQUEST);
    const consumed = f.runtime.consumedTeslaPower.receivedAt;
    f.setNow(f.item.identification.pauseUntil + 1000);
    assert.equal(f.independentRamp().id, 'tesla');
    assert.equal(f.item.vehicleMatch.pauseRequestedAt, undefined);
    const independent = structuredClone(f.item.vehicleMatch);
    f.setNow(f.now + 1000);
    f.runtime.chargers[f.peerId].streamEvidence = { stoppedTimes: [STOP + 1000] };
    assert.equal(f.observe()[id].vehicle.id, 'tesla');
    assert.equal(f.item.vehicleEvidence.teslaContestedPauseRequestedAt, REQUEST);
    assert.deepEqual(f.item.vehicleMatch, independent);
    assert.ok(f.runtime.consumedTeslaPower.receivedAt >= consumed);
    await f.restart();
    assert.equal(f.observe()[id].vehicle.id, 'tesla');
    assert.equal(f.item.vehicleMatch.pauseRequestedAt, undefined);
  });

  test(`${id}: simultaneous native and vehicle stop retains pause provenance after native ownership ends`, async t => {
    const f = fixture(t, id); f.begin(); f.physicalStop({ readback: false });
    assert.equal(f.item.identification.pause, null, 'No earlier runtime pass has stored the native pause');
    assert.equal(f.vehicleStop().id, 'tesla');
    assert.equal(f.item.identification.phase, 'completed');
    assert.equal(f.item.identification.pause?.requestedAt, REQUEST,
      'The winning same-pass pause must survive the completion transition');
    assert.equal(f.item.vehicleMatch.pauseRequestedAt, REQUEST);
    Object.assign(f.controls[id], { owned: null, ownsInstruction: false, pauseConfirmed: false });
    await f.restart();
    assert.equal(f.observe()[id].vehicle.id, 'tesla');
    f.setNow(STOP + 10_000); f.peerTransition();
    assert.equal(f.observe()[id].vehicle.id, null);
    assert.equal(f.item.identification.phase, 'observing');
    assert.equal(f.item.identification.pause.requestedAt, REQUEST);
    await f.restart();
    assert.equal(f.observe()[id].vehicle.id, null);
  });
}

test('Shelly hands its confirmed 6 A comparison to the unreachable-peer Tesla pause after settling', t => {
  const f = fixture(t, 'charger2', { minimumCurrent: true });
  assert.equal(f.beginCurrentTest().id, null);
  assert.equal(f.item.identification.phase, 'charging', 'Five seconds of confirmed comparison remain required');
  f.setNow(START + 6000);
  assert.equal(f.observe().charger2.vehicle.id, null);
  assert.equal(f.item.identification.phase, 'pausing');
  assert.equal(f.item.identification.candidate.kind, 'tesla');
  const test = structuredClone(f.controls.charger2.currentTest);
  assert.equal(f.physicalStop({ requestedAt: START + 7000, stoppedAt: START + 10_000 }).id, null);
  assert.equal(f.vehicleStop().id, 'tesla');
  assert.deepEqual(f.controls.charger2.currentTest, test, 'Identity cannot overwrite the current restoration obligation');
  assert.equal(f.observe().charger1.vehicle.id, null);
});

test('an online peer with missing measurements does not select the unreachable-peer exception', t => {
  const f = fixture(t, 'charger1');
  f.controls.charger2.snapshot.online = true;
  f.runtime.chargers.charger2.adapter.normalize = () => ({ providerConnected: true,
    connected: { value: null, available: false }, charging: { value: null, available: false },
    powerKw: { value: null, available: false } });
  assert.equal(f.begin().id, null);
  assert.equal(f.item.identification.candidate, null);
  assert.equal(f.item.identification.phase, 'charging');
});

for (const restriction of ['pending', 'takeover', 'owned pause', 'native schedule', 'near resume', 'recent transition']) {
  test(`an unreachable peer with ${restriction} still blocks a new identification pause`, t => {
    const f = fixture(t, 'charger1'), peer = f.controls[f.peerId];
    if (restriction === 'pending') peer.pending = { action: 'release' };
    if (restriction === 'takeover') peer.takeoverPending = { requestedAt: START };
    if (restriction === 'owned pause') peer.owned = { purpose: 'identification' };
    if (restriction === 'native schedule') peer.snapshot.nativeScheduleActive = true;
    if (restriction === 'near resume') peer.execution = { periods: [{ startAt: START + MINUTE, endAt: null }] };
    if (restriction === 'recent transition') f.runtime.chargers[f.peerId].streamEvidence = { chargingTimes: [START - 1000] };
    f.begin();
    assert.equal(f.item.identification.candidate, null);
    assert.equal(f.item.identification.phase, 'charging');
    assert.equal(f.observe()[f.id].vehicle.id, null);
  });
}
