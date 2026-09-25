import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveScheduleFingerprint } from '../src/charging/easee.js';
import { confirmedIdentityPause } from '../src/charging/identity-evidence.js';

const NOW = Date.parse('2026-09-25T09:00:00Z'), MINUTE = 60_000;
const expected = { connectedAt: NOW - 5 * MINUTE, requestedAt: NOW - 30_000,
  confirmedAt: NOW - 20_000, startAt: NOW + 30 * MINUTE, stoppedAt: NOW - 25_000 };

function fixture(transport) {
  const { stoppedAt, ...owned } = expected;
  const control = { enabled: true, errorCode: null, pending: null, manual: null, released: false,
    session: { connected: true, connectedAt: expected.connectedAt, lastDisconnectedAt: NOW - 10 * MINUTE },
    owned, snapshot: { online: true, readAt: NOW, pluggedIn: true } };
  if (transport === 'ocpp') {
    Object.assign(control, { ownsInstruction: true, pauseConfirmed: true });
    control.session.transactionId = 17;
    control.owned.transactionId = 17;
    control.owned.pauseRequestedAt = expected.requestedAt;
    Object.assign(control.snapshot, { transport, connectionId: 'synthetic-connection', transactionId: 17,
      transactionConfirmed: true, transactionStartedAt: expected.connectedAt,
      connectorStatus: 'SuspendedEVSE', statusAt: stoppedAt, powerKw: 0, powerAt: NOW - 1000 });
  } else if (transport === 'shelly-evse') {
    Object.assign(control, { ownsInstruction: true, pauseConfirmed: true });
    control.session.sessionId = 'synthetic-shelly-session';
    Object.assign(control.owned, { purpose: 'identification', identificationId: 'synthetic-identification',
      identificationConnectedAt: expected.connectedAt, sessionId: control.session.sessionId });
    Object.assign(control.snapshot, { transport, controlReady: true, nativeScheduleActive: false,
      charging: false, statusAt: stoppedAt, powerKw: 0, powerAt: NOW - 1000 });
  } else {
    const schedule = { enabled: 'delayed', delayed: { startTime: '09:30:00', timezone: 'UTC', maximumAmps: 16 } };
    control.owned.activeFingerprint = effectiveScheduleFingerprint(schedule);
    Object.assign(control.snapshot, { controlKnown: true, enabled: true, faulted: false, manualStop: false,
      stopped: false, authorizationBlocked: false, mode: 2, reason: 54, modeAt: stoppedAt, reasonAt: stoppedAt, schedule });
  }
  return control;
}

test('cloud, OCPP and Shelly prove the exact same transport-independent pause', () => {
  for (const transport of ['cloud', 'ocpp', 'shelly-evse']) {
    const control = fixture(transport), before = structuredClone(control);
    assert.deepEqual(confirmedIdentityPause(control, NOW), expected, transport);
    assert.deepEqual(control, before, 'normalizing must not mutate controller evidence');
  }
});

test('Shelly identity requires current owned pause, physical stop and fresh zero power', () => {
  const invalid = [
    ...commonInvalid.filter(([name]) => name !== 'disabled automatic control'),
    ['unowned setting', c => { c.ownsInstruction = false; }],
    ['unconfirmed physical effect', c => { c.pauseConfirmed = false; }],
    ['ordinary economic pause', c => { c.owned.purpose = 'economic'; }],
    ['different connection', c => { c.owned.identificationConnectedAt++; }],
    ['different session', c => { c.owned.sessionId = 'synthetic-other-session'; }],
    ['missing session ID', c => { delete c.session.sessionId; delete c.owned.sessionId; }],
    ['native control blocked', c => { c.snapshot.controlReady = false; }],
    ['native schedule', c => { c.snapshot.nativeScheduleActive = true; }],
    ['still charging', c => { c.snapshot.charging = true; }],
    ['unknown work state', c => { c.snapshot.charging = null; }],
    ['stop before request', c => { c.snapshot.statusAt = expected.requestedAt - 1; }],
    ['future stop', c => { c.snapshot.statusAt = NOW + 1; }],
    ['unknown power', c => { c.snapshot.powerKw = null; }],
    ['nonzero power', c => { c.snapshot.powerKw = 0.05; }],
    ['zero before request', c => { c.snapshot.powerAt = expected.requestedAt - 1; }],
    ['future power', c => { c.snapshot.powerAt = NOW + 1; }],
  ];
  for (const [name, change] of invalid) {
    const control = fixture('shelly-evse'); change(control);
    assert.equal(confirmedIdentityPause(control, NOW), null, name);
  }
  const off = fixture('shelly-evse'); off.enabled = false;
  assert.deepEqual(confirmedIdentityPause(off, NOW), expected, 'Automatic OFF does not disable identification');
});

const commonInvalid = [
  ['disabled automatic control', c => { c.enabled = false; }],
  ['read failure retaining cached snapshot', c => { c.errorCode = 'read-failed'; }],
  ['command failure', c => { c.errorCode = 'command-failed'; }],
  ['readback mismatch', c => { c.errorCode = 'readback-mismatch'; }],
  ['pending write', c => { c.pending = { action: 'install' }; }],
  ['pending clear', c => { c.pending = { action: 'clear' }; }],
  ['manual stop', c => { c.manual = { kind: 'stop' }; }],
  ['manual release', c => { c.manual = { kind: 'release' }; }],
  ['released session', c => { c.released = true; }],
  ['controller disconnected', c => { c.disconnected = true; }],
  ['awaiting reconnection', c => { c.vehicleDisconnect = { awaitingConnection: true }; }],
  ['disconnect cleanup pending', c => { c.vehicleDisconnect = { cleanupPending: true }; }],
  ['disconnected session', c => { c.session.connected = false; }],
  ['unknown session connection', c => { c.session.connected = null; }],
  ['physically unplugged', c => { c.snapshot.pluggedIn = false; }],
  ['unknown plug state', c => { c.snapshot.pluggedIn = null; }],
  ['offline snapshot', c => { c.snapshot.online = false; }],
  ['unknown online state', c => { c.snapshot.online = null; }],
  ['stale read', c => { c.snapshot.readAt = NOW - MINUTE - 1; }],
  ['future read', c => { c.snapshot.readAt = NOW + 1; }],
  ['missing read clock', c => { delete c.snapshot.readAt; }],
  ['missing owner', c => { c.owned = null; }],
  ['missing session', c => { c.session = null; }],
  ['future session', c => { c.session.connectedAt = NOW + 1; }],
  ['prior session instruction', c => { c.session.connectedAt = expected.requestedAt + 1; }],
  ['disconnect after session start', c => { c.session.lastDisconnectedAt = expected.connectedAt + 1; }],
  ['disconnect at session start', c => { c.session.lastDisconnectedAt = expected.connectedAt; }],
  ['invalid disconnect clock', c => { c.session.lastDisconnectedAt = NaN; }],
  ['missing guarded request', c => { delete c.owned.requestedAt; delete c.owned.pauseRequestedAt; }],
  ['future request', c => { c.owned.requestedAt = NOW + 1; c.owned.pauseRequestedAt = NOW + 1; }],
  ['request before connection', c => { c.owned.requestedAt = expected.connectedAt - 1; c.owned.pauseRequestedAt = expected.connectedAt - 1; }],
  ['unconfirmed instruction', c => { delete c.owned.confirmedAt; }],
  ['future confirmation', c => { c.owned.confirmedAt = NOW + 1; }],
  ['confirmation before request', c => { c.owned.confirmedAt = expected.requestedAt - 1; }],
  ['expired pause', c => { c.owned.startAt = NOW; }],
  ['invalid future start', c => { c.owned.startAt = Infinity; }],
  ['unknown transport', c => { c.snapshot.transport = 'unsupported'; }],
];

for (const transport of ['cloud', 'ocpp']) {
  test(`${transport} rejects invalid current pause evidence`, () => {
    for (const [name, change] of commonInvalid) {
      const control = fixture(transport); change(control);
      assert.equal(confirmedIdentityPause(control, NOW), null, name);
    }
    for (const now of [null, undefined, NaN, Infinity, -1, NOW + 0.5])
      assert.equal(confirmedIdentityPause(fixture(transport), now), null, `invalid now ${now}`);
  });

  test(`${transport} requires the stop to follow the request, without depending on readback latency`, () => {
    const stopped = (control, at) => {
      if (transport === 'ocpp') control.snapshot.statusAt = at;
      else { control.snapshot.modeAt = at; control.snapshot.reasonAt = at; }
    };
    for (const at of [expected.requestedAt - 1, NOW + 1, NaN, undefined]) {
      const control = fixture(transport); stopped(control, at);
      assert.equal(confirmedIdentityPause(control, NOW), null, `invalid stop ${at}`);
    }
    const sameMillisecond = fixture(transport); stopped(sameMillisecond, expected.requestedAt);
    assert.deepEqual(confirmedIdentityPause(sameMillisecond, NOW), { ...expected, stoppedAt: expected.requestedAt });
    const laterStop = fixture(transport); stopped(laterStop, expected.confirmedAt + 1);
    assert.deepEqual(confirmedIdentityPause(laterStop, NOW), { ...expected, stoppedAt: expected.confirmedAt + 1 });
    const justRead = fixture(transport); justRead.owned.confirmedAt = NOW;
    justRead.snapshot.readAt = NOW - 1;
    assert.equal(confirmedIdentityPause(justRead, NOW)?.confirmedAt, NOW,
      'confirmation can be timestamped just after the successful read');
  });
}

test('cloud needs matching native schedule ownership and reason54 stopped-state clocks', () => {
  const invalid = [
    ['unknown native state', c => { c.snapshot.controlKnown = false; }],
    ['native disabled', c => { c.snapshot.enabled = false; }],
    ['native fault', c => { c.snapshot.faulted = true; }],
    ['native manual stop', c => { c.snapshot.manualStop = true; }],
    ['native stop', c => { c.snapshot.stopped = true; }],
    ['authorization blocked', c => { c.snapshot.authorizationBlocked = true; }],
    ['still charging', c => { c.snapshot.mode = 3; }],
    ['foreign reason', c => { c.snapshot.reason = 53; }],
    ['foreign fingerprint', c => { c.owned.activeFingerprint = 'synthetic-foreign'; }],
    ['missing fingerprint', c => { delete c.owned.activeFingerprint; }],
    ['changed schedule', c => { c.snapshot.schedule.delayed.maximumAmps = 20; }],
    ['disabled schedule', c => { c.snapshot.schedule.enabled = 'none'; }],
    ['missing schedule', c => { delete c.snapshot.schedule; }],
    ['invalid schedule', c => { c.snapshot.schedule.delayed.timezone = 'Synthetic/Unknown'; }],
    ['wrong absolute start', c => { c.owned.startAt += 24 * 60 * MINUTE; }],
    ['reason predates request', c => { c.snapshot.reasonAt = expected.requestedAt - 1; }],
    ['future reason', c => { c.snapshot.reasonAt = NOW + 1; }],
    ['reason absent', c => { c.snapshot.reasonAt = null; }],
    ['stale stopped mode', c => { c.snapshot.modeAt = expected.requestedAt - 1; }],
    ['reason and mode refer to different stops', c => {
      c.owned.requestedAt = NOW - 2 * MINUTE;
      c.snapshot.modeAt = NOW - MINUTE; c.snapshot.reasonAt = NOW - 29_999;
    }],
  ];
  for (const [name, change] of invalid) {
    const control = fixture('cloud'); change(control);
    assert.equal(confirmedIdentityPause(control, NOW), null, name);
  }
  for (const mode of [2, 4, 6]) {
    const control = fixture('cloud'); control.snapshot.mode = mode;
    assert.deepEqual(confirmedIdentityPause(control, NOW), expected, `stopped connected mode ${mode}`);
  }
  const cached = fixture('cloud');
  cached.snapshot.schedule.daily = { timezone: 'UTC', periods: [{ startTime: '00:00:00', stopTime: '01:00:00', maximumAmps: 8 }] };
  assert.deepEqual(confirmedIdentityPause(cached, NOW), expected, 'inactive schedules cannot change current owned delay');
});

test('OCPP needs current transaction ownership, physical EVSE pause and fresh zero power', () => {
  const invalid = [
    ['unowned envelope', c => { c.ownsInstruction = false; }],
    ['intent without Charging witness', c => { delete c.owned.pauseRequestedAt; }],
    ['witness predates command intent', c => { c.owned.pauseRequestedAt = c.owned.requestedAt - 1; }],
    ['unconfirmed physical pause', c => { c.pauseConfirmed = false; }],
    ['unconfirmed reconnected transaction', c => { c.snapshot.transactionConfirmed = false; }],
    ['new transaction', c => { c.snapshot.transactionId += 1; }],
    ['prior session transaction', c => { c.session.transactionId += 1; }],
    ['missing transaction', c => { c.snapshot.transactionId = null; c.owned.transactionId = null; c.session.transactionId = null; }],
    ['invalid transaction', c => { c.snapshot.transactionId = -1; c.owned.transactionId = -1; c.session.transactionId = -1; }],
    ['future transaction', c => { c.snapshot.transactionStartedAt = NOW + 1; }],
    ['transaction starts after request', c => { c.snapshot.transactionStartedAt = expected.requestedAt + 1; }],
    ['transaction belongs before disconnect', c => { c.snapshot.transactionStartedAt = c.session.lastDisconnectedAt; }],
    ['vehicle stopped itself', c => { c.snapshot.connectorStatus = 'SuspendedEV'; }],
    ['still charging', c => { c.snapshot.connectorStatus = 'Charging'; }],
    ['faulted connector', c => { c.snapshot.connectorStatus = 'Faulted'; }],
    ['nonzero power', c => { c.snapshot.powerKw = 0.01; }],
    ['unknown power', c => { c.snapshot.powerKw = null; }],
    ['old zero power before request', c => { c.snapshot.powerAt = expected.requestedAt - 1; }],
    ['stale zero power', c => { c.owned.requestedAt = NOW - 2 * MINUTE; c.owned.pauseRequestedAt = NOW - 2 * MINUTE;
      c.snapshot.powerAt = NOW - MINUTE - 1; }],
    ['future zero power', c => { c.snapshot.powerAt = NOW + 1; }],
    ['missing power clock', c => { delete c.snapshot.powerAt; }],
    ['power after successful snapshot read', c => { c.snapshot.readAt = NOW - 2000; }],
  ];
  for (const [name, change] of invalid) {
    const control = fixture('ocpp'); change(control);
    assert.equal(confirmedIdentityPause(control, NOW), null, name);
  }
});

test('freshness accepts exactly one minute and rejects one millisecond older', () => {
  for (const transport of ['cloud', 'ocpp']) {
    const control = fixture(transport), now = NOW + MINUTE;
    if (transport === 'ocpp') control.snapshot.powerAt = NOW;
    assert.deepEqual(confirmedIdentityPause(control, now), expected, transport);
    assert.equal(confirmedIdentityPause(control, now + 1), null, transport);
  }
});
