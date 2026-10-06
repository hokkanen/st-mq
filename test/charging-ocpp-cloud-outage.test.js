import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createOcppScheduleAdapter, initialOcppControllerState } from '../src/charging/ocpp.js';
import { createDeviceProviders } from '../src/acquisition/devices.js';
import { createHttp } from '../src/acquisition/http.js';
import { ocppInstallation } from '../src/acquisition/easee-ocpp-setup.js';
import { CHARGING_OBSERVATION_IDS } from '../src/charging/easee.js';

const START = Date.parse('2026-10-06T09:00:00Z'), MINUTE = 60_000, SCOPE = 'd'.repeat(64);
const plan = startAt => ({ id: 'synthetic-local-plan', feasible: true, startAt,
  periods: [{ startAt, endAt: null }] });
const noSchedule = () => ({ enabled: 'none', delayed: null, daily: null, weekly: null, offPeak: null, tariff: null });
const cloud = (at, changes = {}) => ({ readAt: at, enabled: true, enabledAt: at,
  stopped: false, stopAt: at, controlKnown: true, faulted: false, authorizationBlocked: false,
  schedule: noSchedule(), ...changes });

function fixture(t, { initialState = null, initialApp = null } = {}) {
  let now = START, app = initialApp, authority = true, permission = null, stored = initialState;
  let online = true, connected = true, connectorStatus = 'Preparing', statusAt = START;
  let transactionId = null, transactionStartedAt = null, connectionId = 'synthetic-local-socket';
  let identification = null, nativeStop = null, controller;
  const profiles = new Map(), calls = [], nativeTakeovers = [], reads = [];
  const isPaused = () => [...profiles.values()].some(value => value.transactionId === transactionId
    && Date.parse(value.validTo) > now);
  const snapshot = () => ({ transport: 'ocpp', scope: SCOPE, connectionId, readAt: now, online,
    connectorStatus: transactionId && isPaused() ? 'SuspendedEVSE' : connectorStatus, statusAt,
    transactionId, transactionStartedAt, transactionConfirmed: transactionId !== null,
    pluggedIn: connected, powerKw: transactionId && !isPaused() ? 7 : 0, powerAt: now,
    appControl: structuredClone(app), nativeStop: structuredClone(nativeStop) });
  const adapter = createOcppScheduleAdapter({ scope: SCOPE, clock: () => now,
    canControl: () => authority,
    readSnapshot: async options => { reads.push(options); return snapshot(); },
    isCurrent: value => online && value.connectionId === connectionId && value.transactionId === transactionId,
    setStartPermission: (value, options) => { permission = value ? { snapshot: structuredClone(value), ...options } : null; },
    takeoverNative: async options => {
      assert.equal(options.canMutate(), true);
      await options.beforeWrite();
      nativeTakeovers.push(structuredClone(options.expectedAppControl));
      // A successful local operation does not invent a cloud observation.
      app = null;
      return null;
    },
    request: async (action, payload, options) => {
      assert.equal(options.guard(), true);
      assert.equal(options.beforeSend?.() ?? true, true);
      calls.push({ action, payload: structuredClone(payload) });
      if (action === 'SetChargingProfile') {
        assert.equal(payload.csChargingProfiles.transactionId, transactionId);
        profiles.set(payload.csChargingProfiles.chargingProfileId, structuredClone(payload.csChargingProfiles));
        return { status: 'Accepted' };
      }
      if (action === 'ClearChargingProfile') return { status: profiles.delete(payload.id) ? 'Accepted' : 'Unknown' };
      assert.equal(action, 'GetCompositeSchedule');
      const expiry = Math.max(0, ...[...profiles.values()].map(value => Date.parse(value.validTo)));
      return { status: 'Accepted', connectorId: 1, scheduleStart: new Date(now).toISOString(),
        chargingSchedule: { chargingRateUnit: 'A', duration: payload.duration,
          chargingSchedulePeriod: [{ startPeriod: 0, limit: isPaused() ? 0 : 16 },
            ...(expiry > now && expiry < now + payload.duration * 1000
              ? [{ startPeriod: (expiry - now) / 1000, limit: 16 }] : [])] } };
    } });
  const create = () => {
    controller = adapter.createController({ initialState: stored, clock: () => now, canControl: () => authority,
      getIdentification: () => identification, saveState: value => { stored = structuredClone(value); } });
  };
  create(); t.after(() => controller.close());
  return { adapter, calls, nativeTakeovers, profiles, reads,
    get controller() { return controller; }, get now() { return now; }, get stored() { return stored; },
    get permission() { return permission; },
    get startAllowed() { return Boolean(permission && permission.until > now && permission.guard()); },
    update: options => controller.update({ enabled: true, plan: plan(now), ...options }),
    app(value) { app = value; }, identify(value) { identification = value; },
    nativeStop(value) { nativeStop = value; },
    advance(ms) { now += ms; statusAt = now; }, authority(value) { authority = value; },
    online(value) { online = value; }, connected(value) { connected = value; },
    status(value, at = now) { connectorStatus = value; statusAt = at; },
    transaction(value = 7) { transactionId = value; transactionStartedAt = now; connectorStatus = 'Charging'; statusAt = now; },
    endTransaction(reason, at = now) { nativeStop = { transactionId, at, receivedAt: now, reason };
      transactionId = transactionStartedAt = null; connectorStatus = 'Preparing'; statusAt = now; },
    disconnect() { connected = false; connectorStatus = 'Available'; statusAt = now; transactionId = transactionStartedAt = null; },
    reconnect() { connected = true; connectorStatus = 'Preparing'; statusAt = now; },
    async restart() { await controller.close(); assert.equal(permission, null); connectionId += '-restart'; create(); },
  };
}

for (const [label, app] of [
  ['missing cloud data', null],
  ['unknown cloud control and schedule', cloud(START, { enabled: null, enabledAt: null, stopAt: null,
    controlKnown: false, schedule: null })],
  ['missing schedule with known enabled state', cloud(START, { schedule: null })],
  ['expired cloud readback', cloud(START - 2 * MINUTE)],
]) test(`local new-connection approval works with ${label} without inventing cloud evidence`, async t => {
  const f = fixture(t, { initialApp: app });
  const view = await f.update();
  assert.equal(f.startAllowed, true);
  assert.equal(view.session.transactionId, null, 'Local startup permission precedes transaction confirmation');
  assert.equal(view.automaticTakeover, null);
  assert.deepEqual(view.snapshot.appControl, app, 'The original unknown state and source clocks must survive');
  assert.equal(f.nativeTakeovers.length, 0, 'Missing information alone does not request native clearing');
});

test('cloud outage does not open a future price period but local time reaching that period does', async t => {
  const f = fixture(t), startAt = START + 30 * MINUTE;
  await f.update({ plan: plan(startAt) });
  assert.equal(f.startAllowed, false);
  assert.equal(f.calls.length, 0, 'No transaction-specific profile is invented before a transaction');
  f.advance(30 * MINUTE);
  await f.update({ plan: plan(startAt) });
  assert.equal(f.startAllowed, true);
});

test('Charge now works without cloud when Automatic is off and remains scoped to this connection', async t => {
  const f = fixture(t);
  const first = await f.update({ enabled: false, plan: plan(START + 30 * MINUTE) });
  await f.update({ enabled: false, plan: plan(START + 30 * MINUTE), chargeNow: { connectedAt: first.session.connectedAt } });
  assert.equal(f.startAllowed, true);
  f.advance(1000); f.disconnect(); await f.update({ enabled: false });
  f.advance(1000); f.reconnect();
  await f.update({ enabled: true, plan: plan(START + 30 * MINUTE), chargeNow: { connectedAt: first.session.connectedAt } });
  assert.equal(f.startAllowed, false, 'The old Charge now choice cannot authorize the new physical connection');
});

test('a cloud-independent identification probe grants only its original bounded startup window', async t => {
  const f = fixture(t), returnStartAt = START + 30 * MINUTE, probeUntil = START + 35_000;
  await f.update({ plan: plan(returnStartAt) });
  f.identify({ id: 'synthetic-local-identification', connectedAt: START, phase: 'waiting',
    mode: 'probe', probeUntil, returnStartAt });
  await f.update({ plan: plan(returnStartAt) });
  assert.equal(f.startAllowed, true);
  assert.equal(f.permission.until, probeUntil);
  f.advance(1000); await f.restart(); await f.update({ plan: plan(returnStartAt) });
  assert.equal(f.startAllowed, true);
  assert.equal(f.permission.until, probeUntil, 'Restart cannot renew a physical identification allowance');
  f.advance(probeUntil - f.now); await f.update({ plan: plan(returnStartAt) });
  assert.equal(f.startAllowed, false);
});

test('a positively observed later Stop remains authoritative through cloud loss and restart', async t => {
  const f = fixture(t, { initialApp: cloud(START) });
  await f.update(); assert.equal(f.startAllowed, true);
  f.advance(1000); f.app(cloud(f.now, { enabled: false, stopped: true }));
  const stopped = await f.update();
  assert.equal(stopped.manual?.kind, 'stop'); assert.equal(f.startAllowed, false);
  const witness = structuredClone(stopped.manual);
  f.app(null); f.advance(2 * MINUTE);
  await f.update(); assert.equal(f.startAllowed, false);
  await f.restart();
  const restored = await f.update({ chargeNow: { connectedAt: stopped.session.connectedAt } });
  assert.equal(f.startAllowed, false, 'Charge now cannot erase an observed later Stop');
  assert.deepEqual(restored.manual, witness);
  assert.equal(restored.snapshot.appControl, null);
});

test('an OCPP Remote stop with no cloud evidence prevents restart until explicit Use automatic', async t => {
  const f = fixture(t);
  f.transaction(); await f.update(); assert.equal(f.startAllowed, true);
  f.advance(1000); f.endTransaction('Remote');
  const stopped = await f.update();
  assert.equal(stopped.manual?.kind, 'stop');
  assert.equal(f.startAllowed, false);
  assert.equal(stopped.snapshot.appControl, null);
  const witness = structuredClone(stopped.manual);
  f.advance(1000); f.nativeStop(null); await f.restart();
  const restored = await f.update({ chargeNow: { connectedAt: stopped.session.connectedAt } });
  assert.equal(f.startAllowed, false, 'Losing the local observation after restart does not erase the saved instruction');
  assert.deepEqual(restored.manual, witness);
  const resumed = await f.update({ takeover: restored.takeover.token });
  assert.equal(resumed.takeover.state, 'confirmed');
  assert.equal(resumed.manual, null);
  assert.equal(f.startAllowed, true);
});

test('first-read OCPP deauthorization after plug-in blocks automatic takeover while suspension alone does not', async t => {
  const suspended = fixture(t);
  suspended.status('SuspendedEVSE');
  const unknown = await suspended.update();
  assert.equal(unknown.manual, null);
  assert.equal(suspended.startAllowed, true, 'A suspended status cannot identify an external Stop');
  const stopped = fixture(t);
  stopped.advance(2000); stopped.status('Preparing', START);
  stopped.nativeStop({ transactionId: 7, at: START + 1000, receivedAt: stopped.now, reason: 'DeAuthorized' });
  const view = await stopped.update();
  assert.equal(view.session.connectedAt, START);
  assert.equal(view.manual?.kind, 'stop');
  assert.equal(stopped.startAllowed, false);
  assert.equal(stopped.nativeTakeovers.length, 0, 'The first read cannot supersede an instruction sourced after physical plug-in');
});

test('a confirmed new plug supersedes a previous connection OCPP Local stop', async t => {
  const f = fixture(t);
  f.transaction(); await f.update();
  f.advance(1000); f.endTransaction('Local');
  await f.update(); assert.equal(f.startAllowed, false);
  f.advance(1000); f.disconnect(); await f.update();
  f.advance(1000); f.reconnect();
  const next = await f.update();
  assert.equal(next.manual, null);
  assert.equal(f.startAllowed, true);
  assert.equal(next.snapshot.nativeStop.reason, 'Local', 'The old observation stays historical evidence for its own connection');
});

test('an OCPP Stop received after explicit takeover within the same source second retains priority', async t => {
  const f = fixture(t);
  f.transaction(); await f.update();
  f.advance(200);
  const before = await f.update();
  await f.update({ takeover: before.takeover.token });
  assert.equal(f.startAllowed, true);
  assert.equal(f.stored.nativeTakeoverAt, START + 200);
  f.advance(400); f.endTransaction('Remote', START);
  const stopped = await f.update();
  assert.equal(stopped.manual?.kind, 'stop');
  assert.equal(f.startAllowed, false);
  assert.equal(stopped.snapshot.nativeStop.at, START, 'The charger source timestamp keeps its original second precision');
  assert.equal(stopped.snapshot.nativeStop.receivedAt, START + 600);
});

test('a retry of an OCPP Stop received before takeover does not acquire a new receipt after restart', async t => {
  const f = fixture(t);
  f.transaction(); await f.update();
  f.advance(100); f.endTransaction('Remote', START);
  const stopped = await f.update();
  assert.equal(f.startAllowed, false);
  const original = structuredClone(stopped.snapshot.nativeStop);
  f.advance(100);
  const before = await f.update();
  await f.update({ takeover: before.takeover.token });
  assert.equal(f.startAllowed, true);
  f.advance(400); await f.restart(); f.nativeStop(original);
  const retry = await f.update();
  assert.equal(f.startAllowed, true);
  assert.equal(retry.manual, null);
  assert.deepEqual(retry.snapshot.nativeStop, original, 'Retry receipt does not change the admitted first-receipt evidence');
});

test('a delayed Stop from the previous transaction cannot claim a new physical connection in the same second', async t => {
  const f = fixture(t);
  f.transaction(); await f.update();
  f.advance(100); f.disconnect(); await f.update();
  f.advance(100); f.reconnect(); await f.update();
  const connectedAt = f.stored.session.connectedAt;
  assert.equal(connectedAt, START + 200);
  f.advance(400);
  f.nativeStop({ transactionId: 7, at: START, receivedAt: f.now, reason: 'Remote' });
  const next = await f.update();
  assert.equal(next.session.connectedAt, connectedAt);
  assert.equal(next.session.transactionId, null);
  assert.equal(next.manual, null);
  assert.equal(f.startAllowed, true, 'Receipt ordering cannot reassign an old transaction Stop to a new connection');
});

for (const [label, sourceOffset, elapsed, accepted] of [
  ['a 400 ms ahead source after its time arrives', 400, 400, true],
  ['a source time that has not arrived', 400, 0, false],
  ['a source over one second ahead of its original receipt', 1001, 1001, false],
]) test(`local Stop validation ${accepted ? 'accepts' : 'rejects'} ${label}`, async t => {
  const f = fixture(t);
  f.transaction(); await f.update();
  f.advance(elapsed);
  const stop = { transactionId: 7, at: START + sourceOffset, receivedAt: START, reason: 'Remote' };
  f.nativeStop(stop);
  const view = await f.update();
  if (accepted) {
    assert.notEqual(view.errorCode, 'read-failed');
    assert.deepEqual(view.snapshot.nativeStop, stop, 'Waiting for source time does not renew the original receipt');
    assert.equal(view.manual?.kind, 'stop');
  } else assert.equal(view.errorCode, 'read-failed');
  assert.equal(f.startAllowed, false);
});

test('cloud recovery establishes an old normal baseline without inventing an external instruction', async t => {
  const f = fixture(t);
  await f.update(); assert.equal(f.startAllowed, true);
  f.advance(2 * MINUTE);
  f.app(cloud(f.now, { enabledAt: START - MINUTE, stopAt: START - MINUTE }));
  const recovered = await f.update();
  assert.equal(recovered.manual, null);
  assert.equal(f.startAllowed, true);
  assert.equal(recovered.appControl.enabledAt, START - MINUTE, 'Receiving old evidence does not renew its source clock');
  f.advance(1000);
  f.app(cloud(f.now, { stopped: true }));
  const laterStop = await f.update();
  assert.equal(laterStop.manual?.kind, 'stop');
  assert.equal(f.startAllowed, false, 'A newly observed instruction after the recovered baseline retains priority');
});

test('a locally confirmed takeover does not need cloud readback and fences replay of its old Stop after restart', async t => {
  const oldStop = cloud(START, { enabled: false, stopped: true,
    enabledAt: START - MINUTE, stopAt: START - MINUTE });
  const f = fixture(t, { initialApp: oldStop });
  const taken = await f.update();
  assert.equal(f.nativeTakeovers.length, 1);
  assert.equal(taken.takeover.state, 'confirmed');
  assert.equal(taken.snapshot.appControl, null);
  assert.equal(f.startAllowed, true);
  f.advance(1000); await f.restart();
  f.app({ ...oldStop, readAt: f.now });
  const replay = await f.update();
  assert.equal(f.startAllowed, true);
  assert.equal(replay.manual, null);
  assert.equal(f.nativeTakeovers.length, 1, 'A known pre-takeover instruction is not applied again after restart');
});

test('a first cloud Stop with a source time after local takeover is retained when the next response is unknown', async t => {
  const f = fixture(t);
  await f.update(); assert.equal(f.startAllowed, true);
  f.advance(1000); f.app(cloud(f.now, { enabled: false, stopped: true }));
  await f.update(); assert.equal(f.startAllowed, false);
  f.advance(1000);
  f.app(cloud(f.now, { controlKnown: false, enabled: null, enabledAt: null, stopAt: null, schedule: null }));
  await f.update(); assert.equal(f.startAllowed, false);
  await f.restart(); await f.update();
  assert.equal(f.startAllowed, false, 'Unknown source state does not cancel a positively observed later restriction');
});

test('the first reconciliation respects a Stop sourced after plug-in and only explicit takeover supersedes it', async t => {
  const f = fixture(t);
  f.advance(2000); f.status('Preparing', START);
  f.app(cloud(f.now, { enabled: false, stopped: true, enabledAt: START + 1000, stopAt: START + 1000 }));
  const held = await f.update();
  assert.equal(held.session.connectedAt, START);
  assert.equal(f.startAllowed, false);
  assert.equal(f.nativeTakeovers.length, 0, 'A late first reconciliation cannot move the plug-in boundary past a Stop');
  f.app(null); f.advance(1000); await f.restart();
  const retained = await f.update();
  assert.equal(f.startAllowed, false);
  assert.equal(retained.appControl.stopped, true);
  assert.equal(retained.takeover.available, true);
  const explicit = await f.update({ takeover: retained.takeover.token });
  assert.equal(explicit.takeover.state, 'confirmed');
  assert.equal(f.startAllowed, true);
});

test('persisted uncertain local handover requires a status after its request before restart recovery confirms it', async t => {
  const saved = initialOcppControllerState(SCOPE);
  saved.session = { transactionId: null, connected: true, connectedAt: START - MINUTE, lastDisconnectedAt: null };
  saved.takeoverPending = { connectedAt: saved.session.connectedAt, requestedAt: START,
    beforeSchedule: 'a'.repeat(64), afterSchedule: 'b'.repeat(64), enabledAt: null, stopAt: null, local: true };
  const f = fixture(t, { initialState: saved });
  const stale = await f.update();
  assert.equal(stale.errorCode, 'takeover-unconfirmed');
  assert.deepEqual(stale.takeoverPending, saved.takeoverPending);
  assert.equal(f.startAllowed, false);
  await f.restart();
  assert.equal((await f.update()).errorCode, 'takeover-unconfirmed', 'Reading the same old status again cannot confirm the write');
  f.advance(1000);
  const confirmed = await f.update();
  assert.equal(confirmed.takeoverPending, null);
  assert.equal(confirmed.nativeTakeoverAt, START);
  assert.equal(f.startAllowed, true);
  assert.equal(f.nativeTakeovers.length, 0, 'Recovery readback confirms the prior attempt without replaying its mutation');
});

test('Use automatic can address an unavailable connector with unknown plug state only for an established connection', async t => {
  const known = fixture(t);
  const established = await known.update();
  known.advance(1000); known.connected(null); known.status('Unavailable');
  const disabled = await known.update();
  assert.equal(disabled.session.connectedAt, established.session.connectedAt);
  assert.equal(disabled.takeover.available, true);
  assert.equal(known.startAllowed, false, 'Availability recovery is distinct from permission to start');
  const unknown = fixture(t);
  unknown.connected(null); unknown.status('Unavailable');
  const fresh = await unknown.update();
  assert.equal(fresh.takeover.available, false, 'Unavailable alone does not establish a physical connection');
  assert.equal(unknown.startAllowed, false);
});

test('a confirmed new physical connection supersedes the previous connection Stop without cloud', async t => {
  const f = fixture(t, { initialApp: cloud(START) });
  await f.update();
  f.advance(1000); f.app(cloud(f.now, { enabled: false, stopped: true }));
  await f.update(); assert.equal(f.startAllowed, false);
  f.app(null); f.advance(1000); f.disconnect(); await f.update();
  f.advance(1000); f.reconnect();
  const next = await f.update();
  assert.equal(next.manual, null);
  assert.equal(next.session.connectedAt, f.now);
  assert.equal(f.startAllowed, true, 'Historical cloud Stop is not a restriction on a new automatic session');
});

for (const blocked of ['Faulted', 'Unavailable', 'Reserved', 'offline', 'authority'])
  test(`cloud-independent permission still rejects ${blocked}`, async t => {
    const f = fixture(t);
    if (blocked === 'offline') f.online(false);
    else if (blocked === 'authority') f.authority(false);
    else f.status(blocked);
    await f.update();
    assert.equal(f.startAllowed, false);
    assert.equal(f.calls.length, 0);
  });

test('a local scheduling pause installs, survives restart and releases without a compulsory cloud read', async t => {
  const f = fixture(t), startAt = START + 30 * MINUTE;
  f.transaction();
  const paused = await f.update({ plan: plan(startAt) });
  assert.equal(paused.phase, 'paused');
  assert.equal(paused.pauseConfirmed, true);
  assert.equal(f.startAllowed, false);
  assert.equal(f.reads.some(options => options.forceAppRefresh), false,
    'Profile installation must not wait for cloud refresh');
  const profile = structuredClone(paused.owned);
  f.advance(1000); await f.restart();
  const resumed = await f.update({ plan: plan(startAt) });
  assert.equal(resumed.owned.profileId, profile.profileId);
  assert.equal(f.calls.filter(call => call.action === 'SetChargingProfile').length, 1);
  f.advance(startAt - f.now);
  const released = await f.update({ plan: plan(startAt) });
  assert.equal(released.owned, null);
  assert.equal(f.startAllowed, true);
  assert.equal(f.calls.at(-1).action, 'ClearChargingProfile');
});

test('invalid persisted ownership cannot become local approval when cloud information is absent', t => {
  const state = initialOcppControllerState(SCOPE);
  state.scope = 'e'.repeat(64);
  assert.throws(() => fixture(t, { initialState: state }), /Unsupported native charging ownership/);
  const invalidHandover = initialOcppControllerState(SCOPE);
  invalidHandover.nativeTakeoverAt = 'unknown';
  assert.throws(() => fixture(t, { initialState: invalidHandover }), /Unsupported native charging ownership/);
});

async function transportFixture(t) {
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const charger = 'synthetic-outage-charger', password = 'synthetic-ocpp-pass';
  let now = START, remote = null, sequence = 0, cloudAvailable = true, ws;
  const calls = [], requests = [], states = new Map(), observations = new Map();
  const observe = changes => {
    for (const [id, value] of Object.entries(changes)) observations.set(Number(id),
      { id: Number(id), value, timestamp: new Date(now).toISOString() });
  };
  observe(Object.fromEntries(CHARGING_OBSERVATION_IDS.map(id => [id, 16])));
  observe({ 31: true, 80: 344, 96: 55, 100: 'B', 109: 7, 120: 0, 141: 1, 250: true });
  const connections = { easee: { charger_id: charger, access_token: 'synthetic-access-token', local_ocpp: {
    enabled: true, host: '127.0.0.1', port, server_url: `ws://192.0.2.10:${port}/ocpp`,
    password, authorization_mode: 'plug-and-charge',
  } } };
  const stateFor = key => ({ get: () => structuredClone(states.get(key) ?? null),
    set: value => states.set(key, structuredClone(value)) });
  const http = createHttp({ allowOcppSetup: true, canControl: () => true,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname, method = options.method;
      requests.push({ path, method, cloudAvailable });
      if (!cloudAvailable) throw Error('Synthetic Easee cloud outage');
      if (path === `/state/${charger}/observations`) return Response.json({ observations: [...observations.values()] });
      if (path === `/api/chargers/${charger}/schedules` && method === 'GET')
        return Response.json({ enabled: remote ? 'ocpp.direct' : 'none' });
      if (path === `/local-ocpp/v1/connection-details/${charger}`) {
        if (method === 'GET') return remote ? Response.json(remote) : new Response(null, { status: 404 });
        assert.equal(method, 'POST');
        assert.ok(states.get('setup')?.intent);
        const body = JSON.parse(options.body);
        remote = { version: 'synthetic-outage-setup-version', connectivityMode: body.connectivityMode,
          websocketConnectionArgs: { ...body.websocketConnectionArgs, url: `${body.websocketConnectionArgs.url}/${charger}` },
          basicAuth: { username: body.chargePointId, password: body.basicAuthPassword } };
        return Response.json({ version: remote.version }, { status: 201 });
      }
      if (path === `/local-ocpp/v1/connections/chargers/${charger}` && method === 'POST')
        return new Response(null, { status: 204 });
      assert.fail(`Unexpected synthetic provider request: ${method} ${path}`);
    } });
  const installation = ocppInstallation({ connections });
  const provider = createDeviceProviders({ connections, http, clock: () => now, canControl: () => true,
    streamFactory: null, ocppInstallation: installation, ocppState: stateFor('transactions'),
    ocppSetupState: stateFor('setup'), onOcppControlTransition: async () => {} });
  let controller;
  t.after(async () => { await controller?.close(); ws?.terminate(); await provider.close(); http.close(); });
  await provider.reconcileOcpp();
  assert.equal(provider.localOcppStatus().controlTransport, 'ocpp');
  const adapter = provider.chargerScheduleControl();
  controller = adapter.createController({ clock: () => now, canControl: () => true, saveState: stateFor('controller').set });
  ws = new WebSocket(`ws://127.0.0.1:${port}/ocpp/${charger}`, 'ocpp1.6', {
    headers: { Authorization: `Basic ${Buffer.from(`${charger}:${password}`).toString('base64')}` },
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
    const id = `synthetic-outage-call-${++sequence}`;
    const timeout = setTimeout(() => { pending.delete(id); reject(Error('Synthetic OCPP reply timeout')); }, 2000);
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
  return { provider, adapter, controller, calls, requests, installation, call, status, meter, observe,
    get now() { return now; }, advance(ms) { now += ms; }, cloudAvailable(value) { cloudAvailable = value; } };
}

test('real authenticated OCPP starts on time and respects a later Stop while all Easee HTTP fails', async t => {
  const f = await transportFixture(t), startAt = START + 30 * MINUTE;
  f.cloudAvailable(false); f.advance(61_000);
  await f.status('Preparing'); await f.meter(0);
  const missing = await f.adapter.read({ forceAppRefresh: true });
  assert.equal(missing.appControl, null, 'Expired HTTP evidence is absent, not a fabricated permissive snapshot');
  await f.controller.update({ enabled: true, plan: plan(startAt) });
  const waiting = await f.call('Authorize', { idTag: f.installation.virtualTag });
  assert.equal(waiting[2].idTagInfo.status, 'Blocked');
  assert.equal(f.calls.some(value => value.action === 'RemoteStartTransaction'), false);
  f.advance(startAt - f.now);
  await f.status('Preparing'); await f.meter(0);
  await f.controller.update({ enabled: true, plan: plan(startAt) });
  await f.status('Preparing'); await f.call('Heartbeat', {});
  assert.equal(f.calls.filter(value => value.action === 'RemoteStartTransaction').length, 1);
  const allowed = await f.call('Authorize', { idTag: f.installation.virtualTag });
  assert.equal(allowed[2].idTagInfo.status, 'Accepted');
  f.advance(1000);
  const started = await f.call('StartTransaction', { connectorId: 1, idTag: f.installation.virtualTag,
    timestamp: new Date(f.now).toISOString(), meterStart: 0 });
  assert.equal(started[2].idTagInfo.status, 'Accepted');
  const transactionId = started[2].transactionId;
  await f.status('Charging'); await f.meter(6900, transactionId);
  const charging = await f.controller.update({ enabled: true, plan: plan(startAt) });
  assert.equal(charging.snapshot.transactionConfirmed, true);
  assert.equal(charging.snapshot.transactionId, transactionId);
  assert.equal(charging.snapshot.powerKw, 6.9);
  assert.equal(charging.snapshot.appControl, null);
  f.advance(1000);
  await f.call('StopTransaction', { transactionId, timestamp: new Date(f.now).toISOString(), meterStop: 2, reason: 'Remote' });
  await f.status('Preparing'); await f.meter(0);
  const immediate = await f.call('Authorize', { idTag: f.installation.virtualTag });
  assert.equal(immediate[2].idTagInfo.status, 'Blocked', 'The observed Stop fences old start permission before controller reconciliation');
  const stopped = await f.controller.update({ enabled: true, plan: plan(startAt) });
  assert.equal(stopped.manual?.kind, 'stop');
  assert.deepEqual(stopped.snapshot.nativeStop, { transactionId, at: f.now, receivedAt: f.now, reason: 'Remote' });
  await f.status('Preparing'); await f.call('Heartbeat', {});
  assert.equal(f.calls.filter(value => value.action === 'RemoteStartTransaction').length, 1,
    'A local Stop cannot trigger an automatic replacement Start');
  assert.equal(f.requests.some(value => value.method !== 'GET' && !value.cloudAvailable), false,
    'Commissioned local operation needs no cloud setup, enable, resume or schedule write');
});
