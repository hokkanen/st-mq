import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { main as setup } from '../../scripts/lib/linux-setup.js';
import { main as runtimeOperation, readLocalStatus, userServiceEnvironment } from '../../scripts/lib/linux-deployment.js';
import { runCommand } from '../../scripts/lib/deployment-command.js';

// The actual wizard, staged npm build, application, workers, listener probes and
// user systemd service run here. Only privilege acquisition/lingering is replaced:
// this unique disposable service must never change host boot or household state.
test('native wizard installs and deploys the actual application in isolated standalone simulation', {
  skip: process.env.STMQ_REQUIRE_SYSTEMD_TESTS !== '1', timeout: 180000,
}, async t => {
  const source = resolve(import.meta.dirname, '../..');
  assert.equal(await runCommand('git', ['status', '--porcelain'], { cwd: source }), '', 'Native setup requires the committed source checkout.');
  const root = mkdtempSync(join(tmpdir(), 'st-mq-native-setup-'));
  const userCommand = (exe, args, options = {}) => runCommand(exe, args,
    { ...options, env: userServiceEnvironment() });
  const serviceName = 'synthetic-st-mq-setup-' + randomUUID() + '.service';
  const unit = `/run/user/${process.getuid()}/systemd/user/${serviceName}`;
  const privateDirectory = join(root, 'private config'), runtime = join(root, 'runtime with spaces'), data = join(root, 'isolated data');
  mkdirSync(privateDirectory, { mode: 0o700 });
  const connectionPath = join(privateDirectory, 'linux-deploy.json'), environment = join(privateDirectory, 'linux-runtime.env'), secrets = join(privateDirectory, 'secrets.json');
  const finder = createServer(); await new Promise(yes => finder.listen(0, '127.0.0.1', yes));
  const port = finder.address().port; await new Promise(yes => finder.close(yes));
  const connection = { service_name: serviceName, service_scope: 'user', runtime_dir: runtime, node_path: process.execPath,
    environment_file: environment, status_url: `http://127.0.0.1:${port}`, sync_timeout_seconds: 30 };
  writeFileSync(connectionPath, JSON.stringify(connection), { mode: 0o600 });
  const events = [], transcript = [];
  const native = async (exe, args, options) => {
    if (exe === 'sudo') {
      assert.deepEqual(args, ['-n', 'loginctl', 'enable-linger', userInfo().username]);
      events.push('reviewed-linger-skipped'); return '';
    }
    return runCommand(exe, args, options);
  };
  t.after(async () => {
    try { await userCommand('systemctl', ['--user', 'stop', serviceName], { timeout: 30000 }); } catch { /* Unit might not have been installed. */ }
    try { await userCommand('systemctl', ['--user', 'disable', serviceName], { timeout: 10000 }); } catch { /* No enabled unit may exist. */ }
    rmSync(unit, { force: true });
    try { await userCommand('systemctl', ['--user', 'daemon-reload']); } catch { /* Preserve the original assertion. */ }
    try { await userCommand('systemctl', ['--user', 'reset-failed', serviceName]); } catch { /* No failed unit may exist. */ }
    rmSync(root, { recursive: true, force: true });
  });
  const io = {
    log: message => transcript.push(message),
    choose: async (label, choices) => {
      if (label === 'Operation') return 'standalone';
      if (label === 'Configuration source') { assert.ok(choices.includes('Minimal starter')); return 'Minimal starter'; }
      assert.fail('Unexpected wizard choice: ' + label);
    },
    ask: async (label, fallback) => ({ 'Runtime directory': runtime, 'Data directory': data,
      'Private configuration file': secrets, 'Local web port': String(port) })[label] ?? fallback,
    confirm: async label => {
      if (label === 'Open the minimal starter in an editor?') return false;
      if (label === 'Apply this configuration, install and start?') return true;
      assert.fail('Unexpected confirmation: ' + label);
    },
    edit: async () => assert.fail('Minimal skeleton should not require an editor.'),
    paste: async () => assert.fail('No credentials are needed for isolated simulation.'),
    external: action => action(),
  };
  const dependencies = { source, home: root, env: {}, io, run: native, unitPath: () => unit,
    inspect: async () => ({ user: userInfo().username, group: userInfo().username, packages: [], broker: { installed: true, managed: false, active: false } }),
    authenticate: async () => { events.push('reviewed-sudo-skipped'); },
    lease: () => ({ assertValid() {}, async close() {} }),
    provision: async () => assert.fail('Standalone prerequisites are already installed.'),
    install: (mode, args, options) => runtimeOperation(mode, args, { ...options, unitPath: () => unit }),
  };
  let result;
  try { result = await setup(['--connection', connectionPath], dependencies); }
  catch (error) {
    t.diagnostic(transcript.join('\n'));
    try { t.diagnostic(await userCommand('journalctl', ['--user', '-u', serviceName, '-n', '20', '--no-pager', '-o', 'cat'])); } catch { /* No private or household logs. */ }
    throw error;
  }
  assert.equal(result.state, 'ready'); assert.equal(result.topology, 'standalone');
  assert.equal(result.connectionPath, connectionPath); assert.ok(events.includes('reviewed-sudo-skipped'));
  assert.ok(events.includes('reviewed-linger-skipped')); assert.ok(transcript.some(line => line.includes('simulation; equipment has not been commissioned')));
  await userCommand('systemd-analyze', ['--user', 'verify', unit]);
  const installed = JSON.parse(readFileSync(connectionPath, 'utf8'));
  const status = await readLocalStatus(installed);
  assert.equal(status.input, 'simulated'); assert.equal(status.environment, 'simulation'); assert.equal(status.automation.home.enabled, false);
  const database = join(data, 'simulation.sqlite'); assert.ok(existsSync(database));
  const savedConfiguration = readFileSync(secrets), inode = lstatSync(database).ino;
  const runOptions = { source, run: native, unitPath: () => unit, log: message => transcript.push(message) };
  await runtimeOperation('deploy', ['--connection', connectionPath], runOptions);
  assert.equal((await readLocalStatus(installed)).input, 'simulated'); assert.equal(lstatSync(database).ino, inode);
  assert.deepEqual(readFileSync(secrets), savedConfiguration);
  await userCommand('systemctl', ['--user', 'stop', serviceName], { timeout: 30000 });
  await runtimeOperation('deploy', ['--connection', connectionPath, '--stopped'], runOptions);
  assert.equal(await userCommand('systemctl', ['--user', 'show', serviceName, '--property=ActiveState', '--value']), 'inactive');
  assert.equal(lstatSync(database).ino, inode); assert.deepEqual(readFileSync(secrets), savedConfiguration);
  for (const path of [secrets, environment, connectionPath]) assert.equal(lstatSync(path).mode & 0o777, 0o600);
});
