import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/storage/store.js';

const childURL = new URL('../helpers/executor-crash-child.js', import.meta.url);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-executor-process-'));
  const path = join(directory, 'history.sqlite'), children = new Set(), commands = [];
  let on = false;
  t.after(async () => {
    const pending = [...children];
    for (const child of pending) child.kill('SIGKILL');
    await Promise.all(pending.map(child => child.closed));
    await rm(directory, { recursive: true, force: true });
  });
  function run(operation, boundary, fence = 'none') {
    return new Promise((resolve, reject) => {
      const child = fork(childURL, [path, operation, boundary, fence], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], signal: t.signal });
      child.closed = new Promise(resolve => child.once('close', resolve));
      children.add(child);
      let result, stopped = false, stderr = '';
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
      child.once('error', reject);
      child.on('message', message => {
        if (message.type === 'command') {
          on = message.on; commands.push(on);
          if (operation === 'start' && boundary === 'on-before-ack' && on) { stopped = true; child.kill('SIGKILL'); }
          else child.send({ type: 'ack', id: message.id });
        } else if (message.type === 'boundary') { stopped = true; child.kill('SIGKILL'); }
        else if (message.type === 'restored') result = message;
        else if (message.type === 'failure') reject(new Error(`Child failed: ${message.code}`));
      });
      child.once('exit', (code, signal) => {
        children.delete(child);
        if (operation === 'start' ? stopped && signal === 'SIGKILL' : code === 0 && result) resolve(result);
        else reject(new Error(`Unexpected child completion: ${code}/${signal} ${stderr}`));
      });
    });
  }
  const read = () => { const store = new Store(path, { readOnly: true }); try { return store.getState('executor:home'); } finally { store.close(); } };
  return { run, read, commands, isOn: () => on };
}

for (const boundary of ['before-on', 'on-before-ack', 'off-clearing-fails', 'after-clear'])
  test(`real process death ${boundary} preserves the committed circulation restoration obligation`, { timeout: 20000 }, async t => {
    const f = await fixture(t);
    await f.run('start', boundary);
    const saved = f.read(), hadDuty = boundary !== 'after-clear';
    assert.equal(saved.dhwrOutstanding, hadDuty);
    assert.equal(f.isOn(), boundary === 'on-before-ack');
    const priorCommands = f.commands.length;
    const result = await f.run('restore', 'none');
    assert.equal(result.errorCode, null);
    assert.equal(result.state.dhwrOutstanding, false);
    assert.equal(f.read().dhwrOutstanding, false);
    assert.equal(f.isOn(), false);
    assert.equal(f.commands.length, priorCommands + Number(hadDuty), 'restart resolves a retained duty but does not replay a completed run');
    assert(f.commands.slice(priorCommands).every(on => on === false), 'restart must never replay ON');
  });

for (const fence of ['authority', 'identity', 'evidence'])
  test(`process restart with ${fence} loss preserves the original duty without commanding another relay`, { timeout: 20000 }, async t => {
    const f = await fixture(t);
    await f.run('start', 'on-before-ack');
    const original = f.read(), priorCommands = f.commands.length;
    await f.run('restore', 'none', fence);
    assert.equal(f.commands.length, priorCommands);
    assert.equal(f.read().dhwrOutstanding, true);
    assert.deepEqual(f.read().targetBindings, original.targetBindings);
    assert.equal(f.isOn(), true, 'a fenced controller cannot claim physical restoration');
    const resumed = await f.run('restore', 'none');
    assert.equal(resumed.errorCode, null);
    assert.equal(f.isOn(), false);
    assert.equal(f.read().dhwrOutstanding, false);
  });
