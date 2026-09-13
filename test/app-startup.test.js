import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { Store } from '../src/storage/store.js';
import { providerFixture } from '../scripts/lib/provider-fixture.js';
import { identityConnection, idleIdentityClient } from './helpers/identity-mqtt.js';

test('legacy publisher exits at the live gate before loading credentials or connecting', () => {
  const result = spawnSync(process.execPath, ['scripts/mqtt-control.js'], { encoding: 'utf8', env: { ...process.env, STMQ_LEGACY_LIVE: '' }, timeout: 3000 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Legacy live publishing is disabled/);
  assert.doesNotMatch(result.stdout, /MQTT client connected|MQTT published/);
});

test('standalone entry starts offline promptly, serves built UI, survives restart and closes workers', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-startup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, directory);
  const started = performance.now();
  const app = await start({ config });
  try {
    assert.ok(performance.now() - started < 3000);
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/status`);
    const status = await response.json();
    assert.equal(status.input, 'simulated');
    assert.equal(status.liveWrites, false);
    assert.equal(status.settingsReload.configuration.environment, 'ubuntu');
    assert.equal(status.settingsReload.configuration.privatePath, join(directory, 'st-mq/secrets.json'));
    assert.equal(status.settingsReload.configuration.defaultsPath, config.configuration.defaultsPath);
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
  assert.match(dockerfile, /FROM node:22\.23\.2-alpine/);
  assert.doesNotMatch(dockerfile, /FROM \$\{BUILD_FROM\}/);
  assert.match(dockerfile, /STMQ_DATA_DIR=\/data\/st-mq/);
  assert.match(dockerfile, /CMD \["node", "src\/main.js"\]/);
  const addon = JSON.parse(readFileSync('config.json', 'utf8'));
  assert.deepEqual(addon.arch, ['aarch64', 'amd64']);
  assert.equal(addon.options.controller.input, 'simulated');
  assert.equal(addon.options.controller.mode, 'shadow');
  assert.ok(addon.map.includes('addon_config:rw'));
  assert.ok(addon.map.includes('share:rw'));
  assert.equal(addon.backup, 'cold');
  assert.equal(addon.version, JSON.parse(readFileSync('package.json', 'utf8')).version);
});

test('an occupied web port fails before MQTT, providers or controller initialization', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-occupied-port-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const blocker = createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const port = blocker.address().port;
  const config = loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory,
    STMQ_PORT: String(port), STMQ_INPUT: 'providers' }, directory);
  config.connections.mqtt.address = 'mqtt://fixture.invalid';
  let connections = 0, requests = 0;
  await assert.rejects(start({ config, installSignalHandlers: false,
    mqttOptions: { connect: () => { connections++; throw new Error('Unexpected MQTT connection'); } },
    providerOptions: { temperatureProvider: async () => { requests++; return []; } },
  }), error => {
    assert.equal(error.code, 'EADDRINUSE');
    assert.equal(error.port, port);
    assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
    assert.match(error.message, /existing ST-MQ process or service/);
    assert.match(error.message, /STMQ_PORT/);
    return true;
  });
  assert.equal(connections, 0);
  assert.equal(requests, 0);
  const store = new Store(config.dbPath);
  try { assert.equal(store.getState('contract:providers'), null); }
  finally { store.close(); }
  assert.equal(blocker.listening, true, 'The process that already owns the port is left running');

  const result = spawnSync(process.execPath, ['src/main.js'], { encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: join(directory, 'cli'),
      STMQ_PORT: String(port), STMQ_INPUT: 'providers' } });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.error, undefined);
  assert.match(result.stderr, /EADDRINUSE.*port is already in use/);
  assert.doesNotMatch(result.stdout, /"event":"ready"/);
});

test('H66 observations coexist with weather and prices and acquisition only requests snapshots', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-combined-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const now = Date.parse('2026-09-07T12:00Z');
  const fixture = providerFixture(now), fake = new EventEmitter();
  const subscriptions = []; let closed = 0;
  fake.subscribe = (topic, options, done) => { subscriptions.push(topic); done(); };
  fake.publish = (topic, payload, options, done) => {
    assert.equal(topic, 'fixture-h66/HP/CMD'); assert.equal(payload, 'GETALL');
    assert.equal(options.retain, false); done();
  };
  fake.end = (force, options, done) => { closed++; done(); };
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory, STMQ_PORT: '0', STMQ_DATA_DIR: directory }, directory), input: 'mqtt', deviceId: 'fixture-h66',
    connections: { ...fixture.connections, mqtt: { address: 'mqtt://fixture.invalid' } } };
  const app = await start({ config, clock: () => now, providerOptions: fixture.providerOptions,
    mqttOptions: { connect: (_address, options) => identityConnection(options) ? idleIdentityClient() : fake } });
  try {
    fake.emit('connect');
    for (let i = 0; i < 100 && !app.engine.status().providers.outdoor?.lastSuccessAt; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(subscriptions, ['fixture-h66/HP/#']);
    fake.emit('message', 'fixture-h66/HP/8105', Buffer.from('-180'), { retain: true });
    assert.equal(app.store.latestObservation('heating_integral').source, 'husdata-h66');
    const status = app.engine.tick();
    assert.equal(status.providers.market.source, 'elering');
    assert.equal(status.observations.outdoor.source, 'fmi');
    assert.ok(status.prices.length > 0);
    assert.ok(status.forecast.length > 0);
    assert.equal(status.liveWrites, false);
  } finally { await app.close(); }
  assert.equal(closed, 1);
});

test('pause expires on its deadline between regular controller ticks', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-deadline-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = loadConfig({ XDG_CONFIG_HOME: directory, STMQ_PORT: '0', STMQ_DATA_DIR: directory }, directory);
  const app = await start({ config });
  try {
    app.engine.setTemporary({ pauseUntil: new Date(Date.now() + 200).toISOString() });
    for (let i = 0; i < 60 && app.store.getState('override:simulated') !== null; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(app.store.getState('override:simulated'), null, 'Timer clears the persisted override without a status request');
    assert.equal(app.store.events().filter(e => e.type === 'override-expired').length, 1);
  } finally { await app.close(); }
});
