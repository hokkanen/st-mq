import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { Store } from '../src/storage/store.js';
import { readReplicaPublication } from '../src/replication/publication.js';
import { replayLearningJournal, LEARNING_WINDOW_MS } from '../src/app/committed-learning.js';

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
      input: 'mqtt', role, connections: { mqtt: { address: 'mqtt://127.0.0.1' } } };
    config.pairing = { enabled: true, directory: join(directory, 'pairing'), databasePath: config.dbPath,
      replicaDirectory: config.replication.directory, initialRole: role, platform, pairId: 'synthetic-runtime-pair',
      token: 'synthetic-runtime-shared-token-0123456789', peerUrl: 'http://127.0.0.1:1',
      listenHost: '127.0.0.1', port: 0, intervalMs: 60000, timeoutMs: 30000, vip: {}, mqtt: config.connections.mqtt };
    let owned = false;
    const app = await start({ config, clock: () => now, installSignalHandlers: false, providerOptions: { automatic: false },
      pairingOptions: { validateBroker: async () => {}, prepareVipPolicy: async () => {}, managerOptions: {
        announcements: () => null, vip: { acquire: async () => { owned = true; }, release: async () => { owned = false; },
          status: () => ({ owned, ready: owned }) } } } });
    clearTimeout(app.pairing.timer); await app.pairing.polling; clearTimeout(app.pairing.timer);
    running.add(app); return app;
  }
  return { open, async close(app) { await app.close(); running.delete(app); } };
}
function connect(a, b) {
  a.pairing.peer.peerUrl = `http://127.0.0.1:${b.pairing.peer.server.address().port}`;
  b.pairing.peer.peerUrl = `http://127.0.0.1:${a.pairing.peer.server.address().port}`;
}
const url = app => `http://127.0.0.1:${app.server.address().port}`;
async function apiAction(app, body) {
  const response = await fetch(`${url(app)}/api/pairing/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 202);
  const accepted = await response.json(); assert.equal(accepted.uiOperation.id, body.requestId);
  await until(() => app.status().uiOperation?.state !== 'running');
  assert.equal(app.status().uiOperation.state, 'complete', JSON.stringify(app.status()));
}
function observation(store, at, value) {
  store.observation({ source: 'synthetic', device: 'invented-home', signal: 'indoor_temperature',
    value, unit: 'degC', sourceTime: at, receivedAt: at });
}

test('full application handover switches controller/viewer, preserves durable roles and exposes idempotent UI actions', async t => {
  const f = await fixture(t), a = await f.open('a', 'primary', 'hassio'), b = await f.open('b', 'replica', 'ubuntu');
  connect(a, b); observation(a.store, now - W, 20);
  await b.pairing.synchronize(a.pairing.state.claim());
  assert.equal(b.pairing.sync.state, 'ready');
  const initial = await (await fetch(`${url(b)}/api/status`)).json();
  assert.equal(initial.readOnly, true); assert.equal(initial.pairing.role, 'replica');
  assert.equal((await fetch(`${url(b)}/api/settings/reload`, { method: 'POST' })).status, 405);
  const handover = command('handover'); await apiAction(a, handover);
  assert.equal(a.pairing.canControl(), false); assert.equal(b.pairing.canControl(), true);
  assert.equal(a.engine, undefined); assert.equal(b.engine.config.input, 'mqtt');
  assert.equal(b.store.latestObservation('indoor_temperature').value, 20);
  await apiAction(a, handover);
  await a.pairing.poll();
  assert.equal(a.pairing.state.value.role, 'replica', 'intentional Hassio demotion does not automatically take control back');
  await f.close(a); const restarted = await f.open('a', 'primary', 'hassio'); connect(restarted, b);
  assert.equal(restarted.pairing.state.value.role, 'replica'); assert.equal(restarted.engine, undefined);
  await restarted.pairing.synchronize(b.pairing.state.claim()); assert.equal(restarted.pairing.sync.state, 'ready');
});

test('outage promotion, returning Hassio, manual gap recovery and exact rejoin run through real app lifecycle', async t => {
  const f = await fixture(t), a = await f.open('a', 'primary', 'hassio'), b = await f.open('b', 'replica', 'ubuntu');
  connect(a, b); observation(a.store, now - 4 * W, 20);
  await b.pairing.synchronize(a.pairing.state.claim()); assert.equal(b.pairing.sync.state, 'ready');
  await f.close(a);
  await apiAction(b, command('promote')); assert.equal(b.pairing.canControl(), true);
  observation(b.store, now - 3 * W, 21);
  observation(b.store, now - 2 * W, 99); // conflict: returning master's observation must win.
  b.store.setState('synthetic-donor-only-state', { obsolete: true });
  const returned = await f.open('a', 'primary', 'hassio');
  observation(returned.store, now - 2 * W, 22);
  connect(returned, b); await b.pairing.observeClaim(returned.pairing.state.claim());
  assert.equal(b.pairing.state.value.role, 'protected'); assert.equal(b.engine, undefined);
  await apiAction(returned, command('check-recovery'));
  const preview = returned.pairing.state.value.recovery.preview;
  assert.match(preview.previewId, /^[a-f0-9]{64}$/); assert.ok(preview.counts.missing >= 1);
  await apiAction(returned, command('recover', { previewId: preview.previewId }));
  assert.equal(b.pairing.state.value.role, 'protected');
  assert.equal(returned.store.observations().find(row => row.sourceTime === now - 3 * W).value, 21);
  assert.equal(returned.store.observations().find(row => row.sourceTime === now - 2 * W).value, 22);
  assert.deepEqual(replayLearningJournal(returned.store, 'mqtt', null, { rebuild: true }), returned.engine.checkpoint);
  await apiAction(returned, command('rejoin'));
  assert.equal(b.pairing.state.value.role, 'replica');
  const publication = await readReplicaPublication(b.pairing.config.replicaDirectory);
  const replica = new Store(publication.dbPath, { readOnly: true });
  try {
    assert.equal(replica.getState('synthetic-donor-only-state'), null);
    assert.equal(replica.observations().find(row => row.sourceTime === now - 2 * W).value, 22);
    assert.equal(replica.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(replica.db.prepare('PRAGMA foreign_key_check').get(), undefined);
  } finally { replica.close(); }
  assert.equal(publication.digest, returned.pairing.state.value.recovery?.metadata?.digest ?? b.pairing.state.value.accepted.digest);
  await f.close(returned);
  await apiAction(b, command('promote'));
  assert.equal(b.store.getState('synthetic-donor-only-state'), null, 'later promotion uses clean mirrored database');
});
