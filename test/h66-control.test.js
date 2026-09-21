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
function rig({ store = memoryStore(), values = baselines, settings = {}, behavior = null, startAt = initialTime } = {}) {
  let now = startAt;
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

test('H66 transport settings can tighten but cannot extend the shared five-minute source lifetime', t => {
  for (const [configured, effective] of [[600_000, 300_000], [60_000, 60_000]]) {
    const r = rig({ settings: { maxAgeMs: configured } });
    t.after(() => r.controller.close());
    assert.equal(r.controller.status().maxAgeMs, effective);
    r.setNow(initialTime + effective);
    assert.equal(r.controller.status().readings['0203'].available, true);
    r.setNow(initialTime + effective + 1);
    assert.equal(r.controller.status().readings['0203'].available, false);
  }
});

test('manual native settings retain the original baseline and restore within one minute or on restart', async t => {
  const r = rig(); t.after(() => r.controller.close());
  const result = await r.controller.setSetting({ register: '0203', value: 21 });
  assert.equal(result.confirmed, true); assert.equal(result.sent, true);
  assert.equal(result.previousValue, 20); assert.equal(result.readback, 21);
  assert.equal(r.controller.status().obligations['0203'].baseline, 20);
  assert.equal(r.controller.status().expiresAt, initialTime + 60_000);
  r.setNow(initialTime + 30_000);
  await r.controller.setSetting({ register: '0203', value: 22 });
  assert.equal(r.controller.status().obligations['0203'].baseline, 20);
  assert.equal(r.controller.status().expiresAt, initialTime + 60_000, 'Repeated edits do not extend the temporary deadline');
  r.setNow(initialTime + 60_000); await r.controller.reconcile();
  assert.equal(r.native['0203'], 20);
  assert.deepEqual(r.controller.status().obligations, {});
  assert.equal(r.controller.status().expiresAt, null);
  await r.controller.setSetting({ register: '0203', value: 21 });
  await r.controller.close();
  const restarted = rig({ store: r.store, values: r.native, startAt: r.now });
  t.after(() => restarted.controller.close());
  await nextTurn(); await restarted.controller.reconcile();
  assert.deepEqual(restarted.sent.map(({ payload }) => payload), ['20']);
  await restarted.controller.setPhase({ phase: 'preheat', roomBoostC: 5 });
  assert.equal(restarted.native['0203'], 25);
  await restarted.controller.restore();
  assert.equal(restarted.native['0203'], 20, 'Automatic cycles keep the original native setting');
});

test('paused manual native settings remain selected until the pause deadline and restore their original baseline', async t => {
  const r = rig(); t.after(() => r.controller.close());
  const pause = { pauseId: 'fixture-pause', expiresAt: initialTime + 3_600_000 };
  await r.controller.setSetting({ register: '0203', value: 21, ...pause });
  r.setNow(initialTime + 60_000); await r.controller.reconcile();
  assert.equal(r.native['0203'], 21);
  assert.equal(r.sent.length, 1);
  assert.equal(r.controller.status().phase, 'manual-pause');
  await r.controller.setSetting({ register: '0203', value: 22, ...pause });
  assert.equal(r.controller.status().obligations['0203'].baseline, 20);
  r.setNow(pause.expiresAt);
  r.feed('0203'); await r.controller.reconcile();
  assert.equal(r.native['0203'], 20);
  assert.deepEqual(r.controller.status().obligations, {});
  assert.equal(r.controller.status().expiresAt, null);
});

test('manual native changes respect controller ownership and cannot make a stale value look confirmed', async t => {
  const r = rig(); t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'preheat', roomBoostC: 5 });
  assert.equal(r.controller.status().controls['0203'].available, false);
  await assert.rejects(r.controller.setSetting({ register: '0203', value: 22 }), { code: 'H66_MANUAL_CONFLICT' });
  await nextTurn();
  assert.equal(r.controller.status().phase, 'preheat');
  assert.equal(r.sent.length, 1, 'Rejected manual input does not interrupt or restore the automatic cycle');
  await r.controller.restore();
  r.setNow(initialTime + 300_001);
  await assert.rejects(r.controller.setSetting({ register: '0203', value: 20 }), { code: 'H66_UNAVAILABLE' });
  assert.equal(r.sent.length, 2);
  for (const [register, value] of [['invalid', 20], ['0203', 50], ['2201', 1.5]])
    await assert.rejects(r.controller.setSetting({ register, value }), { code: 'H66_SETTINGS_INVALID' });
});

test('an unconfirmed manual native change keeps its restoration obligation and restores on reconnect without replay', async t => {
  let silent = true;
  const r = rig({ behavior: () => silent ? 'silent' : undefined }); t.after(() => r.controller.close());
  await assert.rejects(r.controller.setSetting({ register: '0203', value: 21 }), { code: 'H66_READBACK_TIMEOUT' });
  assert.equal(r.controller.status().lastManual.confirmed, false);
  assert.equal(r.controller.status().lastManual.status, 'unconfirmed');
  assert.equal(r.controller.status().restorationPending, false);
  assert.equal(r.controller.status().obligations['0203'].baseline, 20);
  assert.equal(r.controller.status().obligations['0203'].confirmed, false);
  await r.controller.reconcile();
  assert.equal(r.sent.length, 1, 'An uncertain write is neither replayed nor restored before its deadline');
  r.controller.setConnected(false); r.controller.setConnected(true);
  silent = false;
  r.native['0203'] = 21; r.feed('0203'); await nextTurn();
  assert.deepEqual(r.sent.map(({ payload }) => payload), ['21', '20']);
  assert.equal(r.controller.status().readings['0203'].value, 20);
  assert.deepEqual(r.controller.status().obligations, {});
});

test('preheat and reduction restore exact original native settings, never write ROOM10', async t => {
  const r = rig(); t.after(() => r.controller.close());
  const before = r.controller.status();
  assert.equal(before.available, true);
  assert.equal(before.controlsReady, true);
  await r.controller.setPhase({ phase: 'preheat', roomBoostC: 5, expiresAt: r.now + 60_000 });
  assert.equal(r.native['0203'], 25);
  assert.deepEqual(r.controller.status().baseline, baselines);
  await r.controller.setPhase({ phase: 'reduction', expiresAt: r.now + 120_000 });
  assert.deepEqual(r.sent.map(item => [item.index, item.payload]), [
    ['0203', '25'], ['0203', '20'], ['0212', '40'], ['0208', '50'], ['2201', '2'],
  ]);
  assert.equal(r.controller.status().phase, 'reduction');
  await r.controller.setPhase({ phase: 'recovery' });
  assert.deepEqual(r.native, baselines);
  assert.deepEqual(r.controller.status().obligations, {});
  assert.ok(r.sent.every(item => item.options.qos === 0 && item.options.retain === false));
});

test('repeated preheat uses the captured baseline and is idempotent', async t => {
  const r = rig(); t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'preheat', roomBoostC: 5 });
  await r.controller.setPhase({ phase: 'preheat', roomBoostC: 5 });
  assert.equal(r.sent.length, 1);
  await r.controller.setPhase({ phase: 'preheat', roomBoostC: 4 });
  assert.equal(r.native['0203'], 24);
  assert.equal(r.controller.status().baseline['0203'], 20);
});

test('a native compressor-only baseline supports heating cycles and restores mode2 exactly', async t => {
  const r = rig({ values: { ...baselines, '2201': 2 } }); t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'preheat', roomBoostC: 5 });
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
  assert.deepEqual(r.controller.status().readings['0203'].unavailableReasons, ['awaiting-live-report']);
  r.feed('0007', 5);
  assert.equal(r.controller.status().brokerConnected, true);
  assert.deepEqual(r.controller.status().readings['0007'].unavailableReasons, []);
  await assert.rejects(r.controller.setPhase({ phase: 'preheat' }), { code: 'H66_BASELINE_UNAVAILABLE' });
  assert.equal(r.sent.length, 0);
});

test('wire scale overrides are applied symmetrically', async t => {
  const r = rig({ values: { ...baselines, '0203': 200 }, settings: { mqttScaleByRegister: { '0203': 0.1 } } });
  t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'preheat', roomBoostC: 5 });
  assert.equal(r.sent[0].payload, '250');
  assert.equal(r.controller.status().readings['0203'].value, 25);
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
  await acquisition.setPhase({ phase: 'preheat', roomBoostC: 5 });
  assert.equal(connectionCount, 1);
  assert.equal(native['0203'], 25);
  await acquisition.restore();
  assert.equal(native['0203'], 20);
  now += 300_001;
  assert.equal(acquisition.status().available, false);
  assert.ok(publications.some(item => item.payload === 'GETALL'));
});


for (const baseline of [25, 27, 33, 35]) test(`five-degree preheat respects a ${baseline} °C baseline and the device maximum`, async t => {
  const r = rig({ values: { ...baselines, '0203': baseline } }); t.after(() => r.controller.close());
  const target = Math.min(35, baseline + 5);
  const result = await r.controller.setPhase({ phase: 'preheat', roomBoostC: 5 });
  assert.equal(r.native['0203'], target);
  assert.equal(result.roomBoostC, target - baseline);
  await r.controller.restore();
  await r.controller.setManualPreheat({ enabled: true, roomBoostC: 5 });
  assert.equal(r.native['0203'], target);
  await r.controller.setManualPreheat({ enabled: true, roomBoostC: 5 });
  assert.equal(r.native['0203'], target, 'Renewal retains the original baseline');
  await r.controller.setManualPreheat({ enabled: false });
  assert.equal(r.native['0203'], baseline);
});
