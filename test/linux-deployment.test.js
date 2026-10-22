import { runCommand } from '../scripts/lib/deployment-command.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, existsSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { main, LinuxDeploymentError, validateConnection, validateEnvironment, parseEnvironment, serviceText,
  privateFile, readPair, canonical, checkoutRoot, validateInstalledRuntime } from '../scripts/lib/linux-deployment.js';

import { validateStandby } from '../scripts/lib/paired-deployment.js';
import { PairManager } from '../src/pairing/manager.js';
import { PairState } from '../src/pairing/state.js';
import { createAppServer } from '../src/app/server.js';
import { randomUUID } from 'node:crypto';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture(t, scope = 'user') {
  const root = mkdtempSync(join(tmpdir(), 'linux-deployment-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), secrets = join(root, 'private'), data = join(root, 'household');
  for (const path of [source, secrets, data]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(data, 'state'), 'synthetic-retained-pair-state');
  writeFileSync(join(data, 'database.sqlite'), 'synthetic-retained-history');
  const configPath = join(secrets, 'installation.json');
  writeFileSync(configPath, '{}', { mode: 0o600 });
  const c = { runtime_dir: join(root, 'runtime with spaces'), node_path: process.execPath,
    environment_file: join(secrets, 'runtime.env'), service_scope: scope, service_name: 'synthetic-energy.service',
    status_url: 'http://127.0.0.1:1234', ...(scope === 'system' ? { service_user: 'synthetic' } : {}) };
  const env = { STMQ_CONFIG: configPath, STMQ_DATA_DIR: data, STMQ_DATABASE_DIR: data, STMQ_PAIR_DIR: join(data, 'pairing'), STMQ_TOPOLOGY: 'pair' };
  writeFileSync(c.environment_file, Object.entries(env).map(([k, v]) => `${k}='${v}'`).join('\n'), { mode: 0o600 });
  const connection = join(secrets, 'linux-deploy.json');
  const saveConnection = patch => writeFileSync(connection, JSON.stringify({ ...c, ...patch }), { mode: 0o600 });
  saveConnection();
  git(source, 'init', '--initial-branch=main');
  git(source, 'config', 'user.email', 'synthetic@example.invalid'); git(source, 'config', 'user.name', 'Synthetic');
  writeFileSync(join(source, '.gitignore'), 'dist/\nnode_modules/\n');
  mkdirSync(join(source, 'src'));
  writeFileSync(join(source, 'src/main.js'), 'process.exit(0);\n');
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'synthetic-deployment', version: '1.0.0', scripts: { build: 'node build.cjs' } }));
  writeFileSync(join(source, 'build.cjs'), "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.html','synthetic build');require('fs').mkdirSync('node_modules',{recursive:true});\n");
  writeFileSync(join(source, 'package-lock.json'), JSON.stringify({ name: 'synthetic-deployment', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'synthetic-deployment', version: '1.0.0' } } }));
  git(source, 'add', '.'); git(source, 'commit', '-m', 'Synthetic initial source');
  const unit = join(root, 'units', c.service_name), calls = [], logs = [];
  const state = { active: false, pid: 0, onCommand: null, onPair: null, now: 100000, waiting: 0, pairCalls: 0, authCalls: 0, helperCalls: [], leaseChecks: 0, leaseClosed: 0 };
  const status = () => ({ role: 'slave', nodeId: 'synthetic-node', pairId: 'synthetic-pair', canControl: false, busy: false, phase: null,
    vip: { owned: false }, peer: { nodeId: 'synthetic-master', role: 'master', reachable: true, lastSeenAt: state.now }, sync: { state: 'ready', error: null } });
  const run = async (exe, args, options) => {
    calls.push([exe, ...args]); await state.onCommand?.(exe, args, options);
    if (exe === 'systemctl' || exe === 'sudo' && args.includes('systemctl')) {
      const a = exe === 'sudo' ? args.slice(2) : args.filter(x => x !== '--user');
      if (a[0] === 'show') return [`LoadState=${existsSync(unit) ? 'loaded' : 'not-found'}`, `ActiveState=${state.active ? 'active' : 'inactive'}`,
        `SubState=${state.active ? 'running' : 'dead'}`, `MainPID=${state.pid}`, 'Transient=no', `FragmentPath=${unit}`, 'DropInPaths=', 'NeedDaemonReload=no',
        `WorkingDirectory=${join(c.runtime_dir, 'current')}`, `ExecStart={ path=${c.node_path} ; argv[]=${c.node_path} ${join(c.runtime_dir, 'current/src/main.js')} ; }`,
        `User=${c.service_user ?? ''}`, ...Object.entries(state.showPatch ?? {}).map(([key, value]) => `${key}=${value}`)].join('\n');
      if (a[0] === 'stop') { state.active = false; state.pid = 0; }
      if (a[0] === 'start') { state.active = true; state.pid = 12345; }
      return '';
    }
    if (exe === 'sudo' && args[1] === 'install') {
      mkdirSync(join(root, 'units'), { recursive: true }); writeFileSync(unit, readFileSync(args.at(-2))); return '';
    }
    // This fixture has no real application configuration module or service
    // process; the native suite separately exercises those boundaries.
    if (args.some(a => /linux-deployment-(?:preflight|process)\.js$/.test(a))) return '';
    return runCommand(exe, args, options);
  };
  const deps = { source, run, operatorUid: 1000, operatorUser: 'synthetic', log: s => logs.push(s), unitPath: () => unit, clock: () => state.now,
    authenticate: async () => { state.authCalls++; },
    lease: () => ({ assertValid: () => { state.leaseChecks++; }, close: async () => { state.leaseClosed++; } }),
    refreshHelper: async options => { state.helperCalls.push(options.source); },
    sleep: async () => { state.now += 1000; }, pair: async () => { state.pairCalls++; return state.onPair ? state.onPair(status()) : status(); } };
  const invoke = (mode, extra = []) => main(mode, ['--connection', connection, ...extra], deps);
  const setup = async () => { await invoke('setup', ['--apply']); state.active = true; state.pid = 1234; };
  const update = () => { writeFileSync(join(source, 'src/main.js'), 'process.exitCode=0;\n'); git(source, 'add', 'src/main.js'); git(source, 'commit', '-m', 'Synthetic next revision'); };
  return { root, source, secrets, data, configPath, c, env, unit, calls, logs, state, connection, saveConnection, status, invoke, setup, update, deps };
}

test('connection and environment boundaries reject unknown formats, overlap, ambiguous targets and unsafe paths', t => {
  const f = fixture(t);
  assert.equal(validateConnection(f.c, f.source).sync_timeout_seconds, 900);
  for (const patch of [{ retired: true }, { runtime_dir: f.source }, { runtime_dir: f.root }, { runtime_dir: '/tmp/../tmp' },
    { service_name: 'bad;command.service' }, { service_scope: 'other' }, { service_user: 'unexpected' },
    { status_url: 'https://example.invalid' }, { status_url: 'http://127.0.0.1/api/pair' }, { status_url: 'http://127.0.0.1/?token=synthetic' },
    { sync_timeout_seconds: 0 }, { environment_file: join(f.source, 'private') }]) assert.throws(() => validateConnection({ ...f.c, ...patch }, f.source));
  symlinkSync(f.source, join(f.root, 'source-alias'));
  assert.throws(() => validateConnection({ ...f.c, runtime_dir: join(f.root, 'source-alias/runtime') }, f.source), /non-overlapping/);
  assert.equal(canonical(join(f.root, 'missing/child')), join(f.root, 'missing/child'));
  assert.deepEqual(parseEnvironment("# ignored\nKEY='a b $literal'\nEMPTY=\n"), { KEY: 'a b $literal', EMPTY: '' });
  for (const text of ['KEY=one\nKEY=two', 'export KEY=value', 'KEY="value"', 'KEY=with space', 'KEY=$(command)', "KEY='line\nvalue'"]) assert.throws(() => parseEnvironment(text));
  assert.throws(() => validateEnvironment({ ...f.env, STMQ_PAIR_DIR: join(f.c.runtime_dir, 'pairing') }, f.c, f.source));
  assert.throws(() => validateEnvironment({ ...f.env, STMQ_ROLE: 'master' }, f.c, f.source));
  chmodSync(f.connection, 0o644); assert.throws(() => privateFile(f.connection, f.source, f.c.runtime_dir), /0600/);
});

test('standby evidence requires identity, recent peer contact, non-control and successful synchronization', t => {
  const f = fixture(t), p = f.status();
  assert.doesNotThrow(() => validateStandby(p, null, f.state.now, true));
  for (const patch of [{ role: 'master' }, { canControl: true }, { busy: true }, { phase: 'handover' }, { vip: { owned: true } },
    { peer: { ...p.peer, reachable: false } }, { peer: { ...p.peer, lastSeenAt: f.state.now - 16000 } }, { sync: { state: 'syncing' } },
    { error: 'synthetic-error' }, { bootstrapPending: true }]) assert.throws(() => validateStandby({ ...p, ...patch }, null, f.state.now, true));
  assert.throws(() => validateStandby({ ...p, nodeId: 'other' }, p, f.state.now), /identity/);
});

test('real current configuration preflight is read-only and rejects runtime-local history paths', async t => {
  const f = fixture(t);
  writeFileSync(f.configPath, JSON.stringify({ controller: { input: 'mqtt', topology: 'pair', h66_device: 'invented-gateway' },
    mqtt: { address: 'mqtt://127.0.0.1' }, pair: { pair_id: 'synthetic-pair',
      token: 'synthetic-pairing-token-with-more-than-32-characters', peer_url: 'http://192.0.2.2:1244',
      vip_address: '192.0.2.100', vip_interface: 'eth0' } }));
  const args = [join(checkoutRoot, 'scripts/lib/linux-deployment-preflight.js'), checkoutRoot, f.c.environment_file, f.c.runtime_dir, checkoutRoot];
  await runCommand(process.execPath, args);
  assert.deepEqual(readdirSync(f.data).sort(), ['database.sqlite', 'state']);
  writeFileSync(f.c.environment_file, readFileSync(f.c.environment_file, 'utf8') + `\nSTMQ_PAIR_SNAPSHOT_DIR='${f.c.runtime_dir}/snapshots'\n`);
  await assert.rejects(runCommand(process.execPath, args));
  assert.equal(existsSync(f.c.runtime_dir), false);
});

test('CLI help resolves its own source from an unrelated working directory', async t => {
  const f = fixture(t);
  const output = await runCommand(process.execPath, [join(checkoutRoot, 'scripts/setup-linux.js'), '--help'], { cwd: f.data });
  assert.match(output, /secrets\.json/); assert.match(output, /--dry-run/);
});

test('setup previews without mutation, applies stopped and disabled, and refuses to overwrite a service', async t => {
  const f = fixture(t);
  await f.invoke('setup');
  assert.equal(existsSync(f.c.runtime_dir), false); assert.equal(existsSync(f.unit), false);
  await f.invoke('setup', ['--apply']);
  assert.equal(f.state.active, false);
  assert.equal(readFileSync(f.unit, 'utf8'), serviceText(validateConnection(f.c, f.source)));
  assert(existsSync(join(f.c.runtime_dir, 'current/dist/index.html')));
  assert.equal(f.calls.some(call => call.includes('start') || call.includes('enable')), false);
  await assert.rejects(f.invoke('setup', ['--apply']), /already exists/);
});

test('real staged npm build and Git deployment preserve external state and complete the managed standby lifecycle', async t => {
  const f = fixture(t); await f.setup(); const old = realpathSync(join(f.c.runtime_dir, 'current'));
  f.update(); await f.invoke('deploy');
  const installed = realpathSync(join(f.c.runtime_dir, 'current'));
  assert.notEqual(installed, old); assert(existsSync(old));
  assert.equal(git(installed, 'rev-parse', 'HEAD'), git(f.source, 'rev-parse', 'HEAD'));
  assert.equal(f.state.active, true);
  assert.equal(readFileSync(join(f.data, 'state'), 'utf8'), 'synthetic-retained-pair-state');
  assert.equal(readFileSync(join(f.data, 'database.sqlite'), 'utf8'), 'synthetic-retained-history');
  assert.equal(existsSync(join(f.c.runtime_dir, 'deployment.lock')), false);
  const build = f.calls.findLastIndex(call => call[0] === 'npm' && call.includes('build'));
  const stop = f.calls.findIndex(call => call.includes('stop'));
  assert(build < stop); assert(f.logs.some(s => s.includes('synchronization ready')));
});

test('managed runtimes work through a symlinked parent without publishing an outside release', async t => {
  const f = fixture(t), parent = join(f.root, 'physical'); mkdirSync(parent);
  const alias = join(f.root, 'alias'); symlinkSync(parent, alias);
  f.c.runtime_dir = join(alias, 'runtime'); f.saveConnection();
  await f.setup(); f.update(); await f.invoke('deploy');
  assert(realpathSync(join(f.c.runtime_dir, 'current')).startsWith(join(parent, 'runtime/releases/')));
});

test('unknown managed metadata is rejected without rewriting or converting it', async t => {
  const f = fixture(t); await f.setup();
  const marker = join(f.c.runtime_dir, 'deployment.json');
  const changed = JSON.stringify({ ...JSON.parse(readFileSync(marker, 'utf8')), retiredField: true }); writeFileSync(marker, changed);
  await assert.rejects(f.invoke('deploy'), /Unsupported.*metadata/);
  assert.equal(readFileSync(marker, 'utf8'), changed);
});

test('system service adapter installs a persistent unit and uses explicit privileged systemctl commands', async t => {
  const f = fixture(t, 'system'); await f.setup(); f.update(); await f.invoke('deploy');
  assert.match(readFileSync(f.unit, 'utf8'), /User=synthetic/);
  assert(f.calls.some(call => call[0] === 'sudo' && call[1] === '-n' && call[2] === 'install'));
  assert(f.calls.some(call => call[0] === 'sudo' && call[2] === 'systemctl' && call[3] === 'stop'));
  assert.equal(f.calls.some(call => call[0] === 'sudo' && call.includes('-u')), false, 'Private application reads remain under the deployment/service account');
});

test('master and unknown role are rejected before building or stopping', async t => {
  const f = fixture(t); await f.setup(); f.update(); f.calls.length = 0;
  f.state.onPair = p => ({ ...p, role: 'master', canControl: true });
  await assert.rejects(f.invoke('deploy'), /slave/);
  assert.equal(f.calls.some(call => call.includes('stop') || call.includes('ci')), false);
  assert.equal(f.state.active, true);
});

test('a role change during preparation refuses the stop and retains the original release', async t => {
  const f = fixture(t); await f.setup(); f.update(); const old = realpathSync(join(f.c.runtime_dir, 'current'));
  f.state.onPair = p => f.state.pairCalls > 1 ? { ...p, role: 'master' } : p;
  await assert.rejects(f.invoke('deploy'), /slave/);
  assert.equal(realpathSync(join(f.c.runtime_dir, 'current')), old); assert.equal(f.state.active, true);
  assert.equal(f.calls.some(call => call.includes('stop')), false);
});

test('build failure leaves the old service running without disclosing child output', async t => {
  const f = fixture(t); await f.setup(); f.update();
  f.state.onCommand = (exe, args) => { if (exe === 'npm' && args.includes('build')) throw new Error('synthetic-private-output'); };
  await assert.rejects(f.invoke('deploy'), e => /prepare/.test(e.message) && !/synthetic-private-output/.test(e.message));
  assert.equal(f.state.active, true); assert.equal(f.calls.some(call => call.includes('stop')), false);
});

test('start failure retains the selected release, stopped service and lock for inspection', async t => {
  const f = fixture(t); await f.setup(); f.update();
  f.state.onCommand = (exe, args) => { if (exe === 'systemctl' && args.includes('start')) throw new Error('synthetic-private-output'); };
  await assert.rejects(f.invoke('deploy'), /start.*Start requested; outcome unconfirmed/);
  assert.equal(f.state.active, false); assert(existsSync(join(f.c.runtime_dir, 'deployment.lock')));
  assert.equal(git(join(f.c.runtime_dir, 'current'), 'rev-parse', 'HEAD'), git(f.source, 'rev-parse', 'HEAD'));
});

test('startup waits through unavailable HTTP and peer acquisition, then confirms synchronization', async t => {
  const f = fixture(t); await f.setup(); f.update();
  f.state.onPair = p => {
    if (f.state.pairCalls === 3) throw new LinuxDeploymentError('synthetic-connection-refused');
    if (f.state.pairCalls === 4) return { ...p, peer: { reachable: false }, sync: { state: 'waiting' } };
    return p;
  };
  await f.invoke('deploy'); assert(f.state.pairCalls >= 5);
});

test('synchronization timeout leaves the service running and never promotes or rolls back', async t => {
  const f = fixture(t); await f.setup(); f.update(); f.saveConnection({ sync_timeout_seconds: 2 });
  f.state.onPair = p => ({ ...p, sync: { state: f.state.pairCalls > 2 ? 'syncing' : 'ready' } });
  await assert.rejects(f.invoke('deploy'), /Synchronization timed out/);
  assert.equal(f.state.active, true); assert(f.logs.every(s => !s.includes('Deployment verified')));
  assert.equal(readdirSync(join(f.c.runtime_dir, 'releases')).length, 2);
});

test('wrong post-restart identity fails and is never treated as successful synchronization', async t => {
  const f = fixture(t); await f.setup(); f.update();
  f.state.onPair = p => ({ ...p, nodeId: f.state.pairCalls > 2 ? 'synthetic-wrong-node' : p.nodeId });
  await assert.rejects(f.invoke('deploy'), /identity/);
});

test('dirty source and installed source are rejected; existing locks are not removed', async t => {
  const f = fixture(t); await f.setup();
  writeFileSync(join(f.source, 'untracked'), 'synthetic');
  await assert.rejects(f.invoke('deploy'), /source checkout clean/); rmSync(join(f.source, 'untracked'));
  writeFileSync(join(f.c.runtime_dir, 'current/src/main.js'), 'synthetic-local-edit');
  await assert.rejects(f.invoke('deploy'), /local changes/);
  await assert.rejects(f.invoke('deploy'), /lock exists/);
});

test('modified installed frontend is rejected before building or stopping the standby', async t => {
  const f = fixture(t); await f.setup(); f.update(); f.calls.length = 0;
  writeFileSync(join(f.c.runtime_dir, 'current/dist/index.html'), 'synthetic-modified-build');
  await assert.rejects(f.invoke('deploy'), /prepared release proof/);
  assert.equal(f.calls.some(call => call.includes('stop') || call.includes('ci')), false);
});

test('Linux --stopped updates an inactive managed runtime without status or lifecycle requests', async t => {
  const f = fixture(t); await f.setup(); f.update(); f.state.active = false; f.state.pid = 0; f.calls.length = 0;
  f.c.token_file = join(f.secrets, 'unused-offline-token'); f.saveConnection();
  f.state.onPair = () => { throw Error('Stopped deployment must not query an unavailable application.'); };
  await f.invoke('deploy', ['--stopped']);
  assert.equal(f.state.active, false); assert.equal(f.state.pairCalls, 0);
  assert(!f.calls.some(call => call.includes('stop') || call.includes('start')));
  assert.equal(git(join(f.c.runtime_dir, 'current'), 'rev-parse', 'HEAD'), git(f.source, 'rev-parse', 'HEAD'));
  assert(f.logs.some(s => s.includes('service remains stopped')));
});

test('installed-runtime ownership validation is read-only and checks unit, metadata and artifact proofs', async t => {
  const f = fixture(t); await f.setup(); f.calls.length = 0;
  const options = { source: f.source, run: f.deps.run, unitPath: () => f.unit };
  const before = readFileSync(f.connection), markerPath = join(f.c.runtime_dir, 'deployment.json'), marker = readFileSync(markerPath);
  const current = await validateInstalledRuntime(f.c, options);
  assert.equal(current.release, realpathSync(join(f.c.runtime_dir, 'current')));
  assert.equal(current.revision, git(f.source, 'rev-parse', 'HEAD')); assert.equal(current.service.MainPID, '1234');
  assert.ok(f.calls.some(call => call.some(arg => String(arg).endsWith('linux-deployment-process.js'))));
  assert.ok(!f.calls.some(call => call.includes('stop') || call.includes('start') || call.includes('ci')));
  assert.deepEqual(readFileSync(f.connection), before); assert.equal(existsSync(join(f.c.runtime_dir, 'deployment.lock')), false);
  writeFileSync(markerPath, JSON.stringify({ ...JSON.parse(marker), scope: 'system' }));
  await assert.rejects(validateInstalledRuntime(f.c, options), /mismatched managed runtime metadata/); writeFileSync(markerPath, marker);
  const unit = readFileSync(f.unit); writeFileSync(f.unit, Buffer.concat([unit, Buffer.from('\n# unreviewed change\n')]));
  await assert.rejects(validateInstalledRuntime(f.c, options), /persistent service/); writeFileSync(f.unit, unit);
  for (const patch of [{ DropInPaths: '/synthetic/override.conf' }, { NeedDaemonReload: 'yes' }, { Transient: 'yes' }, { MainPID: '0' }]) {
    f.state.showPatch = patch; await assert.rejects(validateInstalledRuntime(f.c, options), /persistent service/);
  }
  f.state.showPatch = {};
  writeFileSync(join(current.release, 'dist/index.html'), 'unreviewed-frontend');
  await assert.rejects(validateInstalledRuntime(f.c, options), /prepared release proof/);
  assert.equal(readFileSync(join(f.data, 'database.sqlite'), 'utf8'), 'synthetic-retained-history');
});
test('installed-runtime preflight checks process ownership when active and fully stopped state when inactive', async t => {
  const f = fixture(t); await f.setup();
  const options = { source: f.source, run: f.deps.run, unitPath: () => f.unit };
  f.state.onCommand = (_exe, args) => { if (args.some(arg => /linux-deployment-process\.js$/.test(arg))) throw new LinuxDeploymentError('Listener ownership failed.'); };
  await assert.rejects(validateInstalledRuntime(f.c, options), /Listener ownership failed/);
  f.state.onCommand = null; f.state.active = false; f.state.pid = 0;
  assert.equal((await validateInstalledRuntime(f.c, options)).service.ActiveState, 'inactive');
  await assert.rejects(validateInstalledRuntime(f.c, { ...options, state: 'running' }), /persistent service/);
  f.state.showPatch = { ActiveState: 'activating', SubState: 'start' };
  await assert.rejects(validateInstalledRuntime(f.c, options), /neither a confirmed running application nor fully stopped/);
});
test('paired deployment authenticates once and refreshes verified helper code after stopping', async t => {
  const f = fixture(t); await f.setup(); f.update(); const old = realpathSync(join(f.c.runtime_dir, 'current'));
  f.deps.refreshHelper = async ({ source }) => {
    assert.equal(f.state.active, false); assert.equal(realpathSync(join(f.c.runtime_dir, 'current')), old);
    assert.equal(git(source, 'rev-parse', 'HEAD'), git(f.source, 'rev-parse', 'HEAD'));
    assert.ok(existsSync(join(source, '.git/linux-deployment-proof.json'))); f.state.helperCalls.push(source);
  };
  await f.invoke('deploy');
  assert.equal(f.state.authCalls, 1); assert.equal(f.state.leaseClosed, 1); assert.equal(f.state.helperCalls.length, 1);
  assert.equal(f.state.helperCalls[0], realpathSync(join(f.c.runtime_dir, 'current'))); assert.ok(f.state.leaseChecks > 0);
});
test('standalone user deployment needs no privilege authentication or VIP helper', async t => {
  const f = fixture(t); f.env.STMQ_TOPOLOGY = 'standalone';
  writeFileSync(f.c.environment_file, Object.entries(f.env).map(([key, value]) => `${key}='${value}'`).join('\n'), { mode: 0o600 });
  f.deps.status = async () => ({ topology: 'standalone', role: 'master' });
  await f.setup(); f.update(); await f.invoke('deploy');
  assert.equal(f.state.authCalls, 0); assert.equal(f.state.helperCalls.length, 0); assert.equal(f.state.pairCalls, 0);
});
test('lost privilege lease aborts before Stop and always closes its renewal', async t => {
  const f = fixture(t); await f.setup(); f.update(); let expired = false;
  f.state.onCommand = (exe, args) => { if (exe === 'npm' && args.includes('build')) expired = true; };
  f.deps.lease = () => ({ assertValid: () => { if (expired) throw new LinuxDeploymentError('Privilege authorization expired.'); },
    close: async () => { f.state.leaseClosed++; } });
  await assert.rejects(f.invoke('deploy'), /Privilege authorization expired/);
  assert.equal(f.state.active, true); assert.equal(f.calls.some(call => call.includes('stop')), false); assert.equal(f.state.leaseClosed, 1);
});
test('helper refresh failure leaves the selected service stopped and previous release intact', async t => {
  const f = fixture(t); await f.setup(); f.update(); const previous = realpathSync(join(f.c.runtime_dir, 'current'));
  f.deps.refreshHelper = async () => { throw new LinuxDeploymentError('VIP-helper refresh was not confirmed.'); };
  await assert.rejects(f.invoke('deploy'), /failed during helper.*VIP-helper refresh was not confirmed/);
  assert.equal(f.state.active, false); assert.equal(realpathSync(join(f.c.runtime_dir, 'current')), previous);
  assert.equal(f.calls.some(call => call.includes('start')), false); assert.equal(f.state.leaseClosed, 1);
});
test('an external start during helper refresh prevents publishing the prepared release', async t => {
  for (const stopped of [false, true]) {
    const f = fixture(t); await f.setup(); f.update(); const previous = realpathSync(join(f.c.runtime_dir, 'current'));
    if (stopped) { f.state.active = false; f.state.pid = 0; }
    f.calls.length = 0;
    f.deps.refreshHelper = async () => { f.state.active = true; f.state.pid = 9999; };
    await assert.rejects(f.invoke('deploy', stopped ? ['--stopped'] : []), /requires a confirmed inactive service/);
    assert.equal(realpathSync(join(f.c.runtime_dir, 'current')), previous); assert.equal(f.state.active, true);
    assert.equal(f.calls.some(call => call.includes('start')), false);
    assert.equal(f.calls.filter(call => call.includes('stop')).length, stopped ? 0 : 1);
  }
});

test('Linux --stopped refuses a running service without stopping it', async t => {
  const f = fixture(t); await f.setup(); f.calls.length = 0;
  await assert.rejects(f.invoke('deploy', ['--stopped']), /requires a confirmed inactive service/);
  assert.equal(f.state.active, true);
  assert(!f.calls.some(call => call.includes('stop') || call.includes('start') || call.includes('ci')));
});

test('Linux --stopped rechecks inactivity after preparation and preserves an externally started service', async t => {
  const f = fixture(t); await f.setup(); f.update(); f.state.active = false; f.state.pid = 0; f.calls.length = 0;
  const old = realpathSync(join(f.c.runtime_dir, 'current'));
  f.state.onCommand = (exe, args) => { if (exe === 'npm' && args.includes('build')) { f.state.active = true; f.state.pid = 4321; } };
  await assert.rejects(f.invoke('deploy', ['--stopped']), /requires a confirmed inactive service/);
  assert.equal(realpathSync(join(f.c.runtime_dir, 'current')), old);
  assert(!f.calls.some(call => call.includes('stop') || call.includes('start')));
});

test('local status authentication never follows redirects or exposes private responses', async t => {
  const f = fixture(t), tokenFile = join(f.secrets, 'token'); writeFileSync(tokenFile, 'synthetic-private-token', { mode: 0o600 });
  let seen;
  await readPair({ ...f.c, token_file: tokenFile }, { fetchImpl: async (url, options) => {
    seen = { url, options }; return { ok: true, text: async () => JSON.stringify(f.status()) };
  } });
  assert.equal(seen.url, f.c.status_url + '/api/pair'); assert.equal(seen.options.redirect, 'error');
  assert.equal(seen.options.headers.Authorization, 'Bearer synthetic-private-token');
  await assert.rejects(readPair(f.c, { fetchImpl: async () => { throw Error('synthetic-private-response'); } }), e => !/synthetic-private-response/.test(e.message));
});

test('deployment consumes the actual paired status producer through the authenticated application API', async t => {
  const f = fixture(t), config = { directory: join(f.root, 'native-pair-state'), pairId: 'synthetic-api-contract-pair', platform: 'ubuntu',
    databasePath: join(f.data, 'native-source.sqlite'), snapshotDirectory: join(f.root, 'native-snapshots'),
    token: 'synthetic-private-peer-token-01234567890123456789', peerUrl: 'http://127.0.0.1:1', vip: {} };
  const state = new PairState(config); await state.open(); t.after(() => state.close());
  await state.update({ bootstrapPending: false });
  const manager = new PairManager({ config, state, peer: {}, snapshots: {}, announcements: () => null,
    vip: { status: () => ({ owned: false, ready: false, error: null }) } });
  manager.recordPeerStatus({ nodeId: randomUUID(), platform: 'hassio', role: 'master', epoch: randomUUID(), sequence: 0, ancestors: [] }, { state: 'ready' });
  manager.sync = { state: 'ready', sourceAt: Date.now(), verifiedAt: Date.now(), lastSuccessAt: Date.now(), error: null };
  const token = 'synthetic-native-api-token-01234567890123456789';
  const server = createAppServer({ token, role: 'slave', topology: 'pair', store: { getState: () => null },
    engine: { status: () => { throw Error('The management API must not depend on dashboard storage.'); } },
    chartService: { overview: async () => ({ rows: [] }) },
    pairContext: { status: () => manager.status(), canControl: () => manager.canControl() } });
  await new Promise(yes => server.listen(0, '127.0.0.1', yes));
  t.after(() => new Promise(yes => server.close(yes)));
  f.c.status_url = `http://127.0.0.1:${server.address().port}`;
  f.c.token_file = join(f.secrets, 'native-api-token'); writeFileSync(f.c.token_file, token + '\n', { mode: 0o600 }); f.saveConnection();
  assert.equal((await fetch(f.c.status_url + '/api/pair')).status, 401);
  const native = await readPair(f.c);
  assert.equal(native.pairId, config.pairId, 'Pair identity must come from the production status producer.');
  assert.equal(native.nodeId, state.value.nodeId); assert.equal(native.peer.nodeId, manager.peerState.nodeId);
  assert.equal(native.webAccess.role, 'admin'); assert.doesNotThrow(() => validateStandby(native, null, Date.now(), true));
  assert.ok(!JSON.stringify(native).includes(config.token)); assert.ok(!JSON.stringify(native).includes(token));
  f.deps.pair = readPair; f.deps.clock = Date.now;
  await f.setup(); f.update(); await f.invoke('deploy');
  assert.equal(f.state.active, true); assert.equal(f.state.helperCalls.length, 1);
  const ready = await readPair(f.c); assert.doesNotThrow(() => validateStandby(ready, native, Date.now(), true));
});

test('command timeout and cancellation reap the child without leaking output', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'console.error("synthetic-private-output");setTimeout(()=>{},10000)'], { timeout: 30 }), e => /timed out/.test(e.message) && !/synthetic-private-output/.test(e.message));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runCommand(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { signal: controller.signal }), /cancelled/);
});
