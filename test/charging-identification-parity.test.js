import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { easeeChargerTelemetry, effectiveScheduleFingerprint, normalizeScheduleState } from '../src/charging/easee.js';
import { createOcppScheduleAdapter, ocppPauseInstruction } from '../src/charging/ocpp.js';

const START = Date.parse('2026-09-25T10:00:00Z'), MINUTE = 60_000;
const REQUEST = START + 3 * MINUTE, STOP = REQUEST + 10_000;
const field = (key, value, at) => ({ measuredAt: at, readingId: `synthetic-${key}-${value}-${at}` });

// Exercise the real vehicle ingestion, transport normalizers and simultaneous
// assignment. Controller status is synthetic; no fixture can dispatch commands.
function fixture(t, transport) {
  let now = START;
  const states = new Map(), store = {
    getState: key => structuredClone(states.get(key)),
    setState: (key, value) => states.set(key, structuredClone(value)),
  };
  const config = { input: 'mqtt',
    connections: { easee: { charger_id: 'synthetic-parity-charger', equalizer_id: 'synthetic-parity-equalizer' },
      mqtt: { address: 'mqtt://synthetic.invalid', user: 'synthetic-parity' }, teslamate: { enabled: true } },
    charging: { vehicles: { bmw: { mqttTopic: 'synthetic/parity/bmw' } }, chargers: { charger2: { enabled: false } } } };
  const snapshot = { online: true, pluggedIn: true, powerKw: 7, powerAt: START,
    limits: { chargerA: 16, cableA: 16, circuitA: [16, 16, 16] },
    ...(transport === 'cloud' ? { enabled: true, controlKnown: true, mode: 3, modeAt: START, reason: 0, reasonAt: START,
      schedule: normalizeScheduleState({ enabled: 'none' }),
      observations: { 109: { value: 3, at: START }, 120: { value: 7, at: START } } }
      : { transport: 'ocpp', connectionId: 'synthetic-parity-socket', connectorStatus: 'Charging', statusAt: START,
        transactionId: 7, transactionStartedAt: START, transactionConfirmed: true }) };
  const control = { enabled: true, session: { connected: true, connectedAt: START, lastDisconnectedAt: START - 1000,
    ...(transport === 'ocpp' ? { transactionId: 7 } : {}) },
    owned: null, pending: null, manual: null, phase: 'off', ownsInstruction: false, pauseConfirmed: false };
  const tesla = { association: 'synthetic-parity-tesla', healthy: false, pluggedIn: true, atHome: true, charging: true,
    actualPowerKw: 7, batteryLevel: 70, chargeLimitSoc: 85, fields: {} };
  let runtime;
  const attach = (target, id = 'charger1') => {
    const item = target.chargers[id], scope = item.association;
    item.adapter = transport === 'cloud' ? { normalize: easeeChargerTelemetry }
      : createOcppScheduleAdapter({ scope, clock: () => now,
        readSnapshot: async () => assert.fail('Synthetic identification fixture does not read a charger'),
        request: async () => assert.fail('Synthetic identification fixture does not send commands') });
    item.controller = { status: () => structuredClone({ ...control, snapshot: { ...snapshot, scope, readAt: now } }),
      update: async () => {}, close: async () => {} };
  };
  const attachTesla = target => {
    target.teslaCapture = { topic: 'synthetic/parity/tesla/#', snapshot: () => structuredClone(tesla),
      reception: () => ({ connected: true }) };
  };
  const create = ({ attached = true, captured = true } = {}) => {
    const target = new ChargingRuntime({ engine: {}, store, config, clock: () => now });
    t.after(() => target.close());
    target.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
    if (captured) attachTesla(target);
    if (attached) attach(target);
    return target;
  };
  const publish = (values, at, packet = {}) => runtime.receiveSoc('synthetic/parity/bmw', JSON.stringify({
    provider: 'bmw-cardata', ...values,
    fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, field(key, value, at)])),
  }), packet, now);
  const physical = (charging, at = now) => {
    snapshot.powerKw = charging === true ? 7 : 0; snapshot.powerAt = at;
    if (transport === 'cloud') {
      snapshot.mode = charging === null ? null : charging ? 3 : 2; snapshot.modeAt = at;
      snapshot.observations[109] = { value: snapshot.mode, at };
      snapshot.observations[120] = { value: snapshot.powerKw, at };
    } else { snapshot.connectorStatus = charging === null ? null : charging ? 'Charging' : 'SuspendedEVSE'; snapshot.statusAt = at; }
  };
  const startBmw = ({ freshPlug = false, retainedStart = false } = {}) => {
    publish({ pluggedIn: true, atHome: true, charging: false }, START - 60 * MINUTE, { retain: true });
    if (freshPlug) publish({ pluggedIn: false }, START - 500);
    publish({ charging: true, ...(freshPlug ? { pluggedIn: true } : {}) }, START, { retain: retainedStart });
  };
  const pause = ({ owned = true, manual = false } = {}) => {
    now = STOP + 10_000; physical(false, STOP);
    if (transport === 'cloud') {
      snapshot.reason = 54; snapshot.reasonAt = STOP;
      snapshot.schedule = normalizeScheduleState({ enabled: 'delayed',
        delayed: { timezone: 'Europe/Helsinki', startTime: '14:00:00', maximumAmps: 16 } });
      control.owned = owned ? { requestedAt: REQUEST, confirmedAt: REQUEST + 2000, startAt: START + 60 * MINUTE,
        activeFingerprint: effectiveScheduleFingerprint(snapshot.schedule) } : null;
    } else {
      control.owned = owned ? { ...ocppPauseInstruction({ profileId: 31, transactionId: 7,
        startAt: START + 60 * MINUTE, now: REQUEST }), requestedAt: REQUEST, pauseRequestedAt: REQUEST, confirmedAt: REQUEST + 2000 } : null;
      control.ownsInstruction = owned; control.pauseConfirmed = owned;
    }
    control.manual = manual ? { kind: 'stop' } : null;
    control.phase = 'paused';
  };
  const startTesla = ({ retained = false } = {}) => {
    Object.assign(tesla, { healthy: true, pluggedIn: true, atHome: true, charging: true,
      fields: { charger_power: { value: 7, receivedAt: START, retained },
        plugged_in: { value: true, receivedAt: START, retained: false },
        charging_state: { value: 'Charging', receivedAt: START, retained: false } } });
  };
  runtime = create();
  return { get runtime() { return runtime; }, snapshot, control, tesla, attach, attachTesla, create, publish,
    startBmw, startTesla, physical, pause,
    setNow: value => { now = value; },
    vehicle: (id = 'charger1') => runtime.telemetry(now)[id].vehicle,
    restart: options => { runtime.persist(); runtime = create(options); return runtime; } };
}

for (const transport of ['cloud', 'ocpp']) {
  test(`${transport}: BMW with unchanged retained inlet identifies from the verified physical pause`, t => {
    const f = fixture(t, transport); f.startBmw();
    assert.equal(f.vehicle().state, 'identifying');
    assert.equal(f.vehicle().id, null);
    f.pause();
    assert.equal(f.vehicle().state, 'identifying', 'The vehicle stop must arrive independently');
    f.publish({ charging: false }, STOP + 4000);
    assert.equal(f.vehicle().id, 'bmw');
    assert.equal(f.vehicle().reason, 'matched-physical-session');
    assert.equal(f.runtime.vehicleFeeds.bmw.reading.fields.pluggedIn.positiveEvent.retained, true);
  });

  test(`${transport}: delayed BMW stop delivery uses its source time and an unchanged physical stop`, t => {
    const f = fixture(t, transport); f.startBmw(); f.pause();
    f.setNow(STOP + 4 * MINUTE);
    // Fresh meter evidence proves the owned pause still holds; its original
    // status transition continues to date the actual stop.
    f.snapshot.powerAt = STOP + 4 * MINUTE;
    f.publish({ charging: false }, STOP + 4000);
    assert.equal(f.vehicle().id, 'bmw');
    assert.equal(f.runtime.vehicleFeeds.bmw.reading.fields.charging.negativeEvent.measuredAt, STOP + 4000);
  });

  for (const kind of ['unowned stop', 'manual pause']) {
    test(`${transport}: independently paired ${kind} identifies BMW with unchanged inlet context`, t => {
      const f = fixture(t, transport); f.startBmw();
      f.pause({ owned: kind !== 'unowned stop', manual: kind === 'manual pause' });
      f.publish({ charging: false }, STOP + 4000);
      assert.equal(f.vehicle().id, 'bmw');
      assert.equal(f.vehicle().reason, 'matched-physical-session');
      if (kind === 'manual pause') assert.deepEqual(f.control.manual, { kind: 'stop' },
        'Historical identity does not erase the independent manual stop');
      else assert.equal(f.control.owned, null);
    });
  }

  for (const failure of ['retained start', 'missing stop']) {
    test(`${transport}: ${failure} cannot identify BMW from unchanged inlet context`, t => {
      const f = fixture(t, transport); f.startBmw({ retainedStart: failure === 'retained start' });
      f.pause();
      if (failure !== 'missing stop') f.publish({ charging: false }, STOP + 4000);
      assert.equal(f.vehicle().id, null);
      f.setNow(START + 16 * MINUTE);
      f.publish({}, START + 16 * MINUTE); // healthy bridge without inventing new source evidence
      assert.equal(f.vehicle().state, failure === 'missing stop' ? 'identifying' : 'unidentified');
      assert.equal(f.vehicle().id, null);
    });
  }

  test(`${transport}: a fresh BMW plug and natural paired stop use the same identification path`, t => {
    const f = fixture(t, transport); f.startBmw({ freshPlug: true });
    f.setNow(START + MINUTE); f.physical(false);
    f.publish({ charging: false }, START + MINUTE);
    assert.equal(f.vehicle().id, 'bmw');
    assert.equal(f.vehicle().reason, 'matched-physical-session');
    assert.equal(f.control.owned, null);
  });

  test(`${transport}: unknown physical charging cannot manufacture a BMW stop`, t => {
    const f = fixture(t, transport); f.startBmw({ freshPlug: true });
    f.setNow(START + MINUTE); f.physical(null);
    f.publish({ charging: false }, START + MINUTE);
    assert.equal(f.vehicle().id, null);
    assert.deepEqual(f.runtime.chargers.charger1.vehicleEvidence.stoppedTimes, []);
  });

  test(`${transport}: fresh Tesla ramp identifies but retained power never identifies`, t => {
    const f = fixture(t, transport); f.startTesla({ retained: true });
    assert.equal(f.vehicle().id, null);
    f.startTesla();
    assert.equal(f.vehicle().id, 'tesla');
    assert.equal(f.vehicle().reason, 'matched-physical-session');
  });

  test(`${transport}: later BMW evidence conflicts with an already identified Tesla`, t => {
    const f = fixture(t, transport); f.startTesla();
    assert.equal(f.vehicle().id, 'tesla');
    f.startBmw({ freshPlug: true });
    f.setNow(START + MINUTE); f.physical(false);
    f.publish({ charging: false }, START + MINUTE);
    assert.equal(f.vehicle().state, 'conflict');
    assert.equal(f.vehicle().id, null);
    f.tesla.healthy = false;
    assert.equal(f.vehicle().state, 'conflict', 'Temporary provider silence cannot decide an ambiguous connection');
  });

  for (const first of ['charger', 'vehicle feed']) {
    test(`${transport}: saved Tesla identity waits for ${first}-first startup without losing its session`, t => {
      const f = fixture(t, transport); f.startTesla();
      assert.equal(f.vehicle().id, 'tesla');
      const expected = structuredClone(f.runtime.chargers.charger1.vehicleMatch);
      const restarted = f.restart({ attached: false, captured: false });
      assert.equal(f.vehicle().id, null);
      assert.deepEqual(restarted.chargers.charger1.vehicleMatch, expected);
      if (first === 'charger') f.attach(restarted); else f.attachTesla(restarted);
      assert.equal(f.vehicle().id, null);
      restarted.persist();
      assert.deepEqual(restarted.chargers.charger1.vehicleMatch, expected,
        'Publishing and saving partial startup must preserve inert same-session context');
      if (first === 'charger') f.attachTesla(restarted); else f.attach(restarted);
      assert.equal(f.vehicle().id, 'tesla');
      assert.deepEqual(restarted.chargers.charger1.vehicleMatch, expected);
    });

    test(`${transport}: saved Tesla/BMW conflict cannot resolve during ${first}-first startup`, t => {
      const f = fixture(t, transport); f.startTesla();
      assert.equal(f.vehicle().id, 'tesla');
      f.startBmw({ freshPlug: true }); f.pause(); f.publish({ charging: false }, STOP + 4000);
      assert.equal(f.vehicle().state, 'conflict');
      const expected = structuredClone(f.runtime.chargers.charger1.vehicleConflict);
      const restarted = f.restart({ attached: false, captured: false });
      assert.equal(f.vehicle().id, null);
      assert.deepEqual(restarted.chargers.charger1.vehicleConflict, expected);
      if (first === 'charger') f.attach(restarted); else f.attachTesla(restarted);
      assert.equal(f.vehicle().id, null);
      restarted.persist();
      assert.deepEqual(restarted.chargers.charger1.vehicleConflict, expected);
      if (first === 'charger') f.attachTesla(restarted); else f.attach(restarted);
      assert.equal(f.vehicle().state, 'conflict');
      assert.deepEqual([...restarted.chargers.charger1.vehicleConflict.ids].sort(), ['bmw', 'tesla']);
    });
  }

  test(`${transport}: a changed Tesla source inherits neither a saved match nor authority from a conflict`, t => {
    const f = fixture(t, transport); f.startTesla();
    assert.equal(f.vehicle().id, 'tesla');
    let restarted = f.restart({ captured: false });
    f.tesla.association = 'synthetic-replacement-tesla';
    f.startTesla({ retained: true });
    f.attachTesla(restarted);
    assert.equal(f.vehicle().id, null, 'Old source identity cannot transfer to the new source');
    assert.equal(restarted.chargers.charger1.vehicleMatch, null);

    // Establish a conflict, then lose fresh bridge reception. Removing one
    // changed source must not promote an unavailable remaining vehicle feed.
    f.startTesla(); assert.equal(f.vehicle().id, 'tesla');
    f.startBmw({ freshPlug: true }); f.pause(); f.publish({ charging: false }, STOP + 4000);
    assert.equal(f.vehicle().state, 'conflict');
    f.setNow(START + 20 * MINUTE);
    restarted = f.restart({ captured: false });
    f.tesla.association = 'synthetic-another-tesla'; f.tesla.healthy = false; f.tesla.fields = {};
    f.attachTesla(restarted);
    assert.equal(f.vehicle().id, null);
    assert.equal(restarted.chargers.charger1.vehicleConflict, null);
  });

  for (const vehicle of ['tesla', 'bmw']) {
    test(`${transport}: one ${vehicle} matching two chargers is ambiguous for both`, t => {
      const f = fixture(t, transport);
      f.attach(f.runtime, 'charger2');
      if (vehicle === 'tesla') f.startTesla();
      else { f.startBmw({ freshPlug: true }); f.pause(); f.publish({ charging: false }, STOP + 4000); }
      assert.equal(f.vehicle('charger1').state, 'conflict');
      assert.equal(f.vehicle('charger2').state, 'conflict');
      assert.equal(f.vehicle('charger1').id, null);
      assert.equal(f.vehicle('charger2').id, null);
    });

    test(`${transport}: ${vehicle} identity survives restart only after the same physical session is observed`, t => {
      const f = fixture(t, transport);
      if (vehicle === 'tesla') f.startTesla();
      else { f.startBmw(); f.pause(); f.publish({ charging: false }, STOP + 4000); }
      assert.equal(f.vehicle().id, vehicle);
      const restarted = f.restart({ attached: false });
      assert.equal(f.vehicle().id, null);
      assert.equal(restarted.chargers.charger1.vehicleMatch.id, vehicle);
      f.attach(restarted);
      assert.equal(f.vehicle().id, vehicle);
      const reconnect = START + 5 * MINUTE;
      f.setNow(reconnect);
      f.control.session = { connected: true, connectedAt: reconnect, lastDisconnectedAt: reconnect - 1000,
        ...(transport === 'ocpp' ? { transactionId: 8 } : {}) };
      f.snapshot.transactionId = 8; f.snapshot.transactionStartedAt = reconnect;
      f.control.owned = null; f.control.ownsInstruction = false; f.control.pauseConfirmed = false;
      f.physical(true, reconnect);
      assert.equal(f.vehicle().id, null, 'Earlier vehicle evidence cannot identify a new connection');
    });
  }
}

for (const transport of ['cloud', 'ocpp']) {
  test(`${transport}: an overnight natural start remains matchable after a long run, restart and delayed stop`, t => {
    const f = fixture(t, transport);
    f.publish({ atHome: true }, START - 14 * 24 * 60 * MINUTE, { retain: true });
    f.publish({ atHome: null }, null);
    f.publish({ pluggedIn: false, charging: false }, START - 500);
    f.publish({ pluggedIn: true, charging: true }, START);
    assert.equal(f.vehicle().id, null);
    const stopAt = START + 78 * MINUTE;
    f.setNow(stopAt); f.physical(false, stopAt);
    assert.equal(f.vehicle().id, null);
    f.restart();
    const resumed = stopAt + 5 * MINUTE;
    f.setNow(resumed); f.physical(true, resumed);
    f.publish({ charging: true }, resumed);
    assert.equal(f.vehicle().id, null);
    f.setNow(stopAt + 60 * MINUTE);
    f.publish({ charging: false }, stopAt + 5000);
    assert.equal(f.runtime.vehicleFeeds.bmw.reading.charging, true, 'Late stop does not roll back current charging');
    assert.equal(f.vehicle().id, 'bmw');
    assert.equal(f.runtime.vehicleFeeds.bmw.consumedChargingId, `synthetic-charging-true-${START}`,
      'The matched historical start is consumed, not the newer resumed start');
    assert.equal(f.runtime.vehicleFeeds.bmw.reading.atHome, null);
  });
}
