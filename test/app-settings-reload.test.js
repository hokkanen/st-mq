import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { isolatedGarageAdapter } from './helpers/garage-mqtt.js';

async function setup(t, options = {}, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-settings-reload-'));
  const path = join(directory, 'options.json');
  // Keep legacy topic/H66 reload fixtures independent of the public equipment
  // catalogue and garage adapter; those routes have their own integration tests.
  const write = value => writeFileSync(path, JSON.stringify({ equipment: { devices: [] },
    garage: { adapter: isolatedGarageAdapter() },
    teslamate: { enabled: false, charger_identification: false }, ...value }));
  write(options);
  const config = loadConfig({ STMQ_CONFIG: path, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, directory);
  // MQTT fixtures exercise reload and subscriptions without polling public providers.
  const app = await start({ config, providerOptions: { automatic: false }, ...overrides });
  t.after(async () => { try { await app.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { 'Content-Type': 'application/json', ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) };
  const post = (args = {}) => fetch(`${base}/api/settings/reload`, {
    method: 'POST', headers, body: '{}', ...args,
  });
  return { app, config, path, write, base, headers, post };
}

test('reload applies disk settings, rates and recording while preserving temporary controls and the listener', async t => {
  let now = Date.parse('2026-09-08T12:00Z');
  const { app, config, path, write, base, post } = await setup(t, {}, { clock: () => now });
  const port = app.server.address().port, oldEngine = app.engine;
  const listeners = process.listenerCount('SIGTERM');
  app.engine.setTemporary({ awayUntil: new Date(now + 2 * 3600_000).toISOString(), pauseUntil: new Date(now + 3600_000).toISOString() });
  const before = app.engine.status();
  now += 60_000;
  const options = { controller: { mode: 'monitoring', max_drop_c: 0.6, heat_pump_compressor_kw: 4 },
    electricity: { margin_ct_per_kwh_ex_vat: 0.8 }, recording: { max_interval_minutes: 2, annual_budget_gb: 4 } };
  write(options);
  const original = readFileSync(path, 'utf8');
  const response = await post();
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.mode, 'monitoring');
  assert.equal(status.settings.comfort.maxDropC, 0.6);
  assert.equal(status.learning.parameters.heatPumpCompressorKw, 4);
  assert.equal(app.engine.recorder.config.maxIntervalMs, 120_000);
  assert.equal(app.engine.recorder.config.annualBudgetBytes, 4_000_000_000);
  assert.equal(status.contract.periods.at(-1).marginCtPerKwh, 0.8);
  assert.equal(status.contract.periods[0].marginCtPerKwh, config.priceSettings.marginCtPerKwh);
  assert.deepEqual(status.settings.occupancy, before.settings.occupancy);
  assert.deepEqual(status.override, before.override);
  assert.equal(status.settingsReload.available, true);
  assert.equal(status.settingsReload.busy, false);
  assert.notEqual(app.engine, oldEngine);
  assert.equal(oldEngine.executor.closed, true);
  assert.equal(app.server.address().port, port);
  assert.equal(process.listenerCount('SIGTERM'), listeners);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal((await (await fetch(`${base}/api/status`)).json()).mode, 'monitoring');
  assert.equal(app.store.events().filter(event => event.type === 'settings-reloaded').length, 1);
});

test('reload validates authentication, JSON and startup settings before touching runtime; parse failures are private', async t => {
  const options = { controller: { web_token: 'synthetic-access-token-at-least-24' } };
  const { app, path, write, post, headers } = await setup(t, options);
  const engine = app.engine;
  assert.equal((await post({ headers: {} })).status, 401);
  assert.equal((await post({ headers: { ...headers, Origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await post({ headers: { Authorization: headers.Authorization } })).status, 400);
  assert.equal((await post({ body: '{"mode":"active"}' })).status, 400);
  write({ controller: { ...options.controller, input: 'offline', mode: 'monitoring' } });
  let response = await post();
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Restart/);
  assert.equal(app.engine, engine);
  assert.equal(engine.executor.closed, false);
  writeFileSync(path, '{"private":"synthetic-secret-value" BROKEN');
  response = await post();
  assert.equal(response.status, 400);
  const failure = await response.json();
  assert.match(failure.error, /read or validated/);
  assert.doesNotMatch(JSON.stringify({ failure, events: app.store.events() }), /synthetic-secret-value|options\.json/);
  assert.equal(app.engine, engine);
});

function fakeMqtt() {
  const clients = [], packets = [];
  const connect = (address, options) => {
    const client = new EventEmitter();
    Object.assign(client, { address, options, connected: true, endCalls: 0, subscriptions: [] });
    client.subscribe = (topic, options, done) => { client.subscriptions.push(topic); done(); };
    client.publish = (topic, payload, options, done) => { packets.push({ address, topic, payload }); done(); };
    client.end = (force, options, done) => { client.endCalls++; done(); };
    if (!options?.clientId?.startsWith('stmq-identity-')) clients.push(client);
    return client;
  };
  return { clients, packets, connect };
}

test('reload reconnects subscriptions and command transport, ignores late old publications and retains pending restoration', async t => {
  const mqtt = fakeMqtt();
  const options = { controller: { input: 'mqtt' }, mqtt: { address: 'mqtt://first.invalid', indoor_temperature_topic: 'invented/first' } };
  const { app, write, post } = await setup(t, options, { mqttOptions: { connect: mqtt.connect } });
  const old = mqtt.clients[0];
  old.emit('message', 'invented/first', Buffer.from('21'), { retain: false });
  const oldEngine = app.engine;
  const restore = oldEngine.executor.restore;
  oldEngine.executor.restore = async () => ({ restorationPending: true });
  write({ controller: { input: 'mqtt', max_drop_c: 0.5 }, mqtt: { address: 'mqtt://second.invalid', indoor_temperature_topic: 'invented/second' },
    acquisition: { easee_poll_seconds: 20 } });
  const blocked = await post();
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).error, /restoration is still pending/);
  assert.equal(old.endCalls, 0);
  assert.equal(app.engine, oldEngine);
  oldEngine.executor.restore = restore;
  const response = await post();
  assert.equal(response.status, 200);
  assert.equal(old.endCalls, 1);
  assert.equal(mqtt.clients.length, 2);
  const replacement = mqtt.clients[1];
  assert.equal(replacement.address, 'mqtt://second.invalid');
  assert.deepEqual(replacement.subscriptions, ['stmq/vehicles/bmw', 'invented/second']);
  assert.equal(app.engine.config.acquisition.easeeIntervalMs, 20_000);
  old.emit('message', 'invented/first', Buffer.from('29'), { retain: false });
  assert.equal(app.engine.latest.indoor_temperature, undefined);
  replacement.emit('message', 'invented/second', Buffer.from('22'), { retain: false });
  assert.equal(app.engine.latest.indoor_temperature.value, 22);
  await app.engine.testHeating({ command: 'circulation' });
  assert.equal(mqtt.packets.at(-1).address, 'mqtt://second.invalid');
  await app.close();
  assert.equal(replacement.endCalls, 1);
});

test('a failed reconnect restores the previous configuration and rate history without exposing transport errors', async t => {
  const mqtt = fakeMqtt();
  let attempts = 0;
  const connect = (...args) => {
    if (args[1]?.clientId?.startsWith('stmq-identity-')) return mqtt.connect(...args);
    if (++attempts === 2) throw new Error('synthetic-private-transport-failure');
    return mqtt.connect(...args);
  };
  const options = { controller: { input: 'mqtt' }, mqtt: { address: 'mqtt://first.invalid', indoor_temperature_topic: 'invented/first' } };
  const { app, write, post } = await setup(t, options, { mqttOptions: { connect } });
  const originalContract = app.engine.contract();
  write({ ...options, controller: { input: 'mqtt', max_drop_c: 0.5 }, electricity: { margin_ct_per_kwh_ex_vat: 0.9 } });
  const response = await post();
  assert.equal(response.status, 400);
  const failure = await response.json();
  assert.match(failure.error, /previous configuration was restored/);
  assert.equal(app.engine.settings.comfort.maxDropC, 1.5);
  assert.deepEqual(app.engine.contract(), originalContract);
  assert.equal(app.engine.executor.closed, false);
  assert.equal(mqtt.clients[0].endCalls, 1);
  assert.equal(mqtt.clients[1].endCalls, 0);
  assert.doesNotMatch(JSON.stringify({ failure, events: app.store.events() }), /synthetic-private-transport-failure/);
});

test('changing the H66 device starts with empty live readings and uses only the new subscription', async t => {
  const mqtt = fakeMqtt();
  const options = { controller: { input: 'mqtt', h66_device: 'invented-first' }, mqtt: { address: 'mqtt://synthetic.invalid' } };
  const { app, write, post } = await setup(t, options, { mqttOptions: { connect: mqtt.connect } });
  const first = mqtt.clients[0];
  first.emit('message', 'invented-first/HP/0001', Buffer.from('31'), { retain: false });
  first.emit('message', 'invented-first/HP/0007', Buffer.from('8'), { retain: false });
  assert.equal(app.engine.latest.return_temperature.value, 31);
  assert.equal(app.engine.outdoorCandidates['husdata-h66'].value, 8);
  write({ ...options, controller: { input: 'mqtt', h66_device: 'invented-second' } });
  const response = await post();
  assert.equal(response.status, 200);
  assert.equal(first.endCalls, 1);
  assert.deepEqual(mqtt.clients[1].subscriptions, ['stmq/vehicles/bmw', 'invented-second/HP/#']);
  assert.equal(app.engine.latest.return_temperature, undefined);
  assert.equal(app.engine.outdoorCandidates['husdata-h66'], undefined);
  assert.deepEqual(app.engine.status().h66.readings, {});
  first.emit('message', 'invented-first/HP/0001', Buffer.from('39'), { retain: false });
  assert.equal(app.engine.latest.return_temperature, undefined);
  mqtt.clients[1].emit('message', 'invented-second/HP/0001', Buffer.from('32'), { retain: false });
  assert.equal(app.engine.latest.return_temperature.value, 32);
});

test('controller-only reload retains provider snapshots and rate-limit backoff', async t => {
  const now = Date.parse('2026-09-08T12:00Z');
  const options = { controller: { input: 'providers' }, geoloc: { country_code: 'fi', latitude: '60', longitude: '25' } };
  const { app, write, post } = await setup(t, options, { clock: () => now, providerOptions: { automatic: false } });
  const market = { source: 'elering', fetchedAt: now, intervals: [] };
  const weather = { source: 'openmeteo', fetchedAt: now, forecast: [] };
  const backoff = { failures: 1, nextAttemptAt: now + 3600_000, error: 'HTTP-429', shared: true };
  app.store.setState('provider:market', market);
  app.store.setState('provider:weather', weather);
  const health = app.store.getState('providers:health');
  health.weather.sourceBackoff = { fmi: backoff };
  health.weather.nextAttemptAt = now + 300_000;
  app.store.setState('providers:health', health);
  write({ ...options, controller: { input: 'providers', max_drop_c: 0.5 } });
  assert.equal((await post()).status, 200);
  assert.deepEqual(app.store.getState('provider:market'), market);
  assert.deepEqual(app.store.getState('provider:weather'), weather);
  assert.deepEqual(app.store.getState('providers:health').weather.sourceBackoff.fmi, backoff);
  assert.equal(app.store.getState('providers:health').weather.nextAttemptAt, health.weather.nextAttemptAt);
  health.weather.nextAttemptAt = now + 1800_000;
  app.store.setState('providers:health', health);
  write({ ...options, controller: { input: 'providers', max_drop_c: 0.5 }, acquisition: { weather_poll_minutes: 5 } });
  assert.equal((await post()).status, 200);
  assert.equal(app.store.getState('providers:health').weather.nextAttemptAt, now + 300_000);
  assert.deepEqual(app.store.getState('providers:health').weather.sourceBackoff.fmi, backoff);
});

test('reload serializes against API mutations and source-less injected configurations are explicitly unavailable', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let entered;
  const reading = new Promise(resolve => { entered = resolve; });
  const { app, config, base, headers, post } = await setup(t, {}, {
    readConfig: async () => { entered(); await waiting; return config; },
  });
  const pending = post();
  await reading;
  assert.equal((await post()).status, 503);
  assert.equal((await fetch(`${base}/api/temporary`, { method: 'POST', headers, body: '{}' })).status, 503);
  release();
  assert.equal((await pending).status, 200);
  const injectedPath = join(config.dataDir, 'injected.sqlite');
  const second = await start({ config: { ...config, port: 0, dbPath: injectedPath, legacyDbPath: injectedPath } });
  try {
    const endpoint = `http://127.0.0.1:${second.server.address().port}`;
    const status = await (await fetch(`${endpoint}/api/status`)).json();
    assert.equal(status.settingsReload.available, false);
    assert.equal((await fetch(`${endpoint}/api/settings/reload`, { method: 'POST', headers, body: '{}' })).status, 409);
  } finally { await second.close(); }
  assert.equal(app.engine.config, config);
});
