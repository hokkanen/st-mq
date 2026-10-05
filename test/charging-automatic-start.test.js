import test from 'node:test';
import assert from 'node:assert/strict';
import { createOcppScheduleAdapter, initialOcppControllerState } from '../src/charging/ocpp.js';
import { normalizeScheduleState } from '../src/charging/easee.js';

const AT = Date.parse('2026-10-01T12:00:00Z'), MINUTE = 60_000, SCOPE = 'c'.repeat(64);
const schedule = () => normalizeScheduleState({ enabled: 'none' });
const appState = (at, stopped = false) => ({ readAt: at, enabled: true, enabledAt: at,
  stopped, stopAt: at, controlKnown: true, faulted: false, authorizationBlocked: false, schedule: schedule() });
const plan = startAt => ({ id: 'fixture-automatic-start', feasible: true, startAt, periods: [{ startAt, endAt: null }] });

function fixture(t, { saved = null, app = appState(AT), transactionId = null } = {}) {
  let now = AT, currentApp = structuredClone(app), permission = null, persisted = saved;
  let currentTransaction = transactionId, transactionStartedAt = AT - MINUTE;
  let connectionId = 'fixture-automatic-connection', connected = true, readHook = null;
  let nextCompositeLimit = null, statusAt = null;
  const profiles = new Map(), commands = [], takeovers = [];
  const paused = () => [...profiles.values()].some(profile => Date.parse(profile.validTo) > now);
  const snapshot = () => ({ transport: 'ocpp', scope: SCOPE, connectionId, readAt: now, online: true,
    connectorStatus: !connected ? 'Available' : paused() ? 'SuspendedEVSE' : 'Preparing', statusAt: statusAt ?? now,
    transactionId: currentTransaction, transactionStartedAt: currentTransaction === null ? null : transactionStartedAt,
    transactionConfirmed: currentTransaction !== null, pluggedIn: connected, powerKw: 0, powerAt: now,
    appControl: currentApp ? { ...structuredClone(currentApp), readAt: now } : null });
  const adapter = createOcppScheduleAdapter({ scope: SCOPE, clock: () => now, canControl: () => true,
    readSnapshot: async options => { await readHook?.(options); return snapshot(); },
    isCurrent: (value, { unchangedStatus = false, requireTransaction = true } = {}) => value.connectionId === connectionId
      && (!requireTransaction || value.transactionId === currentTransaction)
      && (!unchangedStatus || value.connectorStatus === snapshot().connectorStatus && value.statusAt === snapshot().statusAt),
    setStartPermission: (value, options) => { permission = value ? { snapshot: structuredClone(value), ...options } : null; },
    request: async (action, payload, options) => {
      assert.equal(options.guard(), true);
      assert.equal(options.beforeSend?.() ?? true, true);
      commands.push({ action, payload: structuredClone(payload) });
      if (action === 'SetChargingProfile') {
        profiles.set(payload.csChargingProfiles.chargingProfileId, structuredClone(payload.csChargingProfiles));
        return { status: 'Accepted' };
      }
      if (action === 'ClearChargingProfile') return { status: profiles.delete(payload.id) ? 'Accepted' : 'Unknown' };
      assert.equal(action, 'GetCompositeSchedule');
      const expiry = Math.max(0, ...[...profiles.values()].map(profile => Date.parse(profile.validTo)));
      const limit = nextCompositeLimit ?? (paused() ? 0 : 16);
      return { status: 'Accepted', connectorId: 1, scheduleStart: new Date(now).toISOString(), chargingSchedule: {
        chargingRateUnit: 'A', duration: payload.duration,
        chargingSchedulePeriod: [{ startPeriod: 0, limit }, ...(expiry > now && expiry < now + payload.duration * 1000
          ? [{ startPeriod: (expiry - now) / 1000, limit: 16 }] : [])] } };
    },
    takeoverNative: async ({ expectedAppControl, canMutate, beforeWrite }) => {
      assert.equal(canMutate(), true);
      assert.deepEqual(expectedAppControl, snapshot().appControl);
      await beforeWrite();
      takeovers.push({ paused: paused(), app: structuredClone(currentApp) });
      currentApp = appState(now);
      return structuredClone(currentApp);
    } });
  const controller = adapter.createController({ initialState: saved, canControl: () => true, clock: () => now,
    saveState: value => { persisted = structuredClone(value); } });
  t.after(() => controller.close());
  return { controller, commands, takeovers, profiles,
    get saved() { return structuredClone(persisted); },
    get startAllowed() { return Boolean(permission && permission.until > now && permission.guard()); },
    get permission() { return permission; },
    advance(ms) { now += ms; },
    app(value) { currentApp = structuredClone(value); },
    transaction(value) { currentTransaction = value; transactionStartedAt = now; },
    connected(value) { connected = value; },
    statusAt(value) { statusAt = value; },
    reconnect() { connectionId += '-new'; currentTransaction = null; },
    readHook(value) { readHook = value; },
    compositeLimit(value) { nextCompositeLimit = value; } };
}

test('automatic wait denies transaction startup until its scheduled period begins', async t => {
  const f = fixture(t), startAt = AT + 30 * MINUTE;
  const waiting = await f.controller.update({ enabled: true, plan: plan(startAt) });
  assert.equal(waiting.errorCode, 'transaction-unconfirmed');
  assert.equal(f.startAllowed, false);
  assert.equal(f.commands.length, 0);
  f.advance(30 * MINUTE);
  await f.controller.update({ enabled: true, plan: plan(startAt) });
  assert.equal(f.startAllowed, true);
  f.controller.invalidate();
  assert.equal(f.startAllowed, false, 'A subsequent control edit immediately revokes queued authorization');
});

test('reconnection resolves the old disconnect without granting an unscheduled start', async t => {
  const saved = initialOcppControllerState(SCOPE);
  saved.session = { transactionId: null, connected: false, connectedAt: null, lastDisconnectedAt: AT - MINUTE };
  saved.vehicleDisconnect = { source: 'easee-stream', readingId: 'fixture-old-unplug',
    endedConnectedAt: AT - 2 * MINUTE, measuredAt: AT - MINUTE, receivedAt: AT - MINUTE, awaitingConnection: true };
  const f = fixture(t, { saved });
  const waiting = await f.controller.update({ enabled: true, plan: plan(AT + 30 * MINUTE) });
  assert.equal(waiting.session.connectedAt, AT);
  assert.equal(waiting.vehicleDisconnect.awaitingConnection, false);
  assert.equal(waiting.errorCode, 'transaction-unconfirmed');
  assert.equal(f.startAllowed, false, 'Physical reconnection alone cannot replace the economic wait');
  assert.equal(f.commands.length, 0, 'A new physical connection does not grant profile authority');

  const chargeNow = { connectedAt: AT };
  await f.controller.update({ enabled: true, chargeNow });
  assert.equal(f.startAllowed, true, 'Explicit Charge now can authorize the new transaction');
  assert.equal(f.commands.length, 0);
  f.advance(1000); f.app(appState(AT + 1000, true));
  const stopped = await f.controller.update({ enabled: true, chargeNow });
  assert.equal(stopped.manual.kind, 'stop');
  assert.equal(f.startAllowed, false, 'A later native Stop still revokes transaction startup');
});

test('missing startup planning inputs preserve an adopted native pause and deny early authorization', async t => {
  for (const reason of ['electrical-telemetry-unavailable', 'equalizer-allowance-unavailable', 'price-coverage-unavailable']) {
    const first = fixture(t, { transactionId: 7 }), startAt = AT + 30 * MINUTE;
    const original = plan(startAt);
    await first.controller.update({ enabled: true, plan: original });
    const restarted = fixture(t, { saved: first.saved, transactionId: 7 });
    for (const [id, profile] of first.profiles) restarted.profiles.set(id, structuredClone(profile));
    restarted.advance(MINUTE); restarted.reconnect(); restarted.transaction(7);
    const missing = { id: 'synthetic-missing-inputs', reason, startAt: AT + MINUTE, feasible: false,
      provisional: true, periods: [{ startAt: AT + MINUTE, endAt: null }] };
    const waiting = await restarted.controller.update({ enabled: true, plan: missing });
    assert.equal(waiting.phase, 'paused', reason);
    assert.equal(waiting.execution.planId, original.id);
    assert.equal(waiting.owned.startAt, startAt);
    assert.equal(restarted.startAllowed, false);
    assert.equal(restarted.commands.some(command => command.action !== 'GetCompositeSchedule'), false,
      'A verified retained profile needs no schedule write');
    restarted.advance(29 * MINUTE);
    const released = await restarted.controller.update({ enabled: true, plan: missing });
    assert.equal(released.phase, 'released');
    assert.equal(restarted.startAllowed, true, 'The original start still authorizes charging without a rebuilt forecast');
    assert.equal(released.provisional, false);
  }
});

test('fresh connections retain provisional startup while recovered inputs can install an economic pause', async t => {
  const f = fixture(t, { transactionId: 7 });
  const missing = { ...plan(AT), reason: 'electrical-telemetry-unavailable', feasible: false, provisional: true };
  const provisional = await f.controller.update({ enabled: true, plan: missing });
  assert.equal(provisional.phase, 'provisional');
  assert.equal(f.startAllowed, true);
  f.advance(MINUTE);
  const recovered = await f.controller.update({ enabled: true, plan: plan(AT + 30 * MINUTE) });
  assert.equal(recovered.phase, 'paused');
  assert.equal(f.startAllowed, false);
  assert.equal(recovered.provisional, false);
  f.advance(MINUTE); f.connected(false);
  await f.controller.update({ enabled: true, plan: missing });
  f.advance(MINUTE); f.connected(true); f.transaction(8);
  const nextConnection = await f.controller.update({ enabled: true, plan: missing });
  assert.equal(nextConnection.phase, 'provisional');
  assert.equal(f.startAllowed, true, 'A confirmed new vehicle connection cannot inherit the previous program');
  assert.equal(nextConnection.execution, null);
});

test('unsupported Easee schedules block native takeover without offering an unusable action', async t => {
  for (const kind of ['offPeak', 'tariff']) {
    const app = appState(AT);
    app.schedule = normalizeScheduleState({ enabled: kind, [kind]: { timezone: 'UTC' } });
    const f = fixture(t, { app, transactionId: 7 });
    const view = await f.controller.update({ enabled: true, plan: plan(AT + 30 * MINUTE) });
    assert.equal(view.errorCode, 'unsupported-schedule');
    assert.equal(view.takeover.available, false);
    assert.equal(view.takeover.token, null);
    assert.equal(f.commands.length, 0);
    assert.equal(f.startAllowed, false);
  }
});

test('a price revision moving an open period into the future revokes authorization before confirming its pause', async t => {
  for (const transactionConfirmed of [true, false]) {
    const f = fixture(t, { transactionId: 7 }), deadlineAt = AT + 180 * MINUTE;
    const original = { ...plan(AT), deadlineAt };
    await f.controller.update({ enabled: true, plan: original });
    assert.equal(f.startAllowed, true);
    f.advance(20 * MINUTE);
    await f.controller.update({ enabled: true, plan: original });
    assert.equal(f.startAllowed, true, 'The existing active period has a fresh authorization decision');
    if (!transactionConfirmed) f.transaction(null);
    let pausePreflight = false;
    f.readHook(options => {
      if (options.forceAppRefresh) {
        pausePreflight = true;
        assert.equal(f.startAllowed, false, 'A new waiting plan cannot authorize a start while its pause is being installed');
      }
    });
    const revised = { ...plan(AT + 60 * MINUTE), id: 'fixture-cheaper-plan', deadlineAt, requiredGridKwh: 4,
      priceRevision: { previousPlanId: original.id, at: AT + 20 * MINUTE } };
    const view = await f.controller.update({ enabled: true, plan: revised });
    assert.equal(f.startAllowed, false);
    if (transactionConfirmed) {
      assert.equal(pausePreflight, true);
      assert.equal(view.phase, 'paused');
      assert.equal(view.execution.planId, revised.id);
    } else {
      assert.equal(view.errorCode, 'transaction-unconfirmed');
      assert.equal(f.commands.length, 0, 'Missing transaction evidence denies startup without inventing a native profile');
    }
  }
});

test('unknown charger instructions cannot authorize startup with automatic on or off', async t => {
  for (const enabled of [true, false]) {
    const f = fixture(t, { app: null });
    await f.controller.update({ enabled, plan: plan(AT) });
    assert.equal(f.startAllowed, false);
    assert.equal(f.commands.length, 0);
  }
});

test('a paused connection remains paused across process and transport restart', async t => {
  const first = fixture(t, { app: appState(AT, true) });
  await first.controller.update({ enabled: false, plan: plan(AT) });
  const restarted = fixture(t, { saved: first.saved, app: appState(AT, true) });
  restarted.reconnect();
  const view = await restarted.controller.update({ enabled: true, plan: plan(AT) });
  assert.equal(view.errorCode, 'charger-stopped');
  assert.equal(restarted.startAllowed, false);
  assert.equal(restarted.takeovers.length, 0, 'Restart cannot turn an existing pause into a new-connection takeover');
});

test('a new physical connection supersedes the previous connection manual stop under a confirmed wait', async t => {
  const f = fixture(t);
  await f.controller.update({ enabled: true, plan: plan(AT) });
  f.advance(1000); f.app(appState(AT + 1000, true));
  const manual = await f.controller.update({ enabled: true, plan: plan(AT) });
  assert.equal(manual.manual.kind, 'stop');
  assert.equal(f.startAllowed, false);
  f.advance(1000); f.connected(false);
  await f.controller.update({ enabled: true, plan: plan(AT + 30 * MINUTE) });
  f.advance(1000); f.connected(true); f.transaction(8);
  const next = await f.controller.update({ enabled: true, plan: plan(AT + 30 * MINUTE) });
  assert.equal(next.takeover.state, 'confirmed');
  assert.equal(next.manual, null);
  assert.equal(f.takeovers.length, 1);
  assert.equal(f.takeovers[0].paused, true);
  assert.equal(f.startAllowed, false);
});

test('replayed Available older than the saved connection or manual pause cannot turn a restart into automatic takeover', async t => {
  for (const oldStatusAt of [AT - MINUTE, AT + 500]) {
    const first = fixture(t);
    await first.controller.update({ enabled: true, plan: plan(AT) });
    first.advance(1000); first.app(appState(AT + 1000, true));
    const paused = await first.controller.update({ enabled: true, plan: plan(AT) });
    assert.equal(paused.manual.kind, 'stop');
    const restarted = fixture(t, { saved: first.saved, app: appState(AT + 1000, true) });
    restarted.advance(2000); restarted.reconnect(); restarted.connected(false); restarted.statusAt(oldStatusAt);
    const replay = await restarted.controller.update({ enabled: true, plan: plan(AT) });
    assert.equal(replay.errorCode, 'status-stale');
    assert.deepEqual(replay.session, paused.session);
    assert.deepEqual(replay.manual, paused.manual);
    assert.equal(restarted.startAllowed, false);
    restarted.advance(1000); restarted.connected(true); restarted.statusAt(null); restarted.transaction(7);
    const current = await restarted.controller.update({ enabled: true, plan: plan(AT) });
    assert.equal(current.session.connectedAt, paused.session.connectedAt);
    assert.deepEqual(current.manual, paused.manual);
    assert.equal(restarted.takeovers.length, 0);
    assert.equal(restarted.startAllowed, false);
  }
});

test('a newer explicit physical disconnect remains authoritative when native Available is an older replay', async t => {
  const first = fixture(t);
  await first.controller.update({ enabled: true, plan: plan(AT) });
  first.advance(1000); first.app(appState(AT + 1000, true));
  const paused = await first.controller.update({ enabled: true, plan: plan(AT) });
  const restarted = fixture(t, { saved: first.saved, app: appState(AT + 1000, true) });
  restarted.advance(2000); restarted.reconnect(); restarted.connected(false); restarted.statusAt(AT - MINUTE);
  const disconnected = await restarted.controller.update({ enabled: true, plan: plan(AT + 30 * MINUTE),
    vehicleDisconnect: { source: 'easee-stream', readingId: 'fixture-explicit-disconnect',
      endedConnectedAt: paused.session.connectedAt, measuredAt: AT + 1500, receivedAt: AT + 2000 } });
  assert.equal(disconnected.manual, null);
  assert.equal(disconnected.session.connectedAt, null);
  assert.equal(disconnected.session.lastDisconnectedAt, AT + 1500);
  restarted.advance(1000); restarted.connected(true); restarted.statusAt(null); restarted.transaction(8);
  const next = await restarted.controller.update({ enabled: true });
  assert.equal(next.takeover.state, 'confirmed');
  assert.equal(restarted.takeovers.length, 1);
  assert.equal(restarted.takeovers[0].paused, true);
});

test('manual observation receipt time cannot hide a later physical disconnect source time', async t => {
  for (const explicit of [false, true]) {
    const first = fixture(t);
    await first.controller.update({ enabled: true, plan: plan(AT) });
    first.advance(3000); first.app(appState(AT + 1000, true));
    const paused = await first.controller.update({ enabled: true, plan: plan(AT) });
    assert.equal(paused.manual.at, AT + 3000);
    const restarted = fixture(t, { saved: first.saved, app: appState(AT + 1000, true) });
    restarted.advance(4000); restarted.reconnect(); restarted.connected(false);
    restarted.statusAt(explicit ? AT - MINUTE : AT + 2000);
    const view = await restarted.controller.update({ enabled: true, plan: plan(AT), ...(explicit ? {
      vehicleDisconnect: { source: 'easee-stream', readingId: 'fixture-source-time-disconnect',
        endedConnectedAt: paused.session.connectedAt, measuredAt: AT + 2000, receivedAt: AT + 4000 },
    } : {}) });
    assert.equal(view.manual, null);
    assert.equal(view.session.connectedAt, null);
    assert.equal(view.session.lastDisconnectedAt, AT + 2000);
  }
});

test('fault or authorization readiness recovery does not cancel a pending automatic takeover of unchanged instructions', async t => {
  for (const readiness of ['faulted', 'authorizationBlocked']) {
    for (const stopped of [true, false]) {
      const app = { ...appState(AT, stopped), [readiness]: true };
      if (!stopped) app.schedule = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'Europe/Helsinki',
        periods: [{ startTime: '01:00:00', stopTime: '03:00:00', maximumAmps: 16 }] } });
      const f = fixture(t, { app, transactionId: 7 });
      const blocked = await f.controller.update({ enabled: true, plan: plan(AT + 30 * MINUTE) });
      assert.equal(blocked.errorCode, 'takeover-unavailable');
      assert.ok(blocked.automaticTakeover);
      assert.equal(f.takeovers.length, 0);
      f.advance(1000); f.app({ ...app, [readiness]: false, stopAt: stopped ? app.stopAt : AT + 1000 });
      const ready = await f.controller.update({ enabled: true });
      assert.equal(ready.takeover.state, 'confirmed');
      assert.equal(ready.automaticTakeover, null);
      assert.equal(f.takeovers.length, 1);
      assert.equal(f.takeovers[0].paused, true);
      assert.equal(f.startAllowed, false);
    }
  }
});

test('a fresh read containing older control evidence cannot authorize over a saved stop', async t => {
  for (const enabled of [true, false]) {
    const saved = initialOcppControllerState(SCOPE);
    saved.session = { transactionId: null, connected: true, connectedAt: AT - MINUTE, lastDisconnectedAt: null };
    saved.appControl = appState(AT, true);
    const f = fixture(t, { saved, app: appState(AT - MINUTE, false) });
    const view = await f.controller.update({ enabled, plan: plan(AT) });
    assert.equal(view.appControl.stopped, true, 'Saved source evidence remains newer than the current response');
    assert.equal(f.startAllowed, false, 'Authorization must obey the retained stop, including while automatic is off');
    assert.equal(f.takeovers.length, 0);
  }
});

test('new connection takeover installs and confirms the waiting restriction before clearing an existing schedule', async t => {
  const app = appState(AT);
  app.schedule = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'Europe/Helsinki',
    periods: [{ startTime: '01:00:00', stopTime: '03:00:00', maximumAmps: 16 }] } });
  const f = fixture(t, { app, transactionId: 7 });
  const view = await f.controller.update({ enabled: true, plan: plan(AT + 30 * MINUTE) });
  assert.equal(view.takeover.state, 'confirmed');
  assert.equal(f.takeovers.length, 1);
  assert.equal(f.takeovers[0].paused, true);
  assert.equal(f.startAllowed, false);
  assert.equal(view.appControl.schedule.enabled, 'none');
});

test('an unconfirmed waiting restriction preserves the external pause and never authorizes start', async t => {
  const f = fixture(t, { app: appState(AT, true), transactionId: 7 });
  f.compositeLimit(16);
  const view = await f.controller.update({ enabled: true, plan: plan(AT + 30 * MINUTE) });
  assert.equal(view.errorCode, 'readback-mismatch');
  assert.equal(f.takeovers.length, 0);
  assert.equal(f.startAllowed, false);
});

test('a newer external edit wins while automatic takeover awaits a transaction', async t => {
  const f = fixture(t, { app: appState(AT, true) });
  await f.controller.update({ enabled: true, plan: plan(AT + 30 * MINUTE) });
  assert.ok(f.saved.automaticTakeover);
  f.advance(1000);
  f.app(appState(AT + 1000, true));
  f.transaction(7);
  const view = await f.controller.update({ enabled: true, plan: plan(AT + 30 * MINUTE) });
  assert.equal(view.automaticTakeover, null);
  assert.equal(f.takeovers.length, 0);
  assert.equal(f.startAllowed, false);
});

test('profile preflight rejects a newer external stop before any charger mutation', async t => {
  const f = fixture(t, { app: appState(AT), transactionId: 7 });
  f.readHook(options => { if (options.forceAppRefresh) f.app(appState(AT, true)); });
  const view = await f.controller.update({ enabled: true, plan: plan(AT + 30 * MINUTE) });
  assert.equal(view.errorCode, 'control-revoked');
  assert.equal(f.commands.length, 0);
  assert.equal(f.startAllowed, false);
});
