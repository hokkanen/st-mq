import { fixtureMqttFrontend, fixtureMqttSourceContext } from './helpers/pair-frontend.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { Store, SCHEMA_VERSION } from '../src/storage/store.js';
import * as resetStorage from '../src/pairing/reset-storage.js';
import { resetFailureDiagnostic } from '../src/pairing/runtime.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pair-reset-')), apps = new Set();
  t.after(async () => { for (const app of apps) await app.close(); await rm(root, { recursive: true, force: true }); });
  const directory = join(root, 'data');
  const config = { ...loadConfig({ XDG_CONFIG_HOME: root, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, root),
    input: 'mqtt', role: 'slave', topology: 'pair', connections: { mqtt: { address: 'mqtt://127.0.0.1' } } };
  config.charging.vehicles.bmw.mqttTopic = '';
  config.garage = { ...config.garage, enabled: false, adapter: {}, sender: {} };
  config.pair = { directory: join(directory, 'pairing'), databasePath: config.dbPath,
    snapshotDirectory: join(directory, 'pair-snapshots'), platform: 'ubuntu', pairId: 'synthetic-reset-pair',
    token: 'synthetic-reset-shared-token-0123456789', peerUrl: 'http://127.0.0.1:1', listenHost: '127.0.0.1',
    port: 0, intervalMs: 60000, timeoutMs: 30000, vip: {}, mqtt: config.connections.mqtt };
  return { root, config, async open(options = {}) {
    let owned = false;
    const app = await start({ config, installSignalHandlers: false, providerOptions: { automatic: false },
      mqttOptions: { connect: () => { throw Error('Unexpected MQTT connection in a paired storage fixture'); } },
      pairOptions: { frontendFactory: fixtureMqttFrontend, sourceContextFactory: fixtureMqttSourceContext, validateBroker: async () => {}, prepareVipPolicy: async () => {}, ...options,
        managerOptions: { announcements: () => null, vip: {
          acquire: async () => { owned = true; }, release: async () => { owned = false; }, status: () => ({ owned }) } } } });
    apps.add(app); return app;
  }, async close(app) { await app.close(); apps.delete(app); } };
}

const command = (app, mode, extra = {}) => ({ action: 'reset', nodeId: app.status().nodeId, mode, requestId: app.status().reset.pendingRequestId ?? randomUUID(), confirmed: true,
  resetToken: app.status().reset.token, ...(mode === 'fresh' ? { restorationConfirmed: true, backup: true } : {}), ...extra });
async function completed(app, input) {
  app.requestAction(input);
  for (let i = 0; i < 1000; i++) {
    const op = app.status().uiOperation;
    if (op.state !== 'running') return op;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Reset did not settle');
}
async function promote(app) { await app.pair.action('promote', { requestId: randomUUID(), confirmed: true }); }

test('reset diagnostics bound aggregate failures and reuse private-safe source and reason filtering', () => {
  const source = new URL('../src/storage/journal.js', import.meta.url).href;
  const known = Object.assign(new Error('synthetic private database value'), { code: 'database_journal_invalid',
    stack: `Error: synthetic private database value\n    at fail (${source}:17:42)` });
  const privateError = Object.assign(new Error('synthetic private credentials'), { code: 'private-account-code',
    stack: 'Error: synthetic private credentials\n    at connect (/private/installation/account.js:19:2)' });
  const aggregate = new AggregateError([known, new AggregateError([privateError], 'private nested value')], 'private top value');
  assert.deepEqual(resetFailureDiagnostic(aggregate, 'stop-control'), {
    event: 'paired-reset-failed', stage: 'stop-control', failures: [
      { reason: 'database_journal_invalid', location: 'src/storage/journal.js:17:42' },
      { reason: 'peer_protocol_failed' },
    ],
  });
  aggregate.errors.push(aggregate);
  assert.equal(resetFailureDiagnostic(aggregate, 'private stage').stage, 'unknown');
  const many = new AggregateError(Array.from({ length: 100 }, () => new Error('private leaf')), 'private aggregate');
  assert.equal(resetFailureDiagnostic(many, 'archive').failures.length, 8);
  assert.equal(resetFailureDiagnostic({ code: 'pair_reset_restoration_required' }, 'check-restoration')
    .failures[0].reason, 'pair_reset_restoration_required');
  assert.doesNotMatch(JSON.stringify(resetFailureDiagnostic(aggregate, 'stop-control')), /private|credentials|installation|account/);
});

for (const asyncSink of [false, true]) test(`shutdown failure reports safe reset diagnostics and preserves protection when the sink ${asyncSink ? 'rejects' : 'throws'}`, async t => {
  const f = await fixture(t), diagnostics = [];
  const store = new Store(f.config.dbPath);
  store.event('synthetic-preserved-after-close-failure', { value: 1 }, 1); store.close();
  const leaf = Object.assign(new Error('synthetic private shutdown detail'), { code: 'database_journal_invalid',
    stack: `Error: synthetic private shutdown detail\n    at fail (${new URL('../src/storage/journal.js', import.meta.url).href}:17:42)` });
  const app = await f.open({ startRuntime: async ({ config }) => ({ store: { path: config.dbPath },
    close: async () => { throw new AggregateError([leaf], 'synthetic private aggregate'); } }),
  reportResetFailure: diagnostic => {
    diagnostics.push(diagnostic);
    if (asyncSink) return Promise.reject(new Error('synthetic private diagnostic sink'));
    throw new Error('synthetic private diagnostic sink');
  } });
  await promote(app);
  const op = await completed(app, command(app, 'fresh'));
  assert.equal(op.state, 'error'); assert.equal(op.errorCode, 'pair_reset_failed');
  assert.equal(app.status().role, 'protected'); assert.equal(app.pair.canControl(), false);
  assert.equal(app.pair.state.value.reset, undefined, 'failed shutdown must not begin an archive');
  assert.deepEqual(diagnostics, [{ event: 'paired-reset-failed', stage: 'stop-control', failures: [
    { reason: 'database_journal_invalid', location: 'src/storage/journal.js:17:42' },
  ] }]);
  assert.doesNotMatch(JSON.stringify({ diagnostics, op }), /synthetic private|aggregate|\/private\//);
  const preserved = new Store(f.config.dbPath, { readOnly: true });
  try { assert.equal(preserved.db.prepare("SELECT COUNT(*) n FROM events WHERE type='synthetic-preserved-after-close-failure'").get().n, 1); }
  finally { preserved.close(); }
});

test('keep history clears previous pairing identity in place and returns a master as protected without losing records', async t => {
  const f = await fixture(t), app = await f.open(); await promote(app);
  await app.store.runWrite(() => app.store.event('synthetic-reset-evidence', { value: 7 }, Date.now()));
  const previousId = app.pair.state.value.nodeId;
  const op = await completed(app, command(app, 'keep'));
  assert.equal(op.state, 'complete', op.error);
  assert.equal(op.result.backupCount, 0);
  assert.equal(op.result.unavailableCount, 0);
  assert.deepEqual(op.result.unavailableReasons, []);
  assert.equal(app.pair.canControl(), false);
  assert.equal(app.status().role, 'protected');
  assert.equal(app.status().reason, 'pairing_reset');
  assert.notEqual(app.pair.state.value.nodeId, previousId);
  const kept = new Store(app.pair.state.value.activeDbPath, { readOnly: true });
  assert.equal(kept.db.prepare("SELECT count(*) AS n FROM events WHERE type='synthetic-reset-evidence'").get().n, 1);
  kept.close();
  assert.equal(op.result.archiveDirectory, null);
  assert.equal(app.pair.state.value.activeDbPath, f.config.dbPath);
  await assert.rejects(readdir(resetStorage.archiveRoot(f.config)), { code: 'ENOENT' });
  await f.close(app); const restarted = await f.open();
  assert.equal(restarted.status().role, 'protected');
  assert.equal(restarted.status().reset.lastResult.archiveDirectory, op.result.archiveDirectory);
  assert.equal(restarted.pair.canControl(), false);
  await promote(restarted);
  assert.equal(restarted.pair.canControl(), true, 'retained history requires a new explicit promotion');
  assert.equal(restarted.store.db.prepare("SELECT count(*) AS n FROM events WHERE type='synthetic-reset-evidence'").get().n, 1);
});

test('fresh archives an incompatible database intact, keeps provider files, and does not recreate an authoritative database', async t => {
  const f = await fixture(t); await mkdir(f.config.dataDir, { recursive: true });
  const db = new DatabaseSync(f.config.dbPath); db.exec('CREATE TABLE old_history(value); INSERT INTO old_history VALUES (19); PRAGMA user_version=18'); db.close();
  const original = await readFile(f.config.dbPath);
  const provider = join(f.config.dataDir, 'provider-token.json'); await writeFile(provider, '{"synthetic":true}');
  const app = await f.open(); assert.equal(app.status().error, 'database_schema_mismatch');
  const request = command(app, 'fresh'); const op = await completed(app, request);
  assert.equal(op.state, 'complete', op.error);
  assert.equal(op.result.backupCount, 0);
  assert.equal(op.result.unavailableCount, 1);
  assert.deepEqual(op.result.unavailableReasons, ['incompatible-database']);
  assert.equal(app.status().role, 'slave'); assert.equal(app.status().bootstrapPending, true);
  assert.equal(app.status().error, null); assert.equal(app.pair.canControl(), false);
  await assert.rejects(readFile(f.config.dbPath), { code: 'ENOENT' });
  assert.equal(await readFile(provider, 'utf8'), '{"synthetic":true}');
  const files = await recursiveFiles(op.result.archiveDirectory);
  const databases = files.filter(file => file.endsWith('.sqlite'));
  assert.ok((await Promise.all(databases.map(file => readFile(file)))).some(bytes => bytes.equals(original)));
  await f.close(app); const restarted = await f.open();
  const before = await readdir(resetStorage.archiveRoot(f.config));
  const receipt = await (await fetch(`http://127.0.0.1:${restarted.server.address().port}/api/pair/action?nodeId=${restarted.status().nodeId}&requestId=${request.requestId}`)).json();
  assert.equal(receipt.state, 'complete');
  assert.equal(receipt.action, 'reset');
  assert.deepEqual(await readdir(resetStorage.archiveRoot(f.config)), before, 'retry after restart does not reset again');
  await promote(restarted);
  assert.equal(restarted.store.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.ok((await Promise.all(databases.map(file => readFile(file)))).some(bytes => bytes.equals(original)), 'promotion leaves the old database archive unchanged');
});

async function recursiveFiles(root) {
  const files = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) files.push(...await recursiveFiles(path)); else files.push(path);
  }
  return files;
}

test('interrupted archive stays protected across restart and only a confirmed retry finishes it', async t => {
  const f = await fixture(t), app = await f.open({ resetStorage: { ...resetStorage,
    resumeResetArchive: async () => { throw Error('synthetic disk failure'); } } });
  await promote(app);
  const op = await completed(app, command(app, 'fresh'));
  assert.equal(op.state, 'error'); assert.equal(app.status().role, 'protected');
  assert.equal(app.status().reset.pendingMode, 'fresh');
  await assert.rejects(app.pair.action('promote', { requestId: randomUUID(), confirmed: true }), { code: 'protected_history' });
  await assert.rejects(app.pair.handlePeer('snapshot', {}), { code: 'protected_history' });
  const archive = app.pair.state.value.reset.archiveDirectory;
  await f.close(app); const restarted = await f.open();
  assert.equal(restarted.status().role, 'protected');
  assert.equal(restarted.pair.state.value.reset.archiveDirectory, archive);
  assert.throws(() => restarted.requestAction(command(restarted, 'keep')), /original choice/);
  assert.throws(() => restarted.requestAction(command(restarted, 'fresh', { backup: false, discardConfirmed: true })), /original choice/);
  const retry = await completed(restarted, command(restarted, 'fresh'));
  assert.equal(retry.state, 'complete', retry.error);
  assert.equal(retry.result.archiveDirectory, archive);
  assert.equal(restarted.status().role, 'slave');
});

test('reset rejects missing confirmation, unknown fields, and a stale review before stopping control', async t => {
  const f = await fixture(t), app = await f.open(); const stale = command(app, 'keep'); await promote(app);
  assert.throws(() => app.requestAction(stale), /changed/);
  assert.throws(() => app.requestAction(command(app, 'fresh', { restorationConfirmed: false })), /paired action/);
  assert.throws(() => app.requestAction(command(app, 'keep', { confirmed: false })), /Confirm/);
  assert.throws(() => app.requestAction(command(app, 'keep', { unexpected: true })), /paired action/);
  assert.equal(app.pair.canControl(), true);
});

for (const backup of [true, false]) test(`fresh cannot erase a recorded equipment restoration obligation with backup=${backup}`, async t => {
  const f = await fixture(t);
  const db = new Store(f.config.dbPath);
  db.setState('equipment-tests:v1', { version: 1, active: { deviceId: 'synthetic-switch', signature: 'a'.repeat(64),
    on: true, previousOn: false, requestedAt: 1000, until: 2000, status: 'restoration-pending' } }); db.close();
  const app = await f.open();
  const op = await completed(app, command(app, 'fresh', { backup, ...(!backup ? { discardConfirmed: true } : {}) }));
  assert.equal(op.state, 'error'); assert.match(op.error, /still require restoration/);
  assert.equal(app.status().role, 'protected');
  const saved = new Store(f.config.dbPath, { readOnly: true });
  assert.ok(saved.getState('equipment-tests:v1').active); saved.close();
  assert.equal(app.pair.state.value.reset, undefined);
});

test('unreadable pairing state serves the protected reset GUI without rewriting rejected bytes', async t => {
  const f = await fixture(t), initial = await f.open(); await f.close(initial);
  const path = join(f.config.pair.directory, 'state.json'), rejected = '{"obsolete":true, broken';
  await writeFile(path, rejected);
  const app = await f.open();
  assert.equal(app.status().role, 'protected');
  assert.equal(app.status().error, 'invalid_pair_state');
  assert.equal(app.status().reset.keepBlockedReason, 'invalid_pair_state');
  assert.equal(await readFile(path, 'utf8'), rejected);
  assert.equal(app.status().actions.promote, false);
  assert.throws(() => app.requestAction(command(app, 'keep')), /unreadable/);
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/pair`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).actions.reset, true);
  const op = await completed(app, command(app, 'fresh'));
  assert.equal(op.state, 'complete', op.error);
  assert.equal(app.status().role, 'slave');
  assert.equal(await readFile(join(op.result.archiveDirectory, 'pairing', 'state.json'), 'utf8'), rejected);
});

test('reset endpoint requires admin access even on a protected database', async t => {
  const f = await fixture(t);
  f.config.token = 'synthetic-admin-reset-token-0123456789';
  f.config.familyToken = 'synthetic-family-reset-token-0123456789';
  const app = await f.open(), body = command(app, 'fresh');
  const endpoint = `http://127.0.0.1:${app.server.address().port}/api/pair/action`;
  for (const token of ['', f.config.familyToken]) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json',
      Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    assert.ok([401, 403].includes(response.status));
  }
  assert.equal(app.pair.state.value.resetReceipt, undefined);
});

test('keeping incompatible history retains it in place without making the obsolete format usable', async t => {
  const f = await fixture(t); await mkdir(f.config.dataDir, { recursive: true });
  const db = new DatabaseSync(f.config.dbPath); db.exec('CREATE TABLE old_history(value); PRAGMA user_version=18'); db.close();
  const original = await readFile(f.config.dbPath), app = await f.open();
  const op = await completed(app, command(app, 'keep'));
  assert.equal(op.state, 'complete', op.error);
  assert.equal(app.status().role, 'protected');
  assert.equal(app.status().error, 'database_schema_mismatch');
  assert.equal(app.pair.canControl(), false);
  assert.deepEqual(await readFile(app.pair.state.value.activeDbPath), original);
});

test('a linked data directory supports keep, explicit promotion, then fresh reset without changing the alias', async t => {
  const f = await fixture(t), physical = f.config.dataDir, alias = join(f.root, 'var');
  await mkdir(physical); await symlink(physical, alias);
  f.config.dataDir = alias; f.config.databaseDir = alias; f.config.dbPath = join(alias, 'st-mq.sqlite');
  Object.assign(f.config.pair, { directory: join(alias, 'pairing'), snapshotDirectory: join(alias, 'pair-snapshots'),
    databasePath: f.config.dbPath });
  const app = await f.open(); await promote(app);
  await app.store.runWrite(() => app.store.event('synthetic-linked-storage', { value: 3 }, Date.now()));
  const kept = await completed(app, command(app, 'keep'));
  assert.equal(kept.state, 'complete', kept.error);
  assert.equal(app.pair.state.value.activeDbPath, join(physical, 'st-mq.sqlite'));
  assert.equal(app.status().role, 'protected');
  await promote(app);
  assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='synthetic-linked-storage'").get().n, 1);
  const fresh = await completed(app, command(app, 'fresh'));
  assert.equal(fresh.state, 'complete', fresh.error);
  assert.equal(app.status().role, 'slave');
  assert.equal(app.status().bootstrapPending, true);
  assert.equal(fresh.result.archiveDirectory.startsWith(join(physical, 'backups', 'reset-archives') + '/'), true);
  assert.equal((await readdir(join(alias, 'backups', 'reset-archives'))).length, 1);
  await assert.rejects(readFile(f.config.dbPath), { code: 'ENOENT' });
});

for (const mode of ['keep', 'fresh']) test(`${mode} fast reset never invokes archival and preserves existing independent backups`, async t => {
  const f = await fixture(t);
  const store = new Store(f.config.dbPath); store.event('synthetic-fast-history', {}, 10); store.close();
  const backups = resetStorage.archiveRoot(f.config);
  await mkdir(backups, { recursive: true }); await writeFile(join(backups, 'old-copy.sqlite'), 'independent backup');
  const app = await f.open({ resetStorage: { ...resetStorage,
    createResetArchive: () => { throw Error('Fast reset must not hash or archive history'); },
    resumeResetArchive: () => { throw Error('Fast reset must not create portable backups'); } } });
  const before = app.pair.state.value.activeDbPath;
  const input = command(app, mode, mode === 'fresh' ? { backup: false, discardConfirmed: true } : {});
  const op = await completed(app, input);
  assert.equal(op.state, 'complete', op.error);
  assert.equal(op.result.archiveDirectory, null); assert.equal(op.result.backup, false);
  assert.equal(await readFile(join(backups, 'old-copy.sqlite'), 'utf8'), 'independent backup');
  assert.equal(app.pair.canControl(), false);
  if (mode === 'keep') assert.equal(app.pair.state.value.activeDbPath, before);
  else await assert.rejects(readFile(before), { code: 'ENOENT' });
  await f.close(app); const restarted = await f.open();
  assert.equal(restarted.status().role, mode === 'keep' ? 'protected' : 'slave');
  const response = await fetch(`http://127.0.0.1:${restarted.server.address().port}/api/pair/action?nodeId=${input.nodeId}&requestId=${input.requestId}`);
  assert.equal(response.status, 200); assert.equal((await response.json()).state, 'complete', 'original computer identity resolves after reset/restart');
});

test('fresh rejects absent backup choice and missing destructive consent without stopping the runtime', async t => {
  const f = await fixture(t), app = await f.open(); await promote(app);
  const input = command(app, 'fresh');
  for (const extra of [{ backup: undefined }, { backup: false }, { backup: false, discardConfirmed: false },
    { backup: true, discardConfirmed: true }, { backup: 'false' }]) {
    assert.throws(() => app.requestAction({ ...input, ...extra }), /paired action/);
    assert.equal(app.pair.canControl(), true);
  }
  assert.throws(() => app.requestAction(command(app, 'keep', { backup: false })), /paired action/);
});

test('slow fresh backup keeps the same authenticated listeners and progress available without a database', async t => {
  const f = await fixture(t);
  f.config.token = 'synthetic-reset-progress-admin-token'; f.config.familyToken = 'synthetic-reset-progress-family-token';
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const app = await f.open({ resetStorage: { ...resetStorage,
    resumeResetArchive: async (directory, options) => {
      options.onProgress({ phase: 'reset-backup', processed: 0, total: 1 });
      entered(); await gate;
      return resetStorage.resumeResetArchive(directory, options);
    } } });
  await promote(app);
  const endpoint = `http://127.0.0.1:${app.server.address().port}`;
  const input = command(app, 'fresh');
  const headers = token => ({ Authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const accepted = await fetch(`${endpoint}/api/pair/action`, { method: 'POST', headers: headers(f.config.token), body: JSON.stringify(input) });
  assert.equal(accepted.status, 202); await accepted.json(); await started;
  assert.equal(app.store, undefined, 'database runtime has closed while listeners stay available');
  for (let i = 0; i < 4; i++) {
    for (const token of [f.config.token, f.config.familyToken]) {
      const response = await fetch(`${endpoint}/api/pair`, { headers: headers(token), signal: AbortSignal.timeout(1500) });
      assert.equal(response.status, 200);
      const status = await response.json();
      assert.equal(status.canControl, false); assert.equal(status.uiOperation.state, 'running');
      assert.equal(status.uiOperation.progress.phase, 'reset-backup'); assert.equal(status.uiOperation.progress.total, 1);
      assert.equal(status.webAccess.role, token === f.config.token ? 'admin' : 'family');
    }
  }
  const denied = await fetch(`${endpoint}/api/pair`); assert.equal(denied.status, 401);
  const familyWrite = await fetch(`${endpoint}/api/pair/action`, { method: 'POST', headers: headers(f.config.familyToken), body: JSON.stringify(input) });
  assert.equal(familyWrite.status, 403);
  const database = await fetch(`${endpoint}/api/status`, { headers: headers(f.config.token) }); assert.equal(database.status, 503);
  const receipt = await fetch(`${endpoint}/api/pair/action?nodeId=${input.nodeId}&requestId=${input.requestId}`, { headers: headers(f.config.token) });
  assert.equal((await receipt.json()).state, 'running');
  assert.throws(() => app.requestAction({ ...input, backup: false, discardConfirmed: true }), /another action/);
  release();
  for (let i = 0; i < 1000 && app.status().uiOperation.state === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(app.status().uiOperation.state, 'complete', app.status().uiOperation.error);
  assert.equal(app.status().reset.lastResult.backupCount, 1);
});

test('interrupted discard preserves consent and requires an explicit identical retry after restart', async t => {
  const f = await fixture(t), store = new Store(f.config.dbPath); store.close();
  const app = await f.open({ resetStorage: { ...resetStorage, resumeLocalReset: async () => { throw Error('synthetic interrupted discard'); } } });
  const input = command(app, 'fresh', { backup: false, discardConfirmed: true });
  assert.equal((await completed(app, input)).state, 'error');
  const pending = app.pair.state.value.reset;
  assert.equal(pending.backup, false); assert.equal(pending.requestId, input.requestId);
  await f.close(app); const restarted = await f.open();
  assert.equal(restarted.status().role, 'protected');
  const interruptedReceipt = await fetch(`http://127.0.0.1:${restarted.server.address().port}/api/pair/action?nodeId=${input.nodeId}&requestId=${input.requestId}`);
  const interruptedStatus = await interruptedReceipt.json();
  assert.equal(interruptedStatus.state, 'error'); assert.equal(interruptedStatus.action, 'reset');
  assert.throws(() => restarted.requestAction(command(restarted, 'fresh')), /original choice/);
  assert.throws(() => restarted.requestAction(command(restarted, 'fresh', { backup: false, discardConfirmed: true, requestId: randomUUID() })), /original request ID/);
  const retry = await completed(restarted, command(restarted, 'fresh', { backup: false, discardConfirmed: true }));
  assert.equal(retry.state, 'complete', retry.error);
  assert.equal(restarted.status().role, 'slave');
});

for (const backup of [true, false]) test(`interrupted file inspection retains reset consent before a storage plan exists, backup=${backup}`, async t => {
  const f = await fixture(t), store = new Store(f.config.dbPath); store.event('synthetic-before-inspection', {}, 10); store.close();
  const stop = async () => { throw Error('synthetic inspection interrupted'); };
  const app = await f.open({ resetStorage: { ...resetStorage, createResetArchive: stop, createLocalReset: stop } });
  const input = command(app, 'fresh', { backup, ...(!backup ? { discardConfirmed: true } : {}) });
  const op = await completed(app, input);
  assert.equal(op.state, 'error'); assert.equal(app.status().role, 'protected');
  assert.equal(app.pair.state.value.reset.backup, backup);
  assert.equal(app.pair.state.value.reset.archiveDirectory, null); assert.equal(app.pair.state.value.reset.storagePlan, null);
  await f.close(app); const restarted = await f.open();
  assert.equal(restarted.status().reset.pendingRequestId, input.requestId);
  const result = await completed(restarted, command(restarted, 'fresh', { backup, ...(!backup ? { discardConfirmed: true } : {}) }));
  assert.equal(result.state, 'complete', result.error); assert.equal(restarted.status().role, 'slave');
});
