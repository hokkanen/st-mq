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

function fixture(t) {
  const config = { dataDir: '/unused-fixture-directory', connections: { easee: {
    charger_id: CHARGER, access_token: 'fixture-access-token', local_ocpp: {
      server_url: 'ws://192.0.2.10:9001/ocpp', password: 'fixture-ocpp-pass', authorization_mode: 'plug-and-charge',
    },
  } } };
  const events = [], providers = [], states = new Map(), listeners = [];
  let now = AT, permitted = true, current = null, version = 0, schedule = { enabled: 'none' };
  let transition = async () => {}, applyHook = async () => {}, beforeRequest = async () => {};
  let readSetupState = () => states.get('setup');
  const stateFor = key => ({ get: () => clone(states.get(key) ?? null), set: value => states.set(key, clone(value)) });
  const http = createHttp({ allowOcppSetup: true, allowChargerScheduling: true, canControl: () => permitted,
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
        [[80, 344], [141, 1], [250, true]].map(([id, value]) => ({ id, value, timestamp: new Date(now).toISOString() })) });
      if (path === `/api/chargers/${CHARGER}/schedules` && method === 'GET') return Response.json(clone(schedule));
      assert.fail(`Unexpected synthetic request: ${method} ${path}`);
    } });
  function make(enabled = true) {
    const configured = clone(config); configured.connections.easee.local_ocpp.enabled = enabled;
    const installation = ocppInstallation(configured);
    const provider = createDeviceProviders({ connections: configured.connections, http, clock: () => now, canControl: () => permitted,
      streamFactory: null, ocppInstallation: installation, ocppState: stateFor('transactions'), ocppSetupState: stateFor('setup'),
      ocppFactory: options => {
        let ready = false, closed = false;
        let control = { connectionId: 'fixture-native-connection', connectorStatus: 'Available', timestamp: now,
          receivedAt: now, transaction: null, readings: [] };
        const listener = {
          options, get closed() { return closed; }, set control(value) { control = clone(value); },
          async start() { events.push({ type: 'listener-start', enabled: options.config.enabled }); ready = options.config.enabled && options.canControl(); },
          status: () => ({ configured: options.config.enabled, ready: ready && !closed && options.canControl(), available: false, controlTransport: 'ocpp' }),
          snapshot: () => null,
          controlSnapshot: () => ready && !closed && options.canControl() ? clone(control) : null,
          refreshAuthority() { events.push({ type: 'listener-authority', active: options.canControl() }); },
          noteModeDisableRequested() { events.push({ type: 'native-mode-disable-intent' }); },
          async request(action, payload, { guard } = {}) {
            assert.equal(options.canControl(), true); assert.equal(guard?.(), true);
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
  return { config, events, states, listeners, make, http,
    get current() { return current; }, get now() { return now; }, advance: ms => { now += ms; },
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

test('provider leaves a foreign active cloud schedule intact and restores cloud control selection', async t => {
  const f = fixture(t); f.schedule = { enabled: 'daily', daily: { timezone: 'Europe/Helsinki',
    periods: [{ startTime: '01:00:00', stopTime: '03:00:00', maximumAmps: 10 }] } };
  const provider = f.make(); await provider.reconcileOcpp();
  assert.deepEqual(writes(f), []);
  assert.equal(provider.localOcppStatus().setup.reason, 'cloud-schedule-active');
  assert.equal(provider.chargerScheduleControl().ownershipNamespace, undefined);
  assert.deepEqual(f.events.filter(event => event.type === 'transition').map(({ phase, target }) => [phase, target]),
    [['prepare', 'native'], ['complete', 'cloud']]);
  await provider.restoreOcpp();
  assert.equal(provider.localOcppStatus().setup.state, 'disabled', 'Failed preflight leaves no restoration obligation or shutdown backoff');
  assert.deepEqual(writes(f), []);
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
  const restarted = f.make(); await restarted.reconcileOcpp();
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

test('full application shutdown restores OcppOff while paired handover preserves native commissioning', async t => {
  for (const preserveOcpp of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'stmq-ocpp-lifecycle-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const f = fixture(t), requestsReady = deferred();
    f.beforeRequest = () => requestsReady.promise;
    const port = await freePort();
    const config = loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'providers' }, directory);
    config.connections.easee = { ...f.config.connections.easee, local_ocpp: { ...f.config.connections.easee.local_ocpp,
      host: '127.0.0.1', port, server_url: `ws://192.0.2.10:${port}/ocpp` } };
    config.connections.mqtt = { address: '' };
    const app = await start({ config, clock: () => AT, installSignalHandlers: false,
      providerOptions: { automatic: false, streamFactory: null, http: f.http } });
    t.after(() => app.close({ preserveOcpp }));
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
    await app.close({ restore: true, preserveOcpp }); await closed;
    assert.equal(f.current.connectivityMode, preserveOcpp ? 'DualProtocol' : 'OcppOff');
    assert.equal(writes(f).length, initialWrites + (preserveOcpp ? 0 : 2));
    const probe = createServer(); probe.listen(port, '127.0.0.1'); await once(probe, 'listening');
    await new Promise(resolve => probe.close(resolve));
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
