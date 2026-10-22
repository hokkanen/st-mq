import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentArguments, synchronizationTimeout, validateStandby, waitForStandby } from '../scripts/lib/paired-deployment.js';

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
