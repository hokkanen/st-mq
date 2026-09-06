import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { spawnSync } from 'node:child_process';

test('legacy publisher exits at the live gate before loading credentials or connecting', () => {
  const result = spawnSync(process.execPath, ['scripts/mqtt-control.js'], { encoding: 'utf8', env: { ...process.env, STMQ_LEGACY_LIVE: '' }, timeout: 3000 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Legacy live publishing is disabled/);
  assert.doesNotMatch(result.stdout, /MQTT client connected|MQTT published/);
});

test('standalone entry starts offline promptly, serves built UI, survives restart and closes workers', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-startup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = loadConfig({ STMQ_DATA_DIR: directory, STMQ_PORT: '0' });
  const started = performance.now();
  const app = await start({ config });
  try {
    assert.ok(performance.now() - started < 3000);
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/status`);
    const status = await response.json();
    assert.equal(status.input, 'simulated');
    assert.equal(status.liveWrites, false);
    app.engine.setOverride(60);
    // A conflicting listener must close its worker instead of hanging startup.
    await assert.rejects(start({ config: { ...config, dataDir: join(directory, 'conflict'), dbPath: join(directory, 'conflict/test.sqlite'), port: app.server.address().port } }), /EADDRINUSE/);
  } finally { await app.close(); }
  const restarted = await start({ config });
  try { assert.equal(restarted.engine.status().override.mode, 'normal'); }
  finally { await restarted.close(); }
});

test('deployment metadata uses an explicit Node base, persistent storage and both required architectures', () => {
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  assert.match(dockerfile, /ARG BUILD_FROM=node:22-alpine/);
  assert.match(dockerfile, /STMQ_DATA_DIR=\/data\/st-mq/);
  assert.match(dockerfile, /CMD \["node", "src\/main.js"\]/);
  const addon = JSON.parse(readFileSync('config.json', 'utf8'));
  assert.deepEqual(addon.arch, ['aarch64', 'amd64']);
  assert.equal(addon.options.controller.input, 'simulated');
  assert.equal(addon.options.controller.mode, 'shadow');
  assert.equal(addon.version, JSON.parse(readFileSync('package.json', 'utf8')).version);
});
