import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { createOcppSetup, ocppInstallation } from '../src/acquisition/easee-ocpp-setup.js';
import { ocppHandoverHooks } from '../src/pairing/ocpp.js';

const AT = Date.parse('2026-09-24T12:00:00Z');
function configuration() {
  return { topology: 'pair', pair: { token: 'fixture-disable-pair-token-at-least-32-characters', vip: { address: '192.0.2.30' } },
    connections: { easee: { charger_id: 'fixture-disable-charger', local_ocpp: { authorization_tags: ['fixture-tag'] } } } };
}
async function ownedFixture() {
  const config = configuration(), installation = ocppInstallation(config), calls = [], listener = { ready: true, available: true };
  let saved = null, current = null, now = AT, version = 0, active = true;
  const state = { get: () => structuredClone(saved), set: value => { saved = structuredClone(value); } };
  const api = {
    async get() { calls.push({ action: 'get' }); if (!current) throw { status: 404 }; return structuredClone(current); },
    async observations() {
      calls.push({ action: 'observations' });
      return { observations: [[80, 344], [141, 1], [250, true]].map(([id, value]) => ({ id, value, timestamp: new Date(AT).toISOString() })) };
    },
    async store(body) {
      assert(saved.intent, 'Persist restoration intent before a charger-side write');
      calls.push({ action: 'store', body: structuredClone(body) });
      current = { version: `fixture-version-${++version}`, connectivityMode: body.connectivityMode,
        websocketConnectionArgs: { ...structuredClone(body.websocketConnectionArgs), url: `${body.websocketConnectionArgs.url}/${encodeURIComponent(body.chargePointId)}` },
        basicAuth: { username: body.chargePointId, password: body.basicAuthPassword } };
      return { version: current.version };
    },
    async apply(body) {
      assert.equal(saved.intent.version, body.version, 'Apply only the durably recorded version');
      assert.equal(current.version, body.version);
      calls.push({ action: 'apply', body: structuredClone(body) });
    },
  };
  const make = (enabled = false, hooks = {}) => createOcppSetup({ prepareControl: async () => {}, commitControl: async () => {}, installation: { ...installation, enabled,
    ...(!enabled ? { password: '', endpoint: '', authorization_tags: [] } : {}) }, state, api,
    listener: { status: () => enabled ? listener : { ready: false, available: false } },
    clock: () => now, canControl: () => active, ...hooks });
  const on = make(true); await on.runDue(); now += 60_000; calls.length = 0;
  return { config, installation, calls, state, api, make, on, listener,
    get saved() { return saved; }, get current() { return current; }, set current(value) { current = structuredClone(value); },
    get now() { return now; }, advance: ms => { now += ms; }, revoke: () => { active = false; } };
}
const writes = f => f.calls.filter(call => call.action === 'store' || call.action === 'apply');
const changedByOperator = current => ({ ...structuredClone(current), version: 'fixture-manual-version',
  basicAuth: { username: 'fixture-manual-charger', password: 'fixture-manual-password' } });

test('disable applies immediately after a healthy enabled check instead of waiting an hour with no listener', async () => {
  const f = await ownedFixture(); await f.on.runDue();
  assert.equal(f.on.status().state, 'ready');
  assert.equal(f.saved.nextAttemptAt, f.now + 3600_000);
  f.calls.length = 0;
  const off = f.make(); await off.runDue();
  assert.equal(off.status().state, 'disabled');
  assert.deepEqual(writes(f).map(call => call.action), ['store', 'apply']);
  assert.equal(f.current.connectivityMode, 'OcppOff');
});

test('disable recovers a lost store response after restart without rewriting preserved connection settings', async () => {
  const f = await ownedFixture(), original = structuredClone(f.current), store = f.api.store;
  f.api.store = async body => { await store(body); throw new Error('fixture-lost-store-response'); };
  const off = f.make(); await off.runDue();
  assert.equal(off.status().state, 'retrying'); assert.equal(f.saved.intent.version, null);
  assert.equal(f.current.connectivityMode, 'OcppOff');
  assert.deepEqual(f.current.basicAuth, original.basicAuth);
  assert.deepEqual(f.current.websocketConnectionArgs, original.websocketConnectionArgs);
  const attempted = f.calls.length, restart = f.make(); await restart.runDue();
  assert.equal(f.calls.length, attempted, 'Interrupted disable retains its failure backoff');
  f.advance(30_001); await restart.runDue();
  assert.equal(restart.status().state, 'disabled');
  assert.deepEqual(writes(f).map(call => call.action), ['store', 'apply']);
  assert.equal(f.saved.ownedFingerprint, null); assert.equal(f.saved.intent, null);
  const complete = f.calls.length; await restart.runDue(); assert.equal(f.calls.length, complete);
});

test('disable retries the exact stored version after a lost apply reply and retains rate-limit backoff', async () => {
  const f = await ownedFixture(), apply = f.api.apply;
  f.api.apply = async body => { await apply(body); throw Object.assign(new Error('fixture-lost-apply-response'), { status: 429, retryAfterMs: 120_000 }); };
  const off = f.make(); await off.runDue();
  const storedVersion = f.saved.intent.version, attempted = f.calls.length, restart = f.make();
  await restart.runDue(); f.advance(119_999); await restart.runDue(); assert.equal(f.calls.length, attempted);
  f.advance(2); f.api.apply = apply; await restart.runDue();
  assert.equal(restart.status().state, 'disabled');
  assert.deepEqual(writes(f).map(call => call.action), ['store', 'apply', 'apply']);
  assert.deepEqual(f.calls.filter(call => call.action === 'apply').map(call => call.body.version), [storedVersion, storedVersion]);
});

test('foreign changes during disable checks or after an interrupted store are preserved and cannot be adopted while disabled', async () => {
  const f = await ownedFixture(), observations = f.api.observations;
  f.api.observations = async () => { const result = await observations(); f.current = changedByOperator(f.current); return result; };
  const off = f.make(); await off.runDue();
  assert.deepEqual(writes(f), []); assert.equal(f.current.version, 'fixture-manual-version');
  assert.equal(off.status().reason, 'foreign-configuration'); assert.equal(off.status().canAdopt, false);
  const g = await ownedFixture(), store = g.api.store;
  g.api.store = async body => { await store(body); throw new Error('fixture-lost-store-response'); };
  await g.make().runDue(); g.current = changedByOperator(g.current); g.advance(30_001);
  const restart = g.make(); await restart.runDue();
  assert.equal(restart.status().reason, 'foreign-configuration'); assert.equal(restart.status().canAdopt, false);
  assert.deepEqual(writes(g).map(call => call.action), ['store']);
  assert.equal(g.current.version, 'fixture-manual-version');
});

test('disable refuses apply if manual configuration changes after store acknowledgement', async () => {
  const f = await ownedFixture(), store = f.api.store;
  f.api.store = async body => { const result = await store(body); f.current = changedByOperator(f.current); return result; };
  const off = f.make(); await off.runDue();
  assert.deepEqual(writes(f).map(call => call.action), ['store']);
  assert.equal(off.status().reason, 'foreign-configuration');
  assert.equal(f.current.version, 'fixture-manual-version');
});

test('disable requires durable intent and current authority before each charger mutation', async () => {
  const f = await ownedFixture(); f.state.set = () => { throw new Error('fixture-storage-unavailable'); };
  const off = f.make(); await off.runDue();
  assert.equal(off.status().reason, 'storage-unavailable'); assert.deepEqual(writes(f), []);
  const g = await ownedFixture(), store = g.api.store;
  g.api.store = async body => { const result = await store(body); g.revoke(); return result; };
  const revoked = g.make(); await revoked.runDue();
  assert.deepEqual(writes(g).map(call => call.action), ['store']);
  assert.equal(revoked.status().reason, 'authority-revoked');
});

test('disable retains its restoration obligation while Wi-Fi or charger availability is unconfirmed', async () => {
  for (const [id, value, reason] of [[141, 0, 'wifi-required'], [250, false, 'charger-offline']]) {
    const f = await ownedFixture(), observations = f.api.observations, owned = f.saved.ownedFingerprint;
    f.api.observations = async () => {
      const payload = await observations(); payload.observations.find(row => row.id === id).value = value; return payload;
    };
    const off = f.make(); await off.runDue();
    assert.equal(off.status().reason, reason); assert.deepEqual(writes(f), []);
    assert.equal(f.saved.ownedFingerprint, owned);
  }
});

test('disabled paired handover checks its listener before carrying a pending current restoration intent', async t => {
  const f = await ownedFixture(), store = f.api.store;
  f.api.store = async body => { await store(body); throw new Error('fixture-lost-store-response'); };
  await f.make().runDue();
  f.config.connections.easee.local_ocpp.enabled = false;
  const dir = mkdtempSync(join(tmpdir(), 'stmq-ocpp-disable-pair-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Store(join(dir, 'final.sqlite')); t.after(() => db.close());
  db.setState('easee:ocpp-setup', f.saved);
  const before = structuredClone(f.saved); let probes = 0;
  const source = ocppHandoverHooks({ configuration: () => f.config, store: () => db });
  const requirements = source.handoverRequirements(); assert.match(requirements.digest, /^[a-f0-9]{64}$/);
  const target = ocppHandoverHooks({ configuration: () => structuredClone(f.config), store: () => null, probe: async () => { probes++; } });
  await target.prepareHandover(requirements); target.verifyHandover({ dbPath: db.path, requirements });
  assert.equal(probes, 1); assert.deepEqual(db.getState('easee:ocpp-setup'), before);
  const incompatible = structuredClone(f.config); incompatible.connections.easee.charger_id = 'fixture-other-charger';
  const wrong = ocppHandoverHooks({ configuration: () => incompatible, store: () => null });
  assert.throws(() => wrong.verifyHandover({ dbPath: db.path, requirements }), { code: 'ocpp_handover_not_ready' });
  assert.deepEqual(db.getState('easee:ocpp-setup'), before, 'Unrecognized restoration ownership must fail before mutation');
});

test('disable waits for its durable transaction discontinuity hook after verified intent and before apply', async () => {
  const f = await ownedFixture(), apply = f.api.apply;
  let entered, finish, marked = false;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.api.apply = async body => { assert.equal(marked, true, 'Transaction discontinuity must already be durable'); await apply(body); };
  const off = f.make(false, { beforeDisable: async () => {
    assert.equal(f.current.connectivityMode, 'OcppOff');
    assert.equal(f.saved.intent.version, f.current.version);
    assert.match(f.saved.ownedFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(f.calls.at(-1).action, 'get', 'Version is read back immediately before recording the boundary');
    entered(); await new Promise(resolve => { finish = () => { marked = true; resolve(); }; });
  } });
  const disabling = off.runDue(); await waiting;
  assert.deepEqual(writes(f).map(call => call.action), ['store'], 'Stored settings are not applied while durable boundary persistence is pending');
  finish(); await disabling;
  assert.equal(off.status().state, 'disabled'); assert.deepEqual(writes(f).map(call => call.action), ['store', 'apply']);
});

test('failed transaction boundary persistence blocks OcppOff apply and retains restoration for retry', async () => {
  const f = await ownedFixture(), owned = f.saved.ownedFingerprint;
  const off = f.make(false, { beforeDisable: async () => { throw Object.assign(new Error('synthetic boundary storage failure'), { code: 'storage-unavailable' }); } });
  await off.runDue();
  assert.equal(off.status().state, 'retrying'); assert.equal(off.status().reason, 'storage-unavailable');
  assert.deepEqual(writes(f).map(call => call.action), ['store']);
  assert.equal(f.saved.ownedFingerprint, owned); assert.equal(f.saved.intent.version, f.current.version);
  let marked = false; f.advance(30_001);
  const restarted = f.make(false, { beforeDisable: async () => { marked = true; } });
  const apply = f.api.apply;
  f.api.apply = async body => { assert.equal(marked, true); await apply(body); };
  await restarted.runDue();
  assert.equal(restarted.status().state, 'disabled'); assert.deepEqual(writes(f).map(call => call.action), ['store', 'apply']);
});

test('disable rechecks remote ownership after waiting for its durable transaction boundary', async () => {
  const f = await ownedFixture();
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const off = f.make(false, { beforeDisable: async () => { began(); await held; } });
  const pending = off.runDue(); await started;
  f.current = changedByOperator(f.current);
  release(); await pending;
  assert.equal(off.status().reason, 'foreign-configuration');
  assert.deepEqual(writes(f).map(call => call.action), ['store']);
  assert.equal(f.current.basicAuth.username, 'fixture-manual-charger');
});
