import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createDeviceProviders } from '../src/acquisition/devices.js';
import { createHttp } from '../src/acquisition/http.js';
import { ocppInstallation } from '../src/acquisition/easee-ocpp-setup.js';
import { CHARGING_OBSERVATION_IDS } from '../src/charging/easee.js';

const START = Date.parse('2026-01-15T12:00:00Z'), MINUTE = 60_000;
const CHARGER = 'synthetic-approval-charger', PASSWORD = 'synthetic-ocpp-pass';

async function fixture(t, { transactionState, controllerState, beforeTransactionSave, getIdentification, getStartRecoveryContext, getDeadlineRequest, getPlan, holdRemoteStart = false, homeFreeCharging = false } = {}) {
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  let now = START, remote = null, sequence = 0, admitted = true, authority = true;
  const calls = [], requests = [], states = new Map(), observations = new Map();
  if (transactionState) states.set('transactions', structuredClone(transactionState));
  if (controllerState) states.set('controller', structuredClone(controllerState));
  const observe = changes => {
    for (const [id, value] of Object.entries(changes)) observations.set(Number(id),
      { id: Number(id), value, timestamp: new Date(now).toISOString() });
  };
  observe(Object.fromEntries(CHARGING_OBSERVATION_IDS.map(id => [id, 16])));
  observe({ 31: true, 80: 344, 96: 55, 100: 'B', 109: 7, 120: 0, 141: 1, 250: true });
  const connections = { easee: { charger_id: CHARGER, access_token: 'synthetic-access-token', local_ocpp: {
    enabled: true, host: '127.0.0.1', port, server_url: `ws://192.0.2.10:${port}/ocpp`,
    password: PASSWORD, authorization_mode: 'plug-and-charge',
  } } };
  const stateFor = key => ({ get: () => structuredClone(states.get(key) ?? null),
    set: value => { if (key === 'transactions') beforeTransactionSave?.(value); states.set(key, structuredClone(value)); } });
  const http = createHttp({ allowOcppSetup: true, canControl: () => true,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname, method = options.method;
      requests.push({ path, method });
      if (path === `/state/${CHARGER}/observations`) return Response.json({ observations: [...observations.values()] });
      if (path === `/api/chargers/${CHARGER}/schedules` && method === 'GET') return Response.json({ enabled: 'none' });
      if (path === `/local-ocpp/v1/connection-details/${CHARGER}`) {
        if (method === 'GET') return remote ? Response.json(remote) : new Response(null, { status: 404 });
        assert.equal(method, 'POST');
        const body = JSON.parse(options.body);
        assert.ok(states.get('setup')?.intent, 'Native configuration must have a durable intent before dispatch');
        remote = { version: 'synthetic-setup-version', connectivityMode: body.connectivityMode,
          websocketConnectionArgs: { ...body.websocketConnectionArgs, url: `${body.websocketConnectionArgs.url}/${body.chargePointId}` },
          basicAuth: { username: body.chargePointId, password: body.basicAuthPassword } };
        return Response.json({ version: remote.version }, { status: 201 });
      }
      if (path === `/local-ocpp/v1/connections/chargers/${CHARGER}` && method === 'POST')
        return new Response(null, { status: 204 });
      assert.fail(`Unexpected synthetic provider request: ${method} ${path}`);
    } });
  const installation = ocppInstallation({ connections });
  const homeSettings = { FreeCharging: false, FreeChargingIdTag: installation.virtualTag };
  const homeReadOnly = {}, homeRejected = new Set();
  const homeTransactions = [];
  let homeReplyGate = null;
  const provider = createDeviceProviders({ connections, http, clock: () => now, canControl: () => true,
    streamFactory: null, ocppInstallation: installation, ocppState: stateFor('transactions'),
    ocppSetupState: stateFor('setup'), onOcppControlTransition: async () => {} });
  let ws, controller;
  t.after(async () => { await controller?.close(); ws?.terminate(); await provider.close(); http.close(); });
  await provider.reconcileOcpp();
  assert.equal(provider.localOcppStatus().controlTransport, 'ocpp');
  const adapter = provider.chargerScheduleControl();
  controller = adapter.createController({ clock: () => now, initialState: controllerState, canControl: () => authority && admitted,
    hasAuthority: () => authority, saveState: stateFor('controller').set, getIdentification, getStartRecoveryContext, getDeadlineRequest, getPlan });
  ws = new WebSocket(`ws://127.0.0.1:${port}/ocpp/${CHARGER}`, 'ocpp1.6', {
    headers: { Authorization: `Basic ${Buffer.from(`${CHARGER}:${PASSWORD}`).toString('base64')}` },
  });
  const pending = new Map(), pendingStarts = [];
  ws.on('message', async raw => {
    const frame = JSON.parse(raw);
    if (frame[0] === 2) {
      calls.push({ action: frame[2], payload: frame[3] });
      if (holdRemoteStart && frame[2] === 'RemoteStartTransaction') { pendingStarts.push(frame); return; }
      const key = frame[2] === 'GetConfiguration' ? frame[3].key?.[0] : frame[3].key;
      if (homeFreeCharging && Object.hasOwn(homeSettings, key)) {
        await homeReplyGate?.(frame);
        if (frame[2] === 'GetConfiguration') {
          ws.send(JSON.stringify([3, frame[1], { configurationKey: [{ key, value: String(homeSettings[key]), readonly: homeReadOnly[key] ?? false }] }]));
          return;
        }
        assert.equal(frame[2], 'ChangeConfiguration');
        if (homeRejected.has(key)) { ws.send(JSON.stringify([3, frame[1], { status: 'Rejected' }])); return; }
        assert.ok(states.get('transactions').automaticStartRecoveries.attempts.length,
          'The start context must be durable before native authorization writes');
        homeSettings[key] = key === 'FreeCharging' ? frame[3].value.toLowerCase() === 'true' : frame[3].value;
        ws.send(JSON.stringify([3, frame[1], { status: 'Accepted' }]));
        if (key === 'FreeCharging' && homeSettings.FreeCharging) {
          const reply = await call('StartTransaction', { connectorId: 1, idTag: homeSettings.FreeChargingIdTag,
            timestamp: new Date(now).toISOString(), meterStart: 0 });
          homeTransactions.push(reply);
          if (reply[2].idTagInfo.status === 'Accepted') {
            now += 1000;
            await status('Charging'); await meter(6900, reply[2].transactionId);
          }
        }
        return;
      }
      ws.send(JSON.stringify([3, frame[1], { status: 'Accepted' }]));
    } else { const resolve = pending.get(frame[1]); pending.delete(frame[1]); resolve?.(frame); }
  });
  await once(ws, 'open');
  const call = (action, payload) => new Promise((resolve, reject) => {
    const id = `synthetic-call-${++sequence}`;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Synthetic OCPP reply timeout')); }, 2000);
    pending.set(id, frame => { clearTimeout(timeout); resolve(frame); });
    ws.send(JSON.stringify([2, id, action, payload]));
  });
  const status = value => call('StatusNotification', { connectorId: 1, status: value,
    errorCode: 'NoError', timestamp: new Date(now).toISOString() });
  const meter = (powerW, transactionId) => call('MeterValues', { connectorId: 1,
    ...(transactionId === undefined ? {} : { transactionId }), meterValue: [{ timestamp: new Date(now).toISOString(),
      sampledValue: [{ measurand: 'Power.Active.Import', unit: 'W', value: String(powerW) }] }] });
  await call('BootNotification', { chargePointVendor: 'Synthetic vendor', chargePointModel: 'Synthetic charger' });
  await status('Preparing'); await meter(0);
  await adapter.read({ forceAppRefresh: true });
  return { provider, adapter, controller, calls, requests, installation, states, call, status, meter, observe,
    homeSettings, homeReadOnly, homeRejected, homeTransactions, homeGate(value) { homeReplyGate = value; },
    answerStart() { const frame = pendingStarts.shift(); assert(frame); ws.send(JSON.stringify([3, frame[1], { status: 'Accepted' }])); },
    admission(value) { admitted = value; }, authority(value) { authority = value; },
    get now() { return now; }, advance(ms) { now += ms; } };
}

test('committed input restores the original unexpired native Start lease without another reconcile', async t => {
  const f = await fixture(t), plan = { id: 'open', startAt: START, feasible: true, periods: [{ startAt: START, endAt: null }] };
  await f.controller.update({ enabled: true, plan });
  const authorize = async () => (await f.call('Authorize', { idTag: f.installation.virtualTag }))[2].idTagInfo.status;
  assert.equal(await authorize(), 'Accepted'); f.advance(1000);
  const read = f.adapter.read;
  f.adapter.read = async options => { const snapshot = await read(options); f.admission(false); return snapshot; };
  try {
    await f.controller.update({ enabled: true, plan });
    assert.equal(await authorize(), 'Blocked', 'Pending admission cannot authorize physical Start');
    f.admission(true);
    assert.equal(await authorize(), 'Accepted', 'The unchanged original lease remains usable after commit');
    f.advance(60_000);
    assert.equal(await authorize(), 'Blocked', 'Pending refresh cannot extend original expiry');
  } finally { f.admission(true); f.adapter.read = read; }
});

async function rejectedAutomaticStart(f, { reason = 'DeAuthorized', power = 0 } = {}) {
  const startAt = f.now + 30 * MINUTE;
  await f.controller.update({ enabled: true, plan: { startAt, feasible: true, periods: [{ startAt, endAt: null }] } });
  const reply = await f.call('StartTransaction', { connectorId: 1, idTag: f.installation.virtualTag,
    timestamp: new Date(f.now).toISOString(), meterStart: 0 });
  assert.equal(reply[2].idTagInfo.status, 'Blocked');
  await f.call('StopTransaction', { transactionId: reply[2].transactionId,
    timestamp: new Date(f.now).toISOString(), meterStop: 0, reason });
  f.advance(1000); await f.status('SuspendedEVSE'); await f.meter(power);
  return reply[2].transactionId;
}
const openPlan = f => ({ startAt: f.now, feasible: true, periods: [{ startAt: f.now, endAt: null }] });
const starts = f => f.calls.filter(row => row.action === 'RemoteStartTransaction');

test('Charge now restores native Home authorization after our refused Start without resetting the charger', async t => {
  const f = await fixture(t, { homeFreeCharging: true });
  await rejectedAutomaticStart(f);
  await f.controller.update({ enabled: true, plan: openPlan(f),
    chargeNow: { connectedAt: START, requestedAt: f.now } });
  await f.status('SuspendedEVSE');
  for (let n = 0; n < 16; n++) await f.call('Heartbeat', {});
  assert.equal(starts(f).length, 1);
  assert.equal(f.homeTransactions.length, 1,
    'An accepted RemoteStart alone cannot clear the native FreeCharging latch after deauthorization');
  assert.equal(f.homeTransactions[0][2].idTagInfo.status, 'Accepted');
  const control = await f.controller.update({ enabled: true, plan: openPlan(f) });
  assert.equal(control.snapshot.transactionConfirmed, true);
  assert.equal(f.adapter.normalize(control.snapshot, { now: f.now }).powerKw.value, 6.9);
  assert.equal(f.calls.some(row => ['Reset', 'ClearCache'].includes(row.action)), false);
  assert.equal(f.states.get('transactions').transactions[0].status, 'Blocked');
  const writes = f.calls.filter(row => row.action === 'ChangeConfiguration' && row.payload.key.startsWith('FreeCharging'));
  assert.deepEqual(writes.map(row => row.payload.key), ['FreeChargingIdTag', 'FreeCharging']);
  assert.equal(writes[0].payload.value, starts(f)[0].payload.idTag);
  assert.equal(f.provider.localOcppStatus().startProgress.recovery.status, 'confirmed');
  assert.equal(f.states.get('transactions').automaticStartRecoveries.attempts.length, 1);
  const before = f.calls.length;
  for (let n = 0; n < 4; n++) await f.call('Heartbeat', {});
  assert.equal(f.calls.slice(before).some(row => row.action === 'ChangeConfiguration'), false, 'Polling cannot repeat native recovery');
});

for (const boundary of ['pause', 'authority', 'native stop', 'disconnect', 'operation expiry', 'pending input'])
test(`native Home approval recovery preserves the ${boundary} boundary after its tag write`, async t => {
  const f = await fixture(t, { homeFreeCharging: true });
  await rejectedAutomaticStart(f);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let reads = 0;
  f.homeGate(async frame => {
    if (frame[2] === 'GetConfiguration' && frame[3].key[0] === 'FreeChargingIdTag' && ++reads === 2) {
      entered.resolve(); await release.promise;
    }
  });
  const input = { enabled: true, plan: openPlan(f), chargeNow: { connectedAt: START, requestedAt: f.now } };
  await f.controller.update(input); await f.status('SuspendedEVSE'); await entered.promise;
  const original = f.provider.localOcppStatus().startProgress.recovery.requestedAt;
  try {
    assert.equal(f.homeSettings.FreeCharging, false);
    if (boundary === 'pause') await f.controller.update({ sessionPause: { connectedAt: START, requestedAt: f.now } });
    else if (boundary === 'authority') { f.authority(false); await f.controller.update(input); }
    else if (boundary === 'native stop') { f.advance(1000); f.observe({ 96: 53 }); await f.adapter.read({ forceAppRefresh: true }); }
    else if (boundary === 'disconnect') await f.status('Available');
    else if (boundary === 'operation expiry') f.advance(15_000);
    else f.admission(false);
    release.resolve();
    for (let n = 0; n < 8; n++) await f.call('Heartbeat', {});
    assert.equal(f.calls.some(row => row.action === 'ChangeConfiguration' && row.payload.key === 'FreeCharging'), false,
      'An acknowledged private tag write supplies no permission to enable native charging');
    assert.equal(f.homeTransactions.length, 0);
    if (boundary === 'pending input') {
      f.admission(true);
      // The existing one-second maintenance turn owns queue progress after
      // admission; incoming heartbeats are not a synthetic scheduler pump.
      const deadline = performance.now() + 3000;
      while (!f.homeTransactions.length && performance.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(f.homeTransactions.length, 1, 'Admission can finish the original bounded operation without replaying a request');
      assert.equal(f.provider.localOcppStatus().startProgress.recovery.requestedAt, original);
      assert.equal(reads, 2, 'A deferred native readback is never sent again');
    }
    assert.equal(f.states.get('transactions').automaticStartRecoveries.attempts.length, 1);
  } finally { release.resolve(); }
});

test('native Home recovery recognizes our refused tag after a new connection replaces its attempt window', async t => {
  const f = await fixture(t, { homeFreeCharging: true });
  await f.controller.update({ enabled: true, plan: openPlan(f) }); await f.status('Preparing');
  for (let n = 0; n < 4; n++) await f.call('Heartbeat', {});
  assert.equal(starts(f).length, 1);
  const oldCode = starts(f)[0].payload.idTag;
  f.homeSettings.FreeChargingIdTag = oldCode;
  f.advance(1000); await f.status('Available'); await f.controller.update({ enabled: true, plan: openPlan(f) });
  f.advance(1000); await f.status('Preparing'); await f.meter(0);
  const future = { startAt: f.now + 30 * MINUTE, feasible: true,
    periods: [{ startAt: f.now + 30 * MINUTE, endAt: null }] };
  await f.controller.update({ enabled: true, plan: future });
  const refused = await f.call('StartTransaction', { connectorId: 1, idTag: oldCode,
    meterStart: 0, timestamp: new Date(f.now).toISOString() });
  assert.equal(refused[2].idTagInfo.status, 'Blocked');
  await f.call('StopTransaction', { transactionId: refused[2].transactionId, meterStop: 0,
    reason: 'DeAuthorized', timestamp: new Date(f.now).toISOString() });
  f.advance(1000); await f.status('SuspendedEVSE'); await f.meter(0);
  const connectedAt = f.controller.status().session.connectedAt;
  await f.controller.update({ enabled: true, plan: future, chargeNow: { connectedAt, requestedAt: f.now } });
  await f.status('SuspendedEVSE');
  for (let n = 0; n < 16; n++) await f.call('Heartbeat', {});
  assert.equal(starts(f).length, 2);
  assert.equal(f.homeTransactions.length, 1, 'The original refused transaction retains ownership proof for its exact tag');
  assert.equal(f.homeTransactions[0][2].idTagInfo.status, 'Accepted');
  assert.equal(f.states.get('transactions').automaticStartRecoveries.connectedAt, connectedAt);
  assert.equal(f.states.get('transactions').automaticStartRecoveries.attempts.length, 1);
});

test('receiver restart cannot replay a native Home recovery whose tag write already consumed its start context', async t => {
  const f = await fixture(t, { homeFreeCharging: true });
  await rejectedAutomaticStart(f);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let reads = 0;
  f.homeGate(async frame => {
    if (frame[2] === 'GetConfiguration' && frame[3].key[0] === 'FreeChargingIdTag' && ++reads === 2) {
      entered.resolve(); await release.promise;
    }
  });
  const chargeNow = { connectedAt: START, requestedAt: f.now };
  await f.controller.update({ enabled: true, plan: openPlan(f), chargeNow });
  await f.status('SuspendedEVSE'); await entered.promise;
  const saved = structuredClone(f.states.get('transactions')), controllerState = structuredClone(f.states.get('controller'));
  await f.controller.close(); release.resolve();
  const next = await fixture(t, { transactionState: saved, controllerState, homeFreeCharging: true });
  next.homeSettings.FreeChargingIdTag = f.homeSettings.FreeChargingIdTag;
  next.advance(1000); await next.status('SuspendedEVSE'); await next.meter(0);
  await next.controller.update({ enabled: true, plan: openPlan(next), chargeNow });
  for (let n = 0; n < 8; n++) await next.call('Heartbeat', {});
  assert.equal(starts(next).length, 0);
  assert.equal(next.calls.some(row => row.action === 'ChangeConfiguration' && row.payload.key.startsWith('FreeCharging')), false);
  assert.equal(next.homeTransactions.length, 0);
  assert.deepEqual(next.states.get('transactions').automaticStartRecoveries, saved.automaticStartRecoveries);
});

for (const restriction of ['unknown mode', 'foreign tag', 'read-only mode', 'read-only tag', 'refused tag', 'refused mode', 'tag readback mismatch'])
test(`native Home approval recovery preserves ${restriction} instead of overriding native evidence`, async t => {
  const f = await fixture(t, { homeFreeCharging: true });
  await rejectedAutomaticStart(f);
  if (restriction === 'unknown mode') f.homeSettings.FreeCharging = 'unknown';
  if (restriction === 'foreign tag') f.homeSettings.FreeChargingIdTag = 'synthetic-foreign';
  if (restriction === 'read-only mode') f.homeReadOnly.FreeCharging = true;
  if (restriction === 'read-only tag') f.homeReadOnly.FreeChargingIdTag = true;
  if (restriction === 'refused tag') f.homeRejected.add('FreeChargingIdTag');
  if (restriction === 'refused mode') f.homeRejected.add('FreeCharging');
  if (restriction === 'tag readback mismatch') {
    let reads = 0;
    f.homeGate(frame => {
      if (frame[2] === 'GetConfiguration' && frame[3].key[0] === 'FreeChargingIdTag' && ++reads === 2)
        f.homeSettings.FreeChargingIdTag = f.installation.virtualTag;
    });
  }
  await f.controller.update({ enabled: true, plan: openPlan(f), chargeNow: { connectedAt: START, requestedAt: f.now } });
  await f.status('SuspendedEVSE');
  for (let n = 0; n < 16; n++) await f.call('Heartbeat', {});
  assert.notEqual(f.homeSettings.FreeCharging, true, 'Unknown native mode cannot be treated as writable disabled mode');
  assert.equal(f.homeTransactions.length, 0);
  assert.equal(f.provider.localOcppStatus().startProgress.recovery.status, 'unavailable');
  assert.equal(starts(f).length, 1, 'Native refusal cannot rearm the consumed start context');
  if (restriction !== 'refused mode') assert.equal(f.calls.some(row => row.action === 'ChangeConfiguration' && row.payload.key === 'FreeCharging'), false);
  const diagnostics = JSON.stringify(f.provider.localOcppStatus());
  assert.equal(diagnostics.includes(f.installation.virtualTag), false);
  assert.equal(diagnostics.includes(starts(f)[0].payload.idTag), false);
});

test('passive retry readiness observes the actual native command queue until Start acknowledgement', async t => {
  const f = await fixture(t, { holdRemoteStart: true });
  await rejectedAutomaticStart(f);
  assert.equal(f.adapter.controlPending(), false, 'Read-only native queries do not own physical work');
  await f.controller.update({ enabled: true, plan: openPlan(f) });
  await f.status('SuspendedEVSE');
  assert.equal(starts(f).length, 1);
  assert.equal(f.adapter.controlPending(), true);
  f.answerStart(); await f.call('Heartbeat', {});
  assert.equal(f.adapter.controlPending(), false);
});

test('an explicit passive Identify retry gets one new refused-start attempt without overriding the economic period', async t => {
  let retry = null;
  const f = await fixture(t, { getStartRecoveryContext: () => retry });
  await rejectedAutomaticStart(f);
  await f.controller.update({ enabled: true, plan: openPlan(f) });
  await f.status('SuspendedEVSE');
  assert.equal(starts(f).length, 1);
  const prior = structuredClone(f.states.get('transactions').automaticStartRecoveries.attempts.at(-1));
  retry = { id: 'synthetic-explicit-identify', connectedAt: f.controller.status().session.connectedAt };
  f.advance(1000); await f.meter(0);
  const future = f.now + 30 * MINUTE;
  await f.controller.update({ enabled: true, plan: { startAt: future, feasible: true,
    periods: [{ startAt: future, endAt: null }] } });
  await f.status('SuspendedEVSE');
  assert.equal(starts(f).length, 1, 'Passive retry cannot grant charging outside the ordinary program');
  await f.controller.update({ enabled: true, plan: openPlan(f) });
  await f.status('SuspendedEVSE');
  assert.equal(starts(f).length, 2, 'Explicit retry has its own once-only recovery context');
  assert.notEqual(f.states.get('transactions').automaticStartRecoveries.attempts.at(-1).key, prior.key);
  await f.controller.update({ enabled: true, plan: openPlan(f) });
  await f.status('SuspendedEVSE');
  assert.equal(starts(f).length, 2, 'Routine refresh cannot repeat the explicit attempt');
  retry = null;
  assert.equal((await f.call('Authorize', { idTag: f.installation.virtualTag }))[2].idTagInfo.status, 'Blocked',
    'Ending the explicit context revokes its retained lease before another reconcile');
  f.advance(1000); await f.meter(0);
  await f.controller.update({ enabled: true, plan: openPlan(f) });
  await f.status('SuspendedEVSE');
  assert.equal(starts(f).length, 2, 'Ending the explicit attempt cannot rearm the consumed ordinary context');
  const restarted = await fixture(t, { transactionState: f.states.get('transactions'),
    controllerState: f.states.get('controller') });
  restarted.advance(5000); await restarted.status('SuspendedEVSE'); await restarted.meter(0);
  await restarted.controller.update({ enabled: true, plan: openPlan(restarted) });
  await restarted.status('SuspendedEVSE');
  assert.equal(starts(restarted).length, 0, 'Restart preserves every consumed context without replaying consent');
});

test('a refused automatic transaction recovers from fresh suspension once current permission returns', async t => {
  const f = await fixture(t);
  await rejectedAutomaticStart(f);
  assert.equal(starts(f).length, 0);
  await f.controller.update({ enabled: true, plan: openPlan(f) });
  await f.status('SuspendedEVSE');
  assert.equal(starts(f).length, 1);
  const saved = f.states.get('transactions');
  assert.equal(saved.automaticStartRecoveries.attempts.at(-1).at, f.now);
  f.advance(1000);
  const reply = await f.call('StartTransaction', { connectorId: 1, idTag: f.installation.virtualTag,
    timestamp: new Date(f.now).toISOString(), meterStart: 0 });
  assert.equal(reply[2].idTagInfo.status, 'Accepted');
  await f.status('Charging'); await f.meter(6900, reply[2].transactionId);
  const current = await f.controller.update({ enabled: true, plan: openPlan(f) });
  assert.equal(current.snapshot.transactionConfirmed, true);
  assert.equal(f.adapter.normalize(current.snapshot, { now: f.now }).powerKw.value, 6.9);
  assert.equal(f.requests.filter(row => row.method === 'POST' && row.path.startsWith('/api/')).length, 0);
});

test('ending Identify during durable reservation consumes the attempt without sending a late Start', async t => {
  let retry = null;
  const f = await fixture(t, { getStartRecoveryContext: () => retry,
    beforeTransactionSave: value => {
      if (value.automaticStartRecoveries?.attempts.length === 2) retry = null;
    } });
  await rejectedAutomaticStart(f);
  await f.controller.update({ enabled: true, plan: openPlan(f) });
  await f.status('SuspendedEVSE');
  assert.equal(starts(f).length, 1);
  const explicit = { id: 'synthetic-ending-identify', connectedAt: f.controller.status().session.connectedAt };
  retry = explicit;
  f.advance(1000); await f.meter(0);
  await f.controller.update({ enabled: true, plan: openPlan(f) });
  await f.status('SuspendedEVSE');
  assert.equal(f.states.get('transactions').automaticStartRecoveries.attempts.length, 2);
  assert.equal(starts(f).length, 1, 'Actual dispatch checks the still-current explicit context after persistence');
  retry = explicit;
  await f.controller.update({ enabled: true, plan: openPlan(f) });
  await f.status('SuspendedEVSE');
  assert.equal(starts(f).length, 1, 'An uncertain reserved attempt is never replayed');
});

test('full consumed-context storage fails closed without forgetting earlier attempts', async t => {
  const original = await fixture(t);
  await rejectedAutomaticStart(original);
  await original.controller.update({ enabled: true, plan: openPlan(original) });
  await original.status('SuspendedEVSE');
  const saved = structuredClone(original.states.get('transactions'));
  const history = saved.automaticStartRecoveries;
  while (history.attempts.length < 256) history.attempts.push({
    key: history.attempts.length.toString(16).padStart(64, '0'), at: history.attempts[0].at });
  const f = await fixture(t, { transactionState: saved, controllerState: original.states.get('controller'),
    getStartRecoveryContext: () => ({ id: 'synthetic-at-capacity', connectedAt: history.connectedAt }) });
  f.advance(5000); await f.status('SuspendedEVSE'); await f.meter(0);
  await f.controller.update({ enabled: true, plan: openPlan(f) });
  await f.status('SuspendedEVSE');
  assert.equal(starts(f).length, 0);
  assert.deepEqual(f.states.get('transactions').automaticStartRecoveries, history);
  assert.equal(f.provider.localOcppStatus().remoteStartStatus, 'recovery-capacity');
});

test('only a current explicit Identify context can add a refused-start attempt', async t => {
  for (const invalid of ['old physical session', 'future physical session', 'missing identity', 'oversized identity'])
    await t.test(invalid, async t => {
      let retry = null;
      const f = await fixture(t, { getStartRecoveryContext: () => retry });
      await rejectedAutomaticStart(f);
      await f.controller.update({ enabled: true, plan: openPlan(f) });
      await f.status('SuspendedEVSE');
      assert.equal(starts(f).length, 1);
      retry = { id: 'synthetic-explicit-retry', connectedAt: f.controller.status().session.connectedAt };
      if (invalid === 'old physical session') retry.connectedAt--;
      if (invalid === 'future physical session') retry.connectedAt++;
      if (invalid === 'missing identity') delete retry.id;
      if (invalid === 'oversized identity') retry.id = 'x'.repeat(129);
      f.advance(1000); await f.meter(0);
      await f.controller.update({ enabled: true, plan: openPlan(f) });
      await f.status('SuspendedEVSE');
      assert.equal(starts(f).length, 1);
      assert.equal(f.states.get('transactions').automaticStartRecoveries.attempts.length, 1);
    });
});

test('a confirmed newer physical session starts its own recovery history without removing transaction evidence', async t => {
  const f = await fixture(t); await rejectedAutomaticStart(f);
  await f.controller.update({ enabled: true, plan: openPlan(f) });
  await f.status('SuspendedEVSE');
  const original = structuredClone(f.states.get('transactions'));
  assert.equal(starts(f).length, 1);
  await f.status('Available');
  await f.controller.update({ enabled: true, plan: { startAt: f.now + 30 * MINUTE,
    feasible: true, periods: [{ startAt: f.now + 30 * MINUTE, endAt: null }] } });
  f.advance(1000); await f.status('Preparing'); await f.meter(0);
  await rejectedAutomaticStart(f);
  await f.controller.update({ enabled: true, plan: openPlan(f) });
  await f.status('SuspendedEVSE');
  assert.equal(starts(f).length, 2);
  const saved = f.states.get('transactions');
  assert(saved.automaticStartRecoveries.connectedAt > original.automaticStartRecoveries.connectedAt);
  assert.equal(saved.automaticStartRecoveries.attempts.length, 1);
  assert.deepEqual(saved.transactions[0], original.transactions[0]);
});

test('refused-start recovery preserves evidence, instruction and physical-connection fences', async t => {
  for (const boundary of ['external-stop', 'nonzero-power', 'stale-power', 'expired-permission', 'pause', 'authority', 'pending-input', 'new-connection'])
    await t.test(boundary, async t => {
      const f = await fixture(t);
      await rejectedAutomaticStart(f, { reason: boundary === 'external-stop' ? 'Local' : 'DeAuthorized',
        power: boundary === 'nonzero-power' ? 1000 : 0 });
      const input = { enabled: true, plan: openPlan(f) };
      if (boundary === 'stale-power') f.advance(61_000);
      if (boundary === 'pause') input.sessionPause = { connectedAt: START, requestedAt: f.now };
      if (boundary === 'authority') f.authority(false);
      if (boundary === 'new-connection') {
        await f.status('Available'); await f.controller.update(input);
        f.advance(1000); await f.status('Preparing'); await f.meter(0);
        await f.status('SuspendedEVSE');
      }
      await f.controller.update(input);
      if (boundary === 'expired-permission') { f.advance(61_000); await f.meter(0); }
      if (boundary === 'pending-input') f.admission(false);
      await f.status('SuspendedEVSE');
      assert.equal(starts(f).length, 0);
      if (boundary === 'pending-input') {
        f.admission(true); await f.status('SuspendedEVSE');
        assert.equal(starts(f).length, 1, 'Committing pending input restores the original unexpired permission');
      }
    });
});

test('an accepted transaction ending with DeAuthorized cannot supply refused-start recovery', async t => {
  const f = await fixture(t);
  await f.controller.update({ enabled: true, plan: openPlan(f) });
  const started = await f.call('StartTransaction', { connectorId: 1, idTag: f.installation.virtualTag,
    timestamp: new Date(f.now).toISOString(), meterStart: 0 });
  assert.equal(started[2].idTagInfo.status, 'Accepted');
  await f.call('StopTransaction', { transactionId: started[2].transactionId,
    timestamp: new Date(f.now).toISOString(), meterStop: 0, reason: 'DeAuthorized' });
  f.advance(1000); await f.status('SuspendedEVSE'); await f.meter(0);
  await f.controller.update({ enabled: true, plan: openPlan(f) }); await f.status('SuspendedEVSE');
  assert.equal(starts(f).length, 0);
  assert.equal(f.states.get('transactions').automaticStartRecoveries, null);
});

test('a second refused start cannot loop and the recovery budget survives receiver restart', async t => {
  const f = await fixture(t); await rejectedAutomaticStart(f);
  await f.controller.update({ enabled: true, plan: openPlan(f) }); await f.status('SuspendedEVSE');
  assert.equal(starts(f).length, 1);
  f.advance(1000); f.admission(false);
  const second = await f.call('StartTransaction', { connectorId: 1, idTag: f.installation.virtualTag,
    timestamp: new Date(f.now).toISOString(), meterStart: 0 });
  assert.equal(second[2].idTagInfo.status, 'Blocked');
  await f.call('StopTransaction', { transactionId: second[2].transactionId,
    timestamp: new Date(f.now).toISOString(), meterStop: 0, reason: 'DeAuthorized' });
  f.admission(true); await f.meter(0); await f.status('SuspendedEVSE');
  assert.equal(starts(f).length, 1);
  const restarted = await fixture(t, { transactionState: f.states.get('transactions'), controllerState: f.states.get('controller') });
  restarted.advance(3000); await restarted.status('SuspendedEVSE'); await restarted.meter(0);
  await restarted.controller.update({ enabled: true, plan: openPlan(restarted) });
  await restarted.status('SuspendedEVSE');
  assert.equal(starts(restarted).length, 0);
  restarted.advance(1000);
  await restarted.controller.update({ enabled: true, plan: openPlan(restarted),
    chargeNow: { connectedAt: START, requestedAt: restarted.now } });
  await restarted.status('SuspendedEVSE');
  assert.equal(starts(restarted).length, 1, 'A fresh explicit action has an independent bounded attempt');
});

test('refused-start recovery cannot dispatch before its durable attempt is saved', async t => {
  const f = await fixture(t, { beforeTransactionSave: value => {
    if (value.automaticStartRecoveries) throw new Error('Synthetic recovery storage failure');
  } });
  await rejectedAutomaticStart(f);
  await f.controller.update({ enabled: true, plan: openPlan(f) }); await f.status('SuspendedEVSE');
  assert.equal(starts(f).length, 0);
  assert.equal(f.provider.localOcppStatus().error, 'transaction-state-unavailable');
});

test('actual controller authority loss permanently revokes a retained Start lease', async t => {
  const f = await fixture(t), plan = { id: 'open', startAt: START, feasible: true, periods: [{ startAt: START, endAt: null }] };
  await f.controller.update({ enabled: true, plan });
  f.admission(false); f.authority(false); await f.controller.update({ enabled: true, plan });
  f.authority(true); f.admission(true);
  assert.equal((await f.call('Authorize', { idTag: f.installation.virtualTag }))[2].idTagInfo.status, 'Blocked');
});

test('pending native approval starts through the real OCPP transport only when the economic period opens', async t => {
  const f = await fixture(t), startAt = START + 30 * MINUTE;
  const plan = { id: 'synthetic-approval-plan', startAt, feasible: true, periods: [{ startAt, endAt: null }] };
  const remoteStarts = () => f.calls.filter(call => call.action === 'RemoteStartTransaction');
  const initial = await f.adapter.read();
  assert.equal(initial.appControl.authorizationBlocked, false);
  assert.equal(initial.appControl.controlKnown, true);
  assert.equal(initial.transactionId, null);

  const waiting = await f.controller.update({ enabled: true, plan });
  assert.equal(waiting.errorCode, 'transaction-unconfirmed');
  await f.status('Preparing'); await f.call('Heartbeat', {});
  assert.equal(remoteStarts().length, 0, 'A future economic period cannot grant an immediate remote start');
  const blocked = await f.call('Authorize', { idTag: f.installation.virtualTag });
  assert.equal(blocked[2].idTagInfo.status, 'Blocked', 'Virtual authorization also waits for the selected period');

  f.advance(30 * MINUTE);
  await f.status('Preparing'); await f.meter(0);
  await f.adapter.read({ forceAppRefresh: true });
  await f.controller.update({ enabled: true, plan });
  await f.status('Preparing'); await f.call('Heartbeat', {});
  assert.equal(remoteStarts().length, 1);
  assert.equal(remoteStarts()[0].payload.connectorId,1);
  const automaticCode=remoteStarts()[0].payload.idTag;
  assert.match(automaticCode,/^[a-f0-9]{20}$/);
  assert.notEqual(automaticCode,f.installation.virtualTag,'A previously refused cached tag is not reused');

  // Pending-approval telemetry can advance while the local start is in flight.
  // That source clock is not a new Stop and cannot revoke the issued permission.
  f.advance(1000); f.observe({ 96: 55 });
  await f.adapter.read({ forceAppRefresh: true });
  const authorized = await f.call('Authorize', { idTag: automaticCode });
  assert.equal(authorized[2].idTagInfo.status, 'Accepted');
  const started = await f.call('StartTransaction', { connectorId: 1, idTag: automaticCode,
    timestamp: new Date(f.now).toISOString(), meterStart: 0 });
  assert.equal(started[0], 3);
  assert.equal(started[2].idTagInfo.status, 'Accepted');
  assert.ok(Number.isSafeInteger(started[2].transactionId));
  await f.status('Charging'); await f.meter(6900, started[2].transactionId);

  const charging = await f.controller.update({ enabled: true, plan });
  assert.equal(charging.phase, 'released');
  assert.equal(charging.snapshot.transactionConfirmed, true);
  assert.equal(charging.snapshot.transactionId, started[2].transactionId);
  const measured = f.adapter.normalize(charging.snapshot, { now: f.now });
  assert.equal(measured.charging.value, true);
  assert.equal(measured.powerKw.value, 6.9);
  assert.equal(measured.powerKw.source, 'easee-ocpp');
  assert.equal(remoteStarts().length, 1, 'Confirmed transaction must not trigger another startup');
  assert.ok(f.states.get('transactions').transactions.some(row => row.id === started[2].transactionId && row.status === 'Accepted'));
  assert.equal(f.requests.filter(row => row.method === 'POST' && row.path.startsWith('/api/')).length, 0,
    'Local pending approval never sends a cloud Start, Resume, enablement or schedule command');
});

test('an unchanged controller refresh preserves native authorization while its read is in flight', async t => {
  const f = await fixture(t);
  const plan = { id: 'synthetic-open-plan', startAt: START, feasible: true,
    periods: [{ startAt: START, endAt: null }] };
  await f.controller.update({ enabled: true, plan });
  const first = await f.call('Authorize', { idTag: f.installation.virtualTag });
  assert.equal(first[2].idTagInfo.status, 'Accepted');
  const read = f.adapter.read;
  let release, entered;
  const reading = new Promise(resolve => { entered = resolve; });
  f.adapter.read = async options => {
    entered();
    await new Promise(resolve => { release = resolve; });
    return read(options);
  };
  const refresh = f.controller.update({ enabled: true, plan: { ...structuredClone(plan),
    costCents: 19, decisionCostCents: 20, assumptions: ['synthetic-new-forecast'], allocationTargetA: 12 } });
  await reading;
  try {
    const authorized = await f.call('Authorize', { idTag: f.installation.virtualTag });
    assert.equal(authorized[2].idTagInfo.status, 'Accepted', 'Polling cannot interrupt an already granted charging instruction');
    const started = await f.call('StartTransaction', { connectorId: 1, idTag: f.installation.virtualTag,
      timestamp: new Date(f.now).toISOString(), meterStart: 0 });
    assert.equal(started[2].idTagInfo.status, 'Accepted');
    assert.ok(Number.isSafeInteger(started[2].transactionId));
  } finally {
    f.adapter.read = read; release(); await refresh;
  }
});

for (const permission of ['probe', 'Charge now', 'Automatic off'])
test(`an economic plan refresh cannot interrupt ${permission} start permission`, async t => {
  const identification = { id: 'synthetic-independent-probe', connectedAt: START, phase: 'waiting', mode: 'probe',
    probeUntil: START + 2 * MINUTE, returnStartAt: START + 30 * MINUTE };
  const f = await fixture(t, { getIdentification: () => permission === 'probe' ? identification : null });
  const plan = { id: 'synthetic-future-plan', startAt: START + 30 * MINUTE, feasible: true,
    periods: [{ startAt: START + 30 * MINUTE, endAt: null }] };
  const input = { enabled: permission !== 'Automatic off', plan,
    ...(permission === 'Charge now' ? { chargeNow: { connectedAt: START, requestedAt: START } } : {}) };
  await f.controller.update(input);
  assert.equal((await f.call('Authorize', { idTag: f.installation.virtualTag }))[2].idTagInfo.status, 'Accepted');
  const read = f.adapter.read;
  let release, entered;
  const reading = new Promise(resolve => { entered = resolve; });
  f.adapter.read = async options => { entered(); await new Promise(resolve => { release = resolve; }); return read(options); };
  const refresh = f.controller.update({ ...input, plan: { ...plan, id: 'synthetic-refreshed-plan',
    startAt: START + 31 * MINUTE, periods: [{ startAt: START + 31 * MINUTE, endAt: null }] } });
  await reading;
  try {
    const started = await f.call('StartTransaction', { connectorId: 1, idTag: f.installation.virtualTag,
      timestamp: new Date(f.now).toISOString(), meterStart: 0 });
    assert.equal(started[2].idTagInfo.status, 'Accepted', 'an unrelated economic forecast cannot deny independent Start permission');
    if (permission === 'probe') assert.equal(f.controller.status().identification.probeUntil, identification.probeUntil,
      'the original probe deadline is unchanged');
  } finally { f.adapter.read = read; release(); await refresh; }
});

for (const boundary of ['pause', 'controls revision', 'replan', 'invalidate', 'expiry', 'disconnect', 'fault', 'authority', 'pending input'])
test(`an economic refresh during a probe retains the ${boundary} Start boundary`, async t => {
  const identification = { id: 'synthetic-fenced-probe', connectedAt: START, phase: 'waiting', mode: 'probe',
    probeUntil: START + 30_000, returnStartAt: START + 30 * MINUTE };
  const f = await fixture(t, { getIdentification: () => identification });
  const plan = { id: 'synthetic-future-plan', startAt: START + 30 * MINUTE, feasible: true,
    periods: [{ startAt: START + 30 * MINUTE, endAt: null }] };
  await f.controller.update({ enabled: true, plan });
  const authorize = async () => (await f.call('Authorize', { idTag: f.installation.virtualTag }))[2].idTagInfo.status;
  assert.equal(await authorize(), 'Accepted');
  const read = f.adapter.read;
  let release, entered, replacement;
  const reading = new Promise(resolve => { entered = resolve; });
  f.adapter.read = async options => { entered(); await new Promise(resolve => { release = resolve; }); return read(options); };
  const refresh = f.controller.update({ enabled: true, plan: { ...plan, id: 'synthetic-refreshed-plan',
    startAt: START + 31 * MINUTE, periods: [{ startAt: START + 31 * MINUTE, endAt: null }] } });
  await reading;
  try {
    assert.equal(await authorize(), 'Accepted');
    if (boundary === 'pause') replacement = f.controller.update({ sessionPause: { connectedAt: START, requestedAt: f.now } });
    else if (boundary === 'controls revision') replacement = f.controller.update({ controlsRevision: 1 });
    else if (boundary === 'replan') replacement = f.controller.update({ replan: true });
    else if (boundary === 'invalidate') f.controller.invalidate();
    else if (boundary === 'expiry') f.advance(30_000);
    else if (boundary === 'disconnect') await f.status('Available');
    else if (boundary === 'fault') await f.status('Faulted');
    else if (boundary === 'authority') f.authority(false);
    else f.admission(false);
    assert.equal(await authorize(), 'Blocked', 'economic independence cannot bypass a current Start restriction');
  } finally { f.adapter.read = read; release(); await refresh; await replacement; }
});

test('refreshing start permission retains its original expiry and immediate revocation boundaries', async t => {
  for (const boundary of ['disabled', 'replan', 'invalidate', 'expiry', 'disconnect']) await t.test(boundary, async t => {
    const f = await fixture(t);
    const plan = { id: 'synthetic-open-plan', startAt: START, feasible: true,
      periods: [{ startAt: START, endAt: null }] };
    await f.controller.update({ enabled: true, plan });
    const read = f.adapter.read;
    let release, entered, replacement;
    const reading = new Promise(resolve => { entered = resolve; });
    f.adapter.read = async options => {
      entered(); await new Promise(resolve => { release = resolve; }); return read(options);
    };
    const refresh = f.controller.update({ enabled: true, plan });
    await reading;
    try {
      assert.throws(() => f.controller.update({ resume: false }), /Unsupported charging control field/);
      assert.equal((await f.call('Authorize', { idTag: f.installation.virtualTag }))[2].idTagInfo.status, 'Accepted',
        'Rejecting an unsupported action cannot alter existing permission');
      if (boundary === 'disabled') replacement = f.controller.update({ enabled: false });
      else if (boundary === 'replan') replacement = f.controller.update({ replan: true,
        plan: { ...plan, startAt: START + MINUTE, periods: [{ startAt: START + MINUTE, endAt: null }] } });
      else if (boundary === 'invalidate') f.controller.invalidate();
      else if (boundary === 'expiry') f.advance(MINUTE);
      else await f.status('Available');
      assert.equal((await f.call('Authorize', { idTag: f.installation.virtualTag }))[2].idTagInfo.status, 'Blocked');
    } finally {
      f.adapter.read = read; release(); await refresh; await replacement;
    }
  });
});


test('native admission diagnostics follow real pending, grant and economic refusal without renewing evidence', async t => {
  const f = await fixture(t);
  const authorize = async () => (await f.call('Authorize', { idTag: f.installation.virtualTag }))[2].idTagInfo.status;
  f.admission(false);
  await f.controller.update({ enabled: true, plan: openPlan(f) });
  assert.deepEqual(f.provider.localOcppStatus().startAdmission,
    { checkedAt: f.now, allowed: false, reason: 'input-admission-pending' });
  assert.equal(await authorize(), 'Blocked');
  f.admission(true);
  await f.controller.update({ enabled: true, plan: openPlan(f) });
  assert.deepEqual(f.provider.localOcppStatus().startAdmission,
    { checkedAt: f.now, allowed: true, reason: 'controller-admitted' });
  assert.deepEqual(f.provider.localOcppStatus().startPermissionChange,
    { checkedAt: f.now, action: 'granted', reason: 'controller-admitted' });
  assert.equal(await authorize(), 'Accepted');
  const granted = f.provider.localOcppStatus();
  f.advance(1000);
  assert.deepEqual(f.provider.localOcppStatus().startAdmission, granted.startAdmission,
    'Reading the status does not create a newer controller decision');
  assert.deepEqual(f.provider.localOcppStatus().startPermissionChange, granted.startPermissionChange);
  const startAt = f.now + 30 * MINUTE;
  await f.controller.update({ enabled: true, plan: { startAt, feasible: true, periods: [{ startAt, endAt: null }] } });
  assert.deepEqual(f.provider.localOcppStatus().startAdmission,
    { checkedAt: f.now, allowed: false, reason: 'waiting-for-economic-period' });
  assert.deepEqual(f.provider.localOcppStatus().startPermissionChange,
    { checkedAt: f.now, action: 'revoked', reason: 'waiting-for-economic-period' });
  assert.equal(await authorize(), 'Blocked');
  f.controller.invalidate();
  assert.deepEqual(f.provider.localOcppStatus().startPermissionChange,
    { checkedAt: f.now, action: 'revoked', reason: 'controller-invalidated' });
  await f.controller.update({ enabled: true, plan: openPlan(f) });
  assert.equal(await authorize(), 'Accepted');
  f.advance(61_000);
  assert.equal(await authorize(), 'Blocked');
  const expired = f.provider.localOcppStatus().startPermissionChange;
  assert.deepEqual(expired, { checkedAt: f.now, action: 'revoked', reason: 'permission-expired' });
  f.advance(1000);
  assert.equal(await authorize(), 'Blocked');
  assert.deepEqual(f.provider.localOcppStatus().startPermissionChange, expired,
    'A later missing-lease check preserves the original expiry revocation evidence');
});

for (const previous of ['missing', 'older'])
test(`publishing the reviewed feasible plan preserves its in-flight Start when the input plan is ${previous}`, async t => {
  const plan = { id: 'synthetic-reviewed-plan', feasible: true, startAt: START,
    periods: [{ startAt: START, endAt: null }] };
  const request = { actionId: 'synthetic-initial-request', revision: 1, connectedAt: START, deadlineAt: START + 8 * 60 * MINUTE };
  const f = await fixture(t, { holdRemoteStart: true, getPlan: async () => plan, getDeadlineRequest: () => request });
  // Runtime supplies its previous published plan, then getPlan selects and
  // publishes the new plan inside this reconciliation before Start is sent.
  const previousPlan = previous === 'missing' ? null : { id: 'synthetic-old-plan', feasible: true,
    startAt: START + 30 * MINUTE, periods: [{ startAt: START + 30 * MINUTE, endAt: null }] };
  await f.controller.update({ enabled: true, plan: previousPlan });
  await f.status('Preparing');
  for (let n = 0; n < 4; n++) await f.call('Heartbeat', {});
  assert.equal(starts(f).length, 1);
  const code = starts(f)[0].payload.idTag;
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), read = f.adapter.read;
  f.adapter.read = async options => { entered.resolve(); await release.promise; return read(options); };
  f.advance(100);
  const refresh = f.controller.update({ enabled: true, plan: structuredClone(plan), deadlineRequest: request });
  await entered.promise;
  try {
    f.answerStart();
    await f.call('Heartbeat', {});
    const started = await f.call('StartTransaction', { connectorId: 1, idTag: code,
      meterStart: 0, timestamp: new Date(f.now).toISOString() });
    assert.equal(started[2].idTagInfo.status, 'Accepted',
      'Publishing the plan that already authorized this Start is not a changed instruction');
    await f.status('Charging');
    await f.meter(6900, started[2].transactionId);
    assert.equal(f.adapter.normalize(await read(), { now: f.now }).powerKw.value, 6.9);
    assert.equal(starts(f).length, 1, 'The original Start succeeds without retrying its consumed context');
  } finally { release.resolve(); await refresh; f.adapter.read = read; }
});

for (const boundary of ['future period', 'period end', 'plan identity', 'pause', 'controls revision', 'deadline', 'request revision',
  'replan', 'invalidate', 'expiry', 'disconnect', 'fault', 'native stop', 'authority', 'pending input'])
test(`publishing the reviewed feasible plan retains the ${boundary} Start boundary`, async t => {
  const plan = { id: 'synthetic-reviewed-plan', feasible: true, startAt: START,
    periods: [{ startAt: START, endAt: null }] };
  const request = { actionId: 'synthetic-initial-request', revision: 1, connectedAt: START, deadlineAt: START + 8 * 60 * MINUTE };
  const f = await fixture(t, { holdRemoteStart: true, getPlan: async () => plan, getDeadlineRequest: () => request });
  await f.controller.update({ enabled: true, plan: null });
  await f.status('Preparing');
  for (let n = 0; n < 4; n++) await f.call('Heartbeat', {});
  assert.equal(starts(f).length, 1);
  const code = starts(f)[0].payload.idTag;
  const authorize = async () => (await f.call('Authorize', { idTag: code }))[2].idTagInfo.status;
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), read = f.adapter.read;
  f.adapter.read = async options => { entered.resolve(); await release.promise; return read(options); };
  f.advance(100);
  const refresh = f.controller.update({ enabled: true, plan: structuredClone(plan), deadlineRequest: request });
  await entered.promise;
  let replacement;
  try {
    assert.equal(await authorize(), 'Accepted');
    if (boundary === 'future period') replacement = f.controller.update({ plan: { ...plan,
      startAt: START + 30 * MINUTE, periods: [{ startAt: START + 30 * MINUTE, endAt: null }] } });
    else if (boundary === 'period end') replacement = f.controller.update({ plan: { ...plan,
      periods: [{ startAt: START, endAt: START + MINUTE }] } });
    else if (boundary === 'plan identity') replacement = f.controller.update({ plan: { ...plan, id: 'synthetic-other-plan' } });
    else if (boundary === 'pause') replacement = f.controller.update({ sessionPause: { connectedAt: START, requestedAt: f.now } });
    else if (boundary === 'controls revision') replacement = f.controller.update({ controlsRevision: 1 });
    else if (boundary === 'deadline') replacement = f.controller.update({ readyBy: '07:00' });
    else if (boundary === 'request revision') {
      request.revision++; request.deadlineAt += 60 * MINUTE;
      replacement = f.controller.update({ deadlineRequest: request });
    }
    else if (boundary === 'replan') replacement = f.controller.update({ replan: true });
    else if (boundary === 'invalidate') f.controller.invalidate();
    else if (boundary === 'expiry') f.advance(MINUTE);
    else if (boundary === 'disconnect') await f.status('Available');
    else if (boundary === 'fault') await f.status('Faulted');
    else if (boundary === 'native stop') { f.advance(1000); f.observe({ 96: 53 }); await read({ forceAppRefresh: true }); }
    else if (boundary === 'authority') f.authority(false);
    else f.admission(false);
    assert.equal(await authorize(), 'Blocked', 'Retaining reviewed-plan permission cannot bypass a newer restriction');
    assert.equal(starts(f).length, 1, 'No restriction can mint another automatic attempt');
  } finally { release.resolve(); await refresh; await replacement; f.adapter.read = read; }
});

test('Charge now after a refused automatic Start uses a new context and survives economic plan publication', async t => {
  const f = await fixture(t, { holdRemoteStart: true });
  await f.controller.update({ enabled: true, plan: openPlan(f) });
  await f.status('Preparing');
  for (let n = 0; n < 4; n++) await f.call('Heartbeat', {});
  assert.equal(starts(f).length, 1);
  const originalCode = starts(f)[0].payload.idTag;
  const future = { id: 'synthetic-future-plan', feasible: true, startAt: START + 30 * MINUTE,
    periods: [{ startAt: START + 30 * MINUTE, endAt: null }] };
  await f.controller.update({ enabled: true, plan: future });
  f.answerStart();
  const refused = await f.call('StartTransaction', { connectorId: 1, idTag: originalCode,
    meterStart: 0, timestamp: new Date(f.now).toISOString() });
  assert.equal(refused[2].idTagInfo.status, 'Blocked');
  await f.call('StopTransaction', { transactionId: refused[2].transactionId, meterStop: 0,
    reason: 'DeAuthorized', timestamp: new Date(f.now).toISOString() });
  f.advance(1000); await f.status('SuspendedEVSE'); await f.meter(0);
  await f.controller.update({ enabled: true, plan: future });
  await f.status('SuspendedEVSE');
  assert.equal(starts(f).length, 1, 'Polling cannot repeat the consumed automatic attempt');

  await f.controller.update({ chargeNow: { connectedAt: START, requestedAt: f.now } });
  await f.status('SuspendedEVSE');
  assert.equal(starts(f).length, 2);
  const immediateCode = starts(f)[1].payload.idTag;
  assert.notEqual(immediateCode, originalCode);
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), read = f.adapter.read;
  f.adapter.read = async options => { entered.resolve(); await release.promise; return read(options); };
  const refresh = f.controller.update({ plan: { ...future, id: 'synthetic-refreshed-future-plan' } });
  await entered.promise;
  try {
    f.answerStart();
    const started = await f.call('StartTransaction', { connectorId: 1, idTag: immediateCode,
      meterStart: 0, timestamp: new Date(f.now).toISOString() });
    assert.equal(started[2].idTagInfo.status, 'Accepted');
    f.advance(1000);
    await f.status('Charging'); await f.meter(6900, started[2].transactionId);
    assert.equal(f.adapter.normalize(await read(), { now: f.now }).powerKw.value, 6.9);
    assert.equal(f.states.get('transactions').transactions[0].status, 'Blocked', 'The original refusal remains evidence');
    assert.equal(f.states.get('transactions').automaticStartRecoveries.attempts.length, 2);
    assert.equal(starts(f).length, 2, 'Only the explicit Charge now action adds an attempt');
  } finally { release.resolve(); await refresh; f.adapter.read = read; }
});

test('publishing a moving immediate fallback cannot withdraw the reviewed Start while native transaction admission is pending', async t => {
  let f,selectedPlan=null;const fallback=()=>({id:'fallback-'+f.now,provisional:true,feasible:false,startAt:f.now,periods:[{startAt:f.now,endAt:null}]});
  f=await fixture(t,{holdRemoteStart:true,getPlan:async()=>selectedPlan??fallback()});
  await f.controller.update({enabled:true,plan:null});await f.status('Preparing');for(let n=0;n<4;n++)await f.call('Heartbeat',{});
  assert.equal(starts(f).length,1,JSON.stringify({admission:f.provider.localOcppStatus().startAdmission,readiness:f.provider.localOcppStatus().startReadiness,phase:f.controller.status().phase,error:f.controller.status().errorCode}));
  const code=starts(f)[0].payload.idTag,entered=Promise.withResolvers(),release=Promise.withResolvers(),read=f.adapter.read;
  f.adapter.read=async options=>{entered.resolve();await release.promise;return read(options);};
  f.advance(400);const refresh=f.controller.update({enabled:true,plan:fallback()});await entered.promise;
  try{f.answerStart();await f.call('Heartbeat',{});const reply=await f.call('StartTransaction',{connectorId:1,idTag:code,meterStart:0,timestamp:new Date(f.now).toISOString()});assert.equal(reply[2].idTagInfo.status,'Accepted','Routine publication of the same immediate Normal release is not contrary instruction');}
  finally{release.resolve();await refresh;f.adapter.read=read;}
  const future=f.now+30*MINUTE;selectedPlan={id:'future',feasible:true,startAt:future,periods:[{startAt:future,endAt:null}]};await f.controller.update({enabled:true,plan:selectedPlan});
  assert.equal((await f.call('Authorize',{idTag:code}))[2].idTagInfo.status,'Blocked','A real future-period instruction still withdraws startup permission');
});
