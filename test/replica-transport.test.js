import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { validateTransportConfig, publicReplicationError } from '../src/replication/transport.js';
import { ReplicationService } from '../src/replication/service.js';

test('service serializes slow attempts, retries failures, and exposes only sanitized status', async () => {
  let active = 0, peak = 0, attempts = 0;
  const service = new ReplicationService({ dbPath: '/invented/source.sqlite', config: { intervalMs: 5 },
    synchronize: async ({ signal, onPhase }) => {
      active++; peak = Math.max(peak, active); attempts++; onPhase('transferring');
      try {
        await delay(30, null, { signal });
        if (attempts === 1) throw new Error('synthetic confidential external details');
        return { digest: 'synthetic-digest', sourceAt: 1, verifiedAt: 2, generation: 'synthetic-generation', bytes: 512,
          privatePath: 'synthetic confidential internal path' };
      } finally { active--; }
    } });
  service.start(); service.start();
  try {
    for (let i = 0; i < 100 && service.status().lastSuccessAt === null; i++) await delay(5);
    assert.equal(peak, 1);
    assert.ok(attempts >= 2);
    assert.ok(service.status().lastSuccessAt);
    assert.equal(service.status().consecutiveFailures, 0);
    assert.equal(service.status().snapshotAt, 1);
    assert.ok(!JSON.stringify(service.status()).includes('confidential'));
  } finally { await service.stop(); }
  assert.equal(active, 0);
  assert.equal(service.status().state, 'stopped');
  assert.equal(service.status().nextAttemptAt, null);
});

test('transport rejects SSH argument injection and remote shell metacharacters without echoing input', () => {
  const config = { sshHost: 'test-peer', remoteDirectory: '/invented/replica', receiverPath: '/invented/receiver.js' };
  validateTransportConfig(config);
  for (const change of [{ sshHost: '-oProxyCommand=example' }, { sshHost: 'host name' },
    { remoteDirectory: '/invented/$(example)' }, { receiverPath: '/invented/receiver;example' }, { nodePath: 'node -e example' }]) {
    assert.throws(() => validateTransportConfig({ ...config, ...change }), /^Error: configuration_invalid$/);
  }
  assert.equal(publicReplicationError(new Error('synthetic private details')), 'transfer_failed');
});
