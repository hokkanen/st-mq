import assert from 'node:assert/strict';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { existsSync } from 'node:fs';

assert.equal(existsSync('/st-mq/scripts/share'), false, 'Historical CSVs must be excluded from the image');
assert.equal(existsSync('/st-mq/data/options.json'), false, 'Owner credentials must not be built into the image');

const config = loadConfig({ ...process.env, STMQ_INPUT: 'simulated', STMQ_PORT: '0', STMQ_HOST: '127.0.0.1' });
let app = await start({ config });
try {
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = config.token ? { Authorization: `Bearer ${config.token}` } : {};
  assert.equal((await fetch(`${base}/`)).status, 200);
  const state = await (await fetch(`${base}/api/status`, { headers })).json();
  assert.equal(state.liveWrites, false);
  assert.equal(state.input, 'simulated');
  app.engine.setOverride(60);
} finally { await app.close(); }
app = await start({ config });
try { assert.equal(app.engine.status().override.mode, 'normal'); }
finally { await app.close(); }
console.log(JSON.stringify({ result: 'container-smoke-passed', arch: process.arch, node: process.version }));
