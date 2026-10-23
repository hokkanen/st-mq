import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, renameSync, symlinkSync, lstatSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireDeploymentLock, deploymentLockPath, ownsDeploymentLock, releaseDeploymentLock,
  acquireRemoteDeploymentLock, remoteDeploymentLockPath } from '../scripts/lib/deployment-lock.js';
import { DeploymentSafetyError } from '../scripts/lib/paired-deployment.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'deployment-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('existing Linux lock names its canonical location through a runtime alias without removing it', t => {
  const root = fixture(t), runtime = join(root, 'runtime with spaces'), alias = join(root, 'alias');
  mkdirSync(runtime); symlinkSync(runtime, alias);
  const owner = acquireDeploymentLock(alias), path = join(runtime, 'deployment.lock'), before = lstatSync(path);
  assert.equal(deploymentLockPath(owner), path);
  assert.throws(() => acquireDeploymentLock(alias), error => {
    assert(error instanceof DeploymentSafetyError);
    assert.match(error.message, /lock exists/); assert(error.message.includes(JSON.stringify(path)));
    assert.match(error.message, /previous operation.*only that empty lock directory/); return true;
  });
  assert.equal(lstatSync(path).ino, before.ino); assert.deepEqual(readdirSync(path), []);
  assert.equal(ownsDeploymentLock(owner, alias), true); releaseDeploymentLock(owner, alias);
});

test('Linux lock creation and runtime preparation failures name the location without claiming a lock exists', t => {
  const root = fixture(t), parent = join(root, 'file'); writeFileSync(parent, 'synthetic private error context');
  const runtime = join(parent, 'runtime');
  assert.throws(() => acquireDeploymentLock(runtime), error => {
    assert(error.message.includes(JSON.stringify(join(runtime, 'deployment.lock'))));
    assert.match(error.message, /Could not prepare/); assert.doesNotMatch(error.message, /lock exists|synthetic private/); return true;
  });
  if (process.getuid?.() !== 0) {
    const denied = join(root, 'denied'); mkdirSync(denied, { mode: 0o500 });
    try {
      assert.throws(() => acquireDeploymentLock(denied), error => {
        assert(error.message.includes(JSON.stringify(join(denied, 'deployment.lock'))));
        assert.match(error.message, /Could not create/); assert.doesNotMatch(error.message, /lock exists/); return true;
      });
    } finally { chmodSync(denied, 0o700); }
  }
});

test('lost Linux lock ownership and nonempty cleanup failures name the retained directory and never remove another lock', t => {
  const root = fixture(t), runtime = join(root, 'runtime'), owner = acquireDeploymentLock(runtime);
  const path = deploymentLockPath(owner), previous = join(runtime, 'original-lock');
  renameSync(path, previous); mkdirSync(path);
  assert.equal(ownsDeploymentLock(owner, runtime), false);
  assert.throws(() => releaseDeploymentLock(owner, runtime), error => error.message.includes(JSON.stringify(path)) && /ownership could not be confirmed/.test(error.message));
  assert(lstatSync(path).isDirectory()); assert(lstatSync(previous).isDirectory());
  const second = acquireDeploymentLock(join(root, 'second')), secondPath = deploymentLockPath(second);
  writeFileSync(join(secondPath, 'retained'), 'synthetic preserved');
  assert.throws(() => releaseDeploymentLock(second, join(root, 'second')), error => error.message.includes(JSON.stringify(secondPath)) && /Could not remove/.test(error.message));
  assert.equal(readFileSync(join(secondPath, 'retained'), 'utf8'), 'synthetic preserved');
});

test('lock paths are quoted so unusual directory characters cannot forge diagnostic lines', t => {
  const runtime = join(fixture(t), 'runtime\nwith "quotes"'), owner = acquireDeploymentLock(runtime);
  assert.throws(() => acquireDeploymentLock(runtime), error => {
    assert(error.message.includes(JSON.stringify(deploymentLockPath(owner)))); assert(!error.message.includes('\n')); return true;
  });
  releaseDeploymentLock(owner, runtime);
});

test('HA setup and deployment share exact SSH-app lock paths and distinguish existence from creation failures', async () => {
  for (const exitCode of [0, 73, 74]) {
    const calls = [], ssh = { run: async script => { calls.push(script); return { exitCode }; } };
    const path = remoteDeploymentLockPath('synthetic_st-mq');
    if (exitCode === 0) assert.equal(await acquireRemoteDeploymentLock(ssh, 'synthetic_st-mq'), path);
    else await assert.rejects(acquireRemoteDeploymentLock(ssh, 'synthetic_st-mq'), error => {
      assert(error.message.includes(JSON.stringify(path))); assert.match(error.message, /on HA in the SSH app/);
      assert.match(error.message, exitCode === 73 ? /lock already exists/ : /Could not create/); return true;
    });
    assert.equal(calls.length, 1); assert(calls[0].includes(`test -L ${path}`)); assert(!calls[0].includes('rmdir'));
  }
  assert.throws(() => remoteDeploymentLockPath('invalid;private-value'), /Invalid HA app identity/);
});

test('an occupied live-test lock names its file without starting any provider worker or changing the lock', t => {
  const root = fixture(t), path = join(root, 'run.lock');
  for (const contents of [JSON.stringify({ pid: process.pid }), 'synthetic private malformed lock']) {
    writeFileSync(path, contents);
    const result = spawnSync(process.execPath, ['scripts/test-live.js'], {
      cwd: new URL('../', import.meta.url), env: { ...process.env, STMQ_LIVE_DATA_DIR: root }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 1); assert(result.stderr.includes(JSON.stringify(path)));
    assert.match(result.stderr, /needs inspection/); assert.doesNotMatch(result.stderr, /synthetic private/);
    assert.equal(readFileSync(path, 'utf8'), contents); assert.deepEqual(readdirSync(root), ['run.lock']);
  }
});
