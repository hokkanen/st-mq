import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectSSH, validateSSHHost, shellQuote, DeploymentTransportError } from '../scripts/lib/ha-deploy-transport.js';

const destination = { ssh_host: 'synthetic-ha' };

function mockSSH(onSpawn, { writeError } = {}) {
  const calls = [];
  return {
    calls,
    spawnProcess(command, args, options) {
      const child = new EventEmitter();
      const input = [];
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({
        write(chunk, _encoding, done) {
          input.push(Buffer.from(chunk));
          done(writeError);
        },
      });
      child.kill = signal => {
        child.signals.push(signal);
        queueMicrotask(() => child.emit('close', null, signal));
        return true;
      };
      child.signals = [];
      const call = { command, args, options, child, input };
      calls.push(call);
      queueMicrotask(() => onSpawn?.(call));
      return child;
    },
  };
}

function localSSH(calls = []) {
  return {
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      // Execute the exact remote command using a real POSIX shell. The fixture
      // never starts ssh or reads keys/configuration from the local machine.
      return spawn('sh', ['-c', args.at(-1)], options);
    },
  };
}

test('SSH shell quoting preserves apostrophes, substitutions and newlines literally', () => {
  const value = "it's $(printf unsafe) `printf unsafe`\nnext";
  const output = execFileSync('sh', ['-c', `printf '%s' ${shellQuote(value)}`], { encoding: 'utf8' });
  assert.equal(output, value);
});

test('SSH uses verified noninteractive separate processes and never a shell or terminal', async t => {
  const fixture = mockSSH(({ child }) => child.emit('close', 0, null));
  const ssh = await connectSSH(destination, fixture);
  t.after(() => ssh.close());
  assert.equal(fixture.calls.length, 0, 'connection creation must not run an unrequested command');
  await ssh.run('printf first');
  await ssh.run('printf second');
  assert.equal(fixture.calls.length, 2);
  for (const { command, args, options } of fixture.calls) {
    assert.equal(command, 'ssh');
    assert.deepEqual(args.slice(0, -1), [
      '-T', '-o', 'BatchMode=yes', '-o', 'ForkAfterAuthentication=no', '-o', 'StdinNull=no',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '--', 'synthetic-ha',
    ]);
    assert.deepEqual(options, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  }
  assert.equal(fixture.calls[0].args.at(-1), "sh -c 'printf first'");
});

test('SSH validates destinations before spawning and never prints rejected private values', async () => {
  const fixture = mockSSH();
  for (const ssh_host of ['', '-oProxyCommand=private', 'host;private', 'private host', 'a\nprivate',
    'user@host@private', 'ssh://private', '$(private)', 'private`id`', 'x'.repeat(256), null]) {
    await assert.rejects(connectSSH({ ssh_host }, fixture), error =>
      error instanceof DeploymentTransportError && !error.message.includes('private'));
  }
  assert.equal(fixture.calls.length, 0);
  for (const ssh_host of ['alias', 'home-assistant.invalid', 'user@home-assistant.invalid', '127.0.0.1',
    'user@192.0.2.1', '[2001:db8::1]', 'user@2001:db8::1']) {
    assert.equal(validateSSHHost(ssh_host), ssh_host);
    await (await connectSSH({ ssh_host }, fixture)).close();
  }
});

test('SSH streams binary data once to real local shell with exact bytes and independent SHA-256', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ha-ssh-stream-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "bundle ' synthetic.bin");
  const input = Buffer.alloc(512 * 1024 + 19);
  for (let index = 0; index < input.length; index++) input[index] = index % 256;
  const calls = [];
  const ssh = await connectSSH(destination, localSSH(calls));
  t.after(() => ssh.close());
  const result = await ssh.run(`umask 077; cat > ${shellQuote(path)} && sha256sum ${shellQuote(path)}`, { input });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.slice(0, 64), createHash('sha256').update(input).digest('hex'));
  assert.deepEqual(readFileSync(path), input);
  assert.equal(calls.length, 1, 'the entire transfer is one logical command');
});

test('SSH ordinary nonzero command exit is returned and does not replay or poison later commands', async t => {
  const calls = [];
  const ssh = await connectSSH(destination, localSSH(calls));
  t.after(() => ssh.close());
  assert.deepEqual(await ssh.run("printf 'command result'; exit 23"), { exitCode: 23, output: 'command result' });
  assert.deepEqual(await ssh.run("printf 'next result'"), { exitCode: 0, output: 'next result' });
  assert.equal(calls.length, 2);
});

test('SSH stdout preserves UTF-8 fragments and excludes private stderr banners', async t => {
  const fixture = mockSSH(({ child }) => {
    const value = Buffer.from('temperature 20 °C');
    const split = value.indexOf(0xc2) + 1;
    child.stdout.write(value.subarray(0, split));
    child.stdout.write(value.subarray(split));
    child.stderr.write('private SSH authentication banner');
    child.emit('close', 0, null);
  });
  const ssh = await connectSSH(destination, fixture);
  t.after(() => ssh.close());
  assert.deepEqual(await ssh.run('synthetic'), { exitCode: 0, output: 'temperature 20 °C' });
});

test('SSH timeout kills and reaps the client, fences further work and never retries', async () => {
  const fixture = mockSSH();
  const ssh = await connectSSH(destination, fixture);
  await assert.rejects(ssh.run('may already be executing', { timeoutMs: 20 }), /timed out.*may still be running/);
  assert.deepEqual(fixture.calls[0].child.signals, ['SIGTERM']);
  await assert.rejects(ssh.run('must not run'), /timed out/);
  await ssh.close();
  assert.equal(fixture.calls.length, 1);
});

test('SSH escalates to SIGKILL and waits for close when SIGTERM does not reap the client', async () => {
  let closed = false;
  const fixture = mockSSH(({ child }) => {
    child.kill = signal => {
      child.signals.push(signal);
      if (signal === 'SIGKILL') queueMicrotask(() => { closed = true; child.emit('close', null, signal); });
      return true;
    };
  });
  const ssh = await connectSSH(destination, fixture);
  await assert.rejects(ssh.run('synthetic', { timeoutMs: 20 }), /timed out/);
  assert.equal(closed, true);
  assert.deepEqual(fixture.calls[0].child.signals, ['SIGTERM', 'SIGKILL']);
  await ssh.close();
});

for (const [code, signal] of [[255, null], [null, 'SIGTERM']]) {
  test(`SSH connection loss (${code ?? signal}) fences later commands without leaking remote details`, async () => {
    const fixture = mockSSH(({ child }) => {
      child.stderr.write('private-address private-account private-token');
      child.emit('close', code, signal);
    });
    const ssh = await connectSSH(destination, fixture);
    await assert.rejects(ssh.run('synthetic'), error =>
      error instanceof DeploymentTransportError && /may still be running/.test(error.message) &&
      !error.message.includes('private'));
    await assert.rejects(ssh.run('must not run'), /connection failed/);
    assert.equal(fixture.calls.length, 1);
    await ssh.close();
  });
}

test('SSH output limit includes both streams, stops the process and suppresses output', async () => {
  const fixture = mockSSH(({ child }) => {
    child.stdout.write(Buffer.alloc(1024 * 1024, 'x'));
    child.stderr.write(Buffer.alloc(1024 * 1024, 'y'));
    child.stderr.write('private-overflow');
  });
  const ssh = await connectSSH(destination, fixture);
  await assert.rejects(ssh.run('synthetic'), error => /output exceeded/.test(error.message) && !error.message.includes('private'));
  assert.deepEqual(fixture.calls[0].child.signals, ['SIGTERM']);
  await assert.rejects(ssh.run('must not run'), /output exceeded/);
  assert.equal(fixture.calls.length, 1);
  await ssh.close();
});

test('SSH handles stdin EPIPE and close races without exposing diagnostics or running more commands', async () => {
  const fixture = mockSSH(undefined, { writeError: Object.assign(new Error('private-path EPIPE'), { code: 'EPIPE' }) });
  const ssh = await connectSSH(destination, fixture);
  await assert.rejects(ssh.run('synthetic', { input: Buffer.from('payload') }), error =>
    /input failed/.test(error.message) && !error.message.includes('private'));
  await assert.rejects(ssh.run('must not run'), /input failed/);
  assert.equal(fixture.calls.length, 1);
  await ssh.close();
});

test('SSH spawn errors, synchronous or emitted, are private and permanently fence transport', async () => {
  for (const synchronous of [true, false]) {
    let attempts = 0;
    const fixture = mockSSH(({ child }) => child.emit('error', new Error('private-key-path')));
    const ssh = await connectSSH(destination, {
      spawnProcess(...args) {
        attempts++;
        if (synchronous) throw new Error('private-key-path');
        return fixture.spawnProcess(...args);
      },
    });
    await assert.rejects(ssh.run('synthetic'), error =>
      error instanceof DeploymentTransportError && /SSH process/.test(error.message) && !error.message.includes('private'));
    await assert.rejects(ssh.run('must not run'), /SSH process/);
    assert.equal(attempts, 1);
    await ssh.close();
  }
});

test('SSH rejects concurrent commands without cancelling the first or replaying the second', async () => {
  const fixture = mockSSH();
  const ssh = await connectSSH(destination, fixture);
  const first = ssh.run('first');
  await assert.rejects(ssh.run('second'), /already running/);
  assert.equal(fixture.calls.length, 1);
  fixture.calls[0].child.emit('close', 0, null);
  assert.deepEqual(await first, { exitCode: 0, output: '' });
  await ssh.close();
});

test('SSH close reaps an active client, reports uncertain execution and refuses later work', async () => {
  const fixture = mockSSH();
  const ssh = await connectSSH(destination, fixture);
  const rejection = assert.rejects(ssh.run('already submitted'), /closed.*may still be running/);
  await ssh.close();
  await rejection;
  assert.deepEqual(fixture.calls[0].child.signals, ['SIGTERM']);
  await assert.rejects(ssh.run('must not run'), /closed/);
  await ssh.close();
  assert.equal(fixture.calls.length, 1);
});

test('SSH invalid arguments fail before spawning and leave a valid command available', async () => {
  const fixture = mockSSH(({ child }) => child.emit('close', 0, null));
  const ssh = await connectSSH(destination, fixture);
  for (const [script, options] of [[null, {}], ['x\0y', {}], ['valid', { input: 'not a buffer' }],
    ['valid', { timeoutMs: 0 }], ['valid', { timeoutMs: Infinity }], ['valid', { timeoutMs: 2147483648 }]]) {
    await assert.rejects(ssh.run(script, options), /Invalid SSH command/);
  }
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(await ssh.run('valid'), { exitCode: 0, output: '' });
  await ssh.close();
});
