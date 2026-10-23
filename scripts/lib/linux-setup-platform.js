import { spawn } from 'node:child_process';
import { lstatSync, realpathSync, readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo, arch as machineArch, platform as machinePlatform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './deployment-command.js';
import { DeploymentSafetyError } from './paired-deployment.js';
import { validateVip } from '../../src/pairing/vip.js';

const fail = message => { throw new DeploymentSafetyError(message); };
export const platformPackages = ['ca-certificates', 'curl', 'xz-utils', 'git', 'python3', 'openssh-client', 'iproute2', 'iputils-arping'];
export const managedBrokerText = '# Managed by st-mq Linux setup.\nlistener 1883 127.0.0.1\nallow_anonymous false\npassword_file /etc/mosquitto/st-mq-passwords\n';
export const helperSourceFiles = ['scripts/pair-vip.js', 'src/pairing/vip.js'];
const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
export function vipServiceText(nodePath) {
  return `[Unit]\nDescription=st-mq restricted virtual IP helper\nRequires=st-mq-vip.socket\nAfter=network.target\n\n[Service]\nType=simple\nUser=root\nGroup=root\nExecStart=${quote(nodePath)} /usr/local/lib/st-mq/scripts/pair-vip.js --serve\nNoNewPrivileges=true\nCapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW\nAmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW\nProtectSystem=strict\nProtectHome=true\nPrivateTmp=true\nRestrictAddressFamilies=AF_UNIX AF_NETLINK AF_INET AF_PACKET\nRestrictSUIDSGID=true\nLockPersonality=true\nMemoryDenyWriteExecute=false\n`;
}
export function vipSocketText(group) {
  return `[Unit]\nDescription=st-mq virtual IP control socket\n\n[Socket]\nListenStream=/run/st-mq-vip/socket\nSocketMode=0660\nSocketUser=root\nSocketGroup=${group}\nDirectoryMode=0755\nRemoveOnStop=true\n\n[Install]\nWantedBy=sockets.target\n`;
}

export function stockBrokerConfiguration({ rootDir = '/', readFile = readFileSync, exists = existsSync, readdir = readdirSync,
  stat = lstatSync, requireRootOwnership = rootDir === '/' } = {}) {
  const path = name => join(rootDir, name);
  try {
    const directory = path('/etc/mosquitto/conf.d'), managed = path('/etc/mosquitto/conf.d/st-mq.conf');
    for (const filename of [path('/etc/mosquitto'), directory, managed, path('/etc/mosquitto/mosquitto.conf')]) {
      let info; try { info = stat(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (info && (info.isSymbolicLink() || requireRootOwnership && (info.uid !== 0 || info.mode & 0o022))) return false;
    }
    if (exists(directory) && readdir(directory).some(name => name.endsWith('.conf') && name !== 'st-mq.conf')) return false;
    if (exists(managed) && readFile(managed, 'utf8') !== managedBrokerText) return false;
    const main = path('/etc/mosquitto/mosquitto.conf');
    if (!exists(main)) return true;
    const lines = readFile(main, 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    const allowed = ['pid_file /run/mosquitto/mosquitto.pid', 'persistence true', 'persistence_location /var/lib/mosquitto/',
      'log_dest file /var/log/mosquitto/mosquitto.log', 'include_dir /etc/mosquitto/conf.d'];
    return lines.includes('include_dir /etc/mosquitto/conf.d') && lines.every(line => allowed.includes(line));
  } catch { return false; }
}

export function trustedNode(path, { stat = lstatSync, realpath = realpathSync } = {}) {
  try {
    const executable = realpath(path);
    let current = executable;
    while (true) {
      const info = stat(current);
      if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) return null;
      if (current === executable ? !info.isFile() || !(info.mode & 0o111) : !info.isDirectory()) return null;
      if (current === '/') break;
      current = dirname(current);
    }
    return executable;
  } catch { return null; }
}

export async function inspectPlatform({ run = runCommand, readFile = readFileSync, stat = lstatSync,
  realpath = realpathSync, platform = machinePlatform(), arch = machineArch(), nodePath = process.execPath,
  user = userInfo().username, exists = existsSync, readdir = readdirSync, signal } = {}) {
  const release = readFile('/etc/os-release', 'utf8');
  const values = Object.fromEntries(release.split('\n').map(line => /^([A-Z_]+)=(?:"([^"\n]*)"|([^\n]*))$/.exec(line))
    .filter(Boolean).map(match => [match[1], match[2] ?? match[3]]));
  const version = values.VERSION_ID, [major, minor] = String(version).split('.').map(Number);
  if (platform !== 'linux' || values.ID !== 'ubuntu' || !/^\d+\.\d+$/.test(version ?? '')
    || !(major > 22 || major === 22 && minor >= 4) || !['x64', 'arm64'].includes(arch))
    fail('Linux setup supports systemd-based Ubuntu 22.04 or newer on amd64 and arm64.');
  if (!exists('/run/systemd/system')) fail('Linux setup requires systemd to be running.');
  const trusted = trustedNode(nodePath, { stat, realpath });
  if (!trusted) fail('Run bash scripts/setup-linux.sh to select a trusted root-owned Node installation.');
  const versionText = await run(trusted, ['-p', 'process.versions.node'], { signal, timeout: 10000 });
  const [nodeMajor, nodeMinor] = versionText.split('.').map(Number);
  if (!(nodeMajor > 22 || nodeMajor === 22 && nodeMinor >= 19))
    fail('Run bash scripts/setup-linux.sh to install a supported Node runtime.');
  const group = await run('id', ['-gn', user], { signal, timeout: 10000 });
  if (!/^[a-z_][a-z0-9_-]*$/.test(user) || user === 'root' || !/^[a-z_][a-z0-9_-]*$/.test(group))
    fail('Run setup as an ordinary application account with a plain primary group name.');
  const wanted = [...platformPackages, 'mosquitto', 'mosquitto-clients'];
  const packageState = await run('dpkg-query', ['-W', '-f=${binary:Package} ${db:Status-Status}\n', ...wanted],
    { signal, timeout: 10000, acceptedExitCodes: [0, 1] });
  const installed = new Set(packageState.split('\n').filter(line => line.endsWith(' installed')).map(line => line.split(' ')[0].split(':')[0]));
  const active = await run('systemctl', ['is-active', 'mosquitto.service'], { signal, timeout: 10000, acceptedExitCodes: [0, 1, 3, 4] });
  return { distribution: 'ubuntu', version, architecture: arch, nodePath: trusted, user, group,
    packages: platformPackages.filter(name => !installed.has(name)),
    broker: { installed: installed.has('mosquitto'), managed: exists('/etc/mosquitto/conf.d/st-mq.conf'), active: active === 'active',
      stock: stockBrokerConfiguration({ readFile, exists, readdir, stat }) } };
}

export function startSudoLease({ run = runCommand, signal, intervalMs = 45000 } = {}) {
  const cancellation = new AbortController();
  let failed = false, closed = false, pending;
  const abort = () => { failed = true; cancellation.abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setInterval(() => {
    if (closed || failed || pending) return;
    pending = Promise.resolve().then(() => run('sudo', ['-n', '-v'], { signal: cancellation.signal, timeout: 10000 }))
      .catch(() => { failed = true; }).finally(() => { pending = null; });
  }, intervalMs);
  timer.unref?.();
  return {
    assertValid() { if (failed || signal?.aborted) fail('Privilege authorization expired or setup was cancelled. Inspect the current service state before retrying.'); },
    async close() { closed = true; clearInterval(timer); signal?.removeEventListener('abort', abort); cancellation.abort(); await pending; },
  };
}

// sudo owns password entry and terminal echo. No password passes through JavaScript.
export async function authenticateSudo({ signal, spawnProcess = spawn, timeout = 120000 } = {}) {
  if (signal?.aborted) fail('Setup cancelled before privilege authentication.');
  await new Promise((yes, no) => {
    const child = spawnProcess('sudo', ['-v'], { stdio: 'inherit', detached: false });
    let reason, timer, killer;
    const cancel = message => {
      if (reason) return;
      reason = message; child.kill('SIGTERM'); killer = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const abort = () => cancel('Setup cancelled during privilege authentication.');
    timer = setTimeout(() => cancel('Privilege authentication timed out.'), timeout);
    child.once('error', () => { reason = 'Could not start sudo; install sudo and retry.'; });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(killer); signal?.removeEventListener('abort', abort);
      if (reason || code !== 0) no(new DeploymentSafetyError(reason ?? 'Privilege authentication was not completed.'));
      else yes();
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function provisionLinux({ source, nodePath, user, group, vip = null, broker = null,
  run = runCommand, signal, log = console.log } = {}) {
  const executable = trustedNode(nodePath);
  if (!executable) fail('Privileged provisioning requires a trusted root-owned Node installation.');
  if (!/^[a-z_][a-z0-9_-]*$/.test(user ?? '') || user === 'root' || !/^[a-z_][a-z0-9_-]*$/.test(group ?? ''))
    fail('Invalid application user or primary group.');
  if (vip) { try { validateVip(vip); } catch { fail('Invalid virtual IP settings.'); } }
  if (broker && (typeof broker.user !== 'string' || !/^[A-Za-z0-9_.@-]{1,128}$/.test(broker.user)
    || typeof broker.password !== 'string' || broker.password.length < 1 || broker.password.length > 4096 || /[\0\r\n]/.test(broker.password)))
    fail('Broker credentials require a plain username and a nonempty single-line password.');
  const temporary = mkdtempSync(join(tmpdir(), 'st-mq-provision-'));
  const requestPath = join(temporary, 'request.json');
  try {
    writeFileSync(requestPath, JSON.stringify({ version: 1, operation: 'setup', source: resolve(source), nodePath: executable,
      user, group, uid: process.getuid(), vip, broker }), { mode: 0o600, flag: 'wx' });
    log('Installing reviewed Linux prerequisites and services.');
    const output = await run('sudo', ['-n', executable, fileURLToPath(new URL('./linux-setup-root.js', import.meta.url)), requestPath],
      { signal, timeout: 1200000 });
    let result;
    try { result = JSON.parse(output); } catch { fail('Privileged installation result was not confirmed; inspect services before retrying.'); }
    if (result.error) fail(result.error);
    if (result.ok !== true) fail('Privileged installation result was not confirmed; inspect services before retrying.');
    return { nodePath: executable };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

// Read only public helper artifacts and systemd metadata; the root-only VIP policy stays private.
export async function pairHelperNeedsRefresh({ source, nodePath, run = runCommand, signal,
  readFile = readFileSync, stat = lstatSync } = {}) {
  const executable = trustedNode(nodePath);
  if (!executable) fail('VIP-helper verification requires a trusted root-owned Node installation.');
  const expected = new Map([
    ['/usr/local/lib/st-mq/package.json', Buffer.from('{"type":"module"}\n')],
    ...helperSourceFiles.map(name => ['/usr/local/lib/st-mq/' + name, readFile(join(source, name))]),
    ['/etc/systemd/system/st-mq-vip.service', Buffer.from(vipServiceText(executable))],
  ]);
  try {
    const socketPath = '/etc/systemd/system/st-mq-vip.socket';
    const socketText = readFile(socketPath, 'utf8');
    const group = /^SocketGroup=([a-z_][a-z0-9_-]*)$/m.exec(socketText)?.[1];
    if (!group) return true;
    expected.set(socketPath, Buffer.from(vipSocketText(group)));
    for (const [filename, contents] of expected) {
      let current = filename;
      while (true) {
        const info = stat(current);
        if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) return true;
        if (current === filename ? !info.isFile() || info.gid !== 0 || (info.mode & 0o7777) !== 0o644 : !info.isDirectory()) return true;
        if (current === '/') break;
        current = dirname(current);
      }
      if (!readFile(filename).equals(contents)) return true;
    }
    for (const name of ['st-mq-vip.service', 'st-mq-vip.socket']) {
      const output = await run('systemctl', ['show', name,
        '--property=LoadState,FragmentPath,DropInPaths,NeedDaemonReload,ActiveState,SubState,UnitFileState'],
      { signal, timeout: 10000, acceptedExitCodes: [0, 1] });
      const state = Object.fromEntries(output.split('\n').map(line => {
        const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
      }));
      if (state.LoadState !== 'loaded' || state.FragmentPath !== '/etc/systemd/system/' + name
        || state.DropInPaths !== '' || state.NeedDaemonReload !== 'no') return true;
      if (name.endsWith('.socket')) {
        if (state.ActiveState !== 'active' || !['listening', 'running'].includes(state.SubState) || state.UnitFileState !== 'enabled') return true;
      } else if (!(state.ActiveState === 'active' && state.SubState === 'running'
        || state.ActiveState === 'inactive' && state.SubState === 'dead')) return true;
    }
    return false;
  } catch {
    if (signal?.aborted) fail('Deployment cancelled during VIP-helper verification.');
    // Missing, unreadable or uncertain installation state must never skip privileged verification.
    return true;
  }
}

// Deployment refreshes public helper code only. Existing policy, group and address ownership remain untouched.
export async function refreshPairHelper({ source, nodePath, run = runCommand, signal, log = console.log } = {}) {
  const executable = trustedNode(nodePath);
  if (!executable) fail('VIP-helper refresh requires a trusted root-owned Node installation.');
  const temporary = mkdtempSync(join(tmpdir(), 'st-mq-helper-'));
  const requestPath = join(temporary, 'request.json');
  try {
    writeFileSync(requestPath, JSON.stringify({ version: 1, operation: 'refresh', source: resolve(source), nodePath: executable,
      uid: process.getuid() }), { mode: 0o600, flag: 'wx' });
    log('Refreshing the installed restricted VIP helper.');
    const output = await run('sudo', ['-n', executable, fileURLToPath(new URL('./linux-setup-root.js', import.meta.url)), requestPath],
      { signal, timeout: 120000 });
    let result;
    try { result = JSON.parse(output); } catch { fail('VIP-helper refresh was not confirmed; inspect its service before retrying.'); }
    if (result.error) fail(result.error);
    if (result.ok !== true) fail('VIP-helper refresh was not confirmed; inspect its service before retrying.');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
