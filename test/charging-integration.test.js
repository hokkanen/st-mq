import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { loadConfig } from '../src/app/config.js';
import { createAppServer } from '../src/app/server.js';
import { startMqtt } from '../src/acquisition/mqtt.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-integration-'));
  const store = new Store(join(directory, 'test.sqlite'));
  let now = Date.parse('2026-09-15T18:00:00Z');
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory }, directory), input: 'mqtt', deviceId: null,
    connections: { mqtt: { address: 'mqtt://example.invalid' }, teslamate: { enabled: true, carId: '7', chargerAssignment: 'bmw' } } };
  const engine = new Engine({ store, config, clock: () => now }), cleanup = [];
  t.after(async () => { for (const close of cleanup) await close(); await engine.charging.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, engine, config, cleanup, advance(ms) { now += ms; } };
}

test('charging API persists preferences across engines and obeys authentication and controller authority', async t => {
  const { store, engine, config } = fixture(t);
  let primary = true;
  const token = 'synthetic-charging-test-authorization';
  const server = createAppServer({ engine, store, token,
    controlAuthority: { canControl: () => primary, status: () => ({}) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, authenticated = true) => fetch(`${base}/api/charging/${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post('settings', { enabled: true }, false)).status, 401);
  assert.equal((await post('settings', { capacity1Kwh: 79, capacity2Kwh: 61, readyBy: '07:15' })).status, 200);
  const response = await post('soc', { soc: 43 });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.charging.soc.source, 'manual');
  const expiration = status.charging.soc.expiresAt;
  assert.equal((await post('settings', { installation: { mainFuseA: 25 } })).status, 200);
  assert.equal((await post('settings', { capacity1Kwh: -1 })).status, 400);
  assert.equal((await post('settings', { unknown: true })).status, 400);
  primary = false;
  assert.equal((await post('settings', { enabled: true })).status, 409);
  assert.equal((await post('soc', { soc: 1 })).status, 409);
  primary = true;
  const restarted = new Engine({ store, config, clock: engine.clock });
  assert.equal(restarted.charging.settings.enabled, false);
  assert.equal(restarted.charging.settings.capacity1Kwh, 79);
  assert.equal(restarted.charging.settings.capacity2Kwh, 61);
  assert.equal(restarted.charging.settings.installation.mainFuseA, 25);
  assert.equal(restarted.charging.settings.manualSoc, 43);
  assert.equal(restarted.charging.status().soc.expiresAt, expiration);
  await restarted.charging.close();
});

test('shared MQTT connection receives retained SoC, switches topics live and forecasts a waiting Charger 2', async t => {
  const { store, engine, config, cleanup, advance } = fixture(t), client = new EventEmitter(), subscriptions = [];
  client.subscribe = (topic, options, done) => { subscriptions.push({ topic, qos: options.qos }); done(null, [{ topic, qos: options.qos }]); };
  client.unsubscribe = (_topic, done) => done();
  client.end = (_force, _options, done) => done();
  const capture = await startMqtt({ engine, store, config, connect: () => client });
  cleanup.push(() => capture.close({ restore: false }));
  client.emit('connect');
  assert(subscriptions.some(row => row.topic === engine.charging.settings.mqttTopic && row.qos === 1));
  const reading = { vehicleId: 'charger1-vehicle', sourceId: 'vehicle-telemetry', readingId: 'sample-1', soc: 64,
    measuredAt: engine.clock() - 24 * 3_600_000 };
  const sendSoc = (value, topic = engine.charging.settings.mqttTopic) => client.emit('message', topic, Buffer.from(JSON.stringify(value)), { retain: true });
  sendSoc(reading);
  assert.equal(engine.charging.status().soc.soc, 64);
  advance(1000); client.emit('offline'); client.emit('connect'); sendSoc(reading);
  assert.equal(engine.charging.automaticSoc.measuredAt, reading.measuredAt);
  assert.equal(engine.charging.automaticSoc.receivedAt, engine.clock() - 1000);
  await engine.charging.setSoc({ soc: 44 });
  sendSoc({ ...reading, readingId: 'sample-2', measuredAt: engine.clock(), soc: 65 });
  assert.equal(engine.charging.status().soc.soc, 44);
  assert.equal(engine.charging.automaticSoc.soc, 65);
  await engine.charging.setSoc({ action: 'automatic' });
  assert.equal(engine.charging.status().soc.soc, 65);
  const previousTopic = engine.charging.settings.mqttTopic;
  await engine.charging.setSettings({ mqttTopic: 'stmq/garage/charger1/new-vehicle' });
  assert(subscriptions.some(row => row.topic === 'stmq/garage/charger1/new-vehicle' && row.qos === 1));
  sendSoc({ ...reading, readingId: 'old-topic-replay' }, previousTopic);
  assert.equal(engine.charging.status().soc.assumed, true);
  const send = (field, value) => client.emit('message', `teslamate/cars/7/${field}`, Buffer.from(String(value)));
  for (const [field, value] of Object.entries({ battery_level: 40, charge_limit_soc: 80, charge_current_request: 13,
    charge_current_request_max: 16, charger_phases: 3, charger_voltage: 230, plugged_in: true, geofence: 'Home',
    charger_power: 0, scheduled_charging_start_time: new Date(engine.clock() + 3_600_000).toISOString() })) send(field, value);
  engine.charging.tick();
  assert.equal(engine.charging.status().charger2.currentA, 13);
  assert(engine.charging.status().charger2.startAt > engine.clock());
});
