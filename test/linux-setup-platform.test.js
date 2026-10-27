import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, lstatSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';
import { EventEmitter } from 'node:events';
import { inspectPlatform, trustedNode, authenticateSudo, provisionLinux, platformPackages, stockBrokerConfiguration, startSudoLease, vipServiceText, vipSocketText } from '../scripts/lib/linux-setup-platform.js';
import { installProvisioning, validateProvisionRequest } from '../scripts/lib/linux-setup-root.js';
import { runCommand } from '../scripts/lib/deployment-command.js';
import { installSetupDependencies } from '../scripts/lib/linux-setup-bootstrap.js';

const source = resolve(import.meta.dirname, '..');
const vip = { interface: 'eth0', address: '192.0.2.30', prefixLength: 24 };
const request = overrides => ({ version: 1, operation: 'setup', source, nodePath: '/usr/bin/node', uid: 1000,
  user: 'operator', group: 'operator', vip: null, broker: null, ...overrides });
const temp = () => mkdtempSync(join(tmpdir(), 'st-mq-platform-'));
const fakeStat = path => ({ uid: 0, mode: path === '/usr/bin/node' ? 0o100755 : 0o40755,
  isSymbolicLink: () => false, isFile: () => path === '/usr/bin/node', isDirectory: () => path !== '/usr/bin/node' });
const defaultInspect = overrides => inspectPlatform({ platform: 'linux', arch: 'x64', nodePath: '/usr/bin/node', user: 'operator',
  realpath: path => path, stat: fakeStat, readFile: () => 'ID=ubuntu\nVERSION_ID="22.04"\n', exists: () => true,
  run: async (exe, args) => exe === '/usr/bin/node' ? '24.22.1' : exe === 'id' ? 'operator'
    : exe === 'systemctl' ? 'inactive' : platformPackages.map(name => `${name} installed`).join('\n'), ...overrides });

for (const version of ['22.04', '24.04', '26.04']) {
  for (const arch of ['x64', 'arm64']) test(`detects supported Ubuntu ${version} ${arch}`, async () => {
    const info = await defaultInspect({ arch, readFile: () => `ID=ubuntu\nVERSION_ID="${version}"\n` });
    assert.equal(info.version, version); assert.equal(info.architecture, arch); assert.deepEqual(info.packages, []);
    assert.equal(info.broker.installed, false);
  });
}
test('unsupported platform, distro, architecture and unavailable systemd fail before package work', async () => {
  for (const options of [{ platform: 'darwin' }, { arch: 'ia32' }, { readFile: () => 'ID=debian\nVERSION_ID="12"\n' },
    { readFile: () => 'ID=ubuntu\nVERSION_ID="20.04"\n' }, { exists: () => false }])
    await assert.rejects(defaultInspect({ ...options, run: async () => { assert.fail('No command expected'); } }), /Ubuntu|systemd/);
});
test('Node executable and every ancestor must be protected and root owned', () => {
  assert.equal(trustedNode('/usr/bin/node', { stat: fakeStat, realpath: path => path }), '/usr/bin/node');
  for (const name of ['/usr/bin/node', '/usr/bin', '/usr', '/']) {
    assert.equal(trustedNode('/usr/bin/node', { realpath: path => path, stat: path => ({ ...fakeStat(path), ...(path === name ? { uid: 1000 } : {}) }) }), null);
    assert.equal(trustedNode('/usr/bin/node', { realpath: path => path, stat: path => ({ ...fakeStat(path), ...(path === name ? { mode: 0o777 } : {}) }) }), null);
  }
});
test('old Node and untrusted Node are rejected with the bootstrap command', async () => {
  await assert.rejects(defaultInspect({ run: async () => '22.18.0' }), /bash scripts\/setup-linux.sh/);
  await assert.rejects(defaultInspect({ stat: () => { throw Error(); } }), /trusted root-owned Node/);
});
test('missing package list and managed broker are detected without root mutations', async () => {
  const info = await defaultInspect({ exists: () => true, run: async (exe) => exe === '/usr/bin/node' ? '22.19.0'
    : exe === 'id' ? 'operator' : exe === 'systemctl' ? 'active' : 'git installed\nmosquitto installed' });
  assert.ok(info.packages.includes('iproute2')); assert.ok(!info.packages.includes('git'));
  assert.deepEqual(info.broker, { installed: true, managed: true, active: true, stock: false });
});

function fakeSudo(result, observed) {
  return (exe, args, options) => {
    observed.push({ exe, args, options });
    const child = new EventEmitter();
    child.kill = signal => { observed.push(signal); queueMicrotask(() => child.emit('close', 1)); };
    if (result !== undefined) queueMicrotask(() => child.emit('close', result));
    return child;
  };
}
test('sudo authenticates through its own inherited terminal, with no password input arguments', async () => {
  const observed = []; await authenticateSudo({ spawnProcess: fakeSudo(0, observed) });
  assert.deepEqual(observed, [{ exe: 'sudo', args: ['-v'], options: { stdio: 'inherit', detached: false } }]);
});
test('sudo cancellation and rejected authentication are bounded', async () => {
  await assert.rejects(authenticateSudo({ spawnProcess: fakeSudo(1, []) }), /not completed/);
  const controller = new AbortController(), observed = [];
  const pending = authenticateSudo({ signal: controller.signal, spawnProcess: fakeSudo(undefined, observed) });
  controller.abort(); await assert.rejects(pending, /cancelled/); assert.ok(observed.includes('SIGTERM'));
  await assert.rejects(authenticateSudo({ spawnProcess: fakeSudo(undefined, []), timeout: 1 }), /timed out/);
});
test('sudo lease renews without prompting and rejects further privileged work after renewal loss', async () => {
  const calls = []; let rejectRenewal = false;
  const lease = startSudoLease({ intervalMs: 2, run: async (exe, args, options) => {
    calls.push({ exe, args, options }); if (rejectRenewal) throw Error('synthetic-private-sudo-output'); return '';
  } });
  try {
    await new Promise(resolve => setTimeout(resolve, 12)); lease.assertValid(); assert.ok(calls.length);
    assert.equal(calls[0].exe, 'sudo'); assert.deepEqual(calls[0].args, ['-n', '-v']); assert.equal(calls[0].options.timeout, 10000);
    rejectRenewal = true; await new Promise(resolve => setTimeout(resolve, 12));
    assert.throws(() => lease.assertValid(), error => /Privilege authorization expired/.test(error.message) && !error.message.includes('synthetic-private'));
  } finally { await lease.close(); }
  const count = calls.length; await new Promise(resolve => setTimeout(resolve, 8)); assert.equal(calls.length, count);
});
test('stock broker detection matches managed configuration and refuses other listeners and symbolic paths', () => {
  const root = temp();
  try {
    mkdirSync(join(root, 'etc/mosquitto/conf.d'), { recursive: true });
    writeFileSync(join(root, 'etc/mosquitto/mosquitto.conf'), '# stock\npid_file /run/mosquitto/mosquitto.pid\ninclude_dir /etc/mosquitto/conf.d\n');
    assert.equal(stockBrokerConfiguration({ rootDir: root }), true);
    const extra = join(root, 'etc/mosquitto/conf.d/external.conf'); writeFileSync(extra, 'listener 1884\n');
    assert.equal(stockBrokerConfiguration({ rootDir: root }), false); rmSync(extra);
    symlinkSync(join(root, 'absent'), join(root, 'etc/mosquitto/conf.d/st-mq.conf'));
    assert.equal(stockBrokerConfiguration({ rootDir: root }), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fixtureRunner(root, calls, { installed = [...platformPackages, 'mosquitto', 'mosquitto-clients'], failAt } = {}) {
  return async (exe, args, options) => {
    calls.push({ exe, args, options });
    if (failAt?.(exe, args)) throw Error('Synthetic command failed');
    if (exe === 'dpkg-query') return installed.map(name => `${name} installed`).join('\n');
    if (exe === 'id') return '103';
    if (exe === 'systemctl' && args[0] === 'is-active') return args[1] === 'mosquitto.service' ? 'active' : 'inactive';
    if (exe === 'systemctl' && args[0] === 'is-enabled') return 'not-found';
    if (exe === 'mosquitto_passwd') {
      assert.equal(args[0], '-U');
      const lines = readFileSync(args[1], 'utf8').split('\n');
      assert.equal(lines[0], 'device:synthetic-password');
      writeFileSync(args[1], 'device:$7$101$c3ludGhldGlj$c3ludGhldGljaGFzaA==\n');
    }
    return '';
  };
}
test('standalone provisioning with installed prerequisites makes no files or service changes', async () => {
  const root = temp(), calls = [];
  try {
    const result = await installProvisioning(request(), { rootDir: root, fixture: true, run: fixtureRunner(root, calls) });
    assert.deepEqual(result, { helper: false, broker: false, packages: [] });
    assert.deepEqual(calls.map(call => call.exe), ['dpkg-query']);
    assert.equal(existsSync(join(root, 'etc')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('only missing prerequisite packages are installed', async () => {
  const root = temp(), calls = [];
  try {
    await installProvisioning(request(), { rootDir: root, fixture: true,
      run: fixtureRunner(root, calls, { installed: platformPackages.filter(name => name !== 'iputils-arping') }) });
    assert.deepEqual(calls.find(call => call.exe === 'apt-get' && call.args[0] === 'install').args,
      ['install', '-y', '--no-install-recommends', 'iputils-arping']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('paired provisioning installs only protected current helper code and group-specific socket', async () => {
  const root = temp(), calls = [];
  try {
    await installProvisioning(request({ vip }), { rootDir: root, fixture: true, run: fixtureRunner(root, calls) });
    const policy = join(root, 'etc/st-mq-vip/policy.json');
    assert.deepEqual(JSON.parse(readFileSync(policy)), vip); assert.equal(lstatSync(policy).mode & 0o777, 0o600);
    assert.equal(lstatSync(dirname(policy)).mode & 0o777, 0o700);
    assert.equal(readFileSync(join(root, 'etc/systemd/system/st-mq-vip.socket'), 'utf8'), vipSocketText('operator'));
    assert.equal(readFileSync(join(root, 'etc/systemd/system/st-mq-vip.service'), 'utf8'), vipServiceText('/usr/bin/node'));
    for (const name of ['scripts/pair-vip.js', 'src/pairing/vip.js']) {
      const installed = join(root, 'usr/local/lib/st-mq', name);
      assert.deepEqual(readFileSync(installed), readFileSync(join(source, name))); assert.equal(lstatSync(installed).mode & 0o777, 0o644);
    }
    assert.ok(calls.some(call => call.args.join(' ') === 'enable --now st-mq-vip.socket'));
    assert.ok(!calls.some(call => ['ip', 'arping'].includes(call.exe)));
    // Execute the installed module and its real Unix socket protocol, with synthetic network operations.
    const helper = await import(pathToFileURL(join(root, 'usr/local/lib/st-mq/scripts/pair-vip.js')));
    const operations = [], socketPath = join(root, 'vip.sock');
    const server = helper.serveVip({ socketPath, manage: args => helper.manageVip(args, { policyPath: policy,
      requireRootPolicy: false, interfaces: () => ({ eth0: [] }), run: async (...args) => { operations.push(args); return ''; } }) });
    await new Promise(yes => server.once('listening', yes));
    const exchange = args => new Promise((yes, no) => {
      const socket = createConnection(socketPath); let output = '';
      socket.on('connect', () => socket.write(JSON.stringify(args) + '\n')); socket.on('data', data => { output += data; });
      socket.on('end', () => yes(output)); socket.on('error', no);
    });
    try {
      assert.equal(await exchange(['acquire', vip.interface, vip.address, '24']), 'ok\n');
      assert.equal(await exchange(['acquire', vip.interface, '192.0.2.31', '24']), 'error:vip_policy_mismatch\n');
      assert.deepEqual(operations.map(([exe]) => exe), ['ip', 'arping']);
    } finally { await new Promise(yes => server.close(yes)); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('helper refresh preserves the policy and group and backs up changed public code', async () => {
  const root = temp(), calls = [];
  try {
    await installProvisioning(request({ vip }), { rootDir: root, fixture: true, run: fixtureRunner(root, calls) });
    const installed = join(root, 'usr/local/lib/st-mq/scripts/pair-vip.js'); writeFileSync(installed, 'changed-code');
    const result = await installProvisioning({ version: 1, operation: 'refresh', source, nodePath: '/usr/bin/node', uid: 1000 },
      { rootDir: root, fixture: true, run: fixtureRunner(root, calls) });
    assert.equal(result.helper, true); assert.deepEqual(JSON.parse(readFileSync(join(root, 'etc/st-mq-vip/policy.json'))), vip);
    assert.equal(readFileSync(join(root, 'etc/systemd/system/st-mq-vip.socket'), 'utf8'), vipSocketText('operator'));
    const { readdirSync } = await import('node:fs');
    assert.ok(readdirSync(dirname(installed)).some(name => name.startsWith('pair-vip.js.backup-')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('managed broker credentials never enter command arguments and provisioning is loopback-only', async () => {
  const root = temp(), calls = [];
  try {
    await installProvisioning(request({ broker: { user: 'device', password: 'synthetic-password' } }),
      { rootDir: root, fixture: true, run: fixtureRunner(root, calls, { installed: platformPackages }) });
    const serialized = JSON.stringify(calls);
    assert.ok(!serialized.includes('synthetic-password')); assert.ok(calls.some(call => call.exe === 'mosquitto_passwd'));
    const password = join(root, 'etc/mosquitto/st-mq-passwords');
    assert.equal(lstatSync(password).mode & 0o777, 0o640); assert.ok(!readFileSync(password, 'utf8').includes('synthetic-password'));
    assert.match(readFileSync(join(root, 'etc/mosquitto/conf.d/st-mq.conf'), 'utf8'), /listener 1883 127\.0\.0\.1\nallow_anonymous false/);
    const mask = calls.findIndex(call => call.args.join(' ') === 'mask --runtime mosquitto.service');
    const apt = calls.findIndex(call => call.exe === 'apt-get');
    const unmask = calls.findIndex(call => call.args.join(' ') === 'unmask --runtime mosquitto.service');
    assert.ok(mask >= 0 && mask < apt && unmask > apt);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('restrictive umask retains readable helper files and broker group access with private policy', async () => {
  const root = temp(), calls = [], previous = process.umask(0o077);
  try {
    await installProvisioning(request({ vip, broker: { user: 'device', password: 'synthetic-password' } }),
      { rootDir: root, fixture: true, run: fixtureRunner(root, calls) });
    for (const name of ['usr/local/lib/st-mq/package.json', 'usr/local/lib/st-mq/scripts/pair-vip.js',
      'etc/systemd/system/st-mq-vip.service', 'etc/systemd/system/st-mq-vip.socket', 'etc/mosquitto/conf.d/st-mq.conf'])
      assert.equal(lstatSync(join(root, name)).mode & 0o777, 0o644, name);
    assert.equal(lstatSync(join(root, 'etc/mosquitto/st-mq-passwords')).mode & 0o777, 0o640);
    assert.equal(lstatSync(join(root, 'etc/st-mq-vip/policy.json')).mode & 0o777, 0o600);
    assert.equal(lstatSync(join(root, 'etc/st-mq-vip')).mode & 0o777, 0o700);
  } finally { process.umask(previous); rmSync(root, { recursive: true, force: true }); }
});
test('unmanaged broker configuration and symlinked destinations are rejected before commands', async () => {
  for (const variant of ['config', 'symlink', 'dangling-symlink']) {
    const root = temp(), calls = [];
    try {
      mkdirSync(join(root, 'etc/mosquitto/conf.d'), { recursive: true });
      if (variant === 'config') writeFileSync(join(root, 'etc/mosquitto/conf.d/other.conf'), 'listener 1884\n');
      else { mkdirSync(join(root, 'usr/local/lib'), { recursive: true }); symlinkSync(join(root, variant === 'symlink' ? 'etc' : 'absent'), join(root, 'usr/local/lib/st-mq')); }
      await assert.rejects(installProvisioning(request({ vip, broker: variant === 'config' ? { user: 'device', password: 'synthetic-password' } : null }),
        { rootDir: root, fixture: true, run: fixtureRunner(root, calls) }), /unmanaged|symbolic link/);
      assert.equal(calls.length, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
test('package failure leaves a safe broker listener and never starts the broker', async () => {
  const root = temp(), calls = [];
  try {
    await assert.rejects(installProvisioning(request({ broker: { user: 'device', password: 'synthetic-password' } }),
      { rootDir: root, fixture: true, run: fixtureRunner(root, calls, { installed: platformPackages, failAt: exe => exe === 'apt-get' }) }), /Synthetic/);
    assert.match(readFileSync(join(root, 'etc/mosquitto/conf.d/st-mq.conf'), 'utf8'), /127\.0\.0\.1/);
    assert.ok(!calls.some(call => call.args.join(' ') === 'restart mosquitto.service'));
    assert.equal(calls.filter(call => call.args.join(' ') === 'unmask --runtime mosquitto.service').length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('broker rerun preserves unrelated hashed users and changes only the chosen account', async () => {
  const root = temp(), calls = [];
  try {
    const runner = fixtureRunner(root, calls);
    await installProvisioning(request({ broker: { user: 'device', password: 'synthetic-password' } }), { rootDir: root, fixture: true, run: runner });
    const password = join(root, 'etc/mosquitto/st-mq-passwords');
    const other = 'another:$7$101$c3ludGhldGlj$b3RoZXJoYXNo\n';
    writeFileSync(password, other + readFileSync(password, 'utf8'));
    await installProvisioning(request({ broker: { user: 'device', password: 'synthetic-password' } }), { rootDir: root, fixture: true, run: runner });
    const text = readFileSync(password, 'utf8');
    assert.ok(text.startsWith(other)); assert.equal(text.split('\n').filter(line => line.startsWith('device:')).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('broker hash conversion failure preserves active credentials and removes private pending data', async () => {
  const root = temp(), calls = [];
  try {
    const setup = request({ broker: { user: 'device', password: 'synthetic-password' } });
    await installProvisioning(setup, { rootDir: root, fixture: true, run: fixtureRunner(root, calls) });
    const password = join(root, 'etc/mosquitto/st-mq-passwords'), previous = readFileSync(password);
    calls.length = 0;
    await assert.rejects(installProvisioning(setup, { rootDir: root, fixture: true,
      run: fixtureRunner(root, calls, { failAt: exe => exe === 'mosquitto_passwd' }) }), /Synthetic/);
    assert.deepEqual(readFileSync(password), previous);
    const { readdirSync } = await import('node:fs');
    assert.ok(!readdirSync(dirname(password)).some(name => name.includes('.pending-')));
    assert.ok(!calls.some(call => call.args.join(' ') === 'restart mosquitto.service'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('a changed active helper socket is restarted so its reviewed group takes effect', async () => {
  const root = temp(), calls = [];
  try {
    await installProvisioning(request({ vip }), { rootDir: root, fixture: true, run: fixtureRunner(root, calls) });
    calls.length = 0;
    const runner = fixtureRunner(root, calls);
    await installProvisioning(request({ vip, group: 'newgroup' }), { rootDir: root, fixture: true, run: async (exe, args, options) => {
      const output = await runner(exe, args, options);
      return exe === 'systemctl' && args.join(' ') === 'is-active st-mq-vip.socket' ? 'active' : output;
    } });
    assert.equal(calls.filter(call => call.args.join(' ') === 'restart st-mq-vip.socket').length, 1);
    assert.equal(readFileSync(join(root, 'etc/systemd/system/st-mq-vip.socket'), 'utf8'), vipSocketText('newgroup'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('native installed mosquitto_passwd hashes a staged synthetic password', async t => {
  if (!existsSync('/usr/bin/mosquitto_passwd')) { t.skip('Native Mosquitto tools are unavailable.'); return; }
  const root = temp(), calls = [];
  try {
    const runner = fixtureRunner(root, calls);
    await installProvisioning(request({ broker: { user: 'device', password: 'synthetic-password' } }), { rootDir: root, fixture: true,
      run: (exe, args, options) => exe === 'mosquitto_passwd' ? runCommand('/usr/bin/mosquitto_passwd', args, options) : runner(exe, args, options) });
    assert.match(readFileSync(join(root, 'etc/mosquitto/st-mq-passwords'), 'utf8'), /^device:\$7\$[1-9][0-9]*\$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('invalid request fields and authority-bearing overrides fail closed', () => {
  for (const value of [request({ user: 'root' }), request({ uid: 0 }), request({ nodePath: '/tmp/node;echo' }),
    request({ vip: { ...vip, sudo: true } }), request({ broker: { user: 'device', password: 'synthetic-one\nsynthetic-two' } }),
    request({ retiredField: true })]) assert.throws(() => validateProvisionRequest(value));
});
test('provisioning transports private credentials through a deleted private request file only', async () => {
  let privatePath, body;
  await provisionLinux({ source, nodePath: process.execPath, user: 'operator', group: 'operator', vip: null,
    broker: { user: 'device', password: 'synthetic-password' }, log: () => {},
    run: async (exe, args) => {
      assert.equal(exe, 'sudo'); assert.ok(!args.join(' ').includes('synthetic-password'));
      privatePath = args.at(-1); body = JSON.parse(readFileSync(privatePath, 'utf8'));
      assert.equal(lstatSync(privatePath).mode & 0o777, 0o600); assert.equal(lstatSync(dirname(privatePath)).mode & 0o777, 0o700);
      return '{"ok":true}';
    } });
  assert.equal(body.broker.password, 'synthetic-password'); assert.equal(existsSync(privatePath), false);
});
test('bootstrap has valid shell syntax and help requires neither Node nor sudo', async () => {
  await runCommand('bash', ['-n', join(source, 'scripts/setup-linux.sh')]);
  const output = await runCommand('bash', [join(source, 'scripts/setup-linux.sh'), '--help']);
  assert.match(output, /secrets\.json/); assert.match(output, /--dry-run/);
});
test('fresh source dependencies are installed without inherited application settings or Node injection', async () => {
  const root = temp();
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'synthetic-setup-bootstrap', version: '1.0.0', private: true,
      scripts: { postinstall: 'node install.js' } }));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'synthetic-setup-bootstrap', version: '1.0.0', lockfileVersion: 3,
      packages: { '': { name: 'synthetic-setup-bootstrap', version: '1.0.0', hasInstallScript: true } } }));
    writeFileSync(join(root, 'install.js'), `const assert=require('node:assert/strict');const fs=require('node:fs');
assert.equal(process.env.STMQ_API_TOKEN,undefined);assert.equal(process.env.NODE_OPTIONS,undefined);assert.equal(process.env.NODE_PATH,undefined);
fs.writeFileSync('prepared','ready');`);
    await installSetupDependencies({ source: root, env: { ...process.env, STMQ_API_TOKEN: 'synthetic-private-bootstrap-token',
      NODE_OPTIONS: '--invalid-inherited-option', NODE_PATH: '/synthetic/unreviewed/modules' } });
    assert.equal(readFileSync(join(root, 'prepared'), 'utf8'), 'ready');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('dependency installation failure retains private diagnostics without exposing raw npm output', async () => {
  const root = temp(); let diagnostic;
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'synthetic-bootstrap-failure', version: '1.0.0', private: true,
      scripts: { postinstall: 'node -e "console.error(\'synthetic-private-npm-output\');process.exit(1)"' } }));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'synthetic-bootstrap-failure', version: '1.0.0', lockfileVersion: 3,
      packages: { '': { name: 'synthetic-bootstrap-failure', version: '1.0.0', hasInstallScript: true } } }));
    await assert.rejects(installSetupDependencies({ source: root }), error => {
      assert.ok(!error.message.includes('synthetic-private-npm-output'));
      diagnostic = error.message.split('Private diagnostic log: ')[1]; return Boolean(diagnostic);
    });
    assert.equal(lstatSync(diagnostic).mode & 0o777, 0o600); assert.equal(lstatSync(dirname(diagnostic)).mode & 0o777, 0o700);
    assert.ok(readFileSync(diagnostic, 'utf8').includes('synthetic-private-npm-output'));
  } finally {
    if (diagnostic) rmSync(dirname(diagnostic), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
test('the actual bootstrap path strips Node injection and inherited runtime settings before Node executes', async t => {
  if (!existsSync('/run/systemd/system') || !/^ID=ubuntu$/m.test(readFileSync('/etc/os-release', 'utf8'))) {
    t.skip('Native bootstrap execution requires a supported Ubuntu systemd host.'); return;
  }
  const root = temp();
  try {
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'src/app'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'scripts/setup-linux.sh'), readFileSync(join(source, 'scripts/setup-linux.sh')));
    const check = `import assert from 'node:assert/strict';assert.equal(process.env.NODE_OPTIONS,undefined);assert.equal(process.env.NODE_PATH,undefined);assert.equal(process.env.STMQ_API_TOKEN,undefined);`;
    writeFileSync(join(root, 'src/app/config.js'), check + 'export const fixture=true;');
    writeFileSync(join(root, 'scripts/setup-linux.js'), check + 'console.log("bootstrap sanitized");');
    const output = await runCommand('bash', [join(root, 'scripts/setup-linux.sh'), '--dry-run'], { timeout: 10000,
      env: { ...process.env, NODE_OPTIONS: '--invalid-inherited-option', NODE_PATH: '/synthetic/modules', STMQ_API_TOKEN: 'synthetic-private-value' } });
    assert.equal(output, 'bootstrap sanitized');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
