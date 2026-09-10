// Run only inside the disposable, networkless container test fixture.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';

assert.equal(process.env.STMQ_CONTAINER_FIXTURE, '1');
assert.equal(spawnSync('sqlite3_rsync', ['--version'], { stdio: 'ignore' }).status, 0);
assert.equal(spawnSync('ssh', ['-V'], { stdio: 'ignore' }).status, 0);
assert.equal(spawnSync('ip', ['-Version'], { stdio: 'ignore' }).status, 0);
assert.equal(spawnSync('arping', ['-V'], { stdio: 'ignore' }).status, 0);
// Invalid arguments must fail without issuing any network mutation.
assert.equal(spawnSync('/usr/local/bin/st-mq-vip', ['invalid'], { stdio: 'ignore' }).status, 1);
const config = loadConfig({ XDG_CONFIG_HOME: '/missing-replica-fixture', STMQ_ROLE: 'replica',
  STMQ_INPUT: 'mqtt', STMQ_MODE: 'active', STMQ_PORT: '0', STMQ_HOST: '127.0.0.1',
  STMQ_DATA_DIR: '/tmp/replica-smoke-unused', STMQ_REPLICA_DIR: '/tmp/replica-smoke-waiting' });
const app = await start({ config });
try {
  const endpoint = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${endpoint}/api/status`);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.role, 'replica');
  assert.equal(status.replication.state, 'waiting');
  assert.equal(status.liveWrites, false);
  assert.equal(app.engine, undefined);
  assert.equal((await fetch(`${endpoint}/`)).status, 200);
  assert.equal((await fetch(`${endpoint}/api/heating-test`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 405);
  assert.equal(existsSync(config.dbPath), false);
  assert.equal(existsSync(config.replication.directory), false);
} finally { await app.close(); }
console.log('Replica container viewer and bundled SSH/SQLite/VIP tools passed.');
