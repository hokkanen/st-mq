import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ocppInstallation, ocppConnectionDetails, createOcppSetup, ocppHandoverRequirements,
  assertOcppHandoverReady } from '../src/acquisition/easee-ocpp-setup.js';
import { easeeLocalConnectionDisplay } from '../chart/provider-status.js';

const AT = Date.parse('2026-09-24T12:00:00Z');
function config(overrides = {}) {
  return { dataDir: '/unused-fixture-directory', connections: { easee: { charger_id: 'fixture-charger', local_ocpp: {
    server_url: 'ws://192.0.2.10:9001/ocpp', password: 'fixture-setup-pass', authorization_tags: ['fixture-tag'], ...overrides,
  } } }, topology: 'standalone', pair: {} };
}
function fixture(overrides = {}) {
  const installation = overrides.installation ?? ocppInstallation(config());
  let saved = overrides.saved ?? null, current = overrides.current ?? null, now = AT, active = true;
  const calls = [], controlCalls = [], listener = { listening: true, ready: true, available: false, error: null };
  let count = 0, stateWrites = 0;
  const state = { get: () => structuredClone(saved), set: value => { stateWrites++; saved = structuredClone(value); } };
  const api = {
    async get() { calls.push('get'); if (!current) throw Object.assign(new Error('fixture-not-found'), { status: 404 }); return structuredClone(current); },
    async observations() { calls.push('observations'); return { observations: [[80, 344], [141, 1], [250, true]]
      .map(([id, value]) => ({ id, value, timestamp: new Date(now).toISOString() })) }; },
    async store(body) {
      calls.push('store');
      assert(saved?.intent, 'Intent is durable before store');
      current = { version: `fixture-version-${++count}`, connectivityMode: body.connectivityMode,
        websocketConnectionArgs: { ...body.websocketConnectionArgs, url: `${body.websocketConnectionArgs.url}/${encodeURIComponent(body.chargePointId)}` }, basicAuth: { username: body.chargePointId, password: body.basicAuthPassword } };
      return { version: current.version };
    },
    async apply(body) { calls.push('apply'); assert.equal(body.version, current.version); assert.equal(saved.intent.version, body.version); },
  };
  const make = () => createOcppSetup({ prepareControl: async target => { controlCalls.push(['prepare', target]); },
    commitControl: async target => { controlCalls.push(['commit', target]); },
    installation, state, api, listener: { status: () => ({ ...listener }) }, clock: () => now, canControl: () => active });
  const setup = make();
  return { setup, make, api, calls, controlCalls, listener, state, installation,
    advance: ms => { now += ms; }, revoke: () => { active = false; },
    get saved() { return saved; }, get stateWrites() { return stateWrites; }, get current() { return current; }, set current(value) { current = value; } };
}
const foreign = () => ({ version: 'fixture-foreign-version', connectivityMode: 'DualProtocol',
  websocketConnectionArgs: { url: 'ws://192.0.2.99:9001/ocpp', caCertificate: null, caCertificateDomain: null },
  basicAuth: { username: 'fixture-foreign-charger', password: 'fixture-foreign-password' } });

test('setup waits for durable admission and rechecks authority and remote configuration before mutating the charger', async t => {
  for (const change of ['none', 'authority', 'foreign']) await t.test(change, async () => {
    const f = fixture(), set = f.state.set;
    let release, started;
    const began = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    let first = true;
    f.state.set = async value => { if (first) { first = false; started(); await pending; } set(value); };
    const running = f.setup.runDue();
    await began;
    assert.equal(f.saved, null);
    assert.ok(!f.calls.includes('store') && !f.calls.includes('apply'));
    if (change === 'authority') f.revoke();
    if (change === 'foreign') f.current = foreign();
    release(); await running;
    if (change === 'none') assert.equal(f.setup.status().state, 'connecting');
    else assert.ok(!f.calls.includes('store') && !f.calls.includes('apply'), 'Waiting cannot retain obsolete setup authority.');
    await f.setup.close();
  });
});

test('standalone omitted or empty URL detects a local address with the configured listener port', () => {
  for (const omitted of [false, true]) {
    const source = config({ server_url: '', port: 9012, host: '192.0.2.10' });
    if (omitted) delete source.connections.easee.local_ocpp.server_url;
    const before = structuredClone(source);
    const installation = ocppInstallation(source, { detectAddress: ({ host }) => {
      assert.equal(host, '192.0.2.10'); return '192.0.2.10';
    } });
    assert.equal(installation.endpoint, 'ws://192.0.2.10:9012/ocpp');
    assert.equal(installation.endpointSource, 'detected');
    assert.deepEqual(source, before, 'Detection is runtime state, not a configuration edit');
  }
  const defaultPort = ocppInstallation(config({ server_url: '' }), { detectAddress: () => '192.0.2.10' });
  assert.equal(defaultPort.endpoint, 'ws://192.0.2.10:9001/ocpp');
  const httpPort = ocppInstallation(config({ server_url: '', port: 80 }), { detectAddress: () => '192.0.2.10' });
  assert.equal(httpPort.endpoint, 'ws://192.0.2.10/ocpp');
});

test('explicit standalone and paired virtual endpoints never depend on host detection', () => {
  const detectAddress = () => assert.fail('Address detection must not run for explicit or paired endpoints');
  const explicit = ocppInstallation(config(), { detectAddress });
  assert.equal(explicit.endpoint, 'ws://192.0.2.10:9001/ocpp');
  assert.equal(explicit.endpointSource, 'configured');
  const paired = config({ server_url: '' });
  paired.topology = 'pair'; paired.pair = { vip: { address: '192.0.2.30' } };
  for (const server_url of ['', 'ws://192.0.2.30:9001/ocpp']) {
    paired.connections.easee.local_ocpp.server_url = server_url;
    const installation = ocppInstallation(paired, { detectAddress });
    assert.equal(installation.endpoint, 'ws://192.0.2.30:9001/ocpp');
    assert.equal(installation.endpointSource, 'pair-vip');
  }
  paired.connections.easee.local_ocpp.server_url = explicit.endpoint;
  assert.throws(() => ocppInstallation(paired, { detectAddress }), /virtual/);
});

test('failed address detection prevents automatic setup without cloud operations', async () => {
  const installation = ocppInstallation(config({ server_url: '' }), { detectAddress: () => '' });
  const f = fixture({ installation }); await f.setup.runDue();
  assert.equal(installation.endpointSource, null);
  assert.equal(f.setup.status().reason, 'endpoint-required');
  assert.equal(f.setup.status({ includeEndpoint: true }).endpoint, null);
  assert.deepEqual(f.calls, []);
});

test('detected address remains stable until configuration is reapplied and owned setup follows the new address', async () => {
  let address = '192.0.2.10', detections = 0;
  const source = config({ server_url: '' });
  const detectAddress = () => { detections++; return address; };
  const f = fixture({ installation: ocppInstallation(source, { detectAddress }) });
  await f.setup.runDue();
  address = '192.0.2.20'; f.advance(300_001); await f.setup.runDue();
  assert.equal(detections, 1);
  assert.equal(f.current.websocketConnectionArgs.url, 'ws://192.0.2.10:9001/ocpp/fixture-charger');
  // An explicit integration change can hand native control back first.
  await f.setup.deactivate();
  assert.equal(f.current.connectivityMode, 'OcppOff');
  assert.equal(f.saved.ownedFingerprint, null);
  const next = fixture({ installation: ocppInstallation(source, { detectAddress }), saved: f.saved, current: f.current });
  await next.setup.runDue();
  assert.equal(detections, 2);
  assert.equal(next.current.websocketConnectionArgs.url, 'ws://192.0.2.20:9001/ocpp/fixture-charger');
  assert.equal(next.setup.status({ includeEndpoint: true }).endpoint, 'ws://192.0.2.20:9001/ocpp');
  assert.equal(next.setup.status().endpoint, undefined);
  assert.doesNotMatch(JSON.stringify(next.saved), /192\.0\.2|fixture-charger|fixture-setup-pass/);
});

test('remembering an inactive connection neither authorizes external edits nor creates a disable obligation', async () => {
  const f = fixture(); await f.setup.runDue(); await f.setup.deactivate();
  const saved = structuredClone(f.saved);
  assert.match(saved.appliedFingerprint, /^[a-f0-9]{64}$/);
  const disabled = fixture({ installation: ocppInstallation(config({ enabled: false })), saved, current: f.current });
  await disabled.setup.runDue();
  assert.equal(disabled.setup.status().state, 'disabled');
  assert.deepEqual(disabled.calls, []);
  const installation = ocppInstallation(config({ server_url: '' }), { detectAddress: () => '192.0.2.20' });
  for (const field of ['address', 'authentication', 'mode']) {
    const current = structuredClone(f.current);
    if (field === 'address') current.websocketConnectionArgs.url = 'ws://192.0.2.99:9001/ocpp/fixture-charger';
    if (field === 'authentication') current.basicAuth.password = 'fixture-external-pass';
    if (field === 'mode') current.connectivityMode = 'DualProtocol';
    const restarted = fixture({ installation, saved, current });
    await restarted.setup.runDue();
    assert.equal(restarted.setup.status().reason, 'foreign-configuration', field);
    assert.deepEqual(restarted.calls, ['get'], field);
  }
});

test('a detected endpoint does not authorize replacing a foreign connection on retry', async () => {
  const installation = ocppInstallation(config({ server_url: '' }), { detectAddress: () => '192.0.2.10' });
  const f = fixture({ installation, current: foreign() });
  await f.setup.runDue(); f.advance(300_001); await f.setup.runDue();
  assert.equal(f.setup.status().reason, 'foreign-configuration');
  assert(!f.calls.includes('store'));
  await f.setup.adopt(f.setup.status().revision);
  assert.equal(f.current.websocketConnectionArgs.url, 'ws://192.0.2.10:9001/ocpp/fixture-charger');
});

test('native setup stores and applies a version, waits for local readings, and avoids repeat writes on restart', async () => {
  const f = fixture(); await f.setup.runDue();
  assert.equal(f.setup.status().state, 'connecting');
  assert.equal(f.calls.filter(x => x === 'store').length, 1); assert.equal(f.calls.filter(x => x === 'apply').length, 1);
  f.listener.available = true; assert.equal(f.setup.status().state, 'ready');
  f.advance(30001); const restarted = f.make(); await restarted.runDue();
  assert.equal(restarted.status().state, 'ready');
  assert.equal(f.calls.filter(x => x === 'store').length, 1); assert.equal(f.calls.filter(x => x === 'apply').length, 1);
  const publicData = JSON.stringify({ status: restarted.status(), saved: f.saved });
  for (const privateValue of [f.installation.password, f.installation.identity, f.installation.endpoint, 'fixture-tag'])
    assert(!publicData.includes(privateValue), 'Status/history omit raw installation identity, endpoint, tags and secrets');
});

test('fresh authenticated native readings adopt a matching connection without replaying setup after state loss', async () => {
  const original = fixture(); await original.setup.runDue();
  const f = fixture({ current: original.current });
  f.listener.available = true;
  await f.setup.runDue();
  assert.equal(f.setup.status().state, 'ready');
  assert.deepEqual(f.calls, ['get']);
  assert.equal(f.saved.ownedFingerprint, original.saved.ownedFingerprint);
  assert.equal(f.saved.appliedFingerprint, original.saved.appliedFingerprint);
  assert.equal(f.saved.lastAppliedAt, null, 'Observed installation is not a new application command');
});

test('matching stored connection without saved setup or authenticated readings still completes initial commissioning', async () => {
  const original = fixture(); await original.setup.runDue();
  const f = fixture({ current: original.current });
  await f.setup.runDue();
  assert.equal(f.setup.status().state, 'connecting');
  assert.equal(f.calls.filter(call => call === 'store').length, 0);
  assert.equal(f.calls.filter(call => call === 'apply').length, 1);
});

test('missing endpoint, authorization, credentials, listener or authority cannot program a charger', async () => {
  for (const [change, reason] of [[{ endpoint: '' }, 'endpoint-required'], [{ authorization_tags: [] }, 'authorization-tags-required'],
    [{ password: '' }, 'credentials-unavailable']]) {
    const f = fixture({ installation: { ...ocppInstallation(config()), ...change } }); await f.setup.runDue();
    assert.equal(f.setup.status().reason, reason); assert.deepEqual(f.calls, []);
  }
  const f = fixture(); f.listener.ready = false; f.listener.listening = false; await f.setup.runDue();
  assert.equal(f.setup.status().reason, 'listener-unavailable'); assert.deepEqual(f.calls, []);
  f.listener.ready = true; f.revoke(); await f.setup.runDue(); assert.deepEqual(f.calls, []);
});

test('listener recovery clears setup warnings before the healthy cloud deadline', async () => {
  const f = fixture(); await f.setup.runDue();
  f.listener.available = true;
  f.advance(30001); await f.setup.runDue();
  assert.equal(f.setup.status().state, 'ready');
  const saved = structuredClone(f.saved), calls = [...f.calls];
  Object.assign(f.listener, { ready: false, listening: false, available: false });
  assert.equal(f.setup.status().reason, 'listener-unavailable');
  await f.setup.runDue();
  Object.assign(f.listener, { ready: true, listening: true, available: true });
  await f.setup.runDue();
  const status = f.setup.status();
  assert.equal(status.state, 'ready');
  assert.equal(status.reason, null);
  const display = easeeLocalConnectionDisplay({ localOcpp: { ...f.listener, setup: status } },
    { now: AT + 30001, formatTime: value => new Date(value).toISOString() });
  assert.equal(display.setup.label, 'Setup complete');
  assert.equal(display.readings.label, 'Available');
  assert.match(display.setup.detail, /Next connection check/);
  assert.doesNotMatch(display.setup.detail, /cannot accept|Next setup attempt/);
  assert.deepEqual(f.saved, saved, 'Status recovery does not rewrite setup state or deadlines');
  assert.deepEqual(f.calls, calls, 'Recovery does not request or reapply cloud configuration');
});

test('installed setup restart displays a scheduled check separately from current local readings', async () => {
  const f = fixture(); await f.setup.runDue();
  f.listener.available = true; f.advance(30001); await f.setup.runDue();
  const setup = f.make(), calls = [...f.calls], controls = structuredClone(f.controlCalls), saved = structuredClone(f.saved), stateWrites = f.stateWrites;
  f.listener.ready = false;
  assert.equal(setup.status().state, 'waiting-listener');
  Object.assign(f.listener, { ready: true, available: false, connected: false, transportConnected: false, connectionGeneration: 0 });
  assert.equal(setup.status().state, 'checking');
  assert.equal(setup.status().reason, null);
  Object.assign(f.listener, { connected: true, transportConnected: true });
  assert.equal(setup.status().state, 'checking', 'Current socket evidence does not replace a settings check');
  f.listener.available = true;
  assert.equal(setup.status().state, 'checking');
  f.api.get = async () => { f.calls.push('unexpected-cloud-read'); throw new Error('Synthetic offline cloud'); };
  await setup.runDue();
  assert.equal(setup.status().state, 'checking');
  assert.equal(setup.status().reason, null);
  assert.equal(setup.status().busy, false);
  assert.equal(setup.status().canAdopt, false);
  assert.equal(setup.status().revision, null);
  assert.equal(setup.status().lastSuccessAt, saved.lastSuccessAt, 'Local availability cannot renew the earlier cloud confirmation clock');
  assert.equal(setup.status().nextAttemptAt, saved.nextAttemptAt);
  const display = easeeLocalConnectionDisplay({ localOcpp: { ...f.listener, setup: setup.status() } },
    { now: AT + 30001, formatTime: value => new Date(value).toISOString() });
  assert.equal(display.setup.label, 'Waiting for settings check');
  assert.equal(display.readings.label, 'Available');
  assert.match(display.setup.detail, /Next settings check/);
  assert.doesNotMatch(display.setup.detail, /Checking.*settings|confirmed/);
  assert.deepEqual(f.saved, saved, 'Reporting current readiness performs no durable write');
  assert.equal(f.stateWrites, stateWrites);
  assert.deepEqual(f.calls, calls);
  assert.deepEqual(f.controlCalls, controls, 'Reporting does not acquire or hand away native control');
});

test('installed current local readings retain known cloud failure and foreign-configuration diagnostics', async t => {
  for (const kind of ['rate-limit', 'foreign']) await t.test(kind, async () => {
    const f = fixture(); await f.setup.runDue();
    f.listener.available = true; f.advance(30001); await f.setup.runDue();
    const controls = structuredClone(f.controlCalls), writes = f.calls.filter(value => ['store', 'apply'].includes(value));
    f.advance(3600001);
    if (kind === 'rate-limit') f.api.get = async () => {
      f.calls.push('rate-limited-get');
      throw Object.assign(new Error('fixture-rate-limit'), { status: 429, retryAfterMs: 120000 });
    };
    else f.current = foreign();
    await f.setup.runDue();
    const status = f.setup.status(), saved = structuredClone(f.saved), calls = [...f.calls];
    assert.equal(status.state, kind === 'rate-limit' ? 'retrying' : 'blocked');
    assert.equal(status.reason, kind === 'rate-limit' ? 'cloud-rate-limit' : 'foreign-configuration');
    assert.equal(status.canAdopt, kind === 'foreign');
    assert.equal(f.listener.available, true);
    await f.setup.runDue();
    assert.deepEqual(f.saved, saved); assert.deepEqual(f.calls, calls);
    assert.deepEqual(f.controlCalls, controls);
    assert.deepEqual(f.calls.filter(value => ['store', 'apply'].includes(value)), writes);
    const restart = f.make();
    assert.equal(restart.status().state, 'checking', 'Saved timing and current readings cannot confirm unverified settings');
    assert.equal(restart.status().reason, null, 'An earlier unsaved reason is not guessed after restart');
    assert.equal(restart.status().nextAttemptAt, saved.nextAttemptAt);
    assert.equal(restart.status().lastSuccessAt, saved.lastSuccessAt);
    const display = easeeLocalConnectionDisplay({ localOcpp: { ...f.listener, setup: restart.status() } },
      { now: AT + 3630002, formatTime: value => new Date(value).toISOString() });
    assert.equal(display.setup.label, 'Waiting for settings check');
    assert.equal(display.readings.label, 'Available');
    assert.doesNotMatch(display.setup.detail, /confirmed|Setup complete/);
    await restart.runDue();
    assert.deepEqual(f.saved, saved); assert.deepEqual(f.calls, calls);
    assert.deepEqual(f.controlCalls, controls);
  });
});

test('current local availability cannot complete uninstalled, pending or actively checked setup', async t => {
  for (const kind of ['absent', 'intent', 'adoption', 'in-flight']) await t.test(kind, async () => {
    const f = fixture();
    if (kind !== 'absent') {
      await f.setup.runDue(); f.listener.available = true; f.advance(30001); await f.setup.runDue();
    }
    f.listener.available = true;
    if (kind === 'intent') f.state.set({ ...f.saved, intent: {
      fingerprint: f.saved.ownedFingerprint, base: f.saved.ownedFingerprint, version: f.current.version } });
    if (kind === 'adoption') f.state.set({ ...f.saved, adoptionFingerprint: f.saved.ownedFingerprint });
    const saved = structuredClone(f.saved), calls = [...f.calls], controls = structuredClone(f.controlCalls), setup = f.make();
    if (kind === 'in-flight') {
      f.advance(3600001);
      let release; const gate = new Promise(resolve => { release = resolve; });
      const get = f.api.get;
      f.api.get = async () => { await gate; return get(); };
      const running = setup.runDue();
      assert.equal(setup.status().state, 'checking'); assert.equal(setup.status().busy, true);
      release(); await running;
      assert.equal(setup.status().state, 'ready');
    } else {
      assert.equal(setup.status().state, 'checking');
      assert.deepEqual(f.saved, saved); assert.deepEqual(f.calls, calls); assert.deepEqual(f.controlCalls, controls);
    }
    await setup.close(); await f.setup.close();
  });
});

test('listener recovery with applied setup still waits for fresh local readings', async () => {
  const f = fixture(); await f.setup.runDue();
  f.listener.ready = false;
  assert.equal(f.setup.status().state, 'waiting-listener');
  f.listener.ready = true;
  assert.equal(f.setup.status().state, 'connecting');
  assert.equal(f.setup.status().reason, 'waiting-connection');
  f.listener.available = true;
  assert.equal(f.setup.status().state, 'ready');
});

test('listener readiness reports specific storage and authorization failures without inventing port failures', async () => {
  for (const [listening, error, reason] of [
    [false, null, 'listener-unavailable'],
    [true, 'listener-unavailable', 'listener-unavailable'],
    [false, 'transaction-state-unavailable', 'transaction-state-unavailable'],
    [false, 'incompatible-transaction-state', 'incompatible-transaction-state'],
    [true, 'authorization-unavailable', 'authorization-unavailable'],
    [true, null, 'listener-not-ready'],
    [true, 'fixture-private-error', 'listener-not-ready'],
  ]) {
    const f = fixture(); Object.assign(f.listener, { ready: false, listening, error });
    await f.setup.runDue();
    assert.equal(f.setup.status().reason, reason);
    assert.deepEqual(f.calls, []);
    assert.equal(f.saved, null);
  }
});

test('listener recovery preserves unresolved apply failures, retry backoff and foreign configuration', async () => {
  for (const foreignConnection of [false, true]) {
    const f = fixture(foreignConnection ? { current: foreign() } : {});
    if (!foreignConnection) f.api.apply = async () => {
      throw Object.assign(new Error('fixture-rate-limit'), { status: 429, retryAfterMs: 120000 });
    };
    await f.setup.runDue();
    const before = f.setup.status(), saved = structuredClone(f.saved), calls = [...f.calls];
    f.listener.ready = false;
    assert.equal(f.setup.status().state, 'waiting-listener');
    f.listener.ready = true; f.listener.available = true;
    await f.setup.runDue();
    assert.deepEqual(f.setup.status(), before, 'Fresh readings do not confirm failed or foreign setup');
    assert.deepEqual(f.saved, saved);
    assert.deepEqual(f.calls, calls);
  }
});

test('foreign connection requires reviewed adoption and changed readback invalidates that authorization', async () => {
  const f = fixture({ current: foreign() }); await f.setup.runDue();
  const revision = f.setup.status().revision;
  assert.equal(f.setup.status().canAdopt, true); assert.match(revision, /^[a-f0-9]{64}$/);
  await assert.rejects(f.setup.adopt('0'.repeat(64)), /ocpp-setup-changed/);
  f.current = { ...f.current, basicAuth: { ...f.current.basicAuth, username: 'fixture-changed' } };
  await assert.rejects(f.setup.adopt(revision), /ocpp-setup-changed/);
  assert(!f.calls.includes('store'));
  f.advance(300001); await f.setup.runDue(); await f.setup.adopt(f.setup.status().revision);
  assert.equal(f.setup.status().state, 'connecting'); assert.equal(f.calls.filter(x => x === 'store').length, 1);
});

test('manual configuration changing during prerequisite lookup or between store/apply is preserved', async () => {
  const f = fixture(), original = f.api.observations;
  f.api.observations = async (...args) => { const result = await original(...args); f.current = foreign(); return result; };
  await f.setup.runDue(); assert(!f.calls.includes('store')); assert(!f.calls.includes('apply'));
  assert.equal(f.current.version, 'fixture-foreign-version');
  const g = fixture(), store = g.api.store;
  g.api.store = async (...args) => { const result = await store(...args); g.current = foreign(); return result; };
  await g.setup.runDue(); assert(!g.calls.includes('apply')); assert.equal(g.current.version, 'fixture-foreign-version');
});

test('a lost store response recovers its stored version without storing again', async () => {
  const f = fixture(), store = f.api.store;
  f.api.store = async (...args) => { await store(...args); throw new Error('fixture-lost-response'); };
  await f.setup.runDue(); assert.equal(f.setup.status().state, 'retrying');
  assert.equal(f.saved.intent.version, null); f.advance(30001);
  const restart = f.make(); await restart.runDue();
  assert.equal(restart.status().state, 'connecting');
  assert.equal(f.calls.filter(x => x === 'store').length, 1); assert.equal(f.calls.filter(x => x === 'apply').length, 1);
});

test('a lost apply response retries only its known version and honors persisted backoff', async () => {
  const f = fixture(), apply = f.api.apply;
  f.api.apply = async (...args) => { await apply(...args); throw Object.assign(new Error('fixture-rate-limit'), { status: 429, retryAfterMs: 120000 }); };
  await f.setup.runDue(); const count = f.calls.length;
  const restart = f.make(); await restart.runDue(); assert.equal(f.calls.length, count);
  f.advance(120001); f.api.apply = apply; await restart.runDue();
  assert.equal(f.calls.filter(x => x === 'store').length, 1); assert.equal(f.calls.filter(x => x === 'apply').length, 2);
  assert.equal(restart.status().state, 'connecting');
});

test('restart exposes saved setup clocks while preserving failure backoff and unknown failure reason', async () => {
  const f = fixture();
  await f.setup.runDue();
  f.listener.available = true;
  f.advance(30001);
  await f.setup.runDue();
  assert.equal(f.setup.status().state, 'ready');
  const lastSuccessAt = f.saved.lastSuccessAt;
  assert.equal(lastSuccessAt, AT + 30001);
  f.listener.available = false;
  f.advance(3600001);
  const get = f.api.get;
  f.api.get = async () => {
    f.calls.push('rate-limited-get');
    throw Object.assign(new Error('fixture-rate-limit'), { status: 429, retryAfterMs: 120000 });
  };
  await f.setup.runDue();
  assert.equal(f.setup.status().reason, 'cloud-rate-limit');
  const saved = structuredClone(f.saved), calls = [...f.calls];
  const restarted = f.make();
  const status = restarted.status();
  assert.equal(status.state, 'checking');
  assert.equal(status.reason, null, 'An unrecorded earlier failure reason remains unknown.');
  assert.equal(status.busy, false);
  assert.equal(status.nextAttemptAt, saved.nextAttemptAt, 'The original durable retry deadline stays visible.');
  assert.equal(status.lastSuccessAt, lastSuccessAt, 'Status reads preserve the original successful setup clock.');
  const display = easeeLocalConnectionDisplay({ localOcpp: { ...f.listener, setup: status } },
    { now: AT + 3630002, formatTime: at => `fixture-clock-${at}` });
  assert.ok(display.setup.detail.includes(`Next settings check fixture-clock-${saved.nextAttemptAt}`));
  assert.deepEqual(f.saved, saved, 'Rendering status never writes saved setup state.');
  await restarted.runDue();
  assert.deepEqual(f.calls, calls, 'No cloud read, Store or Apply runs before the saved failure deadline.');
  assert.deepEqual(f.saved, saved);
  assert.equal(restarted.status().nextAttemptAt, saved.nextAttemptAt);
  f.advance(120001);
  f.api.get = get;
  await restarted.runDue();
  assert.ok(f.calls.length > calls.length, 'The ordinary setup retry runs when its deadline arrives.');
  await restarted.close();
  await f.setup.close();
});

test('authority revocation during cloud reads and close during pending reads prevent all later mutations', async () => {
  const f = fixture(), observations = f.api.observations;
  f.api.observations = async (...args) => { const result = await observations(...args); f.revoke(); return result; };
  await f.setup.runDue(); assert(!f.calls.includes('store')); assert(!f.calls.includes('apply'));
  const g = fixture(); let release, begun;
  const started = new Promise(resolve => { begun = resolve; });
  g.api.get = async ({ signal }) => { begun(); await new Promise(resolve => { release = resolve; }); assert(signal.aborted); throw new Error('fixture-aborted'); };
  const running = g.setup.runDue(); await started; const closing = g.setup.close(); release(); await Promise.all([running, closing]);
  assert(!g.calls.includes('store')); assert.equal(g.saved, null);
});

test('durable intent failure and malformed setup state never reach a cloud mutation', async () => {
  const f = fixture(); f.state.set = () => { throw new Error('fixture-storage-failure'); };
  await f.setup.runDue(); assert.equal(f.setup.status().reason, 'storage-unavailable'); assert(!f.calls.includes('store'));
  const g = fixture({ saved: { version: 0, scope: 'fixture-old-format' } }); await g.setup.runDue();
  assert.equal(g.setup.status().reason, 'incompatible-setup-state'); assert.deepEqual(g.calls, []);
});

test('Wi-Fi, firmware and online prerequisites reject contradictory or future source reports', async () => {
  for (const [id, value, reason] of [[80, 343, 'firmware-required'], [141, 0, 'wifi-required'], [250, false, 'charger-offline']]) {
    const f = fixture(), read = f.api.observations;
    f.api.observations = async (...args) => { const payload = await read(...args); payload.observations.push({ id, value, timestamp: new Date(AT).toISOString() }); return payload; };
    await f.setup.runDue(); assert.equal(f.setup.status().reason, reason); assert(!f.calls.includes('store'));
  }
  const f = fixture(), read = f.api.observations;
  f.api.observations = async (...args) => { const p = await read(...args); p.observations.find(row => row.id === 141).timestamp = new Date(AT + 1).toISOString(); return p; };
  await f.setup.runDue(); assert.equal(f.setup.status().reason, 'wifi-required'); assert(!f.calls.includes('store'));
});

test('GET uses the current native ConnectionDetailsDto and rejects POST-shaped or incomplete readback', () => {
  assert.equal(ocppConnectionDetails(foreign()).basicAuth.username, 'fixture-foreign-charger');
  assert.throws(() => ocppConnectionDetails({ version: 'fixture-version' }), /invalid-cloud-response/);
  assert.throws(() => ocppConnectionDetails({ ...foreign(), chargePointId: 'fixture-post-field' }), /invalid-cloud-response/);
});

test('disabling local OCPP applies OcppOff only to an owned connection and re-enabling reuses it', async () => {
  const f = fixture(); await f.setup.runDue();
  const offInstallation = { ...f.installation, enabled: false, password: '' };
  const off = createOcppSetup({ prepareControl: async () => {}, commitControl: async () => {}, installation: offInstallation, state: f.state, api: f.api,
    listener: { status: () => ({ ready: false }) }, clock: () => AT + 60000, canControl: () => true });
  await off.runDue(); assert.equal(off.status().state, 'disabled'); assert.equal(f.current.connectivityMode, 'OcppOff');
  assert.equal(f.current.basicAuth.password, f.installation.password); assert.equal(f.saved.ownedFingerprint, null);
  const count = f.calls.length; await off.runDue(); assert.equal(f.calls.length, count);
  f.advance(60001); const on = f.make(); await on.runDue();
  assert.equal(f.current.connectivityMode, 'DualProtocol'); assert.equal(on.status().state, 'connecting');
});

test('disabling does not turn off a foreign connection or apply before failed storage recovers', async () => {
  const f = fixture(); await f.setup.runDue(); f.current = foreign();
  const calls = f.calls.length;
  const off = createOcppSetup({ prepareControl: async () => {}, commitControl: async () => {}, installation: { ...f.installation, enabled: false }, state: f.state, api: f.api,
    listener: { status: () => ({ ready: false }) }, clock: () => AT + 60000, canControl: () => true });
  await off.runDue(); assert.equal(off.status().reason, 'foreign-configuration'); assert.equal(off.status().canAdopt, false);
  assert.deepEqual(f.calls.slice(calls), ['get']); assert.equal(f.current.connectivityMode, 'DualProtocol');
});

test('paired endpoint and credentials remain stable across nodes while incompatible takeover settings fail', () => {
  const primary = config({ password: '', server_url: '' });
  primary.topology = 'pair'; primary.pair = { token: 'fixture-shared-pairing-token-for-derivation', vip: { address: '192.0.2.30' } };
  const peer = structuredClone(primary); peer.dataDir = '/fixture-other-node'; peer.pair.listenHost = '192.0.2.20';
  assert.equal(ocppInstallation(primary).endpoint, 'ws://192.0.2.30:9001/ocpp');
  assert.equal(ocppInstallation(primary).password, ocppInstallation(peer).password);
  const requirements = ocppHandoverRequirements(primary);
  assert.doesNotThrow(() => assertOcppHandoverReady(peer, null, requirements));
  const disabledPeer = structuredClone(peer); disabledPeer.connections.easee.local_ocpp.enabled = false;
  assert.throws(() => assertOcppHandoverReady(disabledPeer, null, requirements), /ocpp-handover-incompatible/);
  peer.connections.easee.local_ocpp.authorization_tags = ['fixture-other-tag'];
  assert.throws(() => assertOcppHandoverReady(peer, null, requirements), /ocpp-handover-incompatible/);
  assert.throws(() => assertOcppHandoverReady(primary, null, null), /ocpp-handover-incompatible/);
  primary.connections.easee.local_ocpp.server_url = 'ws://192.0.2.10:9001/ocpp';
  assert.throws(() => ocppInstallation(primary), /virtual/);
  primary.connections.easee.local_ocpp.server_url = ''; primary.connections.easee.local_ocpp.host = '127.0.0.1';
  assert.throws(() => ocppInstallation(primary), /virtual/);
});

test('standalone credentials are durable and private and cannot silently transfer to another charger', t => {
  const dir = mkdtempSync(join(tmpdir(), 'stmq-ocpp-credential-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const c = config({ password: '' }); c.dataDir = dir;
  const first = ocppInstallation(c, { createCredential: true });
  assert(first.password.length === 20); assert.equal(statSync(join(dir, 'easee-ocpp-credentials.json')).mode & 0o777, 0o600);
  assert.equal(ocppInstallation(c, { createCredential: true }).password, first.password);
  c.connections.easee.local_ocpp.enabled = false;
  assert.equal(ocppInstallation(c, { createCredential: true }).password, first.password,
    'Disabled native control retains its credential for owned profile cleanup');
  const before = readFileSync(join(dir, 'easee-ocpp-credentials.json'));
  c.connections.easee.charger_id = 'fixture-different-charger';
  assert.throws(() => ocppInstallation(c, { createCredential: true }), /credentials-unavailable/);
  assert.deepEqual(readFileSync(join(dir, 'easee-ocpp-credentials.json')), before);
  writeFileSync(join(dir, 'easee-ocpp-credentials.json'), '{');
  assert.throws(() => ocppInstallation(c, { createCredential: true }), /credentials-unavailable/);
});

test('disabled paired OCPP retains compatibility checks while native restoration is outstanding', () => {
  const source = config({ enabled: false, password: '', server_url: '' });
  source.topology = 'pair'; source.pair = { token: 'fixture-shared-pairing-token-for-derivation', vip: { address: '192.0.2.30' } };
  const installation = ocppInstallation(source), empty = { version: 1, scope: installation.scope,
    ownedFingerprint: null, appliedFingerprint: null, adoptionFingerprint: null, intent: null,
    lastAppliedAt: null, lastSuccessAt: null, nextAttemptAt: null, failures: 0 };
  assert.equal(ocppHandoverRequirements(source, empty), null);
  for (const outstanding of [{ ...empty, ownedFingerprint: 'a'.repeat(64) },
    { ...empty, intent: { fingerprint: 'b'.repeat(64), base: null, version: null } }]) {
    const requirement = ocppHandoverRequirements(source, outstanding);
    assert.match(requirement.digest, /^[a-f0-9]{64}$/);
    assert.doesNotThrow(() => assertOcppHandoverReady(source, null, requirement), 'Peer preflight precedes final journal transfer');
    assert.doesNotThrow(() => assertOcppHandoverReady(source, outstanding, requirement));
    assert.throws(() => assertOcppHandoverReady(source, outstanding, null), /ocpp-handover-incompatible/);
    for (const different of [{ enabled: true }, { port: 9011 }, { password: 'fixture-other-pass' },
      { authorization_mode: 'plug-and-charge' }, { authorization_tags: ['other-fixture-tag'] }]) {
      const peer = structuredClone(source); Object.assign(peer.connections.easee.local_ocpp, different);
      assert.throws(() => assertOcppHandoverReady(peer, null, requirement), /ocpp-handover-incompatible/);
    }
  }
  assert.throws(() => ocppHandoverRequirements(source, { ...empty, version: 999 }), /ocpp-handover-incompatible/);
});
