import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createDeviceProviders } from '../src/acquisition/devices.js';
import { createHttp } from '../src/acquisition/http.js';
import { ocppInstallation } from '../src/acquisition/easee-ocpp-setup.js';
import { CHARGING_OBSERVATION_IDS } from '../src/charging/easee.js';
import { loadConfig } from '../src/app/config.js';
import { start } from '../src/main.js';

const AT = Date.parse('2026-09-24T12:00:00Z');
const CHARGER = 'fixture-lifecycle-charger';
const clone = value => structuredClone(value);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(t, { streaming = false } = {}) {
  const config = { dataDir: '/unused-fixture-directory', connections: { easee: {
    charger_id: CHARGER, access_token: 'fixture-access-token', local_ocpp: {
      server_url: 'ws://192.0.2.10:9001/ocpp', password: 'fixture-ocpp-pass', authorization_mode: 'plug-and-charge',
    },
  } } };
  const events = [], providers = [], states = new Map(), listeners = [];
  let now = AT, permitted = true, current = null, version = 0, schedule = { enabled: 'none' };
  let transition = async () => {}, applyHook = async () => {}, beforeRequest = async () => {};
  let cloudObservations = null, cloudOffline = false, nativeRequest = null, streamRows = null;
  let readSetupState = () => states.get('setup');
  const stateFor = key => ({ get: () => clone(states.get(key) ?? null), set: value => states.set(key, clone(value)) });
  const newHttp = () => createHttp({ allowOcppSetup: true, allowChargerScheduling: true, allowChargerTakeover: true, canControl: () => permitted,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname, method = options.method, body = options.body ? JSON.parse(options.body) : null;
      events.push({ type: 'http', path, method, body });
      await beforeRequest();
      if (path === `/local-ocpp/v1/connection-details/${CHARGER}`) {
        if (method === 'GET') return current ? Response.json(clone(current)) : new Response(null, { status: 404 });
        assert(readSetupState()?.intent, 'Durable setup intent precedes the HTTP store');
        assert(!body.websocketConnectionArgs.url.endsWith(`/${CHARGER}`), 'POST accepts a base URL, not the expanded GET URL');
        current = { version: `fixture-version-${++version}`, connectivityMode: body.connectivityMode,
          websocketConnectionArgs: { ...clone(body.websocketConnectionArgs), url: `${body.websocketConnectionArgs.url}/${encodeURIComponent(body.chargePointId)}` },
          basicAuth: { username: body.chargePointId, password: body.basicAuthPassword } };
        return Response.json({ version: current.version }, { status: 201 });
      }
      if (path === `/local-ocpp/v1/connections/chargers/${CHARGER}`) {
        assert.equal(method, 'POST'); assert.equal(body.version, current.version);
        assert.equal(readSetupState().intent.version, current.version);
        await applyHook(current.connectivityMode);
        schedule = { ...schedule, enabled: current.connectivityMode === 'DualProtocol' ? 'ocpp.direct' : 'none' };
        return new Response(null, { status: 204 });
      }
      if (path === `/state/${CHARGER}/observations`) return Response.json({ observations:
        (cloudOffline ? (() => { throw Error('synthetic cloud unavailable'); })() : cloudObservations
          ?? [[80, 344], [141, 1], [250, true]].map(([id, value]) => ({ id, value, timestamp: new Date(now).toISOString() }))) });
      if (path === `/api/chargers/${CHARGER}/schedules` && method === 'GET') {
        if (cloudOffline) throw Error('synthetic cloud unavailable');
        return Response.json(clone(schedule));
      }
      if (method === 'POST' && path === `/api/chargers/${CHARGER}/settings`) {
        assert.deepEqual(body, { enabled: true });
        cloudObservations = cloudObservations.map(row => row.id === 31
          ? { ...row, value: true, timestamp: new Date(now).toISOString() } : row);
        return new Response(null, { status: 200 });
      }
      if (method === 'POST' && path === `/api/chargers/${CHARGER}/commands/resume_charging`) {
        assert.equal(body, null);
        cloudObservations = cloudObservations.map(row => [48, 96].includes(row.id)
          ? { ...row, value: row.id === 48 ? 16 : 0, timestamp: new Date(now).toISOString() } : row);
        return new Response(null, { status: 200 });
      }
      if (method === 'POST' && /^\/api\/chargers\/[^/]+\/schedules\/(?:daily|weekly|delayed)\/disable$/.test(path)) {
        assert.equal(body, null); schedule = { ...schedule, enabled: 'none' };
        return new Response(null, { status: 204 });
      }
      assert.fail(`Unexpected synthetic request: ${method} ${path}`);
    } });
  const http = newHttp();
  function make(enabled = true) {
    const configured = clone(config); configured.connections.easee.local_ocpp.enabled = enabled;
    const installation = ocppInstallation(configured);
    const provider = createDeviceProviders({ connections: configured.connections, http, clock: () => now, canControl: () => permitted,
      streamFactory: streaming ? () => ({ start() {}, close() {}, snapshot: () => clone(streamRows), reconcile() {}, status: () => ({ connected: true }) }) : null, ocppInstallation: installation, ocppState: stateFor('transactions'), ocppSetupState: stateFor('setup'),
      ocppFactory: options => {
        let ready = false, closed = false;
        let control = { connectionId: 'fixture-native-connection', connectorStatus: 'Available', timestamp: now,
          receivedAt: now, transaction: null, readings: [] };
        const listener = {
          options, get closed() { return closed; }, get control() { return clone(control); }, set control(value) { control = clone(value); },
          async start() { events.push({ type: 'listener-start', enabled: options.config.enabled }); ready = options.config.enabled && options.canControl(); },
          status: () => ({ configured: options.config.enabled, ready: ready && !closed && options.canControl(), available: false, controlTransport: 'ocpp' }),
          snapshot: () => null,
          controlSnapshot: () => ready && !closed && options.canControl() ? clone(control) : null,
          refreshAuthority() { events.push({ type: 'listener-authority', active: options.canControl() }); },
          noteModeDisableRequested() { events.push({ type: 'native-mode-disable-intent' }); },
          async request(action, payload, requestOptions = {}) {
            assert.equal(options.canControl(), true); assert.equal(requestOptions.guard?.(), true);
            if (nativeRequest) return nativeRequest(action, payload, requestOptions);
            events.push({ type: 'native', action, payload: clone(payload) }); return { status: 'Accepted' };
          },
          async close() { if (!closed) events.push({ type: 'listener-close' }); ready = false; closed = true; },
        };
        listeners.push(listener); return listener;
      },
      onOcppControlTransition: async change => {
        events.push({ type: 'transition', phase: change.phase, target: change.target });
        await transition(change);
      } });
    providers.push(provider); return provider;
  }
  t.after(async () => { for (const provider of providers) await provider.close(); http.close(); });
  return { config, events, states, listeners, make, http, newHttp,
    get current() { return current; }, get now() { return now; }, advance: ms => { now += ms; },
    get observations() { return clone(cloudObservations); }, set observations(value) { cloudObservations = clone(value); },
    set streamRows(value) { streamRows = clone(value); }, set cloudOffline(value) { cloudOffline = value; },
    set nativeRequest(value) { nativeRequest = value; },
    set schedule(value) { schedule = clone(value); }, set transition(value) { transition = value; },
    set applyHook(value) { applyHook = value; }, set beforeRequest(value) { beforeRequest = value; },
    set setupStateReader(value) { readSetupState = value; }, revoke: () => { permitted = false; } };
}
const writes = f => f.events.filter(event => event.type === 'http' && event.method === 'POST');

test('provider activation drains cloud control before store, accepts native POST 201, and compares expanded GET URLs', async t => {
  const f = fixture(t), drain = deferred(), entered = deferred();
  f.transition = async ({ phase, target, adapter }) => {
    if (phase === 'prepare' && target === 'native') { entered.resolve(); await drain.promise; }
    if (phase === 'complete' && target === 'native') assert.equal(adapter.ownershipNamespace, 'ocpp');
  };
  const provider = f.make(), reconciling = provider.reconcileOcpp(); await entered.promise;
  assert.deepEqual(writes(f), [], 'No charger-side mutation can overtake the old controller drain');
  drain.resolve(); await reconciling;
  assert.equal(provider.localOcppStatus().setup.state, 'connecting');
  assert.equal(provider.localOcppStatus().setup.endpoint, undefined, 'Persistable health omits the address');
  assert.equal(provider.localOcppStatus({ includeEndpoint: true }).setup.endpoint, 'ws://192.0.2.10:9001/ocpp');
  assert.equal(writes(f).length, 2);
  assert.equal(f.current.websocketConnectionArgs.url, `ws://192.0.2.10:9001/ocpp/${CHARGER}`);
  assert.equal(provider.chargerScheduleControl().ownershipNamespace, 'ocpp');
  const listener = f.listeners[0];
  assert.equal(listener.options.virtualTag.length, 20);
  assert.equal(listener.options.config.password.length, 17);
  f.advance(30_001); await provider.reconcileOcpp();
  assert.equal(writes(f).length, 2, 'Matching readback cannot cause repeated store/apply writes');
});

test('provider leaves an active cloud schedule and pending cloud takeover intact before native commissioning', async t => {
  const f = fixture(t); f.schedule = { enabled: 'daily', daily: { timezone: 'Europe/Helsinki',
    periods: [{ startTime: '01:00:00', stopTime: '03:00:00', maximumAmps: 10 }] } };
  f.transition = () => assert.fail('Blocked commissioning must not suspend or recreate the cloud controller');
  const provider = f.make(); await provider.reconcileOcpp();
  assert.deepEqual(writes(f), []);
  assert.equal(provider.localOcppStatus().setup.reason, 'cloud-schedule-active');
  assert.equal(provider.chargerScheduleControl().ownershipNamespace, undefined);
  assert.deepEqual(f.events.filter(event => event.type === 'transition'), []);
  await provider.restoreOcpp();
  assert.equal(provider.localOcppStatus().setup.state, 'disabled', 'Failed preflight leaves no restoration obligation or shutdown backoff');
  assert.deepEqual(writes(f), []);
});

test('a schedule installed during native commissioning preflight prevents configuration writes and restores cloud control', async t => {
  const f = fixture(t);
  f.transition = ({ phase, target }) => {
    if (phase === 'prepare' && target === 'native') f.schedule = { enabled: 'delayed',
      delayed: { timezone: 'Europe/Helsinki', startTime: '22:00:00', maximumAmps: 16 } };
  };
  const provider = f.make(); await provider.reconcileOcpp();
  assert.deepEqual(writes(f), []);
  assert.equal(provider.localOcppStatus().setup.reason, 'cloud-schedule-active');
  assert.equal(provider.chargerScheduleControl().ownershipNamespace, undefined);
  assert.deepEqual(f.events.filter(event => event.type === 'transition').map(({ phase, target }) => [phase, target]),
    [['prepare', 'native'], ['complete', 'cloud']]);
});

test('unsupported setup state fences listener authorization and both control backends before mutation', async t => {
  const f = fixture(t), malformed = { version: 999, ownedFingerprint: 'malformed' };
  f.states.set('setup', clone(malformed));
  const provider = f.make(); await provider.reconcileOcpp();
  assert.equal(provider.localOcppStatus().setup.reason, 'incompatible-setup-state');
  assert.equal(provider.localOcppStatus().controlTransport, 'transition');
  assert.equal(f.listeners[0].options.config.enabled, false);
  assert.equal(f.listeners[0].options.canControl(), false);
  assert.equal(f.events.some(event => event.type === 'listener-start'), false);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.states.get('setup'), malformed);
});

test('disabled owned OCPP keeps its listener until native cleanup and OcppOff apply finish', async t => {
  const f = fixture(t), enabled = f.make(); await enabled.reconcileOcpp(); await enabled.close();
  f.events.length = 0;
  const disabled = f.make(false), listener = f.listeners.at(-1), drain = deferred(), entered = deferred();
  assert.equal(listener.options.config.enabled, true, 'Persisted ownership keeps native cleanup reachable despite enabled:false');
  f.transition = async ({ phase, target }) => {
    if (phase === 'prepare' && target === 'cloud') {
      const adapter = disabled.chargerScheduleControl(), snapshot = await adapter.read();
      await adapter.clear({ profileId: 418 }, snapshot);
      assert.equal(listener.closed, false); entered.resolve(); await drain.promise;
    }
    if (phase === 'complete' && target === 'cloud') assert.equal(listener.closed, false);
  };
  f.applyHook = async mode => { assert.equal(mode, 'OcppOff'); assert.equal(listener.closed, false); };
  const restoring = disabled.reconcileOcpp(); await entered.promise;
  assert.equal(writes(f).length, 0); assert.equal(listener.closed, false);
  drain.resolve(); await restoring;
  assert.equal(disabled.localOcppStatus().setup.state, 'disabled');
  assert.equal(f.current.connectivityMode, 'OcppOff'); assert.equal(listener.closed, true);
  assert.equal(f.states.get('setup').ownedFingerprint, null);
  const stop = f.events.findIndex(event => event.type === 'listener-close');
  const apply = f.events.findLastIndex(event => event.type === 'http' && event.path.includes('/connections/chargers/'));
  assert(stop > apply);
  assert(f.events.findIndex(event => event.type === 'native' && event.action === 'ClearChargingProfile') < apply,
    'Owned native cleanup remains callable before OcppOff is applied');
});

test('ordinary provider close preserves native commissioning while explicit restore applies OcppOff', async t => {
  const f = fixture(t), first = f.make(); await first.reconcileOcpp();
  const count = writes(f).length; await first.close();
  assert.equal(writes(f).length, count); assert.equal(f.current.connectivityMode, 'DualProtocol');
  assert(f.states.get('setup').ownedFingerprint);
  f.advance(30_001);
  const restarted = f.make(); await restarted.reconcileOcpp();
  assert.equal(writes(f).length, count, 'Restart verifies matching native settings without applying them again');
  await restarted.restoreOcpp();
  assert.equal(f.current.connectivityMode, 'OcppOff');
  assert.equal(restarted.localOcppStatus().setup.state, 'disabled');
  assert.equal(f.listeners.at(-1).closed, true);
});

test('provider native cleanup can clear an exact owned profile after the transaction has ended', async t => {
  const f = fixture(t), provider = f.make(); await provider.reconcileOcpp();
  const adapter = provider.chargerScheduleControl(), snapshot = await adapter.read();
  assert.equal(snapshot.online, true); assert.equal(snapshot.transactionId, null);
  await adapter.clear({ profileId: 731 }, snapshot);
  assert.deepEqual(f.events.filter(event => event.type === 'native').map(({ action, payload }) => ({ action, payload })),
    [{ action: 'ClearChargingProfile', payload: { id: 731 } }]);
});

test('provider preserves OCPP message receipt clocks instead of replacing them with adapter poll time', async t => {
  const f = fixture(t), provider = f.make(); await provider.reconcileOcpp();
  f.listeners.at(-1).control = { connectionId: 'fixture-native-connection', connectorStatus: 'SuspendedEV',
    timestamp: AT - 30_000, receivedAt: AT - 29_900, transaction: null,
    readings: [{ id: 120, value: 0, timestamp: new Date(AT - 1000).toISOString(), receivedAt: AT - 800 }] };
  const adapter = provider.chargerScheduleControl(), first = await adapter.read();
  assert.equal(first.statusReceivedAt, AT - 29_900);
  assert.equal(first.powerReceivedAt, AT - 800);
  f.advance(5000);
  const next = await adapter.read(), values = adapter.normalize(next, { now: f.now });
  assert.equal(next.readAt, f.now);
  assert.equal(values.charging.measuredAt, AT - 30_000);
  assert.equal(values.charging.receivedAt, AT - 29_900);
  assert.equal(values.powerKw.value, 0);
  assert.equal(values.powerKw.measuredAt, AT - 1000);
  assert.equal(values.powerKw.receivedAt, AT - 800);
});

test('unconfirmed native cleanup retains its listener and commissioning obligation without applying OcppOff', async t => {
  const f = fixture(t), provider = f.make(); await provider.reconcileOcpp();
  const owned = f.states.get('setup').ownedFingerprint, count = writes(f).length;
  f.transition = async ({ phase, target }) => {
    if (phase === 'prepare' && target === 'cloud') throw Object.assign(new Error('Synthetic cleanup still pending'), { code: 'control-transition-pending' });
  };
  await assert.rejects(provider.restoreOcpp(), { code: 'control-transition-pending' });
  assert.equal(provider.localOcppStatus().setup.reason, 'control-transition-pending');
  assert.equal(writes(f).length, count);
  assert.equal(f.current.connectivityMode, 'DualProtocol'); assert.equal(f.listeners[0].closed, false);
  assert.equal(f.states.get('setup').ownedFingerprint, owned);
  assert.equal(provider.chargerScheduleControl().ownershipNamespace, 'ocpp');
});

test('close fences the listener immediately and drains an activation callback without later charger writes', async t => {
  const f = fixture(t), entered = deferred(), drain = deferred();
  f.transition = async ({ phase, target }) => {
    if (phase === 'prepare' && target === 'native') { entered.resolve(); await drain.promise; }
  };
  const provider = f.make(), running = provider.reconcileOcpp(); await entered.promise;
  const closing = provider.close();
  assert.equal(f.listeners[0].options.canControl(), false);
  assert.equal(f.listeners[0].closed, true);
  drain.resolve(); await Promise.all([running, closing]);
  assert.equal(writes(f).length, 0);
});

test('authority loss during controller drain prevents subsequent native provisioning', async t => {
  const f = fixture(t);
  f.transition = async ({ phase, target }) => { if (phase === 'prepare' && target === 'native') f.revoke(); };
  const provider = f.make(); await provider.reconcileOcpp();
  assert.equal(writes(f).length, 0);
  assert.equal(provider.localOcppStatus().setup.reason, 'authority-revoked');
});

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function waitFor(condition) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Synthetic application did not reach the expected lifecycle boundary');
}

test('application shutdown preserves native commissioning on orderly stop and authority loss; restart does not reapply', async t => {
  for (const restore of [true, false]) {
    const directory = mkdtempSync(join(tmpdir(), 'stmq-ocpp-lifecycle-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const f = fixture(t), requestsReady = deferred();
    f.beforeRequest = () => requestsReady.promise;
    const port = await freePort();
    const config = loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'providers' }, directory);
    config.connections.easee = { ...f.config.connections.easee, local_ocpp: { ...f.config.connections.easee.local_ocpp,
      host: '127.0.0.1', port, server_url: `ws://192.0.2.10:${port}/ocpp` } };
    config.connections.mqtt = { address: '' };
    const app = await start({ config, clock: () => f.now, installSignalHandlers: false,
      providerOptions: { automatic: false, streamFactory: null, http: f.http } });
    t.after(() => app.close({ restore }));
    f.setupStateReader = () => app.store.getState('easee:ocpp-setup'); requestsReady.resolve();
    await waitFor(() => app.engine.ocppSetup.status()?.setup.state === 'connecting');
    assert.equal(app.engine.charging.charger('charger1').adapter.ownershipNamespace, 'ocpp');
    assert.equal(app.engine.ocppSetup.status().listening, true);
    const client = new WebSocket(`ws://127.0.0.1:${port}/ocpp/${CHARGER}`, 'ocpp1.6', {
      headers: { Authorization: `Basic ${Buffer.from(`${CHARGER}:${config.connections.easee.local_ocpp.password}`).toString('base64')}` },
    });
    client.on('error', () => {}); t.after(() => client.terminate());
    client.on('message', raw => {
      const frame = JSON.parse(raw);
      if (frame[0] === 2) client.send(JSON.stringify([3, frame[1], { status: 'Accepted' }]));
    });
    await once(client, 'open');
    client.send(JSON.stringify([2, 'fixture-status', 'StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError', timestamp: new Date(AT).toISOString() }]));
    client.send(JSON.stringify([2, 'fixture-meter', 'MeterValues', { connectorId: 1, meterValue: [{ timestamp: new Date(AT).toISOString(),
      sampledValue: [{ measurand: 'Power.Active.Import', unit: 'W', value: '0' }] }] }]));
    await waitFor(() => app.engine.ocppSetup.status().available === true);
    const initialWrites = writes(f).length, closed = once(client, 'close');
    await app.close({ restore }); await closed;
    assert.equal(f.current.connectivityMode, 'DualProtocol');
    assert.equal(writes(f).length, initialWrites);
    const probe = createServer(); probe.listen(port, '127.0.0.1'); await once(probe, 'listening');
    await new Promise(resolve => probe.close(resolve));

    f.advance(30_001);
    const restartReady = deferred(); f.beforeRequest = () => restartReady.promise;
    let nextConfig = config;
    const restarted = await start({ config, readConfig: () => nextConfig, clock: () => f.now, installSignalHandlers: false,
      providerOptions: { automatic: false, streamFactory: null, get http() { return f.newHttp(); } } });
    t.after(() => restarted.close());
    f.setupStateReader = () => restarted.store.getState('easee:ocpp-setup'); restartReady.resolve();
    await waitFor(() => restarted.engine.ocppSetup.status()?.setup.state === 'connecting');
    assert.equal(restarted.engine.charging.charger('charger1').adapter.ownershipNamespace, 'ocpp');
    assert.equal(restarted.engine.ocppSetup.status().listening, true);
    assert.equal(f.current.connectivityMode, 'DualProtocol');
    assert.equal(writes(f).length, initialWrites, 'Reopening the persistent application does not reset charger mode');
    if (restore) {
      await restarted.reloadSettings();
      assert.equal(f.current.connectivityMode, 'DualProtocol');
      assert.equal(writes(f).length, initialWrites, 'Unchanged configuration reload does not reset charger mode');
      nextConfig = clone(config); nextConfig.connections.easee.local_ocpp.enabled = false;
      await restarted.reloadSettings();
      assert.equal(f.current.connectivityMode, 'OcppOff', 'Explicit disabling still restores cloud mode through the old connection');
      assert.equal(writes(f).length, initialWrites + 2);
      assert.equal(restarted.engine.ocppSetup.status().setup.state, 'disabled');
    }
    await restarted.close();
  }
});

test('native exact-ID cleanup remains available while a stopped transaction awaits its StopTransaction', async t => {
  const f = fixture(t), provider = f.make(); await provider.reconcileOcpp();
  const listener = f.listeners[0];
  listener.control = { connectionId: 'fixture-native-connection', connectorStatus: 'Available',
    timestamp: f.now, receivedAt: f.now, transaction: { id: 7, startedAt: f.now - 60_000, confirmed: false }, readings: [] };
  const adapter = provider.chargerScheduleControl(), snapshot = await adapter.read();
  await adapter.clear({ profileId: 719 }, snapshot);
  assert.deepEqual(f.events.filter(event => event.type === 'native').map(({ action, payload }) => ({ action, payload })),
    [{ action: 'ClearChargingProfile', payload: { id: 719 } }]);
});

async function nativeAppFixture(t, options) {
  const f = fixture(t, options), profiles = new Map(), cloud = new Map();
  for (const id of [...CHARGING_OBSERVATION_IDS, 80, 141]) cloud.set(id, { id, value: 16, timestamp: new Date(f.now).toISOString() });
  const observe = changes => {
    for (const [id, value] of Object.entries(changes)) cloud.set(Number(id), { id: Number(id), value, timestamp: new Date(f.now).toISOString() });
    f.observations = [...cloud.values()];
  };
  observe({ 31: true, 96: 0, 100: 'C', 109: 3, 120: 7, 250: true, 80: 344, 141: 1 });
  const provider = f.make(); await provider.reconcileOcpp();
  const listener = f.listeners.at(-1), adapter = provider.chargerScheduleControl();
  const physical = (status = 'Charging', powerKw = 7, transactionId = 7) => {
    listener.control = { connectionId: 'native-app-fixture-socket', connectorStatus: status, timestamp: f.now, receivedAt: f.now,
      transaction: transactionId === null ? null : { id: transactionId, startedAt: AT - 60_000, confirmed: true },
      readings: [{ id: 120, value: powerKw, timestamp: new Date(f.now).toISOString(), receivedAt: f.now }] };
  };
  physical();
  f.nativeRequest = async (action, payload, options) => {
    assert.equal(options.beforeSend?.() ?? true, true);
    assert.equal(options.guard(), true);
    f.events.push({ type: 'native', action, payload: clone(payload) });
    if (action === 'SetChargingProfile') { profiles.set(payload.csChargingProfiles.chargingProfileId, clone(payload.csChargingProfiles)); physical('SuspendedEVSE', 0); return { status: 'Accepted' }; }
    if (action === 'ClearChargingProfile') return { status: profiles.delete(payload.id) ? 'Accepted' : 'Unknown' };
    assert.equal(action, 'GetCompositeSchedule');
    const end = Math.max(0, ...[...profiles.values()].map(profile => Date.parse(profile.validTo)));
    return { status: 'Accepted', connectorId: 1, scheduleStart: new Date(f.now).toISOString(), chargingSchedule: {
      duration: payload.duration, chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: end > f.now ? 0 : 16 },
        ...(end > f.now && end < f.now + payload.duration * 1000 ? [{ startPeriod: (end - f.now) / 1000, limit: 16 }] : [])] } };
  };
  let stored = null;
  const createController = initialState => adapter.createController({ initialState, clock: () => f.now, canControl: () => true,
    saveState: value => { stored = clone(value); } });
  const controller = createController(null); t.after(() => controller.close());
  const refresh = () => adapter.read({ forceAppRefresh: true });
  const plan = { id: 'native-app-plan', feasible: true, startAt: AT + 40 * 60_000, periods: [{ startAt: AT + 40 * 60_000, endAt: null }] };
  await refresh();
  return { f, provider, listener, adapter, controller, plan, profiles, physical, observe, refresh, createController,
    get saved() { return stored; }, nativeWrites: () => f.events.filter(row => row.type === 'native' && row.action !== 'GetCompositeSchedule') };
}

test('production native start authorization is fenced by live status, reconnect and app pause before controller polling', async t => {
  for (const change of ['fault', 'unplug', 'reconnect', 'app-pause']) {
    const x = await nativeAppFixture(t, { streaming: true });
    x.f.streamRows = x.f.observations; x.provider.startStreaming();
    const immediate = { ...x.plan, startAt: AT, periods: [{ startAt: AT, endAt: null }] };
    await x.controller.update({ enabled: true, plan: immediate });
    const canStart = x.listener.options.canStart;
    assert.equal(canStart(), true, `${change}: an open period initially authorizes native startup`);
    const before = x.controller.status();
    x.f.advance(1000);
    if (change === 'fault') x.physical('Faulted', 0);
    if (change === 'unplug') x.physical('Available', 0, null);
    if (change === 'reconnect') x.listener.control = { ...x.listener.control, connectionId: 'fixture-reconnected-socket' };
    if (change === 'app-pause') {
      x.observe({ 48: 0, 96: 52 }); x.f.streamRows = x.f.observations;
    }
    assert.equal(canStart(), false, `${change}: fresh device evidence revokes the queued start without another controller update`);
    assert.deepEqual(x.controller.status(), before, `${change}: the command fence does not require controller reconciliation`);
    x.f.advance(1000);
    x.physical('Preparing', 0, null);
    if (change === 'app-pause') { x.observe({ 48: 16, 96: 0 }); x.f.streamRows = x.f.observations; }
    assert.equal(canStart(), false, `${change}: a recovered connection cannot reuse authorization issued before the interruption`);
  }
});

test('production native adapter observes Easee app Stop and Enable, preserves native limits and restores manual priority', async t => {
  const x = await nativeAppFixture(t), { f, controller } = x;
  let view = await controller.update({ enabled: true, plan: x.plan });
  assert.equal(view.phase, 'paused');
  const ownedId = view.owned.profileId;
  x.profiles.set(19, { transactionId: 7, validTo: new Date(AT + 20 * 60_000).toISOString() });
  f.advance(1000); x.observe({ 31: false, 96: 53, 109: 4 }); await x.refresh();
  view = await controller.update({ enabled: true });
  assert.equal(view.phase, 'yielded'); assert.equal(view.manual.kind, 'stop');
  assert.equal(x.profiles.has(ownedId), false); assert.equal(x.profiles.has(19), true);
  assert.deepEqual(x.nativeWrites().at(-1), { type: 'native', action: 'ClearChargingProfile', payload: { id: ownedId } });
  view = await controller.update({ enabled: true, replan: true });
  assert.equal(view.phase, 'yielded', 'Ordinary replanning cannot undo a stop instruction');
  f.advance(1000); x.observe({ 31: true, 96: 0, 47: 8 }); await x.refresh();
  view = await controller.update({ enabled: true });
  assert.equal(view.manual.kind, 'release'); assert.equal(view.phase, 'yielded');
  assert.equal(view.snapshot.limits.chargerA, 8);
  const restarted = x.createController(x.saved); t.after(() => restarted.close());
  view = await restarted.update({ enabled: true, plan: x.plan });
  assert.equal(view.manual.kind, 'release', 'A restart preserves the same connected session’s app priority');
  view = await restarted.update({ enabled: true, takeover: view.takeover.token });
  assert.equal(view.phase, 'paused'); assert.equal(view.manual, null);
  assert.equal(view.snapshot.limits.chargerA, 8);
  assert(x.nativeWrites().every(row => ['SetChargingProfile', 'ClearChargingProfile'].includes(row.action)));
  assert(x.nativeWrites().filter(row => row.action === 'SetChargingProfile').every(row => row.payload.csChargingProfiles.chargingSchedule.chargingSchedulePeriod.every(period => period.limit === 0)));
});

test('production native adapter distinguishes app priority from Equalizer suspension, faults and an unconfirmed pause', async t => {
  const x = await nativeAppFixture(t);
  x.physical('SuspendedEVSE', 0); x.observe({ 96: 50, 109: 4 }); await x.refresh();
  let view = await x.controller.update({ enabled: true, plan: x.plan });
  assert.equal(view.phase, 'paused'); assert.equal(view.manual, null);
  x.f.advance(1000); x.observe({ 96: 56, 109: 5 }); await x.refresh();
  view = await x.controller.update({ enabled: true });
  assert.equal(view.phase, 'unavailable'); assert.equal(view.manual, null);
  assert.equal(x.nativeWrites().length, 1);
});

test('production native read recognizes app Charge now only after physical confirmation of an owned pause', async t => {
  const x = await nativeAppFixture(t);
  let view = await x.controller.update({ enabled: true, plan: x.plan });
  const saved = x.saved, id = view.owned.profileId;
  assert.equal(view.pauseConfirmed, true);
  x.f.advance(1000); x.physical('Charging', 7);
  const restarted = x.createController(saved); t.after(() => restarted.close());
  view = await restarted.update({ enabled: true, plan: x.plan });
  assert.equal(view.phase, 'yielded'); assert.equal(view.manual.kind, 'release');
  assert.deepEqual(x.nativeWrites().at(-1).payload, { id });
  x.f.advance(1000); x.physical('Available', 0, null);
  view = await restarted.update({ enabled: true });
  assert.equal(view.manual, null); assert.equal(view.phase, 'disconnected');
});

test('production native adapter yields to a changed app schedule until its known window ends', async t => {
  const x = await nativeAppFixture(t);
  await x.controller.update({ enabled: true, plan: x.plan });
  x.f.advance(1000);
  x.f.schedule = { enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '12:00', stopTime: '12:05', maximumAmps: 8 }] } };
  await x.refresh();
  let view = await x.controller.update({ enabled: true });
  assert.equal(view.phase, 'yielded'); assert.equal(view.manual.kind, 'window');
  assert.equal(view.manual.resumeAt, AT + 5 * 60_000);
  x.f.advance(5 * 60_000); await x.refresh();
  view = await x.controller.update({ enabled: true });
  assert.equal(view.manual, null); assert.equal(view.phase, 'paused');
  assert(finiteOnly(x.nativeWrites()));
  assert.equal(x.f.events.filter(row => row.type === 'http' && row.path.endsWith('/schedules') && row.method !== 'GET').length, 0);
});
const finiteOnly = rows => rows.filter(row => row.action === 'SetChargingProfile').every(row => Boolean(row.payload.csChargingProfiles.validTo));

test('production native pre-write reread fences a newer Easee app action without sending a profile', async t => {
  const x = await nativeAppFixture(t), snapshot = await x.refresh();
  x.f.advance(1000); x.observe({ 31: false, 96: 53 });
  const { ocppPauseInstruction } = await import('../src/charging/ocpp.js');
  const instruction = ocppPauseInstruction({ profileId: 81, transactionId: 7, now: x.f.now, startAt: AT + 40 * 60_000 });
  await assert.rejects(x.adapter.install(instruction, snapshot), { code: 'control-revoked' });
  assert.equal(x.nativeWrites().length, 0);
});

test('production native cleanup remains local when supplemental Easee cloud evidence is unavailable', async t => {
  const x = await nativeAppFixture(t);
  await x.controller.update({ enabled: true, plan: x.plan });
  x.f.cloudOffline = true; x.f.advance(61_000);
  const view = await x.controller.update({ enabled: false });
  assert.equal(view.phase, 'off'); assert.equal(view.handoverConfirmed, true);
  assert.equal(x.profiles.size, 0); assert.equal(view.snapshot.appControl, null);
});

test('newer REST app evidence fences a profile even when the stream still holds an older enabled value', async t => {
  const x = await nativeAppFixture(t, { streaming: true });
  x.f.streamRows = x.f.observations; x.provider.startStreaming();
  const snapshot = await x.refresh();
  x.f.advance(1000); x.observe({ 31: false, 96: 53 });
  const { ocppPauseInstruction } = await import('../src/charging/ocpp.js');
  const instruction = ocppPauseInstruction({ profileId: 82, transactionId: 7, now: x.f.now, startAt: AT + 40 * 60_000 });
  await assert.rejects(x.adapter.install(instruction, snapshot), { code: 'control-revoked' });
  assert.equal(x.nativeWrites().length, 0);
  assert.equal((await x.refresh()).appControl.stopped, true);
});

test('a streamed app change while a native profile is queued revokes its final send guard', async t => {
  const x = await nativeAppFixture(t, { streaming: true });
  x.f.streamRows = x.f.observations; x.provider.startStreaming();
  const snapshot = await x.refresh();
  x.f.nativeRequest = async (action, payload, options) => {
    assert.equal(action, 'SetChargingProfile');
    x.f.advance(1000); x.observe({ 31: false, 96: 53 }); x.f.streamRows = x.f.observations;
    assert.equal(options.beforeSend(), false);
    throw Object.assign(Error('queued native write revoked'), { code: 'control-revoked' });
  };
  const { ocppPauseInstruction } = await import('../src/charging/ocpp.js');
  const instruction = ocppPauseInstruction({ profileId: 83, transactionId: 7, now: x.f.now, startAt: AT + 40 * 60_000 });
  await assert.rejects(x.adapter.install(instruction, snapshot), { code: 'control-revoked' });
  assert.equal(x.nativeWrites().length, 0);
});

test('native app schedule priority requires a fresh schedule before expiry handback and records the ready-by cycle', async t => {
  const x = await nativeAppFixture(t);
  await x.controller.update({ enabled: false });
  x.f.schedule = { enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '12:00', stopTime: '12:05', maximumAmps: 8 }] } };
  await x.refresh();
  let view = await x.controller.update({ enabled: true, plan: x.plan, readyBy: '12:04', timezone: 'UTC' });
  assert.equal(view.manual.cycleEndsAt, AT + 4 * 60_000);
  x.f.cloudOffline = true; x.f.advance(5 * 60_000 + 1000);
  view = await x.controller.update({ enabled: true });
  assert.equal(view.phase, 'yielded'); assert.equal(x.nativeWrites().length, 0);
  x.f.cloudOffline = false; x.f.advance(1000); await x.refresh();
  view = await x.controller.update({ enabled: true });
  assert.equal(view.phase, 'paused');
  assert.deepEqual(view.lastManualResume, { at: x.f.now, deadlineAt: AT + 4 * 60_000, reason: 'window-end' });
});

test('natural delayed-schedule expiry does not invent an Easee app Charge now action', async t => {
  const x = await nativeAppFixture(t);
  await x.controller.update({ enabled: false });
  x.f.schedule = { enabled: 'delayed', delayed: { timezone: 'UTC', startTime: '12:05', maximumAmps: 8 } };
  await x.refresh();
  let view = await x.controller.update({ enabled: true, plan: x.plan });
  assert.equal(view.manual.kind, 'schedule');
  const manual = clone(view.manual);
  x.f.advance(5 * 60_000); x.f.schedule = { enabled: 'ocpp.direct' }; await x.refresh();
  view = await x.controller.update({ enabled: true });
  assert.deepEqual(view.manual, manual);
});

test('native transaction rollover keeps app priority and the same physical connection scope', async t => {
  const x = await nativeAppFixture(t);
  let view = await x.controller.update({ enabled: true, plan: x.plan });
  const connectedAt = view.session.connectedAt;
  x.f.advance(1000); x.physical('Charging', 7);
  view = await x.controller.update({ enabled: true });
  assert.equal(view.manual.kind, 'release');
  const manual = clone(view.manual);
  x.f.advance(1000); x.physical('Charging', 7, 8);
  view = await x.controller.update({ enabled: true });
  assert.equal(view.session.connectedAt, connectedAt); assert.equal(view.session.transactionId, 8);
  assert.deepEqual(view.manual, manual); assert.equal(view.phase, 'yielded');
});

test('an observed Easee app pause remains authoritative through missing cloud evidence and restart', async t => {
  const x = await nativeAppFixture(t);
  await x.controller.update({ enabled: false });
  x.f.advance(1000); x.observe({ 31: true, 48: 0, 96: 52 }); await x.refresh();
  let view = await x.controller.update({ enabled: true, plan: x.plan });
  assert.equal(view.phase, 'yielded'); assert.equal(view.manual.kind, 'stop');
  x.f.cloudOffline = true; x.f.advance(61_000);
  const restarted = x.createController(x.saved); t.after(() => restarted.close());
  view = await restarted.update({ enabled: true, plan: x.plan, replan: true });
  assert.equal(view.phase, 'yielded'); assert.equal(view.manual.kind, 'stop'); assert.equal(x.nativeWrites().length, 0);
});

test('older Easee cloud control observations cannot acknowledge or erase a newer app stop', async t => {
  const x = await nativeAppFixture(t), older = x.f.observations;
  await x.controller.update({ enabled: true, plan: x.plan });
  x.f.advance(1000); x.observe({ 31: false, 96: 53 }); await x.refresh();
  let view = await x.controller.update({ enabled: true });
  assert.equal(view.manual.kind, 'stop');
  const manual = clone(view.manual), writesBefore = x.nativeWrites().length;
  x.f.advance(1000); x.f.observations = older; await x.refresh();
  view = await x.controller.update({ enabled: true, replan: true });
  assert.equal(view.phase, 'yielded'); assert.deepEqual(view.manual, manual);
  assert.equal(x.nativeWrites().length, writesBefore);
});

test('a newer Easee schedule wins over a takeover request for an earlier displayed release', async t => {
  const x = await nativeAppFixture(t);
  await x.controller.update({ enabled: true, plan: x.plan });
  x.f.advance(1000); x.physical('Charging', 7);
  let view = await x.controller.update({ enabled: true });
  assert.equal(view.manual.kind, 'release');
  const earlier = view.manual.id, takeover = view.takeover.token;
  x.f.advance(1000);
  x.f.schedule = { enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '12:00', stopTime: '12:05', maximumAmps: 8 }] } };
  await x.refresh();
  const count = x.nativeWrites().length;
  view = await x.controller.update({ enabled: true, takeover });
  assert.equal(view.takeover.state, 'blocked'); assert.equal(view.manual.kind, 'window');
  assert.notEqual(view.manual.id, earlier); assert.equal(x.nativeWrites().length, count);
});

test('production Use automatic confirms a local economic hold before enabling and resuming an Easee pause', async t => {
  const x = await nativeAppFixture(t), { f, controller } = x;
  x.observe({ 31: false, 48: 0, 96: 53, 109: 2 }); x.physical('SuspendedEVSE', 0); await x.refresh();
  const prior = await controller.update({ enabled: false, plan: x.plan });
  assert.equal(prior.takeover.available, true);
  const start = f.events.length, hardLimits = f.observations.filter(row => [22, 23, 24, 47, 104, 111, 112, 113, 230, 231, 232].includes(row.id));
  const result = await controller.update({ enabled: true, takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'confirmed'); assert.equal(result.phase, 'paused'); assert.equal(result.manual, null);
  const events = f.events.slice(start), envelope = events.findIndex(row => row.action === 'GetCompositeSchedule');
  const enable = events.findIndex(row => row.path?.endsWith('/settings'));
  const resume = events.findIndex(row => row.path?.endsWith('/commands/resume_charging'));
  assert.ok(envelope >= 0 && enable > envelope && resume > enable);
  assert.equal(events.some(row => row.method === 'POST' && row.path?.endsWith('/schedules/delayed')), false);
  assert.deepEqual(f.observations.filter(row => hardLimits.some(limit => limit.id === row.id)), hardLimits);
  assert.equal(result.appControl.stopped, false); assert.equal(result.appControl.enabled, true);
  const restarted = x.createController(x.saved); t.after(() => restarted.close());
  const beforeRestart = writes(f).length; await restarted.update({ enabled: true, plan: x.plan });
  assert.equal(writes(f).length, beforeRestart, 'native enable/resume are never replayed on restart');
  f.advance(1000); x.observe({ 31: false, 96: 53 }); await x.refresh();
  const manual = await restarted.update({ enabled: true, plan: x.plan });
  assert.equal(manual.phase, 'yielded'); assert.equal(manual.manual.kind, 'stop');
});

test('production Use automatic disables an active native daily schedule permanently through its guarded vendor API', async t => {
  const x = await nativeAppFixture(t), { f, controller } = x;
  f.schedule = { enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '13:00', stopTime: '14:00', maximumAmps: 8 }] } };
  await x.refresh();
  const immediate = { id: 'start-now', startAt: f.now, periods: [{ startAt: f.now, endAt: null }], feasible: true };
  const prior = await controller.update({ enabled: false, plan: immediate });
  assert.equal(prior.manual.kind, 'window');
  const result = await controller.update({ enabled: true, takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'confirmed'); assert.equal(result.phase, 'released');
  assert.equal(result.appControl.schedule.enabled, 'none'); assert.equal(result.manual, null);
  assert.equal(writes(f).filter(row => row.path.endsWith('/schedules/daily/disable')).length, 1);
  const restarted = x.createController(x.saved); t.after(() => restarted.close());
  f.advance(1000); x.physical('Available', 0, null); x.observe({ 100: 'A', 109: 1 }); await x.refresh();
  await restarted.update({ enabled: true, plan: immediate });
  f.advance(1000); x.physical('Charging', 7, 8); x.observe({ 100: 'C', 109: 3 }); await x.refresh();
  const reconnected = await restarted.update({ enabled: true, plan: immediate });
  assert.equal(reconnected.appControl.schedule.enabled, 'none'); assert.equal(reconnected.manual, null);
  assert.equal(writes(f).filter(row => row.path.endsWith('/schedules/daily/disable')).length, 1);
});

test('production takeover preserves restrictive positive current limits and fences a newer native instruction', async t => {
  const x = await nativeAppFixture(t), { f, controller } = x;
  x.observe({ 31: true, 48: 8, 96: 53, 109: 2 }); await x.refresh();
  let prior = await controller.update({ enabled: false, plan: x.plan });
  let result = await controller.update({ enabled: true, takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'blocked'); assert.equal(result.errorCode, 'resume-current-limit');
  assert.equal(writes(f).some(row => row.path.endsWith('/commands/resume_charging')), false);
  assert.equal(f.observations.find(row => row.id === 48).value, 8);
  prior = await controller.update({ enabled: true, plan: x.plan });
  f.advance(1000); x.observe({ 31: false, 96: 53 }); await x.refresh();
  result = await controller.update({ enabled: true, takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'blocked'); assert.equal(result.errorCode, 'takeover-stale');
  assert.equal(writes(f).some(row => row.path.endsWith('/settings') || row.path.endsWith('/commands/resume_charging')), false);
});

test('an interrupted native schedule disable retains the economic zero profile through polling and restart', async t => {
  const x = await nativeAppFixture(t), { f, controller } = x;
  f.schedule = { enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '13:00', stopTime: '14:00', maximumAmps: 8 }] } };
  await x.refresh();
  const prior = await controller.update({ enabled: false, plan: x.plan });
  f.beforeRequest = async () => {
    if (f.events.at(-1).path?.endsWith('/daily/disable') && f.events.at(-1).method === 'POST') {
      f.schedule = { enabled: 'none' }; throw Error('synthetic lost disable reply');
    }
  };
  let result = await controller.update({ enabled: true, takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'blocked'); assert.ok(x.saved.takeoverPending); assert.ok(result.owned);
  f.beforeRequest = async () => {}; await x.refresh();
  const count = x.nativeWrites().length;
  result = await controller.update({ enabled: true }); assert.equal(result.errorCode, 'takeover-unconfirmed');
  const restarted = x.createController(x.saved); t.after(() => restarted.close());
  result = await restarted.update({ enabled: true, plan: x.plan });
  assert.equal(result.errorCode, 'takeover-unconfirmed'); assert.equal(x.nativeWrites().length, count);
  assert.equal(x.profiles.has(result.owned.profileId), true);
  f.advance(1000); x.observe({ 31: false, 96: 53 }); await x.refresh();
  result = await restarted.update({ enabled: true, plan: x.plan });
  assert.equal(result.takeoverPending, null); assert.equal(result.manual.kind, 'stop'); assert.equal(result.phase, 'yielded');
  assert.equal(writes(f).some(row => row.path.endsWith('/commands/resume_charging')), false);
});

test('a lost native resume reply cannot become manual release and remove the planned zero profile', async t => {
  const x = await nativeAppFixture(t), { f, controller } = x;
  x.observe({ 31: true, 48: 0, 96: 53, 109: 2 }); await x.refresh();
  const prior = await controller.update({ enabled: false, plan: x.plan });
  f.beforeRequest = async () => {
    if (f.events.at(-1).path?.endsWith('/commands/resume_charging') && f.events.at(-1).method === 'POST') {
      f.observations = f.observations.map(row => [48, 96].includes(row.id)
        ? { ...row, value: row.id === 48 ? 16 : 0, timestamp: new Date(f.now).toISOString() } : row);
      throw Error('synthetic lost resume reply');
    }
  };
  let result = await controller.update({ enabled: true, takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'blocked'); assert.ok(x.saved.takeoverPending);
  const id = result.owned.profileId, nativeCount = x.nativeWrites().length;
  f.beforeRequest = async () => {}; await x.refresh();
  result = await controller.update({ enabled: true }); assert.equal(result.errorCode, 'takeover-unconfirmed');
  const restarted = x.createController(x.saved); t.after(() => restarted.close());
  result = await restarted.update({ enabled: true, plan: x.plan });
  assert.equal(result.errorCode, 'takeover-unconfirmed'); assert.equal(x.profiles.has(id), true);
  assert.equal(x.nativeWrites().length, nativeCount);
  result = await restarted.update({ enabled: true, takeover: result.takeover.token });
  assert.equal(result.takeover.state, 'confirmed'); assert.equal(result.takeoverPending, null);
  assert.equal(writes(f).filter(row => row.path.endsWith('/commands/resume_charging')).length, 1);
});

test('automatic takeover waits for recovered transaction authority before replacing an Easee zero-current pause', async t => {
  const x = await nativeAppFixture(t), { f, controller } = x;
  x.observe({ 31: true, 48: 0, 96: 52, 109: 2 }); x.physical('SuspendedEVSE', 0, null); await x.refresh();
  let result = await controller.update({ enabled: true, plan: x.plan });
  assert.equal(result.errorCode, 'transaction-unconfirmed'); assert.ok(result.automaticTakeover);
  assert.equal(x.nativeWrites().length, 0);
  assert.equal(writes(f).some(row => row.path.endsWith('/commands/resume_charging')), false);

  // The receiver validates independently reported, fresh transaction-bearing
  // readings. Recovery preserves the unknown original session start time.
  f.advance(1000); const confirmedAt = f.now;
  const recover = () => {
    x.listener.control = { ...x.listener.control, transaction: { id: 7, startedAt: null, confirmedAt,
      provenance: 'meter-values', confirmed: true } };
  };
  x.physical('SuspendedEVSE', 0); recover();
  const nativeRequest = x.listener.request;
  x.listener.request = async (...args) => { const response = await nativeRequest(...args); recover(); return response; };
  const before = f.events.length;
  result = await controller.update({ enabled: true });
  assert.equal(result.phase, 'paused'); assert.equal(result.manual, null);
  assert.equal(result.snapshot.transactionStartedAt, null); assert.equal(result.snapshot.transactionProvenance, 'meter-values');
  assert.equal(result.owned.transactionId, 7); assert.equal(result.automaticTakeover, null);
  const events = f.events.slice(before), install = events.findIndex(row => row.action === 'SetChargingProfile'),
    confirmed = events.findIndex(row => row.action === 'GetCompositeSchedule'),
    resume = events.findIndex(row => row.path?.endsWith('/commands/resume_charging'));
  assert.ok(install >= 0 && confirmed > install && resume > confirmed);
  assert.equal(events.some(row => row.action === 'RemoteStartTransaction'), false);
  assert.equal(writes(f).some(row => row.path.endsWith('/schedules/delayed')), false);
  const restarted = x.createController(x.saved); t.after(() => restarted.close());
  const count = writes(f).length;
  result = await restarted.update({ enabled: true, plan: x.plan });
  assert.equal(result.phase, 'paused'); assert.equal(writes(f).length, count);
});
