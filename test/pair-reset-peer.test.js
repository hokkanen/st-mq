import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { peerOperation } from '../src/replication/coalesced.js';
import { fixtureMqttFrontend, fixtureMqttSourceContext } from './helpers/pair-frontend.js';

test('keep reset preserves an interrupted seed as evidence and starts a new peer delivery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stmq-reset-peer-')), directory = join(root, 'data');
  const config = { ...loadConfig({ XDG_CONFIG_HOME: root, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, root),
    input: 'mqtt', role: 'slave', topology: 'pair', connections: { mqtt: { address: 'mqtt://127.0.0.1' } } };
  config.charging.vehicles.bmw.mqttTopic = '';
  config.garage = { ...config.garage, enabled: false, adapter: {}, sender: {} };
  config.pair = { directory: join(directory, 'pairing'), databasePath: config.dbPath,
    snapshotDirectory: join(directory, 'pair-snapshots'), platform: 'ubuntu', pairId: 'synthetic-reset-peer',
    token: 'synthetic-reset-peer-token-0123456789', peerUrl: 'http://127.0.0.1:1', listenHost: '127.0.0.1',
    port: 0, intervalMs: 60000, timeoutMs: 30000, vip: {}, mqtt: config.connections.mqtt };
  let owned = false;
  const open = () => start({ config, installSignalHandlers: false, providerOptions: { automatic: false },
    mqttOptions: { connect: () => { throw Error('Unexpected MQTT connection in a reset fixture'); } },
    pairOptions: { frontendFactory: fixtureMqttFrontend, sourceContextFactory: fixtureMqttSourceContext,
      validateBroker: async () => {}, prepareVipPolicy: async () => {},
      managerOptions: { announcements: () => null, vip: { acquire: async () => { owned = true; },
        release: async () => { owned = false; }, status: () => ({ owned }) } } } });
  let app = await open();
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const promote = async () => {
    await app.pair.action('promote', { requestId: randomUUID(), confirmed: true });
    clearTimeout(app.pair.timer); await app.pair.polling; clearTimeout(app.pair.timer);
  };
  await promote();
  app.store.event('synthetic-kept-peer-evidence', { value: 1 }, Date.now());
  const previousSeed = await app.pair.exportPeerSeed();
  const previous = await peerOperation('anchor', { dbPath: app.store.path });
  const sourceBytes = await readFile(previous.pending.sourcePath), spoolBytes = await readFile(previous.pending.path);
  app.requestAction({ action: 'reset', mode: 'keep', requestId: randomUUID(), confirmed: true, resetToken: app.status().reset.token });
  for (let i = 0; i < 1000 && app.status().uiOperation.state === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const result = app.status().uiOperation;
  assert.equal(result.state, 'complete', result.error);
  assert.equal(app.pair.canControl(), false);
  const archive = result.result.archiveDirectory, plan = JSON.parse(await readFile(join(archive, 'reset.json'), 'utf8'));
  const archived = source => join(archive, plan.entries.find(entry => entry.source === source).destination);
  assert.deepEqual(await readFile(archived(previous.pending.sourcePath)), sourceBytes);
  assert.deepEqual(await readFile(archived(previous.pending.path)), spoolBytes);
  const kept = await peerOperation('anchor', { dbPath: app.pair.state.value.activeDbPath });
  assert.equal(kept.pending, null, 'the kept copy belongs to the reset pairing, not the archived pending delivery');
  await app.close(); app = await open();
  assert.equal(app.pair.canControl(), false, 'reset history still requires explicit promotion after restart');
  await promote();
  const nextSeed = await app.pair.exportPeerSeed();
  assert.notEqual(nextSeed.generation, previousSeed.generation);
  assert.equal(app.store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='synthetic-kept-peer-evidence'").get().n, 1);
});
