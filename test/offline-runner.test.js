import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { offlineTestProfile, testLatencyLimit, testCompletionLimit } from '../scripts/lib/offline-test-profile.js';

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

test('HA SD qualification selects explicit completion budgets and rejects unknown profiles', () => {
  assert.deepEqual(offlineTestProfile('standard'), { name: 'standard', concurrency: 4,
    caseTimeoutMs: 60_000, extendedCaseTimeoutMs: 180_000 });
  assert.deepEqual(offlineTestProfile('ha-sd'), { name: 'ha-sd', concurrency: 2,
    caseTimeoutMs: 180_000, extendedCaseTimeoutMs: 900_000 });
  assert.throws(() => offlineTestProfile('invented'), /Unknown offline test profile/);
  assert.equal(testLatencyLimit(1500, 'standard'), 1500);
  assert.equal(testLatencyLimit(1500, 'ha-sd'), 30_000);
  assert.equal(testCompletionLimit(60_000, 'standard'), 60_000);
  assert.equal(testCompletionLimit(60_000, 'ha-sd'), 300_000);
});

test('qualification receipts retain failed cases, cancellation relationships and remaining files', async t => {
  const f = await fixture(t, {
    failed: `import test from 'node:test'; test('synthetic parent', async t => {
      await t.test('synthetic child failure', () => { throw Error('synthetic failure evidence'); }); });
      test('synthetic cancelling parent', async t => {
        void t.test('synthetic cancelled child', () => new Promise(()=>{}));
        throw Error('synthetic parent failure'); });`,
    passed: `import test from 'node:test'; import assert from 'node:assert/strict';
      test('synthetic architecture case', () => { assert.equal(process.env.STMQ_TEST_PROFILE, 'ha-sd'); });
      test('synthetic optional prerequisite', { skip: 'synthetic missing prerequisite' }, () => {});`,
  });
  const report = join(f.directory, 'receipt.jsonl');
  await assert.rejects(execute(process.execPath, command({ files: f.paths, profile: 'ha-sd', report, concurrency: 1 }),
    { timeout: 10000 }), { code: 1 });
  const rows = (await readFile(report, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  assert.equal(rows[0].event, 'suite-start');
  assert.equal(rows[0].profile, 'ha-sd'); assert.equal(rows[0].architecture, process.arch);
  assert.equal(rows[0].node, process.version); assert.equal(rows[0].timeoutMs, 180_000);
  assert.match(rows[0].sourceDigest, /^[a-f0-9]{64}$/);
  const failed = rows.filter(row => row.result === 'fail');
  assert(failed.some(row => row.name === 'synthetic child failure' && row.nesting === 1));
  assert(failed.some(row => row.name === 'synthetic parent' && row.error.failureType === 'subtestsFailed'));
  assert(failed.some(row => row.name === 'synthetic cancelled child' && row.nesting === 1
    && row.error.failureType === 'cancelledByParent'));
  assert(rows.some(row => row.event === 'file-end' && row.file === f.paths[1] && row.code === 0));
  assert(rows.some(row => row.result === 'skip' && row.name === 'synthetic optional prerequisite'
    && row.reason === 'synthetic missing prerequisite'));
  assert.deepEqual(rows.at(-1), { at: rows.at(-1).at, event: 'suite-end', completed: 2, failed: 1,
    unstarted: 0, interrupted: false, code: 1 });
});

test('HA qualification accepts a long storage-tail delay while retaining correctness failures', async t => {
  const limits = new URL('../scripts/lib/offline-test-profile.js', import.meta.url).href;
  const f = await fixture(t, {
    delayed: `import test from 'node:test'; import assert from 'node:assert/strict';
      import {testLatencyLimit} from ${JSON.stringify(limits)};
      test('delayed synthetic fixture', async () => { const began=performance.now();
        await new Promise(resolve=>setTimeout(resolve,17200));
        assert(performance.now()-began < testLatencyLimit(1000), 'synthetic latency exceeds the declared profile'); });`,
    incorrect: `import test from 'node:test'; import assert from 'node:assert/strict';
      test('synthetic data mismatch', () => { assert.equal(1,2,'synthetic incorrect result'); });`,
  });
  await assert.rejects(execute(process.execPath, command({ files: [f.paths[0]], profile: 'standard' }),
    { timeout: 40000 }), { code: 1 });
  await execute(process.execPath, command({ files: [f.paths[0]], profile: 'ha-sd' }), { timeout: 40000 });
  await assert.rejects(execute(process.execPath, command({ files: [f.paths[1]], profile: 'ha-sd' }),
    { timeout: 10000 }), error => {
    assert.equal(error.code, 1); assert.match(error.stdout, /synthetic incorrect result/); return true;
  });
});

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
