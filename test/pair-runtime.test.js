import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { Store } from '../src/storage/store.js';
import { readReplicaPublication } from '../src/replication/publication.js';
import { replayLearningJournal, LEARNING_WINDOW_MS } from '../src/app/committed-learning.js';
import { pairDisplay } from '../chart/pair-status.js';

const W = LEARNING_WINDOW_MS, now = Date.parse('2026-01-09T12:00Z');
const command = (action, extra = {}) => ({ action, requestId: randomUUID(), confirmed: true, ...extra });
async function until(check) {
  for (let i = 0; i < 1000; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Paired runtime did not reach the expected state');
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-pair-runtime-')), running = new Set();
  t.after(async () => { for (const app of running) await app.close(); await rm(root, { recursive: true, force: true }); });
  async function open(name, role, platform) {
    const directory = join(root, name);
    const config = { ...loadConfig({ XDG_CONFIG_HOME: root, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, directory),
      input: 'mqtt', role: 'slave', connections: { mqtt: { address: 'mqtt://127.0.0.1' } } };
    config.topology = 'pair';
    config.pair = { directory: join(directory, 'pairing'), databasePath: config.dbPath,
      snapshotDirectory: join(directory, 'pair-snapshots'), platform, pairId: 'synthetic-runtime-pair',
      token: 'synthetic-runtime-shared-token-0123456789', peerUrl: 'http://127.0.0.1:1',
      listenHost: '127.0.0.1', port: 0, intervalMs: 60000, timeoutMs: 30000, vip: {}, mqtt: config.connections.mqtt };
    const fresh = await access(join(config.pair.directory, 'state.json')).then(() => false, () => true);
    let owned = false;
    const app = await start({ config, clock: () => now, installSignalHandlers: false, providerOptions: { automatic: false },
      pairOptions: { validateBroker: async () => {}, prepareVipPolicy: async () => {}, managerOptions: {
        announcements: () => null, vip: { acquire: async () => { owned = true; }, release: async () => { owned = false; },
          status: () => ({ owned, ready: owned }) } } } });
    if (fresh && role === 'master') {
      try { await app.pair.action('promote', { requestId: randomUUID(), confirmed: true }); }
      catch (error) { if (app.pair.state.value.role !== 'protected' || !app.pair.state.value.activationError) throw error; }
    }
    clearTimeout(app.pair.timer); await app.pair.polling; clearTimeout(app.pair.timer);
    running.add(app); return app;
  }
  return { open, async close(app) { await app.close(); running.delete(app); } };
}
function connect(a, b) {
  a.pair.peer.peerUrl = `http://127.0.0.1:${b.pair.peer.server.address().port}`;
  b.pair.peer.peerUrl = `http://127.0.0.1:${a.pair.peer.server.address().port}`;
}
const url = app => `http://127.0.0.1:${app.server.address().port}`;
async function apiAction(app, body) {
  const response = await fetch(`${url(app)}/api/pair/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 202);
  const accepted = await response.json(); assert.equal(accepted.uiOperation.id, body.requestId);
  await until(() => app.status().uiOperation?.state !== 'running');
  assert.equal(app.status().uiOperation.state, 'complete', JSON.stringify(app.status()));
}
function observation(store, at, value) {
  store.observation({ source: 'synthetic', device: 'invented-home', signal: 'indoor_temperature',
    value, unit: 'degC', sourceTime: at, receivedAt: at });
}

test('both fresh pair nodes stay read-only until explicit promotion, then restart preserves the chosen master', async t => {
  const f = await fixture(t), a = await f.open('a', 'slave', 'hassio'), b = await f.open('b', 'slave', 'ubuntu');
  connect(a, b);
  for (const app of [a, b]) {
    assert.equal(app.engine, undefined);
    assert.equal(app.pair.canControl(), false);
    assert.equal(app.pair.status().role, 'slave');
    assert.equal(app.pair.status().bootstrapPending, true);
    assert.equal(app.pair.status().actions.promote, true);
    await assert.rejects(access(app.pair.config.databasePath), { code: 'ENOENT' });
    await app.pair.poll();
    assert.equal(app.pair.canControl(), false);
  }
  await assert.rejects(a.pair.action('promote', { requestId: randomUUID() }), { code: 'confirmation_required' });
  await apiAction(a, command('promote'));
  assert.equal(a.pair.canControl(), true);
  assert.equal(a.pair.status().bootstrapPending, false);
  assert.equal(a.pair.state.value.everWritten, true);
  await b.pair.synchronize(a.pair.state.claim());
  assert.equal(b.pair.status().bootstrapPending, false);
  assert.equal(b.pair.canControl(), false);
  await f.close(a);
  const restarted = await f.open('a', 'slave', 'hassio');
  assert.equal(restarted.pair.status().role, 'master');
  assert.equal(restarted.pair.canControl(), true);
});

test('full application handover switches controller/viewer, preserves durable roles and exposes idempotent UI actions', async t => {
  const f = await fixture(t), a = await f.open('a', 'master', 'hassio'), b = await f.open('b', 'slave', 'ubuntu');
  connect(a, b); observation(a.store, now - W, 20);
  await b.pair.synchronize(a.pair.state.claim());
  assert.equal(b.pair.sync.state, 'ready');
  const initial = await (await fetch(`${url(b)}/api/status`)).json();
  assert.equal(initial.readOnly, true); assert.equal(initial.pair.role, 'slave');
  assert.equal((await fetch(`${url(b)}/api/settings/reload`, { method: 'POST' })).status, 405);
  const handover = command('handover'); await apiAction(a, handover);
  assert.equal(a.pair.canControl(), false); assert.equal(b.pair.canControl(), true);
  assert.equal(a.engine, undefined); assert.equal(b.engine.config.input, 'mqtt');
  assert.equal(b.store.latestObservation('indoor_temperature').value, 20);
  await apiAction(a, handover);
  await a.pair.poll();
  assert.equal(a.pair.state.value.role, 'slave', 'intentional Hassio demotion does not automatically take control back');
  await f.close(a); const restarted = await f.open('a', 'master', 'hassio'); connect(restarted, b);
  assert.equal(restarted.pair.state.value.role, 'slave'); assert.equal(restarted.engine, undefined);
  await restarted.pair.synchronize(b.pair.state.claim()); assert.equal(restarted.pair.sync.state, 'ready');
});

test('outage promotion, returning Hassio, manual gap recovery and exact rejoin run through real app lifecycle', async t => {
  const f = await fixture(t), a = await f.open('a', 'master', 'hassio'), b = await f.open('b', 'slave', 'ubuntu');
  connect(a, b); observation(a.store, now - 4 * W, 20);
  await b.pair.synchronize(a.pair.state.claim()); assert.equal(b.pair.sync.state, 'ready');
  await f.close(a);
  await apiAction(b, command('promote')); assert.equal(b.pair.canControl(), true);
  observation(b.store, now - 3 * W, 21);
  observation(b.store, now - 2 * W, 99); // conflict: returning master's observation must win.
  b.store.setState('synthetic-donor-only-state', { obsolete: true });
  const returned = await f.open('a', 'master', 'hassio');
  observation(returned.store, now - 2 * W, 22);
  connect(returned, b); await b.pair.observeClaim(returned.pair.state.claim());
  assert.equal(b.pair.state.value.role, 'protected'); assert.equal(b.engine, undefined);
  await apiAction(returned, command('check-recovery'));
  const preview = returned.pair.state.value.recovery.preview;
  assert.match(preview.previewId, /^[a-f0-9]{64}$/); assert.ok(preview.counts.missing >= 1);
  await apiAction(returned, command('recover', { previewId: preview.previewId }));
  assert.equal(b.pair.state.value.role, 'protected');
  assert.equal(returned.store.observations().find(row => row.sourceTime === now - 3 * W).value, 21);
  assert.equal(returned.store.observations().find(row => row.sourceTime === now - 2 * W).value, 22);
  assert.deepEqual(replayLearningJournal(returned.store, 'mqtt', null, { rebuild: true }), returned.engine.checkpoint);
  await apiAction(returned, command('rejoin'));
  assert.equal(b.pair.state.value.role, 'slave');
  const publication = await readReplicaPublication(b.pair.config.snapshotDirectory);
  const replica = new Store(publication.dbPath, { readOnly: true });
  try {
    assert.equal(replica.getState('synthetic-donor-only-state'), null);
    assert.equal(replica.observations().find(row => row.sourceTime === now - 2 * W).value, 22);
    assert.equal(replica.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(replica.db.prepare('PRAGMA foreign_key_check').get(), undefined);
  } finally { replica.close(); }
  assert.equal(publication.digest, returned.pair.state.value.recovery?.metadata?.digest ?? b.pair.state.value.accepted.digest);
  await f.close(returned);
  await apiAction(b, command('promote'));
  assert.equal(b.store.getState('synthetic-donor-only-state'), null, 'later promotion uses clean mirrored database');
});

test('HTTP rejoin can explicitly skip checked gaps while preserving the master history and model', async t => {
  const f = await fixture(t), master = await f.open('master', 'master', 'hassio'), donor = await f.open('donor', 'master', 'ubuntu');
  observation(master.store, now - 4 * W, 20);
  observation(donor.store, now - 3 * W, 21);
  donor.store.setState('synthetic-donor-only-state', { obsolete: true });
  connect(master, donor); await donor.pair.observeClaim(master.pair.state.claim());
  await apiAction(master, command('check-recovery'));
  const preview = master.status().recovery.preview;
  assert.ok(preview.counts.missing > 0);
  const before = { observations: master.store.observations(), checkpoint: structuredClone(master.engine.checkpoint),
    epoch: master.store.learningEpoch('mqtt'), journal: master.store.db.prepare('SELECT * FROM learning_journal_all').all() };
  for (const body of [command('recover', { previewId: preview.previewId, discardUnrecovered: true }),
    command('rejoin', { previewId: preview.previewId, discardUnrecovered: 'true' })]) {
    const rejected = await fetch(`${url(master)}/api/pair/action`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(rejected.status, 409);
  }
  await apiAction(master, command('rejoin', { previewId: preview.previewId, discardUnrecovered: true }));
  assert.deepEqual(master.store.observations(), before.observations);
  assert.deepEqual(master.engine.checkpoint, before.checkpoint);
  assert.equal(master.store.learningEpoch('mqtt'), before.epoch);
  assert.deepEqual(master.store.db.prepare('SELECT * FROM learning_journal_all').all(), before.journal);
  assert.equal(master.status().recovery.report.recoverySkipped, true);
  assert.equal(master.status().recovery.report.imported, 0);
  assert.equal(donor.pair.state.value.role, 'slave');
  const publication = await readReplicaPublication(donor.pair.config.snapshotDirectory);
  const replica = new Store(publication.dbPath, { readOnly: true });
  try {
    assert.deepEqual(replica.observations(), before.observations);
    assert.equal(replica.getState('synthetic-donor-only-state'), null);
    assert.equal(replica.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(replica.db.prepare('PRAGMA foreign_key_check').get(), undefined);
  } finally { replica.close(); }
});

test('normal mirror checks preserve unavailable evidence and never restore deliberate master deletions', async t => {
  const f = await fixture(t), master = await f.open('master', 'master', 'hassio'), slave = await f.open('slave', 'slave', 'ubuntu');
  connect(master, slave);
  for (const [index, value, quality] of [[1, null, ['missing', 'unavailable']], [2, 20, ['stale']], [3, 0, []]])
    master.store.observation({ source: 'synthetic', device: 'invented-home', signal: 'indoor_temperature',
      value, unit: 'degC', sourceTime: now - index * W, receivedAt: now - index * W, quality });
  await slave.pair.synchronize(master.pair.state.claim());
  const original = master.store.observations();
  for (let iteration = 0; iteration < 2; iteration++) {
    await apiAction(master, command('check-recovery'));
    const status = master.status();
    assert.equal(status.recovery.donorRole, 'slave');
    assert.equal(status.recovery.preview.counts.missing, 0, 'A verified mirror must not manufacture missing observations');
    assert.equal(status.actions.recover, false);
    assert.equal(status.actions.rejoin, false);
    assert.doesNotMatch(pairDisplay(status).recovery, /discard|then resume|recover the gaps/i);
    assert.equal(slave.status().role, 'slave');
    assert.deepEqual(master.store.observations(), original, 'Checking is read-only even for unavailable measurements');
    await slave.pair.synchronize(master.pair.state.claim());
  }
  const removed = master.store.db.prepare("SELECT id FROM observations WHERE source='synthetic' AND value=0").get().id;
  master.store.db.prepare('DELETE FROM observations WHERE id=?').run(removed);
  await apiAction(master, command('check-recovery'));
  assert.ok(master.status().recovery.preview.counts.missing > 0, 'The old mirror still has the deliberately deleted record');
  assert.equal(master.status().actions.recover, false, 'A snapshot difference cannot authorize importing an old master deletion');
  assert.equal(master.status().actions.rejoin, false);
  await assert.rejects(master.pair.action('recover', command('recover', { previewId: master.status().recovery.preview.previewId })));
  await assert.rejects(master.pair.action('rejoin', command('rejoin', { discardUnrecovered: true,
    previewId: master.status().recovery.preview.previewId })));
  assert.equal(master.store.db.prepare('SELECT 1 FROM observations WHERE id=?').get(removed), undefined);
  await master.pair.exportSnapshot({ force: true });
  await slave.pair.synchronize(master.pair.state.claim());
  await apiAction(master, command('check-recovery'));
  assert.equal(master.status().recovery.preview.counts.missing, 0, 'The next ordinary mirror applies the deletion');
  await master.pair.poll();
  const masterStatus = master.status(), slaveStatus = slave.status();
  assert.equal(masterStatus.peer.role, slaveStatus.role);
  assert.equal(masterStatus.peer.sync.sourceAt, slaveStatus.sync.sourceAt);
  assert.equal(masterStatus.peer.sync.verifiedAt, slaveStatus.sync.verifiedAt);
  assert.equal(masterStatus.peer.sync.state, slaveStatus.sync.state);
  assert.doesNotMatch(pairDisplay(masterStatus).sync, /blocked|needs attention/i);
  assert.doesNotMatch(pairDisplay(slaveStatus).sync, /blocked|needs attention/i);
});

test('completed recovery stays protected without rejoin through rejected actions, restart and another check', async t => {
  const f = await fixture(t), master = await f.open('master', 'master', 'hassio'), donor = await f.open('donor', 'master', 'ubuntu');
  observation(master.store, now - 3 * W, 20);
  observation(donor.store, now - 2 * W, 21);
  connect(master, donor);
  await donor.pair.observeClaim(master.pair.state.claim());
  await apiAction(master, command('check-recovery'));
  await apiAction(master, command('recover', { previewId: master.status().recovery.preview.previewId }));
  const report = structuredClone(master.status().recovery.report);
  await master.pair.poll(); await donor.pair.poll();
  assert.equal(master.status().peer.role, 'protected');
  assert.equal(donor.status().role, 'protected');
  assert.match(pairDisplay(donor.status()).sync, /blocked/i);
  assert.equal(master.status().actions.handover, false);
  await assert.rejects(master.pair.action('handover', command('handover')));
  assert.deepEqual(master.status().recovery.report, report, 'An invalid action cannot discard completed recovery evidence');
  assert.equal(donor.status().role, 'protected');
  await f.close(master);
  const restarted = await f.open('master', 'master', 'hassio'); connect(restarted, donor);
  await restarted.pair.poll(); await donor.pair.poll();
  assert.equal(restarted.status().recovery.state, 'complete');
  assert.deepEqual(restarted.status().recovery.report, report);
  assert.equal(donor.status().role, 'protected', 'Restart must not silently resume mirroring');
  await apiAction(restarted, command('check-recovery'));
  assert.equal(restarted.status().recovery.state, 'complete', 'An unchanged checked donor retains the completed recovery');
  assert.deepEqual(restarted.status().recovery.report, report);
  assert.equal(restarted.status().actions.rejoin, true);
  assert.equal(restarted.status().actions.recover, false);
  await apiAction(restarted, command('rejoin'));
  await restarted.pair.poll(); await donor.pair.poll();
  assert.equal(restarted.status().recovery.state, 'resolved');
  assert.equal(restarted.status().peer.role, 'slave');
  assert.equal(donor.status().role, 'slave');
  assert.equal(donor.pair.canControl(), false);
  assert.doesNotMatch(pairDisplay(donor.status()).sync, /blocked/i);
});
