import test from 'node:test';
import assert from 'node:assert/strict';
import { createFloorOverride, floorOverrideConfiguration, FLOOR_MQTT_TOPICS } from '../src/control/floor-override.js';
import { FLOOR_PREHEAT_SIGNALS } from '../src/domain/floor-circuits.js';
import { SIGNAL_INFO, RECORDED_EVIDENCE_SIGNALS } from '../src/domain/history-series.js';
import { recordedSignalInfo, recordingPolicy } from '../src/domain/recording-policy.js';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';

test('unconfigured floor circuits create no GPIO observations from connection state or retired readback', async t => {
  const store = new Store(':memory:'), recorder = new Recorder(store);
  t.after(() => store.close());
  const adapter = createFloorOverride({ store, publish: () => assert.fail('An unconfigured controller cannot publish'),
    onObservation: observation => recorder.record(observation) });
  adapter.setConnected(true);
  adapter.ingest('fixture-floor/stmq/floor/status', JSON.stringify({ protocol: 'stmq-floor-v1',
    ready: true, clockOk: true, boot: 1, channels: [0, 1].map(id => ({ id, output: false })) }));
  await adapter.tick();
  await adapter.release();
  adapter.setConnected(false);
  await adapter.close();
  for (const signal of FLOOR_PREHEAT_SIGNALS) assert.deepEqual(store.observations({ signal }), []);
});

test('native floor GPIO changes survive the real recorder with explicit receipt clocks and unknown gaps', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let wall = Date.parse('2026-10-15T12:00:00Z'), mono = 1000;
  const recorder = new Recorder(store, { clock: () => wall });
  const frame = { v: 1, build: 'sonoff4chpro-lease-v1', sketch_md5: 'd'.repeat(32), kind: 'reply',
    id: '', op: 'get', accepted: true, duplicate: false, code: 'ok', device: '02:00:00:00:00:01',
    generation: 'a'.repeat(32), connected: true, active: false, mask: 0, gpio_mask: 0, gpio_match: true,
    state_evidence: 'gpio_output_readback', board_ok: true, now_ms: mono, lease_until_ms: 0,
    end_ms: 0, owner: '', treatment: 0, seq: 0, highwater: 0, reason: 'connected', max_lease_ms: 900000 };
  let adapter, failPoll = false;
  adapter = createFloorOverride({ store,
    settings: floorOverrideConfiguration({ device_mac: frame.device }), clock: () => wall, monotonicClock: () => mono,
    onObservation: observation => recorder.record(observation),
    publish: async (_topic, payload, options) => {
      const request = JSON.parse(payload); assert.equal(request.op, 'get'); options.beforePublish();
      if (failPoll) throw new Error('synthetic monitoring failure');
      store.transaction(() => adapter.ingest(FLOOR_MQTT_TOPICS.state,
        JSON.stringify({ ...frame, id: request.id, op: request.op }), {}, wall, mono));
    } });
  t.after(() => adapter.close({ restore: false }));
  adapter.setConnected(true); await adapter.tick();
  for (const mask of [1, 3, 0]) {
    mono++;
    Object.assign(frame, { kind: 'state', id: '', op: 'state', now_ms: mono, mask, gpio_mask: mask,
      active: mask !== 0, owner: 'synthetic-owner', treatment: 1, seq: mono, highwater: 1,
      lease_until_ms: mask ? 61000 : 0, end_ms: 61000, reason: mask ? 'renewed' : 'released' });
    store.transaction(() => adapter.ingest(FLOOR_MQTT_TOPICS.state, JSON.stringify(frame), {}, wall, mono));
  }
  const one = store.observations({ signal: FLOOR_PREHEAT_SIGNALS[0] }).filter(row => row.value !== null);
  // A shortened evidence lifetime may retain an unchanged value as a policy
  // boundary. All actual transitions must still survive in order.
  const transitions = rows => rows.filter((row, index) => !index || row.value !== rows[index - 1].value).map(row => row.value);
  assert.deepEqual(transitions(one), [0, 1, 0]);
  assert(one.every(row => !row.quality.includes('unavailable') && row.sourceTime === wall && row.receivedAt === wall));
  assert(one.every(row => row.raw.timeBasis === 'mqtt-received'));
  assert(one.every(row => row.raw.evidence === 'gpio_output_readback'
    && row.raw.generation === frame.generation && Number.isSafeInteger(row.raw.deviceMonotonicMs)));
  assert(one.every(row => row.raw.reportIntervalMs > 0 && row.raw.reportIntervalMs <= 90_000 && row.raw.reportGraceMs === 0));
  const two = store.observations({ signal: FLOOR_PREHEAT_SIGNALS[1] }).filter(row => row.value !== null);
  assert.deepEqual(transitions(two), [0, 1, 0]);
  const admittedAt = wall;
  failPoll = true; wall += 30000; mono += 30000; await adapter.tick();
  for (const signal of FLOOR_PREHEAT_SIGNALS) {
    const row = recorder.status(wall).exactParameters.find(row => row.signal === signal);
    assert.equal(row.freshness.status, 'fresh');
    assert.equal(row.freshness.sourceObservedAt, admittedAt);
    assert.equal(row.lastPollAt, admittedAt);
    assert.equal(store.observations({ signal }).at(-1).value, 0);
  }
  wall += 1000; mono += 1000;
  adapter.setConnected(false); await store.whenWritesSettled?.();
  for (const signal of FLOOR_PREHEAT_SIGNALS) {
    const rows = store.observations({ signal });
    assert.equal(rows.at(-1).value, null);
    assert(rows.at(-1).quality.includes('floor-mqtt-disconnected'));
  }
});

test('four circuit histories have new identities and describe pipe length separately from physical feedback', () => {
  assert.deepEqual(FLOOR_PREHEAT_SIGNALS, [1, 2, 3, 4].map(id => `floor_groundfloor_${id}_active`));
  const labels = ['Living 106 m', 'Living 62 m', 'Storage 38 m', 'Storage 80 m'];
  FLOOR_PREHEAT_SIGNALS.forEach((signal, index) => {
    assert(RECORDED_EVIDENCE_SIGNALS.includes(signal));
    assert.equal(recordedSignalInfo(signal).label, `${labels[index]} · floor circuit ${index + 1}`);
    assert.match(recordedSignalInfo(signal).basis, /does not prove valve position or water flow/);
    assert.equal(recordingPolicy({ signal, unit: 'state' }).id, 'change-only');
  });
  for (const group of ['storage', 'living']) for (const id of [0, 1]) {
    const signal = `floor_${group}_${id}_active`;
    assert.equal(Object.hasOwn(SIGNAL_INFO, signal), false, 'No alias reinterprets retired output history as SONOFF feedback');
    assert.equal(RECORDED_EVIDENCE_SIGNALS.includes(signal), false);
  }
});
