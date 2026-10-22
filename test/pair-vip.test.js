import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { manageVip, serveVip } from '../scripts/pair-vip.js';
import { requestVipSocket, validateVip, VirtualIP } from '../src/pairing/vip.js';

test('documented restricted helper installation runs independently of application storage modules', async t => {
  const root = await mkdtemp(join(tmpdir(), 'st-mq-installed-vip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['scripts', 'src/pairing']) await mkdir(join(root, path), { recursive: true });
  for (const path of ['package.json', 'scripts/pair-vip.js', 'src/pairing/vip.js'])
    await copyFile(new URL('../' + path, import.meta.url), join(root, path));
  const result = spawnSync(process.execPath, [join(root, 'scripts/pair-vip.js'), 'invalid-action'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'error:vip_failed\n');
  assert.equal(result.stderr, 'VIP operation failed.\n');
});

test('VIP policy accepts only fixed validated address and reports real release failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stmq-pair-vip-')); t.after(() => rm(root, { recursive: true, force: true }));
  const policyPath = join(root, 'policy.json');
  await writeFile(policyPath, JSON.stringify({ interface: 'eth0', address: '192.0.2.50', prefixLength: 24 }), { mode: 0o600 });
  const calls = [];
  const run = async (command, args) => { calls.push([command, args]); return '[]'; };
  const options = { policyPath, requireRootPolicy: false, run, interfaces: () => ({ eth0: [] }) };
  await manageVip(['acquire', 'eth0', '192.0.2.50', '24'], options);
  assert.deepEqual(calls[0], ['ip', ['address', 'replace', '192.0.2.50/24', 'dev', 'eth0']]);
  assert.equal(calls[1][0], 'arping');
  await manageVip(['release', 'eth0', '192.0.2.50', '24'], options);
  await assert.rejects(manageVip(['acquire', 'eth0', '192.0.2.51', '24'], options));
  assert.throws(() => validateVip({ interface: 'eth0;id', address: '192.0.2.50', prefixLength: 24 }));
  await assert.rejects(manageVip(['release', 'eth0', '192.0.2.50', '24'], { ...options, run: async () => { throw Error(); } }));
});

test('VIP failures identify the setup stage without returning private command errors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stmq-vip-diagnostic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policyPath = join(root, 'policy.json'), args = ['acquire', 'eth0', '192.0.2.50', '24'];
  const options = { policyPath, requireRootPolicy: false, interfaces: () => ({ eth0: [] }), run: async () => '[]' };
  await assert.rejects(manageVip(args, options), { code: 'vip_policy_invalid' });
  await writeFile(policyPath, JSON.stringify({ interface: 'eth0', address: '192.0.2.51', prefixLength: 24 }), { mode: 0o600 });
  await assert.rejects(manageVip(args, options), { code: 'vip_policy_mismatch' });
  await writeFile(policyPath, JSON.stringify({ interface: 'eth0', address: '192.0.2.50', prefixLength: 24 }));
  await assert.rejects(manageVip(args, { ...options, interfaces: () => ({}) }), { code: 'vip_interface_missing' });
  const calls = [];
  const run = async command => { calls.push(command); if (command === 'arping') throw Error('private command output'); return ''; };
  await assert.rejects(manageVip(args, { ...options, run }), { code: 'vip_announce_failed' });
  assert.deepEqual(calls, ['ip', 'arping', 'ip'], 'An unannounced address is removed');
  await assert.rejects(manageVip(args, { ...options, run: async () => { throw Error('private command output'); } }), { code: 'vip_command_failed' });
  const socketPath = join(root, 'control.sock');
  const server = serveVip({ socketPath, manage: async () => { throw Object.assign(Error('private detail'), { code: 'vip_policy_mismatch' }); } });
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(requestVipSocket(socketPath, args), { message: 'vip_policy_mismatch', code: 'vip_policy_mismatch' });
  await assert.rejects(requestVipSocket(join(root, 'missing.sock'), args), { code: 'vip_helper_unavailable' });
});

test('native VIP socket delegates only bounded commands and supports unprivileged application', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stmq-vip-socket-')); t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, 'control.sock'), calls = [];
  const server = serveVip({ socketPath, manage: async args => { calls.push(args); if (args[0] === 'bad') throw Error(); } });
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const vip = new VirtualIP({ interface: 'eth0', address: '192.0.2.50', prefixLength: 24, socketPath });
  await vip.acquire(); assert.equal(vip.status().owned, true);
  await vip.release(); assert.equal(vip.status().owned, false);
  assert.deepEqual(calls.map(args => args[0]), ['acquire', 'release']);
  await assert.rejects(requestVipSocket(socketPath, ['bad', 'eth0', '192.0.2.50', '24']), { code: 'vip_failed' });
});
