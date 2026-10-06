import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { Executor } from '../src/app/executor.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createHeatingTransport } from '../src/control/mqtt.js';
import { validateOptionFields } from '../src/app/configuration-source.js';

const INITIAL = Date.parse('2026-10-06T10:00:00Z'), PREFIX = 'fixture/home/circulation';
const device = { id: 'dhwr', kind: 'switch', connection: `shelly:${PREFIX}`, generation: 3, switch_id: 0,
  record: false, max_age_seconds: 120,
  readings: [{ key: 'power', label: 'Pump power', unit: 'W', component: 'switch:0', path: 'apower', required: true, record: false }] };
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, { identify = true } = {}) {
  const store = new Store(':memory:'), publications = [], observations = [];
  let now = INITIAL, nativeId = 'shelly1pmg3-fixture';
  const settings = equipmentConfiguration({ devices: [device] });
  const capture = createEquipmentCapture({ store, settings, brokerIdentity: 'fixture-broker',
    engine: { clock: () => now, ingest: row => observations.push(row) }, readbackTimeoutMs: 40,
    publish: async (topic, payload, options) => { publications.push({ topic, frame: JSON.parse(payload), options }); } });
  const context = { config: { connections: { equipment: settings } }, clock: () => now,
    executor: { pulseMs: 600000, status: () => ({ dhwrOutstanding: true, pulseUntil: INITIAL + 600000 }) }, equipmentStatus: () => capture.status() };
  const reply = (publication, result) => capture.receive(`${publication.frame.src}/rpc`, JSON.stringify({
    id: publication.frame.id, src: nativeId, dst: publication.frame.src, result }));
  const identifyDevice = () => reply(publications.findLast(row => row.frame.method === 'Shelly.GetDeviceInfo'), { id: nativeId, gen: 3 });
  capture.setConnected(true); if (identify) identifyDevice();
  t.after(() => { capture.close(); store.close(); });
  return { store, capture, settings, publications, observations, context, reply, identifyDevice,
    status: () => Engine.prototype.dhwrStatus.call(context), at: at => { now = at; },
    report: (power, output = power > 0, packet = {}) => capture.receive(`${PREFIX}/status/switch:0`,
      JSON.stringify({ id: 0, output, apower: power }), packet),
    nativeId: value => { nativeId = value; } };
}

test('circulation uses only direct modern Shelly switch configuration and rejects retired raw MQTT settings', () => {
  const configured = equipmentConfiguration({ devices: [device] }).devices[0];
  assert.equal(configured.controlsSwitch, false);
  assert.equal(configured.stateSignal, 'dhwr_active');
  for (const patch of [{ connection: 'mqtt:fixture/old-power' }, { generation: 1 }, { kind: 'power' },
    { switch_control: true }, { tariff_control: true }, { record: true }, { signal: 'unrelated_active' },
    { readings: [{ ...device.readings[0], unit: 'state' }] }])
    assert.throws(() => equipmentConfiguration({ devices: [{ ...device, ...patch }] }));
  const schema = JSON.parse(readFileSync(new URL('../config.json', import.meta.url))).schema;
  validateOptionFields({ equipment: { devices: [device] } }, schema);
  assert.throws(() => validateOptionFields({ mqtt: { dhwr_topic: 'fixture/retired/set' } }, schema), /Unknown configuration field in mqtt/);
});

test('native watts and switch readback stay live while only compact electrical operation is recorded', t => {
  const f = fixture(t);
  f.report(0); assert.equal(f.status().actualOn, false);
  for (let i = 1; i <= 120; i++) { f.at(INITIAL + i * 30000); f.report(0); }
  assert.equal(f.store.observations({ signal: 'dhwr_active' }).length, 1);
  f.at(INITIAL + 3601000); f.report(24.5);
  const state = f.status();
  assert.equal(state.actualOn, true); assert.equal(state.feedback.power.value, 24.5);
  assert.equal(state.feedback.power.unit, 'W'); assert.equal(state.commandTopic, `${PREFIX}/rpc`);
  assert.deepEqual(f.observations, []);
  assert.deepEqual(f.store.observations({ signal: 'dhwr_active' }).map(row => row.value), [0, 1]);
  assert.equal(f.store.observations({ signal: 'dhwr_power' }).length, 0);
  assert.equal(f.publications.some(row => row.frame.method === 'Switch.Set'), false);
});

test('retained, invalid, expired and disconnected circulation power stays unknown', t => {
  const f = fixture(t);
  f.report(25, true, { retain: true }); assert.equal(f.status().actualOn, null);
  f.report(25); assert.equal(f.status().actualOn, true);
  f.at(INITIAL + 120000); f.capture.tick(); assert.equal(f.status().actualOn, null);
  f.report(25); assert.equal(f.status().actualOn, true);
  for (const power of [null, false, true, -1, 100001]) { f.report(power, true); assert.equal(f.status().actualOn, null); }
  f.report(0); assert.equal(f.status().actualOn, false);
  f.capture.setConnected(false); assert.equal(f.status().actualOn, null);
  f.capture.setConnected(true); f.report(25, true, { retain: true }); assert.equal(f.status().actualOn, null);
});

test('native identity and exact Switch.GetStatus confirm circulation; PUBACK, was_on and notifications cannot', async t => {
  const f = fixture(t, { identify: false });
  await assert.rejects(f.capture.publishDhwr(true), { code: 'SHELLY_IDENTITY_UNAVAILABLE' });
  f.identifyDevice(); f.report(0);
  await assert.rejects(f.capture.setSwitch('dhwr', true), /not configured/);
  let complete = false;
  const pending = f.capture.publishDhwr(true).then(result => { complete = true; return result; });
  await settle();
  const command = f.publications.findLast(row => row.frame.method === 'Switch.Set');
  assert.deepEqual(command.frame.params, { id: 0, on: true });
  assert.deepEqual(command.options, { qos: 1, retain: false, noReplay: true });
  f.report(25); assert.equal(complete, false);
  f.reply(command, { was_on: false }); await settle(); assert.equal(complete, false);
  f.at(INITIAL + 1);
  f.reply(f.publications.findLast(row => row.frame.method === 'Switch.GetStatus'), { id: 0, output: true, apower: 25 });
  assert.equal((await pending).confirmed, true); assert.equal(f.status().actualOn, true);
});

test('failed native readback preserves durable OFF and clears it only after confirmed retry', async t => {
  const f = fixture(t); f.report(0);
  const transport = createHeatingTransport(); transport.setDhwrRelay(f.capture.publishDhwr, () => f.capture.signature('dhwr'));
  const executor = new Executor({ store: f.store, input: 'mqtt', clock: () => INITIAL, commandTransport: transport });
  t.after(() => executor.close({ restore: false }));
  const on = executor.execute({ commands: ['circulation'] }, { automationEnabled: false, manualTest: true, now: INITIAL });
  await settle();
  assert.equal(f.store.getState('executor:home').dhwrOutstanding, true);
  await assert.rejects(on, { code: 'SHELLY_READBACK_TIMEOUT' });
  assert.equal(executor.status().dhwrOutstanding, true);
  const off = executor.stopDhwr(INITIAL + 1000); await settle();
  const command = f.publications.findLast(row => row.frame.method === 'Switch.Set');
  assert.equal(command.frame.params.on, false);
  f.reply(command, { was_on: true }); await settle();
  assert.equal(executor.status().dhwrOutstanding, true);
  f.reply(f.publications.findLast(row => row.frame.method === 'Switch.GetStatus'), { id: 0, output: false, apower: 0 });
  await off; assert.equal(executor.status().dhwrOutstanding, false);
});

test('a replacement native circulation identity cannot inherit an earlier OFF obligation', async t => {
  const f = fixture(t); f.report(0);
  const transport = createHeatingTransport(); transport.setDhwrRelay(f.capture.publishDhwr, () => f.capture.signature('dhwr'));
  const executor = new Executor({ store: f.store, input: 'mqtt', clock: () => INITIAL, commandTransport: transport });
  t.after(() => executor.close({ restore: false }));
  executor.target('dhwr', { acquire: true }); executor.state.dhwrOutstanding = true; executor.persist();
  f.capture.setConnected(false); f.nativeId('shelly1pmg3-replacement'); f.capture.setConnected(true); f.identifyDevice();
  const before = f.publications.length;
  await assert.rejects(executor.stopDhwr(), { code: 'EXECUTOR_TARGET_CHANGED' });
  assert.equal(f.publications.length, before); assert.equal(executor.status().dhwrOutstanding, true);
});

test('failed native history writes roll back readings and allow an exact retry', t => {
  const f = fixture(t); f.report(0); f.at(INITIAL + 5000);
  const observation = f.store.observation;
  f.store.observation = () => { throw new Error('synthetic write failure'); };
  assert.throws(() => f.report(25), /synthetic write failure/);
  assert.equal(f.status().actualOn, false);
  f.store.observation = observation; f.report(25);
  assert.equal(f.status().actualOn, true);
  assert.deepEqual(f.store.observations({ signal: 'dhwr_active' }).map(row => row.value), [0, 1]);
});

test('stale power blocks a new circulation run but leaves native OFF restoration available', async t => {
  const f = fixture(t); f.report(25); f.at(INITIAL + 120000);
  const before = f.publications.length;
  await assert.rejects(f.capture.publishDhwr(true), { code: 'SHELLY_CONTROL_FAILED' });
  assert.equal(f.publications.length, before);
  const stopping = f.capture.publishDhwr(false); await settle();
  const command = f.publications.findLast(row => row.frame.method === 'Switch.Set');
  assert.equal(command.frame.params.on, false);
  f.reply(command, { was_on: true }); await settle();
  f.reply(f.publications.findLast(row => row.frame.method === 'Switch.GetStatus'), { id: 0, output: false, apower: 0 });
  assert.equal((await stopping).confirmed, true);
});
