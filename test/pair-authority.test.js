import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PairManager } from '../src/pairing/manager.js';
import { readReplicaPublication } from '../src/replication/publication.js';
import { acceptsLineage, compareAuthority, PairState } from '../src/pairing/state.js';

function createDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL); CREATE TABLE readings(at INTEGER PRIMARY KEY,value REAL); INSERT INTO readings VALUES(100,20)');
  db.close();
}

async function manager(t, root, name, { role = 'primary', platform = 'ubuntu', create = role === 'primary', hooks = {} } = {}) {
  const path = join(root, `${name}.sqlite`);
  if (create) createDatabase(path);
  const config = { enabled: true, directory: join(root, name), replicaDirectory: join(root, `${name}-replica`),
    databasePath: path, pairId: 'fixture-pair', token: 'synthetic-authority-token-0123456789abcdef',
    initialRole: role, platform, listenHost: '127.0.0.1', port: 0, peerUrl: 'http://127.0.0.1:1',
    timeoutMs: 30000, intervalMs: 60000, vip: {} };
  let owned = false;
  const calls = [];
  const result = new PairManager({ config, announcements: () => null,
    vip: { acquire: async () => { owned = true; }, release: async () => { owned = false; }, status: () => ({ owned, ready: owned }) },
    hooks: { startPrimary: async value => calls.push(['primary', value.dbPath]), startReplica: async value => calls.push(['replica', value.role]),
      stopControl: async value => calls.push(['stop', value.restore, result.canControl()]), closeReplica: async () => {}, ...hooks } });
  await result.init(); await result.start(); clearTimeout(result.timer);
  t.after(() => result.close());
  result.calls = calls;
  return result;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-pair-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const command = () => ({ requestId: randomUUID(), confirmed: true });
function connect(left, right) {
  left.peer.peerUrl = `http://127.0.0.1:${right.peer.server.address().port}`;
  right.peer.peerUrl = `http://127.0.0.1:${left.peer.server.address().port}`;
}

test('Hassio wins active claims regardless of promotion order; equal platforms agree by stable node ID', () => {
  const first = { nodeId: randomUUID(), epoch: randomUUID(), role: 'primary', platform: 'hassio', sequence: 0 };
  const second = { nodeId: randomUUID(), epoch: randomUUID(), role: 'primary', platform: 'ubuntu', sequence: 10000 };
  assert.ok(compareAuthority(first, second) > 0);
  assert.ok(compareAuthority(second, first) < 0);
  first.platform = 'ubuntu';
  assert.equal(Math.sign(compareAuthority(first, second)), -Math.sign(compareAuthority(second, first)));
});

test('unknown existing history starts protected and durable state refuses concurrent ownership', async t => {
  const root = await fixture(t), databasePath = join(root, 'existing.sqlite'); createDatabase(databasePath);
  const options = { directory: join(root, 'state'), pairId: 'fixture', platform: 'ubuntu', initialRole: 'replica', databasePath };
  const state = new PairState(options); await state.open();
  assert.equal(state.value.role, 'protected');
  const nodeId = state.value.nodeId;
  await assert.rejects(new PairState(options).open(), { code: 'pair_already_running' });
  await state.close();
  const restarted = new PairState(options); await restarted.open();
  assert.equal(restarted.value.nodeId, nodeId); assert.equal(restarted.value.role, 'protected');
  await restarted.close();
});

test('no peer availability promotes a replica or stops an active master', async t => {
  const root = await fixture(t);
  const primary = await manager(t, root, 'primary');
  const replica = await manager(t, root, 'replica', { role: 'replica' });
  await primary.poll(); await replica.poll();
  assert.equal(primary.canControl(), true); assert.equal(replica.state.value.role, 'replica');
  assert.equal(replica.canControl(), false);
});

test('loser disables control before stopping, keeps original history and remains protected after restart', async t => {
  const root = await fixture(t), winner = await manager(t, root, 'hassio', { platform: 'hassio' });
  const loser = await manager(t, root, 'ubuntu');
  await loser.observeClaim(winner.state.claim());
  assert.equal(loser.state.value.role, 'protected');
  assert.deepEqual(loser.calls.find(call => call[0] === 'stop'), ['stop', false, false]);
  assert.equal(winner.canControl(), true);
  await loser.close();
  const restarted = new PairState(loser.config); await restarted.open();
  assert.equal(restarted.value.role, 'protected'); assert.equal(restarted.value.activeDbPath, loser.config.databasePath);
  await restarted.close();
});

test('graceful handover commits final snapshot, demotion survives restart and later promotion uses current replica', async t => {
  const root = await fixture(t), left = await manager(t, root, 'hassio', { platform: 'hassio' });
  const right = await manager(t, root, 'ubuntu', { role: 'replica' }); connect(left, right);
  await right.synchronize(left.state.claim());
  assert.equal(right.sync.state, 'ready');
  await left.action('handover', command());
  assert.equal(left.state.value.role, 'replica'); assert.equal(right.state.value.role, 'primary');
  assert.deepEqual(left.calls.find(call => call[0] === 'stop'), ['stop', true, true]);
  assert.equal(acceptsLineage(left.state.value.accepted, right.state.claim()), true);
  await left.synchronize(right.state.claim());
  assert.equal(left.sync.state, 'ready');
  const oldDb = left.config.databasePath;
  await left.action('promote', command());
  assert.notEqual(left.state.value.activeDbPath, oldDb);
  const db = new DatabaseSync(left.state.value.activeDbPath, { readOnly: true });
  assert.equal(db.prepare('SELECT value FROM readings').get().value, 20); db.close();
});

test('database rollback breaks lineage and protects a more complete replica', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source');
  const replica = await manager(t, root, 'replica', { role: 'replica' }); connect(source, replica);
  const backup = join(root, 'before.sqlite'); await copyFile(source.config.databasePath, backup);
  await replica.synchronize(source.state.claim()); assert.equal(replica.sync.state, 'ready');
  const acceptedEpoch = replica.state.value.accepted.epoch;
  await copyFile(backup, source.config.databasePath);
  await source.exportSnapshot({ force: true });
  assert.notEqual(source.state.value.epoch, acceptedEpoch);
  await replica.synchronize(source.state.claim());
  assert.equal(replica.state.value.role, 'protected'); assert.equal(replica.sync.error, 'lineage_mismatch');
});

test('force promotion confirmation and durable request IDs prevent accidental repeated promotions', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source');
  const replica = await manager(t, root, 'replica', { role: 'replica' }); connect(source, replica);
  await replica.synchronize(source.state.claim());
  const body = command();
  await assert.rejects(replica.action('promote', { requestId: body.requestId }), { code: 'confirmation_required' });
  await replica.action('promote', body);
  const epoch = replica.state.value.epoch;
  const duplicate = await replica.action('promote', body);
  assert.equal(duplicate.duplicate, true); assert.equal(replica.state.value.epoch, epoch);
});

test('manual recovery pins donor, keeps protection until verified rejoin, then replaces and deletes divergent rows', async t => {
  const root = await fixture(t);
  const primary = await manager(t, root, 'master', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId: randomUUID(), counts: { missing: 1, conflicts: 1, skipped: 0 } }),
    recoveryApply: async () => {
      const db = new DatabaseSync(primary.state.value.activeDbPath);
      db.exec('INSERT INTO readings VALUES(200,21)'); db.close();
      return { status: 'complete', imported: 1 };
    },
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  const db = new DatabaseSync(donor.state.value.activeDbPath); db.exec('INSERT INTO readings VALUES(200,21); INSERT INTO readings VALUES(300,99)'); db.close();
  await donor.observeClaim(primary.state.claim());
  await primary.action('check-recovery', command());
  assert.equal(donor.state.value.role, 'protected');
  await primary.action('recover', { ...command(), previewId: primary.state.value.recovery.preview.previewId });
  assert.equal(donor.state.value.role, 'protected');
  await primary.action('rejoin', command());
  assert.equal(donor.state.value.role, 'replica'); assert.equal(donor.state.value.everWritten, false);
  await donor.action('promote', command());
  const clean = new DatabaseSync(donor.state.value.activeDbPath, { readOnly: true });
  assert.deepEqual(clean.prepare('SELECT at FROM readings ORDER BY at').all().map(row => row.at), [100, 200]); clean.close();
});

test('recovery requires the latest successful check and a pending or failed recheck invalidates the old preview', async t => {
  const root = await fixture(t);
  let applyCalls = 0;
  let preview = async () => ({ previewId: randomUUID(), counts: { missing: 1 } });
  const primary = await manager(t, root, 'primary', { platform: 'hassio', hooks: {
    recoveryPreview: () => preview(),
    recoveryApply: async () => { applyCalls++; return { status: 'complete', imported: 1 }; },
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  await donor.observeClaim(primary.state.claim());

  assert.equal(primary.status().actions.recover, false);
  await assert.rejects(primary.action('recover', { ...command(), previewId: randomUUID() }), { code: 'invalid_transition' });
  await primary.action('check-recovery', command());
  const oldPreviewId = primary.status().recovery.preview.previewId;
  assert.equal(primary.status().actions.recover, true);

  let entered, fail;
  const checking = new Promise(resolve => { entered = resolve; });
  const comparison = new Promise((resolve, reject) => { fail = reject; });
  preview = async () => { entered(); return comparison; };
  const failedCheck = assert.rejects(primary.action('check-recovery', command()), { code: 'snapshot_unavailable' });
  await checking;
  assert.equal(primary.status().recovery.state, 'checking');
  assert.equal(primary.status().recovery.preview, null);
  assert.equal(primary.status().actions.recover, false);
  await assert.rejects(primary.action('recover', { ...command(), previewId: oldPreviewId }), { code: 'peer_busy' });
  fail(Object.assign(new Error('Synthetic snapshot failure'), { code: 'snapshot_unavailable' }));
  await failedCheck;
  assert.equal(primary.status().recovery.state, 'error');
  assert.equal(primary.status().actions.recover, false);
  await assert.rejects(primary.action('recover', { ...command(), previewId: oldPreviewId }), { code: 'invalid_transition' });

  preview = async () => ({ previewId: randomUUID(), counts: { missing: 1 } });
  await primary.action('check-recovery', command());
  const currentPreviewId = primary.status().recovery.preview.previewId;
  assert.notEqual(currentPreviewId, oldPreviewId);
  await assert.rejects(primary.action('recover', { ...command(), previewId: oldPreviewId }), { code: 'invalid_transition' });
  assert.equal(applyCalls, 0);
  await primary.action('recover', { ...command(), previewId: currentPreviewId });
  assert.equal(applyCalls, 1);
  assert.equal(primary.status().recovery.state, 'complete');
});

test('explicit rejoin without recovery requires the checked preview and replaces donor history without importing it', async t => {
  const root = await fixture(t);
  let imported = false;
  const primary = await manager(t, root, 'primary', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId: randomUUID(), counts: { missing: 1, conflicts: 1 }, model: { status: 'rebuild_required' } }),
    recoveryApply: async () => { imported = true; },
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  const original = new DatabaseSync(donor.state.value.activeDbPath);
  original.exec('UPDATE readings SET value=99; INSERT INTO readings VALUES(200,21)'); original.close();
  await donor.observeClaim(primary.state.claim());
  await primary.poll();
  await assert.rejects(primary.action('rejoin', { ...command(), discardUnrecovered: true, previewId: randomUUID() }), { code: 'recovery_required' });
  await primary.action('check-recovery', command());
  const previewId = primary.status().recovery.preview.previewId;
  assert.equal(primary.status().actions.rejoin, true);
  await assert.rejects(primary.action('rejoin', command()), { code: 'recovery_required' });
  await assert.rejects(primary.action('rejoin', { ...command(), discardUnrecovered: true, previewId: randomUUID() }), { code: 'invalid_transition' });
  await assert.rejects(primary.action('rejoin', { requestId: randomUUID(), discardUnrecovered: true, previewId }), { code: 'confirmation_required' });
  assert.equal(donor.state.value.role, 'protected');
  const skipRequest = { ...command(), discardUnrecovered: true, previewId };
  await primary.action('rejoin', skipRequest);
  assert.equal(imported, false);
  assert.equal(primary.status().recovery.state, 'resolved');
  assert.equal(primary.status().recovery.report.recoverySkipped, true);
  assert.equal(primary.status().recovery.report.imported, 0);
  assert.equal(primary.status().recovery.report.model.status, 'unchanged');
  assert.equal(donor.state.value.role, 'replica');
  const publication = await readReplicaPublication(donor.config.replicaDirectory);
  for (const path of [primary.state.value.activeDbPath, publication.dbPath]) {
    const db = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual(db.prepare('SELECT at,value FROM readings ORDER BY at').all().map(row => ({ ...row })), [{ at: 100, value: 20 }]);
    db.close();
  }
  assert.equal(publication.digest, donor.state.value.accepted.digest);
  assert.equal((await primary.action('rejoin', skipRequest)).duplicate, true);
  assert.equal((await readReplicaPublication(donor.config.replicaDirectory)).generation, publication.generation);
});

test('an uncertain discard request cannot authorize rejoin after another recovery has completed', async t => {
  const root = await fixture(t);
  const primary = await manager(t, root, 'primary', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId: randomUUID(), counts: { missing: 0 } }),
    recoveryApply: async () => ({ status: 'complete', imported: 0 }),
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  await donor.observeClaim(primary.state.claim());
  await primary.action('check-recovery', command());
  const uncertain = { ...command(), discardUnrecovered: true, previewId: primary.status().recovery.preview.previewId };
  await primary.action('check-recovery', command());
  const previewId = primary.status().recovery.preview.previewId;
  assert.notEqual(previewId, uncertain.previewId);
  await primary.action('recover', { ...command(), previewId });
  await assert.rejects(primary.action('rejoin', uncertain), { code: 'recovery_required' });
  await assert.rejects(primary.action('rejoin', { ...command(), discardUnrecovered: true, previewId }), { code: 'recovery_required' });
  assert.equal(donor.state.value.role, 'protected');
  assert.equal(primary.status().recovery.state, 'complete');
  await primary.action('rejoin', command());
  assert.equal(donor.state.value.role, 'replica');
  assert.equal(primary.status().recovery.report.recoverySkipped, undefined);
});

test('discarding unchecked donor changes is rejected and leaves the donor protected', async t => {
  const root = await fixture(t);
  const primary = await manager(t, root, 'primary', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId: randomUUID(), counts: { missing: 0 } }),
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  await donor.observeClaim(primary.state.claim());
  await primary.action('check-recovery', command());
  const previewId = primary.status().recovery.preview.previewId;
  const changed = new DatabaseSync(donor.state.value.activeDbPath);
  changed.exec('INSERT INTO readings VALUES(200,21)'); changed.close();
  await assert.rejects(primary.action('rejoin', { ...command(), discardUnrecovered: true, previewId }), { code: 'recovery_required' });
  assert.equal(donor.state.value.role, 'protected');
  assert.equal(primary.status().recovery.state, 'ready');
  const preserved = new DatabaseSync(donor.state.value.activeDbPath, { readOnly: true });
  assert.equal(preserved.prepare('SELECT value FROM readings WHERE at=200').get().value, 21); preserved.close();
});

test('lost handover acknowledgement never resumes the old master and leaves recovery possible', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source', { platform: 'hassio' });
  const target = await manager(t, root, 'target', { role: 'replica' }); connect(source, target);
  await target.synchronize(source.state.claim());
  const request = source.peer.request.bind(source.peer);
  source.peer.request = async (operation, ...args) => {
    const result = await request(operation, ...args);
    if (operation === 'handover-activate') throw Object.assign(Error(), { code: 'peer_unavailable' });
    return result;
  };
  await assert.rejects(source.action('handover', command()), { code: 'peer_unavailable' });
  assert.equal(source.canControl(), false); assert.equal(source.state.value.role, 'protected');
  assert.equal(target.canControl(), true);
  const original = source.state.value.activeDbPath;
  await source.close();
  const restarted = new PairState(source.config); await restarted.open();
  assert.equal(restarted.value.role, 'protected'); assert.equal(restarted.value.activeDbPath, original);
  await restarted.close();
});

test('explicit promotion from protected history is available without reopening a resolved old database', async t => {
  const root = await fixture(t), primary = await manager(t, root, 'hassio', { platform: 'hassio' });
  const backup = await manager(t, root, 'ubuntu');
  await backup.observeClaim(primary.state.claim());
  const original = backup.state.value.activeDbPath, priorEpoch = backup.state.value.epoch;
  assert.equal(backup.status().actions.promote, true);
  await backup.action('promote', command());
  assert.equal(backup.canControl(), true); assert.equal(backup.state.value.activeDbPath, original);
  assert.notEqual(backup.state.value.epoch, priorEpoch);
});

test('a stale recovery completion cannot erase changes made to the protected donor after preview', async t => {
  const root = await fixture(t), primary = await manager(t, root, 'primary', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId: randomUUID(), counts: {} }), recoveryApply: async () => ({ status: 'complete' }),
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  await donor.observeClaim(primary.state.claim());
  await primary.action('check-recovery', command());
  await primary.action('recover', { ...command(), previewId: primary.state.value.recovery.preview.previewId });
  const db = new DatabaseSync(donor.state.value.activeDbPath); db.exec('INSERT INTO readings VALUES(900,22)'); db.close();
  await assert.rejects(primary.action('rejoin', command()), { code: 'recovery_required' });
  assert.equal(donor.state.value.role, 'protected');
});

test('large catchup retains its immutable source and completed chunks across receiver restart', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source');
  const original = new DatabaseSync(source.state.value.activeDbPath);
  original.exec('CREATE TABLE bulk(payload BLOB)');
  original.prepare('INSERT INTO bulk VALUES(?)').run(Buffer.alloc(3500000, 7)); original.close();
  const replica = await manager(t, root, 'replica', { role: 'replica' }); connect(source, replica);
  const request = replica.peer.request.bind(replica.peer);
  let chunks = 0;
  replica.peer.request = (operation, ...args) => {
    if (operation === 'snapshot-chunk' && ++chunks > 1) return Promise.reject(Object.assign(Error(), { code: 'peer_unavailable' }));
    return request(operation, ...args);
  };
  await replica.synchronize(source.state.claim());
  assert.equal(replica.sync.state, 'error');
  const generation = replica.state.value.pendingReplica.generation;
  await replica.close();
  const restarted = await manager(t, root, 'replica', { role: 'replica', create: false }); connect(source, restarted);
  assert.equal(restarted.state.value.pendingReplica.generation, generation);
  await restarted.synchronize(source.state.claim());
  assert.equal(restarted.sync.state, 'ready');
  assert.equal(restarted.state.value.accepted.generation, generation);
  assert.ok(restarted.sync.transferredBytes < restarted.sync.bytes);
});

test('restart finishes an interrupted publication acknowledgement from its durable pending proof', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source');
  const replica = await manager(t, root, 'replica', { role: 'replica' }); connect(source, replica);
  const update = replica.state.update.bind(replica.state);
  replica.state.update = patch => patch.accepted ? Promise.reject(Object.assign(Error(), { code: 'EIO' })) : update(patch);
  await replica.synchronize(source.state.claim());
  assert.equal(replica.sync.state, 'error'); assert.equal(replica.state.value.accepted, null);
  const pending = replica.state.value.pendingReplica;
  replica.state.update = update; await replica.close();
  const restarted = await manager(t, root, 'replica', { role: 'replica', create: false });
  assert.equal(restarted.state.value.role, 'replica'); assert.equal(restarted.state.value.pendingReplica, null);
  assert.equal(restarted.state.value.accepted.generation, pending.generation);
});

test('startup protects an accepted replica that acquired unclassified local writes', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source');
  const replica = await manager(t, root, 'replica', { role: 'replica' }); connect(source, replica);
  await replica.synchronize(source.state.claim());
  const publication = await readReplicaPublication(replica.config.replicaDirectory);
  await replica.close();
  const changed = new DatabaseSync(publication.dbPath); changed.exec('INSERT INTO readings VALUES(300,23)'); changed.close();
  const restarted = await manager(t, root, 'replica', { role: 'replica', create: false });
  assert.equal(restarted.state.value.role, 'protected'); assert.equal(restarted.state.value.reason, 'replica_verification_failed');
  const donor = await restarted.exportSnapshot({ force: true });
  assert.notEqual(donor.digest, publication.digest);
});

test('failed VIP promotion preserves the database and protected management, then explicit retry succeeds', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source');
  const replica = await manager(t, root, 'replica', { role: 'replica' }); connect(source, replica);
  await replica.synchronize(source.state.claim());
  const acquire = replica.vip.acquire;
  replica.vip.acquire = async () => { throw Object.assign(Error(), { code: 'vip_failed' }); };
  await assert.rejects(replica.action('promote', command()), { code: 'vip_failed' });
  assert.equal(replica.state.value.role, 'protected'); assert.equal(replica.canControl(), false);
  assert.deepEqual(replica.calls.at(-1), ['replica', 'protected']);
  assert.equal(replica.status().actions.promote, true);
  replica.vip.acquire = acquire;
  await replica.action('promote', command());
  assert.equal(replica.canControl(), true);
});

test('runtime startup failure leaves a protected management view with explicit retry', async t => {
  const root = await fixture(t);
  let fail = true;
  const app = await manager(t, root, 'source', { hooks: { startPrimary: async () => {
    if (fail) throw Error('synthetic runtime failure');
  } } });
  assert.equal(app.state.value.role, 'protected'); assert.equal(app.canControl(), false);
  assert.equal(app.error, 'runtime_failed'); assert.deepEqual(app.calls.at(-1), ['replica', 'protected']);
  fail = false; await app.action('promote', command());
  assert.equal(app.canControl(), true);
});

test('pristine bootstrap failure can retry without treating a missing formerly written database as empty', async t => {
  const root = await fixture(t);
  const app = await manager(t, root, 'new-primary', { create: false, hooks: { startPrimary: async () => {
    throw Error('synthetic setup failure before opening storage');
  } } });
  assert.equal(app.state.value.bootstrapPending, true); assert.equal(app.state.value.role, 'protected');
  app.hooks.startPrimary = async ({ dbPath, onWriting }) => { await onWriting(); createDatabase(dbPath); };
  await app.action('promote', command());
  assert.equal(app.canControl(), true); assert.equal(app.state.value.bootstrapPending, false);
  await app.demote('synthetic');
  await rm(app.state.value.activeDbPath);
  await assert.rejects(app.action('promote', command()));
  assert.equal(app.state.value.role, 'protected');
});

test('a stale activation callback cannot write or demote a newer local primary', async t => {
  const root = await fixture(t), app = await manager(t, root, 'source');
  let enter, resume;
  const entered = new Promise(resolve => { enter = resolve; });
  const paused = new Promise(resolve => { resume = resolve; });
  let writes = 0, releases = 0;
  app.vip.release = async () => { releases++; };
  app.hooks.startPrimary = async ({ onWriting }) => { enter(); await paused; await onWriting(); writes++; };
  const stale = app.startPrimary().catch(error => error);
  await entered;
  const epoch = randomUUID(); await app.state.update({ epoch, role: 'primary' });
  app.activeAllowed = true;
  resume(); const result = await stale;
  assert.equal(result.code, 'authority_changed'); assert.equal(writes, 0); assert.equal(releases, 0);
  assert.equal(app.state.value.epoch, epoch); assert.equal(app.canControl(), true);
});
