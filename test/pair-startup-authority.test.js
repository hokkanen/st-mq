import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../src/storage/store.js';
import { PairManager } from '../src/pairing/manager.js';

const failure = code => Object.assign(new Error(code), { code });
const deferred = () => Promise.withResolvers();

async function fixture(t) {
  const directory = await mkdtemp('/tmp/stmq-startup-authority-'), nodes = [], events = [];
  t.after(async () => { await Promise.all(nodes.map(node => node.pair.close())); await rm(directory, { recursive: true, force: true }); });
  async function create(name, platform, { role = 'master', timeoutMs = 1000 } = {}) {
    const databasePath = join(directory, `${name}.sqlite`);
    if (role === 'master') new Store(databasePath).close();
    const node = { name, owned: false, starts: 0, stopError: null, releaseError: null, restore: [] };
    const pair = new PairManager({ config: { directory: join(directory, name), databasePath,
      snapshotDirectory: join(directory, `${name}-snapshots`), pairId: 'fixture-pair', platform,
      token: 'synthetic-startup-authority-token-0123456789abcdef', listenHost: '127.0.0.1', port: 0,
      peerUrl: 'http://127.0.0.1:1', timeoutMs, intervalMs: 60000, vip: {} },
    announcements: () => null, reportStartupFailure: () => {}, vip: {
      acquire: async () => {
        assert.equal(nodes.some(other => other !== node && other.owned), false, 'no second host may acquire the address');
        node.owned = true; events.push(`${name}:acquire`);
      },
      release: async () => { if (node.releaseError) throw failure(node.releaseError); node.owned = false; events.push(`${name}:release`); },
      status: () => ({ owned: node.owned, ready: node.owned, error: node.releaseError }),
    }, hooks: {
      startPrimary: async () => { node.starts++; events.push(`${name}:start`); },
      stopControl: async ({ restore }) => { node.restore.push(restore); events.push(`${name}:stop`); if (node.stopError) throw failure(node.stopError); },
      startReplica: async () => {},
    } });
    node.pair = pair; nodes.push(node);
    await pair.init();
    if (role === 'master') await pair.state.update({ role: 'master', reason: null });
    node.start = async () => { await pair.start(); clearTimeout(pair.timer); return node; };
    node.follow = other => { pair.peer.peerUrl = `http://127.0.0.1:${other.pair.peer.server.address().port}`; };
    return node;
  }
  return { create, events };
}

test('a preferred saved master waits for the live peer to release control and address before starting', async t => {
  const f = await fixture(t), peer = await f.create('peer', 'ubuntu'); await peer.start();
  const returning = await f.create('returning', 'hassio'); returning.follow(peer);
  await returning.start();
  assert.equal(returning.pair.canControl(), true);
  assert.equal(peer.pair.canControl(), false);
  assert.equal(peer.pair.state.value.role, 'protected');
  assert.deepEqual(peer.restore, [false]);
  assert.ok(f.events.indexOf('peer:stop') < f.events.indexOf('returning:acquire'));
  assert.ok(f.events.indexOf('peer:release') < f.events.indexOf('returning:acquire'));
  assert.equal(returning.starts, 1);
});

test('a lower-priority saved master returns protected without opening equipment or acquiring the address', async t => {
  const f = await fixture(t), peer = await f.create('peer', 'hassio'); await peer.start();
  const returning = await f.create('returning', 'ubuntu'); returning.follow(peer);
  await returning.start();
  assert.equal(peer.pair.canControl(), true);
  assert.equal(returning.pair.state.value.role, 'protected');
  assert.equal(returning.starts, 0);
  assert.equal(f.events.includes('returning:acquire'), false);
});

test('a malformed saved transition cannot restart master control or acquire the address', async t => {
  const f = await fixture(t), node = await f.create('invalid-transition', 'ubuntu', { timeoutMs: 30 });
  await node.pair.state.close();
  const path = node.pair.state.path;
  const saved = JSON.parse(await readFile(path, 'utf8'));
  const bytes = JSON.stringify({ ...saved, transition: false });
  await writeFile(path, bytes);
  await node.pair.state.open({ allowInvalid: true });
  await node.start();
  assert.equal(node.starts, 0);
  assert.equal(node.pair.canControl(), false);
  assert.equal(node.pair.state.value.role, 'protected');
  assert.equal(f.events.includes('invalid-transition:acquire'), false);
  assert.equal(await readFile(path, 'utf8'), bytes, 'invalid authority evidence remains available for diagnosis');
});

test('simultaneous saved-master restarts agree on one winner without reciprocal fencing deadlock', async t => {
  const f = await fixture(t), high = await f.create('high', 'hassio'), low = await f.create('low', 'ubuntu');
  const listening = deferred(); let started = 0;
  for (const [node, peer] of [[high, low], [low, high]]) {
    const start = node.pair.peer.start.bind(node.pair.peer);
    node.pair.peer.start = async () => {
      const address = await start();
      peer.pair.peer.peerUrl = `http://127.0.0.1:${address.port}`;
      if (++started === 2) listening.resolve();
      await listening.promise;
      return address;
    };
  }
  await Promise.all([high.start(), low.start()]);
  assert.equal(high.pair.canControl(), true);
  assert.equal(low.pair.state.value.role, 'protected');
  assert.equal(high.starts, 1); assert.equal(low.starts, 0);
  assert.equal(f.events.filter(event => event.endsWith(':acquire')).length, 1);
});

test('a lost fencing acknowledgement after observing a master never authorizes startup', async t => {
  const f = await fixture(t), peer = await f.create('peer', 'ubuntu'); await peer.start();
  const returning = await f.create('returning', 'hassio'); returning.follow(peer);
  const request = returning.pair.peer.request.bind(returning.pair.peer);
  returning.pair.peer.request = async (operation, body, options) => {
    const result = await request(operation, body, options);
    if (body.claim) throw failure('peer_unavailable');
    return result;
  };
  await returning.start();
  assert.equal(returning.starts, 0); assert.equal(returning.pair.canControl(), false);
  assert.equal(returning.pair.state.value.reason, 'startup_authority_unconfirmed');
  assert.equal(peer.pair.state.value.role, 'protected');
});

test('a peer that still claims master cannot authorize the returning preferred master to activate', async t => {
  const f = await fixture(t), peer = await f.create('peer', 'ubuntu'); await peer.start();
  const returning = await f.create('returning', 'hassio');
  returning.pair.peer.request = () => peer.pair.handlePeer('status', {});
  await returning.start();
  assert.equal(returning.starts, 0);
  assert.equal(returning.pair.state.value.reason, 'startup_authority_unconfirmed');
  assert.equal(peer.pair.canControl(), true);
});

test('a non-master role without current release proof never authorizes startup', async t => {
  const f = await fixture(t), peer = await f.create('slave', 'ubuntu', { role: 'slave' }); await peer.start();
  const returning = await f.create('returning', 'hassio', { timeoutMs: 30 });
  returning.pair.peer.request = async () => {
    const { controlReleased, ...unconfirmed } = await peer.pair.handlePeer('status', {});
    return unconfirmed;
  };
  await returning.start();
  assert.equal(returning.starts, 0);
  assert.equal(returning.pair.state.value.role, 'protected');
  assert.equal(returning.pair.status().error, 'timed_out');
});

for (const problem of ['release', 'stop']) test(`failed peer ${problem} is reported instead of acknowledging startup fencing`, async t => {
  const f = await fixture(t), peer = await f.create('peer', 'ubuntu'); await peer.start();
  if (problem === 'release') peer.releaseError = 'vip_release_failed'; else peer.stopError = 'runtime_failed';
  const returning = await f.create('returning', 'hassio'); returning.follow(peer);
  await returning.start();
  assert.equal(returning.starts, 0);
  assert.equal(returning.pair.state.value.role, 'protected');
  assert.equal(peer.pair.canControl(), false);
  assert.equal((await peer.pair.handlePeer('status', {})).controlReleased, false);
  assert.equal(returning.pair.status().error, problem === 'release' ? 'vip_release_failed' : 'runtime_failed');
});

test('a saved master can start after a bounded silent-peer timeout with no observed competing claim', async t => {
  const f = await fixture(t), node = await f.create('master', 'ubuntu', { timeoutMs: 30 });
  let timedOut = false;
  node.pair.peer.request = async (operation, body, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { timedOut = true; reject(failure('timed_out')); }, { once: true });
  });
  await node.start();
  assert.equal(timedOut, true); assert.equal(node.pair.canControl(), true); assert.equal(node.starts, 1);
});

test('malformed or unauthenticated reachable peer responses cannot be treated as an offline slave', async t => {
  for (const response of ['malformed', 'authentication']) {
    const f = await fixture(t), node = await f.create(response, 'ubuntu');
    node.pair.peer.request = async () => {
      if (response === 'authentication') throw failure('peer_authentication_failed');
      return { claim: { role: 'slave' }, controlReleased: true };
    };
    await node.start();
    assert.equal(node.starts, 0);
    assert.equal(node.pair.state.value.role, 'protected');
  }
});

test('HTTP refusals, redirects and interrupted responses never become offline-master startup permission', async t => {
  for (const status of [302, 500, 503, 200]) {
    const server = createServer((request, response) => {
      request.resume(); response.writeHead(status, { Location: 'http://127.0.0.1:1/' });
      if (status === 200) response.flushHeaders(); else response.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const f = await fixture(t), node = await f.create(`http-${status}`, 'ubuntu', { timeoutMs: 100 });
    node.pair.peer.peerUrl = `http://127.0.0.1:${server.address().port}`;
    await node.start();
    assert.equal(node.starts, 0);
    assert.equal(node.pair.state.value.role, 'protected');
    assert.equal(node.pair.status().error, status === 503 ? 'peer_busy' : 'peer_protocol_failed');
  }
});

test('a peer with an unfinished initial address release does not yet acknowledge control release', async t => {
  const f = await fixture(t), peer = await f.create('slave', 'ubuntu', { role: 'slave' });
  const entered = deferred(), resume = deferred(), release = peer.pair.vip.release;
  peer.pair.vip.release = async () => { entered.resolve(); await resume.promise; return release(); };
  const starting = peer.start();
  await entered.promise;
  assert.equal((await peer.pair.handlePeer('status', {})).controlReleased, false);
  resume.resolve(); await starting;
  assert.equal((await peer.pair.handlePeer('status', {})).controlReleased, true);
});
