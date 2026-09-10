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
  writeFileSync(path, JSON.stringify({ controller: { input: 'mqtt', role: 'replica', mode: 'active', h66_device: 'invented-gateway' },
    mqtt: { address: 'mqtt://127.0.0.1' }, pairing: { enabled: true, pair_id: 'synthetic-pair',
      token: 'synthetic-pairing-token-with-more-than-32-characters', peer_url: 'http://192.0.2.2:1244',
      vip_address: '192.0.2.100', vip_interface: 'eth0' }, ...options }), { mode: 0o600 });
  return () => loadConfig({ STMQ_CONFIG: path, STMQ_DATA_DIR: join(dir, 'data'), ...env }, dir);
}

test('paired standby retains private future controller settings but starts with replica role', t => {
  const config = fixture(t)();
  assert.equal(config.role, 'replica'); assert.equal(config.input, 'mqtt');
  assert.equal(config.pairing.initialRole, 'replica'); assert.equal(config.pairing.platform, 'ubuntu');
  assert.equal(config.pairing.vip.socketPath, '/run/st-mq-vip/socket');
  assert.equal(config.connections.pairing, undefined);
  assert.equal(config.deviceId, 'invented-gateway');
  assert.equal(config.settings.mode, 'active');
});

test('Home Assistant deployment determines conflict preference and direct VIP helper', t => {
  const config = fixture(t, {}, { STMQ_ADDON: '1', STMQ_DATABASE_DIR: '/tmp/invented-addon-db' })();
  assert.equal(config.pairing.platform, 'hassio'); assert.equal(config.pairing.vip.socketPath, '');
});

test('pairing rejects incomplete credentials, competing transport and VIP as management address', t => {
  assert.throws(fixture(t, {}, { STMQ_PAIR_TOKEN: 'short' }), /shared private token/);
  assert.throws(fixture(t, {}, { STMQ_PAIR_PEER_URL: 'http://192.0.2.100:1244' }), /fixed addresses/);
  assert.throws(fixture(t, {}, { STMQ_PAIR_VIP_INTERFACE: 'eth0;invalid' }), /vip_interface/);
  assert.throws(fixture(t, {}, { STMQ_INPUT: 'simulated' }), /live input/);
  assert.throws(fixture(t, { controller: { input: 'mqtt', role: 'primary' }, replication: { enabled: true,
    ssh_host: 'synthetic', remote_directory: '/tmp/synthetic', receiver_path: '/tmp/synthetic/receiver.js' } }), /disable separate SSH/);
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
});
