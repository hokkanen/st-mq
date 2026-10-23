import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/deploy-ha.js';
import { DeploymentSafetyError } from '../scripts/lib/paired-deployment.js';
import { DeploymentTransportError } from '../scripts/lib/ha-deploy-transport.js';

const version = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')).version;

function workflowFixture(t, { managed = false, snapshot, buildFailure = false, lostStopResponse = false, lostStartResponse = false, startFailure = false, stopFailure = false, stopStaysRunning = false, syncTimeoutSeconds, existingLock = false, corruptBundle = false, changedApp = false, optionsAfterRebuild,
  lostRebuildResponse = false, lostRefreshResponse = false, changedRepositories = false, stateError,
  wrongSchema = false, complete = false, initialState = managed ? 'started' : 'stopped', lostDiscoveryResponse = false,
  lostLockResponse = false, lockExitCode, containerStartsAtRead = Infinity, stoppedAfterRebuild = false,
  storedFileCheck, finalFileTimeout = false, sourceChangesAfterRebuild = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ha-deploy-workflow-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const checkout = join(directory, 'checkout');
  const privateDirectory = join(directory, 'private');
  mkdirSync(checkout);
  mkdirSync(join(checkout, 'src'));
  mkdirSync(privateDirectory, { mode: 0o700 });
  const connectionPath = join(privateDirectory, 'connection.json');
  writeFileSync(connectionPath, JSON.stringify({ ssh_host: 'synthetic-ha', ...(syncTimeoutSeconds ? { sync_timeout_seconds: syncTimeoutSeconds } : {}) }), { mode: 0o600 });
  writeFileSync(join(checkout, '.gitignore'), 'dist/\n');
  writeFileSync(join(checkout, 'config.json'), JSON.stringify({ version, options: {}, schema: {} }));
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({
    name: 'synthetic-deployment-fixture', version, private: true,
    scripts: { build: 'node build.cjs' },
  }));
  writeFileSync(join(checkout, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  writeFileSync(join(checkout, 'build.cjs'), "const fs = require('node:fs'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/index.html', '<!doctype html><title>Synthetic</title>');\n");
  writeFileSync(join(checkout, 'src/index.js'), 'export const synthetic = true;\n');
  if (buildFailure) writeFileSync(join(checkout, 'build.cjs'), 'process.exit(1);\n');
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Synthetic deployment test');
  git('config', 'user.email', 'synthetic@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  git('add', '.gitignore', 'config.json', 'package.json', 'package-lock.json', 'build.cjs', 'src/index.js');
  git('commit', '--quiet', '-m', 'Synthetic deployment baseline');
  const remoteHead = git('rev-parse', 'HEAD');
  if (corruptBundle || sourceChangesAfterRebuild) {
    writeFileSync(join(checkout, 'src/index.js'), 'export const synthetic = false;\n');
    git('add', 'src/index.js');
    git('commit', '--quiet', '-m', 'Synthetic deployment target');
  }

  const events = [];
  const messages = [];
  const uploads = new Map();
  const app = { slug: 'synthetic_st-mq', repository: 'synthetic', state: 'stopped', version, schema: [], options: {
    enabled: false,
    charging: { limit: 0, schedule: [{ start: '01:00', target: 80 }, { start: '02:00', target: null }] },
  } };
  let appReads = 0;
  let storeReads = 0;
  let rebuilt = false;
  let refreshed = false;
  let sourceMoved = false;
  let pythonCode = '';
  let containerReads = 0;
  let runtimeState = initialState, runtimeReads = 0, now = Date.now();
  const imageId = 'sha256:' + '1'.repeat(64);
  const ssh = {
    async run(script, { input, timeoutMs } = {}) {
      events.push({ type: 'ssh', script, input, timeoutMs });
      if (script.startsWith('docker container ls ')) {
        containerReads++;
        assert.match(script, /--all --filter 'name=\^\/\(app\|addon\)_synthetic_st-mq\$'/);
        return { exitCode: 0, output: containerReads >= containerStartsAtRead
          ? JSON.stringify({ Names: 'app_synthetic_st-mq', State: 'running' }) : '' };
      }
      if (script.includes('/data/addons/git') && script.includes("'rev-parse'")) {
        return { exitCode: 0, output: JSON.stringify({
          root: '/data/addons/git/synthetic', head: remoteHead,
          runtime: ['/data/addons/data/synthetic_st-mq', '/data/addon_configs/synthetic_st-mq'],
        }) };
      }
      if (script.includes('if mkdir') && script.includes('.lock')) {
        if (lostLockResponse) throw new DeploymentTransportError('SSH connection lost; the submitted operation may still be running');
        return { exitCode: lockExitCode ?? (existingLock ? 73 : 0), output: '' };
      }
      if (/^umask 077\nmkdir \/tmp\/st-mq-deploy-[a-f0-9]+$/.test(script)) return { exitCode: 0, output: '' };
      if (input !== undefined && script.includes('sha256sum')) {
        assert.ok(Buffer.isBuffer(input), 'upload streams bytes directly');
        const path = script.match(/sha256sum '([^']+)'/)[1];
        if (path.endsWith('.py')) execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "deployment-step", "exec")'], { input, stdio: ['pipe', 'pipe', 'pipe'] });
        uploads.set(path, input);
        const checksum = corruptBundle && path.endsWith('.bundle') ? '0'.repeat(64) : createHash('sha256').update(input).digest('hex');
        return { exitCode: 0, output: `${checksum}  ${path}\n` };
      }
      if (script.startsWith('docker cp ')) {
        const path = script.split(' ')[2];
        if (path.endsWith('.py')) pythonCode = uploads.get(path).toString();
        return { exitCode: 0, output: '' };
      }
      if (/^docker exec hassio_supervisor python3 /.test(script)) {
        if (pythonCode.includes('\n snapshot(FILE_HASSIO_APPS') || pythonCode.includes('\n verify(FILE_HASSIO_APPS')) {
          const readsFiles = pythonCode.includes('\n snapshot(FILE_HASSIO_APPS') || /^ verify\(FILE_HASSIO_APPS,.*check_files=True\)/m.test(pythonCode);
          if (readsFiles) {
            storedFileCheck?.(timeoutMs);
            if (finalFileTimeout && rebuilt) throw new DeploymentTransportError('SSH command timed out; the remote operation may still be running');
          } else assert.equal(timeoutMs, 30000, 'intermediate metadata checks retain their short deadline');
          if (rebuilt && readsFiles) assert.ok(!pythonCode.includes('from supervisor.apps.options import UiOptions'), 'final file check does not repeat unused schema presentation imports');
          const failed = stateError && (rebuilt || (refreshed && stateError === 'source'));
          return { exitCode: 0, output: JSON.stringify(sourceMoved ? { error: 'source' }
            : failed ? { error: stateError } : { ok: true, schema: [] }) };
        }
        return { exitCode: 0, output: '' };
      }
      if (complete && script.startsWith('docker image inspect ')) return { exitCode: 0, output: imageId };
      if (complete && script.includes("['docker','image','ls'")) return { exitCode: 0, output: JSON.stringify(`synthetic-st-mq:${version}`) };
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
    return async (endpoint, method = 'get', timeoutSeconds = 30, body) => {
      events.push({ type: 'api', endpoint, method, timeoutSeconds, body });
      if (endpoint === '/addons') {
        if (lostDiscoveryResponse) throw new DeploymentTransportError('SSH connection failed; the remote operation may still be running');
        return { addons: [structuredClone(app)] };
      }
      if (endpoint === '/addons/synthetic_st-mq/info') {
        appReads++;
        return {
          ...structuredClone(app),
          state: managed ? runtimeState : changedApp && appReads > 1 ? 'started' : rebuilt && stoppedAfterRebuild ? 'stopped' : initialState,
          ...(rebuilt && wrongSchema ? { schema: [{ name: 'unexpected' }] } : {}),
          ...(rebuilt && optionsAfterRebuild ? { options: structuredClone(optionsAfterRebuild) } : {}),
        };
      }
      if (endpoint === '/addons/synthetic_st-mq/stop') {
        assert.equal(method, 'post');
        if (lostStopResponse) throw new DeploymentTransportError('Stop response lost; outcome unconfirmed.');
        if (stopFailure) throw new DeploymentSafetyError('Supervisor refused Stop.');
        runtimeState = stopStaysRunning ? 'started' : 'stopped'; return {};
      }
      if (endpoint === '/addons/synthetic_st-mq/start') {
        assert.equal(method, 'post');
        if (lostStartResponse) throw new DeploymentTransportError('Start response lost; outcome unconfirmed.');
        if (startFailure) throw new DeploymentSafetyError('Supervisor refused Start.');
        runtimeState = 'started'; return {};
      }
      if (endpoint === '/store') {
        storeReads++;
        return { repositories: [
          { slug: 'core', source: 'core' }, { slug: 'local', source: 'local' },
          { slug: 'synthetic', source: 'https://example.invalid/synthetic' },
          ...(changedRepositories && storeReads > 1 ? [{ slug: 'added', source: 'https://example.invalid/added' }] : []),
        ] };
      }
      if (endpoint === '/supervisor/options') {
        assert.equal(method, 'post');
        assert.deepEqual(body, { addons_repositories: ['core', 'https://example.invalid/synthetic', 'local'] });
        if (lostRefreshResponse) throw new DeploymentTransportError('SSH connection lost; the submitted operation may still be running');
        refreshed = true;
        return {};
      }
      if (endpoint === '/addons/synthetic_st-mq/rebuild') {
        assert.equal(refreshed, true, 'metadata is refreshed before rebuilding');
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
    deploy: () => main([...(managed ? [] : ['--stopped']), '--connection', connectionPath], {
      clock: () => now, sleep: async () => { now += 1000; },
      readRuntime: async (_ssh, _app, options = {}) => {
        events.push({ type: 'runtime', options }); runtimeReads++;
        const value = { state: 'ready', observedAt: now, container: (rebuilt ? 'b' : 'a').repeat(64), image: imageId,
          pair: { role: 'slave', nodeId: 'synthetic-ha-node', pairId: 'synthetic-pair', canControl: false, busy: false, phase: null,
            vip: { owned: false }, peer: { nodeId: 'synthetic-master-node', role: 'master', reachable: true, lastSeenAt: now }, sync: { state: 'ready', error: null } } };
        const result = snapshot ? snapshot(value, runtimeReads, events) : value;
        if (result && (options.expectedImage && result.image !== options.expectedImage || options.expectedContainer && result.container !== options.expectedContainer)) throw new DeploymentSafetyError('The HA container or running image does not match the selected deployment.');
        return result;
      },
      checkout,
      connect: async config => { assert.equal(config.ssh_host, 'synthetic-ha'); events.push({ type: 'connect' }); return ssh; },
      supervisor,
      log: message => {
        messages.push(message);
        // The successful awaited response has already returned. An independent
        // repository refresh now changes source before installed verification.
        if (sourceChangesAfterRebuild && message.startsWith('Supervisor rebuild completed.')) {
          assert.equal(rebuilt, true);
          sourceMoved = true;
          events.push({ type: 'source-moved-after-rebuild-ack' });
        }
      },
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

for (const state of ['started', 'unknown', 'synthetic-private-state']) {
  test(`initial app state ${state} reports preflight refusal without implying deployment mutations`, async t => {
    const fixture = workflowFixture(t, { initialState: state });
    await assert.rejects(fixture.deploy(), error => {
      assert.match(error.message, /Stop the st-mq app in HA/);
      assert.match(error.message, /Deployment stopped during app preflight/);
      assert.match(error.message, /observed (started|unknown|unrecognized)/);
      assert.match(error.message, /No remote changes were attempted by this run/);
      assert.doesNotMatch(error.message, /SSH connection|may still be running|are retained|synthetic-private-state/);
      return true;
    });
    assert.deepEqual(fixture.events.map(event => event.type), ['connect', 'api', 'api', 'close']);
    assert.ok(fixture.events.filter(event => event.type === 'api').every(event => event.method === 'get'));
    assertNoRebuild(fixture.events);
  });
}

test('discovery transport failure still names SSH connection without implying deployment mutations', async t => {
  const fixture = workflowFixture(t, { lostDiscoveryResponse: true });
  await assert.rejects(fixture.deploy(), error => {
    assert.match(error.message, /Deployment stopped during SSH connection/);
    assert.match(error.message, /No remote changes were attempted by this run/);
    assert.doesNotMatch(error.message, /rebuild may still be running|are retained/);
    return true;
  });
  assert.deepEqual(fixture.events.map(event => event.type), ['connect', 'api', 'close']);
});

test('lost lock response retains possible remote changes without implying a rebuild was submitted', async t => {
  const fixture = workflowFixture(t, { lostLockResponse: true });
  await assert.rejects(fixture.deploy(), error => {
    assert.match(error.message, /Deployment stopped during remote lock/);
    assert.match(error.message, /no rebuild was submitted by this run/);
    assert.match(error.message, /files and lock are retained/);
    assert(error.message.includes(JSON.stringify('/tmp/st-mq-deploy-synthetic_st-mq.lock')));
    assert.match(error.message, /on HA in the SSH app/);
    assert.doesNotMatch(error.message, /No remote changes were attempted/);
    return true;
  });
  assertNoRebuild(fixture.events);
  assertRetainedFailureState(fixture.events);
});

for (const stoppedAfterRebuild of [false, true]) {
  test(`a stopped app reported as error completes deployment with fresh Docker checks (state clears: ${stoppedAfterRebuild})`, async t => {
    const fixture = workflowFixture(t, { initialState: 'error', complete: true, stoppedAfterRebuild });
    await fixture.deploy();
    const reads = fixture.events.filter(event => event.type === 'ssh' && event.script.startsWith('docker container ls '));
    assert.equal(reads.length, 5, 'each error-state observation requires new Docker evidence');
    assert.match(fixture.messages[0], /Supervisor reports error; Docker confirms the st-mq app is stopped/);
    assert.match(fixture.messages.at(-2), /App remains stopped/);
    assert.ok(!fixture.events.some(event => event.type === 'api' && /\/(start|restart|stop)$/.test(event.endpoint)));
  });
}

for (const containerStartsAtRead of [1, 2, 3, 4, 5]) {
  test(`a running container behind Supervisor error blocks deployment at check ${containerStartsAtRead}`, async t => {
    const fixture = workflowFixture(t, { initialState: 'error', complete: true, containerStartsAtRead });
    await assert.rejects(fixture.deploy(), /Docker could not confirm an absent or exited container/);
    const reads = fixture.events.filter(event => event.type === 'ssh' && event.script.startsWith('docker container ls '));
    assert.equal(reads.length, containerStartsAtRead);
    if (containerStartsAtRead <= 3) assertNoRebuild(fixture.events);
    assertRetainedFailureState(fixture.events);
  });
}

test('an existing deployment lock prevents remote workspace creation, uploads and rebuild', async t => {
  const fixture = workflowFixture(t, { existingLock: true });
  await assert.rejects(fixture.deploy(), error => /deployment lock already exists/.test(error.message)
    && error.message.includes(JSON.stringify('/tmp/st-mq-deploy-synthetic_st-mq.lock')));
  const lockIndex = fixture.events.findIndex(event => event.type === 'ssh' && event.script.includes('if mkdir'));
  assert.notEqual(lockIndex, -1);
  assert.deepEqual(fixture.events.slice(lockIndex + 1).map(event => event.type), ['close']);
  assertNoRebuild(fixture.events);
  assertRetainedFailureState(fixture.events);
});

test('remote lock creation failure names the SSH-app location without claiming an existing lock', async t => {
  const fixture = workflowFixture(t, { lockExitCode: 74 });
  await assert.rejects(fixture.deploy(), error => {
    assert.match(error.message, /Could not create the remote deployment lock/);
    assert(error.message.includes(JSON.stringify('/tmp/st-mq-deploy-synthetic_st-mq.lock')));
    assert.doesNotMatch(error.message, /lock already exists/); return true;
  });
  assertNoRebuild(fixture.events); assertRetainedFailureState(fixture.events);
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
  await assert.rejects(fixture.deploy(), error => {
    assert.match(error.message, /the submitted rebuild may still be running/);
    assert.doesNotMatch(error.message, /no rebuild was submitted|No remote changes were attempted/);
    return true;
  });
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
  assert.match(finalEvents.at(-2).script, /rmdir \/tmp\/st-mq-deploy-synthetic_st-mq\.lock/);
  assert.equal(finalEvents.at(-3).endpoint, '/store');
  assert.equal(finalEvents.at(-1).type, 'close');
  assert.equal(fixture.events.filter(event => event.type === 'api' && event.endpoint.endsWith('/rebuild')).length, 1);
  assert.ok(!fixture.events.some(event => event.type === 'api' && /\/(start|restart|stop)$/.test(event.endpoint)));
  assert.match(fixture.messages.at(-2), /1 source files, 1 frontend files/);
  assert.match(fixture.messages.at(-2), /App remains stopped/);
});

test('slow metadata inventories get a bounded deadline and progress, with no lingering heartbeat', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let fileChecks = 0;
  const fixture = workflowFixture(t, { complete: true, storedFileCheck: timeoutMs => {
    fileChecks++;
    assert.ok(timeoutMs > 45000 && timeoutMs <= 15 * 60 * 1000, 'allow a realistic slow scan without an unlimited wait');
    t.mock.timers.tick(45000);
  } });
  await fixture.deploy();
  assert.equal(fileChecks, 2, 'both snapshot and final comparison inventory stored-file metadata');
  assert.ok(fixture.messages.includes('Stored-file snapshot is still running…'));
  assert.ok(fixture.messages.includes('Stored-file verification is still running…'));
  assert.ok(fixture.messages.includes('Supervisor rebuild completed. Verifying the image and preserved settings…'));
  const count = fixture.messages.length;
  t.mock.timers.tick(60000);
  assert.equal(fixture.messages.length, count, 'completed checks clear their progress timers');
});

test('final stored-file timeout names the step, preserves the lock and distinguishes completed rebuild', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fixture = workflowFixture(t, { complete: true, finalFileTimeout: true });
  await assert.rejects(fixture.deploy(), error => {
    assert.match(error.message, /Deployment stopped during verification: stored files and saved settings/);
    assert.match(error.message, /Supervisor confirmed rebuild completion/);
    assert.doesNotMatch(error.message, /submitted rebuild may still be running/);
    return true;
  });
  const rebuilds = fixture.events.filter(event => event.type === 'api' && event.endpoint.endsWith('/rebuild'));
  assert.equal(rebuilds.length, 1, 'a verification failure never submits another rebuild');
  assertRetainedFailureState(fixture.events);
  const count = fixture.messages.length;
  t.mock.timers.tick(60000);
  assert.equal(fixture.messages.length, count, 'failed checks clear their progress timers');
});

test('Supervisor reordering saved options during rebuild still completes image verification and cleanup', async t => {
  const fixture = workflowFixture(t, { complete: true, optionsAfterRebuild: {
    charging: { schedule: [{ target: 80, start: '01:00' }, { target: null, start: '02:00' }], limit: 0 },
    enabled: false,
  } });
  await fixture.deploy();
  assert.equal(fixture.events.filter(event => event.type === 'api' && event.endpoint.endsWith('/rebuild')).length, 1);
  assert.ok(fixture.events.some(event => event.type === 'ssh' && event.script.includes('docker run')));
  assert.ok(fixture.events.some(event => event.type === 'ssh' && /rmdir \/tmp\/st-mq-deploy-synthetic_st-mq\.lock/.test(event.script)));
  assert.ok(!fixture.events.some(event => event.type === 'api' && /\/(start|restart|stop)$/.test(event.endpoint)));
  assert.match(fixture.messages.at(-2), /Stored-file metadata and saved settings unchanged through the stopped deployment window\. App remains stopped/);
});

test('a genuine saved-options change after rebuild retains the lock without runtime commands or retry', async t => {
  const fixture = workflowFixture(t, { complete: true, stateError: 'saved-settings', optionsAfterRebuild: {
    enabled: false,
    charging: { limit: 1, schedule: [{ start: '01:00', target: 80 }, { start: '02:00', target: null }] },
  } });
  await assert.rejects(fixture.deploy(), /Saved installation settings changed during deployment.*Deployment stopped during verification/i);
  const rebuilds = fixture.events.filter(event => event.type === 'api' && event.endpoint.endsWith('/rebuild'));
  assert.equal(rebuilds.length, 1);
  const afterRebuild = fixture.events.slice(fixture.events.indexOf(rebuilds[0]) + 1);
  assert.equal(afterRebuild[0].endpoint, '/addons/synthetic_st-mq/info');
  assert.equal(fixture.events.filter(event => event.type === 'connect').length, 1);
  assertRetainedFailureState(fixture.events);
});

test('new and changed effective defaults do not masquerade as saved-settings changes', async t => {
  const fixture = workflowFixture(t, { complete: true, optionsAfterRebuild: { newDefault: 2, enabled: true } });
  await fixture.deploy();
  assert.match(fixture.messages.at(-2), /Supervisor schema and defaults match/);
  assert.match(fixture.messages.at(-1), /Incompatible saved fields require configuration recovery/);
  const calls = fixture.events.filter(event => event.type === 'api' && event.method === 'post');
  assert.deepEqual(calls.map(call => call.endpoint), ['/supervisor/options', '/addons/synthetic_st-mq/rebuild']);
  assert.ok(!fixture.events.some(event => /\/store\/reload|\/addons\/reload/.test(event.endpoint ?? '')));
});

test('repository changes abort before applying the saved repository list', async t => {
  const fixture = workflowFixture(t, { changedRepositories: true });
  await assert.rejects(fixture.deploy(), /repositories changed during deployment/);
  assert.ok(!fixture.events.some(event => event.type === 'api' && event.method === 'post'));
  assertNoRebuild(fixture.events);
  assertRetainedFailureState(fixture.events);
});

test('lost metadata refresh response is never replayed and prevents rebuilding', async t => {
  const fixture = workflowFixture(t, { lostRefreshResponse: true });
  await assert.rejects(fixture.deploy(), /may still be running.*Supervisor metadata refresh/);
  const calls = fixture.events.filter(event => event.endpoint === '/supervisor/options');
  assert.equal(calls.length, 1);
  assert.deepEqual(fixture.events.slice(fixture.events.indexOf(calls[0]) + 1).map(event => event.type), ['close']);
  assertNoRebuild(fixture.events);
  assertRetainedFailureState(fixture.events);
});

test('source movement during metadata refresh prevents rebuilding a different commit', async t => {
  const fixture = workflowFixture(t, { stateError: 'source' });
  await assert.rejects(fixture.deploy(), /Remote source no longer matches the selected commit/);
  assertNoRebuild(fixture.events);
  assertRetainedFailureState(fixture.events);
});

test('source movement after acknowledged rebuild retains evidence and refuses installed verification', async t => {
  const fixture = workflowFixture(t, { complete: true, sourceChangesAfterRebuild: true });
  await assert.rejects(fixture.deploy(), error => {
    assert.match(error.message, /Remote source no longer matches the selected commit/);
    assert.match(error.message, /Deployment stopped during verification: installed metadata/);
    assert.match(error.message, /Supervisor confirmed rebuild completion/);
    assert.doesNotMatch(error.message, /submitted rebuild may still be running/);
    return true;
  });
  const rebuilds = fixture.events.filter(event => event.type === 'api' && event.endpoint.endsWith('/rebuild'));
  assert.equal(rebuilds.length, 1, 'the pre-rebuild source checks succeeded and the acknowledged rebuild is not repeated');
  const movement = fixture.events.findIndex(event => event.type === 'source-moved-after-rebuild-ack');
  assert(movement > fixture.events.indexOf(rebuilds[0]));
  assert(fixture.messages.some(message => message.startsWith('Supervisor rebuild completed.')));
  assert(!fixture.messages.some(message => message.startsWith('Verified ')));
  assert(fixture.events.some(event => event.type === 'ssh' && Buffer.isBuffer(event.input)
    && event.script.includes('.bundle')), 'the committed target bundle was transferred before the independent source change');
  assertRetainedFailureState(fixture.events);
});

for (const stateError of ['schema', 'defaults', 'files', 'version']) {
  test(`a failed ${stateError} check after rebuild cannot report success or clean up`, async t => {
    const fixture = workflowFixture(t, { complete: true, stateError });
    await assert.rejects(fixture.deploy(), /Deployment stopped during verification/);
    assert.ok(!fixture.messages.some(message => message.startsWith('Verified ')));
    assertRetainedFailureState(fixture.events);
  });
}

test('the installed schema must also match through the running Supervisor API', async t => {
  const fixture = workflowFixture(t, { complete: true, wrongSchema: true });
  await assert.rejects(fixture.deploy(), /installed schema does not match/);
  assertRetainedFailureState(fixture.events);
});

test('managed HA deployment stops a verified slave, brackets preservation checks and restarts before cleanup', async t => {
  const f = workflowFixture(t, { managed: true, complete: true }); await f.deploy();
  const index = suffix => f.events.findIndex(e => e.type === 'api' && e.endpoint.endsWith(suffix));
  const stop = index('/stop'), rebuild = index('/rebuild'), start = index('/start');
  const snapshot = f.events.findIndex(e => e.type === 'ssh' && e.input?.toString().includes('\n snapshot(FILE_HASSIO_APPS'));
  const verification = f.events.findLastIndex(e => e.type === 'ssh' && /^ verify\(FILE_HASSIO_APPS,.*check_files=True\)/m.test(e.input?.toString() ?? ''));
  const cleanup = f.events.findIndex(e => e.type === 'ssh' && e.script.includes('rmdir /tmp/st-mq-deploy'));
  assert(stop > 0 && stop < snapshot && snapshot < rebuild && rebuild < verification && verification < start && start < cleanup);
  assert.equal(f.events.filter(e => e.endpoint?.endsWith('/stop')).length, 1);
  assert.equal(f.events.filter(e => e.endpoint?.endsWith('/start')).length, 1);
  assert.match(f.messages.at(-1), /Same paired slave running.*synchronization ready/);
  assert(!f.events.some(e => e.endpoint?.includes('/pair/action')));
});

for (const patch of [{ role: 'master', canControl: true }, { busy: true }, { vip: { owned: true } }]) {
  test(`managed HA preflight refuses unsafe authority ${Object.keys(patch).join(',')}`, async t => {
    const f = workflowFixture(t, { managed: true, snapshot: s => ({ ...s, pair: { ...s.pair, ...patch } }) });
    await assert.rejects(f.deploy(), /slave/);
    assert(!f.events.some(e => e.method === 'post')); assertNoRebuild(f.events);
  });
}

test('managed HA refuses an already stopped app unless --stopped was selected', async t => {
  const f = workflowFixture(t, { managed: true, initialState: 'stopped' });
  await assert.rejects(f.deploy(), /requires a running paired slave/);
  assert(!f.events.some(e => e.type === 'runtime' || e.method === 'post'));
});

test('managed preparation failure leaves HA running and sends no lifecycle commands', async t => {
  const f = workflowFixture(t, { managed: true, complete: true, buildFailure: true });
  await assert.rejects(f.deploy(), /local build/);
  assert(!f.events.some(e => e.method === 'post'));
});

test('managed HA checks role again immediately before Stop', async t => {
  const f = workflowFixture(t, { managed: true, complete: true,
    snapshot: (s, reads) => reads === 2 ? { ...s, pair: { ...s.pair, role: 'master', canControl: true } } : s });
  await assert.rejects(f.deploy(), /slave/); assertRetainedFailureState(f.events);
});

test('managed HA bounds stop confirmation and never edits source or repeats Stop while the app remains running', async t => {
  const f = workflowFixture(t, { managed: true, complete: true, stopStaysRunning: true });
  await assert.rejects(f.deploy(), /did not confirm the app stopped/);
  assert.equal(f.events.filter(e => e.endpoint?.endsWith('/stop')).length, 1);
  assertNoRebuild(f.events);
  assert(!f.events.some(e => e.input?.toString().includes('\n snapshot(FILE_HASSIO_APPS')));
});

for (const options of [{ lostStopResponse: true }, { stopFailure: true }]) {
  test(`managed HA does not replay an uncertain or refused Stop ${Object.keys(options)[0]}`, async t => {
    const f = workflowFixture(t, { managed: true, complete: true, ...options });
    await assert.rejects(f.deploy(), /during stop.*Stop requested; outcome unconfirmed/);
    assert.equal(f.events.filter(e => e.endpoint?.endsWith('/stop')).length, 1);
    assert(!f.events.some(e => e.endpoint?.endsWith('/start'))); assertNoRebuild(f.events);
  });
}

test('managed verification failure retains the stopped app and never starts an unverified image', async t => {
  const f = workflowFixture(t, { managed: true, complete: true, stateError: 'files' });
  await assert.rejects(f.deploy(), /Stored-file metadata changed.*App confirmed stopped/);
  assert(f.events.some(e => e.endpoint?.endsWith('/stop')));
  assert(!f.events.some(e => e.endpoint?.endsWith('/start')));
});

for (const options of [{ lostStartResponse: true }, { startFailure: true }]) {
  test(`managed HA does not replay an uncertain or refused Start ${Object.keys(options)[0]}`, async t => {
    const f = workflowFixture(t, { managed: true, complete: true, ...options });
    await assert.rejects(f.deploy(), /during start.*Start requested; outcome unconfirmed/);
    assert.equal(f.events.filter(e => e.endpoint?.endsWith('/start')).length, 1);
    assert(!f.messages.some(s => s.startsWith('Verified '))); assert.equal(f.events.at(-1).type, 'close');
  });
}

test('managed HA rejects a wrong running image after Start', async t => {
  const f = workflowFixture(t, { managed: true, complete: true,
    snapshot: (s, reads) => reads > 2 ? { ...s, image: 'sha256:' + '2'.repeat(64) } : s });
  await assert.rejects(f.deploy(), /running image/); assert(!f.messages.some(s => s.startsWith('Verified ')));
});

test('managed HA cannot report success if synchronization regresses during final runtime verification', async t => {
  const f = workflowFixture(t, { managed: true, complete: true,
    snapshot: (s, reads) => reads === 4 ? { ...s, pair: { ...s.pair, sync: { state: 'syncing' } } } : s });
  await assert.rejects(f.deploy(), /has not completed synchronization/);
  assert(!f.messages.some(s => s.startsWith('Verified ')));
  assert(!f.events.some(e => e.type === 'ssh' && e.script.includes('rmdir /tmp/st-mq-deploy')));
});

test('managed HA rejects a different node after Start', async t => {
  const f = workflowFixture(t, { managed: true, complete: true,
    snapshot: (s, reads) => reads > 2 ? { ...s, pair: { ...s.pair, nodeId: 'synthetic-other-node' } } : s });
  await assert.rejects(f.deploy(), /identity/);
});

test('managed HA waits through ordinary startup without applying the remote clock to its local deadline', async t => {
  const f = workflowFixture(t, { managed: true, complete: true, snapshot: (s, reads) => {
    if (reads === 3) return null;
    return { ...s, observedAt: s.observedAt + 3600000, pair: { ...s.pair, peer: { ...s.pair.peer, lastSeenAt: s.observedAt + 3600000 } } };
  } });
  await f.deploy(); assert.match(f.messages.at(-1), /synchronization ready/);
});

test('managed HA synchronization timeout leaves the started app for inspection without cleanup or promotion', async t => {
  const f = workflowFixture(t, { managed: true, complete: true, syncTimeoutSeconds: 2,
    snapshot: (s, reads) => reads > 2 ? { ...s, pair: { ...s.pair, sync: { state: 'syncing', error: null } } } : s });
  await assert.rejects(f.deploy(), /Synchronization timed out/);
  assert.equal(f.events.filter(e => e.endpoint?.endsWith('/start')).length, 1);
  assert(!f.events.some(e => e.type === 'ssh' && e.script.includes('rmdir /tmp/st-mq-deploy')));
});
