import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/app/config.js';
import { requireLocalBroker } from '../src/pairing/config.js';

function fixture(t, options = {}, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stmq-pair-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'secrets.json');
  writeFileSync(path, JSON.stringify({ controller: { input: 'mqtt', topology: 'pair', h66_device: 'invented-gateway' },
    mqtt: { address: 'mqtt://127.0.0.1' }, pair: { pair_id: 'synthetic-pair',
      token: 'synthetic-pairing-token-with-more-than-32-characters', peer_url: 'http://192.0.2.2:1244',
      vip_address: '192.0.2.100', vip_interface: 'eth0' }, ...options }), { mode: 0o600 });
  return () => loadConfig({ STMQ_CONFIG: path, STMQ_DATA_DIR: join(dir, 'data'), ...env }, dir);
}

test('paired standby retains private future controller settings but starts with slave role', t => {
  const config = fixture(t)();
  assert.equal(config.role, 'slave'); assert.equal(config.input, 'mqtt');
  assert.equal(config.pair.initialRole, undefined); assert.equal(config.pair.platform, 'ubuntu');
  assert.equal(config.pair.vip.socketPath, '/run/st-mq-vip/socket');
  assert.equal(config.topology, 'pair');
  assert.equal(config.pair.enabled, undefined);
  assert.equal(config.pair.directory, join(config.dataDir, 'pairing'));
  assert.equal(config.pair.snapshotDirectory, join(config.databaseDir, 'pair-snapshots'));
  assert.equal(config.pair.staleAfterMs, 180000);
  assert.equal(config.pair.replicaDirectory, undefined);
  assert.equal(config.connections.pair, undefined);
  assert.equal(config.deviceId, 'invented-gateway');
  assert.equal(Object.hasOwn(config.settings, 'mode'), false);
});

test('Home Assistant deployment determines conflict preference and direct VIP helper', t => {
  const config = fixture(t, {}, { STMQ_ADDON: '1', STMQ_DATABASE_DIR: '/tmp/invented-addon-db' })();
  assert.equal(config.pair.platform, 'hassio'); assert.equal(config.pair.vip.socketPath, '');
});

test('pair rejects incomplete credentials and VIP as management address', t => {
  assert.throws(fixture(t, {}, { STMQ_PAIR_TOKEN: 'short' }), /shared private token/);
  assert.throws(fixture(t, {}, { STMQ_PAIR_PEER_URL: 'http://192.0.2.100:1244' }), /fixed addresses/);
  assert.throws(fixture(t, {}, { STMQ_PAIR_VIP_INTERFACE: 'eth0;invalid' }), /vip_interface/);
  assert.throws(fixture(t, {}, { STMQ_INPUT: 'simulated' }), /live input/);
});

test('pair snapshot settings are independent of mirror settings and accept environment overrides', t => {
  const config = fixture(t, { mirror: { role: 'master', directory: '/invented/mirror', stale_seconds: 900 } },
    { STMQ_PAIR_SNAPSHOT_DIR: '/invented/pair-snapshots', STMQ_PAIR_STALE_SECONDS: '240', STMQ_MIRROR_ROLE: 'master' })();
  assert.equal(config.role, 'slave', 'Mirror configuration cannot grant initial pair authority');
  assert.equal(config.pair.snapshotDirectory, '/invented/pair-snapshots');
  assert.equal(config.pair.staleAfterMs, 240000);
  assert.equal(config.mirror.directory, '/invented/mirror');
  assert.equal(config.mirror.staleAfterMs, 900000);
  assert.throws(fixture(t, {}, { STMQ_PAIR_STALE_SECONDS: 'NaN' }), /stale_seconds/);
  assert.throws(fixture(t, {}, { STMQ_PAIR_SNAPSHOT_DIR: '/invented/shared', STMQ_PAIR_DIR: '/invented/shared' }), /directory/);
});

test('inactive pair connection settings do not require credentials or a local broker', t => {
  for (const topology of ['standalone', 'mirror']) {
    const config = fixture(t, { controller: { topology, input: 'simulated' }, mirror: { role: 'slave' },
      pair: {}, mqtt: { address: '' } })();
    assert.deepEqual(config.pair, {});
    assert.equal(config.topology, topology);
  }
});

test('local broker verification accepts only local interfaces or the Supervisor broker alias', async () => {
  const interfaces = () => ({ eth0: [{ address: '192.0.2.1' }] });
  await requireLocalBroker({ address: 'mqtt://127.0.0.1' }, { interfaces });
  await requireLocalBroker({ address: 'mqtt://192.0.2.1' }, { interfaces });
  await requireLocalBroker({ address: 'mqtt://core-mosquitto' }, { addon: true, interfaces });
  await assert.rejects(requireLocalBroker({ address: 'mqtt://192.0.2.2' }, { interfaces }), /this machine/);
  await assert.rejects(requireLocalBroker({ address: 'mqtt://192.0.2.100' }, { interfaces, vipAddress: '192.0.2.100' }), /devices use/);
  await assert.rejects(requireLocalBroker({ address: 'mqtt://name:synthetic-password@localhost' }, { interfaces }), /separately/);
  await assert.rejects(requireLocalBroker({ address: 'mqtt://local.invalid' }, { interfaces,
    resolveHost: async () => [{ address: '127.0.0.1' }, { address: '192.0.2.2' }] }), /this machine/);
  await assert.rejects(requireLocalBroker({ address: 'mqtt://floating.invalid' }, {
    interfaces: () => ({ eth0: [{ address: '192.0.2.100' }] }), vipAddress: '192.0.2.100',
    resolveHost: async () => [{ address: '192.0.2.100' }] }), { code: 'mqtt_local_required' });
  await assert.rejects(requireLocalBroker({ address: 'mqtt://missing.invalid' }, {
    resolveHost: async () => { throw Error('private resolver output'); } }), { code: 'mqtt_resolution_failed' });
});
