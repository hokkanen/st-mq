import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/app/config.js';
import { Store } from '../src/storage/store.js';
import { startPaired } from '../src/pairing/runtime.js';
import { startupFailureDiagnostic } from '../src/pairing/manager.js';

const now = Date.parse('2026-01-09T12:00Z');
const failure = code => Object.assign(new Error('synthetic private diagnostic'), { code });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-pair-startup-')), running = new Set();
  t.after(async () => {
    for (const app of running) await app.close();
    await rm(root, { recursive: true, force: true });
  });
  async function open(name, { role = 'primary', releaseError = null, brokerError = null, runtimeError = null,
    reportStartupFailure = null } = {}) {
    const directory = join(root, name);
    const config = { ...loadConfig({ XDG_CONFIG_HOME: root, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, directory),
      input: 'mqtt', role, connections: { mqtt: { address: 'mqtt://127.0.0.1' } } };
    config.pairing = { enabled: true, directory: join(directory, 'pairing'), databasePath: config.dbPath,
      replicaDirectory: config.replication.directory, initialRole: role, platform: 'ubuntu', pairId: 'synthetic-startup-pair',
      token: 'synthetic-startup-shared-token-0123456789', peerUrl: 'http://127.0.0.1:1',
      listenHost: '127.0.0.1', port: 0, intervalMs: 60000, timeoutMs: 30000, vip: {}, mqtt: config.connections.mqtt };
    if (role === 'primary') {
      const store = new Store(config.dbPath);
      try {
        if (!store.observations().length) store.observation({ source: 'synthetic', device: 'invented-room',
          signal: 'indoor_temperature', value: 20, unit: 'degC', sourceTime: now, receivedAt: now });
      } finally { store.close(); }
    }
    let owned = false, error = null, primaryStarts = 0;
    const diagnostics = [];
    const app = await startPaired({ config, clock: () => now, installSignalHandlers: false,
      prepareVipPolicy: async () => {}, validateBroker: async () => { if (brokerError) throw failure(brokerError); },
      // Device I/O is deliberately absent. The real supervisor, peer service,
      // snapshot verifier and protected HTTP viewer still run end to end.
      startRuntime: async ({ config: current }) => {
        primaryStarts++;
        if (runtimeError) throw failure(runtimeError);
        return { store: { path: current.dbPath }, close: async () => {} };
      }, managerOptions: { announcements: () => null,
        reportStartupFailure: diagnostic => { diagnostics.push(diagnostic); return reportStartupFailure?.(diagnostic); }, vip: {
        acquire: async () => { owned = true; error = null; },
        release: async () => {
          if (releaseError) { error = releaseError; throw failure(releaseError); }
          owned = false; error = null;
        },
        status: () => ({ owned, ready: owned && !error, error }),
      } } });
    clearTimeout(app.pairing.timer); await app.pairing.polling; clearTimeout(app.pairing.timer);
    running.add(app);
    return { app, config, diagnostics, primaryStarts: () => primaryStarts };
  }
  return { open, async close(app) { await app.close(); running.delete(app); } };
}

async function status(app) {
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/status`);
  assert.equal(response.status, 200);
  return response.json();
}

test('startup diagnostics expose only a closed public reason and an actual repository source frame', () => {
  const source = new URL('../src/garage/runtime.js', import.meta.url).href;
  const error = { code: 'private-account-code', message: 'synthetic private credentials',
    stack: `Error: synthetic private credentials\n    at GarageRuntime (${source}:87:5)` };
  assert.deepEqual(startupFailureDiagnostic(error, 'runtime_failed'), {
    event: 'paired-startup-failed', reason: 'runtime_failed', location: 'src/garage/runtime.js:87:5',
  });
  assert.deepEqual(startupFailureDiagnostic(error, 'private-account-code'), {
    event: 'paired-startup-failed', reason: 'peer_protocol_failed', location: 'src/garage/runtime.js:87:5',
  });
  for (const stack of [
    'Error: synthetic private credentials',
    'Error: failed\n    at connect (/srv/private-installation/private-client.js:123:45)',
    'Error: failed\n    at connect (/srv/private-installation/src/private-account/client.js:123:45)',
    `Error: failed\n    at connect (${new URL('../node_modules/synthetic-provider/src/private-client.js', import.meta.url).href}:123:45)`,
    `Error: failed\n${source}:87:5`,
    `Error: failed\n    at connect (${source.replace('/src/garage/', '/src/../private-account/')}:87:5)`,
  ]) assert.deepEqual(startupFailureDiagnostic({ ...error, stack }, 'runtime_failed'), {
    event: 'paired-startup-failed', reason: 'runtime_failed',
  });
  const multiline = { ...error, stack: `Error: failed\n/src/private-account/message.js:123:45\n    at GarageRuntime (${source}:87:5)` };
  assert.deepEqual(startupFailureDiagnostic(multiline, 'runtime_failed'), {
    event: 'paired-startup-failed', reason: 'runtime_failed', location: 'src/garage/runtime.js:87:5',
  });
  for (const value of [null, undefined, {}, { stack: 123, message: 'synthetic private credentials' }])
    assert.deepEqual(startupFailureDiagnostic(value, 'vip_policy_mismatch'), {
      event: 'paired-startup-failed', reason: 'vip_policy_mismatch',
    });
});

test('a throwing startup diagnostic sink cannot prevent activation fallback or protected restart', async t => {
  const f = await fixture(t);
  const reportStartupFailure = () => { throw Error('synthetic diagnostic sink failure'); };
  const first = await f.open('controller', { brokerError: 'mqtt_local_required', reportStartupFailure });
  const view = await status(first.app);
  assert.equal(view.readOnly, true);
  assert.equal(view.pairing.role, 'protected');
  assert.equal(view.pairing.error, 'mqtt_local_required');
  assert.equal(first.primaryStarts(), 0);
  assert.deepEqual(first.diagnostics.map(({ event, reason }) => ({ event, reason })),
    [{ event: 'paired-startup-failed', reason: 'mqtt_local_required' }]);
  assert.match(first.diagnostics[0].location, /^src\/pairing\/runtime\.js:\d+:\d+$/);
  assert.doesNotMatch(JSON.stringify(first.diagnostics), /synthetic private|synthetic diagnostic/);
  const dbPath = first.app.pairing.state.value.activeDbPath;
  await f.close(first.app);
  const restarted = await f.open('controller', { releaseError: 'vip_helper_permission', reportStartupFailure });
  const after = await status(restarted.app);
  assert.equal(after.readOnly, true);
  assert.equal(after.pairing.role, 'protected');
  assert.equal(after.pairing.error, 'vip_helper_permission');
  assert.equal(restarted.primaryStarts(), 0);
  assert.deepEqual(restarted.diagnostics.map(({ event, reason }) => ({ event, reason })),
    [{ event: 'paired-startup-failed', reason: 'vip_helper_permission' }]);
  assert.match(restarted.diagnostics[0].location, /^src\/pairing\/manager\.js:\d+:\d+$/);
  assert.doesNotMatch(JSON.stringify(restarted.diagnostics), /synthetic private|synthetic diagnostic/);
  const store = new Store(dbPath, { readOnly: true });
  try { assert.equal(store.observations()[0].value, 20); }
  finally { store.close(); }
});

test('an asynchronously rejecting diagnostic sink cannot interrupt protected fallback', async t => {
  const f = await fixture(t);
  const instance = await f.open('controller', { runtimeError: 'runtime_failed',
    reportStartupFailure: async () => { throw Error('synthetic asynchronous diagnostic sink failure'); } });
  await new Promise(resolve => setImmediate(resolve));
  const view = await status(instance.app);
  assert.equal(view.readOnly, true);
  assert.equal(view.pairing.role, 'protected');
  assert.equal(view.pairing.canControl, false);
  assert.equal(view.pairing.error, 'runtime_failed');
  assert.equal(instance.diagnostics.length, 1);
  assert.doesNotMatch(JSON.stringify(instance.diagnostics), /synthetic asynchronous|synthetic private/);
});

test('a failed activation retains sanitized diagnostics and protected history across supervisor restart', async t => {
  for (const code of ['mqtt_local_required', 'mqtt_resolution_failed', 'runtime_failed']) await t.test(code, async t => {
    const f = await fixture(t);
    const first = await f.open('controller', code === 'runtime_failed' ? { runtimeError: code } : { brokerError: code });
    const before = await status(first.app);
    assert.equal(before.readOnly, true);
    assert.equal(before.pairing.role, 'protected');
    assert.equal(before.pairing.error, code);
    assert.equal(before.pairing.canControl, false);
    assert.equal(before.pairing.actions.promote, true);
    assert.doesNotMatch(JSON.stringify(before), /synthetic private diagnostic/);
    const dbPath = first.app.pairing.state.value.activeDbPath;
    const epoch = first.app.pairing.state.value.epoch;
    await f.close(first.app);
    const restarted = await f.open('controller');
    const after = await status(restarted.app);
    assert.equal(after.pairing.error, code);
    assert.equal(after.pairing.role, 'protected');
    assert.equal(after.pairing.canControl, false);
    assert.equal(restarted.primaryStarts(), 0, 'Fixing configuration must not automatically promote after restart');
    assert.equal(restarted.app.pairing.state.value.activeDbPath, dbPath);
    assert.equal(restarted.app.pairing.state.value.epoch, epoch);
    const store = new Store(dbPath, { readOnly: true });
    try { assert.equal(store.observations().length, 1); assert.equal(store.observations()[0].value, 20); }
    finally { store.close(); }
    await restarted.app.pairing.action('promote', { requestId: randomUUID(), confirmed: true });
    assert.equal(restarted.app.pairing.canControl(), true);
    assert.equal(restarted.app.pairing.status().error, null);
    assert.equal(restarted.app.pairing.state.value.activationError, null);
  });
});

test('a broken release helper leaves protected management and history readable without granting authority', async t => {
  const f = await fixture(t);
  const initial = await f.open('controller', { brokerError: 'mqtt_local_required' });
  const dbPath = initial.app.pairing.state.value.activeDbPath;
  await f.close(initial.app);
  const restarted = await f.open('controller', { releaseError: 'vip_policy_mismatch' });
  const view = await status(restarted.app);
  assert.equal(view.pairing.role, 'protected');
  assert.equal(view.pairing.reason, 'vip_release_failed');
  assert.equal(view.pairing.error, 'vip_policy_mismatch');
  assert.equal(view.pairing.canControl, false);
  assert.equal(view.readOnly, true);
  assert.equal(restarted.primaryStarts(), 0);
  assert.equal(restarted.app.pairing.state.value.activeDbPath, dbPath);
  const base = `http://127.0.0.1:${restarted.app.server.address().port}`;
  assert.equal((await fetch(`${base}/api/pairing`)).status, 200);
  for (const path of ['/api/settings/reload', '/api/garage/native', '/api/database-export'])
    assert.equal((await fetch(`${base}${path}`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/database-export`)).status, 200);
  const store = new Store(dbPath, { readOnly: true });
  try { assert.equal(store.observations().length, 1); assert.equal(store.observations()[0].value, 20); }
  finally { store.close(); }
});

test('a protected accepted replica cannot promote a publication that disagrees with its durable proof', async t => {
  const f = await fixture(t), primary = await f.open('primary'), replica = await f.open('replica', { role: 'replica' });
  replica.app.pairing.peer.peerUrl = `http://127.0.0.1:${primary.app.pairing.peer.server.address().port}`;
  await replica.app.pairing.synchronize(primary.app.pairing.state.claim());
  assert.equal(replica.app.pairing.sync.state, 'ready');
  const accepted = structuredClone(replica.app.pairing.state.value.accepted);
  const dbPath = replica.app.pairing.state.value.activeDbPath;
  for (const patch of [{ digest: 'f'.repeat(64) }, { epoch: randomUUID() }, { nodeId: randomUUID() },
    { sequence: accepted.sequence + 1 }]) {
    await replica.app.pairing.state.update({ role: 'protected', reason: 'replica_verification_failed', accepted: { ...accepted, ...patch } });
    await assert.rejects(replica.app.pairing.action('promote', { requestId: randomUUID(), confirmed: true }), { code: 'verification_failed' });
    assert.equal(replica.app.pairing.state.value.role, 'protected');
    assert.equal(replica.app.pairing.canControl(), false);
    assert.equal(replica.app.pairing.state.value.activeDbPath, dbPath);
    assert.equal(replica.primaryStarts(), 0);
  }
  await replica.app.pairing.state.update({ accepted });
  await replica.app.pairing.action('promote', { requestId: randomUUID(), confirmed: true });
  assert.equal(replica.app.pairing.canControl(), true);
  const store = new Store(replica.app.pairing.state.value.activeDbPath, { readOnly: true });
  try { assert.equal(store.observations().length, 1); assert.equal(store.observations()[0].value, 20); }
  finally { store.close(); }
});

test('an accepted replica protected by helper failure keeps showing accepted history instead of an unused configured database', async t => {
  const f = await fixture(t), primary = await f.open('primary'), replica = await f.open('replica', { role: 'replica' });
  replica.app.pairing.peer.peerUrl = `http://127.0.0.1:${primary.app.pairing.peer.server.address().port}`;
  await replica.app.pairing.synchronize(primary.app.pairing.state.claim());
  assert.equal(replica.app.pairing.sync.state, 'ready');
  await f.close(replica.app);
  // A former configured database is user-owned and can legitimately remain
  // after handover. It is not the accepted replica or a protected donor.
  const leftover = new Store(replica.config.dbPath);
  try { leftover.observation({ source: 'synthetic', device: 'unused-original-room', signal: 'indoor_temperature',
    value: 99, unit: 'degC', sourceTime: now, receivedAt: now }); }
  finally { leftover.close(); }
  const restarted = await f.open('replica', { role: 'replica', releaseError: 'vip_helper_unavailable' });
  assert.equal(restarted.app.pairing.state.value.everWritten, false);
  assert.equal(restarted.app.pairing.state.value.role, 'protected');
  const base = `http://127.0.0.1:${restarted.app.server.address().port}`;
  const response = await fetch(`${base}/api/history?from=${now - 1}&to=${now + 1}`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).map(row => row.value), [20]);
  const preserved = new Store(replica.config.dbPath, { readOnly: true });
  try { assert.equal(preserved.observations()[0].value, 99); }
  finally { preserved.close(); }
});
