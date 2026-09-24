import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ocppInstallation, ocppConnectionDetails, createOcppSetup, ocppHandoverRequirements,
  assertOcppHandoverReady } from '../src/acquisition/easee-ocpp-setup.js';

const AT = Date.parse('2026-09-24T12:00:00Z');
function config(overrides = {}) {
  return { dataDir: '/unused-fixture-directory', connections: { easee: { charger_id: 'fixture-charger', local_ocpp: {
    server_url: 'ws://192.0.2.10:9001/ocpp', password: 'fixture-setup-pass', authorization_tags: ['fixture-tag'], ...overrides,
  } } }, pairing: { enabled: false } };
}
function fixture(overrides = {}) {
  const installation = overrides.installation ?? ocppInstallation(config());
  let saved = overrides.saved ?? null, current = overrides.current ?? null, now = AT, active = true;
  const calls = [], listener = { ready: true, available: false };
  let count = 0;
  const state = { get: () => structuredClone(saved), set: value => { saved = structuredClone(value); } };
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
  const make = () => createOcppSetup({ prepareControl: async () => {}, commitControl: async () => {}, installation, state, api, listener: { status: () => ({ ...listener }) }, clock: () => now, canControl: () => active });
  const setup = make();
  return { setup, make, api, calls, listener, state, installation,
    advance: ms => { now += ms; }, revoke: () => { active = false; },
    get saved() { return saved; }, get current() { return current; }, set current(value) { current = value; } };
}
const foreign = () => ({ version: 'fixture-foreign-version', connectivityMode: 'DualProtocol',
  websocketConnectionArgs: { url: 'ws://192.0.2.99:9001/ocpp', caCertificate: null, caCertificateDomain: null },
  basicAuth: { username: 'fixture-foreign-charger', password: 'fixture-foreign-password' } });

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

test('missing endpoint, authorization, credentials, listener or authority cannot program a charger', async () => {
  for (const [change, reason] of [[{ endpoint: '' }, 'endpoint-required'], [{ authorization_tags: [] }, 'authorization-tags-required'],
    [{ password: '' }, 'credentials-unavailable']]) {
    const f = fixture({ installation: { ...ocppInstallation(config()), ...change } }); await f.setup.runDue();
    assert.equal(f.setup.status().reason, reason); assert.deepEqual(f.calls, []);
  }
  const f = fixture(); f.listener.ready = false; await f.setup.runDue();
  assert.equal(f.setup.status().reason, 'listener-unavailable'); assert.deepEqual(f.calls, []);
  f.listener.ready = true; f.revoke(); await f.setup.runDue(); assert.deepEqual(f.calls, []);
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
  primary.pairing = { enabled: true, token: 'fixture-shared-pairing-token-for-derivation', vip: { address: '192.0.2.30' } };
  const peer = structuredClone(primary); peer.dataDir = '/fixture-other-node'; peer.pairing.listenHost = '192.0.2.20';
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
  source.pairing = { enabled: true, token: 'fixture-shared-pairing-token-for-derivation', vip: { address: '192.0.2.30' } };
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
