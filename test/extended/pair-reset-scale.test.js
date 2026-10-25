import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, copyFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Store } from '../../src/storage/store.js';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';
import { fixtureMqttFrontend, fixtureMqttSourceContext } from '../helpers/pair-frontend.js';

// Explicit extended workload: current-schema synthetic records only. No household
// configuration, broker, virtual address, provider or controller may be opened.
test('populated GiB history resets stay fast without backup and keep progress responsive with backup', { timeout: 600000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'stmq-reset-scale-'));
  let app;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  const target = 1024 ** 3, source = join(root, 'synthetic.sqlite');
  const store = new Store(source), payload = { synthetic: 'x'.repeat(32768) };
  let records = 0;
  try {
    while (store.db.prepare('PRAGMA page_count').get().page_count * 4096 < target) {
      store.transaction(() => { for (let i = 0; i < 64; i++) store.event('synthetic-reset-scale', payload, ++records); });
      if (records % 1024 === 0) await new Promise(resolve => setImmediate(resolve));
    }
  } finally { await store.close(); }
  const sourceBytes = (await stat(source)).size, results = [];
  for (const [mode, backup] of [['keep', false], ['fresh', false], ['fresh', true]]) {
    const directory = join(root, `${mode}-${backup}`);
    const config = { ...loadConfig({ XDG_CONFIG_HOME: root, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, root), input: 'mqtt', role: 'slave', topology: 'pair',
      connections: { mqtt: { address: 'mqtt://127.0.0.1' } } };
    config.pair = { directory: join(directory, 'pairing'), snapshotDirectory: join(directory, 'pair-snapshots'), databasePath: config.dbPath,
      platform: 'ubuntu', pairId: 'synthetic-reset-scale-pair', token: 'synthetic-reset-scale-shared-token-0123456789', peerUrl: 'http://127.0.0.1:1',
      listenHost: '127.0.0.1', port: 0, intervalMs: 60000, timeoutMs: 30000, vip: {}, mqtt: config.connections.mqtt };
    await mkdir(directory, { recursive: true });
    await copyFile(source, config.dbPath);
    app = await start({ config, installSignalHandlers: false,
      pairOptions: { startRuntime: () => { throw Error('Scale fixture must never start control'); }, frontendFactory: fixtureMqttFrontend, sourceContextFactory: fixtureMqttSourceContext,
        validateBroker: async () => {}, prepareVipPolicy: async () => {},
        managerOptions: { announcements: () => null, vip: { release: async () => {}, status: () => ({ owned: false }) } } } });
    const endpoint = `http://127.0.0.1:${app.server.address().port}`;
    const started = performance.now();
    app.requestAction({ action: 'reset', mode, nodeId: app.status().nodeId, requestId: randomUUID(), confirmed: true, resetToken: app.status().reset.token,
      ...(mode === 'fresh' ? { backup, restorationConfirmed: true, ...(!backup ? { discardConfirmed: true } : {}) } : {}) });
    let polls = 0, maxPollMs = 0, reconnects = 0;
    while (app.status().uiOperation.state === 'running') {
      const at = performance.now();
      try {
        const response = await fetch(`${endpoint}/api/pair`, { signal: AbortSignal.timeout(2000) });
        assert.equal(response.status, 200); await response.json(); polls++; maxPollMs = Math.max(maxPollMs, performance.now() - at);
      } catch (error) {
        // Only the final listener replacement may require reconnecting. Archive
        // and backup phases must retain the original management listeners.
        assert.equal(app.status().uiOperation.progress?.phase, 'reset-finishing', String(error)); reconnects++;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const ms = Math.round(performance.now() - started), operation = app.status().uiOperation;
    assert.equal(operation.state, 'complete', operation.error);
    assert.equal(app.pair.canControl(), false);
    if (!backup) assert(ms < 5000, `Fast reset exceeded 5 seconds: ${ms}`);
    else assert.equal(operation.result.backupCount, 1);
    if (mode === 'keep') {
      const reader = new Store(app.pair.state.value.activeDbPath, { readOnly: true });
      try { assert.equal(reader.db.prepare('SELECT COUNT(*) n FROM events').get().n, records); } finally { await reader.close(); }
    }
    results.push({ mode, backup, sourceBytes, records, ms, polls, maxPollMs: Math.round(maxPollMs), reconnects });
    await app.close(); app = null;
  }
  console.log(JSON.stringify({ resetScale: results }));
});
