import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/deploy-ha.js';
import { DeploymentTransportError } from '../scripts/lib/ha-deploy-transport.js';

function workflowFixture(t, { existingLock = false, corruptBundle = false, changedApp = false, optionsAfterRebuild, lostRebuildResponse = false, complete = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ha-deploy-workflow-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const checkout = join(directory, 'checkout');
  const privateDirectory = join(directory, 'private');
  mkdirSync(checkout);
  mkdirSync(join(checkout, 'src'));
  mkdirSync(privateDirectory, { mode: 0o700 });
  const connectionPath = join(privateDirectory, 'connection.json');
  writeFileSync(connectionPath, JSON.stringify({ ssh_host: 'synthetic-ha' }), { mode: 0o600 });
  writeFileSync(join(checkout, '.gitignore'), 'dist/\n');
  writeFileSync(join(checkout, 'config.json'), JSON.stringify({ version: '0.9.5-dev.3' }));
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({
    name: 'synthetic-deployment-fixture', version: '0.9.5-dev.3', private: true,
    scripts: { build: 'node build.cjs' },
  }));
  writeFileSync(join(checkout, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  writeFileSync(join(checkout, 'build.cjs'), "const fs = require('node:fs'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/index.html', '<!doctype html><title>Synthetic</title>');\n");
  writeFileSync(join(checkout, 'src/index.js'), 'export const synthetic = true;\n');
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Synthetic deployment test');
  git('config', 'user.email', 'synthetic@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  git('add', '.gitignore', 'config.json', 'package.json', 'package-lock.json', 'build.cjs', 'src/index.js');
  git('commit', '--quiet', '-m', 'Synthetic deployment baseline');
  const remoteHead = git('rev-parse', 'HEAD');
  if (corruptBundle) {
    writeFileSync(join(checkout, 'src/index.js'), 'export const synthetic = false;\n');
    git('add', 'src/index.js');
    git('commit', '--quiet', '-m', 'Synthetic deployment target');
  }

  const events = [];
  const messages = [];
  const uploads = new Map();
  const app = { slug: 'synthetic_st-mq', repository: 'synthetic', state: 'stopped', version: '0.9.5-dev.3', options: {
    enabled: false,
    charging: { limit: 0, schedule: [{ start: '01:00', target: 80 }, { start: '02:00', target: null }] },
  } };
  let appReads = 0;
  let rebuilt = false;
  const ssh = {
    async run(script, { input } = {}) {
      events.push({ type: 'ssh', script, input });
      if (script.includes('/data/addons/git') && script.includes("'rev-parse'")) {
        return { exitCode: 0, output: JSON.stringify({
          root: '/data/addons/git/synthetic', head: remoteHead,
          runtime: ['/data/addons/data/synthetic_st-mq', '/data/addon_configs/synthetic_st-mq'],
        }) };
      }
      if (script.includes('if mkdir') && script.includes('.lock')) return { exitCode: existingLock ? 73 : 0, output: '' };
      if (/^umask 077\nmkdir \/tmp\/home-energy-deploy-[a-f0-9]+$/.test(script)) return { exitCode: 0, output: '' };
      if (input !== undefined && script.includes('sha256sum')) {
        assert.ok(Buffer.isBuffer(input), 'upload streams bytes directly');
        const path = script.match(/sha256sum '([^']+)'/)[1];
        uploads.set(path, input);
        const checksum = corruptBundle && path.endsWith('.bundle') ? '0'.repeat(64) : createHash('sha256').update(input).digest('hex');
        return { exitCode: 0, output: `${checksum}  ${path}\n` };
      }
      if (script.startsWith('docker cp ') || /^docker exec hassio_supervisor python3 /.test(script)) return { exitCode: 0, output: '' };
      if (complete && script.includes("['docker','image','ls'")) return { exitCode: 0, output: JSON.stringify('synthetic-st-mq:0.9.5-dev.3') };
      if (complete && script.includes('docker run')) {
        assert.match(script, /--network none/);
        assert.match(script, /--entrypoint node/);
        assert.doesNotMatch(script, /--volume|--mount|\s-v\s/);
        const path = script.match(/^cat (\S+) \|/)[1];
        assert.ok(uploads.has(path));
        const output = execFileSync(process.execPath, ['--input-type=module'], {
          cwd: checkout, input: uploads.get(path), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { exitCode: 0, output };
      }
      if (complete && script.startsWith('docker exec hassio_supervisor rm -f ')) return { exitCode: 0, output: '' };
      assert.fail('Unexpected remote command in deployment fixture');
    },
    async close() { events.push({ type: 'close' }); },
  };
  const supervisor = connected => {
    assert.equal(connected, ssh);
    return async (endpoint, method = 'get', timeoutSeconds = 30) => {
      events.push({ type: 'api', endpoint, method, timeoutSeconds });
      if (endpoint === '/addons') return { addons: [structuredClone(app)] };
      if (endpoint === '/addons/synthetic_st-mq/info') {
        appReads++;
        return {
          ...structuredClone(app),
          state: changedApp && appReads > 1 ? 'started' : 'stopped',
          ...(rebuilt && optionsAfterRebuild ? { options: structuredClone(optionsAfterRebuild) } : {}),
        };
      }
      if (endpoint === '/addons/synthetic_st-mq/rebuild') {
        assert.equal(method, 'post');
        assert.equal(timeoutSeconds, 900);
        if (lostRebuildResponse) throw new DeploymentTransportError('SSH connection lost; the submitted operation may still be running');
        if (complete) { rebuilt = true; return {}; }
      }
      assert.fail('Unexpected Supervisor request in deployment fixture');
    };
  };
  return {
    events, messages,
    deploy: () => main(['--connection', connectionPath], {
      checkout,
      connect: async config => { assert.equal(config.ssh_host, 'synthetic-ha'); events.push({ type: 'connect' }); return ssh; },
      supervisor,
      log: message => messages.push(message),
    }),
  };
}

function assertNoRebuild(events) {
  assert.equal(events.filter(event => event.type === 'api' && event.endpoint.endsWith('/rebuild')).length, 0);
}

function assertRetainedFailureState(events) {
  assert.equal(events.filter(event => event.type === 'close').length, 1, 'the SSH transport closes after failure');
  assert.ok(!events.some(event => event.type === 'ssh' && /\brmdir\b|\brm -rf\b/.test(event.script)), 'failure retains its lock and temporary files');
  assert.ok(!events.some(event => event.type === 'api' && /\/(start|restart|stop)$/.test(event.endpoint)), 'deployment never changes app runtime state');
}

test('an existing deployment lock prevents remote workspace creation, uploads and rebuild', async t => {
  const fixture = workflowFixture(t, { existingLock: true });
  await assert.rejects(fixture.deploy(), /deployment lock already exists/);
  const lockIndex = fixture.events.findIndex(event => event.type === 'ssh' && event.script.includes('if mkdir'));
  assert.notEqual(lockIndex, -1);
  assert.deepEqual(fixture.events.slice(lockIndex + 1).map(event => event.type), ['close']);
  assertNoRebuild(fixture.events);
  assertRetainedFailureState(fixture.events);
});

test('a corrupted uploaded bundle prevents source replacement and rebuild', async t => {
  const fixture = workflowFixture(t, { corruptBundle: true });
  await assert.rejects(fixture.deploy(), /checksum mismatch/);
  const bundleIndex = fixture.events.findIndex(event => event.type === 'ssh' && event.input !== undefined && /sha256sum '[^']+\.bundle'/.test(event.script));
  assert.notEqual(bundleIndex, -1, 'the committed update reached the streaming upload boundary');
  assert.deepEqual(fixture.events.slice(bundleIndex + 1).map(event => event.type), ['close']);
  assert.ok(!fixture.events.some(event => event.input?.toString().includes("git('fetch'")), 'unverified bytes never reach the source update');
  assertNoRebuild(fixture.events);
  assertRetainedFailureState(fixture.events);
});

test('an app started during deployment prevents Supervisor rebuild', async t => {
  const fixture = workflowFixture(t, { changedApp: true });
  await assert.rejects(fixture.deploy(), /changed during deployment: state \(expected stopped; observed started\)/);
  assert.equal(fixture.events.filter(event => event.type === 'api' && event.endpoint.endsWith('/info')).length, 2);
  assertNoRebuild(fixture.events);
  assertRetainedFailureState(fixture.events);
});

test('a lost rebuild response is never replayed and retains the deployment lock and files', async t => {
  const fixture = workflowFixture(t, { lostRebuildResponse: true });
  await assert.rejects(fixture.deploy(), /may still be running/);
  const rebuilds = fixture.events.filter(event => event.type === 'api' && event.endpoint.endsWith('/rebuild'));
  assert.equal(rebuilds.length, 1);
  const rebuildIndex = fixture.events.indexOf(rebuilds[0]);
  assert.deepEqual(fixture.events.slice(rebuildIndex + 1).map(event => event.type), ['close']);
  assert.equal(fixture.events.filter(event => event.type === 'connect').length, 1);
  assertRetainedFailureState(fixture.events);
});

test('successful deployment runs the emitted image verifier before final stopped readback and cleanup', async t => {
  const fixture = workflowFixture(t, { complete: true });
  await fixture.deploy();
  const verificationIndex = fixture.events.findIndex(event => event.type === 'ssh' && event.script.includes('docker run'));
  assert.notEqual(verificationIndex, -1);
  const finalEvents = fixture.events.slice(verificationIndex + 1);
  assert.equal(finalEvents[0].endpoint, '/addons/synthetic_st-mq/info');
  assert.match(finalEvents[1].script, /rmdir \/tmp\/home-energy-deploy-synthetic_st-mq\.lock/);
  assert.deepEqual(finalEvents.map(event => event.type), ['api', 'ssh', 'close']);
  assert.equal(fixture.events.filter(event => event.type === 'api' && event.endpoint.endsWith('/rebuild')).length, 1);
  assert.ok(!fixture.events.some(event => event.type === 'api' && /\/(start|restart|stop)$/.test(event.endpoint)));
  assert.match(fixture.messages.at(-1), /1 source files, 1 frontend files/);
  assert.match(fixture.messages.at(-1), /App remains stopped/);
});

test('Supervisor reordering saved options during rebuild still completes image verification and cleanup', async t => {
  const fixture = workflowFixture(t, { complete: true, optionsAfterRebuild: {
    charging: { schedule: [{ target: 80, start: '01:00' }, { target: null, start: '02:00' }], limit: 0 },
    enabled: false,
  } });
  await fixture.deploy();
  assert.equal(fixture.events.filter(event => event.type === 'api' && event.endpoint.endsWith('/rebuild')).length, 1);
  assert.ok(fixture.events.some(event => event.type === 'ssh' && event.script.includes('docker run')));
  assert.ok(fixture.events.some(event => event.type === 'ssh' && /rmdir \/tmp\/home-energy-deploy-synthetic_st-mq\.lock/.test(event.script)));
  assert.ok(!fixture.events.some(event => event.type === 'api' && /\/(start|restart|stop)$/.test(event.endpoint)));
  assert.match(fixture.messages.at(-1), /Stored files and configuration unchanged\. App remains stopped/);
});

test('a genuine saved-options change after rebuild retains the lock without runtime commands or retry', async t => {
  const fixture = workflowFixture(t, { complete: true, optionsAfterRebuild: {
    enabled: false,
    charging: { limit: 1, schedule: [{ start: '01:00', target: 80 }, { start: '02:00', target: null }] },
  } });
  await assert.rejects(fixture.deploy(), /changed during deployment: configuration.*Deployment stopped during verification/i);
  const rebuilds = fixture.events.filter(event => event.type === 'api' && event.endpoint.endsWith('/rebuild'));
  assert.equal(rebuilds.length, 1);
  const afterRebuild = fixture.events.slice(fixture.events.indexOf(rebuilds[0]) + 1);
  assert.deepEqual(afterRebuild.map(event => event.type), ['api', 'close']);
  assert.equal(afterRebuild[0].endpoint, '/addons/synthetic_st-mq/info');
  assert.equal(fixture.events.filter(event => event.type === 'connect').length, 1);
  assertRetainedFailureState(fixture.events);
});
