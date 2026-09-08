import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createH66Controller } from '../src/control/h66.js';
import { createH66Decoder } from '../src/domain/telemetry.js';
import { startMqtt } from '../src/acquisition/mqtt.js';

const initialTime = Date.parse('2026-09-07T12:00:00Z');
const deviceId = 'fixture-h66';
const baselines = { '0203': 20, '0212': 44, '0208': 60, '2201': 1 };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function memoryStore(seed = {}) {
  const states = new Map(Object.entries(seed));
  return { events: [], getState: key => structuredClone(states.get(key) ?? null),
    setState: (key, value) => states.set(key, structuredClone(value)),
    event(type, detail, now) { this.events.push({ type, detail, now }); } };
}
function rig({ store = memoryStore(), values = baselines, settings = {}, behavior = null } = {}) {
  let now = initialTime;
  const decoder = createH66Decoder({ deviceId, mqttScaleByRegister: settings.mqttScaleByRegister, verifiedRegisters: settings.verification });
  const sent = [], native = { ...values };
  let controller;
  const feed = (index, value = native[index], extra = {}) => controller.ingest(decoder.decode({
    topic: `${deviceId}/HP/${index}`, payload: String(value), receivedAt: now, ...extra,
  }));
  controller = createH66Controller({ deviceId, store, clock: () => now,
    config: { writeEnabled: true, readbackTimeoutMs: 30, ...settings },
    publish: async (topic, payload, options) => {
      const index = topic.split('/').at(-1);
      sent.push({ index, payload, options });
      const saved = store.getState(`h66:control:${deviceId}`);
      assert.ok(saved.obligations[index], 'restoration obligation is durable before publication');
      if (behavior && await behavior({ index, payload, sent, feed, native }) === 'silent') return;
      native[index] = Number(payload);
      queueMicrotask(() => feed(index));
    },
  });
  controller.setConnected(true);
  for (const [index, value] of Object.entries(native)) feed(index, value);
  return { controller, sent, native, feed, store, setNow: value => { now = value; }, get now() { return now; } };
}

test('preheat and reduction restore exact original native settings, never write ROOM10', async t => {
  const r = rig(); t.after(() => r.controller.close());
  const before = r.controller.status();
  assert.equal(before.available, true);
  assert.equal(before.controlsReady, true);
  await r.controller.setPhase({ phase: 'preheat', roomBoostC: 2, expiresAt: r.now + 60_000 });
  assert.equal(r.native['0203'], 22);
  assert.deepEqual(r.controller.status().baseline, baselines);
  await r.controller.setPhase({ phase: 'reduction', expiresAt: r.now + 120_000 });
  assert.deepEqual(r.sent.map(item => [item.index, item.payload]), [
    ['0203', '22'], ['0203', '20'], ['0212', '40'], ['0208', '50'], ['2201', '2'],
  ]);
  assert.equal(r.controller.status().phase, 'reduction');
  await r.controller.setPhase({ phase: 'recovery' });
  assert.deepEqual(r.native, baselines);
  assert.deepEqual(r.controller.status().obligations, {});
  assert.ok(r.sent.every(item => item.options.qos === 0 && item.options.retain === false));
});

test('repeated preheat uses the captured baseline and is idempotent', async t => {
  const r = rig(); t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'preheat', roomBoostC: 1 });
  await r.controller.setPhase({ phase: 'preheat', roomBoostC: 1 });
  assert.equal(r.sent.length, 1);
  await r.controller.setPhase({ phase: 'preheat', roomBoostC: 3 });
  assert.equal(r.native['0203'], 23);
  assert.equal(r.controller.status().baseline['0203'], 20);
});

test('a native compressor-only baseline supports heating cycles and restores mode2 exactly', async t => {
  const r = rig({ values: { ...baselines, '2201': 2 } }); t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'preheat', roomBoostC: 1 });
  assert.equal(r.controller.status().baseline['2201'], 2);
  await r.controller.setPhase({ phase: 'reduction' });
  await r.controller.setPhase({ phase: 'normal' });
  assert.deepEqual(r.native, { ...baselines, '2201': 2 });
  assert.equal(r.sent.some(row => row.index === '2201'), false);
});

test('a baseline below40 is not raised, and preheat cannot start inside reduction', async t => {
  const r = rig({ values: { ...baselines, '0212': 38 } }); t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'reduction' });
  assert.equal(r.native['0212'], 38);
  await assert.rejects(r.controller.setPhase({ phase: 'preheat' }), { code: 'H66_PHASE_CONFLICT' });
  await nextTurn();
});

test('cached, missing or disconnected readings cannot authorize native writes', async t => {
  const r = rig({ values: {} }); t.after(() => r.controller.close());
  for (const [index, value] of Object.entries(baselines)) r.feed(index, value, { retained: true });
  assert.equal(r.controller.status().available, false);
  await assert.rejects(r.controller.setPhase({ phase: 'preheat' }), { code: 'H66_UNAVAILABLE' });
  for (const [index, value] of Object.entries(baselines)) r.feed(index, value);
  r.controller.setConnected(false); r.controller.setConnected(true);
  assert.equal(r.controller.status().controlsReady, false);
  r.feed('0007', 5);
  await assert.rejects(r.controller.setPhase({ phase: 'preheat' }), { code: 'H66_BASELINE_UNAVAILABLE' });
  assert.equal(r.sent.length, 0);
});

test('wire scale overrides are applied symmetrically', async t => {
  const r = rig({ values: { ...baselines, '0203': 200 }, settings: { mqttScaleByRegister: { '0203': 0.1 } } });
  t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'preheat', roomBoostC: 2 });
  assert.equal(r.sent[0].payload, '220');
  assert.equal(r.controller.status().readings['0203'].value, 22);
  await r.controller.restore();
  assert.equal(r.sent.at(-1).payload, '200');
});

test('broker publication without later matching readback is not confirmation', async t => {
  const r = rig({ behavior: () => 'silent' }); t.after(() => r.controller.close());
  await assert.rejects(r.controller.setPhase({ phase: 'preheat' }), { code: 'H66_READBACK_TIMEOUT' });
  await nextTurn();
  assert.equal(r.controller.status().lastResult.status, 'pending');
  assert.ok(r.controller.status().obligations['0203'], 'old pre-write baseline cannot prove failed write had no effect');
  assert.equal(r.controller.status().restorationPending, true);
});

test('retained matching value cannot acknowledge a setting write', async t => {
  const r = rig({ behavior: ({ index, payload, feed }) => { feed(index, Number(payload), { retained: true }); return 'silent'; } });
  t.after(() => r.controller.close());
  await assert.rejects(r.controller.setPhase({ phase: 'preheat' }), { code: 'H66_READBACK_TIMEOUT' });
});

test('expiry restores original settings with live readback', async t => {
  const r = rig(); t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'preheat', expiresAt: r.now + 1000 });
  r.setNow(r.now + 1001);
  const result = await r.controller.reconcile({ now: r.now });
  assert.equal(result.status, 'confirmed');
  assert.equal(r.native['0203'], 20);
  assert.equal(r.controller.status().phase, 'normal');
});

test('restart restores outstanding overrides instead of resuming preheat', async t => {
  const first = rig();
  await first.controller.setPhase({ phase: 'preheat', roomBoostC: 3 });
  await first.controller.close();
  const second = rig({ store: first.store, values: first.native }); t.after(() => second.controller.close());
  await nextTurn(); await nextTurn();
  assert.equal(second.native['0203'], 20);
  assert.deepEqual(second.controller.status().obligations, {});
  assert.equal(second.controller.status().phase, 'normal');
});

test('manual changes supersede saved overrides and cancel the cycle', async t => {
  const r = rig(); t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'reduction' });
  r.native['0212'] = 42; r.feed('0212', 42);
  await nextTurn(); await nextTurn();
  assert.equal(r.native['0212'], 42, 'restore must preserve the manual value');
  assert.equal(r.native['0208'], 60);
  assert.equal(r.native['2201'], 1);
  assert.equal(r.controller.status().phase, 'normal');
});

test('partial failures preserve obligations and restore fields with fresh evidence', async t => {
  let stopFailure = true;
  const r = rig({ behavior: ({ index }) => index === '0208' && stopFailure ? 'silent' : undefined });
  t.after(() => r.controller.close());
  await assert.rejects(r.controller.setPhase({ phase: 'reduction' }), { code: 'H66_READBACK_TIMEOUT' });
  await nextTurn(); await nextTurn();
  assert.equal(r.native['0212'], 44, 'confirmed earlier mutation is restored');
  assert.ok(r.controller.status().obligations['0208']);
  stopFailure = false; r.feed('0208', 60);
  await nextTurn();
  assert.deepEqual(r.controller.status().obligations, {});
});

test('unsupported writes and invalid bounded trials publish nothing', async t => {
  const r = rig(); t.after(() => r.controller.close());
  await assert.rejects(r.controller.writeSettings({ '8105': -990 }), { code: 'H66_SETTINGS_INVALID' });
  await assert.rejects(r.controller.test({ register: '0203', value: 22, durationSeconds: 3600 }), { code: 'H66_TEST_DURATION' });
  await assert.rejects(r.controller.setPhase({ phase: 'preheat', roomBoostC: 6 }), { code: 'H66_BOOST_INVALID' });
  assert.equal(r.sent.length, 0);
});

test('plain MQTT acquisition publishes GETALL, exposes receipt-time evidence, and shares write connection', async t => {
  const fake = new EventEmitter(), store = memoryStore(), observations = [], publications = [];
  const native = { ...baselines };
  let now = initialTime, connectionCount = 0;
  fake.subscribe = (topic, options, done) => { assert.equal(topic, `${deviceId}/HP/#`); done(); };
  fake.publish = (topic, payload, options, done) => {
    publications.push({ topic, payload, options });
    if (topic.includes('/SET/')) native[topic.split('/').at(-1)] = Number(payload);
    done();
    if (payload === 'GETALL') queueMicrotask(() => {
      for (const [index, value] of Object.entries(native)) fake.emit('message', `${deviceId}/HP/${index}`, Buffer.from(String(value)), { retain: false });
    });
  };
  fake.end = (force, options, done) => done();
  const acquisition = await startMqtt({ store, engine: { clock: () => now, ingest: value => observations.push(value) },
    config: { deviceId, connections: { mqtt: { address: 'mqtt://fixture.invalid' } }, h66: { enabled: true, writeEnabled: true, readbackTimeoutMs: 50 } },
    connect: () => { connectionCount++; return fake; } });
  t.after(() => acquisition.close());
  fake.emit('connect'); await nextTurn();
  assert.equal(acquisition.status().available, true);
  assert.equal(observations[0].sourceTime, now);
  assert.equal(observations[0].raw.timeBasis, 'mqtt-received');
  assert.equal(observations[0].raw.sensorMeasuredAt, null);
  assert.equal(observations[0].raw.publicationMayUseGatewayCache, true);
  await acquisition.setPhase({ phase: 'preheat', roomBoostC: 1 });
  assert.equal(connectionCount, 1);
  assert.equal(native['0203'], 21);
  await acquisition.restore();
  assert.equal(native['0203'], 20);
  now += 300_001;
  assert.equal(acquisition.status().available, false);
  assert.ok(publications.some(item => item.payload === 'GETALL'));
});
