import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { createH66Controller } from '../src/control/h66.js';
import { validateH66ControlState } from '../src/domain/heating-control-state.js';
import { createH66Decoder } from '../src/domain/telemetry.js';
import { startMqtt } from '../src/acquisition/mqtt.js';

const initialTime = Date.parse('2026-09-07T12:00:00Z');
const deviceId = 'fixture-h66';
const baselines = { '0203': 20, '0212': 44, '0208': 60, '2201': 1 };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('unreadable native-setting state cannot erase restoration duties or publish commands', () => {
  const unreadable = new SyntaxError('Synthetic unreadable persisted state');
  let mutations = 0;
  assert.throws(() => createH66Controller({ deviceId,
    store: { getState() { throw unreadable; }, setState() { mutations++; } },
    publish() { mutations++; },
  }), error => error === unreadable);
  assert.equal(mutations, 0);
});

test('malformed native restoration fields reject before initialization, persistence or commands', () => {
  const valid = { version: 1, phase: 'preheat', baseline: { '0203': 20 }, requested: { '0203': 25 },
    obligations: { '0203': { baseline: 20, expected: 25, previousValue: 23,
      originalAt: initialTime - 60_000, requestedAt: initialTime, requestedRevision: 1,
      confirmed: false, restoring: false } }, expiresAt: initialTime + 60_000 };
  for (const patch of [{ obligations: { '0203': null } }, { obligations: { '0203': {} } },
    { obligations: { '0203': { ...valid.obligations['0203'], previousValue: null } } },
    { requested: null }, { requested: {} }, { baseline: {} }]) {
    const saved = structuredClone({ ...valid, ...patch }), original = structuredClone(saved);
    let mutations = 0;
    assert.throws(() => createH66Controller({ deviceId, clock: () => initialTime,
      store: { getState: () => saved, setState() { mutations++; } },
      publish() { mutations++; }, requestSnapshot() { mutations++; },
    }), { code: 'H66_STATE_UNSUPPORTED' });
    assert.equal(mutations, 0);
    assert.deepEqual(saved, original);
  }
});

function memoryStore(seed = {}) {
  const states = new Map(Object.entries(seed));
  let writes = 0;
  return { events: [], get writes() { return writes; }, getState: key => structuredClone(states.get(key) ?? null),
    setState: (key, value) => {
      validateH66ControlState(value);
      const encoded = JSON.parse(JSON.stringify(value));
      validateH66ControlState(encoded);
      writes++; states.set(key, encoded);
    },
    event(type, detail, now) { this.events.push({ type, detail, now }); } };
}
function rig({ store = memoryStore(), values = baselines, settings = {}, behavior = null, startAt = initialTime, closeWriteTimeoutMs = 5000, beforePublication = null } = {}) {
  let now = startAt, elapsed = 0;
  const decoder = createH66Decoder({ deviceId, mqttScaleByRegister: settings.mqttScaleByRegister, verifiedRegisters: settings.verification });
  const sent = [], native = { ...values };
  let controller;
  const feed = (index, value = native[index], extra = {}) => controller.ingest(decoder.decode({
    topic: `${deviceId}/HP/${index}`, payload: String(value), receivedAt: now, ...extra,
  }));
  controller = createH66Controller({ deviceId, store, clock: () => now, monotonicClock: () => elapsed, closeWriteTimeoutMs,
    config: { writeEnabled: true, readbackTimeoutMs: 30, ...settings },
    publish: async (topic, payload, options) => {
      await beforePublication?.({ options, feed });
      options.beforePublish();
      const index = topic.split('/').at(-1);
      sent.push({ index, payload, options });
      const saved = store.getState(`h66:control:${deviceId}`);
      if (saved.lastManual?.scope === 'native-setting' && saved.lastManual.status === 'pending') {
        assert.equal(saved.lastManual.register, index);
        if (saved.obligations[index]) assert.notEqual(saved.obligations[index].expected, Number(payload),
          'Only a preceding temporary change can retain its restoration duty during native delivery');
      } else assert.ok(saved.obligations[index], 'restoration obligation is durable before publication');
      if (behavior && await behavior({ index, payload, sent, feed, native }) === 'silent') return;
      native[index] = Number(payload);
      queueMicrotask(() => feed(index));
    },
  });
  controller.setConnected(true);
  for (const [index, value] of Object.entries(native)) feed(index, value);
  return { controller, sent, native, feed, store, setNow: value => { now = value; }, get now() { return now; }, elapse(ms) { elapsed += ms; } };
}

test('H66 queues intent and restoration behind a real SQLite writer without blocking timers or publishing early', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-h66-contention-'));
  const path = join(directory, 'fixture.sqlite'), store = new Store(path), competitor = new DatabaseSync(path);
  const r = rig({ store });
  t.after(async () => { await r.controller.close(); competitor.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const restoring of [false, true]) {
    competitor.exec('BEGIN IMMEDIATE');
    let beats = 0;
    const heartbeat = setInterval(() => { beats++; }, 5);
    const before = r.sent.length;
    const operation = restoring ? r.controller.restore()
      : r.controller.writeSettings({ '0212': 40 }, { expiresAt: r.now + 60_000 });
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(r.sent.length, before, 'No MQTT command precedes the durable admitted intent.');
    assert.ok(beats >= 5, 'Timers continue during a lock longer than the removed 100 ms timeout.');
    if (!restoring) assert.equal(store.getState(`h66:control:${deviceId}`), null);
    else assert.equal(store.getState(`h66:control:${deviceId}`).obligations['0212'].baseline, 44);
    competitor.exec('ROLLBACK'); clearInterval(heartbeat);
    assert.equal((await operation).status, 'confirmed');
  }
  assert.deepEqual(r.sent.map(row => row.payload), ['40', '44']);
  assert.deepEqual(store.getState(`h66:control:${deviceId}`).obligations, {});
});

test('H66 rechecks expiry, connection and native evidence after asynchronous writer admission', async t => {
  for (const scenario of ['expiry', 'clock-rollback', 'reconnect', 'stale', 'panel-change', 'shutdown']) await t.test(scenario, async t => {
    const store = memoryStore();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    store.runWrite = operation => held.then(operation);
    const r = rig({ store }); t.after(() => r.controller.close());
    const operation = r.controller.writeSettings({ '0212': 40 }, { expiresAt: r.now + 1000 });
    const failed = assert.rejects(operation, { code: {
      expiry: 'H66_EXPIRED', 'clock-rollback': 'H66_EXPIRED', reconnect: 'H66_DISCONNECTED',
      stale: 'H66_UNAVAILABLE', 'panel-change': 'H66_SETTING_CHANGED', shutdown: 'H66_CLOSED',
    }[scenario] });
    await nextTurn();
    assert.deepEqual(r.sent, []);
    assert.equal(store.getState(`h66:control:${deviceId}`), null);
    if (scenario === 'expiry') r.setNow(r.now + 1000);
    if (scenario === 'clock-rollback') { r.setNow(r.now - 60_000); r.elapse(1000); }
    if (scenario === 'reconnect') { r.controller.setConnected(false); r.controller.setConnected(true); r.feed('0212', 44); }
    if (scenario === 'stale') r.setNow(r.now + 300_001);
    if (scenario === 'panel-change') r.feed('0212', 46);
    if (scenario === 'shutdown') r.controller.beginShutdown();
    if (scenario === 'elapsed-timeout') r.elapse(500);
    if (scenario === 'clock-rollback') for (const [index, value] of Object.entries(baselines)) r.feed(index, value);
    release(); await failed;
    assert.deepEqual(r.sent, [], 'A queued command cannot acquire permission from its old checks.');
    assert.deepEqual(r.controller.status().obligations, {});
  });
});

test('H66 shutdown fences queued native changes while allowing an existing override to restore', async t => {
  const r = rig(); t.after(() => r.controller.close());
  await r.controller.writeSettings({ '0212': 40 }, { expiresAt: r.now + 60_000 });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  r.store.runWrite = operation => held.then(operation);
  const pending = r.controller.writeSettings({ '0203': 24 }, { expiresAt: r.now + 60_000 });
  const rejected = assert.rejects(pending, { code: 'H66_CLOSED' });
  await nextTurn(); r.controller.beginShutdown(); release(); await rejected;
  await nextTurn(); // The retained duty may already be restoring through reconciliation.
  await r.controller.restore();
  assert.deepEqual(r.sent.map(row => [row.index, row.payload]), [['0212', '40'], ['0212', '44']]);
  assert.deepEqual(r.controller.status().obligations, {});
  await assert.rejects(r.controller.setSetting({ register: '0203', value: 23 }), { code: 'H66_CLOSED' });
});

test('H66 cancellation drains its own queued save under a held SQLite writer and preserves committed restoration', async t => {
  for (const action of ['close', 'demote', 'restore-timeout']) await t.test(action, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'stmq-h66-close-'));
    const path = join(directory, 'fixture.sqlite'), store = new Store(path), competitor = new DatabaseSync(path);
    const r = rig({ store, closeWriteTimeoutMs: 50 });
    let locked = false;
    t.after(async () => {
      if (locked) competitor.exec('ROLLBACK');
      await r.controller.close(); competitor.close(); store.close(); rmSync(directory, { recursive: true, force: true });
    });
    await r.controller.writeSettings({ '0212': 40 }, { expiresAt: r.now + 60_000 });
    const saved = store.getState(`h66:control:${deviceId}`);
    competitor.exec('BEGIN IMMEDIATE'); locked = true;
    const pending = r.controller.restore();
    const rejected = assert.rejects(pending, { code: 'STORAGE_WRITE_CANCELLED' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert(store.writeQueueStatus().pending > 0);
    if (action === 'close') await r.controller.close();
    else r.controller.beginShutdown({ restore: action === 'restore-timeout' });
    await rejected;
    assert.equal(store.writeQueueStatus().pending, 0);
    assert.deepEqual(store.getState(`h66:control:${deviceId}`), saved);
    assert.deepEqual(r.sent.map(row => row.payload), ['40']);
    competitor.exec('ROLLBACK'); locked = false;
    await store.runWrite(() => store.setState('next-runtime', { ready: true }));
    assert.equal(store.getState('next-runtime').ready, true);
  });
});

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

for (const [register, value] of [['0203', 22], ['0212', 46], ['0208', 61], ['2201', 2]])
  test(`native ${register} changes survive reconciliation and restart as the next automatic baseline`, async t => {
    const r = rig(); t.after(() => r.controller.close());
    const result = await r.controller.setSetting({ register, value });
    assert.equal(result.confirmed, true); assert.equal(result.sent, true);
    assert.equal(result.previousValue, baselines[register]); assert.equal(result.readback, value);
    assert.equal(result.scope, 'native-setting');
    assert.deepEqual(r.controller.status().obligations, {});
    assert.equal(r.controller.status().expiresAt, null);
    r.setNow(initialTime + 60_000); await r.controller.reconcile();
    assert.equal(r.native[register], value);
    await r.controller.close();
    const restarted = rig({ store: r.store, values: r.native, startAt: r.now });
    t.after(() => restarted.controller.close());
    await nextTurn(); await restarted.controller.reconcile();
    assert.deepEqual(restarted.sent, [], 'Restart reads the pump and cannot restore or replay native selections');
    await restarted.controller.setPhase({ phase: 'preheat', roomBoostC: 5 });
    await restarted.controller.setPhase({ phase: 'reduction' });
    await restarted.controller.restore();
    assert.deepEqual(restarted.native, { ...baselines, [register]: value });
  });

test('permanent native edits preserve other manual preheat duties, while ROOM supersedes its boost', async t => {
  const r = rig(); t.after(() => r.controller.close());
  const pause = { pauseId: 'fixture-pause', expiresAt: initialTime + 3_600_000 };
  await r.controller.setPhase({ phase: 'preheat', manual: true, expiresAt: r.now + 60_000, ...pause });
  await r.controller.setSetting({ register: '0212', value: 46 });
  assert.equal(r.controller.status().manualPreheat.baseValue, 20);
  assert.equal(r.controller.status().expiresAt, pause.expiresAt);
  assert.equal(r.controller.status().obligations['0212'], undefined);
  r.setNow(pause.expiresAt);
  for (const index of Object.keys(r.native)) r.feed(index);
  await r.controller.reconcile();
  assert.equal(r.native['0203'], 20, 'Temporary preheat still restores');
  assert.equal(r.native['0212'], 46, 'Permanent DHW edit survives pause expiry');
  await r.controller.setPhase({ phase: 'preheat', manual: true, expiresAt: r.now + 60_000 });
  await r.controller.setSetting({ register: '0203', value: 22 });
  assert.equal(r.controller.status().manualPreheat, null);
  assert.equal(r.controller.status().expiresAt, null);
  await r.controller.restore();
  assert.equal(r.native['0203'], 22, 'Later native ROOM supersedes the temporary boost');
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

test('a failed durable native edit preserves the active manual preheat restoration duty', async t => {
  const r = rig(); t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'preheat', manual: true, expiresAt: r.now + 60_000 });
  const before = r.controller.status(), save = r.store.setState;
  let failNext = true;
  r.store.setState = (...args) => {
    if (failNext) { failNext = false; throw new Error('Synthetic storage failure'); }
    return save(...args);
  };
  await assert.rejects(r.controller.setSetting({ register: '0203', value: 22 }), /Synthetic storage failure/);
  assert.equal(r.sent.length, 1, 'No native command can be sent before its supersession is durable');
  assert.deepEqual(r.controller.status().obligations, before.obligations);
  assert.deepEqual(r.controller.status().manualPreheat, before.manualPreheat);
  assert.equal(r.controller.status().expiresAt, before.expiresAt);
  r.setNow(before.expiresAt); r.feed('0203');
  await r.controller.reconcile();
  assert.equal(r.native['0203'], 20);
});

test('failed native ROOM delivery retains the earlier preheat deadline and restores its baseline', async t => {
  const r = rig({ behavior: ({ payload }) => {
    if (payload === '22') throw new Error('Synthetic publish failure');
  } }); t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'preheat', manual: true, expiresAt: r.now + 60_000 });
  const before = r.controller.status();
  await assert.rejects(r.controller.setSetting({ register: '0203', value: 22 }), { code: 'H66_WRITE_FAILED' });
  assert.equal(r.native['0203'], 25);
  assert.deepEqual(r.controller.status().obligations, before.obligations);
  assert.equal(r.controller.status().expiresAt, before.expiresAt);
  r.setNow(before.expiresAt); r.feed('0203');
  await r.controller.reconcile();
  assert.equal(r.native['0203'], 20);
});

test('a late native ROOM result supersedes the earlier temporary boost without restoring its old baseline', async t => {
  const r = rig({ behavior: ({ payload }) => payload === '22' ? 'silent' : undefined });
  t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'preheat', manual: true, expiresAt: r.now + 60_000 });
  const end = r.controller.status().expiresAt;
  await assert.rejects(r.controller.setSetting({ register: '0203', value: 22 }), { code: 'H66_READBACK_TIMEOUT' });
  assert.equal(r.controller.status().obligations['0203'].baseline, 20);
  r.native['0203'] = 22; r.feed('0203');
  r.setNow(end); r.feed('0203'); await r.controller.reconcile();
  assert.equal(r.native['0203'], 22);
  assert.deepEqual(r.controller.status().obligations, {});
  assert.deepEqual(r.sent.map(({ payload }) => payload), ['25', '22']);
});

test('explicitly selecting the current boosted ROOM value promotes it without a write or later restoration', async t => {
  const r = rig(); t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'preheat', manual: true, expiresAt: r.now + 60_000 });
  const result = await r.controller.setSetting({ register: '0203', value: 25 });
  assert.equal(result.sent, false);
  assert.equal(result.confirmed, true);
  assert.equal(r.controller.status().manualPreheat, null);
  assert.deepEqual(r.controller.status().obligations, {});
  r.setNow(initialTime + 60_000); await r.controller.reconcile();
  assert.equal(r.native['0203'], 25);
  assert.equal(r.sent.length, 1);
});

test('an unconfirmed native edit is never replayed or rolled back on reconnect or restart', async t => {
  const r = rig({ behavior: () => 'silent' }); t.after(() => r.controller.close());
  await assert.rejects(r.controller.setSetting({ register: '0203', value: 21 }), { code: 'H66_READBACK_TIMEOUT' });
  assert.equal(r.controller.status().lastManual.confirmed, false);
  assert.equal(r.controller.status().lastManual.status, 'unconfirmed');
  assert.equal(r.controller.status().restorationPending, false);
  assert.deepEqual(r.controller.status().obligations, {});
  await r.controller.reconcile();
  r.controller.setConnected(false); r.controller.setConnected(true);
  r.native['0203'] = 21; r.feed('0203'); await nextTurn();
  assert.deepEqual(r.sent.map(({ payload }) => payload), ['21']);
  assert.equal(r.controller.status().readings['0203'].value, 21);
  await r.controller.close();
  const restarted = rig({ store: r.store, values: r.native, startAt: r.now });
  t.after(() => restarted.controller.close());
  await nextTurn(); await restarted.controller.reconcile();
  assert.deepEqual(restarted.sent, []);
  assert.equal(restarted.controller.status().readings['0203'].value, 21);
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

test('expired restoration waits without repeated persistence until its fresh readback arrives', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig(); t.after(() => r.controller.close());
  await r.controller.writeSettings({ '0212': 40 }, { expiresAt: r.now + 1000 });
  r.setNow(initialTime + 300_001); r.elapse(300_001);
  r.feed('0001', 5); // Transport is live, but none of the native settings are fresh.
  t.mock.timers.tick(1000); await nextTurn();
  const waiting = r.controller.status(), writes = r.store.writes, commands = r.sent.length;
  assert.equal(waiting.phase, 'restoration-pending');
  assert.equal(waiting.restorationPending, true);
  assert.equal(waiting.obligations['0212'].baseline, 44);
  for (let step = 0; step < 10; step++) {
    t.mock.timers.tick(25); await nextTurn();
  }
  assert.equal(r.store.writes, writes, 'An expired deadline must not repeatedly persist the same pending result.');
  assert.equal(r.sent.length, commands);
  assert.equal(r.store.getState(`h66:control:${deviceId}`).obligations['0212'].expected, 40);

  r.feed('0212', 40, { retained: true }); await nextTurn();
  assert.equal(r.sent.length, commands, 'A retained register value cannot authorize restoration.');
  assert.equal(r.controller.status().restorationPending, true);
  r.feed('0212', 40); await nextTurn();
  assert.equal(r.native['0212'], 44, 'Fresh relevant telemetry restores immediately, without waiting for a retry timer.');
  assert.deepEqual(r.controller.status().obligations, {});
  assert.equal(r.controller.status().restorationPending, false);
});

test('expiry restores independently available settings and retains missing settings without a retry timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig(); t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'reduction', expiresAt: r.now + 1000 });
  r.controller.setConnected(false); r.controller.setConnected(true);
  r.setNow(initialTime + 1000); r.elapse(1000);
  r.feed('0212', 40);
  t.mock.timers.tick(1000); await nextTurn();
  assert.equal(r.native['0212'], 44);
  assert.deepEqual(Object.keys(r.controller.status().obligations).sort(), ['0208', '2201']);
  const writes = r.store.writes, commands = r.sent.length;
  for (let step = 0; step < 10; step++) {
    t.mock.timers.tick(25); await nextTurn();
  }
  assert.equal(r.store.writes, writes);
  assert.equal(r.sent.length, commands);
  r.feed('0208', 50); await nextTurn();
  assert.equal(r.native['0208'], 60);
  assert.deepEqual(Object.keys(r.controller.status().obligations), ['2201']);
  r.feed('2201', 2); await nextTurn();
  assert.deepEqual(r.native, baselines);
  assert.deepEqual(r.controller.status().obligations, {});
});

test('disconnected expiry survives restart and waits for fresh native evidence before restoration', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = rig(); t.after(() => first.controller.close());
  await first.controller.writeSettings({ '0212': 40 }, { expiresAt: first.now + 1000 });
  first.controller.setConnected(false);
  first.setNow(initialTime + 1000); first.elapse(1000);
  const writes = first.store.writes, commands = first.sent.length;
  t.mock.timers.tick(1000); await nextTurn();
  assert.equal(first.controller.status().restorationPending, true);
  assert.equal(first.store.writes, writes);
  assert.equal(first.sent.length, commands);
  await first.controller.close();

  const restarted = rig({ store: first.store, values: { '0001': 5 }, startAt: first.now });
  t.after(() => restarted.controller.close());
  await nextTurn();
  const restartWrites = restarted.store.writes;
  for (let step = 0; step < 10; step++) {
    t.mock.timers.tick(25); await nextTurn();
  }
  assert.equal(restarted.store.writes, restartWrites);
  assert.deepEqual(restarted.sent, []);
  assert.equal(restarted.controller.status().restorationPending, true);
  restarted.feed('0212', 40); await nextTurn();
  assert.equal(restarted.native['0212'], 44);
  assert.deepEqual(restarted.controller.status().obligations, {});
});

test('expiry during a pending native write restores after that operation finishes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig({ settings: { readbackTimeoutMs: 2000 },
    behavior: ({ sent }) => sent.length === 1 ? 'silent' : undefined });
  t.after(() => r.controller.close());
  const transition = r.controller.writeSettings({ '0212': 40 }, { expiresAt: r.now + 1000 });
  await nextTurn();
  r.setNow(initialTime + 1000); r.elapse(1000);
  t.mock.timers.tick(1000); await nextTurn();
  assert.equal(r.controller.status().restorationPending, true);
  assert.equal(r.sent.length, 1);
  r.feed('0212', 40);
  await assert.rejects(transition, { code: 'H66_EXPIRED' });
  await nextTurn();
  assert.deepEqual(r.sent.map(row => row.payload), ['40', '44']);
  assert.deepEqual(r.controller.status().obligations, {});
  assert.equal(r.controller.status().restorationPending, false);
});

test('fresh missing-setting telemetry received during restoration is reconciled after the active write', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig({ behavior: ({ index, payload, feed }) => {
    if (index === '0212' && payload === '44') feed('0208', 50);
  } });
  t.after(() => r.controller.close());
  await r.controller.writeSettings({ '0212': 40, '0208': 50 }, { expiresAt: r.now + 1000 });
  r.controller.setConnected(false); r.controller.setConnected(true);
  r.setNow(initialTime + 1000); r.elapse(1000);
  r.feed('0212', 40);
  t.mock.timers.tick(1000); await nextTurn();
  assert.equal(r.native['0212'], 44);
  assert.equal(r.native['0208'], 60, 'Fresh evidence during the first write must not wait for another report.');
  assert.deepEqual(r.controller.status().obligations, {});
  assert.equal(r.controller.status().restorationPending, false);
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

test('restart preserves the preceding override value after an uncertain second native write', async t => {
  let first;
  first = rig({ behavior: ({ index, payload }) => {
    if (index === '0203' && payload === '24') {
      first.controller.setConnected(false);
      return 'silent';
    }
  } });
  await first.controller.setPhase({ phase: 'preheat', roomBoostC: 5 });
  assert.equal(first.native['0203'], 25);
  await assert.rejects(first.controller.setPhase({ phase: 'preheat', roomBoostC: 4 }), { code: 'H66_DISCONNECTED' });
  const obligation = first.store.getState(`h66:control:${deviceId}`).obligations['0203'];
  assert.equal(obligation.baseline, 20);
  assert.equal(obligation.expected, 24);
  assert.equal(obligation.previousValue, 25);
  assert.equal(obligation.confirmed, false);
  await first.controller.close();
  const second = rig({ store: first.store, values: first.native });
  t.after(() => second.controller.close());
  await nextTurn(); await nextTurn();
  assert.equal(second.native['0203'], 20, 'The preceding controller override is restored, not mistaken for an external edit');
  assert.deepEqual(second.controller.status().obligations, {});
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
  await r.controller.setPhase({ phase: 'preheat', manual: true, expiresAt: r.now + 60_000, roomBoostC: 5 });
  assert.equal(r.native['0203'], target);
  await r.controller.setPhase({ phase: 'preheat', manual: true, expiresAt: r.now + 60_000, roomBoostC: 5 });
  assert.equal(r.native['0203'], target, 'Renewal retains the original baseline');
  await r.controller.setPhase({ phase: 'normal' });
  assert.equal(r.native['0203'], baseline);
});

for (const [register, manual] of [['2201', 0], ['0208', 58]]) test(`restoration preserves a ${register} panel edit during an earlier register readback`, async t => {
  const r = rig({ behavior({ index, payload, feed, native }) {
    if (index === '0212' && Number(payload) === 44) { native[register] = manual; feed(register, manual); }
  } });
  t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'reduction' });
  const before = r.sent.length;
  await r.controller.restore();
  assert.equal(r.native[register], manual);
  assert.equal(r.sent.slice(before).some(row => row.index === register), false);
  assert(r.store.events.some(row => row.type === 'h66-external-setting-preserved' && row.detail.register === register));
  assert.deepEqual(r.controller.status().obligations, {});
});

test('a no-op automatic register is watched and a later first write restores the new baseline', async t => {
  const r = rig({ values: { ...baselines, '2201': 2 } }); t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'reduction' });
  assert.equal(r.controller.status().obligations['2201'], undefined);
  r.native['2201'] = 1; r.feed('2201', 1);
  assert.equal(r.controller.status().externalChangeRevision, 1);
  await nextTurn(); await r.controller.reconcile();
  await r.controller.setPhase({ phase: 'reduction' });
  assert.equal(r.controller.status().obligations['2201'].baseline, 1);
  await r.controller.restore(); assert.equal(r.native['2201'], 1);
});

test('manual Heat control preheat restores despite a wall-clock rollback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig(); t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'preheat', manual: true, expiresAt: r.now + 60_000 });
  r.setNow(initialTime - 3_600_000);
  for (const [register, value] of Object.entries(r.native)) r.feed(register, value);
  r.elapse(60_000); t.mock.timers.tick(60_000);
  await nextTurn();
  assert.equal(r.native['0203'], 20);
  assert.deepEqual(r.controller.status().obligations, {});
});

test('a paused Reduced selection retains exact native obligations across restart without replaying writes', async t => {
  const first = rig(); t.after(() => first.controller.close());
  await first.controller.setPhase({ phase: 'reduction', manual: true, pauseId: 'durable-pause', expiresAt: null });
  await first.controller.close();
  const restarted = rig({ store: first.store, values: first.native, startAt: first.now + 86_400_000 });
  t.after(() => restarted.controller.close());
  await nextTurn(); await restarted.controller.reconcile();
  assert.deepEqual(restarted.sent, []);
  assert.equal(restarted.controller.status().phase, 'reduction');
  assert.equal(restarted.controller.status().pauseId, 'durable-pause');
  assert.equal(restarted.controller.status().expiresAt, null);
  await restarted.controller.restore();
  assert.deepEqual(restarted.native, baselines);
});

test('a late matching native device report settles an unconfirmed manual receipt', async t => {
  const r = rig({ behavior: () => 'silent' }); t.after(() => r.controller.close());
  await assert.rejects(r.controller.setSetting({ register: '0203', value: 22 }), { code: 'H66_READBACK_TIMEOUT' });
  assert.equal(r.controller.status().lastManual.status, 'unconfirmed');
  r.setNow(initialTime + 1000); r.feed('0203', 22);
  assert.equal(r.controller.status().lastManual.status, 'confirmed');
  assert.equal(r.controller.status().lastManual.confirmedAt, initialTime + 1000);
  assert.equal(r.controller.status().lastManual.at, initialTime, 'Feedback does not restart receipt retention.');
});

test('Preheat returns DHW and AUX to normal service even when it follows a recovery hold', async t => {
  const r = rig(); t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'reduction' });
  await r.controller.setPhase({ phase: 'recovery', holdDhwReduced: true, compressorOnly: true });
  assert.equal(r.native['0212'], 40); assert.equal(r.native['2201'], 2);
  await r.controller.setPhase({ phase: 'preheat', roomBoostC: 5 });
  assert.deepEqual(r.native, { ...baselines, '0203': 25 });
});

test('promoting the last manual ROOM override to a native setting releases manual ownership', async t => {
  const r = rig(); t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'preheat', manual: true, expiresAt: r.now + 60_000 });
  await r.controller.setSetting({ register: '0203', value: 25 });
  await r.controller.setPhase({ phase: 'preheat', roomBoostC: 5 });
  assert.equal(r.native['0203'], 30);
});

test('an uncertain native edit preserves an indefinite paused Reduced choice and settles on later readback', async t => {
  const r = rig({ behavior: ({ index, payload }) => index === '0212' && Number(payload) === 46 ? 'silent' : undefined });
  t.after(() => r.controller.close());
  await r.controller.setPhase({ phase: 'reduction', manual: true, pauseId: 'uncertain-edit-pause', expiresAt: null });
  const obligation = r.controller.status().obligations['0212'];
  await assert.rejects(r.controller.setSetting({ register: '0212', value: 46 }), { code: 'H66_READBACK_TIMEOUT' });
  await nextTurn();
  const pending = r.controller.status();
  assert.equal(pending.phase, 'reduction');
  assert.equal(pending.restorationPending, false);
  assert.equal(pending.expiresAt, null);
  assert.deepEqual(pending.obligations['0212'], obligation);
  assert.equal(r.native['2201'], 2, 'Uncertain native delivery must not cancel the held Reduced selection.');
  r.setNow(initialTime + 1000); r.native['0212'] = 46; r.feed('0212');
  assert.equal(r.controller.status().lastManual.status, 'confirmed');
  assert.equal(r.controller.status().obligations['0212'], undefined);
  assert.equal(r.controller.status().phase, 'reduction');
  await r.controller.restore();
  assert.equal(r.native['0212'], 46, 'The confirmed native edit becomes the new baseline.');
  assert.equal(r.native['2201'], 1);
});

test('H66 waits for admitted MQTT publication and only subsequent readback confirms it', async t => {
  let release, options;
  const r = rig({ settings: { readbackTimeoutMs: 500 }, beforePublication: input => {
    options = input.options; return new Promise(resolve => { release = resolve; });
  } });
  t.after(() => r.controller.close());
  const request = r.controller.setSetting({ register: '0212', value: 40 });
  await nextTurn();
  assert.equal(r.sent.length, 0); assert(options.signal instanceof AbortSignal);
  r.feed('0203', 20); // An unrelated committed observation does not revoke the edit.
  release();
  assert.equal((await request).confirmed, true); assert.equal(r.sent.length, 1);
});

test('H66 storage waits cancel instead of sending with changed evidence, expired deadlines or lost connection', async t => {
  for (const scenario of ['native-change', 'reconnect', 'shutdown', 'timeout', 'elapsed-timeout', 'expiry']) await t.test(scenario, async () => {
    let release, options;
    const r = rig({ settings: { readbackTimeoutMs: scenario === 'timeout' ? 20 : 500 }, beforePublication: input => {
      options = input.options; return new Promise(resolve => { release = resolve; });
    } });
    const request = scenario === 'expiry'
      ? r.controller.writeSettings({ '0212': 40 }, { expiresAt: r.now + 1000 })
      : r.controller.setSetting({ register: '0212', value: 40 });
    const rejected = assert.rejects(request);
    await nextTurn();
    if (scenario === 'native-change') r.feed('0212', 40);
    if (scenario === 'reconnect') { r.controller.setConnected(false); r.controller.setConnected(true); }
    if (scenario === 'shutdown') r.controller.beginShutdown();
    if (scenario === 'elapsed-timeout') r.elapse(500);
    if (scenario === 'expiry') { r.setNow(r.now + 1000); r.elapse(1000); }
    if (scenario === 'timeout') { await rejected; assert.equal(options.signal.aborted, true); }
    release(); await rejected; await nextTurn();
    assert.equal(r.sent.length, 0, 'Recovery never dispatches the abandoned request');
    await r.controller.close();
  });
});
