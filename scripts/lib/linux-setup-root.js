#!/usr/bin/env node
// Privileged installer: only fixed destinations and reviewed, validated values.
import { readFileSync, writeFileSync, lstatSync, realpathSync, existsSync, mkdirSync, renameSync, copyFileSync,
  chmodSync, chownSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { runCommand } from './deployment-command.js';
import { DeploymentSafetyError } from './paired-deployment.js';
import { trustedNode, platformPackages, managedBrokerText, stockBrokerConfiguration } from './linux-setup-platform.js';
import { validateVip } from '../../src/pairing/vip.js';

const fail = message => { throw new DeploymentSafetyError(message); };
const account = value => typeof value === 'string' && /^[a-z_][a-z0-9_-]*$/.test(value) && value !== 'root';
const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));

export function validateProvisionRequest(request) {
  const fields = request?.operation === 'refresh' ? ['version', 'operation', 'source', 'nodePath', 'uid']
    : ['version', 'operation', 'source', 'nodePath', 'uid', 'user', 'group', 'vip', 'broker'];
  if (!exact(request, fields) || request.version !== 1 || !['setup', 'refresh'].includes(request.operation)
    || !Number.isInteger(request.uid) || request.uid < 1 || !isAbsolute(request.source ?? '') || request.source !== resolve(request.source)
    || !isAbsolute(request.nodePath ?? '') || !/^\/[A-Za-z0-9_./ -]+$/.test(request.nodePath)) fail('Invalid privileged installation request.');
  if (request.operation === 'setup') {
    if (!account(request.user) || !account(request.group)) fail('Invalid privileged application account.');
    if (request.vip !== null) {
      try { validateVip(request.vip); } catch { fail('Invalid privileged virtual IP settings.'); }
      if (!exact(request.vip, ['interface', 'address', 'prefixLength'])) fail('Unsupported virtual IP settings.');
    }
    if (request.broker !== null && (!exact(request.broker, ['user', 'password'])
      || !/^[A-Za-z0-9_.@-]{1,128}$/.test(request.broker.user ?? '') || typeof request.broker.password !== 'string'
      || !request.broker.password.length || request.broker.password.length > 4096 || /[\0\r\n]/.test(request.broker.password)))
      fail('Invalid privileged broker credentials.');
  }
  return request;
}

export function vipServiceText(nodePath) {
  return `[Unit]\nDescription=st-mq restricted virtual IP helper\nRequires=st-mq-vip.socket\nAfter=network.target\n\n[Service]\nType=simple\nUser=root\nGroup=root\nExecStart=${quote(nodePath)} /usr/local/lib/st-mq/scripts/pair-vip.js --serve\nNoNewPrivileges=true\nCapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW\nAmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW\nProtectSystem=strict\nProtectHome=true\nPrivateTmp=true\nRestrictAddressFamilies=AF_UNIX AF_NETLINK AF_INET AF_PACKET\nRestrictSUIDSGID=true\nLockPersonality=true\nMemoryDenyWriteExecute=false\n`;
}
export function vipSocketText(group) {
  return `[Unit]\nDescription=st-mq virtual IP control socket\n\n[Socket]\nListenStream=/run/st-mq-vip/socket\nSocketMode=0660\nSocketUser=root\nSocketGroup=${group}\nDirectoryMode=0755\nRemoveOnStop=true\n\n[Install]\nWantedBy=sockets.target\n`;
}

// rootDir is used only by isolated tests. The executable entry point always uses '/'.
export async function installProvisioning(input, { rootDir = '/', run = runCommand, signal, fixture = false } = {}) {
  const request = validateProvisionRequest(input);
  if (rootDir !== '/' && !fixture) fail('Alternate installation roots are restricted to isolated tests.');
  if (!fixture && trustedNode(request.nodePath) !== request.nodePath) fail('Privileged Node runtime must be a canonical root-owned protected path.');
  const path = name => join(rootDir, name);
  const command = (exe, args, options = {}) => run(exe, args, { timeout: 120000, signal, ...options });
  // Reject directory symlinks, including ancestors, before writing privileged files.
  const checkPath = value => {
    let current = value;
    while (current !== dirname(current)) {
      let info;
      try { info = lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (info) {
        if (info.isSymbolicLink()) fail('Refusing a symbolic link in an installation destination.');
        if (!fixture && (info.uid !== 0 || info.mode & 0o022)) fail('Privileged installation destinations must be root-owned and protected.');
      }
      if (current === rootDir) break;
      current = dirname(current);
    }
  };
  const directory = (name, mode = 0o755) => {
    const destination = path(name); checkPath(destination);
    if (!existsSync(destination)) mkdirSync(destination, { recursive: true, mode });
    if (!lstatSync(destination).isDirectory()) fail('Installation destination is not a directory.');
    chmodSync(destination, mode); if (!fixture) chownSync(destination, 0, 0);
  };
  const install = (name, contents, mode = 0o644, gid = 0) => {
    const destination = path(name); checkPath(destination);
    if (existsSync(destination) && !lstatSync(destination).isFile()) fail('Installation destination is not a regular file.');
    if (existsSync(destination) && readFileSync(destination).equals(Buffer.from(contents))) {
      chmodSync(destination, mode); if (!fixture) chownSync(destination, 0, gid); return false;
    }
    if (existsSync(destination)) {
      const backup = destination + '.backup-' + randomUUID(); copyFileSync(destination, backup);
      chmodSync(backup, mode); if (!fixture) chownSync(backup, 0, gid);
    }
    const temporary = destination + '.install-' + randomUUID();
    writeFileSync(temporary, contents, { mode, flag: 'wx' }); if (!fixture) chownSync(temporary, 0, gid);
    renameSync(temporary, destination); return true;
  };
  const helperFiles = ['scripts/pair-vip.js', 'src/pairing/vip.js'];
  const publicCode = Object.fromEntries(helperFiles.map(name => {
    const filename = join(request.source, name);
    if (realpathSync(filename) !== filename || !lstatSync(filename).isFile()) fail('Helper source must contain regular current files.');
    return [name, readFileSync(filename)];
  }));
  const helper = request.operation === 'refresh' || request.vip !== null;
  let vip = request.vip, group = request.group;
  if (request.operation === 'refresh') {
    const policy = path('/etc/st-mq-vip/policy.json'), socket = path('/etc/systemd/system/st-mq-vip.socket');
    if (!existsSync(policy) || !existsSync(socket)) fail('Run Linux setup to install the restricted VIP helper first.');
    try {
      checkPath(policy); checkPath(socket);
      if (!fixture && (lstatSync(policy).uid !== 0 || (lstatSync(policy).mode & 0o077))) throw Error();
      vip = validateVip(JSON.parse(readFileSync(policy, 'utf8')));
      const text = readFileSync(socket, 'utf8'); group = /^SocketGroup=([a-z_][a-z0-9_-]*)$/m.exec(text)?.[1];
      if (!group || text !== vipSocketText(group)) throw Error();
    } catch { fail('Installed VIP helper policy or socket differs from the current managed installation; run setup to review it.'); }
  }
  if (!fixture && request.operation === 'setup') {
    const uid = Number(await command('id', ['-u', request.user]));
    const primaryGroup = await command('id', ['-gn', request.user]);
    if (uid !== request.uid || primaryGroup !== request.group) fail('Application account changed before privileged provisioning.');
  }
  const brokerText = managedBrokerText;
  if (request.broker) {
    if (!stockBrokerConfiguration({ rootDir })) fail('Existing broker configuration is unmanaged; preserve it and configure broker credentials in secrets.json.');
  }
  // Validate fixed destinations before package installation or service changes.
  for (const destination of ['/etc/systemd/system', '/usr/local/lib/st-mq', ...(helper ? ['/etc/st-mq-vip'] : []),
    ...(request.broker ? ['/etc/mosquitto/conf.d', '/etc/mosquitto/st-mq-passwords'] : [])]) checkPath(path(destination));
  let missing = [];
  if (request.operation === 'setup') {
    const packages = [...platformPackages, ...(request.broker ? ['mosquitto', 'mosquitto-clients'] : [])];
    const state = await command('dpkg-query', ['-W', '-f=${binary:Package} ${db:Status-Status}\n', ...packages], { acceptedExitCodes: [0, 1] });
    const installed = new Set(state.split('\n').filter(line => line.endsWith(' installed')).map(line => line.split(' ')[0].split(':')[0]));
    missing = packages.filter(name => !installed.has(name));
  }
  let masked = false;
  try {
    if (request.broker && missing.includes('mosquitto')) {
      // A failed package install must also leave a loopback-only, authentication-required configuration.
      directory('/etc/mosquitto/conf.d');
      install('/etc/mosquitto/conf.d/st-mq.conf', brokerText);
      if (!existsSync(path('/etc/mosquitto/st-mq-passwords'))) install('/etc/mosquitto/st-mq-passwords', '', 0o600);
      // Prevent package post-install startup with its default wildcard listener.
      const state = await command('systemctl', ['is-enabled', 'mosquitto.service'], { acceptedExitCodes: [0, 1, 4] });
      if (['masked', 'masked-runtime'].includes(state)) fail('Mosquitto is masked; review its administration before enabling a broker.');
      await command('systemctl', ['mask', '--runtime', 'mosquitto.service']); masked = true;
    }
    if (missing.length) {
      await command('apt-get', ['update'], { timeout: 600000, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
      await command('apt-get', ['install', '-y', '--no-install-recommends', ...missing],
        { timeout: 900000, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
    }
    if (helper) {
      for (const name of ['/usr/local/lib/st-mq/scripts', '/usr/local/lib/st-mq/src/pairing', '/etc/systemd/system', '/etc/st-mq-vip'])
        directory(name, name === '/etc/st-mq-vip' ? 0o700 : 0o755);
      install('/usr/local/lib/st-mq/package.json', '{"type":"module"}\n');
      for (const [name, code] of Object.entries(publicCode)) install('/usr/local/lib/st-mq/' + name, code);
      install('/etc/systemd/system/st-mq-vip.service', vipServiceText(request.nodePath));
      const socketChanged = install('/etc/systemd/system/st-mq-vip.socket', vipSocketText(group));
      if (request.operation === 'setup') install('/etc/st-mq-vip/policy.json', JSON.stringify(vip, null, 2) + '\n', 0o600);
      await command('systemctl', ['daemon-reload']);
      if (socketChanged && await command('systemctl', ['is-active', 'st-mq-vip.socket'], { acceptedExitCodes: [0, 1, 3, 4] }) === 'active')
        await command('systemctl', ['restart', 'st-mq-vip.socket']);
      // An already running helper loads code at start, so refresh it without changing address ownership.
      const active = await command('systemctl', ['is-active', 'st-mq-vip.service'], { acceptedExitCodes: [0, 1, 3, 4] });
      if (active === 'active') await command('systemctl', ['restart', 'st-mq-vip.service']);
      await command('systemctl', ['enable', '--now', 'st-mq-vip.socket']);
    }
    if (request.broker) {
      directory('/etc/mosquitto/conf.d');
      const gid = Number(await command('id', ['-g', 'mosquitto']));
      if (!Number.isSafeInteger(gid) || gid < 1) fail('Broker service group is unavailable.');
      const password = path('/etc/mosquitto/st-mq-passwords');
      let retained = [];
      if (existsSync(password)) {
        checkPath(password);
        const stat = lstatSync(password);
        if (!stat.isFile() || stat.size > 1024 * 1024) fail('Managed broker password file is malformed or exceeds its size limit.');
        const lines = readFileSync(password, 'utf8').split('\n').filter(Boolean), names = new Set();
        for (const line of lines) {
          const match = /^([^:\r\n]+):(\$[67]\$[^\r\n]+)$/.exec(line);
          if (!match || names.has(match[1])) fail('Managed broker password file contains invalid or duplicate users.');
          names.add(match[1]);
          if (match[1] !== request.broker.user) retained.push(line);
        }
      }
      // Hash only the new password in a separate private file. A failed conversion
      // leaves the live authentication database and all its other users intact.
      const pending = password + '.pending-' + randomUUID();
      try {
        writeFileSync(pending, request.broker.user + ':' + request.broker.password + '\n', { mode: 0o600, flag: 'wx' });
        if (!fixture) chownSync(pending, 0, 0);
        await command('mosquitto_passwd', ['-U', pending]);
        const hashed = readFileSync(pending, 'utf8').trim();
        if (!hashed.startsWith(request.broker.user + ':')
          || !/^\$7\$[1-9][0-9]*\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(hashed.slice(request.broker.user.length + 1)))
          fail('Broker password hashing was not confirmed; previous authentication was preserved.');
        install('/etc/mosquitto/st-mq-passwords', [...retained, hashed].join('\n') + '\n', 0o640, gid);
      } finally { if (existsSync(pending)) unlinkSync(pending); }
      install('/etc/mosquitto/conf.d/st-mq.conf', brokerText);
      if (masked) { await command('systemctl', ['unmask', '--runtime', 'mosquitto.service']); masked = false; }
      await command('systemctl', ['enable', 'mosquitto.service']);
      await command('systemctl', ['restart', 'mosquitto.service']);
      if (await command('systemctl', ['is-active', 'mosquitto.service'], { acceptedExitCodes: [0, 1, 3, 4] }) !== 'active')
        fail('Broker startup was not confirmed; inspect its service before retrying.');
    }
  } finally {
    // No Start/Restart is retried after an uncertain result.
    if (masked) await command('systemctl', ['unmask', '--runtime', 'mosquitto.service']).catch(() => {});
  }
  return { helper, broker: Boolean(request.broker), packages: missing };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
  try {
    if (process.getuid() !== 0 || process.argv.length !== 3) fail('Privileged installation must be launched by Linux setup.');
    const filename = process.argv[2], stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 65536
      || Number(process.env.SUDO_UID) !== stat.uid || stat.uid === 0 || (lstatSync(dirname(filename)).mode & 0o077))
      fail('Privileged request must be a private file owned by the invoking account.');
    const request = JSON.parse(readFileSync(filename, 'utf8'));
    if (request.uid !== stat.uid) fail('Privileged request owner mismatch.');
    await installProvisioning(request, { signal: abort.signal });
    process.stdout.write('{"ok":true}\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof DeploymentSafetyError ? error.message : 'Privileged installation failed; private details suppressed.' }) + '\n');
  }
}
