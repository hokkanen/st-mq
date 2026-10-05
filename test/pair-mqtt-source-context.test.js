import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { createMqttSourceContext, mqttSourceIdentity, MQTT_SOURCE_CONTEXT_KEY } from '../src/pairing/mqtt-source-context.js';
import { HeatingAutomation } from '../src/app/automation.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { Recorder } from '../src/storage/recorder.js';

const token = randomUUID();
const otherToken = randomUUID();
const config = (secondary = false) => ({ topology: 'pair', input: 'mqtt',
  pair: { pairId: 'synthetic-house', token: 'synthetic-private-pair-token', vip: { address: '192.0.2.30' } },
  connections: { mqtt: secondary ? { address: 'mqtt://127.0.0.1', user: 'synthetic-local-user',
    ha: { address: 'mqtt://192.0.2.20:1885', user: 'synthetic-ha-user' } }
    : { address: 'mqtt://core-mosquitto', user: 'synthetic-ha-user' },
    teslamate: { enabled: true, carId: '1', homeGeofence: 'Home' },
    equipment: { devices: [{ id: 'synthetic-door', kind: 'door', area: 'garage',
      protocol: 'mqtt', topic: 'synthetic/door/state', mqtt: { commandTopic: 'synthetic/door/set' } }] } },
  charging: { vehicles: { bmw: { provider: 'bmw-cardata', mqttTopic: 'synthetic/bmw' } },
    chargers: { charger2: { enabled: true, deviceId: 'synthetic-evse' } } } });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-mqtt-source-context-'));
  const store = new Store(join(directory, 'current.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ha = config(), ubuntu = config(true);
  return { directory, store, ha, ubuntu,
    local: createMqttSourceContext({ configuration: () => ha, directory: join(directory, 'ha') }),
    remote: createMqttSourceContext({ configuration: () => ubuntu, directory: join(directory, 'ubuntu') }) };
}

test('first active current master seeds exact source identities without reading or rewriting equipment state', async t => {
  const f = fixture(t);
  const original = { signature: 'synthetic-existing-signature', enabled: false, observedAt: 1234 };
  f.store.setState('synthetic-existing-equipment-state', original);
  await f.local.activate(f.ha, f.store, { allowSeed: true });
  assert.deepEqual(mqttSourceIdentity(f.ha, 'primary'), { address: 'mqtt://core-mosquitto', username: 'synthetic-ha-user' });
  assert.deepEqual(mqttSourceIdentity(f.ha, 'ha'), mqttSourceIdentity(f.ha, 'primary'));
  assert.deepEqual(f.store.getState('synthetic-existing-equipment-state'), original);
  const descriptor = f.local.requirements(f.store);
  assert.deepEqual(Object.keys(descriptor).sort(), ['contract', 'pair', 'seedDigest', 'version']);
  assert.doesNotMatch(JSON.stringify(descriptor), /core-mosquitto|synthetic-private|synthetic-ha-user/);
  assert.equal(statSync(join(f.directory, 'ha', 'mqtt-source-context.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.directory, 'ha')).mode & 0o777, 0o700);
});

test('authenticated current handover keeps source identities through both endpoint changes and restarts', async t => {
  const f = fixture(t);
  await f.local.activate(f.ha, f.store, { allowSeed: true });
  const requirements = f.local.requirements(f.store), args = { requirements, token, dbPath: f.store.path };
  await f.remote.prepare(args);
  f.remote.verify(args);
  await assert.rejects(f.remote.activate(f.ubuntu, f.store), { code: 'mqtt_source_context_invalid' }, 'Prepared context alone grants no binding');
  await f.remote.authorize(args);
  await f.remote.authorize(args); // A lost acknowledgement does not require another binding.
  await f.remote.activate(f.ubuntu, f.store);
  assert.equal(f.ubuntu.connections.mqtt.address, 'mqtt://127.0.0.1');
  assert.equal(f.ubuntu.connections.mqtt.ha.address, 'mqtt://192.0.2.20:1885');
  assert.deepEqual(mqttSourceIdentity(f.ubuntu, 'ha'), mqttSourceIdentity(f.ha, 'ha'));
  assert.deepEqual(mqttSourceIdentity(f.ubuntu, 'primary'), mqttSourceIdentity(f.ha, 'primary'));
  const restarted = structuredClone(f.ubuntu);
  const restartedContext = createMqttSourceContext({ configuration: () => restarted, directory: join(f.directory, 'ubuntu') });
  await restartedContext.activate(restarted, f.store);
  assert.deepEqual(mqttSourceIdentity(restarted, 'ha'), mqttSourceIdentity(f.ha, 'ha'));
  const reverse = { requirements: restartedContext.requirements(f.store), token: otherToken, dbPath: f.store.path };
  await f.local.prepare(reverse); f.local.verify(reverse); await f.local.authorize(reverse);
  await f.local.activate(f.ha, f.store);
  assert.deepEqual(f.local.requirements(f.store), requirements);
});

test('a replica cannot self-seed or adopt a copied seed without an explicit verified action', async t => {
  const f = fixture(t);
  await assert.rejects(f.remote.activate(f.ubuntu, f.store), { code: 'mqtt_source_context_invalid' });
  await assert.rejects(f.remote.authorizePromotion({ dbPath: f.store.path }), { code: 'mqtt_source_context_invalid' });
  assert.equal(f.store.getState(MQTT_SOURCE_CONTEXT_KEY), null);
  await f.local.activate(f.ha, f.store, { allowSeed: true });
  await assert.rejects(f.remote.activate(f.ubuntu, f.store, { allowSeed: true }), { code: 'mqtt_source_context_invalid' });
  await f.remote.authorizePromotion({ dbPath: f.store.path });
  await f.remote.activate(f.ubuntu, f.store);
  assert.deepEqual(mqttSourceIdentity(f.ubuntu, 'ha'), mqttSourceIdentity(f.ha, 'ha'));
});

test('real equipment consumers and phase recording retain one identity through handover, restart and return', async t => {
  const f = fixture(t), runtimes = [], now = Date.parse('2026-10-05T12:00:00Z');
  for (const config of [f.ha, f.ubuntu]) config.charging.chargers.charger2.topicPrefix = 'synthetic/evse';
  const engine = { clock: () => now };
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); });
  const consumers = config => {
    const charging = new ChargingRuntime({ engine, store: f.store, config, clock: engine.clock, canControl: () => false });
    runtimes.push(charging);
    const garage = new GarageRuntime({ engine, store: f.store, config, clock: engine.clock, canControl: () => false });
    const heating = new HeatingAutomation({ store: f.store, config, clock: engine.clock, targetIdentity: () => 'a'.repeat(64) });
    return { charging, heating, identities: { charger: charging.chargers.charger2.association,
      bmw: charging.vehicleFeeds.bmw.association, garage: garage.adapterKey, home: heating.features.home.identity } };
  };
  await f.local.activate(f.ha, f.store, { allowSeed: true });
  const first = consumers(f.ha);
  first.heating.set('home', true);
  const record = (consumer, index) => {
    const recorder = new Recorder(f.store);
    recorder.recordEnergy({ source: 'shelly-evse', device: consumer.identities.charger, prefix: 'ev2',
      start: now + index * 60_000, end: now + (index + 1) * 60_000,
      energies: [0.01,0.02,0.03], powers: [0.6,1.2,1.8], quality: ['native_counter'] });
    recorder.flush(now + (index + 1) * 60_000, { force: true });
  };
  record(first, 0);
  const forward = { requirements: f.local.requirements(f.store), token, dbPath: f.store.path };
  await f.remote.prepare(forward); await f.remote.authorize(forward); await f.remote.activate(f.ubuntu, f.store);
  const second = consumers(f.ubuntu);
  assert.deepEqual(second.identities, first.identities);
  assert.equal(second.heating.features.home.enabled, true);
  record(second, 1);
  const restarted = structuredClone(f.ubuntu);
  const context = createMqttSourceContext({ configuration: () => restarted, directory: join(f.directory, 'ubuntu') });
  await context.activate(restarted, f.store);
  const third = consumers(restarted);
  assert.deepEqual(third.identities, first.identities); record(third, 2);
  const reverse = { requirements: context.requirements(f.store), token: otherToken, dbPath: f.store.path };
  await f.local.prepare(reverse); await f.local.authorize(reverse); await f.local.activate(f.ha, f.store);
  const returned = consumers(f.ha);
  assert.deepEqual(returned.identities, first.identities);
  assert.equal(returned.heating.features.home.enabled, true); record(returned, 3);
  const rows = f.store.db.prepare("SELECT signal,COUNT(DISTINCT device) devices,COUNT(*) records,SUM(value) energy FROM observations WHERE source='shelly-evse' GROUP BY signal ORDER BY signal").all();
  assert.deepEqual(rows.map(row => [row.devices,row.records]), [[1,4],[1,4],[1,4]]);
  rows.forEach((row,i) => assert.ok(Math.abs(row.energy - (i + 1) * 0.04) < 1e-12));
  const replacement = structuredClone(f.ha);
  replacement.charging.chargers.charger2.deviceId = 'different-synthetic-evse';
  await f.local.activate(replacement, f.store);
  assert.notEqual(consumers(replacement).identities.charger, first.identities.charger,
    'A real configured equipment change must still select a new identity');
});

test('source configuration, final snapshot, operation token and candidate route must all agree', async t => {
  const f = fixture(t);
  await f.local.activate(f.ha, f.store, { allowSeed: true });
  const args = { requirements: f.local.requirements(f.store), token, dbPath: f.store.path };
  f.ubuntu.charging.chargers.charger2.deviceId = 'different-synthetic-evse';
  await assert.rejects(f.remote.prepare(args), { code: 'mqtt_source_context_invalid' });
  await assert.rejects(f.remote.authorizePromotion({ dbPath: f.store.path }), { code: 'mqtt_source_context_invalid' });
  f.ubuntu.charging.chargers.charger2.deviceId = 'synthetic-evse';
  await f.remote.prepare(args);
  assert.throws(() => f.remote.verify({ ...args, token: otherToken }), { code: 'mqtt_source_context_invalid' });
  f.ubuntu.connections.mqtt.ha.address = 'mqtt://different-synthetic-ha.invalid';
  assert.throws(() => f.remote.verify(args), { code: 'mqtt_source_context_invalid' });
  f.ubuntu.connections.mqtt.ha.address = 'mqtt://192.0.2.20:1885';
  const seed = f.store.getState(MQTT_SOURCE_CONTEXT_KEY);
  f.store.setState(MQTT_SOURCE_CONTEXT_KEY, { ...seed, identities: { ...seed.identities,
    ha: { address: 'mqtt://unrelated-synthetic-broker.invalid', username: '' } } });
  assert.throws(() => f.remote.verify(args), { code: 'mqtt_source_context_invalid' });
  f.store.setState(MQTT_SOURCE_CONTEXT_KEY, seed);
  f.remote.verify(args);
});

test('ordinary route edits cannot reuse a bound identity; a new verified handover may bind the candidate route', async t => {
  const f = fixture(t);
  await f.local.activate(f.ha, f.store, { allowSeed: true });
  const requirements = f.local.requirements(f.store);
  await f.remote.prepare({ requirements, token });
  await f.remote.authorize({ requirements, token, dbPath: f.store.path });
  await f.remote.activate(f.ubuntu, f.store);
  f.ubuntu.connections.mqtt.ha.address = 'mqtt://changed-synthetic-ha.invalid:1885';
  await assert.rejects(f.remote.activate(f.ubuntu, f.store), { code: 'mqtt_source_context_invalid' });
  await f.remote.prepare({ requirements, token: otherToken });
  await f.remote.authorize({ requirements, token: otherToken, dbPath: f.store.path });
  await f.remote.activate(f.ubuntu, f.store);
  assert.deepEqual(mqttSourceIdentity(f.ubuntu, 'ha'), mqttSourceIdentity(f.ha, 'ha'));
});

test('current equipment edits update the snapshot contract while preserving the immutable broker identity seed', async t => {
  const f = fixture(t);
  await f.local.activate(f.ha, f.store, { allowSeed: true });
  const initial = f.local.requirements(f.store);
  f.ha.connections.equipment.devices[0].mqtt.commandTopic = 'synthetic/door/new-command';
  await f.local.activate(f.ha, f.store);
  const current = f.local.requirements(f.store);
  assert.equal(current.seedDigest, initial.seedDigest);
  assert.notEqual(current.contract, initial.contract);
  await assert.rejects(f.remote.prepare({ requirements: current, token }), { code: 'mqtt_source_context_invalid' });
  f.ubuntu.connections.equipment.devices[0].mqtt.commandTopic = 'synthetic/door/new-command';
  await f.remote.prepare({ requirements: current, token });
  await f.remote.authorize({ requirements: current, token, dbPath: f.store.path });
});

test('initial source-context publication resumes its exact journal after interruption', async t => {
  const f = fixture(t);
  let failOnce = true;
  const interrupted = { getState: key => f.store.getState(key), setState(key, value) {
    if (failOnce) { failOnce = false; throw Error('synthetic interrupted persistence'); }
    f.store.setState(key, value);
  } };
  await assert.rejects(f.local.activate(f.ha, interrupted, { allowSeed: true }));
  assert.equal(f.store.getState(MQTT_SOURCE_CONTEXT_KEY), null);
  await f.local.activate(f.ha, f.store, { allowSeed: true });
  assert.equal(f.local.requirements(f.store).version, 1);
});

test('malformed current context and local pins fail closed without being overwritten or exposing values', async t => {
  const f = fixture(t);
  await f.local.activate(f.ha, f.store, { allowSeed: true });
  const seed = f.store.getState(MQTT_SOURCE_CONTEXT_KEY);
  f.store.setState(MQTT_SOURCE_CONTEXT_KEY, { ...seed, retiredFormat: 'synthetic-private-value' });
  await assert.rejects(f.local.activate(f.ha, f.store), error => error.code === 'mqtt_source_context_invalid'
    && !error.message.includes('synthetic-private'));
  assert.equal(f.store.getState(MQTT_SOURCE_CONTEXT_KEY).retiredFormat, 'synthetic-private-value');
  f.store.setState(MQTT_SOURCE_CONTEXT_KEY, seed);
  const pin = join(f.directory, 'ha', 'mqtt-source-context.json');
  writeFileSync(pin, '{"synthetic-private-malformed');
  await assert.rejects(f.local.activate(f.ha, f.store), { code: 'mqtt_source_context_invalid' });
  assert.equal(readFileSync(pin, 'utf8'), '{"synthetic-private-malformed');
});

test('explicitly stored null source context is malformed, not absent state eligible for initial seeding', async t => {
  const f = fixture(t);
  f.store.setState(MQTT_SOURCE_CONTEXT_KEY, null);
  await assert.rejects(f.local.activate(f.ha, f.store, { allowSeed: true }), { code: 'mqtt_source_context_invalid' });
  assert.equal(f.store.db.prepare('SELECT value FROM state WHERE key = ?').get(MQTT_SOURCE_CONTEXT_KEY).value, 'null');
});

test('standalone and omitted-username identity hashes retain their current serialization', () => {
  assert.equal(JSON.stringify(mqttSourceIdentity({ connections: { mqtt: { address: 'mqtt://synthetic.invalid' } } }, 'primary')),
    '{"address":"mqtt://synthetic.invalid"}');
  const standalone = { connections: { mqtt: { address: 'mqtt://primary.invalid', user: '', ha: { address: 'mqtt://ha.invalid', user: 'ha' } } } };
  assert.deepEqual(mqttSourceIdentity(standalone, 'ha'), { address: 'mqtt://ha.invalid', username: 'ha' });
});
