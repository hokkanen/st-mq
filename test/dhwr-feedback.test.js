import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { equipmentConfiguration, equipmentSignature } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { Engine } from '../src/app/engine.js';
import { Executor } from '../src/app/executor.js';
import { loadConfig, validateSettings } from '../src/app/config.js';
import { createHeatingTransport } from '../src/control/mqtt.js';
import { validateOptionFields } from '../src/app/configuration-source.js';
import { Store } from '../src/storage/store.js';

const INITIAL = Date.parse('2026-09-13T10:00:00Z');
const feedback = {
  id: 'dhwr', label: 'Hot-water circulation', area: 'home', kind: 'switch',
  connection: 'mqtt:invented/dhwr/status', record: false, mqtt: { state_path: 'switch' },
  readings: [{ key: 'power', label: 'Pump power', unit: 'W', path: 'power', record: false }],
};
function fixture(t, device = feedback) {
  const store = new Store(':memory:'), writes = [], commands = [];
  let now = INITIAL;
  const capture = createEquipmentCapture({ store, settings: equipmentConfiguration({ devices: [device] }),
    engine: { clock: () => now, ingest: row => { writes.push(row); store.observation(row); }, rememberObservation: row => writes.push(row) },
    publish: (...args) => { commands.push(args); return Promise.resolve(); } });
  const executor = { pulseMs: 600_000, status: () => ({ dhwrOutstanding: false, pulseUntil: 0 }) };
  const status = () => Engine.prototype.dhwrStatus.call({ executor, clock: () => now,
    equipmentStatus: () => capture.status(), config: { connections: { mqtt: { dhwr_topic: 'invented/dhwr/set' } } } });
  t.after(() => { capture.close(); store.close(); });
  capture.setConnected(true);
  return { store, capture, writes, commands, executor, status, now: value => { now = value; } };
}

test('DHWR feedback is live-only, monitoring-only and uses explicit safe mappings', () => {
  const device = equipmentConfiguration({ devices: [{ ...feedback, record: undefined }] }).devices[0];
  assert.equal(device.record, false);
  assert.equal(device.stateSignal, 'dhwr_active');
  assert.equal(device.readings[0].signal, 'dhwr_power');
  for (const patch of [
    { record: true }, { switch_control: true }, { tariff_control: true }, { kind: 'metered_switch' },
    { connection: 'shelly:invented/dhwr' }, { signal: 'unrelated_active' },
    { connection: 'mqtt:invented/+' }, { mqtt: { state_path: '__proto__.state' } },
    { readings: [{ key: 'power', unit: 'state' }] },
  ]) assert.throws(() => equipmentConfiguration({ devices: [{ ...feedback, ...patch }] }));
  assert.throws(() => equipmentConfiguration({ devices: [{ id: 'upstairs', kind: 'temperature',
    connection: 'mqtt:invented/room', record: false }] }));
  assert.throws(() => equipmentConfiguration({ devices: [{ id: 'upstairs', kind: 'temperature',
    connection: 'mqtt:invented/room', readings: [{ key: 'temperature', unit: 'degC', record: false }] }] }));
  assert.throws(() => equipmentConfiguration({ devices: [{ id: 'garage', kind: 'switch',
    connection: 'mqtt:invented/garage', record: false }] }));
});

test('recording choices do not change a physical switch identity or its restoration route', () => {
  const row = { id: 'relay', kind: 'switch', connection: 'mqtt:invented/relay',
    readings: [{ key: 'active', unit: 'state', path: 'switch' }] };
  const config = device => equipmentConfiguration({ devices: [device] }).devices[0];
  assert.equal(equipmentSignature(config(row)), equipmentSignature(config({ ...row, record: false,
    readings: [{ ...row.readings[0], record: false }] })));
});

test('live DHWR switch and power stay independent of requested operation and record compact observed state', t => {
  const f = fixture(t);
  f.capture.receive('invented/dhwr/status', '{"switch":"on","power":24.5}');
  let status = f.status();
  assert.equal(status.active, false);
  assert.equal(status.actualOn, true);
  assert.equal(status.confirmed, false, 'Live ON is not confirmation of a requested OFF');
  assert.equal(status.feedback.configured, true);
  assert.equal(status.feedback.available, true);
  assert.equal(status.feedback.power.value, 24.5);
  assert.equal(status.feedback.power.unit, 'W');
  assert.equal(status.durationMinutes, 10);
  assert.equal(status.commandTopic, 'invented/dhwr/set');
  f.executor.status = () => ({ dhwrOutstanding: true, pulseUntil: INITIAL + 600_000 });
  assert.equal(f.status().confirmed, true);
  f.now(INITIAL + 20_000);
  f.capture.receive('invented/dhwr/status', '{"switch":"off","power":0}');
  status = f.status();
  assert.equal(status.actualOn, false);
  assert.equal(status.active, true, 'Device feedback never rewrites the executor timer');
  assert.equal(status.confirmed, false);
  assert.equal(status.feedback.power.value, 0);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.commands, []);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM observations').get().count, 2);
});

test('retained, invalid, disconnected and expired DHWR reports cannot establish current ON state', t => {
  const f = fixture(t);
  f.capture.receive('invented/dhwr/status', '{"switch":"on","power":25}', { retain: true });
  assert.equal(f.status().actualOn, null);
  f.capture.receive('invented/dhwr/status', '{"switch":"on","power":25}');
  assert.equal(f.status().actualOn, true);
  f.capture.setConnected(false);
  assert.equal(f.status().actualOn, null);
  f.capture.setConnected(true);
  f.capture.receive('invented/dhwr/status', '{"switch":"on","power":25}');
  f.now(INITIAL + 120_000);
  assert.equal(f.status().actualOn, null);
  assert.equal(f.status().feedback.power.stale, true);
  f.capture.receive('invented/dhwr/status', '{"switch":"unknown","power":"invalid"}');
  assert.equal(f.status().actualOn, null);
  assert.equal(f.status().feedback.available, false);
  assert.deepEqual(f.writes, []);
});

test('a separate DHWR power topic determines operation independently of switch reports', t => {
  const f = fixture(t, { ...feedback, readings: [{ ...feedback.readings[0], topic: 'invented/dhwr/power', path: null }] });
  f.capture.receive('invented/dhwr/power', '22');
  assert.equal(f.status().actualOn, true);
  assert.equal(f.status().feedback.power.value, 22);
  f.capture.receive('invented/dhwr/status', '{"switch":"off"}');
  assert.equal(f.status().actualOn, true);
  assert.equal(f.status().feedback.available, true);
  f.capture.receive('invented/dhwr/power', 'invalid');
  assert.equal(f.status().feedback.power.value, null);
  assert.equal(f.status().actualOn, null);
  assert.equal(f.status().feedback.available, true);
  assert.deepEqual(f.writes, []);
});

test('DHWR feedback configuration is accepted by the manifest and cannot consume or recheck on the ON/OFF command topic', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-dhwr-feedback-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const privatePath = join(directory, 'fixture.json');
  const manifest = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const options = { mqtt: { address: 'mqtt://synthetic.invalid', dhwr_topic: 'invented/dhwr/set' },
    equipment: { devices: [feedback] } };
  validateOptionFields(options, manifest.schema);
  const load = device => {
    writeFileSync(privatePath, JSON.stringify({ ...options, equipment: { devices: [device] } }), { mode: 0o600 });
    return loadConfig({ STMQ_INPUT: 'mqtt', STMQ_CONFIG: privatePath, HOME: directory }, directory);
  };
  assert.equal(load(feedback).connections.equipment.devices[0].record, false);
  assert.throws(() => load({ ...feedback, connection: 'mqtt:invented/dhwr/set' }), /separate from the DHWR switch command/);
  assert.throws(() => load({ ...feedback, readings: [{ ...feedback.readings[0], topic: 'invented/dhwr/set' }] }), /separate from the DHWR switch command/);
  assert.throws(() => load({ ...feedback, mqtt: { ...feedback.mqtt, request_topic: 'invented/dhwr/set', request_payload: 'ON' } }), /separate from the DHWR switch command/);
});

test('DHWR remains usable without feedback configuration', () => {
  const status = Engine.prototype.dhwrStatus.call({ executor: { pulseMs: 600_000, status: () => ({}) },
    clock: () => INITIAL, equipmentStatus: () => ({ devices: [] }), config: {} });
  assert.equal(status.actualOn, null);
  assert.equal(status.confirmed, false);
  assert.deepEqual(status.feedback, { configured: false, stateConfigured: false, powerConfigured: false, deviceId: null, available: false, basis: null, state: null, power: null });
});

function externalPump(t, publishDhwr) {
  const store = new Store(':memory:');
  const engine = new Engine({ store, clock: () => INITIAL, commandTransport: { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) }, publishDhwr, close: async () => {} },
    config: { input: 'mqtt', settings: validateSettings({  }) } });
  const state = { value: 1, unit: 'state', observedAt: INITIAL, stale: false };
  engine.equipment = { status: () => ({ devices: [{ id: 'dhwr', available: true, readings: { dhwr_active: state } }] }) };
  t.after(async () => { await engine.executor.close({ restore: false }); await engine.closeFireplace(); store.close(); });
  return { engine, store, state };
}

test('manual DHWR Stop persists and delivers OFF for a fresh externally started pump', async t => {
  const calls = [];
  const f = externalPump(t, async on => {
    assert.equal(f.store.getState('executor:home').dhwrOutstanding, true, 'OFF obligation precedes delivery');
    calls.push(on); return { sent: true };
  });
  assert.equal(f.engine.dhwrStatus().active, false);
  assert.equal(f.engine.dhwrStatus().actualOn, true);
  const result = await f.engine.stopDhwr();
  assert.deepEqual(calls, [false]);
  assert.equal(f.store.getState('executor:home').dhwrOutstanding, false);
  assert.equal(result.dhwr.actualOn, true, 'Broker acknowledgement cannot replace device feedback');
  assert.equal(result.dhwr.confirmed, false);
  f.state.stale = true;
  await f.engine.stopDhwr();
  f.state.stale = false; f.state.value = 0;
  await f.engine.stopDhwr();
  assert.deepEqual(calls, [false], 'No new OFF without an outstanding obligation or fresh reported ON');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM observations WHERE signal = 'dhwr_request' AND value = 0").get().count, 1);
});

test('failed external DHWR Stop survives restart and retries OFF without starting a run', async t => {
  const f = externalPump(t, async () => { throw Object.assign(new Error('Unconfirmed OFF'), { code: 'MQTT_TIMEOUT' }); });
  await assert.rejects(f.engine.stopDhwr(), { code: 'MQTT_TIMEOUT' });
  assert.equal(f.engine.dhwrStatus().active, false);
  assert.equal(f.engine.dhwrStatus().restorationPending, true);
  assert.equal(f.store.getState('executor:home').dhwrOutstanding, true);
  await f.engine.executor.close({ restore: false });
  const calls = [];
  const restarted = new Executor({ input: 'mqtt', store: f.store, clock: () => INITIAL + 10_000,
    commandTransport: { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) }, publishDhwr: async on => { calls.push(on); return { sent: true }; }, close: async () => {} } });
  try {
    await restarted.restore({ reason: 'restart' });
    assert.deepEqual(calls, [false]);
    assert.equal(restarted.status().dhwrOutstanding, false);
    assert.equal(restarted.status().restorationPending, false);
  } finally { await restarted.close({ restore: false }); }
});

test('external DHWR Stop retains the existing transport authority check', async t => {
  let connections = 0;
  const transport = createHeatingTransport({ connection: { address: 'mqtt://synthetic.invalid' },
    canControl: () => false, connect: () => { connections++; throw new Error('Must not connect'); } });
  t.after(() => transport.close());
  const f = externalPump(t, transport.publishDhwr);
  await assert.rejects(f.engine.stopDhwr(), { code: 'MQTT_AUTHORITY_LOST' });
  assert.equal(connections, 0);
  assert.equal(f.engine.dhwrStatus().restorationPending, true);
});
