import { fixtureMqttFrontend, fixtureMqttSourceContext } from './helpers/pair-frontend.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../src/storage/store.js';
import { PairManager } from '../src/pairing/manager.js';
import { startPaired } from '../src/pairing/runtime.js';
import { createHistoryRecovery } from '../src/app/history-recovery.js';
import { readReplicaPublication, snapshotDigest } from '../src/replication/publication.js';

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
  const instances = [], gates = [], runtimeConfigurations = [], sourceActivations = [];
  const defaultRuntime = async () => {
    const server = createServer((req, res) => res.end('fixture')); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const instance = { server, store: { path: dbPath, runWrite: async operation => operation() }, engine: { config: { input: 'mqtt' }, closeFireplace: async () => {} },
      close: async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); } };
    return instance;
  };
  const app = await startPaired({ config, frontendFactory: fixtureMqttFrontend, sourceContextFactory: fixtureMqttSourceContext, installSignalHandlers: false, prepareVipPolicy: async () => {},
    validateBroker: async () => {}, recoveryModule, snapshotSource,
    startRuntime: async options => {
      gates.push(options.pairContext.canControl);
      runtimeConfigurations.push(options.config);
      sourceActivations.push(options.pairContext.activateMqttSources);
      const instance = await (runtimeFactory ?? defaultRuntime)({ index: instances.length, defaultRuntime });
      const saved = new Map();
      instance.store.getState = key => saved.get(key) ?? null;
      instance.store.setState = (key, value) => saved.set(key, value);
      instance.historyRecovery = createHistoryRecovery({ store: instance.store, getEngine: () => instance.engine,
        canControl: options.pairContext.canControl, ...options.historyRecoveryOptions });
      instances.push(instance); return instance;
    }, managerFactory: options => {
      hooks = options.hooks;
      return { init: async () => {}, start: () => hooks.startPrimary({ dbPath }),
        status: () => ({ role: controlling ? 'master' : 'protected' }), canControl: () => controlling && !closed,
        prepareShutdown: () => {}, close: async () => { closed = true; controlling = false; } };
    } });
  t.after(async () => { await app.close(); for (const instance of instances) await instance.close(); await rm(root, { recursive: true, force: true }); });
  return { app, hooks, instances, gates, config, runtimeConfigurations, sourceActivations, demote: () => { controlling = false; } };
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

test('authority-loss shutdown joins an in-flight restoring close before acknowledging stopped equipment', async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { runtimeFactory: async ({ defaultRuntime }) => {
    const instance = await defaultRuntime(), close = instance.close;
    instance.close = async () => { entered.resolve(); await finish.promise; await close(); };
    return instance;
  } });
  const restoring = f.hooks.stopControl({ restore: true });
  await entered.promise;
  let acknowledged = false;
  const fencing = f.hooks.stopControl({ restore: false }).then(() => { acknowledged = true; });
  await Promise.resolve();
  assert.equal(acknowledged, false);
  assert.equal(f.gates[0](), false, 'authority is revoked before waiting for the older close');
  finish.resolve(); await bounded(Promise.all([restoring, fencing]));
  assert.equal(f.instances[0].server.listening, false);
});

test('successful configuration application survives runtime replacement without adopting its promoted storage path', async t => {
  const f = await fixture(t);
  const applied = { ...f.runtimeConfigurations[0], dbPath: join(f.config.dataDir, 'promoted-copy.sqlite'),
    settings: { syntheticSetting: 'applied' } };
  await f.sourceActivations[0](applied, f.instances[0].store);
  await f.hooks.startPrimary({ dbPath: f.config.dbPath });
  assert.equal(f.runtimeConfigurations[1].settings.syntheticSetting, 'applied');
  assert.equal(f.runtimeConfigurations[1].dbPath, f.config.dbPath);
  assert.equal(f.config.dbPath.endsWith('source.sqlite'), true);
  // A settings rollback passes through the same validated activation boundary.
  await f.sourceActivations[1]({ ...f.runtimeConfigurations[1], settings: { syntheticSetting: 'restored' } }, f.instances[1].store);
  await f.hooks.startPrimary({ dbPath: f.config.dbPath });
  assert.equal(f.runtimeConfigurations[2].settings.syntheticSetting, 'restored');
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

test('a slave gap-check export and normal catchup serialize without falsely protecting valid history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stmq-pair-export-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const create = async name => {
    const config = { directory: join(root, name), snapshotDirectory: join(root, `${name}-snapshots`),
      databasePath: join(root, `${name}.sqlite`), pairId: 'fixture-pair', platform: 'ubuntu',
      token: 'synthetic-export-race-token-0123456789abcdef', listenHost: '127.0.0.1', port: 0,
      peerUrl: 'http://127.0.0.1:1', timeoutMs: 30000, intervalMs: 60000, vip: {} };
    const pair = new PairManager({ config, announcements: () => null, hooks: {
      startPrimary: async ({ dbPath }) => new Store(dbPath).close(),
    }, vip: { acquire: async () => {}, release: async () => {}, status: () => ({ ready: true }) } });
    t.after(() => pair.close());
    await pair.init(); await pair.start(); clearTimeout(pair.timer);
    return pair;
  };
  const master = await create('master'), slave = await create('slave');
  master.peer.peerUrl = `http://127.0.0.1:${slave.peer.server.address().port}`;
  slave.peer.peerUrl = `http://127.0.0.1:${master.peer.server.address().port}`;
  await master.promote();
  await slave.synchronize(master.state.claim());
  assert.equal(slave.sync.state, 'ready');
  const original = await readReplicaPublication(slave.config.snapshotDirectory);
  const backupEntered = deferred(), resume = deferred(), publicationQueued = deferred();
  const snapshot = slave.snapshots.snapshot;
  let exporting = false;
  slave.snapshots.snapshot = async options => {
    exporting = true; backupEntered.resolve();
    await resume.promise;
    return snapshot(options);
  };
  const serialize = slave.serialized.bind(slave);
  slave.serialized = operation => { if (exporting) publicationQueued.resolve(); return serialize(operation); };
  const donor = slave.exportSnapshot({ force: true });
  t.after(() => resume.resolve());
  await bounded(backupEntered.promise, 5000);
  const store = new Store(master.state.value.activeDbPath);
  store.db.exec("INSERT INTO events(type,payload,at) VALUES('fixture','{}',1000)"); store.close();
  const updated = await master.exportSnapshot({ force: true });
  const syncing = slave.synchronize(master.state.claim());
  await bounded(publicationQueued.promise, 5000);
  resume.resolve();
  const exported = await donor; await syncing;
  assert.equal(exported.digest, original.digest);
  assert.equal((await snapshotDigest(join(slave.snapshots.directory, `export-${exported.generation}.sqlite`))).digest, original.digest);
  assert.equal(slave.state.value.role, 'slave');
  assert.equal(slave.sync.state, 'ready');
  assert.equal((await readReplicaPublication(slave.config.snapshotDirectory)).digest, updated.digest);
});
