import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, readFileSync, writeFileSync, mkdirSync, readdirSync,
  readlinkSync, symlinkSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCommand } from './deployment-command.js';
import { acquireDeploymentLock, ownsDeploymentLock, releaseDeploymentLock } from './deployment-lock.js';
import { authenticateSudo, startSudoLease, refreshPairHelper, pairHelperNeedsRefresh } from './linux-setup-platform.js';
import { DeploymentSafetyError, deploymentArguments, synchronizationTimeout, validateStandby, waitForStandby } from './paired-deployment.js';

export const checkoutRoot = fileURLToPath(new URL('../../', import.meta.url));
export class LinuxDeploymentError extends DeploymentSafetyError {}
const fail = message => { throw new LinuxDeploymentError(message); };
const inside = (parent, child) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r)); };
const sha = value => createHash('sha256').update(value).digest('hex');
const exactFields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// Follow existing ancestors as well as complete paths when checking boundaries.
export function canonical(path) {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(canonical(parent), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
}
function absolute(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value) || !/^\/[A-Za-z0-9_./ -]+$/.test(value) || value !== resolve(value))
    fail(`Use a normalized absolute path for ${name}; supported path characters are letters, numbers, spaces, /, _, . and -.`);
  return value;
}
export function validateConnection(value, source = checkoutRoot) {
  const fields = ['runtime_dir', 'service_name', 'service_scope', 'service_user', 'node_path', 'environment_file', 'status_url', 'token_file', 'sync_timeout_seconds'];
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !fields.includes(k))) fail('Invalid Linux deployment connection fields.');
  for (const name of ['runtime_dir', 'node_path', 'environment_file']) absolute(value[name], name);
  if (value.token_file !== undefined) absolute(value.token_file, 'token_file');
  if (!['user', 'system'].includes(value.service_scope) || !/^[A-Za-z0-9][A-Za-z0-9_-]*\.service$/.test(value.service_name ?? '')) fail('Specify a user/system service scope and a plain .service name.');
  if (value.service_scope === 'system' ? !/^[a-z_][a-z0-9_-]*$/.test(value.service_user ?? '') || value.service_user === 'root' : value.service_user !== undefined)
    fail('System services require a non-root service_user; user services omit service_user.');
  let url;
  try { url = new URL(value.status_url); } catch { fail('Specify a loopback HTTP status_url.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/' || url.username || url.password || url.search || url.hash)
    fail('status_url must be an HTTP loopback origin, for example http://127.0.0.1:1234.');
  synchronizationTimeout(value.sync_timeout_seconds);
  const runtime = canonical(value.runtime_dir), root = canonical(source);
  if (inside(root, runtime) || inside(runtime, root) || runtime === '/') fail('The managed runtime and source checkout must be separate, non-overlapping directories.');
  for (const name of ['environment_file', 'token_file']) if (value[name] && (inside(runtime, canonical(value[name])) || inside(root, canonical(value[name])))) fail('Private deployment inputs must stay outside the source and runtime directories.');
  return { ...value, status_url: url.origin, sync_timeout_seconds: value.sync_timeout_seconds ?? 900 };
}
export function privateFile(path, source, runtime) {
  const actual = canonical(path), stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) || (lstatSync(dirname(actual)).mode & 0o077)
    || inside(canonical(source), actual) || inside(canonical(runtime), actual)) fail('Private files must be regular files outside source/runtime, mode 0600, with a mode 0700 parent.');
  return readFileSync(actual, 'utf8');
}

// The scripts and systemd EnvironmentFile share this deliberately small subset:
// single-line assignments, optional single quotes, no escapes or expansion.
export function parseEnvironment(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^([A-Z_][A-Z0-9_]*)=(?:'([^'\r\n]*)'|([^\s'"\\`$]*))$/.exec(line);
    if (!m || Object.hasOwn(env, m[1]) || /[\0\r\n]/.test(m[2] ?? m[3])) fail('Environment file requires unique KEY=value or KEY=\'single-line value\' assignments; no escapes or expansion.');
    env[m[1]] = m[2] ?? m[3];
  }
  return env;
}
export function validateEnvironment(env, connection, source) {
  if (!['pair', 'standalone'].includes(env.STMQ_TOPOLOGY) || env.STMQ_ADDON !== undefined || env.STMQ_ROLE !== undefined) fail('Linux deployment requires pair or standalone topology; no addon or role override is accepted.');
  for (const name of ['STMQ_CONFIG', 'STMQ_DATA_DIR', 'STMQ_DATABASE_DIR', ...(env.STMQ_TOPOLOGY === 'pair' ? ['STMQ_PAIR_DIR'] : [])]) {
    absolute(env[name], name);
    const path = canonical(env[name]);
    if (inside(canonical(source), path) || inside(canonical(connection.runtime_dir), path)) fail('Configuration, data, databases and pairing must have explicit paths outside source/runtime.');
  }
  return env;
}
const unitQuote = text => '"' + text.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
export function serviceText(c) {
  const current = join(c.runtime_dir, 'current');
  return `[Unit]
Description=st-mq
After=network.target

[Service]
Type=simple
${c.service_scope === 'system' ? `User=${c.service_user}\n` : ''}WorkingDirectory=${current}
EnvironmentFile=${c.environment_file}
ExecStart=${unitQuote(c.node_path)} ${unitQuote(join(current, 'src/main.js'))}
Restart=on-failure
RestartSec=5
TimeoutStopSec=90
KillMode=control-group
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=${c.service_scope === 'user' ? 'default.target' : 'multi-user.target'}
`;
}
export function servicePath(c) {
  return join(c.service_scope === 'user' ? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user') : '/etc/systemd/system', c.service_name);
}

// Non-login terminals can lack both bus variables even while this account's
// persistent user manager is running. Use only its existing, owned local bus;
// explicit session settings remain authoritative and no manager is started.
export function userServiceEnvironment({ env = process.env, uid = process.getuid?.(), stat = lstatSync } = {}) {
  if (env.DBUS_SESSION_BUS_ADDRESS || env.XDG_RUNTIME_DIR || !Number.isInteger(uid) || uid < 0) return env;
  const runtime = `/run/user/${uid}`;
  try {
    const directory = stat(runtime), bus = stat(join(runtime, 'bus'));
    if (directory.isDirectory() && directory.uid === uid && !(directory.mode & 0o077)
      && bus.isSocket() && bus.uid === uid) return { ...env, XDG_RUNTIME_DIR: runtime };
  } catch { /* Leave unavailable managers to the normal command/query checks. */ }
  return env;
}

function digestTree(root, boundary = root) {
  const hashes = [];
  function walk(path) {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name), stat = lstatSync(file), label = relative(root, file);
      if (stat.isSymbolicLink()) {
        if (!inside(canonical(boundary), canonical(file))) fail('Build contains a symlink outside its release.');
        hashes.push(`${label}\0link\0${readlinkSync(file)}`);
      } else if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) hashes.push(`${label}\0${stat.mode & 0o777}\0${sha(readFileSync(file))}`);
      else fail('Build contains an unsupported filesystem entry.');
    }
  }
  walk(root);
  return sha(hashes.join('\n'));
}
function atomicFile(path, value) {
  const temporary = path + '.' + randomUUID();
  writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path);
}
function pointCurrent(runtime, release) {
  const temporary = join(runtime, '.current-' + randomUUID());
  symlinkSync(relative(canonical(runtime), release), temporary); renameSync(temporary, join(runtime, 'current'));
}
export async function readLocalStatus(c, { signal, fetchImpl = fetch, endpoint = '/api/status' } = {}) {
  if (!['/api/status', '/api/pair'].includes(endpoint)) fail('Invalid local status endpoint.');
  const token = c.token_file ? readFileSync(c.token_file, 'utf8').trim() : '';
  let response;
  try {
    response = await fetchImpl(c.status_url + endpoint, { headers: token ? { Authorization: 'Bearer ' + token } : {}, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    if (!response.ok) fail('Authenticated local application status is unavailable.');
    let body = '';
    if (response.body) {
      const reader = response.body.getReader();
      const chunks = []; let bytes = 0;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 1024 * 1024) { await reader.cancel(); fail('Local pair status exceeded its size limit.'); }
        chunks.push(Buffer.from(value));
      }
      body = Buffer.concat(chunks).toString('utf8');
    } else body = await response.text();
    if (body.length > 1024 * 1024) fail('Local pair status exceeded its size limit.');
    return JSON.parse(body);
  } catch { fail('Authenticated local application status is unavailable; private response suppressed.'); }
}
export const readPair = (c, options) => readLocalStatus(c, { ...options, endpoint: '/api/pair' });

function managedMarker(connection) {
  const path = join(connection.runtime_dir, 'deployment.json');
  if (!existsSync(path)) fail('Run setup:linux for this managed runtime first.');
  let marker;
  try { marker = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('Invalid managed runtime metadata; preserve it and inspect setup.'); }
  if (!exactFields(marker, ['version', 'service', 'scope', 'unit']) || marker.version !== 1
    || marker.service !== connection.service_name || marker.scope !== connection.service_scope || marker.unit !== sha(serviceText(connection)))
    fail('Unsupported or mismatched managed runtime metadata; preserve it and inspect setup.');
}

function serviceInspector(c, { run = runCommand, unitPath = servicePath, signal } = {}) {
  const unit = unitPath(c), expectedUnit = serviceText(c), runtime = c.runtime_dir;
  const command = (exe, args, options = {}) => run(exe, args, { signal, ...options });
  const systemctl = (...args) => {
    const options = { timeout: 120000, acceptedExitCodes: args[0] === 'show' ? [0, 1] : [0] };
    return c.service_scope === 'user' ? command('systemctl', ['--user', ...args], { ...options, env: userServiceEnvironment() })
      : command('sudo', ['-n', 'systemctl', ...args], options);
  };
  const show = async () => {
    const output = await systemctl('show', c.service_name, '--property=LoadState,ActiveState,SubState,MainPID,Transient,FragmentPath,DropInPaths,NeedDaemonReload,WorkingDirectory,ExecStart,User');
    const properties = Object.fromEntries(output.split('\n').filter(Boolean).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    if (!properties.LoadState) fail(`Could not query the ${c.service_scope} systemd manager. Check that its bus is available to this terminal before retrying.`);
    return properties;
  };
  const assertService = async (active = true, listenerReady = active) => {
    const s = await show();
    // Report failed checks, never raw unit contents or systemd values: those
    // may contain private paths, command arguments or unreviewed overrides.
    const failures = [];
    if (!existsSync(unit)) failures.push('unit file missing');
    else if (readFileSync(unit, 'utf8') !== expectedUnit) failures.push('unit file differs from the configured installation');
    if (s.LoadState !== 'loaded') failures.push('LoadState is not loaded');
    if (s.Transient !== 'no') failures.push('persistent unit not confirmed');
    if (s.FragmentPath !== unit) failures.push('FragmentPath differs from the expected unit file');
    if (s.DropInPaths) failures.push('unexpected service drop-ins');
    if (s.NeedDaemonReload !== 'no') failures.push('systemd daemon reload not confirmed current');
    if (s.WorkingDirectory !== join(runtime, 'current')) failures.push('WorkingDirectory differs from the configured runtime');
    if (!s.ExecStart?.includes(`path=${c.node_path} ;`)) failures.push('ExecStart Node executable differs from configuration');
    if (!s.ExecStart?.includes(join(runtime, 'current/src/main.js'))) failures.push('ExecStart application entrypoint differs from configuration');
    if (c.service_scope === 'system' && s.User !== c.service_user) failures.push('service user differs from configuration');
    if (active) {
      if (s.ActiveState !== 'active') failures.push('ActiveState is not active');
      if (s.SubState !== 'running') failures.push('SubState is not running');
      if (!(Number(s.MainPID) > 0)) failures.push('running MainPID not confirmed');
    }
    if (failures.length) fail(`The persistent service does not match this installation or is not running: ${failures.join('; ')}.`);
    if (listenerReady) await command(c.node_path, [fileURLToPath(new URL('./linux-deployment-process.js', import.meta.url)),
      s.MainPID, c.node_path, join(runtime, 'current'), c.status_url], { timeout: 10000 });
    return s;
  };
  const assertStopped = async () => {
    const state = await assertService(false);
    if (state.ActiveState !== 'inactive' || state.SubState !== 'dead' || Number(state.MainPID) !== 0)
      fail('--stopped requires a confirmed inactive service; stop it explicitly first.');
    return state;
  };
  return { systemctl, show, assertService, assertStopped, unit, expectedUnit };
}

// Read-only ownership proof for deployment and installer reconfiguration. Call
// before stopping an existing service or publishing any private configuration.
export async function validateInstalledRuntime(connection, { source = checkoutRoot, run = runCommand,
  unitPath = servicePath, signal, state = 'either' } = {}) {
  if (!['running', 'stopped', 'either'].includes(state)) fail('Invalid installed-runtime state requirement.');
  const c = validateConnection(connection, source), runtime = c.runtime_dir;
  managedMarker(c);
  const inspector = serviceInspector(c, { run, unitPath, signal });
  let service;
  if (state === 'running') service = await inspector.assertService();
  else if (state === 'stopped') service = await inspector.assertStopped();
  else {
    service = await inspector.assertService(false);
    if (service.ActiveState === 'active') service = await inspector.assertService();
    else if (service.ActiveState !== 'inactive' || service.SubState !== 'dead' || Number(service.MainPID) !== 0)
      fail('The installed service is neither a confirmed running application nor fully stopped.');
  }
  const release = canonical(join(runtime, 'current'));
  if (!inside(canonical(join(runtime, 'releases')), release) || !lstatSync(join(runtime, 'current')).isSymbolicLink())
    fail('The current release does not belong to this managed runtime.');
  const git = (...args) => run('git', args, { cwd: release, signal });
  if (await git('status', '--porcelain')) fail('The installed release has local changes.');
  let proof;
  try { proof = JSON.parse(readFileSync(join(release, '.git/linux-deployment-proof.json'), 'utf8')); }
  catch { fail('The installed release proof is missing or malformed.'); }
  const revision = await git('rev-parse', 'HEAD');
  if (!exactFields(proof, ['version', 'revision', 'dist', 'dependencies']) || proof.version !== 1 || proof.revision !== revision
    || proof.dist !== digestTree(join(release, 'dist'), release) || proof.dependencies !== digestTree(join(release, 'node_modules'), release))
    fail('The installed build differs from its prepared release proof.');
  return { release, revision, service };
}

export function validateStandalone(status) {
  if (!status || status.topology !== 'standalone' || status.role !== 'master') fail('The installed application is not a ready standalone runtime.');
  return status;
}

export async function main(mode, args, dependencies = {}) {
  const { source = checkoutRoot, run = runCommand, log = console.log, pair = readPair, status = readLocalStatus,
    authenticate = authenticateSudo, lease = startSudoLease, refreshHelper = refreshPairHelper, helperNeedsRefresh = pairHelperNeedsRefresh,
    clock = Date.now, operatorUid = process.getuid?.(), operatorUser = userInfo().username, sleep = (ms, signal) => new Promise((yes, no) => {
      const abort = () => { clearTimeout(timer); no(new LinuxDeploymentError('Deployment cancelled.')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); yes(); }, ms);
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    }), unitPath = servicePath, signal, operationLock } = dependencies;
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    log(`Usage: node scripts/deploy-linux.js [--connection /private/path/linux-deploy.json] [--stopped]\nDeploy this script checkout’s clean committed HEAD to a managed Linux systemd runtime.\nDeployment restarts a running standalone application or synchronized paired slave by default.\n--stopped requires and leaves a stopped service.\nDefault connection: ~/.config/st-mq/linux-deploy.json (honors XDG_CONFIG_HOME).\nSee docs/linux-deployment.md and docs/paired-deployment.md.`); return;
  }
  const { connection: connectionPath, stopped, apply } = deploymentArguments(args,
    join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'st-mq/linux-deploy.json'), { setup: mode === 'setup' });
  // Validate the connection's own privacy before parsing any installation values.
  const raw = privateFile(connectionPath, source, source);
  const c = validateConnection(JSON.parse(raw), source), runtime = c.runtime_dir;
  privateFile(connectionPath, source, runtime);
  const environmentText = privateFile(c.environment_file, source, runtime);
  const environment = validateEnvironment(parseEnvironment(environmentText), c, source);
  const paired = environment.STMQ_TOPOLOGY === 'pair';
  privateFile(environment.STMQ_CONFIG, source, runtime);
  if (c.token_file && !stopped) privateFile(c.token_file, source, runtime);
  if (!existsSync(c.node_path)) fail('Configured Node executable does not exist.');
  if (operatorUid === 0) fail('Run Linux setup/deployment as an ordinary deployment user, not root.');
  if (c.service_scope === 'system' && c.service_user !== operatorUser) fail('Run deployment as the configured service_user so private files retain their 0600 ownership.');
  let privilegeLease;
  const command = (exe, a, options = {}) => { privilegeLease?.assertValid(); return run(exe, a, { signal, ...options }); };
  const git = (cwd, ...a) => command('git', a, { cwd });
  const inspector = serviceInspector(c, { run: command, unitPath, signal });
  const { systemctl, show, assertService, assertStopped, unit, expectedUnit } = inspector;
  try {
  if (mode === 'deploy' && !operationLock && c.service_scope === 'system') {
    await authenticate({ signal }); privilegeLease = lease({ run, signal });
  }
  const target = await git(source, 'rev-parse', 'HEAD');
  if (!/^[a-f0-9]{40}$/.test(target) || await git(source, 'status', '--porcelain')) fail('Commit changes and leave the source checkout clean before deployment.');
  const nodeVersion = await command(c.node_path, ['-p', 'process.versions.node']);
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (!(major > 22 || major === 22 && minor >= 19)) fail('The configured Node executable must be version 22.19 or newer.');
  const sourceUnchanged = async () => {
    if (await git(source, 'rev-parse', 'HEAD') !== target || await git(source, 'status', '--porcelain')
      || privateFile(c.environment_file, source, runtime) !== environmentText) fail('Source or environment changed during preparation.');
  };
  const markerPath = join(runtime, 'deployment.json');
  if (mode === 'setup') {
    if (existsSync(unit) || (await show()).LoadState !== 'not-found') fail('The service already exists; preserve it and choose a distinct name or retire it explicitly.');
    if (existsSync(runtime) && (lstatSync(runtime).isSymbolicLink() || readdirSync(runtime).some(name => !(name === 'deployment.lock' && operationLock && ownsDeploymentLock(operationLock, runtime))))) fail('Setup requires a new or empty runtime directory; existing files are never overwritten.');
    log(`Source commit: ${target}\nService: ${c.service_scope}/${c.service_name}\nService file:\n${expectedUnit}`);
    if (!apply) { log('Preview only. Use --apply to build and install; the service remains stopped and disabled.'); return; }
  } else {
    managedMarker(c);
    if (stopped) await assertStopped(); else await assertService();
  }
  mkdirSync(runtime, { recursive: true });
  const ownedLock = operationLock ?? acquireDeploymentLock(runtime);
  if (!ownsDeploymentLock(ownedLock, runtime)) fail('The installation lock is not owned by this operation.');
  let stage, switched = false, lifecycle = stopped ? 'Service confirmed stopped; no lifecycle commands requested.' : 'No lifecycle commands requested.', complete = false, phase = 'preflight';
  try {
    let identity, previous;
    if (mode === 'deploy') {
      if (!stopped) {
        if (paired) identity = validateStandby(await pair(c, { signal }), null, clock(), true);
        else validateStandalone(await status(c, { signal }));
      }
      const installed = await validateInstalledRuntime(c, { source, run: command, unitPath, signal, state: stopped ? 'stopped' : 'running' });
      previous = installed.release;
      await git(source, 'merge-base', '--is-ancestor', installed.revision, target);
    }
    phase = 'prepare'; log('Preparing the selected commit and frontend before changing the installed runtime…');
    mkdirSync(join(runtime, 'releases'), { recursive: true });
    stage = join(canonical(join(runtime, 'releases')), target + '-' + randomUUID());
    await git(runtime, 'clone', '--no-hardlinks', '--no-checkout', '--single-branch', '--no-tags', '--', canonical(source), stage);
    await git(stage, 'checkout', '--detach', target);
    const buildEnv = { ...process.env, PATH: dirname(c.node_path) + ':' + process.env.PATH };
    for (const key of Object.keys(buildEnv)) if (key.startsWith('STMQ_') || key === 'NODE_OPTIONS' || key === 'NODE_ENV') delete buildEnv[key];
    await command('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: stage, env: buildEnv });
    const preflightArgs = [fileURLToPath(new URL('./linux-deployment-preflight.js', import.meta.url)), stage, c.environment_file, runtime, canonical(source)];
    await command(c.node_path, preflightArgs, { env: buildEnv, timeout: 30000 });
    await command('npm', ['run', 'build'], { cwd: stage, env: buildEnv });
    const proof = { dist: digestTree(join(stage, 'dist'), stage), dependencies: digestTree(join(stage, 'node_modules'), stage) };
    atomicFile(join(stage, '.git/linux-deployment-proof.json'), JSON.stringify({ version: 1, revision: target, ...proof }) + '\n');
    if (!existsSync(join(stage, 'dist/index.html'))) fail('The frontend build is incomplete.');
    await sourceUnchanged();
    if (await git(stage, 'rev-parse', 'HEAD') !== target || await git(stage, 'status', '--porcelain')) fail('The prepared release no longer matches the selected commit.');
    let refreshNeeded = false;
    if (mode === 'deploy' && paired) {
      phase = 'helper verification';
      refreshNeeded = await helperNeedsRefresh({ source: stage, nodePath: c.node_path, run: command, signal });
      if (refreshNeeded && !privilegeLease && !operationLock) {
        log('The restricted VIP helper needs an update; requesting sudo before stopping the application.');
        await authenticate({ signal }); privilegeLease = lease({ run, signal });
      }
      await sourceUnchanged();
    }
    if (mode === 'deploy' && !stopped) {
      phase = 'stop'; await assertService();
      if (paired) validateStandby(await pair(c, { signal }), identity, clock(), true);
      else validateStandalone(await status(c, { signal }));
      lifecycle = 'Stop requested; outcome unconfirmed.';
      await systemctl('stop', c.service_name);
      const stopped = await show();
      if (stopped.ActiveState !== 'inactive' || Number(stopped.MainPID) !== 0) fail('The service did not confirm a complete stop.');
      lifecycle = 'Service confirmed stopped.';
    }
    if (mode === 'deploy' && stopped) await assertStopped();
    if (mode === 'deploy' && paired) {
      phase = 'helper'; privilegeLease?.assertValid();
      if (refreshNeeded) await refreshHelper({ source: stage, nodePath: c.node_path, run: command, signal, log });
      else log('The installed restricted VIP helper is current; no helper update or restart needed.');
      await assertStopped();
      if (await helperNeedsRefresh({ source: stage, nodePath: c.node_path, run: command, signal }))
        fail('VIP-helper verification failed; inspect its installation before retrying.');
    }
    phase = 'install';
    pointCurrent(runtime, stage); switched = true;
    if (digestTree(join(stage, 'dist'), stage) !== proof.dist || digestTree(join(stage, 'node_modules'), stage) !== proof.dependencies) fail('Installed build verification failed.');
    if (mode === 'setup') {
      if (existsSync(unit)) fail('The service file appeared during setup; it was not overwritten.');
      if (c.service_scope === 'user') { mkdirSync(dirname(unit), { recursive: true }); writeFileSync(unit, expectedUnit, { flag: 'wx', mode: 0o600 }); }
      else {
        const temporary = join(runtime, 'service.install'); writeFileSync(temporary, expectedUnit, { flag: 'wx', mode: 0o600 });
        await command('sudo', ['-n', 'install', '-o', 'root', '-g', 'root', '-m', '0644', '-T', temporary, unit], { timeout: 30000 }); unlinkSync(temporary);
      }
      await systemctl('daemon-reload');
      const installed = await assertService(false);
      if (installed.ActiveState !== 'inactive' || Number(installed.MainPID) !== 0) fail('Setup did not leave the service stopped.');
      atomicFile(markerPath, JSON.stringify({ version: 1, service: c.service_name, scope: c.service_scope, unit: sha(expectedUnit) }) + '\n');
      log(`Setup verified at ${target}. Service installed stopped; startup was not enabled. Review existing pair state, then start the service explicitly.`);
    } else if (stopped) {
      await assertStopped();
      log(`Deployment verified: ${target}; service remains stopped. No stop, start or pair-status requests were sent.`);
    } else {
      phase = 'start'; await sourceUnchanged(); await assertService(false);
      lifecycle = 'Start requested; outcome unconfirmed.';
      await systemctl('start', c.service_name); lifecycle = 'Start acknowledged; inspect current service state if verification fails.';
      phase = paired ? 'synchronize' : 'startup';
      if (paired) log('Service started. Waiting for the same slave to synchronize with its master…');
      if (paired) await waitForStandby({ identity, timeoutSeconds: c.sync_timeout_seconds, clock, sleep, log, signal,
        verifyRunning: () => assertService(true, false), verifyReady: () => assertService(),
        read: async () => {
          try { return { pair: await pair(c, { signal }), observedAt: clock() }; }
          catch (error) { if (signal?.aborted || !(error instanceof LinuxDeploymentError)) throw error; return null; }
        },
      });
      else {
        const deadline = clock() + c.sync_timeout_seconds * 1000;
        while (true) {
          await assertService(true, false);
          let observed;
          try { observed = await status(c, { signal }); } catch (error) { if (signal?.aborted || !(error instanceof LinuxDeploymentError)) throw error; }
          if (observed) { validateStandalone(observed); await assertService(); break; }
          if (clock() >= deadline) fail('Standalone startup timed out.');
          await sleep(1000, signal);
        }
      }
      if (canonical(join(runtime, 'current')) !== stage || await git(stage, 'rev-parse', 'HEAD') !== target || await git(stage, 'status', '--porcelain')
        || digestTree(join(stage, 'dist'), stage) !== proof.dist || digestTree(join(stage, 'node_modules'), stage) !== proof.dependencies) fail('Installed source or build changed during restart.');
      log(`Deployment verified: ${target}; ${paired ? 'service running, same paired slave, no control authority, synchronization ready' : 'standalone service running; authenticated application status verified'}.`);
    }
    complete = true;
  } catch (error) {
    const detail = error instanceof DeploymentSafetyError ? error.message : 'Operation failed; private error details suppressed.';
    fail(`Linux ${mode} failed during ${phase}: ${detail} ${switched ? 'The current release changed.' : 'The current release was not changed.'} ${lifecycle} No automatic rollback, role change or database reset was attempted. Deployment evidence and lock were retained.`);
  } finally {
    if (complete && !operationLock) releaseDeploymentLock(ownedLock, runtime);
  }
  } finally { await privilegeLease?.close(); }
}
