import test from 'node:test';
import assert from 'node:assert/strict';
import { createChargingTeslaCapture, teslamateVehicleTelemetry } from '../src/charging/teslamate.js';
import { updateTeslaCurrentRequest, validateTeslaCurrentRequest } from '../src/charging/tesla-current-request.js';
import { validateChargingRuntimeState } from '../src/charging/runtime-state.js';
import { planChargers } from '../src/charging/planner.js';
import { ocppPauseInstruction } from '../src/charging/ocpp.js';

const START = 1_800_000_000_000;
function fixture() {
  let now = START, state = null, nativeCurrent = pilot(13, START), control = {
    session: { sessionId: 'synthetic-session', connectedAt: START }, snapshot: { fields: {} } };
  const capture = createChargingTeslaCapture({ clock: () => now }); capture.setConnected(true);
  const admit = () => state = updateTeslaCurrentRequest(state, capture.snapshot(), { now, nativeCurrent, control });
  const send = (field, value, packet = {}) => { capture.receive(`teslamate/cars/1/${field}`, String(value), packet); admit(); };
  send('healthy', true); send('charging_state', 'Charging');
  return { send, admit, capture, get now() { return now; }, advance(ms = 1000) { now += ms; },
    get state() { return state; }, restore(value) { state = structuredClone(value); },
    setPilot(value) { nativeCurrent = pilot(value, now); }, setControl(value) { control = value; },
    setNativeCurrent(value) { nativeCurrent = value; },
    project() { return teslamateVehicleTelemetry(capture.snapshot(), { now, currentRequest: state }).vehicleCurrentA; } };
}
const pilot = (value, at) => ({ value, available: true, measuredAt: at, receivedAt: at, retained: false });
const stoppedFields = { start_charging: { value: false, measuredAt: START, receivedAt: START },
  work_state: { measuredAt: START, receivedAt: START }, phase_info: { measuredAt: START, receivedAt: START } };
const permissionScope = () => ({ association: 'synthetic-charger',
  session: { connected: true, sessionId: 'synthetic-session', connectedAt: START },
  snapshot: { association: 'synthetic-charger', fields: {} } });
const pendingStop = (patch = {}) => ({ association: 'synthetic-charger', sessionId: 'synthetic-session',
  revision: 1, expiresAt: START + 10_000, role: 'start_charging', value: false,
  reason: 'economic-wait', stage: 'dispatched', dispatchedAt: START + 500, ...patch });
const ocppPause = (now, stoppedAt = START + 3) => ({ enabled: true, ownsInstruction: true, pauseConfirmed: true,
  session: { connected: true, connectedAt: START, lastDisconnectedAt: START - 1000, transactionId: 17 },
  owned: { profileId: 1, transactionId: 17, requestedAt: START + 1, pauseRequestedAt: START + 1,
    confirmedAt: START + 2, startAt: START + 3600_000 },
  pauseWitness: { profileId: 1, transactionId: 17, connectionId: 'synthetic-ocpp', at: stoppedAt },
  snapshot: { transport: 'ocpp', online: true, pluggedIn: true, readAt: now, connectionId: 'synthetic-ocpp',
    transactionConfirmed: true, transactionStartedAt: START, transactionId: 17, connectorStatus: 'SuspendedEVSE',
    statusAt: stoppedAt, powerAt: stoppedAt, powerKw: 0 } });
const pendingOcppPause = now => {
  const control = ocppPause(now); control.scope = 'a'.repeat(64); control.snapshot.scope = control.scope;
  control.ownsInstruction = false; control.pauseConfirmed = false; control.owned = null;
  control.pending = { action: 'install', attempts: 1, nextAttemptAt: START + 30_000, accepted: false, execution: null,
    instruction: { ...ocppPauseInstruction({ profileId: 1, transactionId: 17, startAt: START + 3600_000, now: START }),
      requestedAt: START + 500, pauseRequestedAt: START + 600 } };
  return control;
};

test('a qualified request keeps its original clocks through four real max-only pilot cycles and restart', () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10);
  const original = structuredClone(f.state.limit), fields = structuredClone(f.capture.snapshot().fields.charge_current_request);
  assert.equal(f.project().value, 10);
  for (const current of [10, 12, 10, 12, 10, 12, 10, 12]) {
    f.advance(); f.setPilot(current); f.send('charge_current_request_max', current);
    assert.equal(f.project().value, 10); assert.deepEqual(f.state.limit, original);
    assert.deepEqual(f.capture.snapshot().fields.charge_current_request, fields);
    assert.equal(f.project().rawRequest.value, 10);
    f.restore(f.state);
  }
  const before = structuredClone(f.state); f.project(); f.project(); assert.deepEqual(f.state, before);
});

for (const reflected of [6, 10]) test(`matching ${reflected} A pilot cannot become an independent ceiling on a later max-only raise`, () => {
  const f = fixture(); f.setPilot(reflected); f.send('charge_current_request_max', reflected); f.send('charge_current_request', reflected);
  assert.equal(f.state.request.reflected, true); assert.equal(f.project().value, null);
  f.advance(); f.setPilot(16); f.send('charge_current_request_max', 16);
  assert.equal(f.project().value, null); assert.equal(f.state.limit, null);
});

test('a request-first update can qualify from its prior confirmed pilot after asynchronous max arrival', () => {
  const f = fixture(); f.send('charge_current_request_max', 10); f.advance(); f.send('charge_current_request', 10);
  assert.equal(f.state.request.eligible, true); assert.equal(f.state.limit, null);
  f.advance(); f.send('charge_current_request_max', 13);
  assert.equal(f.project().value, 10); assert.equal(f.project().receivedAt, START + 1000);
  assert.equal(f.state.limit.maximumReceivedAt, START + 2000);
});

test('confirmed own Stop 5/5 retains a genuine ceiling and never promotes its stopped report after restart', () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10);
  const original = structuredClone(f.state.limit); f.advance();
  f.setControl({ session: { sessionId: 'synthetic-session', connectedAt: START }, pauseConfirmed: true,
    permissionCommand: { value: false, sessionId: 'synthetic-session', dispatchedAt: START, acceptedAt: START },
    snapshot: { fields: stoppedFields } });
  f.send('charging_state', 'Stopped'); f.send('charge_current_request', 5);
  assert.equal(f.state.request.reflected, true, 'The request arrives before max5, while the native pilot remains13');
  assert.deepEqual(f.state.limit, original); f.send('charge_current_request_max', 5);
  f.restore(f.state); f.advance(); f.send('charge_current_request_max', 16);
  assert.deepEqual(f.state.limit, original); assert.equal(f.project().value, 10); assert.equal(f.project().rawRequest.value, 5);
});

test('new zero, lower and higher requests retain their own provenance and release older choices', () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10);
  for (const current of [8, 1, 0]) {
    f.advance(); f.send('charge_current_request', current);
    assert.equal(f.project().value, current); assert.equal(f.project().receivedAt, f.now);
  }
  f.advance(); f.send('charge_current_request', 16);
  assert.equal(f.state.limit, null, 'A new higher usable request retires the original zero constraint');
  f.advance(); f.setPilot(16); f.send('charge_current_request_max', 16); f.send('charge_current_request', 12);
  assert.equal(f.project().value, 12);
  f.advance(); f.send('charge_current_request', 16);
  assert.equal(f.state.limit, null, 'A genuinely new higher matching request releases the earlier lower ceiling');
});

test('a real zero after a confirmed own Stop remains independent instead of becoming a stopped reflection', () => {
  const f = fixture(); f.send('charge_current_request_max', 5); f.advance();
  f.setControl({ session: { sessionId: 'synthetic-session', connectedAt: START }, pauseConfirmed: true,
    permissionCommand: { value: false, sessionId: 'synthetic-session', acceptedAt: START },
    snapshot: { fields: stoppedFields } });
  f.send('charging_state', 'Stopped'); f.send('charge_current_request', 0);
  assert.equal(f.state.request.reflected, false); assert.equal(f.project().value, 0);
  f.advance(); f.send('charge_current_request_max', 0); assert.equal(f.project().value, 0);
});

test('pending command intent is unknown and preserves a proven lower ceiling without claiming reflection', () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10);
  const original = structuredClone(f.state.limit); f.advance();
  f.setControl({ session: { sessionId: 'synthetic-session', connectedAt: START },
    pending: { role: 'current_limit', value: 6, sessionId: 'synthetic-session', dispatchedAt: START }, snapshot: { fields: {} } });
  f.send('charge_current_request', 6);
  assert.equal(f.state.request.reflected, false); assert.equal(f.state.request.eligible, false);
  assert.deepEqual(f.state.limit, original); f.advance(); f.send('charge_current_request_max', 16);
  assert.deepEqual(f.state.limit, original);
});

for (const stage of ['dispatched', 'accepted']) test(`a stopped 5 A during ${stage} permission Stop remains unknown through ACK, max updates and restart`, () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10);
  const original = structuredClone(f.state.limit); f.advance();
  f.setControl({ ...permissionScope(), pending: pendingStop({ stage,
    ...(stage === 'accepted' ? { acceptedAt: START + 800 } : {}) }) });
  f.send('charging_state', 'Stopped'); f.send('charge_current_request', 5);
  const request = structuredClone(f.capture.snapshot().fields.charge_current_request);
  assert.equal(f.state.request.eligible, false); assert.equal(f.state.request.reflected, false);
  assert.deepEqual(f.state.limit, original);
  // The command can fail, expire or be superseded after publication. None proves
  // it was unapplied at the original request; a later max cannot rewrite that.
  f.advance(12_000); f.setControl({ ...permissionScope(), pending: null,
    permissionCommand: { value: false, sessionId: 'synthetic-session', dispatchedAt: START + 500, acceptedAt: f.now } });
  f.restore(f.state); f.capture.setConnected(false); f.admit(); f.capture.setConnected(true); f.send('healthy', true);
  for (const maximum of [5, 16]) { f.advance(); f.send('charge_current_request_max', maximum); }
  f.send('charge_current_request', 5);
  assert.deepEqual(f.capture.snapshot().fields.charge_current_request, request);
  assert.deepEqual(f.state.limit, original); assert.equal(f.state.request.eligible, false);
  f.advance(); f.send('charge_current_request', 8); assert.equal(f.project().value, 8);
});

test('delayed first qualification keeps dispatch/request/ACK order after pending was cleared', () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10);
  const original = structuredClone(f.state.limit); f.advance();
  f.capture.receive('teslamate/cars/1/charging_state', 'Stopped', {});
  f.capture.receive('teslamate/cars/1/charge_current_request', '5', {});
  f.advance(500); f.setControl({ ...permissionScope(), pending: null,
    permissionCommand: { value: false, sessionId: 'synthetic-session', dispatchedAt: START + 500, acceptedAt: f.now } });
  f.admit(); assert.equal(f.state.request.eligible, false); assert.equal(f.state.request.reflected, false);
  assert.deepEqual(f.state.limit, original); assert.equal(f.state.request.receivedAt, START + 1000);
  f.advance(); f.send('charge_current_request_max', 16); assert.deepEqual(f.state.limit, original);
});

test('a pending Stop without an earlier qualified limit leaves stopped 5 A unknown', () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.advance();
  f.setControl({ ...permissionScope(), pending: pendingStop() });
  f.send('charging_state', 'Stopped'); f.send('charge_current_request', 5);
  assert.equal(f.state.request.eligible, false); assert.equal(f.state.request.reflected, false);
  assert.equal(f.project().value, null);
});

for (const [name, mutate] of [
  ['proposed unpublished command', control => { control.pending.stage = 'proposed'; }],
  ['future dispatch', control => { control.pending.dispatchedAt = START + 1500; }],
  ['foreign session', control => { control.pending.sessionId = 'other-session'; }],
  ['foreign equipment', control => { control.pending.association = 'other-charger'; }],
  ['changed physical association', control => { control.snapshot.association = 'other-charger'; }],
  ['dispatch before new physical connection', control => { control.session.connectedAt = START + 700; }],
  ['disconnected physical session', control => { control.session.connected = false; }],
  ['superseded by pending Start', control => { control.pending.value = true; }],
]) test(`${name} cannot suppress an independent stopped 5 A request`, () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10); f.advance();
  const control = { ...permissionScope(), pending: pendingStop() }; mutate(control); f.setControl(control);
  f.send('charging_state', 'Stopped'); f.send('charge_current_request', 5);
  assert.equal(f.state.request.eligible, true); assert.equal(f.project().value, 5);
});

for (const current of [0, 1, 8, 16]) test(`pending permission Stop does not replace a genuinely new ${current} A request`, () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10); f.advance();
  f.setControl({ ...permissionScope(), pending: pendingStop() }); f.send('charging_state', 'Stopped');
  f.send('charge_current_request', current);
  assert.equal(f.state.request.reflected, false); assert.equal(f.project().value, current < 13 ? current : null);
  assert.equal(f.state.limit?.value ?? null, current < 13 ? current : null);
});

test('permission Stop intent cannot suppress5 while Tesla still reports charging', () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10); f.advance();
  f.setControl({ ...permissionScope(), pending: pendingStop() }); f.send('charge_current_request', 5);
  assert.equal(f.project().value, 5); assert.equal(f.state.request.eligible, true);
});

test('a pending same-transaction OCPP pause keeps stopped 5 A unknown through later ACK and maximum changes', () => {
  const f = fixture(); f.setNativeCurrent({ ...pilot(13, START), receivedAt: null });
  f.send('charge_current_request_max', 13); f.send('charge_current_request', 10);
  const original = structuredClone(f.state.limit); f.advance();
  const control = pendingOcppPause(f.now); f.setControl(control);
  f.send('charging_state', 'Stopped'); f.send('charge_current_request', 5);
  assert.equal(f.state.request.eligible, false); assert.equal(f.state.request.reflected, false);
  assert.deepEqual(f.state.limit, original);
  f.advance(); control.owned = { ...control.pending.instruction, confirmedAt: f.now }; control.pending = null;
  control.ownsInstruction = true; control.pauseConfirmed = true;
  for (const maximum of [5, 16]) { f.advance(); f.send('charge_current_request_max', maximum); }
  assert.deepEqual(f.state.limit, original); assert.equal(f.state.request.eligible, false);
});

test('a later owned OCPP confirmation preserves uncertainty at the original stopped request receipt', () => {
  const f = fixture(); f.setNativeCurrent({ ...pilot(13, START), receivedAt: null });
  f.send('charge_current_request_max', 13); f.send('charge_current_request', 10);
  const original = structuredClone(f.state.limit); f.advance();
  f.capture.receive('teslamate/cars/1/charging_state', 'Stopped', {});
  f.capture.receive('teslamate/cars/1/charge_current_request', '5', {});
  f.advance(500); const control = pendingOcppPause(f.now);
  control.owned = { ...control.pending.instruction, confirmedAt: f.now }; control.pending = null;
  control.ownsInstruction = true; f.setControl(control); f.admit();
  assert.equal(f.state.request.eligible, false); assert.equal(f.state.request.reflected, false);
  assert.deepEqual(f.state.limit, original);
});

for (const [name, mutate] of [
  ['unwitnessed profile proposal', control => { delete control.pending.instruction.pauseRequestedAt; control.pending.attempts = 0; }],
  ['profile clear', control => { control.pending.action = 'clear'; }],
  ['foreign equipment scope', control => { control.scope = 'b'.repeat(64); }],
  ['foreign transaction', control => { control.pending.instruction.transactionId = 18; }],
  ['changed native transaction', control => { control.snapshot.transactionId = 18; }],
  ['unconfirmed native transaction', control => { control.snapshot.transactionConfirmed = false; }],
  ['future pause witness', control => { control.pending.instruction.pauseRequestedAt = START + 1500; }],
  ['request before current connection', control => { control.pending.instruction.requestedAt = START - 1; }],
  ['ended pause before request', control => { control.pending.instruction.startAt = START + 1000; }],
]) test(`OCPP ${name} cannot suppress an independent stopped 5 A`, () => {
  const f = fixture(); f.setNativeCurrent({ ...pilot(13, START), receivedAt: null });
  f.send('charge_current_request_max', 13); f.send('charge_current_request', 10); f.advance();
  const control = pendingOcppPause(f.now); mutate(control); f.setControl(control);
  f.send('charging_state', 'Stopped'); f.send('charge_current_request', 5);
  assert.equal(f.state.request.eligible, true); assert.equal(f.project().value, 5);
});

for (const current of [0, 1, 8, 16]) test(`an OCPP pending pause preserves a new independent ${current} A request`, () => {
  const f = fixture(); f.setNativeCurrent({ ...pilot(13, START), receivedAt: null });
  f.send('charge_current_request_max', 13); f.send('charge_current_request', 10); f.advance();
  f.setControl(pendingOcppPause(f.now)); f.send('charging_state', 'Stopped'); f.send('charge_current_request', current);
  assert.equal(f.state.request.reflected, false); assert.equal(f.project().value, current < 13 ? current : null);
});

for (const [name, patch] of [
  ['foreign session', { sessionId: 'other-session' }],
  ['before current connection', { dispatchedAt: START - 1 }],
  ['future ACK', { acceptedAt: START + 2000 }],
]) test(`late saved Stop ACK ${name} cannot suppress independent5`, () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10); f.advance();
  f.setControl({ ...permissionScope(), permissionCommand: { value: false, sessionId: 'synthetic-session',
    dispatchedAt: START + 500, acceptedAt: START + 1500, ...patch } });
  f.capture.receive('teslamate/cars/1/charging_state', 'Stopped', {});
  f.capture.receive('teslamate/cars/1/charge_current_request', '5', {});
  f.advance(500); f.admit();
  assert.equal(f.project().value, 5); assert.equal(f.state.request.eligible, true);
});

test('currentTest pending derives its scope from the supported parent record and never hides zero', () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10);
  const original = structuredClone(f.state.limit); f.advance();
  f.setControl({ session: { sessionId: 'synthetic-session', connectedAt: START },
    currentTest: { sessionId: 'synthetic-session', connectedAt: START,
      pending: { value: 6, dispatchedAt: START, acceptedAt: START } }, snapshot: { fields: {} } });
  f.send('charge_current_request', 6); assert.equal(f.state.request.eligible, false); assert.deepEqual(f.state.limit, original);
  f.advance(); f.setControl({ session: { sessionId: 'synthetic-session', connectedAt: START },
    pending: { role: 'current_limit', value: 0, sessionId: 'synthetic-session', dispatchedAt: START }, snapshot: { fields: {} } });
  f.send('charge_current_request', 0); assert.equal(f.project().value, 0);
});

for (const [name, phase, restoreAt, receivedAt, requestOffset, qualifies] of [
  ['restoration after the held request', 'restored', START + 11_000, START + 12_000, 10_400, false],
  ['unresolved whole-second ordering', 'restored', START + 10_000, START + 12_000, 10_400, false],
  ['confirmed restored pilot before a genuinely new request', 'restored', START + 8000, START + 9000, 10_400, true],
  ['supersession after the held test-era request', 'superseded', START + 11_000, START + 12_000, 10_400, false],
  ['confirmed external pilot before a genuinely new request', 'superseded', START + 8000, START + 9000, 10_400, true],
  ['new request after the superseded test interval', 'superseded', START + 101_000, START + 102_000, 100_400, true],
]) test(`a terminal minimum-current test handles ${name} without inventing independent6`, () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.advance(requestOffset);
  f.capture.receive('teslamate/cars/1/charge_current_request', '6', {}, f.now); f.advance(1600);
  const native = { ...pilot(13, restoreAt), receivedAt };
  const state = updateTeslaCurrentRequest(null, f.capture.snapshot(), { now: f.now, nativeCurrent: native,
    control: { session: { sessionId: 'synthetic-session', connectedAt: START }, currentTest: {
      id: 'synthetic-current-test', connectedAt: START, sessionId: 'synthetic-session', phase,
      startedAt: START + 1000, confirmedAt: START + 3000, expiresAt: START + 91_000,
      originalCurrentA: 13, appliedCurrentA: 6, restoreCurrentA: 13, permissionAt: restoreAt, pending: null }, snapshot: { fields: {} } } });
  assert.equal(state.request.eligible, qualifies); assert.equal(state.limit?.value ?? null, qualifies ? 6 : null);
  f.restore(state); f.advance(); f.send('charge_current_request_max', 16);
  assert.equal(f.state.limit?.value ?? null, qualifies ? 6 : null, 'Later max-only publication cannot promote the ambiguous held6');
});

for (const delayed of [false, true]) test(`owned same-transaction OCPP stop ${delayed ? 'with newer physical evidence is unknown' : 'is reflected'} and cannot latch5`, () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10);
  const original = structuredClone(f.state.limit); f.advance(); f.send('charging_state', 'Stopped');
  f.setNativeCurrent({ value: 13, available: true, measuredAt: START, receivedAt: null });
  if (delayed) {
    f.capture.receive('teslamate/cars/1/charge_current_request', '5', {}, f.now); f.advance();
    f.setControl(ocppPause(f.now, f.now)); f.admit();
  } else { f.setControl(ocppPause(f.now)); f.send('charge_current_request', 5); }
  assert.equal(f.state.request.reflected, !delayed); assert.equal(f.state.request.eligible, false);
  assert.deepEqual(f.state.limit, original); f.advance(); f.send('charge_current_request_max', 5);
  f.advance(); f.send('charge_current_request_max', 16); assert.deepEqual(f.state.limit, original);
});

test('a foreign OCPP transaction or unowned zero cannot establish an application-stop reflection', () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.advance();
  const control = ocppPause(f.now); control.session.transactionId = 18; f.setControl(control);
  f.setNativeCurrent({ value: 13, available: true, measuredAt: START, receivedAt: null });
  f.send('charging_state', 'Stopped'); f.send('charge_current_request', 5);
  assert.equal(f.state.request.reflected, false); assert.equal(f.project().value, 5,
    'Suspended/zero alone cannot attribute a request to an application Stop');
});

test('a malformed new request preserves the original tighter constraint while its raw value is unknown', () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10);
  const original = structuredClone(f.state.limit); f.advance(); f.send('charge_current_request', 'invalid');
  assert.equal(f.state.request.value, null); assert.equal(f.state.request.eligible, false);
  assert.deepEqual(f.state.limit, original); assert.equal(f.project().value, 10); assert.equal(f.project().rawRequest.value, null);
});

test('delayed admission after a correlated stop readback cannot qualify the stopped 5 A report against old max13', () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10);
  const original = structuredClone(f.state.limit); f.advance();
  f.send('charging_state', 'Stopped');
  f.capture.receive('teslamate/cars/1/charge_current_request', '5', {}, f.now);
  f.advance();
  f.setControl({ session: { sessionId: 'synthetic-session', connectedAt: START }, pauseConfirmed: true,
    permissionCommand: { value: false, sessionId: 'synthetic-session', dispatchedAt: START, acceptedAt: START },
    snapshot: { fields: Object.fromEntries(Object.entries(stoppedFields)
      .map(([key, field]) => [key, { ...field, receivedAt: f.now }])) } });
  f.admit();
  assert.equal(f.state.request.reflected, true); assert.equal(f.state.request.eligible, false);
  assert.deepEqual(f.state.limit, original); f.advance(); f.send('charge_current_request_max', 16);
  assert.deepEqual(f.state.limit, original);
});

test('lost original pause-at-request evidence leaves an acknowledged-stop 5 A report unknown without erasing known10', () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10);
  const original = structuredClone(f.state.limit); f.advance(); f.send('charging_state', 'Stopped');
  f.capture.receive('teslamate/cars/1/charge_current_request', '5', {}, f.now); f.advance();
  f.setControl({ session: { sessionId: 'synthetic-session', connectedAt: START }, ownedPause: true, pauseConfirmed: true,
    permissionCommand: { value: false, sessionId: 'synthetic-session', acceptedAt: START },
    snapshot: { fields: Object.fromEntries(Object.entries(stoppedFields).map(([key, field]) => [key,
      { ...field, measuredAt: key === 'start_charging' ? START : f.now, receivedAt: f.now }])) } });
  f.admit(); assert.equal(f.state.request.reflected, false); assert.equal(f.state.request.eligible, false);
  assert.deepEqual(f.state.limit, original); f.advance(); f.send('charge_current_request_max', 16);
  assert.deepEqual(f.state.limit, original);
});

test('a later native readback confirms the original 6 A pilot without promoting its unchanged reflected request', () => {
  const f = fixture(); f.setPilot(6); f.send('charge_current_request_max', 13); f.advance();
  f.capture.receive('teslamate/cars/1/charge_current_request', '6', {}, f.now); f.advance();
  const snapshot = f.capture.snapshot(), native = { ...pilot(6, START), receivedAt: f.now };
  const state = updateTeslaCurrentRequest(null, snapshot, { now: f.now, nativeCurrent: native });
  assert.equal(state.request.reflected, true); assert.equal(state.request.eligible, false); assert.equal(state.limit, null);
  assert.equal(state.request.offered.measuredAt, START); assert.equal(state.request.offered.receivedAt, f.now);
  f.restore(state); f.advance(); f.send('charge_current_request_max', 16); assert.equal(f.state.limit, null);
});

test('health/reconnect admission withdraws availability without changing original request or qualification', () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10);
  const original = structuredClone(f.state); f.capture.setConnected(false); f.admit();
  assert.equal(f.project().available, false); assert.deepEqual(f.state, original);
  f.capture.setConnected(true); f.admit(); assert.equal(f.project().available, false);
  f.advance(); f.send('healthy', true); assert.equal(f.project().value, 10); assert.deepEqual(f.state, original);
  f.send('healthy', false); assert.equal(f.project().available, false); assert.deepEqual(f.state, original);
  assert.equal(f.project().value, null); assert.equal(f.project().knownLimitA, 10); assert.equal(f.project().lastKnownValue, 10);
});

for (const current of [10, 5, 0]) test(`the dormant qualified ${current} A constraint bounds planning while raw logger availability is false`, () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', current);
  const live = f.project(); f.advance(); f.send('healthy', false); const dormant = f.project();
  assert.equal(dormant.available, false); assert.equal(dormant.value, null); assert.equal(dormant.knownLimitA, current);
  const signal = value => ({ value, available: true });
  const charger = field => ({ id: 'charger2', requiredGridKwh: 6, deadlineAt: START + 3600_000,
    settings: { enabled: true }, capabilities: { scheduling: true, currentControl: true }, control: {}, telemetry: {},
    values: { connected: signal(true), charging: signal(false), maximumCurrentA: signal(16), currentA: signal(16),
      actualCurrentA: signal(0), voltageV: signal(230), minimumSoc: signal(80), vehicleCeilingSoc: signal(80),
      soc: signal(20), vehicleCurrentA: field } });
  const run = field => planChargers({ now: f.now, chargers: [charger(field)],
    prices: [{ start: START, end: START + 3600_000, priceCtPerKwh: 10 }], supply: { configuredBudgetCurrentA: [16,16,16] } });
  const active = run(live), retained = run(dormant);
  assert.equal(retained.plans.charger2.deliveredGridKwh, active.plans.charger2.deliveredGridKwh);
  assert.deepEqual(retained.allocations, active.allocations);
  if (current === 0) assert.equal(retained.plans.charger2.deliveredGridKwh, 0);
});

test('unchanged live and retained current repeats preserve the exact receipt, sequence and retained provenance', () => {
  const f = fixture(); f.send('charge_current_request_max', 13, { retain: true }); f.send('charge_current_request', 10, { retain: true });
  const original = structuredClone(f.capture.snapshot().fields), state = structuredClone(f.state);
  f.advance(); f.send('charge_current_request', 10); f.send('charge_current_request_max', 13);
  assert.deepEqual(f.capture.snapshot().fields.charge_current_request, original.charge_current_request);
  assert.deepEqual(f.capture.snapshot().fields.charge_current_request_max, original.charge_current_request_max);
  assert.deepEqual(f.state, state); assert.equal(f.project().retained, true);
});

test('future source clocks and a new feed or physical scope cannot inherit a qualification', () => {
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10);
  const snapshot = f.capture.snapshot(), previous = structuredClone(f.state);
  snapshot.fields.charge_current_request.receivedAt = f.now + 1;
  assert.deepEqual(updateTeslaCurrentRequest(previous, snapshot, { now: f.now }), previous);
  assert.equal(updateTeslaCurrentRequest(null, snapshot, { now: f.now }), null);
  const other = f.capture.snapshot(); other.association = 'synthetic-other-feed';
  other.fields.charge_current_request_max.receivedAt = f.now + 1;
  assert.equal(updateTeslaCurrentRequest(previous, other, { now: f.now }).limit, null);
  assert.equal(updateTeslaCurrentRequest(null, f.capture.snapshot(), { now: f.now + 1000,
    control: { session: { connectedAt: f.now + 1 } } }), null);
  const futureSupply = structuredClone(previous); futureSupply.limit.maximumReceivedAt = f.now + 1;
  const projected = teslamateVehicleTelemetry(f.capture.snapshot(), { now: f.now, currentRequest: futureSupply }).vehicleCurrentA;
  assert.equal(projected.available, false); assert.equal(projected.value, null); assert.equal(projected.reason, 'vehicle-evidence-stale');
});

test('the genuinely absent optional slot defaults to null while malformed or retired JSON shapes fail closed', () => {
  validateTeslaCurrentRequest(undefined); validateTeslaCurrentRequest(null);
  const f = fixture(); f.send('charge_current_request_max', 13); f.send('charge_current_request', 10);
  validateTeslaCurrentRequest(f.state);
  for (const value of [false, 0, '', [], {}, { ...f.state, version: 1 }, { ...f.state, currentA: 10 },
    { ...f.state, request: { ...f.state.request, measuredAt: START } }, { ...f.state, limit: { ...f.state.limit, value: 13 } }])
    assert.throws(() => validateTeslaCurrentRequest(value), /Unsupported saved Tesla current request/);
  const evidence = { scope: 'synthetic-equipment:1800000000000', chargingTimes: [], stoppedTimes: [], teslaCurrentRequest: f.state };
  const saved = { version: 7, chargers: { charger2: { association: 'synthetic-equipment', vehicleEvidence: evidence } } };
  validateChargingRuntimeState(saved); saved.chargers.charger2.vehicleEvidence.teslaCurrentRequest = { value: 10 };
  assert.throws(() => validateChargingRuntimeState(saved), /Unsupported saved Tesla current request/);
});
