import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, mirrorConfiguration } from '../src/app/config.js';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-mirror-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const privatePath = join(directory, 'secrets.json');
  writeFileSync(privatePath, JSON.stringify(options), { mode: 0o600 });
  return env => loadConfig({ HOME: directory, STMQ_CONFIG: privatePath, STMQ_DATA_DIR: join(directory, 'data'),
    STMQ_DATABASE_DIR: join(directory, 'database'), ...env }, directory);
}

test('mirror slave role is local, suppresses live input and does not require producer connections', t => {
  const read = fixture(t, { mirror: { role: 'slave' }, controller: { topology: 'mirror', input: 'providers', mode: 'active', h66_device: 'invented-device' },
    mqtt: { address: '' }, teslamate: { enabled: true } });
  const config = read({ STMQ_INPUT: 'mqtt', STMQ_MODE: 'active' });
  assert.equal(config.role, 'slave');
  assert.equal(config.input, 'offline');
  assert.equal(config.settings.mode, 'monitoring');
  assert.deepEqual(config.connections, {});
  assert.equal(config.deviceId, undefined);
  assert.equal(config.h66.enabled, false);
  assert.equal(config.h66.writeEnabled, false);
  assert.equal(config.h66Verification, undefined);
  assert.equal(config.topology, 'mirror');
  assert.equal(config.mirror.enabled, undefined);
  assert.equal(config.mirror.directory, join(config.databaseDir, 'mirror'));
  assert.equal(config.mirror.sourceDirectory, join(config.dataDir, 'mirror-work'));
});

test('master defaults retain ordinary operation; slave source and runtime directories stay distinct', t => {
  const read = fixture(t);
  const master = read({});
  assert.equal(master.role, 'master');
  assert.equal(master.input, 'simulated');
  assert.equal(master.topology, 'standalone');
  assert.equal(master.mirror.enabled, undefined);
  const slave = read({ STMQ_TOPOLOGY: 'mirror', STMQ_MIRROR_ROLE: 'slave', STMQ_MIRROR_DIR: '/invented/mirror' });
  assert.equal(slave.mirror.directory, '/invented/mirror');
  assert.notEqual(slave.mirror.directory, slave.dbPath);
  assert.throws(() => read({ STMQ_MIRROR_ROLE: 'automatic' }), /STMQ_MIRROR_ROLE/);
});

test('mirror options configure bounded intervals and long catchups with environment precedence', t => {
  const read = fixture(t, { controller: { topology: 'mirror' }, mirror: { ssh_host: 'invented-slave',
    remote_directory: '/invented/slave', receiver_path: '/opt/st-mq/scripts/replica-receiver.js',
    interval_seconds: 300, timeout_seconds: 7200, ssh_config: '/etc/st-mq/ssh/config' } });
  const master = read({ STMQ_INPUT: 'providers', STMQ_MIRROR_INTERVAL_SECONDS: '120' });
  assert.equal(master.topology, 'mirror');
  assert.equal(master.mirror.intervalMs, 120000);
  assert.equal(master.mirror.timeoutMs, 7200000);
  assert.equal(master.mirror.sshConfigPath, '/etc/st-mq/ssh/config');
  assert.equal(read({ STMQ_MIRROR_SSH_CONFIG: '/invented/ssh/config' }).mirror.sshConfigPath, '/invented/ssh/config');
  assert.equal(master.connections.mirror, undefined, 'Mirror destinations are not provider settings');
  assert.equal(read({ STMQ_TOPOLOGY: 'standalone' }).topology, 'standalone');
  assert.equal(read({ STMQ_MIRROR_ROLE: 'slave' }).role, 'slave');
});

test('bad mirror settings fail without exposing private values', () => {
  const valid = { ssh_host: 'invented-slave', remote_directory: '/invented/slave',
    receiver_path: '/opt/st-mq/scripts/replica-receiver.js' };
  for (const fields of [{ ssh_host: '-oProxyCommand=private-value' }, { ssh_host: 'host;private-value' },
    { remote_directory: 'private-value' }, { receiver_path: 'private-value' },
    { remote_directory: '/' }, { remote_directory: '/private-value/../elsewhere' }, { receiver_path: '/private-value with spaces' },
    { node_path: 'private-value\n' }, { interval_seconds: 0 }, { timeout_seconds: Infinity }]) {
    assert.throws(() => mirrorConfiguration({ ...valid, ...fields }, {}, { topology: 'mirror' }), error =>
      !error.message.includes('private-value') && /[Mm]irror/.test(error.message));
  }
  assert.throws(() => mirrorConfiguration({}, { STMQ_MIRROR_ENABLED: 'yes' }), /Retired environment/);
  assert.throws(() => mirrorConfiguration({}, { STMQ_MIRROR_STALE_SECONDS: 'NaN' }), /stale_seconds/);
  assert.throws(() => mirrorConfiguration({}, { STMQ_MIRROR_SSH_CONFIG: 'relative/private-value' }), /ssh_config/);
});

test('topology selects mirror sender requirements and standalone always remains master', t => {
  const read = fixture(t);
  assert.equal(read({ STMQ_MIRROR_ROLE: 'slave' }).role, 'master');
  assert.throws(() => read({ STMQ_TOPOLOGY: 'mirror' }), /ssh_host/);
  assert.equal(read({ STMQ_TOPOLOGY: 'mirror', STMQ_MIRROR_ROLE: 'slave' }).topology, 'mirror');
  assert.throws(() => read({ STMQ_TOPOLOGY: 'paired' }), /standalone, mirror or pair/);
});

test('retired sections, enable flags, roles and environment names fail before runtime construction', t => {
  for (const options of [{ replication: {} }, { pairing: {} }, { mirror: { enabled: false } },
    { pair: { enabled: false } }, { controller: { role: 'primary' } }, { controller: { role: 'replica' } }, { controller: { role: 'master' } }, { controller: { role: 'slave' } }]) {
    const read = fixture(t, options);
    for (const env of [{}, { STMQ_ADDON: '1' }])
      assert.throws(() => read(env), /Retired .*controller\.(topology|role)/);
  }
  const read = fixture(t);
  for (const name of ['STMQ_REPLICATION_ENABLED', 'STMQ_REPLICATION_SSH_HOST', 'STMQ_REPLICA_DIR',
    'STMQ_REPLICA_STALE_SECONDS', 'STMQ_PAIR_ENABLED', 'STMQ_MIRROR_ENABLED'])
    assert.throws(() => read({ [name]: 'private-value' }), error =>
      error.message.includes(name) && error.message.includes('STMQ_TOPOLOGY') && !error.message.includes('private-value'));
  assert.throws(() => read({ STMQ_ROLE: 'master' }), /Retired .*STMQ_MIRROR_ROLE/);
  for (const role of ['primary', 'replica']) assert.throws(() => read({ STMQ_MIRROR_ROLE: role }), /master or slave/);
  for (const role of ['master', 'slave']) assert.throws(() => fixture(t, { pair: { role } })({}), /pair.role.*manual promotion/);
});
