import test from 'node:test';
import assert from 'node:assert/strict';
import { createChargingController } from '../src/charging/controller.js';
import { createEaseeScheduleAdapter, normalizeScheduleState } from '../src/charging/easee.js';

const START = Date.parse('2026-09-22T08:00:00Z'), MINUTE = 60_000;
const observation = (id, value, at) => ({ id, value, timestamp: new Date(at).toISOString() });
const disconnect = (extra = {}) => ({ source: 'bmw-cardata', readingId: 'bmw-unplug',
  measuredAt: START + 34 * MINUTE, receivedAt: START + 34 * MINUTE + 1000,
  endedConnectedAt: START, ...extra });
const reconnect = event => ({ ...event, reconnected: { readingId: 'bmw-replug', retained: false,
  measuredAt: event.measuredAt + 16_000, receivedAt: event.receivedAt + 16_000 } });

function harness() {
  const h = { now: START, sourceAt: START, mode: 2, pilot: 'B', pilotAt: START,
    enabled: true, online: true, allowed: true, reason: null, saved: null, writes: [],
    schedule: normalizeScheduleState({ enabled: 'none' }), failClear: false, failSave: false };
  const request = async (url, options) => {
    if (options.method === 'GET') {
      if (url.endsWith('/schedules')) return structuredClone(h.schedule);
      return [observation(250, h.online, h.now), observation(31, h.enabled, h.now),
        observation(109, h.mode, h.sourceAt), observation(100, h.pilot, h.pilotAt),
        observation(96, h.reason ?? (h.schedule.enabled === 'none' ? 0 : 54), h.now),
        observation(47, 16, h.now), observation(48, 16, h.now), observation(104, 32, h.now),
        ...[22, 23, 24].map(id => observation(id, 20, h.now))];
    }
    assert.equal(options.controlGuard?.(), true);
    if (url.endsWith('/disable') && h.failClear) throw Object.assign(new Error('synthetic clear failure'), { code: 'command-failed' });
    if (h.writeHook) await h.writeHook(url);
    h.writes.push(url.endsWith('/disable') ? 'clear' : 'install');
    if (url.endsWith('/disable')) h.schedule.enabled = 'none';
    else {
      const { enabled, ...delayed } = JSON.parse(options.body);
      h.schedule = normalizeScheduleState({ enabled: 'delayed', delayed });
    }
    return '';
  };
  const native = createEaseeScheduleAdapter({ request, chargerId: 'synthetic-charger', clock: () => h.now, canControl: () => h.allowed });
  const received = snapshot => h.readAt === undefined ? snapshot : { ...snapshot, readAt: h.readAt };
  h.adapter = { ...native, read: async () => received(await native.read()),
    clear: async options => received(await native.clear(options)) };
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
    plan: { id: 'old-plan', startAt: START + 3 * 60 * MINUTE }, ...extra });
  h.begin = async () => { await h.update(); h.now = START + 35 * MINUTE; };
  return h;
}

test('verified unplug closes the old session despite cached connected Easee and replug opens an unidentified observation', async () => {
  const h = harness(); await h.begin();
  const event = disconnect();
  let state = await h.update({ vehicleDisconnect: event, plan: null });
  assert.equal(state.snapshot.pluggedIn, true, 'Raw Easee connection telemetry is never fabricated');
  assert.equal(state.session.connectedAt, null); assert.equal(state.session.connected, false);
  assert.equal(state.session.lastDisconnectedAt, event.measuredAt);
  assert.equal(state.phase, 'disconnected'); assert.equal(state.owned, null);
  assert.equal(state.vehicleDisconnect.awaitingConnection, true);
  assert.equal(state.vehicleDisconnect.cleanupPending, false);
  assert.deepEqual(h.writes, ['install', 'clear']);
  h.now += 1000;
  state = await h.update({ vehicleDisconnect: reconnect(event), plan: null });
  assert.equal(state.phase, 'unavailable'); assert.equal(state.session.connectedAt, h.now);
  assert.equal(state.session.lastDisconnectedAt, event.measuredAt);
  assert.equal(state.vehicleDisconnect.awaitingConnection, false);
  assert.equal(state.vehicleDisconnect.source, 'bmw-cardata');
  assert.equal(state.execution, null); assert.equal(state.released, false);
  assert.deepEqual(h.writes, ['install', 'clear']);
  const connectedAt = state.session.connectedAt;
  h.now += MINUTE; h.restart();
  state = await h.update({ vehicleDisconnect: reconnect(event), plan: null });
  assert.equal(state.session.connectedAt, connectedAt, 'A replay across restart cannot create another observation');
  assert.deepEqual(h.writes, ['install', 'clear']);
});

test('new Easee mode or pilot source evidence can open the next connection without BMW replug delivery', async t => {
  for (const source of ['mode', 'pilot']) await t.test(source, async () => {
    const h = harness(); await h.begin();
    if (source === 'mode') h.sourceAt = h.now;
    else h.pilotAt = h.now;
    const state = await h.update({ vehicleDisconnect: disconnect(), plan: null });
    assert.equal(state.phase, 'unavailable'); assert.equal(state.session.connectedAt, h.now);
    assert.equal(state.vehicleDisconnect.awaitingConnection, false);
    assert.deepEqual(h.writes, ['install', 'clear']);
  });
});

test('same-clock or future positive Easee evidence does not reopen the ended session', async t => {
  for (const sourceAt of [disconnect().measuredAt, START + 40 * MINUTE]) await t.test(String(sourceAt), async () => {
    const h = harness(); await h.begin(); h.sourceAt = sourceAt; h.pilotAt = sourceAt;
    const state = await h.update({ vehicleDisconnect: disconnect(), plan: null });
    assert.equal(state.session.connectedAt, null); assert.equal(state.vehicleDisconnect.awaitingConnection, true);
  });
});

test('a read predating the unplug cannot turn a later BMW replug into a connected session', async () => {
  const h = harness(); await h.begin(); h.readAt = START;
  const state = await h.update({ vehicleDisconnect: reconnect(disconnect()), plan: null });
  assert.equal(state.session.connectedAt, null); assert.equal(state.vehicleDisconnect.awaitingConnection, true);
});

test('a newer real Easee disconnect prevents an earlier BMW replug from reopening the session', async () => {
  const h = harness(); await h.begin(); const event = reconnect(disconnect());
  h.mode = 1; h.pilot = 'A'; h.sourceAt = h.pilotAt = event.measuredAt + 25_000;
  let state = await h.update({ vehicleDisconnect: event, plan: null });
  assert.equal(state.session.lastDisconnectedAt, event.measuredAt + 25_000);
  h.mode = 2; h.pilot = 'B'; h.sourceAt = h.pilotAt = event.measuredAt + 20_000;
  state = await h.update({ vehicleDisconnect: event, plan: null });
  assert.equal(state.session.connectedAt, null); assert.equal(state.vehicleDisconnect.awaitingConnection, true);
  h.sourceAt = h.now;
  state = await h.update({ vehicleDisconnect: event, plan: null });
  assert.equal(state.session.connectedAt, h.now); assert.equal(state.phase, 'unavailable');
});

test('retained, old, or future BMW replug events cannot reopen a session with cached Easee evidence', async t => {
  const event = disconnect(), valid = reconnect(event).reconnected;
  for (const extra of [{ retained: true }, { measuredAt: event.measuredAt },
    { receivedAt: event.receivedAt }, { measuredAt: START + 40 * MINUTE }, { receivedAt: START + 40 * MINUTE }])
    await t.test(JSON.stringify(extra), async () => {
      const h = harness(); await h.begin();
      const state = await h.update({ vehicleDisconnect: { ...event, reconnected: { ...valid, ...extra } }, plan: null });
      assert.equal(state.session.connectedAt, null); assert.equal(state.vehicleDisconnect.awaitingConnection, true);
      assert.equal(state.vehicleDisconnect.reconnected, undefined);
    });
});

test('clear failure retains the old owned instruction and durable boundary for restart retry', async () => {
  const h = harness(); await h.begin(); h.failClear = true;
  const event = disconnect();
  let state = await h.update({ vehicleDisconnect: event, plan: null });
  assert.equal(state.phase, 'unconfirmed'); assert.ok(state.owned); assert.equal(state.pending.action, 'clear');
  assert.equal(state.vehicleDisconnect.cleanupPending, true); assert.equal(state.session.connectedAt, null);
  assert.deepEqual(h.writes, ['install']);
  h.restart(); h.failClear = false; h.now += MINUTE; h.sourceAt = h.now;
  state = await h.update({ vehicleDisconnect: event, plan: null });
  assert.equal(state.phase, 'unavailable'); assert.equal(state.owned, null); assert.equal(state.pending, null);
  assert.equal(state.vehicleDisconnect.cleanupPending, false); assert.equal(state.session.connectedAt, h.now);
  assert.deepEqual(h.writes, ['install', 'clear']);
});

test('a verified unplug arriving during an old-session install waits for readback then clears that owned instruction', async () => {
  const h = harness(); await h.begin();
  let begin, finish;
  const begun = new Promise(resolve => { begin = resolve; });
  const release = new Promise(resolve => { finish = resolve; });
  h.writeHook = async () => { begin(); await release; h.writeHook = null; };
  const installing = h.update({ plan: { id: 'old-session-replan', startAt: START + 4 * 60 * MINUTE } });
  await begun;
  h.now += 1000;
  const ending = h.update({ vehicleDisconnect: disconnect({ measuredAt: h.now - 1, receivedAt: h.now }),
    plan: null });
  finish(); await installing;
  const state = await ending;
  assert.equal(state.phase, 'disconnected'); assert.equal(state.owned, null); assert.equal(state.pending, null);
  assert.equal(state.session.connectedAt, null); assert.equal(state.vehicleDisconnect.cleanupPending, false);
  assert.deepEqual(h.writes, ['install', 'install', 'clear']);
});

test('a foreign manual window replaces ownership and survives the verified unplug', async () => {
  const h = harness(); await h.begin();
  h.schedule = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC',
    periods: [{ startTime: '09:00', stopTime: '10:00', maximumAmps: 16 }] } });
  const manualSchedule = structuredClone(h.schedule);
  const state = await h.update({ vehicleDisconnect: reconnect(disconnect()), plan: null });
  assert.equal(state.phase, 'yielded'); assert.equal(state.manual.kind, 'window');
  assert.equal(state.owned, null); assert.deepEqual(h.schedule, manualSchedule);
  assert.deepEqual(h.writes, ['install']);
});

test('stopped, offline, faulted, unauthorized, and revoked-control snapshots retain pending cleanup without a write', async t => {
  for (const change of [{ enabled: false, reason: 53 }, { enabled: false, reason: 53, mode: 1, pilot: 'A' },
    { online: false }, { mode: 5, reason: 56 },
    { mode: 7, reason: 55 }, { allowed: false }]) await t.test(JSON.stringify(change), async () => {
    const h = harness(); await h.begin(); Object.assign(h, change);
    const state = await h.update({ vehicleDisconnect: reconnect(disconnect()), plan: null });
    assert.equal(state.released, false); assert.ok(state.owned);
    assert.equal(state.vehicleDisconnect.cleanupPending, true);
    if (change.enabled === false) assert.equal(state.manual.kind, 'stop');
    if (change.online === false) assert.equal(state.session.connectedAt, null);
    assert.deepEqual(h.writes, ['install']);
  });
});

test('automatic off can relinquish its owned instruction without creating a new plan', async () => {
  const h = harness(); await h.begin();
  const state = await h.update({ enabled: false, vehicleDisconnect: reconnect(disconnect()), plan: null });
  assert.equal(state.phase, 'off'); assert.equal(state.owned, null); assert.equal(state.execution, null);
  assert.deepEqual(h.writes, ['install', 'clear']);
});

test('wrong-session, invalid-provider, and future unplug events leave the original session alone', async t => {
  for (const extra of [{ endedConnectedAt: START - MINUTE }, { source: 'other' }, { readingId: '' },
    { measuredAt: START + 40 * MINUTE }, { receivedAt: START + 40 * MINUTE }])
    await t.test(JSON.stringify(extra), async () => {
      const h = harness(); await h.begin();
      const state = await h.update({ vehicleDisconnect: disconnect(extra) });
      assert.equal(state.session.connectedAt, START); assert.equal(state.vehicleDisconnect, undefined);
      assert.deepEqual(h.writes, ['install']);
    });
});

test('failure to persist the boundary cannot clear a schedule or consume the event in memory', async () => {
  const h = harness(); await h.begin(); h.failSave = true;
  await assert.rejects(h.update({ vehicleDisconnect: disconnect() }), /synthetic save failure/);
  assert.equal(h.controller.status().session.connectedAt, START);
  assert.equal(h.controller.status().vehicleDisconnect, undefined);
  assert.deepEqual(h.writes, ['install']);
  h.failSave = false;
  const state = await h.update({ vehicleDisconnect: reconnect(disconnect()), plan: null });
  assert.equal(state.phase, 'unavailable'); assert.deepEqual(h.writes, ['install', 'clear']);
});

test('an already-passed old release cannot skip the new observation after unplug', async () => {
  const h = harness(); await h.begin();
  h.now = START + 4 * 60 * MINUTE;
  const event = disconnect({ measuredAt: h.now - MINUTE, receivedAt: h.now - MINUTE + 1000 });
  const state = await h.update({ vehicleDisconnect: reconnect(event), plan: null });
  assert.equal(state.phase, 'unavailable'); assert.equal(state.released, false);
  assert.equal(state.execution, null); assert.equal(state.owned, null);
  assert.deepEqual(h.writes, ['install', 'clear']);
});

test('a confirmed Easee disconnect retains cleanup ownership even after the old release time', async () => {
  const h = harness(); await h.begin(); h.now = START + 4 * 60 * MINUTE;
  h.mode = 1; h.pilot = 'A'; h.sourceAt = h.pilotAt = h.now - 1000;
  const state = await h.update({ vehicleDisconnect: disconnect({ measuredAt: h.now - MINUTE,
    receivedAt: h.now - MINUTE + 1000 }), plan: null });
  assert.equal(state.phase, 'disconnected'); assert.equal(state.owned, null);
  assert.deepEqual(h.writes, ['install', 'clear']);
});
