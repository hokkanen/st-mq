import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { loadConfig } from '../src/app/config.js';
import { createAppServer } from '../src/app/server.js';
import { startMqtt } from '../src/acquisition/mqtt.js';

function setup(t, input = 'simulated') {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-app-test-'));
  const store = new Store(join(directory, 'test.sqlite'));
  const config = { ...loadConfig({}, directory), input };
  let at = Date.parse('2026-09-06T03:45:00Z'); // 06:45 Finnish time
  const engine = new Engine({ store, config, clock: () => at });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, engine, config, advance: ms => { at += ms; } };
}

test('shadow and monitoring record intents without operating the simulated plant', t => {
  const { engine, store } = setup(t);
  const result = engine.tick();
  assert.equal(result.liveWrites, false);
  assert.equal(result.execution.sent, false);
  assert.equal(result.decision.dhwr.requested, true);
  assert.equal(engine.plant.state.pulseUntil, 0);
  assert.equal(store.events().some(e => e.type === 'simulated-command-readback'), false);
  engine.updateSettings({ mode: 'monitoring' });
  assert.equal(engine.status().execution.status, 'monitoring');
});

test('active simulation applies pulse sequence once and restart preserves recency and timed override', t => {
  const { engine, store, config, advance } = setup(t);
  engine.updateSettings({ mode: 'active', comfort: { maxDropC: 1 } });
  assert.ok(engine.plant.state.pulseUntil > engine.clock());
  const pulseUntil = engine.plant.state.pulseUntil;
  advance(15 * 60_000);
  engine.setOverride(120);
  const restarted = new Engine({ store, config, clock: engine.clock });
  const result = restarted.tick();
  assert.equal(result.decision.dhwr.requested, false);
  assert.equal(restarted.plant.state.pulseUntil, pulseUntil);
  assert.equal(result.override.mode, 'normal');
  advance(120 * 60_000);
  assert.equal(restarted.tick().override, null);
  assert.ok(store.events().some(e => e.type === 'override-expired'));
});

test('physical inputs cannot activate control, ingest does not fabricate unknown source timestamps', t => {
  const { engine, store } = setup(t, 'offline');
  assert.throws(() => engine.updateSettings({ mode: 'active' }), /commissioning/);
  engine.ingest({ source: 'mqtt', device: 'h66', signal: 'indoor_temperature', value: 21, unit: 'degC', sourceTime: null, receivedAt: engine.clock(), quality: ['unknown-source-time'] });
  const status = engine.tick();
  assert.equal(store.latestObservation('indoor_temperature').sourceTime, null);
  assert.equal(status.observations.indoor.stale, true);
  assert.equal(status.decision.action, 'normal');
  assert.equal(status.observations.actual.mode, 'unknown');
});

test('corrupt learned JSON cannot delay conservative startup', t => {
  const { engine, store } = setup(t);
  store.db.prepare('INSERT INTO state (key,value,updated_at) VALUES (?,?,?)').run('learned:simulated', '{broken', 0);
  assert.equal(engine.tick().decision.action, 'normal');
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
  assert.equal(status.liveWrites, false);
  assert.equal(JSON.stringify(status).includes('connections'), false);
  assert.equal((await fetch(`${base}/api/history?limit=999999`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/api/history?from=0`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/api/history?signal=indoor_temperature`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/override`, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{"minutes":60}' })).status, 403);
  assert.equal((await fetch(`${base}/api/override`, { method: 'POST', headers, body: '{"minutes":60}' })).status, 400);
  const response = await fetch(`${base}/api/override`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"minutes":60}' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).override.expiresAt, engine.clock() + 3_600_000);
  assert.equal((await fetch(`${base}/api/override`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"minutes":-1}' })).status, 400);
});

test('read-only MQTT subscribes on reconnect, preserves retained uncertainty, ignores writes and logs bounded errors', async t => {
  const { engine, store, config } = setup(t, 'mqtt');
  const fake = new EventEmitter();
  const subscriptions = [];
  fake.subscribe = (topic, options, done) => { subscriptions.push(topic); done(); };
  fake.end = (force, options, done) => done();
  fake.publish = () => assert.fail('Read-only acquisition must never publish');
  const reader = await startMqtt({ engine, store, config: { ...config, deviceId: 'test-h66', connections: { mqtt: { address: 'mqtt://example.invalid', user: 'private-user', pw: 'private-password' } } }, connect: () => fake });
  fake.emit('connect'); fake.emit('connect');
  assert.deepEqual(subscriptions, ['test-h66/HP/+', 'test-h66/HP/+']);
  fake.emit('message', 'test-h66/HP/0008', Buffer.from('21.2'), { retain: true });
  const observation = store.latestObservation('indoor_temperature');
  assert.equal(observation.sourceTime, null);
  assert.equal(observation.value, null);
  assert.ok(observation.quality.includes('retained'));
  fake.emit('message', 'test-h66/HP/SET/0203', Buffer.from('25'));
  for (let i = 0; i < 100; i++) fake.emit('error', new Error('private-password'));
  assert.equal(store.events().filter(e => e.type === 'mqtt-error').length, 1);
  assert.equal(JSON.stringify(store.events()).includes('private-password'), false);
  await reader.close();
});

test('dated contract API enforces authentication and validation, persists revisions and keeps simulation prices separate', async t => {
  const { engine, store, config } = setup(t);
  const token = 'synthetic-test-access-token-24';
  const server = createAppServer({ engine, store, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const rates = { effectiveDate: '2026-09-06', marginCtPerKwh: 1.25, taxCtPerKwh: 2, vatRate: 0.24, tariff: 'day-night' };
  assert.equal((await fetch(`${base}/api/contract`)).status, 401);
  assert.equal((await fetch(`${base}/api/contract`, { headers, method: 'POST', body: JSON.stringify({ ...rates, vatRate: 24 }) })).status, 400);
  assert.equal(engine.contract(), null);
  const post = () => fetch(`${base}/api/contract`, { headers, method: 'POST', body: JSON.stringify(rates) });
  const response = await post();
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.periods[0].vatRate, 0.24);
  assert.deepEqual(await (await fetch(`${base}/api/contract`, { headers })).json(), saved);
  assert.equal((await post()).status, 400, 'Duplicate date cannot silently replace existing rates');
  const restarted = new Engine({ store, config, clock: engine.clock });
  assert.deepEqual(restarted.contract(), saved);
  assert.equal(restarted.status().priceStatus, 'simulated');
  assert.equal(store.events().filter(event => event.type === 'contract-period-added').length, 1);
});
