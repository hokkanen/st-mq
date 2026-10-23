import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentArguments, synchronizationTimeout, validateStandby, waitForStandby, waitForSynchronizedStandby } from '../scripts/lib/paired-deployment.js';

test('Linux and HA share the same managed default, stopped flag, connection parsing and timeout range', () => {
  assert.deepEqual(deploymentArguments([], '/private/example.json'), { connection: '/private/example.json', stopped: false, apply: false });
  assert.deepEqual(deploymentArguments(['--stopped', '--connection', '/private/example.json'], '/unused'), { connection: '/private/example.json', stopped: true, apply: false });
  assert.equal(synchronizationTimeout(), 900);
  for (const value of [0, -1, 86401, '900', null, 1.2]) assert.throws(() => synchronizationTimeout(value));
  for (const args of [['--stopped', '--stopped'], ['--apply'], ['--connection'], ['--connection', '/one', '--connection', '/two'], ['--unknown']]) assert.throws(() => deploymentArguments(args, '/unused'));
  assert.throws(() => deploymentArguments(['--stopped'], '/unused', { setup: true }));
});

test('shared readiness preserves the originating observation clock and never accepts unknown control authority', async () => {
  let clock = 1000, calls = 0;
  const identity = { role: 'slave', nodeId: 'synthetic-local', pairId: 'synthetic-pair', canControl: false, busy: false, phase: null,
    vip: { owned: false }, peer: { nodeId: 'synthetic-master', role: 'master', reachable: true, lastSeenAt: 9000000 }, sync: { state: 'ready', error: null } };
  assert.throws(() => validateStandby({ ...identity, canControl: undefined }, null, 9000000, true));
  const result = await waitForStandby({ identity, clock: () => clock, timeoutSeconds: 2, verifyRunning: async () => {},
    sleep: async () => { clock += 1000; }, read: async () => ++calls === 1 ? null : { pair: identity, observedAt: 9000000 } });
  assert.equal(result, identity); assert.equal(calls, 2);
});

test('shared readiness propagates transport failures without replaying a poisoned connection', async () => {
  let reads = 0;
  await assert.rejects(waitForStandby({ identity: {}, timeoutSeconds: 1, verifyRunning: async () => {},
    read: async () => { reads++; throw Error('synthetic-uncertain-transport'); } }), /synthetic-uncertain-transport/);
  assert.equal(reads, 1);
});

function runningStandbyFixture() {
  let now = 1000, reads = 0, checks = 0;
  const pair = { role: 'slave', nodeId: 'synthetic-local', pairId: 'synthetic-pair', canControl: false, busy: false, phase: null,
    vip: { owned: false }, peer: { nodeId: 'synthetic-master', role: 'master', reachable: true, lastSeenAt: 9000000 }, sync: { state: 'ready', error: null } };
  const options = { timeoutSeconds: 2, clock: () => now, sleep: async () => { now += 1000; },
    verifyRunning: async () => { checks++; },
    read: async () => { reads++; return { pair, observedAt: 9000000 }; } };
  return { pair, options, reads: () => reads, checks: () => checks };
}

test('running standby wait allows periodic waiting and syncing with the original observation clock', async () => {
  const f = runningStandbyFixture(); let reads = 0;
  const result = await waitForSynchronizedStandby({ ...f.options, read: async () => ({ observedAt: 9000000,
    pair: { ...f.pair, sync: { state: ['waiting', 'syncing', 'ready'][reads++] } } }) });
  assert.equal(result.sync.state, 'ready'); assert.equal(reads, 3); assert.equal(f.checks(), 3);
});

for (const [name, change] of Object.entries({
  master: p => ({ ...p, role: 'master' }), protected: p => ({ ...p, role: 'protected', phase: 'initializing' }),
  authority: p => ({ ...p, canControl: true }), unknownAuthority: p => ({ ...p, canControl: undefined }),
  vip: p => ({ ...p, vip: { owned: true } }), busy: p => ({ ...p, busy: true }),
  phase: p => ({ ...p, phase: 'handover' }), error: p => ({ ...p, error: 'synthetic-error' }),
  recovery: p => ({ ...p, recovery: { pendingRelease: true } }), bootstrap: p => ({ ...p, bootstrapPending: true }),
  node: p => ({ ...p, nodeId: 'synthetic-other' }), pair: p => ({ ...p, pairId: 'synthetic-other' }),
  peer: p => ({ ...p, peer: { ...p.peer, nodeId: 'synthetic-other' } }),
  lostPeer: p => ({ ...p, peer: { ...p.peer, reachable: false } }),
  stalePeer: p => ({ ...p, peer: { ...p.peer, lastSeenAt: 1 } }),
  unknownPeerRole: p => ({ ...p, peer: { ...p.peer, role: 'slave' } }),
  syncError: p => ({ ...p, sync: { state: 'error' } }),
  syncErrorDetail: p => ({ ...p, sync: { state: 'syncing', error: 'synthetic-error' } }),
  unknownSync: p => ({ ...p, sync: { state: 'unknown' } }), missingSync: p => ({ ...p, sync: undefined }),
})) {
  test(`running standby refuses ${name} during synchronization without waiting it away`, async () => {
    const f = runningStandbyFixture(); let reads = 0;
    await assert.rejects(waitForSynchronizedStandby({ ...f.options, read: async () => ({ observedAt: 9000000,
      pair: ++reads === 1 ? { ...f.pair, sync: { state: 'syncing' } } : change(f.pair) }) }));
    assert.equal(reads, 2); assert.equal(f.checks(), 2);
  });
}

test('running standby timeout is bounded and cancellation, unavailable status and service failure are terminal', async () => {
  const f = runningStandbyFixture(); f.pair.sync.state = 'syncing';
  await assert.rejects(waitForSynchronizedStandby(f.options), /Synchronization timed out/);
  assert.equal(f.reads(), 3);
  await assert.rejects(waitForSynchronizedStandby({ ...f.options, read: async () => null }), /Invalid pair/);
  await assert.rejects(waitForSynchronizedStandby({ ...f.options, read: async () => { throw Error('synthetic-transport'); } }), /synthetic-transport/);
  await assert.rejects(waitForSynchronizedStandby({ ...f.options, verifyRunning: async () => { throw Error('synthetic-service-changed'); } }), /synthetic-service-changed/);
  const abort = new AbortController();
  await assert.rejects(waitForSynchronizedStandby({ ...f.options, signal: abort.signal,
    read: async () => { abort.abort(); return { pair: { ...f.pair, sync: { state: 'ready' } }, observedAt: 9000000 }; } }), /cancelled/);
});
