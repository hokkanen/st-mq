import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, lstatSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pairHelperNeedsRefresh, helperSourceFiles, trustedNode } from '../scripts/lib/linux-setup-platform.js';
import { installProvisioning } from '../scripts/lib/linux-setup-root.js';

const source = resolve(import.meta.dirname, '..');
const nodePath = trustedNode(process.execPath);
async function fixture(t) {
  assert.ok(nodePath, 'Fixture needs a protected Node installation');
  const root = mkdtempSync(join(tmpdir(), 'linux-vip-helper-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await installProvisioning({ version: 1, operation: 'setup', source, nodePath, uid: 1000,
    user: 'operator', group: 'operator', broker: null,
    vip: { interface: 'eth0', address: '192.0.2.30', prefixLength: 24 } },
  { rootDir: root, fixture: true, run: async () => '' });
  const path = name => join(root, name), calls = [];
  const states = Object.fromEntries(['st-mq-vip.service', 'st-mq-vip.socket'].map(name => [name, {
    LoadState: 'loaded', FragmentPath: '/etc/systemd/system/' + name, DropInPaths: '', NeedDaemonReload: 'no',
    ActiveState: 'active', SubState: name.endsWith('.socket') ? 'listening' : 'running', UnitFileState: 'enabled',
  }]));
  const options = { source, nodePath,
    readFile: (name, encoding) => readFileSync(name.startsWith(source + '/') ? name : path(name), encoding),
    stat: name => {
      const info = lstatSync(path(name));
      // Fixture files belong to the ordinary test account; model the production root owner.
      info.uid = 0; info.gid = 0; return info;
    },
    run: async (exe, args, commandOptions) => {
      calls.push([exe, ...args]); assert.equal(exe, 'systemctl'); assert.equal(args[0], 'show');
      assert.equal(commandOptions.timeout, 10000);
      return Object.entries(states[args[1]]).map(([key, value]) => `${key}=${value}`).join('\n');
    },
  };
  return { root, path, calls, states, options, inspect: () => pairHelperNeedsRefresh(options) };
}

test('current protected helper is verified without sudo or any mutation, including socket-activated idle service', async t => {
  const f = await fixture(t);
  assert.equal(await f.inspect(), false);
  f.states['st-mq-vip.service'].ActiveState = 'inactive'; f.states['st-mq-vip.service'].SubState = 'dead';
  assert.equal(await f.inspect(), false);
  assert.equal(f.calls.length, 4);
});

test('each public helper artifact must match; missing or unreadable artifacts require refresh', async t => {
  const f = await fixture(t);
  const files = ['usr/local/lib/st-mq/package.json', ...helperSourceFiles.map(name => 'usr/local/lib/st-mq/' + name),
    'etc/systemd/system/st-mq-vip.service', 'etc/systemd/system/st-mq-vip.socket'];
  for (const name of files) {
    const filename = f.path(name), original = readFileSync(filename);
    writeFileSync(filename, Buffer.concat([original, Buffer.from('\n# changed\n')]));
    assert.equal(await f.inspect(), true, name);
    writeFileSync(filename, original); rmSync(filename);
    assert.equal(await f.inspect(), true, name);
    writeFileSync(filename, original, { mode: 0o644 });
  }
  const readFile = f.options.readFile;
  f.options.readFile = (name, encoding) => {
    if (name === '/etc/systemd/system/st-mq-vip.socket') throw Error('synthetic unreadable file');
    return readFile(name, encoding);
  };
  assert.equal(await f.inspect(), true);
  assert.equal(f.calls.length, 0);
});

test('changed source helper requires refresh even when the installed release is internally consistent', async t => {
  const f = await fixture(t), readFile = f.options.readFile;
  f.options.readFile = (name, encoding) => name === join(source, helperSourceFiles[0])
    ? Buffer.from('changed current source') : readFile(name, encoding);
  assert.equal(await f.inspect(), true);
});

test('unprotected files or ancestors and symbolic links cannot qualify for skipping refresh', async t => {
  const f = await fixture(t), name = '/usr/local/lib/st-mq/scripts/pair-vip.js', filename = f.path(name);
  for (const mode of [0o666, 0o600, 0o4644]) {
    chmodSync(filename, mode); assert.equal(await f.inspect(), true);
  }
  chmodSync(filename, 0o644);
  for (const directory of ['/usr/local/lib/st-mq', '/usr/local', '/']) {
    const target = f.path(directory), mode = lstatSync(target).mode;
    chmodSync(target, 0o777); assert.equal(await f.inspect(), true); chmodSync(target, mode);
  }
  const stat = f.options.stat;
  for (const target of [name, '/etc/systemd/system', '/']) {
    f.options.stat = path => { const info = stat(path); if (path === target) info.uid = 1000; return info; };
    assert.equal(await f.inspect(), true);
  }
  f.options.stat = stat;
  f.options.stat = path => { const info = stat(path); if (path === name) info.gid = 1000; return info; };
  assert.equal(await f.inspect(), true); f.options.stat = stat;
  const original = readFileSync(filename), linkTarget = f.path('linked-helper');
  writeFileSync(linkTarget, original); rmSync(filename); symlinkSync(linkTarget, filename);
  assert.equal(await f.inspect(), true);
});

test('systemd drift, inactive socket and unavailable metadata require refresh', async t => {
  const f = await fixture(t);
  for (const name of Object.keys(f.states)) {
    for (const patch of [{ LoadState: 'not-found' }, { FragmentPath: '/run/systemd/system/' + name },
      { DropInPaths: '/etc/systemd/system/external.conf' }, { NeedDaemonReload: 'yes' },
      { ActiveState: 'failed', SubState: 'failed' }]) {
      const original = f.states[name]; f.states[name] = { ...original, ...patch };
      assert.equal(await f.inspect(), true); f.states[name] = original;
    }
  }
  for (const patch of [{ ActiveState: 'inactive', SubState: 'dead' }, { UnitFileState: 'disabled' }]) {
    const original = f.states['st-mq-vip.socket']; f.states['st-mq-vip.socket'] = { ...original, ...patch };
    assert.equal(await f.inspect(), true); f.states['st-mq-vip.socket'] = original;
  }
  f.options.run = async () => { throw Error('synthetic unavailable systemd'); };
  assert.equal(await f.inspect(), true);
  const controller = new AbortController(); controller.abort(); f.options.signal = controller.signal;
  await assert.rejects(f.inspect(), /cancelled/);
});
