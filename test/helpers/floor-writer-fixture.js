import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/storage/store.js';
import { Recorder } from '../../src/storage/recorder.js';
import { Engine } from '../../src/app/engine.js';
import { recordLearningContext } from '../../src/app/committed-learning.js';
import { createFloorOverride, floorOverrideConfiguration, FLOOR_MQTT_TOPICS } from '../../src/control/floor-override.js';

export const FLOOR_KEY = 'floor-override:v1';
const DEVICE = '02:00:00:00:00:01', GENERATION = 'a'.repeat(32);
const TOKEN = 'b'.repeat(32), CHALLENGE = 'c'.repeat(32);

// Only the native transport is synthetic. Store admission/worker transactions,
// the floor adapter, Recorder and immutable learning-context producer are real.
export async function floorWriterFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-floor-writer-'));
  const path = join(directory, 'history.sqlite');
  const clock = { wall: Date.parse('2026-10-15T12:00:00Z'), mono: 10_000 };
  const native = { active: false, mask: 0, gpio_mask: 0, owner: '', treatment: 0,
    seq: 0, highwater: 0, lease_until_ms: 0, end_ms: 0, reason: 'connected' };
  const wire = [], acquireRows = [], gates = new Set(), flights = new Set();
  let store, reader, adapter, authority = true, closing = false;

  const track = promise => {
    flights.add(promise);
    promise.then(() => flights.delete(promise), () => flights.delete(promise));
    return promise;
  };
  const committedState = () => {
    const row = reader.prepare('SELECT value FROM state WHERE key=?').get(FLOOR_KEY);
    return row ? JSON.parse(row.value) : null;
  };
  const contexts = () => reader.prepare("SELECT payload FROM learning_journal_entries WHERE kind='context' ORDER BY id")
    .all().map(row => JSON.parse(row.payload).value.controlContext);
  const outputs = () => reader.prepare("SELECT id,signal,value FROM observations WHERE source='sonoff-floor' ORDER BY id").all();
  const frame = extra => ({ v: 1, build: 'sonoff4chpro-lease-v1', sketch_md5: 'd'.repeat(32),
    kind: 'reply', id: '', op: 'get', accepted: true, duplicate: false, code: 'ok',
    device: DEVICE, generation: GENERATION, connected: true, gpio_match: true,
    state_evidence: 'gpio_output_readback', board_ok: true, now_ms: clock.mono,
    max_lease_ms: 900000, ...native, ...extra });
  const ingest = value => track(store.runWrite(() => adapter.ingest(FLOOR_MQTT_TOPICS.state,
    JSON.stringify(value), { retain: false, dup: false }, clock.wall, clock.mono)));

  async function send(_topic, payload, options) {
    // These callbacks represent the transport's pre-publication and last-write
    // boundaries. This fixture does not claim to exercise MQTT.js socket writes.
    options.beforePublish(); options.beforeWrite();
    const body = JSON.parse(payload);
    wire.push(structuredClone(body));
    if (body.op === 'acquire') {
      // A separate read-only SQLite connection cannot see an uncommitted
      // obligation or a Store RAM/cache value.
      const row = committedState();
      assert.equal(row?.outstanding?.phase, 'acquiring');
      assert.equal(row.outstanding.mask, body.mask);
      assert.equal(row.outstanding.generation, body.generation);
      assert.equal(row.outstanding.owner, body.owner);
      assert.equal(row.outstanding.treatment, body.treatment);
      assert.equal(row.outstanding.deviceEnd, body.end_ms);
      acquireRows.push(structuredClone(row));
    }
    if (native.active && clock.mono >= native.lease_until_ms)
      Object.assign(native, { active: false, mask: 0, gpio_mask: 0, lease_until_ms: 0, reason: 'expired' });
    if (body.op === 'acquire' || body.op === 'renew') {
      if (body.op === 'renew') assert.equal(body.token, TOKEN);
      Object.assign(native, { active: true, mask: body.mask, gpio_mask: body.mask,
        owner: body.owner, treatment: body.treatment, seq: body.seq, highwater: body.treatment,
        lease_until_ms: Math.min(clock.mono + body.ttl_ms, body.end_ms), end_ms: body.end_ms,
        reason: body.op === 'acquire' ? 'acquired' : 'renewed' });
    } else if (body.op === 'release') {
      assert.equal(body.token, TOKEN);
      assert.equal(body.owner, native.owner);
      assert.equal(body.treatment, native.treatment);
      Object.assign(native, { active: false, mask: 0, gpio_mask: 0, lease_until_ms: 0,
        seq: body.seq, reason: 'released' });
    }
    const extra = body.op === 'challenge' ? { challenge: CHALLENGE, issued_ms: clock.mono, lifetime_ms: 2000 }
      : body.op === 'acquire' ? { token: TOKEN } : {};
    await ingest(frame({ id: body.id, op: body.op, ...extra }));
  }

  async function open({ seed = false } = {}) {
    store = new Store(path);
    await store.startWriter();
    reader = new DatabaseSync(path, { readOnly: true });
    if (seed) await store.runWrite(() => recordLearningContext(store, 'mqtt', {
      phase: 'normal', regime: 'occupied', targetC: 21, roomBoostC: 0,
      floorOverrideMode: 'off', treatmentKey: 'normal', dhwrActive: false,
    }, clock.wall));
    const recorder = new Recorder(store);
    const engine = { store, config: { input: 'mqtt' }, control: {}, checkpoint: null,
      clock: () => clock.wall };
    adapter = createFloorOverride({ store,
      settings: floorOverrideConfiguration({ device_mac: DEVICE, commissioned: true, enabled: true }),
      brokerIdentity: { address: 'mqtt://fixture.invalid', user: 'fixture-user' },
      canControl: () => authority, clock: () => clock.wall, monotonicClock: () => clock.mono,
      onObservation: value => recorder.record(value),
      onLearningMode: change => Engine.prototype.recordFloorLearningMode.call(engine, change),
      publish: send });
    adapter.setConnected(true);
    await adapter.tick();
  }
  async function closeHost() {
    authority = false;
    await adapter?.close({ restore: false });
    await Promise.allSettled([...flights]);
    reader?.close(); reader = null;
    await store?.close(); store = null;
  }
  t.after(async () => {
    closing = true;
    for (const gate of gates) gate.release();
    try { await closeHost(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  await open({ seed: true });

  function holdCommit({ obligation = false, fail = false } = {}) {
    const currentStore = store, request = store.writer.request.bind(store.writer);
    const setState = store.setState.bind(store);
    let matched = !obligation, used = false, enter, release;
    const ready = new Promise(resolve => { enter = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    if (obligation) store.setState = (key, value, ...args) => {
      const result = setState(key, value, ...args);
      if (key === FLOOR_KEY && value.outstanding?.phase === 'acquiring') matched = true;
      return result;
    };
    store.writer.request = async (name, ...args) => {
      if (name === 'commit' && matched && !used) {
        used = true; enter(); await barrier;
        if (fail && !closing) throw Object.assign(new Error('synthetic rejected commit'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
      }
      return request(name, ...args);
    };
    const gate = { ready, release, get writerHeld() { return used && currentStore.writePending; } };
    gates.add(gate);
    return gate;
  }

  return {
    get store() { return store; }, get adapter() { return adapter; }, wire, acquireRows,
    get nativeMask() { return native.gpio_mask; }, get now() { return clock.wall; },
    advance(ms) { clock.wall += ms; clock.mono += ms; },
    committedState, contexts, outputs, holdCommit,
    manual(channel, enabled, requestId, durationSeconds = 900) {
      return track(adapter.manual({ channel, enabled, requestId, durationSeconds, scope: adapter.status().commandScope }));
    },
    async externalOn() {
      clock.wall++; clock.mono++;
      Object.assign(native, { active: true, mask: 1, gpio_mask: 1, owner: 'fixture-external',
        treatment: 1, highwater: 1, seq: 1, lease_until_ms: clock.mono + 60000,
        end_ms: clock.mono + 60000, reason: 'acquired' });
      return ingest(frame({ kind: 'state', id: '', op: 'state' }));
    },
    settle: () => store.runWrite(() => {}),
    async restart() {
      for (const gate of gates) gate.release();
      await closeHost();
      authority = true;
      await open();
    },
  };
}
