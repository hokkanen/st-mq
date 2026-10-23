import { runCommand } from '../../scripts/lib/deployment-command.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { main, readPair, userServiceEnvironment } from '../../scripts/lib/linux-deployment.js';

test('native user systemd setup, listener ownership and deployment use only a disposable synthetic app', {
  skip: process.env.STMQ_REQUIRE_SYSTEMD_TESTS !== '1', timeout: 90000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'linux-systemd-'));
  const service = 'synthetic-linux-deployment-' + randomUUID() + '.service';
  const unit = `/run/user/${process.getuid()}/systemd/user/${service}`;
  const systemctl = (...args) => runCommand('systemctl', ['--user', ...args], { env: userServiceEnvironment() });
  t.after(async () => {
    try { await systemctl('stop', service); } catch { /* It might never have loaded. */ }
    if (existsSync(unit)) rmSync(unit);
    try { await systemctl('daemon-reload'); } catch { /* Preserve original test failure. */ }
    rmSync(root, { recursive: true, force: true });
  });
  const source = join(root, 'source checkout'), privateDir = join(root, 'private'), data = join(root, 'data'), runtime = join(root, 'runtime with spaces');
  for (const path of [source, privateDir, data]) mkdirSync(path, { mode: 0o700 });
  mkdirSync(join(source, 'src/app'), { recursive: true });
  const portFinder = createServer(); await new Promise(resolve => portFinder.listen(0, '127.0.0.1', resolve));
  const port = portFinder.address().port; await new Promise(resolve => portFinder.close(resolve));
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'synthetic-linux-systemd', version: '1.0.0', type: 'module', scripts: { build: 'node build.js' } }));
  writeFileSync(join(source, 'package-lock.json'), JSON.stringify({ name: 'synthetic-linux-systemd', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'synthetic-linux-systemd', version: '1.0.0' } } }));
  writeFileSync(join(source, '.gitignore'), 'node_modules/\ndist/\n');
  writeFileSync(join(source, 'build.js'), "import{mkdirSync,writeFileSync}from'node:fs';mkdirSync('dist',{recursive:true});mkdirSync('node_modules',{recursive:true});writeFileSync('dist/index.html','synthetic');\n");
  writeFileSync(join(source, 'src/main.js'), `import {createServer} from 'node:http';
const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({role:'slave',nodeId:'synthetic-node',pairId:'synthetic-pair',canControl:false,busy:false,phase:null,vip:{owned:false},peer:{nodeId:'synthetic-master',role:'master',reachable:true,lastSeenAt:Date.now()},sync:{state:'ready',error:null}}));});
server.listen(Number(process.env.STMQ_PORT),'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));\n`);
  writeFileSync(join(source, 'src/app/config.js'), `export function loadConfig(e){return {topology:'pair',addon:false,dataDir:e.STMQ_DATA_DIR,databaseDir:e.STMQ_DATABASE_DIR,dbPath:e.STMQ_DATABASE_DIR+'/history.sqlite',pair:{directory:e.STMQ_PAIR_DIR,sourceDirectory:e.STMQ_PAIR_DIR+'/work',snapshotDirectory:e.STMQ_DATABASE_DIR+'/snapshots',snapshotExportDirectory:e.STMQ_DATA_DIR+'/backups'}};}\n`);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main'); git('config', 'user.email', 'synthetic@example.invalid'); git('config', 'user.name', 'Synthetic');
  git('add', '.'); git('commit', '-m', 'Synthetic service');
  const config = join(privateDir, 'installation.json'), environment = join(privateDir, 'runtime settings.env'), connection = join(privateDir, 'connection.json');
  writeFileSync(config, '{}', { mode: 0o600 });
  writeFileSync(join(data, 'retained'), 'synthetic-history');
  writeFileSync(environment, [`STMQ_CONFIG=${config}`, `STMQ_DATA_DIR=${data}`, `STMQ_DATABASE_DIR=${data}`, `STMQ_PAIR_DIR=${data}/pairing`, 'STMQ_TOPOLOGY=pair', `STMQ_PORT=${port}`].join('\n'), { mode: 0o600 });
  const c = { runtime_dir: runtime, service_scope: 'user', service_name: service, node_path: process.execPath,
    environment_file: environment, status_url: `http://127.0.0.1:${port}`, sync_timeout_seconds: 15 };
  writeFileSync(connection, JSON.stringify(c), { mode: 0o600 });
  const observations = [];
  const dependencies = { source, unitPath: () => unit, log: () => {}, run: async (exe, args, options) => {
    const result = await runCommand(exe, args, options);
    if (exe === 'systemctl' && args.includes('show')) observations.push(result);
    return result;
  }, authenticate: async () => assert.fail('Current user-service deployment must not authenticate sudo'),
  lease: () => assert.fail('No privilege renewal expected'), helperNeedsRefresh: async () => false,
  refreshHelper: async () => assert.fail('Current helper must not be refreshed') };
  try { await main('setup', ['--connection', connection, '--apply'], dependencies); }
  catch (error) { t.diagnostic(observations.join('\n')); throw error; }
  assert.equal(await systemctl('show', service, '--property=ActiveState', '--value'), 'inactive');
  // Verify the generated syntax with the host's native systemd parser.
  await runCommand('systemd-analyze', ['--user', 'verify', unit], { env: userServiceEnvironment() });
  await systemctl('start', service);
  for (let attempt = 0; ; attempt++) {
    try { await readPair(c); break; } catch (error) {
      if (attempt > 30) {
        t.diagnostic(await runCommand('journalctl', ['--user', '-u', service, '-n', '20', '--no-pager', '-o', 'cat']));
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const old = realpathSync(join(runtime, 'current'));
  writeFileSync(join(source, 'revision'), 'synthetic-next'); git('add', 'revision'); git('commit', '-m', 'Synthetic update');
  await main('deploy', ['--connection', connection], dependencies);
  assert.notEqual(realpathSync(join(runtime, 'current')), old);
  assert.equal(readFileSync(join(data, 'retained'), 'utf8'), 'synthetic-history');
  assert.equal((await readPair(c)).role, 'slave');
  await systemctl('stop', service);
  writeFileSync(join(source, 'revision'), 'synthetic-stopped-update'); git('add', 'revision'); git('commit', '-m', 'Synthetic stopped update');
  await main('deploy', ['--connection', connection, '--stopped'], dependencies);
  assert.equal(await systemctl('show', service, '--property=ActiveState', '--value'), 'inactive');
});
