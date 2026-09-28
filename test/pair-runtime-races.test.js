import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startPaired } from '../src/pairing/runtime.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const abortable = signal => new Promise((resolve, reject) => {
  if (signal.aborted) reject(Error('cancelled'));
  else signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
});
async function bounded(promise, milliseconds = 1500) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(Error('runtime shutdown did not finish')), milliseconds);
    })]);
  } finally { clearTimeout(timeout); }
}

async function fixture(t, { runtimeFactory, recoveryModule, snapshotSource } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-pair-runtime-race-'));
  const dbPath = join(root, 'source.sqlite'); await writeFile(dbPath, 'synthetic placeholder');
  const config = { dbPath, dataDir: root, databaseDir: root, input: 'mqtt', role: 'master', port: 0, host: '127.0.0.1', token: '',
    settings: {  }, connections: { mqtt: { address: 'mqtt://127.0.0.1' } },
    topology: 'pair', pair: { snapshotDirectory: join(root, 'pair-snapshots'), directory: join(root, 'pair'), timeoutMs: 30000, vip: {} } };
  let hooks, controlling = true, closed = false;
  const instances = [], gates = [];
  const defaultRuntime = async () => {
    const server = createServer((req, res) => res.end('fixture')); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const instance = { server, store: { path: dbPath }, engine: { config: { input: 'mqtt' }, closeFireplace: async () => {} },
      close: async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); } };
    return instance;
  };
  const app = await startPaired({ config, installSignalHandlers: false, prepareVipPolicy: async () => {},
    validateBroker: async () => {}, recoveryModule, snapshotSource,
    startRuntime: async options => {
      gates.push(options.pairContext.canControl);
      const instance = await (runtimeFactory ?? defaultRuntime)({ index: instances.length, defaultRuntime });
      instances.push(instance); return instance;
    }, managerFactory: options => {
      hooks = options.hooks;
      return { init: async () => {}, start: () => hooks.startPrimary({ dbPath }),
        status: () => ({ role: controlling ? 'master' : 'protected' }), canControl: () => controlling && !closed,
        prepareShutdown: () => {}, close: async () => { closed = true; controlling = false; } };
    } });
  t.after(async () => { await app.close(); for (const instance of instances) await instance.close(); await rm(root, { recursive: true, force: true }); });
  return { app, hooks, instances, gates, config, demote: () => { controlling = false; } };
}

test('shutdown cancels protected-view snapshot creation before opening a new listener', async t => {
  const entered = deferred(); let aborted = false;
  const f = await fixture(t, { snapshotSource: async ({ signal }) => {
    entered.resolve();
    try { await abortable(signal); } finally { aborted = signal.aborted; }
  } });
  const previous = f.app.server;
  const transition = f.hooks.startReplica({ role: 'protected', dbPath: f.config.dbPath }).catch(error => error);
  await entered.promise;
  await bounded(f.app.close()); await transition;
  assert.equal(aborted, true);
  assert.equal(previous.listening, false);
  assert.equal(f.app.server, undefined);
  assert.equal(f.instances.length, 1);
});

test('shutdown during replacement revokes an in-flight primary and closes its late listener', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { runtimeFactory: async ({ index, defaultRuntime }) => {
    if (index === 1) { entered.resolve(); await release.promise; }
    return defaultRuntime();
  } });
  const replacement = f.hooks.startPrimary({ dbPath: f.config.dbPath }).catch(error => error);
  await entered.promise;
  const closing = f.app.close();
  await Promise.resolve();
  assert.equal(f.gates[1](), false, 'late runtime has lost its captured command token');
  release.resolve(); await bounded(closing); await replacement;
  assert.equal(f.instances.length, 2);
  assert.equal(f.instances.every(instance => !instance.server.listening), true);
  assert.equal(f.app.server, undefined);
});

test('shutdown aborts a running recovery worker before closing its source store', async t => {
  const entered = deferred(), phases = [];
  const f = await fixture(t, { recoveryModule: async () => ({ recoverHistory: async ({ signal, isCurrent }) => {
    assert.equal(isCurrent(), true); entered.resolve();
    try { await abortable(signal); } finally { phases.push('worker-stopped'); }
  } }), runtimeFactory: async ({ defaultRuntime }) => {
    const instance = await defaultRuntime(), close = instance.close;
    instance.close = async () => { phases.push('store-closed'); await close(); };
    return instance;
  } });
  const recovery = f.hooks.recoveryApply({ donorPath: 'synthetic-donor.sqlite', preview: {} }).catch(error => error);
  await entered.promise;
  await bounded(f.app.close()); await recovery;
  assert.deepEqual(phases.slice(0, 2), ['worker-stopped', 'store-closed']);
  assert.equal(f.instances[0].server.listening, false);
});

test('shutdown while the previous primary closes prevents starting its replacement', async t => {
  const closingOld = deferred(), releaseOld = deferred();
  const f = await fixture(t, { runtimeFactory: async ({ index, defaultRuntime }) => {
    const instance = await defaultRuntime(), close = instance.close;
    if (index === 0) instance.close = async () => { closingOld.resolve(); await releaseOld.promise; await close(); };
    return instance;
  } });
  const replacement = f.hooks.startPrimary({ dbPath: f.config.dbPath }).catch(error => error);
  await closingOld.promise;
  const closing = f.app.close();
  releaseOld.resolve(); await bounded(closing); await replacement;
  assert.equal(f.instances.length, 1, 'shutdown does not open a replacement listener or start providers');
  assert.equal(f.instances[0].server.listening, false);
});

test('an unreadable protected donor retains its management API and read-only waiting view', async t => {
  const f = await fixture(t);
  f.demote();
  await f.hooks.startReplica({ role: 'protected', dbPath: f.config.dbPath });
  assert.equal(f.app.pair.error, 'snapshot_failed');
  const response = await fetch(`http://127.0.0.1:${f.app.server.address().port}/api/status`);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.readOnly, true); assert.equal(status.pair.role, 'protected');
  assert.equal(status.sync.state, 'waiting');
  assert.equal(f.app.engine, undefined);
  await bounded(f.app.close());
});
