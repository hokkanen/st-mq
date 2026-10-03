import assert from 'node:assert/strict';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { HeatingAutomation } from '../src/app/automation.js';
import { providerFixture } from './lib/provider-fixture.js';

// This script is packaged for repeatable container checks. All fixture writes
// require explicit opt-in and isolated mounts created by test-addon-container.sh.
const operation = process.argv[2] ?? 'fixture';
const fixtureMarker = '/data/container-smoke-fixture.json';
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const writeJson = (path, value, options = {}) => writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600, ...options });
function isolatedFixture() {
  assert.equal(process.env.STMQ_CONTAINER_FIXTURE, '1', 'Container fixture opt-in required');
  const marker = JSON.parse(readFileSync(fixtureMarker, 'utf8'));
  assert.equal(marker.kind, 'synthetic-addon-container-smoke');
  assert.equal(digest('/data/options.json'), marker.optionsDigest, 'Options must remain unchanged');
  return marker;
}
function readState(db, key) {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}
async function seedAddon() {
  assert.equal(process.env.STMQ_CONTAINER_FIXTURE, '1', 'Container fixture opt-in required');
  assert.equal(existsSync('/data/options.json'), false, 'Seed only a new isolated data mount');
  assert.equal(existsSync('/config/st-mq/st-mq.sqlite'), false);
  const options = JSON.parse(readFileSync('/st-mq/config.json', 'utf8')).options;
  const now = Date.now();
  const temporary = { awayUntil: new Date(now + 24 * 3_600_000).toISOString(),
    pauseUntil: new Date(now + 3_600_000).toISOString() };
  options.controller = { ...options.controller, input: 'offline',
    web_token: 'synthetic-container-test-token-no-household-access', max_drop_c: 0.7 };
  options.electricity = { ...options.electricity, margin_ct_per_kwh_ex_vat: 0.37, effective_date: '' };
  writeJson('/data/options.json', options, { flag: 'wx' });
  mkdirSync('/data/st-mq', { recursive: true, mode: 0o700 });
  mkdirSync('/share/st-mq', { recursive: true });
  const fixture = providerFixture(now);
  const current = new Store('/config/st-mq/st-mq.sqlite');
  try {
    for (const row of await fixture.providerOptions.devices.temperatures()) current.observation(row);
    for (const row of await fixture.providerOptions.outdoor()) current.observation(row);
    current.setState('provider:market', await fixture.providerOptions.market());
    current.setState('provider:weather', await fixture.providerOptions.weather());
    // The history viewer cannot edit controls. Seed a current-format paused
    // state so its persistence can be checked without granting live authority.
    current.setState('occupancy:offline', { mode: 'away', returnAt: temporary.awayUntil });
    const automation = new HeatingAutomation({ store: current, config: loadConfig(), clock: () => now,
      targetIdentity: () => createHash('sha256').update('fixture-offline-heating-target').digest('hex') });
    automation.set('home', false, { pauseUntil: Date.parse(temporary.pauseUntil), now });
    current.setState('container-fixture', { synthetic: true, marker: 'retained-through-restart-and-restore' });
    current.event('container-fixture', { synthetic: true }, now);
  } finally { current.close(); }
  writeJson('/data/st-mq/easee-tokens.json', { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' }, { flag: 'wx' });
  writeJson(fixtureMarker, { kind: 'synthetic-addon-container-smoke', now, ...temporary,
    optionsDigest: digest('/data/options.json'),
    tokenDigest: digest('/data/st-mq/easee-tokens.json') }, { flag: 'wx' });
}

async function probeAddon({ restarted = false, restored = false } = {}) {
  const marker = isolatedFixture(), config = loadConfig();
  assert.equal(config.addon, true);
  assert.equal(config.input, 'offline');
  assert.equal(config.dataDir, '/data/st-mq');
  assert.equal(config.dbPath, restored ? '/config/restored/st-mq.sqlite' : '/config/st-mq/st-mq.sqlite');
  const base = 'http://127.0.0.1:1234', headers = { Authorization: `Bearer ${config.token}` };
  // The image's normal CMD runs in another process. Wait only for bounded local startup.
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`${base}/api/status`, { headers, signal: AbortSignal.timeout(1000) })).ok; }
    catch { /* App has not begun listening yet. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Add-on CMD must start its authenticated web server');
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/status`, { headers: { Authorization: 'Bearer wrong-synthetic-token' } })).status, 401);
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<title>Home Energy<\/title>/);
  // Dashboard links may point to public firmware downloads. Only script/link
  // elements are page assets; the networkless fixture must never follow a
  // user-operated download link to an external repository.
  const assetPaths = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^\"]+\.(?:js|css))"/g)].map(match => match[1]);
  assert.ok(assetPaths.length >= 3, 'Built scripts, theme and style must be referenced');
  for (const path of assetPaths) {
    const url = new URL(path, base);
    assert.equal(url.origin, base, 'Dashboard assets must be packaged locally');
    assert.equal((await fetch(url)).status, 200, path);
  }
  assert.equal((await fetch(`${base}/data/options.json`)).status, 404);
  const status = await fetch(`${base}/api/status`, { headers }).then(response => response.json());
  assert.equal(status.automation.home.enabled, false);
  assert.equal(status.automation.garage, undefined, 'Garage has manual heating, not economic automation');
  assert.equal(status.input, 'offline');
  assert.equal(status.settings.comfort.maxDropC, 0.7, 'Options control the preferred drop');
  assert.equal(status.contract.periods.at(-1).marginCtPerKwh, 0.37, 'Options control actual price layers');
  assert.equal(status.contract.periods.at(-1).vatRate, 0.255);
  assert.ok(status.prices.length > 0, 'Stored market snapshot is priced by configured rates');
  for (const price of status.prices) {
    assert.equal(price.marginCtPerKwh, 0.37);
    assert.ok(Math.abs(price.totalCtPerKwh - ((7 + 0.37 + 2.325) * 1.255 + price.transferIncludingVatCtPerKwh)) < 1e-8,
      'All-in price applies configured VAT exactly once');
  }
  assert.equal(JSON.stringify(status).includes(config.token), false, 'Status must not reveal credentials');
  const chart = await fetch(`${base}/api/chart`, { headers }).then(response => response.json());
  assert.equal(chart.range.startDate, chart.range.endDate);
  assert.equal(chart.range.timeZone, 'Europe/Helsinki');
  assert.ok(chart.series.all_in_price.length > 0);
  assert.ok(chart.series.outdoor_forecast.length > 0);
  assert.equal(digest('/data/st-mq/easee-tokens.json'), marker.tokenDigest, 'Offline startup must not alter private tokens');
  for (const destination of ['/config/st-mq/easee-tokens.json', '/share/st-mq/easee-tokens.json', '/config/options.json', '/share/st-mq/options.json']) {
    assert.equal(existsSync(destination), false, `Secrets must not be copied to ${destination}`);
  }
  assert.equal(status.settings.occupancy.mode, 'away');
  assert.equal(status.settings.occupancy.returnAt, marker.awayUntil);
  assert.equal(status.automation.home.pause.expiresAt, Date.parse(marker.pauseUntil));
  assert.equal(status.automation.home.available, false, 'Saved state cannot authorize history-viewer control');
  assert.equal(status.contract.periods.length, 1, 'Restart must not append duplicate rate periods');
  if (!restarted) {
    const response = await fetch(`${base}/api/temporary`, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ awayUntil: null, pauseUntil: null }) });
    assert.equal(response.status, 409, 'The history viewer rejects control edits');
    const updated = await fetch(`${base}/api/status`, { headers }).then(result => result.json());
    assert.equal(updated.settings.occupancy.mode, 'away');
    assert.equal(updated.automation.home.pause.expiresAt, Date.parse(marker.pauseUntil));
    assert.equal(updated.automation.home.enabled, false);
    assert.equal(updated.automation.garage, undefined);
    for (const path of ['/api/settings', '/api/contract']) {
      assert.equal((await fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })).status, 405);
    }
  }
  isolatedFixture();
}

function inspectSharedFiles() {
  assert.equal(process.env.STMQ_CONTAINER_FIXTURE, '1');
  assert.equal(existsSync('/data/options.json'), false, 'SSH-equivalent container has no private data mount');
  assert.equal(existsSync('/data/st-mq/easee-tokens.json'), false);
  const paths = ['/config/st-mq/st-mq.sqlite', '/share/st-mq/container-backup.sqlite', '/config/restored/st-mq.sqlite'];
  let observations, savedAutomation, savedOccupancy;
  for (const path of paths) {
    // All writers are stopped. Immutable mode allows these cold snapshots to be
    // read from a read-only mount without creating WAL sidecars; never use it on
    // the running controller's database.
    const db = new DatabaseSync(`file:${path}?immutable=1`, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      assert.equal(readState(db, 'container-fixture').marker, 'retained-through-restart-and-restore');
      const occupancy = readState(db, 'occupancy:offline');
      assert.equal(occupancy.mode, 'away');
      savedOccupancy ??= occupancy;
      assert.deepEqual(occupancy, savedOccupancy, 'Snapshot/restore must preserve the exact temporary occupancy');
      const automation = readState(db, 'automation:offline');
      assert.equal(automation.version, 3);
      assert.equal(automation.features.home.enabled, false);
      assert.ok(automation.features.home.pause.expiresAt > Date.now());
      savedAutomation ??= automation;
      assert.deepEqual(automation, savedAutomation, 'Snapshot/restore must preserve the exact current automation state');
      assert.equal(readState(db, 'override:offline'), null, 'Retired pause storage must stay absent');
      assert.equal(readState(db, 'contract:offline').periods.at(-1).marginCtPerKwh, 0.37);
      const count = db.prepare('SELECT COUNT(*) AS count FROM observations').get().count;
      assert.ok(count >= 2);
      observations ??= count;
      assert.equal(count, observations, 'Snapshot/restore must preserve observations');
    } finally { db.close(); }
  }
  const csv = readFileSync('/share/st-mq/container-export.csv', 'utf8');
  assert.match(csv, /indoor_temperature/);
  assert.match(csv, /21\.2/);
}

if (operation !== 'fixture') {
  if (operation === 'seed-addon') await seedAddon();
  else if (operation === 'probe-addon') await probeAddon();
  else if (operation === 'probe-restart') await probeAddon({ restarted: true });
  else if (operation === 'probe-restored') await probeAddon({ restarted: true, restored: true });
  else if (operation === 'inspect-shared') inspectSharedFiles();
  else throw new Error(`Unknown container smoke operation: ${operation}`);
  console.log(JSON.stringify({ result: 'addon-container-stage-passed', stage: operation, arch: process.arch, node: process.version }));
} else {
assert.equal(existsSync('/st-mq/scripts/share'), false, 'Historical CSVs must be excluded from the image');
assert.equal(existsSync('/st-mq/data/options.json'), false, 'Owner credentials must not be built into the image');
assert.equal(existsSync('/st-mq/secrets.json'), false, 'Private imports must not be built into the image');
assert.equal(existsSync('/st-mq/test/live/providers.test.js'), true, 'Opt-in live checks are packaged for add-on use');
const addonManifest = JSON.parse(readFileSync('/st-mq/config.json', 'utf8'));
assert.equal(addonManifest.init, false);
assert.equal(addonManifest.ingress, true);
assert.equal(addonManifest.ingress_port, 0);
assert.equal(addonManifest.backup, 'cold');
assert.deepEqual(addonManifest.map.find(mapping => mapping.type === 'app_config'),
  { type: 'app_config', read_only: false, path: '/config' });
assert.ok(addonManifest.map.includes('share:rw'));
assert.ok(addonManifest.arch.includes(process.arch === 'arm64' ? 'aarch64' : 'amd64'));

// A fresh add-on can start with only ingress; direct access never opens empty.
const ingressOnly = await start({ config: loadConfig({ ...process.env, STMQ_INPUT: 'simulated',
  STMQ_PORT: '0', STMQ_INGRESS_PORT: '0', STMQ_API_TOKEN: '', STMQ_HOST: '0.0.0.0' }) });
try {
  assert.equal(ingressOnly.webAccess.status().direct.enabled, false);
  assert.equal(ingressOnly.webAccess.status().ingress.enabled, true);
  const base = `http://127.0.0.1:${ingressOnly.webAccess.ingressServer.address().port}`;
  assert.equal((await fetch(`${base}/api/status`, {
    headers: { 'X-Forwarded-For': '172.30.32.2' },
  })).status, 403, 'A direct container client cannot impersonate HA ingress');
} finally { await ingressOnly.close(); }

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
  assert.equal(state.automation.home.enabled, false);
  assert.equal(state.automation.garage, undefined);
  assert.equal(state.input, 'simulated');
  const chartResponse = await fetch(`${base}/api/chart`, { headers });
  assert.equal(chartResponse.status, 200);
  const chart = await chartResponse.json();
  assert.equal(chart.left, 'power');
  assert.equal(chart.range.startDate, chart.range.endDate);
  assert.equal(chart.range.timeZone, 'Europe/Helsinki');
  assert.ok(chart.series.all_in_price.length > 0);
  app.engine.setTemporary({ pauseUntil: new Date(app.engine.clock() + 3_600_000).toISOString() });
} finally { await app.close(); }
app = await start({ config });
try { assert.equal(app.engine.status().automation.home.enabled, false); assert(app.engine.status().override.expiresAt > Date.now()); }
finally { await app.close(); }
const now = Date.now(), fixture = providerFixture(now);
app = await start({ config: { ...config, input: 'providers', dbPath: join(config.dataDir, 'provider-fixture.sqlite'), connections: fixture.connections },
  clock: () => now, providerOptions: fixture.providerOptions });
try {
  for (let attempt = 0; attempt < 100 && app.engine.status().providers.outdoor?.status !== 'ok'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = config.token ? { Authorization: `Bearer ${config.token}` } : {};
  const status = await fetch(`${base}/api/status`, { headers }).then(response => response.json());
  assert.equal(status.automation.home.enabled, false);
  assert.equal(status.automation.garage, undefined);
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
}
