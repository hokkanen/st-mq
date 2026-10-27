import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mqtt from 'mqtt';
import mqttPacket from 'mqtt-packet';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { floorOverrideConfiguration, FLOOR_MQTT_TOPICS } from '../src/control/floor-override.js';

const KEY = 'floor-override:v1', DEVICE = '02:00:00:00:00:01';
const GENERATION = 'a'.repeat(32), TOKEN = 'b'.repeat(32), CHALLENGE = 'c'.repeat(32);
const flush = () => new Promise(resolve => setImmediate(resolve));
async function waitUntil(predicate, signal) {
  while (!predicate()) await delay(5, undefined, { signal });
}

async function fixture(t, { deferAcquireReply = false } = {}) {
  // Completion of received MQTT/writer work belongs to the case deadline, not
  // an independent three-second poll. Native request/lease timers stay real.
  const until = predicate => waitUntil(predicate, t.signal);
  const directory = mkdtempSync(join(tmpdir(), 'stmq-floor-mqtt-writer-'));
  const store = new Store(join(directory, 'history.sqlite'));
  let authority = true, acquisition, client, stream, readOnly, acquireSignal, bytes = 0;
  let expectedIngress = 0, receivedIngress = 0;
  const clock = { wall: Date.parse('2026-10-15T12:00:00Z'), mono: 10000 };
  const wire = [], held = [], acquireReplies = [], heldAcquireBodies = [], commitGates = [], actions = new Set();
  const native = { active: false, mask: 0, gpio_mask: 0, owner: '', treatment: 0,
    seq: 0, highwater: 0, lease_until_ms: 0, end_ms: 0, reason: 'connected' };
  const frame = extra => ({ v: 1, build: 'sonoff4chpro-lease-v1', sketch_md5: 'd'.repeat(32),
    kind: 'reply', id: '', op: 'get', accepted: true, duplicate: false, code: 'ok',
    device: DEVICE, generation: GENERATION, connected: true, gpio_match: true,
    state_evidence: 'gpio_output_readback', board_ok: true, now_ms: clock.mono,
    max_lease_ms: 900000, ...native, ...extra });
  const incoming = (value, packet = {}) => {
    expectedIngress++;
    return stream.push(mqttPacket.generate({ cmd: 'publish', qos: 0,
      retain: false, dup: false, ...packet, topic: FLOOR_MQTT_TOPICS.state, payload: JSON.stringify(value) }));
  };
  const outgoing = new mqtt.Store(), put = outgoing.put.bind(outgoing);
  outgoing.put = (packet, callback) => put(packet, error => {
    const body = packet.cmd === 'publish' && packet.topic === FLOOR_MQTT_TOPICS.command
      ? JSON.parse(String(packet.payload)) : null;
    if (body?.op === 'acquire') { heldAcquireBodies.push(body); held.push(() => callback(error)); }
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
          if (native.active && clock.mono >= native.lease_until_ms) Object.assign(native, {
            active: false, mask: 0, gpio_mask: 0, lease_until_ms: 0, reason: 'expired' });
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
          const response = frame({ id: body.id, op: body.op, ...extra });
          if (body.op === 'acquire' && deferAcquireReply) acquireReplies.push(response);
          else queueMicrotask(() => incoming(response));
        });
        return stream;
      }, { ...options, reconnectPeriod: 0, keepalive: 0, outgoingStore: outgoing });
      client.on('error', () => {});
      client.on('message', topic => { if (topic === FLOOR_MQTT_TOPICS.state) receivedIngress++; });
      return client;
    } });
  const publish = client.publish;
  client.publish = function(...args) {
    if (args[0] === FLOOR_MQTT_TOPICS.command && JSON.parse(String(args[1])).op === 'acquire')
      acquireSignal = args[2]?.signal;
    return publish.apply(this, args);
  };
  await acquisition.ready();
  await until(() => acquisition.floorOverride.status().manualAvailable && store.canDispatch());
  await store.whenWritesSettled();
  const state = () => {
    const row = readOnly.prepare('SELECT value FROM state WHERE key=?').get(KEY);
    return row ? JSON.parse(row.value) : null;
  };
  const lastRecordedAt = () => readOnly.prepare("SELECT MAX(received_at) AS at FROM observations WHERE source='sonoff-floor'").get().at;
  return { store, acquisition, wire, held, acquireReplies, releaseOutgoing, state, lastRecordedAt, until,
    get expectedIngress() { return expectedIngress; }, get receivedIngress() { return receivedIngress; },
    advance(ms) { clock.wall += ms; clock.mono += ms; },
    authority(value) { authority = value; },
    deliverAcquireReply(change = {}, packet) { incoming({ ...acquireReplies.at(-1), ...change }, packet); },
    primeUnsentAcquire() {
      const body = heldAcquireBodies.at(-1); assert(body);
      // Deliberately adversarial evidence: no command byte was dispatched.
      Object.assign(native, { active: true, mask: body.mask, gpio_mask: body.mask, owner: body.owner,
        treatment: body.treatment, seq: body.seq, highwater: body.treatment, end_ms: body.end_ms,
        lease_until_ms: body.end_ms, reason: 'acquired' });
      acquireReplies.push(frame({ id: body.id, op: 'acquire', token: TOKEN }));
    },
    get byteCount() { return bytes; }, get observations() { return observed.length; },
    get nativeMask() { return native.gpio_mask; },
    get acquireCancelled() { return acquireSignal?.aborted === true; },
    pendingOutgoing: () => outgoing._inflights.size,
    manual(id, channel = 1) {
      const promise = acquisition.floorOverride.manual({ channel, enabled: true, requestId: id,
        scope: acquisition.floorOverride.status().commandScope }).then(value => ({ value }), error => ({ error }));
      actions.add(promise);
      promise.then(() => actions.delete(promise));
      return promise;
    },
    holdNextCommit({ fail = false } = {}) {
      const request = store.writer.request.bind(store.writer);
      let entered = false, release;
      const barrier = new Promise(resolve => { release = resolve; });
      store.writer.request = async (name, ...args) => {
        if (name === 'commit' && !entered) {
          entered = true; await barrier;
          if (fail) throw Object.assign(new Error('Synthetic rejected ingress COMMIT'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
        }
        return request(name, ...args);
      };
      const gate = { get entered() { return entered; }, release };
      commitGates.push(gate);
      return gate;
    },
    reportCurrentState() {
      clock.wall++; clock.mono++;
      incoming(frame({ kind: 'state', id: '', op: 'state' }));
    },
  };
}

test('routine floor readback retains time for a missed poll despite minor timer jitter', async t => {
  const interval = globalThis.setInterval, clear = globalThis.clearInterval;
  let maintenance;
  t.mock.method(globalThis, 'setInterval', (callback, period, ...args) => {
    if (!callback.toString().includes('floorOverride.tick')) return interval(callback, period, ...args);
    maintenance = { callback, period, handle: { unref() {} } };
    return maintenance.handle;
  });
  t.mock.method(globalThis, 'clearInterval', handle => handle === maintenance?.handle ? undefined : clear(handle));
  const f = await fixture(t), receipts = [0];
  assert(maintenance, 'Exercise the installed MQTT maintenance callback');
  let elapsed = 0, queries = f.wire.filter(row => row.op === 'get').length;
  for (let at = maintenance.period, turn = 1; at <= 180_000; at += maintenance.period, turn++) {
    const next = at + turn % 2;
    f.advance(next - elapsed); elapsed = next;
    maintenance.callback(); await flush();
    await f.until(() => !f.acquisition.floorOverride.status().busy
      && f.store.canDispatch() && f.store.writeQueueStatus().pending === 0);
    const current = f.wire.filter(row => row.op === 'get').length;
    if (current > queries) { receipts.push(elapsed); queries = current; }
  }
  const gaps = receipts.slice(1).map((at, index) => at - receipts[index]);
  t.diagnostic(JSON.stringify({ polls: receipts.length, maximumGapMs: Math.max(...gaps) }));
  assert(gaps.length >= 3);
  assert(gaps.every(ms => ms >= 30_000), 'The native polling interval still bounds request frequency');
  assert(gaps.every(ms => ms < 45_000), 'Leave another poll before the original 90-second evidence deadline');
  assert(f.wire.every(row => row.op === 'get'), 'Routine monitoring sends no lease mutation');
});

test('actual acquisition and installed MQTT dispatch a committed floor lease after outgoing storage releases', async t => {
  const f = await fixture(t), action = f.manual('mqtt-writer-control');
  await f.until(() => f.held.length === 1);
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
  assert.equal(f.store.writeHealth.status().history.windows.day.commandsNotSent, 0, 'Queries and a dispatched confirmed lease add no known-unsent commands');
});

test('new floor ingress awaiting real writer COMMIT cancels delayed MQTT activation before its first byte', async t => {
  const f = await fixture(t), action = f.manual('mqtt-writer-pending-input');
  await f.until(() => f.held.length === 1);
  assert.equal(f.state().outstanding.phase, 'acquiring');
  const before = { recordedAt: f.lastRecordedAt(), observed: f.observations,
    floorAt: f.acquisition.floorOverride.status().devices[0].at };
  const commit = f.holdNextCommit();
  f.reportCurrentState();
  await f.until(() => commit.entered);
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
  assert.equal(f.store.writeHealth.status().history.windows.day.commandsByContext['floor-control'], 1, 'A recording veto before first wire bytes is one known unsent floor command');
  commit.release();
  const result = await action;
  assert(result.error instanceof Error, 'This attempt is cancelled, rather than replayed when storage recovers');
  await f.store.runWrite(() => {});
  await flush();
  assert.equal(f.wire.some(row => row.op === 'acquire' || row.op === 'renew'), false);
  assert.equal(f.pendingOutgoing(), 0);
  assert.equal(f.nativeMask, 0);
});

async function timedOutAcquire(t, { unsent = false } = {}) {
  const f = await fixture(t, { deferAcquireReply: true }), action = f.manual('late-acquire');
  await f.until(() => f.held.length === 1);
  const original = structuredClone(f.state().outstanding);
  assert.equal(original.phase, 'acquiring');
  if (unsent) f.primeUnsentAcquire();
  else {
    f.releaseOutgoing();
    await f.until(() => f.acquireReplies.length === 1);
    assert.equal(f.wire.filter(row => row.op === 'acquire').length, 1);
  }
  f.advance(1801);
  const result = await action;
  assert.equal(result.error?.code, 'FLOOR_UNCONFIRMED');
  assert.equal(f.state().lastRequest.status, 'failed');
  assert.equal(f.state().lastRequest.confirmed, false);
  assert.equal(f.state().outstanding.until, original.until);
  assert.equal(f.nativeMask, 1);
  return { f, original };
}

async function settledInput(f) {
  // Stream parsing can arrive after an event-loop turn. A rejected ingress can
  // also queue its diagnostic after the current transaction has settled. Wait
  // for actual receipt and the entire writer queue, including that follow-up.
  await f.until(() => f.receivedIngress === f.expectedIngress
    && f.store.writeQueueStatus().pending === 0 && !f.store.writeQueue.running && !f.store.writePending);
}

test('a late acquire capability commits through real acquisition only for fresh-readback release', async t => {
  const { f, original } = await timedOutAcquire(t);
  const before = { observed: f.observations, floorAt: f.acquisition.floorOverride.status().devices[0].at,
    saved: structuredClone(f.state()), wire: f.wire.length };
  const commit = f.holdNextCommit();
  f.deliverAcquireReply();
  await f.until(() => commit.entered);
  assert.equal(f.store.canDispatch(), false);
  assert.deepEqual(f.state(), before.saved, 'The independent reader retains the failed obligation');
  assert.equal(f.wire.length, before.wire);
  commit.release();
  await settledInput(f);
  assert.equal(f.observations, before.observed, 'The late reply creates no fresh measurement');
  assert.equal(f.acquisition.floorOverride.status().devices[0].at, before.floorAt);
  assert.deepEqual(f.state(), before.saved, 'A release capability cannot promote the saved activation');
  const releaseAt = f.wire.length;
  const released = await f.acquisition.floorOverride.release();
  assert.equal(released.released, true);
  assert.deepEqual(f.wire.slice(releaseAt).map(row => row.op), ['get', 'release']);
  assert.equal(f.nativeMask, 0);
  assert.equal(f.state().outstanding, null);
  assert(f.state().retired.some(row => row.key === original.key && row.until === original.until));
  assert.equal(f.state().lastRequest.status, 'failed', 'Late restoration does not rewrite the action outcome');
});

test('timely acquire ingress whose real COMMIT outlives the request can still release safely', async t => {
  const f = await fixture(t, { deferAcquireReply: true }), action = f.manual('commit-delayed-acquire');
  await f.until(() => f.held.length === 1);
  f.releaseOutgoing();
  await f.until(() => f.acquireReplies.length === 1);
  const original = structuredClone(f.state().outstanding), beforeBytes = f.byteCount;
  const commit = f.holdNextCommit();
  f.deliverAcquireReply();
  await f.until(() => commit.entered);
  assert.equal(f.state().outstanding.phase, 'acquiring');
  assert.equal(f.store.canDispatch(), false);
  // Observe the unchanged real 1800ms request timer. It starts restoration,
  // whose normal state write queues behind this actual ingress COMMIT.
  await f.until(() => f.acquireCancelled);
  f.advance(1801);
  assert.equal(f.byteCount, beforeBytes, 'No replacement or release bypasses the held COMMIT');
  commit.release();
  const result = await action;
  assert.equal(result.error?.code, 'FLOOR_UNCONFIRMED');
  assert.equal(f.nativeMask, 0);
  assert.equal(f.state().outstanding, null);
  assert(f.state().retired.some(row => row.key === original.key && row.until === original.until));
  assert.equal(f.state().lastRequest.status, 'failed');
  assert.equal(f.wire.filter(row => row.op === 'acquire').length, 1);
  assert.equal(f.wire.some(row => row.op === 'renew'), false);
  assert(f.wire.some(row => row.op === 'release'));
});

test('rolled-back late acquire ingress cannot supply a release capability', async t => {
  const { f } = await timedOutAcquire(t), commit = f.holdNextCommit({ fail: true });
  f.deliverAcquireReply();
  await f.until(() => commit.entered);
  commit.release();
  await settledInput(f);
  f.reportCurrentState();
  await settledInput(f);
  assert.equal(f.store.canDispatch(), true, 'Fresh committed native evidence recovers input admission');
  const release = await f.acquisition.floorOverride.release();
  assert.equal(release.released, false);
  assert.equal(f.wire.some(row => row.op === 'release'), false);
  assert.equal(f.nativeMask, 1);
  assert.notEqual(f.state().outstanding, null);
  assert.equal(f.state().lastRequest.status, 'failed');
});

test('late packets with another correlation, duty or provenance cannot authorize release', async t => {
  const { f } = await timedOutAcquire(t), original = f.acquireReplies[0];
  const invalid = [
    [{ id: 'e'.repeat(32) }], [{ device: '02:00:00:00:00:02' }], [{ generation: 'f'.repeat(32) }],
    [{ owner: 'another-owner' }], [{ treatment: original.treatment + 1 }], [{ seq: original.seq + 1 }],
    [{ mask: 2, gpio_mask: 2 }], [{ end_ms: original.end_ms + 1 }],
    [{ accepted: false, token: undefined }], [{ duplicate: true, code: 'duplicate' }],
    [{ code: 'wrong-owner' }], [{ op: 'renew', token: undefined }],
    [{}, { retain: true }], [{}, { dup: true }],
  ];
  for (const [change, packet] of invalid) {
    f.deliverAcquireReply(change, packet);
    await settledInput(f);
    const released = await f.acquisition.floorOverride.release();
    assert.equal(released.released, false);
    assert.equal(f.wire.some(row => row.op === 'release'), false);
    assert.equal(f.nativeMask, 1);
    assert.equal(f.state().lastRequest.status, 'failed');
  }
});

test('an acquire never admitted to the MQTT byte boundary has no late release authority', async t => {
  const { f } = await timedOutAcquire(t, { unsent: true });
  assert.equal(f.wire.some(row => row.op === 'acquire'), false);
  f.deliverAcquireReply();
  await settledInput(f);
  f.releaseOutgoing();
  await settledInput(f);
  const release = await f.acquisition.floorOverride.release();
  assert.equal(release.released, false);
  assert.equal(f.wire.some(row => ['acquire', 'renew', 'release'].includes(row.op)), false);
  assert.equal(f.nativeMask, 1);
});

for (const boundary of ['authority-loss', 'connection-change', 'closed']) {
  test(`late acquire COMMIT cannot cross ${boundary}`, async t => {
    const { f } = await timedOutAcquire(t), commit = f.holdNextCommit();
    f.deliverAcquireReply();
    await f.until(() => commit.entered);
    if (boundary === 'authority-loss') f.authority(false);
    if (boundary === 'connection-change') {
      f.acquisition.floorOverride.setConnected(false);
      f.acquisition.floorOverride.setConnected(true);
    }
    if (boundary === 'closed') await f.acquisition.floorOverride.close({ restore: false });
    commit.release();
    await settledInput(f);
    f.authority(true);
    const release = await f.acquisition.floorOverride.release();
    assert.equal(release.released, false);
    assert.equal(f.wire.some(row => row.op === 'release'), false);
    assert.equal(f.nativeMask, 1);
    assert.notEqual(f.state().outstanding, null);
  });
}

test('retiring the original duty prevents its old acquire reply from changing a replacement', async t => {
  const { f } = await timedOutAcquire(t);
  f.advance(900001);
  assert.equal((await f.acquisition.floorOverride.release()).released, true);
  assert.equal(f.nativeMask, 0);
  const next = f.manual('replacement-duty', 2);
  await f.until(() => f.held.length === 1);
  f.releaseOutgoing();
  await f.until(() => f.acquireReplies.length === 2);
  const old = f.acquireReplies.shift();
  f.deliverAcquireReply();
  assert.equal((await next).error, undefined);
  const replacement = structuredClone(f.state());
  const floorAt = f.acquisition.floorOverride.status().devices[0].at;
  // Deliver the original valid ACK through installed MQTT, while a newer
  // confirmed treatment owns the board. It must not become current evidence.
  f.acquireReplies.push(old);
  f.deliverAcquireReply();
  await settledInput(f);
  assert.deepEqual(f.state(), replacement);
  assert.equal(f.acquisition.floorOverride.status().devices[0].at, floorAt);
  assert.equal(f.nativeMask, 2);
  assert.equal(f.wire.filter(row => row.op === 'acquire').length, 2);
  assert.equal((await f.acquisition.floorOverride.release()).released, true);
  assert.equal(f.nativeMask, 0);
});
