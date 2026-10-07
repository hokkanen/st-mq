import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile, cp, access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { PairManager } from '../src/pairing/manager.js';
import { readReplicaPublication, snapshotDigest } from '../src/replication/publication.js';
import { acceptsLineage, compareAuthority, PairState } from '../src/pairing/state.js';

function createDatabase(path) {
  const db = new Store(path).db;
  db.exec("INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality) VALUES('fixture','fixture','temperature',20,'degC',100,100,'[]')");
  db.close();
}

async function manager(t, root, name, { role = 'master', platform = 'ubuntu', create = role === 'master', hooks = {} } = {}) {
  const path = join(root, `${name}.sqlite`);
  if (create) createDatabase(path);
  const config = { directory: join(root, name), snapshotDirectory: join(root, `${name}-replica`),
    databasePath: path, pairId: 'fixture-pair', token: 'synthetic-authority-token-0123456789abcdef',
    platform, listenHost: '127.0.0.1', port: 0, peerUrl: 'http://127.0.0.1:1',
    timeoutMs: 30000, intervalMs: 60000, vip: {} };
  let owned = false;
  const calls = [];
  const result = new PairManager({ config, announcements: () => null,
    vip: { acquire: async () => { owned = true; }, release: async () => { owned = false; }, status: () => ({ owned, ready: owned }) },
    hooks: { startPrimary: async value => calls.push(['master', value.dbPath]), startReplica: async value => calls.push(['slave', value.role]),
      stopControl: async value => calls.push(['stop', value.restore, result.canControl()]), closeReplica: async () => {}, ...hooks } });
  const fresh = await access(join(config.directory, 'state.json')).then(() => false, () => true);
  t.after(() => result.close());
  await result.init(); await result.start(); clearTimeout(result.timer);
  if (fresh && role === 'master') {
    try { await result.promote(); }
    catch (error) { if (result.state.value.role !== 'protected' || !result.state.value.activationError) throw error; }
  }
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
  const first = { nodeId: randomUUID(), epoch: randomUUID(), role: 'master', platform: 'hassio', sequence: 0 };
  const second = { nodeId: randomUUID(), epoch: randomUUID(), role: 'master', platform: 'ubuntu', sequence: 10000 };
  assert.ok(compareAuthority(first, second) > 0);
  assert.ok(compareAuthority(second, first) < 0);
  first.platform = 'ubuntu';
  assert.equal(Math.sign(compareAuthority(first, second)), -Math.sign(compareAuthority(second, first)));
});

test('unknown existing history starts protected and durable state refuses concurrent ownership', async t => {
  const root = await fixture(t), databasePath = join(root, 'existing.sqlite'); createDatabase(databasePath);
  const options = { directory: join(root, 'state'), pairId: 'fixture', platform: 'ubuntu', databasePath };
  const state = new PairState(options); await state.open();
  assert.equal(state.value.role, 'protected');
  const nodeId = state.value.nodeId;
  await assert.rejects(new PairState(options).open(), { code: 'pair_already_running' });
  await state.close();
  const restarted = new PairState(options); await restarted.open();
  assert.equal(restarted.value.nodeId, nodeId); assert.equal(restarted.value.role, 'protected');
  await restarted.close();
});

test('retired pair state and role values are rejected before altering files or acquiring a lock', async t => {
  const root = await fixture(t), directory = join(root, 'state'), databasePath = join(root, 'saved.sqlite');
  await mkdir(directory); createDatabase(databasePath);
  const database = await readFile(databasePath);
  const path = join(directory, 'state.json');
  const options = { directory, pairId: 'fixture', platform: 'ubuntu', databasePath };
  for (const change of [{ version: 2, role: 'protected' }, { role: 'primary' }, { role: 'replica' }]) {
    const raw = JSON.stringify({ version: 3, pairId: 'fixture', nodeId: randomUUID(), epoch: randomUUID(),
      role: 'slave', platform: 'ubuntu', sequence: 0, ancestors: [], actions: [], everWritten: true, ...change });
    await writeFile(path, raw);
    await assert.rejects(new PairState(options).open(), error =>
      error.code === 'invalid_pair_state' && /Preserve.*fresh pair directory/.test(error.message));
    assert.equal(await readFile(path, 'utf8'), raw);
    assert.deepEqual(await readdir(directory), ['state.json']);
    assert.deepEqual(await readFile(databasePath), database);
  }
});

test('no peer availability promotes a replica or stops an active master', async t => {
  const root = await fixture(t);
  const primary = await manager(t, root, 'master');
  const replica = await manager(t, root, 'slave', { role: 'slave' });
  await primary.poll(); await replica.poll();
  assert.equal(primary.canControl(), true); assert.equal(replica.state.value.role, 'slave');
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
  const right = await manager(t, root, 'ubuntu', { role: 'slave' }); connect(left, right);
  await right.synchronize(left.state.claim());
  assert.equal(right.sync.state, 'ready');
  await left.action('handover', command());
  assert.equal(left.state.value.role, 'slave'); assert.equal(right.state.value.role, 'master');
  const finalPublication = await readReplicaPublication(left.config.snapshotDirectory);
  assert.equal(left.status().sync.state, 'ready');
  assert.equal(left.status().sync.sourceAt, finalPublication.sourceAt);
  assert.equal(left.status().sync.verifiedAt, finalPublication.verifiedAt);
  assert.deepEqual(left.calls.find(call => call[0] === 'stop'), ['stop', true, true]);
  assert.equal(acceptsLineage(left.state.value.accepted, right.state.claim()), true);
  await left.synchronize(right.state.claim());
  assert.equal(left.sync.state, 'ready');
  const oldDb = left.config.databasePath;
  await left.action('promote', command());
  assert.notEqual(left.state.value.activeDbPath, oldDb);
  const db = new DatabaseSync(left.state.value.activeDbPath, { readOnly: true });
  assert.equal(db.prepare('SELECT value FROM observations').get().value, 20); db.close();
});

test('former preferred master restarts as slave and catches up after completed normal handover', async t => {
  const root = await fixture(t), original = await manager(t, root, 'hassio', { platform: 'hassio' });
  const successor = await manager(t, root, 'ubuntu', { role: 'slave' }); connect(original, successor);
  await successor.synchronize(original.state.claim());
  await original.action('handover', command());
  const nodeId = original.state.value.nodeId, inactivePath = original.config.databasePath;
  const inactiveBytes = await readFile(inactivePath);
  await original.close();
  const current = new Store(successor.state.value.activeDbPath);
  current.db.exec("INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality) VALUES('fixture','fixture','temperature',21,'degC',200,200,'[]')");
  current.close();
  const returning = await manager(t, root, 'hassio', { platform: 'hassio', role: 'slave', create: false });
  connect(returning, successor);
  assert.equal(returning.state.value.nodeId, nodeId);
  assert.equal(returning.state.value.role, 'slave');
  assert.equal(returning.calls.some(call => call[0] === 'master'), false);
  await returning.poll();
  await returning.syncTask;
  assert.equal(returning.state.value.role, 'slave');
  assert.equal(returning.sync.state, 'ready');
  assert.equal(returning.canControl(), false);
  assert.equal(returning.vip.status().owned, false);
  assert.equal(successor.canControl(), true);
  const publication = await readReplicaPublication(returning.config.snapshotDirectory);
  const mirrored = new Store(publication.dbPath, { readOnly: true });
  try { assert.deepEqual(mirrored.db.prepare('SELECT value FROM observations ORDER BY source_time').all().map(row => row.value), [20, 21]); }
  finally { mirrored.close(); }
  assert.deepEqual(await readFile(inactivePath), inactiveBytes, 'Former master history remains inactive and untouched');
});

test('OCPP readiness refusal leaves the current primary and its VIP running', async t => {
  const root = await fixture(t), requirements = { version: 1, fingerprint: 'a'.repeat(64) };
  const source = await manager(t, root, 'source', { hooks: { handoverRequirements: () => requirements } });
  const target = await manager(t, root, 'target', { role: 'slave', hooks: {
    prepareHandover: async received => {
      assert.deepEqual(received, requirements);
      throw Object.assign(Error('private configuration diagnostic'), { code: 'ocpp_handover_not_ready' });
    },
    verifyHandover: async () => {},
  } });
  connect(source, target);
  await assert.rejects(source.action('handover', command()), { code: 'ocpp_handover_not_ready' });
  assert.equal(source.canControl(), true); assert.equal(source.vip.status().owned, true);
  assert.equal(source.calls.some(call => call[0] === 'stop'), false);
  assert.equal(source.state.value.transition, null); assert.equal(target.state.value.transition, null);
  assert.equal(source.status().error, 'ocpp_handover_not_ready');
  assert.doesNotMatch(JSON.stringify(source.status()), /private configuration/);
});

test('handover checks database compatibility before stopping the master, including an empty slave', async t => {
  for (const existing of [false, true]) await t.test(existing ? 'incompatible retained snapshot' : 'incompatible incoming snapshot', async t => {
    const root = await fixture(t), source = await manager(t, root, 'source');
    const target = await manager(t, root, 'target', { role: 'slave' }); connect(source, target);
    let originalPath;
    if (existing) {
      await target.synchronize(source.state.claim());
      originalPath = (await readReplicaPublication(target.config.snapshotDirectory)).dbPath;
      const db = new DatabaseSync(originalPath); db.exec('PRAGMA user_version=7'); db.close();
    } else {
      // An earlier release can export its own database. Only the receiver runs
      // the current validator; the real transfer and handover paths stay intact.
      source.snapshots.snapshot = async ({ dbPath, destination }) => {
        await copyFile(dbPath, destination);
        const db = new DatabaseSync(destination); db.exec('PRAGMA user_version=7'); db.close();
        return { ...await snapshotDigest(destination), sourceStartedAt: 1, sourceAt: 1 };
      };
    }
    const originalBytes = originalPath ? await readFile(originalPath) : null;
    await assert.rejects(source.action('handover', command()), { code: 'database_schema_mismatch' });
    assert.equal(source.canControl(), true);
    assert.equal(source.vip.status().owned, true);
    assert.equal(source.calls.some(call => call[0] === 'stop'), false);
    assert.equal(source.state.value.transition, null);
    assert.equal(target.state.value.transition, null);
    assert.equal(target.canControl(), false);
    assert.equal(target.vip.status().owned, false);
    if (originalPath) assert.deepEqual(await readFile(originalPath), originalBytes);
    else assert.equal(await readReplicaPublication(target.config.snapshotDirectory), null);
  });
});

test('handover preflight rejects current incompatible state despite a cached or pending compatible snapshot', async t => {
  for (const pending of [false, true]) await t.test(pending ? 'pending transfer' : 'cached export', async t => {
    const root = await fixture(t), source = await manager(t, root, 'source');
    const target = await manager(t, root, 'target', { role: 'slave' }); connect(source, target);
    const cached = await source.exportSnapshot({ force: true });
    if (pending) await target.state.update({ pendingSnapshot: cached });
    const db = new DatabaseSync(source.state.value.activeDbPath);
    db.prepare('INSERT INTO state(key,value,updated_at) VALUES(?,?,?)').run('charging:mqtt', '{"version":-1}', 1);
    db.close();
    await assert.rejects(source.action('handover', command()), { code: 'database_state_incompatible' });
    assert.equal(source.canControl(), true);
    assert.equal(source.vip.status().owned, true);
    assert.equal(source.calls.some(call => call[0] === 'stop'), false);
    assert.equal(source.state.value.transition, null);
    assert.equal(target.state.value.transition, null);
    assert.equal(target.canControl(), false);
  });
});

test('handover requires current OCPP readiness acknowledgement before stopping', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source');
  const target = await manager(t, root, 'target', { role: 'slave' }); connect(source, target);
  await assert.rejects(target.handlePeer('handover-prepare', { claim: source.state.claim(), token: randomUUID() }),
    { code: 'ocpp_handover_not_ready' });
  const request = source.peer.request.bind(source.peer);
  source.peer.request = async (operation, ...args) => {
    const response = await request(operation, ...args);
    if (operation === 'handover-prepare') delete response.ocpp;
    return response;
  };
  await assert.rejects(source.action('handover', command()), { code: 'ocpp_handover_not_ready' });
  assert.equal(source.canControl(), true);
  assert.equal(source.calls.some(call => call[0] === 'stop'), false);
});

test('MQTT preflight failure or missing current frontend acknowledgement leaves the master running', async t => {
  for (const problem of ['upstream', 'transport', 'old-peer']) await t.test(problem, async t => {
    const root = await fixture(t), source = await manager(t, root, 'source');
    const target = await manager(t, root, 'target', { role: 'slave' }); connect(source, target);
    source.hooks.mqttHandoverRequirements = () => ({ version: 1, protocol: 'mqtt:', port: 1883 });
    target.hooks.mqttHandoverRequirements = () => ({ version: 1, protocol: problem === 'transport' ? 'mqtts:' : 'mqtt:', port: 1883 });
    if (problem === 'upstream') target.hooks.preparePrimary = async () => { throw Object.assign(Error(), { code: 'mqtt_upstream_unavailable' }); };
    if (problem === 'old-peer') {
      const request = source.peer.request.bind(source.peer);
      source.peer.request = async (operation, ...args) => {
        const result = await request(operation, ...args);
        if (operation === 'handover-prepare') delete result.mqtt;
        return result;
      };
    }
    await assert.rejects(source.action('handover', command()),
      { code: problem === 'upstream' ? 'mqtt_upstream_unavailable' : 'mqtt_handover_not_ready' });
    assert.equal(source.canControl(), true);
    assert.equal(source.vip.status().owned, true);
    assert.equal(source.calls.some(call => call[0] === 'stop'), false);
  });
});

test('handover completes restoration and closes VIP connections before address release or peer activation', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source');
  const target = await manager(t, root, 'target', { role: 'slave' }); connect(source, target);
  const events = [];
  let entered, resume;
  const closing = new Promise(resolve => { entered = resolve; });
  const closed = new Promise(resolve => { resume = resolve; });
  source.hooks.stopControl = async ({ restore }) => { events.push(`control:${restore}`); };
  source.hooks.stopTransport = async () => { events.push('transport:closing'); entered(); await closed; events.push('transport:closed'); };
  const release = source.vip.release;
  source.vip.release = async () => { events.push('vip:release'); await release(); };
  const start = target.hooks.startPrimary;
  target.hooks.startPrimary = async options => { events.push('peer:start'); await start(options); };
  const transfer = source.action('handover', command());
  await closing;
  assert.deepEqual(events, ['control:true', 'transport:closing']);
  assert.equal(source.vip.status().owned, true);
  assert.equal(source.controlReleased, false);
  assert.equal(target.canControl(), false);
  resume(); await transfer;
  assert.deepEqual(events.slice(0, 5), ['control:true', 'transport:closing', 'transport:closed', 'vip:release', 'peer:start']);
  assert.equal(source.canControl(), false);
  assert.equal(target.canControl(), true);
});

test('final handover snapshot preserves OCPP transactions and setup after listener shutdown', async t => {
  const root = await fixture(t), requirements = { version: 1, fingerprint: 'b'.repeat(64) };
  let source, checked = 0;
  const ledger = { version: 1, activeId: 17, nextId: 18, transactions: [{ id: 17, meterStart: 123 }] };
  const setup = { version: 1, fingerprint: requirements.fingerprint, phase: 'configured' };
  source = await manager(t, root, 'source', { hooks: {
    handoverRequirements: () => requirements,
    stopControl: async () => {
      const store = new Store(source.config.databasePath);
      try { store.setState('easee:ocpp', ledger); store.setState('easee:ocpp-setup', setup); }
      finally { store.close(); }
    },
  } });
  const target = await manager(t, root, 'target', { role: 'slave', hooks: {
    prepareHandover: async received => assert.deepEqual(received, requirements),
    verifyHandover: async ({ dbPath, requirements: received }) => {
      assert.deepEqual(received, requirements);
      const store = new Store(dbPath, { readOnly: true });
      try { assert.deepEqual(store.getState('easee:ocpp'), ledger); assert.deepEqual(store.getState('easee:ocpp-setup'), setup); }
      finally { store.close(); }
      checked++;
    },
  } });
  connect(source, target); await target.synchronize(source.state.claim());
  await source.action('handover', command());
  assert.equal(checked, 2); assert.equal(target.canControl(), true);
  const store = new Store(target.state.value.activeDbPath, { readOnly: true });
  try { assert.deepEqual(store.getState('easee:ocpp'), ledger); assert.deepEqual(store.getState('easee:ocpp-setup'), setup); }
  finally { store.close(); }
});

test('final OCPP verification failure leaves both controllers fenced', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source');
  const target = await manager(t, root, 'target', { role: 'slave', hooks: {
    verifyHandover: async () => { throw Object.assign(Error(), { code: 'ocpp_handover_not_ready' }); },
  } });
  connect(source, target);
  await assert.rejects(source.action('handover', command()), { code: 'ocpp_handover_not_ready' });
  assert.equal(source.canControl(), false); assert.equal(target.canControl(), false);
  assert.equal(source.state.value.role, 'protected'); assert.equal(target.state.value.role, 'slave');
  assert.equal(source.vip.status().owned, false); assert.equal(target.vip.status().owned, false);
});

test('authority lost during readiness check cannot start a restoring shutdown', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source');
  let prepared, proceed;
  const entered = new Promise(resolve => { prepared = resolve; });
  const paused = new Promise(resolve => { proceed = resolve; });
  const target = await manager(t, root, 'target', { role: 'slave', hooks: {
    prepareHandover: async () => { prepared(); await paused; },
  } });
  connect(source, target);
  const transfer = source.action('handover', command()).catch(error => error);
  await entered; await source.demote('synthetic'); proceed();
  assert.equal((await transfer).code, 'authority_changed');
  assert.equal(source.canControl(), false);
  assert.equal(source.calls.some(call => call[0] === 'stop' && call[1] === true), false);
});

test('database rollback breaks lineage and protects a more complete replica', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source');
  const replica = await manager(t, root, 'slave', { role: 'slave' }); connect(source, replica);
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
  const replica = await manager(t, root, 'slave', { role: 'slave' }); connect(source, replica);
  await replica.synchronize(source.state.claim());
  const body = command();
  await assert.rejects(replica.action('promote', { requestId: body.requestId }), { code: 'confirmation_required' });
  await replica.action('promote', body);
  const epoch = replica.state.value.epoch;
  const duplicate = await replica.action('promote', body);
  assert.equal(duplicate.duplicate, true); assert.equal(replica.state.value.epoch, epoch);
});

test('recovery rejects missing and retired preview identities without generating authority', async t => {
  const root = await fixture(t);
  let previewId;
  const primary = await manager(t, root, 'master', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId, status: 'checked', model: { status: 'not-assessed' } }),
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  await donor.observeClaim(primary.state.claim());
  for (previewId of [undefined, null, randomUUID(), 'invalid']) {
    await assert.rejects(primary.action('check-recovery', command()), { code: 'recovery_unavailable' });
    assert.equal(primary.status().recovery.state, 'error');
    assert.equal(primary.status().recovery.preview, null);
    assert.equal(primary.status().actions.recover, false);
    assert.equal(primary.status().actions.rejoin, false);
    assert.equal(donor.state.value.role, 'protected');
  }
});

test('retired merge previews cannot authorize recovery or protected replacement', async t => {
  const root = await fixture(t);
  const primary = await manager(t, root, 'master', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId: randomBytes(32).toString('hex'), counts: { missing: 0 }, model: { status: 'unchanged' } }),
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  await donor.observeClaim(primary.state.claim());
  await assert.rejects(primary.action('check-recovery', command()), { code: 'recovery_unavailable' });
  assert.equal(primary.status().actions.recover, false);
  assert.equal(primary.status().actions.rejoin, false);
  assert.equal(donor.state.value.role, 'protected');
});

test('manual recovery pins donor, keeps protection until verified rejoin, then replaces and deletes divergent rows', async t => {
  const root = await fixture(t);
  const primary = await manager(t, root, 'master', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId: randomBytes(32).toString('hex'), status: 'checked', model: { status: 'not-assessed' } }),
    recoveryApply: async () => {
      const db = new DatabaseSync(primary.state.value.activeDbPath);
      db.exec(`INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality) VALUES('fixture','fixture','temperature',21,'degC',200,200,'[]')`); db.close();
      return { status: 'complete', imported: 1 };
    },
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  const db = new DatabaseSync(donor.state.value.activeDbPath); db.exec(`INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality) VALUES('fixture','fixture','temperature',21,'degC',200,200,'[]'); INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality) VALUES('fixture','fixture','temperature',99,'degC',300,300,'[]')`); db.close();
  await donor.observeClaim(primary.state.claim());
  await primary.action('check-recovery', command());
  assert.equal(donor.state.value.role, 'protected');
  await primary.action('recover', { ...command(), previewId: primary.state.value.recovery.preview.previewId });
  assert.equal(donor.state.value.role, 'protected');
  await primary.action('rejoin', command());
  assert.equal(donor.state.value.role, 'slave'); assert.equal(donor.state.value.everWritten, false);
  await donor.action('promote', command());
  const clean = new DatabaseSync(donor.state.value.activeDbPath, { readOnly: true });
  assert.deepEqual(clean.prepare('SELECT source_time AS at FROM observations ORDER BY source_time').all().map(row => row.at), [100, 200]); clean.close();
});

test('recovery requires the latest successful check and a pending or failed recheck invalidates the old preview', async t => {
  const root = await fixture(t);
  let applyCalls = 0;
  let preview = async () => ({ previewId: randomBytes(32).toString('hex'), status: 'checked', model: { status: 'not-assessed' } });
  const primary = await manager(t, root, 'master', { platform: 'hassio', hooks: {
    recoveryPreview: () => preview(),
    recoveryApply: async () => { applyCalls++; return { status: 'complete', imported: 1 }; },
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  await donor.observeClaim(primary.state.claim());

  assert.equal(primary.status().actions.recover, false);
  await assert.rejects(primary.action('recover', { ...command(), previewId: randomBytes(32).toString('hex') }), { code: 'invalid_transition' });
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

  preview = async () => ({ previewId: randomBytes(32).toString('hex'), status: 'checked', model: { status: 'not-assessed' } });
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
  const primary = await manager(t, root, 'master', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId: randomBytes(32).toString('hex'), status: 'checked', model: { status: 'not-assessed' } }),
    recoveryApply: async () => { imported = true; },
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  const original = new DatabaseSync(donor.state.value.activeDbPath);
  original.exec(`UPDATE observations SET value=99; INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality) VALUES('fixture','fixture','temperature',21,'degC',200,200,'[]')`); original.close();
  await donor.observeClaim(primary.state.claim());
  await primary.poll();
  await assert.rejects(primary.action('rejoin', { ...command(), discardUnrecovered: true, previewId: randomBytes(32).toString('hex') }), { code: 'recovery_required' });
  await primary.action('check-recovery', command());
  const previewId = primary.status().recovery.preview.previewId;
  assert.equal(primary.status().actions.rejoin, true);
  await assert.rejects(primary.action('rejoin', command()), { code: 'recovery_required' });
  await assert.rejects(primary.action('rejoin', { ...command(), discardUnrecovered: true, previewId: randomBytes(32).toString('hex') }), { code: 'invalid_transition' });
  await assert.rejects(primary.action('rejoin', { requestId: randomUUID(), discardUnrecovered: true, previewId }), { code: 'confirmation_required' });
  assert.equal(donor.state.value.role, 'protected');
  const skipRequest = { ...command(), discardUnrecovered: true, previewId };
  await primary.action('rejoin', skipRequest);
  assert.equal(imported, false);
  assert.equal(primary.status().recovery.state, 'resolved');
  assert.equal(primary.status().recovery.report.recoverySkipped, true);
  assert.equal(primary.status().recovery.report.imported, 0);
  assert.equal(primary.status().recovery.report.model.status, 'unchanged');
  assert.equal(donor.state.value.role, 'slave');
  const publication = await readReplicaPublication(donor.config.snapshotDirectory);
  for (const path of [primary.state.value.activeDbPath, publication.dbPath]) {
    const db = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual(db.prepare('SELECT source_time AS at,value FROM observations ORDER BY source_time').all().map(row => ({ ...row })), [{ at: 100, value: 20 }]);
    db.close();
  }
  assert.equal(publication.digest, donor.state.value.accepted.digest);
  assert.equal((await primary.action('rejoin', skipRequest)).duplicate, true);
  assert.equal((await readReplicaPublication(donor.config.snapshotDirectory)).generation, publication.generation);
});

test('an uncertain discard request cannot authorize rejoin after another recovery has completed', async t => {
  const root = await fixture(t);
  const primary = await manager(t, root, 'master', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId: randomBytes(32).toString('hex'), status: 'checked', model: { status: 'not-assessed' } }),
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
  assert.equal(donor.state.value.role, 'slave');
  assert.equal(primary.status().recovery.report.recoverySkipped, undefined);
});

test('discarding unchecked donor changes is rejected and leaves the donor protected', async t => {
  const root = await fixture(t);
  const primary = await manager(t, root, 'master', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId: randomBytes(32).toString('hex'), status: 'checked', model: { status: 'not-assessed' } }),
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  await donor.observeClaim(primary.state.claim());
  await primary.action('check-recovery', command());
  const previewId = primary.status().recovery.preview.previewId;
  const changed = new DatabaseSync(donor.state.value.activeDbPath);
  changed.exec(`INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality) VALUES('fixture','fixture','temperature',21,'degC',200,200,'[]')`); changed.close();
  await assert.rejects(primary.action('rejoin', { ...command(), discardUnrecovered: true, previewId }), { code: 'recovery_required' });
  assert.equal(donor.state.value.role, 'protected');
  assert.equal(primary.status().recovery.state, 'ready');
  const preserved = new DatabaseSync(donor.state.value.activeDbPath, { readOnly: true });
  assert.equal(preserved.prepare('SELECT value FROM observations WHERE source_time=200').get().value, 21); preserved.close();
});

test('lost handover acknowledgement never resumes the old master and leaves recovery possible', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source', { platform: 'hassio' });
  const target = await manager(t, root, 'target', { role: 'slave' }); connect(source, target);
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
  const root = await fixture(t), primary = await manager(t, root, 'master', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId: randomBytes(32).toString('hex'), status: 'checked', model: { status: 'not-assessed' } }), recoveryApply: async () => ({ status: 'complete' }),
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  await donor.observeClaim(primary.state.claim());
  await primary.action('check-recovery', command());
  await primary.action('recover', { ...command(), previewId: primary.state.value.recovery.preview.previewId });
  const db = new DatabaseSync(donor.state.value.activeDbPath); db.exec(`INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality) VALUES('fixture','fixture','temperature',22,'degC',900,900,'[]')`); db.close();
  await assert.rejects(primary.action('rejoin', command()), { code: 'recovery_required' });
  assert.equal(donor.state.value.role, 'protected');
});

test('large catchup retains its immutable source and completed chunks across receiver restart', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source');
  const original = new DatabaseSync(source.state.value.activeDbPath);
  original.prepare("INSERT INTO events(type,payload,at) VALUES('bulk',json_object('value',?),0)").run('x'.repeat(3500000)); original.close();
  const replica = await manager(t, root, 'slave', { role: 'slave' }); connect(source, replica);
  const request = replica.peer.request.bind(replica.peer);
  let chunks = 0;
  replica.peer.request = (operation, ...args) => {
    if (operation === 'snapshot-chunk' && ++chunks > 1) return Promise.reject(Object.assign(Error(), { code: 'peer_unavailable' }));
    return request(operation, ...args);
  };
  await replica.synchronize(source.state.claim());
  assert.equal(replica.sync.state, 'error');
  const generation = replica.state.value.pendingSnapshot.generation;
  await replica.close();
  const restarted = await manager(t, root, 'slave', { role: 'slave', create: false }); connect(source, restarted);
  assert.equal(restarted.state.value.pendingSnapshot.generation, generation);
  await restarted.synchronize(source.state.claim());
  assert.equal(restarted.sync.state, 'ready');
  assert.equal(restarted.state.value.accepted.generation, generation);
  assert.ok(restarted.sync.transferredBytes < restarted.sync.bytes);
});

test('restart finishes an interrupted publication acknowledgement from its durable pending proof', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source');
  const replica = await manager(t, root, 'slave', { role: 'slave' }); connect(source, replica);
  const update = replica.state.update.bind(replica.state);
  replica.state.update = patch => patch.accepted ? Promise.reject(Object.assign(Error(), { code: 'EIO' })) : update(patch);
  await replica.synchronize(source.state.claim());
  assert.equal(replica.sync.state, 'error'); assert.equal(replica.state.value.accepted, null);
  const pending = replica.state.value.pendingSnapshot;
  replica.state.update = update; await replica.close();
  const restarted = await manager(t, root, 'slave', { role: 'slave', create: false });
  assert.equal(restarted.state.value.role, 'slave'); assert.equal(restarted.state.value.pendingSnapshot, null);
  assert.equal(restarted.state.value.accepted.generation, pending.generation);
});

test('startup protects an accepted replica that acquired unclassified local writes', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source');
  const replica = await manager(t, root, 'slave', { role: 'slave' }); connect(source, replica);
  await replica.synchronize(source.state.claim());
  const publication = await readReplicaPublication(replica.config.snapshotDirectory);
  await replica.close();
  const changed = new DatabaseSync(publication.dbPath); changed.exec(`INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality) VALUES('fixture','fixture','temperature',23,'degC',300,300,'[]')`); changed.close();
  const restarted = await manager(t, root, 'slave', { role: 'slave', create: false });
  assert.equal(restarted.state.value.role, 'protected'); assert.equal(restarted.state.value.reason, 'snapshot_verification_failed');
  const donor = await restarted.exportSnapshot({ force: true });
  assert.notEqual(donor.digest, publication.digest);
});

test('fresh pair state cannot bootstrap over unclassified or corrupt received history', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source');
  const receiver = await manager(t, root, 'receiver', { role: 'slave' }); connect(source, receiver);
  await receiver.synchronize(source.state.claim());
  const publication = await readReplicaPublication(receiver.config.snapshotDirectory);
  const originalDatabase = await readFile(publication.dbPath);
  for (const corrupt of [false, true]) {
    const name = corrupt ? 'corrupt-history' : 'unclassified-history';
    const directory = join(root, `${name}-replica`);
    await cp(receiver.config.snapshotDirectory, directory, { recursive: true });
    const manifest = join(directory, 'publication.json');
    if (corrupt) await writeFile(manifest, '{invalid-publication');
    const originalManifest = await readFile(manifest);
    const app = await manager(t, root, name, { role: 'slave' });
    assert.equal(app.state.value.role, 'protected');
    assert.equal(app.state.value.reason, 'unclassified_local_history');
    assert.equal(app.state.value.bootstrapPending, false);
    assert.equal(app.status().bootstrapPending, false);
    assert.equal(app.status().actions.promote, false);
    await assert.rejects(app.action('promote', command()), { code: 'protected_history' });
    assert.equal(app.calls.some(call => call[0] === 'master'), false);
    await assert.rejects(access(app.config.databasePath), { code: 'ENOENT' });
    // A later helper error may change the visible protection reason, but must
    // not restore permission to bootstrap past the preserved received history.
    await app.state.update({ reason: 'vip_release_failed' });
    await app.close();
    const restarted = await manager(t, root, name, { role: 'slave' });
    assert.equal(restarted.status().actions.promote, false);
    await assert.rejects(restarted.action('promote', command()), { code: 'protected_history' });
    assert.deepEqual(await readFile(manifest), originalManifest);
    assert.deepEqual(await readFile(join(directory, `snapshot-${publication.generation}.sqlite`)), originalDatabase);
  }
});

test('failed VIP promotion preserves the database and protected management, then explicit retry succeeds', async t => {
  const root = await fixture(t), source = await manager(t, root, 'source');
  const replica = await manager(t, root, 'slave', { role: 'slave' }); connect(source, replica);
  await replica.synchronize(source.state.claim());
  const acquire = replica.vip.acquire;
  replica.vip.acquire = async () => { throw Object.assign(Error(), { code: 'vip_failed' }); };
  await assert.rejects(replica.action('promote', command()), { code: 'vip_failed' });
  assert.equal(replica.state.value.role, 'protected'); assert.equal(replica.canControl(), false);
  assert.deepEqual(replica.calls.at(-1), ['slave', 'protected']);
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
  assert.equal(app.error, 'runtime_failed'); assert.deepEqual(app.calls.at(-1), ['slave', 'protected']);
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
  const epoch = randomUUID(); await app.state.update({ epoch, role: 'master' });
  app.activeAllowed = true;
  resume(); const result = await stale;
  assert.equal(result.code, 'authority_changed'); assert.equal(writes, 0); assert.equal(releases, 0);
  assert.equal(app.state.value.epoch, epoch); assert.equal(app.canControl(), true);
});

test('A10-002 repeated cached synchronization remains a valid immutable publication',async t=>{
  const root=await fixture(t),source=await manager(t,root,'source'),replica=await manager(t,root,'slave',{role:'slave'});
  connect(source,replica);await replica.synchronize(source.state.claim());
  const first=await readReplicaPublication(replica.config.snapshotDirectory);
  await replica.synchronize(source.state.claim());
  const second=await readReplicaPublication(replica.config.snapshotDirectory);
  assert.equal(second.generation,first.generation);assert.notEqual(second.previousGeneration,second.generation);
  assert.equal(replica.state.value.accepted.generation,first.generation);
});

test('A10-003 delayed pre-handover poll and MQTT claim cannot demote the new primary',async t=>{
  const root=await fixture(t),source=await manager(t,root,'source',{platform:'hassio'}),target=await manager(t,root,'target',{role:'slave'});
  connect(source,target);await target.synchronize(source.state.claim());const stale=source.state.claim();
  const request=target.peer.request.bind(target.peer);let release;
  target.peer.request=(operation,...args)=>operation==='status' && !release?new Promise(resolve=>{release=()=>resolve({claim:stale});}):request(operation,...args);
  const polling=target.poll();await source.action('handover',command());assert.equal(target.canControl(),true);
  release();await polling;assert.equal(target.canControl(),true);assert.equal(source.canControl(),false);
  target.peer.request=request;await target.observeClaim(stale);assert.equal(target.canControl(),true,'stale MQTT claim is freshly challenged');
});

test('A10-004 lost release acknowledgement retries the same durable operation',async t=>{
  const root=await fixture(t),primary=await manager(t,root,'master',{platform:'hassio',hooks:{
    recoveryPreview:async()=>({previewId:randomBytes(32).toString('hex'),status:'checked',model:{status:'not-assessed'}}),recoveryApply:async()=>({status:'complete',imported:0}),
  }}),donor=await manager(t,root,'donor');connect(primary,donor);
  await donor.observeClaim(primary.state.claim());await primary.action('check-recovery',command());
  await primary.action('recover',{...command(),previewId:primary.state.value.recovery.preview.previewId});
  const request=primary.peer.request.bind(primary.peer),action=command();let lost=false;
  primary.peer.request=async(operation,...args)=>{const result=await request(operation,...args);if(operation==='release'&&!lost){lost=true;throw Object.assign(Error(),{code:'peer_unavailable'});}return result;};
  await assert.rejects(primary.action('rejoin',action),{code:'peer_unavailable'});
  const pendingRelease = structuredClone(primary.state.value.recovery.releaseOperation);
  assert.equal(primary.status().actions['check-recovery'], false);
  await assert.rejects(primary.action('check-recovery', command()), { code: 'invalid_transition' });
  assert.deepEqual(primary.state.value.recovery.releaseOperation, pendingRelease);
  await primary.poll();
  assert.equal(primary.status().peer.role, 'slave');
  assert.equal(primary.status().actions.rejoin, true, 'the saved release can be verified after the peer already became a slave');
  assert.equal(primary.status().actions.handover, false);
  await assert.rejects(primary.action('handover', command()), { code: 'invalid_transition' });
  assert.deepEqual(primary.state.value.recovery.releaseOperation, pendingRelease);
  assert.equal(donor.state.value.role,'slave');const generation=donor.state.value.accepted.generation;
  for (let n = 0; n < 3; n++) await primary.exportSnapshot({ force: true });
  await primary.snapshots.chunk({ generation, index: 0 });
  await primary.close(); await donor.close();
  const restartedPrimary = await manager(t,root,'master',{platform:'hassio',create:false});
  const restartedDonor = await manager(t,root,'donor',{role:'slave',create:false});
  connect(restartedPrimary,restartedDonor);
  for (let n = 0; n < 3; n++) await restartedPrimary.exportSnapshot({ force: true });
  await restartedPrimary.snapshots.chunk({ generation, index: 0 });
  assert.equal((await restartedPrimary.action('rejoin',action)).ok,true);
  assert.equal(restartedPrimary.state.value.recovery.state,'resolved');assert.equal(restartedDonor.state.value.accepted.generation,generation);
});

test('saved uncertain discard verifies only its original request after the source-check contract changes', async t => {
  const root = await fixture(t);
  const primary = await manager(t, root, 'master', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId: randomBytes(32).toString('hex'), status: 'checked', model: { status: 'not-assessed' } }),
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  await donor.observeClaim(primary.state.claim());
  await primary.action('check-recovery', command());
  const previewId = primary.status().recovery.preview.previewId;
  const action = { ...command(), discardUnrecovered: true, previewId };
  const request = primary.peer.request.bind(primary.peer);
  let lost = false;
  primary.peer.request = async (operation, ...args) => {
    const result = await request(operation, ...args);
    if (operation === 'release' && !lost) { lost = true; throw Object.assign(Error(), { code: 'peer_unavailable' }); }
    return result;
  };
  await assert.rejects(primary.action('rejoin', action), { code: 'peer_unavailable' });
  const generation = donor.state.value.accepted.generation;
  await primary.state.update({ recovery: { ...primary.state.value.recovery,
    preview: { previewId, counts: { missing: 1 }, model: { status: 'rebuild-required' } } } });
  await primary.poll();
  assert.equal(primary.status().actions.rejoin, true, 'The receipt can be verified after its source review is retired');
  assert.equal(primary.status().actions.recover, false);
  for (const change of [{ requestId: randomUUID() }, { discardUnrecovered: false }, { previewId: randomBytes(32).toString('hex') }])
    await assert.rejects(primary.action('rejoin', { ...action, ...change }), { code: 'invalid_transition' });
  await primary.action('rejoin', action);
  assert.equal(primary.status().recovery.state, 'resolved');
  assert.equal(donor.state.value.accepted.generation, generation, 'Verification does not start another replacement');
});

test('peer snapshot requests cannot pin exports indefinitely', async t => {
  const root = await fixture(t), primary = await manager(t, root, 'master');
  const metadata = await primary.handlePeer('snapshot', { force: true, pin: true });
  await assert.rejects(access(join(primary.snapshots.directory, `export-${metadata.generation}.pin`)), { code: 'ENOENT' });
});

test('ordinary slave comparisons cannot import its older history or replace it through recovery', async t => {
  const root = await fixture(t);
  let imported = false;
  const primary = await manager(t, root, 'master', { hooks: {
    recoveryPreview: async () => ({ previewId: randomBytes(32).toString('hex'), status: 'checked', model: { status: 'not-assessed' } }),
    recoveryApply: async () => { imported = true; },
  } });
  const slave = await manager(t, root, 'slave', { role: 'slave' }); connect(primary, slave);
  await slave.synchronize(primary.state.claim());
  await primary.poll();
  await primary.action('check-recovery', command());
  const recovery = primary.status().recovery;
  assert.equal(recovery.donorRole, 'slave');
  assert.equal(primary.status().actions.recover, false);
  assert.equal(primary.status().actions.rejoin, false);
  await assert.rejects(primary.action('recover', { ...command(), previewId: recovery.preview.previewId }), { code: 'invalid_transition' });
  await assert.rejects(primary.action('rejoin', { ...command(), discardUnrecovered: true, previewId: recovery.preview.previewId }), { code: 'recovery_required' });
  assert.equal(imported, false);
  assert.deepEqual(primary.status().recovery, recovery);
  assert.equal(slave.state.value.role, 'slave');
});

test('rejoin retains the original dedicated database without restoring its excluded data on later promotion', async t => {
  for (const skip of [false, true]) await t.test(skip ? 'explicit skip' : 'completed recovery', async t => {
    const root = await fixture(t);
    const primary = await manager(t, root, 'master', { platform: 'hassio', hooks: {
      recoveryPreview: async () => ({ previewId: randomBytes(32).toString('hex'), status: 'checked', model: { status: 'not-assessed' } }),
      recoveryApply: async () => ({ status: 'complete', imported: 0, model: { status: 'unchanged' } }),
    } });
    const donor = await manager(t, root, 'donor', { role: 'slave' }); connect(primary, donor);
    await donor.synchronize(primary.state.claim());
    await donor.action('promote', command());
    const originalPath = donor.state.value.activeDbPath;
    assert.ok(originalPath.startsWith(join(donor.config.directory, 'master-')));
    const original = new Store(originalPath);
    original.db.prepare(`INSERT INTO charging_reports(namespace,charger_id,report_id,association,started_at,saved_at,summary,checkpoint)
      VALUES(?,?,?,?,?,?,?,?)`).run('mqtt', 'charger2', 'synthetic-saved-report', 'synthetic-association', 100, 200, '{}', '{}');
    original.setState('synthetic-excluded-control', { enabled: true });
    original.close();
    await donor.observeClaim(primary.state.claim());
    const before = await readFile(originalPath);
    await primary.action('check-recovery', command());
    const previewId = primary.status().recovery.preview.previewId;
    if (!skip) await primary.action('recover', { ...command(), previewId });
    const rejoin = { ...command(), ...(skip ? { previewId, discardUnrecovered: true } : {}) };
    await primary.action('rejoin', rejoin);
    assert.equal(donor.state.value.role, 'slave');
    assert.equal(donor.state.value.activeDbPath, null);
    assert.deepEqual(await readFile(originalPath), before, 'Rejoin must retain every original database byte');
    const retained = new Store(originalPath, { readOnly: true });
    assert.equal(retained.db.prepare('SELECT COUNT(*) n FROM charging_reports').get().n, 1);
    assert.equal(retained.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    retained.close();
    await donor.action('promote', command());
    assert.notEqual(donor.state.value.activeDbPath, originalPath);
    const promoted = new Store(donor.state.value.activeDbPath, { readOnly: true });
    assert.equal(promoted.db.prepare('SELECT COUNT(*) n FROM charging_reports').get().n, 0);
    assert.equal(promoted.getState('synthetic-excluded-control'), null);
    promoted.close();
    assert.deepEqual(await readFile(originalPath), before);
  });
});

test('rejoin retains protected replica history through later mirroring and interrupted release', async t => {
  for (const interrupted of [false, true]) await t.test(interrupted ? 'restart after publication' : 'completed release', async t => {
    const root = await fixture(t);
    const primary = await manager(t, root, 'master', { platform: 'hassio', hooks: {
      recoveryPreview: async () => ({ previewId: randomBytes(32).toString('hex'), status: 'checked', model: { status: 'not-assessed' } }),
    } });
    let donor = await manager(t, root, 'donor', { role: 'slave' }); connect(primary, donor);
    await donor.synchronize(primary.state.claim());
    const publication = await readReplicaPublication(donor.config.snapshotDirectory);
    const changed = new Store(publication.dbPath);
    changed.setState('synthetic-unmatched-history', { value: 'preserve me' });
    changed.close();
    await donor.synchronize(primary.state.claim());
    assert.equal(donor.state.value.role, 'protected');
    assert.equal(donor.state.value.everWritten, false);
    await primary.action('check-recovery', command());
    const action = { ...command(), discardUnrecovered: true, previewId: primary.status().recovery.preview.previewId };
    if (interrupted) {
      const closeReplica = donor.hooks.closeReplica;
      donor.hooks.closeReplica = async () => { throw Object.assign(Error(), { code: 'runtime_failed' }); };
      await assert.rejects(primary.action('rejoin', action), { code: 'runtime_failed' });
      assert.equal(donor.state.value.role, 'protected');
      assert.equal(donor.state.value.reason, 'rejoining');
      donor.hooks.closeReplica = closeReplica;
      await donor.close();
      donor = await manager(t, root, 'donor', { role: 'slave', create: false }); connect(primary, donor);
      const source = await donor.exportSnapshot({ force: true });
      const retained = new Store(join(donor.snapshots.directory, `export-${source.generation}.sqlite`), { readOnly: true });
      try { assert.deepEqual(retained.getState('synthetic-unmatched-history'), { value: 'preserve me' }); }
      finally { retained.close(); }
    }
    await primary.action('rejoin', action);
    assert.equal(donor.state.value.role, 'slave');
    for (let n = 0; n < 3; n++) {
      await primary.exportSnapshot({ force: true });
      await donor.synchronize(primary.state.claim());
      await donor.exportSnapshot({ force: true });
    }
    const pins = (await readdir(donor.snapshots.directory)).filter(name => name.endsWith('.pin'));
    assert.equal(pins.length, 1, 'The protected source remains pinned after ordinary export/publication pruning');
    const retainedPath = join(donor.snapshots.directory, pins[0].replace(/\.pin$/, '.sqlite'));
    const retained = new Store(retainedPath, { readOnly: true });
    try { assert.deepEqual(retained.getState('synthetic-unmatched-history'), { value: 'preserve me' }); }
    finally { retained.close(); }
    await donor.close();
    donor = await manager(t, root, 'donor', { role: 'slave', create: false }); connect(primary, donor);
    await donor.synchronize(primary.state.claim());
    assert.equal(donor.state.value.role, 'slave');
    assert.equal(donor.canControl(), false);
    await access(retainedPath);
    await donor.action('promote', command());
    const active = new Store(donor.state.value.activeDbPath, { readOnly: true });
    try { assert.equal(active.getState('synthetic-unmatched-history'), null, 'Inactive retained history never reactivates'); }
    finally { active.close(); }
  });
});

test('a completed protected recovery survives rechecking unchanged history and rejects stale donor roles', async t => {
  const root = await fixture(t);
  const report = { status: 'complete', imported: 1, model: { status: 'rebuilt' } };
  const primary = await manager(t, root, 'master', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId: randomBytes(32).toString('hex'), status: 'checked', model: { status: 'not-assessed' } }),
    recoveryApply: async () => report,
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  await donor.observeClaim(primary.state.claim());
  await primary.action('check-recovery', command());
  await primary.action('recover', { ...command(), previewId: primary.status().recovery.preview.previewId });
  await primary.action('check-recovery', command());
  assert.equal(primary.status().recovery.state, 'complete');
  assert.deepEqual(primary.status().recovery.report, report);
  assert.equal(primary.status().actions.recover, false);
  assert.equal(donor.state.value.role, 'protected', 'waiting and checking never resume mirroring');
  const request = primary.peer.request.bind(primary.peer);
  primary.peer.request = async () => { throw Object.assign(Error(), { code: 'peer_unavailable' }); };
  await assert.rejects(primary.action('check-recovery', command()), { code: 'peer_unavailable' });
  assert.equal(primary.status().recovery.state, 'error');
  assert.deepEqual(primary.status().recovery.report, report);
  assert.equal(primary.status().actions.recover, false);
  assert.equal(primary.status().actions.rejoin, false);
  primary.peer.request = request;
  await primary.action('check-recovery', command());
  assert.equal(primary.status().recovery.state, 'complete');
  assert.deepEqual(primary.status().recovery.report, report);
  await donor.action('promote', command());
  await assert.rejects(primary.action('rejoin', command()), { code: 'invalid_transition' });
  assert.deepEqual(primary.status().recovery.report, report);
  assert.equal(primary.state.value.recovery.releaseOperation, undefined);
});

test('offline donor disables recovery while newer matching protected status can satisfy the fresh identity check', async t => {
  const root = await fixture(t), primary = await manager(t, root, 'master', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId: randomBytes(32).toString('hex'), status: 'checked', model: { status: 'not-assessed' } }),
    recoveryApply: async () => ({ status: 'complete', imported: 1 }),
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  await donor.observeClaim(primary.state.claim());
  await primary.action('check-recovery', command());
  const request = primary.peer.request.bind(primary.peer);
  primary.peer.request = async () => { throw Object.assign(Error(), { code: 'peer_unavailable' }); };
  await primary.poll();
  assert.equal(primary.status().actions.recover, false);
  primary.peer.request = async (operation, ...args) => {
    const result = await request(operation, ...args);
    if (operation === 'status') await primary.handlePeer('status', { claim: donor.state.claim(), sync: donor.sync });
    return result;
  };
  await primary.poll();
  assert.equal(primary.status().actions.recover, true);
  await primary.action('recover', { ...command(), previewId: primary.status().recovery.preview.previewId });
  assert.equal(primary.status().recovery.state, 'complete');
});

test('changed donor evidence after completed recovery requires a fresh recovery decision', async t => {
  const root = await fixture(t);
  const primary = await manager(t, root, 'master', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId: randomBytes(32).toString('hex'), status: 'checked', model: { status: 'not-assessed' } }),
    recoveryApply: async () => ({ status: 'complete', imported: 1 }),
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  await donor.observeClaim(primary.state.claim());
  await primary.action('check-recovery', command());
  await primary.action('recover', { ...command(), previewId: primary.status().recovery.preview.previewId });
  const changed = new DatabaseSync(donor.state.value.activeDbPath);
  changed.exec("INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality) VALUES('fixture','fixture','temperature',23,'degC',900,900,'[]')");
  changed.close();
  await assert.rejects(primary.action('rejoin', command()), { code: 'recovery_required' });
  assert.equal(primary.status().recovery.pendingRelease, null, 'a definite pre-replacement rejection permits a new check');
  await primary.action('check-recovery', command());
  assert.equal(primary.status().recovery.state, 'ready');
  assert.equal(primary.status().recovery.report, null);
  await assert.rejects(primary.action('rejoin', command()), { code: 'recovery_required' });
  assert.equal(donor.state.value.role, 'protected');
});

test('an unassessed protected check offers recovery and requires explicit discard consent to skip it', async t => {
  const root = await fixture(t), primary = await manager(t, root, 'master', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId: randomBytes(32).toString('hex'), status: 'checked', model: { status: 'not-assessed' } }),
    recoveryApply: async () => { throw Error('Explicit discard must not import or rebuild'); },
  } });
  const donor = await manager(t, root, 'donor'); connect(primary, donor);
  await donor.observeClaim(primary.state.claim());
  await primary.poll();
  await primary.action('check-recovery', command());
  assert.equal(primary.status().actions.recover, true);
  assert.equal(primary.status().actions.rejoin, true);
  await assert.rejects(primary.action('rejoin', command()), { code: 'recovery_required' });
  assert.equal(donor.state.value.role, 'protected');
  await primary.action('rejoin', { ...command(), discardUnrecovered: true, previewId: primary.status().recovery.preview.previewId });
  assert.equal(donor.state.value.role, 'slave');
});

test('running replica mutations are preserved before synchronization or ordinary snapshot export', async t => {
  for (const action of ['synchronize', 'export']) await t.test(action, async t => {
    const root = await fixture(t), primary = await manager(t, root, 'master');
    const slave = await manager(t, root, 'slave', { role: 'slave' }); connect(primary, slave);
    await slave.synchronize(primary.state.claim());
    const publication = await readReplicaPublication(slave.config.snapshotDirectory);
    const changed = new DatabaseSync(publication.dbPath);
    changed.exec('UPDATE observations SET value=29'); changed.close();
    if (action === 'synchronize') await slave.synchronize(primary.state.claim());
    else await assert.rejects(slave.exportSnapshot({ force: true }), { code: 'verification_failed' });
    assert.equal(slave.state.value.role, 'protected');
    assert.equal(slave.state.value.reason, 'snapshot_verification_failed');
    const preserved = new DatabaseSync(publication.dbPath, { readOnly: true });
    assert.equal(preserved.prepare('SELECT value FROM observations').get().value, 29); preserved.close();
    const donor = await slave.exportSnapshot({ force: true });
    assert.equal(donor.claim.role, 'protected', 'preserved history remains available for explicit recovery');
  });
});

test('peer snapshot status uses observed public fields and survives slave restart without granting authority', async t => {
  const root = await fixture(t), primary = await manager(t, root, 'master');
  const slave = await manager(t, root, 'slave', { role: 'slave' }); connect(primary, slave);
  await slave.synchronize(primary.state.claim());
  slave.sync.privateDiagnostic = 'private fixture details';
  await primary.poll();
  const peer = primary.status().peer;
  assert.deepEqual(peer.sync, { state: 'ready', sourceAt: slave.sync.sourceAt, verifiedAt: slave.sync.verifiedAt, bytes: slave.sync.bytes });
  assert.equal(Number.isFinite(peer.syncReceivedAt), true);
  assert.doesNotMatch(JSON.stringify(peer.sync), /private/);
  await slave.close();
  const restarted = await manager(t, root, 'slave', { role: 'slave', create: false }); connect(primary, restarted);
  assert.equal(restarted.status().sync.state, 'ready');
  assert.equal(restarted.status().sync.sourceAt, peer.sync.sourceAt);
  assert.equal(restarted.canControl(), false);
  restarted.sync = { state: 'invalid', sourceAt: -1, verifiedAt: 'invalid', bytes: -1 };
  await primary.poll();
  assert.deepEqual(primary.status().peer.sync, { state: 'waiting', sourceAt: null, verifiedAt: null, bytes: null });
  restarted.sync = { state: 'error', error: 'database_algorithm_mismatch', privateDiagnostic: 'private fixture details' };
  await primary.poll();
  assert.deepEqual(primary.status().peer.sync, { state: 'error', sourceAt: null, verifiedAt: null, bytes: null,
    error: 'database_algorithm_mismatch' });
  restarted.sync.error = 'private arbitrary exception';
  await primary.poll();
  assert.equal(primary.status().peer.sync.error, 'peer_protocol_failed');
  assert.doesNotMatch(JSON.stringify(primary.status().peer.sync), /private/);
});

test('a preserved incompatible slave reports its database problem to the master after repeated restarts', async t => {
  const root = await fixture(t), primary = await manager(t, root, 'master');
  let slave = await manager(t, root, 'slave', { role: 'slave' }); connect(primary, slave);
  await slave.synchronize(primary.state.claim());
  const publication = await readReplicaPublication(slave.config.snapshotDirectory);
  await slave.close();
  const changed = new DatabaseSync(publication.dbPath); changed.exec('PRAGMA user_version=7'); changed.close();
  const before = await readFile(publication.dbPath);
  for (let n = 0; n < 2; n++) {
    slave = await manager(t, root, 'slave', { role: 'slave', create: false }); connect(primary, slave);
    await primary.poll();
    assert.equal(primary.status().peer.role, 'protected');
    assert.equal(primary.status().peer.sync.error, 'database_schema_mismatch');
    assert.equal(slave.canControl(), false);
    assert.deepEqual(await readFile(publication.dbPath), before);
    await slave.close();
  }
});

test('simultaneous polls preserve newer peer status and still schedule first mirroring', async t => {
  const root = await fixture(t), primary = await manager(t, root, 'master');
  const slave = await manager(t, root, 'slave', { role: 'slave' }); connect(primary, slave);
  await Promise.all([primary.poll(), slave.poll()]);
  await slave.syncTask;
  assert.equal(slave.status().sync.state, 'ready');
  assert.ok(slave.state.value.accepted);
  assert.equal(slave.state.value.role, 'slave');
});

test('restart protects a replica whose accepted authority contradicts its publication identity', async t => {
  const root = await fixture(t), primary = await manager(t, root, 'master');
  const slave = await manager(t, root, 'slave', { role: 'slave' }); connect(primary, slave);
  await slave.synchronize(primary.state.claim());
  await slave.state.update({ accepted: { ...slave.state.value.accepted, sequence: slave.state.value.accepted.sequence + 1 } });
  await slave.close();
  const restarted = await manager(t, root, 'slave', { role: 'slave', create: false });
  assert.equal(restarted.state.value.role, 'protected');
  assert.equal(restarted.state.value.reason, 'snapshot_verification_failed');
  assert.notEqual(restarted.status().sync.state, 'ready');
});

test('delayed poll success or failure cannot replace newer role and synchronization evidence', async t => {
  for (const failed of [false, true]) await t.test(failed ? 'failure' : 'success', async t => {
    const root = await fixture(t), primary = await manager(t, root, 'master');
    const slave = await manager(t, root, 'slave', { role: 'slave' }); connect(primary, slave);
    let release;
    primary.peer.request = async () => new Promise((resolve, reject) => { release = () => failed
      ? reject(Object.assign(Error(), { code: 'peer_unavailable' }))
      : resolve({ claim: slave.state.claim(), sync: { state: 'waiting' } }); });
    const polling = primary.poll();
    await primary.handlePeer('status', { claim: { ...slave.state.claim(), role: 'protected' }, sync: { state: 'error' } });
    release(); await polling;
    assert.equal(primary.status().peer.reachable, true);
    assert.equal(primary.status().peer.role, 'protected');
    assert.equal(primary.status().peer.sync.state, 'error');
  });
});
