#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { connectSSH, validateSSHHost, shellQuote, DeploymentTransportError } from './lib/ha-deploy-transport.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
class DeploymentError extends Error {}
const STORED_FILES_TIMEOUT_MS = 15 * 60 * 1000;

const help = `Usage: node scripts/deploy-ha.js [--connection /private/path/ha-deploy.json]

Deploy this checkout's committed HEAD over SSH to Home Assistant's
Advanced SSH & Web Terminal app. The installed app MUST be stopped and
remains stopped. No Git push, release publication, configuration edit or data
reset is performed. The installed manifest version must match this checkout.
Supervisor schema/defaults are refreshed; saved installation settings are preserved.

Default connection: $XDG_CONFIG_HOME/st-mq/ha-deploy.json
(or ~/.config/st-mq/ha-deploy.json). See docs/ha-deployment.md.
`;

export function validateConnection(value) {
  const allowed = ['ssh_host', 'app_slug'];
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !allowed.includes(k))) throw new DeploymentError('Invalid connection fields; use ssh_host and optional app_slug');
  validateSSHHost(value.ssh_host);
  if (value.app_slug !== undefined && (typeof value.app_slug !== 'string' || !/^[a-z0-9_-]+$/.test(value.app_slug))) throw new DeploymentError('Invalid app slug');
  return { ...value };
}

export function selectApp(apps, slug) {
  const matches = apps.filter(a => slug ? a.slug === slug : a.slug?.endsWith('_st-mq'));
  if (matches.length !== 1 || !/^[a-z0-9_-]+$/.test(matches[0].slug)) throw new DeploymentError('Select exactly one app using app_slug in the connection file');
  return matches[0];
}

export function validateDeploymentState(app, manifest, evidence = {}) {
  if (typeof app.slug !== 'string' || !/^[a-z0-9_-]+$/.test(app.slug)) throw new DeploymentError('Invalid app identity');
  if (!appIsStopped(app, evidence)) throw new DeploymentError(`Stop Home Energy in HA before deploying and wait until it is stopped (observed ${publicAppState(app.state)}); this script never stops or starts it.`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new DeploymentError('Invalid manifest version');
  if (app.version !== manifest.version) throw new DeploymentError('Installed and checkout versions differ; install the matching version through Supervisor first');
  if (typeof app.repository !== 'string' || !/^[a-z0-9_-]+$/.test(app.repository)) throw new DeploymentError('Expected a Git-backed app repository');
  validateAppOptions(app.options);
}

function validateAppOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new DeploymentError('App configuration options are invalid or unavailable');
}

function publicAppState(state) {
  // Only recognized public state labels may enter diagnostics, never raw API values.
  return ['started', 'starting', 'startup', 'unknown', 'error'].includes(state) ? state : 'unrecognized';
}

function appIsStopped(app, { stoppedContainerVerified = false } = {}) {
  return app.state === 'stopped' || (app.state === 'error' && stoppedContainerVerified === true);
}

export async function readStoppedEvidence(ssh, app) {
  if (app.state !== 'error') return {};
  if (typeof app.slug !== 'string' || !/^[a-z0-9_-]+$/.test(app.slug)) throw new DeploymentError('Invalid app identity');
  // Supervisor can retain error after a manual stop removes the container.
  // Check both names supported by current Supervisor; never infer absence from
  // a failed inspect command or rewrite the original Supervisor observation.
  const names = ['app_' + app.slug, 'addon_' + app.slug];
  const result = await ssh.run(`docker container ls --all --filter ${shellQuote(`name=^/(app|addon)_${app.slug}$`)} --format ${shellQuote('{{json .}}')}`);
  const message = 'Supervisor reports an app error; Docker could not confirm an absent or exited container. Inspect Home Energy in HA before retrying.';
  if (result.exitCode !== 0) throw new DeploymentError(message);
  let rows;
  try { rows = result.output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch { throw new DeploymentError(message); }
  if (rows.length > 1 || rows.some(row => !row || !names.includes(row.Names) || row.State !== 'exited')) throw new DeploymentError(message);
  return { stoppedContainerVerified: true };
}

export function validateUnchangedApp(current, original, { compareOptions = true, ...evidence } = {}) {
  validateAppOptions(original.options);
  validateAppOptions(current.options);
  const changed = [];
  if (!appIsStopped(current, evidence)) {
    changed.push(`state (expected stopped; observed ${publicAppState(current.state)})`);
  }
  for (const field of ['slug', 'repository', 'version']) if (current[field] !== original[field]) changed.push(field);
  // Supervisor may serialize object keys in a different order after rebuilding.
  // Values, types, missing keys and array order must still match exactly.
  if (compareOptions && !isDeepStrictEqual(current.options, original.options)) changed.push('configuration');
  if (changed.length) throw new DeploymentError(`App checks changed during deployment: ${changed.join(', ')}`);
}

export function repositorySources(store, repository) {
  const entries = store?.repositories;
  if (!Array.isArray(entries) || !entries.length
    || entries.some(entry => !entry || typeof entry.slug !== 'string' || typeof entry.source !== 'string' || !entry.source.trim())
    || !entries.some(entry => entry.slug === repository)
    || new Set(entries.map(entry => entry.slug)).size !== entries.length
    || new Set(entries.map(entry => entry.source)).size !== entries.length)
    throw new DeploymentError('Supervisor repository information is invalid or unavailable');
  return entries.map(({ source }) => source).sort();
}

function validateRepositories(current, original, repository) {
  if (!isDeepStrictEqual(repositorySources(current, repository), original))
    throw new DeploymentError('Supervisor repositories changed during deployment; inspect HA before retrying');
}

function validateInstalledSchema(current, schema) {
  if (!Array.isArray(schema) || !isDeepStrictEqual(current.schema, schema))
    throw new DeploymentError('Supervisor installed schema does not match the deployed commit');
}

export function createSupervisorAPI(ssh) {
  return async (endpoint, method = 'get', timeout = 30, body) => {
    if (!/^\/[a-z0-9_/-]+$/.test(endpoint) || !['get', 'post'].includes(method) || !Number.isInteger(timeout) || timeout < 1 || timeout > 900
      || (body !== undefined && (method !== 'post' || !body || typeof body !== 'object' || Array.isArray(body)))) throw new DeploymentError('Invalid Supervisor request');
    // The login shell supplies the app-local token. It never crosses SSH or
    // appears in command arguments, logs or the Ubuntu connection file.
    const code = `import os,sys,urllib.request
request=urllib.request.Request('http://supervisor${endpoint}',method='${method.toUpperCase()}',headers={'Authorization':'Bearer '+os.environ['SUPERVISOR_TOKEN'],'Content-Type':'application/json'},data=${method === 'post' ? 'sys.stdin.buffer.read()' : 'None'})
with urllib.request.urlopen(request,timeout=${timeout}) as response:
 print(response.read(2097153).decode('utf-8'))
`;
    // Login profiles may print an installation banner. Reserve fd 3 for the
    // API response and discard profile stdout without parsing around it.
    const result = await ssh.run(`bash -lc ${shellQuote('python3 -c ' + shellQuote(code) + ' >&3')} 3>&1 1>/dev/null`, {
      timeoutMs: (timeout + 5) * 1000, ...(body === undefined ? {} : { input: Buffer.from(JSON.stringify(body)) }),
    });
    if (result.exitCode !== 0) throw new DeploymentError('Supervisor request failed; inspect Supervisor locally. Any submitted operation may still be running');
    let response;
    try { response = JSON.parse(result.output); } catch { throw new DeploymentError('Invalid Supervisor response; any submitted operation may still be running'); }
    if (response?.result !== 'ok' || !response.data || typeof response.data !== 'object' || Array.isArray(response.data)) throw new DeploymentError('Supervisor rejected the request; inspect Supervisor locally');
    return response.data;
  };
}

function privateFile(path, checkout) {
  const actual = realpathSync(path), rel = relative(realpathSync(checkout), actual);
  if (rel === '' || (!rel.startsWith('..' + '/') && !isAbsolute(rel))) throw new DeploymentError('Deployment connection files must be outside the checkout');
  if (!statSync(actual).isFile() || (statSync(actual).mode & 0o077) || (statSync(dirname(actual)).mode & 0o077)) throw new DeploymentError('Connection files require mode 0600 and their directory mode 0700');
  return readFileSync(actual, 'utf8');
}

export async function main(args, { checkout = root, connect = connectSSH, supervisor = createSupervisorAPI, log = console.log } = {}) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { log(help); return; }
  if (args.length && !(args.length === 2 && args[0] === '--connection')) throw new DeploymentError('Invalid arguments; use --help');
  const connectionPath = args[1] ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'st-mq', 'ha-deploy.json');
  const config = validateConnection(JSON.parse(privateFile(resolve(connectionPath), checkout)));
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim();
  if (git('status', '--porcelain')) throw new DeploymentError('Commit or set aside local changes before deploying');
  const target = git('rev-parse', 'HEAD');
  const manifest = JSON.parse(git('show', target + ':config.json'));
  const local = mkdtempSync(join(tmpdir(), 'home-energy-deploy-'));
  const remote = '/tmp/home-energy-deploy-' + randomBytes(10).toString('hex');
  let ssh, phase = 'SSH connection';
  let remoteChangesPossible = false, rebuildSubmitted = false, rebuildCompleted = false;
  try {
    ssh = await connect(config);
    const api = supervisor(ssh);
    const apps = (await api('/addons')).addons;
    phase = 'app selection';
    const selected = selectApp(apps, config.app_slug);
    phase = 'app preflight';
    const app = await api(`/addons/${selected.slug}/info`);
    if (app.slug !== selected.slug) throw new DeploymentError('Supervisor returned a different app identity');
    validateDeploymentState(app, manifest, await readStoppedEvidence(ssh, app));
    if (app.state === 'error') log('Supervisor reports error; Docker confirms Home Energy is stopped. Continuing with fresh container checks.');
    const readUnchangedApp = async (options = {}) => {
      const current = await api(`/addons/${app.slug}/info`);
      if (current.slug !== app.slug) throw new DeploymentError('Supervisor returned a different app identity');
      validateUnchangedApp(current, app, { ...options, ...await readStoppedEvidence(ssh, current) });
      return current;
    };
    const execute = async (script, timeoutMs = 30000) => {
      const result = await ssh.run(script, { timeoutMs });
      if (result.exitCode !== 0) throw new DeploymentError(`Remote command exited with status ${result.exitCode}; inspect the terminal or Supervisor locally`);
      return result.output.trim();
    };
    phase = 'preflight';
    const info = JSON.parse(await execute(`docker exec -i hassio_supervisor python3 - <<'PY'
from pathlib import Path
import json,subprocess
repo='${app.repository}'; slug='${app.slug}'
roots=[Path(b)/repo for b in ['/data/apps/git','/data/addons/git'] if (Path(b)/repo).is_dir()]
assert len(roots)==1
root=str(roots[0])
def git(*a):return subprocess.check_output(['git','-C',root,*a],stderr=subprocess.PIPE,text=True).strip()
assert not git('status','--porcelain')
runtime=[str(Path(b)/slug) for b in ['/data/apps/data','/data/addons/data','/data/app_configs','/data/addon_configs'] if (Path(b)/slug).is_dir()]
assert len(runtime)>=2
print(json.dumps({'root':root,'head':git('rev-parse','HEAD'),'runtime':runtime}))
PY`));
    if (!/^\/data\/(addons|apps)\/git\/[a-z0-9_-]+$/.test(info.root) || !/^[a-f0-9]{40}$/.test(info.head)) throw new DeploymentError('Unexpected remote repository');
    git('merge-base', '--is-ancestor', info.head, target);
    log(`Deploying ${target.slice(0, 12)}; the app will remain stopped.`);
    phase = 'local build';
    log('Building the committed frontend locally for comparison…');
    execFileSync('npm', ['run', 'build'], { cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
    if (git('rev-parse', 'HEAD') !== target || git('status', '--porcelain')) throw new DeploymentError('Checkout changed during preparation');
    const walk = path => readdirSync(join(checkout, path), { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path + '/' + d.name) : [path + '/' + d.name]).sort();
    const distHash = hash(walk('dist').map(p => p + '\0' + hash(readFileSync(join(checkout, p))) + '\n').join(''));
    const sourcePaths = git('ls-tree', '-r', '--name-only', target, 'src').split('\n').sort();
    const sourceHash = hash(sourcePaths.map(p => p + '\0' + hash(execFileSync('git', ['show', target + ':' + p], { cwd: checkout })) + '\n').join(''));
    const packageHashes = Object.fromEntries(['config.json', 'package.json', 'package-lock.json'].map(p => [p, hash(execFileSync('git', ['show', target + ':' + p], { cwd: checkout }))]));
    // The remote lock refuses concurrent deployments, including interrupted ones.
    // It is intentionally retained on failure for an operator to inspect.
    phase = 'remote lock';
    // Mark before submission: a lost response cannot prove the lock was not created.
    remoteChangesPossible = true;
    const lock = await ssh.run(`umask 077\nif mkdir /tmp/home-energy-deploy-${app.slug}.lock; then exit 0; fi\nif test -e /tmp/home-energy-deploy-${app.slug}.lock; then exit 73; fi\nexit 74`);
    if (lock.exitCode === 73) throw new DeploymentError('A deployment lock already exists. Confirm the previous deployment and any Supervisor rebuild have finished, then remove only the empty deployment lock before retrying');
    if (lock.exitCode !== 0) throw new DeploymentError('Could not create the remote deployment lock');
    phase = 'remote workspace';
    await execute(`umask 077\nmkdir ${remote}`);
    const upload = async (bytes, path, progress = false) => {
      const start = performance.now();
      const result = await ssh.run(`umask 077\nset -C\ncat > ${shellQuote(path)} && sha256sum ${shellQuote(path)}`, { input: bytes, timeoutMs: 120000 });
      if (result.exitCode !== 0) throw new DeploymentError(`File transfer exited with status ${result.exitCode}; remote files are retained`);
      if (result.output.trim() !== hash(bytes) + '  ' + path) throw new DeploymentError('Transferred file checksum mismatch');
      if (progress) log(`Transferred and verified ${bytes.length} bytes over SSH in ${((performance.now() - start) / 1000).toFixed(2)} s.`);
    };
    let step = 0;
    const python = async (code, timeoutMs = 30000) => {
      const path = remote + '/step-' + (++step) + '.py';
      await upload(Buffer.from(code), path);
      await execute(`docker cp ${path} hassio_supervisor:${remote}-step.py`);
      return execute(`docker exec hassio_supervisor python3 ${remote}-step.py`, timeoutMs);
    };
    const stateHelper = readFileSync(new URL('./lib/ha-deploy-state.py', import.meta.url), 'utf8');
    const stateChecks = { state: 'Supervisor saved state is unavailable or malformed', snapshot: 'Deployment state snapshot is unavailable or incompatible; start a fresh deployment after inspecting the retained lock',
      files: 'Stored-file metadata changed during deployment', 'saved-settings': 'Saved installation settings changed during deployment',
      metadata: 'Installed app metadata changed before rebuild', source: 'Remote source no longer matches the selected commit',
      schema: 'Supervisor installed schema does not match the deployed commit', defaults: 'Supervisor installed defaults do not match the deployed commit',
      version: 'Supervisor installed version does not match the deployed commit' };
    const checkState = async (action, installed = false, checkFiles = false) => {
      const argumentsPrefix = `FILE_HASSIO_APPS, '${app.slug}', ${JSON.stringify(info.runtime)}, '${remote}-before.json'`;
      const statement = action === 'snapshot' ? `snapshot(${argumentsPrefix})`
        : `verify(${argumentsPrefix}, '${info.root}', '${target}', '${packageHashes['config.json']}', installed=${installed ? 'True' : 'False'}, check_files=${checkFiles ? 'True' : 'False'})`;
      const code = stateHelper + `\nfrom supervisor.const import FILE_HASSIO_APPS\ntry:\n ${statement}\nexcept DeploymentStateError as error:\n print(json.dumps({'error': error.code}))\nelse:\n` + (installed && !checkFiles
        ? ` from supervisor.apps.options import UiOptions\n manifest=json.loads(Path('${info.root}/config.json').read_text())\n print(json.dumps({'ok': True, 'schema': UiOptions(None)(manifest['schema'])}))\n`
        : ` print(json.dumps({'ok': True}))\n`);
      const checksStoredMetadata = action === 'snapshot' || checkFiles;
      const label = action === 'snapshot' ? 'Stored-file snapshot' : 'Stored-file verification';
      if (checksStoredMetadata) log(`${label}: checking file sizes and modification times without reading stored contents…`);
      const heartbeat = checksStoredMetadata ? setInterval(() => log(`${label} is still running…`), 30000) : undefined;
      let result;
      try {
        result = JSON.parse(await python(code, checksStoredMetadata ? STORED_FILES_TIMEOUT_MS : 30000));
      } finally { clearInterval(heartbeat); }
      if (result?.ok !== true) throw new DeploymentError(Object.hasOwn(stateChecks, result?.error) ? stateChecks[result.error] : 'Deployment state verification failed');
      return result.schema;
    };
    phase = 'saved settings and stored-file snapshot';
    await checkState('snapshot');
    if (info.head !== target) {
      phase = 'bundle transfer';
      git('bundle', 'create', join(local, 'update.bundle'), info.head + '..' + target, 'HEAD');
      if (git('bundle', 'list-heads', join(local, 'update.bundle')) !== target + ' HEAD') throw new DeploymentError('Checkout changed during bundle preparation');
      const bundle = readFileSync(join(local, 'update.bundle'));
      await upload(bundle, remote + '/update.bundle', true);
      await execute(`docker cp ${remote}/update.bundle hassio_supervisor:${remote}.bundle`);
      phase = 'source fast-forward';
      await readUnchangedApp();
      await python(`import subprocess,hashlib\nfrom pathlib import Path\nroot='${info.root}'\ndef git(*a):return subprocess.check_output(['git','-C',root,*a],stderr=subprocess.PIPE,text=True).strip()\nassert hashlib.sha256(Path('${remote}.bundle').read_bytes()).hexdigest()=='${hash(bundle)}'\nassert git('rev-parse','HEAD')=='${info.head}'\nassert not git('status','--porcelain')\ngit('fetch','${remote}.bundle','HEAD')\nassert git('rev-parse','FETCH_HEAD')=='${target}'\ngit('merge','--ff-only','FETCH_HEAD')\n`);
    }
    phase = 'Supervisor metadata refresh';
    await readUnchangedApp();
    const repositories = repositorySources(await api('/store'), app.repository);
    await checkState('verify');
    validateRepositories(await api('/store'), repositories, app.repository);
    // Supervisor v1 supports reapplying the unchanged repository list. Unlike
    // /store/reload it rereads local manifests without fetching Git branches.
    // Never fall back to a pull, change the list, or replay an uncertain request.
    await api('/supervisor/options', 'post', 60, { addons_repositories: repositories });
    validateRepositories(await api('/store'), repositories, app.repository);
    await checkState('verify');
    phase = 'rebuild';
    await readUnchangedApp();
    log('Source verified. Supervisor is rebuilding the image…');
    const heartbeat = setInterval(() => log('Supervisor rebuild is still running…'), 30000);
    try {
      rebuildSubmitted = true;
      await api(`/addons/${app.slug}/rebuild`, 'post', 900);
      rebuildCompleted = true;
    } finally { clearInterval(heartbeat); }
    log('Supervisor rebuild completed. Verifying the image and preserved settings…');
    phase = 'verification: app state';
    // Effective options include defaults; raw saved overrides are checked below.
    const current = await readUnchangedApp({ compareOptions: false });
    phase = 'verification: installed metadata';
    const installedSchema = await checkState('verify', true);
    validateInstalledSchema(current, installedSchema);
    phase = 'verification: image lookup';
    const image = JSON.parse(await execute(`python3 - <<'PY'
import json,subprocess
rows=[json.loads(x) for x in subprocess.check_output(['docker','image','ls','--format','{{json .}}'],text=True).splitlines()]
rows=[r for r in rows if r['Tag']==${JSON.stringify(app.version)} and r['Repository'].endswith(('-st-mq','_st-mq'))]
assert len(rows)==1
print(json.dumps(rows[0]['Repository']+':'+rows[0]['Tag']))
PY`));
    if (!/^[a-zA-Z0-9_./:-]+$/.test(image)) throw new DeploymentError('Unexpected image reference');
    const verify = `import{readFileSync,readdirSync}from'node:fs';import{createHash}from'node:crypto';\nconst hash=x=>createHash('sha256').update(x).digest('hex');const walk=p=>readdirSync(p,{withFileTypes:true}).flatMap(d=>d.isDirectory()?walk(p+'/'+d.name):[p+'/'+d.name]).sort();const tree=p=>hash(walk(p).map(f=>f+'\\0'+hash(readFileSync(f))+'\\n').join(''));\nif(tree('src')!=='${sourceHash}'||tree('dist')!=='${distHash}')process.exit(1);for(const[p,h]of Object.entries(${JSON.stringify(packageHashes)}))if(hash(readFileSync(p))!==h)process.exit(1);\nconsole.log(JSON.stringify({sourceFiles:walk('src').length,frontendFiles:walk('dist').length,architecture:process.arch}));`;
    phase = 'verification: image contents';
    await upload(Buffer.from(verify), remote + '/verify.mjs');
    const checked = JSON.parse(await execute(`cat ${remote}/verify.mjs | docker run --rm -i --network none --entrypoint node ${shellQuote(image)} --input-type=module`, 60000));
    phase = 'verification: final app state';
    validateInstalledSchema(await readUnchangedApp({ compareOptions: false }), installedSchema);
    phase = 'verification: stored files and saved settings';
    await checkState('verify', true, true);
    phase = 'verification: repositories';
    validateRepositories(await api('/store'), repositories, app.repository);
    // Only deployment-owned temporary files are removed, after all checks pass.
    phase = 'cleanup';
    await execute(`docker exec hassio_supervisor rm -f ${remote}-step.py ${remote}-before.json ${remote}.bundle && rm -rf ${remote} && rmdir /tmp/home-energy-deploy-${app.slug}.lock`);
    log(`Verified ${target.slice(0, 12)}: ${checked.sourceFiles} source files, ${checked.frontendFiles} frontend files, ${checked.architecture}. Supervisor schema and defaults match. Stored-file metadata and saved settings unchanged. App remains stopped.`);
    log('Start the app explicitly when ready. Incompatible saved fields require configuration recovery; deployment does not remove them.');
  } catch (error) {
    const detail = error instanceof DeploymentError || error instanceof DeploymentTransportError ? error.message + ' ' : '';
    const rebuildStatus = rebuildCompleted ? 'Supervisor confirmed rebuild completion, but deployment verification or cleanup did not finish'
      : rebuildSubmitted ? 'the submitted rebuild may still be running' : 'no rebuild was submitted by this run';
    const outcome = remoteChangesPossible
      ? `No automatic rollback or restart was attempted. Inspect HA before retrying; ${rebuildStatus}. Any created remote deployment files and lock are retained.`
      : 'No remote changes were attempted by this run; no deployment lock, files or rebuild were created or submitted.';
    throw new DeploymentError(`${detail}Deployment stopped during ${phase}. ${outcome}`);
  } finally { await ssh?.close(); rmSync(local, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // Never print raw network/process errors, configuration, terminal output or tokens.
    const safe = error instanceof DeploymentError;
    console.error(safe ? error.message : 'Deployment preparation failed; check private connection files, permissions and local prerequisites');
    process.exitCode = 1;
  });
}
