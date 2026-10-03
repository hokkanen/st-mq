#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectHA, connectTerminal, shellQuote } from './lib/ha-deploy-transport.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
class DeploymentError extends Error {}

const help = `Usage: node scripts/deploy-ha.js [--connection /private/path/ha-deploy.json]

Deploy this checkout's committed HEAD through Home Assistant's WebSocket and
Advanced SSH & Web Terminal ingress. The installed app MUST be stopped and
remains stopped. No Git push, release publication, configuration edit or data
reset is performed. The installed manifest version must match this checkout.

Default connection: $XDG_CONFIG_HOME/st-mq/ha-deploy.json
(or ~/.config/st-mq/ha-deploy.json). See docs/ha-deployment.md.
`;

export function validateConnection(value) {
  const allowed = ['url', 'token_path', 'app_slug', 'terminal_slug'];
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !allowed.includes(k))) throw new DeploymentError('Invalid connection fields');
  let url;
  try { url = new URL(value.url); } catch { throw new DeploymentError('Connection requires an HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new DeploymentError('Connection URL must be an HTTP(S) origin without credentials');
  if (typeof value.token_path !== 'string' || !isAbsolute(value.token_path)) throw new DeploymentError('token_path must be an absolute private file path');
  for (const key of ['app_slug', 'terminal_slug']) if (value[key] !== undefined && (typeof value[key] !== 'string' || !/^[a-z0-9_-]+$/.test(value[key]))) throw new DeploymentError('Invalid app or terminal slug');
  return { ...value, url: url.origin };
}

export function selectApp(apps, slug, kind) {
  const matches = apps.filter(a => slug ? a.slug === slug : kind === 'app' ? a.slug?.endsWith('_st-mq') : /Advanced SSH & Web Terminal/.test(a.name ?? ''));
  if (matches.length !== 1 || !/^[a-z0-9_-]+$/.test(matches[0].slug)) throw new DeploymentError(`Select exactly one ${kind} using its slug in the connection file`);
  return matches[0];
}

export function validateDeploymentState(app, manifest, terminal) {
  if (app.state !== 'stopped') throw new DeploymentError('Stop Home Energy in HA before deploying; this script never stops or starts it');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new DeploymentError('Invalid manifest version');
  if (app.version !== manifest.version) throw new DeploymentError('Installed and checkout versions differ; install the matching version through Supervisor first');
  if (terminal.state !== 'started') throw new DeploymentError('Start Advanced SSH & Web Terminal first');
  if (typeof app.repository !== 'string' || !/^[a-z0-9_-]+$/.test(app.repository)) throw new DeploymentError('Expected a Git-backed app repository');
}

function privateFile(path) {
  const actual = realpathSync(path), rel = relative(realpathSync(root), actual);
  if (rel === '' || (!rel.startsWith('..' + '/') && !isAbsolute(rel))) throw new DeploymentError('Deployment credentials must be outside the checkout');
  if (!statSync(actual).isFile() || (statSync(actual).mode & 0o077) || (statSync(dirname(actual)).mode & 0o077)) throw new DeploymentError('Credential files require mode 0600 and their directory mode 0700');
  return readFileSync(actual, 'utf8');
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(help); return; }
  if (args.length && !(args.length === 2 && args[0] === '--connection')) throw new DeploymentError('Invalid arguments; use --help');
  const connectionPath = args[1] ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'st-mq', 'ha-deploy.json');
  const config = validateConnection(JSON.parse(privateFile(resolve(connectionPath))));
  const token = privateFile(config.token_path).trim();
  if (!token || /\s/.test(token)) throw new DeploymentError('Invalid token file');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim();
  if (git('status', '--porcelain')) throw new DeploymentError('Commit or set aside local changes before deploying');
  const target = git('rev-parse', 'HEAD');
  const manifest = JSON.parse(git('show', target + ':config.json'));
  const local = mkdtempSync(join(tmpdir(), 'home-energy-deploy-'));
  const remote = '/tmp/home-energy-deploy-' + randomBytes(10).toString('hex');
  let ha, terminalConnection, phase = 'connection';
  try {
    ha = await connectHA({ url: config.url, token });
    const api = (endpoint, method = 'get', timeout = 30) => ha.call({ type: 'supervisor/api', endpoint, method, timeout }, timeout * 1000);
    const apps = (await api('/addons')).addons;
    const app = await api(`/addons/${selectApp(apps, config.app_slug, 'app').slug}/info`);
    const terminal = await api(`/addons/${selectApp(apps, config.terminal_slug, 'terminal').slug}/info`);
    validateDeploymentState(app, manifest, terminal);
    const session = (await api('/ingress/session', 'post')).session;
    if (typeof session !== 'string' || !session || /[\r\n;]/.test(session)) throw new DeploymentError('Invalid ingress session');
    terminalConnection = await connectTerminal({ url: config.url, session, ingress: terminal.ingress_entry });
    const execute = async (script, timeoutMs = 30000) => {
      const result = await terminalConnection.run(script, { timeoutMs });
      if (result.exitCode !== 0) throw new DeploymentError('Remote command failed; inspect the terminal or Supervisor locally');
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
    console.log(`Deploying ${target.slice(0, 12)}; the app will remain stopped.`);
    phase = 'local build';
    console.log('Building the committed frontend locally for comparison…');
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
    if (git('rev-parse', 'HEAD') !== target || git('status', '--porcelain')) throw new DeploymentError('Checkout changed during preparation');
    const walk = path => readdirSync(join(root, path), { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path + '/' + d.name) : [path + '/' + d.name]).sort();
    const distHash = hash(walk('dist').map(p => p + '\0' + hash(readFileSync(join(root, p))) + '\n').join(''));
    const sourcePaths = git('ls-tree', '-r', '--name-only', target, 'src').split('\n').sort();
    const sourceHash = hash(sourcePaths.map(p => p + '\0' + hash(execFileSync('git', ['show', target + ':' + p], { cwd: root })) + '\n').join(''));
    const packageHashes = Object.fromEntries(['config.json', 'package.json', 'package-lock.json'].map(p => [p, hash(execFileSync('git', ['show', target + ':' + p], { cwd: root }))]));
    // The remote lock refuses concurrent deployments, including interrupted ones.
    // It is intentionally retained on failure for an operator to inspect.
    phase = 'remote lock and fingerprints';
    await execute(`umask 077\nmkdir /tmp/home-energy-deploy-${app.slug}.lock && mkdir ${remote}`);
    const upload = async (bytes, path, progress = false) => {
      const encoded = bytes.toString('base64');
      await execute(`umask 077\n: > ${shellQuote(path + '.b64')}`);
      for (let offset = 0; offset < encoded.length; offset += 1600) {
        await execute(`test "$(wc -c < ${shellQuote(path + '.b64')})" -eq ${offset} && printf '%s' '${encoded.slice(offset, offset + 1600)}' >> ${shellQuote(path + '.b64')}`);
        if (progress && offset % 32000 === 0) console.log(`Transfer ${Math.round(Math.min(offset + 1600, encoded.length) / encoded.length * 100)}%`);
      }
      const result = await execute(`base64 -d ${shellQuote(path + '.b64')} > ${shellQuote(path)} && sha256sum ${shellQuote(path)}`);
      if (!result.startsWith(hash(bytes) + ' ')) throw new DeploymentError('Transferred file checksum mismatch');
    };
    const python = async code => {
      await upload(Buffer.from(code), remote + '/step.py');
      await execute(`docker cp ${remote}/step.py hassio_supervisor:${remote}-step.py`);
      return execute(`docker exec hassio_supervisor python3 ${remote}-step.py`);
    };
    const fingerprintCode = `from pathlib import Path\nimport hashlib,json\ndef digest(p):\n h=hashlib.sha256()\n with p.open('rb') as f:\n  for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)\n return h.hexdigest()\nroots=${JSON.stringify(info.runtime)}\nrecords={}\nfor root in roots:\n for p in Path(root).rglob('*'):\n  if p.is_symlink(): records[str(p)]=['link',str(p.readlink())]\n  elif p.is_file(): records[str(p)]=['file',digest(p)]\n`;
    await python(fingerprintCode + `\nimport os\nfd=os.open('${remote}-before.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)\nwith os.fdopen(fd,'w') as f:json.dump(records,f)\n`);
    if (info.head !== target) {
      phase = 'bundle transfer';
      git('bundle', 'create', join(local, 'update.bundle'), info.head + '..' + target, 'HEAD');
      if (git('bundle', 'list-heads', join(local, 'update.bundle')) !== target + ' HEAD') throw new DeploymentError('Checkout changed during bundle preparation');
      const bundle = readFileSync(join(local, 'update.bundle'));
      await upload(bundle, remote + '/update.bundle', true);
      await execute(`docker cp ${remote}/update.bundle hassio_supervisor:${remote}.bundle`);
      phase = 'source fast-forward';
      if ((await api(`/addons/${app.slug}/info`)).state !== 'stopped') throw new DeploymentError('App started during transfer; source update cancelled');
      await python(`import subprocess,hashlib\nfrom pathlib import Path\nroot='${info.root}'\ndef git(*a):return subprocess.check_output(['git','-C',root,*a],stderr=subprocess.PIPE,text=True).strip()\nassert hashlib.sha256(Path('${remote}.bundle').read_bytes()).hexdigest()=='${hash(bundle)}'\nassert git('rev-parse','HEAD')=='${info.head}'\nassert not git('status','--porcelain')\ngit('fetch','${remote}.bundle','HEAD')\nassert git('rev-parse','FETCH_HEAD')=='${target}'\ngit('merge','--ff-only','FETCH_HEAD')\n`);
    }
    phase = 'rebuild';
    const before = await api(`/addons/${app.slug}/info`);
    if (before.state !== 'stopped' || hash(JSON.stringify(before.options)) !== hash(JSON.stringify(app.options))) throw new DeploymentError('App state or configuration changed during deployment');
    console.log('Source verified. Supervisor is rebuilding the image…');
    const heartbeat = setInterval(() => console.log('Supervisor rebuild is still running…'), 30000);
    try { await api(`/addons/${app.slug}/rebuild`, 'post', 900); } finally { clearInterval(heartbeat); }
    phase = 'verification';
    const current = await api(`/addons/${app.slug}/info`);
    if (current.state !== 'stopped' || current.version !== app.version || hash(JSON.stringify(current.options)) !== hash(JSON.stringify(app.options))) throw new DeploymentError('App state, version or configuration changed');
    await python(fingerprintCode + `\nimport subprocess\nassert records==json.loads(Path('${remote}-before.json').read_text())\nassert subprocess.check_output(['git','-C','${info.root}','rev-parse','HEAD'],text=True).strip()=='${target}'\nassert not subprocess.check_output(['git','-C','${info.root}','status','--porcelain'],text=True).strip()\n`);
    const image = JSON.parse(await execute(`python3 - <<'PY'
import json,subprocess
rows=[json.loads(x) for x in subprocess.check_output(['docker','image','ls','--format','{{json .}}'],text=True).splitlines()]
rows=[r for r in rows if r['Tag']==${JSON.stringify(app.version)} and r['Repository'].endswith(('-st-mq','_st-mq'))]
assert len(rows)==1
print(json.dumps(rows[0]['Repository']+':'+rows[0]['Tag']))
PY`));
    if (!/^[a-zA-Z0-9_./:-]+$/.test(image)) throw new DeploymentError('Unexpected image reference');
    const verify = `import{readFileSync,readdirSync}from'node:fs';import{createHash}from'node:crypto';\nconst hash=x=>createHash('sha256').update(x).digest('hex');const walk=p=>readdirSync(p,{withFileTypes:true}).flatMap(d=>d.isDirectory()?walk(p+'/'+d.name):[p+'/'+d.name]).sort();const tree=p=>hash(walk(p).map(f=>f+'\\0'+hash(readFileSync(f))+'\\n').join(''));\nif(tree('src')!=='${sourceHash}'||tree('dist')!=='${distHash}')process.exit(1);for(const[p,h]of Object.entries(${JSON.stringify(packageHashes)}))if(hash(readFileSync(p))!==h)process.exit(1);\nconsole.log(JSON.stringify({sourceFiles:walk('src').length,frontendFiles:walk('dist').length,architecture:process.arch}));`;
    await upload(Buffer.from(verify), remote + '/verify.mjs');
    const checked = JSON.parse(await execute(`cat ${remote}/verify.mjs | docker run --rm -i --network none --entrypoint node ${shellQuote(image)} --input-type=module`, 60000));
    if ((await api(`/addons/${app.slug}/info`)).state !== 'stopped') throw new DeploymentError('App started during image verification');
    // Only deployment-owned temporary files are removed, after all checks pass.
    await execute(`docker exec hassio_supervisor rm -f ${remote}-step.py ${remote}-before.json ${remote}.bundle && rm -rf ${remote} && rmdir /tmp/home-energy-deploy-${app.slug}.lock`);
    console.log(`Verified ${target.slice(0, 12)}: ${checked.sourceFiles} source files, ${checked.frontendFiles} frontend files, ${checked.architecture}. Stored files and configuration unchanged. App remains stopped.`);
  } catch (error) {
    const detail = error instanceof DeploymentError ? error.message + ' ' : '';
    throw new DeploymentError(`${detail}Deployment stopped during ${phase}. No automatic rollback or restart was attempted. Inspect HA before retrying; any submitted rebuild may still be running. Any created remote deployment files and lock are retained.`);
  } finally { terminalConnection?.close(); ha?.close(); rmSync(local, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // Never print raw network/process errors, configuration, terminal output or tokens.
    const safe = error instanceof DeploymentError;
    console.error(safe ? error.message : 'Deployment preparation failed; check private connection files, permissions and local prerequisites');
    process.exitCode = 1;
  });
}
