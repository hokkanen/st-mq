import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, readFileSync, writeFileSync, mkdirSync, readdirSync,
  readlinkSync, symlinkSync, renameSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCommand } from './deployment-command.js';
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
  for (const name of ['STMQ_CONFIG', 'STMQ_DATA_DIR', 'STMQ_DATABASE_DIR', 'STMQ_PAIR_DIR']) {
    absolute(env[name], name);
    const path = canonical(env[name]);
    if (inside(canonical(source), path) || inside(canonical(connection.runtime_dir), path)) fail('Configuration, data, databases and pairing must have explicit paths outside source/runtime.');
  }
  if (env.STMQ_TOPOLOGY !== 'pair' || env.STMQ_ADDON !== undefined || env.STMQ_ROLE !== undefined) fail('Linux deployment requires STMQ_TOPOLOGY=pair; no addon or role override is accepted.');
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
export async function readPair(c, { signal, fetchImpl = fetch } = {}) {
  const token = c.token_file ? readFileSync(c.token_file, 'utf8').trim() : '';
  let response;
  try {
    response = await fetchImpl(c.status_url + '/api/pair', { headers: token ? { Authorization: 'Bearer ' + token } : {}, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    if (!response.ok) fail('Authenticated local pair status is unavailable.');
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
  } catch { fail('Authenticated local pair status is unavailable; private response suppressed.'); }
}

export async function main(mode, args, dependencies = {}) {
  const { source = checkoutRoot, run = runCommand, log = console.log, pair = readPair,
    clock = Date.now, operatorUid = process.getuid?.(), operatorUser = userInfo().username, sleep = (ms, signal) => new Promise((yes, no) => {
      const abort = () => { clearTimeout(timer); no(new LinuxDeploymentError('Deployment cancelled.')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); yes(); }, ms);
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    }), unitPath = servicePath, signal } = dependencies;
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    log(`Usage: node scripts/${mode === 'setup' ? 'setup' : 'deploy'}-linux.js [--connection /private/path/linux-deploy.json]${mode === 'setup' ? ' [--apply]' : ' [--stopped]'}\nDeploy this script checkout’s clean committed HEAD to a local paired Linux systemd runtime.\nSetup previews by default; --apply installs it stopped. Deployment manages a running slave by default; --stopped requires and leaves a stopped service.\nDefault connection: ~/.config/st-mq/linux-deploy.json (honors XDG_CONFIG_HOME).\nSee docs/linux-deployment.md and docs/paired-deployment.md.`); return;
  }
  const { connection: connectionPath, stopped, apply } = deploymentArguments(args,
    join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'st-mq/linux-deploy.json'), { setup: mode === 'setup' });
  // Validate the connection's own privacy before parsing any installation values.
  const raw = privateFile(connectionPath, source, source);
  const c = validateConnection(JSON.parse(raw), source), runtime = c.runtime_dir;
  privateFile(connectionPath, source, runtime);
  const environmentText = privateFile(c.environment_file, source, runtime);
  const environment = validateEnvironment(parseEnvironment(environmentText), c, source);
  privateFile(environment.STMQ_CONFIG, source, runtime);
  if (c.token_file && !stopped) privateFile(c.token_file, source, runtime);
  if (!existsSync(c.node_path)) fail('Configured Node executable does not exist.');
  if (operatorUid === 0) fail('Run Linux setup/deployment as an ordinary deployment user, not root.');
  if (c.service_scope === 'system' && c.service_user !== operatorUser) fail('Run deployment as the configured service_user so private files retain their 0600 ownership.');
  const command = (exe, a, options = {}) => run(exe, a, { signal, ...options });
  const git = (cwd, ...a) => command('git', a, { cwd });
  const systemctl = (...a) => {
    // systemctl show returns exit 1 along with LoadState=not-found for a new unit.
    const options = { timeout: 120000, acceptedExitCodes: a[0] === 'show' ? [0, 1] : [0] };
    return c.service_scope === 'user' ? command('systemctl', ['--user', ...a], options) : command('sudo', ['-n', 'systemctl', ...a], options);
  };
  const target = await git(source, 'rev-parse', 'HEAD');
  if (!/^[a-f0-9]{40}$/.test(target) || await git(source, 'status', '--porcelain')) fail('Commit changes and leave the source checkout clean before deployment.');
  const nodeVersion = await command(c.node_path, ['-p', 'process.versions.node']);
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (!(major > 22 || major === 22 && minor >= 19)) fail('The configured Node executable must be version 22.19 or newer.');
  const unit = unitPath(c), expectedUnit = serviceText(c);
  const show = async () => {
    const text = await systemctl('show', c.service_name, '--property=LoadState,ActiveState,SubState,MainPID,Transient,FragmentPath,DropInPaths,NeedDaemonReload,WorkingDirectory,ExecStart,User');
    return Object.fromEntries(text.split('\n').filter(Boolean).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  };
  const sourceUnchanged = async () => {
    if (await git(source, 'rev-parse', 'HEAD') !== target || await git(source, 'status', '--porcelain')
      || privateFile(c.environment_file, source, runtime) !== environmentText) fail('Source or environment changed during preparation.');
  };
  const assertService = async (active = true, listenerReady = active) => {
    const s = await show();
    if (!existsSync(unit) || readFileSync(unit, 'utf8') !== expectedUnit || s.LoadState !== 'loaded' || s.Transient !== 'no'
      || s.FragmentPath !== unit || s.DropInPaths || s.NeedDaemonReload !== 'no' || s.WorkingDirectory !== join(runtime, 'current')
      || !s.ExecStart?.includes(`path=${c.node_path} ;`) || !s.ExecStart?.includes(join(runtime, 'current/src/main.js'))
      || c.service_scope === 'system' && s.User !== c.service_user
      || active && (s.ActiveState !== 'active' || s.SubState !== 'running' || !(Number(s.MainPID) > 0))) fail('The persistent service does not match this installation or is not running.');
    if (listenerReady) {
      const a = [fileURLToPath(new URL('./linux-deployment-process.js', import.meta.url)), s.MainPID, c.node_path, join(runtime, 'current'), c.status_url];
      await command(c.node_path, a, { timeout: 10000 });
    }
    return s;
  };
  const assertStopped = async () => {
    const state = await assertService(false);
    if (state.ActiveState !== 'inactive' || state.SubState !== 'dead' || Number(state.MainPID) !== 0) fail('--stopped requires a confirmed inactive service; stop it explicitly first.');
  };
  const markerPath = join(runtime, 'deployment.json');
  if (mode === 'setup') {
    if (existsSync(unit) || (await show()).LoadState !== 'not-found') fail('The service already exists; preserve it and choose a distinct name or retire it explicitly.');
    if (existsSync(runtime) && (lstatSync(runtime).isSymbolicLink() || readdirSync(runtime).length)) fail('Setup requires a new or empty runtime directory; existing files are never overwritten.');
    log(`Source commit: ${target}\nService: ${c.service_scope}/${c.service_name}\nService file:\n${expectedUnit}`);
    if (!apply) { log('Preview only. Use --apply to build and install; the service remains stopped and disabled.'); return; }
  } else {
    if (!existsSync(markerPath)) fail('Run setup:linux for this managed runtime first.');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (!exactFields(marker, ['version', 'service', 'scope', 'unit']) || marker.version !== 1 || marker.service !== c.service_name || marker.scope !== c.service_scope || marker.unit !== sha(expectedUnit)) fail('Unsupported or mismatched managed runtime metadata; preserve it and inspect setup.');
    if (stopped) await assertStopped(); else await assertService();
  }
  mkdirSync(runtime, { recursive: true });
  const lock = join(runtime, 'deployment.lock');
  try { mkdirSync(lock); } catch { fail('A deployment lock exists; inspect the previous operation before removing an empty lock.'); }
  let stage, switched = false, lifecycle = stopped ? 'Service confirmed stopped; no lifecycle commands requested.' : 'No lifecycle commands requested.', complete = false, phase = 'preflight';
  try {
    let identity, previous;
    if (mode === 'deploy') {
      if (!stopped) identity = validateStandby(await pair(c, { signal }), null, clock(), true);
      previous = canonical(join(runtime, 'current'));
      if (!inside(canonical(join(runtime, 'releases')), previous) || !lstatSync(join(runtime, 'current')).isSymbolicLink()) fail('The current release does not belong to this managed runtime.');
      if (await git(previous, 'status', '--porcelain')) fail('The installed release has local changes.');
      const priorProof = JSON.parse(readFileSync(join(previous, '.git/linux-deployment-proof.json'), 'utf8'));
      if (!exactFields(priorProof, ['version', 'revision', 'dist', 'dependencies']) || priorProof.version !== 1 || priorProof.revision !== await git(previous, 'rev-parse', 'HEAD')
        || priorProof.dist !== digestTree(join(previous, 'dist'), previous)
        || priorProof.dependencies !== digestTree(join(previous, 'node_modules'), previous)) fail('The installed build differs from its prepared release proof.');
      await git(source, 'merge-base', '--is-ancestor', await git(previous, 'rev-parse', 'HEAD'), target);
    }
    phase = 'prepare'; log('Preparing the selected commit and frontend while the current standby remains available…');
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
    if (mode === 'deploy' && !stopped) {
      phase = 'stop'; await assertService();
      validateStandby(await pair(c, { signal }), identity, clock(), true);
      lifecycle = 'Stop requested; outcome unconfirmed.';
      await systemctl('stop', c.service_name);
      const stopped = await show();
      if (stopped.ActiveState !== 'inactive' || Number(stopped.MainPID) !== 0) fail('The service did not confirm a complete stop.');
      lifecycle = 'Service confirmed stopped.';
    }
    if (mode === 'deploy' && stopped) await assertStopped();
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
      phase = 'synchronize'; log('Service started. Waiting for the same slave to synchronize with its master…');
      await waitForStandby({ identity, timeoutSeconds: c.sync_timeout_seconds, clock, sleep, log, signal,
        verifyRunning: () => assertService(true, false), verifyReady: () => assertService(),
        read: async () => {
          try { return { pair: await pair(c, { signal }), observedAt: clock() }; }
          catch (error) { if (signal?.aborted || !(error instanceof LinuxDeploymentError)) throw error; return null; }
        },
      });
      if (canonical(join(runtime, 'current')) !== stage || await git(stage, 'rev-parse', 'HEAD') !== target || await git(stage, 'status', '--porcelain')
        || digestTree(join(stage, 'dist'), stage) !== proof.dist || digestTree(join(stage, 'node_modules'), stage) !== proof.dependencies) fail('Installed source or build changed during restart.');
      log(`Deployment verified: ${target}; service running, same paired slave, no control authority, synchronization ready.`);
    }
    complete = true;
  } catch (error) {
    const detail = error instanceof DeploymentSafetyError ? error.message : 'Operation failed; private error details suppressed.';
    fail(`Linux ${mode} failed during ${phase}: ${detail} ${switched ? 'The current release changed.' : 'The current release was not changed.'} ${lifecycle} No automatic rollback, role change or database reset was attempted. Deployment evidence and lock were retained.`);
  } finally {
    if (complete) rmdirSync(lock);
  }
}
