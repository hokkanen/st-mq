import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, symlink, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { atomicJson, lockDirectory } from '../src/https/storage.js';

async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'stmq-https-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function childOwner(t, directory) {
  const module = new URL('../src/https/storage.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { lockDirectory } from ${JSON.stringify(module)};
    const release = await lockDirectory(process.argv[1]);
    process.stdout.write('locked\\n');
    process.stdin.resume();
    process.stdin.once('end', async () => { await release(); });
  `, directory], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  let error = '';
  child.stderr.on('data', bytes => { error += bytes; });
  const ready = await Promise.race([
    once(child.stdout, 'data', { signal: t.signal }).then(([bytes]) => bytes.toString()),
    exited.then(() => { throw new Error(`Lock owner exited before readiness: ${error}`); }),
  ]);
  assert.equal(ready, 'locked\n');
  return { child, exited };
}

test('concurrent managers have exactly one owner and leave no filesystem claims', async t => {
  const directory = await fixture(t);
  const outcomes = await Promise.allSettled(Array.from({ length: 50 }, () => lockDirectory(directory)));
  const accepted = outcomes.filter(outcome => outcome.status === 'fulfilled');
  assert.equal(accepted.length, 1);
  t.after(accepted[0].value);
  for (const outcome of outcomes.filter(outcome => outcome.status === 'rejected'))
    assert.equal(outcome.reason.code, 'https_manager_already_running');
  assert.deepEqual(await readdir(directory), []);
  await accepted[0].value();
  await accepted[0].value();
  for (let restart = 0; restart < 10; restart++) {
    const release = await lockDirectory(directory);
    await assert.rejects(lockDirectory(directory), { code: 'https_manager_already_running' });
    await release();
  }
  assert.deepEqual(await readdir(directory), []);
});

test('a different process and a symlink alias cannot acquire a running manager’s directory', { timeout: 15000 }, async t => {
  const parent = await fixture(t);
  const directory = resolve(parent, 'https'); await mkdir(directory, { mode: 0o700 });
  const alias = resolve(parent, 'alias'); await symlink(directory, alias);
  const { child, exited } = await childOwner(t, directory);
  await assert.rejects(lockDirectory(directory), { code: 'https_manager_already_running' });
  await assert.rejects(lockDirectory(alias), { code: 'https_manager_already_running' });
  child.stdin.end();
  const [code, signal] = await exited;
  assert.equal(code, 0); assert.equal(signal, null);
  const release = await lockDirectory(alias); t.after(release);
  assert.deepEqual(await readdir(directory), []);
});

test('independent installation directories have independent ownership', async t => {
  const first = await fixture(t), second = await fixture(t);
  const releaseFirst = await lockDirectory(first); t.after(releaseFirst);
  const releaseSecond = await lockDirectory(second); t.after(releaseSecond);
  await releaseFirst();
  await assert.rejects(lockDirectory(second), { code: 'https_manager_already_running' });
  const reacquired = await lockDirectory(first); t.after(reacquired);
  await assert.rejects(lockDirectory(first), { code: 'https_manager_already_running' });
});

test('repeated abrupt process death releases ownership without any stale-lock repair', { timeout: 15000 }, async t => {
  const directory = await fixture(t);
  await atomicJson(resolve(directory, 'state.json'), { fixture: 'saved-certificate-and-identity-reference' });
  const original = await readFile(resolve(directory, 'state.json'), 'utf8');
  for (let crash = 0; crash < 5; crash++) {
    const { child, exited } = await childOwner(t, directory);
    await assert.rejects(lockDirectory(directory), { code: 'https_manager_already_running' });
    child.kill('SIGKILL');
    const [code, signal] = await exited;
    assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    const release = await lockDirectory(directory); await release();
    assert.deepEqual(await readdir(directory), ['state.json']);
    assert.equal(await readFile(resolve(directory, 'state.json'), 'utf8'), original);
  }
});

for (const artifact of ['manager.lock', 'manager.claim']) test(`retired ${artifact} is rejected untouched rather than decoded or automatically reset`, async t => {
  const directory = await fixture(t);
  const path = resolve(directory, artifact);
  if (artifact === 'manager.claim') await mkdir(path, { mode: 0o700 });
  const owner = artifact === 'manager.claim' ? resolve(path, 'owner.json') : path;
  await atomicJson(owner, { version: 1, pid: process.pid, nonce: 'unsupported-pid-only-ownership' });
  const original = await readFile(owner, 'utf8');
  await assert.rejects(lockDirectory(directory), { code: 'https_lock_recovery_required' });
  assert.deepEqual(await readdir(directory), [artifact]);
  assert.equal(await readFile(owner, 'utf8'), original);
});
