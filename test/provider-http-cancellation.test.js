import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const phase of ['headers', 'body', 'partial', 'reload']) {
  test(`actual HTTP ${phase} cancellation survives GC and completes shutdown`, async () => {
    const helper = fileURLToPath(new URL('./helpers/provider-http-cancellation.js', import.meta.url));
    const child = spawn(process.execPath, ['--expose-gc', helper, phase], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', timedOut = false;
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', value => { errors += value; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 8000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timer);
    assert.equal(timedOut, false, `Synthetic ${phase} cancellation failed to settle`);
    assert.equal(code, 0, errors);
    const result = output.trim().split('\n').map(line => JSON.parse(line)).find(row => row.phase === phase);
    assert.equal(result?.complete, true);
  });
}
