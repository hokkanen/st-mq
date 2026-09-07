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
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('<title>Home Energy</title>'));
  const themePath = html.match(/src="([^\"]*theme[^\"]*\.js)"/)?.[1];
  assert.ok(themePath, 'Prepaint theme asset is included');
  assert.equal((await fetch(new URL(themePath, base))).status, 200);
  const state = await (await fetch(`${base}/api/status`, { headers })).json();
  assert.equal(state.liveWrites, false);
  assert.equal(state.input, 'simulated');
  const chartResponse = await fetch(`${base}/api/chart`, { headers });
  assert.equal(chartResponse.status, 200);
  const chart = await chartResponse.json();
  assert.equal(chart.left, 'power');
  assert.equal(chart.range.startDate, chart.range.endDate);
  assert.equal(chart.range.timeZone, 'Europe/Helsinki');
  assert.ok(chart.series.all_in_price.length > 0);
  app.engine.setOverride(60);
} finally { await app.close(); }
app = await start({ config });
try { assert.equal(app.engine.status().override.mode, 'normal'); }
finally { await app.close(); }
console.log(JSON.stringify({ result: 'container-smoke-passed', arch: process.arch, node: process.version }));
