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

function fixture(t, charging) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-integration-'));
  const store = new Store(join(directory, 'test.sqlite'));
  let now = Date.parse('2026-09-15T18:00:00Z');
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory }, directory), input: 'mqtt', deviceId: null, ...(charging ? { charging } : {}),
    connections: { mqtt: { address: 'mqtt://example.invalid' }, teslamate: { enabled: true, carId: '7', chargerAssignment: 'bmw' } } };
  const engine = new Engine({ store, config, clock: () => now }), cleanup = [];
  t.after(async () => { for (const close of cleanup) await close(); await engine.charging.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, engine, config, cleanup, advance(ms) { now += ms; } };
}

const chargerView = (runtime, id = 'charger1') => runtime.status().chargers.find(item => item.id === id);

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
  assert.equal((await post('chargers/charger1/settings', { enabled: true }, false)).status, 401);
  assert.equal((await post('settings', { chargers: { charger1: { capacityKwh: 79, readyBy: '07:15' }, charger2: { capacityKwh: 61 } } })).status, 200);
  const response = await post('chargers/charger1/settings', { manualSoc: 43 });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.charging.chargers.find(item => item.id === 'charger1').values.soc.source, 'manual-fallback');
  assert.equal(status.charging.timezone, 'Europe/Helsinki');
  assert.equal((await post('settings', { installation: { mainFuseA: 25 } })).status, 400);
  assert.equal((await post('chargers/charger1/settings', { capacityKwh: -1 })).status, 400);
  assert.equal((await post('settings', { unknown: true })).status, 400);
  assert.equal((await post('chargers/charger2/settings', { enabled: true })).status, 400);
  assert.equal((await post('chargers/missing/settings', { manualSoc: 50 })).status, 400);
  assert.equal((await post('chargers/charger2/settings', { manualSoc: 56 })).status, 200);
  primary = false;
  assert.equal((await post('chargers/charger1/settings', { enabled: true })).status, 409);
  assert.equal((await post('chargers/charger1/settings', { manualSoc: 1 })).status, 409);
  primary = true;
  const restarted = new Engine({ store, config, clock: engine.clock });
  assert.equal(restarted.charging.settings.chargers.charger1.enabled, false);
  assert.equal(restarted.charging.settings.chargers.charger1.capacityKwh, 79);
  assert.equal(restarted.charging.settings.chargers.charger2.capacityKwh, 61);
  assert.equal(restarted.charging.settings.installation, undefined);
  assert.equal(restarted.charging.settings.chargers.charger1.manualSoc, 43);
  assert.equal(restarted.charging.settings.chargers.charger2.manualSoc, 56);
  assert.equal(chargerView(restarted.charging, 'charger2').values.soc.value, 56);
  assert.equal(chargerView(restarted.charging).values.soc.value, 43);
  await restarted.charging.close();
});

test('independent MQTT vehicle routes keep source timestamps without overriding unassigned charger defaults', async t => {
  const { store, engine, config, cleanup, advance } = fixture(t, { chargers: { charger2: { mqttTopic: 'stmq/garage/charger2/vehicle' } } }), client = new EventEmitter(), subscriptions = [];
  client.subscribe = (topic, options, done) => { subscriptions.push({ topic, qos: options.qos }); done(null, [{ topic, qos: options.qos }]); };
  client.unsubscribe = (_topic, done) => done();
  client.end = (_force, _options, done) => done();
  const capture = await startMqtt({ engine, store, config, connect: () => client });
  cleanup.push(() => capture.close({ restore: false }));
  client.emit('connect');
  assert(subscriptions.some(row => row.topic === engine.charging.configuration.vehicles.bmw.mqttTopic && row.qos === 1));
  const reading = { provider: 'bmw-cardata', vehicleId: 'charger1-vehicle', sourceId: 'vehicle-telemetry', readingId: 'sample-1', soc: 64,
    measuredAt: engine.clock() - 24 * 3_600_000 };
  const sendSoc = (value, topic = engine.charging.configuration.vehicles.bmw.mqttTopic) => client.emit('message', topic, Buffer.from(JSON.stringify(value)), { retain: true });
  sendSoc(reading);
  assert.equal(chargerView(engine.charging).values.soc.value, 20);
  advance(1000); client.emit('offline'); client.emit('connect'); sendSoc(reading);
  assert.equal(engine.charging.vehicleFeeds.bmw.reading.measuredAt, reading.measuredAt);
  assert.equal(engine.charging.vehicleFeeds.bmw.reading.receivedAt, engine.clock() - 1000);
  await engine.charging.setChargerSettings('charger1', { manualSoc: 44 });
  sendSoc({ ...reading, readingId: 'sample-2', measuredAt: engine.clock(), soc: 65 });
  assert.equal(chargerView(engine.charging).values.soc.value, 44, 'Unknown vehicle retains the editable fallback');
  assert.equal(engine.charging.settings.chargers.charger1.manualSoc, 44, 'Fallback remains saved');
  await assert.rejects(engine.charging.setChargerSettings('charger1', { mqtt: { topic: 'new/topic' } }), /Unknown/);
  assert(subscriptions.some(row => row.topic === 'stmq/garage/charger2/vehicle' && row.qos === 1));
  sendSoc({ readingId: 'second-car', measuredAt: engine.clock(), soc: 48 }, 'stmq/garage/charger2/vehicle');
  assert.equal(chargerView(engine.charging, 'charger2').values.soc.value, 20, 'A generic extra feed cannot identify the Tesla');
  assert.equal(chargerView(engine.charging).values.soc.value, 44, 'Vehicle topics cannot attach themselves to a charger');
  advance(1000);
  const send = (field, value) => client.emit('message', `teslamate/cars/7/${field}`, Buffer.from(String(value)));
  for (const [field, value] of Object.entries({ battery_level: 40, charge_limit_soc: 80, charge_current_request: 13,
    charge_current_request_max: 16, charger_phases: 3, charger_voltage: 230, plugged_in: true, geofence: 'Home',
    charger_power: 0, scheduled_charging_start_time: new Date(engine.clock() + 3_600_000).toISOString() })) send(field, value);
  engine.charging.tick();
  assert.equal(chargerView(engine.charging, 'charger2').values.currentA.value, 13);
  assert(chargerView(engine.charging, 'charger2').forecast.startAt > engine.clock());
});

test('session target API authenticates, enforces controller authority and rejects a replaced connection', async t => {
  const { store, engine, advance } = fixture(t);
  const runtime = engine.charging, connectedAt = engine.clock();
  let primary = true, charging = true, sessionAt = connectedAt;
  const token = 'synthetic-target-api-authorization';
  const item = runtime.chargers.charger1;
  item.adapter = { normalize: () => ({ connected: { value: true, available: true },
    charging: { value: charging, available: true, measuredAt: engine.clock() } }) };
  item.controller = { status: () => ({ session: { connectedAt: sessionAt }, phase: 'off' }), async update() {}, close() {} };
  const publish = packet => runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, JSON.stringify(packet));
  publish({ provider: 'bmw-cardata', soc: 40, chargeLimitSoc: 85, measuredAt: connectedAt, readingId: 'api-battery',
    atHome: true, pluggedIn: true, charging: true, fields: Object.fromEntries(['atHome', 'pluggedIn', 'charging'].map(key =>
      [key, { measuredAt: connectedAt, readingId: `api-${key}` }])) });
  advance(60_000); charging = false;
  publish({ provider: 'bmw-cardata', charging: false, fields: { charging: { measuredAt: engine.clock(), readingId: 'api-stop' } } });
  assert.equal(chargerView(runtime).vehicle.id, 'bmw');
  const server = createAppServer({ engine, store, token,
    controlAuthority: { canControl: () => primary, status: () => ({}) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/charging/chargers/charger1/target`;
  const post = (body, authenticated = true) => fetch(url, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post({ connectedAt, mode: 'full' }, false)).status, 401);
  primary = false;
  assert.equal((await post({ connectedAt, mode: 'full' })).status, 409);
  primary = true;
  assert.equal((await post({ connectedAt, mode: 'invalid' })).status, 400);
  const response = await post({ connectedAt, mode: 'full' });
  assert.equal(response.status, 200);
  const chosen = (await response.json()).charging.chargers[0];
  assert.equal(chosen.values.minimumSoc.value, 100);
  assert.equal(chosen.targetSelection.mode, 'full');
  assert.equal(chosen.targetSelection.raw.value, 85);
  assert.equal((await post({ connectedAt, mode: 'automatic' })).status, 200);
  assert.equal(chargerView(runtime).values.minimumSoc.value, 85);
  advance(60_000); sessionAt = engine.clock();
  assert.equal((await post({ connectedAt, mode: 'full' })).status, 400);
  assert.equal(chargerView(runtime).targetSelection, null);
});
