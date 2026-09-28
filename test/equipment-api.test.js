import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { createAppServer } from '../src/app/server.js';
import { createEquipmentTests } from '../src/app/equipment-tests.js';
import { createH66Controller } from '../src/control/h66.js';
import { createH66Decoder } from '../src/domain/telemetry.js';
import { loadConfig, validateSettings } from '../src/app/config.js';
import { start } from '../src/main.js';
import { CONTROL_SCOPE } from '../src/control/authority.js';
import { idleIdentityClient, identityConnection } from './helpers/identity-mqtt.js';
import { bluHtEquipment } from '../integrations/shelly/blu-ht.js';

const INITIAL = Date.parse('2026-09-13T10:00:00Z');
const KEY = 'equipment-tests:v1', TOKEN = 'synthetic-equipment-api-access-token';
const TEST = { deviceId: 'caravan', on: true, durationMinutes: 1 };
const ROUTES = [
  ['/api/equipment/recheck', {}], ['/api/equipment/test', TEST], ['/api/equipment/test/restore', {}],
  ['/api/equipment/switch', { deviceId: 'caravan', on: true }], ['/api/equipment/h66', { register: '0203', value: 21 }],
  ['/api/equipment/cover', { deviceId: 'garage_door1', action: 'open' }],
  ['/api/equipment/dehumidifier', { deviceId: 'caravan_dehumidifier', setting: 'power', value: 'on' }],
  ['/api/equipment/dehumidifier/temperature-control', { deviceId: 'caravan_dehumidifier', enabled: false }],
];
const flush = () => new Promise(resolve => setImmediate(resolve));

async function serverFixture(t, serverOptions = {}) {
  const store = new Store(':memory:');
  let now = INITIAL, confirmation = true;
  const calls = [], checks = [];
  const engine = new Engine({ store, config: { input: 'mqtt', settings: validateSettings({ mode: 'shadow' }) }, clock: () => now });
  const device = { id: 'caravan', label: 'Synthetic caravan', area: 'garage', kind: 'switch', available: true,
    controls: { switch: true, tariff: false }, readings: { caravan_active: { value: 0, unit: 'state', stale: false, observedAt: now } } };
  engine.equipment = {
    status: () => ({ configured: true, connected: true, devices: [structuredClone(device)] }),
    signature: id => id === 'caravan' ? 'a'.repeat(64) : null,
    async recheck(input) {
      if (input.deviceId !== undefined && input.deviceId !== 'caravan') throw new Error('Unknown configured equipment.');
      checks.push(input);
    },
    async setSwitch(id, on) {
      assert.equal((store.getState(KEY).active ?? store.getState(KEY).lastManual).deviceId, id);
      calls.push({ id, on });
      if (confirmation) device.readings.caravan_active = { value: Number(on), unit: 'state', stale: false, observedAt: ++now };
      return { confirmed: confirmation, sent: true };
    },
  };
  const allowed = () => (serverOptions.controlAuthority?.canControl() ?? true) && (serverOptions.pairContext?.canControl() ?? true);
  engine.equipmentTests = createEquipmentTests({ store, clock: () => now, getEquipment: () => engine.equipment, canControl: allowed });
  const server = createAppServer({ engine, store, token: TOKEN, ...serverOptions });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await engine.equipmentTests.close({ restore: false });
    await engine.h66?.close();
    await engine.closeFireplace(); await engine.executor.close({ restore: false }); store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  const post = async (path, value, options = {}) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(value), ...options });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { engine, store, calls, checks, base, headers, post, confirm(value) { confirmation = value; },
    advance(ms) { now += ms; } };
}

test('all equipment HTTP actions require authenticated same-origin JSON before dispatch', async t => {
  const f = await serverFixture(t);
  for (const [path, input] of ROUTES) {
    assert.equal((await f.post(path, input, { headers: {} })).status, 401);
    assert.equal((await f.post(path, input, { headers: { ...f.headers, Origin: 'https://invented-other.invalid' } })).status, 403);
    assert.equal((await f.post(path, input, { headers: { Authorization: f.headers.Authorization } })).status, 400);
    assert.equal((await f.post(path, input, { body: '{invalid' })).status, 400);
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(f.checks, []); assert.equal(f.store.getState(KEY), null);
});

test('replicas, protected controllers and paired standbys reject equipment actions before dispatch', async t => {
  for (const [name, options, expected] of [
    ['slave', { role: 'slave' }, 405],
    ['protected', { controlAuthority: { canControl: () => false, status: () => ({ protected: true }) } }, 409],
    ['standby', { pairContext: { canControl: () => false, recovering: () => false, status: () => ({ role: 'standby' }) } }, 409],
  ]) await t.test(name, async t => {
    const f = await serverFixture(t, options);
    for (const [path, input] of ROUTES) assert.equal((await f.post(path, input)).status, expected);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.checks, []); assert.equal(f.store.getState(KEY), null);
  });
});

test('recheck accepts only configured selection and cannot accept command fields', async t => {
  const f = await serverFixture(t);
  for (const input of [null, [], { deviceId: 4 }, { deviceId: 'unconfigured' }, { topic: 'invented/arbitrary' },
    { deviceId: 'caravan', on: true }, { command: 'Switch.Set' }])
    assert.equal((await f.post('/api/equipment/recheck', input)).status, 400);
  assert.deepEqual(f.checks, []); assert.deepEqual(f.calls, []);
  assert.equal((await f.post('/api/equipment/recheck', { deviceId: 'caravan' })).status, 200);
  assert.equal((await f.post('/api/equipment/recheck', {})).status, 200);
  assert.deepEqual(f.checks, [{ deviceId: 'caravan' }, {}]); assert.deepEqual(f.calls, []);
});

test('explicit shadow-mode switch tests persist and confirm both the test and restoration through HTTP', async t => {
  const f = await serverFixture(t);
  const started = await f.post('/api/equipment/test', TEST, { headers: { ...f.headers, Origin: f.base } });
  assert.equal(started.status, 200); assert.equal(started.body.mode, 'shadow');
  assert.equal(started.body.equipmentTests.active.status, 'active');
  assert.equal(started.body.equipmentTests.lastResult.confirmed, true);
  assert.equal(started.headers.get('cache-control'), 'no-store');
  assert.equal(f.store.getState(KEY).active.previousOn, false);
  assert.equal((await f.post('/api/equipment/test/restore', { deviceId: 'caravan' })).status, 400);
  assert.deepEqual(f.calls, [{ id: 'caravan', on: true }]);
  const restored = await f.post('/api/equipment/test/restore', {});
  assert.equal(restored.status, 200); assert.equal(restored.body.equipmentTests.active, null);
  assert.equal(restored.body.equipmentTests.lastResult.status, 'restored');
  assert.deepEqual(f.calls, [{ id: 'caravan', on: true }, { id: 'caravan', on: false }]);
  assert.equal(f.store.getState(KEY).active, null);
});

test('manual switch HTTP controls change and confirm state without scheduling a reversal', async t => {
  const f = await serverFixture(t);
  const changed = await f.post('/api/equipment/switch', { deviceId: 'caravan', on: true });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.equipmentControls.lastResult.confirmed, true);
  assert.equal(changed.body.equipmentControls.lastResult.on, true);
  assert.equal(changed.body.equipment.devices[0].readings.caravan_active.value, 1);
  assert.equal(changed.body.equipmentTests.active, null);
  assert.equal((await f.post('/api/equipment/switch', TEST)).status, 400);
  assert.deepEqual(f.calls, [{ id: 'caravan', on: true }]);
  f.confirm(false);
  const uncertain = await f.post('/api/equipment/switch', { deviceId: 'caravan', on: false });
  assert.equal(uncertain.status, 400);
  assert.equal(f.engine.status().equipmentControls.lastResult.confirmed, false);
  assert.equal(f.engine.status().equipmentControls.lastResult.sent, true);
});

test('native H66 HTTP changes confirm readback and remain permanent across the former expiry', async t => {
  const f = await serverFixture(t), sent = [], deviceId = 'synthetic-h66';
  const decoder = createH66Decoder({ deviceId });
  let h66;
  const feed = (register, value) => h66.ingest(decoder.decode({ topic: `${deviceId}/HP/${register}`,
    payload: String(value), receivedAt: f.engine.clock() }));
  h66 = createH66Controller({ deviceId, store: f.store, clock: f.engine.clock,
    config: { writeEnabled: true, readbackTimeoutMs: 30 }, publish: async (topic, payload) => {
      sent.push({ topic, payload }); queueMicrotask(() => feed(topic.split('/').at(-1), Number(payload)));
    } });
  h66.setConnected(true);
  for (const [register, value] of Object.entries({ '0203': 20, '0212': 44, '0208': 60, '2201': 1 })) feed(register, value);
  f.engine.setH66(h66);
  f.engine.tick(); await f.engine.dispatchPending;
  for (const input of [null, [], {}, { register: '0203', value: 40 }, { register: 'invalid', value: 20 },
    { register: '0203', value: 21, durationMinutes: 2 }])
    assert.equal((await f.post('/api/equipment/h66', input)).status, 400);
  assert.equal(sent.length, 0);
  const changed = await f.post('/api/equipment/h66', { register: '0203', value: 21 });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.h66.lastManual.confirmed, true);
  assert.equal(changed.body.h66.readings['0203'].value, 21);
  assert.equal(changed.body.h66.expiresAt, null);
  assert.deepEqual(changed.body.h66.obligations, {});
  assert.equal(sent.length, 1);
  f.advance(60_000); await h66.reconcile();
  const restored = await (await fetch(`${f.base}/api/status`, { headers: f.headers })).json();
  assert.equal(restored.h66.readings['0203'].value, 21);
  assert.equal(restored.h66.expiresAt, null);
  assert.deepEqual(restored.h66.obligations, {});
  assert.deepEqual(sent.map(({ payload }) => payload), ['21']);
});

test('an unconfirmed HTTP switch command leaves a visible durable restoration obligation', async t => {
  const f = await serverFixture(t);
  f.confirm(false);
  const failed = await f.post('/api/equipment/test', TEST);
  assert.equal(failed.status, 400);
  const status = await (await fetch(`${f.base}/api/status`, { headers: f.headers })).json();
  assert.equal(status.equipmentTests.active.status, 'restoration-pending');
  assert.equal(status.equipmentTests.lastResult.confirmed, false);
  assert.equal(f.store.getState(KEY).active.previousOn, false);
  f.confirm(true);
  assert.equal((await f.post('/api/equipment/test/restore', {})).status, 200);
  assert.deepEqual(f.calls, [{ id: 'caravan', on: true }, { id: 'caravan', on: false }]);
});

function brokerFixture(beforeReply) {
  const clients = [], events = [], outputs = new Map(), identities = [], heldReadbacks = [], hardwareIds = new Map();
  let rejectOff = false, holdReadbacks = false;
  const connect = (address, options) => {
    if (identityConnection(options)) { const client = idleIdentityClient(); identities.push(client); return client; }
    const client = new EventEmitter();
    Object.assign(client, { connected: true, closed: false, address }); clients.push(client);
    client.subscribe = (topic, _options, done) => { events.push({ type: 'subscribe', topic, client }); done?.(); };
    client.end = (_force, _options, done) => {
      client.closed = true; client.connected = false; events.push({ type: 'close', client }); done?.();
    };
    client.publish = (topic, payload, publication, done) => {
      const frame = topic.endsWith('/rpc') ? JSON.parse(String(payload)) : null;
      events.push({ type: 'publish', topic, payload: String(payload), frame, publication, client }); done?.();
      if (!frame) {
        if (topic === 'invented-aux/get' && String(payload) === 'status') queueMicrotask(() => {
          if (client.closed) return;
          beforeReply(); client.emit('message', 'invented-aux/state', Buffer.from('{"value":false}'), { retain: false });
        });
        return;
      }
      const prefix = topic.slice(0, -4);
      let result, error;
      if (frame.method === 'Switch.Set') {
        if (!frame.params.on && rejectOff) error = { code: -1, message: 'synthetic relay unavailable' };
        else { outputs.set(prefix, frame.params.on); result = { was_on: !frame.params.on }; }
      } else if (frame.method === 'Switch.GetStatus') {
        result = { id: 0, output: outputs.get(prefix) ?? false, apower: 100, current: 0.5, aenergy: { total: 1000 } };
      } else if (frame.method === 'Shelly.GetStatus') {
        result = { 'switch:0': { id: 0, output: outputs.get(prefix) ?? false, apower: 100, current: 0.5, aenergy: { total: 1000 } } };
      } else if (frame.method === 'Shelly.GetDeviceInfo') {
        result = { id: hardwareIds.get(prefix) ?? prefix, gen: 2 };
      } else throw new Error('The fixture received a non-status equipment operation.');
      const respond = () => queueMicrotask(() => {
        if (client.closed) return;
        beforeReply(); events.push({ type: 'reply', method: frame.method, topic, client });
        client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({ id: frame.id, src: hardwareIds.get(prefix) ?? prefix, dst: frame.src,
          ...(error ? { error } : { result }) })), { retain: false });
      });
      if (holdReadbacks && frame.method === 'Switch.GetStatus') heldReadbacks.push(respond);
      else respond();
    };
    return client;
  };
  return { connect, clients, events, outputs, identities, hardwareIds, failOff(value) { rejectOff = value; },
    holdReadbacks(value) { holdReadbacks = value; if (!value) for (const respond of heldReadbacks.splice(0)) respond(); },
    commands: () => events.filter(row => row.type === 'publish' && row.frame?.method === 'Switch.Set') };
}

const native = (id = 'caravan', prefix = 'invented-caravan') => ({ id, label: 'Synthetic test switch', area: 'garage',
  kind: 'metered_switch', connection: `shelly:${prefix}`, switch_control: true });
async function runtimeFixture(t, devices = [native()]) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-equipment-api-'));
  const path = join(directory, 'settings.json');
  let now = INITIAL;
  const options = { controller: { input: 'mqtt', mode: 'shadow', web_token: TOKEN },
    mqtt: { address: 'mqtt://synthetic-equipment.invalid' }, teslamate: { enabled: false },
    equipment: { devices: [] } };
  const write = (selected = devices, patch = {}) => writeFileSync(path, JSON.stringify({ ...options, ...patch,
    equipment: { devices: selected } }), { mode: 0o600 });
  write();
  const load = () => loadConfig({ STMQ_CONFIG: path, XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory,
    STMQ_PORT: '0' }, directory);
  const mqtt = brokerFixture(() => { now++; });
  const launch = () => start({ config: load(), clock: () => now, installSignalHandlers: false,
    providerOptions: { automatic: false }, mqttOptions: { connect: mqtt.connect } });
  let app = await launch();
  let expectedCleanupFailure = false;
  t.after(async () => {
    try {
      mqtt.failOff(false);
      if (expectedCleanupFailure) await assert.rejects(app.close(), /cleanup completed with errors/);
      else await app.close();
    }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  await flush();
  const post = async (route, input = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${route}`, { method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  return { get app() { return app; }, mqtt, write, post,
    expectCleanupFailure() { expectedCleanupFailure = true; },
    async restart() { await app.close({ restore: false }); now++; app = await launch(); await flush(); },
    advance(ms) { now += ms; } };
}

test('runtime equipment recheck sends only status requests to the selected configured native device', async t => {
  const f = await runtimeFixture(t, [native(), native('other', 'invented-other')]);
  assert.equal(f.app.engine.status().equipment.devices.length, 2);
  f.mqtt.events.length = 0;
  const checked = await f.post('/api/equipment/recheck', { deviceId: 'caravan' });
  assert.equal(checked.status, 200);
  const requests = f.mqtt.events.filter(row => row.type === 'publish');
  assert.deepEqual(requests.map(row => [row.topic, row.frame?.method]), [['invented-caravan/rpc', 'Shelly.GetStatus']]);
  assert(requests.every(row => row.publication.retain === false));
  assert.equal(f.mqtt.commands().length, 0);
  f.mqtt.events.length = 0;
  assert.equal((await f.post('/api/equipment/recheck', { deviceId: 'invented-unconfigured' })).status, 400);
  assert.equal(f.mqtt.events.length, 0);
});

test('generic equipment recheck publishes only its explicitly configured read request', async t => {
  const f = await runtimeFixture(t, [{ id: 'aux', label: 'Synthetic auxiliary switch', kind: 'switch', area: 'garage',
    connection: 'mqtt:invented-aux/state', switch_control: true,
    mqtt: { command_topic: 'invented-aux/set', on_payload: 'ON', off_payload: 'OFF',
      request_topic: 'invented-aux/get', request_payload: 'status' } }]);
  f.mqtt.events.length = 0;
  const checked = await f.post('/api/equipment/recheck', { deviceId: 'aux' });
  assert.equal(checked.status, 200);
  assert.deepEqual(f.mqtt.events.filter(row => row.type === 'publish').map(row => [row.topic, row.payload]), [['invented-aux/get', 'status']]);
  assert.equal(checked.body.equipment.devices[0].available, true);
  assert.equal(f.app.store.getState(KEY), null);
});

test('explicit shadow-mode door HTTP controls publish configured commands without optimistic position or unsupported Stop', async t => {
  const f = await runtimeFixture(t, [{ id: 'garage_door1', label: 'Synthetic garage door', area: 'garage', kind: 'door',
    connection: 'mqtt:invented-door/state', cover_control: true,
    mqtt: { command_topic: 'invented-door/cover', open_payload: 'open', close_payload: 'closed',
      state_path: 'value', timestamp_path: 'timestamp', cover_state_path: 'cover_state', availability_topic: 'invented-door/online' } }]);
  const client = f.mqtt.clients[0];
  client.emit('message', 'invented-door/state', Buffer.from(JSON.stringify({ value: 'closed', cover_state: 'closed',
    timestamp: new Date(INITIAL).toISOString() })), { retain: false });
  client.emit('message', 'invented-door/online', Buffer.from('online'), { retain: false });
  f.mqtt.events.length = 0;
  for (const input of [null, [], {}, { deviceId: 'unknown', action: 'open' }, { deviceId: 'garage_door1', action: 'toggle' },
    { deviceId: 'garage_door1', action: 'stop' }, { deviceId: 'garage_door1', action: 'open', topic: 'invented/arbitrary' }])
    assert.equal((await f.post('/api/equipment/cover', input)).status, 400);
  assert.equal(f.mqtt.events.filter(row => row.type === 'publish').length, 0);
  const opened = await f.post('/api/equipment/cover', { deviceId: 'garage_door1', action: 'open' });
  assert.equal(opened.status, 200); assert.equal(opened.body.mode, 'shadow');
  const device = opened.body.equipment.devices[0];
  assert.deepEqual(device.controls.cover, { open: true, close: true, stop: false });
  assert.equal(device.cover.state, 'closed'); assert.equal(device.cover.operation.status, 'published');
  assert.deepEqual(f.mqtt.events.filter(row => row.type === 'publish').map(row => ({ topic: row.topic, payload: row.payload, options: row.publication })),
    [{ topic: 'invented-door/cover', payload: 'open', options: { qos: 1, retain: false } }]);
  client.emit('message', 'invented-door/online', Buffer.from('offline'), { retain: false });
  assert.equal((await f.post('/api/equipment/cover', { deviceId: 'garage_door1', action: 'close' })).status, 400);
});

test('dehumidifier HTTP controls wait for live MQTT feedback and expose confirmed settings separately from commands', async t => {
  const f = await runtimeFixture(t, [{ id: 'caravan_dehumidifier', label: 'Synthetic dehumidifier', area: 'garage', kind: 'dehumidifier',
    connection: 'mqtt:invented-dehumidifier/state', dehumidifier_control: true,
    mqtt: { command_topic: 'invented-dehumidifier/set', timestamp_path: 'timestamp', availability_topic: 'invented-dehumidifier/online' } }]);
  const command = { deviceId: 'caravan_dehumidifier', setting: 'targetHumidity', value: 60 }, client = f.mqtt.clients[0];
  assert.equal((await f.post('/api/equipment/dehumidifier', command)).status, 400);
  const report = (targetHumidity, timestamp) => client.emit('message', 'invented-dehumidifier/state', Buffer.from(JSON.stringify({
    identity: 'a'.repeat(64),
    power: 'off', mode: 'auto', targetHumidity, fanSpeed: 'low', swing: 'fixed_90', timestamp: new Date(timestamp).toISOString(),
    capabilities: { power: ['off', 'on'], targetHumidity: [55, 60], fanSpeed: ['low'] },
  })), { retain: false });
  report(55, INITIAL); client.emit('message', 'invented-dehumidifier/online', Buffer.from('online'), { retain: false });
  f.mqtt.events.length = 0;
  for (const invalid of [{ ...command, value: 61 }, { ...command, deviceId: 'unknown' }, { ...command, topic: 'invented/arbitrary' }])
    assert.equal((await f.post('/api/equipment/dehumidifier', invalid)).status, 400);
  const changed = await f.post('/api/equipment/dehumidifier', command);
  assert.equal(changed.status, 200); assert.equal(changed.body.equipment.devices[0].dehumidifier.state.targetHumidity, 55);
  assert.equal(changed.body.equipment.devices[0].dehumidifier.operation.status, 'published');
  assert.equal((await f.post('/api/equipment/dehumidifier', command)).status, 400);
  assert.deepEqual(f.mqtt.events.filter(row => row.type === 'publish').map(row => ({ topic: row.topic, payload: row.payload, options: row.publication })),
    [{ topic: 'invented-dehumidifier/set', payload: JSON.stringify({ targetHumidity: 60, identity: 'a'.repeat(64), requestedAt: INITIAL, expiresAt: INITIAL + 10_000 }), options: { qos: 1, retain: false } }]);
  f.advance(1000); report(60, INITIAL + 1000);
  assert.equal(f.app.engine.status().equipment.devices[0].dehumidifier.operation.status, 'observed');
  client.emit('message', 'invented-dehumidifier/online', Buffer.from('offline'), { retain: false });
  assert.equal((await f.post('/api/equipment/dehumidifier', { ...command, setting: 'power', value: 'on' })).status, 400);
});

test('dehumidifier automatic power choices are editable without device feedback and do not write configuration', async t => {
  const f = await runtimeFixture(t, [bluHtEquipment({ prefix: 'invented/air' }), {
    id: 'caravan_dehumidifier', area: 'garage', kind: 'dehumidifier',
    connection: 'mqtt:invented-dehumidifier/state', dehumidifier_control: true,
    temperature_control: { sensor_device_id: 'blu_ht' },
    mqtt: { command_topic: 'invented-dehumidifier/set', timestamp_path: 'timestamp', availability_topic: 'invented-dehumidifier/online' },
  }]);
  const route = '/api/equipment/dehumidifier/temperature-control';
  for (const invalid of [null, {}, { deviceId: 'unknown', enabled: false },
    { deviceId: 'caravan_dehumidifier', offAtC: 3, onAtC: 2 },
    { deviceId: 'caravan_dehumidifier', enabled: 'false' },
    { deviceId: 'caravan_dehumidifier', enabled: false, topic: 'invented/other' }])
    assert.equal((await f.post(route, invalid)).status, 400);
  const client = f.mqtt.clients[0];
  client.emit('message', 'invented-dehumidifier/state', Buffer.from(JSON.stringify({ identity: 'a'.repeat(64),
    power: 'off', fanSpeed: 'low', humidity: 50, timestamp: INITIAL,
    capabilities: { power: ['off', 'on'], fanSpeed: ['low'] },
  })), { retain: false });
  client.emit('message', 'invented-dehumidifier/online', Buffer.from('offline'), { retain: false });
  const changed = await f.post(route, { deviceId: 'caravan_dehumidifier', enabled: false, offAtC: 1.5, onAtC: 3 });
  assert.equal(changed.status, 200);
  const policy = changed.body.equipment.devices.find(row => row.id === 'caravan_dehumidifier').dehumidifier.temperatureControl;
  assert.equal(policy.enabled, false); assert.equal(policy.offAtC, 1.5); assert.equal(policy.onAtC, 3);
  assert.equal(policy.recording, false);
  assert.equal(f.mqtt.events.filter(row => row.type === 'publish' && row.topic.endsWith('/set')).length, 0);
});

test('configuration reload confirms restoration through the old route before closing it and subscribing to the new route', async t => {
  const f = await runtimeFixture(t);
  assert.equal((await f.post('/api/equipment/test', TEST)).status, 200);
  const oldEngine = f.app.engine, oldClient = f.mqtt.clients[0];
  f.mqtt.events.length = 0;
  f.write([native('caravan', 'invented-replacement')]);
  assert.equal((await f.post('/api/settings/reload')).status, 200);
  const events = f.mqtt.events;
  const restore = events.findIndex(row => row.type === 'publish' && row.frame?.method === 'Switch.Set');
  const confirmed = events.findIndex(row => row.type === 'reply' && row.method === 'Switch.GetStatus');
  const ended = events.findIndex(row => row.type === 'close' && row.client === oldClient);
  const subscribed = events.findIndex(row => row.type === 'subscribe' && row.topic === 'invented-replacement/#');
  assert(restore >= 0 && confirmed > restore && ended > confirmed && subscribed > ended);
  assert.equal(events[restore].topic, 'invented-caravan/rpc');
  assert.equal(events[restore].frame.params.on, false);
  assert.notEqual(f.app.engine, oldEngine); assert.equal(oldClient.closed, true);
  assert.equal(f.app.store.getState(KEY).active, null);
  assert(f.mqtt.commands().every(row => row.topic === 'invented-caravan/rpc' && row.frame.params.on === false));
});

test('a pending restoration rejects configuration reload and keeps the old route available for retry', async t => {
  const f = await runtimeFixture(t);
  assert.equal((await f.post('/api/equipment/test', TEST)).status, 200);
  const oldEngine = f.app.engine, oldClient = f.mqtt.clients[0];
  f.write([native('caravan', 'invented-replacement')]); f.mqtt.failOff(true);
  const failed = await f.post('/api/settings/reload');
  assert.equal(failed.status, 400); assert.match(failed.body.error, /restoration is still pending/);
  assert.equal(f.app.engine, oldEngine); assert.equal(oldClient.closed, false);
  assert.equal(f.app.store.getState(KEY).active.status, 'restoration-pending');
  assert.equal(f.mqtt.clients.length, 1);
  f.mqtt.failOff(false);
  assert.equal((await f.post('/api/settings/reload')).status, 200);
  assert.equal(f.app.store.getState(KEY).active, null); assert.equal(oldClient.closed, true);
});

test('configuration reload refuses to swap routes while the equipment test command is still in flight', async t => {
  const f = await runtimeFixture(t);
  f.mqtt.holdReadbacks(true);
  const pending = f.post('/api/equipment/test', TEST);
  for (let i = 0; i < 100 && !f.app.engine.equipmentTests.status().busy; i++)
    await new Promise(resolve => setTimeout(resolve, 5));
  const oldEngine = f.app.engine;
  f.write([native('caravan', 'invented-replacement')]);
  const rejected = await f.post('/api/settings/reload');
  assert.equal(rejected.status, 400); assert.match(rejected.body.error, /finish before updating settings/);
  assert.equal(f.app.engine, oldEngine); assert.equal(f.mqtt.clients.length, 1); assert.equal(f.mqtt.clients[0].closed, false);
  assert.deepEqual(f.mqtt.commands().map(row => row.frame.params.on), [true]);
  f.mqtt.holdReadbacks(false);
  assert.equal((await pending).status, 200);
  assert.equal((await f.post('/api/settings/reload')).status, 200);
});

test('runtime restart restores a saved manual test without dispatching a new ON', async t => {
  const f = await runtimeFixture(t);
  assert.equal((await f.post('/api/equipment/test', TEST)).status, 200);
  const before = f.mqtt.commands().length;
  await f.restart();
  assert.equal(f.app.engine.status().equipmentTests.active, null);
  assert.equal(f.app.store.getState(KEY).active, null);
  assert.deepEqual(f.mqtt.commands().slice(before).map(row => row.frame.params.on), [false]);
});

test('a restart with a changed route preserves the obligation and never controls the replacement device', async t => {
  const f = await runtimeFixture(t);
  assert.equal((await f.post('/api/equipment/test', TEST)).status, 200);
  const before = f.mqtt.commands().length;
  f.write([native('caravan', 'invented-replacement')]);
  await f.restart();
  const state = f.app.engine.status().equipmentTests;
  assert.equal(state.active.status, 'restoration-pending');
  assert.equal(state.lastResult.code, 'EQUIPMENT_TEST_ROUTE');
  assert.equal(f.mqtt.commands().length, before);
  await f.app.close({ restore: false });
});

test('replacement native hardware reusing the same MQTT prefix cannot inherit a saved restoration obligation', async t => {
  const f = await runtimeFixture(t);
  const started = await f.post('/api/equipment/test', TEST);
  assert.equal(started.status, 200, JSON.stringify({ error: started.body.error,
    methods: f.mqtt.events.filter(row => row.type === 'publish').map(row => row.frame?.method),
    controls: f.app.engine.equipment.status().devices[0].controls,
    identified: Boolean(f.app.engine.equipment.signature('caravan')) }));
  const before = f.mqtt.commands().length;
  f.mqtt.hardwareIds.set('invented-caravan', 'invented-replacement-hardware');
  await f.restart();
  const state = f.app.engine.status().equipmentTests;
  assert.equal(state.active?.status, 'restoration-pending');
  assert.equal(state.lastResult.code, 'EQUIPMENT_TEST_ROUTE');
  assert.equal(f.mqtt.commands().length, before);
  await f.app.close({ restore: false });
});

test('native hardware replacement on the existing broker connection invalidates the saved route', async t => {
  const f = await runtimeFixture(t);
  assert.equal((await f.post('/api/equipment/test', TEST)).status, 200);
  const before = f.mqtt.commands().length, client = f.mqtt.clients[0];
  client.emit('message', 'invented-caravan/online', Buffer.from('false'), { retain: false });
  f.mqtt.hardwareIds.set('invented-caravan', 'invented-replacement-hardware');
  client.emit('message', 'invented-caravan/online', Buffer.from('true'), { retain: false });
  await flush();
  const restored = await f.post('/api/equipment/test/restore');
  assert.equal(restored.status, 400);
  assert.equal(f.app.store.getState(KEY).active.status, 'restoration-pending');
  assert.equal(f.app.engine.status().equipmentTests.lastResult.code, 'EQUIPMENT_TEST_ROUTE');
  assert.equal(f.mqtt.commands().length, before);
  await f.app.close({ restore: false });
});

test('normal runtime shutdown confirms the previous state before closing its acquisition connection', async t => {
  const f = await runtimeFixture(t);
  assert.equal((await f.post('/api/equipment/test', TEST)).status, 200);
  f.mqtt.events.length = 0;
  await f.app.close();
  const confirmed = f.mqtt.events.findIndex(row => row.type === 'reply' && row.method === 'Switch.GetStatus');
  const ended = f.mqtt.events.findIndex(row => row.type === 'close');
  assert(confirmed >= 0 && ended > confirmed);
  assert.deepEqual(f.mqtt.commands().map(row => row.frame.params.on), [false]);
});

test('shutdown still closes the runtime when restoration and its diagnostic write both fail', async t => {
  const f = await runtimeFixture(t);
  assert.equal((await f.post('/api/equipment/test', TEST)).status, 200);
  f.mqtt.failOff(true);
  const setState = f.app.store.setState.bind(f.app.store);
  let failedDiagnostic = false;
  f.app.store.setState = (key, value, ...args) => {
    if (key === KEY && value.active?.status === 'restoration-pending') {
      failedDiagnostic = true;
      throw new Error('synthetic pending-state write failure');
    }
    return setState(key, value, ...args);
  };
  f.expectCleanupFailure();
  await assert.rejects(f.app.close(), /cleanup completed with errors/);
  assert.equal(failedDiagnostic, true);
  assert.equal(f.mqtt.clients[0].closed, true);
  assert.equal(f.app.server.listening, false);
  assert.equal(f.app.engine.equipmentTests.status().available, false);
  assert.equal(f.app.engine.equipmentTests.status().active.status, 'restoration-pending');
});

test('authority demotion cancels an in-flight equipment readback and keeps its obligation without further commands', { timeout: 5000 }, async t => {
  const f = await runtimeFixture(t);
  f.mqtt.holdReadbacks(true);
  const pending = f.post('/api/equipment/test', TEST);
  for (let i = 0; i < 100 && !f.mqtt.events.some(row => row.type === 'publish' && row.frame?.method === 'Switch.GetStatus'); i++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.mqtt.commands().length, 1);
  const topic = `st-mq/control-authority/${createHash('sha256').update(CONTROL_SCOPE).digest('hex').slice(0, 32)}`;
  const identity = f.mqtt.identities[0];
  identity.connected = true; identity.emit('connect');
  identity.emit('message', topic, Buffer.from(JSON.stringify({ version: 1, nodeId: randomUUID(), epoch: randomUUID(),
    role: 'master', platform: 'hassio', at: INITIAL, boot: randomUUID(), heartbeat: 1 })), {});
  const failed = await pending;
  assert.equal(failed.status, 400);
  assert.equal(f.mqtt.clients[0].closed, true);
  assert(f.app.store.getState(KEY).active);
  assert.deepEqual(f.mqtt.commands().map(row => row.frame.params.on), [true]);
  assert.equal((await f.post('/api/equipment/test/restore')).status, 409);
  await f.app.close({ restore: false });
});
