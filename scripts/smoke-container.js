import assert from 'node:assert/strict';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { providerFixture } from './lib/provider-fixture.js';

assert.equal(existsSync('/st-mq/scripts/share'), false, 'Historical CSVs must be excluded from the image');
assert.equal(existsSync('/st-mq/data/options.json'), false, 'Owner credentials must not be built into the image');
assert.equal(existsSync('/st-mq/test/live/providers.test.js'), true, 'Opt-in live checks are packaged for add-on use');

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
const now = Date.now(), fixture = providerFixture(now);
app = await start({ config: { ...config, input: 'providers', dbPath: join(config.dataDir, 'provider-fixture.sqlite'), connections: fixture.connections },
  clock: () => now, providerOptions: fixture.providerOptions });
try {
  for (let attempt = 0; attempt < 100 && app.engine.status().providers.outdoor?.status !== 'ok'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = config.token ? { Authorization: `Bearer ${config.token}` } : {};
  const status = await fetch(`${base}/api/status`, { headers }).then(response => response.json());
  assert.equal(status.liveWrites, false);
  assert.equal(status.providers.market.status, 'fallback');
  assert.equal(status.providers.market.source, 'elering');
  assert.equal(status.providers.weather.source, 'fmi');
  assert.equal(status.observations.outdoor.source, 'fmi');
  assert.equal(status.observations.outdoor.stale, false);
  const chart = await fetch(`${base}/api/chart`, { headers }).then(response => response.json());
  assert.ok(chart.series.outdoor_temperature.some(point => point.y === 10));
  assert.ok(chart.series.outdoor_forecast.some(point => point.y === 9));
  assert.ok(chart.series.spot_price.some(point => point.y === 7));
} finally { await app.close(); }
console.log(JSON.stringify({ result: 'container-smoke-passed', arch: process.arch, node: process.version }));
