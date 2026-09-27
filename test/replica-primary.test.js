import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/app/config.js';
import { start } from '../src/main.js';

test('optional synchronization failure leaves the primary running and control API usable', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-primary-sync-'));
  const path = join(directory, 'secrets.json');
  writeFileSync(path, JSON.stringify({ controller: { topology: 'mirror' }, mirror: { ssh_host: 'invented-replica',
    remote_directory: '/invented/replica', receiver_path: '/invented/receiver.js',
    rsync_path: join(directory, 'unavailable-tool') } }), { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: path, STMQ_PORT: '0', STMQ_DATA_DIR: join(directory, 'data') }, directory);
  const app = await start({ config });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  for (let attempt = 0; attempt < 200 && app.mirror.status().state !== 'error'; attempt++) await delay(5);
  assert.equal(app.mirror.status().error, 'tool_unavailable');
  const endpoint = `http://127.0.0.1:${app.server.address().port}`;
  let response = await fetch(`${endpoint}/api/status`);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.sync.state, 'error');
  assert.ok(status.sync.nextAttemptAt > status.sync.lastAttemptAt);
  assert.ok(!JSON.stringify(status.sync).includes(directory));
  assert.ok(!JSON.stringify(status.sync).includes('invented-replica'));
  response = await fetch(`${endpoint}/api/temporary`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pauseUntil: new Date(Date.now() + 60_000).toISOString() }) });
  assert.equal(response.status, 200);
  assert.ok(app.store.getState('override:simulated'));
  assert.equal(app.mirror.status().state, 'error');
  const stop = app.mirror.stop.bind(app.mirror);
  let finishCopyCleanup;
  const copyCleanup = new Promise(resolve => { finishCopyCleanup = resolve; });
  app.mirror.stop = async () => { await stop(); await copyCleanup; };
  const closing = app.close();
  try {
    for (let attempt = 0; attempt < 200 && !app.engine.executor.closed; attempt++) await delay(5);
    assert.equal(app.engine.executor.closed, true, 'Equipment shutdown precedes slow replication cleanup');
  } finally { finishCopyCleanup(); await closing; }
});

test('changing replication or instance role requires restart without replacing the running controller', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-primary-reload-'));
  const path = join(directory, 'secrets.json');
  writeFileSync(path, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: path, STMQ_PORT: '0', STMQ_DATA_DIR: join(directory, 'data') }, directory);
  const app = await start({ config });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const engine = app.engine;
  for (const options of [{ mirror: { interval_seconds: 120 } }, { controller: { topology: 'mirror' }, mirror: { role: 'slave' } }]) {
    writeFileSync(path, JSON.stringify(options), { mode: 0o600 });
    await assert.rejects(app.reloadSettings(), /Restart to apply/);
    assert.equal(app.engine, engine);
    assert.equal(app.store.getState('settings:simulated')?.mode ?? app.engine.settings.mode, 'shadow');
  }
});
