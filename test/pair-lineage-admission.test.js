import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { startPaired } from '../src/pairing/runtime.js';
import { Store } from '../src/storage/store.js';
import { peerOperation } from '../src/replication/coalesced.js';
import { fixtureMqttFrontend, fixtureMqttSourceContext } from './helpers/pair-frontend.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-lineage-admission-')), dbPath = join(root, 'synthetic.sqlite');
  const store = new Store(dbPath); let hooks;
  const owner = { state: { value: { role: 'master', epoch: randomUUID(), activeDbPath: dbPath } },
    abort: new AbortController(), activeAllowed: true, closed: false,
    init: async () => {}, start: () => hooks.startPrimary({ dbPath }), prepareShutdown: () => {},
    canControl() { return this.activeAllowed && !this.closed; },
    close() { this.closed = true; this.activeAllowed = false; this.abort.abort(); }, status: () => ({ role: 'master' }) };
  const config = { dbPath, dataDir: root, databaseDir: root, input: 'mqtt', role: 'master', settings: {},
    connections: { mqtt: { address: 'mqtt://127.0.0.1' } }, topology: 'pair',
    pair: { directory: join(root, 'pairing'), snapshotDirectory: join(root, 'snapshots'), vip: {} } };
  const app = await startPaired({ config, installSignalHandlers: false, prepareVipPolicy: async () => {},
    validateBroker: async () => {}, frontendFactory: fixtureMqttFrontend, sourceContextFactory: fixtureMqttSourceContext,
    managerFactory: options => { hooks = options.hooks; return owner; },
    startRuntime: async () => ({ store, close: async () => store.close() }) });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { root, dbPath, store, owner, hooks,
    stamp: () => ({ epoch: owner.state.value.epoch, sequence: 1, token: randomUUID() }) };
}

test('live lineage admission yields to timers during a held writer lock and commits exactly once', async t => {
  const f = await fixture(t), lock = new DatabaseSync(f.dbPath), stamp = f.stamp();
  lock.exec('BEGIN IMMEDIATE');
  let ticks = 0, writes = 0;
  const timer = setInterval(() => ticks++, 10);
  const prepare = f.store.db.prepare.bind(f.store.db);
  t.mock.method(f.store.db, 'prepare', sql => {
    if (sql.includes("VALUES('pairing-lineage'")) writes++;
    return prepare(sql);
  });
  const saving = f.hooks.writeLineage({ dbPath: f.dbPath, value: stamp });
  try {
    await delay(100);
    assert(ticks >= 3, 'SQLite contention must not block the controller thread');
    assert.equal(writes, 0, 'The callback waits for admission');
    assert.equal(f.store.getState('pairing-lineage'), null);
  } finally { clearInterval(timer); lock.exec('ROLLBACK'); lock.close(); }
  await saving;
  assert.equal(writes, 1); assert.deepEqual(f.store.getState('pairing-lineage'), stamp);
});

test('authority revocation rejects an admitted-waiting lineage save without changing the database', async t => {
  const f = await fixture(t), lock = new DatabaseSync(f.dbPath);
  lock.exec('BEGIN IMMEDIATE');
  const saving = assert.rejects(f.hooks.writeLineage({ dbPath: f.dbPath, value: f.stamp() }), { code: 'STORAGE_WRITE_STALE' });
  await delay(30); f.hooks.revokeControl();
  try { await saving; } finally { lock.exec('ROLLBACK'); lock.close(); }
  assert.equal(f.store.getState('pairing-lineage'), null);
});

test('released handover writes its final stamp off-thread after the controlling Store closes', async t => {
  const f = await fixture(t), stamp = f.stamp();
  await f.hooks.stopControl({ restore: true });
  f.owner.activeAllowed = false;
  await assert.rejects(f.hooks.writeLineage({ dbPath: f.dbPath, value: stamp }), { code: 'peer_busy' });
  f.owner.controlReleased = true;
  f.owner.state.value.transition = { kind: 'handover', phase: 'stopping', token: randomUUID() };
  await f.hooks.writeLineage({ dbPath: f.dbPath, value: stamp });
  const saved = new Store(f.dbPath, { readOnly: true });
  try { assert.deepEqual(saved.getState('pairing-lineage'), stamp); } finally { saved.close(); }
});

for (const loss of ['epoch', 'transition']) test(`released handover ${loss} loss cancels and joins its pending worker before a stamp can publish`, async t => {
  const f = await fixture(t), stamp = f.stamp();
  await f.hooks.stopControl({ restore: true });
  f.owner.activeAllowed = false; f.owner.controlReleased = true;
  f.owner.state.value.transition = { kind: 'handover', phase: 'stopping', token: randomUUID() };
  const lock = new DatabaseSync(f.dbPath); lock.exec('BEGIN IMMEDIATE');
  const saving = assert.rejects(f.hooks.writeLineage({ dbPath: f.dbPath, value: stamp }), { code: 'authority_changed' });
  try {
    await delay(50);
    if (loss === 'epoch') f.owner.state.value.epoch = randomUUID();
    else f.owner.state.value.transition.token = randomUUID();
    await delay(30);
  } finally { lock.exec('ROLLBACK'); lock.close(); }
  await saving;
  const saved = new Store(f.dbPath, { readOnly: true });
  try { assert.equal(saved.getState('pairing-lineage'), null); } finally { saved.close(); }
});

test('invalid off-thread lineage payload rejects before creating a database', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stmq-invalid-lineage-')), dbPath = join(root, 'absent.sqlite');
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const value of [
    { epoch: '-'.repeat(36), sequence: 1, token: randomUUID() },
    Object.assign([], { epoch: randomUUID(), sequence: 1, token: randomUUID() }),
    { epoch: new String(randomUUID()), sequence: 1, token: randomUUID() },
    { epoch: randomUUID(), sequence: 1, token: new String(randomUUID()) },
  ]) {
    await assert.rejects(peerOperation('lineage', { dbPath, at: 1, value }), { code: 'journal_peer_invalid' });
    await assert.rejects(access(dbPath), { code: 'ENOENT' });
  }
});
