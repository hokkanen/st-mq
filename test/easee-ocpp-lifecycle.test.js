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
import { easeeAllowanceStatus } from '../src/charging/allowance-history.js';
import { updateSupplyEstimate } from '../src/charging/supply.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
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

function fixture(t, { streaming = false, authorizationMode = 'plug-and-charge', equalizer = false, realOcpp = false } = {}) {
  const config = { dataDir: '/unused-fixture-directory', connections: { easee: {
    charger_id: CHARGER, access_token: 'fixture-access-token', ...(equalizer ? { equalizer_id: 'fixture-equalizer' } : {}), local_ocpp: {
      server_url: 'ws://192.0.2.10:9001/ocpp', password: 'fixture-ocpp-pass', authorization_mode: authorizationMode,
      authorization_tags: authorizationMode === 'rfid' ? ['fixture-rfid-tag'] : [],
    },
  } } };
  const events = [], providers = [], states = new Map(), listeners = [];
  let now = AT, permitted = true, current = null, version = 0, schedule = { enabled: 'none' };
  let transition = async () => {}, applyHook = async () => {}, beforeRequest = async () => {};
  let cloudObservations = null, cloudOffline = false, nativeRequest = null, streamRows = null, commandSourceAt = null;
  let resumeCurrentDelayReads = 0, pendingResumeCurrentAt = null;
  let streamObservation = null;
  let streamConnected = true, streamDisconnect = null, streamEvidence = null, streamPending = false;
  let readSetupState = () => states.get('setup');
  const stateFor = key => ({ get: () => clone(states.get(key) ?? null), set: value => states.set(key, clone(value)) });
  const newHttp = () => createHttp({ allowOcppSetup: true, allowChargerScheduling: true, allowChargerTakeover: true, canControl: () => permitted,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname, method = options.method, body = options.body ? JSON.parse(options.body) : null;
      events.push({ type: 'http', path, method, body });
      const intercepted = await beforeRequest({ path, method, body });
      if (intercepted instanceof Response) return intercepted;
      if (path === '/api/equalizers/fixture-equalizer/config') return Response.json({ maxAllocatedCurrent: 27 });
      if (path === '/state/fixture-equalizer/observations') return Response.json({ observations:
        [31, 32, 33, 34, 35, 36].map(id => ({ id, value: id < 34 ? 5 : 230, timestamp: new Date(AT).toISOString() })) });
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
        const setup = readSetupState();
        if (setup.intent) assert.equal(setup.intent.version, current.version);
        else assert(setup.ownedFingerprint && setup.appliedFingerprint === setup.ownedFingerprint,
          'Recovery only reapplies an already commissioned and owned connection');
        await applyHook(current.connectivityMode);
        schedule = { ...schedule, enabled: current.connectivityMode === 'DualProtocol' ? 'ocpp.direct' : 'none' };
        return new Response(null, { status: 204 });
      }
      if (path === `/state/${CHARGER}/observations`) {
        if (pendingResumeCurrentAt !== null && resumeCurrentDelayReads-- <= 0) {
          cloudObservations = cloudObservations.map(row => row.id === 48
            ? { ...row, value: 16, timestamp: new Date(pendingResumeCurrentAt).toISOString() } : row);
          pendingResumeCurrentAt = null;
        }
        return Response.json({ observations:
        (cloudOffline ? (() => { throw Error('synthetic cloud unavailable'); })() : cloudObservations
          ?? [[80, 344], [141, 1], [250, true]].map(([id, value]) => ({ id, value, timestamp: new Date(now).toISOString() }))) });
      }
      if (path === `/api/chargers/${CHARGER}/schedules` && method === 'GET') {
        if (cloudOffline) throw Error('synthetic cloud unavailable');
        return Response.json(clone(schedule));
      }
      if (method === 'POST' && path === `/api/chargers/${CHARGER}/settings`) {
        assert.deepEqual(body, { enabled: true });
        cloudObservations = cloudObservations.map(row => row.id === 31
          ? { ...row, value: true, timestamp: new Date(commandSourceAt ?? now).toISOString() } : row);
        return new Response(null, { status: 200 });
      }
      if (method === 'POST' && path === `/api/chargers/${CHARGER}/commands/resume_charging`) {
        assert.equal(body, null);
        if (resumeCurrentDelayReads > 0) pendingResumeCurrentAt = commandSourceAt ?? now;
        cloudObservations = cloudObservations.map(row => (row.id === 96 || row.id === 48 && pendingResumeCurrentAt === null)
          ? { ...row, value: row.id === 48 ? 16 : 0, timestamp: new Date(commandSourceAt ?? now).toISOString() } : row);
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
      streamFactory: streaming ? options => {
        streamObservation = options.onObservation;
        streamDisconnect = options.onDisconnect;
        return { start() {}, close() {}, snapshot: (device, ids) => !streamConnected ? null
          : streamRows instanceof Map ? clone(streamRows.get(device)?.filter(row => ids.includes(row.id)) ?? null) : clone(streamRows),
        evidence: (device, ids) => streamEvidence ? clone({ ...streamEvidence.get(device), observations:
          streamEvidence.get(device)?.synchronized === true ? streamEvidence.get(device)?.observations?.filter(row => ids.includes(row.id)) : null }) : undefined,
        pending: () => streamPending, reconcile() {}, status: () => ({ connected: streamConnected }) };
      } : null, ocppInstallation: installation, ocppState: stateFor('transactions'), ocppSetupState: stateFor('setup'),
      ocppFactory: realOcpp ? undefined : options => {
        let ready = false, closed = false;
        let control = { connectionId: 'fixture-native-connection', connectorStatus: 'Available', timestamp: now,
          receivedAt: now, transaction: null, readings: [] };
        const listener = {
          options, get closed() { return closed; }, get control() { return clone(control); }, set control(value) { control = clone(value); },
          async start() { events.push({ type: 'listener-start', enabled: options.config.enabled }); ready = options.config.enabled && options.canControl(); },
          status: () => ({ configured: options.config.enabled, ready: ready && !closed && options.canControl(), available: false, controlTransport: 'ocpp' }),
          snapshot: () => null,
          controlSnapshot: () => ready && !closed && options.canControl() && control.timestamp <= now ? clone(control) : null,
          currentSupplySnapshot: () => ready && !closed && options.canControl() ? {
            connectionId: control.connectionId, epoch: control.connectionId, readings: clone(control.readings),
          } : null,
          controlClockDelayMs: () => {
            const remaining = control.timestamp - now;
            if (!ready || closed || !options.canControl() || !(remaining > 0 && remaining <= 1000)) return 0;
            listener.onClockWait?.(remaining);
            return remaining;
          },
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
    set commandSourceAt(value) { commandSourceAt = value; },
    set resumeCurrentDelayReads(value) { resumeCurrentDelayReads = value; },
    set streamRows(value) { streamRows = clone(value); }, set cloudOffline(value) { cloudOffline = value; },
    set streamEvidence(value) { streamEvidence = clone(value); },
    set streamPending(value) { streamPending = value; },
    set streamConnected(value) { if (streamConnected && !value) streamDisconnect?.(); streamConnected = value; },
    emitObservation(observation) { streamObservation?.(CHARGER, observation); },
    get nativeRequest() { return nativeRequest; }, set nativeRequest(value) { nativeRequest = value; },
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

test('native OCPP restart retains supply history while cloud metadata is missing and recovers its configured balancing evidence', async t => {
  const f = fixture(t, { equalizer: true });
  f.observations = [[80, 344], [141, 1], [250, true], [22, 16], [23, 16], [24, 16],
    [230, 20], [231, 20], [232, 20], [183, 0], [184, 0], [185, 0]]
    .map(([id, value]) => ({ id, value, timestamp: new Date(AT).toISOString() }));
  const physical = () => { f.listeners.at(-1).control = {
    connectionId: 'supply-restart-socket', connectorStatus: 'SuspendedEVSE', timestamp: f.now,
    receivedAt: f.now, transaction: null,
    readings: [120, 183, 184, 185].map(id => ({ id, value: 0, timestamp: new Date(AT).toISOString(), receivedAt: AT })),
  }; };
  const first = f.make(); await first.reconcileOcpp(); physical();
  const baseline = await first.chargerScheduleControl().read({ forceAppRefresh: true });
  assert.equal(baseline.externalLoadBalancing, true);
  const established = updateSupplyEstimate(null, baseline, f.now);
  assert.equal(established.available, true);
  assert.equal(established.samples.length, 1);
  await first.close(); f.advance(1000);
  const restarted = f.make(); await restarted.reconcileOcpp(); physical();
  f.cloudOffline = true;
  const absent = await restarted.chargerScheduleControl().read({ forceAppRefresh: true });
  assert.equal(absent.online, true, 'Local OCPP remains connected during the cloud metadata gap');
  assert.equal(absent.externalLoadBalancing, null);
  const held = updateSupplyEstimate(JSON.parse(JSON.stringify(established)), absent, f.now);
  assert.equal(held.available, false);
  assert.deepEqual(held.samples, established.samples);
  assert.equal(held.measuredAt, established.measuredAt);
  f.cloudOffline = false; f.advance(1000);
  const recovered = await restarted.chargerScheduleControl().read({ forceAppRefresh: true });
  assert.equal(recovered.externalLoadBalancing, true);
  const restored = updateSupplyEstimate(held, recovered, f.now);
  assert.equal(restored.available, true);
  assert.deepEqual(restored.samples, established.samples);
  assert.equal(restored.measuredAt, established.measuredAt, 'Metadata recovery cannot renew source observations');
});

test('native current supply reads admitted stream and OCPP samples without polling or refreshing their clocks', async t => {
  const f = fixture(t, { equalizer: true, streaming: true });
  f.observations = [[80, 344], [141, 1], [250, true], [22, 16], [23, 16], [24, 16],
    [230, 20], [231, 20], [232, 20], [183, 0], [184, 0], [185, 0]]
    .map(([id, value]) => ({ id, value, timestamp: new Date(AT).toISOString() }));
  const provider = f.make(); await provider.reconcileOcpp();
  const adapter = provider.chargerScheduleControl();
  await adapter.read({ forceAppRefresh: true });
  provider.startStreaming(); await new Promise(resolve => setImmediate(resolve));
  const rows = (ids, values, at = f.now) => ids.map((id, index) => ({
    id, value: values[index], unit: 'A', timestamp: new Date(at).toISOString(),
  }));
  const physical = readings => { f.listeners.at(-1).control = {
    connectionId: 'current-supply-socket', connectorStatus: 'Charging', timestamp: f.now,
    receivedAt: f.now, transaction: null, readings,
  }; };
  f.advance(1000);
  let property = rows([31, 32, 33], [20, 21, 22]);
  const charger = rows([183, 184, 185], [3, 4, 5]);
  physical(charger);
  const stream = () => { f.streamRows = new Map([
    ['fixture-equalizer', property.some(row => row.id === 250) ? property
      : [...property, { id: 250, value: true, timestamp: new Date(AT).toISOString() }]],
    [CHARGER, [...rows([183, 184, 185], [9, 9, 9]), { id: 250, value: true, timestamp: new Date(AT).toISOString() }]],
  ]); };
  stream();
  const httpCount = f.events.filter(row => row.type === 'http').length;
  let reading = adapter.readCurrentSupply();
  assert.equal(reading.online, true);
  assert.deepEqual(reading.supply.propertyCurrentA, [20, 21, 22]);
  assert.deepEqual(reading.supply.chargerCurrentA, [3, 4, 5], 'Admitted local meter samples precede cloud charger samples');
  assert.deepEqual(reading.supply.currentSources, { property: 'easee-stream', charger: 'easee-ocpp' });
  assert.equal(Object.hasOwn(reading.supply, 'nativeBudget'), false);
  assert.equal(Object.hasOwn(reading.supply, 'availableCurrentA'), false);
  f.advance(1000); property = rows([31, 32, 33], [25, 26, 27]); stream();
  reading = adapter.readCurrentSupply();
  assert.deepEqual(reading.supply.propertyCurrentA, [25, 26, 27], 'A new stream sample is visible without controller/cloud polling');
  const sourceTimes = structuredClone(reading.supply.observationTimes);
  f.advance(20_000);
  assert.deepEqual(adapter.readCurrentSupply().supply.observationTimes, sourceTimes,
    'Repeated getters preserve the original source clocks');
  assert.equal(f.events.filter(row => row.type === 'http').length, httpCount);
  for (const invalid of [
    rows([31, 32, 33], [null, 20, 20]), rows([31, 32], [20, 20]),
    rows([31, 32, 33], [20, 20, 20], f.now + 1000),
    rows([31, 32, 33], [20, 20, 20]).map(row => ({ ...row, unit: 'W' })),
    [...rows([31, 32, 33], [20, 20, 20]), ...rows([31], [21])],
    [...rows([31, 32, 33], [20, 20, 20]), { id: 250, value: false, timestamp: new Date(f.now).toISOString() }],
  ]) {
    property = invalid; stream();
    assert.equal(adapter.readCurrentSupply().supply.propertyCurrentA, null,
      'Unknown live evidence cannot borrow an older cached property value');
  }
  property = rows([31, 32, 33], [20, 20, 20]); stream();
  physical(rows([183], [null]));
  assert.equal(adapter.readCurrentSupply().supply.chargerCurrentA, null,
    'An invalid local meter sample cannot be replaced by a different source');
  physical([]);
  assert.deepEqual(adapter.readCurrentSupply().supply.chargerCurrentA, [9, 9, 9],
    'An independent admitted stream can supply phases when no local phases exist');
  f.streamConnected = false;
  assert.equal(adapter.readCurrentSupply().supply.propertyCurrentA, null,
    'Disconnect fences cached supply from before the acquisition boundary');
  assert.equal(f.events.filter(row => row.type === 'http').length, httpCount);
  await adapter.read({ forceAppRefresh: true });
  reading = adapter.readCurrentSupply();
  assert.equal(reading.supply.propertyCurrentA, null,
    'A successful REST read cannot substitute for a disconnected synchronized property stream');
  await provider.close();
  reading = adapter.readCurrentSupply();
  assert.equal(reading.online, false);
  assert.equal(reading.supply.propertyCurrentA, null);
  assert.equal(reading.supply.chargerCurrentA, null);
});

test('current supply keeps held property state and stream health separate from native meter receipts', async t => {
  const f = fixture(t, { equalizer: true, streaming: true });
  const provider = f.make(); await provider.reconcileOcpp();
  provider.startStreaming(); await new Promise(resolve => setImmediate(resolve));
  f.advance(1000);
  const old = AT - 3_600_000, online = { id: 250, value: true, timestamp: new Date(old).toISOString() };
  const rows = (ids, values, at = old) => ids.map((id, index) => ({ id, value: values[index], unit: 'A',
    timestamp: new Date(at).toISOString() }));
  const propertyRows = rows([31, 32, 33], [4, 5, 6]);
  const chargerRows = rows([183, 184, 185], [0, 0, 0]);
  const streamEvidence = new Map([
    ['fixture-equalizer', { source: 'easee-stream', connected: true, online: true, synchronized: true,
      epoch: '1:0', receivedAt: AT, activityAt: null, sourceAt: null, observations: propertyRows }],
    [CHARGER, { source: 'easee-stream', connected: true, online: true, synchronized: true,
      epoch: '1:0', receivedAt: AT, activityAt: null, sourceAt: null, observations: chargerRows }],
  ]);
  f.streamRows = new Map([
    ['fixture-equalizer', [...rows([31, 32, 33], [4, 5, 6], f.now), online]],
    [CHARGER, [...chargerRows, online]],
  ]);
  f.streamEvidence = streamEvidence;
  f.listeners.at(-1).control = { connectionId: 'current-supply-socket', connectorStatus: 'Charging', timestamp: f.now,
    receivedAt: f.now, transaction: null,
    readings: rows([183, 184, 185], [2, 3, 4], f.now).map(row => ({ ...row, receivedAt: f.now })),
  };
  const adapter = provider.chargerScheduleControl(), httpCount = f.events.filter(row => row.type === 'http').length;
  const supply = adapter.readCurrentSupply().supply;
  assert.deepEqual(supply.propertyCurrentA, [4, 5, 6], 'A newer shared REST cache cannot masquerade as live stream evidence');
  assert.deepEqual(supply.observationTimes.property, [old, old, old], 'A newer unchanged REST observation cannot renew stream source clocks');
  assert.deepEqual(supply.chargerCurrentA, [2, 3, 4]);
  assert.equal(supply.feedEvidence.property.synchronized, true);
  assert.equal(supply.feedEvidence.property.activityAt, null, 'Synchronized held state is not a fresh measurement');
  assert.equal(supply.feedEvidence.charger.source, 'easee-ocpp');
  assert.equal(supply.feedEvidence.charger.activityAt, f.now);
  assert.equal(supply.feedEvidence.charger.epoch, 'current-supply-socket');
  f.advance(60_000);
  assert.deepEqual(adapter.readCurrentSupply().supply, supply, 'Reading evidence neither polls nor renews source or receipt clocks');
  assert.equal(f.events.filter(row => row.type === 'http').length, httpCount);
  streamEvidence.set('fixture-equalizer', { ...streamEvidence.get('fixture-equalizer'), synchronized: false, epoch: '1:1' });
  f.streamEvidence = streamEvidence;
  const invalid = adapter.readCurrentSupply().supply;
  assert.equal(invalid.propertyCurrentA, null, 'Old property rows cannot cross a device recovery boundary');
  assert.equal(invalid.feedEvidence.property.synchronized, false);
  assert.deepEqual(invalid.chargerCurrentA, [2, 3, 4], 'One device recovery does not erase the other independent feed');
});

test('cloud and native control use the same held property feed without Equalizer allowance or configuration reads', async t => {
  for (const native of [false, true]) {
    const f = fixture(t, { equalizer: true, streaming: true });
    const provider = f.make(native); await provider.reconcileOcpp();
    provider.startStreaming(); await new Promise(resolve => setImmediate(resolve));
    f.advance(3600_000);
    const rows = (ids, values) => ids.map((id, index) => ({ id, value: values[index], unit: 'A',
      timestamp: new Date(AT).toISOString() }));
    const property = rows([31, 32, 33], [14, 15, 16]), charger = rows([183, 184, 185], [8, 8, 8]);
    const online = { id: 250, value: true, timestamp: new Date(AT).toISOString() };
    f.streamRows = new Map([['fixture-equalizer', [...property, online]], [CHARGER, [...charger, online]]]);
    const evidence = observations => ({ source: 'easee-stream', connected: true, online: true, synchronized: true,
      epoch: '1:0', receivedAt: AT, activityAt: null, sourceAt: null, observations });
    f.streamEvidence = new Map([['fixture-equalizer', evidence(property)], [CHARGER, evidence(charger)]]);
    // Simulate an unavailable native control connection. Its availability must
    // not gate independent Equalizer state or admitted cloud peer measurements.
    f.listeners.at(-1).control = { ...f.listeners.at(-1).control, timestamp: f.now + 1000 };
    f.listeners.at(-1).currentSupplySnapshot = () => null;
    const adapter = provider.chargerScheduleControl(), httpCount = f.events.filter(row => row.type === 'http').length;
    const reading = adapter.readCurrentSupply();
    assert.equal(reading.online, true);
    assert.deepEqual(reading.supply.propertyCurrentA, [14, 15, 16]);
    assert.deepEqual(reading.supply.chargerCurrentA, [8, 8, 8]);
    assert.deepEqual(reading.supply.observationTimes, { property: [AT, AT, AT], charger: [AT, AT, AT] });
    assert.deepEqual(reading.supply.currentSources, { property: 'easee-stream', charger: 'easee-stream' });
    assert.equal(reading.supply.feedEvidence.property.synchronized, true);
    assert.equal(reading.supply.feedEvidence.charger.synchronized, true);
    assert.equal(Object.hasOwn(reading.supply, 'availableCurrentA'), false);
    assert.equal(Object.hasOwn(reading.supply, 'nativeBudget'), false);
    assert.equal(f.events.filter(row => row.type === 'http').length, httpCount);
    f.streamConnected = false;
    const disconnected = adapter.readCurrentSupply();
    assert.equal(disconnected.online, false);
    assert.equal(disconnected.supply.propertyCurrentA, null);
    assert.equal(disconnected.supply.chargerCurrentA, null);
  }
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

async function recoveryFixture(t) {
  const f = fixture(t, { realOcpp: true }), port = await freePort();
  f.config.connections.easee.refresh_token = 'fixture-recovery-refresh-token';
  Object.assign(f.config.connections.easee.local_ocpp, { host: '127.0.0.1', port,
    server_url: `ws://192.0.2.10:${port}/ocpp` });
  const provider = f.make(); await provider.reconcileOcpp();
  const nativeFrames = [];
  async function connect() {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ocpp/${CHARGER}`, 'ocpp1.6', {
      headers: { Authorization: `Basic ${Buffer.from(`${CHARGER}:${f.config.connections.easee.local_ocpp.password}`).toString('base64')}` },
    });
    client.on('error', () => {}); t.after(() => client.terminate());
    client.on('message', raw => {
      const frame = JSON.parse(raw);
      if (frame[0] !== 2) return;
      nativeFrames.push(frame);
      client.send(JSON.stringify([3, frame[1], { status: 'Accepted' }]));
    });
    await once(client, 'open');
    client.send(JSON.stringify([2, 'recovery-status', 'StatusNotification', { connectorId: 1,
      status: 'Available', errorCode: 'NoError', timestamp: new Date(f.now).toISOString() }]));
    client.send(JSON.stringify([2, 'recovery-meter', 'MeterValues', { connectorId: 1,
      meterValue: [{ timestamp: new Date(f.now).toISOString(),
        sampledValue: [{ measurand: 'Power.Active.Import', unit: 'W', value: '0' }] }] }]));
    await waitFor(() => provider.localOcppStatus().available === true);
    return client;
  }
  return { f, provider, connect, nativeFrames };
}

test('failed cloud-assisted OCPP recovery preserves the native backend and accepts local reconnection during cloud loss', async t => {
  const { f, provider, connect, nativeFrames } = await recoveryFixture(t);
  const commissioned = clone(f.states.get('setup')), adapter = provider.chargerScheduleControl();
  const start = f.events.length;
  f.transition = () => assert.fail('Connection recovery must not transition or recreate the native controller');
  f.applyHook = () => { throw Error('synthetic recovery apply failure'); };
  f.advance(300_001); await provider.reconcileOcpp();
  const attempted = f.events.slice(start).filter(row => row.type === 'http' && row.method === 'POST');
  assert.deepEqual(attempted.map(({ path, body }) => ({ path, body })),
    [{ path: `/local-ocpp/v1/connections/chargers/${CHARGER}`, body: { version: f.current.version } }],
    'Recovery attempts Apply without storing configuration or changing charger mode');
  assert.equal(provider.localOcppStatus().setup.reason, 'cloud-unavailable');
  assert.equal(provider.localOcppStatus().listening, true);
  assert.equal(provider.localOcppStatus().controlTransport, 'ocpp');
  assert.equal(provider.chargerScheduleControl(), adapter);
  assert.equal(f.current.connectivityMode, 'DualProtocol');
  assert.equal(f.states.get('setup').intent, null);
  assert.equal(f.states.get('setup').ownedFingerprint, commissioned.ownedFingerprint);
  assert.equal(f.states.get('setup').appliedFingerprint, commissioned.appliedFingerprint);

  f.cloudOffline = true;
  f.beforeRequest = () => { throw Error('synthetic total cloud outage'); };
  await connect();
  await provider.reconcileOcpp();
  const snapshot = await adapter.read();
  assert.equal(snapshot.online, true, 'Fresh local readback survives the failed optional cloud recovery');
  assert.equal(snapshot.connectorStatus, 'Available');
  await adapter.clear({ profileId: 719 }, snapshot);
  assert.deepEqual(nativeFrames.filter(frame => frame[2] === 'ClearChargingProfile').map(frame => frame[3]), [{ id: 719 }]);
  assert.equal(provider.localOcppStatus().listening, true);
  assert.equal(provider.localOcppStatus().controlTransport, 'ocpp');
  assert.equal(provider.chargerScheduleControl(), adapter);
});

test('a local OCPP connection arriving during cloud token refresh cancels the pending recovery Apply retry', async t => {
  const { f, provider, connect } = await recoveryFixture(t);
  const releaseRefresh = deferred(), start = f.events.length;
  let rejectedApply = false, refreshing = false;
  t.after(() => releaseRefresh.resolve());
  f.transition = () => assert.fail('Connection recovery must not transition the native controller');
  f.beforeRequest = async ({ path }) => {
    if (path === `/local-ocpp/v1/connections/chargers/${CHARGER}` && !rejectedApply) {
      rejectedApply = true; return new Response(null, { status: 401 });
    }
    if (path === '/api/accounts/refresh_token') {
      refreshing = true; await releaseRefresh.promise;
      return Response.json({ accessToken: 'fixture-recovery-rotated-access', refreshToken: 'fixture-recovery-rotated-refresh' });
    }
  };
  f.advance(300_001);
  const recovery = provider.reconcileOcpp();
  try { await waitFor(() => refreshing); await connect(); } finally { releaseRefresh.resolve(); }
  await recovery;
  const requests = f.events.slice(start).filter(row => row.type === 'http');
  assert.equal(requests.filter(row => row.path === `/local-ocpp/v1/connections/chargers/${CHARGER}`).length, 1,
    'A rejected request cannot be retried after the authenticated local connection appears');
  assert.equal(requests.some(row => row.method === 'POST' && row.path === `/local-ocpp/v1/connection-details/${CHARGER}`), false);
  assert.equal(provider.localOcppStatus().available, true);
  assert.equal(provider.localOcppStatus().controlTransport, 'ocpp');
  assert.equal(f.states.get('setup').intent, null);
  assert.equal(f.current.connectivityMode, 'DualProtocol');
});

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
  const preserveStoppedEvidence = options?.preserveStoppedEvidence === true;
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
    if (action === 'ChangeAvailability') {
      assert.deepEqual(payload, { connectorId: 0, type: 'Operative' });
      physical(listener.control.connectorStatus === 'Unavailable' ? 'Preparing' : listener.control.connectorStatus,
        listener.control.readings.find(row => row.id === 120)?.value ?? 0, listener.control.transaction?.id ?? null);
      return { status: 'Accepted' };
    }
    if (action === 'SetChargingProfile') {
      profiles.set(payload.csChargingProfiles.chargingProfileId, clone(payload.csChargingProfiles));
      if (!preserveStoppedEvidence || listener.control.connectorStatus !== 'SuspendedEVSE') physical('SuspendedEVSE', 0);
      return { status: 'Accepted' };
    }
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
  for (const change of ['fault', 'unplug', 'reconnect', 'app-pause', 'pending-source-clock']) {
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
    if (change === 'pending-source-clock') x.f.streamPending = true;
    if (change === 'app-pause') {
      x.observe({ 48: 0, 96: 52 }); x.f.streamRows = x.f.observations;
    }
    assert.equal(canStart(), false, `${change}: fresh device evidence revokes the queued start without another controller update`);
    assert.deepEqual(x.controller.status(), before, `${change}: the command fence does not require controller reconciliation`);
    x.f.advance(1000);
    x.physical('Preparing', 0, null);
    if (change === 'app-pause') { x.observe({ 48: 16, 96: 0 }); x.f.streamRows = x.f.observations; }
    if (change === 'pending-source-clock') x.f.streamPending = false;
    assert.equal(canStart(), false, `${change}: a recovered connection cannot reuse authorization issued before the interruption`);
  }
});

test('native pending approval waits for the plan and recovers a saved blocked takeover', async t => {
  const x = await nativeAppFixture(t);
  x.physical('Preparing', 0, null); x.observe({ 109: 8, 96: 55, 100: 'B', 120: 0 }); await x.refresh();
  const blocked = await x.controller.update({ enabled: true, plan: x.plan });
  assert.equal(blocked.errorCode, 'takeover-unavailable');
  assert.equal(blocked.appControl.authorizationBlocked, true);
  assert.ok(blocked.automaticTakeover);
  const saved = x.saved; await x.controller.close();
  x.f.advance(1000); x.observe({ 109: 7 }); await x.refresh();
  const restarted = x.createController(saved); t.after(() => restarted.close());
  const waiting = await restarted.update({ enabled: true, plan: x.plan });
  assert.equal(waiting.automaticTakeover, null);
  assert.equal(waiting.appControl.authorizationBlocked, false);
  assert.equal(waiting.errorCode, 'transaction-unconfirmed');
  assert.equal(x.listener.options.canStart(), false, 'Pending approval does not permit charging before its period');
  x.f.advance(x.plan.startAt - x.f.now); x.physical('Preparing', 0, null); await x.refresh();
  const starting = await restarted.update({ enabled: true, plan: x.plan });
  assert.equal(x.listener.options.canStart(), true, 'The open period can approve its own native transaction');
  assert.equal(starting.errorCode, 'transaction-unconfirmed', 'Permission is not proof that charging started');
  assert.deepEqual(x.nativeWrites(), []);
});

test('native startup permission survives pending-approval updates while retaining current-limit instruction clocks', async t => {
  for (const changes of [{ 109: 7 }, { 96: 55 }, { 109: 7, 96: 55 }]) {
    const x = await nativeAppFixture(t, { streaming: true });
    x.physical('Preparing', 0, null); x.observe({ 109: 2, 100: 'B', 120: 0 }); await x.refresh();
    x.f.streamRows = x.f.observations; x.provider.startStreaming();
    const immediate = { ...x.plan, startAt: AT, periods: [{ startAt: AT, endAt: null }] };
    await x.controller.update({ enabled: true, plan: immediate });
    const canStart = x.listener.options.canStart;
    assert.equal(canStart(), true);
    x.f.advance(1000); x.observe(changes); x.f.streamRows = x.f.observations;
    assert.equal(canStart(), true, 'Waiting for local approval cannot revoke the approval being supplied');
    x.f.advance(1000); x.observe({ 109: 3, 96: 0 }); x.f.streamRows = x.f.observations;
    assert.equal(canStart(), true, 'Normal approval completion is not an external instruction');
    // Both native app commands can land between authorization checks. Their
    // current-setting source clock still invalidates the earlier permission.
    x.f.advance(1000); x.observe({ 48: 0, 96: 52 }); x.f.streamRows = x.f.observations;
    x.f.advance(1000); x.observe({ 48: 16, 96: 0 }); x.f.streamRows = x.f.observations;
    assert.equal(canStart(), false, 'A Stop/Resume sequence cannot reuse permission from before those instructions');
  }
});

test('pending native approval preserves de-authentication, faults, manual pause, RFID and cloud restrictions', async t => {
  for (const [changes, status] of [[{ 109: 8 }, 'Preparing'], [{ 109: 5, 96: 56 }, 'Faulted'],
    [{ 31: false }, 'Preparing'], [{ 48: 0, 96: 52 }, 'Preparing']]) {
    const x = await nativeAppFixture(t, { streaming: true });
    x.physical('Preparing', 0, null); x.observe({ 109: 7, 96: 55, 100: 'B', 120: 0 }); await x.refresh();
    x.f.streamRows = x.f.observations; x.provider.startStreaming();
    await x.controller.update({ enabled: true, plan: { ...x.plan, startAt: AT, periods: [{ startAt: AT, endAt: null }] } });
    assert.equal(x.listener.options.canStart(), true);
    x.f.advance(1000); x.observe(changes); x.physical(status, 0, null); x.f.streamRows = x.f.observations;
    assert.equal(x.listener.options.canStart(), false);
  }
  const rfid = await nativeAppFixture(t, { authorizationMode: 'rfid' });
  rfid.physical('Preparing', 0, null); rfid.observe({ 109: 7, 96: 55, 100: 'B', 120: 0 }); await rfid.refresh();
  const blocked = await rfid.controller.update({ enabled: true,
    plan: { ...rfid.plan, startAt: AT, periods: [{ startAt: AT, endAt: null }] } });
  assert.equal(blocked.snapshot.appControl.authorizationBlocked, true);
  assert.equal(rfid.listener.options.canStart(), false);
  const f = fixture(t); f.observations = rfid.f.observations;
  const cloud = f.make(false), snapshot = await cloud.chargerScheduleControl().read();
  assert.equal(snapshot.authorizationBlocked, true, 'Cloud scheduling cannot supply native approval');
});

test('native startup observes transient Stop and de-authorization edges before the next permission check', async t => {
  for (const [id, value, recovered] of [[96, 53, 55], [109, 8, 7]]) {
    const x = await nativeAppFixture(t, { streaming: true });
    x.physical('Preparing', 0, null); x.observe({ 109: 7, 96: 55, 100: 'B', 120: 0 }); await x.refresh();
    x.f.streamRows = x.f.observations; x.provider.startStreaming();
    await x.controller.update({ enabled: true, plan: { ...x.plan, startAt: AT, periods: [{ startAt: AT, endAt: null }] } });
    assert.equal(x.listener.options.canStart(), true);
    x.f.advance(1000); x.observe({ [id]: value }); x.f.streamRows = x.f.observations;
    x.f.emitObservation({ id, value, previousValue: recovered, measuredAt: x.f.now,
      previousMeasuredAt: AT, receivedAt: x.f.now });
    x.f.advance(1000); x.observe({ [id]: recovered }); x.f.streamRows = x.f.observations;
    x.f.emitObservation({ id, value: recovered, previousValue: value, measuredAt: x.f.now,
      previousMeasuredAt: x.f.now - 1000, receivedAt: x.f.now });
    assert.equal(x.listener.options.canStart(), false, 'A transient restriction requires a fresh controller decision');
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

test('production native pre-write guard fences newly received Easee app evidence without sending a profile', async t => {
  const x = await nativeAppFixture(t), snapshot = await x.refresh();
  x.f.advance(1000); x.observe({ 31: false, 96: 53 }); await x.refresh();
  const { ocppPauseInstruction } = await import('../src/charging/ocpp.js');
  const instruction = ocppPauseInstruction({ profileId: 81, transactionId: 7, now: x.f.now, startAt: AT + 40 * 60_000 });
  await assert.rejects(x.adapter.install(instruction, snapshot), { code: 'control-revoked' });
  assert.equal(x.nativeWrites().length, 0);
});

test('production economic handover confirms an already stopped charger without inventing a new physical transition', async t => {
  const x = await nativeAppFixture(t, { preserveStoppedEvidence: true }), { f, controller } = x;
  x.observe({ 31: true, 48: 0, 96: 52, 109: 2 }); x.physical('SuspendedEVSE', 0); await x.refresh();
  f.advance(2000);
  const prior = await controller.update({ enabled: false, plan: x.plan });
  let result = await controller.update({ enabled: true, takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'confirmed', result.reason); assert.equal(result.appControl.stopped, false);
  assert.equal(result.phase, 'paused'); assert.equal(result.pauseConfirmed, true);
  assert.equal(result.snapshot.powerAt, AT); assert.equal(result.snapshot.statusAt, AT);
  assert.equal(result.owned.pauseRequestedAt, undefined);
  f.advance(5000);
  const revised = { ...x.plan, startAt: x.plan.startAt - 30_000,
    periods: [{ startAt: x.plan.startAt - 30_000, endAt: null }] };
  result = await controller.update({ enabled: true, plan: revised });
  assert.equal(result.phase, 'paused'); assert.equal(result.pauseConfirmed, true);
  assert.equal(result.snapshot.powerAt, AT, 'A current composite confirms the restriction; it does not refresh held meter data');
  assert.equal(result.owned.startAt, revised.startAt);
  assert.equal(result.owned.pauseRequestedAt, undefined, 'An existing stop cannot identify a vehicle');
  assert.equal(writes(f).filter(row => row.path.endsWith('/commands/resume_charging')).length, 1);
});

test('economic replanning preserves a selected identification pause through the production local command queue', async t => {
  const x = await nativeAppFixture(t), { f, adapter } = x;
  let identification = null;
  const controller = adapter.createController({ clock: () => f.now, canControl: () => true,
    getIdentification: () => identification });
  t.after(() => controller.close());
  const immediate = { ...x.plan, startAt: AT, periods: [{ startAt: AT, endAt: null }] };
  const initial = await controller.update({ enabled: true, plan: immediate });
  const connectedAt = initial.session.connectedAt;
  f.advance(1000); x.physical();
  identification = { id: 'local-queue-identification', connectedAt, phase: 'pausing', pauseUntil: f.now + 90_000 };
  const item = { association: adapter.scope, controller, identification, controls: { enabled: true },
    request: { scope: `${adapter.scope}:${connectedAt}`, sessionId: `${adapter.scope}:${connectedAt}` }, plan: immediate };
  const context = { chargers: { charger1: item }, closed: false };
  const fence = sourceId => ChargingRuntime.prototype.fenceChangedCommands.call(context, f.now, sourceId);
  fence('charger1');
  const entered = deferred(), release = deferred();
  const nativeRequest = f.nativeRequest;
  f.nativeRequest = async (...args) => { entered.resolve(); await release.promise; return nativeRequest(...args); };
  const work = controller.update({ enabled: true, plan: immediate });
  item.reconcileFlight = work;
  await entered.promise;
  assert.equal(controller.status().pending.action, 'install');
  for (const minutes of [20, 21, 22]) {
    item.plan = { ...immediate, periods: [{ startAt: AT, endAt: AT + minutes * 60_000 },
      { startAt: AT + 2 * 3600_000, endAt: null }] };
    fence();
  }
  f.nativeRequest = nativeRequest; release.resolve();
  const result = await work;
  assert.equal(item.reconcileAgain, undefined, 'Economic updates must not abort the independent native instruction');
  assert.equal(result.errorCode, null); assert.equal(result.ownsInstruction, true);
  assert.equal(result.pauseConfirmed, true); assert.equal(result.owned.startAt, identification.pauseUntil);
  assert.equal(x.nativeWrites().filter(row => row.action === 'SetChargingProfile').length, 1);
  assert.equal(result.snapshot.connectorStatus, 'SuspendedEVSE'); assert.equal(result.snapshot.powerKw, 0);
});

test('production native cleanup remains local when supplemental Easee cloud evidence is unavailable', async t => {
  const x = await nativeAppFixture(t);
  await x.controller.update({ enabled: true, plan: x.plan });
  x.f.cloudOffline = true; x.f.advance(61_000);
  const view = await x.controller.update({ enabled: false });
  assert.equal(view.phase, 'off'); assert.equal(view.handoverConfirmed, true);
  assert.equal(x.profiles.size, 0); assert.equal(view.snapshot.appControl, null);
});

test('native startup permission survives missing cloud evidence but a newly observed pause revokes it', async t => {
  const x = await nativeAppFixture(t);
  x.physical('Preparing', 0, null);
  const baseline = await x.refresh();
  x.adapter.setStartPermission(baseline, { until: x.f.now + 5 * 60_000, guard: () => true });
  assert.equal(x.listener.options.canStart(), true);
  x.f.cloudOffline = true; x.f.advance(61_000); x.physical('Preparing', 0, null);
  const missing = await x.refresh();
  assert.equal(missing.appControl, null);
  assert.equal(missing.instructionRevision, baseline.instructionRevision);
  assert.equal(x.listener.options.canStart(), true, 'Cloud disappearance cannot cancel unexpired local permission');
  x.f.cloudOffline = false;
  const repeated = await x.refresh();
  assert.equal(repeated.instructionRevision, baseline.instructionRevision);
  assert.equal(x.listener.options.canStart(), true, 'The same source observations do not become a new instruction on recovery');
  x.f.advance(1000); x.observe({ 48: 0, 96: 52 }); await x.refresh();
  assert.equal(x.listener.options.canStart(), false, 'A real later pause still fences the issued permission');
});

test('a locally reported external transaction stop fences startup immediately during a cloud outage', async t => {
  const x = await nativeAppFixture(t);
  x.f.cloudOffline = true; x.f.advance(61_000); x.physical('Preparing', 0, null);
  const before = await x.refresh();
  assert.equal(before.appControl, null);
  x.adapter.setStartPermission(before, { until: x.f.now + 60_000, guard: () => true });
  assert.equal(x.listener.options.canStart(), true);
  x.f.advance(1000);
  const nativeStop = { transactionId: 7, at: x.f.now, receivedAt: x.f.now, reason: 'Remote' };
  x.listener.control = { ...x.listener.control, nativeStop };
  assert.equal(x.listener.options.canStart(), false);
  const after = await x.adapter.read();
  assert.equal(after.instructionRevision, before.instructionRevision + 1);
  assert.deepEqual(after.nativeStop, nativeStop);
});

test('native local takeover enables an unavailable connector without cloud access and confirms local readback', async t => {
  const x = await nativeAppFixture(t);
  x.f.cloudOffline = true; x.f.advance(61_000); x.physical('Unavailable', 0, null);
  const snapshot = await x.refresh(), before = x.f.events.length, commands = [];
  x.f.nativeRequest = async (action, payload, options) => {
    assert.equal(options.guard(), true);
    assert.equal(options.beforeSend(), true);
    commands.push({ action, payload });
    x.f.advance(1000); x.physical('Preparing', 0, null);
    return { status: 'Accepted' };
  };
  const writes = [];
  const result = await x.adapter.takeover(snapshot, { guard: () => true, beforeWrite: value => writes.push(value) });
  assert.equal(result.connectorStatus, 'Preparing');
  assert.equal(result.appControl, null);
  assert.deepEqual(commands, [{ action: 'ChangeAvailability', payload: { connectorId: 0, type: 'Operative' } }]);
  assert.deepEqual(writes, [{ local: true }]);
  assert.equal(x.f.events.slice(before).some(event => event.type === 'http'), false, 'Local takeover performs no required cloud request');
});

test('a newer streamed resume prevents an older REST zero-current pause from forcing cloud takeover', async t => {
  const x = await nativeAppFixture(t, { streaming: true });
  x.observe({ 48: 0, 96: 52 }); await x.refresh();
  const olderPause = x.f.observations;
  x.f.advance(1000); x.observe({ 48: 16, 96: 0 }); x.f.streamRows = x.f.observations;
  x.f.observations = olderPause; x.provider.startStreaming();
  const snapshot = await x.refresh(), before = x.f.events.length;
  assert.equal(snapshot.appControl.stopped, false);
  const result = await x.adapter.takeover(snapshot, { guard: () => true });
  assert.equal(result.appControl.stopped, false);
  assert.equal(x.f.events.slice(before).some(event => event.type === 'http'), false);
  x.f.streamConnected = false;
  await x.adapter.read(); // Losing the stream may expose the older REST cache.
  x.f.cloudOffline = true; x.f.advance(61_000); x.physical('Preparing', 0, null);
  const missing = await x.refresh(), afterLoss = x.f.events.length;
  assert.equal(missing.appControl, null);
  await x.adapter.takeover(missing, { guard: () => true });
  assert.equal(x.f.events.slice(afterLoss).some(event => event.type === 'http'), false,
    'An old REST pause cannot regain authority when the newer resumed stream disappears');
});

test('native local takeover does not turn a rejected enable command into confirmed authority', async t => {
  const x = await nativeAppFixture(t);
  x.f.cloudOffline = true; x.f.advance(61_000); x.physical('Unavailable', 0, null);
  const snapshot = await x.refresh();
  x.f.nativeRequest = async () => ({ status: 'Rejected' });
  await assert.rejects(x.adapter.takeover(snapshot, { guard: () => true }), { code: 'availability-rejected' });
  assert.equal(x.listener.control.connectorStatus, 'Unavailable');
});

test('a new local Stop during cloud confirmation of our enable still revokes the takeover', async t => {
  const x = await nativeAppFixture(t, { streaming: true });
  x.observe({ 31: false, 96: 0 }); x.f.streamRows = x.f.observations; x.provider.startStreaming();
  const snapshot = await x.refresh();
  x.f.nativeRequest = async (action, payload, options) => {
    assert.equal(action, 'ChangeAvailability');
    assert.equal(options.beforeSend(), true);
    x.f.advance(1000); x.observe({ 31: true }); x.f.streamRows = x.f.observations;
    x.physical('Preparing', 0, null);
    x.listener.control = { ...x.listener.control,
      nativeStop: { transactionId: 7, at: x.f.now, receivedAt: x.f.now, reason: 'Remote' } };
    return { status: 'Accepted' };
  };
  await assert.rejects(x.adapter.takeover(snapshot, { guard: () => true }), { code: 'control-revoked' });
  assert.equal((await x.adapter.read()).nativeStop.reason, 'Remote');
});

test('newer REST app evidence fences a profile even when the stream still holds an older enabled value', async t => {
  const x = await nativeAppFixture(t, { streaming: true });
  x.f.streamRows = x.f.observations; x.provider.startStreaming();
  const snapshot = await x.refresh();
  x.f.advance(1000); x.observe({ 31: false, 96: 53 }); await x.refresh();
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
  await controller.update({ enabled: false });
  f.advance(1000);
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

test('production OCPP handover confirms an advanced native resume clock behind its local dispatch', async t => {
  const x = await nativeAppFixture(t), { f, controller } = x;
  x.observe({ 31: true, 48: 0, 96: 53, 109: 2 }); x.physical('SuspendedEVSE', 0); await x.refresh();
  f.advance(61_400); f.commandSourceAt = f.now - 1400;
  x.physical('SuspendedEVSE', 0); await x.refresh();
  const immediate = { id: 'source-clock-resume', startAt: f.now, periods: [{ startAt: f.now, endAt: null }], feasible: true };
  const prior = await controller.update({ enabled: false, plan: immediate });
  const result = await controller.update({ enabled: true, takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'confirmed'); assert.equal(result.phase, 'released');
  assert.equal(result.appControl.stopped, false); assert.equal(result.manual, null);
  assert.equal(result.appControl.stopAt, f.now - 1400, 'OCPP preserves the native source clock behind local dispatch');
  assert.equal(result.takeoverPending, null);
  assert.equal(writes(f).filter(row => row.path.endsWith('/commands/resume_charging')).length, 1);
  const restarted = x.createController(x.saved); t.after(() => restarted.close());
  await restarted.update({ enabled: true, plan: immediate });
  assert.equal(writes(f).filter(row => row.path.endsWith('/commands/resume_charging')).length, 1,
    'The confirmed handover is retained without repeating the resume');
});

test('ordinary native reads await admitted status time without publishing a cached false disconnect', { timeout: 2000 }, async t => {
  const x = await nativeAppFixture(t), { f, listener, adapter } = x;
  const waiting = deferred(), sourceAt = f.now + 138, receivedAt = f.now;
  listener.control = { ...listener.control, connectorStatus: 'SuspendedEVSE', timestamp: sourceAt, receivedAt };
  listener.onClockWait = () => waiting.resolve();
  let settled = false;
  const reading = adapter.read().then(value => { settled = true; return value; });
  await waiting.promise;
  assert.equal(settled, false); assert.equal(listener.controlSnapshot(), null);
  f.advance(138);
  const result = await reading;
  assert.equal(result.online, true); assert.equal(result.connectorStatus, 'SuspendedEVSE');
  assert.equal(result.statusAt, sourceAt); assert.equal(result.statusReceivedAt, receivedAt);
  assert.equal(result.readAt, f.now, 'Read completion uses the actual clock after the wait');
});

test('ordinary native clock wait remains abortable and does not renew for a new future status', { timeout: 2000 }, async t => {
  for (const change of ['abort', 'provider-close', 'later-future-status']) {
    const x = await nativeAppFixture(t), { f, listener, adapter } = x;
    const waiting = deferred(), signal = new AbortController(); let waits = 0;
    listener.control = { ...listener.control, timestamp: f.now + 138 };
    listener.onClockWait = () => { waits++; waiting.resolve(); };
    const reading = adapter.read({ signal: signal.signal });
    await waiting.promise;
    if (change === 'abort') { signal.abort(); await assert.rejects(reading); }
    else if (change === 'provider-close') {
      const rejected = assert.rejects(reading); await x.provider.close(); await rejected;
    }
    else {
      f.advance(138); listener.control = { ...listener.control, timestamp: f.now + 500 };
      assert.equal((await reading).online, false, 'Unknown remains unknown when another future status supersedes the waited status');
    }
    assert.equal(waits, 1, 'The read never extends its wait for a newer timestamp');
  }
});

test('ordinary native clock wait retains newer stream Stop and connection identity', { timeout: 2000 }, async t => {
  for (const change of ['native-stop', 'reconnect']) {
    const x = await nativeAppFixture(t, { streaming: true }), { f, listener, adapter } = x;
    f.streamRows = f.observations; x.provider.startStreaming();
    const original = await adapter.read(), waiting = deferred();
    listener.control = { ...listener.control, timestamp: f.now + 138 };
    listener.onClockWait = () => waiting.resolve();
    const reading = adapter.read(); await waiting.promise; f.advance(138);
    if (change === 'native-stop') { x.observe({ 48: 0, 96: 53 }); f.streamRows = f.observations; }
    else listener.control = { ...listener.control, connectionId: 'replacement-fixture-connection' };
    const after = await reading;
    if (change === 'native-stop') {
      assert.equal(after.appControl.stopped, true); assert.equal(after.appControl.stopAt, f.now);
    } else assert.notEqual(after.connectionId, original.connectionId);
    assert.equal(x.nativeWrites().length, 0, 'Waiting for a read grants no command permission');
  }
});

test('production OCPP handover waits for admitted status clock skew without replaying Resume', async t => {
  const x = await nativeAppFixture(t), { f, controller, listener } = x;
  x.observe({ 31: true, 48: 0, 96: 53, 109: 2 }); x.physical('SuspendedEVSE', 0); await x.refresh();
  f.advance(1000); x.physical('SuspendedEVSE', 0); await x.refresh();
  const immediate = { id: 'clock-skew-resume', startAt: f.now, periods: [{ startAt: f.now, endAt: null }], feasible: true };
  const prior = await controller.update({ enabled: false, plan: immediate });
  const waiting = deferred(), sourceAt = f.now + 138, receivedAt = f.now;
  listener.onClockWait = ms => { assert.equal(ms, 138); waiting.resolve(); };
  f.beforeRequest = ({ path, method }) => {
    if (method === 'POST' && path.endsWith('/commands/resume_charging'))
      listener.control = { ...listener.control, connectorStatus: 'Charging', timestamp: sourceAt, receivedAt };
  };
  const updating = controller.update({ enabled: true, takeover: prior.takeover.token });
  await waiting.promise;
  assert.equal(listener.controlSnapshot(), null, 'Future status remains unavailable during the read-only wait');
  f.advance(138);
  const result = await updating;
  assert.equal(result.takeover.state, 'confirmed', result.reason); assert.equal(result.phase, 'released');
  assert.equal(result.takeoverPending, null); assert.equal(result.manual, null);
  assert.equal(result.snapshot.statusAt, sourceAt); assert.equal(listener.control.receivedAt, receivedAt);
  assert.equal(writes(f).filter(row => row.path.endsWith('/commands/resume_charging')).length, 1);
});

test('status clock wait preserves newer native Stop and connection fences after one Resume', async t => {
  for (const interruption of ['native-stop', 'new-connection']) {
    const x = await nativeAppFixture(t), { f, controller, listener } = x;
    x.observe({ 31: true, 48: 0, 96: 53, 109: 2 }); x.physical('SuspendedEVSE', 0); await x.refresh();
    f.advance(1000); x.physical('SuspendedEVSE', 0); await x.refresh();
    const immediate = { id: 'interrupted-clock-wait', startAt: f.now, periods: [{ startAt: f.now, endAt: null }], feasible: true };
    const prior = await controller.update({ enabled: false, plan: immediate }), waiting = deferred();
    listener.onClockWait = () => waiting.resolve();
    f.beforeRequest = ({ path, method }) => {
      if (method === 'POST' && path.endsWith('/commands/resume_charging'))
        listener.control = { ...listener.control, connectorStatus: 'Charging', timestamp: f.now + 138 };
    };
    const updating = controller.update({ enabled: true, takeover: prior.takeover.token });
    await waiting.promise; f.advance(138);
    if (interruption === 'native-stop') {
      x.observe({ 48: 0, 96: 53 }); x.physical('SuspendedEVSE', 0);
    } else listener.control = { ...listener.control, connectionId: 'new-fixture-connection' };
    const result = await updating;
    assert.equal(result.takeover.state, 'blocked', interruption);
    assert.ok(x.saved.takeoverPending, 'Unconfirmed handover remains durable');
    assert.equal(writes(f).filter(row => row.path.endsWith('/commands/resume_charging')).length, 1);
    assert.equal(x.nativeWrites().some(row => row.action === 'ClearChargingProfile'), false);
  }
});

test('production OCPP handover waits for separately delivered native resume current after the reason clears', async t => {
  const x = await nativeAppFixture(t), { f, controller } = x;
  x.observe({ 31: true, 48: 0, 96: 53, 109: 2 }); x.physical('SuspendedEVSE', 0); await x.refresh();
  f.advance(61_400); f.commandSourceAt = f.now - 1400; f.resumeCurrentDelayReads = 2;
  x.physical('SuspendedEVSE', 0); await x.refresh();
  const immediate = { id: 'asynchronous-native-resume', startAt: f.now, periods: [{ startAt: f.now, endAt: null }], feasible: true };
  const prior = await controller.update({ enabled: false, plan: immediate });
  const result = await controller.update({ enabled: true, takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'confirmed'); assert.equal(result.phase, 'released');
  assert.equal(result.appControl.stopped, false); assert.equal(result.snapshot.limits.dynamicChargerA, 16);
  assert.equal(writes(f).filter(row => row.path.endsWith('/commands/resume_charging')).length, 1);
  assert.equal(result.takeoverPending, null);
});

test('production takeover preserves restrictive positive current limits and fences a newer native instruction', async t => {
  const x = await nativeAppFixture(t), { f, controller } = x;
  x.observe({ 31: true, 48: 8, 96: 53, 109: 2 }); await x.refresh();
  let prior = await controller.update({ enabled: false, plan: x.plan });
  let result = await controller.update({ enabled: true, takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'confirmed'); assert.equal(result.errorCode, null);
  assert.equal(x.nativeWrites().some(row => row.action === 'ChangeAvailability'), true);
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


test('native allowance uses supplemental cloud receipt and phase clocks rather than repeated OCPP status', async t => {
  const { f, adapter, physical } = await nativeAppFixture(t, { equalizer: true });
  const first = await adapter.read(), initial = easeeAllowanceStatus({ telemetry: adapter.normalize(first), now: f.now });
  assert.equal(initial.allowanceA, 16); assert.equal(initial.source, 'easee-equalizer');
  assert.equal(initial.receivedAt, AT); assert.deepEqual(initial.sourceTimes, [AT, AT, AT]);
  f.advance(5000); physical();
  const reread = await adapter.read(), repeated = easeeAllowanceStatus({ telemetry: adapter.normalize(reread), now: f.now });
  assert.equal(repeated.receivedAt, AT); assert.deepEqual(repeated.sourceTimes, [AT, AT, AT]);
  assert.equal(reread.statusAt, f.now);
  f.cloudOffline = true; f.advance(300_001); physical();
  const stale = await adapter.read();
  assert.equal(easeeAllowanceStatus({ telemetry: adapter.normalize(stale), now: f.now }).mode, 'unknown');
});
