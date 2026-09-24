import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, replicationConfiguration } from '../src/app/config.js';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-replica-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const privatePath = join(directory, 'secrets.json');
  writeFileSync(privatePath, JSON.stringify(options), { mode: 0o600 });
  return env => loadConfig({ HOME: directory, STMQ_CONFIG: privatePath, STMQ_DATA_DIR: join(directory, 'data'),
    STMQ_DATABASE_DIR: join(directory, 'database'), ...env }, directory);
}

test('replica role is local, suppresses live input and does not require producer connections', t => {
  const read = fixture(t, { controller: { role: 'replica', input: 'providers', mode: 'active', h66_device: 'invented-device' },
    mqtt: { address: '' }, teslamate: { enabled: true } });
  const config = read({ STMQ_INPUT: 'mqtt', STMQ_MODE: 'active' });
  assert.equal(config.role, 'replica');
  assert.equal(config.input, 'offline');
  assert.equal(config.settings.mode, 'monitoring');
  assert.deepEqual(config.connections, {});
  assert.equal(config.deviceId, undefined);
  assert.equal(config.h66.enabled, false);
  assert.equal(config.h66.writeEnabled, false);
  assert.equal(config.h66Verification, undefined);
  assert.equal(config.replication.enabled, false);
  assert.equal(config.replication.directory, join(config.databaseDir, 'replica'));
  assert.equal(config.replication.sourceDirectory, join(config.dataDir, 'replication'));
});

test('primary defaults retain ordinary operation; replica source and runtime directories stay distinct', t => {
  const read = fixture(t);
  const primary = read({});
  assert.equal(primary.role, 'primary');
  assert.equal(primary.input, 'simulated');
  assert.equal(primary.replication.enabled, false);
  const replica = read({ STMQ_ROLE: 'replica', STMQ_REPLICA_DIR: '/invented/mirror' });
  assert.equal(replica.replication.directory, '/invented/mirror');
  assert.notEqual(replica.replication.directory, replica.dbPath);
  assert.throws(() => read({ STMQ_ROLE: 'automatic' }), /STMQ_ROLE/);
});

test('replication options configure bounded intervals and long catchups with environment precedence', t => {
  const read = fixture(t, { replication: { enabled: true, ssh_host: 'invented-replica',
    remote_directory: '/invented/replica', receiver_path: '/opt/st-mq/scripts/replica-receiver.js',
    interval_seconds: 300, timeout_seconds: 7200, ssh_config: '/etc/st-mq/ssh/config' } });
  const primary = read({ STMQ_INPUT: 'providers', STMQ_REPLICATION_INTERVAL_SECONDS: '120' });
  assert.equal(primary.replication.enabled, true);
  assert.equal(primary.replication.intervalMs, 120000);
  assert.equal(primary.replication.timeoutMs, 7200000);
  assert.equal(primary.replication.sshConfigPath, '/etc/st-mq/ssh/config');
  assert.equal(read({ STMQ_REPLICATION_SSH_CONFIG: '/invented/ssh/config' }).replication.sshConfigPath, '/invented/ssh/config');
  assert.equal(primary.connections.replication, undefined, 'Replication destinations are not provider settings');
  assert.equal(read({ STMQ_REPLICATION_ENABLED: '0' }).replication.enabled, false);
  assert.throws(() => read({ STMQ_ROLE: 'replica' }), /cannot enable outgoing/);
  assert.equal(read({ STMQ_ROLE: 'replica', STMQ_REPLICATION_ENABLED: '0' }).role, 'replica');
});

test('bad replication settings fail without exposing private values', () => {
  const valid = { enabled: true, ssh_host: 'invented-replica', remote_directory: '/invented/replica',
    receiver_path: '/opt/st-mq/scripts/replica-receiver.js' };
  for (const fields of [{ ssh_host: '-oProxyCommand=private-value' }, { ssh_host: 'host;private-value' },
    { remote_directory: 'private-value' }, { receiver_path: 'private-value' },
    { remote_directory: '/' }, { remote_directory: '/private-value/../elsewhere' }, { receiver_path: '/private-value with spaces' },
    { node_path: 'private-value\n' }, { interval_seconds: 0 }, { timeout_seconds: Infinity }]) {
    assert.throws(() => replicationConfiguration({ ...valid, ...fields }), error =>
      !error.message.includes('private-value') && /[Rr]eplication/.test(error.message));
  }
  assert.throws(() => replicationConfiguration({}, { STMQ_REPLICATION_ENABLED: 'yes' }), /must be 0 or 1/);
  assert.throws(() => replicationConfiguration({}, { STMQ_REPLICA_STALE_SECONDS: 'NaN' }), /stale_seconds/);
  assert.throws(() => replicationConfiguration({}, { STMQ_REPLICATION_SSH_CONFIG: 'relative/private-value' }), /ssh_config/);
});
