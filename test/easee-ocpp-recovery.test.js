import test from 'node:test';
import assert from 'node:assert/strict';
import { createOcppSetup, ocppInstallation } from '../src/acquisition/easee-ocpp-setup.js';

const AT = Date.parse('2026-10-09T09:00:00Z'), MINUTE = 60_000;

async function fixture(t, { savedPatch = {} } = {}) {
  const installation = ocppInstallation({ topology: 'standalone', connections: { easee: {
    charger_id: 'synthetic-recovery-charger', local_ocpp: { server_url: 'ws://192.0.2.10:9001/ocpp',
      password: 'fixture-setup-pass', authorization_tags: ['fixture-recovery-tag'] },
  } } });
  let now = AT, saved = null, current = null, active = true, coordinator;
  const calls = [], writes = [];
  const local = { listening: true, ready: true, transportConnected: false, connected: false,
    connectionGeneration: 0, available: false, error: null };
  const state = { get: () => structuredClone(saved), async set(value) { saved = structuredClone(value); } };
  const api = {
    async get() {
      calls.push('get');
      if (!current) throw Object.assign(new Error('Synthetic absent configuration'), { status: 404 });
      return structuredClone(current);
    },
    async observations() {
      calls.push('observations');
      return { observations: [[80, 344], [141, 1], [250, true]].map(([id, value]) =>
        ({ id, value, timestamp: new Date(now).toISOString() })) };
    },
    async store(body) {
      calls.push('store');
      assert.ok(saved.intent, 'Initial commissioning persists its intent before the write');
      current = { version: 'synthetic-installed-version', connectivityMode: body.connectivityMode,
        websocketConnectionArgs: { ...body.websocketConnectionArgs,
          url: `${body.websocketConnectionArgs.url}/${encodeURIComponent(body.chargePointId)}` },
        basicAuth: { username: body.chargePointId, password: body.basicAuthPassword } };
      writes.push({ method: 'store', body: structuredClone(body) });
      return { version: current.version };
    },
    async apply(body, options) {
      if (options.isCurrent && !options.isCurrent())
        throw Object.assign(new Error('Synthetic superseded recovery'), { code: 'recovery-cancelled' });
      calls.push('apply');
      assert.equal(body.version, current.version);
      if (saved.intent) assert.equal(saved.intent.version, body.version);
      else {
        assert.equal(typeof options.isCurrent, 'function', 'Recovery must be fenced at HTTP dispatch');
        assert.ok(saved.recovery?.attempts > 0, 'Recovery budget is durable before an uncertain external write');
      }
      writes.push({ method: 'apply', body: structuredClone(body) });
    },
  };
  const make = () => createOcppSetup({ installation, state, api, listener: { status: () => ({ ...local }) },
    clock: () => now, canControl: () => active,
    prepareControl: async target => { calls.push(`prepare:${target}`); },
    commitControl: async target => { calls.push(`commit:${target}`); } });
  coordinator = make();
  await coordinator.runDue();
  assert.ok(saved.ownedFingerprint && saved.appliedFingerprint, 'Fixture must establish ordinary commissioning first');
  await coordinator.close();
  saved = { ...saved, ...savedPatch };
  calls.length = 0; writes.length = 0;
  coordinator = make();
  t.after(() => coordinator.close());
  return { installation, calls, writes, local, state, api,
    get setup() { return coordinator; }, get saved() { return saved; }, get now() { return now; },
    get current() { return current; }, set current(value) { current = value; },
    advance(ms) { now += ms; }, revoke() { active = false; },
    connect({ readings = false, traffic = true } = {}) {
      local.connectionGeneration++;
      Object.assign(local, { transportConnected: true, connected: traffic, available: readings });
    },
    disconnect() { Object.assign(local, { transportConnected: false, connected: false, available: false }); },
    async restart() { await coordinator.close(); coordinator = make(); },
  };
}

const applies = f => f.writes.filter(row => row.method === 'apply').length;
const ownership = f => ({ owned: f.saved.ownedFingerprint, applied: f.saved.appliedFingerprint, intent: f.saved.intent });
async function grace(f) { await f.setup.runDue(); f.advance(5 * MINUTE); await f.setup.runDue(); }

test('commissioned disconnected OCPP gets one guarded apply after five minutes without control handback or rewriting settings', async t => {
  const f = await fixture(t, { savedPatch: { nextAttemptAt: AT + 60 * MINUTE } });
  const before = ownership(f), current = structuredClone(f.current);
  await f.setup.runDue();
  f.advance(5 * MINUTE - 1); await f.setup.runDue();
  assert.equal(applies(f), 0, 'A restart gets a full reconnect grace period');
  f.advance(1); await f.setup.runDue();
  assert.equal(applies(f), 1, 'A healthy hourly cloud poll deadline cannot postpone disconnected recovery');
  assert.deepEqual(ownership(f), before);
  assert.deepEqual(f.current, current);
  assert.equal(f.saved.recovery.attempts, 1);
  assert.equal(f.saved.recovery.lastAttemptAt, f.now);
  assert.equal(f.calls.includes('store'), false);
  assert.equal(f.calls.some(value => value.startsWith('prepare:') || value.startsWith('commit:')), false,
    'Recovery must not drain or switch the existing native charging controller');
});

test('recovery waits fifteen then sixty minutes and its three-attempt bound survives restart', async t => {
  const f = await fixture(t);
  await grace(f);
  assert.equal(applies(f), 1);
  await f.restart(); await f.setup.runDue();
  f.advance(15 * MINUTE - 1); await f.setup.runDue();
  assert.equal(applies(f), 1);
  f.advance(1); await f.setup.runDue();
  assert.equal(applies(f), 2);
  f.advance(60 * MINUTE - 1); await f.setup.runDue();
  assert.equal(applies(f), 2);
  f.advance(1); await f.setup.runDue();
  assert.equal(applies(f), 3);
  assert.equal(f.saved.recovery.attempts, 3);
  await f.restart(); await f.setup.runDue();
  f.advance(24 * 60 * MINUTE); await f.setup.runDue();
  assert.equal(applies(f), 3, 'Restart and time alone cannot replenish the recovery budget');
});

test('a rejected cloud apply preserves local ownership and respects Retry-After before another recovery', async t => {
  const f = await fixture(t), original = f.api.apply, before = ownership(f);
  let attempts = 0;
  f.api.apply = async (...args) => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('Synthetic rate limit'), { status: 429, retryAfterMs: 30 * MINUTE });
    return original(...args);
  };
  await grace(f);
  assert.equal(attempts, 1);
  assert.equal(f.saved.recovery.attempts, 1, 'An uncertain cloud call consumes its reserved attempt');
  assert.deepEqual(ownership(f), before);
  assert.equal(f.current.connectivityMode, 'DualProtocol');
  assert.equal(f.calls.some(value => value === 'store' || value.startsWith('prepare:') || value.startsWith('commit:')), false);
  f.advance(15 * MINUTE); await f.setup.runDue();
  assert.equal(attempts, 1);
  f.advance(15 * MINUTE); await f.setup.runDue();
  assert.equal(attempts, 2);
});

test('cloud read failure cannot erase installed OCPP and real local reconnection resets budget without a cloud reply', async t => {
  const f = await fixture(t);
  await grace(f);
  const before = ownership(f);
  f.api.get = async () => { throw new Error('Synthetic cloud outage'); };
  f.advance(15 * MINUTE); await f.setup.runDue();
  assert.deepEqual(ownership(f), before);
  assert.equal(f.saved.recovery.attempts, 1);
  f.connect();
  await f.setup.runDue();
  assert.equal(f.saved.recovery, null, 'Authenticated OCPP traffic resets the budget independently of cloud readback');
  assert.deepEqual(ownership(f), before);
  assert.equal(applies(f), 1);
});

test('an authenticated socket without complete electrical readings suppresses connection recovery', async t => {
  const f = await fixture(t);
  f.connect();
  await f.setup.runDue();
  f.advance(6 * 60 * MINUTE); await f.setup.runDue();
  assert.equal(f.local.available, false);
  assert.equal(applies(f), 0, 'Missing meter fields must not make a working OCPP transport look disconnected');
});

test('a silent newly authenticated socket suppresses writes but cannot replenish consumed attempts', async t => {
  const f = await fixture(t);
  await grace(f);
  f.connect({ traffic: false });
  f.advance(20 * MINUTE); await f.setup.runDue();
  assert.equal(applies(f), 1);
  assert.equal(f.saved.recovery.attempts, 1);
});

function barrier() {
  let enter, release;
  return { entered: new Promise(resolve => { enter = resolve; }), wait: new Promise(resolve => { release = resolve; }),
    enter: () => enter(), release: () => release() };
}

test('reconnection during asynchronous recovery work cancels stale writes', async t => {
  for (const stage of ['first-get', 'observations', 'reservation', 'final-get', 'dispatch'])
    await t.test(stage, async t => {
      const f = await fixture(t), pending = barrier();
      const pause = async () => { pending.enter(); await pending.wait; };
      if (stage === 'first-get' || stage === 'final-get') {
        const get = f.api.get; let gets = 0;
        f.api.get = async (...args) => {
          gets++;
          const response = await get(...args);
          if (gets === (stage === 'first-get' ? 1 : 2)) await pause();
          return response;
        };
      } else if (stage === 'observations') {
        const observations = f.api.observations;
        f.api.observations = async (...args) => { const result = await observations(...args); await pause(); return result; };
      } else if (stage === 'reservation') {
        const set = f.state.set;
        f.state.set = async value => { if (value.recovery?.attempts === 1) await pause(); await set(value); };
      } else {
        const apply = f.api.apply;
        f.api.apply = async (...args) => { await pause(); return apply(...args); };
      }
      await f.setup.runDue(); f.advance(5 * MINUTE);
      const running = f.setup.runDue();
      await pending.entered;
      f.connect();
      // Even an observed reconnect which closes before the awaiting cloud work
      // completes has superseded that recovery attempt.
      f.disconnect();
      pending.release(); await running;
      assert.equal(applies(f), 0, 'A new authenticated connection generation fences the prior recovery');
      assert.equal(f.calls.includes('store'), false);
    });
});

test('foreign configuration, missing configuration and changed versions cannot be reapplied as recovery', async t => {
  for (const change of ['foreign', 'missing', 'version-race']) await t.test(change, async t => {
    const f = await fixture(t), before = ownership(f);
    await f.setup.runDue();
    if (change === 'foreign') f.current = { ...f.current, basicAuth: { ...f.current.basicAuth, password: 'synthetic-foreign-choice' } };
    if (change === 'missing') f.current = null;
    if (change === 'version-race') {
      const set = f.state.set;
      f.state.set = async value => {
        await set(value);
        if (value.recovery?.attempts === 1) f.current = { ...f.current, version: 'synthetic-newer-external-version' };
      };
    }
    f.advance(5 * MINUTE); await f.setup.runDue();
    assert.equal(applies(f), 0);
    assert.equal(f.calls.includes('store'), false, 'Recovery must not silently recommission a missing or changed connection');
    assert.deepEqual(ownership(f), before);
  });
});

test('foreign and missing cloud configuration keep their polling backoff while recovery is overdue', async t => {
  for (const change of ['foreign', 'missing']) await t.test(change, async t => {
    const f = await fixture(t);
    f.current = change === 'missing' ? null
      : { ...f.current, basicAuth: { ...f.current.basicAuth, password: 'synthetic-foreign-choice' } };
    await grace(f);
    const reads = f.calls.filter(value => value === 'get').length;
    if (change === 'missing') assert.equal(f.setup.status().canAdopt, false,
      'An absent cloud record must not expose a reviewed-adoption action without durable authorization');
    f.advance(5 * MINUTE - 1);
    for (let count = 0; count < 4; count++) await f.setup.runDue();
    assert.equal(f.calls.filter(value => value === 'get').length, reads,
      'An overdue recovery cannot repeatedly bypass a configuration mismatch backoff');
    f.advance(1); await f.setup.runDue();
    assert.equal(f.calls.filter(value => value === 'get').length, reads + 1);
    assert.equal(f.writes.length, 0);
  });
});

test('connection recovery gives the local listener five ready minutes before calling Apply', async t => {
  const f = await fixture(t);
  Object.assign(f.local, { listening: false, ready: false });
  await f.setup.runDue();
  f.advance(10 * MINUTE); await f.setup.runDue();
  assert.equal(f.calls.length, 0, 'A listener which cannot accept a connection cannot justify charger recovery');
  Object.assign(f.local, { listening: true, ready: true });
  await f.setup.runDue();
  assert.equal(applies(f), 0);
  f.advance(5 * MINUTE - 1); await f.setup.runDue();
  assert.equal(applies(f), 0);
  f.advance(1); await f.setup.runDue();
  assert.equal(applies(f), 1);
});

test('loss of authority while recovery is admitted prevents cloud writes', async t => {
  const f = await fixture(t), set = f.state.set;
  f.state.set = async value => { await set(value); if (value.recovery?.attempts === 1) f.revoke(); };
  await grace(f);
  assert.equal(applies(f), 0);
  assert.equal(f.calls.includes('store'), false);
});

test('reviewed adoption can deliberately replace a foreign connection after earlier commissioning', async t => {
  const f = await fixture(t);
  f.current = { ...f.current, basicAuth: { ...f.current.basicAuth, password: 'synthetic-foreign-choice' } };
  await grace(f);
  const review = f.setup.status();
  assert.equal(review.canAdopt, true);
  assert.equal(f.calls.includes('store'), false);
  await f.setup.adopt(review.revision);
  assert.equal(f.setup.status().state, 'connecting');
  assert.equal(f.current.basicAuth.password, f.installation.password);
  assert.equal(f.calls.filter(value => value === 'store').length, 1);
});

test('successful reviewed adoption clears an exhausted recovery budget from the prior setup', async t => {
  const f = await fixture(t, { savedPatch: { recovery: { attempts: 3, lastAttemptAt: AT } } });
  f.current = { ...f.current, basicAuth: { ...f.current.basicAuth, password: 'synthetic-foreign-choice' } };
  await grace(f);
  assert.equal(f.saved.recovery.attempts, 3);
  const review = f.setup.status();
  assert.equal(review.canAdopt, true);
  await f.setup.adopt(review.revision);
  assert.equal(f.setup.status().state, 'connecting');
  assert.equal(f.current.basicAuth.password, f.installation.password);
  assert.equal(f.saved.recovery, null, 'Explicitly completing new setup starts with an unused recovery budget');
});

test('local reconnection resets recovery budget while preserving a known foreign configuration warning', async t => {
  const f = await fixture(t);
  await grace(f);
  f.current = { ...f.current, basicAuth: { ...f.current.basicAuth, password: 'synthetic-foreign-choice' } };
  f.advance(15 * MINUTE); await f.setup.runDue();
  const review = f.setup.status(), before = ownership(f);
  assert.equal(review.state, 'blocked');
  assert.equal(review.reason, 'foreign-configuration');
  assert.equal(f.saved.recovery.attempts, 1);
  f.connect();
  await f.setup.runDue();
  assert.equal(f.saved.recovery, null);
  assert.deepEqual(ownership(f), before);
  assert.equal(f.setup.status().state, 'blocked');
  assert.equal(f.setup.status().reason, 'foreign-configuration');
  assert.equal(f.setup.status().revision, review.revision);
  assert.equal(f.setup.status().canAdopt, true);
  assert.equal(applies(f), 1, 'Local traffic cannot authorize replacing a known foreign configuration');
});

test('malformed persisted recovery cannot authorize setup or recovery', async t => {
  for (const recovery of [{ attempts: 0, lastAttemptAt: AT }, { attempts: 4, lastAttemptAt: AT },
    { attempts: 1, lastAttemptAt: -1 }, { attempts: 1, lastAttemptAt: AT, ignored: true }])
    await t.test(JSON.stringify(recovery), async t => {
      const f = await fixture(t, { savedPatch: { recovery } });
      await grace(f);
      assert.equal(f.setup.status().reason, 'incompatible-setup-state');
      assert.equal(f.calls.length, 0);
    });
});
