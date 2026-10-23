import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { main, localPromotion, setupArguments, waitForSetupRuntime, validateSetupPair } from '../scripts/lib/linux-setup.js';
import { HASetupUnavailableError } from '../scripts/lib/linux-setup-ha.js';
import { BrokerProbeError } from '../scripts/lib/linux-setup-broker.js';

function fixture(t, { existing = false, installed = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'st-mq-wizard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(import.meta.dirname, '..'), privatePath = join(root, 'private');
  mkdirSync(privatePath, { mode: 0o700 });
  const connectionPath = join(privatePath, 'linux-deploy.json'), secrets = join(privatePath, 'secrets.json'), environment = join(privatePath, 'runtime.env');
  const runtime = join(root, 'runtime'), data = join(root, 'data');
  const connection = { runtime_dir: runtime, service_scope: 'user', service_name: 'synthetic-st-mq.service', node_path: process.execPath,
    environment_file: environment, status_url: 'http://127.0.0.1:19876' };
  writeFileSync(connectionPath, JSON.stringify(connection), { mode: 0o600 });
  if (existing) {
    mkdirSync(data, { mode: 0o700 });
    writeFileSync(secrets, '{}\n', { mode: 0o600 });
    writeFileSync(environment, `STMQ_CONFIG='${secrets}'\nSTMQ_DATA_DIR='${data}'\nSTMQ_DATABASE_DIR='${data}'\nSTMQ_TOPOLOGY='standalone'\nSTMQ_PORT='19876'\nSTMQ_SNAPSHOT_DIR='${data}/snapshots'\nPATH='/usr/local/bin:/usr/bin'\n`, { mode: 0o600 });
  }
  if (installed) { mkdirSync(runtime); writeFileSync(join(runtime, 'deployment.json'), '{}'); }
  const events = [], transcript = [];
  let active = false;
  const io = {
    log: value => transcript.push(value),
    choose: async (label, choices, fallback) => {
      if (label === 'Operation') return 'standalone';
      if (label === 'Configuration source') return existing ? 'Use existing file' : 'Minimal starter';
      assert.fail('Unexpected choice: ' + label);
    },
    ask: async (label, fallback) => ({ 'Runtime directory': runtime, 'Data directory': data, 'Private configuration file': secrets,
      'Local web port': '19876' })[label] ?? fallback,
    confirm: async label => label === 'Apply this configuration, install and start?',
    edit: async () => assert.fail('No editor required'),
    external: action => action(),
  };
  const run = async (exe, args) => {
    if (exe === 'git') return args[0] === 'rev-parse' ? 'a'.repeat(40) : '';
    if (exe === 'systemctl') {
      const action = args[1]; events.push(action);
      if (action === 'stop') active = false;
      if (action === 'start') active = true;
      if (action === 'show') return active ? 'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123'
        : `LoadState=${installed ? 'loaded' : 'not-found'}\nActiveState=inactive\nSubState=dead\nMainPID=0`;
      return '';
    }
    if (exe === 'sudo') { assert.equal(args[1], 'loginctl'); events.push('linger'); return ''; }
    if (exe === process.execPath) { events.push('listener-probe'); return ''; }
    assert.fail('Unexpected command: ' + exe);
  };
  const deps = { source, home: root, env: {}, io, run, operator: userInfo(), uid: 1000,
    inspect: async () => ({ packages: [], group: userInfo().username, broker: { installed: false } }),
    authenticate: async () => events.push('authenticate'),
    lease: () => ({ assertValid() {}, close() {} }),
    provision: async () => assert.fail('Simulation needs no new infrastructure'),
    install: async (mode, args, options) => {
      events.push(mode); assert.ok(options.operationLock);
      assert.ok(args.includes(installed ? '--stopped' : '--apply'));
      assert.equal(JSON.parse(readFileSync(connectionPath)).runtime_dir, runtime);
    },
    validateInstallation: async () => events.push('ownership'),
    readRuntime: async () => ({ topology: 'standalone', role: 'master' }),
  };
  return { root, source, connection, connectionPath, secrets, environment, runtime, data, io, deps, events, transcript };
}

test('wizard dry-run reviews a fresh minimal installation without authentication or permanent inputs', async t => {
  const f = fixture(t);
  const result = await main(['--connection', f.connectionPath, '--dry-run'], f.deps);
  assert.equal(result.state, 'preview'); assert.equal(result.topology, 'standalone');
  assert.equal(existsSync(f.secrets), false); assert.equal(existsSync(f.environment), false);
  assert.equal(existsSync(f.runtime), false); assert.deepEqual(f.events, []);
});

test('wizard installs, enables, starts and verifies actual status through the process ownership probe', async t => {
  const f = fixture(t);
  const result = await main(['--connection', f.connectionPath], f.deps);
  assert.equal(result.state, 'ready');
  assert.deepEqual(JSON.parse(readFileSync(f.secrets)), { controller: { topology: 'standalone' } });
  assert.deepEqual(f.events, ['authenticate', 'show', 'setup', 'enable', 'linger', 'start', 'show', 'listener-probe']);
  assert.equal(existsSync(join(f.runtime, 'deployment.lock')), false);
  assert.ok(f.transcript.some(line => line.includes('simulation; equipment has not been commissioned')));
});

test('rerun explicitly reviews interruption, checks ownership before stop, and preserves environment overrides', async t => {
  const f = fixture(t, { existing: true, installed: true });
  await main(['--connection', f.connectionPath], f.deps);
  assert.ok(f.events.indexOf('ownership') < f.events.indexOf('stop'));
  assert.ok(f.events.indexOf('stop') < f.events.indexOf('deploy'));
  assert.ok(readFileSync(f.environment, 'utf8').includes("PATH='/usr/local/bin:/usr/bin'"));
  assert.ok(readFileSync(f.environment, 'utf8').includes(`STMQ_SNAPSHOT_DIR='${f.data}/snapshots'`));
  assert.ok(f.transcript.some(line => line.includes('existing Linux service will stop')));
});

test('unowned runtime is rejected before stop or configuration replacement', async t => {
  const f = fixture(t, { existing: true, installed: true });
  const original = readFileSync(f.secrets);
  f.deps.validateInstallation = async () => { throw Error('private-unrelated-process-detail'); };
  await assert.rejects(main(['--connection', f.connectionPath], f.deps), error => !error.message.includes('private-unrelated-process-detail')
    && error.message.includes(JSON.stringify(join(f.runtime, 'deployment.lock'))));
  assert.equal(f.events.includes('stop'), false); assert.deepEqual(readFileSync(f.secrets), original);
  assert.ok(existsSync(join(f.runtime, 'deployment.lock')));
});

test('configuration changed during privilege authentication is not overwritten', async t => {
  const f = fixture(t, { existing: true });
  f.deps.authenticate = async () => writeFileSync(f.secrets, '{"controller":{"input":"simulated"}}\n');
  await assert.rejects(main(['--connection', f.connectionPath], f.deps), /private input changed after review/);
  assert.ok(readFileSync(f.secrets, 'utf8').includes('simulated')); assert.equal(f.events.includes('setup'), false);
});

test('existing data cannot be relocated by setup', async t => {
  const f = fixture(t, { existing: true });
  const ask = f.io.ask; f.io.ask = (label, fallback) => label === 'Data directory' ? join(f.root, 'replacement') : ask(label, fallback);
  await assert.rejects(main(['--connection', f.connectionPath], f.deps), /does not relocate existing history/);
  assert.deepEqual(f.events, []);
});

test('declining apply writes no permanent configuration and does not request sudo', async t => {
  const f = fixture(t); f.io.confirm = async () => false;
  assert.equal((await main(['--connection', f.connectionPath], f.deps)).state, 'cancelled');
  assert.equal(existsSync(f.secrets), false); assert.deepEqual(f.events, []);
});

test('public setup rejects retired apply flag and duplicate arguments', () => {
  assert.throws(() => setupArguments(['--apply']), /Invalid setup arguments/);
  assert.throws(() => setupArguments(['--dry-run', '--dry-run']), /Invalid setup arguments/);
});

const bootstrap = { nodeId: 'synthetic-linux', pairId: 'synthetic-pair', role: 'slave', bootstrapPending: true,
  canControl: false, actions: { promote: true }, busy: false, phase: null, error: null, vip: { owned: false }, peer: { role: 'slave' } };
test('explicit first-master action supports bootstrap and reviewed protected standalone history', async () => {
  for (const protectedInitial of [false, true]) {
    const identity = protectedInitial ? { ...bootstrap, role: 'protected', bootstrapPending: false } : bootstrap;
    let request;
    await localPromotion({ status_url: 'http://127.0.0.1:1234' }, identity, { protectedInitial,
      verify: async () => {},
      read: async () => identity, fetchImpl: async (url, init) => { request = JSON.parse(init.body); return { status: 202 }; } });
    assert.equal(request.action, 'promote'); assert.equal(request.confirmed, true);
  }
});
test('first-master action rejects existing authority, busy state, missing action and competing master', async () => {
  for (const patch of [{ nodeId: 'different' }, { busy: true }, { phase: 'busy' }, { error: 'private-failure' },
    { actions: { promote: false } }, { peer: { role: 'master' } }, { canControl: true }, { role: 'protected', bootstrapPending: false }]) {
    await assert.rejects(localPromotion({ status_url: 'http://127.0.0.1:1234' }, bootstrap, {
      verify: async () => {},
      read: async () => ({ ...bootstrap, ...patch }), fetchImpl: async () => assert.fail('Unsafe promotion submitted'),
    }), /preconditions changed/);
  }
});
test('runtime startup rejects unknown non-master authority instead of treating service active as ready', async () => {
  await assert.rejects(waitForSetupRuntime({ connection: { node_path: process.execPath, runtime_dir: '/synthetic', service_name: 'synthetic.service', status_url: 'http://127.0.0.1:1234' },
    topology: 'pair', run: async () => '', service: async () => 'ActiveState=active\nMainPID=123',
    read: async () => ({ role: 'slave', canControl: true }),
  }), /Unknown pair authority/);
});

test('pair completion requires both matching fresh nodes, real master VIP ownership and ready slave', () => {
  const now = Date.now();
  const master = { ...bootstrap, nodeId: 'synthetic-ha', role: 'master', bootstrapPending: false, canControl: true,
    vip: { owned: true }, peer: { role: 'slave', reachable: true, nodeId: 'synthetic-linux', lastSeenAt: now } };
  const slave = { ...bootstrap, bootstrapPending: false, sync: { state: 'ready', error: null },
    peer: { role: 'master', reachable: true, nodeId: 'synthetic-ha', lastSeenAt: now } };
  validateSetupPair(slave, master, { now }); validateSetupPair(master, slave, { now });
  for (const patch of [{ busy: true }, { vip: { owned: false } }, { pairId: 'other-pair' }, { peer: { ...master.peer, lastSeenAt: now - 20000 } }])
    assert.throws(() => validateSetupPair(slave, { ...master, ...patch }, { now }));
  assert.throws(() => validateSetupPair({ ...slave, sync: { state: 'mirroring' } }, master, { now }));
});

function pairedFixture(t, { unavailable = false, applyFailure = false } = {}) {
  const f = fixture(t), stages = [];
  const choose = f.io.choose, ask = f.io.ask;
  f.io.choose = (label, options, fallback) => label === 'Operation' ? 'pair' : label === 'First master for this new pair' ? 'Select later' : choose(label, options, fallback);
  f.io.ask = (label, fallback) => ({ 'HA SSH destination or alias': 'synthetic-ha', 'Linux local MQTT origin': 'mqtt://127.0.0.1',
    'Linux LAN interface': 'eth0', 'HA LAN interface': 'eth0', 'Shared virtual IPv4 address': '192.0.2.200',
    'Virtual IP prefix length': '24', 'Peer fixed HTTP origin': 'http://192.0.2.2:1244',
    'Linux fixed HTTP peer origin': 'http://192.0.2.1:1244' })[label] ?? ask(label, fallback);
  f.io.confirm = async label => label === 'Configure HA through SSH if available?' || label === 'Apply this configuration, install and start?';
  f.deps.inspect = async () => ({ packages: [], group: userInfo().username, broker: { installed: true, managed: true, active: true } });
  f.deps.validateBrokerLocation = async () => {};
  f.deps.probeBroker = async () => {};
  f.deps.provision = async request => { stages.push('linux-infrastructure'); assert.deepEqual(Object.keys(request.vip).sort(), ['address', 'interface', 'prefixLength']); };
  f.deps.readRuntime = async () => bootstrap;
  const ha = { options: { controller: { topology: 'pair' } }, mqtt: { installed: true }, interfaces: [{ name: 'eth0', primary: true }], initialRuntime: null,
    backupAndApply: async request => { stages.push('ha-apply'); assert.equal(request.options.pair.peer_url, 'http://192.0.2.1:1244'); if (applyFailure) throw Error('private-HA-response'); return { changed: true }; },
    start: async () => stages.push('ha-start'), readRuntime: async () => ({ pair: { ...bootstrap, nodeId: 'synthetic-ha' }, observedAt: Date.now() }),
    promote: async () => assert.fail('Select later does not authorize promotion'), close: async () => stages.push('ha-close') };
  f.deps.connectHA = async (connection, options) => {
    assert.equal(connection.ssh_host, 'synthetic-ha'); assert.ok(options.schema); assert.ok(options.expectedVersion);
    if (unavailable) throw new HASetupUnavailableError('Transport unavailable');
    return ha;
  };
  return { ...f, ha, stages };
}

test('optional SSH setup preserves a preconfigured fresh pair and permits explicit later commissioning', async t => {
  const f = pairedFixture(t);
  const result = await main(['--connection', f.connectionPath], f.deps);
  assert.equal(result.state, 'peer-pending'); assert.equal(result.haResult.changed, true);
  assert.deepEqual(f.stages, ['linux-infrastructure', 'ha-apply', 'ha-start', 'ha-close']);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'private/ha-deploy.json'))).ssh_host, 'synthetic-ha');
  const options = JSON.parse(readFileSync(f.secrets)); assert.ok(options.pair.token.length >= 32);
  assert.equal(f.transcript.some(line => line.includes(options.pair.token)), false);
});

test('unavailable optional HA SSH finishes local installation and writes private manual settings', async t => {
  const f = pairedFixture(t, { unavailable: true });
  const result = await main(['--connection', f.connectionPath], f.deps);
  assert.equal(result.state, 'peer-pending');
  const manual = JSON.parse(readFileSync(join(f.root, 'private/ha-pair-settings.json')));
  const local = JSON.parse(readFileSync(f.secrets));
  assert.equal(manual.pair.token, local.pair.token); assert.equal(manual.pair.peer_url, 'http://192.0.2.1:1244');
  assert.deepEqual(f.stages, ['linux-infrastructure']);
  assert.ok(f.transcript.some(line => line.includes('HA configuration pending')));
});

test('uncertain HA write is never replayed or followed by application startup', async t => {
  const f = pairedFixture(t, { applyFailure: true });
  await assert.rejects(main(['--connection', f.connectionPath], f.deps), error => !error.message.includes('private-HA-response'));
  assert.deepEqual(f.stages, ['linux-infrastructure', 'ha-apply', 'ha-close']);
  assert.equal(f.events.includes('start'), false); assert.equal(f.events.includes('setup'), false);
  assert.ok(existsSync(join(f.runtime, 'deployment.lock')));
});

test('standalone live input provisions a refused local broker and authenticates it before startup', async t => {
  const f = fixture(t);
  writeFileSync(f.secrets, JSON.stringify({ controller: { input: 'providers' }, mqtt: { address: 'mqtt://127.0.0.1' } }), { mode: 0o600 });
  const choose = f.io.choose; f.io.choose = (label, options, fallback) => label === 'Configuration source' ? 'Use existing file' : choose(label, options, fallback);
  f.io.confirm = async label => ['Apply this configuration, install and start?', 'Install or configure the private local Mosquitto broker?'].includes(label);
  let online = false, probes = 0;
  f.deps.probeBroker = async connection => {
    probes++;
    if (!online) throw new BrokerProbeError('unavailable', { endpointState: 'refused' });
    assert.ok(connection.user); assert.ok(connection.pw.length >= 32); f.events.push('broker-authenticated');
  };
  f.deps.provision = async request => { assert.equal(request.vip, null); assert.ok(request.broker.password.length >= 32); online = true; };
  assert.equal((await main(['--connection', f.connectionPath], f.deps)).state, 'ready');
  assert.equal(probes, 2); assert.ok(f.events.indexOf('broker-authenticated') < f.events.indexOf('start'));
  const options = JSON.parse(readFileSync(f.secrets)); assert.equal(f.transcript.some(line => line.includes(options.mqtt.pw)), false);
});

test('unmanaged responding broker authentication failure never becomes provisioning permission', async t => {
  const f = fixture(t);
  writeFileSync(f.secrets, JSON.stringify({ controller: { input: 'providers' }, mqtt: { address: 'mqtt://127.0.0.1' } }), { mode: 0o600 });
  const choose = f.io.choose; f.io.choose = (label, options, fallback) => label === 'Configuration source' ? 'Use existing file' : choose(label, options, fallback);
  f.io.confirm = async () => assert.fail('No apply or broker replacement should be offered');
  f.deps.probeBroker = async () => { throw new BrokerProbeError('authentication_failed', { endpointState: 'responded' }); };
  await assert.rejects(main(['--connection', f.connectionPath], f.deps), /rejected authentication/);
  assert.deepEqual(f.events, []);
});

test('wizard reviews and starts an existing stopped HA broker without requesting configuration changes', async t => {
  const f = pairedFixture(t); f.ha.mqtt = { installed: true, port: 1885, app: { state: 'stopped' } };
  const confirm = f.io.confirm; f.io.confirm = label => label === 'Start the existing stopped HA MQTT broker?' ? true : confirm(label);
  f.ha.backupAndApply = async request => {
    assert.equal(request.startBroker, true); assert.equal(request.installBroker, false);
    assert.equal(request.brokerOptions, undefined); assert.equal(request.brokerNetwork, undefined);
    return { changed: true };
  };
  assert.equal((await main(['--connection', f.connectionPath], f.deps)).state, 'peer-pending');
  assert.ok(f.transcript.some(line => line.includes('Start the existing stopped HA MQTT broker')));
});

test('an existing wizard lock names its exact location and blocks installation without removing it', async t => {
  const f = fixture(t); mkdirSync(f.runtime); const path = join(f.runtime, 'deployment.lock'); mkdirSync(path);
  await assert.rejects(main(['--connection', f.connectionPath], f.deps), error => error.message.includes(JSON.stringify(path)) && /lock exists/.test(error.message));
  assert(existsSync(path)); assert(!f.events.includes('setup')); assert(!f.events.includes('stop'));
});
