import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createChargingController } from '../src/charging/controller.js';
import { chargingSnapshot, normalizeScheduleState, delayedScheduleFor } from '../src/charging/easee.js';

const START = Date.parse('2026-09-22T08:00:00Z'), SECOND = 1000;
const row = (id, value, at) => ({ id, value, timestamp: new Date(at).toISOString() });
const view = runtime => runtime.status().chargers.find(item => item.id === 'charger1');
function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = { now: START, reads: 0, writes: [], saved: new Map(), failSave: false,
    observed: { mode: 2, pilot: 'B', at: START }, schedule: normalizeScheduleState({ enabled: 'none' }) };
  const store = { getState: key => structuredClone(h.saved.get(key)), setState: (key, value) => {
    if (h.failSave) throw new Error('synthetic database unavailable');
    h.saved.set(key, structuredClone(value));
  } };
  const snapshot = () => chargingSnapshot([
    row(250, true, h.now), row(31, true, h.now), row(109, h.observed.mode, h.observed.at),
    row(100, h.observed.pilot, h.observed.at), row(96, h.schedule.enabled === 'none' ? 0 : 54, h.now),
    row(47, 16, h.now), row(48, 16, h.now), row(104, 32, h.now),
    ...[22, 23, 24].map(id => row(id, 20, h.now)),
  ], h.schedule, h.now, null, { externalLoadBalancing: false });
  h.adapter = {
    createController(options) { h.canControl = options.canControl; return createChargingController(options); },
    async read() { h.reads++; await h.readHook?.(); return snapshot(); },
    async installDelayed(options) {
      assert.equal(options.canMutate(), true); await options.beforeWrite?.(snapshot());
      h.writes.push('install'); h.schedule = normalizeScheduleState({ enabled: 'delayed', delayed: delayedScheduleFor(options, h.now) });
      return snapshot();
    },
    async clear(options) { assert.equal(options.canMutate(), true); h.writes.push('clear'); h.schedule = normalizeScheduleState({ enabled: 'none' }); return snapshot(); },
  };
  const engine = {};
  h.create = (chargerId = 'synthetic-charger') => {
    const runtime = new ChargingRuntime({ engine, store, config: { input: 'mqtt', connections: { easee: { charger_id: chargerId } } }, clock: () => h.now });
    runtime.teslaCapture = { snapshot: () => ({ association: 'synthetic-tesla-source', connected: true, pluggedIn: true, atHome: true, assignment: 'auto', batteryLevel: 60 }),
      reception: () => ({ connected: true }) };
    t.after(() => runtime.close());
    return runtime;
  };
  h.start = async runtime => { await runtime.setAdapter('charger1', h.adapter); await runtime.reconcile('charger1');
    const item=runtime.chargers.charger1, at=view(runtime).control.session.connectedAt;
    if(at===START) item.vehicleMatch={id:'tesla',vehicleAssociation:'synthetic-tesla-source',scope:`${item.association}:${at}`,matchedAt:at}; };
  h.event = (runtime, id, value, previousValue, measuredAt, previousMeasuredAt = START) => {
    h.now = Math.max(h.now, measuredAt + 1);
    return runtime.receiveEaseeObservation({ id, value, measuredAt, receivedAt: h.now, previousValue, previousMeasuredAt });
  };
  h.flush = async (runtime, ms = 100) => { t.mock.timers.tick(ms); await runtime.streamFlight; };
  return h;
}

test('one-second and sixteen-second stream unplug/replug cycles reset identified sessions without BMW events', async t => {
  for (const gap of [SECOND, 16 * SECOND]) await t.test(`${gap / SECOND} seconds`, async t => {
    const h = fixture(t), runtime = h.create(); await h.start(runtime);
    const original = view(runtime).control.session.connectedAt;
    assert.equal(view(runtime).vehicle.id, 'tesla'); assert.equal(runtime.vehicleFeeds.bmw.reading, null);
    const unplugAt = START + 60 * SECOND, plugAt = unplugAt + gap;
    assert.equal(h.event(runtime, 100, 'A', 'B', unplugAt), true);
    assert.equal(view(runtime).vehicle.id, null, 'The old identity is withdrawn before another controller read');
    assert.equal(h.event(runtime, 100, 'B', 'A', plugAt, unplugAt), true);
    h.observed = { mode: 2, pilot: 'B', at: plugAt };
    await h.flush(runtime);
    const current = view(runtime);
    assert.ok(current.control.session.connectedAt > original);
    assert.equal(current.control.session.lastDisconnectedAt, unplugAt);
    assert.equal(current.vehicle.id, null, 'The old Tesla verdict does not identify the new session');
    assert.equal(current.targetSelection, null);
    assert.equal(runtime.chargers.charger1.vehicleDisconnect.source, 'easee-stream');
    assert.equal(runtime.vehicleFeeds.bmw.reading, null);
  });
});

test('a pending stream boundary restores independently of BMW and is isolated by charger configuration', async t => {
  const h = fixture(t), runtime = h.create(); await h.start(runtime);
  const unplugAt = START + 60 * SECOND, plugAt = unplugAt + 16 * SECOND;
  h.event(runtime, 100, 'A', 'B', unplugAt); h.event(runtime, 100, 'B', 'A', plugAt, unplugAt);
  const original = structuredClone(runtime.chargers.charger1.vehicleDisconnect);
  await runtime.close(); h.observed = { mode: 2, pilot: 'B', at: plugAt }; h.now += SECOND;
  const restored = h.create();
  assert.equal(restored.vehicleFeeds.bmw.reading, null);
  assert.deepEqual(restored.chargers.charger1.vehicleDisconnect, original);
  await h.start(restored);
  assert.ok(view(restored).control.session.connectedAt > START);
  assert.equal(view(restored).vehicle.id, null);
  const different = h.create('different-synthetic-charger');
  assert.equal(different.chargers.charger1.vehicleDisconnect, null);
  assert.equal(different.chargers.charger1.streamEvidence, null);
});

test('charging start, stop and restart source edges survive even when the next poll sees only charging', async t => {
  const h = fixture(t), runtime = h.create(); await h.start(runtime);
  const startAt = START + 10 * SECOND, stopAt = START + 20 * SECOND, restartAt = START + 30 * SECOND;
  h.event(runtime, 109, 3, 2, startAt);
  h.event(runtime, 109, 2, 3, stopAt, startAt);
  h.event(runtime, 109, 3, 2, restartAt, stopAt);
  h.observed = { mode: 3, pilot: 'C', at: restartAt };
  await h.flush(runtime);
  const item = runtime.chargers.charger1;
  assert.deepEqual(item.streamEvidence.chargingTimes, [startAt, restartAt]);
  assert.deepEqual(item.streamEvidence.stoppedTimes, [stopAt]);
  assert.ok(item.vehicleEvidence.chargingTimes.includes(startAt));
  assert.ok(item.vehicleEvidence.chargingTimes.includes(restartAt));
  assert.ok(item.vehicleEvidence.stoppedTimes.includes(stopAt));
  assert.equal(view(runtime).control.snapshot.mode, 3);
});

test('a critical stream burst schedules one reconcile after 100 ms while ordinary current measurements schedule none', async t => {
  const h = fixture(t), runtime = h.create(); await h.start(runtime);
  const initialReads = h.reads;
  assert.equal(h.event(runtime, 183, 7, 6, START + SECOND), false);
  await h.flush(runtime, 200); assert.equal(h.reads, initialReads);
  h.event(runtime, 109, 3, 2, START + 2 * SECOND);
  h.event(runtime, 96, 50, 0, START + 3 * SECOND);
  h.event(runtime, 109, 2, 3, START + 4 * SECOND, START + 2 * SECOND);
  t.mock.timers.tick(99); assert.equal(h.reads, initialReads);
  await h.flush(runtime, 1);
  assert.equal(h.reads, initialReads + 1);
  assert.equal(runtime.streamPending.size, 0); assert.equal(runtime.streamFlight, null);
});

test('failed stream persistence retains evidence, blocks control and retries without needing event replay', async t => {
  const h = fixture(t), runtime = h.create(); await h.start(runtime);
  const initialReads = h.reads; h.failSave = true;
  const unplugAt = START + 60 * SECOND;
  assert.equal(h.event(runtime, 100, 'A', 'B', unplugAt), true);
  const boundary = structuredClone(runtime.chargers.charger1.vehicleDisconnect);
  assert.equal(runtime.streamPersistencePending, true); assert.equal(h.canControl(), false);
  assert.equal(runtime.error, 'charging-stream-save-unavailable');
  await h.flush(runtime);
  assert.equal(h.reads, initialReads, 'No controller work runs until the evidence is durable');
  assert.deepEqual(runtime.chargers.charger1.vehicleDisconnect, boundary);
  h.failSave = false; h.observed = { mode: 1, pilot: 'A', at: unplugAt };
  await h.flush(runtime, 1000);
  assert.equal(runtime.streamPersistencePending, false);
  assert.equal(h.canControl(), true);
  assert.equal(view(runtime).control.session.connectedAt, null);
  assert.equal(h.saved.get('charging:mqtt').chargers.charger1.vehicleDisconnect.readingId, boundary.readingId);
});

test('a stream cycle delivered during an in-flight read is retained for the queued reconciliation', async t => {
  const h = fixture(t), runtime = h.create(); await h.start(runtime);
  let started, finish;
  const begun = new Promise(resolve => { started = resolve; });
  const released = new Promise(resolve => { finish = resolve; });
  h.readHook = async () => { started(); await released; h.readHook = null; };
  const reading = runtime.reconcile('charger1'); await begun;
  const unplugAt = START + 60 * SECOND, plugAt = unplugAt + SECOND;
  h.event(runtime, 100, 'A', 'B', unplugAt);
  h.event(runtime, 100, 'B', 'A', plugAt, unplugAt);
  h.observed = { mode: 2, pilot: 'B', at: plugAt };
  t.mock.timers.tick(100); finish(); await reading; await runtime.streamFlight;
  assert.ok(view(runtime).control.session.connectedAt > START);
  assert.equal(view(runtime).vehicle.id, null); assert.equal(h.canControl(), true);
  assert.equal(runtime.streamPending.size, 0);
});

test('an ordinary read that notices a disconnect before the queued stream boundary cannot leave control permanently gated', async t => {
  const h = fixture(t), runtime = h.create(); await h.start(runtime);
  let started, finish;
  const begun = new Promise(resolve => { started = resolve; });
  const released = new Promise(resolve => { finish = resolve; });
  h.readHook = async () => { started(); await released; h.readHook = null; };
  const reading = runtime.reconcile('charger1'); await begun;
  const unplugAt = START + 60 * SECOND;
  h.event(runtime, 100, 'A', 'B', unplugAt);
  h.observed = { mode: 1, pilot: 'A', at: unplugAt };
  finish(); await reading;
  assert.equal(view(runtime).control.session.connectedAt, null);
  await h.flush(runtime);
  assert.equal(h.canControl(), true, 'A controller that already closed this session may proceed');
  const plugAt = unplugAt + 16 * SECOND;
  h.event(runtime, 100, 'B', 'A', plugAt, unplugAt);
  h.observed = { mode: 2, pilot: 'B', at: plugAt };
  await h.flush(runtime);
  assert.ok(view(runtime).control.session.connectedAt > START);
  assert.equal(h.canControl(), true); assert.equal(view(runtime).vehicle.id, null);
});
