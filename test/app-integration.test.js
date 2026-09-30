import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { recordLearningContext } from '../src/app/committed-learning.js';
import { loadConfig } from '../src/app/config.js';
import { createAppServer } from '../src/app/server.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { isolatedGarageAdapter } from './helpers/garage-mqtt.js';

function setup(t, input = 'simulated') {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-app-test-'));
  const store = new Store(join(directory, 'test.sqlite'));
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory }, directory), input };
  config.garage.adapter = isolatedGarageAdapter(); config.garage.sender = { stateTopic: '', commandTopic: '' };
  let at = Date.parse('2026-09-06T03:45:00Z'); // 06:45 Finnish time
  const engines = [];
  const createEngine = (options = {}) => {
    const engine = new Engine({ store, config, clock: () => at, ...options });
    engines.push(engine);
    return engine;
  };
  const engine = createEngine();
  t.after(async () => {
    // Worker readers can create SQLite sidecars even after the writer closes.
    // Drain every simulated restart before removing their shared database.
    for (const runtime of engines.reverse()) {
      await runtime.charging.close();
      await runtime.garage.close({ restore: false });
      await runtime.closeFireplace();
      await runtime.executor.close({ restore: false });
    }
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, engine, config, createEngine, advance: ms => { at += ms; } };
}

test('Pause records its state without operating the simulated plant', t => {
  const { engine, store } = setup(t);
  const result = engine.tick();
  assert.equal(result.automation.home.enabled, false);
  assert.equal(result.execution.sent, false);
  assert.equal(result.decision.dhwr.requested, false);
  assert.equal(engine.plant.state.pulseUntil, 0);
  assert.equal(store.events().some(e => e.type === 'simulated-command-readback'), false);
  assert.equal(engine.status().execution.status, 'paused');
});

test('retired Garage pause state rejects before startup writes or MQTT connection', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const config = { input: 'mqtt', settings: {}, garage: { enabled: true, adapter: isolatedGarageAdapter(), sender: { stateTopic: '', commandTopic: '' } },
    connections: { mqtt: { address: 'mqtt://invented.invalid', user: 'invented-account' } } };
  store.setState('garage:adapter:mqtt', { version: 1,
    episode: { id: 'retired-pause', purpose: 'manual' }, restorePending: true });
  const before = store.db.prepare('SELECT total_changes() AS changes').get().changes;
  assert.throws(() => new Engine({ store, config }), /Unsupported saved Garage adapter state/);
  assert.equal(store.db.prepare('SELECT total_changes() AS changes').get().changes, before,
    'Unsupported physical-restoration state must remain untouched');
  let connects = 0;
  await assert.rejects(startMqtt({ engine: {}, store, config,
    connect: () => { connects++; throw new Error('Connection must not start'); } }),
  /Unsupported saved Garage adapter state/);
  assert.equal(connects, 0);
  assert.equal(store.db.prepare('SELECT total_changes() AS changes').get().changes, before);
});

test('automatic simulation applies pulse sequence once and restart preserves recency and timed override', async t => {
  const { engine, store, createEngine, advance } = setup(t);
  engine.updateSettings({ comfort: { maxDropC: 1 } });
  await engine.setAutomation({ feature: 'home', enabled: true });
  assert.ok(engine.plant.state.pulseUntil > engine.clock());
  const pulseUntil = engine.plant.state.pulseUntil;
  advance(15 * 60_000);
  engine.setTemporary({ pauseUntil: new Date(engine.clock() + 120 * 60_000).toISOString() });
  const restarted = createEngine();
  const result = restarted.tick();
  assert.equal(result.decision.dhwr.requested, false);
  assert.equal(restarted.plant.state.pulseUntil, pulseUntil);
  assert.equal(result.automation.home.activity, 'paused');
  advance(120 * 60_000);
  assert.equal(restarted.tick().override, null);
  assert.ok(store.events().some(e => e.type === 'heating-pause-ended'));
});

test('history input cannot enable automation, ingest does not fabricate unknown source timestamps', async t => {
  const { engine, store } = setup(t, 'offline');
  await assert.rejects(engine.setAutomation({ feature: 'home', enabled: true }), /history viewer/);
  engine.ingest({ source: 'mqtt', device: 'h66', signal: 'indoor_temperature', value: 21, unit: 'degC', sourceTime: null, receivedAt: engine.clock(), quality: ['unknown-source-time'] });
  const status = engine.tick();
  assert.equal(store.latestObservation('indoor_temperature').sourceTime, null);
  assert.equal(status.observations.indoor.stale, true);
  assert.equal(status.decision.action, 'normal');
  assert.equal(status.observations.actual.mode, 'unknown');
});

test('corrupt learned JSON cannot delay conservative startup', t => {
  const { engine, store, createEngine } = setup(t);
  recordLearningContext(store, 'simulated', { phase: 'normal', regime: 'occupied', targetC: 21 }, engine.clock());
  store.db.prepare('INSERT INTO state (key,value,updated_at) VALUES (?,?,?)').run('adaptive:simulated', '{broken', 0);
  const restarted = createEngine();
  assert.equal(restarted.tick().decision.action, 'normal');
  assert.ok(store.events().some(e => e.type === 'checkpoint-rebuild'));
});

test('authenticated API serves authoritative state, bounded history and persistent override with no credential exposure', async t => {
  const { engine, store } = setup(t);
  engine.tick();
  const token = 'test-token-with-at-least-24-characters';
  const server = createAppServer({ engine, store, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  const status = await (await fetch(`${base}/api/status`, { headers })).json();
  assert.equal(status.input, 'simulated');
  assert.equal(status.automation.home.enabled, false);
  assert.equal(JSON.stringify(status).includes('connections'), false);
  assert.equal((await fetch(`${base}/api/history?limit=999999`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/api/history?from=0`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/api/history?signal=indoor_temperature`, { headers })).status, 200);
  const body = JSON.stringify({ pauseUntil: new Date(engine.clock() + 3_600_000).toISOString() });
  assert.equal((await fetch(`${base}/api/temporary`, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await fetch(`${base}/api/temporary`, { method: 'POST', headers, body })).status, 400);
  const response = await fetch(`${base}/api/temporary`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).override.expiresAt, engine.clock() + 3_600_000);
  assert.equal((await fetch(`${base}/api/temporary`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"minutes":-1}' })).status, 400);
  assert.equal((await fetch(`${base}/api/override`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"minutes":60}' })).status, 404);
});

test('MQTT requests snapshots on reconnect, preserves retained uncertainty and logs bounded errors', async t => {
  const { engine, store, config } = setup(t, 'mqtt');
  const fake = new EventEmitter();
  const subscriptions = [];
  fake.subscribe = (topic, options, done) => { subscriptions.push(topic); done(); };
  fake.end = (force, options, done) => done();
  const publications = [];
  fake.publish = (topic, payload, options, done) => {
    assert.equal(topic, 'test-h66/HP/CMD'); assert.equal(payload, 'GETALL');
    publications.push(payload); done();
  };
  const reader = await startMqtt({ engine, store, config: { ...config, deviceId: 'test-h66', connections: { mqtt: { address: 'mqtt://example.invalid', user: 'private-user', pw: 'private-password' } } }, connect: () => fake });
  fake.emit('connect'); fake.emit('connect'); fake.emit('offline'); fake.emit('connect');
  assert.deepEqual(subscriptions, ['stmq/vehicles/bmw', 'test-h66/HP/#', 'stmq/vehicles/bmw', 'test-h66/HP/#']);
  assert.equal(publications.length, 2);
  fake.emit('message', 'test-h66/HP/0001', Buffer.from('31.2'), { retain: true });
  const observation = store.latestObservation('return_temperature');
  assert.equal(observation.sourceTime, engine.clock());
  assert.equal(observation.raw.sensorMeasuredAt, null);
  assert.equal(observation.raw.usableForControl, false);
  assert.equal(observation.value, 31.2);
  assert.ok(observation.quality.includes('retained'));
  fake.emit('message', 'test-h66/HP/SET/0203', Buffer.from('25'));
  fake.emit('message', 'test-h66/HP/0001', Buffer.from('31.4'), { retain: false });
  const live = store.latestObservation('return_temperature');
  assert.equal(live.raw.timeBasis, 'mqtt-received'); assert.equal(live.raw.verified, true);
  assert.equal(live.raw.usableForControl, true); assert.deepEqual(live.quality, []);
  for (let i = 0; i < 100; i++) fake.emit('error', new Error('private-password'));
  assert.equal(store.events().filter(e => e.type === 'mqtt-error').length, 1);
  assert.equal(JSON.stringify(store.events()).includes('private-password'), false);
  await reader.close();
});

test('permanent settings APIs are read-only and configured price revisions preserve history on restart', async t => {
  const { engine, store, config, createEngine, advance } = setup(t);
  const token = 'synthetic-test-access-token-24';
  const server = createAppServer({ engine, store, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/contract`)).status, 401);
  for (const path of ['contract', 'settings']) assert.equal((await fetch(`${base}/api/${path}`, { headers, method: 'POST', body: '{}' })).status, 405);
  assert.equal((await fetch(`${base}/api/garage/protection`, { headers, method: 'POST', body: '{}' })).status, 404,
    'Installation parameters have no dashboard mutation endpoint');
  assert.equal(engine.garage.setProtection, undefined);
  const saved = engine.contract();
  assert.equal(saved.periods[0].vatRate, 0.255);
  assert.equal(saved.periods[0].marginCtPerKwh, 0.33);
  assert.deepEqual(await (await fetch(`${base}/api/contract`, { headers })).json(), saved);
  const restarted = createEngine();
  assert.equal(restarted.contract().periods.length, 1);
  assert.equal(restarted.status().priceStatus, 'simulated');
  advance(3600_000);
  const changed = createEngine({ config: { ...config, priceSettings: { ...config.priceSettings, marginCtPerKwh: 0.4 } } });
  assert.equal(changed.contract().periods.length, 2);
  assert.equal(changed.contract().periods[0].marginCtPerKwh, 0.33);
  assert.equal(changed.contract().periods[1].marginCtPerKwh, 0.4);
  assert.equal(changed.contract().periods[1].from, engine.clock());
});

test('temporary controls API checks authentication, JSON and atomic Finnish dates', async t => {
  const { engine, store } = setup(t);
  const token = 'synthetic-test-access-token-24';
  const server = createAppServer({ engine, store, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/temporary`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://example.invalid' }, body: '{}' })).status, 403);
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ awayUntilLocal: '2026-09-08T10:00', pauseUntilLocal: '2026-09-07T12:00' }) });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.settings.occupancy.returnAt, '2026-09-08T07:00:00.000Z');
  assert.equal(status.override.expiresAt, Date.parse('2026-09-07T09:00Z'));
  assert.equal(status.automation.home.enabled, false);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ awayUntilLocal: null, pauseUntilLocal: '2026-09-05T00:00' }) })).status, 400);
  assert.equal(engine.status().settings.occupancy.mode, 'away');
});
