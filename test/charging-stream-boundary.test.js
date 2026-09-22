import test from 'node:test';
import assert from 'node:assert/strict';
import { createChargingController } from '../src/charging/controller.js';
import { createEaseeScheduleAdapter, normalizeScheduleState } from '../src/charging/easee.js';

const START = Date.parse('2026-09-22T08:00:00Z'), MINUTE = 60_000;
const row = (id, value, at) => ({ id, value, timestamp: new Date(at).toISOString() });
const disconnected = (extra = {}) => ({ source: 'easee-stream', readingId: 'easee-live-disconnect',
  measuredAt: START + 34 * MINUTE, receivedAt: START + 34 * MINUTE + 1000, endedConnectedAt: START, ...extra });
const reconnected = event => ({ ...event, reconnected: { readingId: 'easee-live-reconnect', retained: false,
  measuredAt: event.measuredAt + 5000, receivedAt: event.receivedAt + 5000 } });

function harness() {
  const h = { now: START, sourceAt: START, mode: 2, pilot: 'B', enabled: true, online: true,
    allowed: true, reason: null, saved: null, writes: [], failClear: false, failSave: false,
    schedule: normalizeScheduleState({ enabled: 'none' }) };
  const request = async (url, options) => {
    if (options.method === 'GET') {
      if (url.endsWith('/schedules')) return structuredClone(h.schedule);
      return [row(250, h.online, h.now), row(31, h.enabled, h.now), row(109, h.mode, h.sourceAt),
        row(100, h.pilot, h.sourceAt), row(96, h.reason ?? (h.schedule.enabled === 'none' ? 0 : 54), h.now),
        row(47, 16, h.now), row(48, 16, h.now), row(104, 32, h.now),
        ...[22, 23, 24].map(id => row(id, 20, h.now))];
    }
    assert.equal(options.controlGuard?.(), true);
    if (url.endsWith('/disable') && h.failClear) throw new Error('synthetic clear failure');
    await h.writeHook?.(url);
    h.writes.push(url.endsWith('/disable') ? 'clear' : 'install');
    if (url.endsWith('/disable')) h.schedule.enabled = 'none';
    else { const { enabled, ...delayed } = JSON.parse(options.body);
      h.schedule = normalizeScheduleState({ enabled: 'delayed', delayed }); }
    return '';
  };
  const native = createEaseeScheduleAdapter({ request, chargerId: 'synthetic-charger', clock: () => h.now, canControl: () => h.allowed });
  const received = snapshot => h.readAt === undefined ? snapshot : { ...snapshot, readAt: h.readAt };
  h.adapter = { ...native, read: async () => received(await native.read()), clear: async options => received(await native.clear(options)) };
  h.restart = () => {
    h.controller?.close();
    h.controller = createChargingController({ adapter: h.adapter, initialState: h.saved, clock: () => h.now,
      canControl: () => h.allowed, saveState: value => {
        if (h.failSave) throw new Error('synthetic save failure');
        h.saved = structuredClone(value);
      } });
  };
  h.restart();
  h.update = (extra = {}) => h.controller.update({ enabled: true, timezone: 'UTC', maximumAmps: 16,
    plan: { id: 'old-plan', startAt: START + 3 * 60 * MINUTE, periods: [
      { startAt: START + 3 * 60 * MINUTE, endAt: START + 4 * 60 * MINUTE },
      { startAt: START + 6 * 60 * MINUTE, endAt: null }] }, ...extra });
  h.begin = async () => { await h.update(); h.now = START + 35 * MINUTE; };
  return h;
}

test('live stream disconnect and reconnect between polls end any old vehicle session and clear only its owned delay', async () => {
  const h = harness(); await h.begin();
  assert.ok(h.controller.status().execution);
  const event = reconnected(disconnected());
  let state = await h.update({ vehicleDisconnect: event, plan: { state: 'identifying' } });
  assert.equal(state.snapshot.pluggedIn, true, 'The unchanged polled observation stays raw');
  assert.equal(state.session.connectedAt, h.now); assert.equal(state.session.lastDisconnectedAt, event.measuredAt);
  assert.equal(state.vehicleDisconnect.source, 'easee-stream');
  assert.equal(state.vehicleDisconnect.awaitingConnection, false); assert.equal(state.vehicleDisconnect.cleanupPending, false);
  assert.equal(state.phase, 'identifying'); assert.equal(state.execution, null); assert.equal(state.released, false);
  assert.equal(state.owned, null); assert.deepEqual(h.writes, ['install', 'clear']);
  const connectedAt = state.session.connectedAt;
  h.now += MINUTE; h.restart();
  state = await h.update({ vehicleDisconnect: event, plan: { state: 'identifying' } });
  assert.equal(state.session.connectedAt, connectedAt, 'Persisted replay cannot open another session');
  assert.deepEqual(h.writes, ['install', 'clear']);
  state = await h.update({ vehicleDisconnect: disconnected({ readingId: 'old-replay' }), plan: { state: 'identifying' } });
  assert.equal(state.session.connectedAt, connectedAt, 'A different ID cannot reuse the ended connection');
});

test('stream disconnect clears released status even when the old native start has already expired', async () => {
  const h = harness();
  await h.update({ plan: { id: 'released-plan', startAt: START } });
  assert.equal(h.controller.status().released, true);
  h.now += 35 * MINUTE;
  const state = await h.update({ vehicleDisconnect: reconnected(disconnected()), plan: { state: 'identifying' } });
  assert.equal(state.phase, 'identifying'); assert.equal(state.released, false); assert.equal(state.execution, null);
  assert.equal(state.session.connectedAt, h.now); assert.deepEqual(h.writes, []);
});

test('stream reconnect cannot bypass a fresh online controller read', async t => {
  for (const change of [{ readAt: START }, { online: false }]) await t.test(JSON.stringify(change), async () => {
    const h = harness(); await h.begin(); Object.assign(h, change);
    const state = await h.update({ vehicleDisconnect: reconnected(disconnected()), plan: { state: 'identifying' } });
    assert.equal(state.session.connectedAt, null); assert.equal(state.vehicleDisconnect.awaitingConnection, true);
    assert.notEqual(state.phase, 'identifying');
  });
});

test('replayed stream boundary identity and clocks cannot be revised to add reconnection evidence', async t => {
  for (const change of [{ measuredAt: disconnected().measuredAt + 1 }, { receivedAt: disconnected().receivedAt + 1 },
    { source: 'bmw-cardata' }, { endedConnectedAt: START + 1 }]) await t.test(JSON.stringify(change), async () => {
    const h = harness(); await h.begin(); const event = disconnected();
    let state = await h.update({ vehicleDisconnect: event, plan: { state: 'identifying' } });
    assert.equal(state.session.connectedAt, null);
    state = await h.update({ vehicleDisconnect: { ...reconnected(event), ...change }, plan: { state: 'identifying' } });
    assert.equal(state.session.connectedAt, null); assert.equal(state.vehicleDisconnect.reconnected, undefined);
    assert.equal(state.vehicleDisconnect.measuredAt, event.measuredAt);
    assert.equal(state.vehicleDisconnect.receivedAt, event.receivedAt);
    assert.deepEqual(h.writes, ['install', 'clear']);
  });
});

test('invalid, future, same-clock and retained stream boundary facts never reopen an ended session', async t => {
  const event = disconnected(), valid = reconnected(event).reconnected;
  for (const change of [{ retained: true }, { readingId: event.readingId }, { readingId: 'x'.repeat(129) },
    { measuredAt: event.measuredAt }, { receivedAt: START + 40 * MINUTE }, { measuredAt: START + 40 * MINUTE },
    { receivedAt: null }]) await t.test(JSON.stringify(change), async () => {
    const h = harness(); await h.begin();
    const state = await h.update({ vehicleDisconnect: { ...event, reconnected: { ...valid, ...change } }, plan: { state: 'identifying' } });
    assert.equal(state.session.connectedAt, null); assert.equal(state.vehicleDisconnect.awaitingConnection, true);
    assert.equal(state.vehicleDisconnect.reconnected, undefined);
  });
});

test('wrong-session and invalid stream disconnect provenance leave the existing session untouched', async t => {
  for (const change of [{ source: 'other' }, { readingId: '' }, { readingId: 'x'.repeat(129) },
    { endedConnectedAt: START - 1 }, { measuredAt: null }, { receivedAt: START + 40 * MINUTE }])
    await t.test(JSON.stringify(change), async () => {
      const h = harness(); await h.begin();
      const state = await h.update({ vehicleDisconnect: disconnected(change) });
      assert.equal(state.session.connectedAt, START); assert.equal(state.vehicleDisconnect, undefined);
      assert.deepEqual(h.writes, ['install']);
    });
});

test('failed stream-boundary cleanup survives restart and retries only the exact owned delay', async () => {
  const h = harness(); await h.begin(); h.failClear = true;
  const event = reconnected(disconnected());
  let state = await h.update({ vehicleDisconnect: event, plan: { state: 'identifying' } });
  assert.equal(state.phase, 'unconfirmed'); assert.equal(state.pending.action, 'clear');
  assert.equal(state.vehicleDisconnect.cleanupPending, true); assert.ok(state.owned);
  h.failClear = false; h.now += MINUTE; h.restart();
  state = await h.update({ vehicleDisconnect: event, plan: { state: 'identifying' } });
  assert.equal(state.phase, 'identifying'); assert.equal(state.owned, null); assert.equal(state.pending, null);
  assert.equal(state.vehicleDisconnect.cleanupPending, false); assert.deepEqual(h.writes, ['install', 'clear']);
});

test('a stream boundary received during an old-session write queues cleanup after its confirmed readback', async () => {
  const h = harness(); await h.begin();
  let begin, finish;
  const begun = new Promise(resolve => { begin = resolve; });
  const release = new Promise(resolve => { finish = resolve; });
  h.writeHook = async () => { begin(); await release; h.writeHook = null; };
  const installing = h.update({ plan: { id: 'in-flight', startAt: START + 4 * 60 * MINUTE } });
  await begun; h.now += 1000;
  const ending = h.update({ vehicleDisconnect: reconnected(disconnected()), plan: { state: 'identifying' } });
  finish(); await installing;
  const state = await ending;
  assert.equal(state.phase, 'identifying'); assert.equal(state.owned, null); assert.equal(state.execution, null);
  assert.equal(state.vehicleDisconnect.cleanupPending, false); assert.deepEqual(h.writes, ['install', 'install', 'clear']);
});

test('stream reconnect preserves manual stops and foreign schedules instead of granting control', async t => {
  await t.test('manual stop', async () => {
    const h = harness(); await h.begin(); h.enabled = false; h.reason = 53;
    const event = reconnected(disconnected());
    let state = await h.update({ vehicleDisconnect: event, plan: { state: 'identifying' } });
    assert.equal(state.phase, 'yielded'); assert.equal(state.manual.kind, 'stop');
    assert.equal(state.vehicleDisconnect.cleanupPending, true); assert.ok(state.owned);
    h.now += MINUTE; h.restart();
    state = await h.update({ vehicleDisconnect: event, plan: { state: 'identifying' } });
    assert.equal(state.manual.kind, 'stop'); assert.deepEqual(h.writes, ['install']);
  });
  await t.test('foreign schedule', async () => {
    const h = harness(); await h.begin();
    h.schedule = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC',
      periods: [{ startTime: '09:00', stopTime: '10:00', maximumAmps: 16 }] } });
    const saved = structuredClone(h.schedule);
    const state = await h.update({ vehicleDisconnect: reconnected(disconnected()), plan: { state: 'identifying' } });
    assert.equal(state.phase, 'yielded'); assert.equal(state.manual.kind, 'window'); assert.equal(state.owned, null);
    assert.deepEqual(h.schedule, saved); assert.deepEqual(h.writes, ['install']);
  });
});

test('stream boundary persistence failure rolls back the boundary before any charger write', async () => {
  const h = harness(); await h.begin(); h.failSave = true;
  await assert.rejects(h.update({ vehicleDisconnect: disconnected() }), /synthetic save failure/);
  assert.equal(h.controller.status().session.connectedAt, START);
  assert.equal(h.controller.status().vehicleDisconnect, undefined);
  assert.deepEqual(h.writes, ['install']);
});


test('Easee reconnect ordering follows source clocks when delivery is reversed or shares one millisecond', async t => {
  for (const receiptOffset of [-14_000, 0]) await t.test(String(receiptOffset), async () => {
    const h = harness(); await h.begin();
    const event = disconnected({ receivedAt: disconnected().measuredAt + 20_000 });
    event.reconnected = { readingId: 'source-later-reconnect', retained: false,
      measuredAt: event.measuredAt + 5000, receivedAt: event.receivedAt + receiptOffset };
    const state = await h.update({ vehicleDisconnect: event, plan: { state: 'identifying' } });
    assert.equal(state.phase, 'identifying'); assert.equal(state.session.connectedAt, h.now);
    assert.deepEqual(state.vehicleDisconnect.reconnected, event.reconnected, 'Original delivery clocks remain intact');
    assert.deepEqual(h.writes, ['install', 'clear']);
  });
});

test('a second live disconnect replaces a pending reconnect while the durable session remains closed', async () => {
  const h = harness(); await h.begin(); h.readAt = START;
  const first = reconnected(disconnected());
  let state = await h.update({ vehicleDisconnect: first, plan: { state: 'identifying' } });
  assert.equal(state.session.connectedAt, null); assert.equal(state.vehicleDisconnect.awaitingConnection, true);
  assert.deepEqual(state.vehicleDisconnect.reconnected, first.reconnected);
  const second = disconnected({ readingId: 'next-source-disconnect', measuredAt: first.measuredAt + 10_000,
    receivedAt: first.receivedAt + 10_000 });
  h.readAt = undefined; h.sourceAt = first.reconnected.measuredAt;
  state = await h.update({ vehicleDisconnect: second, plan: { state: 'identifying' } });
  assert.equal(state.session.connectedAt, null); assert.equal(state.phase, 'disconnected');
  assert.equal(state.vehicleDisconnect.readingId, second.readingId);
  assert.equal(state.vehicleDisconnect.reconnected, undefined, 'The old reconnect cannot open the newer ended connection');
  assert.equal(state.session.lastDisconnectedAt, second.measuredAt);
  h.restart(); h.now += MINUTE;
  state = await h.update({ vehicleDisconnect: first, plan: { state: 'identifying' } });
  assert.equal(state.session.connectedAt, null); assert.equal(state.vehicleDisconnect.readingId, second.readingId);
  assert.deepEqual(h.writes, ['install', 'clear']);
});
