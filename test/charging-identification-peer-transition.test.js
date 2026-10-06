import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { advanceIdentification, prepareActiveBmwCandidate } from '../src/charging/identification.js';
import { withReportDatabase } from './helpers/report-database.js';

const START = Date.parse('2026-10-06T09:00:00Z'), MINUTE = 60_000;
const REQUEST = START + 2000, STOP = START + 5000;

function fixture(t, { naturalStart = false } = {}) {
  let now = START, runtime;
  const states = new Map(), store = withReportDatabase({ getState: key => structuredClone(states.get(key)),
    setState: (key, value) => states.set(key, structuredClone(value)) }, t);
  const config = { input: 'mqtt', connections: {
    easee: { charger_id: 'synthetic-peer-transition', equalizer_id: 'synthetic-peer-equalizer' },
    mqtt: { address: 'mqtt://synthetic.invalid', user: 'synthetic-peer-transition' } },
  charging: { vehicles: { bmw: { mqttTopic: 'synthetic/peer-transition/bmw' } }, chargers: { charger2: { enabled: false } } } };
  const controls = Object.fromEntries(['charger1', 'charger2'].map((id, index) => [id, {
    enabled: true, session: { sessionId: `synthetic-${id}`, connected: true, connectedAt: START - 5 * MINUTE,
      lastDisconnectedAt: START - 6 * MINUTE, transactionId: index + 1 },
    owned: null, pending: null, manual: null, ownsInstruction: false, pauseConfirmed: false,
    snapshot: { transport: 'ocpp', online: true, pluggedIn: true, transactionConfirmed: true,
      transactionId: index + 1, transactionStartedAt: START - 5 * MINUTE,
      connectorStatus: index === 0 ? 'Charging' : 'SuspendedEV',
      statusAt: naturalStart && index === 0 ? START - MINUTE : START - 2 * MINUTE,
      powerKw: index === 0 ? 7 : 0 },
  }]));
  const attach = target => {
    for (const [id, control] of Object.entries(controls)) {
      const item = target.chargers[id];
      item.controller = { status: () => structuredClone({ ...control,
        snapshot: { ...control.snapshot, readAt: now, powerAt: now } }), close: async () => {} };
      item.adapter = { normalize: snapshot => {
        const signal = (value, measuredAt = now) => ({ value, measuredAt, available: true });
        return { providerConnected: true, connected: signal(snapshot.pluggedIn),
          charging: signal(snapshot.connectorStatus === 'Charging', snapshot.statusAt), powerKw: signal(snapshot.powerKw) };
      } };
    }
  };
  const create = () => {
    const target = new ChargingRuntime({ engine: {}, store, config, clock: () => now });
    target.tick = () => {};
    target.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
    attach(target); t.after(() => target.close()); return target;
  };
  runtime = create();
  const publish = (values, at, retained = false) => {
    assert.equal(runtime.receiveSoc('synthetic/peer-transition/bmw', JSON.stringify({ provider: 'bmw-cardata', ...values,
      fields: Object.fromEntries(Object.entries(values).map(([key]) => [key,
        { measuredAt: at, readingId: `synthetic-${key}-${at}` }])) }), { retain: retained }, now), true);
  };
  publish({ atHome: true, pluggedIn: true }, START - 10 * MINUTE, true);
  publish({ charging: true }, START - MINUTE);
  runtime.telemetry(now);
  const item = runtime.chargers.charger1, connectedAt = controls.charger1.session.connectedAt;
  item.identification = advanceIdentification(null, { connectedAt, now, charging: true });
  const candidate = prepareActiveBmwCandidate(runtime.vehicleFeeds.bmw.reading, {
    connectedAt, chargingAt: item.vehicleEvidence.chargingTimes, stoppedAt: [], physicalAt: now, now });
  assert.equal(candidate.kind, naturalStart ? 'start' : 'ongoing');
  now++;
  item.identification = advanceIdentification(item.identification, { connectedAt, now, charging: true, candidate });
  const pause = { connectedAt, requestedAt: REQUEST, confirmedAt: STOP, startAt: item.identification.pauseUntil, stoppedAt: STOP };
  Object.assign(controls.charger1, { ownsInstruction: true, pauseConfirmed: true,
    owned: { purpose: 'identification', identificationId: item.identification.id, transactionId: 1,
      identificationConnectedAt: connectedAt,
      requestedAt: REQUEST, pauseRequestedAt: REQUEST, confirmedAt: STOP, startAt: pause.startAt } });
  controls.charger1.snapshot.connectorStatus = 'SuspendedEVSE';
  controls.charger1.snapshot.powerKw = 0; controls.charger1.snapshot.statusAt = STOP;
  now = STOP + 1000;
  item.identification = advanceIdentification(item.identification, { connectedAt, now, charging: false, pause });
  return { controls, publish, states, get runtime() { return runtime; }, get now() { return now; },
    setNow: value => { now = value; },
    view: () => runtime.telemetry(now).charger1.vehicle,
    peer(charging, at) {
      const snapshot = controls.charger2.snapshot;
      snapshot.connectorStatus = charging ? 'Charging' : 'SuspendedEV';
      snapshot.powerKw = charging ? 7 : 0; snapshot.statusAt = at;
    },
    restart() { runtime.persist(); runtime = create(); },
  };
}

test('an unexpected idle-peer start blocks an ongoing-baseline BMW pause match in the same observation pass', t => {
  const f = fixture(t), item = f.runtime.chargers.charger1;
  const savedPause = structuredClone(item.identification), owned = structuredClone(f.controls.charger1.owned);
  f.peer(true, REQUEST + 1000);
  assert.equal(f.view().id, null);
  assert.equal(item.vehicleEvidence.bmwContestedPauseRequestedAt, REQUEST);
  assert.deepEqual(item.identification, savedPause, 'Uncertain identity never changes the saved pause or its deadline');
  assert.deepEqual(f.controls.charger1.owned, owned, 'The native restoration duty remains intact');
  f.publish({ charging: false }, STOP);
  assert.equal(f.view().id, null, 'A BMW stop cannot turn a contaminated pause into identity');
});

test('a peer stop without its original start edge cannot falsely confirm an ongoing BMW baseline', t => {
  const f = fixture(t), peer = f.runtime.chargers.charger2;
  peer.vehicleEvidence.physicalCharging = true;
  peer.vehicleEvidence.chargingTimes = [];
  f.peer(false, STOP);
  f.publish({ charging: false }, STOP);
  assert.equal(f.view().id, null);
  assert.equal(f.runtime.chargers.charger1.vehicleEvidence.bmwContestedPauseRequestedAt, REQUEST);
  assert.deepEqual(peer.vehicleEvidence.chargingTimes, [], 'No missing peer start is manufactured');
});

test('peer contamination is saved while an identification stop still awaits confirmation', t => {
  const f = fixture(t), item = f.runtime.chargers.charger1, control = f.controls.charger1;
  const pause = structuredClone(item.identification.pause), owned = control.owned;
  item.identification.pause = null;
  control.pauseConfirmed = false; control.owned = null;
  control.pending = { action: 'install', instruction: owned };
  control.snapshot.connectorStatus = 'Charging'; control.snapshot.powerKw = 7; control.snapshot.statusAt = START - 2 * MINUTE;
  f.peer(true, REQUEST + 1000); f.view();
  assert.equal(item.vehicleEvidence.bmwContestedPauseRequestedAt, REQUEST);
  assert.equal(item.identification.pause, null, 'Restriction does not manufacture physical stop confirmation');
  control.pending = null; control.owned = owned; control.pauseConfirmed = true;
  control.snapshot.connectorStatus = 'SuspendedEVSE'; control.snapshot.powerKw = 0; control.snapshot.statusAt = STOP;
  item.identification.pause = pause;
  f.publish({ charging: false }, STOP);
  assert.equal(f.view().id, null);
});

test('pause contamination survives peer history replacement and a current-version restart', t => {
  const f = fixture(t);
  f.peer(true, REQUEST + 1000); f.view();
  f.controls.charger2.session.connectedAt = STOP + 1000;
  f.controls.charger2.session.sessionId = 'synthetic-peer-replacement';
  f.setNow(STOP + 2 * MINUTE); f.peer(false, f.now);
  f.view(); f.restart();
  assert.equal(f.runtime.chargers.charger1.vehicleEvidence.bmwContestedPauseRequestedAt, REQUEST);
  f.publish({ charging: false }, STOP);
  assert.equal(f.view().id, null, 'Delayed vehicle delivery cannot launder the earlier contested pause');
});

test('a settled idle peer permits historical BMW pause evidence after a later unrelated peer transition', t => {
  const f = fixture(t);
  assert.equal(f.view().id, null);
  f.setNow(STOP + 2 * MINUTE); f.peer(true, STOP + 31_000); f.view();
  f.publish({ charging: false }, STOP);
  assert.equal(f.view().id, 'bmw');
  assert.equal(f.runtime.chargers.charger1.vehicleEvidence.bmwContestedPauseRequestedAt, undefined,
    'A later transition does not invalidate the original causal window');
});

test('independent complete BMW charging episodes remain usable when a pause alone is contested', t => {
  const f = fixture(t, { naturalStart: true });
  f.peer(true, REQUEST + 1000); f.view();
  f.publish({ charging: false }, STOP);
  assert.equal(f.view().id, 'bmw');
  assert.equal(f.view().reason, 'matched-physical-session');
});

test('a delayed peer edge withdraws an identity supported only by the contaminated pause', t => {
  const f = fixture(t), item = f.runtime.chargers.charger1;
  f.publish({ charging: false }, STOP);
  assert.equal(f.view().id, 'bmw');
  item.identification = advanceIdentification(item.identification, {
    connectedAt: item.identification.connectedAt, now: f.now, identified: true });
  const pause = structuredClone(item.identification.pause), owned = structuredClone(f.controls.charger1.owned);
  f.setNow(STOP + 10_000); f.peer(true, REQUEST + 1000);
  assert.equal(f.view().id, null);
  assert.equal(item.identification.phase, 'observing', 'Withdrawal grants no new active test or charging allowance');
  assert.deepEqual(item.identification.pause, pause);
  assert.deepEqual(f.controls.charger1.owned, owned);
  f.restart();
  assert.equal(f.view().id, null, 'Restart cannot restore the withdrawn certainty from consumed evidence');
});

test('a peer edge cannot withdraw a complete independent BMW charging episode', t => {
  const f = fixture(t, { naturalStart: true });
  f.publish({ charging: false }, STOP);
  assert.equal(f.view().id, 'bmw');
  f.setNow(STOP + 10_000); f.peer(true, REQUEST + 1000);
  assert.equal(f.view().id, 'bmw');
  assert.equal(f.view().reason, 'matched-physical-session');
});

test('a contested retry preserves the earlier confirmed identity', t => {
  const f = fixture(t), item = f.runtime.chargers.charger1;
  f.publish({ charging: false }, STOP);
  assert.equal(f.view().id, 'bmw');
  // A retained identity predates this retry's request and is not evidence
  // produced by the retry. Its existing session label remains authoritative.
  item.vehicleMatch.matchedAt = REQUEST - 1000;
  const earlier = structuredClone(item.vehicleMatch);
  f.setNow(STOP + 10_000); f.peer(true, REQUEST + 1000);
  assert.equal(f.view().id, 'bmw');
  assert.deepEqual(item.vehicleMatch, earlier);
});

test('malformed persisted pause-contamination restrictions fail closed', t => {
  const f = fixture(t);
  f.runtime.persist();
  const saved = f.states.get(f.runtime.key);
  saved.chargers.charger1.vehicleEvidence.bmwContestedPauseRequestedAt = 'unknown';
  assert.throws(() => new ChargingRuntime({ engine: {}, store: f.runtime.store, config: f.runtime.config,
    clock: () => f.now }), /Unsupported saved current identification evidence/);
});
