import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { loadConfig } from '../src/app/config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { startMqtt } from '../src/acquisition/mqtt.js';

const INITIAL = Date.parse('2026-09-13T10:00:00Z'), TOPIC = 'stmq/home/dhwr/status/power';
const device = { id: 'dhwr', label: 'Hot-water circulation', kind: 'power', connection: `mqtt:${TOPIC}`, record: false, max_age_seconds: 0 };
function fixture(t, patch = {}) {
  const store = new Store(':memory:'), publications = [], observations = [];
  let now = INITIAL;
  const settings = equipmentConfiguration({ devices: [{ ...device, ...patch }] });
  const capture = createEquipmentCapture({ store, settings, engine: { clock: () => now, ingest: row => observations.push(row) },
    publish: (...args) => { publications.push(args); return Promise.resolve(); }, refreshSubscriptions: async () => {} });
  const context = { config: { connections: { equipment: settings } }, clock: () => now,
    executor: { pulseMs: 600000, status: () => ({ dhwrOutstanding: true, pulseUntil: INITIAL + 600000 }) },
    equipmentStatus: () => capture.status() };
  t.after(() => { capture.close(); store.close(); });
  capture.setConnected(true); capture.confirmSubscriptions([TOPIC]);
  return { capture, settings, publications, observations, store, context, status: () => Engine.prototype.dhwrStatus.call(context),
    at: at => { now = at; }, report: (payload, packet = {}) => capture.receive(TOPIC, payload, packet) };
}

test('DHWR watts-only feed accepts 0 and 1 as measured ON/OFF feedback and records only derived state', async t => {
  const f = fixture(t);
  assert.deepEqual(f.settings.devices[0].ownedSignals, ['dhwr_power']);
  assert.equal(f.status().feedback.stateConfigured, true);
  assert.equal(f.status().feedback.powerConfigured, true);
  assert.equal(f.status().feedback.available, false);
  for (const watts of [0, 1, 24.5, 100000]) {
    assert.equal(f.report(String(watts)), true);
    const state = f.status();
    assert.equal(state.feedback.available, true);
    assert.equal(state.feedback.power.value, watts);
    assert.equal(state.feedback.power.unit, 'W');
    assert.equal(state.feedback.power.eventOnly, true);
    assert.equal(state.feedback.state.value, Number(watts > 0));
    assert.equal(state.actualOn, watts > 0);
    assert.equal(state.confirmed, watts > 0);
    assert.equal(state.active, true, 'Measured watts do not rewrite a timed command');
  }
  await f.capture.recheck({ deviceId: 'dhwr' });
  assert.deepEqual(f.publications, [], 'A subscription recheck cannot run the pump or manufacture a measurement');
  assert.deepEqual(f.observations, []);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM observations').get().count, 4);
});

test('change-only power preserves original report age, clears on disconnect and waits for genuine recovery', t => {
  const f = fixture(t);
  f.report('0');
  f.at(INITIAL + 86400000); f.capture.tick();
  assert.equal(f.status().feedback.power.value, 0);
  assert.equal(f.status().feedback.power.observedAt, INITIAL);
  assert.equal(f.status().feedback.power.stale, false);
  f.capture.setConnected(false);
  assert.equal(f.status().feedback.available, false);
  assert.equal(f.status().feedback.power.value, null);
  f.capture.setConnected(true); f.capture.confirmSubscriptions([TOPIC]);
  f.report('27', { retain: true });
  f.report('27', { dup: true });
  assert.equal(f.status().feedback.available, false);
  f.report('27');
  assert.equal(f.status().feedback.available, true);
  assert.equal(f.status().feedback.power.observedAt, INITIAL + 86400000);
});

test('invalid, implausible, overflowing and future-dated DHWR readings invalidate power', t => {
  for (const payload of ['ON', '', 'null', 'true', '"25"', '-1', '100001', '1e309', '{"value":25,"timestamp":"2026-09-14T10:00:00Z"}']) {
    const f = fixture(t); f.report('25'); f.report(payload);
    assert.equal(f.status().feedback.available, false, payload);
    assert.equal(f.status().feedback.power.value, null, payload);
    assert.equal(f.status().actualOn, null, payload);
    f.report('0'); assert.equal(f.status().feedback.available, true);
  }
});

test('a configured periodic power feed expires, and failed subscriptions cannot certify its last reading', t => {
  const f = fixture(t, { max_age_seconds: 120 }); f.report('25');
  assert.equal(f.status().feedback.power.eventOnly, undefined);
  f.at(INITIAL + 120000); f.capture.tick();
  assert.equal(f.status().feedback.available, false);
  assert.equal(f.status().feedback.power.stale, true);
  f.report('25'); f.capture.subscriptionFailed(TOPIC);
  assert.equal(f.status().feedback.available, false);
  assert.equal(f.status().feedback.power.value, null);
});

test('DHWR power remains a monitoring-only watts feed and permits explicit JSON scaling', t => {
  for (const patch of [{ connection: 'shelly:invented/power' }, { switch_control: true }, { tariff_control: true }, { record: true },
    { signal: 'dhwr_active' }, { readings: [{ key: 'power', unit: 'state' }] }, { readings: [{ key: 'power', unit: 'kW' }] },
    { max_age_seconds: 1 }]) assert.throws(() => equipmentConfiguration({ devices: [{ ...device, ...patch }] }));
  const f = fixture(t, { readings: [{ key: 'power', unit: 'W', path: 'watts', scale: 1000 }] });
  f.report('{"watts":0.025}'); assert.equal(f.status().feedback.power.value, 25);
  f.report('{"watts":1e308}'); assert.equal(f.status().feedback.available, false);
});

test('provider MQTT acquisition loads the default DHWR topic and exposes live feedback without any pump publications', async t => {
  const store = new Store(':memory:'), client = new EventEmitter(), subscriptions = [], publications = [];
  const config = loadConfig({ HOME: '/missing-synthetic-home', STMQ_INPUT: 'providers' }, '/missing-synthetic-repository');
  const dhwr = config.connections.equipment.devices.find(row => row.id === 'dhwr');
  config.connections = { mqtt: { address: 'mqtt://synthetic.invalid', dhwr_topic: config.connections.mqtt.dhwr_topic },
    equipment: { ...config.connections.equipment, devices: [dhwr], ownedSignals: dhwr.ownedSignals } };
  config.deviceId = null;
  const engine = new Engine({ store, config, clock: () => INITIAL });
  client.subscribe = (topic, options, done) => { subscriptions.push(topic); done(null, [{ topic, qos: 1 }]); };
  client.publish = (topic, payload, options, done) => { publications.push({ topic, payload }); done(); };
  client.end = (force, options, done) => done();
  const capture = await startMqtt({ engine, store, config, connect: () => client });
  engine.equipment = capture.equipment;
  t.after(async () => { await capture.close(); await engine.closeFireplace(); await engine.executor.close({ restore: false }); store.close(); });
  client.emit('connect');
  assert.deepEqual(subscriptions, ['stmq/garage/charger1/vehicle', TOPIC]);
  client.emit('message', TOPIC, Buffer.from('24.5'), { retain: false, qos: 1 });
  const status = engine.status();
  assert.equal(status.dhwr.feedback.power.value, 24.5);
  assert.equal(status.dhwr.feedback.stateConfigured, true);
  assert.equal(status.dhwr.actualOn, true);
  assert.equal(status.equipment.devices[0].topics[0].role, 'Power');
  assert.equal(status.equipment.topicGroups.find(row => row.id === 'dhwr').topics[0].topic, 'stmq/home/dhwr/command/switch');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM observations WHERE signal IN ('dhwr_power', 'dhwr_active')").get().count, 1);
  assert.deepEqual(publications, []);
});


test('every circulation request needs a new matching power report, including unchanged state', t => {
  const f = fixture(t); f.report('25');
  assert.equal(f.status().confirmed, true);
  f.at(INITIAL + 1000);
  f.context.executor.status = () => ({ dhwrOutstanding: true, pulseUntil: INITIAL + 600000,
    dhwrRequested: { on: true, at: INITIAL + 1000 } });
  assert.equal(f.status().actualOn, true); assert.equal(f.status().confirmed, false);
  assert.equal(f.status().attention, true); assert.match(f.status().reason, /new power report/);
  f.report('25'); assert.equal(f.status().confirmed, true);
  f.at(INITIAL + 2000);
  f.context.executor.status = () => ({ dhwrOutstanding: false, pulseUntil: 0,
    dhwrRequested: { on: false, at: INITIAL + 2000 } });
  assert.equal(f.status().confirmed, false);
  f.report('25'); assert.equal(f.status().confirmed, false);
  f.report('0'); assert.equal(f.status().confirmed, true); assert.equal(f.status().attention, false);
});
