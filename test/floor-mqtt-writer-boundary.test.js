import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mqtt from 'mqtt';
import mqttPacket from 'mqtt-packet';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { floorOverrideConfiguration, FLOOR_MQTT_TOPICS } from '../src/control/floor-override.js';

const KEY = 'floor-override:v1', DEVICE = '02:00:00:00:00:01';
const GENERATION = 'a'.repeat(32), TOKEN = 'b'.repeat(32), CHALLENGE = 'c'.repeat(32);
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const end = performance.now() + 3000;
  while (!predicate()) {
    assert(performance.now() < end, 'The isolated MQTT/writer boundary did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-floor-mqtt-writer-'));
  const store = new Store(join(directory, 'history.sqlite'));
  let authority = true, acquisition, client, stream, readOnly, bytes = 0;
  const clock = { wall: Date.parse('2026-10-15T12:00:00Z'), mono: 10000 };
  const wire = [], held = [], commitGates = [], actions = new Set();
  const native = { active: false, mask: 0, gpio_mask: 0, owner: '', treatment: 0,
    seq: 0, highwater: 0, lease_until_ms: 0, end_ms: 0, reason: 'connected' };
  const frame = extra => ({ v: 1, build: 'sonoff4chpro-lease-v1', sketch_md5: 'd'.repeat(32),
    kind: 'reply', id: '', op: 'get', accepted: true, duplicate: false, code: 'ok',
    device: DEVICE, generation: GENERATION, connected: true, gpio_match: true,
    state_evidence: 'gpio_output_readback', board_ok: true, now_ms: clock.mono,
    max_lease_ms: 900000, ...native, ...extra });
  const incoming = value => stream.push(mqttPacket.generate({ cmd: 'publish', qos: 0,
    retain: false, dup: false, topic: FLOOR_MQTT_TOPICS.state, payload: JSON.stringify(value) }));
  const outgoing = new mqtt.Store(), put = outgoing.put.bind(outgoing);
  outgoing.put = (packet, callback) => put(packet, error => {
    const body = packet.cmd === 'publish' && packet.topic === FLOOR_MQTT_TOPICS.command
      ? JSON.parse(String(packet.payload)) : null;
    if (body?.op === 'acquire') held.push(() => callback(error));
    else callback(error);
  });
  const releaseOutgoing = () => { for (const callback of held.splice(0)) callback(); };
  t.after(async () => {
    authority = false;
    acquisition?.revoke();
    for (const gate of commitGates) gate.release();
    releaseOutgoing();
    try {
      await Promise.allSettled([...actions]);
      await acquisition?.close({ restore: false });
      if (!acquisition && client) await client.endAsync(true);
    } finally {
      readOnly?.close();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await store.startWriter();
  readOnly = new DatabaseSync(store.path, { readOnly: true });
  const recorder = new Recorder(store), observed = [];
  const engine = { clock: () => clock.wall, ingest: observation => {
    observed.push(observation);
    return recorder.record(observation);
  } };
  acquisition = await startMqtt({ store, engine, canControl: () => authority,
    monotonicClock: () => clock.mono, reportStorageFailure: () => {},
    config: { input: 'mqtt', h66: { readbackTimeoutMs: 3000 },
      floorPreheat: floorOverrideConfiguration({ device_mac: DEVICE, commissioned: true, enabled: true }),
      connections: { mqtt: { address: 'mqtt://fixture.invalid' } } },
    connect: (_address, options) => {
      client = new mqtt.MqttClient(() => {
        const parser = mqttPacket.parser();
        stream = new Duplex({ read() {}, write(chunk, _encoding, callback) {
          bytes += chunk.length;
          parser.parse(chunk);
          callback();
        } });
        parser.on('packet', packet => {
          const respond = value => queueMicrotask(() => stream.push(mqttPacket.generate(value)));
          if (packet.cmd === 'connect') respond({ cmd: 'connack', returnCode: 0, sessionPresent: false });
          if (packet.cmd === 'subscribe') respond({ cmd: 'suback', messageId: packet.messageId,
            granted: packet.subscriptions.map(row => row.qos) });
          if (packet.cmd !== 'publish') return;
          assert.equal(packet.topic, FLOOR_MQTT_TOPICS.command);
          const body = JSON.parse(String(packet.payload));
          wire.push(body);
          if (packet.qos === 1) respond({ cmd: 'puback', messageId: packet.messageId });
          if (body.op === 'acquire' || body.op === 'renew') Object.assign(native, {
            active: true, mask: body.mask, gpio_mask: body.mask, owner: body.owner,
            treatment: body.treatment, seq: body.seq, highwater: body.treatment,
            lease_until_ms: Math.min(clock.mono + body.ttl_ms, body.end_ms),
            end_ms: body.end_ms, reason: body.op === 'acquire' ? 'acquired' : 'renewed',
          });
          if (body.op === 'release') Object.assign(native, { active: false, mask: 0,
            gpio_mask: 0, seq: body.seq, lease_until_ms: 0, reason: 'released' });
          const extra = body.op === 'challenge' ? { challenge: CHALLENGE, issued_ms: clock.mono, lifetime_ms: 2000 }
            : body.op === 'acquire' ? { token: TOKEN } : {};
          queueMicrotask(() => incoming(frame({ id: body.id, op: body.op, ...extra })));
        });
        return stream;
      }, { ...options, reconnectPeriod: 0, keepalive: 0, outgoingStore: outgoing });
      client.on('error', () => {});
      return client;
    } });
  await acquisition.ready();
  await until(() => acquisition.floorOverride.status().manualAvailable && store.canDispatch());
  await store.whenWritesSettled();
  const state = () => {
    const row = readOnly.prepare('SELECT value FROM state WHERE key=?').get(KEY);
    return row ? JSON.parse(row.value) : null;
  };
  const lastRecordedAt = () => readOnly.prepare("SELECT MAX(received_at) AS at FROM observations WHERE source='sonoff-floor'").get().at;
  return { store, acquisition, wire, held, releaseOutgoing, state, lastRecordedAt,
    get byteCount() { return bytes; }, get observations() { return observed.length; },
    get nativeMask() { return native.gpio_mask; },
    pendingOutgoing: () => outgoing._inflights.size,
    manual(id) {
      const promise = acquisition.floorOverride.manual({ channel: 1, enabled: true, requestId: id,
        scope: acquisition.floorOverride.status().commandScope }).then(value => ({ value }), error => ({ error }));
      actions.add(promise);
      promise.then(() => actions.delete(promise));
      return promise;
    },
    holdNextCommit() {
      const request = store.writer.request.bind(store.writer);
      let entered = false, release;
      const barrier = new Promise(resolve => { release = resolve; });
      store.writer.request = async (name, ...args) => {
        if (name === 'commit' && !entered) { entered = true; await barrier; }
        return request(name, ...args);
      };
      const gate = { get entered() { return entered; }, release };
      commitGates.push(gate);
      return gate;
    },
    reportCurrentOff() {
      clock.wall++; clock.mono++;
      incoming(frame({ kind: 'state', id: '', op: 'state' }));
    },
  };
}

test('actual acquisition and installed MQTT dispatch a committed floor lease after outgoing storage releases', async t => {
  const f = await fixture(t), action = f.manual('mqtt-writer-control');
  await until(() => f.held.length === 1);
  assert.equal(f.state().outstanding.phase, 'acquiring', 'The obligation is independently visible before transport admission');
  assert.equal(f.store.canDispatch(), true);
  assert.equal(f.wire.some(row => row.op === 'acquire'), false);
  const beforeBytes = f.byteCount;
  f.releaseOutgoing();
  const result = await action;
  assert.equal(result.error, undefined);
  assert(f.byteCount > beforeBytes);
  assert.equal(f.wire.filter(row => row.op === 'acquire').length, 1);
  assert.equal(f.state().outstanding.phase, 'active');
  assert.equal(f.nativeMask, 1);
});

test('new floor ingress awaiting real writer COMMIT cancels delayed MQTT activation before its first byte', async t => {
  const f = await fixture(t), action = f.manual('mqtt-writer-pending-input');
  await until(() => f.held.length === 1);
  assert.equal(f.state().outstanding.phase, 'acquiring');
  const before = { recordedAt: f.lastRecordedAt(), observed: f.observations,
    floorAt: f.acquisition.floorOverride.status().devices[0].at };
  const commit = f.holdNextCommit();
  f.reportCurrentOff();
  await until(() => commit.entered);
  assert.equal(f.store.canDispatch(), false, 'A real received floor report is not committed');
  assert(f.observations >= before.observed + 4, 'The real acquisition handler reached the Recorder');
  assert.equal(f.lastRecordedAt(), before.recordedAt, 'The independent reader cannot observe provisional input');
  assert.equal(f.acquisition.floorOverride.status().devices[0].available, true,
    'Committed device evidence alone still looks healthy while newer input is pending');
  assert.equal(f.acquisition.floorOverride.status().devices[0].at, before.floorAt);
  const beforeBytes = f.byteCount;
  f.releaseOutgoing();
  await flush(); await flush();
  assert.equal(f.byteCount, beforeBytes, 'Pending ingress must be rechecked before any MQTT command byte');
  assert.equal(f.wire.some(row => row.op === 'acquire' || row.op === 'renew'), false);
  assert.equal(f.nativeMask, 0);
  commit.release();
  const result = await action;
  assert(result.error instanceof Error, 'This attempt is cancelled, rather than replayed when storage recovers');
  await f.store.runWrite(() => {});
  await flush();
  assert.equal(f.wire.some(row => row.op === 'acquire' || row.op === 'renew'), false);
  assert.equal(f.pendingOutgoing(), 0);
  assert.equal(f.nativeMask, 0);
});
