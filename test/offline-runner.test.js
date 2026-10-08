import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const execute = promisify(execFile);
const runner = new URL('../scripts/test-offline.js', import.meta.url).href;
async function fixture(t, files) {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-offline-runner-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const paths = [];
  for (const [name, content] of Object.entries(files)) {
    const path = join(directory, `${name}.mjs`);
    await writeFile(path, content); paths.push(path);
  }
  return { directory, paths };
}
const command = options => ['--input-type=module', '-e',
  `import {runOfflineTests} from ${JSON.stringify(runner)}; process.exitCode = await runOfflineTests(${JSON.stringify(options)});`];

test('offline runner gives each case its timeout and each file its own process', async t => {
  const f = await fixture(t, {
    first: `import test from 'node:test'; globalThis.syntheticTestFileState = true;
      test('first bounded case', async () => { await new Promise(resolve => setTimeout(resolve, 75)); });
      test('second bounded case', async () => { await new Promise(resolve => setTimeout(resolve, 75)); });`,
    second: `import test from 'node:test'; import assert from 'node:assert/strict';
      test('independent file state', () => { assert.equal(globalThis.syntheticTestFileState, undefined); });`,
  });
  const output = await execute(process.execPath, command({ files: f.paths, timeout: 100, concurrency: 2 }), { timeout: 10000 });
  assert.match(output.stdout, /second bounded case/);
  assert.match(output.stdout, /independent file state/);
});

test('offline runner fails an over-budget case and still runs remaining files', async t => {
  const f = await fixture(t, {
    slow: `import test from 'node:test'; test('over-budget synthetic case', async () => {
      await new Promise(resolve => setTimeout(resolve, 100)); });`,
    next: `import test from 'node:test'; test('remaining file ran', () => {});`,
  });
  await assert.rejects(execute(process.execPath, command({ files: f.paths, timeout: 20, concurrency: 1 }), { timeout: 10000 }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /timed out after 20ms/);
    assert.match(error.stdout, /remaining file ran/);
    return true;
  });
});

test('offline runner preserves synthetic signals owned by the test application', async t => {
  const f = await fixture(t, {
    signals: `import test from 'node:test'; import assert from 'node:assert/strict';
      test('application signal ownership', () => { let calls=0;
        const listener=()=>{calls++;}; process.on('SIGTERM',listener);
        try { process.emit('SIGTERM'); assert.equal(calls,1); }
        finally { process.removeListener('SIGTERM',listener); }
      });
      test('continued after synthetic signal', () => {});`,
  });
  const output = await execute(process.execPath, command({ files: f.paths, timeout: 1000 }), { timeout: 10000 });
  assert.match(output.stdout, /application signal ownership/);
  assert.match(output.stdout, /continued after synthetic signal/);
});

test('offline runner preserves name filters, skip filters and the selected reporter', async t => {
  const f = await fixture(t, {
    filtered: `import test from 'node:test';
      test('included synthetic case', () => {});
      test('skipped synthetic case', () => { throw Error('skip filter ignored'); });
      test('unmatched synthetic case', () => { throw Error('name filter ignored'); });`,
  });
  const output = await execute(process.execPath, command({ files: f.paths, timeout: 1000,
    args: ['--test-name-pattern=included|skipped', '--test-skip-pattern=skipped', '--test-reporter=tap'] }), { timeout: 10000 });
  assert.match(output.stdout, /TAP version 13/);
  assert.match(output.stdout, /included synthetic case/);
});

test('offline runner termination also stops its active test process', async t => {
  const f = await fixture(t, {}), marker = join(f.directory, 'child.pid'), path = join(f.directory, 'waiting.mjs');
  await writeFile(path, `import test from 'node:test'; import {writeFileSync} from 'node:fs';
    test('waiting synthetic case', async t => { const timer=setInterval(()=>{},1000); t.after(()=>clearInterval(timer));
      writeFileSync(${JSON.stringify(marker)}, String(process.pid)); await new Promise(()=>{}); });`);
  const child = spawn(process.execPath, command({ files: [path], timeout: 60000 }), { stdio: 'ignore' });
  const closed = once(child, 'close');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let pid;
  for (let i = 0; i < 500; i++) {
    pid = await readFile(marker, 'utf8').then(Number, () => null);
    if (pid) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert(pid, 'the runner started a real child test process');
  child.kill('SIGTERM');
  const [code] = await closed;
  assert.equal(code, 143);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('offline runner escalates termination when a blocked test cannot handle SIGTERM', async t => {
  const f = await fixture(t, {}), marker = join(f.directory, 'blocked.pid'), path = join(f.directory, 'blocked.mjs');
  await writeFile(path, `import test from 'node:test'; import {writeFileSync} from 'node:fs';
    test('blocked synthetic case', () => { process.on('SIGTERM',()=>{});
      writeFileSync(${JSON.stringify(marker)}, String(process.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); });`);
  const child = spawn(process.execPath, command({ files: [path], timeout: 100 }), { stdio: 'ignore' });
  const closed = once(child, 'close');
  let pid, timer;
  t.after(() => {
    clearTimeout(timer);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  for (let i = 0; i < 500; i++) {
    pid = await readFile(marker, 'utf8').then(Number, () => null);
    if (pid) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert(pid, 'the test child reached its blocking operation');
  child.kill('SIGTERM');
  const [code] = await Promise.race([closed, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Runner did not reap its blocked test child')), 5000);
  })]);
  clearTimeout(timer);
  assert.equal(code, 143);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  pid = null;
});
