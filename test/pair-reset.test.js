import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { Store } from '../src/storage/store.js';
import * as resetStorage from '../src/pairing/reset-storage.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pair-reset-')), apps = new Set();
  t.after(async () => { for (const app of apps) await app.close(); await rm(root, { recursive: true, force: true }); });
  const directory = join(root, 'data');
  const config = { ...loadConfig({ XDG_CONFIG_HOME: root, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, root),
    input: 'mqtt', role: 'slave', topology: 'pair', connections: { mqtt: { address: 'mqtt://127.0.0.1' } } };
  config.pair = { directory: join(directory, 'pairing'), databasePath: config.dbPath,
    snapshotDirectory: join(directory, 'pair-snapshots'), platform: 'ubuntu', pairId: 'synthetic-reset-pair',
    token: 'synthetic-reset-shared-token-0123456789', peerUrl: 'http://127.0.0.1:1', listenHost: '127.0.0.1',
    port: 0, intervalMs: 60000, timeoutMs: 30000, vip: {}, mqtt: config.connections.mqtt };
  return { root, config, async open(options = {}) {
    let owned = false;
    const app = await start({ config, installSignalHandlers: false, providerOptions: { automatic: false },
      pairOptions: { validateBroker: async () => {}, prepareVipPolicy: async () => {}, ...options,
        managerOptions: { announcements: () => null, vip: {
          acquire: async () => { owned = true; }, release: async () => { owned = false; }, status: () => ({ owned }) } } } });
    apps.add(app); return app;
  }, async close(app) { await app.close(); apps.delete(app); } };
}

const command = (app, mode, extra = {}) => ({ action: 'reset', mode, requestId: randomUUID(), confirmed: true,
  resetToken: app.status().reset.token, ...(mode === 'fresh' ? { restorationConfirmed: true } : {}), ...extra });
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

test('keep history archives previous pairing identity and returns a master as protected without losing records', async t => {
  const f = await fixture(t), app = await f.open(); await promote(app);
  app.store.event('synthetic-reset-evidence', { value: 7 }, Date.now());
  const previousId = app.pair.state.value.nodeId;
  const op = await completed(app, command(app, 'keep'));
  assert.equal(op.state, 'complete', op.error);
  assert.equal(app.pair.canControl(), false);
  assert.equal(app.status().role, 'protected');
  assert.equal(app.status().reason, 'pairing_reset');
  assert.notEqual(app.pair.state.value.nodeId, previousId);
  const kept = new Store(app.pair.state.value.activeDbPath, { readOnly: true });
  assert.equal(kept.db.prepare("SELECT count(*) AS n FROM events WHERE type='synthetic-reset-evidence'").get().n, 1);
  kept.close();
  const archivedState = JSON.parse(await readFile(join(op.result.archiveDirectory, 'pairing', 'state.json')));
  assert.equal(archivedState.nodeId, previousId);
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
  assert.equal(app.status().role, 'slave'); assert.equal(app.status().bootstrapPending, true);
  assert.equal(app.status().error, null); assert.equal(app.pair.canControl(), false);
  await assert.rejects(readFile(f.config.dbPath), { code: 'ENOENT' });
  assert.equal(await readFile(provider, 'utf8'), '{"synthetic":true}');
  const files = await recursiveFiles(op.result.archiveDirectory);
  const databases = files.filter(file => file.endsWith('.sqlite'));
  assert.ok((await Promise.all(databases.map(file => readFile(file)))).some(bytes => bytes.equals(original)));
  await f.close(app); const restarted = await f.open();
  const before = await readdir(resetStorage.archiveRoot(f.config));
  restarted.requestAction(request);
  assert.equal(restarted.status().uiOperation.state, 'complete');
  assert.deepEqual(await readdir(resetStorage.archiveRoot(f.config)), before, 'retry after restart does not reset again');
  await promote(restarted);
  assert.equal(restarted.store.db.prepare('PRAGMA user_version').get().user_version, 19);
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

test('fresh cannot erase a recorded equipment restoration obligation even with confirmation', async t => {
  const f = await fixture(t);
  const db = new Store(f.config.dbPath);
  db.setState('equipment-tests:v1', { version: 1, active: { synthetic: 'outstanding obligation' } }); db.close();
  const app = await f.open();
  const op = await completed(app, command(app, 'fresh'));
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

test('keeping incompatible history archives it without making the obsolete format usable', async t => {
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
  app.store.event('synthetic-linked-storage', { value: 3 }, Date.now());
  const kept = await completed(app, command(app, 'keep'));
  assert.equal(kept.state, 'complete', kept.error);
  assert.equal(app.pair.state.value.activeDbPath, join(physical, 'pairing', 'kept-history.sqlite'));
  assert.equal(app.status().role, 'protected');
  await promote(app);
  assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='synthetic-linked-storage'").get().n, 1);
  const fresh = await completed(app, command(app, 'fresh'));
  assert.equal(fresh.state, 'complete', fresh.error);
  assert.equal(app.status().role, 'slave');
  assert.equal(app.status().bootstrapPending, true);
  assert.equal(fresh.result.archiveDirectory.startsWith(join(physical, 'reset-archives') + '/'), true);
  assert.equal((await readdir(join(alias, 'reset-archives'))).length, 2);
  await assert.rejects(readFile(f.config.dbPath), { code: 'ENOENT' });
});
