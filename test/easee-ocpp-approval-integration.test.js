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

async function fixture(t) {
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  let now = START, remote = null, sequence = 0, admitted = true, authority = true;
  const calls = [], requests = [], states = new Map(), observations = new Map();
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
    set: value => states.set(key, structuredClone(value)) });
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
  const provider = createDeviceProviders({ connections, http, clock: () => now, canControl: () => true,
    streamFactory: null, ocppInstallation: installation, ocppState: stateFor('transactions'),
    ocppSetupState: stateFor('setup'), onOcppControlTransition: async () => {} });
  let ws, controller;
  t.after(async () => { await controller?.close(); ws?.terminate(); await provider.close(); http.close(); });
  await provider.reconcileOcpp();
  assert.equal(provider.localOcppStatus().controlTransport, 'ocpp');
  const adapter = provider.chargerScheduleControl();
  controller = adapter.createController({ clock: () => now, canControl: () => authority && admitted,
    hasAuthority: () => authority, saveState: stateFor('controller').set });
  ws = new WebSocket(`ws://127.0.0.1:${port}/ocpp/${CHARGER}`, 'ocpp1.6', {
    headers: { Authorization: `Basic ${Buffer.from(`${CHARGER}:${PASSWORD}`).toString('base64')}` },
  });
  const pending = new Map();
  ws.on('message', raw => {
    const frame = JSON.parse(raw);
    if (frame[0] === 2) {
      calls.push({ action: frame[2], payload: frame[3] });
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
  assert.deepEqual(remoteStarts()[0].payload, { connectorId: 1, idTag: f.installation.virtualTag });

  // Pending-approval telemetry can advance while the local start is in flight.
  // That source clock is not a new Stop and cannot revoke the issued permission.
  f.advance(1000); f.observe({ 96: 55 });
  await f.adapter.read({ forceAppRefresh: true });
  const authorized = await f.call('Authorize', { idTag: f.installation.virtualTag });
  assert.equal(authorized[2].idTagInfo.status, 'Accepted');
  const started = await f.call('StartTransaction', { connectorId: 1, idTag: f.installation.virtualTag,
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
